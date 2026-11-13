'use strict';
// Offline browser test: popstate restores search, range and shareable URL filters without writing stale state back.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://popstate-test.invalid';
const daysAgo = n => {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
};
const papers = {
  libRecent: {
    id: 'lib-recent', pmid: '101', doi: '10.1001/test.recent',
    title: 'Atrial fibrillation alpha recent study', date: daysAgo(5), datePrecision: 'day',
    journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA',
    clinicalTier: '心血管旗舰顶刊', tags: ['#心律失常'], studyDesign: 'RCT',
    summary: 'Recent alpha summary.', url: 'https://pubmed.ncbi.nlm.nih.gov/101/'
  },
  libMid: {
    id: 'lib-mid', pmid: '102', doi: '10.1001/test.mid',
    title: 'Atrial fibrillation alpha sixty days study', date: daysAgo(60), datePrecision: 'day',
    journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA',
    clinicalTier: '心血管旗舰顶刊', tags: ['#心律失常'], studyDesign: '队列研究',
    summary: 'Mid alpha summary.', url: 'https://pubmed.ncbi.nlm.nih.gov/102/'
  },
  libOld: {
    id: 'lib-old', pmid: '103', doi: '10.1001/test.old',
    title: 'Atrial fibrillation alpha ancient study', date: daysAgo(200), datePrecision: 'day',
    journal: 'JACC', cleanJournal: 'JACC', publisher: 'Elsevier',
    clinicalTier: '心血管旗舰顶刊', tags: ['#心律失常'], studyDesign: 'RCT',
    summary: 'Old alpha summary.', url: 'https://pubmed.ncbi.nlm.nih.gov/103/'
  },
  candBeta: {
    id: 'cand-beta', pmid: '201', doi: '10.1001/test.beta',
    title: 'Valve beta radar study', date: daysAgo(2), datePrecision: 'day',
    journal: 'European Heart Journal', cleanJournal: 'European Heart Journal', publisher: 'Oxford',
    clinicalTier: '心血管旗舰顶刊', tags: ['#瓣膜'], studyDesign: 'RCT',
    summary: 'Beta radar summary.', url: 'https://pubmed.ncbi.nlm.nih.gov/201/'
  },
  candAlpha: {
    id: 'cand-alpha', pmid: '202', doi: '10.1001/test.calpha',
    title: 'Atrial fibrillation alpha radar study', date: daysAgo(3), datePrecision: 'day',
    journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA',
    clinicalTier: '心血管旗舰顶刊', tags: ['#心律失常'], studyDesign: 'RCT',
    summary: 'Alpha radar summary.', url: 'https://pubmed.ncbi.nlm.nih.gov/202/'
  }
};
const scripts = {
  '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: [papers.libRecent, papers.libMid, papers.libOld], pdfIds: ['lib-recent'] }),
  '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: daysAgo(0), items: [papers.candBeta, papers.candAlpha] }),
  '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[]}',
  '/data/curated.js': 'window.CURATED=' + JSON.stringify([papers.libRecent]),
  '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}'
};

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    requests.push({ url: u.href, method: req.method() });
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
      '/icon.png': ['icon.png', 'image/png']
    };
    if (fileMap[u.pathname]) return route.fulfill({ body: fs.readFileSync(path.join(root, fileMap[u.pathname][0])), contentType: fileMap[u.pathname][1] });
    throw Error('Unexpected offline request ' + u.href);
  });

  try {
    // 1. Cross-mode back & forward: library (range=90, q=alpha) -> candidates (q=beta) -> Back -> Forward
    await page.goto(origin + '/?mode=library', { waitUntil: 'load' });
    await page.locator('#rangeBar select[data-range-select]').selectOption('90');
    await page.click('#searchToggleBtn');
    await page.fill('#globalSearch', 'alpha');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'alpha');
    assert.deepStrictEqual(
      await page.locator('#articlesStream article[data-paper-id]').evaluateAll(els => els.map(e => e.dataset.paperId)),
      ['lib-recent', 'lib-mid'],
      'library q=alpha & range=90 shows recent + 60d papers'
    );

    await page.click('.nav-tab-btn[data-mode="candidates"]');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('mode') === 'candidates');
    await page.fill('#globalSearch', 'beta');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'beta');
    assert.deepStrictEqual(
      await page.locator('#articlesStream article[data-paper-id]').evaluateAll(els => els.map(e => e.dataset.paperId)),
      ['cand-beta'],
      'candidates q=beta shows beta paper'
    );

    await page.goBack();
    await page.waitForTimeout(250);
    const backUrl = new URL(page.url());
    assert.strictEqual(backUrl.searchParams.get('mode'), 'library', 'Back restores library mode');
    assert.strictEqual(backUrl.searchParams.get('q'), 'alpha', 'Back preserves q=alpha without overwriting history');
    assert.strictEqual(backUrl.searchParams.get('range'), '90', 'Back preserves range=90 without resetting to default');
    assert.strictEqual(await page.locator('#globalSearch').inputValue(), 'alpha', 'Back restores search input');
    assert.strictEqual(await page.locator('#searchPanel').isVisible(), true, 'Back keeps search panel visible when q is non-empty');
    assert.strictEqual(await page.locator('#rangeBar select[data-range-select]').inputValue(), '90', 'Back restores range select');
    assert.deepStrictEqual(
      await page.locator('#articlesStream article[data-paper-id]').evaluateAll(els => els.map(e => e.dataset.paperId)),
      ['lib-recent', 'lib-mid'],
      'Back re-renders library results for q=alpha & range=90'
    );

    await page.goForward();
    await page.waitForTimeout(250);
    const fwdUrl = new URL(page.url());
    assert.strictEqual(fwdUrl.searchParams.get('mode'), 'candidates', 'Forward restores candidates mode');
    assert.strictEqual(fwdUrl.searchParams.get('q'), 'beta', 'Forward restores q=beta');
    assert.strictEqual(await page.locator('#globalSearch').inputValue(), 'beta', 'Forward restores search input');
    assert.strictEqual(await page.locator('#rangeBar select[data-range-select]').inputValue(), '14', 'Forward restores candidates default range=14');

    // 2. Restore additional shareable params (lane, journal, ft, sort) and same-mode popstate
    await page.goto(origin + '/?mode=library&lane=all&range=365&journal=Circulation&ft=none&q=alpha&sort=date-asc', { waitUntil: 'load' });
    await page.evaluate(() => {
      history.pushState(null, '', '/?mode=library&lane=core&range=30&q=recent&sort=date-desc');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForTimeout(150);
    assert.strictEqual(await page.locator('#globalSearch').inputValue(), 'recent', 'same-mode popstate updates search input');
    assert.strictEqual(await page.locator('#rangeBar select[data-range-select]').inputValue(), '30', 'same-mode popstate updates range');
    assert.strictEqual(await page.locator('#sortSelector').inputValue(), 'date-desc', 'same-mode popstate updates sort');
    assert.strictEqual(await page.locator('#laneBar select[data-lane-select]').inputValue(), 'core', 'same-mode popstate updates lane');

    await page.goBack();
    await page.waitForTimeout(150);
    assert.strictEqual(await page.locator('#globalSearch').inputValue(), 'alpha', 'back restores q=alpha');
    assert.strictEqual(await page.locator('#rangeBar select[data-range-select]').inputValue(), '365', 'back restores range=365');
    assert.strictEqual(await page.locator('#sortSelector').inputValue(), 'date-asc', 'back restores sort=date-asc');
    assert.strictEqual(await page.locator('#laneBar select[data-lane-select]').inputValue(), 'all', 'back restores lane=all');
    assert.strictEqual(await page.locator('#ftBar select[data-ft-select]').inputValue(), 'none', 'back restores ft=none');
    assert.deepStrictEqual(
      await page.locator('#articlesStream article[data-paper-id]').evaluateAll(els => els.map(e => e.dataset.paperId)),
      ['lib-mid'],
      'back restores filtered result for Circulation + ft=none + q=alpha'
    );

    // 3. Overlay Back button still closes drawer without clobbering restored filters
    await page.locator('#articlesStream [data-action="open-drawer"]').first().click();
    await page.locator('#readerDrawer.open').waitFor();
    await page.goBack();
    await page.waitForTimeout(150);
    assert.strictEqual(await page.locator('#readerDrawer.open').count(), 0, 'Back closes drawer');
    assert.strictEqual(new URL(page.url()).searchParams.get('q'), 'alpha', 'closing drawer keeps q=alpha');
    assert.strictEqual(new URL(page.url()).searchParams.get('range'), '365', 'closing drawer keeps range=365');

    assert.deepStrictEqual(errors, [], 'no page errors');
    console.log('popstate restore checks passed');
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
