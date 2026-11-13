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
  exactDoi: () => false
});
vm.runInContext(fn('renderArticleCard'), listCtx);
const cardHtml = listCtx.renderArticleCard({ id: 'p1', title: 'Test Paper', journal: 'Circulation' });
ok(cardHtml.includes('class="title-open" data-action="open-drawer"'), 'card title button opens reader drawer');
ok(/>\s*(?:<span[^>]*>☆<\/span>\s*)?精选<\/button>/.test(cardHtml), 'card shortlist button displays "精选"');

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
  classList: { contains: () => false, add: () => {}, remove: () => {} },
  contains: () => false,
  querySelector: () => null,
  querySelectorAll: () => [],
  setAttribute: () => {},
  removeAttribute: () => {},
  focus: () => {}
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
  $: sel => huddleNodes[sel] || null,
  document: { activeElement: null, body: { classList: { add: () => {} } } },
  state: { huddle: [], huddleCompare: [] },
  huddlePapers: () => [],
  huddlePaper: () => null,
  RADAR_LOAD: { state: 'idle' },
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
  '#drawerCloseBtn': makeNode()
};
const readerCtx = vm.createContext({
  $: sel => drawerNodes[sel] || null,
  document: { activeElement: null, body: { classList: { add: () => {} } }, querySelectorAll: () => [] },
  state: { huddle: [], activeDrawerPaper: null },
  hydratePreGenerated: () => {},
  getPublisherClass: () => '',
  getDesignClass: () => '',
  dateLabel: () => '2026-10-01',
  safeSourceUrl: () => 'https://example.org/paper',
  journalMetricBadge: () => '',
  designBadgeHtml: () => '',
  esc,
  quicklookOf: () => null,
  preGeneratedOf: () => null,
  forgetPaper: () => {},
  prioritizedDesign: () => '',
  validTranslation: () => false,
  LIVE_TR: {},
  trKeyOf: () => '',
  trBoxHtml: () => '',
  buildCitations: () => ({ gb: '', ama: '', bibtex: '' }),
  publicationStatusHtml: () => '',
  journalMetricDetails: () => '',
  abstractTranslationStatus: () => '',
  fulltextView: () => null,
  fulltextStatusHtml: () => '',
  studyBoxHtml: () => '',
  MAINTAINER: false,
  pdfDownloadUrl: () => '',
  resetDlForm: () => {},
  pushOverlay: () => {},
  aiApiCheck: () => {},
  trCheck: () => {},
  studyCheck: () => {},
  aiWaitingMessage: () => '等待确认'
});
vm.runInContext('let lastFocus=null;\nlet drawerRegionHtml={};\n' + fn('openReaderDrawer') + '\n' + fn('renderDrawerRegions'), readerCtx);

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
ok(checkedDraftHtml.includes('已核对导读'), 'source_checked draft shows "已核对导读"');
ok(checkedDraftHtml.includes('未经医生终审'), 'source_checked draft states review boundary');

const uncheckedDraftHtml = renderDrawer({
  id: 'd2', title: 'Unchecked draft', doi: '10.1/d2', summary: 'Abstract',
  hasDraft: true, draftData: { summary: '未核对正文', source_checked: false }
});
ok(!uncheckedDraftHtml.includes('已核对导读'), 'unchecked draft is never labelled "已核对导读"');
ok(uncheckedDraftHtml.includes('AI 速览') && uncheckedDraftHtml.includes('未经人工核对'), 'unchecked draft is labelled as unverified AI 速览');

const onDemandNoneHtml = renderDrawer({
  id: 'q1', title: 'No quicklook yet', doi: '10.1/q1', summary: 'Abstract', _aiState: 'none'
});
ok(onDemandNoneHtml.includes('AI 速览') && onDemandNoneHtml.includes('一键生成 AI 速览'), 'on-demand quicklook prompt uses "AI 速览" terminology');

const onDemandWaitingHtml = renderDrawer({
  id: 'q2', title: 'Waiting quicklook', doi: '10.1/q2', summary: 'Abstract', _aiState: 'waiting'
});
ok(onDemandWaitingHtml.includes('AI 速览') && onDemandWaitingHtml.includes('读取已有 AI 速览'), 'waiting quicklook prompt uses "AI 速览" terminology');

console.log(JSON.stringify({ passed: true, checks, networkCalls: 0 }));
