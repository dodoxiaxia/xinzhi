'use strict';
// Synthetic tokens and in-memory KV only. No live services.
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
  const h = await setup({clock:{now:Date.now()},...options});
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
// Seed after priming, including the candidate index; queueKey always matches createdAt.
function seedJob(h, doi, state, createdAt, extra = {}) {
  const id = crypto.randomUUID();
  const queueKey = 'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id;
  const job = {version:1,id,doi,state,createdAt,updatedAt:createdAt,queueKey,...extra};
  if (['running','uploading','verifying'].includes(state)) Object.assign(job, {leaseId:crypto.randomUUID(),leaseUntil:extra.leaseUntil || createdAt + 3600000,acquisitionStartedAt:createdAt});
  h.values.set('library:muse-job:' + doi, JSON.stringify(job));
  if (state === 'queued') h.values.set(queueKey, JSON.stringify({doi,id}));
  h.values.set('library:paper:' + doi, paperRecord(doi, state === 'available' ? 'available' : 'manual_needed'));
  const doc = stored(h, INDEX);
  if (!['available','abandoned'].includes(state)) {
    const e = state === 'queued' ? createdAt + 6 * 86400000 : ['running','uploading'].includes(state) ? Math.min(job.leaseUntil, job.acquisitionStartedAt + 86400000) : 0;
    doc.entries[doi] = {i:id,s:state,c:createdAt,u:createdAt,e,w:Date.now()};
    h.values.set(INDEX, JSON.stringify(doc));
  }
  return job;
}
// A deployment whose index is already built (the first machine request builds it).
async function primed() {
  const h = await create();
  assert.equal((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task, null);
  return h;
}

const HOUR = 3600000;
const key = doi => 'library:muse-job:' + doi;
const raw = (h, doi) => h.values.get(key(doi));
const jobWrites = (h, doi) => h.writes.filter(w => w.key === key(doi)).length;
async function list(h, state = 'failed-awaiting-fallback') {
  const response = await call(h, '/api/machine/tasks?state=' + state, reader, null, 'GET');
  assert.equal(response.status, 200, 'machine list succeeds');
  return (await response.json()).tasks;
}
async function claim(h, token = fallback, state = 'failed-awaiting-fallback') {
  const response = await call(h, '/api/machine/claim', token, {state});
  assert.equal(response.status, 200, 'machine claim succeeds');
  return (await response.json()).task;
}
async function enabled() { const h = await primed(); h.env.STALE_QUEUED_FALLBACK_ENABLED = 'true'; return h; }
function seed(h, suffix, age, state = 'queued', extra = {}) {
  const doi = '10.1000/stale-' + suffix;
  seedJob(h, doi, state, h.context.Date.now() - age, extra);
  return doi;
}
async function run() {
  for (const value of [undefined, 'false', '1']) {
    const h = await primed();
    if (value !== undefined) h.env.STALE_QUEUED_FALLBACK_ENABLED = value;
    const doi = seed(h, 'off', 7 * HOUR), before = raw(h, doi);
    const reads = h.reads.length, writes = h.writes.length;
    assert.equal(await claim(h), null, 'disabled switch ' + value + ': fallback finds no task');
    assert.equal(h.reads.length - reads, 2, 'disabled switch adds no KV read: only index and stats');
    assert(h.writes.slice(writes).every(w => w.key.startsWith('library:machine-rate:stats:')), 'disabled claim writes only stats');
    const listReads = h.reads.length;
    assert.deepEqual((await list(h, 'to-download')).map(t => t.doi), [doi], 'disabled switch leaves stale task in to-download');
    assert.equal(h.reads.length - listReads, 2, 'disabled list adds no KV read: only index and task');
    assert.equal(raw(h, doi), before, 'disabled switch leaves job byte-identical');
    assert.equal(jobWrites(h, doi), 0, 'disabled switch never writes the job');
  }

  let h = await enabled();
  const over = seed(h, 'over', 6 * HOUR + 1000), under = seed(h, 'under', 6 * HOUR - 60000);
  const underBefore = raw(h, under), start = h.context.Date.now();
  const tasks = await list(h);
  const converted = stored(h, key(over)), end = h.context.Date.now();
  assert.equal(converted.state, 'failed', '6h+1s crosses default threshold');
  assert.equal(converted.reason, 'queue_unclaimed', 'conversion records queue_unclaimed');
  assert.equal(converted.autoFallback.reason, '排队超过 6 小时无人领取（attempts=0），自动转兜底', 'conversion stores exact Chinese reason');
  assert.equal(converted.autoFallback.hours, 6, 'default threshold records six hours');
  const at = Date.parse(converted.autoFallback.at);
  assert.equal(new Date(at).toISOString(), converted.autoFallback.at, 'autoFallback.at is canonical ISO');
  assert(at >= start && at <= end, 'autoFallback.at is within sweep window');
  assert.equal(raw(h, under), underBefore, '6h-60s remains byte-identical and queued');
  assert.equal(stored(h, key(under)).state, 'queued', 'just-under threshold is still queued');
  assert(!h.values.has(converted.queueKey), 'conversion deletes queue pointer');
  assert.equal(stored(h, INDEX).entries[over].s, 'failed', 'conversion updates machine index');
  const entry = tasks.find(t => t.doi === over);
  assert(entry, 'fallback list contains converted task');
  assert.equal(entry.state, 'failed-awaiting-fallback', 'list exposes fallback public state');
  assert.equal(entry.reason, 'queue_unclaimed', 'list exposes queue_unclaimed reason');
  assert.deepEqual(entry.autoFallback, converted.autoFallback, 'list exposes autoFallback metadata');
  const first = raw(h, over), count = jobWrites(h, over);
  await list(h); await list(h, 'to-download');
  assert.equal(raw(h, over), first, 'repeated list sweeps preserve record and autoFallback.at');
  assert.equal(jobWrites(h, over), count, 'repeated sweeps do not rewrite converted key');

  h = await enabled(); h.env.STALE_QUEUED_FALLBACK_HOURS = '12';
  const seven = seed(h, 'seven', 7 * HOUR), thirteen = seed(h, 'thirteen', 13 * HOUR), sevenBefore = raw(h, seven);
  await list(h, 'to-download');
  assert.equal(raw(h, seven), sevenBefore, 'custom 12h threshold leaves 7h task untouched');
  assert.equal(stored(h, key(thirteen)).autoFallback.hours, 12, 'custom 12h threshold converts 13h task');
  for (const value of ['0','abc','200','']) {
    h = await enabled(); h.env.STALE_QUEUED_FALLBACK_HOURS = value;
    const doi = seed(h, 'invalid', 6 * HOUR + 1000);
    await list(h);
    assert.equal(stored(h, key(doi)).autoFallback.hours, 6, 'invalid threshold ' + JSON.stringify(value) + ' defaults to 6h');
  }

  h = await enabled();
  const untouched = [];
  for (const [i, extra] of [{softFailCount:1},{returnCount:1},{claimant:'dsh'},{previousReason:'not_oa'},{attempts:2},{acquisitionStartedAt:h.context.Date.now()-HOUR}].entries()) {
    const doi = seed(h, 'attempt' + i, 8 * HOUR, 'queued', extra);
    untouched.push([doi, raw(h, doi), 'claim history ' + JSON.stringify(extra)]);
  }
  for (const state of ['failed','login_required','review','running','uploading','verifying','available','abandoned']) {
    const sha256 = 'a'.repeat(64);
    const doi = seed(h, state, 8 * HOUR, state, {leaseUntil:h.context.Date.now()+HOUR,sha256,bytes:60000,driveFileId:'syntheticDriveFileId12345',candidateKey:'library:muse-candidate:' + sha256});
    untouched.push([doi, raw(h, doi), 'other status ' + state]);
  }
  await list(h); await list(h, 'to-download');
  for (const [doi, before, label] of untouched) assert.equal(raw(h, doi), before, label + ' remains byte-identical after sweeps');

  h = await enabled();
  const claimedDoi = seed(h, 'claim', 7 * HOUR);
  const task = await claim(h);
  assert(task, 'fallback claim immediately sees newly converted task');
  assert.equal(task.doi, claimedDoi, 'fallback claims stale DOI');
  assert.equal(task.state, 'downloading', 'fallback claim exposes downloading state');
  assert.equal(task.claimant, 'fallback', 'fallback token owns claim');
  const running = stored(h, key(claimedDoi));
  assert.equal(running.state, 'running', 'claimed record is running');
  assert.equal(running.previousReason, 'queue_unclaimed', 'claim retains hard failure history');
  const initialNow = h.context.Date.now;
  try {
    h.context.Date.now = () => running.leaseUntil + 1000;
    const expired = (await list(h)).find(t => t.doi === claimedDoi);
    assert(expired, 'expired fallback lease stays in failed-awaiting-fallback');
    assert.equal(expired.reason, 'queue_unclaimed', 'expired fallback lease retains queue_unclaimed');
    assert(!(await list(h, 'to-download')).some(t => t.doi === claimedDoi), 'expired fallback lease never returns to to-download');
  } finally { h.context.Date.now = initialNow; }

  h = await enabled();
  const downloadDoi = seed(h, 'downloader', 7 * HOUR);
  assert.equal((await claim(h, dsh, 'to-download')).doi, downloadDoi, 'downloader claims stale queued task normally');
  const downloaded = stored(h, key(downloadDoi));
  assert.equal(downloaded.state, 'running', 'downloader does not convert stale task');
  assert.equal(downloaded.claimant, 'dsh', 'downloader claim establishes attempt history');
  assert(downloaded.acquisitionStartedAt > 0, 'downloader records acquisition start (attempts greater than zero)');
  assert.equal(downloaded.autoFallback, undefined, 'downloader claim never sweeps');

  h = await enabled();
  const paused = seed(h, 'paused', 7 * HOUR);
  h.values.set('library:attempt:' + paused, JSON.stringify({paused:true}));
  assert.equal(await claim(h), null, 'paused DOI cannot be claimed by fallback after conversion');
  assert.equal(stored(h, key(paused)).reason, 'queue_unclaimed', 'paused DOI still undergoes stale conversion');
  console.log('stale queued fallback tests passed');
}
module.exports = {run};
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
