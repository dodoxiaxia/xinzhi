'use strict';
// Offline browser test: switching modes or DOI layout clears and hides inapplicable tool-row controls (#laneBar, #rangeBar, #ftBar).
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://mode-toolrow-test.invalid';
const today = new Date().toISOString().slice(0, 10);
const paper = {
  id: 'p-1', pmid: '1', doi: '10.1001/toolrow.1',
  title: 'Cardio AI study', date: today, datePrecision: 'day',
  journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA',
  clinicalTier: '心血管旗舰顶刊', tags: ['#心律'], studyDesign: 'RCT',
  summary: 'Abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/1/'
};
const scripts = {
  '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: [paper], pdfIds: [] }),
  '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: today, items: [{ ...paper, weeklyPick: 1, weeklyCategory: 'cardio' }] }),
  '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[{name:"Circulation",status:"ok",items:1}]}',
  '/data/curated.js': 'window.CURATED=' + JSON.stringify([paper]),
  '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}'
};

async function barState(page) {
  return page.evaluate(() => ['#laneBar', '#rangeBar', '#ftBar', '#filterToggleBtn'].map(sel => {
    const el = document.querySelector(sel);
    return { sel, hidden: !el || el.hidden, html: el ? el.innerHTML : null };
  }));
}

async function assertAllBarsHidden(page, label) {
  const states = await barState(page);
  for (const s of states) {
    assert.strictEqual(s.hidden, true, `${label}: ${s.sel} must be hidden`);
    if (s.sel !== '#filterToggleBtn') assert.strictEqual(s.html, '', `${label}: ${s.sel} must be emptied`);
  }
}

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    assert.strictEqual(u.origin, origin, 'No external requests');
    assert(['GET', 'HEAD'].includes(req.method()), 'Read-only requests only');
    if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
    if (scripts[u.pathname]) return route.fulfill({ body: scripts[u.pathname], contentType: 'application/javascript' });
    const fileMap = {
      '/': ['index.html', 'text/html'],
      '/index.html': ['index.html', 'text/html'],
      '/style.css': ['style.css', 'text/css'],
      '/journal-metrics.js': ['journal-metrics.js', 'application/javascript'],
      '/journal-tiers.js': ['journal-tiers.js', 'application/javascript'],
      '/citation-export.js': ['citation-export.js', 'application/javascript'],
      '/app.js': ['app.js', 'application/javascript'],
      '/demo-reading.html': ['demo-reading.html', 'text/html'],
      '/icon.png': ['icon.png', 'image/png']
    };
    if (fileMap[u.pathname]) return route.fulfill({ body: fs.readFileSync(path.join(root, fileMap[u.pathname][0])), contentType: fileMap[u.pathname][1] });
    throw Error('Unexpected offline request ' + u.href);
  });

  try {
    // 1. library -> weekly -> library -> sources
    await page.goto(origin + '/?mode=library', { waitUntil: 'load' });
    assert.strictEqual(await page.locator('#laneBar select').isVisible(), true, 'library shows lane select');
    assert.strictEqual(await page.locator('#rangeBar select').isVisible(), true, 'library shows range select');
    assert.strictEqual(await page.locator('#ftBar select').isVisible(), true, 'library shows ft select');

    await page.click('.nav-tab-btn[data-mode="weekly"]');
    await assertAllBarsHidden(page, 'library -> weekly');

    await page.click('.nav-tab-btn[data-mode="library"]');
    assert.strictEqual(await page.locator('#laneBar select').isVisible(), true, 'weekly -> library restores lane select');
    assert.strictEqual(await page.locator('#rangeBar select').isVisible(), true, 'weekly -> library restores range select');
    assert.strictEqual(await page.locator('#ftBar select').isVisible(), true, 'weekly -> library restores ft select');

    await page.click('#sourceStatusBtn');
    await assertAllBarsHidden(page, 'library -> sources');

    // 2. curated -> weekly / sources also cleans up topic chips and moves #laneBar back cleanly
    await page.click('.nav-tab-btn[data-mode="curated"]');
    assert.strictEqual(await page.locator('#streamRail #laneBar').count(), 1, 'curated puts #laneBar in rail');
    await page.click('.nav-tab-btn[data-mode="weekly"]');
    await assertAllBarsHidden(page, 'curated -> weekly');
    assert.strictEqual(await page.locator('#streamLaneSlot #laneBar').count(), 1, 'curated -> weekly restores #laneBar slot');

    // 3. DOI layout toggle hides bars and clearing restores target mode visibility
    await page.click('.nav-tab-btn[data-mode="library"]');
    await page.click('#searchToggleBtn');
    await page.fill('#globalSearch', '10.1001/toolrow.1');
    await page.waitForFunction(() => !!document.querySelector('#activeFiltersBar .doi-filter-badge'));
    await assertAllBarsHidden(page, 'library exact DOI');

    await page.click('.nav-tab-btn[data-mode="weekly"]');
    await assertAllBarsHidden(page, 'weekly exact DOI');
    await page.click('#searchPanel [data-clear="search"]');
    await page.waitForFunction(() => !document.querySelector('#weeklySection').hidden);
    await assertAllBarsHidden(page, 'weekly after clearing DOI');

    assert.deepStrictEqual(errors, [], 'no page errors');
    console.log('mode toolRow visibility checks passed');
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
