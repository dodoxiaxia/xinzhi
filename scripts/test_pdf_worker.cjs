// Offline integration tests: synthetic Access keys and fixture GitHub responses only.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const { webcrypto, createHash } = require('crypto');
const original = fs.readFileSync(path.join(__dirname, '../edge/_worker.js'), 'utf8');
const library = {
  article: '10.1000/exact',
  titled: { doi:'', title:'  Clinical, "quoted"\nSTRASSE study  ' },
  both: { doi:'10.1000/exact', title:'Do not use this fallback' },
  invalid: { doi:'not-a-doi', title:'Clinical, "quoted" STRASSE study' }
};
const source = original.replace('const PDF_LIBRARY = {};', 'const PDF_LIBRARY = ' + JSON.stringify(library) + ';').replace('export default {', 'globalThis.worker = {');
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
const env = { PDF_DOWNLOAD_ENABLED:'true', GITHUB_LIBRARY_TOKEN:'synthetic-secret-token', CF_ACCESS_TEAM_DOMAIN:'offline.cloudflareaccess.com', CF_ACCESS_AUD:'synthetic-audience', PDF_GITHUB_COMMIT:commit };
let keyPair, jwk;
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function jwt(overrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iss:'https://offline.cloudflareaccess.com', aud:['synthetic-audience'], exp:now + 3600, nbf:now - 60, ...overrides });
  const header = b64({ alg:'RS256', kid:'offline-key', ...headerOverrides });
  const input = header + '.' + body;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, Buffer.from(input));
  return input + '.' + Buffer.from(signature).toString('base64url');
}
function harness(options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const target = new URL(url); calls.push({ url:target, init });
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    if (target.hostname === 'offline.cloudflareaccess.com') {
      assert.equal(target.pathname, '/cdn-cgi/access/certs');
      assert(!init.headers.authorization);
      return options.jwksResponse ? options.jwksResponse(target, init) : Response.json({ keys:[jwk] });
    }
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
  const context = vm.createContext({ URL, Response, Request, TextEncoder, TextDecoder, AbortController, setTimeout:timers, clearTimeout, Uint8Array, atob, crypto:webcrypto, fetch, console });
  vm.runInContext(source, context);
  return { context, calls, request:async (token, changes = {}, url = 'https://site.test/api/pdf?id=article', headers = {}) => {
    const response = await context.worker.fetch(new Request(url, { headers:{ ...(token ? { 'cf-access-jwt-assertion':token } : {}), ...headers } }), { ...env, ...changes });
    return response;
  } };
}
async function error(result, status, code) {
  assert.equal(result.status, status);
  const body = await result.text();
  assert(!body.includes('synthetic-secret-token')); assert(!body.includes(pdfPath));
  const parsed = JSON.parse(body); assert.equal(parsed.ok, false); assert.equal(parsed.error, code);
  assert.equal(result.headers.get('cache-control'), 'no-store');
}
const githubCalls = h => h.calls.filter(call => call.url.hostname === 'api.github.com');

(async () => {
  keyPair = await webcrypto.subtle.generateKey({ name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' }, true, ['sign','verify']);
  jwk = { ...await webcrypto.subtle.exportKey('jwk', keyPair.publicKey), kid:'offline-key', use:'sig', alg:'RS256' };
  const valid = await jwt();

  let h = harness();
  await error(await h.request(null, { PDF_DOWNLOAD_ENABLED:undefined }), 503, 'pdf_disabled');
  await error(await h.request(valid, { GITHUB_LIBRARY_TOKEN:'' }), 503, 'pdf_not_configured');
  await error(await h.request(valid, { CF_ACCESS_AUD:undefined }), 503, 'pdf_not_configured');
  await error(await h.request(valid, { CF_ACCESS_TEAM_DOMAIN:'https://attacker.example' }), 503, 'pdf_not_configured');
  await error(await h.request(valid, { CF_ACCESS_TEAM_DOMAIN:'https://offline.cloudflareaccess.com@attacker.example' }), 503, 'pdf_not_configured');
  await error(await h.request(valid, { PDF_GITHUB_COMMIT:'main' }), 503, 'pdf_not_configured');
  await error(await h.request(null), 401, 'pdf_auth_required'); assert.equal(h.calls.length, 0);

  for (const token of [
    await jwt({ iss:'https://attacker.example' }), await jwt({ aud:'different-app' }),
    await jwt({ exp:Math.floor(Date.now() / 1000) - 1 }), await jwt({ nbf:Math.floor(Date.now() / 1000) + 3600 }),
    await jwt({ exp:'9999999999' }), await jwt({}, { alg:'HS256' }),
    'invalid.jwt.parts', valid.split('.').slice(0, 2).concat(b64('tampered signature')).join('.'),
    await jwt({ aud:'synthetic-audience' }, { crit:['unhandled'] })
  ]) {
    h = harness(); await error(await h.request(token), 403, 'pdf_access_denied'); assert.equal(githubCalls(h).length, 0);
  }
  const parts = valid.split('.');
  const signature = Buffer.from(parts[2], 'base64url'); signature[signature.length - 1] ^= 1;
  h = harness(); await error(await h.request(parts.slice(0, 2).concat(signature.toString('base64url')).join('.')), 403, 'pdf_access_denied'); assert.equal(githubCalls(h).length, 0);
  h = harness({ jwksResponse:() => new Response('private-upstream-message', { status:500 }) });
  await error(await h.request(valid), 503, 'pdf_auth_unavailable'); assert.equal(githubCalls(h).length, 0);
  h = harness({ jwksResponse:() => new Response(null, { status:302, headers:{ location:'https://attacker.example/jwks' } }) });
  await error(await h.request(valid), 503, 'pdf_auth_unavailable'); assert.equal(h.calls.length, 1);
  h = harness({ jwksResponse:() => Response.json({ keys:[{ ...jwk, kid:'different-key' }] }) });
  await error(await h.request(valid), 403, 'pdf_access_denied'); assert.equal(githubCalls(h).length, 0);
  h = harness({ jwksResponse:() => Response.json({ keys:[jwk, jwk] }) });
  await error(await h.request(valid), 403, 'pdf_access_denied'); assert.equal(githubCalls(h).length, 0);

  h = harness(); const success = await h.request(valid);
  assert.equal(success.status, 200); assert.equal(success.headers.get('content-type'), 'application/pdf');
  assert(success.headers.get('content-disposition').startsWith('attachment;')); assert(success.headers.get('content-disposition').includes("filename*=UTF-8''" + encodeURIComponent('精确匹配文章.pdf')));
  assert(success.headers.get('cache-control').includes('no-store')); assert.equal(success.headers.get('content-length'), String(pdf.length));
  assert.deepEqual(Buffer.from(await success.arrayBuffer()), pdf); assert.equal(githubCalls(h).length, 3);
  const cached = await h.request(valid); assert.equal(cached.status, 200); assert.equal(h.calls.filter(call => call.url.hostname === 'offline.cloudflareaccess.com').length, 1);
  h = harness({ commit:otherCommit }); assert.equal((await h.request(valid, { PDF_GITHUB_COMMIT:undefined })).status, 200); assert.equal(githubCalls(h).length, 4);
  h = harness(); assert.equal((await h.request(await jwt({ aud:'synthetic-audience' }))).status, 200);
  h = harness(); assert.equal((await h.request(valid, {}, 'https://site.test/api/pdf?id=titled')).status, 200, 'no DOI uses exact Unicode case-folded title with quoted comma and embedded newline');
  h = harness({ csv:csv([noDoiRow]) }); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=both'), 404, 'pdf_not_found');
  h = harness(); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=invalid'), 404, 'pdf_not_found'); assert.equal(githubCalls(h).length, 0);
  h = harness(); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=unknown'), 404, 'pdf_not_found'); assert.equal(githubCalls(h).length, 0);
  h = harness(); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=article&id=titled'), 400, 'pdf_bad_id'); assert.equal(githubCalls(h).length, 0);
  for (const extra of ['repo=other/repo', 'path=secret.pdf', 'doi=10.1000/exact']) {
    h = harness(); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=article&' + extra), 400, 'pdf_bad_id'); assert.equal(githubCalls(h).length, 0);
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
    await error(await h.request(valid), 502, 'pdf_upstream'); assert.equal(h.calls.length, 4);
  }
  h = harness({ pdfResponse:() => new Response(null, { status:302, headers:{ location:'https://raw.githubusercontent.com/dodoxiaxia/AI-/' + commit + '/' + pdfPath.split('/').map(encodeURIComponent).join('/') } }), rawResponse:() => new Response(null, { status:302, headers:{ location:'https://attacker.example' } }) });
  await error(await h.request(valid), 502, 'pdf_upstream'); assert.equal(h.calls.length, 5);

  h = harness(); const noLogin = await h.request(null, {}, undefined, { accept:'text/html' });
  assert.equal(noLogin.status, 401); const noLoginPage = await noLogin.text(); assert(noLoginPage.includes('Cloudflare Access 登录')); assert(noLoginPage.includes('href="/?mode=library"'));
  h = harness({ csv:csv([noDoiRow]) }); const fallback = await h.request(valid, {}, undefined, { accept:'text/html' });
  assert.equal(fallback.status, 404); const page = await fallback.text(); assert(page.includes('https://doi.org/10.1000/exact')); assert(!page.includes(pdfPath)); assert(!page.includes(env.GITHUB_LIBRARY_TOKEN));
  const method = await h.context.worker.fetch(new Request('https://site.test/api/pdf?id=article', { method:'POST' }), env); await error(method, 405, 'pdf_method');

  console.log('PDF offline boundaries passed: Access JWT, no unauthorized GitHub access, commit pinning, exact DOI/title, CSV, paths, PDF/SHA/size/blob, safe redirects, downloads and HTML errors.');
})().catch(error => { console.error(error); process.exitCode = 1; });
