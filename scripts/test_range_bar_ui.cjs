'use strict';
// Offline browser test for the time choices in the visible scope filter.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium, expect } = require('playwright/test');

const root = path.resolve(__dirname, '..');
const origin = 'https://range-bar-test.invalid';
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const papers = [
  { id: 'p-5d', pmid: '1', doi: '10.1001/range.1', title: 'Recent 5d paper', date: daysAgo(5), datePrecision: 'day', journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA', clinicalTier: '心血管旗舰顶刊', tags: ['#心律'], studyDesign: 'RCT', summary: 'Recent abstract.' },
  { id: 'p-45d', pmid: '2', doi: '10.1001/range.2', title: 'Older 45d paper', date: daysAgo(45), datePrecision: 'day', journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA', clinicalTier: '心血管旗舰顶刊', tags: ['#心律'], studyDesign: 'RCT', summary: 'Older abstract.' }
];
const scripts = {
  '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers, pdfIds: [] }),
  '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: daysAgo(0), items: papers }),
  '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[{name:"Circulation",status:"ok",items:2}]}',
  '/data/curated.js': 'window.CURATED=' + JSON.stringify([papers[0]]),
  '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}'
};

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const errors = [];
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const page = await context.newPage();
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

      const scope = page.locator('#qfScopeBtn');
      const pop = page.locator('#qfPop');
      const range = value => pop.locator(`[data-qf-range="${value}"]`);
      const ids = () => page.locator('#articlesStream article[data-paper-id]').evaluateAll(
        elements => elements.map(e => e.dataset.paperId));

      await page.goto(origin + '/?mode=library', { waitUntil: 'load' });
      await expect(scope).toBeVisible();
      await scope.click();
      assert.deepStrictEqual(
        await pop.locator('[data-qf-range]').evaluateAll(options => options.map(e => e.dataset.qfRange)),
        ['all', '30', '90', '365'],
        `${width}: library range options`
      );
      await expect(range('all')).toHaveAttribute('aria-pressed', 'true');
      for (const element of [scope, pop, range('365')]) {
        const box = await element.boundingBox();
        assert(box && box.x >= -1 && box.x + box.width <= width + 1, `${width}: scope control fits`);
      }
      assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepStrictEqual(await ids(), ['p-5d', 'p-45d']);
      await range('30').click();
      assert.strictEqual(new URL(page.url()).searchParams.get('range'), '30', `${width}: selecting range=30 updates URL`);
      assert.deepStrictEqual(await ids(), ['p-5d'], `${width}: 30d keeps only the recent paper`);

      await page.goto(origin + '/?mode=candidates', { waitUntil: 'load' });
      await scope.click();
      await expect(range('14')).toHaveAttribute('aria-pressed', 'true');
      await expect(range('all')).toHaveCount(0);
      assert.deepStrictEqual(await ids(), ['p-5d']);
      await range('90').click();
      assert.deepStrictEqual(await ids(), ['p-5d', 'p-45d'], `${width}: extending to 90d includes the older paper`);

      for (const mode of ['curated', 'weekly', 'sources']) {
        await page.goto(origin + `/?mode=${mode}`, { waitUntil: 'load' });
        await expect(scope, `${width}: no scope filter in ${mode}`).toBeHidden();
        await expect(pop).toBeHidden();
      }
      await page.goto(origin + '/?mode=library&q=10.1001%2Frange.1', { waitUntil: 'load' });
      await expect(scope).toBeHidden();

      await context.close();
    }
    assert.deepStrictEqual(errors, [], 'no page errors');
    console.log('Scope time filter checks passed at 390px and 1280px');
  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
