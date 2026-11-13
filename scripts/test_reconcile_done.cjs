'use strict';
// Offline: POST /api/machine/reconcile-done closes queued tasks whose full text is already stored.
// Dry run by default; writing needs apply:true in the body AND MACHINE_RECONCILE_DONE_ENABLED=true.
// Hooked in at the end of test_download_notify.cjs (which test_muse_reader_upload.cjs already runs).
const assert = require('assert');
const {harness, hash, pdf, record} = require('./test_doi_library_worker.cjs');

const base = 'https://learn.dryz.info';
const fallbackToken = 'synthetic_fallback_token_0123456789abc';
const downloaderToken = 'synthetic_downloader_token_0123456789ab';
const tokens = JSON.stringify([{id: 'fallback-bot', role: 'fallback', token: fallbackToken}, {id: 'dsh', role: 'downloader', token: downloaderToken}]);
const NOW = Date.parse('2026-11-14T02:00:00Z');
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const museJob = (n, doi, state, createdAt, extra = {}) => ({version: 1, id: uuid(n), doi, state, createdAt, updatedAt: createdAt,
  queueKey: 'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + uuid(n), ...extra});
function paperRecord(doi, status, withPdf) {
  const rec = record(status);
  rec.paper = {...rec.paper, doi, id: 'doi-' + hash(doi).slice(0, 16)};
  if (!withPdf) delete rec.pdf;
  return rec;
}

function create(options = {}) {
  const h = harness({clock: {now: NOW}, ...options});
  h.env.MACHINE_TOKENS = tokens;
  h.put = (key, value) => h.values.set(key, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  h.job = (n, doi, state, age, extra) => {
    const job = museJob(n, doi, state, NOW - age, extra);
    h.put('library:muse-job:' + doi, job);
    if (state === 'queued') h.put(job.queueKey, {doi});
    return job;
  };
  h.call = (body, config = {}) => h.context.worker.fetch(new Request(base + '/api/machine/reconcile-done', {
    method: config.method || 'POST',
    headers: {'content-type': 'application/json', ...(config.noAuth ? {} : {authorization: 'Bearer ' + (config.token || fallbackToken)})},
    ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})
  }), h.env);
  return h;
}
const H = 3600000;

(async () => {
  // Fixture: A closes (available paper + verified blob), B has no evidence, C says available but the blob is gone (weak),
  // D has a candidate and a sha on the task but no stored text (weak), E is already done, F is failed.
  function fixture(options) {
    const h = create(options);
    h.job(1, '10.1000/a', 'queued', 8 * H);
    h.put('library:paper:10.1000/a', paperRecord('10.1000/a', 'available', true)); h.put('library:pdf:' + hash(pdf), pdf);
    h.job(2, '10.1000/b', 'queued', 7 * H);
    h.put('library:paper:10.1000/b', paperRecord('10.1000/b', 'manual_needed', false));
    h.job(3, '10.1000/c', 'queued', 6 * H);
    const c = paperRecord('10.1000/c', 'available', true); c.pdf = {...c.pdf, key: 'library:pdf:' + 'c'.repeat(64), sha256: 'c'.repeat(64)};
    h.put('library:paper:10.1000/c', c);
    h.job(4, '10.1000/d', 'queued', 5 * H, {sha256: 'd'.repeat(64)});
    h.put('library:muse-candidate:' + 'd'.repeat(64), Buffer.from('x'));
    h.put('library:paper:10.1000/d', paperRecord('10.1000/d', 'manual_needed', false));
    h.job(5, '10.1000/e', 'available', 9 * H);
    h.job(6, '10.1000/f', 'failed', 9 * H, {reason: 'source_blocked'});
    return h;
  }
  const snapshot = h => JSON.stringify([...h.values.entries()].map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('base64') : v]));

  // 1. Dry run: reads only, lists the evidence, closes nothing, even with the switch on and no apply.
  let h = fixture(); h.env.MACHINE_RECONCILE_DONE_ENABLED = 'true';
  let before = snapshot(h), writesBefore = h.writes.length;
  let res = await h.call({}); assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.mode, 'dry-run'); assert.equal(body.done, true); assert.equal(body.scanned, 6); assert.equal(body.queued, 4); assert.equal(body.closed, 0);
  assert.equal(snapshot(h), before, 'a dry run changes nothing'); assert.equal(h.writes.length, writesBefore);
  const byDoi = Object.fromEntries(body.candidates.map(c => [c.doi, c]));
  assert.deepEqual(Object.keys(byDoi).sort(), ['10.1000/a', '10.1000/c', '10.1000/d']);
  assert.equal(byDoi['10.1000/a'].wouldClose, true); assert.deepEqual(byDoi['10.1000/a'].evidence, ['paper_available', 'pdf_blob_verified']);
  assert.equal(byDoi['10.1000/a'].jobId8, uuid(1).slice(0, 8)); assert.equal(byDoi['10.1000/a'].createdAt, new Date(NOW - 8 * H).toISOString());
  assert.equal(byDoi['10.1000/c'].wouldClose, false); assert(byDoi['10.1000/c'].evidence.includes('paper_available_blob_unverified'));
  assert.equal(byDoi['10.1000/d'].wouldClose, false); assert.deepEqual(byDoi['10.1000/d'].evidence, ['task_has_sha256', 'candidate_stored']);
  assert.equal(body.indexMissing.length, 4, 'no candidate index exists in this fixture, so every queued task is reported as missing from it');
  assert.equal(body.indexReady, false);

  // 2. apply:true with the switch off is refused and writes nothing.
  h = fixture(); before = snapshot(h);
  res = await h.call({apply: true}); assert.equal(res.status, 403); assert.equal((await res.json()).error, 'machine_reconcile_disabled');
  assert.equal(snapshot(h), before);
  h.env.MACHINE_RECONCILE_DONE_ENABLED = 'yes'; res = await h.call({apply: true}); assert.equal(res.status, 403, 'only the string true switches it on');
  assert.equal(snapshot(h), before);

  // 3. apply:true with the switch on closes exactly A: terminal state, audit field, queue key gone, id and createdAt kept.
  h = fixture(); h.env.MACHINE_RECONCILE_DONE_ENABLED = 'true';
  const queueKeyA = 'library:muse-queue:' + String(NOW - 8 * H).padStart(13, '0') + ':' + uuid(1);
  assert(h.values.has(queueKeyA));
  res = await h.call({apply: true}); body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.mode, 'apply'); assert.equal(body.closed, 1);
  const a = JSON.parse(h.values.get('library:muse-job:10.1000/a'));
  assert.equal(a.state, 'available'); assert.equal(a.id, uuid(1)); assert.equal(a.createdAt, NOW - 8 * H);
  assert.equal(a.reconciledDone.by, 'fallback-bot'); assert.equal(a.reconciledDone.previousState, 'queued');
  assert.deepEqual(a.reconciledDone.evidence, ['paper_available', 'pdf_blob_verified']); assert.equal(a.reconciledDone.pdfSha256, hash(pdf));
  assert.equal(a.reconciledDone.at, a.updatedAt);
  assert(!h.values.has(queueKeyA), 'the queue key is deleted');
  assert.equal(JSON.parse(h.values.get('library:muse-job:10.1000/b')).state, 'queued');
  assert.equal(JSON.parse(h.values.get('library:muse-job:10.1000/c')).state, 'queued', 'weak evidence is never closed');
  assert.equal(JSON.parse(h.values.get('library:muse-job:10.1000/d')).state, 'queued');
  assert.equal(JSON.parse(h.values.get('library:muse-job:10.1000/f')).state, 'failed');
  assert.equal(h.writes.filter(w => w.key === 'library:muse-job:10.1000/a' && w.opts && w.opts.expirationTtl).length, 0, 'a done record keeps no TTL');
  // The public view agrees: the task is done.
  const listed = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=done', {headers: {authorization: 'Bearer ' + fallbackToken}}), h.env)).json();
  assert(listed.tasks.some(t => t.doi === '10.1000/a'), 'the closed task is listed as done');
  // Idempotent: a second run finds nothing left to close and writes nothing.
  before = snapshot(h);
  body = await (await h.call({apply: true})).json();
  assert.equal(body.closed, 0); assert.equal(snapshot(h), before);
  assert.equal(body.candidates.filter(c => c.wouldClose).length, 0);

  // 4. Index: a task that is in the candidate index is not reported as missing; the closed one leaves the index.
  h = fixture(); h.env.MACHINE_RECONCILE_DONE_ENABLED = 'true';
  const entry = (n, createdAt) => ({i: uuid(n), s: 'queued', c: createdAt, u: createdAt, e: createdAt + 6 * 86400000, w: NOW});
  h.put('library:machine-index:v1', {version: 1, ready: true, entries: {
    '10.1000/a': entry(1, NOW - 8 * H), '10.1000/b': entry(2, NOW - 7 * H)}});
  body = await (await h.call({})).json();
  assert.deepEqual(body.indexMissing.sort(), ['10.1000/c', '10.1000/d']); assert.equal(body.indexReady, true);
  await h.call({apply: true});
  const index = JSON.parse(h.values.get('library:machine-index:v1'));
  assert(!index.entries['10.1000/a'], 'a done task is removed from the candidate index'); assert(index.entries['10.1000/b']);

  // 5. Chunking: limit 2 walks all six job keys in three requests and the cursor ends.
  h = fixture(); const seen = []; let cursor, pages = 0;
  do {
    body = await (await h.call({limit: 2, ...(cursor ? {cursor} : {})})).json(); pages++;
    seen.push(...body.candidates.map(c => c.doi)); cursor = body.cursor;
    assert(pages < 10);
  } while (!body.done);
  assert.equal(pages, 3); assert.deepEqual(seen.sort(), ['10.1000/a', '10.1000/c', '10.1000/d']);

  // 6. A task that changes between the scan and the write is left alone.
  h = fixture(); h.env.MACHINE_RECONCILE_DONE_ENABLED = 'true';
  const realGet = h.env.QL_KV.get; let reads = 0;
  h.env.QL_KV = {...h.env.QL_KV, get: async (k, t) => {
    if (k === 'library:muse-job:10.1000/a' && ++reads === 2) { const j = JSON.parse(h.values.get(k)); j.updatedAt += 1; h.values.set(k, JSON.stringify(j)); }
    return realGet(k, t);
  }};
  body = await (await h.call({apply: true})).json();
  assert.equal(body.closed, 0); assert.deepEqual(body.skipped, [{doi: '10.1000/a', reason: 'changed_during_scan'}]);
  assert.equal(JSON.parse(h.values.get('library:muse-job:10.1000/a')).state, 'queued');

  // 7. Authorization and request shape. Only the fallback role may call it; nothing is written for a refused call.
  h = fixture(); h.env.MACHINE_RECONCILE_DONE_ENABLED = 'true'; before = snapshot(h);
  assert.equal((await h.call({}, {noAuth: true})).status, 401);
  assert.equal((await h.call({}, {token: downloaderToken})).status, 403);
  assert.equal((await h.call({apply: true}, {token: downloaderToken})).status, 403);
  assert.equal((await h.call(undefined, {method: 'GET', noAuth: true})).status, 405);
  for (const bad of [{apply: 'true'}, {limit: 0}, {limit: 101}, {limit: 1.5}, {cursor: 5}, {extra: 1}]) assert.equal((await h.call(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await h.call('{not json')).status, 400);
  assert.equal(snapshot(h), before);

  // 8. Static: the response and the audit field carry no secrets and no storage failures leak details.
  h = fixture(); h.env.MACHINE_RECONCILE_DONE_ENABLED = 'true';
  const text = await (await h.call({apply: true})).text();
  assert(!text.includes(fallbackToken) && !text.includes(downloaderToken));
  h = fixture(); h.env.QL_KV = {...h.env.QL_KV, list: async () => { throw new Error('synthetic secret=' + fallbackToken); }};
  res = await h.call({}); assert.equal(res.status, 503); assert(!(await res.text()).includes(fallbackToken));

  console.log('Reconcile done: dry run, two gates, evidence rules, audit field, index, chunking, race guard and role checks passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
