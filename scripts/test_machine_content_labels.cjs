'use strict';
// Offline unit test for machine-generated content labels in cards, compact rows, and weekly views.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const fn = name => {
  const m = src.match(new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  }'));
  if (!m) throw Error('Missing function ' + name);
  return m[0];
};
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let quicklooks = {};
const ctx = vm.createContext({
  esc,
  state: { huddle: [], search: '' },
  LIVE_TR: {},
  getPublisherClass: () => 'pub-other',
  getDesignClass: () => 'design-other',
  dateLabel: () => '2026-11-13',
  quicklookOf: p => quicklooks[p.id] || null,
  publicationStatusHtml: () => '',
  pdfDownloadLink: () => '',
  safeSourceUrl: p => p.url || '',
  doiStatusBlock: () => '',
  exactDoi: () => '',
  journalMetricBadge: () => '',
  designBadgeHtml: () => '',
  hasAbstract: () => false,
  validTranslation: () => false,
  preGeneratedOf: () => null,
  trKeyOf: p => p.id,
});
vm.runInContext(['officialArticleUrl', 'renderArticleCard', 'renderCompactRow', 'weeklyCard', 'weeklyRow'].map(fn).join('\n'), ctx);

let checks = 0;
const check = (cond, msg) => { assert(cond, msg); checks++; };
const hasNoMachineLabel = (html) => (
  !html.includes('content-label') &&
  !html.includes('未经人工核对') &&
  !html.includes('未经人工核验') &&
  !html.includes('机器翻译') &&
  !html.includes('AI 速览 ·')
);

// CSS should not rely on ::before pseudo-element for AI 速览 label.
check(!css.includes('.article-gist.gist-ai::before'), 'CSS ::before pseudo-element removed for gist-ai');

// 1. Cards: machine title + AI one-liner render directly without machine-content labels
const aiBoth = { id: 'p-both', title: 'Original EN title', titleZh: '机器中文标题', journal: 'JACC', weeklyPick: 1 };
quicklooks[aiBoth.id] = { title_zh: '速览中文标题', one_line: 'AI 一句话结论' };
const cardBoth = ctx.renderArticleCard(aiBoth);
check(hasNoMachineLabel(cardBoth), 'Card with machine title and AI gist omits machine-content labels');
check(cardBoth.includes('ql-title') && cardBoth.includes('速览中文标题'), 'Card outputs machine title directly');
check(cardBoth.includes('gist-ai') && cardBoth.includes('AI 一句话结论'), 'Card outputs AI gist directly');

// 2. Cards: machine title only (no one_line)
const aiTitleOnly = { id: 'p-title-only', title: 'Original EN title', titleZh: '仅机器译名', journal: 'EHJ' };
const cardTitleOnly = ctx.renderArticleCard(aiTitleOnly);
check(hasNoMachineLabel(cardTitleOnly), 'Card machine-title-only omits machine-content labels');
check(cardTitleOnly.includes('仅机器译名'), 'Card machine-title-only shows title directly');
check(!cardTitleOnly.includes('AI 速览'), 'Card without one_line does not show AI 速览');

// 3. Cards: AI one-liner only (no machine title)
const aiGistOnly = { id: 'p-gist-only', title: 'English Only Title', journal: 'NEJM' };
quicklooks[aiGistOnly.id] = { one_line: '仅一句话速览' };
const cardGistOnly = ctx.renderArticleCard(aiGistOnly);
check(hasNoMachineLabel(cardGistOnly), 'Card AI gist only omits machine-content labels');
check(cardGistOnly.includes('English Only Title'), 'Card keeps English title');
check(cardGistOnly.includes('gist-ai') && cardGistOnly.includes('仅一句话速览'), 'Card outputs AI gist directly without label');

// 4. Cards & compact rows: human-reviewed draft shows human content with no machine labels
const humanPaper = {
  id: 'p-human',
  title: 'Human Reviewed Original',
  titleZh: '不应显示的机器译名',
  journal: 'Lancet',
  hasDraft: true,
  draftData: { title_zh: '人工导读标题', summary: '人工导读摘要' },
  weeklyPick: 2,
};
quicklooks[humanPaper.id] = { title_zh: '不应显示的速览标题', one_line: '不应显示的速览' };
const cardHuman = ctx.renderArticleCard(humanPaper);
check(hasNoMachineLabel(cardHuman) && !cardHuman.includes('AI 速览'), 'Reviewed draft card has no machine labels');
check(cardHuman.includes('人工导读标题') && cardHuman.includes('人工导读摘要'), 'Reviewed draft card shows human content');

// 5. Compact rows
const rowBoth = ctx.renderCompactRow(aiBoth);
check(hasNoMachineLabel(rowBoth) && rowBoth.includes('速览中文标题'), 'Compact row outputs machine title directly without label');
const rowTitleOnly = ctx.renderCompactRow(aiTitleOnly);
check(hasNoMachineLabel(rowTitleOnly) && rowTitleOnly.includes('仅机器译名'), 'Compact row titleZh outputs title directly without label');
const rowHuman = ctx.renderCompactRow(humanPaper);
check(hasNoMachineLabel(rowHuman) && rowHuman.includes('[导读] 人工导读标题'), 'Compact row reviewed draft has no machine label');
const rowEn = ctx.renderCompactRow({ id: 'p-en', title: 'Plain English Paper', journal: 'BMJ' });
check(hasNoMachineLabel(rowEn) && rowEn.includes('Plain English Paper'), 'Compact row English title has no machine label');

// 6. Weekly card and weekly compact row
const wCard = ctx.weeklyCard(aiBoth, '11-13', '');
check(hasNoMachineLabel(wCard), 'Weekly card omits machine-content labels');
check(wCard.includes('速览中文标题') && wCard.includes('AI 一句话结论'), 'Weekly card outputs title and one-liner directly');

const wRow = ctx.weeklyRow(aiBoth, '11-13', '');
check(hasNoMachineLabel(wRow), 'Weekly compact row omits machine-content labels');
check(wRow.includes('速览中文标题') && wRow.includes('AI 一句话结论'), 'Weekly compact row outputs title and one-liner directly');

const wHumanCard = ctx.weeklyCard(humanPaper, '11-13', '');
const wHumanRow = ctx.weeklyRow(humanPaper, '11-13', '');
check(hasNoMachineLabel(wHumanCard) && hasNoMachineLabel(wHumanRow), 'Weekly views omit machine labels for human-reviewed draft');

console.log('machine content labels: ' + checks + ' assertions passed');
