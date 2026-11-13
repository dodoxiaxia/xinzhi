'use strict';
// Candidate index for the machine download queue: claim, requeue and the per-state list read one small index key
// instead of listing every task key. Synthetic tokens and an in-memory KV only; no live KV, publisher or model.
const assert = require('assert');
const crypto = require('crypto');
const {setup} = require('./test_fulltext_auth_helpers.cjs');
const {hash} = require('./test_doi_library_worker.cjs');
const base = 'https://learn.dryz.info';
const dsh = 'synthetic_downloader_token_0123456789ab';
const fallback = 'synthetic_fallback_token_0123456789abcd';
const reader = 'synthetic_reader_token_0123456789abcdef';
const tokens = JSON.stringify([{id:'dsh',role:'downloader',token:dsh},{id:'fallback',role:'fallback',token:fallback},{id:'ddx',role:'reader',token:reader}]);
const INDEX = 'library:machine-index:v1';
async function create(options = {}) {
  const h = await setup(options);
  h.env.MUSE_FULLTEXT_ENABLED = 'true';
  h.env.MACHINE_TOKENS = tokens;
  return h;
}
function call(h, route, secret, body, method = 'POST') {
  const init = {method,headers:{authorization:'Bearer ' + secret,'content-type':'application/json'}};
  if (method !== 'GET') init.body = JSON.stringify(body || {});
  return h.context.worker.fetch(new Request(base + route, init), h.env);
}
const stored = (h, key) => { const value = h.values.get(key); return value === undefined ? undefined : JSON.parse(value); };
const dois = (prefix, n) => Array.from({length:n}, (_, i) => '10.1000/' + prefix + String(i).padStart(4, '0'));
function paperRecord(doi, status = 'manual_needed') {
  return JSON.stringify({version:1,paper:{id:'doi-' + hash(doi).slice(0, 16),doi,title:'Synthetic index title ' + doi,journal:'Heart',authors:['Jane Doe'],date:'2026-10-07',datePrecision:'day',dateBasis:'Crossref published-online',ingestedAt:'2026-10-07T04:00:00.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:status}});
}
// Writes a task straight into KV, the way an older deployment left it (no index entry).
function seedJob(h, doi, state, createdAt, extra = {}) {
  const id = crypto.randomUUID();
  const queueKey = 'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id;
  const job = {version:1,id,doi,state,createdAt,updatedAt:createdAt,queueKey,...extra};
  if (['running','uploading','verifying'].includes(state)) Object.assign(job, {leaseId:crypto.randomUUID(),leaseUntil:extra.leaseUntil || createdAt + 3600000,acquisitionStartedAt:createdAt});
  h.values.set('library:muse-job:' + doi, JSON.stringify(job));
  if (state === 'queued') h.values.set(queueKey, JSON.stringify({doi,id}));
  h.values.set('library:paper:' + doi, paperRecord(doi, state === 'available' ? 'available' : 'manual_needed'));
  return job;
}
// A deployment whose index is already built (the first machine request builds it).
async function primed() {
  const h = await create();
  assert.equal((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task, null);
  return h;
}
const registerItems = (ids, source = 'rss-synthetic') => ids.map(doi => ({doi,title:'Synthetic index title ' + doi,source,section:'MAIN'}));
// Runs fn and returns the KV operations it caused.
async function measure(h, fn) {
  const reads = h.reads.length, lists = h.lists.length, writes = h.writes.length;
  const result = await fn();
  return {result,reads:h.reads.length - reads,lists:h.lists.length - lists,writes:h.writes.length - writes};
}
async function run() {
  const now = Date.now();
  // ---- an empty ledger: the first claim creates the index, later empty claims cost one read and no list
  let h = await create();
  const first = await measure(h, () => call(h, '/api/machine/claim', dsh, {state:'to-download'}));
  const firstBody = await first.result.json();
  assert.equal(firstBody.task, null);
  assert.equal(stored(h, INDEX).ready, true);
  const empty = await measure(h, () => call(h, '/api/machine/claim', dsh, {state:'to-download'}));
  assert.equal(empty.result.status, 200);
  assert.equal(empty.result.headers.get('retry-after'), '300');
  const emptyBody = await empty.result.json();
  assert.equal(emptyBody.ok, true); assert.equal(emptyBody.task, null); assert.equal(emptyBody.retryAfterSeconds, 300);
  // Empty claim: one index read plus one stats-key read and one stats-key write (same UTC-day JSON document).
  assert.deepEqual([empty.lists, empty.reads, empty.writes], [0, 2, 1]);
  const emptyFailed = await measure(h, () => call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'}));
  assert.equal((await emptyFailed.result.json()).task, null);
  assert.deepEqual([emptyFailed.lists, emptyFailed.reads, emptyFailed.writes], [0, 2, 1]);
  const emptyRequeue = await measure(h, () => call(h, '/api/machine/requeue', dsh, {dryRun:true}));
  assert.equal((await emptyRequeue.result.json()).requeued.length, 0);
  assert.equal(emptyRequeue.lists, 0); assert(emptyRequeue.reads <= 2);
  const emptyList = await measure(h, () => call(h, '/api/machine/tasks?state=to-download', reader, null, 'GET'));
  assert.equal((await emptyList.result.json()).tasks.length, 0);
  assert.deepEqual([emptyList.lists, emptyList.reads], [0, 1]);

  // ---- a large ledger of finished tasks never slows the claim path down
  h = await create();
  for (const [n, doi] of dois('done', 300).entries()) seedJob(h, doi, n % 2 ? 'available' : 'abandoned', now - 1e7 + n);
  await call(h, '/api/machine/claim', dsh, {state:'to-download'}); // one-time backfill of 300 keys fits in one request
  const index = stored(h, INDEX);
  assert.equal(index.ready, true);
  assert.equal(Object.keys(index.entries).length, 0, 'finished tasks are not in the index');
  for (const [state, token] of [['to-download', dsh], ['failed-awaiting-fallback', fallback]]) {
    const steady = await measure(h, () => call(h, '/api/machine/claim', token, {state}));
    assert.equal((await steady.result.json()).task, null);
    assert.deepEqual([steady.lists, steady.reads, steady.writes], [0, 2, 1]);
  }

  // ---- one-time backfill over several requests, bounded per request; lists and requests wait until it is complete
  h = await create();
  for (const [n, doi] of dois('bf', 1000).entries()) seedJob(h, doi, n % 100 === 7 ? 'queued' : 'available', now - 2e7 + n);
  const steps = [];
  let building = true, requests = 0;
  while (building && steps.length < 20) {
    const step = await measure(h, () => call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'}));
    requests++;
    const body = await step.result.json();
    steps.push({lists:step.lists,reads:step.reads,writes:step.writes});
    assert(step.lists + step.reads < 700, 'one request stays far below the 1000 KV operations a request may use');
    const doc = stored(h, INDEX);
    building = !doc.ready;
    if (building) {
      assert.equal(body.retryAfterSeconds, 60);
      assert.equal(step.result.headers.get('retry-after'), '60');
      const blocked = await call(h, '/api/machine/tasks?state=to-download', reader, null, 'GET');
      requests++;
      assert.equal(blocked.status, 503);
      assert.equal((await blocked.json()).error, 'machine_index_building');
      assert.equal(blocked.headers.get('retry-after'), '60');
    }
  }
  assert(requests > 1 && requests <= 6, 'a 1000-key ledger is rebuilt in a few requests: ' + requests);
  const total = {lists:h.lists.length,reads:h.reads.length,writes:h.writes.length};
  assert.equal(total.lists, 10, '1000 keys at 100 per page');
  assert.equal(total.reads, 1000 + 2 * requests + steps.length, 'one record read per key, two index reads per backfill request, plus one stats-key read per claim');
  const done = stored(h, INDEX);
  assert.equal(Object.keys(done.entries).length, 10, 'only the ten queued tasks are candidates');
  const after = await measure(h, () => call(h, '/api/machine/tasks?state=to-download&limit=50', reader, null, 'GET'));
  assert.equal((await after.result.json()).tasks.length, 10);
  assert.equal(after.lists, 0);
  const early = await create();
  for (const [n, doi] of dois('bg', 1000).entries()) seedJob(early, doi, 'available', now - 3e7 + n);
  const blockedRequeue = await call(early, '/api/machine/requeue', dsh, {dryRun:true});
  assert.equal(blockedRequeue.status, 503);
  assert.equal((await blockedRequeue.json()).error, 'machine_index_building');
  console.log('  backfill of 1000 keys:', JSON.stringify({requests,...total}));

  // ---- claims follow the index; the record is re-read and wins
  h = await primed();
  const ids = dois('q', 4);
  const registered = await (await call(h, '/api/machine/register', dsh, {items:registerItems(ids)})).json();
  assert.equal(registered.counts.registered, 4);
  const batchWrites = h.writes.filter(write => write.key === INDEX);
  assert(batchWrites.length <= 2, 'a registration batch writes the index once (plus its creation): ' + batchWrites.length);
  assert.deepEqual(Object.keys(stored(h, INDEX).entries).sort(), ids.slice().sort());
  const claim = await measure(h, () => call(h, '/api/machine/claim', dsh, {state:'to-download'}));
  const claimBody = await claim.result.json();
  assert(ids.includes(claimBody.task.doi));
  assert.equal(claimBody.task.state, 'downloading'); assert.equal(claimBody.task.claimant, 'dsh');
  assert(claimBody.task.leaseId && claimBody.task.leaseUntil && claimBody.task.title && claimBody.task.institutionUrl);
  assert.equal(claim.lists, 0);
  assert.equal(stored(h, INDEX).entries[claimBody.task.doi].s, 'running');
  console.log('  claim with a task:', JSON.stringify({lists:claim.lists,reads:claim.reads,writes:claim.writes}));
  const seen = new Set([claimBody.task.doi]);
  for (let n = 0; n < 3; n++) seen.add((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task.doi);
  assert.deepEqual([...seen].sort(), ids.slice().sort(), 'each claim takes a different task');
  assert.equal((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task, null);

  // a stale entry (record already finished elsewhere) is corrected and skipped
  h = await primed();
  const stale = dois('s', 3);
  await call(h, '/api/machine/register', dsh, {items:registerItems(stale)});
  const doneJob = stored(h, 'library:muse-job:' + stale[0]);
  h.values.set('library:muse-job:' + stale[0], JSON.stringify({...doneJob,state:'available',updatedAt:doneJob.updatedAt + 5}));
  h.values.delete('library:muse-job:' + stale[1]);
  const picked = (await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task;
  assert.equal(picked.doi, stale[2]);
  const entries = stored(h, INDEX).entries;
  assert(!entries[stale[0]] && !entries[stale[1]], 'entries that disagree with their record are removed');
  assert.equal(entries[stale[2]].s, 'running');

  // an entry lost to a concurrent write is only found again by a rebuild, never silently invented
  h = await primed();
  const lost = dois('l', 2);
  await call(h, '/api/machine/register', dsh, {items:registerItems(lost)});
  const doc = stored(h, INDEX); delete doc.entries[lost[0]]; h.values.set(INDEX, JSON.stringify(doc));
  assert.equal((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task.doi, lost[1]);
  assert.equal((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task, null);
  const rebuilt = [];
  for (let n = 0; n < 5; n++) { const body = await (await call(h, '/api/machine/requeue', dsh, {reindex:true})).json(); rebuilt.push(body.reindex); if (body.reindex.ready) break; }
  assert.equal(rebuilt.at(-1).ready, true);
  assert.equal((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task.doi, lost[0]);
  assert.equal((await call(h, '/api/machine/requeue', dsh, {reindex:true,limit:3})).status, 400);
  assert.equal((await call(h, '/api/machine/requeue', fallback, {reindex:true})).status, 403);

  // ---- failed tasks: fallback claim, requeue and the state lists all read the index
  h = await primed();
  const failed = dois('f', 5);
  await call(h, '/api/machine/register', dsh, {items:registerItems(failed)});
  for (const doi of failed.slice(0, 3)) {
    const job = stored(h, 'library:muse-job:' + doi);
    assert.equal((await call(h, '/api/machine/status', fallback, {doi,state:'failed-awaiting-fallback',reason:'not_oa'})).status, 200);
    assert.equal(stored(h, 'library:muse-job:' + doi).state, 'failed');
    assert(job);
  }
  assert.deepEqual(['failed','failed','failed','queued','queued'], failed.map(doi => stored(h, INDEX).entries[doi].s));
  const listed = await measure(h, () => call(h, '/api/machine/tasks?state=failed-awaiting-fallback&limit=2', reader, null, 'GET'));
  const page1 = await listed.result.json();
  assert.equal(page1.tasks.length, 2); assert(page1.cursor); assert.equal(listed.lists, 0);
  const page2 = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback&limit=2&cursor=' + encodeURIComponent(page1.cursor), reader, null, 'GET')).json();
  assert.equal(page2.tasks.length, 1); assert.equal(page2.cursor, null);
  assert.deepEqual([...page1.tasks, ...page2.tasks].map(task => task.doi).sort(), failed.slice(0, 3).sort());
  assert.equal((await call(h, '/api/machine/tasks?state=failed-awaiting-fallback&cursor=' + encodeURIComponent(Buffer.from('{"c":"x","skip":0}').toString('base64url')), reader, null, 'GET')).status, 400);
  const toDownload = await (await call(h, '/api/machine/tasks?state=to-download', reader, null, 'GET')).json();
  assert.deepEqual(toDownload.tasks.map(task => task.doi).sort(), failed.slice(3).sort());
  const requeue = await measure(h, () => call(h, '/api/machine/requeue', dsh, {limit:50}));
  const requeueBody = await requeue.result.json();
  assert.equal(requeueBody.requeued.length, 3); assert.equal(requeueBody.truncated, false); assert.equal(requeue.lists, 0);
  assert(h.writes.filter(write => write.key === INDEX).length >= 1);
  assert.deepEqual(failed.map(doi => stored(h, INDEX).entries[doi].s), ['queued','queued','queued','queued','queued']);
  const fallbackClaim = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fallbackClaim.task, null); assert.equal(fallbackClaim.retryAfterSeconds, 300);
  // a first lease expiry returns to to-download; fallback must not take it in that same request
  const leased = (await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task;
  const leasedJob = stored(h, 'library:muse-job:' + leased.doi);
  h.values.set('library:muse-job:' + leased.doi, JSON.stringify({...leasedJob,leaseUntil:Date.now() - 1000,updatedAt:leasedJob.updatedAt + 1}));
  const doc2 = stored(h, INDEX); doc2.entries[leased.doi] = {...doc2.entries[leased.doi],e:Date.now() - 1000,u:leasedJob.updatedAt + 1}; h.values.set(INDEX, JSON.stringify(doc2));
  const firstExpiry = (await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json()).task;
  assert.equal(firstExpiry, null);
  const retried = stored(h, 'library:muse-job:' + leased.doi);
  assert.equal(retried.state, 'queued');
  assert.equal(retried.id, leasedJob.id);
  assert.equal(retried.softFailCount, 1);
  const again = (await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task;
  assert.equal(again.doi, leased.doi);
  const againJob = stored(h, 'library:muse-job:' + leased.doi);
  h.values.set('library:muse-job:' + leased.doi, JSON.stringify({...againJob,leaseUntil:Date.now() - 1000,updatedAt:againJob.updatedAt + 1}));
  const doc3 = stored(h, INDEX); doc3.entries[leased.doi] = {...doc3.entries[leased.doi],e:Date.now() - 1000,u:againJob.updatedAt + 1}; h.values.set(INDEX, JSON.stringify(doc3));
  const secondExpiry = (await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json()).task;
  assert.equal(secondExpiry, null);
  const marked = stored(h, 'library:muse-job:' + leased.doi);
  assert.equal(marked.state, 'failed');
  assert.equal(marked.reason, 'lease_expired');
  assert.equal(marked.softFailCount, 2);
  const taken = (await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json()).task;
  assert.equal(taken.doi, leased.doi); assert.equal(taken.claimant, 'fallback');

  // ---- finished tasks leave the index; their records keep no TTL
  h = await primed();
  const finishing = dois('z', 2);
  await call(h, '/api/machine/register', dsh, {items:registerItems(finishing)});
  assert.equal((await call(h, '/api/machine/status', fallback, {doi:finishing[0],state:'confirmed-abandoned',reason:'other'})).status, 200);
  assert(!stored(h, INDEX).entries[finishing[0]]);
  const abandonedWrite = h.writes.filter(write => write.key === 'library:muse-job:' + finishing[0]).at(-1);
  assert(abandonedWrite.opts === undefined || abandonedWrite.opts.expirationTtl === undefined);
  const abandoned = await measure(h, () => call(h, '/api/machine/abandoned', reader, null, 'GET'));
  assert.deepEqual((await abandoned.result.json()).tasks.map(task => task.doi), [finishing[0]]);
  assert(abandoned.lists >= 1, 'the abandoned list still scans the keys (not a claim path)');

  // ---- entries older than the record lifetime are dropped
  h = await primed();
  await call(h, '/api/machine/register', dsh, {items:registerItems(dois('p', 1))});
  const aged = stored(h, INDEX); aged.entries['10.1000/p0000'].w = Date.now() - 9 * 86400000; h.values.set(INDEX, JSON.stringify(aged));
  assert.equal((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task, null);

  // ---- a damaged index document is rebuilt, not trusted
  h = await primed();
  await call(h, '/api/machine/register', dsh, {items:registerItems(dois('d', 2))});
  h.values.set(INDEX, '{"version":2}');
  const rebuild = [];
  for (let n = 0; n < 5; n++) { const body = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json(); rebuild.push(body); if (body.task) break; }
  assert(rebuild.at(-1).task, 'the claim finds the task after the index was rebuilt');
  console.log('machine index tests passed');
}
module.exports = {run};
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
