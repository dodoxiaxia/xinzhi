'use strict';
// Offline regression test for fallback HTML theme alignment with the main site (light + dark).
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
const pdfHtml = vm.runInContext('pdfHtml', context);

function contrastRatio(fgHex, bgHex) {
  const lum = hex => {
    const clean = hex.replace('#', '');
    const rgb = [0, 2, 4].map(i => parseInt(clean.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const l1 = lum(fgHex), l2 = lum(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

(async () => {
  const headers = { accept: 'text/html' };
  const pages = [
    ['GET /api/pdf form', await context.worker.fetch(new Request('https://site.test/api/pdf?id=article', { method: 'GET', headers }), {})],
    ['GET /api/pdf error', await context.worker.fetch(new Request('https://site.test/api/pdf?id=unknown', { method: 'GET', headers }), {})],
    ['GET /api/acquire form', await context.worker.fetch(new Request('https://site.test/api/acquire?doi=10.1000%2Fexact', { method: 'GET', headers }), {})],
    ['GET /api/fulltext form', await context.worker.fetch(new Request('https://site.test/api/fulltext?doi=10.1000%2Fexact', { method: 'GET', headers }), {})],
    ['pdfHtml helper', pdfHtml('<p>测试</p>', 200, '测试页', '10.1000/exact')]
  ];

  const oldBeigeBurgundy = ['#f5f2ea', '#ece8dd', '#fffdf8', '#ddd6c6', '#c9c1ae', '#9b2335', '#7e1a29', '#f3e2df', '#14120f', '#1c1a16', '#1a1814', '#e0707a', '#f08c94'];
  const mainSiteBlue = ['#eef2f7', '#1b4f9c', '#143d7a', '#ffffff', '#0e1520', '#78aeff', '#a0c5ff'];

  for (const [label, response] of pages) {
    const html = await response.text();
    const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html);
    assert(styleMatch, label + ': inline <style> must exist');
    const css = styleMatch[1].toLowerCase();
    for (const oldColor of oldBeigeBurgundy) {
      assert(!css.includes(oldColor), label + ': must not contain old color ' + oldColor);
    }
    for (const expectedColor of mainSiteBlue) {
      assert(css.includes(expectedColor), label + ': must contain main-site color ' + expectedColor);
    }
  }

  // Verify button text vs background contrast >= 4.5:1 in both light and dark modes.
  assert(contrastRatio('#ffffff', '#1b4f9c') >= 4.5, 'light primary button contrast >= 4.5:1');
  assert(contrastRatio('#ffffff', '#143d7a') >= 4.5, 'light primary button hover contrast >= 4.5:1');
  assert(contrastRatio('#0e1520', '#78aeff') >= 4.5, 'dark primary button contrast >= 4.5:1');
  assert(contrastRatio('#0e1520', '#a0c5ff') >= 4.5, 'dark primary button hover contrast >= 4.5:1');

  console.log('Fallback page theme test passed: main-site blue/light-blue-gray palette applied in light/dark modes with >= 4.5:1 button contrast.');
})().catch(error => { console.error(error); process.exitCode = 1; });
