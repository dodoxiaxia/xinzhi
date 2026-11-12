'use strict';
// Offline: first-page identity check for machine uploads, the guarded replace path and the claim reason. Synthetic PDFs only.
// Needs DecompressionStream (Node 18+, same API as Workers). Hooked in at the end of test_muse_fulltext.cjs so CI runs it.
const assert = require('assert'), crypto = require('crypto'), fs = require('fs'), path = require('path'), vm = require('vm');
const {setup, token} = require('./test_fulltext_auth_helpers.cjs');
const {hash, error} = require('./test_doi_library_worker.cjs');
const fixtures = require('./machine_identity_fixtures.cjs');
const base = 'https://learn.dryz.info', reviewUrl = base + '/api/muse/review';
const museKey = 'synthetic_muse_key_0123456789_abcdef', dsh = 'synthetic_downloader_token_0123456789ab', fallback = 'synthetic_fallback_token_0123456789abcd', reader = 'synthetic_reader_token_0123456789abcdef';
const tokens = JSON.stringify([{id:'dsh',role:'downloader',token:dsh},{id:'fallback',role:'fallback',token:fallback},{id:'ddx',role:'reader',token:reader}]);
const {flate, objstm, custom} = fixtures.samples;
function run(h, code) { return vm.runInContext(code, h.context); }
async function create() {
  const h = await setup();
  h.context.DecompressionStream = DecompressionStream;
  Object.assign(h.env, {MUSE_FULLTEXT_ENABLED:'true', MUSE_FULLTEXT_KEY:museKey, MACHINE_TOKENS:tokens});
  return h;
}
const identity = (h, bytes, doi, title) => run(h, 'machineIdentity')(new Uint8Array(bytes), doi, title);
function latin(bytes) { return bytes.toString('latin1'); }
function mutate(bytes, from, to) { const text = latin(bytes); assert(text.includes(from), from); return Buffer.from(text.replace(from, to), 'latin1'); }
function seedPaper(h, doi, title, status = 'manual_needed', pdf = null) {
  const paper = {id:'doi-' + hash(doi).slice(0, 16), doi, title, journal:'Synthetic', authors:['Jane Doe'], date:'2026-10-07', datePrecision:'day', dateBasis:'Crossref published-online', ingestedAt:'2026-10-07T04:00:00.000Z', metadataStatus:'external_bibliography_checked', fulltextStatus:status};
  const record = {version:1, paper};
  if (pdf) { record.pdf = {key:'library:pdf:' + hash(pdf), sha256:hash(pdf), size:pdf.length, source:'machine'}; h.values.set(record.pdf.key, pdf); }
  h.values.set('library:paper:' + doi, JSON.stringify(record));
}
function putJob(h, doi, state, extra = {}) {
  const id = crypto.randomUUID(), createdAt = Date.now() - 60000;
  const job = {version:1, id, doi, state, createdAt, updatedAt:createdAt, queueKey:'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id, ...extra};
  if (['running', 'uploading', 'verifying'].includes(state)) Object.assign(job, {leaseId:extra.leaseId || crypto.randomUUID(), leaseUntil:extra.leaseUntil || createdAt + 3600000, acquisitionStartedAt:createdAt});
  h.values.set('library:muse-job:' + doi, JSON.stringify(job));
  if (state === 'queued') h.values.set(job.queueKey, JSON.stringify({doi, id}));
  return job;
}
const stored = (h, key) => { const value = h.values.get(key); return value === undefined ? undefined : JSON.parse(value); };
function upload(h, bytes, doi, secret = dsh, headers = {}) {
  return h.context.worker.fetch(new Request(base + '/api/machine/upload', {method:'PUT', headers:{authorization:'Bearer ' + secret, 'content-type':'application/pdf', 'x-machine-doi':doi, ...headers}, body:bytes}), h.env);
}
function post(h, route, secret, body) {
  return h.context.worker.fetch(new Request(base + route, {method:'POST', headers:{authorization:'Bearer ' + secret, 'content-type':'application/json'}, body:JSON.stringify(body)}), h.env);
}
async function review(h, body) {
  const auth = await token(h, reviewUrl, 'muse-review.yml');
  return h.context.worker.fetch(new Request(reviewUrl, {method:'POST', headers:{authorization:'Bearer ' + auth, 'content-type':'application/json'}, body:JSON.stringify(body)}), h.env);
}
async function verifyNext(h, doi, result, reason) {
  // Earlier uploads in this run are still waiting for the verifier; only this DOI is of interest here.
  for (const [key, value] of [...h.values]) if (key.startsWith('library:muse-review:') && JSON.parse(value).doi !== doi) h.values.delete(key);
  const claimed = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(claimed && claimed.doi, doi);
  const body = {action:'complete', taskId:claimed.taskId, doi:claimed.doi, leaseId:claimed.leaseId, sha256:claimed.sha256, bytes:claimed.bytes, result, pages:3, method:'dual_parser_all_pages_title_doi', ...(reason ? {reason} : {})};
  const response = await review(h, body);
  assert.equal(response.status, 200);
  return claimed;
}
(async () => {
  const files = fixtures.files();
  // The committed fixtures are exactly what the generator writes (nothing hand-edited, nothing from a publisher).
  for (const [name, bytes] of Object.entries(files)) {
    const committed = fs.readFileSync(path.join(fixtures.directory, name));
    assert(committed.equals(bytes), name + ' differs from the generator');
    assert(committed.length >= 51200 && committed.length < 60000);
    assert(/%%EOF\s*$/.test(latin(committed.subarray(-64))));
  }
  const h = await create();
  const cases = [['flate-eol-before-endstream.pdf', flate], ['objstm-xref-stream.pdf', objstm], ['custom-encoding-tounicode.pdf', custom]];
  for (const [name, sample] of cases) {
    const verdict = await identity(h, files[name], sample.doi, sample.title);
    assert.equal(verdict.verdict, 'ok', name);
    assert.equal(verdict.level, 'full', name);
    // Wrong paper: right file, other DOI / other title / both wrong never passes.
    const wrongDoi = await identity(h, files[name], '10.9999/synthetic.other', sample.title);
    assert.equal(wrongDoi.verdict, 'mismatch'); assert.equal(wrongDoi.reason, 'doi_not_found');
    const wrongTitle = await identity(h, files[name], sample.doi, 'Synthetic unrelated study of imaginary tides and moons');
    assert.equal(wrongTitle.verdict, 'mismatch'); assert.equal(wrongTitle.reason, 'title_not_found');
    const both = await identity(h, files[name], '10.9999/synthetic.other', 'Synthetic unrelated study of imaginary tides and moons');
    assert.equal(both.verdict, 'mismatch'); assert.equal(both.reason, 'identity_mismatch');
  }
  // Variants of each structure.
  for (const eol of ['\r\n', '\n', '\r', ' \n']) assert.equal((await identity(h, fixtures.flateEol({...flate, eol}), flate.doi, flate.title)).verdict, 'ok', JSON.stringify(eol));
  assert.equal((await identity(h, fixtures.flateEol({...flate, lengthWrong:true}), flate.doi, flate.title)).verdict, 'ok');
  assert.equal((await identity(h, fixtures.objStm({...objstm, predictor:true}), objstm.doi, objstm.title)).verdict, 'ok');
  // Custom encoding without a ToUnicode map: title from XMP / Info only when the page text cannot be read; DOI must still be on the page.
  const xmpOnly = fixtures.customEncoding({...custom, toUnicode:false, xmpTitle:custom.title});
  const viaXmp = await identity(h, xmpOnly, custom.doi, custom.title);
  assert.equal(viaXmp.verdict, 'ok'); assert.equal(viaXmp.level, 'metadata_title'); assert.equal(viaXmp.checks.title, 'metadata');
  const viaInfo = await identity(h, fixtures.customEncoding({...custom, toUnicode:false, infoTitle:custom.title}), custom.doi, custom.title);
  assert.equal(viaInfo.level, 'metadata_title');
  const doiOnly = await identity(h, fixtures.customEncoding({...custom, toUnicode:false}), custom.doi, custom.title);
  assert.equal(doiOnly.verdict, 'ok'); assert.equal(doiOnly.level, 'doi_only');
  const otherXmp = await identity(h, fixtures.customEncoding({...custom, toUnicode:false, xmpTitle:'Synthetic unrelated study of imaginary tides and moons'}), custom.doi, custom.title);
  assert.equal(otherXmp.level, 'doi_only'); // metadata that disagrees adds nothing; the dual-parser still decides
  assert.equal((await identity(h, fixtures.customEncoding({...custom, toUnicode:false}), '10.9999/synthetic.other', custom.title)).verdict, 'mismatch');
  assert.equal((await identity(h, fixtures.customEncoding({...custom, toUnicode:false, xmpTitle:custom.title}), '10.9999/synthetic.other', custom.title)).reason, 'doi_not_found');
  // Readable page text with a different title is never rescued by metadata.
  const readableWrong = fixtures.flateEol({...flate});
  assert.equal((await identity(h, readableWrong, flate.doi, 'Synthetic unrelated study of imaginary tides and moons')).reason, 'title_not_found');
  // Internal reason codes instead of a silent empty result.
  const brokenFlate = mutate(files['flate-eol-before-endstream.pdf'], 'stream\n', 'stream\nxxxxxxxx');
  assert.equal((await identity(h, brokenFlate, flate.doi, flate.title)).reason, 'inflate_failed');
  const unsupportedObjstm = mutate(files['objstm-xref-stream.pdf'], '/Type /ObjStm /N 3', '/Type /ObjStm /N 3 /Filter /LZWDecode /X');
  assert.equal((await identity(h, unsupportedObjstm, objstm.doi, objstm.title)).reason, 'objstm_unsupported');
  assert.equal((await identity(h, mutate(files['flate-eol-before-endstream.pdf'], '/Filter /FlateDecode', '/Filter /LZWDecode'), flate.doi, flate.title)).reason, 'filter_unsupported');
  const noPages = mutate(files['flate-eol-before-endstream.pdf'], '/Type /Pages', '/Type /Nope ');
  assert.equal((await identity(h, Buffer.from(latin(noPages).replace(/\/Root 1 0 R/, '/Root 99 0 R').replace('/Kids [3 0 R]', ''), 'latin1'), flate.doi, flate.title)).reason, 'page_tree_not_found');
  const noContents = mutate(files['flate-eol-before-endstream.pdf'], '/Contents 4 0 R', '/Contents 44 0 R');
  assert.equal((await identity(h, noContents, flate.doi, flate.title)).reason, 'contents_not_found');
  assert.equal((await identity(h, files['flate-eol-before-endstream.pdf'], flate.doi, 'Hi')).reason, 'title_too_short');
  assert.equal((await identity(h, files['flate-eol-before-endstream.pdf'], 'not a doi', flate.title)).reason, 'doi_invalid');

  // Upload endpoint: 202 for each structure, 409 with a reason code (and nothing else from the PDF) for a wrong paper.
  for (const [name, sample] of cases) {
    seedPaper(h, sample.doi, sample.title);
    const accepted = await upload(h, files[name], sample.doi);
    assert.equal(accepted.status, 202, name);
    const body = await accepted.json();
    assert.equal(body.task.state, 'uploaded-awaiting-verification'); assert.equal(body.task.identity, 'full'); assert.notEqual(body.task.state, 'done');
    assert.equal(stored(h, 'library:muse-job:' + sample.doi).identityLevel, 'full');
  }
  seedPaper(h, '10.9999/synthetic.wrong', 'Synthetic paper whose title the uploaded file does not carry');
  const wrong = await upload(h, files['flate-eol-before-endstream.pdf'], '10.9999/synthetic.wrong');
  assert.equal(wrong.status, 409);
  const wrongBody = await wrong.json();
  assert.deepEqual(Object.keys(wrongBody).sort(), ['checks', 'error', 'ok', 'reason']);
  assert.equal(wrongBody.error, 'machine_identity_mismatch'); assert.equal(wrongBody.reason, 'identity_mismatch');
  assert(!h.values.has('library:muse-job:10.9999/synthetic.wrong'));
  seedPaper(h, custom.doi + '.b', custom.title);
  const weakDoi = custom.doi + '.b';
  assert.equal((await upload(h, files['custom-encoding-tounicode.pdf'], weakDoi)).status, 409);
  const unreadable = fixtures.customEncoding({doi:weakDoi, title:custom.title, toUnicode:false});
  seedPaper(h, weakDoi, custom.title);
  const weak = await upload(h, unreadable, weakDoi);
  assert.equal(weak.status, 202);
  const weakBody = await weak.json();
  assert.equal(weakBody.task.identity, 'doi_only'); assert.equal(weakBody.task.state, 'uploaded-awaiting-verification');
  assert.equal(stored(h, 'library:muse-job:' + weakDoi).state, 'verifying'); assert.equal(stored(h, 'library:paper:' + weakDoi).paper.fulltextStatus, 'manual_needed');

  // A claimed task no longer shows the failure that made it claimable; list and claim agree.
  const failedDoi = '10.9999/synthetic.failed';
  seedPaper(h, failedDoi, 'Synthetic paper queued then reported failed by an agent');
  putJob(h, failedDoi, 'failed', {reason:'agent_failed'});
  const listed = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=failed-awaiting-fallback', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(listed.tasks.find(task => task.doi === failedDoi).reason, 'agent_failed');
  const picked = await (await post(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(picked.task.doi, failedDoi); assert.equal(picked.task.state, 'downloading'); assert.equal(picked.task.reason, '');
  const claimedJob = stored(h, 'library:muse-job:' + failedDoi);
  assert.equal(claimedJob.state, 'running'); assert.equal(claimedJob.reason, undefined); assert.equal(claimedJob.previousReason, 'agent_failed');
  const downloading = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=downloading', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(downloading.tasks.find(task => task.doi === failedDoi).reason, '');
  const queuedDoi = '10.9999/synthetic.queued';
  seedPaper(h, queuedDoi, 'Synthetic paper waiting for download');
  putJob(h, queuedDoi, 'queued', {reason:'agent_failed'});
  const queuedList = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=to-download', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(queuedList.tasks.find(task => task.doi === queuedDoi).reason, '');
  const expiredDoi = '10.9999/synthetic.expired';
  seedPaper(h, expiredDoi, 'Synthetic paper whose lease ran out');
  putJob(h, expiredDoi, 'running', {leaseUntil:Date.now() - 1000});
  const expiredList = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=failed-awaiting-fallback', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(expiredList.tasks.find(task => task.doi === expiredDoi).reason, 'lease_expired');

  // Guarded replace of an already verified original.
  const rd = '10.9999/synthetic.replace', day = new h.context.Date().toISOString().slice(0, 10);
  const original = fixtures.flateEol({doi:rd, title:flate.title});
  const copy = fixtures.flateEol({doi:rd, title:flate.title, eol:'\r\n'});
  const third = fixtures.flateEol({doi:rd, title:flate.title, eol:'\r'});
  assert.notEqual(hash(original), hash(copy));
  let spent = 0;
  const rate = secret => stored(h, 'library:machine-rate:upload:' + secret + ':' + day);
  seedPaper(h, rd, flate.title, 'available', original);
  const oldJob = putJob(h, rd, 'available', {sha256:hash(original), bytes:original.length, source:'dsh', caller:'dsh', verification:{method:'dual_parser_all_pages_title_doi', pages:1, sha256:hash(original), bytes:original.length}});
  await error(await upload(h, copy, rd), 409, 'machine_done');
  await error(await upload(h, copy, rd, reader, {'x-machine-replace':'1'}), 403, 'machine_forbidden');
  await error(await upload(h, copy, rd, museKey, {'x-machine-replace':'1'}), 403, 'machine_forbidden');
  await error(await upload(h, copy, rd, dsh, {'x-machine-replace':'yes'}), 400, 'machine_bad_request');
  await error(await upload(h, original, rd, dsh, {'x-machine-replace':'1'}), 409, 'machine_replace_same');
  const wrongPaper = fixtures.flateEol({doi:'10.9999/synthetic.other', title:flate.title});
  const mismatched = await upload(h, wrongPaper, rd, dsh, {'x-machine-replace':'1'});
  assert.equal(mismatched.status, 409); assert.equal((await mismatched.json()).reason, 'doi_not_found');
  assert.equal(stored(h, 'library:paper:' + rd).pdf.sha256, hash(original)); spent = rate('dsh'); assert(spent >= 1);
  // Another caller holds a live lease: refused.
  putJob(h, rd, 'running', {claimant:'fallback'});
  await error(await upload(h, copy, rd, dsh, {'x-machine-replace':'1'}), 409, 'machine_busy');
  h.values.set('library:muse-job:' + rd, JSON.stringify(oldJob));
  const replaced = await upload(h, copy, rd, dsh, {'x-machine-replace':'1'});
  assert.equal(replaced.status, 202);
  const replacedBody = await replaced.json();
  assert.equal(replacedBody.task.state, 'uploaded-awaiting-verification');
  assert.equal(replacedBody.task.replace.by, 'dsh'); assert.equal(replacedBody.task.replace.oldSha256, hash(original)); assert.equal(replacedBody.task.replace.newSha256, hash(copy));
  assert(Date.parse(replacedBody.task.replace.at) > 0);
  assert.equal(rate('dsh'), spent + 1); // counts toward the daily upload quota
  assert.equal(stored(h, 'library:paper:' + rd).pdf.sha256, hash(original)); // the old original stays downloadable until verification passes
  const verifying = stored(h, 'library:muse-job:' + rd);
  assert.equal(verifying.state, 'verifying'); assert.equal(verifying.replace.previous.state, 'available');
  assert.equal((await upload(h, copy, rd, dsh, {'x-machine-replace':'1'})).status, 200);
  assert.equal(rate('dsh'), spent + 1);
  await error(await upload(h, third, rd, dsh, {'x-machine-replace':'1'}), 409, 'machine_conflict');
  // Verification rejects the replacement: the original stays, the task is available again and keeps the refusal.
  await verifyNext(h, rd, 'rejected', 'identity_mismatch');
  assert.equal(stored(h, 'library:paper:' + rd).pdf.sha256, hash(original));
  const restored = stored(h, 'library:muse-job:' + rd);
  assert.equal(restored.state, 'available'); assert.equal(restored.replaceRejected.newSha256, hash(copy)); assert.equal(restored.replaceRejected.by, 'dsh');
  // Second attempt passes the dual-parser verification and overwrites.
  assert.equal((await upload(h, copy, rd, fallback, {'x-machine-replace':'1'})).status, 202);
  await verifyNext(h, rd, 'verified');
  const record = stored(h, 'library:paper:' + rd);
  assert.equal(record.pdf.sha256, hash(copy)); assert.equal(record.pdf.replacedSha256, hash(original)); assert.equal(record.paper.fulltextStatus, 'available');
  assert(h.values.has('library:pdf:' + hash(original)) && h.values.has('library:pdf:' + hash(copy)));
  assert(h.values.has(run(h, 'DRIVE_PENDING_PREFIX') + hash(copy))); // the new original is queued for the Drive archive
  const finished = stored(h, 'library:muse-job:' + rd);
  assert.equal(finished.state, 'available'); assert.equal(finished.replace, undefined);
  assert.equal(finished.replacedFrom.by, 'fallback'); assert.equal(finished.replacedFrom.oldSha256, hash(original)); assert.equal(finished.replacedFrom.newSha256, hash(copy));
  assert.equal(rate('fallback'), 1);
  const served = await h.context.worker.fetch(new Request(base + '/api/library?doi=' + encodeURIComponent(rd)), h.env);
  assert.equal((await served.json()).status, 'available');
  // Nothing to replace: a paper that is not done yet.
  const pendingDoi = '10.9999/synthetic.pending';
  seedPaper(h, pendingDoi, flate.title);
  await error(await upload(h, fixtures.flateEol({doi:pendingDoi, title:flate.title}), pendingDoi, dsh, {'x-machine-replace':'1'}), 409, 'machine_replace_unneeded');
  const protocol = await (await h.context.worker.fetch(new Request(base + '/api/machine/protocol'), h.env)).json();
  assert.equal(protocol.replace.header, 'X-Machine-Replace'); assert(protocol.identityReasons.includes('inflate_failed'));
  console.log('Machine identity: tolerant inflate, object streams, ToUnicode, metadata fallback, reason codes, guarded replace and claim reason passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
