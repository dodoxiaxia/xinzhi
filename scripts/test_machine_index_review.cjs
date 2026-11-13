'use strict';
// Review follow-ups for the machine index: read-back checks removals and stale entries, the audit reports what was really repaired,
// the heal pages through long queues and logs, and the runner fails on an unfinished scan. Synthetic tokens and an in-memory KV only.
const assert = require('assert');
const crypto = require('crypto');
const {setup,token} = require('./test_fulltext_auth_helpers.cjs');
const {runIndexAudit} = require('./muse_review_runner.cjs');
const base = 'https://learn.dryz.info', reviewUrl = base + '/api/muse/review';
const dsh = 'synthetic_downloader_token_0123456789ab';
const reader = 'synthetic_reader_token_0123456789abcdef';
const tokens = JSON.stringify([{id:'dsh',role:'downloader',token:dsh},{id:'ddx',role:'reader',token:reader}]);
const INDEX = 'library:machine-index:v1';
async function create() {
  const clock = {now:Date.now()};
  const h = await setup({clock});
  h.clock = clock;
  h.env.MUSE_FULLTEXT_ENABLED = 'true';
  h.env.MACHINE_TOKENS = tokens;
  await call(h, '/api/machine/claim', dsh, {state:'to-download'});
  assert.equal(stored(h, INDEX).ready, true);
  return h;
}
function call(h, route, secret, body, method = 'POST') {
  const init = {method,headers:{authorization:'Bearer ' + secret,'content-type':'application/json'}};
  if (method !== 'GET') init.body = JSON.stringify(body);
  return h.context.worker.fetch(new Request(base + route, init), h.env);
}
const items = (prefix, from, count) => Array.from({length:count}, (_, n) => ({doi:'10.1000/' + prefix + '.' + (from + n),title:'Synthetic review title number ' + (from + n),source:'rss-synthetic',section:'MAIN'}));
const register = (h, list) => call(h, '/api/machine/register', dsh, {items:list});
const stored = (h, key) => { const value = h.values.get(key); return value === undefined ? undefined : JSON.parse(value); };
const indexed = h => Object.keys((stored(h, INDEX) || {entries:{}}).entries).sort();
const toDownload = (h, limit = 1) => call(h, '/api/machine/tasks?state=to-download&limit=' + limit, reader, null, 'GET');
const audit = async (h, body) => (await h.context.worker.fetch(new Request(reviewUrl, {method:'POST',headers:{authorization:'Bearer ' + await token(h, reviewUrl, 'muse-review.yml'),'content-type':'application/json'},body:JSON.stringify(body)}), h.env)).json();
async function auditJobs(h) {
  const total = {missing:0,stale:0,extra:0,repaired:0};
  let cursor = '', report, n = 0;
  do {
    report = await audit(h, cursor ? {action:'index-audit',cursor} : {action:'index-audit'});
    for (const key of Object.keys(total)) total[key] += report[key];
    cursor = report.cursor; n++;
  } while (!report.done && n < 10);
  return total;
}
function seedDone(h, n) {
  const doi = '10.1000/gone.' + n, id = crypto.randomUUID(), createdAt = h.clock.now - 1e8 + n;
  h.values.set('library:muse-job:' + doi, JSON.stringify({version:1,id,doi,state:'available',createdAt,updatedAt:createdAt,queueKey:'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id}));
  return doi;
}
function seedQueued(h, n) {
  const doi = '10.1000/long.' + n, id = crypto.randomUUID(), createdAt = h.clock.now - 1e7 + n;
  const queueKey = 'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id;
  h.values.set('library:muse-job:' + doi, JSON.stringify({version:1,id,doi,state:'queued',createdAt,updatedAt:createdAt,queueKey}));
  h.values.set(queueKey, JSON.stringify({doi,id}));
  return doi;
}
// Whenever the index is written, `after` may put another copy over it (a concurrent writer that read the document earlier).
function clobberIndex(h, after) {
  const put = h.kv.put.bind(h.kv);
  h.kv.put = async (key, value, options) => { await put(key, value, options); if (key === INDEX) after(); };
  return () => { h.kv.put = put; };
}
function capture() {
  const lines = [], saved = {log:console.log,warn:console.warn};
  console.log = (...args) => lines.push(['log', args.join(' ')]);
  console.warn = (...args) => lines.push(['warn', args.join(' ')]);
  return {lines,restore() { console.log = saved.log; console.warn = saved.warn; }};
}
const advance = async (h, ms) => { h.clock.now += ms; };

async function run() {
  // ---- 1. the read-back checks removals and stale updates, not only missing entries
  let h = await create();
  assert.equal((await register(h, items('rb', 0, 5))).status, 200);
  // a stale update: another writer saved an older copy of the entries (same tasks, older updatedAt) over this registration's write
  let once = 1;
  let restore = clobberIndex(h, () => {
    if (once-- <= 0) return;
    const written = stored(h, INDEX);
    for (const entry of Object.values(written.entries)) entry.u -= 1000;
    h.values.set(INDEX, JSON.stringify(written));
  });
  const fresh = await register(h, items('rb', 5, 5));
  assert.equal(fresh.status, 200);
  restore();
  const afterStale = stored(h, INDEX);
  assert.equal(Object.keys(afterStale.entries).length, 10);
  for (const [doi, entry] of Object.entries(afterStale.entries)) {
    if (!/rb\.[5-9]$/.test(doi)) continue;   // the first batch was aged by the same overwrite and is a job for the audit
    const record = stored(h, 'library:muse-job:' + doi);
    assert.equal(entry.u, record.updatedAt, doi + ': the entry matches its record again after the read-back');
  }
  // a removal: the audit deletes an extra entry; a concurrent writer puts it back once; the read-back sees it and deletes it again
  h = await create();
  const ghost = seedDone(h, 1);
  let doc = stored(h, INDEX);
  doc.entries[ghost] = {i:crypto.randomUUID(),s:'queued',c:1,u:1,e:0,w:h.clock.now};
  h.values.set(INDEX, JSON.stringify(doc));
  const ghostDoc = JSON.stringify(doc);
  let back = 1;
  restore = clobberIndex(h, () => { if (back-- > 0) h.values.set(INDEX, ghostDoc); });
  let result = await auditJobs(h);
  restore();
  assert.deepEqual(result, {missing:0,stale:0,extra:1,repaired:1});
  assert(!indexed(h).includes(ghost), 'the removal stuck after the read-back');

  // ---- 2. repaired is what the read-back found, not what was attempted; an unrepaired gap keeps the verify job red
  h = await create();
  assert.equal((await register(h, items('rep', 0, 6))).status, 200);
  doc = stored(h, INDEX);
  const before = JSON.stringify({version:1,ready:true,entries:Object.fromEntries(Object.entries(doc.entries).slice(3)),builtAt:doc.builtAt});
  h.values.set(INDEX, before);
  restore = clobberIndex(h, () => h.values.set(INDEX, before));      // every write is overwritten: the repair cannot stick
  result = await auditJobs(h);
  assert.deepEqual(result, {missing:3,stale:0,extra:0,repaired:0}, 'nothing was repaired, so none is reported as repaired');
  const runEnv = {GITHUB_EVENT_NAME:'schedule',ACTIONS_ID_TOKEN_REQUEST_URL:'https://unit.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-runtime-token'};
  const runHttp = async (url, init) => new URL(url).hostname === 'unit.actions.githubusercontent.com' ? Response.json({value:await token(h, reviewUrl, 'muse-review.yml')}) : h.context.worker.fetch(new Request(url, init), h.env);
  const logs = [];
  await assert.rejects(runIndexAudit(runEnv, runHttp, line => logs.push(line)), /index_mismatch/);
  assert(logs.some(line => line.includes('已修复 0 条')));
  restore();
  h.values.set(INDEX, before);
  result = await auditJobs(h);
  assert.deepEqual(result, {missing:3,stale:0,extra:0,repaired:3}, 'with working storage every gap is repaired and counted');
  assert.equal(indexed(h).length, 6);

  // ---- 3. the heal pages through a long queue (more than one page of pointers, 40 tasks per run)
  h = await create();
  const longDois = Array.from({length:1050}, (_, n) => seedQueued(h, n));
  let runs = 0;
  let lastList = 0;
  const quiet = capture();
  try {
  while (indexed(h).length < 1050 && runs < 60) {
    const listsBefore = h.lists.filter(entry => entry.prefix === 'library:muse-queue:').length;
    assert.equal((await toDownload(h)).status, 200);
    lastList = h.lists.filter(entry => entry.prefix === 'library:muse-queue:').length - listsBefore;
    assert(lastList <= 5, 'at most five list operations per run: ' + lastList);
    await advance(h, 61000);
    runs++;
  }
  } finally { quiet.restore(); }
  assert.equal(indexed(h).length, 1050, 'every pointer was reached, including the ones past the first 1000 (runs: ' + runs + ')');
  assert(runs >= 26 && runs <= 40, 'about 40 tasks per run: ' + runs);
  assert(longDois.every(doi => indexed(h).includes(doi)));
  assert(h.lists.some(entry => entry.prefix === 'library:muse-queue:' && entry.cursor), 'the second page was requested with a cursor');
  // when everything is indexed the walk wraps around and costs one list per run
  const t = h.lists.length;
  await toDownload(h);
  assert(h.lists.length - t <= 5);

  // ---- 4. the heal logs a fixed text on failure and reports what it really repaired
  h = await create();
  assert.equal((await register(h, items('lg', 0, 4))).status, 200);
  doc = stored(h, INDEX);
  const wanted = Object.keys(doc.entries).sort();
  const half = JSON.stringify({version:1,ready:true,entries:{},builtAt:doc.builtAt});
  h.values.set(INDEX, half);
  let seen = capture();
  try {
    assert.equal((await toDownload(h)).status, 200);
  } finally { seen.restore(); }
  assert.deepEqual(seen.lines.filter(([, text]) => text.includes('heal')), [['log','machine index heal: 4 of 4 tasks put back into the index']]);
  assert.equal(indexed(h).length, 4);
  // storage fails while healing: one warning with fixed text, no key, DOI or error text; the request itself still works
  h.values.set(INDEX, half);
  await advance(h, 61000);
  const realGet = h.kv.get.bind(h.kv);
  h.kv.get = async (key, ...rest) => { if (key.startsWith('library:muse-queue:')) throw new Error('synthetic-secret-marker ' + key); return realGet(key, ...rest); };
  seen = capture();
  try { assert.equal((await toDownload(h)).status, 200); } finally { seen.restore(); h.kv.get = realGet; }
  const warned = seen.lines.filter(([level]) => level === 'warn');
  assert.equal(warned.length, 1);
  assert.equal(warned[0][1], 'machine index heal failed; next run retries (0 of 0 repaired)');
  assert(!seen.lines.some(([, text]) => /secret|10\.1000|library:/.test(text)));
  // the entries are written but cannot be read back: the report says 0 of 4, never 4
  h.values.set(INDEX, half);
  await advance(h, 61000);
  restore = clobberIndex(h, () => h.values.set(INDEX, half));
  seen = capture();
  try { assert.equal((await toDownload(h)).status, 200); } finally { seen.restore(); restore(); }
  assert.deepEqual(seen.lines.filter(([, text]) => text.includes('heal')), [['log','machine index heal: 0 of 4 tasks put back into the index']]);
  assert.deepEqual(wanted.length, 4);

  // ---- 5. a scan that hits the request cap without finishing fails the run
  const body = (done, ready = true) => ({ok:true,ready,phase:'jobs',done,cursor:done ? '' : 'next',repair:true,scanned:0,candidates:0,missing:0,stale:0,extra:0,repaired:0,indexed:0,papers:0,orphans:0,orphanDois:[]});
  let calls = 0;
  const endless = async url => new URL(url).hostname === 'unit.actions.githubusercontent.com' ? Response.json({value:'a.b.c'}) : (calls++, Response.json(body(false)));
  const lines = [];
  await assert.rejects(runIndexAudit(runEnv, endless, line => lines.push(line)), /index_audit_incomplete/);
  assert.equal(calls, 40, 'it stopped at the cap');
  assert(lines.some(line => line.startsWith('::warning::') && line.includes('没扫完')));
  calls = 0;
  const lastOne = async url => new URL(url).hostname === 'unit.actions.githubusercontent.com' ? Response.json({value:'a.b.c'}) : (calls++, Response.json(body(calls === 40)));
  assert.equal((await runIndexAudit(runEnv, lastOne, () => {})).requests, 40, 'finishing on the last allowed request is a pass');
  // ---- 6. a change never rolls back an entry that is newer than the record it was based on (upsert and removal), and the audit agrees
  h = await create();
  assert.equal((await register(h, items('nw', 0, 3))).status, 200);
  const [older, newer, same] = ['10.1000/nw.0','10.1000/nw.1','10.1000/nw.2'];
  doc = stored(h, INDEX);
  const recordU = doi => stored(h, 'library:muse-job:' + doi).updatedAt;
  const newState = doi => ({...doc.entries[doi],s:'running',u:recordU(doi) + 500});
  doc.entries[older] = {...doc.entries[older],u:recordU(older) - 500};   // older than the record: stale, the record wins
  doc.entries[newer] = newState(newer);                                  // newer than the record: a later write, kept
  h.values.set(INDEX, JSON.stringify(doc));
  const newerEntry = JSON.stringify(doc.entries[newer]);
  result = await auditJobs(h);
  assert.deepEqual(result, {missing:0,stale:1,extra:0,repaired:1}, 'only the older entry is a mismatch; the newer one is not reported and not touched');
  assert.equal(JSON.stringify(stored(h, INDEX).entries[newer]), newerEntry);
  assert.equal(stored(h, INDEX).entries[older].u, recordU(older));
  assert.deepEqual(await auditJobs(h), {missing:0,stale:0,extra:0,repaired:0}, 'a second audit agrees');
  // a replayed registration puts the record's entry back, but not over a newer one
  const replay = await register(h, items('nw', 0, 3));
  assert.equal(replay.status, 200, 'a newer stored entry counts as settled: no 503');
  assert.equal(JSON.stringify(stored(h, INDEX).entries[newer]), newerEntry);
  assert.equal(stored(h, INDEX).entries[same].u, recordU(same));
  // removal: the audit finds an entry for a finished task; an entry newer than that record is a later write and stays
  const done1 = seedDone(h, 11), done2 = seedDone(h, 12);
  doc = stored(h, INDEX);
  const doneU = doi => stored(h, 'library:muse-job:' + doi).updatedAt;
  doc.entries[done1] = {i:crypto.randomUUID(),s:'queued',c:1,u:doneU(done1) - 1,e:0,w:h.clock.now};
  doc.entries[done2] = {i:crypto.randomUUID(),s:'queued',c:1,u:doneU(done2) + 1,e:0,w:h.clock.now};
  h.values.set(INDEX, JSON.stringify(doc));
  result = await auditJobs(h);
  assert.deepEqual(result, {missing:0,stale:0,extra:1,repaired:1});
  assert(!indexed(h).includes(done1) && indexed(h).includes(done2));
  assert.deepEqual(await auditJobs(h), {missing:0,stale:0,extra:0,repaired:0});
  // removal racing a newer write: a list reads the record (finished), then another request stores a newer entry before the removal is applied
  h = await create();
  const gone = seedDone(h, 21);
  doc = stored(h, INDEX);
  const goneU = stored(h, 'library:muse-job:' + gone).updatedAt;
  const raced = {i:crypto.randomUUID(),s:'queued',c:1,u:goneU,e:0,w:h.clock.now};
  doc.entries[gone] = raced;
  h.values.set(INDEX, JSON.stringify(doc));
  const getRecord = h.kv.get.bind(h.kv);
  let hook = true;
  h.kv.get = async (key, ...rest) => {
    const value = await getRecord(key, ...rest);
    if (hook && key === 'library:muse-job:' + gone) {
      hook = false;
      const latest = stored(h, INDEX);
      latest.entries[gone] = {...raced,s:'running',u:goneU + 9999};   // the concurrent writer
      h.values.set(INDEX, JSON.stringify(latest));
    }
    return value;
  };
  assert.equal((await toDownload(h)).status, 200);
  assert.equal(stored(h, INDEX).entries[gone].u, goneU + 9999, 'the removal based on the older record did not delete the newer entry');
  // without the race the same removal goes through
  h.kv.get = getRecord;
  doc = stored(h, INDEX);
  doc.entries[gone] = raced;
  h.values.set(INDEX, JSON.stringify(doc));
  assert.equal((await toDownload(h)).status, 200);
  assert(!indexed(h).includes(gone), 'an entry that is not newer than the record is removed');
  console.log('machine index review tests passed');
}
module.exports = {run};
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
