'use strict';
// Offline regression test for PDF error page back link preserving the paper's DOI.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('node:assert/strict');
const { webcrypto } = require('crypto');

const source = fs.readFileSync(path.join(__dirname, '../edge/_worker.js'), 'utf8')
  .replace('const PDF_LIBRARY = {};', 'const PDF_LIBRARY = {"article":"10.1000/exact"};')
  .replace('export default {', 'globalThis.worker = {');

const context = vm.createContext({
  URL, URLSearchParams, Response, Request, TextEncoder, TextDecoder, Uint8Array, AbortController,
  setTimeout, clearTimeout, crypto: webcrypto, atob, btoa, console,
  fetch: async () => { throw new Error('unexpected network call'); }
});
vm.runInContext(source, context);
const pdfError = vm.runInContext('pdfError', context);

(async () => {
  const doi = '10.1000/exact+test';
  const req = new Request('https://site.test/api/pdf?id=article', { method: 'GET', headers: { accept: 'text/html' } });
  const res = pdfError(req, 'pdf_not_found', 404, doi);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert(html.includes('<title>心知 · PDF 下载</title>'));
  assert(html.includes('<h1>PDF 下载</h1>'));
  assert(html.includes('这篇文献暂未提供可下载的 PDF。'));
  assert(html.includes('https://doi.org/' + encodeURIComponent(doi).replace(/%2F/gi, '/')));
  const expectedBack = '<p class="back"><a href="/?mode=library&amp;q=' + encodeURIComponent(doi) + '">回到网站查看这篇文献</a></p>';
  assert(html.includes(expectedBack), 'pdfError HTML must include DOI-encoded back link: ' + expectedBack);

  const noDoiRes = pdfError(req, 'pdf_bad_id', 400, '');
  assert.equal(noDoiRes.status, 400);
  const noDoiHtml = await noDoiRes.text();
  assert(!noDoiHtml.includes('<p class="back">'), 'without a DOI, no per-paper back link should be added');

  // End-to-end GET route (no POST, no network) triggering pdfError with a known paper ID.
  const routeRes = await context.worker.fetch(
    new Request('https://site.test/api/pdf?id=article&t=1.x', { method: 'GET', headers: { accept: 'text/html' } }),
    { PDF_SIGNED_LINK: 'true', PDF_DOWNLOAD_PASSPHRASE: 'synthetic-test-passphrase', GITHUB_LIBRARY_TOKEN: 'synthetic-test-token' }
  );
  assert.equal(routeRes.status, 403);
  const routeHtml = await routeRes.text();
  assert(routeHtml.includes('href="/?mode=library&amp;q=' + encodeURIComponent('10.1000/exact') + '"'),
    'GET /api/pdf error page must preserve the article DOI in the back link');

  console.log('PDF error back link test passed: pdfError and GET /api/pdf error page preserve encoded DOI in back link.');
})().catch(error => { console.error(error); process.exitCode = 1; });
