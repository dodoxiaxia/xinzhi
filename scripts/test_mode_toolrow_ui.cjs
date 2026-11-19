'use strict';
// Offline browser test for the visible quick filters across modes and exact DOI searches.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium, expect } = require('playwright/test');

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
    const scope = page.locator('#qfScopeBtn');
    const quickBar = page.locator('#quickBar');
    const pop = page.locator('#qfPop');
    const topic = quickBar.locator('[data-qf="topic"]');
    async function openScope() {
      await expect(scope).toBeVisible();
      await scope.click();
      await expect(pop.locator('[data-qf-lane]').first()).toBeVisible();
      await expect(pop.locator('[data-qf-range]').first()).toBeVisible();
    }

    await page.goto(origin + '/?mode=library', { waitUntil: 'load' });
    await openScope();
    await expect(pop.locator('[data-qf-ft]').first()).toBeVisible();

    await page.click('.nav-tab-btn[data-mode="weekly"]');
    await expect(scope).toBeHidden();
    await expect(pop).toBeHidden();
    await expect(topic).toBeVisible();

    await page.click('.nav-tab-btn[data-mode="library"]');
    await openScope();
    await expect(pop.locator('[data-qf-ft]').first()).toBeVisible();

    await page.click('#sourceStatusBtn');
    await expect(quickBar).toBeHidden();
    await expect(pop).toBeHidden();

    await page.click('.nav-tab-btn[data-mode="curated"]');
    await expect(scope).toBeHidden();
    await expect(topic).toBeVisible();
    await page.click('.nav-tab-btn[data-mode="candidates"]');
    await openScope();
    await expect(pop.locator('[data-qf-ft]')).toHaveCount(0);

    await page.click('.nav-tab-btn[data-mode="library"]');
    await page.click('#searchToggleBtn');
    await page.fill('#globalSearch', '10.1001/toolrow.1');
    await expect(page.locator('.doi-filter-badge')).toBeVisible();
    await expect(quickBar).toBeHidden();

    await page.click('.nav-tab-btn[data-mode="weekly"]');
    await expect(quickBar).toBeHidden();
    await page.click('#searchPanel [data-clear="search"]');
    await expect(page.locator('#weeklySection')).toBeVisible();
    await expect(scope).toBeHidden();
    await expect(topic).toBeVisible();

    assert.deepStrictEqual(errors, [], 'no page errors');
    console.log('mode toolRow visibility checks passed');
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
