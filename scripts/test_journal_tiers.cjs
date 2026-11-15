'use strict';
// Offline unit checks for journal-tiers classification, legacy jtier URL compatibility, and quick-filter matching.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const tierSource = fs.readFileSync(path.join(root, 'src/app/journal-tiers.js'), 'utf8');
const rootTierSource = fs.readFileSync(path.join(root, 'journal-tiers.js'), 'utf8');
assert.equal(tierSource, rootTierSource, 'journal-tiers.js stays identical to src/app/journal-tiers.js');

const stateSource = fs.readFileSync(path.join(root, 'src/app/01-state-helpers.js'), 'utf8');
const qfSource = fs.readFileSync(path.join(root, 'src/app/09z-quick-filters.js'), 'utf8');
const weeklySource = fs.readFileSync(path.join(root, 'src/app/09-weekly.js'), 'utf8');

function createHarness() {
  const windowObj = {
    location: { search: '' },
    addEventListener: () => {}
  };
  const documentObj = {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    activeElement: null
  };
  const ctx = vm.createContext({
    URLSearchParams,
    Map,
    Set,
    window: windowObj,
    globalThis: windowObj,
    document: documentObj,
    navigator: {},
    history: { state: null },
    safeGet: () => null,
    safeSet: () => {},
    $: () => null,
    $$: () => [],
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    cardJournalName: p => (p && (p.cleanJournal || p.journal)) || '',
    isInternalSourceName: () => false,
    matchesFilters: () => true,
    matchesQuery: () => true,
    matchesSidebarFilters: () => true,
    isCaseReport: () => false,
    usesLane: () => ctx.state.mode === 'candidates' || ctx.state.mode === 'library',
    defaultRange: m => (m === 'candidates' ? '14' : 'all'),
    getCurrentDataset: () => ctx.__papers || [],
    weeklyPublicationWindow: items => ({ entries: (items || []).filter(p => p.weeklyPick).map(paper => ({ paper })) }),
    LANES: [{ id: 'core', short: '心血管+AI' }],
    FEEDS: { items: [] }
  });
  windowObj.window = windowObj;

  vm.runInContext(tierSource, ctx);

  const readHelpers = stateSource.slice(
    stateSource.indexOf('  const validView'),
    stateSource.indexOf('  const URL_STATE_KEYS')
  );
  const selectedHelper = stateSource.slice(
    stateSource.indexOf('  function selectedJournals('),
    stateSource.indexOf('  function readStateFromUrl(')
  );
  vm.runInContext(selectedHelper + '\n' + readHelpers + '\nthis.readStateFromUrl = readStateFromUrl;', ctx);
  ctx.state = {
    mode: 'library',
    lane: 'core',
    range: 'all',
    search: '',
    clinicalTier: '',
    publisher: '',
    journal: '',
    journals: [],
    journalTier: '',
    journalTierLegacy: false,
    studyDesign: '',
    tag: '',
    minor: false,
    reading: '',
    favoritesOnly: false,
    excludeCaseReports: false,
    ftFilter: '',
    favoriteJournals: []
  };
  ctx.selectedJournals = () => (Array.isArray(ctx.state.journals) && ctx.state.journals.length ? ctx.state.journals : (ctx.state.journal ? [ctx.state.journal] : []));

  const weeklySnippet = weeklySource.slice(
    weeklySource.indexOf('  const WEEKLY_CATEGORIES'),
    weeklySource.indexOf('  function weeklyReadingIds(')
  ) + '\n' + weeklySource.slice(
    weeklySource.indexOf('  function weeklyTitleCountText('),
    weeklySource.indexOf('  function renderWeeklyAuto(')
  );
  vm.runInContext(weeklySnippet, ctx);

  const qfBody = qfSource.slice(0, qfSource.indexOf("  document.addEventListener('click'"));
  vm.runInContext(qfBody, ctx);
  ctx.JT_API = windowObj.XINZHI_JOURNAL_TIERS;
  return ctx;
}

const ctx = createHarness();
const jt = ctx.JT_API;

// 1. Visible tiers & exact separation
assert.deepEqual(
  JSON.parse(JSON.stringify(jt.tiers.map(t => [t.id, t.short, t.title]))),
  [
    ['generalMedicine', '综合', '综合医学'],
    ['cardioClinical', '临床', '心血管临床'],
    ['basicTranslational', '转化', '基础与转化'],
    ['review', '综述', '综述'],
    ['flagship', '顶刊', '顶刊'],
    ['ai', 'AI', 'AI 期刊'],
    ['other', '其他', '其他期刊']
  ]
);

// No canonical name appears in two visible tiers.
const seenVisible = new Map();
for (const tier of jt.tiers) {
  for (const name of jt.namesInTier(tier.id, true)) {
    const key = jt.normalizeJournalName(name);
    assert.equal(seenVisible.has(key), false, `duplicate canonical name across visible tiers: ${name}`);
    seenVisible.set(key, tier.id);
  }
}

assert.equal(jt.tierOfName('Nature Medicine'), 'generalMedicine');
assert.notEqual(jt.tierOfName('Nature Medicine'), 'cardioClinical');
assert.notEqual(jt.tierOfName('Nature Medicine'), 'flagship');

for (const gm of ['New England Journal of Medicine', 'The Lancet', 'JAMA', 'The BMJ']) {
  assert.equal(jt.tierOfName(gm), 'generalMedicine');
}
for (const top of ['Science', 'Nature']) {
  assert.equal(jt.tierOfName(top), 'flagship');
  assert.notEqual(jt.tierOfName(top), 'generalMedicine');
}
for (const clin of ['Circulation', 'JACC', 'JAMA Cardiology', 'European Heart Journal', 'Heart Rhythm', 'Europace']) {
  assert.equal(jt.tierOfName(clin), 'cardioClinical');
}
for (const basic of ['Circulation Research', 'JACC: Basic to Translational Science']) {
  assert.equal(jt.tierOfName(basic), 'basicTranslational');
  assert.notEqual(jt.tierOfName(basic), 'cardioClinical');
}
assert.equal(jt.tierOfName('Nature Reviews Cardiology'), 'review');
for (const aiName of jt.namesInTier('ai', true)) {
  assert.equal(jt.tierOfName(aiName), 'ai');
  assert.notEqual(jt.tierOfName(aiName), 'other');
}

// 2. NatBME & residual 'other' named discoverability
assert.equal(jt.tierOfName('Nature Biomedical Engineering'), 'other');
assert.equal(jt.isSuggestedName('Nature Biomedical Engineering'), false);
assert(jt.namesInTier('other', false).includes('Nature Biomedical Engineering'));
assert(jt.namesInTier('other', true).includes('Nature Biomedical Engineering'));
assert.equal(jt.tierOfName('Nature Cardiovascular Research'), 'other');
assert.equal(jt.isSuggestedName('Nature Cardiovascular Research'), true);
assert(jt.namesInTier('other', true).includes('Nature Cardiovascular Research'));
assert.equal(jt.tierOfName('Some Unlisted Local Journal'), 'other');

// 3. Legacy URL parsing & matching on fixture papers
const papers = [
  { id: 'nm', journal: 'Nature Medicine', lane: 'general' },
  { id: 'nejm', journal: 'New England Journal of Medicine', lane: 'general' },
  { id: 'lancet', journal: 'The Lancet', lane: 'general' },
  { id: 'jama', journal: 'JAMA', lane: 'general' },
  { id: 'bmj', journal: 'The BMJ', lane: 'general' },
  { id: 'sci', journal: 'Science', lane: 'general' },
  { id: 'nat', journal: 'Nature', lane: 'general' },
  { id: 'circ', journal: 'Circulation', lane: 'cardio', weeklyPick: 1, weeklyCategory: 'aimed' },
  { id: 'hr', journal: 'Heart Rhythm', lane: 'cardio' },
  { id: 'cr', journal: 'Circulation Research', lane: 'cardio' },
  { id: 'jbts', journal: 'JACC: Basic to Translational Science', lane: 'cardio' },
  { id: 'nrc', journal: 'Nature Reviews Cardiology', lane: 'cardio' },
  { id: 'ncvr', journal: 'Nature Cardiovascular Research', lane: 'cardio' },
  { id: 'ai', journal: 'npj Digital Medicine', lane: 'cardio', weeklyPick: 2, weeklyCategory: 'cardio' },
  { id: 'natbme', journal: 'Nature Biomedical Engineering', lane: 'aitech' },
  { id: 'other', journal: 'Some Regional Cardiology Journal', lane: 'cardio' }
];
const idsFor = () => papers.filter(p => ctx.paperMatchesJournalFilter(p)).map(p => p.id);

function applyUrl(search) {
  const parsed = ctx.readStateFromUrl(search);
  ctx.state.journalTier = parsed.journalTier;
  ctx.state.journalTierLegacy = parsed.journalTierLegacy;
  ctx.state.journals = parsed.journals;
  ctx.state.journal = parsed.journal;
}

// Legacy ?jtier=flagship hits all 6 historical flagship journals
applyUrl('?mode=library&jtier=flagship');
assert.equal(ctx.state.journalTier, 'flagship');
assert.deepEqual(idsFor(), ['nejm', 'lancet', 'jama', 'bmj', 'sci', 'nat']);

// Legacy ?jtier=cardioMain still includes Nature Medicine & former cardioMain suggested
applyUrl('?mode=library&jtier=cardioMain');
assert.equal(ctx.state.journalTier, 'cardioMain');
assert.deepEqual(idsFor(), ['nm', 'circ', 'cr', 'nrc', 'ncvr']);
assert.equal(ctx.tierDef(ctx.state.journalTier, ctx.useLegacyTierFilter()).title, '心血管主刊');

// Legacy ?jtier=cardioSub still includes JACC: Basic to Translational Science & Heart Rhythm
applyUrl('?mode=library&jtier=cardioSub');
assert.deepEqual(idsFor(), ['hr', 'jbts']);
assert.equal(ctx.tierDef(ctx.state.journalTier, ctx.useLegacyTierFilter()).title, '心血管子刊');

// Legacy & new jtier=ai
applyUrl('?mode=library&jtier=ai');
assert.deepEqual(idsFor(), ['ai']);

// New visible tier IDs in URL
applyUrl('?mode=library&jtier=generalMedicine');
assert.deepEqual(idsFor(), ['nm', 'nejm', 'lancet', 'jama', 'bmj']);

applyUrl('?mode=library&jtier=cardioClinical');
assert.deepEqual(idsFor(), ['circ', 'hr']);

applyUrl('?mode=library&jtier=basicTranslational');
assert.deepEqual(idsFor(), ['cr', 'jbts']);

applyUrl('?mode=library&jtier=review');
assert.deepEqual(idsFor(), ['nrc']);

// Visible flagship click matches only Science & Nature
ctx.selectWholeTier('flagship');
assert.deepEqual(idsFor(), ['sci', 'nat']);

// Weekly mode: AI journal tier does NOT pull Circulation+aimed paper into AI tier
ctx.state.mode = 'weekly';
ctx.FEEDS.items = papers;
ctx.selectWholeTier('ai');
assert.deepEqual(idsFor(), ['ai']);
assert.equal(ctx.weeklyTitleCountText(1, 2), '· AI 期刊 1');

// Weekly quick-filter chip bar keeps caret menu on AI chip and drops theme-merging tooltip
let renderedRowHtml = '';
ctx.state.mode = 'weekly';
ctx.$ = sel => (sel === '#qfChipRow' ? { set innerHTML(v) { renderedRowHtml = v; }, get innerHTML() { return renderedRowHtml; }, scrollLeft: 0, dataset: {}, scrollWidth: 0, clientWidth: 1000, classList: { toggle() {} } } : sel === '#quickBar' ? { hidden: false } : null);
ctx.renderQuickFilters();
assert(renderedRowHtml.includes('data-qf-jtier="ai"'), 'weekly bar renders AI journal chip');
assert(renderedRowHtml.includes('data-qf-jtier-menu="ai"'), 'weekly AI chip keeps journal list caret');
assert(!renderedRowHtml.includes('AI 医疗、AI 前沿，以及发在 AI 期刊的稿子'), 'old theme-merged tooltip removed');

// 4. 'other' tierJournalRows lists named NatBME (even with 0 papers) + other.suggested + fallback journals
ctx.state.mode = 'library';
ctx.__papers = papers.filter(p => p.id !== 'natbme');
const otherRows = ctx.tierJournalRows('other');
const natbmeRow = otherRows.find(r => r.name === 'Nature Biomedical Engineering');
assert(natbmeRow, 'NatBME is listed in other tier menu even with 0 papers');
assert.equal(natbmeRow.n, 0);
assert.equal(natbmeRow.suggested, false);
const ncvrRow = otherRows.find(r => r.name === 'Nature Cardiovascular Research');
assert(ncvrRow && ncvrRow.n === 1 && ncvrRow.suggested === true);
const fallbackRow = otherRows.find(r => r.name === 'Some Regional Cardiology Journal');
assert(fallbackRow && fallbackRow.n === 1 && fallbackRow.suggested === false);

// Selecting 'other' matches NatBME, other.suggested, and unnamed fallback
ctx.__papers = papers;
ctx.selectWholeTier('other');
assert.deepEqual(idsFor(), ['ncvr', 'natbme', 'other']);


// Visible 顶刊/其他 share jtier ids with legacy URLs; jvis=1 must survive a new session (no history.state).
function parseUrl(search) {
  ctx.window.location.search = search;
  ctx.history.state = null;
  return ctx.readStateFromUrl(search);
}
let parsed = parseUrl('?jtier=flagship');
assert.equal(parsed.journalTier, 'flagship');
assert.equal(parsed.journalTierLegacy, true);
ctx.state.journalTier = parsed.journalTier;
ctx.state.journalTierLegacy = parsed.journalTierLegacy;
assert.deepEqual(idsFor(), ['nejm', 'lancet', 'jama', 'bmj', 'sci', 'nat']);

parsed = parseUrl('?jtier=flagship&jvis=1');
assert.equal(parsed.journalTier, 'flagship');
assert.equal(parsed.journalTierLegacy, false);
ctx.state.journalTier = parsed.journalTier;
ctx.state.journalTierLegacy = parsed.journalTierLegacy;
assert.deepEqual(idsFor(), ['sci', 'nat']);

parsed = parseUrl('?jtier=other');
assert.equal(parsed.journalTierLegacy, true);
ctx.state.journalTier = parsed.journalTier;
ctx.state.journalTierLegacy = parsed.journalTierLegacy;
assert.ok(idsFor().includes('natbme'));
assert.equal(idsFor().includes('ncvr'), false, 'legacy other does not treat NCVR as a named other journal the way visible other.suggested does');

parsed = parseUrl('?jtier=other&jvis=1');
assert.equal(parsed.journalTierLegacy, false);
ctx.state.journalTier = parsed.journalTier;
ctx.state.journalTierLegacy = parsed.journalTierLegacy;
assert.ok(idsFor().includes('natbme'));
assert.ok(idsFor().includes('ncvr'), 'visible other + jvis=1 keeps Nature Cardiovascular Research discoverable');


console.log('journal-tiers unit checks passed');
