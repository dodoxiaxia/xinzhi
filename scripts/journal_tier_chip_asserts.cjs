'use strict';
// Assert journal-tier data is present and renderQuickFilters emits the visible menu chips.
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
const summaryEnd = appSrc.indexOf('\n  function qfAnchor(', end);
assert(summaryEnd > end, 'renderQfSummary block not found');
const slice = appSrc.slice(start, summaryEnd);

const papers = [
  { id: 'gm', journal: 'The Lancet', cleanJournal: 'The Lancet' },
  { id: 'clin1', journal: 'Circulation', cleanJournal: 'Circulation' },
  { id: 'clin2', journal: 'Heart Rhythm', cleanJournal: 'Heart Rhythm' },
  { id: 'basic', journal: 'Circulation Research', cleanJournal: 'Circulation Research' },
  { id: 'rev', journal: 'Nature Reviews Cardiology', cleanJournal: 'Nature Reviews Cardiology' },
  { id: 'flag', journal: 'Science', cleanJournal: 'Science' },
  { id: 'ai', journal: 'NEJM AI', cleanJournal: 'NEJM AI' },
  { id: 'oth', journal: 'Some Regional Cardiology Journal', cleanJournal: 'Some Regional Cardiology Journal' },
  { id: 'natbme', journal: 'Nature Biomedical Engineering', cleanJournal: 'Nature Biomedical Engineering' }
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
const visibleTiers = ctx.window.XINZHI_JOURNAL_TIERS.tiers || [];
assert.ok(visibleTiers.length >= 7, 'visible menu should include medical four + 顶刊 + AI + 其他');
for (const t of visibleTiers) {
  assert.ok(t.id && t.short && t.title, 'visible tier has id/short/title');
}

vm.runInContext(slice, ctx);
ctx.renderQuickFilters();
const html = el('row').innerHTML;
for (const t of visibleTiers) {
  assert.ok(html.includes('>' + t.short + '</button>') || html.includes('筛选' + t.title),
    'quick bar should render chip for ' + t.short + '; html=' + html);
  assert.ok(html.includes(t.short), 'quick bar missing label ' + t.short + '; html=' + html);
}

// Without the global, no tier chips are emitted.
ctx.window.XINZHI_JOURNAL_TIERS = undefined;
ctx.renderQuickFilters();
const missing = el('row').innerHTML;
assert.ok(!missing.includes('顶刊') && !missing.includes('综合') && !missing.includes('心刊'),
  'tier chips must not render when XINZHI_JOURNAL_TIERS is missing; html=' + missing);

// 近7天榜：AI 期刊芯片只按期刊名单筛选，并保留期刊清单。
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
ctx.state.journalTierLegacy = false;
ctx.weeklyPublicationWindow = () => ({ entries: weeklyPapers.map(paper => ({ paper })) });
ctx.renderQuickFilters();
let weeklyHtml = el('row').innerHTML;
assert.ok(/data-qf-jtier="ai"[^>]*>AI<\/button>/.test(weeklyHtml), 'weekly quick bar should render the AI chip; html=' + weeklyHtml);
assert.ok(weeklyHtml.includes('aria-label="筛选AI 期刊"'), 'weekly AI chip is named AI 期刊');
assert.ok(weeklyHtml.includes('data-qf-jtier-menu="ai"'), 'weekly AI chip keeps the journal list');
ctx.state.journalTier = 'ai';
assert.deepEqual(weeklyPapers.filter(ctx.paperMatchesJournalFilter).map(p => p.id), ['w5'], 'weekly AI filter is the AI journal list only');
ctx.renderQfSummary();
assert.ok(el('summary').innerHTML.includes('AI 期刊'), 'weekly selected condition is AI 期刊');
// 只剩 AI 期刊时，仍显示 AI 档并筛出该稿
const journalOnly = weeklyPapers.filter(p => !['w3', 'w4'].includes(p.id));
ctx.weeklyPublicationWindow = () => ({ entries: journalOnly.map(paper => ({ paper })) });
ctx.renderQuickFilters();
assert.ok(/data-qf-jtier="ai"/.test(el('row').innerHTML), 'weekly AI chip remains for AI journals');
assert.deepEqual(journalOnly.filter(ctx.paperMatchesJournalFilter).map(p => p.id), ['w5'], 'AI journal alone still matches the journal list');
// 主题 AI 仍在、但 AI 期刊稿移除后，榜内不出 AI 期刊档
ctx.weeklyPublicationWindow = () => ({ entries: weeklyPapers.filter(p => p.id !== 'w5').map(paper => ({ paper })) });
ctx.state.journalTier = '';
ctx.renderQuickFilters();
assert.ok(!/data-qf-jtier="ai"/.test(el('row').innerHTML), 'weekly AI chip hidden when no AI journals remain, even if topic AI papers exist');
// 其他栏目：仍按 AI 期刊名单
ctx.state.mode = 'candidates';
ctx.state.journalTier = 'ai';
assert.deepEqual(weeklyPapers.filter(ctx.paperMatchesJournalFilter).map(p => p.id), ['w5'], 'non-weekly AI filter keeps the journal list');

console.log('journal tier chip contracts passed');
