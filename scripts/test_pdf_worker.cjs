// Offline integration tests: synthetic passphrases and fixture GitHub responses only.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const { webcrypto, createHash } = require('crypto');
const original = fs.readFileSync(path.join(__dirname, '../edge/_worker.js'), 'utf8');
const library = {
  article: '10.1000/exact',
  titled: { doi:'', title:'  Clinical, "quoted"\nSTRASSE study  ' },
  both: { doi:'10.1000/exact', title:'Do not use this fallback' },
  invalid: { doi:'not-a-doi', title:'Clinical, "quoted" STRASSE study' }
};
const defaultPassphrase = 'synthetic-default-passphrase';
const defaultDigest = createHash('sha256').update(defaultPassphrase).digest('hex');
assert(original.includes("const PDF_DEFAULT_PASSPHRASE_SHA256 = '09c0511115f6c26ef033df2522991fd0cd65af038f8d74c48b8f51b9d898bbab';"));
assert(!/CF_ACCESS_|pdfAuthorize/i.test(original));
const readerPdf = original.slice(original.indexOf('async function handlePdf('), original.indexOf('const LIBRARY_PREFIX'));
assert(!/RS256|jwks|fulltextJobAuthorize/i.test(readerPdf), 'reader downloads use the shared password; OIDC belongs only to the background task endpoint');
const source = original.replace('const PDF_LIBRARY = {};', 'const PDF_LIBRARY = ' + JSON.stringify(library) + ';').replace(/const PDF_DEFAULT_PASSPHRASE_SHA256 = '[a-f0-9]{64}';/, "const PDF_DEFAULT_PASSPHRASE_SHA256 = '" + defaultDigest + "';").replace('export default {', 'globalThis.worker = {');
assert.notEqual(source, original);
const commit = 'a'.repeat(40), otherCommit = 'b'.repeat(40);
const repo = '/repos/dodoxiaxia/AI-';
const indexPath = '文献索引/文献索引.csv', pdfPath = '期刊/2026/测试 PDF.pdf';
const pdf = Buffer.from('%PDF-1.7\nSynthetic offline article\n%%EOF\n');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blobSha = bytes => createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
const columns = ['题名','DOI','期刊','实际出版日期','日期来源','当前路径','SHA256'];
const csvCell = value => /[,"\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
const csv = rows => '\uFEFF' + [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
const normalRow = ['精确匹配文章','https://doi.org/10.1000/EXACT','fixture','2026-10-07','fixture',pdfPath,sha256(pdf)];
const noDoiRow = ['Clinical, "quoted"\r\nStraße study','','fixture','','',pdfPath,sha256(pdf)];
const env = { PDF_DOWNLOAD_ENABLED:'true', GITHUB_LIBRARY_TOKEN:'synthetic-secret-token', PDF_DOWNLOAD_PASSPHRASE:'synthetic-test-passphrase', PDF_GITHUB_COMMIT:commit };
const valid = env.PDF_DOWNLOAD_PASSPHRASE;
function harness(options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const target = new URL(url); calls.push({ url:target, init });
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert(!target.href.includes(valid)); assert(!JSON.stringify(init.headers).includes(valid)); assert(!init.body);
    if (target.hostname === 'raw.githubusercontent.com') {
      assert(!init.headers.authorization, 'GitHub token must never follow a private raw redirect');
      return options.rawResponse ? options.rawResponse(target, init) : new Response(pdf);
    }
    assert.equal(target.hostname, 'api.github.com');
    assert.equal(init.headers.authorization, 'Bearer synthetic-secret-token');
    if (target.pathname === repo + '/commits/main') return Response.json({ sha:options.commit || commit });
    const decodedPath = decodeURIComponent(target.pathname);
    assert.equal(target.searchParams.get('ref'), options.commit || commit, 'all file reads must be commit pinned');
    if (decodedPath === repo + '/contents/' + indexPath) return options.indexResponse ? options.indexResponse(target, init) : new Response(options.csv || csv([normalRow, noDoiRow]));
    assert.equal(decodedPath, repo + '/contents/' + (options.path || pdfPath), 'only the exactly selected PDF may be fetched');
    if (init.headers.accept === 'application/vnd.github+json') return Response.json(options.metadata || { type:'file', path:options.path || pdfPath, size:pdf.length, sha:blobSha(pdf) });
    assert.equal(init.headers.accept, 'application/vnd.github.raw+json');
    return options.pdfResponse ? options.pdfResponse(target, init) : new Response(options.pdf || pdf);
  };
  const timers = options.timeoutMs ? (callback, ms) => setTimeout(callback, Math.min(ms, options.timeoutMs)) : setTimeout;
  const context = vm.createContext({btoa, URL, Response, Request, TextEncoder, TextDecoder, AbortController, setTimeout:timers, clearTimeout, Uint8Array, URLSearchParams, crypto:webcrypto, fetch, console });
  vm.runInContext(source, context);
  const request = async (passphrase, changes = {}, url = 'https://site.test/api/pdf?id=article', headers = {}, rawBody) => {
    const response = await context.worker.fetch(new Request(url, { method:'POST', headers:{ 'content-type':'application/x-www-form-urlencoded', ...headers }, body:rawBody === undefined ? new URLSearchParams({ passphrase:passphrase || '' }).toString() : rawBody }), { ...env, ...changes });
    return response;
  };
  return { context, calls, request, get:async (changes = {}, url = 'https://site.test/api/pdf?id=article', headers = {}) => context.worker.fetch(new Request(url, { headers }), { ...env, ...changes }) };

}
async function error(result, status, code) {
  assert.equal(result.status, status);
  const body = await result.text();
  assert(!body.includes('synthetic-secret-token')); assert(!body.includes(pdfPath)); assert(!body.includes(valid)); assert(!body.includes(defaultPassphrase));
  const parsed = JSON.parse(body); assert.equal(parsed.ok, false); assert.equal(parsed.error, code);
  assert.equal(result.headers.get('cache-control'), 'no-store');
}
const githubCalls = h => h.calls.filter(call => call.url.hostname === 'api.github.com');

(async () => {
  let h = harness();
  const initial = await h.get({ PDF_DOWNLOAD_ENABLED:undefined, GITHUB_LIBRARY_TOKEN:undefined });
  assert.equal(initial.status, 200); assert.equal(h.calls.length, 0);
  const initialPage = await initial.text();
  assert(initialPage.includes('method="post"')); assert(initialPage.includes('action="/api/pdf?id=article"')); assert(initialPage.includes('type="password"')); assert(initialPage.includes('autocomplete="current-password"')); assert(initialPage.includes('href="/?mode=library"'));
  assert(initialPage.includes('https://doi.org/10.1000/exact')); assert(!initialPage.includes(valid)); assert(!initialPage.includes(defaultPassphrase));
  assert.equal(initial.headers.get('cache-control'), 'no-store'); assert(initial.headers.get('content-security-policy').includes("form-action 'self'"));
  assert.equal(initial.headers.get('referrer-policy'), 'same-origin', 'normal browser form submissions must retain the same-origin Origin header');
  await error(await h.request(valid, { PDF_DOWNLOAD_ENABLED:undefined }), 503, 'pdf_disabled');
  await error(await h.request(valid, { GITHUB_LIBRARY_TOKEN:'' }), 503, 'pdf_not_configured');
  await error(await h.request(valid, { PDF_GITHUB_COMMIT:'main' }), 503, 'pdf_not_configured');
  await error(await h.request(valid, { PDF_DOWNLOAD_PASSPHRASE:'' }), 503, 'pdf_not_configured');
  assert.equal(h.calls.length, 0);
  for (const passphrase of ['', 'wrong', valid + 'x', ' ' + valid, valid.toUpperCase()]) {
    h = harness(); await error(await h.request(passphrase), 403, 'pdf_passphrase_invalid'); assert.equal(h.calls.length, 0);
  }
  h = harness(); await error(await h.request('wrong', { GITHUB_LIBRARY_TOKEN:undefined, PDF_DOWNLOAD_ENABLED:undefined }), 403, 'pdf_passphrase_invalid'); assert.equal(h.calls.length, 0);
  h = harness(); const incorrect = await h.request('wrong', {}, undefined, { accept:'text/html' });
  assert.equal(incorrect.status, 403); assert.equal(incorrect.headers.get('referrer-policy'), 'same-origin'); const retry = await incorrect.text(); assert(retry.includes('请重新输入')); assert(retry.includes('method="post"')); assert(retry.includes('action="/api/pdf?id=article"')); assert(retry.includes('https://doi.org/10.1000/exact')); assert(!retry.includes('value="wrong"')); assert.equal(h.calls.length, 0);
  for (const body of ['passphrase=a&passphrase=b', 'passphrase=a&id=article', 'password=a', '', 'passphrase=a&repo=other']) {
    h = harness(); await error(await h.request(valid, {}, undefined, {}, body), 400, 'pdf_bad_form'); assert.equal(h.calls.length, 0);
  }
  h = harness(); await error(await h.request(valid, {}, undefined, { 'content-type':'application/json' }), 415, 'pdf_content_type'); assert.equal(h.calls.length, 0);
  h = harness(); await error(await h.request(valid, {}, undefined, {}, 'passphrase=' + 'a'.repeat(2048)), 413, 'pdf_body_too_large'); assert.equal(h.calls.length, 0);
  h = harness(); await error(await h.request(valid, {}, undefined, { 'content-length':'2049' }), 413, 'pdf_body_too_large'); assert.equal(h.calls.length, 0);
  h = harness(); await error(await h.request(valid, {}, undefined, {}, 'passphrase=' + 'a'.repeat(257)), 403, 'pdf_passphrase_invalid'); assert.equal(h.calls.length, 0);
  for (const origin of ['https://attacker.example', 'null']) {
    h = harness(); await error(await h.request(valid, {}, undefined, { origin }), 403, 'pdf_origin'); assert.equal(h.calls.length, 0);
  }
  for (const site of ['cross-site', 'same-site']) {
    h = harness(); await error(await h.request(valid, {}, undefined, { 'sec-fetch-site':site }), 403, 'pdf_origin'); assert.equal(h.calls.length, 0);
  }
  h = harness(); assert.equal((await h.request(valid, {}, undefined, { 'sec-fetch-site':'same-origin' })).status, 200);
  h = harness(); assert.equal((await h.request(valid, {}, undefined, { origin:'https://site.test' })).status, 200);
  h = harness(); assert.equal((await h.request(defaultPassphrase, { PDF_DOWNLOAD_PASSPHRASE:undefined })).status, 200, 'configured digest fallback works without exposing plaintext in source');
  h = harness(); await error(await h.request(defaultPassphrase), 403, 'pdf_passphrase_invalid'); assert.equal(h.calls.length, 0);

  h = harness(); const success = await h.request(valid);
  assert.equal(success.status, 200); assert.equal(success.headers.get('content-type'), 'application/pdf');
  assert(success.headers.get('content-disposition').startsWith('attachment;')); assert(success.headers.get('content-disposition').includes("filename*=UTF-8''" + encodeURIComponent('精确匹配文章.pdf')));
  assert(success.headers.get('cache-control').includes('no-store')); assert.equal(success.headers.get('content-length'), String(pdf.length));
  assert.deepEqual(Buffer.from(await success.arrayBuffer()), pdf); assert.equal(githubCalls(h).length, 3);
  h = harness({ commit:otherCommit }); assert.equal((await h.request(valid, { PDF_GITHUB_COMMIT:undefined })).status, 200); assert.equal(githubCalls(h).length, 4);
  h = harness(); assert.equal((await h.request(valid, {}, 'https://site.test/api/pdf?id=titled')).status, 200, 'no DOI uses exact Unicode case-folded title with quoted comma and embedded newline');
  h = harness({ csv:csv([noDoiRow]) }); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=both'), 404, 'pdf_not_found');
  h = harness(); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=invalid'), 404, 'pdf_not_found'); assert.equal(githubCalls(h).length, 0);
  h = harness(); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=unknown'), 404, 'pdf_not_found'); assert.equal(githubCalls(h).length, 0);
  h = harness(); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=article&id=titled'), 400, 'pdf_bad_id'); assert.equal(githubCalls(h).length, 0);
  for (const extra of ['repo=other/repo', 'path=secret.pdf', 'doi=10.1000/exact', 'passphrase=synthetic-test-passphrase']) {
    h = harness(); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=article&' + extra), 400, 'pdf_bad_id'); assert.equal(githubCalls(h).length, 0);
    await error(await h.get({}, 'https://site.test/api/pdf?id=article&' + extra), 400, 'pdf_bad_id'); assert.equal(githubCalls(h).length, 0);
  }
  h = harness(); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=__proto__'), 404, 'pdf_not_found'); assert.equal(githubCalls(h).length, 0);

  h = harness({ csv:csv([[...normalRow.slice(0, 1), '10.1000/exactly-different', ...normalRow.slice(2)]]) });
  await error(await h.request(valid), 404, 'pdf_not_found'); assert.equal(githubCalls(h).length, 1);
  for (const rows of [[normalRow, normalRow], [noDoiRow, noDoiRow]]) {
    h = harness({ csv:csv(rows) }); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=' + (rows[0] === normalRow ? 'article' : 'titled')), 409, 'pdf_ambiguous'); assert.equal(githubCalls(h).length, 1);
  }
  for (const invalidCsv of ['"unclosed', csv([normalRow]).replace('SHA256', 'DOI'), csv([[...normalRow, 'extra']])]) {
    h = harness({ csv:invalidCsv }); await error(await h.request(valid), 502, 'pdf_index_invalid'); assert.equal(githubCalls(h).length, 1);
  }
  for (const unsafePath of ['../private.pdf', '/private.pdf', 'folder\\private.pdf', 'folder/../private.pdf', 'https://attacker.example/private.pdf', 'folder//private.pdf', 'folder/file.html']) {
    const row = [...normalRow]; row[5] = unsafePath;
    h = harness({ csv:csv([row]) }); await error(await h.request(valid), 502, 'pdf_index_invalid'); assert.equal(githubCalls(h).length, 1);
  }
  for (const hash of ['', 'invalid-sha', 'a'.repeat(63)]) {
    const row = [...normalRow]; row[6] = hash;
    h = harness({ csv:csv([row]) }); await error(await h.request(valid), 502, 'pdf_index_invalid'); assert.equal(githubCalls(h).length, 1);
  }
  for (const metadata of [
    { type:'dir', path:pdfPath, size:pdf.length, sha:blobSha(pdf) },
    { type:'file', path:'other.pdf', size:pdf.length, sha:blobSha(pdf) },
    { type:'file', path:pdfPath, size:pdf.length, sha:'invalid' },
    { type:'file', path:pdfPath, size:pdf.length, sha:blobSha(pdf), target:'secret.pdf' },
    { type:'file', path:pdfPath, size:pdf.length + 1, sha:blobSha(pdf) },
    { type:'file', path:pdfPath, size:pdf.length, sha:'c'.repeat(40) }
  ]) {
    h = harness({ metadata }); await error(await h.request(valid), 502, 'pdf_integrity');
  }
  h = harness({ metadata:{ type:'file', path:pdfPath, size:20 * 1024 * 1024 + 1, sha:blobSha(pdf) } });
  await error(await h.request(valid), 413, 'pdf_too_large'); assert.equal(githubCalls(h).length, 2);
  const html = Buffer.from('<html>private GitHub error</html>');
  h = harness({ pdf:html, metadata:{ type:'file', path:pdfPath, size:html.length, sha:blobSha(html) } }); await error(await h.request(valid), 502, 'pdf_integrity');
  const different = Buffer.from(pdf); different[10] ^= 1;
  h = harness({ pdf:different, metadata:{ type:'file', path:pdfPath, size:different.length, sha:blobSha(different) } }); await error(await h.request(valid), 502, 'pdf_integrity');
  h = harness({ pdfResponse:() => new Response('secret private path', { status:404 }) }); await error(await h.request(valid), 404, 'pdf_not_found');
  h = harness({ indexResponse:() => new Response(null, { headers:{ 'content-length':String(4 * 1024 * 1024 + 1) } }) }); await error(await h.request(valid), 413, 'pdf_too_large');
  h = harness({ indexResponse:() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); controller.close(); } })) });
  await error(await h.request(valid), 413, 'pdf_too_large');
  h = harness({ timeoutMs:10, indexResponse:(_target, init) => new Response(new ReadableStream({ start(controller) { init.signal.addEventListener('abort', () => controller.error(new Error('synthetic body timeout'))); } })) });
  await error(await h.request(valid), 504, 'pdf_timeout');

  h = harness({ pdfResponse:() => new Response(null, { status:302, headers:{ location:'https://raw.githubusercontent.com/dodoxiaxia/AI-/' + commit + '/' + pdfPath.split('/').map(encodeURIComponent).join('/') + '?token=synthetic-signed-url' } }) });
  const redirected = await h.request(valid); assert.equal(redirected.status, 200); assert.equal(h.calls.filter(call => call.url.hostname === 'raw.githubusercontent.com').length, 1);
  for (const location of ['https://attacker.example/private.pdf', 'https://raw.githubusercontent.com/dodoxiaxia/AI-/' + otherCommit + '/wrong.pdf', 'https://api.github.com/elsewhere']) {
    h = harness({ pdfResponse:() => new Response(null, { status:302, headers:{ location } }) });
    await error(await h.request(valid), 502, 'pdf_upstream'); assert.equal(h.calls.length, 3);
  }
  h = harness({ pdfResponse:() => new Response(null, { status:302, headers:{ location:'https://raw.githubusercontent.com/dodoxiaxia/AI-/' + commit + '/' + pdfPath.split('/').map(encodeURIComponent).join('/') } }), rawResponse:() => new Response(null, { status:302, headers:{ location:'https://attacker.example' } }) });
  await error(await h.request(valid), 502, 'pdf_upstream'); assert.equal(h.calls.length, 4);

  h = harness({ csv:csv([noDoiRow]) }); const fallback = await h.request(valid, {}, undefined, { accept:'text/html' });
  assert.equal(fallback.status, 404); const page = await fallback.text(); assert(page.includes('https://doi.org/10.1000/exact')); assert(!page.includes(pdfPath)); assert(!page.includes(env.GITHUB_LIBRARY_TOKEN));
  const method = await h.context.worker.fetch(new Request('https://site.test/api/pdf?id=article', { method:'PUT' }), env); await error(method, 405, 'pdf_method');

  console.log('PDF offline boundaries passed: GET password form, bounded POST password verification, no unauthorized GitHub access, commit pinning, exact DOI/title, CSV, paths, PDF/SHA/size/blob, safe redirects, downloads and HTML errors.');
})().catch(error => { console.error(error); process.exitCode = 1; });
