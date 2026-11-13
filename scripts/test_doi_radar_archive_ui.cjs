'use strict';
// Offline browser test: radar.js loading/error/retry states during site-wide DOI search across modes.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://doi-radar-ui.invalid';

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const oldDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const radarArchive = {
    rows: [['41000001', '10.1234/radar-old', oldDate, 0, 0, 0, 0, [], 'Old archived radar paper']],
    jn: ['Circulation'], pub: ['AHA'], tier: ['心血管综合与其他'], design: ['RCT'], tag: []
  };
  const assets = {
    '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: [] }),
    '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ items: [] }) + ';window.RADAR=' + JSON.stringify({ rows: [], jn: [], pub: [], tier: [], design: [], tag: [] }) + ';window.RADAR_SRC="/radar.js";',
    '/data/curated.js': 'window.CURATED=[]',
    '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
    '/data/source-health.js': 'window.SOURCE_HEALTH=' + JSON.stringify({ sources: [{ id: 'fixture', name: 'Offline source', status: 'ok', items: 1 }] })
  };

  let radarMode = 'pending'; // 'pending' | 'fail' | 'ok'
  let releasePendingRadar = null;
  let radarRequests = 0;
  const requests = [], errors = [];

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    requests.push({ pathname: u.pathname, method: req.method() });
    assert(['GET', 'HEAD'].includes(req.method()), 'Test must never send POST or mutating requests: ' + req.method() + ' ' + u.pathname);
    assert.equal(u.origin, origin, 'Only offline fixture requests are allowed: ' + u.href);

    if (u.pathname === '/radar.js') {
      radarRequests++;
      if (radarMode === 'pending') {
        await new Promise(resolve => { releasePendingRadar = resolve; });
      }
      if (radarMode === 'fail') {
        return route.fulfill({ status: 500, contentType: 'application/javascript', body: '' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'window.RADAR_ARCHIVE=' + JSON.stringify(radarArchive) + ';window.XINZHI_RADAR_READY&&window.XINZHI_RADAR_READY();'
      });
    }
    if (u.pathname === '/api/library') {
      if (u.searchParams.has('doi')) return route.fulfill({ json: { ok: true, found: false } });
      return route.fulfill({ json: { ok: true, papers: [], jobs: [] } });
    }
    if (u.pathname.startsWith('/api/')) {
      return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
    }
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
    // 1. While radar.js is loading and /api/library returns found:false, show loading notice and never "站内暂未收录".
    radarMode = 'pending';
    await page.goto(origin + '/?mode=library&q=10.1234%2Fradar-old', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const text = document.querySelector('#articlesStream')?.innerText || '';
      return text.includes('正在检索旧雷达存档…') && !text.includes('正在检查补录文献…');
    });
    const loadingText = await page.locator('#articlesStream').innerText();
    assert(loadingText.includes('正在检索旧雷达存档…'), 'Shows loading notice while radar.js is pending');
    assert(!loadingText.includes('站内暂未收录'), 'Does not falsely claim missing while radar.js is loading');

    // 2. When radar.js fails, show failure notice + retry button, and still never "站内暂未收录".
    radarMode = 'fail';
    releasePendingRadar();
    const retryBtn = page.locator('.doi-search-notice').getByRole('button', { name: '重试', exact: true });
    await retryBtn.waitFor();
    const errorText = await page.locator('#articlesStream').innerText();
    assert(errorText.includes('旧雷达存档加载失败，暂时无法确认站内是否收录这个 DOI'), 'Shows failure message when radar.js errors');
    assert(!errorText.includes('站内暂未收录'), 'Does not falsely claim missing when radar.js fails');

    // 3. Clicking retry reloads radar.js, finds the paper, and clears the error notice.
    const countBeforeRetry = radarRequests;
    radarMode = 'ok';
    await retryBtn.click();
    await page.locator('#articlesStream article[data-paper-id="pmid-41000001"]').waitFor();
    assert(radarRequests > countBeforeRetry, 'Retry triggers a new radar.js load');
    const hitText = await page.locator('#articlesStream').innerText();
    assert(hitText.includes('Old archived radar paper'), 'Displays archived paper after retry succeeds');
    assert.equal(await page.locator('.doi-search-notice').count(), 0, 'Hides DOI notice once paper is matched');

    // 4. Only after radar.js loaded AND supplemental lookup missed should "站内暂未收录这个 DOI" appear.
    await page.goto(origin + '/?mode=library&q=10.1234%2Ftruly-missing');
    await page.locator('.doi-search-notice').waitFor();
    await page.waitForFunction(() => (document.querySelector('#articlesStream')?.innerText || '').includes('站内暂未收录这个 DOI'));

    // 5. Decoupled from candidates mode: error + retry works in curated, weekly, sources, candidates, and library.
    for (const mode of ['curated', 'weekly', 'sources', 'candidates', 'library']) {
      radarMode = 'fail';
      await page.goto(origin + '/?mode=' + mode + '&q=10.1234%2Fradar-old');
      const modeRetry = page.locator('.doi-search-notice').getByRole('button', { name: '重试', exact: true });
      await modeRetry.waitFor();
      const modeErrorText = await page.locator('#articlesStream').innerText();
      assert(modeErrorText.includes('旧雷达存档加载失败，暂时无法确认站内是否收录这个 DOI'), mode + ' shows failure message');
      assert(!modeErrorText.includes('站内暂未收录'), mode + ' does not show missing before radar succeeds');

      radarMode = 'ok';
      await modeRetry.click();
      await page.locator('#articlesStream article[data-paper-id="pmid-41000001"]').waitFor();
    }

    // 6. Existing candidates 365-day non-DOI archive notice remains intact.
    radarMode = 'fail';
    await page.goto(origin + '/?mode=candidates&range=365');
    const candRetry = page.locator('.radar-archive-note').getByRole('button', { name: '重试', exact: true });
    await candRetry.waitFor();
    assert((await page.locator('#articlesStream').innerText()).includes('365 天题录存档载入失败'));
    radarMode = 'ok';
    await candRetry.click();
    await page.locator('#articlesStream article[data-paper-id="pmid-41000001"]').waitFor();

    assert.deepEqual(errors, [], 'No page errors occurred');
    console.log('DOI radar archive loading/error/retry UI checks passed');
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
