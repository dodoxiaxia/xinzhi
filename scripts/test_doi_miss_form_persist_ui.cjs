'use strict';
// DOI 检索「未找到站内文献」空状态：后台刷新（列表先于 DOI lookup 返回）时「获取全文」口令框保持展开且输入不丢失。
// 离线浏览器测试：context.route 假后端 + 合成数据与合成口令，不连任何真实服务。
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://doi-miss-persist.invalid';
const TEST_DOI = '10.1234/doi.miss.persist';
const TEST_PASS = 'fake-doi-miss-pass';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox']
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [], consoleLines = [], requests = [];

  let libraryListGets = 0;
  let doiLookupGets = 0;
  let holdNextDoiLookup = false;
  let releaseHeldDoiLookup = null;
  let notifyHeldDoiLookupStarted = null;
  const heldDoiLookupStarted = new Promise(resolve => { notifyHeldDoiLookupStarted = resolve; });

  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => consoleLines.push(m.text()));
  await page.addInitScript(() => {
    window.__testOffsetMs = 0;
    const origNow = Date.now.bind(Date);
    Date.now = () => origNow() + window.__testOffsetMs;
  });

  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    requests.push({ url: req.url(), method: req.method() });
    if (u.origin === 'https://www.ebi.ac.uk') {
      return route.fulfill({ json: { hitCount: 0, resultList: { result: [] } } });
    }
    if (u.origin !== origin) {
      errors.push('Unexpected origin ' + u.origin);
      return route.abort();
    }

    if (u.pathname === '/api/ai' && u.searchParams.get('task') === 'status') {
      return route.fulfill({ json: { ok: true, canGenerate: false, pdfSignedLink: false } });
    }
    if (u.pathname === '/api/library') {
      if (u.searchParams.has('doi')) {
        doiLookupGets++;
        if (holdNextDoiLookup) {
          holdNextDoiLookup = false;
          if (notifyHeldDoiLookupStarted) { notifyHeldDoiLookupStarted(); notifyHeldDoiLookupStarted = null; }
          await new Promise(resolve => { releaseHeldDoiLookup = resolve; });
        }
        return route.fulfill({ json: { ok: true, found: false } });
      }
      libraryListGets++;
      return route.fulfill({ json: { ok: true, papers: [], jobs: [] } });
    }
    if (u.pathname.startsWith('/api/')) {
      return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
    }

    const assets = {
      '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: [] }),
      '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ items: [] }) + ';window.RADAR=' + JSON.stringify({ rows: [], jn: [], pub: [], tier: [], design: [], tag: [] }),
      '/data/curated.js': 'window.CURATED=[]',
      '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
      '/data/source-health.js': 'window.SOURCE_HEALTH=' + JSON.stringify({ sources: [] })
    };
    if (assets[u.pathname]) {
      return route.fulfill({ body: assets[u.pathname], contentType: 'application/javascript' });
    }
    const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (['index.html', 'app.js', 'citation-export.js', 'journal-metrics.js', 'style.css', 'icon.png'].includes(file)) {
      const contentType = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html';
      return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  try {
    const initialListRes = page.waitForResponse(r => {
      const u = new URL(r.url());
      return u.pathname === '/api/library' && !u.searchParams.has('doi');
    });
    const initialDoiRes = page.waitForResponse(r => {
      const u = new URL(r.url());
      return u.pathname === '/api/library' && u.searchParams.get('doi') === TEST_DOI;
    });
    await page.goto(origin + '/?mode=library&q=' + encodeURIComponent(TEST_DOI));
    await initialListRes;
    await initialDoiRes;

    const emptyHeading = page.locator('.empty-state.doi-empty h3');
    const openFormBtn = page.locator('.empty-state.doi-empty [data-ft-action="open-form"]');
    await emptyHeading.filter({ hasText: '未找到站内文献' }).waitFor();
    await openFormBtn.filter({ hasText: '获取全文' }).waitFor();

    await openFormBtn.click();
    const form = page.locator('.empty-state.doi-empty form[data-ft-form]');
    const passInput = form.locator('input[name="passphrase"]');
    await form.waitFor({ state: 'visible' });
    await passInput.fill(TEST_PASS);
    assert.equal(await passInput.inputValue(), TEST_PASS);

    // 刷新后的那一次 /api/library?doi= 先 hold 住，复现补录列表先返回的竞态
    holdNextDoiLookup = true;
    const refreshedListRes = page.waitForResponse(r => {
      const u = new URL(r.url());
      return u.pathname === '/api/library' && !u.searchParams.has('doi');
    });

    await page.evaluate(() => {
      window.__testOffsetMs += 65000;
      let hiddenVal = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenVal });
      document.dispatchEvent(new Event('visibilitychange'));
      hiddenVal = false;
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
      window.dispatchEvent(new Event('focus'));
    });

    await heldDoiLookupStarted;
    await refreshedListRes;
    await page.waitForTimeout(50);

    assert.equal(libraryListGets, 2, '超过 60s TTL 后切回页面应触发补录列表刷新');
    assert.equal(doiLookupGets, 2, '超过 60s TTL 后切回页面应触发 DOI 复核');
    assert.equal(await emptyHeading.innerText(), '正在核对收录状态', 'DOI 复核仍处于 loading 时标题显示正在核对收录状态');
    assert.equal(await form.isVisible(), true, '补录列表先返回且 DOI 仍在 loading 时，口令框仍保持展开');
    assert.equal(await passInput.inputValue(), TEST_PASS, '补录列表先返回且 DOI 仍在 loading 时，口令输入不丢失');

    // 放行被 hold 的 /api/library?doi=，验证完成后仍保持展开和输入
    if (releaseHeldDoiLookup) releaseHeldDoiLookup();
    await emptyHeading.filter({ hasText: '未找到站内文献' }).waitFor();
    assert.equal(await form.isVisible(), true, 'DOI 复核完成后口令框仍保持展开');
    assert.equal(await passInput.inputValue(), TEST_PASS, 'DOI 复核完成后口令输入不丢失');

    assert.equal(requests.filter(r => r.method === 'POST').length, 0, '未提交前不应发送 POST 请求');
    const stored = await page.evaluate(() => JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
      href: location.href
    }));
    assert(!stored.includes(TEST_PASS), '合成口令未出现在 localStorage/sessionStorage/cookie/location.href');
    assert(!consoleLines.some(l => l.includes(TEST_PASS)), '合成口令未出现在 console 日志');
    assert(!requests.some(r => r.url.includes(TEST_PASS)), '合成口令未出现在请求 URL');
    assert.deepEqual(errors, [], '页面应无 pageerror');

    console.log('DOI miss fulltext form persistence UI checks passed.');
  } finally {
    if (releaseHeldDoiLookup) releaseHeldDoiLookup();
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
