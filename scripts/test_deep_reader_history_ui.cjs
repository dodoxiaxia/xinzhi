'use strict';
// Offline browser test: closing #deepReader after a reload or direct ?read= entry must not call history.back().
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const origin = 'https://deep-reader-history.invalid';
const externalOrigin = 'https://external-referrer.invalid';
const today = new Date().toISOString().slice(0, 10);

const makeReading = (pmcid, titleZh) => ({
  pmcid,
  publishedOn: today,
  date: today,
  title: 'Original ' + pmcid,
  titleZh,
  journal: 'Circulation',
  doi: '10.1000/' + pmcid.toLowerCase(),
  pmid: '1',
  humanReviewed: false,
  scope: 'public-fulltext-body',
  sourceUrl: 'https://europepmc.org/articles/' + pmcid,
  sections: {
    question: { text: '测试研究问题 ' + pmcid, evidence: [] },
    design: { text: '测试研究设计 ' + pmcid, evidence: [] }
  }
});

const scripts = {
  '/data/library.js': 'window.LIBRARY={papers:[]};',
  '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: today, items: [] }) + ';',
  '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[]};',
  '/data/curated.js': 'window.CURATED=[];',
  '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}};window.DEEP_READINGS=' + JSON.stringify({
    schemaVersion: 1,
    status: { day: today, target: 2, completed: 2, state: 'complete', reason: '' },
    items: [makeReading('PMC101', '第一篇全文精读'), makeReading('PMC102', '第二篇全文精读')]
  }) + ';'
};

let checks = 0;
const ok = (cond, msg) => { assert(cond, msg); checks++; };

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url());
      if (u.origin === externalOrigin) {
        await route.fulfill({ body: '<!doctype html><html><body>external</body></html>', contentType: 'text/html' });
        return;
      }
      assert.strictEqual(u.origin, origin, 'No external requests');
      if (u.pathname.startsWith('/api/')) {
        assert.strictEqual(req.method(), 'GET', 'No model POST');
        await route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
        return;
      }
      if (scripts[u.pathname]) { await route.fulfill({ body: scripts[u.pathname], contentType: 'application/javascript' }); return; }
      if (u.pathname === '/style.css') { await route.fulfill({ body: fs.readFileSync(path.join(root, 'style.css')), contentType: 'text/css' }); return; }
      if (u.pathname === '/citation-export.js') { await route.fulfill({ body: fs.readFileSync(path.join(root, 'citation-export.js')), contentType: 'application/javascript' }); return; }
      if (u.pathname === '/app.js') { await route.fulfill({ body: fs.readFileSync(path.join(root, 'app.js')), contentType: 'application/javascript' }); return; }
      if (u.pathname === '/icon.png') { await route.fulfill({ body: fs.readFileSync(path.join(root, 'icon.png')), contentType: 'image/png' }); return; }
      if (u.pathname === '/demo-reading.html') { await route.fulfill({ body: fs.readFileSync(path.join(root, 'demo-reading.html')), contentType: 'text/html' }); return; }
      if (u.pathname === '/' || u.pathname === '/index.html') { await route.fulfill({ body: fs.readFileSync(path.join(root, 'index.html')), contentType: 'text/html' }); return; }
      throw new Error('Unexpected request ' + u.href);
    });

    const spyBack = () => page.evaluate(() => {
      window.__backCalls = 0;
      const orig = history.back.bind(history);
      history.back = () => { window.__backCalls += 1; return orig(); };
    });

    // 1. Direct deep link from an external page (no site history before ?read=PMC101):
    //    close button, Esc, and backdrop must not call history.back() or exit the site.
    await page.goto(externalOrigin + '/ref', { waitUntil: 'load' });
    await page.goto(origin + '/?mode=weekly&pane=reading&read=PMC101', { waitUntil: 'load' });
    await page.locator('#deepReader.open').waitFor();
    await spyBack();
    await page.click('#deepReaderClose');
    await page.waitForFunction(() => !document.getElementById('deepReader').classList.contains('open'));
    ok(await page.evaluate(() => window.__backCalls) === 0, 'direct entry close button skips history.back');
    ok(page.url() === origin + '/?mode=weekly&pane=reading', 'direct entry close button returns URL to weekly list');
    ok(await page.evaluate(() => !(history.state && history.state.deepReader)), 'direct entry close clears deepReader state');

    await page.goto(origin + '/?mode=weekly&pane=reading&read=PMC102', { waitUntil: 'load' });
    await page.locator('#deepReader.open').waitFor();
    await spyBack();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('deepReader').classList.contains('open'));
    ok(await page.evaluate(() => window.__backCalls) === 0, 'direct entry Esc skips history.back');
    ok(page.url() === origin + '/?mode=weekly&pane=reading', 'direct entry Esc returns URL to weekly list');

    // 2. Open from list then reload page: browser keeps history.state across reload,
    //    yet closing after reload must NOT call history.back() (must use replaceState).
    await page.goto(origin + '/?mode=weekly&pane=reading', { waitUntil: 'load' });
    await page.click('[data-action="open-deep-reading"][data-reading-id="PMC101"]');
    await page.locator('#deepReader.open').waitFor();
    ok(new URL(page.url()).searchParams.get('read') === 'PMC101', 'opening from list adds read param');
    await page.reload({ waitUntil: 'load' });
    await page.locator('#deepReader.open').waitFor();
    await spyBack();
    await page.click('#deepReaderClose');
    await page.waitForFunction(() => !document.getElementById('deepReader').classList.contains('open'));
    ok(await page.evaluate(() => window.__backCalls) === 0, 'after reload close button skips history.back');
    ok(page.url() === origin + '/?mode=weekly&pane=reading', 'after reload close button returns URL to list');
    ok(await page.evaluate(() => history.state === null), 'after reload close leaves clean history.state');

    // Reload again with Esc and backdrop close paths
    await page.click('[data-action="open-deep-reading"][data-reading-id="PMC102"]');
    await page.locator('#deepReader.open').waitFor();
    await page.reload({ waitUntil: 'load' });
    await page.locator('#deepReader.open').waitFor();
    await spyBack();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('deepReader').classList.contains('open'));
    ok(await page.evaluate(() => window.__backCalls) === 0, 'after reload Esc skips history.back');
    ok(page.url() === origin + '/?mode=weekly&pane=reading', 'after reload Esc returns URL to list');

    await page.click('[data-action="open-deep-reading"][data-reading-id="PMC101"]');
    await page.locator('#deepReader.open').waitFor();
    await page.reload({ waitUntil: 'load' });
    await page.locator('#deepReader.open').waitFor();
    await spyBack();
    await page.evaluate(() => document.getElementById('drawerBackdrop').click());
    await page.waitForFunction(() => !document.getElementById('deepReader').classList.contains('open'));
    ok(await page.evaluate(() => window.__backCalls) === 0, 'after reload backdrop click skips history.back');
    ok(page.url() === origin + '/?mode=weekly&pane=reading', 'after reload backdrop click returns URL to list');

    // 3. Normal list -> open -> close still uses history.back() across close button, Esc, and backdrop.
    await page.goto(origin + '/?mode=weekly&pane=reading', { waitUntil: 'load' });
    await spyBack();

    await page.click('[data-action="open-deep-reading"][data-reading-id="PMC101"]');
    await page.locator('#deepReader.open').waitFor();
    await page.click('#deepReaderClose');
    await page.waitForFunction(() => !document.getElementById('deepReader').classList.contains('open'));
    ok(await page.evaluate(() => window.__backCalls) === 1, 'normal open then close button uses history.back');
    ok(page.url() === origin + '/?mode=weekly&pane=reading', 'normal close button returns URL to list');
    ok(await page.evaluate(() => document.activeElement?.dataset?.readingId === 'PMC101'), 'normal close restores focus to item');

    await page.click('[data-action="open-deep-reading"][data-reading-id="PMC102"]');
    await page.locator('#deepReader.open').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('deepReader').classList.contains('open'));
    ok(await page.evaluate(() => window.__backCalls) === 2, 'normal open then Esc uses history.back');
    ok(page.url() === origin + '/?mode=weekly&pane=reading', 'normal Esc returns URL to list');

    await page.click('[data-action="open-deep-reading"][data-reading-id="PMC101"]');
    await page.locator('#deepReader.open').waitFor();
    await page.evaluate(() => document.getElementById('drawerBackdrop').click());
    await page.waitForFunction(() => !document.getElementById('deepReader').classList.contains('open'));
    ok(await page.evaluate(() => window.__backCalls) === 3, 'normal open then backdrop click uses history.back');
    ok(page.url() === origin + '/?mode=weekly&pane=reading', 'normal backdrop click returns URL to list');

    assert.deepStrictEqual(errors, [], 'No page JS errors');
    console.log(JSON.stringify({ passed: true, checks }));
  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
