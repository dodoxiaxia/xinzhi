'use strict';
// Actual helper execution plus an offline browser; no network, credentials or mutations.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert'), crypto = require('crypto');
const root = path.resolve(__dirname, '..'), src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const fn = name => {
  const match = src.match(new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  }'));
  if (!match) throw Error('Missing helper ' + name);
  return match[0];
};
const constant = name => src.match(new RegExp('  const ' + name + ' =[^]*?;'))[0];
const id = doi => 'doi-' + crypto.createHash('sha256').update(doi).digest('hex').slice(0, 16);
const apiPaper = (doi, title, fulltextStatus = 'available') => ({ id: id(doi), doi, title, journal: 'Nature Medicine',
  date: '2026-09-18', datePrecision: 'day', dateBasis: 'Crossref published-online', ingestedAt: '2026-10-07T08:00:00Z',
  metadataStatus: 'external_bibliography_checked', fulltextStatus, hasDraft: true, draftData: { summary: 'Must not import' }, doctorReviewed: true });

async function helpers() {
  const held = { id: '1111111111111111', doi: '10.1234/hold', title: 'Legacy wrong title', metadataStatus: 'hold_bibliography_review',
    basis: '保留原题录', hasDraft: true, draftData: { summary: 'Original guide' }, doctorReviewed: false };
  const kept = { id: 'guide-id', doi: '10.1234/keep', title: 'Kept clinical title', hasDraft: true, draftData: { summary: 'Keep original' } };
  const radar = { id: 'radar-id', doi: '10.1234/radar', title: 'Archived clinical title', archived: true, date: '2025-01-01' };
  const c = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, encodeURIComponent, CURATED: [kept], FEEDS: { items: [radar] }, LIBRARY: { papers: [held] },
    state: { search: '', mode: 'library', lane: 'aitech', range: '7', journal: 'Other', reading: 'guide' }, _maxDateCache: {},
    PDF_LIBRARY_IDS: new Set([held.id]), DOI_FULLTEXT: new Map(), DOI_LOOKUPS: new Map(), DOI_JOBS: new Map(), DOI_JOB_WATCH: { timer:null, doi:'', startedAt:0 },
    SUPPLEMENTAL_LIBRARY: { state: 'idle', cursor: '', more: false, promise: null, refreshedAt: 0 },
    esc: value => String(value).replace(/[<>&"']/g, ''), refreshSupplementalView: () => {},
    matchesFilters: () => false, getCurrentDataset: () => [],
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, found: false }) }) });
  vm.runInContext('const STATIC_DOI_PAPERS = [...CURATED, ...FEEDS.items, ...LIBRARY.papers]; const allPapersMap = new Map(STATIC_DOI_PAPERS.map(p => [p.id,p]));', c);
  const names = ['exactDoi', 'doiTitleKey', 'sameDoiTitle', 'normalizePaper', 'paperText', 'laneOf', 'isCrossAI', 'supplementalPaper',
    'mergeSupplementalPaper', 'exactDoiPapers', 'fulltextConflict', 'acquireDoiUrl', 'doiJobActive', 'mergeDoiJob', 'watchDoiJob', 'pdfDownloadUrl', 'pdfDownloadLink',
    'libraryJson', 'lookupSupplementalDoi', 'loadSupplementalLibrary', 'getFilteredArticles'];
  vm.runInContext([constant('KIND_MAP'), constant('MINOR_RE'), constant('CARDIO_TIERS'), constant('AI_RE'), constant('CARDIO_RE'), ...names.map(fn)].join('\n'), c);
  for (const value of ['10.1234/Keep', ' DOI: 10.1234/Keep ', 'https://doi.org/10.1234/Keep', 'https://DX.DOI.ORG/10.1234%2FKeep']) assert.equal(c.exactDoi(value), '10.1234/keep');
  for (const value of ['Kept clinical title', 'article 10.1234/keep', '10.1234', 'https://example.org/10.1234/keep', 'https://doi.org/10.1234/keep?token=x', '10.1234/x script']) assert.equal(c.exactDoi(value), '');
  c.state.search = 'DOI:10.1234/radar';
  assert.equal(c.getFilteredArticles()[0], radar, 'DOI ignores every active filter and includes archive');
  c.state.search = '10.1234/rada'; assert.equal(c.getFilteredArticles().length, 0, 'Exact DOI is never a substring match');
  assert(c.sameDoiTitle('[Article]  STRAẞE\nclinical title', 'strasse clinical title'));
  assert.equal(c.supplementalPaper({ ...apiPaper('10.1234/invalid', 'Invalid ID title'), id: [id('10.1234/invalid')] }), null, 'IDs must be strings');
  const archivedAlias = { id: 'pmid-hold', doi: held.doi, title: held.title };
  c.FEEDS.items.push(archivedAlias);
  const holdDraft = held.hasDraft; held.hasDraft = false;
  assert.equal(c.exactDoiPapers(held.doi)[0], held, 'An existing library PDF wins over an archive alias');
  held.hasDraft = holdDraft;
  c.FEEDS.items.push({ id: 'pmid-keep', doi: kept.doi, title: kept.title });
  assert.equal(c.exactDoiPapers(kept.doi)[0], kept, 'An existing guide remains the DOI representative');
  const snapshot = JSON.stringify([held, kept, radar]);
  c.mergeSupplementalPaper(apiPaper('10.1234/keep', 'Kept clinical title'));
  assert.equal(c.LIBRARY.papers.find(p => p.doi === kept.doi), kept, 'Radar/curated identity is reused in library');
  assert.equal(c.pdfDownloadUrl(kept), '/api/fulltext?doi=10.1234%2Fkeep');
  c.mergeSupplementalPaper(apiPaper('10.1234/hold', 'Correct official title'));
  assert.equal(c.pdfDownloadUrl(held), '', 'A new PDF cannot bind to the wrong static title');
  assert(c.pdfDownloadLink(held).includes('题录对应待核实'));
  assert.equal(c.exactDoiPapers('10.1234/hold')[0].title, 'Correct official title');
  assert(c.LIBRARY.papers.some(p => p.title === 'Correct official title'), 'Canonical record is visible in normal library');
  assert.equal(JSON.stringify([held, kept, radar]), snapshot, 'No static bibliography, HOLD or doctor fields are written');
  const dynamic = c.LIBRARY.papers.find(p => p.title === 'Correct official title');
  assert.equal(dynamic.hasDraft, undefined); assert.equal(dynamic.doctorReviewed, undefined); assert.equal(dynamic.draftData, undefined);
  c.mergeSupplementalPaper(apiPaper('10.1234/new', 'New clinical title', 'pending'));
  c.mergeSupplementalPaper({ ...apiPaper('10.1234/new', 'New clinical title', 'pending'), doi: 'DOI: 10.1234/NEW' });
  assert.equal(c.LIBRARY.papers.filter(p => p.doi === '10.1234/new').length, 1, 'Aliases and repeated pages deduplicate');
  const pending = c.LIBRARY.papers.find(p => p.doi === '10.1234/new');
  assert(c.pdfDownloadLink(pending).includes('待补全文')); assert(c.pdfDownloadLink(pending).includes('/api/acquire?doi=')); assert.equal(c.pdfDownloadUrl(pending), '');
  const job = { id: '00000000-0000-4000-8000-000000000001', doi: pending.doi, state: 'queued' };
  c.mergeDoiJob(pending.doi, job); assert(c.pdfDownloadLink(pending).includes('全文排队中')); assert(c.pdfDownloadLink(pending).includes('查看任务'));
  c.mergeDoiJob(pending.doi, { ...job, state: 'running' }); assert(c.pdfDownloadLink(pending).includes('全文获取中'));
  assert.throws(() => c.mergeDoiJob(pending.doi, { ...job, doi: '10.1234/wrong' }));
  c.mergeDoiJob(pending.doi, { ...job, state: 'pending' }); assert(c.pdfDownloadLink(pending).includes('/api/acquire/retry?doi='));
  c.mergeDoiJob(pending.doi); assert.equal(c.DOI_JOBS.size, 0);
  const collision = { id: id('10.1234/collision'), doi: '10.1234/collision', title: 'Held collision title', metadataStatus: 'hold_bibliography_review' };
  c.LIBRARY.papers.push(collision); c.collision = collision;
  vm.runInContext('STATIC_DOI_PAPERS.push(collision); allPapersMap.set(collision.id,collision);', c);
  c.mergeSupplementalPaper(apiPaper('10.1234/collision', 'Canonical collision title'));
  assert(vm.runInContext('allPapersMap.get(collision.id) === collision', c), 'A static ID never changes identity');
  const blocked = { id: id('10.1234/blocked'), doi: '10.1234/blocked', title: 'Held blocked title' };
  const reserved = { id: 'supplemental-' + blocked.id, doi: '10.1234/reserved', title: 'Reserved static title' };
  c.blocked = blocked; c.reserved = reserved;
  vm.runInContext('STATIC_DOI_PAPERS.push(blocked,reserved); allPapersMap.set(blocked.id,blocked); allPapersMap.set(reserved.id,reserved);', c);
  assert.equal(c.mergeSupplementalPaper(apiPaper(blocked.doi, 'Canonical blocked title')), false, 'A reserved alternate ID cannot overwrite static identity');
  assert(vm.runInContext('allPapersMap.get(reserved.id) === reserved', c));
  await c.lookupSupplementalDoi('10.1234/keep', true);
  assert.equal(c.pdfDownloadUrl(kept), '', 'found:false removes old available access');
  const calls = [];
  c.fetch = async (url, options) => { calls.push({ url, method: options.method }); return { ok: true, json: async () => url.includes('cursor=') ? { ok: true, papers: [apiPaper('10.1234/paged', 'Paged title') ] } : { ok: true, papers: [apiPaper('10.1234/paged', 'Paged title')], cursor: 'next-page' } }; };
  await c.loadSupplementalLibrary(true);
  assert.equal(calls.length, 2); assert(calls.every(call => call.method === 'GET'));
  assert.equal(c.LIBRARY.papers.filter(p => p.doi === '10.1234/paged').length, 1);
  c.fetch = async () => { throw Error('Offline failure'); }; await c.loadSupplementalLibrary(true);
  assert.equal(c.SUPPLEMENTAL_LIBRARY.state, 'error'); assert(c.LIBRARY.papers.includes(held));
  c.fetch = async () => ({ ok: false, status: 404 }); await c.loadSupplementalLibrary(true);
  assert.equal(c.SUPPLEMENTAL_LIBRARY.state, 'unsupported'); assert(c.LIBRARY.papers.includes(held));
}

async function browserChecks() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const origin = 'https://doi-ui.invalid', date = new Date().toISOString().slice(0, 10), requests = [], errors = [];
  const hold = { id: '1111111111111111', doi: '10.1234/hold', title: 'Legacy wrong title', date, journal: 'Nature Medicine',
    clinicalTier: 'AI医疗与数字医学', metadataStatus: 'hold_bibliography_review', basis: '保留原题录', hasDraft: true, draftData: { summary: 'Old guide retained', title_zh: '旧导读保留' } };
  const staticPaper = { id: '2222222222222222', doi: '10.1234/static', title: 'Static official title', date, datePrecision: 'day', journal: 'Circulation', clinicalTier: '心血管综合与其他', tags: [] };
  const records = new Map([
    ['10.1234/hold', apiPaper('10.1234/hold', 'Correct official title')],
    ['10.1234/new', apiPaper('10.1234/new', 'New clinical title')],
    ['10.1234/pending', apiPaper('10.1234/pending', 'Pending clinical title', 'pending')]
  ]);
  const jobs = new Map();
  let unsupported = false;
  const context = await browser.newContext(), page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()); requests.push({ pathname: u.pathname, method: req.method(), query: u.search });
    assert.equal(u.origin, origin, 'All traffic is intercepted at the fixture origin');
    assert(['GET', 'HEAD'].includes(req.method()), 'Typing/searching/loading never sends POST');
    if (u.pathname === '/api/library') {
      if (unsupported) return route.fulfill({ status: 404, json: { error: 'not_found' } });
      if (u.searchParams.has('doi')) { const key = u.searchParams.get('doi'), p = records.get(key), job = jobs.get(key); return route.fulfill({ json: { ok: true, found: !!p, ...(p ? { paper: p, status: p.fulltextStatus } : {}), ...(job ? { job } : {}) } }); }
      return route.fulfill({ json: { ok: true, papers: [...records.values()] } });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, found: false, canGenerate: false } });
    const assets = {
      '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: [hold, staticPaper] }),
      '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ items: [] }) + ';window.RADAR=' + JSON.stringify({ rows: [['989', '10.1234/archive', '2026-01-01', 0, 0, 0, 0, [], 'Archived clinical title']], jn: ['Circulation'], pub: ['AHA'], tier: ['心血管综合与其他'], design: ['RCT'], tag: [] }),
      '/data/curated.js': 'window.CURATED=[]', '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
      '/data/source-health.js': 'window.SOURCE_HEALTH=' + JSON.stringify({ sources: [{ id: 'fixture', name: 'Offline source', status: 'ok', items: 1 }] })
    };
    if (assets[u.pathname]) return route.fulfill({ body: assets[u.pathname], contentType: 'application/javascript' });
    const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (['index.html', 'app.js', 'style.css', 'icon.svg'].includes(file)) return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
    return route.fulfill({ status: 404, body: '' });
  });
  try {
    await page.goto(origin + '/?mode=library&lane=aitech&range=7&journal=Other&reading=guide&q=DOI%3A10.1234%2Farchive');
    await page.locator('.doi-search-notice').waitFor();
    assert((await page.locator('#articlesStream').innerText()).includes('Archived clinical title'));
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), 1, 'Archive result ignores filters');
    const before = new URL(page.url());
    await page.locator('#globalSearch').fill('https://doi.org/10.1234/new');
    await page.locator('a[href="/api/fulltext?doi=10.1234%2Fnew"]').waitFor();
    const after = new URL(page.url()); for (const key of ['mode', 'lane', 'range', 'journal', 'reading']) assert.equal(after.searchParams.get(key), before.searchParams.get(key));
    assert.equal(await page.locator('a[href="/api/fulltext?doi=10.1234%2Fnew"]').getAttribute('target'), '_blank');
    assert((await page.locator('a[href="/api/fulltext?doi=10.1234%2Fnew"]').getAttribute('rel')).includes('noopener'));
    await page.locator('#globalSearch').fill('10.1234/pending'); await page.getByText('待补全文', { exact: true }).waitFor();
    assert.equal(await page.locator('a[href="/api/fulltext?doi=10.1234%2Fpending"]').count(), 0);
    records.set('10.1234/pending', apiPaper('10.1234/pending', 'Pending clinical title'));
    await page.locator('[data-action="refresh-doi-status"]').click(); await page.locator('a[href="/api/fulltext?doi=10.1234%2Fpending"]').waitFor();
    await page.locator('#globalSearch').fill('10.1234/unknown'); await page.locator('.doi-empty').waitFor();
    assert.equal(await page.locator('.doi-empty a').getAttribute('href'), '/api/acquire?doi=10.1234%2Funknown');
    await page.locator('#globalSearch').fill('10.1234/hold'); await page.locator('.doi-identity-notice').waitFor();
    assert((await page.locator('#articlesStream').innerText()).includes('Correct official title'));
    assert.equal(await page.locator('#articlesStream [data-paper-id="1111111111111111"]').count(), 0);
    await page.goto(origin + '/?mode=library&lane=all&q=Correct%20official');
    await page.locator('#articlesStream article[data-paper-id="' + id('10.1234/hold') + '"]').waitFor();
    await page.locator('#globalSearch').fill('Legacy wrong'); await page.locator('.fulltext-review').waitFor();
    assert.equal(await page.locator('#articlesStream a[href*="/api/fulltext"]').count(), 0);
    assert((await page.locator('#articlesStream').innerText()).includes('旧导读保留'));
    for (const mode of ['sources', 'weekly']) {
      await page.goto(origin + '/?mode=' + mode + '&q=10.1234%2Farchive'); await page.locator('.doi-search-notice').waitFor();
      await page.locator('[data-clear="search"]').click();
      const selector = mode === 'sources' ? '#sourcesSection' : '#weeklySection';
      assert.equal(await page.locator(selector).isVisible(), true);
      assert((await page.locator(selector).innerText()).trim().length > 0, mode + ' restores initialized content after clearing DOI');
    }
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(origin + '/?mode=library&q=' + encodeURIComponent('10.1234/' + 'x'.repeat(220))); await page.locator('.doi-search-notice').waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= 322), 'Long DOI does not widen a phone screen');
    jobs.set('10.1234/job', { id:'00000000-0000-4000-8000-000000000001', doi:'10.1234/job', state:'queued' });
    await page.clock.install();
    await page.goto(origin + '/?mode=library&lane=all&q=10.1234%2Fjob');
    await page.getByText('后台任务已提交', { exact:true }).waitFor();
    assert((await page.locator('.doi-job-notice').innerText()).includes('已排队'));
    assert.equal(await page.getByRole('link', { name:'查看任务状态', exact:true }).count(), 1);
    jobs.get('10.1234/job').state = 'running';
    await page.clock.runFor(16000);
    await page.getByText('后台正在获取全文，完成后会显示下载入口。', { exact:false }).waitFor();
    records.set('10.1234/job', apiPaper('10.1234/job', 'Background cardiovascular fulltext result'));
    jobs.delete('10.1234/job');
    await page.clock.runFor(16000);
    await page.locator('a[href="/api/fulltext?doi=10.1234%2Fjob"]').waitFor();
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(),1);
    assert.equal(await page.locator('.doi-job-notice').count(),0,'Completion stops pending status and adds verified record without reload');
    assert(requests.every(request => ['GET','HEAD'].includes(request.method)), 'Polling never submits or acquires again');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= 322), 'Background status fits mobile screen');
    unsupported = true; await page.goto(origin + '/?mode=library&lane=all&q=Static%20official');
    await page.locator('#articlesStream article[data-paper-id="2222222222222222"]').waitFor();
    assert.equal(await page.locator('a[href="/api/pdf?id=2222222222222222"]').count(), 1, 'Old API 404 keeps static downloads');
    assert.deepEqual(errors, []);
    assert(requests.every(request => ['GET', 'HEAD'].includes(request.method)));
  } finally { await context.close(); await browser.close(); }
}

(async () => {
  await helpers();
  if (process.argv.includes('--helpers-only')) console.log('DOI library helper checks passed (browser checks run separately)');
  else { await browserChecks(); console.log('DOI library helpers and offline browser checks passed'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
