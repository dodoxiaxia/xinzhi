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
function seedPaper(h, paperDoi, paperTitle = title, status = 'manual_needed') {
  const paper = {id:'doi-' + hash(paperDoi).slice(0, 16),doi:paperDoi,title:paperTitle,journal:'Heart',authors:['Jane Doe'],date:'2026-10-07',datePrecision:'day',dateBasis:'Crossref published-online',ingestedAt:'2026-10-07T04:00:00.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:status};
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
  capList(h);
  const baseTime = Date.now();
  for (let index = 0; index < 11; index++) putJob(h, '10.1000/c' + index, 'running', baseTime + index);
  const queuedDoi = '10.1000/c99';
  putJob(h, queuedDoi, 'queued', baseTime + 100000);
  seedPaper(h, queuedDoi);
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
  assert(h.lists.some(opts => opts.prefix === 'library:muse-queue:' && opts.cursor));
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
  const fallbackClaim = await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'});
  assert.equal((await fallbackClaim.json()).task.doi, openDoi);
  assert.equal(stored(h, 'library:muse-job:' + openDoi).claimant, 'fallback');
  assert(h.lists.some(opts => opts.prefix === 'library:muse-job:' && opts.cursor));

  h = await create();
  capList(h);
  putJob(h, '10.1000/p-done', 'available', baseTime);
  const expected = [];
  for (let index = 0; index < 12; index++) {
    const paperDoi = '10.1000/p' + String(index).padStart(2, '0');
    expected.push(paperDoi);
    putJob(h, paperDoi, 'queued', baseTime + index);
  }
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

  h = await create();
  capList(h);
  const requeueDois = [];
  for (let index = 0; index < 12; index++) requeueDois.push('10.1000/r' + String(index).padStart(2, '0'));
  requeueDois.forEach((paperDoi, index) => putJob(h, paperDoi, 'failed', baseTime + index, {reason:'not_oa'}));
  putJob(h, requeueDois[3], 'review', baseTime + 3, {verificationReason:'identity_mismatch',reason:'identity_mismatch'});
  putJob(h, requeueDois[11], 'login_required', baseTime + 11, {reason:'han_login',stage:'han'});
  h.values.set('library:attempt:' + requeueDois[0], JSON.stringify({paused:true}));
  const writesBeforeDry = h.writes.length;
  const dry = await (await call(h, '/api/machine/requeue', dsh, {dryRun:true,limit:50})).json();
  assert.equal(dry.dryRun, true);
  assert.equal(h.writes.length, writesBeforeDry);
  assert(dry.requeued.some(item => item.doi === requeueDois[11] && item.from === 'login_required'));
  assert(dry.requeued.some(item => item.doi === requeueDois[1] && item.from === 'failed'));
  assert(!dry.requeued.some(item => item.doi === requeueDois[3]));
  assert(!dry.requeued.some(item => item.doi === requeueDois[0]));
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
  assert(h.lists.some(opts => opts.prefix === 'library:muse-job:' && opts.cursor));

  h = await create();
  putJob(h, '10.1000/budget', 'failed', baseTime, {reason:'other'});
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
  const picked = await (await call(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(picked.task.doi, doi);
  assert.equal(picked.task.claimant, 'fallback');
  assert.equal(stored(h, 'library:muse-job:' + doi).state, 'running');

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
  assert(statusHtml.includes('把任务放回下载队列'));
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

  console.log('machine download tests passed');
  await require('./test_machine_register.cjs').run();
})().catch(error => { console.error(error); process.exitCode = 1; });
