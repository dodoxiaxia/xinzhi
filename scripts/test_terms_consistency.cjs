'use strict';
// Pure offline terminology and UI reference checks for index.html and app.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const fn = name => {
  const m = src.match(new RegExp('  function ' + name + '\\([^]*?\\n  }'));
  if (!m) throw new Error('Missing function ' + name);
  return m[0];
};
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let checks = 0;
const ok = (cond, msg) => { assert(cond, msg); checks++; };

// 1. Forbidden legacy terms must not appear in index.html or app.js.
for (const legacy of ['每周精读', '一键 AI 解读', '中文核心导读', 'AI 解读']) {
  ok(!html.includes(legacy), `index.html must not contain legacy term "${legacy}"`);
  ok(!src.includes(legacy), `app.js must not contain legacy term "${legacy}"`);
}
const metaDesc = html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] || '';
ok(metaDesc.includes('近7天榜'), 'meta description uses unified term "近7天榜"');

// 2. Card template + MODE_NOTES + empty shortlist help text match actual UI controls.
const listCtx = vm.createContext({
  state: { huddle: [], search: '' },
  getPublisherClass: () => '',
  dateLabel: () => '2026-10-01',
  esc,
  quicklookOf: () => null,
  publicationStatusHtml: () => '',
  pdfDownloadLink: () => '',
  doiStatusBlock: () => '',
  safeSourceUrl: () => 'https://example.org/paper',
  exactDoi: () => false,
  designBadgeHtml: () => '',
  topicBadgeHtml: () => ''
});
vm.runInContext(src.match(/  const SEARCH_APOSTROPHES = [^\n]+/)[0] + '\n' + src.match(/  const SEARCH_QUOTES = [^\n]+/)[0] + '\n' + fn('foldSearch'), listCtx);
vm.runInContext(['isInternalSourceName', 'cardJournalName', 'huddleStarSvg', 'cardTakeaway', 'cardSideActionsHtml', 'authorAffilHtml'].map(fn).join('\n'), listCtx);
vm.runInContext(fn('officialArticleUrl'), listCtx);
vm.runInContext(fn('renderArticleCard'), listCtx);
const cardHtml = listCtx.renderArticleCard({ id: 'p1', title: 'Test Paper', journal: 'Circulation' });
ok(cardHtml.includes('class="title-open" data-action="open-drawer"'), 'card title button opens reader drawer');
// Since #145 the card shortlist control is the star icon button; its accessible name carries the "精选" term.
ok(/<button[^>]*class="[^"]*\bcard-star\b[^"]*"[^>]*data-action="toggle-huddle"[^>]*aria-label="加入精选"[^>]*title="加入精选"/.test(cardHtml), 'card shortlist button displays "精选"');

const modeMatch = src.match(/  const MODE_NOTES = \{[^]*?\n  \};/);
ok(Boolean(modeMatch), 'MODE_NOTES exists in app.js');
const modeCtx = vm.createContext({});
vm.runInContext(modeMatch[0].replace('const MODE_NOTES', 'var MODE_NOTES'), modeCtx);
ok(modeCtx.MODE_NOTES.candidates.includes('点题名打开阅读面板'), 'candidates note instructs clicking title to open reader drawer');
ok(!modeCtx.MODE_NOTES.candidates.includes('阅读摘要'), 'candidates note does not cite missing "阅读摘要" button');

// 3. Empty shortlist modal note instructs using the card "精选" button.
const makeNode = () => ({
  innerHTML: '',
  dataset: {},
  disabled: false,
  hidden: false,
  href: '',
  parentElement: null,
  classList: { contains: () => false, add: () => {}, remove: () => {} },
  contains: () => false,
  querySelector: () => null,
  querySelectorAll: () => [],
  setAttribute: () => {},
  removeAttribute: () => {},
  focus: () => {},
  remove: () => {},
  appendChild: () => {}
});
const huddleBody = makeNode();
const huddleNodes = {
  '#huddleModalBackdrop': makeNode(),
  '#huddleModalBody': huddleBody,
  '#clearHuddleBtn': makeNode(),
  '#copyHuddleSummaryBtn': makeNode(),
  '#exportHuddleMdBtn': makeNode(),
  '#closeHuddleModalBtn': makeNode()
};
const huddleCtx = vm.createContext({
  DEFERRED: false, // non-split page: all data parts are already loaded, as in test_faceted_filters.cjs
  partsSettled: () => true,
  PART_STATE: {},
  $: sel => huddleNodes[sel] || null,
  document: { activeElement: null, body: { classList: { add: () => {} } } },
  state: { huddle: [], huddleCompare: [] },
  huddlePapers: () => [],
  huddlePaper: () => null,
  RADAR_LOAD: { state: 'idle' },
  loadRadarArchive: () => { throw new Error('Empty shortlist must not load the radar archive'); },
  selectedComparePapers: () => [],
  pushOverlay: () => {},
  compareCheck: () => {},
  window: {},
  buildCitations: () => ({}),
  copyToClipboard: () => {},
  beijingToday: () => '2026-10-01',
  esc,
  quicklookOf: () => null,
  journalMetricBadge: () => '',
  publicationStatusHtml: () => '',
  studyKey: () => '',
  compareBoxHtml: () => '',
  briefHtml: () => '',
  AI_AVAIL: false
});
vm.runInContext('let huddleLastFocus=null;\n' + fn('openHuddleModal'), huddleCtx);
huddleCtx.openHuddleModal();
ok(huddleBody.innerHTML.includes('点卡片上的“精选”加入精选清单'), 'empty shortlist note matches card "精选" button');
ok(!huddleBody.innerHTML.includes('点击“加入精选清单”'), 'empty shortlist note no longer points to missing card button');

// 4. Reader drawer uses "已核对导读" only for source_checked drafts and "AI 速览" for unverified / on-demand entries.
const drawerBody = makeNode();
const ftStatus = makeNode();
const ftRegion = makeNode();
const ftSection = makeNode();
ftSection.querySelector = sel => String(sel).includes('data-drawer-ft-status') ? ftStatus : null;
drawerBody.querySelector = sel => (String(sel).includes('fulltext') || String(sel).includes('data-drawer-region')) ? ftRegion : null;
const drawerNodes = {
  '#readerDrawer': makeNode(),
  '#drawerBackdrop': makeNode(),
  '#drawerJournalBadges': makeNode(),
  '#drawerBody': drawerBody,
  '#drawerHuddleToggleBtn': makeNode(),
  '#drawerCopyShareBtn': makeNode(),
  '#drawerExternalLink': makeNode(),
  '#drawerInstitutionLink': makeNode(),
  '#drawerInstitutionLoginLink': makeNode(),
  '#drawerPdfLink': makeNode(),
  '#drawerPdfForm': makeNode(),
  '#drawerCloseBtn': makeNode(),
  '#drawerFulltext': ftSection
};
const readerCtx = vm.createContext({
  DEFERRED: false, // non-split page: all data parts are already loaded
  PART_STATE: {},
  prioritizeParts: () => {},
  pumpPartQueue: () => {},
  partsPending: () => false,
  partsReady: () => true,
  $: sel => drawerNodes[sel] || null,
  document: { activeElement: null, body: { classList: { add: () => {} } }, querySelectorAll: () => [] },
  state: { huddle: [], activeDrawerPaper: null },
  hydratePreGenerated: () => {},
  getPublisherClass: () => '',
  getDesignClass: () => '',
  dateLabel: () => '2026-10-01',
  safeSourceUrl: () => 'https://example.org/paper',
  exactDoi: () => false,
  journalMetricBadge: () => '',
  designBadgeHtml: () => '',
  esc,
  quicklookOf: () => null,
  forgetPaper: () => {},
  prioritizedDesign: () => '',
  validTranslation: () => false,
  LIVE_TR: {},
  trKeyOf: () => '',
  publicationStatusHtml: () => '',
  fulltextStatusHtml: () => '',
  studyBoxHtml: () => '',
  pdfDownloadUrl: () => '',
  resetDlForm: () => {},
  pushOverlay: () => {},
  aiApiCheck: () => {},
  trCheck: () => {},
  studyCheck: () => {},
  fetchPublicAbstract: async () => null,
  openBodyOnly: () => {},
  aiWaitingMessage: () => '等待确认'
});
vm.runInContext(['isInternalSourceName', 'cardJournalName', 'authorAffilHtml', 'cardTakeaway', 'abstractMayBeIncomplete', 'huddleStarSvg', 'officialArticleUrl'].map(fn).join('\n') + '\nlet lastFocus=null;\nlet drawerRegionHtml={};\n' + fn('openReaderDrawer') + '\n' + fn('renderDrawerRegions'), readerCtx);

const renderDrawer = paper => {
  readerCtx.state.activeDrawerPaper = null;
  drawerBody.dataset = {};
  drawerBody.innerHTML = '';
  readerCtx.openReaderDrawer(paper);
  return drawerBody.innerHTML;
};

const checkedDraftHtml = renderDrawer({
  id: 'd1', title: 'Checked draft', doi: '10.1/d1', summary: 'Abstract',
  hasDraft: true, draftData: { summary: '导读正文', source_checked: true }
});
const CHECKED_TITLE = '<div class="drawer-section-title">已核对导读 <small>对照公开摘要核对</small></div>';
const countOf = (html, needle) => html.split(needle).length - 1;
// A source_checked draft that only has a summary (no limitations / learning_question) still shows the heading.
ok(countOf(checkedDraftHtml, CHECKED_TITLE) === 1, 'source_checked summary-only draft shows the "已核对导读 / 对照公开摘要核对" heading once');
ok(checkedDraftHtml.includes('<p class="drawer-takeaway">导读正文</p>'), 'source_checked draft summary is shown on the takeaway line');
ok(!checkedDraftHtml.includes('未经医生终审') && !checkedDraftHtml.includes('未经人工核对'), 'source_checked draft has no unreviewed disclaimer');

const checkedExtraHtml = renderDrawer({
  id: 'd3', title: 'Checked draft with limits', doi: '10.1/d3', summary: 'Abstract',
  hasDraft: true, draftData: { summary: '带边界的导读', source_checked: true, limitations: '单中心回顾性', learning_question: '能否外推？' }
});
ok(countOf(checkedExtraHtml, CHECKED_TITLE) === 1 && checkedExtraHtml.includes('证据边界') && checkedExtraHtml.includes('能否外推？'), 'source_checked draft with limitations shows the heading once plus evidence limits and question');

// The checked heading sits above the takeaway line (summary is not repeated); with limitations the order is
// heading -> takeaway -> 证据边界 -> 共读问题. Both the summary-only and the limitations case are checked.
const TAKEAWAY = '<p class="drawer-takeaway">';
const before = (html, ...needles) => needles.every((n, i) => html.indexOf(n) >= 0 && (i === 0 || html.indexOf(needles[i - 1]) < html.indexOf(n)));
ok(before(checkedDraftHtml, CHECKED_TITLE, TAKEAWAY) && countOf(checkedDraftHtml, '导读正文') === 1, 'source_checked summary-only draft: heading precedes the takeaway line and the summary is not repeated');
ok(before(checkedExtraHtml, CHECKED_TITLE, TAKEAWAY + '带边界的导读', '证据边界', '能否外推？') && countOf(checkedExtraHtml, '带边界的导读') === 1, 'source_checked draft with limitations: heading -> takeaway -> 证据边界 -> 共读问题');

const uncheckedDraftHtml = renderDrawer({
  id: 'd2', title: 'Unchecked draft', doi: '10.1/d2', summary: 'Abstract',
  hasDraft: true, draftData: { summary: '未核对正文', source_checked: false }
});
ok(!uncheckedDraftHtml.includes('已核对导读') && !uncheckedDraftHtml.includes('对照公开摘要核对'), 'unchecked draft is never labelled "已核对导读"');
// New design (since #145): no 速览 subheading for drafts; the summary sits on the takeaway line.
ok(!uncheckedDraftHtml.includes('<div class="drawer-section-title">速览</div>') && uncheckedDraftHtml.includes('<p class="drawer-takeaway">未核对正文</p>'), 'unchecked draft shows its summary on the takeaway line without a 速览 subheading');
ok(!uncheckedDraftHtml.includes('未经人工核对') && !uncheckedDraftHtml.includes('机器标注'), 'unchecked draft carries no unverified or machine-annotation label');
// Checked and unchecked drafts stay distinguishable on the page: only the checked one carries the heading.
ok(checkedDraftHtml.includes(CHECKED_TITLE) && !uncheckedDraftHtml.includes(CHECKED_TITLE), 'checked and unchecked drafts are distinguishable by the 已核对导读 heading');

const onDemandNoneHtml = renderDrawer({
  id: 'q1', title: 'No quicklook yet', doi: '10.1/q1', summary: 'Abstract', _aiState: 'none'
});
ok(onDemandNoneHtml.includes('AI 速览') && onDemandNoneHtml.includes('一键生成 AI 速览'), 'on-demand quicklook prompt uses "AI 速览" terminology');

const onDemandWaitingHtml = renderDrawer({
  id: 'q2', title: 'Waiting quicklook', doi: '10.1/q2', summary: 'Abstract', _aiState: 'waiting'
});
ok(onDemandWaitingHtml.includes('AI 速览') && onDemandWaitingHtml.includes('读取已有 AI 速览'), 'waiting quicklook prompt uses "AI 速览" terminology');

console.log(JSON.stringify({ passed: true, checks, networkCalls: 0 }));
