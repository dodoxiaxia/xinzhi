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
    PDF_LIBRARY_IDS: new Set([held.id]), DOI_FULLTEXT: new Map(), DOI_LOOKUPS: new Map(), DOI_JOBS: new Map(), DOI_JOB_WATCH: { timer:null, doi:'', startedAt:0 }, DOI_TOUCHED: new Set(),
    SUPPLEMENTAL_LIBRARY: { state: 'idle', cursor: '', more: false, promise: null, refreshedAt: 0 },
    esc: value => String(value).replace(/[<>&"']/g, ''), refreshSupplementalView: () => {},
    matchesFilters: () => false, getCurrentDataset: () => [],
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, found: false }) }) });
  vm.runInContext('const STATIC_DOI_PAPERS = [...CURATED, ...FEEDS.items, ...LIBRARY.papers]; const allPapersMap = new Map(STATIC_DOI_PAPERS.map(p => [p.id,p]));', c);
  const names = ['exactDoi', 'hamburgFulltextUrl', 'doiTitleKey', 'sameDoiTitle', 'normalizePaper', 'paperText', 'laneOf', 'isCrossAI', 'supplementalPaper',
    'mergeSupplementalPaper', 'exactDoiPapers', 'fulltextConflict', 'acquireDoiUrl', 'doiJobActive', 'mergeDoiJob', 'watchDoiJob', 'ftMaintainerMode', 'fulltextState', 'safeSourceUrl', 'officialArticleUrl', 'fulltextView', 'fulltextStatusHtml', 'fulltextFilterBucket', 'pdfDownloadUrl', 'pdfDownloadLink', 'doiStatusBlock',
    'libraryJson', 'lookupSupplementalDoi', 'loadSupplementalLibrary', 'getFilteredArticles'];
  vm.runInContext([constant('FT_STEPS'), constant('FT_FILTERS'), constant('KIND_MAP'), constant('MINOR_RE'), constant('CARDIO_TIERS'), constant('AI_RE'), constant('CARDIO_RE'), ...names.map(fn)].join('\n'), c);
  for (const value of ['10.1234/Keep', ' DOI: 10.1234/Keep ', 'https://doi.org/10.1234/Keep', 'https://DX.DOI.ORG/10.1234%2FKeep']) assert.equal(c.exactDoi(value), '10.1234/keep');
  for (const value of ['Kept clinical title', 'article 10.1234/keep', '10.1234', 'https://example.org/10.1234/keep', 'https://doi.org/10.1234/keep?token=x', '10.1234/x script']) assert.equal(c.exactDoi(value), '');
  assert.equal(c.hamburgFulltextUrl('https://doi.org/10.1056/AIe2600236'), 'https://dx-1doi-1org-10039f8q70087.emedien3.sub.uni-hamburg.de/10.1056/aie2600236');
  assert.equal(c.hamburgFulltextUrl('https://attacker.invalid/10.1056/AIe2600236'), '');
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
  { const ready = c.pdfDownloadLink(kept); assert(ready.includes('data-ft-download') && ready.includes('data-ft-dl-form') && ready.includes('下载 PDF'), 'ready cards carry the download link plus its hidden in-place passphrase form'); }
  c.mergeSupplementalPaper(apiPaper('10.1234/hold', 'Correct official title'));
  assert.equal(c.pdfDownloadUrl(held), '', 'A new PDF cannot bind to the wrong static title');
  assert.equal(c.pdfDownloadLink(held), '', 'Ordinary readers never see the bibliography-conflict wording');
  c.MAINTAINER = true; assert(c.pdfDownloadLink(held).includes('题录对应待核实'), 'maintainer mode still shows it'); delete c.MAINTAINER;
  assert(c.sameDoiTitle('What Is Needed to Make Routine.', 'What is needed to make routine'), 'a trailing full stop is not a different title');
  assert(!c.sameDoiTitle('Correct official title', 'Correct official title II'));
  assert.equal(c.exactDoiPapers('10.1234/hold')[0].title, 'Correct official title');
  assert(c.LIBRARY.papers.some(p => p.title === 'Correct official title'), 'Canonical record is visible in normal library');
  assert.equal(JSON.stringify([held, kept, radar]), snapshot, 'No static bibliography, HOLD or doctor fields are written');
  const dynamic = c.LIBRARY.papers.find(p => p.title === 'Correct official title');
  assert.equal(dynamic.hasDraft, undefined); assert.equal(dynamic.doctorReviewed, undefined); assert.equal(dynamic.draftData, undefined);
  c.mergeSupplementalPaper(apiPaper('10.1234/new', 'New clinical title', 'pending'));
  c.mergeSupplementalPaper({ ...apiPaper('10.1234/new', 'New clinical title', 'pending'), doi: 'DOI: 10.1234/NEW' });
  assert.equal(c.LIBRARY.papers.filter(p => p.doi === '10.1234/new').length, 1, 'Aliases and repeated pages deduplicate');
  const pending = c.LIBRARY.papers.find(p => p.doi === '10.1234/new');
  const none = c.pdfDownloadLink(pending);
  assert(!none.includes('未申请') && !none.includes('ft-badge-none')); assert(none.includes('data-ft-action="open-form"') && none.includes('>获取全文<')); assert(none.includes('data-mode="submit"') && none.includes('type="password"'));
  assert(!none.includes('/api/acquire?doi='), 'the request is made in place; the card no longer links to another page'); assert.equal(c.pdfDownloadUrl(pending), '');
  c.mergeSupplementalPaper(apiPaper('10.1234/manual', 'Manual clinical title', 'manual_needed'));
  const manual = c.LIBRARY.papers.find(p => p.doi === '10.1234/manual');
  assert.equal(manual.fulltextStatus, 'manual_needed'); assert(c.pdfDownloadLink(manual).includes('未取得')); assert(c.pdfDownloadLink(manual).includes('>重新获取全文<')); assert(!c.pdfDownloadLink(manual).includes('/api/fulltext'));
  for (const gone of ['查看处理状态', '查看任务', '再次获取全文']) assert(!c.pdfDownloadLink(manual).includes(gone), gone + ' is replaced by one in-place action');
  const job = { id: '00000000-0000-4000-8000-000000000001', doi: pending.doi, state: 'queued' };
  const primaryCount = html => (html.match(/class="btn-sm btn-primary"/g) || []).length - (html.match(/<form[\s\S]*?<\/form>/g) || []).reduce((n, f) => n + (f.match(/class="btn-sm btn-primary"/g) || []).length, 0);
  c.mergeDoiJob(pending.doi, job); assert(c.pdfDownloadLink(pending).includes('排队下载')); assert(c.pdfDownloadLink(pending).includes('查看进度')); assert(!c.pdfDownloadLink(pending).includes('刷新状态')); assert(!c.pdfDownloadLink(pending).includes('查看任务'));
  c.mergeDoiJob(pending.doi, { ...job, state: 'running' }); assert(c.pdfDownloadLink(pending).includes('排队下载'));
  assert.throws(() => c.mergeDoiJob(pending.doi, { ...job, doi: '10.1234/wrong' }));
  c.mergeDoiJob(pending.doi, { ...job, state: 'pending' }); assert(c.pdfDownloadLink(pending).includes('data-mode="legacy-retry"'), 'an old-style finished job re-submits through the legacy retry route');
  c.mergeDoiJob(pending.doi, null);
  assert.equal(c.fulltextFilterBucket(kept), 'ready');
  assert.equal(c.fulltextFilterBucket(pending), 'none');
  assert.equal(c.fulltextFilterBucket(manual), 'failed');
  c.mergeDoiJob(pending.doi, { ...job, state: 'queued', stage: 'queued' });
  assert.equal(c.fulltextFilterBucket(pending), 'queued');
  c.mergeDoiJob(pending.doi, { ...job, state: 'running', stage: 'running' });
  assert.equal(c.fulltextFilterBucket(pending), 'queued', 'an in-progress download stays in the queued-download filter');
  c.mergeDoiJob(pending.doi, { ...job, state: 'pending', stage: 'verifying', verificationMode: 'hourly' });
  assert.equal(c.fulltextFilterBucket(pending), 'verifying');
  c.mergeDoiJob(pending.doi, { ...job, state: 'review', stage: 'review' });
  assert.equal(c.fulltextFilterBucket(pending), 'failed', 'a failed review is listed under 未取得');
  c.mergeDoiJob(pending.doi, null);
  assert.equal(c.fulltextFilterBucket({ doi: '10.1234/plain', title: 'No request yet' }), 'none');
  assert.equal(c.fulltextFilterBucket({ title: 'No DOI' }), 'none', 'a record without a DOI is still counted under 未申请 so the buckets sum to 全部');
  for (const [kind, task] of Object.entries({ none: null, queued: { state: 'queued', stage: 'queued' }, running: { state: 'running', stage: 'running' }, verifying: { state: 'pending', stage: 'verifying' }, failed: { state: 'failed', stage: 'failed' }, review: { state: 'review', stage: 'review' } })) {
    c.mergeDoiJob(pending.doi, task && { ...job, ...task });
    const html = c.fulltextStatusHtml(pending, true);
    if (kind === 'none') assert(!html.includes('ft-badge-none'), 'none omits ft-badge-none'); else assert(html.includes('ft-badge-' + kind), kind + ' badge');
    assert(html.includes('暂无 PDF：') && html.includes('下一步：'), kind + ' reason and next action');
    assert.equal(primaryCount(html), 1, kind + ' has one primary action');
  }
  assert(c.fulltextStatusHtml(kept, true).includes('ft-badge-ready'));
  assert(!c.fulltextStatusHtml(kept, true, true).includes('data-ft-download'), 'drawer uses its static download link');
  const noDoi = c.fulltextStatusHtml({ title: 'No DOI', url: 'https://example.org/paper' }, true, true);
  assert(noDoi.includes('这篇没有 DOI，无法向站内申请全文') && noDoi.includes('下一步：到官网原文查看'));
  assert(noDoi.includes('href="https://example.org/paper"'));
  assert(!c.fulltextStatusHtml({ title: 'No DOI' }, true, true).includes('href='));
  const bmj = { id: 'bmjopen-121799', doi: '10.1136/bmjopen-2026-121799', title: 'BMJ Open sample', url: 'https://pubmed.ncbi.nlm.nih.gov/41012179/' };
  const want = 'https://doi.org/10.1136/bmjopen-2026-121799';
  const prevSearch = c.state.search;
  c.state.search = bmj.doi;
  const doiCardHtml = c.doiStatusBlock(bmj);
  assert(doiCardHtml.includes('href="' + want + '"') && doiCardHtml.includes('>官网原文 ↗</a>'), 'DOI search card official link points to doi.org');
  assert(!doiCardHtml.includes('pubmed.ncbi.nlm.nih.gov'), 'DOI search card official link does not point to PubMed');
  c.state.search = prevSearch;
  const drawerFtHtml = c.fulltextStatusHtml(bmj, true, true);
  assert(drawerFtHtml.includes('href="' + want + '"') && drawerFtHtml.includes('>官网原文 ↗</a>'), 'Reader drawer fulltext status official link points to doi.org');
  assert(!drawerFtHtml.includes('pubmed.ncbi.nlm.nih.gov'), 'Reader drawer fulltext status official link does not point to PubMed');
  c.mergeDoiJob(pending.doi, null);
  const bucketPapers = [kept, pending, manual, { doi: '10.1234/plain', title: 'No request yet' }, { title: 'No DOI' }];
  const bucketCounts = { ready: 0, verifying: 0, queued: 0, failed: 0, none: 0 };
  bucketPapers.forEach(p => bucketCounts[c.fulltextFilterBucket(p)]++);
  assert.equal(Object.values(bucketCounts).reduce((a, b) => a + b, 0), bucketPapers.length, '各项之和 = 全部');
  assert.equal(bucketCounts.ready, 1); assert.equal(bucketCounts.failed, 1); assert.equal(bucketCounts.none, 3);
  c.mergeDoiJob(pending.doi, { ...job, state: 'pending' });
  c.mergeDoiJob(pending.doi,{...job,state:'pending',stage:'verifying',message:'PDF 已收到，等待网站核验。',nextCheckSeconds:60});
  assert(c.doiJobActive(c.DOI_JOBS.get(pending.doi))); assert(c.pdfDownloadLink(pending).includes('核验中')); assert(!c.pdfDownloadLink(pending).includes('第 2/3 步'));
  assert(!c.pdfDownloadLink(pending).includes('/api/acquire/retry')); assert(!c.pdfDownloadLink(pending).includes('查看任务'));
  // The DOI search view renders ONE full block (three steps, one sentence with an estimate, one primary button); the card row stays empty.
  c.state.search = pending.doi;
  assert.equal(c.pdfDownloadLink(pending), '', 'the card does not repeat the status in the DOI view');
  const hourly = c.doiStatusBlock(pending);
  assert.equal((hourly.match(/<li[ >]/g) || []).length, 3); assert(hourly.includes('aria-current="step"')); assert(hourly.includes('已收到 PDF，正在核验')); assert(!/下一批|计划|\d\d:\d\d/.test(hourly), 'no schedule-derived clock time'); assert(hourly.includes('等待下一轮核验'));
  assert.equal(primaryCount(hourly), 1, 'progress has one explicit read-only refresh button'); assert.equal((hourly.match(/role="status"/g) || []).length, 1);
  c.mergeDoiJob(pending.doi,{...job,state:'pending',stage:'verifying',verificationMode:'immediate',verificationExpectedAt:new Date(Date.now() + 180000).toISOString(),sourceKind:'reader_upload',reason:'identity_mismatch'});
  const fast = c.doiStatusBlock(pending); assert(fast.includes('已收到你上传的 PDF，正在核验')); assert(fast.includes('核验通常几分钟内完成')); assert(!fast.includes('等待下一轮核验'));
  assert(!fast.includes('identity_mismatch'), 'the reason code is maintainer information'); c.MAINTAINER = true; assert(c.doiStatusBlock(pending).includes('identity_mismatch')); delete c.MAINTAINER;
  c.state.search = '';
  c.mergeDoiJob(pending.doi,{...job,state:'running',stage:'uploading',message:'<script>unsafe</script>'});
  assert(c.pdfDownloadLink(pending).includes('排队下载')); assert(!c.pdfDownloadLink(pending).includes('<script>')); assert(!c.pdfDownloadLink(pending).includes('Drive'));
  c.mergeDoiJob(pending.doi,{...job,state:'failed',stage:'failed',message:'领取凭据已过期'});
  assert(c.pdfDownloadLink(pending).includes('未取得')); assert(c.pdfDownloadLink(pending).includes('data-mode="muse-retry"'), 'Muse tasks retry through /api/muse/retry'); assert(!c.pdfDownloadLink(pending).includes('领取凭据已过期')); assert(!c.doiJobActive(c.DOI_JOBS.get(pending.doi)));
  c.mergeDoiJob(pending.doi,{...job,state:'review',stage:'review'});
  assert(c.pdfDownloadLink(pending).includes('未取得 · 核验未通过')); assert(c.pdfDownloadLink(pending).includes('/api/muse/reader-upload?doi=10.1234%2Fnew'));
  c.state.search = pending.doi; const review = c.doiStatusBlock(pending); assert(review.includes('核验没有通过') && review.includes('class="stop"')); assert.equal(primaryCount(review), 1); c.state.search = '';
  for (const bad of [{ verificationMode: 'x' }, { reason: 'Bad Reason!' }]) { c.mergeDoiJob(pending.doi, { ...job, state: 'pending', stage: 'verifying', ...bad }); const j = c.DOI_JOBS.get(pending.doi); assert.equal(j.verificationMode, ''); assert.equal(j.reason, ''); }
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
async function searchFill(page, text) {
  if (!(await page.locator('#searchPanel').isVisible())) await page.locator('#searchToggleBtn').click();
  await page.locator('#globalSearch').fill(text);
}

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
  const jobs = new Map(), posts = [];
  let unsupported = false;
  const context = await browser.newContext(), page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()); requests.push({ pathname: u.pathname, method: req.method(), query: u.search });
    if (req.method() === 'POST') {
      // The only writes the page may make are the two in-place submit routes, and only after the reader typed a passphrase.
      assert(['/api/acquire', '/api/muse/retry'].includes(u.pathname) && u.pathname !== '', 'Unexpected POST ' + u.pathname);
      const key = u.searchParams.get('doi'); posts.push({ pathname: u.pathname, doi: key, body: req.postData() });
      const job = { id: '00000000-0000-4000-8000-0000000000aa', doi: key, state: 'queued', stage: 'queued' }; jobs.set(key, job);
      return route.fulfill({ status: 202, json: { ok: true, job } });
    }
    assert(['GET', 'HEAD'].includes(req.method()), 'Typing/searching/loading never sends POST');
    // Opening the drawer also performs its existing public-abstract lookup.
    // Fulfill that request locally; never contact a real abstract provider.
    if (u.origin === 'https://www.ebi.ac.uk' && u.pathname === '/europepmc/webservices/rest/search') return route.fulfill({ json: { hitCount:0,resultList:{result:[]} } });
    assert.equal(u.origin, origin, 'Only fixture requests or the mocked abstract lookup are allowed');
    if (u.pathname === '/api/library') {
      if (unsupported) return route.fulfill({ status: 404, json: { error: 'not_found' } });
      if (u.searchParams.has('doi')) { const key = u.searchParams.get('doi'), p = records.get(key), job = jobs.get(key); return route.fulfill({ json: { ok: true, found: !!p, ...(p ? { paper: p, status: p.fulltextStatus } : {}), ...(job ? { job } : {}) } }); }
      return route.fulfill({ json: { ok: true, papers: [...records.values()], jobs: [...jobs.values()] } });
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
    if (['index.html', 'app.js', 'style.css', 'icon.png'].includes(file)) return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html' });
    return route.fulfill({ status: 404, body: '' });
  });
  try {
    await page.goto(origin + '/?mode=library&lane=aitech&range=7&journal=Other&reading=guide&maintainer=1&q=DOI%3A10.1234%2Farchive');
    await page.locator('#activeFiltersBar .results-meta').waitFor();
    assert((await page.locator('#articlesStream').innerText()).includes('Archived clinical title'));
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), 1, 'Archive result ignores filters');
    const before = new URL(page.url());
    await searchFill(page, 'https://doi.org/10.1234/new');
    await page.locator('a[href="/api/fulltext?doi=10.1234%2Fnew"]').waitFor();
    const after = new URL(page.url()); for (const key of ['mode', 'lane', 'range', 'journal', 'reading']) assert.equal(after.searchParams.get(key), before.searchParams.get(key));
    assert.equal(await page.locator('a[href="/api/fulltext?doi=10.1234%2Fnew"]').getAttribute('target'), '_blank');
    assert((await page.locator('a[href="/api/fulltext?doi=10.1234%2Fnew"]').getAttribute('rel')).includes('noopener'));
    await page.locator('#articlesStream [data-action="open-drawer"]').first().click();
    assert.equal(await page.locator('#drawerFulltext #drawerPdfLink').count(), 1);
    assert.equal(await page.locator('#drawerFulltext [data-ft-download]').count(), 1, 'one drawer download link');
    assert.equal(await page.locator('#drawerFulltext #drawerPdfForm').count(), 1);
    assert.equal(await page.locator('#readerDrawer .drawer-footer .btn-primary').count(), 0);
    assert(await page.locator('#drawerFulltext .ft-badge-ready').isVisible());
    const hanLink = page.locator('#drawerInstitutionLink');
    const hanLogin = page.locator('#drawerInstitutionLoginLink');
    assert.equal(await hanLogin.getAttribute('href'), 'https://login.emedien3.sub.uni-hamburg.de/han/ScienceDirectElsevierJournalBackfiles');
    assert.equal(await hanLogin.getAttribute('target'), '_blank');
    assert.equal(await hanLink.isVisible(), true);
    assert.equal(await hanLink.getAttribute('href'), 'https://dx-1doi-1org-10039f8q70087.emedien3.sub.uni-hamburg.de/10.1234/new');
    assert.equal(await hanLink.getAttribute('target'), '_blank');
    assert((await hanLink.getAttribute('rel')).includes('noreferrer'));
    await page.locator('#drawerCloseBtn').click();
    await searchFill(page, '10.1234/pending'); await page.locator('#articlesStream .ft-status.ft-none').waitFor();
    assert.equal(await page.locator('#articlesStream .ft-status').count(), 1, 'one status block per paper');
    assert.equal(await page.locator('#articlesStream .ft-steps li').count(), 3); assert((await page.locator('#articlesStream .ft-line').innerText()).includes('站内还没有这篇的全文'));
    assert.equal(await page.locator('#articlesStream a[href*="/api/fulltext"]').count(), 0);
    assert.equal(await page.locator('#articlesStream a[href*="/api/acquire"]').count(), 0, 'no link leaves the page to request the full text');
    assert.equal(await page.locator('#articlesStream .ft-actions .btn-primary:visible').count(), 1, 'exactly one primary button');
    assert.equal(posts.length, 0, 'nothing is sent before the reader submits the passphrase');
    await page.getByRole('button', { name: '获取全文', exact: true }).click();
    await page.locator('#articlesStream .ft-form[data-ft-form] input[type="password"]').fill('test-pass'); await page.locator('#articlesStream .ft-form[data-ft-form] button[type="submit"]').click();
    await page.locator('#articlesStream .ft-status.ft-queued').waitFor();
    assert.equal(posts.length, 1); assert.deepEqual(posts[0], { pathname: '/api/acquire', doi: '10.1234/pending', body: 'passphrase=test-pass' });
    assert.equal(new URL(page.url()).searchParams.get('q'), '10.1234/pending', 'submitting happens in place, with no navigation');
    jobs.delete('10.1234/pending');
    records.set('10.1234/pending', apiPaper('10.1234/pending', 'Pending clinical title'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.locator('a[href="/api/fulltext?doi=10.1234%2Fpending"]').waitFor();
    records.set('10.1234/manual', apiPaper('10.1234/manual', 'Manual clinical title', 'manual_needed'));
    await searchFill(page, '10.1234/manual'); await page.locator('#articlesStream .ft-status.ft-failed').waitFor();
    assert.equal(await page.locator('#articlesStream a[href*="/api/fulltext"]').count(), 0);
    for (const gone of ['再次获取全文', '查看处理状态', '查看任务状态']) assert.equal(await page.getByText(gone, { exact: true }).count(), 0, gone);
    await page.getByRole('button', { name: '重新获取全文', exact: true }).waitFor();
    jobs.set('10.1234/mfail', { id: '00000000-0000-4000-8000-000000000002', doi: '10.1234/mfail', state: 'failed', stage: 'failed' });
    await searchFill(page, '10.1234/mfail'); await page.locator('.doi-empty .ft-status.ft-failed').waitFor();
    await page.getByRole('button', { name: '重新获取全文', exact: true }).click();
    await page.locator('#articlesStream .ft-form[data-ft-form] input[type="password"]').fill('test-pass'); await page.locator('#articlesStream .ft-form[data-ft-form] button[type="submit"]').click();
    await page.locator('#articlesStream .ft-status.ft-queued').waitFor();
    assert.deepEqual(posts[1], { pathname: '/api/muse/retry', doi: '10.1234/mfail', body: 'passphrase=test-pass' }, 'a Muse-mode retry goes to /api/muse/retry');
    jobs.delete('10.1234/mfail');
    await searchFill(page, '10.1234/unknown'); await page.locator('.doi-empty').waitFor();
    await page.locator('.doi-empty .ft-status.ft-none').waitFor(); assert.equal(await page.locator('.doi-empty a[href^="/api/acquire"]').count(), 0); await page.getByRole('button', { name: '获取全文', exact: true }).waitFor();
    await searchFill(page, '10.1234/hold'); await page.locator('.doi-identity-notice').waitFor();
    assert((await page.locator('#articlesStream').innerText()).includes('Correct official title'));
    assert.equal(await page.locator('#articlesStream [data-paper-id="1111111111111111"]').count(), 0);
    await page.goto(origin + '/?mode=library&lane=all&q=Correct%20official');
    await page.locator('#articlesStream article[data-paper-id="' + id('10.1234/hold') + '"]').waitFor();
    await searchFill(page, 'Legacy wrong'); await page.locator('.fulltext-review').waitFor();
    assert.equal(await page.locator('#articlesStream a[href*="/api/fulltext"]').count(), 0);
    assert((await page.locator('#articlesStream').innerText()).includes('旧导读保留'));
    // Ordinary readers (maintainer mode switched off) never see the bibliography-conflict wording.
    await page.goto(origin + '/?mode=library&lane=all&maintainer=0&q=10.1234%2Fhold'); await page.locator('#articlesStream article[data-paper-id]').first().waitFor();
    assert.equal(await page.locator('.doi-identity-notice').count(), 0); assert(!(await page.locator('body').innerText()).includes('题录对应待核实'));
    for (const mode of ['sources', 'weekly']) {
      await page.goto(origin + '/?mode=' + mode + '&q=10.1234%2Farchive'); await page.locator('#activeFiltersBar .results-meta').waitFor();
      await page.getByRole('button', {name:'清除 DOI 检索',exact:true}).click();
      const selector = mode === 'sources' ? '#sourcesSection' : '#weeklySection';
      assert.equal(await page.locator(selector).isVisible(), true);
      assert((await page.locator(selector).innerText()).trim().length > 0, mode + ' restores initialized content after clearing DOI');
    }
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(origin + '/?mode=library&q=' + encodeURIComponent('10.1234/' + 'x'.repeat(220))); await page.locator('.doi-search-notice').waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= 322), 'Long DOI does not widen a phone screen');
    jobs.set('10.1234/job', { id:'00000000-0000-4000-8000-000000000001', doi:'10.1234/job', state:'queued' });
    await page.clock.install();
    await page.goto(origin + '/?mode=library&lane=all&maintainer=1&q=10.1234%2Fjob');
    await page.locator('.doi-empty .ft-status.ft-queued').waitFor();
    assert((await page.locator('#articlesStream .ft-line').innerText()).includes('已排入下载队列')); assert.equal(await page.locator('#articlesStream .ft-steps li.current').innerText(), '排队下载');
    jobs.get('10.1234/job').state = 'running';
    await page.clock.runFor(16000);
    await page.locator('#articlesStream .ft-status.ft-running').waitFor(); assert((await page.locator('#articlesStream .ft-line').innerText()).includes('下载端正在获取全文'));
    records.set('10.1234/job', apiPaper('10.1234/job', 'Background cardiovascular fulltext result','pending'));
    jobs.set('10.1234/job',{...jobs.get('10.1234/job'),state:'pending',stage:'verifying',message:'PDF 已收到，等待网站核验。',nextCheckSeconds:60});
    await page.clock.runFor(16000);
    await page.locator('#articlesStream .ft-status.ft-verifying').waitFor();
    assert.equal(await page.locator('#articlesStream .ft-status').count(), 1, 'the card and the task share one block'); assert.equal(await page.locator('#articlesStream .ft-steps li.current').innerText(), '核验中');
    assert.equal(await page.locator('a[href="/api/fulltext?doi=10.1234%2Fjob"]').count(),0,'Unverified PDF has no download entry');
    records.set('10.1234/job', apiPaper('10.1234/job', 'Background cardiovascular fulltext result'));
    jobs.delete('10.1234/job');
    await page.clock.runFor(61000);
    await page.locator('a[href="/api/fulltext?doi=10.1234%2Fjob"]').waitFor();
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(),1);
    assert.equal(await page.locator('#articlesStream .ft-verifying').count(),0,'Completion replaces the pending block with the download button without reload');
    await page.locator('#articlesStream [data-action="open-drawer"]').first().click();
    assert.equal(await hanLink.getAttribute('href'), 'https://dx-1doi-1org-10039f8q70087.emedien3.sub.uni-hamburg.de/10.1234/job', 'The drawer uses the current paper, not the previous DOI');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= 322), 'Institution and download buttons fit the mobile drawer');
    await page.locator('#drawerCloseBtn').click();
    assert.equal(requests.filter(request => request.method === 'POST').length, 2, 'Polling never submits again; only the two typed-passphrase submits were sent');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= 322), 'Background status fits mobile screen');
    records.set('10.1001/proto.ready', apiPaper('10.1001/proto.ready', 'Ready filter title', 'available'));
    records.set('10.1001/proto.queued', apiPaper('10.1001/proto.queued', 'Queued filter title', 'pending'));
    records.set('10.1001/proto.vhour', apiPaper('10.1001/proto.vhour', 'Verifying filter title', 'pending'));
    records.set('10.1001/proto.failed', apiPaper('10.1001/proto.failed', 'Failed filter title', 'manual_needed'));
    records.set('10.1001/proto.none', apiPaper('10.1001/proto.none', 'Unrequested filter title', 'pending'));
    jobs.set('10.1001/proto.queued', { id: '00000000-0000-4000-8000-000000000011', doi: '10.1001/proto.queued', state: 'queued', stage: 'queued' });
    jobs.set('10.1001/proto.vhour', { id: '00000000-0000-4000-8000-000000000012', doi: '10.1001/proto.vhour', state: 'pending', stage: 'verifying', verificationMode: 'hourly' });
    jobs.set('10.1001/proto.failed', { id: '00000000-0000-4000-8000-000000000013', doi: '10.1001/proto.failed', state: 'failed', stage: 'failed' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(origin + '/?mode=library&lane=all&range=all&maintainer=0');
    await page.locator('#ftBar').waitFor();
    const chipText = await page.locator('#ftBar').textContent();
    for (const label of ['全部', '可阅读', '核验中', '排队下载', '未取得', '未申请']) assert(chipText.includes(label), 'filter chip ' + label);
    const countOf = value => page.locator('#ftBar option[value="' + value + '"]').getAttribute('data-count').then(Number);
    assert(await countOf('') >= 4, '全部 counts every paper in the current list');
    assert(await countOf('ready') >= 1);
    assert.equal(await countOf('verifying'), 1);
    assert.equal(await countOf('queued'), 1);
    assert(await countOf('failed') >= 1);
    assert(await countOf('none') >= 1, '未申请 counts papers that never started a task');
    assert.equal(
      (await countOf('ready')) + (await countOf('verifying')) + (await countOf('queued')) + (await countOf('failed')) + (await countOf('none')),
      await countOf(''),
      '各项之和 = 全部'
    );
    const libraryGets = () => requests.filter(request => request.pathname === '/api/library' && request.method === 'GET' && !String(request.query || '').includes('doi=')).length;
    const getsBeforeClick = libraryGets();
    await page.locator('#ftBar select').selectOption('verifying');
    assert.equal(new URL(page.url()).searchParams.get('ft'), 'verifying');
    assert.equal(await page.locator('#articlesStream article[data-paper-id]').count(), 1);
    assert((await page.locator('#articlesStream').innerText()).includes('Verifying filter title'));
    assert.equal(await page.locator('#ftBar select').inputValue(), 'verifying');
    await page.locator('#ftBar select').selectOption('queued');
    assert.equal(new URL(page.url()).searchParams.get('ft'), 'queued');
    assert((await page.locator('#articlesStream').innerText()).includes('Queued filter title'));
    await page.locator('#ftBar select').selectOption('failed');
    assert((await page.locator('#articlesStream').innerText()).includes('Failed filter title'));
    await page.locator('#ftBar select').selectOption('none');
    assert.equal(new URL(page.url()).searchParams.get('ft'), 'none');
    const noneText = await page.locator('#articlesStream').innerText();
    assert(noneText.includes('Unrequested filter title'));
    assert(!noneText.includes('未申请'), '「未申请」灰标不再显示（筛选仍可用）');
    assert(noneText.includes('获取全文'), '申请全文的入口仍是「获取全文」');
    assert(!noneText.includes('Failed filter title'));
    assert.equal(await page.locator('#ftBar select').inputValue(), 'none');
    await page.locator('#ftBar select').selectOption('');
    assert.equal(new URL(page.url()).searchParams.get('ft'), null);
    assert.equal(libraryGets(), getsBeforeClick, 'choosing a fulltext filter does not send another /api/library request');
    await page.goto(origin + '/?mode=library&lane=all&range=all&ft=ready&maintainer=0');
    await page.locator('#ftBar select').waitFor();
    assert.equal(await page.locator('#ftBar select').inputValue(), 'ready');
    assert(await page.locator('#articlesStream article[data-paper-id]').count() >= 1);
    await page.goto(origin + '/?mode=library&lane=all&q=10.1001%2Fproto.ready');
    await page.locator('[data-ft-doi]').waitFor();
    assert.equal(await page.locator('#ftBar').isVisible(), false, 'the filter row hides during an exact DOI search');
    unsupported = true; await page.goto(origin + '/?mode=library&lane=all&q=Static%20official');
    await page.locator('#articlesStream article[data-paper-id="2222222222222222"]').waitFor();
    assert.equal(await page.locator('a[href="/api/pdf?id=2222222222222222"]').count(), 1, 'Old API 404 keeps static downloads');
    assert.deepEqual(errors, []);
    assert(requests.every(request => ['GET', 'HEAD'].includes(request.method) || (request.method === 'POST' && ['/api/acquire', '/api/muse/retry'].includes(request.pathname))));
  } finally { await context.close(); await browser.close(); }
}

(async () => {
  await helpers();
  if (process.argv.includes('--helpers-only')) console.log('DOI library helper checks passed (browser checks run separately)');
  else { await browserChecks(); console.log('DOI library helpers and offline browser checks passed'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
