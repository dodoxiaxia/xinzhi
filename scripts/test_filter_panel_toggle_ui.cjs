'use strict';
// Offline browser test for toggling off selected publisher, journal, and tag filters in #appSidebar.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://filter-toggle.invalid';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());

const papers = [
  {
    id: 'p-circ-af', pmid: '101', title: 'Circulation AF trial', date: today, datePrecision: 'day',
    journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA (Circulation)',
    clinicalTier: '心血管旗舰顶刊', studyDesign: 'RCT', tags: ['#房颤'], lane: 'cardio',
    summary: 'AF abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/101/', autoPick: { d: today, r: 1 }
  },
  {
    id: 'p-circ-hf', pmid: '102', title: 'Circulation HF cohort', date: today, datePrecision: 'day',
    journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA (Circulation)',
    clinicalTier: '心血管旗舰顶刊', studyDesign: '队列研究', tags: ['#心衰'], lane: 'cardio',
    summary: 'HF abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/102/', autoPick: { d: today, r: 2 }
  },
  {
    id: 'p-stroke-af', pmid: '103', title: 'Stroke AF study', date: today, datePrecision: 'day',
    journal: 'Stroke', cleanJournal: 'Stroke', publisher: 'AHA (Circulation)',
    clinicalTier: '脑血管与高血压', studyDesign: '队列研究', tags: ['#房颤'], lane: 'cardio',
    summary: 'Stroke AF abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/103/', autoPick: { d: today, r: 3 }
  },
  {
    id: 'p-nejm-af', pmid: '104', title: 'NEJM AF trial', date: today, datePrecision: 'day',
    journal: 'NEJM', cleanJournal: 'NEJM', publisher: 'MMS (NEJM)',
    clinicalTier: '顶级综合与科学', studyDesign: 'RCT', tags: ['#房颤'], lane: 'general',
    summary: 'NEJM AF abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/104/', autoPick: { d: today, r: 4 }
  },
  {
    id: 'p-jama-hf', pmid: '105', title: 'JAMA HF trial', date: today, datePrecision: 'day',
    journal: 'JAMA', cleanJournal: 'JAMA', publisher: 'JAMA Network',
    clinicalTier: '顶级综合与科学', studyDesign: 'RCT', tags: ['#心衰'], lane: 'general',
    summary: 'JAMA HF abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/105/', autoPick: { d: today, r: 5 }
  }
];

const scripts = {
  '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers }),
  '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: today, items: papers }),
  '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[]}',
  '/data/curated.js': 'window.CURATED=' + JSON.stringify(papers),
  '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}'
};

let checks = 0;
const eq = (actual, expected, label) => { assert.deepStrictEqual(actual, expected, label); checks++; };

async function run() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox']
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url());
      requests.push({ url: u.href, method: req.method() });
      assert.strictEqual(u.origin, origin, 'No external requests');
      if (u.pathname.startsWith('/api/')) {
        assert.strictEqual(req.method(), 'GET', 'No POST requests');
        return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
      }
      if (u.pathname === '/style.css') return route.fulfill({ body: fs.readFileSync(path.join(root, 'style.css')), contentType: 'text/css' });
      if (u.pathname === '/citation-export.js') return route.fulfill({ body: fs.readFileSync(path.join(root, 'citation-export.js')), contentType: 'application/javascript' });
      if (u.pathname === '/journal-tiers.js') return route.fulfill({ body: fs.readFileSync(path.join(root, 'journal-tiers.js')), contentType: 'application/javascript' });
      if (u.pathname === '/app.js') return route.fulfill({ body: fs.readFileSync(path.join(root, 'app.js')), contentType: 'application/javascript' });
      if (scripts[u.pathname]) return route.fulfill({ body: scripts[u.pathname], contentType: 'application/javascript' });
      if (u.pathname === '/icon.png') return route.fulfill({ body: fs.readFileSync(path.join(root, 'icon.png')), contentType: 'image/png' });
      if (u.pathname === '/' || u.pathname === '/index.html') return route.fulfill({ body: fs.readFileSync(path.join(root, 'index.html')), contentType: 'text/html' });
      throw Error('Unexpected offline request ' + u.href);
    });

    const stateSnapshot = () => page.evaluate(() => ({
      total: document.getElementById('listTotal')?.textContent.trim(),
      apply: document.getElementById('panelApplyBtn')?.textContent.trim(),
      ids: [...document.querySelectorAll('#articlesStream .compact-row[data-paper-id]')].map(el => el.dataset.paperId),
      params: Object.fromEntries(new URLSearchParams(location.search).entries())
    }));

    await page.goto(origin + '/?mode=candidates&lane=all&range=all&view=compact', { waitUntil: 'networkidle' });
    await page.click('#filterToggleBtn');
    await page.waitForSelector('#appSidebar.open');
    await page.evaluate(() => { document.querySelector('.panel-more').open = true; });

    let snap = await stateSnapshot();
    eq(snap.total, '共 5 篇', 'Initial list total');
    eq(snap.apply, '查看 5 篇', 'Initial panel apply count');

    // 1. Toggle publisher on and off
    const ahaPub = page.locator('#publisherAccordion [data-filter-publisher="AHA (Circulation)"]');
    await ahaPub.click();
    eq(await ahaPub.getAttribute('aria-pressed'), 'true', 'Publisher selected');
    snap = await stateSnapshot();
    eq(snap.params.pub, 'AHA (Circulation)', 'URL syncs pub');
    eq(snap.total, '共 3 篇', 'Publisher filters list');
    eq(snap.apply, '查看 3 篇', 'Publisher updates apply button count');

    await ahaPub.click();
    eq(await ahaPub.getAttribute('aria-pressed'), 'false', 'Re-clicking publisher cancels it');
    snap = await stateSnapshot();
    eq(snap.params.pub, undefined, 'URL removes pub after cancel');
    eq(snap.total, '共 5 篇', 'List total restores after publisher cancel');
    eq(snap.apply, '查看 5 篇', 'Panel apply count restores after publisher cancel');

    const expandPublisher = async pub => {
      const btn = page.locator(`#publisherAccordion [data-pub-expand="${pub}"]`);
      if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
    };

    // 2. Select tag + journal (and switch journal), then cancel journal while tag remains
    const tagAf = page.locator('#tagsCloud [data-filter-tag="#房颤"]');
    await tagAf.click();
    eq(await tagAf.getAttribute('aria-pressed'), 'true', 'Tag #房颤 selected');

    await expandPublisher('AHA (Circulation)');
    const circBtn = page.locator('#publisherAccordion [data-filter-journal="Circulation"]');
    await circBtn.click();
    snap = await stateSnapshot();
    eq(snap.params.journal, 'Circulation', 'First journal selected');
    eq(snap.params.tag, '#房颤', 'Tag retained when selecting journal');
    eq(snap.ids, ['p-circ-af'], 'List intersects Circulation and #房颤');

    // Select second journal (single-select replaces previous journal), then re-click to cancel it
    await expandPublisher('MMS (NEJM)');
    const nejmBtn = page.locator('#publisherAccordion [data-filter-journal="NEJM"]');
    await nejmBtn.click();
    eq(await nejmBtn.getAttribute('aria-pressed'), 'true', 'Second journal NEJM selected');
    snap = await stateSnapshot();
    eq(snap.params.journal, 'NEJM', 'NEJM replaces Circulation');
    eq(snap.params.tag, '#房颤', 'Tag #房颤 still retained');
    eq(snap.ids, ['p-nejm-af'], 'List intersects NEJM and #房颤');

    await nejmBtn.click();
    eq(await nejmBtn.getAttribute('aria-pressed'), 'false', 'Re-clicking NEJM cancels journal');
    eq(await tagAf.getAttribute('aria-pressed'), 'true', 'Tag #房颤 remains pressed after cancelling journal');
    snap = await stateSnapshot();
    eq(snap.params.journal, undefined, 'URL removes journal');
    eq(snap.params.pub, undefined, 'URL removes hidden parent pub');
    eq(snap.params.tag, '#房颤', 'URL preserves tag');
    eq(snap.ids, ['p-circ-af', 'p-stroke-af', 'p-nejm-af'], 'List matches remaining #房颤 filter');
    eq(snap.apply, '查看 3 篇', 'Apply button count reflects remaining #房颤 filter');

    // 3. Re-select journal, then cancel tag while journal remains
    await circBtn.click();
    snap = await stateSnapshot();
    eq(snap.ids, ['p-circ-af'], 'Circulation + #房颤 intersection');

    await tagAf.click();
    eq(await tagAf.getAttribute('aria-pressed'), 'false', 'Re-clicking tag cancels tag');
    eq(await circBtn.getAttribute('aria-pressed'), 'true', 'Journal Circulation remains pressed');
    snap = await stateSnapshot();
    eq(snap.params.tag, undefined, 'URL removes tag');
    eq(snap.params.journal, 'Circulation', 'URL preserves Circulation');
    eq(snap.ids, ['p-circ-af', 'p-circ-hf'], 'List matches remaining Circulation filter');
    eq(snap.apply, '查看 2 篇', 'Apply button count reflects Circulation filter');

    // 4. Clicking parent publisher while child journal is active switches to publisher, clicking again clears it
    await ahaPub.click();
    eq(await ahaPub.getAttribute('aria-pressed'), 'true', 'Publisher active after switching from child journal');
    snap = await stateSnapshot();
    eq(snap.params.journal, undefined, 'Child journal cleared');
    eq(snap.params.pub, 'AHA (Circulation)', 'Parent publisher active');
    eq(snap.total, '共 3 篇', 'Publisher count shown');

    await ahaPub.click();
    eq(await ahaPub.getAttribute('aria-pressed'), 'false', 'Re-clicking publisher clears it');
    snap = await stateSnapshot();
    eq(snap.params.pub, undefined, 'Publisher cleared from URL');
    eq(snap.total, '共 5 篇', 'All papers restored');

    // 5. Curated mode laneBar topic chip also toggles off
    await page.goto(origin + '/?mode=curated&view=compact', { waitUntil: 'networkidle' });
    const curatedTag = page.locator('#laneBar [data-filter-tag="#房颤"]');
    await curatedTag.click();
    snap = await stateSnapshot();
    eq(snap.params.tag, '#房颤', 'Curated topic chip sets tag');
    eq(snap.total, '共 3 篇', 'Curated topic chip filters list');
    await curatedTag.click();
    snap = await stateSnapshot();
    eq(snap.params.tag, undefined, 'Re-clicking curated topic chip clears tag');
    eq(snap.total, '共 5 篇', 'Curated topic chip restores full list');

    eq(errors, [], 'No page errors');
    eq(requests.every(r => ['GET', 'HEAD'].includes(r.method)), true, 'All offline requests read-only');
    console.log(JSON.stringify({ passed: true, checks, errors }, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
