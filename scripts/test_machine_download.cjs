'use strict';
// Synthetic machine tokens only. No live publisher, KV, or model calls.
const assert = require('assert');
const crypto = require('crypto');
const {setup,token} = require('./test_fulltext_auth_helpers.cjs');
const {doi,title,hash,error} = require('./test_doi_library_worker.cjs');
const {runReview} = require('./muse_review_runner.cjs');
const base = 'https://learn.dryz.info';
const reviewUrl = base + '/api/muse/review';
const museKey = 'synthetic_muse_key_0123456789_abcdef';
const dsh = 'synthetic_downloader_token_0123456789ab';
const fallback = 'synthetic_fallback_token_0123456789abcd';
const reader = 'synthetic_reader_token_0123456789abcdef';
const revoked = 'synthetic_revoked_token_0123456789abcdef';
const unknown = 'synthetic_unknown_token_0123456789abcd';
const ip = '203.0.113.8';
const tokens = JSON.stringify([
  {id:'dsh',role:'downloader',token:dsh,revoked:false},
  {id:'fallback',role:'fallback',token:fallback},
  {id:'ddx',role:'reader',token:reader},
  {id:'old',role:'downloader',token:revoked,revoked:true}
]);
function dayOf(h) { return new h.context.Date().toISOString().slice(0, 10); }
function ipKey(day) { return 'library:ip:' + day + ':' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16); }
function rateKey(caller, bucket, day) { return 'library:machine-rate:' + bucket + ':' + caller + ':' + day; }
async function create(options = {}) {
  const h = await setup(options);
  h.env.MUSE_FULLTEXT_ENABLED = 'true';
  h.env.MUSE_FULLTEXT_KEY = museKey;
  h.env.MACHINE_TOKENS = tokens;
  return h;
}
function authHeaders(secret, extra = {}) {
  return {authorization:'Bearer ' + secret,'content-type':'application/json',...extra};
}
function call(h, path, secret, body, options = {}) {
  const headers = {...authHeaders(secret, options.headers || {})};
  const init = {method:options.method || 'POST',headers};
  if (options.method !== 'GET') init.body = options.raw === undefined ? JSON.stringify(body || {}) : options.raw;
  return h.context.worker.fetch(new Request(base + path, init), h.env);
}
function upload(h, bytes, paperDoi, secret = dsh, headers = {}) {
  return h.context.worker.fetch(new Request(base + '/api/machine/upload', {
    method:'PUT',
    headers:{authorization:'Bearer ' + secret,'content-type':'application/pdf','x-machine-doi':paperDoi,...headers},
    body:bytes
  }), h.env);
}
function seedPaper(h, paperDoi, paperTitle = title, status = 'manual_needed', journal = 'Heart') {
  const paper = {id:'doi-' + hash(paperDoi).slice(0, 16),doi:paperDoi,title:paperTitle,journal,authors:['Jane Doe'],date:'2026-10-07',datePrecision:'day',dateBasis:'Crossref published-online',ingestedAt:'2026-10-07T04:00:00.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:status};
  h.values.set('library:paper:' + paperDoi, JSON.stringify({version:1,paper}));
}
function putJob(h, paperDoi, state, createdAt, extra = {}) {
  const id = extra.id || crypto.randomUUID();
  const queueKey = 'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id;
  const job = {version:1,id,doi:paperDoi,state,createdAt,updatedAt:createdAt,queueKey,...extra};
  if (['running','uploading','verifying'].includes(state)) {
    job.leaseId = extra.leaseId || crypto.randomUUID();
    job.leaseUntil = extra.leaseUntil || createdAt + 3600000;
    job.acquisitionStartedAt = extra.acquisitionStartedAt || createdAt;
  }
  h.values.set('library:muse-job:' + paperDoi, JSON.stringify(job));
  h.values.set(queueKey, JSON.stringify({doi:paperDoi,id}));
  return job;
}
function pdfPages(pages) {
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, index) => (3 + index) + ' 0 R').join(' ');
  objects.push('<< /Type /Pages /Count ' + pages.length + ' /Kids [' + kids + '] >>');
  pages.forEach((_, index) => objects.push('<< /Type /Page /Parent 2 0 R /Contents ' + (3 + pages.length + index) + ' 0 R >>'));
  pages.forEach(text => {
    const stream = '(' + String(text).replace(/\\/g, '\\\\').replace(/[()]/g, ch => '\\' + ch) + ') Tj\n';
    objects.push('<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream');
  });
  let body = '%PDF-1.7\n';
  objects.forEach((object, index) => { body += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  if (body.length < 52000) body += '% ' + 'x'.repeat(52000 - body.length) + '\n';
  body += '%%EOF\n';
  return Buffer.from(body);
}
function paperPdf(paperDoi, paperTitle = title, extra = '') { return pdfPages([paperDoi + ' ' + paperTitle + (extra ? ' ' + extra : '')]); }
function plainPdf() { return Buffer.from('%PDF-1.7\nSynthetic reader copy\n' + 'x'.repeat(52000) + '\n%%EOF\n'); }
// Tasks seeded straight into KV bypass the code that keeps the candidate index current; rebuild it from the keys.
async function reindex(h) {
  for (let n = 0; n < 50; n++) { const body = await (await call(h, '/api/machine/requeue', dsh, {reindex:true})).json(); if (body.reindex.ready) return; }
  throw new Error('index did not become ready');
}
function capList(h, max = 10) {
  const original = h.kv.list.bind(h.kv);
  h.kv.list = opts => original({...opts,limit:Math.min(Number(opts.limit) || max, max)});
}
function stored(h, key) { const value = h.values.get(key); return value === undefined ? undefined : JSON.parse(value); }
function jobPuts(h, paperDoi) { return h.writes.filter(write => write.key === 'library:muse-job:' + paperDoi); }
function assertKept(write) { assert(write); assert(write.opts === undefined || write.opts.expirationTtl === undefined); }
function assertWeek(write) { assert(write && write.opts && write.opts.expirationTtl === 604800); }
function humanUpload(h, paperDoi, bytes) {
  const body = new FormData();
  body.append('pdf', new Blob([bytes], {type:'application/pdf'}), 'paper.pdf');
  body.append('passphrase', 'synthetic-passphrase');
  return h.context.worker.fetch(new Request(base + '/api/muse/reader-upload?doi=' + encodeURIComponent(paperDoi), {
    method:'POST',body,headers:{accept:'application/json','cf-connecting-ip':ip}
  }), h.env);
}
async function review(h, body) {
  const auth = await token(h, reviewUrl, 'muse-review.yml');
  return h.context.worker.fetch(new Request(reviewUrl, {method:'POST',headers:{authorization:'Bearer ' + auth,'content-type':'application/json'},body:JSON.stringify(body)}), h.env);
}
(async () => {
  for (const secret of [dsh, fallback, reader, revoked, unknown, museKey]) assert(/^[A-Za-z0-9_-]{32,128}$/.test(secret));

  let h = await create();
  const protocol = await (await h.context.worker.fetch(new Request(base + '/api/machine/protocol'), h.env)).json();
  assert.equal(protocol.configured, true);
  assert.equal(protocol.humanGate, 'exempt');
  assert.equal(protocol.legacyMuse.retireOn, '2026-12-12');
  assert.equal(protocol.legacyMuse.autoDisable, false);
  assert.equal(protocol.claimable.field, 'claimable');
  assert.equal(protocol.claimable.unclaimableReasonField, 'unclaimableReason');
  assert.deepEqual(protocol.claimable.unclaimableReasons, ['verification_failed']);
  assert.equal(protocol.statusDetail.field, 'detail');
  assert.equal(protocol.statusDetail.maxChars, 500);
  assert.deepEqual(protocol.statusDetail.allowed, ['just_accepted']);
  assert.deepEqual(protocol.statusDetail.reasons, ['source_blocked']);
  assert.equal(protocol.limits.listLimitDefault, 20);
  assert.equal(protocol.limits.listLimitMax, 50);
  assert(!JSON.stringify(protocol).includes(dsh));
  assert(!JSON.stringify(protocol).includes(museKey));
  const museProtocol = await (await h.context.worker.fetch(new Request(base + '/api/muse/protocol'), h.env)).json();
  assert.equal(museProtocol.deprecation.downloadRole, 'retired');
  assert.equal(museProtocol.deprecation.retireOn, '2026-12-12');
  assert.equal(museProtocol.deprecation.autoDisable, false);
  assert.equal(museProtocol.enabled, true);
  h.env.MUSE_DOWNLOAD_RETIRE_ON = '2020-01-01';
  const retired = await (await h.context.worker.fetch(new Request(base + '/api/muse/protocol', {headers:{accept:'text/html'}}), h.env)).text();
  assert(retired.includes('2020-01-01'));
  assert(retired.includes('不会自动关闭'));
  h.env.MACHINE_TOKENS = '{';
  const broken = await (await h.context.worker.fetch(new Request(base + '/api/machine/protocol'), h.env)).json();
  assert.equal(broken.configured, false);

  h = await create();
  const beforeRoles = h.writes.length;
  await error(await upload(h, paperPdf(doi), doi, reader), 403, 'machine_forbidden');
  await error(await upload(h, paperPdf(doi), doi, revoked), 401, 'machine_revoked');
  await error(await upload(h, paperPdf(doi), doi, unknown), 401, 'machine_unauthorized');
  await error(await call(h, '/api/machine/status', dsh, {doi,state:'confirmed-abandoned'}), 403, 'machine_forbidden');
  await error(await call(h, '/api/machine/requeue', fallback, {dryRun:true}), 403, 'machine_forbidden');
  await error(await call(h, '/api/machine/claim', dsh, {state:'failed-awaiting-fallback'}), 403, 'machine_forbidden');
  await error(await call(h, '/api/machine/claim', fallback, {state:'to-download'}), 403, 'machine_forbidden');
  await error(await call(h, '/api/machine/status', reader, {doi,state:'failed-awaiting-fallback',reason:'not_oa'}), 403, 'machine_forbidden');
  assert.equal(h.writes.length, beforeRoles);
  assert.equal(h.calls.length, 0);
  const listed = await (await call(h, '/api/machine/tasks?limit=5', reader, null, {method:'GET'})).json();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.tasks, []);

  h = await create();
  seedPaper(h, doi);
  const wrongTitle = paperPdf(doi, 'Unrelated nephrology cohort study');
  await error(await upload(h, wrongTitle, doi), 409, 'machine_identity_mismatch');
  assert(!h.values.has('library:muse-job:' + doi));
  const doiOnPageTwo = pdfPages([title, doi + ' ' + title]);
  await error(await upload(h, doiOnPageTwo, doi), 409, 'machine_identity_mismatch');
  assert(!h.values.has('library:muse-job:' + doi));
  const unreadable = pdfPages(['']);
  await error(await upload(h, unreadable, doi), 409, 'machine_identity_mismatch');
  seedPaper(h, '10.1000/short', 'Hi');
  await error(await upload(h, paperPdf('10.1000/short', 'Hi'), '10.1000/short'), 409, 'machine_identity');
  assert.equal(h.writes.filter(write => write.key.startsWith('library:muse-job:')).length, 0);

  const good = paperPdf(doi);
  const accepted = await upload(h, good, doi, dsh, {origin:'https://attacker.example','sec-fetch-site':'cross-site','cf-connecting-ip':ip});
  assert.equal(accepted.status, 202);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.idempotent, false);
  assert.equal(acceptedBody.task.caller, 'dsh');
  assert.equal(acceptedBody.task.state, 'uploaded-awaiting-verification');
  assert.equal(acceptedBody.task.sha256, hash(good));
  const storedJob = stored(h, 'library:muse-job:' + doi);
  assert.equal(storedJob.source, 'dsh');
  assert.equal(storedJob.caller, 'dsh');
  assertWeek(jobPuts(h, doi).at(-1));
  const replay = await upload(h, good, doi);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.idempotent, true);
  assert.equal(replayBody.task.taskId, acceptedBody.task.taskId);
  assert.equal(stored(h, rateKey('dsh', 'upload', dayOf(h))), 1);
  await error(await upload(h, paperPdf(doi, title, 'revision'), doi), 409, 'machine_conflict');
  assert.equal(stored(h, rateKey('dsh', 'upload', dayOf(h))), 1);

  const form = new FormData();
  form.append('doi', '10.1000/form');
  form.append('pdf', new Blob([paperPdf('10.1000/form')], {type:'application/pdf'}), 'paper.pdf');
  seedPaper(h, '10.1000/form');
  const posted = await h.context.worker.fetch(new Request(base + '/api/machine/upload', {method:'POST',headers:{authorization:'Bearer ' + dsh},body:form}), h.env);
  assert.equal(posted.status, 202);
  assert.equal((await posted.json()).task.caller, 'dsh');

  h.env.MACHINE_UPLOAD_DAILY_LIMIT = '1';
  seedPaper(h, '10.1000/second');
  await error(await upload(h, paperPdf('10.1000/second'), '10.1000/second'), 429, 'machine_rate_limit');
  const fallbackUpload = await upload(h, paperPdf('10.1000/second'), '10.1000/second', fallback);
  assert.equal(fallbackUpload.status, 202);
  assert.equal((await fallbackUpload.json()).task.caller, 'fallback');
  assert.equal(stored(h, rateKey('fallback', 'upload', dayOf(h))), 1);

  seedPaper(h, '10.1000/legacy');
  const legacyOk = await upload(h, paperPdf('10.1000/legacy'), '10.1000/legacy', museKey);
  assert.equal(legacyOk.status, 202);
  assert.equal((await legacyOk.json()).task.caller, 'muse');
  h.env.MACHINE_LEGACY_REVOKED = 'true';
  seedPaper(h, '10.1000/closed-legacy');
  await error(await upload(h, paperPdf('10.1000/closed-legacy'), '10.1000/closed-legacy', museKey), 401, 'machine_unauthorized');
  const stillMuse = await h.context.worker.fetch(new Request(base + '/api/muse/claim', {method:'POST',headers:authHeaders(museKey),body:'{}'}), h.env);
  assert.equal(stillMuse.status, 200);

  h = await create();
  const today = dayOf(h);
  const siteKey = 'library:cap:' + today;
  h.values.set(siteKey, '30');
  h.values.set(ipKey(today), '20');
  await error(await humanUpload(h, doi, plainPdf()), 429, 'library_limit');
  assert.equal(h.values.get(siteKey), '30');
  assert.equal(h.values.get(ipKey(today)), '20');
  seedPaper(h, doi);
  const exempt = await upload(h, paperPdf(doi), doi, dsh, {'cf-connecting-ip':ip,'sec-fetch-site':'cross-site',origin:'https://attacker.example'});
  assert.equal(exempt.status, 202);
  assert.equal(h.values.get(siteKey), '30');
  assert.equal(h.values.get(ipKey(today)), '20');
  assert(!h.writes.some(write => write.key.startsWith('library:cap:') || write.key.startsWith('library:ip:') || write.key.startsWith('library:lock:')));
  putJob(h, '10.1000/requeue-cap', 'failed', Date.now() - 1000, {reason:'not_oa'});
  seedPaper(h, '10.1000/requeue-cap');
  const cappedRequeue = await call(h, '/api/machine/requeue', dsh, {dryRun:false,limit:5});
  assert.equal(cappedRequeue.status, 200);
  assert.equal(h.values.get(siteKey), '30');
  assert.equal(h.values.get(ipKey(today)), '20');

  h = await create();
  const today2 = dayOf(h);
  const siteKey2 = 'library:cap:' + today2;
  h.values.set(siteKey2, '0');
  h.values.set(ipKey(today2), '20');
  await error(await humanUpload(h, doi, plainPdf()), 429, 'library_limit');
  assert.equal(h.values.get(siteKey2), '1');
  assert.equal(h.values.get(ipKey(today2)), '20');
  seedPaper(h, doi);
  const exemptIp = await upload(h, paperPdf(doi), doi, dsh, {'cf-connecting-ip':ip});
  assert.equal(exemptIp.status, 202);
  assert.equal(h.values.get(siteKey2), '1');
  assert.equal(h.values.get(ipKey(today2)), '20');

  h = await create();
  putJob(h, doi, 'queued', Date.now(), {});
  seedPaper(h, doi);
  await error(await call(h, '/api/machine/status', dsh, {doi,state:'failed-awaiting-fallback',reason:'nope'}), 400, 'machine_bad_reason');
  assert.equal(stored(h, 'library:muse-job:' + doi).state, 'queued');
  const failed = await call(h, '/api/machine/status', dsh, {doi,state:'failed-awaiting-fallback',reason:'not_oa'});
  assert.equal(failed.status, 200);
  const failedBody = await failed.json();
  assert.equal(failedBody.task.state, 'failed-awaiting-fallback');
  assert.equal(failedBody.task.reason, 'not_oa');
  assert.equal(failedBody.task.claimable, true);
  assert.equal(failedBody.task.unclaimableReason, undefined);
  assert.equal(failedBody.task.stage, '');
  assert(!failedBody.task.driveFileId);
  assertWeek(jobPuts(h, doi).at(-1));
  const han = await call(h, '/api/machine/status', dsh, {doi,state:'failed-awaiting-fallback',reason:'han_login'});
  assert.equal((await han.json()).task.stage, 'han');
  assert.equal(stored(h, 'library:muse-job:' + doi).state, 'login_required');
  const backfill = await call(h, '/api/machine/status', dsh, {doi,driveFileId:'syntheticDriveFile01'});
  assert.equal((await backfill.json()).task.driveFileId, 'syntheticDriveFile01');
  assert.equal(stored(h, 'library:muse-job:' + doi).state, 'login_required');
  await error(await call(h, '/api/machine/status', dsh, {doi,state:'confirmed-abandoned'}), 403, 'machine_forbidden');
  const abandoned = await call(h, '/api/machine/status', fallback, {doi,state:'confirmed-abandoned',reason:'other'});
  assert.equal(abandoned.status, 200);
  const abandonedBody = await abandoned.json();
  assert.equal(abandonedBody.task.state, 'confirmed-abandoned');
  assert.equal(abandonedBody.task.abandonedBy, 'fallback');
  assertKept(jobPuts(h, doi).at(-1));
  const againAbandoned = await call(h, '/api/machine/status', fallback, {doi,state:'confirmed-abandoned'});
  assert.equal((await againAbandoned.json()).idempotent, true);
  const weekly = await (await call(h, '/api/machine/abandoned', reader, null, {method:'GET'})).json();
  assert.equal(weekly.tasks.length, 1);
  assert.equal(weekly.tasks[0].doi, doi);
  assert.equal(weekly.tasks[0].state, 'confirmed-abandoned');

  h = await create();
  const detailDoi = '10.1000/just-accepted';
  putJob(h, detailDoi, 'queued', Date.now(), {});
  seedPaper(h, detailDoi);
  await reindex(h);
  async function assertDetailRejected(response) {
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'machine_bad_request');
    assert(String(body.message || '').includes('just_accepted'), body.message);
    return body;
  }
  await assertDetailRejected(await call(h, '/api/machine/status', dsh, {doi:detailDoi,state:'failed-awaiting-fallback',reason:'not_oa',detail:'just_accepted'}));
  assert.equal(stored(h, 'library:muse-job:' + detailDoi).state, 'queued');
  assert.equal(stored(h, 'library:muse-job:' + detailDoi).detail, undefined);
  await assertDetailRejected(await call(h, '/api/machine/status', dsh, {doi:detailDoi,state:'failed-awaiting-fallback',reason:'source_blocked',detail:'sciencedirect'}));
  await assertDetailRejected(await call(h, '/api/machine/status', dsh, {doi:detailDoi,state:'failed-awaiting-fallback',reason:'source_blocked',detail:'x'.repeat(501)}));
  const firstNoted = await call(h, '/api/machine/status', dsh, {doi:detailDoi,state:'failed-awaiting-fallback',reason:'source_blocked',detail:'\u0007just_accepted\n'});
  assert.equal(firstNoted.status, 200);
  const firstNotedBody = await firstNoted.json();
  assert.equal(firstNotedBody.task.state, 'to-download');
  assert.equal(firstNotedBody.task.detail, undefined);
  assert.equal(stored(h, 'library:muse-job:' + detailDoi).detail, 'just_accepted');
  const queuedWithNote = await (await call(h, '/api/machine/tasks?state=to-download', reader, null, {method:'GET'})).json();
  const queuedItem = queuedWithNote.tasks.find(task => task.doi === detailDoi);
  assert(queuedItem);
  assert.equal(queuedItem.detail, undefined);
  const secondNoted = await call(h, '/api/machine/status', dsh, {doi:detailDoi,state:'failed-awaiting-fallback',reason:'source_blocked'});
  assert.equal(secondNoted.status, 200);
  const secondNotedBody = await secondNoted.json();
  assert.equal(secondNotedBody.task.state, 'failed-awaiting-fallback');
  assert.equal(secondNotedBody.task.reason, 'source_blocked');
  assert.equal(secondNotedBody.task.detail, 'just_accepted');
  const failedWithNote = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', fallback, null, {method:'GET'})).json();
  const failedItemNoted = failedWithNote.tasks.find(task => task.doi === detailDoi);
  assert(failedItemNoted);
  assert.equal(failedItemNoted.detail, 'just_accepted');
  await assertDetailRejected(await call(h, '/api/machine/status', fallback, {doi:detailDoi,state:'confirmed-abandoned',reason:'other',detail:'just_accepted'}));
  const abandonedNoted = await call(h, '/api/machine/status', fallback, {doi:detailDoi,state:'confirmed-abandoned',reason:'other'});
  assert.equal(abandonedNoted.status, 200);
  assert.equal((await abandonedNoted.json()).task.detail, 'just_accepted');
  const weeklyNoted = await (await call(h, '/api/machine/abandoned', reader, null, {method:'GET'})).json();
  const abandonedItem = weeklyNoted.tasks.find(task => task.doi === detailDoi);
  assert(abandonedItem);
  assert.equal(abandonedItem.detail, 'just_accepted');

  h = await create();
  capList(h);
  const baseTime = Date.now();
  for (let index = 0; index < 11; index++) putJob(h, '10.1000/c' + index, 'running', baseTime + index);
  const queuedDoi = '10.1000/c99';
  putJob(h, queuedDoi, 'queued', baseTime + 100000);
  seedPaper(h, queuedDoi);
  await reindex(h);
  const oldClaim = await h.context.worker.fetch(new Request(base + '/api/muse/claim', {method:'POST',headers:authHeaders(museKey),body:'{}'}), h.env);
  assert.equal(oldClaim.status, 200);
  assert.equal((await oldClaim.json()).task, null);
  assert.equal(stored(h, 'library:muse-job:' + queuedDoi).state, 'queued');
  const found = await call(h, '/api/machine/claim', dsh, {state:'to-download'});
  assert.equal(found.status, 200);
  const foundTask = (await found.json()).task;
  assert.equal(foundTask.doi, queuedDoi);
  assert.equal(foundTask.claimant, 'dsh');
  assert.equal(foundTask.title, title);
  assert(foundTask.leaseId);
  // The 12th task is found without paging through the first ten: the claim read the index, not the queue keys.
  assert.equal(stored(h, 'library:muse-job:' + queuedDoi).claimant, 'dsh');

  h = await create();
  capList(h);
  for (let index = 0; index < 11; index++) {
    const pausedDoi = '10.1000/a' + String(index).padStart(2, '0');
    putJob(h, pausedDoi, 'failed', baseTime + index, {reason:'not_oa'});
    h.values.set('library:attempt:' + pausedDoi, JSON.stringify({paused:true}));
  }
  const openDoi = '10.1000/z-open';
  putJob(h, openDoi, 'failed', baseTime + 50, {reason:'source_blocked',stage:'yiigle'});
  seedPaper(h, openDoi);
  await reindex(h);
  const fallbackClaim = await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'});
  assert.equal((await fallbackClaim.json()).task.doi, openDoi);
  assert.equal(stored(h, 'library:muse-job:' + openDoi).claimant, 'fallback');

  h = await create();
  capList(h);
  putJob(h, '10.1000/p-done', 'available', baseTime);
  const expected = [];
  for (let index = 0; index < 12; index++) {
    const paperDoi = '10.1000/p' + String(index).padStart(2, '0');
    expected.push(paperDoi);
    putJob(h, paperDoi, 'queued', baseTime + index);
  }
  await reindex(h);
  const seen = [];
  let cursor = '';
  for (let page = 0; page < 8; page++) {
    const path = '/api/machine/tasks?state=to-download&limit=5' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const pageBody = await (await call(h, path, dsh, null, {method:'GET'})).json();
    seen.push(...pageBody.tasks.map(task => task.doi));
    if (!pageBody.cursor) break;
    cursor = pageBody.cursor;
  }
  assert.deepEqual(seen.slice().sort(), expected.slice().sort());
  assert.equal(new Set(seen).size, 12);
  const donePage = await (await call(h, '/api/machine/tasks?state=done', reader, null, {method:'GET'})).json();
  assert.deepEqual(donePage.tasks.map(task => task.doi), ['10.1000/p-done']);
  assert.equal(donePage.truncated, undefined);

  h = await create();
  const overLimit = await call(h, '/api/machine/tasks?limit=51', reader, null, {method:'GET'});
  assert.equal(overLimit.status, 400);
  const overBody = await overLimit.json();
  assert.equal(overBody.ok, false);
  assert.equal(overBody.error, 'machine_bad_request');
  assert.equal(overBody.listLimitMax, 50);
  assert(String(overBody.message || '').includes('50'), overBody.message);
  const okMax = await call(h, '/api/machine/tasks?limit=50', reader, null, {method:'GET'});
  assert.equal(okMax.status, 200);
  assert.equal((await okMax.json()).truncated, undefined);

  h = await create();
  capList(h, 1);
  const scanBase = Date.now();
  for (let index = 0; index < 60; index++) putJob(h, '10.1000/aaa-q' + String(index).padStart(2, '0'), 'queued', scanBase + index);
  putJob(h, '10.1000/zzz-done', 'available', scanBase + 1000);
  const truncatedPage = await (await call(h, '/api/machine/tasks?state=done&limit=5', reader, null, {method:'GET'})).json();
  assert.equal(truncatedPage.ok, true);
  assert.equal(truncatedPage.truncated, true);
  assert(truncatedPage.cursor, 'scan cap should leave a cursor');
  assert.deepEqual(truncatedPage.tasks.map(task => task.doi), []);
  const seenDone = [];
  let scanCursor = truncatedPage.cursor;
  for (let page = 0; page < 8 && scanCursor; page++) {
    const body = await (await call(h, '/api/machine/tasks?state=done&limit=5&cursor=' + encodeURIComponent(scanCursor), reader, null, {method:'GET'})).json();
    seenDone.push(...body.tasks.map(task => task.doi));
    scanCursor = body.cursor;
    if (!body.cursor) assert.equal(body.truncated, undefined);
  }
  assert.deepEqual(seenDone, ['10.1000/zzz-done']);
  assert.equal(scanCursor, null);

  h = await create();
  capList(h);
  const requeueDois = [];
  for (let index = 0; index < 12; index++) requeueDois.push('10.1000/r' + String(index).padStart(2, '0'));
  requeueDois.forEach((paperDoi, index) => putJob(h, paperDoi, 'failed', baseTime + index, {reason:'not_oa'}));
  putJob(h, requeueDois[3], 'review', baseTime + 3, {verificationReason:'identity_mismatch',reason:'identity_mismatch'});
  putJob(h, requeueDois[11], 'login_required', baseTime + 11, {reason:'han_login',stage:'han'});
  h.values.set('library:attempt:' + requeueDois[0], JSON.stringify({paused:true}));
  await reindex(h);
  const writesBeforeDry = h.writes.length;
  const dry = await (await call(h, '/api/machine/requeue', dsh, {dryRun:true,limit:50})).json();
  assert.equal(dry.dryRun, true);
  assert.equal(h.writes.length, writesBeforeDry);
  assert(dry.requeued.some(item => item.doi === requeueDois[11] && item.from === 'login_required'));
  assert(dry.requeued.some(item => item.doi === requeueDois[1] && item.from === 'failed'));
  assert(!dry.requeued.some(item => item.doi === requeueDois[3]));
  assert(!dry.requeued.some(item => item.doi === requeueDois[0]));
  const mixedList = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback&limit=50', reader, null, {method:'GET'})).json();
  const reviewItem = mixedList.tasks.find(task => task.doi === requeueDois[3]);
  const failedItem = mixedList.tasks.find(task => task.doi === requeueDois[1]);
  assert.equal(reviewItem.state, 'failed-awaiting-fallback');
  assert.equal(reviewItem.claimable, false);
  assert.equal(reviewItem.unclaimableReason, 'verification_failed');
  assert.equal(reviewItem.reason, 'identity_mismatch');
  assert.equal(failedItem.claimable, true);
  assert.equal(failedItem.unclaimableReason, undefined);
  assert(dry.skippedPaused.some(item => item.doi === requeueDois[0]));
  assert.equal(dry.truncated, false);
  assert(!h.values.has(rateKey('dsh', 'requeue', dayOf(h))));
  const limited = await (await call(h, '/api/machine/requeue', dsh, {dryRun:true,limit:2})).json();
  assert.equal(limited.requeued.length, 2);
  assert.equal(limited.truncated, true);
  assert.equal(h.writes.length, writesBeforeDry);
  const applied = await (await call(h, '/api/machine/requeue', dsh, {dryRun:false,limit:50})).json();
  assert.equal(applied.requeued.length, dry.requeued.length);
  assert.equal(stored(h, 'library:muse-job:' + requeueDois[1]).state, 'queued');
  assert.equal(stored(h, 'library:muse-job:' + requeueDois[11]).state, 'queued');
  assert.equal(stored(h, 'library:muse-job:' + requeueDois[3]).state, 'review');
  assert.equal(stored(h, 'library:muse-job:' + requeueDois[0]).state, 'failed');
  assert.equal(stored(h, rateKey('dsh', 'requeue', dayOf(h))), applied.requeued.length);

  h = await create();
  putJob(h, '10.1000/budget', 'failed', baseTime, {reason:'other'});
  await reindex(h);
  h.values.set(rateKey('dsh', 'requeue', dayOf(h)), '200');
  const dryAtLimit = await (await call(h, '/api/machine/requeue', dsh, {dryRun:true,limit:5})).json();
  assert.equal(dryAtLimit.requeued.length, 1);
  assert.equal(stored(h, 'library:muse-job:10.1000/budget').state, 'failed');
  await error(await call(h, '/api/machine/requeue', dsh, {dryRun:false,limit:5}), 429, 'machine_rate_limit');
  assert.equal(stored(h, 'library:muse-job:10.1000/budget').state, 'failed');

  h = await create();
  seedPaper(h, doi);
  const uploaded = await upload(h, paperPdf(doi), doi);
  assert.equal(uploaded.status, 202);
  const env = {GITHUB_EVENT_NAME:'workflow_dispatch',ACTIONS_ID_TOKEN_REQUEST_URL:'https://unit.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-runtime-token'};
  const http = async (url, init) => {
    if (new URL(url).hostname === 'unit.actions.githubusercontent.com') return Response.json({value:await token(h, reviewUrl, 'muse-review.yml')});
    return h.context.worker.fetch(new Request(url, init), h.env);
  };
  const logs = [];
  assert.equal(await runReview(env, http, async (_bytes, task) => ({verified:false,reason:'identity_mismatch',pages:2,method:'dual_parser_all_pages_title_doi',sha256:task.sha256,bytes:task.bytes}), entry => logs.push(entry), async () => {}), 1);
  assert(logs.some(entry => entry.includes('identity_mismatch')));
  const rejected = stored(h, 'library:muse-job:' + doi);
  assert.equal(rejected.state, 'review');
  assert.equal(rejected.verificationReason, 'identity_mismatch');
  assert.equal(rejected.reason, 'identity_mismatch');
  assertWeek(jobPuts(h, doi).at(-1));
  const publicJob = await (await h.request('/api/library', {method:'GET'})).json();
  assert.equal(publicJob.job.state, 'review');
  assert.equal(publicJob.job.reason, 'identity_mismatch');
  assert(publicJob.job.message.includes('核验未通过'));
  const failedList = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', fallback, null, {method:'GET'})).json();
  assert.equal(failedList.tasks.length, 1);
  assert.equal(failedList.tasks[0].doi, doi);
  assert.equal(failedList.tasks[0].reason, 'identity_mismatch');
  assert.equal(failedList.tasks[0].state, 'failed-awaiting-fallback');
  assert.equal(failedList.tasks[0].claimable, false);
  assert.equal(failedList.tasks[0].unclaimableReason, 'verification_failed');
  // A task whose PDF failed verification keeps its candidate and reason: a fallback claim must not take it or overwrite it.
  const before = h.values.get('library:muse-job:' + doi);
  const picked = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(picked.task, null);
  assert.equal(h.values.get('library:muse-job:' + doi), before);
  assert.equal(stored(h, 'library:muse-job:' + doi).state, 'review');

  const doneDoi = '10.1000/done';
  seedPaper(h, doneDoi);
  assert.equal((await upload(h, paperPdf(doneDoi), doneDoi)).status, 202);
  const verifying = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(verifying.doi, doneDoi);
  const completed = await review(h, {action:'complete',taskId:verifying.taskId,doi:verifying.doi,leaseId:verifying.leaseId,sha256:verifying.sha256,bytes:verifying.bytes,result:'verified',pages:4,method:'dual_parser_all_pages_title_doi'});
  assert.equal(completed.status, 200);
  assert.equal(stored(h, 'library:muse-job:' + doneDoi).state, 'available');
  assertKept(jobPuts(h, doneDoi).at(-1));
  await error(await upload(h, paperPdf(doneDoi, title, 'later'), doneDoi), 409, 'machine_done');

  h = await create();
  h.env.MUSE_DOWNLOAD_RETIRE_ON = '2020-01-01';
  const queued = await h.request();
  assert.equal(queued.status, 202);
  const museClaim = await h.context.worker.fetch(new Request(base + '/api/muse/claim', {method:'POST',headers:authHeaders(museKey),body:'{}'}), h.env);
  const museTask = (await museClaim.json()).task;
  assert(museTask);
  assert.equal(museTask.doi, doi);
  assert.equal(stored(h, 'library:muse-job:' + doi).claimant, 'muse');
  const running = await h.context.worker.fetch(new Request(base + '/api/muse/receipt', {method:'POST',headers:authHeaders(museKey),body:JSON.stringify({doi:museTask.doi,taskId:museTask.taskId,leaseId:museTask.leaseId,state:'running'})}), h.env);
  assert.equal(running.status, 200);
  const original = plainPdf();
  const uploadedReceipt = await h.context.worker.fetch(new Request(base + '/api/muse/receipt', {method:'POST',headers:authHeaders(museKey),body:JSON.stringify({doi:museTask.doi,taskId:museTask.taskId,leaseId:museTask.leaseId,state:'uploaded',sha256:hash(original),bytes:original.length,driveFileId:'syntheticDriveFileId12345'})}), h.env);
  assert.equal(uploadedReceipt.status, 200);
  const musePut = await h.context.worker.fetch(new Request(base + '/api/muse/upload', {method:'PUT',headers:{authorization:'Bearer ' + museKey,'content-type':'application/pdf','x-muse-doi':doi,'x-muse-task-id':museTask.taskId,'x-muse-lease-id':museTask.leaseId},body:original}), h.env);
  assert.equal(musePut.status, 200);
  h = await create();
  h.env.MUSE_DOWNLOAD_RETIRE_ON = '2020-01-01';
  assert.equal((await h.request()).status, 202);
  const claimed = (await (await h.context.worker.fetch(new Request(base + '/api/muse/claim', {method:'POST',headers:authHeaders(museKey),body:'{}'}), h.env)).json()).task;
  const stopped = await h.context.worker.fetch(new Request(base + '/api/muse/receipt', {method:'POST',headers:authHeaders(museKey),body:JSON.stringify({doi:claimed.doi,taskId:claimed.taskId,leaseId:claimed.leaseId,state:'failed'})}), h.env);
  assert.equal(stopped.status, 200);
  const statusHtml = await (await h.request('/api/muse/request', {method:'GET',headers:{accept:'text/html'}})).text();
  assert(statusHtml.includes('重新获取全文') && statusHtml.includes('/api/muse/retry?doi='), 'a stopped task offers the one re-queue action');
  assert(!statusHtml.includes('恢复这个任务'));
  const retryHtml = await (await h.request('/api/muse/retry', {method:'GET',headers:{accept:'text/html'}})).text();
  assert(retryHtml.includes('放回下载队列'));
  assert(retryHtml.includes('确认重新入队'));
  assert(retryHtml.includes('method="post"'));
  assert(!retryHtml.includes('恢复这个任务'));
  assert(!retryHtml.includes('恢复 Muse'));
  const retried = await h.request('/api/muse/retry');
  assert.equal(retried.status, 202);
  assert.equal((await retried.json()).job.state, 'queued');

  h = await create();
  seedPaper(h, doi);
  await error(await upload(h, paperPdf(doi, 'Unrelated nephrology cohort study'), doi), 409, 'machine_identity_mismatch');
  const stats409 = stored(h, 'library:machine-rate:stats:dsh:' + dayOf(h));
  assert.equal(stats409.upload409, 1);
  assert.equal(stats409.claim, 0);
  assert.equal(stats409.emptyClaim, 0);
  await error(await upload(h, paperPdf(doi), doi, reader), 403, 'machine_forbidden');
  assert.equal(stored(h, 'library:machine-rate:stats:dsh:' + dayOf(h)).upload409, 1);
  assert.equal(h.values.has('library:machine-rate:stats:ddx:' + dayOf(h)), false);
  const direct = await upload(h, paperPdf(doi), doi);
  assert.equal(direct.status, 202);
  const directBody = await direct.json();
  assert.equal(directBody.task.claimedAt, undefined);
  assert.equal(directBody.task.claimDurationSeconds, undefined);
  await error(await upload(h, paperPdf(doi, title, 'later'), doi), 409, 'machine_conflict');
  assert.equal(stored(h, 'library:machine-rate:stats:dsh:' + dayOf(h)).upload409, 2);

  h = await create();
  const claimDoi = '10.1000/claim-stat';
  putJob(h, claimDoi, 'queued', Date.now());
  seedPaper(h, claimDoi);
  await reindex(h);
  const claimedStat = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(claimedStat.task.doi, claimDoi);
  assert.equal(claimedStat.task.claimant, 'dsh');
  assert(claimedStat.task.claimedAt);
  const afterClaim = stored(h, 'library:machine-rate:stats:dsh:' + dayOf(h));
  assert.equal(afterClaim.claim, 1);
  assert.equal(afterClaim.emptyClaim, 0);
  const emptyStat = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(emptyStat.task, null);
  assert.equal(emptyStat.retryAfterSeconds, 300);
  assert.equal(emptyStat.retryAfter, 300);
  assert.equal(stored(h, 'library:machine-rate:stats:dsh:' + dayOf(h)).emptyClaim, 1);
  const durUp = await upload(h, paperPdf(claimDoi), claimDoi);
  assert.equal(durUp.status, 202);
  const durBody = await durUp.json();
  assert.equal(durBody.task.claimant, 'dsh');
  assert(durBody.task.claimedAt);
  assert.equal(typeof durBody.task.claimDurationSeconds, 'number');
  assert(durBody.task.claimDurationSeconds >= 0);
  const verifyingJob = stored(h, 'library:muse-job:' + claimDoi);
  assert.equal(verifyingJob.claimant, 'dsh');
  assert(Number.isInteger(verifyingJob.acquisitionStartedAt));
  const claimedReview = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(claimedReview.doi, claimDoi);
  const completedDur = await review(h, {action:'complete',taskId:claimedReview.taskId,doi:claimedReview.doi,leaseId:claimedReview.leaseId,sha256:claimedReview.sha256,bytes:claimedReview.bytes,result:'verified',pages:4,method:'dual_parser_all_pages_title_doi'});
  assert.equal(completedDur.status, 200);
  const doneJob = stored(h, 'library:muse-job:' + claimDoi);
  assert.equal(doneJob.state, 'available');
  assert.equal(doneJob.claimant, 'dsh');
  assert.equal(doneJob.acquisitionStartedAt, verifyingJob.acquisitionStartedAt);
  const doneList = await (await call(h, '/api/machine/tasks?state=done', reader, null, {method:'GET'})).json();
  const doneItem = doneList.tasks.find(task => task.doi === claimDoi);
  assert(doneItem);
  assert.equal(doneItem.claimant, 'dsh');
  assert(doneItem.claimedAt);
  assert.equal(typeof doneItem.claimDurationSeconds, 'number');

  h = await create();
  const softDoi = '10.1000/soft-blocked';
  const softJob = putJob(h, softDoi, 'queued', Date.now(), {});
  seedPaper(h, softDoi);
  await reindex(h);
  const firstBlock = await call(h, '/api/machine/status', dsh, {doi:softDoi,state:'failed-awaiting-fallback',reason:'source_blocked'});
  assert.equal(firstBlock.status, 200);
  const firstBlockBody = await firstBlock.json();
  assert.equal(firstBlockBody.task.state, 'to-download');
  assert.equal(firstBlockBody.task.doi, softDoi);
  const afterFirst = stored(h, 'library:muse-job:' + softDoi);
  assert.equal(afterFirst.state, 'queued');
  assert.equal(afterFirst.id, softJob.id);
  assert.equal(afterFirst.createdAt, softJob.createdAt);
  assert.equal(afterFirst.queueKey, softJob.queueKey);
  assert.equal(afterFirst.softFailCount, 1);
  assert.equal(afterFirst.lastSoftFailReason, 'source_blocked');
  assert.deepEqual(stored(h, softJob.queueKey), {doi:softDoi,id:softJob.id});
  const softFailedList = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', reader, null, {method:'GET'})).json();
  assert(!softFailedList.tasks.some(task => task.doi === softDoi));
  const softQueuedList = await (await call(h, '/api/machine/tasks?state=to-download', reader, null, {method:'GET'})).json();
  assert(softQueuedList.tasks.some(task => task.doi === softDoi && task.state === 'to-download'));
  const secondBlock = await call(h, '/api/machine/status', dsh, {doi:softDoi,state:'failed-awaiting-fallback',reason:'source_blocked'});
  assert.equal(secondBlock.status, 200);
  const secondBlockBody = await secondBlock.json();
  assert.equal(secondBlockBody.task.state, 'failed-awaiting-fallback');
  assert.equal(secondBlockBody.task.reason, 'source_blocked');
  const afterSecond = stored(h, 'library:muse-job:' + softDoi);
  assert.equal(afterSecond.state, 'failed');
  assert.equal(afterSecond.softFailCount, 2);
  assert.equal(h.values.has(softJob.queueKey), false);
  const hardDoi = '10.1000/hard-wrong';
  putJob(h, hardDoi, 'queued', Date.now() + 10, {});
  const wrong = await call(h, '/api/machine/status', dsh, {doi:hardDoi,state:'failed-awaiting-fallback',reason:'wrong_paper'});
  assert.equal(wrong.status, 200);
  assert.equal((await wrong.json()).task.state, 'failed-awaiting-fallback');
  assert.equal(stored(h, 'library:muse-job:' + hardDoi).state, 'failed');
  assert.equal(stored(h, 'library:muse-job:' + hardDoi).softFailCount, undefined);

  h = await create();
  const expireDoi = '10.1000/soft-lease';
  const started = Date.now() - 1000;
  const expireJob = putJob(h, expireDoi, 'running', started, {claimant:'dsh',leaseUntil:started - 1000,acquisitionStartedAt:started - 1000});
  seedPaper(h, expireDoi);
  await reindex(h);
  const expireClaim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(expireClaim.task, null);
  const expireRetried = stored(h, 'library:muse-job:' + expireDoi);
  assert.equal(expireRetried.state, 'queued');
  assert.equal(expireRetried.id, expireJob.id);
  assert.equal(expireRetried.softFailCount, 1);
  const expireAgain = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(expireAgain.task.doi, expireDoi);

  h = await create();
  const oldId = crypto.randomUUID();
  const superDoi = '10.1000/supersede-fail';
  const created = Date.now() - 5000;
  putJob(h, superDoi, 'failed', created, {id:oldId,reason:'lease_expired',claimant:'dsh-mini'});
  seedPaper(h, superDoi);
  await reindex(h);
  const beforeSuperList = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', fallback, null, {method:'GET'})).json();
  assert(beforeSuperList.tasks.some(task => task.doi === superDoi && task.claimable === true));
  const superUp = await upload(h, paperPdf(superDoi), superDoi);
  assert.equal(superUp.status, 202);
  const verifyingSuper = stored(h, 'library:muse-job:' + superDoi);
  assert.notEqual(verifyingSuper.id, oldId);
  assert.equal(verifyingSuper.supersededFrom.taskId, oldId);
  assert.equal(verifyingSuper.supersededFrom.reason, 'lease_expired');
  assert.equal(verifyingSuper.supersededFrom.previousState, 'failed');
  assert.equal(verifyingSuper.supersedes, undefined);
  // Direct PUT over a failed job must leave the archive immediately, before verification completes.
  const archiveKey = 'library:muse-superseded:' + superDoi + ':' + oldId;
  const archivedWhileVerifying = stored(h, archiveKey);
  assert.equal(archivedWhileVerifying.id, oldId);
  assert.equal(archivedWhileVerifying.reason, 'lease_expired');
  assert.equal(archivedWhileVerifying.supersededBy, verifyingSuper.id);
  assert(Number.isInteger(archivedWhileVerifying.supersededAt));
  assertKept(h.writes.filter(write => write.key === archiveKey).at(-1));
  const midSuperList = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', fallback, null, {method:'GET'})).json();
  assert(!midSuperList.tasks.some(task => task.doi === superDoi));
  const superReview = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(superReview.doi, superDoi);
  const superDoneRes = await review(h, {action:'complete',taskId:superReview.taskId,doi:superReview.doi,leaseId:superReview.leaseId,sha256:superReview.sha256,bytes:superReview.bytes,result:'verified',pages:4,method:'dual_parser_all_pages_title_doi'});
  assert.equal(superDoneRes.status, 200);
  const superDone = stored(h, 'library:muse-job:' + superDoi);
  assert.equal(superDone.state, 'available');
  assert.equal(superDone.id, verifyingSuper.id);
  assert.equal(superDone.supersededFrom.taskId, oldId);
  assert.equal(superDone.supersededFrom.reason, 'lease_expired');
  assert.equal(superDone.supersedes, undefined);
  const archived = stored(h, archiveKey);
  assert.equal(archived.id, oldId);
  assert.equal(archived.reason, 'lease_expired');
  assert.equal(archived.supersededBy, superDone.id);
  assert.equal(archived.supersededAt, archivedWhileVerifying.supersededAt);
  const afterSuperList = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', fallback, null, {method:'GET'})).json();
  assert(!afterSuperList.tasks.some(task => task.doi === superDoi));
  const afterSuperClaim = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(afterSuperClaim.task, null);
  const doneSuperList = await (await call(h, '/api/machine/tasks?state=done', reader, null, {method:'GET'})).json();
  const doneSuperItem = doneSuperList.tasks.find(task => task.doi === superDoi);
  assert.equal(doneSuperItem.supersededFrom.taskId, oldId);
  assert.equal(doneSuperItem.state, 'done');

  const claimedFailDoi = '10.1000/supersede-claimed';
  const oldClaimedId = crypto.randomUUID();
  putJob(h, claimedFailDoi, 'running', Date.now() - 2000, {id:oldClaimedId,claimant:'fallback',previousReason:'source_blocked'});
  seedPaper(h, claimedFailDoi);
  const claimedUp = await upload(h, paperPdf(claimedFailDoi), claimedFailDoi, fallback);
  assert.equal(claimedUp.status, 202);
  const claimedVerifying = stored(h, 'library:muse-job:' + claimedFailDoi);
  assert.equal(claimedVerifying.supersededFrom.taskId, oldClaimedId);
  const claimedArchiveEarly = stored(h, 'library:muse-superseded:' + claimedFailDoi + ':' + oldClaimedId);
  assert.equal(claimedArchiveEarly.supersededBy, claimedVerifying.id);
  assert.equal(claimedArchiveEarly.previousReason, 'source_blocked');
  const claimedReviewTask = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(claimedReviewTask.doi, claimedFailDoi);
  const claimedDoneRes = await review(h, {action:'complete',taskId:claimedReviewTask.taskId,doi:claimedReviewTask.doi,leaseId:claimedReviewTask.leaseId,sha256:claimedReviewTask.sha256,bytes:claimedReviewTask.bytes,result:'verified',pages:4,method:'dual_parser_all_pages_title_doi'});
  assert.equal(claimedDoneRes.status, 200);
  const claimedDone = stored(h, 'library:muse-job:' + claimedFailDoi);
  assert.equal(claimedDone.supersededFrom.taskId, oldClaimedId);
  const claimedArchive = stored(h, 'library:muse-superseded:' + claimedFailDoi + ':' + oldClaimedId);
  assert.equal(claimedArchive.supersededBy, claimedDone.id);
  assert.equal(claimedArchive.previousReason, 'source_blocked');

  // fallbackHeldLeaseExpiresToFailed: a hard failure claimed by fallback goes back to failed, keeping reasons.
  h = await create();
  const fbDoi = '10.1000/fb-lease-hard';
  putJob(h, fbDoi, 'failed', Date.now() - 2000, {reason:'not_oa'});
  seedPaper(h, fbDoi);
  await reindex(h);
  const fbClaim = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fbClaim.task.doi, fbDoi);
  const fbHeld = stored(h, 'library:muse-job:' + fbDoi);
  assert.equal(fbHeld.previousReason, 'not_oa');
  assert.equal(fbHeld.claimant, 'fallback');
  const fbStarted = fbHeld.acquisitionStartedAt;
  h.values.set('library:muse-job:' + fbDoi, JSON.stringify({...fbHeld,leaseUntil:Date.now() - 1000,updatedAt:fbHeld.updatedAt + 1}));
  await reindex(h);
  const fbExpiry = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fbExpiry.task, null);
  const fbBack = stored(h, 'library:muse-job:' + fbDoi);
  assert.equal(fbBack.state, 'failed');
  assert.equal(fbBack.reason, 'not_oa');
  assert.equal(fbBack.previousReason, 'not_oa');
  assert.equal(fbBack.claimant, 'fallback');
  assert.equal(fbBack.acquisitionStartedAt, fbStarted);
  const fbQueued = await (await call(h, '/api/machine/tasks?state=to-download', reader, null, {method:'GET'})).json();
  assert(!fbQueued.tasks.some(task => task.doi === fbDoi));
  const fbFailedList = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', reader, null, {method:'GET'})).json();
  const fbItem = fbFailedList.tasks.find(task => task.doi === fbDoi);
  assert.equal(fbItem.state, 'failed-awaiting-fallback');
  assert.equal(fbItem.reason, 'not_oa');
  const fbAgain = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fbAgain.task.doi, fbDoi);

  // hardReasonsGoDirectlyToFallback: han_login, han_quota and other never soft-retry.
  h = await create();
  const hanQuotaDoi = '10.1000/hard-han-quota';
  const otherDoi = '10.1000/hard-other';
  const hanLoginDoi = '10.1000/hard-han-login';
  putJob(h, hanQuotaDoi, 'queued', Date.now());
  putJob(h, otherDoi, 'queued', Date.now() + 1);
  putJob(h, hanLoginDoi, 'queued', Date.now() + 2);
  const quotaRes = await call(h, '/api/machine/status', dsh, {doi:hanQuotaDoi,state:'failed-awaiting-fallback',reason:'han_quota',stage:'han'});
  assert.equal(quotaRes.status, 200);
  const quotaBody = await quotaRes.json();
  assert.equal(quotaBody.task.state, 'failed-awaiting-fallback');
  assert.equal(quotaBody.task.reason, 'han_quota');
  assert.equal(stored(h, 'library:muse-job:' + hanQuotaDoi).state, 'failed');
  assert.equal(stored(h, 'library:muse-job:' + hanQuotaDoi).softFailCount, undefined);
  const otherRes = await call(h, '/api/machine/status', dsh, {doi:otherDoi,state:'failed-awaiting-fallback',reason:'other'});
  assert.equal(otherRes.status, 200);
  assert.equal((await otherRes.json()).task.state, 'failed-awaiting-fallback');
  assert.equal(stored(h, 'library:muse-job:' + otherDoi).state, 'failed');
  const loginRes = await call(h, '/api/machine/status', dsh, {doi:hanLoginDoi,state:'failed-awaiting-fallback',reason:'han_login'});
  assert.equal(loginRes.status, 200);
  assert.equal((await loginRes.json()).task.state, 'failed-awaiting-fallback');
  assert.equal(stored(h, 'library:muse-job:' + hanLoginDoi).state, 'login_required');

  // supersedeChainSurvivesReviewReupload: review then a new official upload keeps supersededBy/supersededFrom.
  h = await create();
  const chainDoi = '10.1000/supersede-chain';
  const chainA = crypto.randomUUID();
  putJob(h, chainDoi, 'failed', Date.now() - 4000, {id:chainA,reason:'not_oa'});
  seedPaper(h, chainDoi);
  await reindex(h);
  const chainUp1 = await upload(h, paperPdf(chainDoi), chainDoi);
  assert.equal(chainUp1.status, 202);
  const chainBJob = stored(h, 'library:muse-job:' + chainDoi);
  const chainB = chainBJob.id;
  assert.notEqual(chainB, chainA);
  assert.equal(chainBJob.supersededFrom.taskId, chainA);
  const chainArchiveA = stored(h, 'library:muse-superseded:' + chainDoi + ':' + chainA);
  assert.equal(chainArchiveA.supersededBy, chainB);
  assert.equal(chainArchiveA.id, chainA);
  assert.equal(chainArchiveA.reason, 'not_oa');
  const chainReview1 = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(chainReview1.doi, chainDoi);
  const chainReject = await review(h, {action:'complete',taskId:chainReview1.taskId,doi:chainReview1.doi,leaseId:chainReview1.leaseId,sha256:chainReview1.sha256,bytes:chainReview1.bytes,result:'rejected',reason:'identity_mismatch',pages:2,method:'dual_parser_all_pages_title_doi'});
  assert.equal(chainReject.status, 200);
  const chainReviewed = stored(h, 'library:muse-job:' + chainDoi);
  assert.equal(chainReviewed.state, 'review');
  assert.equal(chainReviewed.id, chainB);
  assert.equal(chainReviewed.supersededFrom.taskId, chainA);
  assert.equal(stored(h, 'library:muse-superseded:' + chainDoi + ':' + chainA).supersededBy, chainB);
  const chainUp2 = await upload(h, paperPdf(chainDoi, title, 'official'), chainDoi);
  assert.equal(chainUp2.status, 202);
  const chainCJob = stored(h, 'library:muse-job:' + chainDoi);
  const chainC = chainCJob.id;
  assert.notEqual(chainC, chainB);
  assert.equal(chainCJob.supersededFrom.taskId, chainB);
  assert.equal(chainCJob.supersededFrom.supersedes.taskId, chainA);
  const chainArchiveBEarly = stored(h, 'library:muse-superseded:' + chainDoi + ':' + chainB);
  assert.equal(chainArchiveBEarly.supersededBy, chainC);
  assert.equal(chainArchiveBEarly.id, chainB);
  assert.equal(chainArchiveBEarly.supersededFrom.taskId, chainA);
  assert.equal(stored(h, 'library:muse-superseded:' + chainDoi + ':' + chainA).supersededBy, chainB);
  const chainReview2 = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(chainReview2.doi, chainDoi);
  const chainDoneRes = await review(h, {action:'complete',taskId:chainReview2.taskId,doi:chainReview2.doi,leaseId:chainReview2.leaseId,sha256:chainReview2.sha256,bytes:chainReview2.bytes,result:'verified',pages:4,method:'dual_parser_all_pages_title_doi'});
  assert.equal(chainDoneRes.status, 200);
  const chainDone = stored(h, 'library:muse-job:' + chainDoi);
  assert.equal(chainDone.state, 'available');
  assert.equal(chainDone.id, chainC);
  assert.equal(chainDone.supersededFrom.taskId, chainB);
  assert.equal(chainDone.supersededFrom.supersedes.taskId, chainA);
  const chainArchiveB = stored(h, 'library:muse-superseded:' + chainDoi + ':' + chainB);
  assert.equal(chainArchiveB.supersededBy, chainC);
  assert.equal(chainArchiveB.id, chainB);
  assert.equal(chainArchiveB.supersededFrom.taskId, chainA);
  assertKept(h.writes.filter(write => write.key === 'library:muse-superseded:' + chainDoi + ':' + chainB).at(-1));
  h = await create();
  const renewDoi = '10.1000/renew-lease';
  putJob(h, renewDoi, 'queued', Date.now());
  seedPaper(h, renewDoi);
  await reindex(h);
  const renewClaim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(renewClaim.task.doi, renewDoi);
  const renewStarted = stored(h, 'library:muse-job:' + renewDoi).acquisitionStartedAt;
  const beforeUntil = stored(h, 'library:muse-job:' + renewDoi).leaseUntil;
  await error(await call(h, '/api/machine/renew', reader, {doi:renewDoi}), 403, 'machine_forbidden');
  await error(await call(h, '/api/machine/renew', fallback, {doi:renewDoi}), 409, 'machine_lease_required');
  const renewed = await call(h, '/api/machine/renew', dsh, {doi:renewDoi,leaseId:renewClaim.task.leaseId});
  assert.equal(renewed.status, 200);
  const renewedBody = await renewed.json();
  const afterUntil = stored(h, 'library:muse-job:' + renewDoi).leaseUntil;
  assert(afterUntil >= beforeUntil + 19 * 60 * 1000);
  assert(afterUntil <= renewStarted + 7200000);
  assert.equal(Date.parse(renewedBody.task.leaseUntil), afterUntil);
  await error(await call(h, '/api/machine/renew', dsh, {doi:renewDoi,leaseId:'00000000-0000-4000-8000-000000000000'}), 409, 'machine_lease_required');

  const capDoi = '10.1000/renew-cap';
  const capStart = Date.now() - 100 * 60 * 1000;
  putJob(h, capDoi, 'running', capStart, {claimant:'dsh',acquisitionStartedAt:capStart,leaseUntil:capStart + 7200000});
  seedPaper(h, capDoi);
  await error(await call(h, '/api/machine/renew', dsh, {doi:capDoi}), 409, 'machine_lease_limit');
  const clipDoi = '10.1000/renew-clip';
  const clipStart = Date.now() - 110 * 60 * 1000;
  putJob(h, clipDoi, 'running', clipStart, {claimant:'dsh',acquisitionStartedAt:clipStart,leaseUntil:Date.now() + 5 * 60 * 1000});
  seedPaper(h, clipDoi);
  const clipped = await call(h, '/api/machine/renew', dsh, {doi:clipDoi});
  assert.equal(clipped.status, 200);
  assert.equal(stored(h, 'library:muse-job:' + clipDoi).leaseUntil, clipStart + 7200000);

  h = await create();
  const retDoi = '10.1000/return-task';
  const retJob = putJob(h, retDoi, 'queued', Date.now());
  seedPaper(h, retDoi);
  await reindex(h);
  const retClaim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(retClaim.task.doi, retDoi);
  await error(await call(h, '/api/machine/return', fallback, {doi:retDoi}), 409, 'machine_lease_required');
  const returned = await call(h, '/api/machine/return', dsh, {doi:retDoi});
  assert.equal(returned.status, 200);
  const returnedBody = await returned.json();
  assert.equal(returnedBody.task.state, 'to-download');
  assert.equal(returnedBody.task.returnCount, 1);
  const afterReturn = stored(h, 'library:muse-job:' + retDoi);
  assert.equal(afterReturn.state, 'queued');
  assert.equal(afterReturn.id, retJob.id);
  assert.equal(afterReturn.createdAt, retJob.createdAt);
  assert.equal(afterReturn.queueKey, retJob.queueKey);
  assert.equal(afterReturn.returnCount, 1);
  assert.equal(afterReturn.softFailCount, undefined);
  assert.deepEqual(stored(h, retJob.queueKey), {doi:retDoi,id:retJob.id});
  assert.equal(stored(h, 'library:machine-rate:stats:dsh:' + dayOf(h)).release, 1);
  assert.equal(stored(h, 'library:muse-job:' + retDoi).reason, undefined);
  const reclaimed = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(reclaimed.task.doi, retDoi);
  await call(h, '/api/machine/return', dsh, {doi:retDoi});
  const secondClaim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(secondClaim.task.doi, retDoi);
  await call(h, '/api/machine/return', dsh, {doi:retDoi});
  assert.equal(stored(h, 'library:muse-job:' + retDoi).returnCount, 3);
  const thirdClaim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(thirdClaim.task.doi, retDoi);
  await error(await call(h, '/api/machine/return', dsh, {doi:retDoi}), 409, 'machine_return_limit');
  const stuck = stored(h, 'library:muse-job:' + retDoi);
  assert.equal(stuck.state, 'running');
  assert.equal(stuck.claimant, 'dsh');
  assert.equal(stuck.returnCount, 3);
  const failInstead = await call(h, '/api/machine/status', dsh, {doi:retDoi,state:'failed-awaiting-fallback',reason:'not_oa'});
  assert.equal(failInstead.status, 200);
  assert.equal((await failInstead.json()).task.state, 'failed-awaiting-fallback');

  // fallbackReturnKeepsHardFailure: fallback return goes to failed-awaiting-fallback, not to-download.
  h = await create();
  const fbRetDoi = '10.1000/fb-return-hard';
  putJob(h, fbRetDoi, 'failed', Date.now() - 3000, {reason:'not_oa'});
  seedPaper(h, fbRetDoi);
  await reindex(h);
  const fbRetClaim = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fbRetClaim.task.doi, fbRetDoi);
  const fbHeldJob = stored(h, 'library:muse-job:' + fbRetDoi);
  assert.equal(fbHeldJob.previousReason, 'not_oa');
  const fbStartedAt = fbHeldJob.acquisitionStartedAt;
  const beforeRelease = stored(h, 'library:machine-rate:stats:fallback:' + dayOf(h));
  const fbReturned = await call(h, '/api/machine/return', fallback, {doi:fbRetDoi});
  assert.equal(fbReturned.status, 200);
  const fbReturnedBody = await fbReturned.json();
  assert.equal(fbReturnedBody.task.state, 'failed-awaiting-fallback');
  assert.equal(fbReturnedBody.task.reason, 'not_oa');
  const fbAfter = stored(h, 'library:muse-job:' + fbRetDoi);
  assert.equal(fbAfter.state, 'failed');
  assert.equal(fbAfter.reason, 'not_oa');
  assert.equal(fbAfter.previousReason, 'not_oa');
  assert.equal(fbAfter.claimant, 'fallback');
  assert.equal(fbAfter.acquisitionStartedAt, fbStartedAt);
  assert.equal(fbAfter.returnCount, undefined);
  const afterRelease = stored(h, 'library:machine-rate:stats:fallback:' + dayOf(h));
  assert.equal(afterRelease && afterRelease.release, beforeRelease && beforeRelease.release);
  const fbRetQueued = await (await call(h, '/api/machine/tasks?state=to-download', reader, null, {method:'GET'})).json();
  assert(!fbRetQueued.tasks.some(task => task.doi === fbRetDoi));
  const fbRetAgain = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fbRetAgain.task.doi, fbRetDoi);

  // replaceAvailableLeavesSupersedeRecord: X-Machine-Replace of a done/available job archives the old record first.
  h = await create();
  const replaceDoi = '10.1000/supersede-replace';
  const firstPdf = paperPdf(replaceDoi);
  const firstSha = hash(firstPdf);
  const oldReplaceId = crypto.randomUUID();
  seedPaper(h, replaceDoi, title, 'available');
  const replacePaper = stored(h, 'library:paper:' + replaceDoi);
  replacePaper.paper.fulltextStatus = 'available';
  replacePaper.pdf = {key:'library:pdf:' + firstSha,sha256:firstSha,size:firstPdf.length,source:'machine'};
  h.values.set('library:paper:' + replaceDoi, JSON.stringify(replacePaper));
  h.values.set('library:pdf:' + firstSha, firstPdf);
  putJob(h, replaceDoi, 'available', Date.now() - 5000, {id:oldReplaceId,sha256:firstSha,bytes:firstPdf.length,source:'dsh',caller:'dsh',verification:{method:'dual_parser_all_pages_title_doi',pages:4,sha256:firstSha,bytes:firstPdf.length}});
  const officialPdf = paperPdf(replaceDoi, title, 'official-version');
  assert.notEqual(hash(officialPdf), firstSha);
  const replaceUp = await upload(h, officialPdf, replaceDoi, dsh, {'x-machine-replace':'1'});
  assert.equal(replaceUp.status, 202);
  const replaceJob = stored(h, 'library:muse-job:' + replaceDoi);
  assert.notEqual(replaceJob.id, oldReplaceId);
  assert.equal(replaceJob.supersededFrom.taskId, oldReplaceId);
  assert.equal(replaceJob.supersededFrom.previousState, 'available');
  const replaceArchive = stored(h, 'library:muse-superseded:' + replaceDoi + ':' + oldReplaceId);
  assert.equal(replaceArchive.id, oldReplaceId);
  assert.equal(replaceArchive.state, 'available');
  assert.equal(replaceArchive.sha256, firstSha);
  assert.equal(replaceArchive.supersededBy, replaceJob.id);
  assert(Number.isInteger(replaceArchive.supersededAt));
  assertKept(h.writes.filter(write => write.key === 'library:muse-superseded:' + replaceDoi + ':' + oldReplaceId).at(-1));
  assert.equal(stored(h, 'library:paper:' + replaceDoi).pdf.sha256, firstSha);

  // supersedeArchiveKeepsReplaceFields: the archive is a verbatim copy, so replace and replaceRejected survive; only candidateKey is dropped.
  h = await create();
  const keepDoi = '10.1000/supersede-keep-replace';
  const oldKeepId = crypto.randomUUID();
  const keepOldPdf = paperPdf(keepDoi);
  const keepOldSha = hash(keepOldPdf);
  const keepReplace = {by:'dsh',at:Date.now() - 9000,oldSha256:'a'.repeat(64),newSha256:keepOldSha};
  const keepRejected = {by:'dsh',at:keepReplace.at,oldSha256:keepReplace.oldSha256,newSha256:keepOldSha,reason:'invalid_identity',rejectedAt:Date.now() - 8000};
  seedPaper(h, keepDoi, title, 'available');
  const keepPaper = stored(h, 'library:paper:' + keepDoi);
  keepPaper.paper.fulltextStatus = 'available';
  keepPaper.pdf = {key:'library:pdf:' + keepOldSha,sha256:keepOldSha,size:keepOldPdf.length,source:'machine'};
  h.values.set('library:paper:' + keepDoi, JSON.stringify(keepPaper));
  h.values.set('library:pdf:' + keepOldSha, keepOldPdf);
  putJob(h, keepDoi, 'available', Date.now() - 5000, {id:oldKeepId,sha256:keepOldSha,bytes:keepOldPdf.length,source:'dsh',caller:'dsh',candidateKey:'library:muse-candidate:' + keepOldSha,replace:keepReplace,replaceRejected:keepRejected,verification:{method:'dual_parser_all_pages_title_doi',pages:4,sha256:keepOldSha,bytes:keepOldPdf.length}});
  const keepUp = await upload(h, paperPdf(keepDoi, title, 'official-version'), keepDoi, dsh, {'x-machine-replace':'1'});
  assert.equal(keepUp.status, 202);
  const keepArchive = stored(h, 'library:muse-superseded:' + keepDoi + ':' + oldKeepId);
  assert.deepEqual(keepArchive.replace, keepReplace);
  assert.deepEqual(keepArchive.replaceRejected, keepRejected);
  assert.equal(keepArchive.candidateKey, undefined);
  assert.equal(keepArchive.supersededBy, stored(h, 'library:muse-job:' + keepDoi).id);

  h = await create();
  const oaDoi = '10.1000/oa-verify';
  seedPaper(h, oaDoi);
  const oaUp = await upload(h, paperPdf(oaDoi), oaDoi);
  assert.equal(oaUp.status, 202);
  const oaVerifying = stored(h, 'library:muse-job:' + oaDoi);
  const candidateKey = oaVerifying.candidateKey;
  assert(h.values.has(candidateKey));
  h.values.set('library:muse-job:' + oaDoi, JSON.stringify({...oaVerifying,source:'open_access'}));
  const oaReview = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(oaReview.doi, oaDoi);
  const oaReject = await review(h, {action:'complete',taskId:oaReview.taskId,doi:oaReview.doi,leaseId:oaReview.leaseId,sha256:oaReview.sha256,bytes:oaReview.bytes,result:'rejected',reason:'identity_mismatch',pages:2,method:'dual_parser_all_pages_title_doi'});
  assert.equal(oaReject.status, 200);
  const oaFirst = stored(h, 'library:muse-job:' + oaDoi);
  assert.equal(oaFirst.state, 'queued');
  assert.equal(oaFirst.id, oaVerifying.id);
  assert.equal(oaFirst.oaVerificationFails, 1);
  assert.equal(oaFirst.oaRejected[0].reason, 'identity_mismatch');
  assert.equal(oaFirst.oaRejected[0].source, 'open_access');
  assert.equal(oaFirst.oaRejected[0].sha256, oaVerifying.sha256);
  assert.equal(oaFirst.candidateKey, candidateKey);
  assert(h.values.has(candidateKey));
  const oaQueued = await (await call(h, '/api/machine/tasks?state=to-download', reader, null, {method:'GET'})).json();
  const oaQueuedItem = oaQueued.tasks.find(task => task.doi === oaDoi);
  assert.equal(oaQueuedItem.state, 'to-download');
  assert.equal(oaQueuedItem.oaRejected[0].sha256, oaVerifying.sha256);
  const oaFailedFirst = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', fallback, null, {method:'GET'})).json();
  assert(!oaFailedFirst.tasks.some(task => task.doi === oaDoi));

  const secondJob = {...oaFirst,state:'verifying',source:'open_access',leaseId:crypto.randomUUID(),leaseUntil:Date.now() + 3600000,receivedAt:Date.now()};
  h.values.set('library:muse-job:' + oaDoi, JSON.stringify(secondJob));
  h.values.set('library:muse-review:' + secondJob.id, JSON.stringify({doi:oaDoi,id:secondJob.id}));
  const oaReview2 = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(oaReview2.doi, oaDoi);
  const oaReject2 = await review(h, {action:'complete',taskId:oaReview2.taskId,doi:oaReview2.doi,leaseId:oaReview2.leaseId,sha256:oaReview2.sha256,bytes:oaReview2.bytes,result:'rejected',reason:'identity_mismatch',pages:2,method:'dual_parser_all_pages_title_doi'});
  assert.equal(oaReject2.status, 200);
  const oaSecond = stored(h, 'library:muse-job:' + oaDoi);
  assert.equal(oaSecond.state, 'review');
  assert.equal(oaSecond.oaVerificationFails, 2);
  assert.equal(oaSecond.reason, 'identity_mismatch');
  assert(h.values.has(candidateKey));
  const oaFailedSecond = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', fallback, null, {method:'GET'})).json();
  const oaFailedItem = oaFailedSecond.tasks.find(task => task.doi === oaDoi);
  assert.equal(oaFailedItem.claimable, false);
  assert.equal(oaFailedItem.unclaimableReason, 'verification_failed');
  const oaClaim = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(oaClaim.task, null);


  h = await create();
  const skipBase = Date.now();
  for (let index = 0; index < 25; index++) {
    const pausedDoi = '10.1000/skip-' + String(index).padStart(2, '0');
    putJob(h, pausedDoi, 'queued', skipBase + index);
    h.values.set('library:attempt:' + pausedDoi, JSON.stringify({paused:true}));
  }
  const skipOpen = '10.1000/skip-open';
  putJob(h, skipOpen, 'queued', skipBase + 25);
  seedPaper(h, skipOpen);
  await reindex(h);
  const skipClaim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(skipClaim.task.doi, skipOpen);

  h = await create();
  const capBase = Date.now();
  for (let index = 0; index < 80; index++) {
    const pausedDoi = '10.1000/scan-' + String(index).padStart(3, '0');
    putJob(h, pausedDoi, 'queued', capBase + index);
    h.values.set('library:attempt:' + pausedDoi, JSON.stringify({paused:true}));
  }
  const afterCap = '10.1000/scan-open';
  putJob(h, afterCap, 'queued', capBase + 80);
  seedPaper(h, afterCap);
  await reindex(h);
  const scanCapped = await call(h, '/api/machine/claim', dsh, {state:'to-download'});
  assert.equal(scanCapped.status, 200);
  assert.equal(scanCapped.headers.get('retry-after'), '60');
  const limitedBody = await scanCapped.json();
  assert.equal(limitedBody.task, null);
  assert.equal(limitedBody.retryAfterSeconds, 60);
  assert.equal(limitedBody.retryAfter, 60);
  assert.equal(limitedBody.reason, 'claim_scan_limit');
  assert.equal(stored(h, 'library:muse-job:' + afterCap).state, 'queued');
  assert.equal(h.values.has('library:machine-rate:stats:dsh:' + dayOf(h)), false);
  const stillCapped = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  // Still scan-limited: the open paper sits past the cap, so this is also not a true empty queue.
  assert.equal(stillCapped.reason, 'claim_scan_limit');
  assert.equal(stillCapped.retryAfterSeconds, 60);
  assert.equal(stillCapped.retryAfter, 60);
  assert.equal(h.values.has('library:machine-rate:stats:dsh:' + dayOf(h)), false);

  h = await create();
  await reindex(h);
  const emptyNow = await call(h, '/api/machine/claim', dsh, {state:'to-download'});
  assert.equal(emptyNow.headers.get('retry-after'), '300');
  const emptyBody = await emptyNow.json();
  assert.equal(emptyBody.task, null);
  assert.equal(emptyBody.retryAfterSeconds, 300);
  assert.equal(emptyBody.retryAfter, 300);
  assert.equal(emptyBody.reason, undefined);
  assert.equal(stored(h, 'library:machine-rate:stats:dsh:' + dayOf(h)).emptyClaim, 1);

  // ---- scope_filter parity with shared JSON fixtures
  const fs = require('fs');
  const path = require('path');
  const scopeCases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'scope_filter_cases.json'), 'utf8'));
  for (const item of scopeCases) {
    const got = h.context.scopeDecision(item.paper);
    assert.equal(got.action, item.action, item.id + ': ' + item.note);
    assert.equal(got.reason, item.reason, item.id + ': ' + item.note);
    assert.equal(typeof got.detail, 'string');
    if (item.action === 'exclude' || item.action === 'uncertain') assert(got.detail.trim().length > 0, item.id + ' detail must be non-empty');
  }

  // ---- claim to-download skips basic research and removes it from index without consuming a lease
  h = await create();
  const scopeBase = Date.now();
  const basicDoi = '10.1000/scope-basic-mi';
  const cvDoi = '10.1000/scope-cv-hfref';
  const basicJob = putJob(h, basicDoi, 'queued', scopeBase);
  seedPaper(h, basicDoi, 'Therapeutic angiogenesis in a mouse model of myocardial infarction', 'manual_needed', 'Circulation Research');
  putJob(h, cvDoi, 'queued', scopeBase + 10);
  seedPaper(h, cvDoi, 'Empagliflozin in patients with HFrEF: a randomized trial', 'manual_needed', 'Heart');
  await reindex(h);
  const scopeClaimed = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(scopeClaimed.task.doi, cvDoi);
  const basicAfter = stored(h, 'library:muse-job:' + basicDoi);
  assert.equal(basicAfter.state, 'failed');
  assert.equal(basicAfter.reason, 'out_of_scope');
  assert.equal(basicAfter.scopeExcluded, true);
  assert.equal(basicAfter.scopeReason, 'basic_research');
  assert(basicAfter.scopeDetail);
  assert.equal(basicAfter.leaseId, undefined);
  assert.equal(h.values.has(basicJob.queueKey), false);
  const scopeIdx = stored(h, 'library:machine-index:v1');
  assert.equal(scopeIdx.entries[basicDoi], undefined);
  const scopeToDownloadList = await (await call(h, '/api/machine/tasks?state=to-download', reader, null, {method:'GET'})).json();
  assert(!scopeToDownloadList.tasks.some(t => t.doi === basicDoi));
  const scopeFailedList = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', reader, null, {method:'GET'})).json();
  assert(!scopeFailedList.tasks.some(t => t.doi === basicDoi));
  const emptyScopeClaim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(emptyScopeClaim.task, null);

  // ---- claim failed-awaiting-fallback skips unrelated oncology and gives CV clinical job to fallback
  h = await create();
  const fbScopeBase = Date.now();
  const oncDoi = '10.1000/scope-onc-chemo';
  const fbCvDoi = '10.1000/scope-fb-cv';
  const oncJob = putJob(h, oncDoi, 'failed', fbScopeBase, {reason:'not_oa'});
  seedPaper(h, oncDoi, 'Adjuvant chemotherapy in early-stage breast cancer', 'manual_needed', 'JAMA Oncology');
  putJob(h, fbCvDoi, 'failed', fbScopeBase + 10, {reason:'not_oa'});
  seedPaper(h, fbCvDoi, 'Pulsed field ablation for atrial fibrillation: a randomized trial', 'manual_needed', 'New England Journal of Medicine');
  await reindex(h);
  const fbScopeClaim = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fbScopeClaim.task.doi, fbCvDoi);
  const oncAfter = stored(h, 'library:muse-job:' + oncDoi);
  assert.equal(oncAfter.state, 'failed');
  assert.equal(oncAfter.reason, 'out_of_scope');
  assert.equal(oncAfter.scopeExcluded, true);
  assert.equal(oncAfter.scopeReason, 'unrelated_to_cv_or_medical_ai');
  assert(oncAfter.scopeDetail);
  assert.equal(oncAfter.leaseId, undefined);
  assert.equal(h.values.has(oncJob.queueKey), false);
  const fbScopeIdx = stored(h, 'library:machine-index:v1');
  assert.equal(fbScopeIdx.entries[oncDoi], undefined);
  const fbEmpty = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fbEmpty.task, null);

  // ---- claim to-download skips uncertain job without modifying its state/queue/index and claims later keep job
  h = await create();
  const uncBase = Date.now();
  const uncDoi = '10.1000/scope-uncertain-delivery';
  const uncKeepDoi = '10.1000/scope-uncertain-later-keep';
  const uncJob = putJob(h, uncDoi, 'queued', uncBase);
  seedPaper(h, uncDoi, 'Clinical perspectives on modern healthcare delivery', 'manual_needed', 'JAMA');
  putJob(h, uncKeepDoi, 'queued', uncBase + 10);
  seedPaper(h, uncKeepDoi, 'Empagliflozin in patients with HFrEF: a randomized trial', 'manual_needed', 'Heart');
  await reindex(h);
  const uncClaim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(uncClaim.task.doi, uncKeepDoi);
  const uncAfter = stored(h, 'library:muse-job:' + uncDoi);
  assert.equal(uncAfter.state, 'queued');
  assert.equal(uncAfter.reason, undefined);
  assert.equal(uncAfter.scopeExcluded, undefined);
  assert.equal(uncAfter.leaseId, undefined);
  assert.equal(h.values.has(uncJob.queueKey), true);
  const uncIdx = stored(h, 'library:machine-index:v1');
  assert.equal(uncIdx.entries[uncDoi] && uncIdx.entries[uncDoi].s, 'queued');
  const uncToDownloadList = await (await call(h, '/api/machine/tasks?state=to-download', reader, null, {method:'GET'})).json();
  const uncListed = uncToDownloadList.tasks.find(t => t.doi === uncDoi);
  assert(uncListed && uncListed.state === 'to-download' && uncListed.claimable === true);
  const uncFailedList = await (await call(h, '/api/machine/tasks?state=failed-awaiting-fallback', reader, null, {method:'GET'})).json();
  assert(!uncFailedList.tasks.some(t => t.doi === uncDoi));
  const uncSecondClaim = await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(uncSecondClaim.task, null);
  assert.equal(stored(h, 'library:muse-job:' + uncDoi).state, 'queued');

  // ---- claim failed-awaiting-fallback skips uncertain job without modifying its state/reason/index and claims later keep job
  h = await create();
  const fbUncBase = Date.now();
  const fbUncDoi = '10.1000/scope-fb-uncertain';
  const fbUncKeepDoi = '10.1000/scope-fb-uncertain-keep';
  putJob(h, fbUncDoi, 'failed', fbUncBase, {reason:'not_oa'});
  seedPaper(h, fbUncDoi, 'Clinical perspectives on modern healthcare delivery', 'manual_needed', 'JAMA');
  putJob(h, fbUncKeepDoi, 'failed', fbUncBase + 10, {reason:'not_oa'});
  seedPaper(h, fbUncKeepDoi, 'Pulsed field ablation for atrial fibrillation: a randomized trial', 'manual_needed', 'New England Journal of Medicine');
  await reindex(h);
  const fbUncClaim = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fbUncClaim.task.doi, fbUncKeepDoi);
  const fbUncAfter = stored(h, 'library:muse-job:' + fbUncDoi);
  assert.equal(fbUncAfter.state, 'failed');
  assert.equal(fbUncAfter.reason, 'not_oa');
  assert.equal(fbUncAfter.scopeExcluded, undefined);
  assert.equal(fbUncAfter.leaseId, undefined);
  const fbUncIdx = stored(h, 'library:machine-index:v1');
  assert.equal(fbUncIdx.entries[fbUncDoi] && fbUncIdx.entries[fbUncDoi].s, 'failed');
  const fbUncEmpty = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(fbUncEmpty.task, null);

  console.log('machine download tests passed');
  await require('./test_machine_register.cjs').run();
  await require('./test_machine_index.cjs').run();
})().catch(error => { console.error(error); process.exitCode = 1; });
