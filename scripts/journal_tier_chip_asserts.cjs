'use strict';
// Assert journal-tier data is present and renderQuickFilters emits the five chips.
// Required by test_weekly_window.cjs so daily.yml pre-release also runs it.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const tiersSrcPath = fs.existsSync(path.join(root, 'journal-tiers.js'))
  ? path.join(root, 'journal-tiers.js')
  : path.join(root, 'src/app/journal-tiers.js');
const tiersSrc = fs.readFileSync(tiersSrcPath, 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const start = appSrc.indexOf('  function qfPapers() {');
const end = appSrc.indexOf('  function qfMoreActive()', start);
assert(start >= 0 && end > start, 'renderQuickFilters helpers not found in app.js');
// Include through renderQfSummary (after qfMoreActive)
const summaryEnd = appSrc.indexOf('\n  function closeQfPop()', end);
assert(summaryEnd > end, 'renderQfSummary block not found');
const slice = appSrc.slice(start, summaryEnd);

const papers = [
  { id: 'flag', journal: 'The Lancet', cleanJournal: 'The Lancet' },
  { id: 'main', journal: 'Circulation', cleanJournal: 'Circulation' },
  { id: 'sub', journal: 'Heart Rhythm', cleanJournal: 'Heart Rhythm' },
  { id: 'ai', journal: 'NEJM AI', cleanJournal: 'NEJM AI' },
  { id: 'oth', journal: 'Some Regional Cardiology Journal', cleanJournal: 'Some Regional Cardiology Journal' }
];

const nodes = {};
function el(name) {
  if (!nodes[name]) {
    nodes[name] = { hidden: false, innerHTML: '', textContent: '', classList: { toggle() {} }, setAttribute() {} };
  }
  return nodes[name];
}

const state = {
  mode: 'candidates', search: '', favoritesOnly: false, favoriteJournals: [],
  excludeCaseReports: false, journals: [], journal: '', journalTier: '',
  clinicalTier: '', publisher: '', studyDesign: '', tag: '', lane: 'core',
  range: '14', ftFilter: '', minor: false, reading: '', page: 1
};

const windowObj = {};
const ctx = vm.createContext({
  window: windowObj,
  globalThis: windowObj,
  console,
  state,
  qfOpen: null,
  getCurrentDataset: () => papers,
  weeklyPublicationWindow: () => ({ entries: [] }),
  FEEDS: { items: [] },
  usesLane: () => true,
  defaultRange: (m) => (m === 'candidates' ? '14' : 'all'),
  exactDoi: () => '',
  selectedJournals: () => [],
  cardJournalName: (p) => p.cleanJournal || p.journal || '',
  isInternalSourceName: () => false,
  isCaseReport: () => false,
  esc: (x) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  $: (sel) => {
    if (sel === '#quickBar') return el('bar');
    if (sel === '#qfChipRow') return el('row');
    if (sel === '#qfScopeBtn') return el('scope');
    if (sel === '#qfSummary') return el('summary');
    return null;
  },
  $$: () => []
});

vm.runInContext(tiersSrc, ctx);
assert.ok(ctx.window.XINZHI_JOURNAL_TIERS, 'XINZHI_JOURNAL_TIERS must be defined');
const shorts = (ctx.window.XINZHI_JOURNAL_TIERS.tiers || []).map(t => t.short);
assert.equal(shorts.length, 5);
for (const label of ['顶刊', '心刊', '子刊', 'AI', '其他']) assert.ok(shorts.includes(label), 'missing tier short ' + label + ' in ' + JSON.stringify(shorts));

vm.runInContext(slice, ctx);
ctx.renderQuickFilters();
const html = el('row').innerHTML;
for (const label of ['顶刊', '心刊', '子刊', 'AI', '其他']) {
  assert.ok(html.includes('>' + label + '</button>') || html.includes('筛选' + (label === '心刊' ? '心血管主刊' : label === '子刊' ? '心血管子刊' : label === 'AI' ? 'AI 期刊' : label === '其他' ? '其他期刊' : '顶刊')),
    'quick bar should render chip for ' + label + '; html=' + html);
  assert.ok(html.includes(label), 'quick bar missing label ' + label + '; html=' + html);
}

// Without the global, no tier chips are emitted.
ctx.window.XINZHI_JOURNAL_TIERS = undefined;
ctx.renderQuickFilters();
const missing = el('row').innerHTML;
assert.ok(!missing.includes('顶刊') && !missing.includes('心刊'),
  'tier chips must not render when XINZHI_JOURNAL_TIERS is missing; html=' + missing);

console.log('journal tier chip contracts passed');
