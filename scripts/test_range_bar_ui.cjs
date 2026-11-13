'use strict';
// Offline browser test: #rangeBar exists in #toolRow, renders in candidates/library, hides elsewhere, and fits 390px without overflow.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');

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
          '/citation-export.js': ['citation-export.js', 'application/javascript'],
          '/app.js': ['app.js', 'application/javascript'],
          '/demo-reading.html': ['demo-reading.html', 'text/html'],
          '/icon.png': ['icon.png', 'image/png']
        };
        if (fileMap[u.pathname]) return route.fulfill({ body: fs.readFileSync(path.join(root, fileMap[u.pathname][0])), contentType: fileMap[u.pathname][1] });
        throw Error('Unexpected offline request ' + u.href);
      });

      // Library: #rangeBar visible in #toolRow, filters papers, fits 390px
      await page.goto(origin + '/?mode=library', { waitUntil: 'load' });
      assert.strictEqual(await page.locator('#toolRow #rangeBar').count(), 1, `${width}: #rangeBar inside #toolRow`);
      assert.strictEqual(await page.locator('#rangeBar').isVisible(), true, `${width}: #rangeBar visible in library`);
      assert.deepStrictEqual(
        await page.locator('#rangeBar select[data-range-select] option').evaluateAll(o => o.map(x => x.value)),
        ['all', '30', '90', '365'],
        `${width}: library range options`
      );
      assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}: no horizontal overflow in library`);

      if (width === 390) {
        const boxes = await page.evaluate(() => ['#searchToggleBtn', '#laneBar .lane-select', '#rangeBar .range-select', '#ftBar select', '#filterToggleBtn'].map(s => {
          const r = document.querySelector(s)?.getBoundingClientRect();
          return r ? { s, x: r.x, right: r.right, y: r.y } : null;
        }));
        assert(boxes.every(b => b && b.x >= -1 && b.right <= 391), '390px library toolRow fits inside viewport');
        assert(Math.max(...boxes.map(b => b.y)) - Math.min(...boxes.map(b => b.y)) < 8, '390px library toolRow stays on one row');
      }

      await page.locator('#rangeBar select[data-range-select]').selectOption('30');
      assert.strictEqual(new URL(page.url()).searchParams.get('range'), '30', `${width}: selecting range=30 updates URL`);
      assert.strictEqual(await page.locator('#articlesStream article[data-paper-id]').count(), 1, `${width}: range=30 filters out 45d paper`);

      // Candidates: #rangeBar visible, default 14, switching to 90 shows 45d paper
      await page.goto(origin + '/?mode=candidates', { waitUntil: 'load' });
      assert.strictEqual(await page.locator('#rangeBar').isVisible(), true, `${width}: #rangeBar visible in candidates`);
      assert.strictEqual(await page.locator('#rangeBar select[data-range-select]').inputValue(), '14', `${width}: candidates default range=14`);
      assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}: no horizontal overflow in candidates`);
      await page.locator('#rangeBar select[data-range-select]').selectOption('90');
      assert.strictEqual(await page.locator('#articlesStream article[data-paper-id]').count(), 2, `${width}: candidates range=90 shows both papers`);

      // Hidden in curated / weekly / sources / exact DOI
      for (const mode of ['curated', 'weekly', 'sources']) {
        await page.goto(origin + `/?mode=${mode}`, { waitUntil: 'load' });
        assert.strictEqual(await page.locator('#rangeBar').isVisible(), false, `${width}: #rangeBar hidden in ${mode}`);
        assert.strictEqual(await page.locator('#rangeBar').innerHTML(), '', `${width}: #rangeBar emptied in ${mode}`);
      }
      await page.goto(origin + '/?mode=library&q=10.1001%2Frange.1', { waitUntil: 'load' });
      assert.strictEqual(await page.locator('#rangeBar').isVisible(), false, `${width}: #rangeBar hidden during exact DOI search`);

      await context.close();
    }
    assert.deepStrictEqual(errors, [], 'no page errors');
    console.log('rangeBar UI checks passed');
  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
