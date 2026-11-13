// Offline integration tests: synthetic passphrases and fixture GitHub responses only.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const { webcrypto, createHash } = require('crypto');
const original = fs.readFileSync(path.join(__dirname, '../edge/_worker.js'), 'utf8');
const library = {
  article: '10.1000/exact',
  titled: { doi:'', title:'  Clinical, "quoted"\nSTRASSE study  ' },
  both: { doi:'10.1000/exact', title:'Do not use this fallback' },
  invalid: { doi:'not-a-doi', title:'Clinical, "quoted" STRASSE study' },
  columnPrefixed: { doi:'', title:'AI IN MEDICINE  Column Test Article' },
  columnPlain: { doi:'', title:'Column Test Article' },
  columnLowercase: { doi:'', title:'Ai in medicine Column Test Article' },
  columnUnknown: { doi:'', title:'NEWS Column Test Article' },
  columnDoi: { doi:'10.1000/exact', title:'AI IN MEDICINE Whatever the title says' }
};
const defaultPassphrase = 'synthetic-default-passphrase';
// The repository is public: no passphrase or digest may be baked into the Worker.
assert(!/PDF_DEFAULT_PASSPHRASE|[0-9a-f]{64}'/.test(original.slice(0, original.indexOf('async function pdfRead('))));
assert(!/CF_ACCESS_|pdfAuthorize/i.test(original));
const readerPdf = original.slice(original.indexOf('async function handlePdf('), original.indexOf('const LIBRARY_PREFIX'));
assert(!/RS256|jwks|fulltextJobAuthorize/i.test(readerPdf), 'reader downloads use the shared password; OIDC belongs only to the background task endpoint');
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
  const context = vm.createContext({caches:options.caches, btoa, URL, Response, Request, TextEncoder, TextDecoder, AbortController, setTimeout:timers, clearTimeout, Uint8Array, URLSearchParams, crypto:webcrypto, fetch, console });
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
  assert(initialPage.includes('method="post"')); assert(initialPage.includes('action="/api/pdf?id=article"')); assert(initialPage.includes('type="password"')); assert(initialPage.includes('autocomplete="current-password"')); assert(initialPage.includes('href="/?mode=library&amp;q='));
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
  h = harness(); await error(await h.request(defaultPassphrase, { PDF_DOWNLOAD_PASSPHRASE:undefined }), 503, 'pdf_not_configured'); assert.equal(h.calls.length, 0);
  {
    // Ten wrong passphrases from one IP lock that IP out for the hour, even with the right one.
    const store = new Map(), caches = { default:{ match:async key => store.has(key.url) ? new Response(store.get(key.url)) : undefined, put:async (key, response) => { store.set(key.url, await response.text()); } } };
    const ip = { 'cf-connecting-ip':'203.0.113.9' };
    h = harness({ caches });
    for (let i = 0; i < 10; i++) await error(await h.request('wrong-' + i, {}, undefined, ip), 403, 'pdf_passphrase_invalid');
    await error(await h.request(valid, {}, undefined, ip), 429, 'pdf_rate_limited');
    assert.equal(h.calls.length, 0);
    assert(![...store.keys()].some(key => key.includes('203.0.113')), 'IP addresses are stored only as digests');
    assert.equal((await h.request(valid, {}, undefined, { 'cf-connecting-ip':'203.0.113.10' })).status, 200, 'other readers are not locked out');
  }
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
  {
    // The same file registered twice (equal SHA-256, any case) is one match; different or unusable checksums stay ambiguous.
    const upper = row => [...row.slice(0, 6), row[6].toUpperCase()];
    const otherPdf = Buffer.from('%PDF-1.7\nAnother synthetic article\n%%EOF\n');
    const other = row => [...row.slice(0, 6), sha256(otherPdf)];
    for (const [id, rows] of [['article', [normalRow, normalRow]], ['article', [normalRow, upper(normalRow)]], ['titled', [noDoiRow, noDoiRow]], ['article', [normalRow, normalRow, normalRow]]]) {
      h = harness({ csv:csv(rows) }); const same = await h.request(valid, {}, 'https://site.test/api/pdf?id=' + id);
      assert.equal(same.status, 200, 'duplicate rows with one SHA-256 download normally'); assert.deepEqual(Buffer.from(await same.arrayBuffer()), pdf); assert.equal(githubCalls(h).length, 3);
    }
    for (const [id, rows] of [['article', [normalRow, other(normalRow)]], ['titled', [noDoiRow, other(noDoiRow)]], ['article', [normalRow, normalRow, other(normalRow)]],
      ['article', [[...normalRow.slice(0, 6), 'invalid'], [...normalRow.slice(0, 6), 'invalid']]], ['article', [normalRow, [...normalRow.slice(0, 6), 'invalid']]]]) {
      h = harness({ csv:csv(rows) }); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=' + id), 409, 'pdf_ambiguous'); assert.equal(githubCalls(h).length, 1);
    }
  }
  {
    // Optional 文件类别 column: once any matched row has a category, only 正文 rows count. The harness only
    // serves pdfPath, so a 200 with the fixture bytes proves the main-text row (listed after the others) was chosen.
    const categoryCsv = rows => '\uFEFF' + [[...columns, '文件类别'], ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const file = (row, name, label) => [...row.slice(0, 5), '期刊/2026/' + name + '.pdf', sha256(Buffer.from('%PDF-1.7\n' + name + '\n%%EOF\n')), label];
    const main = row => [...row, '正文'];
    const supplement = (row, n = 1) => file(row, '补充' + n, '补充材料'), translation = row => file(row, '译本', '译本');
    const ok = async (id, rows, message, build = categoryCsv) => {
      h = harness({ csv:build(rows) }); const result = await h.request(valid, {}, 'https://site.test/api/pdf?id=' + id);
      assert.equal(result.status, 200, message); assert.deepEqual(Buffer.from(await result.arrayBuffer()), pdf, message); assert.equal(githubCalls(h).length, 3, message);
    };
    const refused = async (id, rows, message, build = categoryCsv) => {
      h = harness({ csv:build(rows) }); await error(await h.request(valid, {}, 'https://site.test/api/pdf?id=' + id), 409, 'pdf_ambiguous'); assert.equal(githubCalls(h).length, 1, message);
    };
    await ok('article', [supplement(normalRow), main(normalRow)], '1 main text + supplement');
    await ok('article', [translation(normalRow), main(normalRow)], '2 main text + translation');
    await ok('article', [supplement(normalRow, 1), main(normalRow), supplement(normalRow, 2)], '3 two supplements + main text');
    await refused('article', [file(normalRow, '未判定', ''), [...normalRow, '']], '4 all categories blank keeps the old ambiguity');
    await refused('article', [supplement(normalRow), translation(normalRow)], '5 categories but no main text');
    await refused('article', [main(normalRow), main(file(normalRow, '另一正文', '').slice(0, 7))], '6 two main texts with different SHA-256');
    await ok('article', [main(normalRow), main([...normalRow.slice(0, 6), normalRow[6].toUpperCase()])], '7 two main texts, one SHA-256');
    await refused('article', [[...normalRow, '补充材料']], '8 a single supplement is never sent as the article');
    await ok('article', [main(normalRow)], '9 a single main text');
    await ok('article', [file(normalRow, '未判定', ''), main(normalRow)], '10 main text + undecided blank row');
    await ok('article', [file(normalRow, '待定', '待定'), main(normalRow)], 'unknown category values are ignored');
    await ok('article', [supplement(normalRow), [...normalRow, ' 正文 ']], 'category cells are trimmed');
    await ok('titled', [supplement(noDoiRow), main(noDoiRow)], 'title matches follow the same category rule');
    await ok('article', [[...normalRow, '']], 'a single uncategorised row is unchanged');
    // 11 no 文件类别 column at all: exactly the old behaviour.
    await ok('article', [normalRow], '11 old index, one row', csv);
    await ok('article', [normalRow, normalRow], '11 old index, one file twice', csv);
    await refused('article', [normalRow, file(normalRow, '其他', '').slice(0, 7)], '11 old index, two files', csv);
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

  {
    // A known uppercase column label in front of a title is ignored on either side, only while exactly one row matches.
    const row = (title, sha = sha256(pdf)) => [title, '', 'fixture', '', '', pdfPath, sha];
    const otherSha = sha256(Buffer.from('another file'));
    const get = async (id, rows) => { const run = harness({ csv:csv(rows) }); return run.request(valid, {}, 'https://site.test/api/pdf?id=' + id); };
    assert.equal((await get('columnPrefixed', [row('Column Test Article')])).status, 200, 'site title carries the column label, index title does not');
    assert.equal((await get('columnPlain', [row('AI IN MEDICINE Column Test Article')])).status, 200, 'index title carries the column label');
    assert.equal((await get('columnPrefixed', [row('AI IN MEDICINE Column Test Article')])).status, 200, 'both carry it');
    await error(await get('columnPrefixed', [row('Column Test Article'), row('AI IN MEDICINE Column Test Article', otherSha)]), 409, 'pdf_ambiguous');
    assert.equal((await get('columnPrefixed', [row('Column Test Article'), row('AI IN MEDICINE Column Test Article')])).status, 200, 'same file under both spellings is one file');
    await error(await get('columnPrefixed', [row('Column Test Article'), row('Column  test article', otherSha)]), 409, 'pdf_ambiguous');
    await error(await get('columnLowercase', [row('Column Test Article')]), 404, 'pdf_not_found');
    await error(await get('columnUnknown', [row('Column Test Article')]), 404, 'pdf_not_found');
    await error(await get('columnPrefixed', [row('Other Article')]), 404, 'pdf_not_found');
    await error(await get('columnDoi', [row('Whatever the title says')]), 404, 'pdf_not_found');
    assert.equal((await get('columnDoi', [normalRow])).status, 200, 'with a DOI only the DOI decides');
  }
  h = harness({ csv:csv([noDoiRow]) }); const fallback = await h.request(valid, {}, undefined, { accept:'text/html' });
  assert.equal(fallback.status, 404); const page = await fallback.text(); assert(page.includes('https://doi.org/10.1000/exact')); assert(!page.includes(pdfPath)); assert(!page.includes(env.GITHUB_LIBRARY_TOKEN));
  const method = await h.context.worker.fetch(new Request('https://site.test/api/pdf?id=article', { method:'PUT' }), env); await error(method, 405, 'pdf_method');

  {
    // Signed download links: off unless PDF_SIGNED_LINK is exactly 'true'. Synthetic secrets only.
    const on = { PDF_SIGNED_LINK:'true' }, linkUrl = 'https://site.test/api/pdf?id=article&link=1';
    const linkPattern = /^\/api\/pdf\?id=article&t=([1-9]\d*\.[A-Za-z0-9_-]{43})$/;
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    const writes = [], reads = [];
    const kv = { get:async key => { reads.push(key); return null; }, put:async (...args) => { writes.push(args); }, delete:async (...args) => { writes.push(args); }, list:async () => ({ keys:[], list_complete:true }) };
    const sign = async (kind, subject, exp, changes = {}) => {
      const secrets = { ...env, ...changes }, encoder = new TextEncoder();
      const material = await webcrypto.subtle.importKey('raw', encoder.encode(secrets.GITHUB_LIBRARY_TOKEN + '\0' + secrets.PDF_DOWNLOAD_PASSPHRASE), 'HKDF', false, ['deriveBits']);
      const bits = await webcrypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt:encoder.encode('xinzhi/download-link/v1'), info:encoder.encode('pdf-link-v1') }, material, 256);
      const key = await webcrypto.subtle.importKey('raw', bits, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
      return exp + '.' + Buffer.from(await webcrypto.subtle.sign('HMAC', key, encoder.encode(kind + '|' + subject + '|' + exp))).toString('base64url');
    };
    const tokenUrl = (token, id = 'article') => 'https://site.test/api/pdf?id=' + id + '&t=' + encodeURIComponent(token);

    // Off (unset or anything but 'true'): both new forms stop with pdf_link_disabled before the passphrase, its rate limit or any secret is read.
    for (const flag of [undefined, 'false', 'TRUE', '1', 'true ', 'yes']) {
      let cacheOps = 0;
      h = harness({ caches:{ default:{ match:async () => { cacheOps++; }, put:async () => { cacheOps++; } } } });
      await error(await h.request(valid, { PDF_SIGNED_LINK:flag }, linkUrl), 404, 'pdf_link_disabled');
      await error(await h.request('wrong', { PDF_SIGNED_LINK:flag, PDF_DOWNLOAD_PASSPHRASE:undefined }, linkUrl), 404, 'pdf_link_disabled');
      await error(await h.request(valid, { PDF_SIGNED_LINK:flag }, linkUrl, {}, 'not-a-form'), 404, 'pdf_link_disabled');
      await error(await h.get({ PDF_SIGNED_LINK:flag, GITHUB_LIBRARY_TOKEN:undefined }, tokenUrl(await sign('pdf', 'article', nowSeconds() + 200))), 404, 'pdf_link_disabled');
      const disabledPage = await h.get({ PDF_SIGNED_LINK:flag }, tokenUrl('1.x'), { accept:'text/html' });
      assert.equal(disabledPage.status, 404); assert(disabledPage.headers.get('content-type').startsWith('text/html')); assert(!(await disabledPage.text()).includes('1.x'));
      assert.equal(cacheOps, 0); assert.equal(h.calls.length, 0);
      // Today's paths are unchanged while the switch is off.
      assert.equal((await h.get({ PDF_SIGNED_LINK:flag })).status, 200);
      assert.equal((await h.request(valid, { PDF_SIGNED_LINK:flag })).status, 200);
    }

    // Runtime status tells the page whether the in-card passphrase may be used.
    for (const [flag, expected] of [[undefined, false], ['false', false], ['TRUE', false], ['true', true]]) {
      const status = await h.context.worker.fetch(new Request('https://site.test/api/ai?task=status'), { ...env, LLM_ENDPOINT:'https://model.test/api', PDF_SIGNED_LINK:flag });
      assert.equal(status.status, 200); const body = await status.text();
      assert.strictEqual(JSON.parse(body).pdfSignedLink, expected); assert(!body.includes(valid)); assert(!body.includes(env.GITHUB_LIBRARY_TOKEN));
    }

    // Issue: passphrase checked, no PDF read, JSON only with url and 300 s lifetime.
    h = harness();
    const issued = await h.request(valid, { ...on, QL_KV:kv }, linkUrl);
    assert.equal(issued.status, 200); assert(issued.headers.get('content-type').startsWith('application/json'));
    assert.equal(issued.headers.get('cache-control'), 'no-store'); assert.equal(issued.headers.get('referrer-policy'), 'no-referrer');
    const link = await issued.json();
    assert.deepEqual(Object.keys(link).sort(), ['expiresIn', 'ok', 'url']); assert.strictEqual(link.ok, true); assert.strictEqual(link.expiresIn, 300);
    const matched = linkPattern.exec(link.url); assert(matched, 'signed link format');
    const token = matched[1], exp = Number(token.split('.')[0]);
    assert(exp >= nowSeconds() + 295 && exp <= nowSeconds() + 301, 'five-minute lifetime');
    assert(!JSON.stringify(link).includes(valid)); assert(!JSON.stringify(link).includes(env.GITHUB_LIBRARY_TOKEN));
    assert.equal(h.calls.length, 0, 'issuing a link makes no GitHub request');

    // Download with the link: no passphrase, same bytes and attachment headers as the POST download.
    const linked = await h.get({ ...on, QL_KV:kv }, 'https://site.test' + link.url);
    assert.equal(linked.status, 200); assert.equal(linked.headers.get('content-type'), 'application/pdf');
    assert.equal(linked.headers.get('content-disposition'), success.headers.get('content-disposition'));
    assert.equal(linked.headers.get('cache-control'), 'private, no-store'); assert.equal(linked.headers.get('referrer-policy'), 'no-referrer');
    assert.deepEqual(Buffer.from(await linked.arrayBuffer()), pdf); assert.equal(githubCalls(h).length, 3);
    assert(!h.calls.some(call => call.url.href.includes(token) || call.url.href.includes(token.split('.')[1]) || JSON.stringify(call.init.headers).includes(token.split('.')[1])), 'the link never reaches upstream requests');
    assert(!h.calls.some(call => call.url.href.includes(valid) || JSON.stringify(call.init.headers).includes(valid)));
    // The key is derived exactly as documented (HKDF-SHA256 over token + NUL + passphrase, fixed salt and info).
    h = harness(); assert.equal((await h.get(on, tokenUrl(await sign('pdf', 'article', nowSeconds() + 200)))).status, 200);

    // Issue failures.
    h = harness(); await error(await h.request('wrong', on, linkUrl), 403, 'pdf_passphrase_invalid'); assert.equal(h.calls.length, 0);
    h = harness(); await error(await h.request(valid, on, linkUrl, { origin:'https://attacker.example' }), 403, 'pdf_origin');
    h = harness(); await error(await h.request(valid, { ...on, GITHUB_LIBRARY_TOKEN:undefined }, linkUrl), 503, 'pdf_not_configured');
    h = harness(); await error(await h.request(valid, { ...on, GITHUB_LIBRARY_TOKEN:'  ' }, linkUrl), 503, 'pdf_not_configured');
    h = harness(); await error(await h.request(valid, { ...on, PDF_DOWNLOAD_ENABLED:undefined }, linkUrl), 503, 'pdf_disabled');
    h = harness(); await error(await h.request(valid, { ...on, PDF_DOWNLOAD_PASSPHRASE:undefined }, linkUrl), 503, 'pdf_not_configured');
    assert.equal(h.calls.length, 0);

    // Rejected links: other paper, tampered exp or signature, wrong kind, changed secrets, malformed. None reaches GitHub or KV writes.
    const [expPart, signaturePart] = token.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const flipped = (signaturePart[0] === 'A' ? 'B' : 'A') + signaturePart.slice(1);
    const nonCanonical = signaturePart.slice(0, -1) + alphabet[alphabet.indexOf(signaturePart.slice(-1)) ^ 1];
    h = harness();
    await error(await h.get({ ...on, QL_KV:kv }, tokenUrl(token, 'titled')), 403, 'pdf_link_invalid');
    for (const bad of [(Number(expPart) + 1) + '.' + signaturePart, (Number(expPart) - 1) + '.' + signaturePart, (Number(expPart) + 100000) + '.' + signaturePart,
      expPart + '.' + flipped, expPart + '.' + nonCanonical, expPart + '.' + signaturePart.slice(0, -1), token + 'A', '0' + token, expPart, '', '.', 'x.' + signaturePart,
      await sign('ft', 'article', nowSeconds() + 200), await sign('pdf', 'titled', nowSeconds() + 200),
      await sign('pdf', 'article', nowSeconds() + 200, { PDF_DOWNLOAD_PASSPHRASE:'synthetic-other-passphrase' }),
      await sign('pdf', 'article', nowSeconds() + 200, { GITHUB_LIBRARY_TOKEN:'synthetic-other-token' }),
      await sign('pdf', 'article', nowSeconds() + 3600)]) {
      await error(await h.get({ ...on, QL_KV:kv }, tokenUrl(bad)), 403, 'pdf_link_invalid');
    }
    const invalidPage = await h.get(on, tokenUrl(token, 'titled'), { accept:'text/html' });
    assert.equal(invalidPage.status, 403); const invalidHtml = await invalidPage.text();
    assert(invalidHtml.includes('下载链接无效')); assert(!invalidHtml.includes(signaturePart)); assert(!invalidHtml.includes(valid));
    await error(await h.get({ ...on, GITHUB_LIBRARY_TOKEN:undefined }, 'https://site.test' + link.url), 503, 'pdf_not_configured');
    assert.equal(h.calls.length, 0);

    // Expired: a correctly signed past exp, and a real link after the clock moves past five minutes (Chinese HTML page).
    await error(await h.get(on, tokenUrl(await sign('pdf', 'article', nowSeconds() - 1))), 410, 'pdf_link_expired');
    h = harness();
    const fresh = (await (await h.request(valid, on, linkUrl)).json()).url;
    vm.runInContext('{ const realNow = Date.now; Date.now = () => realNow() + 301000; }', h.context);
    const expired = await h.get({ ...on, QL_KV:kv }, 'https://site.test' + fresh, { accept:'text/html' });
    assert.equal(expired.status, 410); assert(expired.headers.get('content-type').startsWith('text/html'));
    const expiredHtml = await expired.text();
    assert(expiredHtml.includes('下载链接已过期（5 分钟内有效）')); assert(!expiredHtml.includes(fresh.split('t=')[1].split('.')[1])); assert(!expiredHtml.includes(valid));
    assert.equal(h.calls.length, 0);

    // Query whitelist: link only on POST, t only on GET, each at most once, nothing else.
    h = harness();
    await error(await h.request(valid, on, tokenUrl(token)), 400, 'pdf_bad_id');
    await error(await h.get(on, 'https://site.test/api/pdf?id=article&link=1'), 400, 'pdf_bad_id');
    for (const query of ['link=2', 'link=1&link=1', 'link=', 'link=1&t=' + token, 'link=1&repo=other']) await error(await h.request(valid, on, 'https://site.test/api/pdf?id=article&' + query), 400, 'pdf_bad_id');
    for (const query of ['t=' + token + '&t=' + token, 't=' + token + '&repo=other', 't=' + token + '&passphrase=' + valid]) await error(await h.get(on, 'https://site.test/api/pdf?id=article&' + query), 400, 'pdf_bad_id');
    assert.equal(h.calls.length, 0);
    assert.equal(writes.length, 0, 'signed links never write KV');
  }

  {
    // /api/fulltext signed links, with the DOI library harness and its fake KV.
    const { harness:doiHarness, doi:ftDoi, pdf:ftPdf, seed, error:ftError } = require('./test_doi_library_worker.cjs');
    const linkEnv = { PDF_SIGNED_LINK:'true' }, ftQuery = 'doi=' + encodeURIComponent(ftDoi);
    let d = doiHarness(); seed(d);
    await ftError(await d.request('/api/fulltext', { query:ftQuery + '&link=1' }), 404, 'pdf_link_disabled');
    await ftError(await d.request('/api/fulltext', { query:ftQuery + '&link=1', env:{ PDF_SIGNED_LINK:'false' } }), 404, 'pdf_link_disabled');
    await ftError(await d.request('/api/fulltext', { method:'GET', query:ftQuery + '&t=1.x' }), 404, 'pdf_link_disabled');
    assert.equal(d.reads.length, 0);
    const ftIssued = await d.request('/api/fulltext', { query:ftQuery + '&link=1', env:linkEnv });
    assert.equal(ftIssued.status, 200); assert.equal(ftIssued.headers.get('cache-control'), 'no-store'); assert.equal(ftIssued.headers.get('referrer-policy'), 'no-referrer');
    const ftLink = await ftIssued.json();
    assert.deepEqual(Object.keys(ftLink).sort(), ['expiresIn', 'ok', 'url']); assert.strictEqual(ftLink.expiresIn, 300);
    const ftMatched = /^\/api\/fulltext\?doi=10\.1000%2Fexact&t=([1-9]\d*\.[A-Za-z0-9_-]{43})$/.exec(ftLink.url); assert(ftMatched, 'fulltext signed link format');
    assert(!d.reads.some(read => read.key.startsWith('library:pdf:')), 'issuing reads the record only, never the PDF');
    const ftDownload = await d.request('/api/fulltext', { method:'GET', query:ftLink.url.split('?')[1], env:linkEnv });
    assert.equal(ftDownload.status, 200); assert.equal(ftDownload.headers.get('content-type'), 'application/pdf'); assert(ftDownload.headers.get('content-disposition').startsWith('attachment;'));
    assert.deepEqual(Buffer.from(await ftDownload.arrayBuffer()), ftPdf);
    await ftError(await d.request('/api/fulltext', { method:'GET', query:'doi=' + encodeURIComponent('10.1000/other') + '&t=' + ftMatched[1], env:linkEnv }), 403, 'pdf_link_invalid');
    const crossKind = doiHarness({ registry:{ article:ftDoi } });
    await ftError(await crossKind.request('/api/pdf', { method:'GET', query:'id=article&t=' + ftMatched[1], env:linkEnv }), 403, 'pdf_link_invalid');
    assert.equal(crossKind.calls.length, 0, 'a fulltext link is not a /api/pdf link, even for the same paper');
    await ftError(await d.request('/api/fulltext', { query:ftQuery + '&link=1', passphrase:'wrong', env:linkEnv }), 403, 'pdf_passphrase_invalid');
    await ftError(await d.request('/api/fulltext', { query:ftQuery + '&t=' + ftMatched[1], env:linkEnv }), 400, 'library_bad_doi');
    await ftError(await d.request('/api/fulltext', { method:'GET', query:ftQuery + '&link=1', env:linkEnv }), 400, 'library_bad_doi');
    await ftError(await d.request('/api/acquire', { query:ftQuery + '&link=1', env:linkEnv }), 400, 'library_bad_doi');
    await ftError(await d.request('/api/library', { method:'GET', query:ftQuery + '&t=' + ftMatched[1], env:linkEnv }), 400, 'library_bad_doi');
    const ftForm = await d.request('/api/fulltext', { method:'GET', env:linkEnv, headers:{ accept:'text/html' } });
    assert.equal(ftForm.status, 200); assert((await ftForm.text()).includes('method="post"'));
    assert.equal(d.calls.length, 0); assert.equal(d.writes.length, 0, 'fulltext links never write KV');
    d = doiHarness(); await ftError(await d.request('/api/fulltext', { query:ftQuery + '&link=1', env:linkEnv }), 404, 'library_not_found'); assert.equal(d.writes.length, 0);
    const clock = { now:Date.now() }; d = doiHarness({ clock }); seed(d);
    const late = await (await d.request('/api/fulltext', { query:ftQuery + '&link=1', env:linkEnv })).json();
    clock.now += 301000;
    const lateResponse = await d.request('/api/fulltext', { method:'GET', query:late.url.split('?')[1], env:linkEnv, headers:{ accept:'text/html' } });
    assert.equal(lateResponse.status, 410); assert((await lateResponse.text()).includes('下载链接已过期'));
    assert.equal(d.writes.length, 0);
  }

  console.log('Signed download links passed: off by default (pdf_link_disabled before the passphrase), status flag, issue/verify for /api/pdf and /api/fulltext, binding to kind/subject/exp, tampering, expiry, query whitelist, no KV writes.');
  console.log('PDF offline boundaries passed: GET password form, bounded POST password verification, no unauthorized GitHub access, commit pinning, exact DOI/title, CSV, paths, PDF/SHA/size/blob, safe redirects, downloads and HTML errors.');
})().catch(error => { console.error(error); process.exitCode = 1; });
