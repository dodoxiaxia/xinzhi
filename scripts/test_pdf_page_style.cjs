'use strict';
// Fallback pages (/api/pdf, /api/acquire, /api/fulltext) share pdfHtml(): self-contained HTML under
// CSP default-src 'none'; style-src 'unsafe-inline'. Offline: synthetic fixtures only, no network.
const assert = require('node:assert/strict');
const { harness } = require('./test_doi_library_worker.cjs');

function rules(css) {
  // Innermost `selector{declarations}` blocks; @media wrappers are flattened (their children match too).
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1].trim(), body: match[2] }));
}
const find = (list, needle, declaration) => list.filter(rule => rule.selector.includes(needle) && (!declaration || rule.body.includes(declaration)));

function checkPage(label, response, html) {
  assert(response.headers.get('content-type').startsWith('text/html'), label + ': html content type');
  assert.equal(response.headers.get('cache-control'), 'no-store', label + ': cache-control unchanged');
  const csp = response.headers.get('content-security-policy');
  assert(csp.includes("default-src 'none'") && csp.includes("style-src 'unsafe-inline'"), label + ': CSP unchanged');

  // charset is the first element of <head> and sits inside the first 1024 bytes.
  assert(html.startsWith('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'), label + ': explicit <head> with meta charset first');
  assert(Buffer.byteLength(html.slice(0, html.indexOf('<meta charset="utf-8">') + 22)) <= 1024, label + ': charset within 1024 bytes');
  assert(html.includes('<meta name="viewport" content="width=device-width,initial-scale=1">'), label + ': viewport');
  assert(html.includes('</head><body>') && html.endsWith('</main></body></html>'), label + ': head/body structure');

  // Top bar: site name plus a plain <a> back to the library, before <main>; no script needed.
  const topbar = /<header class="topbar"><span class="site">心知<\/span><a class="topback" href="\/\?mode=library">← 返回文献库<\/a><\/header><main>/;
  assert(topbar.test(html), label + ': top bar with 心知 and ← 返回文献库 link to /?mode=library');
  assert(html.indexOf('class="topback"') < html.indexOf('<main>'), label + ': top bar precedes main');
  assert(!html.includes('<main style='), label + ': no inline main styles');
  assert(/<main><h1>[^<]+<\/h1>[\s\S]*<\/main>/.test(html), label + ': h1 then body inside main');
  // The library link appears once, in the top bar; only a link to the specific paper may follow the body.
  assert.equal((html.match(/返回文献库/g) || []).length, 1, label + ': exactly one 返回文献库 link (top bar)');
  const back = /<p class="back"><a href="([^"]+)">([^<]+)<\/a><\/p><\/main>/.exec(html);
  if (back) assert.equal(back[2], '回到网站查看这篇文献', label + ': a bottom link may only point at the specific paper');

  // Nothing external, nothing executable.
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert(!/url\(|@import|https?:\/\//i.test(css), label + ': style has no external resources');
  assert(!/<(?:link|script|img|iframe|object|embed|video|audio)\b|\ssrc\s*=|\son[a-z]+\s*=|http-equiv/i.test(html), label + ': no external or executable resources');

  // Main-site palette copied as literals (style.css html[data-style="a"] and [data-theme="dark"]); old beige/burgundy is gone.
  for (const literal of ['#eef2f7', '#e6ebf2', '#ffffff', '#dbe2ec', '#c3cddb', '#16202e', '#38465a', '#62728a', '#1b4f9c', '#143d7a', '#e3ecf8', '#0f7b6c', '#86570f',
    '#0e1520', '#172130', '#141d2b', '#25334a', '#34445e', '#e7edf6', '#bcc8d9', '#8a9bb3', '#78aeff', '#a0c5ff', '#5cc4b0', '#dbb35a',
    '"PingFang SC"', '"Noto Sans SC"', '"Microsoft YaHei"']) assert(css.includes(literal), label + ': missing ' + literal);
  for (const legacy of ['#f5f2ea', '#ece8dd', '#fffdf8', '#ddd6c6', '#9b2335', '#7e1a29', '#f3e2df', '#14120f', '#1a1814', '#e0707a', '#f08c94',
    '#1d4f91', '#94a3b8', '#334155', '#475569', '#f1f5f9', '#2f6f3e', '#9a3412', 'system-ui']) assert(!css.includes(legacy), label + ': legacy ' + legacy);
  assert(css.includes('@media (prefers-color-scheme:dark)'), label + ': dark theme media query');
  assert(css.indexOf('@media (prefers-color-scheme:dark)') > css.indexOf(':root{'), label + ': dark variables override light ones');

  // Mobile: 44px touch targets, >=16px inputs, full-width primary button, wrapping, no horizontal scroll.
  const list = rules(css);
  const input = find(list, 'input[type=password]')[0];
  assert(input, label + ': password input rule');
  assert(/(?:^|;)font-size:(\d+)px/.test(input.body) && Number(/(?:^|;)font-size:(\d+)px/.exec(input.body)[1]) >= 16, label + ': input font-size >= 16px (no iOS focus zoom)');
  for (const declaration of ['min-height:44px', 'box-sizing:border-box', 'width:100%']) assert(input.body.includes(declaration), label + ': input ' + declaration);
  const button = find(list, 'button.primary', 'min-height:44px')[0];
  assert(button && button.selector.includes('a.primary') && button.selector.includes('form>button[type=submit]'), label + ': buttons min-height 44px');
  assert(button.body.includes('box-sizing:border-box'), label + ': buttons box-sizing');
  assert(find(list, 'p.back a', 'min-height:44px').length, label + ': link buttons min-height 44px');
  assert(find(list, 'a.topback', 'min-height:44px').length, label + ': top bar link min-height 44px');
  assert(css.includes('@media (max-width:480px)'), label + ': narrow-screen media query');
  assert(find(list, 'button.primary', 'width:100%').length, label + ': primary button fills narrow screens');
  assert(find(list, 'body').some(rule => /font:16px\/1\.7 var\(--font-sans\)/.test(rule.body)), label + ': body line-height 1.7 and site font stack');
  assert(find(list, 'main', 'overflow-wrap:anywhere').length, label + ': long DOI/titles wrap');
  const card = find(list, 'main', 'border-radius:10px')[0];
  assert(card && card.body.includes('var(--bg-card)') && card.body.includes('var(--border)') && card.body.includes('var(--shadow-md)'), label + ': main is a card');
  assert(find(list, '.status', 'var(--accent)').length && find(list, '.done', 'var(--emerald)').length && find(list, '.stop', 'var(--amber)').length, label + ': status/steps use site colours');
}

(async () => {
  const h = harness({ registry: { article: '10.1000/exact' } });
  const html = { accept: 'text/html' }, bare = { QL_KV: undefined, GITHUB_LIBRARY_TOKEN: undefined, PDF_DOWNLOAD_ENABLED: undefined };
  const pages = [
    ['pdf password form', await h.request('/api/pdf', { method: 'GET', query: 'id=article', headers: html }), 200],
    ['pdf error page', await h.request('/api/pdf', { method: 'GET', query: 'id=unknown', headers: html }), 404],
    ['acquire form', await h.request('/api/acquire', { method: 'GET', headers: html, env: bare }), 200],
    ['fulltext form', await h.request('/api/fulltext', { method: 'GET', headers: html, env: bare }), 200]
  ];
  for (const [label, response, status] of pages) {
    assert.equal(response.status, status, label + ': status unchanged');
    checkPage(label, response, await response.text());
  }
  assert.equal(h.calls.length, 0, 'rendering fallback pages makes no outbound requests');
  console.log('PDF/acquire fallback page style passed: charset first, top bar back link, site palette (light/dark), 44px targets, 16px inputs, no external resources.');
})().catch(error => { console.error(error); process.exitCode = 1; });
