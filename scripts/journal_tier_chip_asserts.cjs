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

// 近7天榜：快捷条补 AI 档，口径为 AI 医疗、AI 前沿分类并上 AI 期刊。
const fnSrc = n => { const m = appSrc.match(new RegExp('  function ' + n + '\\([^]*?\\n  }')); assert(m, n + ' not found in app.js'); return m[0]; };
const weeklyPapers = [
  { id: 'w1', journal: 'Circulation', cleanJournal: 'Circulation', weeklyCategory: 'cardio' },
  { id: 'w2', journal: 'JAMA', cleanJournal: 'JAMA', weeklyCategory: 'general' },
  { id: 'w3', journal: 'JACC: Advances', cleanJournal: 'JACC: Advances', weeklyCategory: 'aimed' },
  { id: 'w4', journal: 'Nature Communications', cleanJournal: 'Nature Communications', weeklyCategory: 'aitech' },
  { id: 'w5', journal: 'npj Digital Medicine', cleanJournal: 'npj Digital Medicine', weeklyCategory: 'cardio' },
  { id: 'w6', journal: 'Circulation', cleanJournal: 'Circulation' }
];
ctx.window.XINZHI_JOURNAL_TIERS = undefined;
vm.runInContext(tiersSrc, ctx);
ctx.laneOf = p => (p.id === 'w6' ? 'cardio' : 'general');
vm.runInContext(fnSrc('weeklyCategoryOf'), ctx);
ctx.state.mode = 'weekly';
ctx.weeklyPublicationWindow = () => ({ entries: weeklyPapers.map(paper => ({ paper })) });
ctx.renderQuickFilters();
let weeklyHtml = el('row').innerHTML;
assert.ok(/data-qf-jtier="ai"[^>]*>AI<\/button>/.test(weeklyHtml), 'weekly quick bar should render the AI chip; html=' + weeklyHtml);
assert.ok(weeklyHtml.includes('aria-label="筛选 AI"'), 'weekly AI chip is named AI');
assert.ok(!weeklyHtml.includes('data-qf-jtier-menu="ai"'), 'weekly AI chip has no journal list');
ctx.state.journalTier = 'ai';
assert.deepEqual(weeklyPapers.filter(ctx.paperMatchesJournalFilter).map(p => p.id), ['w3', 'w4', 'w5'], 'weekly AI filter = AI 分类与 AI 期刊的并集');
ctx.renderQfSummary();
assert.ok(/>AI <span/.test(el('summary').innerHTML), 'weekly selected condition is AI');
assert.ok(!el('summary').innerHTML.includes('AI 期刊'), 'weekly selected condition is not named AI 期刊');
// 只剩 AI 期刊时，仍显示 AI 档并筛出该稿
const journalOnly = weeklyPapers.filter(p => !['w3', 'w4'].includes(p.id));
ctx.weeklyPublicationWindow = () => ({ entries: journalOnly.map(paper => ({ paper })) });
ctx.renderQuickFilters();
assert.ok(/data-qf-jtier="ai"/.test(el('row').innerHTML), 'weekly AI chip remains for AI journals');
assert.deepEqual(journalOnly.filter(ctx.paperMatchesJournalFilter).map(p => p.id), ['w5'], 'AI journal alone still matches the union');
// 分类 AI 和 AI 期刊稿均移除后，榜内不出 AI 档
ctx.weeklyPublicationWindow = () => ({ entries: weeklyPapers.filter(p => !['w3', 'w4', 'w5'].includes(p.id)).map(paper => ({ paper })) });
ctx.state.journalTier = '';
ctx.renderQuickFilters();
assert.ok(!/data-qf-jtier="ai"/.test(el('row').innerHTML), 'weekly AI chip hidden when neither AI categories nor AI journals remain');
// 其他栏目：仍按 AI 期刊名单
ctx.state.mode = 'candidates';
ctx.state.journalTier = 'ai';
assert.deepEqual(weeklyPapers.filter(ctx.paperMatchesJournalFilter).map(p => p.id), ['w5'], 'non-weekly AI filter keeps the journal list');

console.log('journal tier chip contracts passed');
