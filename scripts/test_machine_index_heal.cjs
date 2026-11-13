'use strict';
// The machine candidate index must not lose waiting tasks after a batch registration that was cut off (client timeout),
// a replayed registration, or a lost concurrent update. Synthetic tokens and an in-memory KV only.
const assert = require('assert');
const crypto = require('crypto');
const {setup,token} = require('./test_fulltext_auth_helpers.cjs');
const base = 'https://learn.dryz.info';
const dsh = 'synthetic_downloader_token_0123456789ab';
const reader = 'synthetic_reader_token_0123456789abcdef';
const tokens = JSON.stringify([{id:'dsh',role:'downloader',token:dsh},{id:'ddx',role:'reader',token:reader}]);
const INDEX = 'library:machine-index:v1';
const reviewUrl = base + '/api/muse/review';
const {runIndexAudit} = require('./muse_review_runner.cjs');
async function create(options = {}) {
  const clock = {now:Date.now()};
  const h = await setup({clock,...options});
  h.clock = clock;
  h.env.MUSE_FULLTEXT_ENABLED = 'true';
  h.env.MACHINE_TOKENS = tokens;
  // A deployment whose index is already built: the first machine request builds it (nothing to do on an empty ledger).
  assert.equal((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task, null);
  assert.equal(stored(h, INDEX).ready, true);
  return h;
}
function call(h, route, secret, body, method = 'POST') {
  const init = {method,headers:{authorization:'Bearer ' + secret,'content-type':'application/json'}};
  if (method !== 'GET') init.body = JSON.stringify(body);
  return h.context.worker.fetch(new Request(base + route, init), h.env);
}
const items = (prefix, from, count) => Array.from({length:count}, (_, n) => ({doi:'10.1000/' + prefix + '.' + (from + n),title:'Synthetic heal title number ' + (from + n),source:'rss-synthetic',section:'MAIN'}));
const register = (h, list) => call(h, '/api/machine/register', dsh, {items:list});
const stored = (h, key) => { const value = h.values.get(key); return value === undefined ? undefined : JSON.parse(value); };
const indexed = h => Object.keys((stored(h, INDEX) || {entries:{}}).entries).sort();
const quota = h => stored(h, 'library:machine-rate:register:dsh:' + new h.context.Date().toISOString().slice(0, 10));
const toDownload = async (h, limit = 50) => (await (await call(h, '/api/machine/tasks?state=to-download&limit=' + limit, reader, null, 'GET')).json());
const jobCount = h => [...h.values.keys()].filter(key => key.startsWith('library:muse-job:')).length;
function ops(h) { return {reads:h.reads.length,lists:h.lists.length,writes:h.writes.length}; }
function since(h, before) { const now = ops(h); return {reads:now.reads - before.reads,lists:now.lists - before.lists,writes:now.writes - before.writes}; }
// The client gives up while the Worker is in the middle of a batch: every job write after the first `allowed` ones never completes.
function killAfter(h, allowed) {
  const put = h.kv.put.bind(h.kv);
  let jobs = 0, active = true;
  h.kv.put = async (key, value, options) => {
    if (active && key.startsWith('library:muse-job:') && ++jobs > allowed) return new Promise(() => {});
    return put(key, value, options);
  };
  return () => { active = false; h.kv.put = put; };
}
const settle = (promise, ms = 150) => Promise.race([promise.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('cut off'), ms))]);

async function run() {
  // ---- the incident: a 35-item batch is cut off after 33 job writes. The old end-of-batch index write never ran: 0 of 33 indexed.
  let h = await create();
  const batch = items('cut', 0, 35);
  const restore = killAfter(h, 33);
  assert.equal(await settle(register(h, batch)), 'cut off');
  restore();
  assert.equal(jobCount(h), 33, 'the job records of the finished items are in KV');
  assert.equal(indexed(h).length, 30, 'six groups of five were saved as they finished; only the unfinished tail is missing');
  assert.equal(quota(h), 30, 'the daily count follows the saved groups');

  // ---- path 1: the client replays the same batch. Existing tasks are skipped and put back in the index; nothing else is written for them.
  let replay = await (await register(h, batch)).json();
  assert.deepEqual(replay.counts, {registered:2,skipped:33,overQuota:0,rejected:0});
  assert.equal(indexed(h).length, 35, 'a replay completes the index');
  assert.equal(quota(h), 32, 'only newly registered DOIs are counted; the three unsaved ones of the cut-off group stay uncounted (at most one group)');
  const writesBefore = h.writes.length;
  replay = await (await register(h, batch)).json();
  assert.deepEqual(replay.counts, {registered:0,skipped:35,overQuota:0,rejected:0});
  assert.equal(h.writes.length, writesBefore, 'a replay that finds the index complete writes nothing');

  // ---- path 2: nobody replays. The next claim or list finds the missing tasks from the queue pointers (one list operation).
  h = await create();
  const restore2 = killAfter(h, 33);
  assert.equal(await settle(register(h, items('cut', 0, 35))), 'cut off');
  restore2();
  assert.equal(indexed(h).length, 30);
  const before = ops(h);
  const listed = await toDownload(h);
  assert.equal(listed.tasks.length, 33, 'the list shows every task that was written');
  assert.equal(indexed(h).length, 33);
  const cost = since(h, before);
  assert.equal(cost.lists, 1, 'one list of the queue pointers');
  assert(cost.reads <= 80, 'three healed tasks (pointer + record each, the index read three times) plus the 33 listed records: ' + cost.reads);
  const claim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert(claim.task, 'a downloader can claim from the healed index');

  // ---- the production gap: 99 waiting tasks written, none in the index. After deployment nobody has to call anything: downloader claims alone work through all 99.
  h = await create();
  for (const [from, count] of [[0,50],[50,49]]) assert.equal((await register(h, items('gap', from, count))).status, 200);
  const gapDoc = stored(h, INDEX);
  assert.equal(Object.keys(gapDoc.entries).length, 99);
  gapDoc.entries = {};
  h.values.set(INDEX, JSON.stringify(gapDoc));
  const claimed = new Set();
  for (let n = 0; n < 110 && claimed.size < 99; n++) {
    const body = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
    if (body.task) claimed.add(body.task.doi);
    if (n < 4) await advance(h, 61000);   // a few minutes pass; the heal runs at most once a minute
  }
  assert.equal(claimed.size, 99, 'every one of the 99 tasks was handed to a downloader');

  // ---- the heal is bounded and throttled: 45 missing tasks come back 40 per run, at most one run every two minutes per isolate
  h = await create();
  assert.equal((await register(h, items('big', 0, 50))).status, 200);
  assert.equal((await register(h, items('big', 50, 10))).status, 200);
  const doc = stored(h, INDEX);
  const dropped = Object.keys(doc.entries).sort().slice(0, 45);
  for (const doi of dropped) delete doc.entries[doi];
  h.values.set(INDEX, JSON.stringify(doc));
  assert.equal(indexed(h).length, 15);
  const counts = [];
  let t0 = ops(h);
  await toDownload(h, 1);
  counts.push(indexed(h).length);
  const first = since(h, t0);
  assert.equal(first.lists, 1);
  assert(first.reads + first.writes <= 100, 'one run touches at most about 84 operations: ' + JSON.stringify(first));
  t0 = ops(h);
  await toDownload(h, 1);
  assert.equal(since(h, t0).lists, 0, 'a second request inside the window does not list again ' + JSON.stringify(h.lists.slice(-3)));
  assert.equal(indexed(h).length, counts[0]);
  assert.equal(counts[0], 55, '15 + 40 healed');
  await advance(h, 61000);
  await toDownload(h, 1);
  assert.equal(indexed(h).length, 60);
  t0 = ops(h);
  await advance(h, 61000);
  await toDownload(h, 1);
  assert.equal(since(h, t0).lists, 1);
  assert(since(h, t0).reads <= 3, 'a complete index costs one list and no pointer reads: ' + JSON.stringify(since(h, t0)));

  // ---- a pointer that needs no entry (record gone) is read once, then remembered
  h = await create();
  await register(h, items('stale', 0, 3));
  const key = [...h.values.keys()].find(name => name.startsWith('library:muse-queue:'));
  h.values.delete('library:muse-job:10.1000/stale.0');
  h.values.delete('library:muse-job:10.1000/stale.1');
  const drop = stored(h, INDEX);
  delete drop.entries['10.1000/stale.0']; delete drop.entries['10.1000/stale.1'];
  h.values.set(INDEX, JSON.stringify(drop));
  assert(key);
  t0 = ops(h);
  await toDownload(h, 5);
  const firstStale = since(h, t0);
  await advance(h, 61000);
  t0 = ops(h);
  await toDownload(h, 5);
  const secondStale = since(h, t0);
  assert(secondStale.reads < firstStale.reads, 'the judged pointers are not read again: ' + JSON.stringify([firstStale, secondStale]));
  assert.deepEqual(indexed(h), ['10.1000/stale.2']);

  // ---- switch: MACHINE_INDEX_SELF_HEAL=off removes the extra list completely
  h = await create();
  h.env.MACHINE_INDEX_SELF_HEAL = 'off';
  const restore3 = killAfter(h, 33);
  assert.equal(await settle(register(h, items('off', 0, 35))), 'cut off');
  restore3();
  await toDownload(h);
  assert.equal(h.lists.filter(entry => entry.prefix === 'library:muse-queue:').length, 0);
  assert.equal(indexed(h).length, 30);

  // ---- two batches at the same time: a lost update on the shared index is repaired by the same mechanisms
  h = await create();
  const [one, two] = await Promise.all([register(h, items('par', 0, 30)), register(h, items('par', 100, 30))]);
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  assert.equal(jobCount(h), 60);
  const lostAtFirst = 60 - indexed(h).length;
  for (let n = 0; n < 4 && indexed(h).length < 60; n++) { await toDownload(h, 1); await advance(h, 61000); }
  assert.equal(indexed(h).length, 60, 'the index covers every task (lost at first: ' + lostAtFirst + ')');


  // ---- the hourly audit (POST /api/muse/review {"action":"index-audit"}, GitHub OIDC, no machine token): compares every job record with the index
  const audit = async (h, body, options = {}) => h.context.worker.fetch(new Request(reviewUrl, {method:'POST',headers:{authorization:'Bearer ' + (options.token || await token(h, reviewUrl, 'muse-review.yml')),'content-type':'application/json'},body:JSON.stringify(body)}), h.env);
  const seedDone = (h, n, state = 'available') => {
    const doi = '10.1000/done.' + n, id = crypto.randomUUID(), createdAt = Date.now() - 1e8 + n;
    h.values.set('library:muse-job:' + doi, JSON.stringify({version:1,id,doi,state,createdAt,updatedAt:createdAt,queueKey:'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id}));
    return doi;
  };
  h = await create();
  assert.equal((await register(h, items('aud', 0, 50))).status, 200);
  assert.equal((await register(h, items('aud', 50, 10))).status, 200);
  for (let n = 0; n < 350; n++) seedDone(h, n);
  const ghost = seedDone(h, 999);   // an available task that still has an index entry
  const auditDoc = stored(h, INDEX);
  const queuedDois = Object.keys(auditDoc.entries).sort();
  assert.equal(queuedDois.length, 60);
  for (const doi of queuedDois.slice(0, 45)) delete auditDoc.entries[doi];                   // 45 missing
  auditDoc.entries[queuedDois[50]] = {...auditDoc.entries[queuedDois[50]], u: auditDoc.entries[queuedDois[50]].u + 5};  // 1 stale
  auditDoc.entries[ghost] = {i:crypto.randomUUID(),s:'queued',c:1,u:1,e:0,w:Date.now()};     // 1 extra
  h.values.set(INDEX, JSON.stringify(auditDoc));
  assert.equal((await audit(h, {action:'index-audit'}, {token:'not-a-token'})).status, 401);
  assert.equal((await audit(h, {action:'index-audit',extra:1})).status, 400);
  assert.equal((await audit(h, {action:'index-audit',cursor:5})).status, 400);
  h.env.MACHINE_INDEX_SELF_HEAL = 'off';
  let report = await (await audit(h, {action:'index-audit'})).json();
  const totals = {scanned:0,candidates:0,missing:0,stale:0,extra:0,repaired:0};
  let cursor = '', chunks = 0;
  const snapshot = JSON.stringify(stored(h, INDEX));
  do {
    report = await (await audit(h, cursor ? {action:'index-audit',cursor} : {action:'index-audit'})).json();
    assert.equal(report.ok, true);
    for (const key of Object.keys(totals)) totals[key] += report[key];
    cursor = report.cursor; chunks++;
  } while (!report.done && chunks < 10);
  assert(chunks >= 2, 'a ledger of 400+ records takes more than one bounded request: ' + chunks);
  assert.deepEqual(totals, {scanned:411,candidates:60,missing:45,stale:1,extra:1,repaired:0}, 'report only while the switch is off');
  assert.equal(JSON.stringify(stored(h, INDEX)), snapshot, 'the switch off: the audit changes nothing');
  delete h.env.MACHINE_INDEX_SELF_HEAL;
  const fixed = {scanned:0,candidates:0,missing:0,stale:0,extra:0,repaired:0};
  cursor = ''; chunks = 0;
  do {
    report = await (await audit(h, cursor ? {action:'index-audit',cursor} : {action:'index-audit'})).json();
    for (const key of Object.keys(fixed)) fixed[key] += report[key];
    cursor = report.cursor; chunks++;
  } while (!report.done && chunks < 10);
  assert.deepEqual(fixed, {scanned:411,candidates:60,missing:45,stale:1,extra:1,repaired:47});
  assert.deepEqual(indexed(h), queuedDois, 'the index holds exactly the 60 waiting tasks');
  const clean = {missing:0,stale:0,extra:0,repaired:0};
  cursor = ''; chunks = 0;
  do {
    report = await (await audit(h, cursor ? {action:'index-audit',cursor} : {action:'index-audit'})).json();
    for (const key of Object.keys(clean)) clean[key] += report[key];
    cursor = report.cursor; chunks++;
  } while (!report.done && chunks < 10);
  assert.deepEqual(clean, {missing:0,stale:0,extra:0,repaired:0}, 'a second audit finds nothing');
  console.log('  audit of 411 records: ' + chunks + ' requests, bounded by ' + 300 + ' operations each');

  // ---- the verify job's step (scripts/muse_review_runner.cjs runIndexAudit): warns on a gap, repairs it, fails only when the gap stays
  h = await create();
  assert.equal((await register(h, items('run', 0, 50))).status, 200);
  const runDoc = stored(h, INDEX);
  for (const doi of Object.keys(runDoc.entries).slice(0, 30)) delete runDoc.entries[doi];
  h.values.set(INDEX, JSON.stringify(runDoc));
  const runEnv = {GITHUB_EVENT_NAME:'schedule',ACTIONS_ID_TOKEN_REQUEST_URL:'https://unit.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-runtime-token'};
  const runHttp = async (url, init) => {
    if (new URL(url).hostname === 'unit.actions.githubusercontent.com') return Response.json({value:await token(h, reviewUrl, 'muse-review.yml')});
    return h.context.worker.fetch(new Request(url, init), h.env);
  };
  let logs = [];
  h.env.MACHINE_INDEX_SELF_HEAL = 'off';
  await assert.rejects(runIndexAudit(runEnv, runHttp, line => logs.push(line)), /index_mismatch/);
  assert(logs.some(line => line.startsWith('::warning::')), 'the gap is reported as a warning annotation');
  assert.equal(indexed(h).length, 20, 'switch off: nothing repaired');
  delete h.env.MACHINE_INDEX_SELF_HEAL;
  logs = [];
  const repaired = await runIndexAudit(runEnv, runHttp, line => logs.push(line));
  assert.deepEqual({missing:repaired.missing,repaired:repaired.repaired}, {missing:30,repaired:30});
  assert(logs.some(line => line.startsWith('::warning::')));
  assert.equal(indexed(h).length, 50);
  logs = [];
  assert.equal((await runIndexAudit(runEnv, runHttp, line => logs.push(line))).mismatch, 0);
  assert(!logs.some(line => line.startsWith('::warning::')), 'no gap, no warning');
  const olderSite = await runIndexAudit(runEnv, async (url, init) => new URL(url).hostname === 'unit.actions.githubusercontent.com' ? Response.json({value:'a.b.c'}) : Response.json({ok:false,error:'muse_bad_request'}, {status:400}), line => logs.push(line));
  assert.equal(olderSite.skipped, true);

  // ---- register reads the index back: a write that a concurrent writer overwrote is done again; one that keeps failing makes the request fail (503) and the idempotent retry completes it
  h = await create();
  const clobber = {on:1};
  const realPut = h.kv.put.bind(h.kv);
  h.kv.put = async (key, value, options) => {
    await realPut(key, value, options);
    if (key === INDEX && clobber.on > 0) { clobber.on--; h.values.set(INDEX, JSON.stringify({version:1,ready:true,entries:{},builtAt:Date.now()})); }   // another writer saved an older copy
  };
  const lostOnce = await register(h, items('lost', 0, 5));
  assert.equal(lostOnce.status, 200);
  assert.equal(indexed(h).length, 5, 'the overwritten write was repeated');
  clobber.on = 99;
  const lostAlways = await register(h, items('lost', 5, 5));
  assert.equal(lostAlways.status, 503);
  assert.equal((await lostAlways.json()).error, 'library_sync_pending');
  assert.equal(jobCount(h), 10, 'the records are written; only the index is behind');
  clobber.on = 0;
  const retried = await (await register(h, items('lost', 5, 5))).json();
  assert.deepEqual(retried.counts, {registered:0,skipped:5,overQuota:0,rejected:0});
  assert(indexed(h).includes('10.1000/lost.9'), 'the idempotent retry puts the tasks back in the index');
  h.kv.put = realPut;

  // ---- every request stays bounded: a full 50-item batch, and how many KV operations it takes
  h = await create();
  let inFlight = 0, maxInFlight = 0;
  for (const name of ['get','put','delete','list']) {
    const original = h.kv[name].bind(h.kv);
    h.kv[name] = async (...args) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); try { return await original(...args); } finally { inFlight--; } };
  }
  t0 = ops(h);
  const full = await (await register(h, items('full', 0, 50))).json();
  const fullCost = since(h, t0);
  assert.equal(full.counts.registered, 50);
  assert.equal(indexed(h).length, 50);
  assert.equal(quota(h), 50);
  assert(maxInFlight <= 5, 'at most one group of five is written at the same time: ' + maxInFlight);
  console.log('  50 new items: ' + JSON.stringify(fullCost) + ', most KV calls in flight ' + maxInFlight);
  assert(fullCost.reads + fullCost.lists + fullCost.writes < 1000, 'far below the 1000 operations a request may use');
  t0 = ops(h);
  const again = await (await register(h, items('full', 0, 50))).json();
  const againCost = since(h, t0);
  assert.equal(again.counts.skipped, 50);
  assert.equal(againCost.writes, 0, 'replaying 50 existing tasks with a complete index writes nothing');
  console.log('  50 replayed items: ' + JSON.stringify(againCost));
  console.log('machine index heal tests passed');
}
// Moves the synthetic clock of the harness.
async function advance(h, ms) {
  h.clock.now += ms;
}
module.exports = {run};
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
