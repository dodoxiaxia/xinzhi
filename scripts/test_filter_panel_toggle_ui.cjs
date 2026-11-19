'use strict';
// Offline browser test for toggling publisher, journal and article-topic filters.
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
    journal: 'New England Journal of Medicine', cleanJournal: 'New England Journal of Medicine', publisher: 'MMS (NEJM)',
    clinicalTier: '顶级综合与科学', studyDesign: 'RCT', tags: ['#房颤'], lane: 'general',
    summary: 'NEJM AF abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/104/', autoPick: { d: today, r: 4 }
  },
  {
    id: 'p-jama-hf', pmid: '105', title: 'JAMA HF trial', date: today, datePrecision: 'day',
    journal: 'JAMA', cleanJournal: 'JAMA', publisher: 'JAMA Network',
    clinicalTier: '顶级综合与科学', studyDesign: 'RCT', tags: ['#心衰'], lane: 'general',
    summary: 'JAMA HF abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/105/', autoPick: { d: today, r: 5 }
  },
  {
    id: 'p-jacc-hf', pmid: '106', title: 'JACC HF cohort', date: today, datePrecision: 'day',
    journal: 'JACC', cleanJournal: 'JACC', publisher: 'ACC (JACC)',
    clinicalTier: '心血管旗舰顶刊', studyDesign: '队列研究', tags: ['#心衰'], lane: 'cardio',
    summary: 'JACC HF abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/106/', autoPick: { d: today, r: 6 }
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

    const pop = page.locator('#qfPop');
    const close = () => pop.locator('[data-qf-close]').click();
    const open = kind => page.locator(`#qfChipRow [data-qf="${kind}"]`).click();
    const picker = tier => page.locator(`[data-qf-jtier-menu="${tier}"]`).click();
    const params = () => new URL(page.url()).searchParams;
    const ids = () => page.locator('#articlesStream .compact-row[data-paper-id]').evaluateAll(
      cards => cards.map(card => card.dataset.paperId).sort());
    const aha = pop.locator('[data-qf-pub="AHA (Circulation)"]');
    const af = pop.locator('[data-qf-topic="#房颤"]');
    const circ = pop.locator('[data-qf-pick-journal="Circulation"]');
    const nejm = pop.locator('[data-qf-pick-journal="New England Journal of Medicine"]');
    const initial = papers.map(p => p.id).sort();

    await page.goto(origin + '/?mode=candidates&lane=all&view=compact', { waitUntil: 'load' });
    eq(await ids(), initial, 'Initial list');
    await open('more');
    await aha.click();
    eq(await aha.getAttribute('aria-pressed'), 'true', 'Publisher is pressed');
    eq(params().get('pub'), 'AHA (Circulation)', 'URL syncs publisher');
    eq(await ids(), ['p-circ-af', 'p-circ-hf', 'p-stroke-af'], 'Publisher filters its entire family');
    await aha.click();
    eq(await aha.getAttribute('aria-pressed'), 'false', 'Re-click clears publisher');
    eq(params().has('pub'), false, 'Publisher is cleared from URL');
    eq(await ids(), initial, 'Publisher toggle restores list');
    await close();

    await open('topic');
    await af.click();
    eq(params().get('tag'), '#房颤', 'Topic is written to the URL');
    await close();

    await picker('cardioClinical');
    await circ.click();
    eq(params().get('journal'), 'Circulation', 'Journal is written to the URL');
    eq(params().has('pub'), false, 'Journal has no implicit publisher');
    eq(await ids(), ['p-circ-af'], 'Journal and topic intersect');
    await close();

    await picker('generalMedicine');
    await nejm.click();
    eq(await ids(), ['p-nejm-af'], 'Selecting a journal from another tier replaces the previous tier');
    await nejm.click();
    eq(await nejm.getAttribute('aria-pressed'), 'false', 'Re-click clears the journal');
    eq(params().has('journal'), false, 'Journal is cleared from URL');
    eq(params().get('tag'), '#房颤', 'Topic persists when clearing journal');
    eq(await ids(), ['p-circ-af', 'p-nejm-af', 'p-stroke-af'], 'Only the topic remains');
    await close();

    await picker('cardioClinical');
    await circ.click();
    await close();
    await open('topic');
    await af.click();
    eq(params().has('tag'), false, 'Re-click clears the topic');
    eq(params().get('journal'), 'Circulation', 'Journal persists when clearing topic');
    eq(await ids(), ['p-circ-af', 'p-circ-hf'], 'Only the journal remains');
    await close();

    await open('more');
    await aha.click();
    eq(params().has('journal'), false, 'Selecting a publisher clears the journal');
    eq(params().has('jtier'), false, 'Selecting a publisher clears its previous journal tier');
    eq(await ids(), ['p-circ-af', 'p-circ-hf', 'p-stroke-af'], 'Publisher restores the whole family');
    await aha.click();
    eq(await ids(), initial, 'Re-click restores the full list');
    await close();
    await open('topic');
    await af.click();
    await close();
    await open('more');
    await aha.click();
    eq(params().get('tag'), '#房颤', 'Selecting a publisher preserves an independent topic filter');
    eq(await ids(), ['p-circ-af', 'p-stroke-af'], 'Publisher still intersects with the topic');

    await page.goto(origin + '/?mode=curated&view=compact', { waitUntil: 'load' });
    await open('topic');
    await af.click();
    eq(await ids(), ['p-circ-af', 'p-nejm-af', 'p-stroke-af'], 'Topic filters curated items');
    await af.click();
    eq(await ids(), initial, 'Topic toggle restores curated list');

    eq(errors, [], 'No page errors');
    eq(requests.every(r => ['GET', 'HEAD'].includes(r.method)), true, 'All offline requests read-only');
    console.log(JSON.stringify({ passed: true, checks, errors }, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
