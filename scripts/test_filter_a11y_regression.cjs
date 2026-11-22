'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright/test');

const root = path.resolve(__dirname, '..');
const origin = 'https://filter-a11y-test.invalid';
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const papers = [
  { id: 'p-recent', pmid: '1', doi: '10.1001/filter.1', title: 'Recent candidate', date: daysAgo(5), datePrecision: 'day', journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA', clinicalTier: '心血管旗舰顶刊', tags: ['#心律'], studyDesign: 'RCT', summary: 'Recent abstract.' },
  { id: 'p-older', pmid: '2', doi: '10.1001/filter.2', title: 'Older candidate', date: daysAgo(45), datePrecision: 'day', journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA', clinicalTier: '心血管旗舰顶刊', tags: ['#心律'], studyDesign: 'RCT', summary: 'Older abstract.' }
];
const scripts = {
  '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers, pdfIds: [] }),
  '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: daysAgo(0), items: papers }),
  '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[{name:"Circulation",status:"ok",items:2}]}',
  '/data/curated.js': 'window.CURATED=' + JSON.stringify([papers[0]]),
  '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}'
};
const files = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/journal-metrics.js': ['journal-metrics.js', 'application/javascript'],
  '/journal-tiers.js': ['journal-tiers.js', 'application/javascript'],
  '/citation-export.js': ['citation-export.js', 'application/javascript'],
  '/app.js': ['app.js', 'application/javascript'],
  '/icon.png': ['icon.png', 'image/png']
};

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const failures = [];
  try {
    for (const width of [390, 884, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage();
      const errors = [];
      const widthFailures = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        assert.strictEqual(url.origin, origin, 'No external requests');
        assert(['GET', 'HEAD'].includes(request.method()), 'Read-only requests only');
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
        if (scripts[url.pathname]) return route.fulfill({ body: scripts[url.pathname], contentType: 'application/javascript' });
        if (files[url.pathname]) {
          const [file, contentType] = files[url.pathname];
          return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType });
        }
        throw Error('Unexpected offline request ' + url.href);
      });

      await page.goto(origin + '/?mode=candidates', { waitUntil: 'load' });
      const scope = page.locator('#qfScopeBtn');
      const pop = page.locator('#qfPop');
      await scope.waitFor({ state: 'visible' });
      const initialLabel = (await scope.innerText()).trim();
      assert.match(initialLabel, /心血管\+AI/);
      assert.match(initialLabel, /近\s*14\s*天/);
      if (await page.getByRole('button', { name: initialLabel, exact: true }).count() !== 1) {
        widthFailures.push(`${width}px: scope accessible name does not include its visible label before selection`);
      }

      const caret = page.locator('button[data-qf-jtier-menu]').first();
      await caret.waitFor({ state: 'visible' });
      const target = await caret.boundingBox();
      if (!target || target.width < 24 || target.height < 24) {
        widthFailures.push(`${width}px: journal dropdown target is below 24×24 CSS px (got ${target && `${target.width}×${target.height}`})`);
      }

      await scope.focus();
      await page.keyboard.press('Enter');
      await pop.waitFor({ state: 'visible' });
      assert.strictEqual(await scope.getAttribute('aria-expanded'), 'true', `${width}px: Enter opens scope filter`);
      const range90 = pop.locator('[data-qf-range="90"]');
      await range90.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('range') === '90');
      await pop.waitFor({ state: 'visible' });
      const selectedLabel = (await scope.innerText()).trim();
      assert.notStrictEqual(selectedLabel, initialLabel, `${width}px: selected range dynamically changes visible label`);
      assert.match(selectedLabel, /近\s*90\s*天/);
      if (await page.getByRole('button', { name: selectedLabel, exact: true }).count() !== 1) {
        widthFailures.push(`${width}px: scope accessible name does not include its visible label after selection`);
      }
      assert.strictEqual(new URL(page.url()).searchParams.get('range'), '90', `${width}px: keyboard selection updates range`);
      await page.keyboard.press('Escape');
      await pop.waitFor({ state: 'hidden' });

      await caret.focus();
      await page.keyboard.press('Enter');
      await pop.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await pop.waitFor({ state: 'hidden' });

      const shortlist = page.locator('#openHuddleBtn');
      const shortlistCounter = page.locator('#huddleCounter');
      await shortlist.waitFor({ state: 'visible' });
      assert.strictEqual((await page.locator('#openHuddleBtn .huddle-label').innerText()).trim(), '精选清单');
      const expectShortlistNameWithCount = async count => {
        assert.strictEqual((await shortlistCounter.innerText()).trim(), String(count), `${width}px: visible shortlist counter is ${count}`);
        if (await page.getByRole('button', { name: new RegExp(`精选清单\\s*${count}$`) }).count() !== 1) {
          widthFailures.push(`${width}px: shortlist accessible name does not include visible counter ${count}`);
        }
      };
      await expectShortlistNameWithCount(0);
      const addShortlist = page.locator('#articlesStream [data-action="toggle-huddle"]').first();
      const paperId = await addShortlist.getAttribute('data-paper-id');
      assert.ok(paperId, `${width}px: offline candidate is available to add to the shortlist`);
      await addShortlist.click();
      await page.waitForFunction(() => document.querySelector('#huddleCounter')?.textContent.trim() === '1');
      await expectShortlistNameWithCount(1);
      await page.locator(`#articlesStream [data-action="toggle-huddle"][data-paper-id="${paperId}"]`).click();
      await page.waitForFunction(() => document.querySelector('#huddleCounter')?.textContent.trim() === '0');
      await expectShortlistNameWithCount(0);

      await shortlist.focus();
      await page.keyboard.press('Enter');
      const huddleModal = page.locator('#huddleModalBackdrop');
      await huddleModal.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await huddleModal.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.id === 'openHuddleBtn');

      if (errors.length) widthFailures.push(`${width}px: page errors: ${errors.join('; ')}`);
      failures.push(...widthFailures);
      await context.close();
      if (!widthFailures.length) console.log(`${width}px: visible/accessible labels, touch target, and keyboard checks passed`);
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    console.log('Filter accessibility regression checks passed at 390px, 884px, and 1280px');
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
