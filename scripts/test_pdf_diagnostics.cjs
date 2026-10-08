'use strict';
// Synthetic offline fixtures only; every fetch is intercepted. No real PDF, credential, URL or provider body is retained.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { harness, doi, title, pdf, hash, record, seed } = require('./test_doi_library_worker.cjs');
const pointer = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + hash(pdf) + '\nsize ' + pdf.length + '\n');
const secret = 'synthetic-private-response-path-token-signature';
const pending = () => new Promise(() => {}), flush = () => new Promise(resolve => setImmediate(resolve));
let count = 0;
async function test(name, work) { await work(); count++; console.log('PASS ' + name); }
function manual(options = {}) { const h = harness({ pointer, ...options }); h.values.set('library:paper:' + doi, JSON.stringify(record('manual_needed'))); return h; }
function intercept(h, match, response) {
  const original = h.context.fetch;
  h.context.fetch = (url, init) => {
    const target = new URL(url);
    if (!match(target, init)) return original(url, init);
    h.calls.push({ url: target, init }); return response(target, init);
  };
}
function clock(h) {
  let serial = 0; const ticks = new Map();
  h.context.setTimeout = (callback, ms) => { const id = ++serial; ticks.set(id, { callback, ms }); return id; };
  h.context.clearTimeout = id => ticks.delete(id);
  return { ticks, fire(ms) { const entries = [...ticks.entries()].filter(([, tick]) => tick.ms === ms); assert(entries.length, 'Expected exact timer ' + ms); entries.forEach(([id, tick]) => { ticks.delete(id); tick.callback(); }); } };
}
async function until(check) { for (const deadline = Date.now() + 10000; Date.now() < deadline;) { if (check()) return; await flush(); } throw Error('Fixture did not reach expected operation'); }
function diagnostic(value, stage, reason, status) {
  assert(value); assert.equal(value.schemaVersion, 1); assert.equal(value.stage, stage); assert.equal(value.reason, reason);
  if (status !== undefined) assert.equal(value.httpStatus, status);
  assert.match(value.requestId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i); assert(Number.isFinite(Date.parse(value.time)));
  assert(!JSON.stringify(value).includes(secret));
  assert(Object.keys(value).every(k => ['schemaVersion','stage','sourceStage','errorCode','reason','httpStatus','objectCode','requestId','time'].includes(k)));
}
function batch(action, error) { return Response.json({ objects: [{ oid: hash(pdf), size: pdf.length, ...(error ? { error } : { actions: { download: action } }) }] }); }
function objectGets(h) { return h.calls.filter(call => call.url.hostname === 'github-cloud.s3.amazonaws.com').length; }
async function failed(h, stage, reason, status) {
  const response = await h.request('/api/acquire/retry'), body = await response.json();
  assert.equal(body.ok, false); diagnostic(body.diagnostic, stage, reason, status); assert.equal(body.diagnosticStatus, 'available');
  const stored = JSON.parse(h.values.get('library:diagnostic:' + doi)); assert.deepEqual(stored, body.diagnostic);
  const write = h.writes.find(w => w.key === 'library:diagnostic:' + doi); assert.equal(write.opts.expirationTtl, 86400);
  return { response, body };
}
(async () => {
  await test('index 404 retains stage/HTTP through generic error and cooldown', async () => {
    const h = manual(); intercept(h, url => decodeURIComponent(url.pathname).endsWith('文献索引.csv'), () => new Response(secret, { status: 404 }));
    const { body } = await failed(h, 'index', 'http_error', 404); assert.equal(body.error, 'library_upstream'); assert.equal(body.diagnostic.errorCode, 'pdf_upstream');
  });
  await test('Contents metadata 404 differs from index 404', async () => {
    const h = manual(); intercept(h, (url, init) => init.headers.accept === 'application/vnd.github+json', () => new Response(secret, { status: 404 }));
    const { body } = await failed(h, 'contents_metadata', 'http_error', 404); assert.equal(body.diagnostic.errorCode, 'pdf_not_found');
  });
  await test('Contents raw 404 retains its separate stage', async () => {
    const h = manual({ githubPdfResponse: () => new Response(secret, { status: 404 }) }); await failed(h, 'contents_raw', 'http_error', 404);
  });
  await test('batch malformed JSON emits parse enum without raw body', async () => {
    const h = manual({ lfsBatch: () => new Response(secret) }); await failed(h, 'lfs_batch', 'parse', 200); assert.equal(objectGets(h), 0);
  });
  for (const code of [401,403,429]) await test('HTTP 200 embedded object ' + code + ' permanently pauses before object GET', async () => {
    const h = manual({ lfsBatch: () => batch(null, { code, message: secret }) });
    const { response, body } = await failed(h, 'lfs_batch', 'object_error', 200);
    assert.equal(response.status, 423); assert.equal(body.error, 'library_paused'); assert.equal(body.diagnostic.objectCode, code); assert.equal(objectGets(h), 0);
    const attempt = h.values.get('library:attempt:' + doi), stored = JSON.parse(attempt); assert.equal(stored.paused, true);
    assert.equal(h.writes.find(w => w.key === 'library:attempt:' + doi).opts, undefined);
    const calls = h.calls.length, writes = h.writes.length; assert.equal((await h.request('/api/acquire/retry')).status, 423); assert.equal(h.calls.length, calls); assert.equal(h.writes.length, writes); assert.equal(h.values.get('library:attempt:' + doi), attempt);
    const source = await h.request('/api/fulltext-source'); const read = await source.json(); assert.equal(source.status, 423); assert.equal(read.lastDiagnostic.objectCode, code); assert.equal(h.calls.length, calls); assert.equal(h.writes.length, writes);
  });
  for (const status of [403,429]) await test('object HTTP ' + status + ' retains stage and permanent pause', async () => {
    const h = manual({ lfsObject: () => new Response(secret, { status }) }); const { response } = await failed(h, 'lfs_object', 'http_error', status); assert.equal(response.status, 423); assert.equal(JSON.parse(h.values.get('library:attempt:' + doi)).paused, true);
  });
  await test('action headers remain rejected without forwarding', async () => {
    const h = manual({ lfsBatch: () => batch({ href: 'https://github-cloud.s3.amazonaws.com/synthetic?private=' + secret, header: { Authorization: secret } }) }); await failed(h, 'lfs_batch', 'action_header', 200); assert.equal(objectGets(h), 0);
  });
  await test('unsafe object host is refused before object GET', async () => {
    const h = manual({ lfsUrl: 'https://github-cloud.s3.amazonaws.com.attacker.invalid/' + secret }); await failed(h, 'lfs_batch', 'unsafe_host', 200); assert.equal(objectGets(h), 0);
  });
  await test('missing action has no-download enum', async () => {
    const h = manual({ lfsBatch: () => Response.json({ objects: [{ oid: hash(pdf), size: pdf.length }] }) }); await failed(h, 'lfs_batch', 'no_download', 200); assert.equal(objectGets(h), 0);
  });
  await test('object network rejection is fixed enum and does not leak raw exception', async () => {
    const h = manual({ lfsObject: () => Promise.reject(Error(secret)) }); await failed(h, 'lfs_object', 'network', null);
  });
  await test('index redirect refusal preserves 302 and redirect reason', async () => {
    const h = manual(); intercept(h, url => decodeURIComponent(url.pathname).endsWith('文献索引.csv'), () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' + secret } })); await failed(h, 'index', 'redirect', 302);
  });
  await test('12s headers ignored-abort request is locally bounded', async () => {
    const h = manual(), time = clock(h); intercept(h, url => decodeURIComponent(url.pathname).endsWith('文献索引.csv'), pending);
    const work = h.request('/api/acquire/retry'); await until(() => time.ticks.size >= 2); time.fire(12000); const response = await work, body = await response.json(); diagnostic(body.diagnostic, 'index', 'header_timeout', null); assert.equal(body.error, 'library_upstream'); assert.equal(time.ticks.size, 0);
  });
  await test('12s object body timeout and ignored cancel retain original operation', async () => {
    let cancelled = 0; const h = manual({ lfsObject: () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: pending, cancel: () => { cancelled++; return pending(); } }) } }) }), time = clock(h);
    const work = h.request('/api/acquire/retry'); await until(() => objectGets(h) === 1); time.fire(12000); const response = await work, body = await response.json(); diagnostic(body.diagnostic, 'body_timeout', 'body_timeout', 200); assert.equal(body.diagnostic.sourceStage, 'lfs_object'); assert.equal(cancelled, 1); assert.equal(time.ticks.size, 0);
  });
  await test('denied response cancel cannot block pause receipt', async () => {
    const h = manual({ lfsBatch: () => ({ ok: false, status: 403, headers: new Headers(), body: { cancel: pending } }) }); const { response } = await failed(h, 'lfs_batch', 'http_error', 403); assert.equal(response.status, 423);
  });
  await test('45s parent abort differs from 12s local body timeout', async () => {
    const h = manual(), time = clock(h); intercept(h, url => decodeURIComponent(url.pathname).endsWith('文献索引.csv'), () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: pending, cancel: pending }) } }));
    const work = h.request('/api/acquire/retry'); await until(() => h.calls.some(c => decodeURIComponent(c.url.pathname).endsWith('文献索引.csv'))); await flush(); time.fire(45000);
    const response = await work, body = await response.json(); assert.equal(response.status, 504); assert.equal(body.error, 'library_timeout'); diagnostic(body.diagnostic, 'index', 'total_timeout', 200); assert.equal(time.ticks.size, 0);
  });
  await test('pending next retry Crossref metadata failure gives true HTTP 503', async () => {
    const h = harness({ crossrefResponse: () => new Response(secret, { status: 503 }) }); const { response, body } = await failed(h, 'metadata', 'http_error', 503); assert.equal(response.status, 502); assert.equal(body.error, 'library_upstream');
  });
  await test('metadata mismatched identity retains identity enum', async () => {
    const h = harness({ crossref: { DOI:'10.1000/wrong' } }); await failed(h,'metadata','identity',200);
  });
  await test('metadata declared size refusal retains size_limit enum', async () => {
    const h = harness({ crossrefResponse: () => new Response('{}',{headers:{'content-length':'1048577'}}) }); await failed(h,'metadata','size_limit',200);
  });
  await test('later successful OA metadata does not replace the original 503 failure', async () => {
    const h = harness({ rows: [], unpaywallResponse: () => new Response(secret, { status: 503 }) });
    const { body } = await failed(h, 'metadata', 'http_error', 503);
    assert.equal(body.error, 'library_upstream');
    assert.equal(h.calls.filter(c => c.url.hostname === 'api.openalex.org').length, 1);
  });
  await test('metadata body ignores abort/cancel yet reaches bounded receipt', async () => {
    const h = harness({ crossrefResponse: () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: pending, cancel: pending }) } }) }), time = clock(h);
    const work = h.request('/api/acquire/retry'); await until(() => h.calls.some(c => c.url.hostname === 'api.crossref.org')); await flush(); time.fire(12000);
    const response = await work, body = await response.json(); assert.equal(response.status, 504); diagnostic(body.diagnostic, 'body_timeout', 'body_timeout', 200); assert.equal(body.diagnostic.sourceStage, 'metadata'); assert.equal(time.ticks.size, 0);
  });
  await test('authorization/origin errors and GET form do zero KV reads/writes and source calls', async () => {
    for (const config of [{ passphrase: 'wrong' }, { headers: { origin: 'https://attacker.invalid' } }, { headers: { 'sec-fetch-site': 'cross-site' } }, { method: 'GET' }]) {
      const h = harness(); const response = await h.request('/api/fulltext-source', config), text = await response.text(); assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.calls.length, 0); assert(!text.includes('configuration')); assert(!text.includes('requestId'));
    }
    const h = harness(); await h.request('/api/acquire', { passphrase: 'wrong' }); assert.equal(h.reads.length + h.writes.length + h.calls.length, 0);
  });
  await test('protected configuration error exposes only bools and sanitized commit state', async () => {
    const h = harness(); const response = await h.request('/api/fulltext-source', { env: { PDF_GITHUB_COMMIT: secret } }), body = await response.json(); assert.equal(response.status, 503); assert.equal(body.configuration.configuredCommit, null); assert.equal(body.configuration.configuredCommitState, 'invalid'); assert(!JSON.stringify(body).includes(secret)); assert.equal(h.writes.length, 0);
    const unset = h.context.pdfConfiguration({}); assert.equal(unset.configuredCommitState, 'unset'); assert.equal(unset.configuredCommit, null);
    const cfg = await h.request('/api/fulltext-source', { env: { PDF_DOWNLOAD_ENABLED: 'off' } }); const failedCfg = await cfg.json(); assert.equal(failedCfg.configuration.downloadEnabled, false); diagnostic(failedCfg.diagnostic, 'configuration', 'configuration', null);
  });
  await test('old generic paused attempt shows diagnostic unavailable without fabrication', async () => {
    const h = harness(), prior = JSON.stringify({ status: 'pending', error: 'library_paused', paused: true, retryAfter: 0 }); h.values.set('library:attempt:' + doi, prior);
    const response = await h.request('/api/fulltext-source'), body = await response.json(); assert.equal(response.status, 423); assert.equal(body.lastDiagnostic, null); assert.equal(body.diagnostic, null); assert.equal(body.diagnosticStatus, 'unavailable'); assert.equal(h.calls.length + h.writes.length, 0); assert.equal(h.values.get('library:attempt:' + doi), prior);
  });
  await test('legacy PDF honors a permanent pause before GitHub and preserves historical receipt', async () => {
    const h = manual({ registry: { fixture: {doi,title} }, lfsBatch: () => batch(null, { code: 403, message: secret }) });
    const first = await h.context.handlePdf(new Request('https://site.test/api/pdf?id=fixture', { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:'passphrase=synthetic-passphrase' }),h.env);
    assert.equal(first.status,423); const receipt = (await first.json()).diagnostic; diagnostic(receipt,'lfs_batch','object_error',200);
    const calls = h.calls.length, writes = h.writes.length;
    const again = await h.context.handlePdf(new Request('https://site.test/api/pdf?id=fixture', { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:'passphrase=synthetic-passphrase' }),h.env);
    assert.equal(again.status,423); assert.deepEqual((await again.json()).diagnostic,receipt); assert.equal(h.calls.length,calls); assert.equal(h.writes.length,writes);
  });
  await test('old generic cooldown does not create a new historical stage', async () => {
    const h = harness(); h.values.set('library:attempt:' + doi, JSON.stringify({ status: 'pending', error: 'library_upstream', retryAfter: Date.now() + 300000 }));
    const response = await h.request('/api/acquire/retry'), body = await response.json(); assert.equal(body.error, 'library_retry_later'); assert.equal(body.diagnostic, null); assert.equal(body.diagnosticStatus, 'unavailable'); assert.equal(h.calls.length + h.writes.length, 0);
  });
  await test('library found:false emits explicit paused/error enums and no diagnostics', async () => {
    const h = harness(); h.values.set('library:attempt:' + doi, JSON.stringify({ status: 'pending', error: secret, paused: true, retryAfter: Date.now() + 300000, diagnostic: { rawError: secret } }));
    const response = await h.request('/api/library', { method: 'GET' }), body = await response.json(); assert.equal(body.found, false); assert.equal(body.paused, true); assert.equal(body.error, 'library_paused'); assert.equal(body.diagnostic, undefined); assert(!JSON.stringify(body).includes(secret)); assert.equal(h.calls.length + h.writes.length, 0);
  });
  await test('sanitizer projects only bounded enums and strips every raw field', async () => {
    const h = harness(), clean = { schemaVersion: 1, stage: 'lfs_batch', reason: 'object_error', errorCode: 'library_paused', httpStatus: 200, objectCode: 403, requestId: crypto.randomUUID(), time: new Date().toISOString() };
    const safe = h.context.sanitizePdfDiagnostic({ ...clean, rawError: secret, url: secret, token: secret, privatePath: secret, body: secret }); assert.deepEqual(JSON.parse(JSON.stringify(safe)), clean);
    for (const injected of [{ stage: secret }, { reason: secret }, { errorCode: secret }, { requestId: secret }, { objectCode: '403' }, { httpStatus: 999 }, { sourceStage: secret }, { time: secret }]) assert.equal(h.context.sanitizePdfDiagnostic({ ...clean, ...injected }), null);
    h.values.set('library:diagnostic:' + doi, JSON.stringify({ ...clean, stage: secret })); const source = await h.request('/api/fulltext-source'); assert.equal((await source.json()).lastDiagnostic, null); assert.equal(h.writes.length, 0);
  });
  await test('valid available cache serves unchanged with no source or diagnostic writes', async () => {
    const h = harness(); seed(h); const prior = h.values.get('library:paper:' + doi); const response = await h.request('/api/acquire/retry'); assert.equal(response.status, 200); assert.equal(h.values.get('library:paper:' + doi), prior); assert.equal(h.writes.length + h.calls.length, 0);
  });
  await test('concurrent available record cannot be overwritten by failed request', async () => {
    const h = manual({ lfsObject: () => { seed(h); return Promise.reject(Error(secret)); } }); const response = await h.request('/api/acquire/retry'); assert.equal(response.status, 200); assert.equal(JSON.parse(h.values.get('library:paper:' + doi)).paper.fulltextStatus, 'available'); assert(!h.writes.some(w => w.key.startsWith('library:diagnostic:') || w.key === 'library:paper:' + doi));
  });
  await test('diagnostic KV write failure preserves original fixed error and receipt', async () => {
    const h = manual({ lfsBatch: () => new Response(secret), putError: key => key.startsWith('library:diagnostic:') }); const response = await h.request('/api/acquire/retry'), body = await response.json(); assert.equal(body.error, 'library_upstream'); diagnostic(body.diagnostic, 'lfs_batch', 'parse', 200);
  });
  await test('failure HTML contains one safe maintenance receipt and no private response data', async () => {
    const h = manual({ lfsBatch: () => new Response(secret) }), response = await h.request('/api/acquire/retry', { headers: { accept: 'text/html' } }), text = await response.text(); assert.equal(response.status, 502); assert(text.includes('维护回执')); assert(text.includes('lfs_batch')); assert(text.includes('parse')); assert(text.includes('等待或重试时限不代表来源问题已解决')); assert(!text.includes(secret)); assert(!text.includes('synthetic-private-token')); assert(!text.includes('期刊/试验.pdf'));
  });
  console.log(count + ' PDF diagnostic scenarios passed; synthetic-only, no live network/model/PDF.');
})().catch(error => { console.error(error); process.exitCode = 1; });
