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
vm.runInContext(['officialArticleUrl', 'machineContentLabel', 'renderArticleCard', 'renderCompactRow', 'weeklyCard', 'weeklyRow'].map(fn).join('\n'), ctx);

let checks = 0;
const check = (cond, msg) => { assert(cond, msg); checks++; };

// CSS should not rely on ::before pseudo-element for AI 速览 label.
check(!css.includes('.article-gist.gist-ai::before'), 'CSS ::before pseudo-element removed for gist-ai');

// Helper output matches reader wording and reuses .content-label.
check(ctx.machineContentLabel('AI 速览') === '<span class="content-label">AI 速览 · 未经人工核对</span>', 'AI quicklook label format');
check(ctx.machineContentLabel('机器翻译') === '<span class="content-label">机器翻译 · 未经人工核对</span>', 'Machine translation label format');

// 1. Cards: machine title + AI one-liner
const aiBoth = { id: 'p-both', title: 'Original EN title', titleZh: '机器中文标题', journal: 'JACC', weeklyPick: 1 };
quicklooks[aiBoth.id] = { title_zh: '速览中文标题', one_line: 'AI 一句话结论' };
const cardBoth = ctx.renderArticleCard(aiBoth);
check(cardBoth.includes('<span class="content-label">机器翻译 · 未经人工核对</span>速览中文标题'), 'Card machine title has label');
check(cardBoth.includes('<span class="content-label">AI 速览 · 未经人工核对</span>AI 一句话结论'), 'Card AI gist has label');

// 2. Cards: machine title only (no one_line)
const aiTitleOnly = { id: 'p-title-only', title: 'Original EN title', titleZh: '仅机器译名', journal: 'EHJ' };
const cardTitleOnly = ctx.renderArticleCard(aiTitleOnly);
check(cardTitleOnly.includes('<span class="content-label">机器翻译 · 未经人工核对</span>仅机器译名'), 'Card machine-title-only still carries AI label');
check(!cardTitleOnly.includes('AI 速览'), 'Card without one_line does not show AI 速览');

// 3. Cards: AI one-liner only (no machine title)
const aiGistOnly = { id: 'p-gist-only', title: 'English Only Title', journal: 'NEJM' };
quicklooks[aiGistOnly.id] = { one_line: '仅一句话速览' };
const cardGistOnly = ctx.renderArticleCard(aiGistOnly);
check(cardGistOnly.includes('English Only Title'), 'Card keeps English title');
check(!cardGistOnly.includes('机器翻译'), 'Card without machine title does not label title');
check(cardGistOnly.includes('<span class="content-label">AI 速览 · 未经人工核对</span>仅一句话速览'), 'Card AI gist only has label');

// 4. Cards & compact rows: human-reviewed draft has NO machine labels
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
check(!cardHuman.includes('未经人工核对'), 'Reviewed draft card has no unverified label');
check(!cardHuman.includes('机器翻译') && !cardHuman.includes('AI 速览'), 'Reviewed draft card has no machine labels');
check(cardHuman.includes('人工导读标题') && cardHuman.includes('人工导读摘要'), 'Reviewed draft card shows human content');

// 5. Compact rows
const rowBoth = ctx.renderCompactRow(aiBoth);
check(rowBoth.includes('<span class="content-label">机器翻译 · 未经人工核对</span>速览中文标题'), 'Compact row machine title has label');
const rowTitleOnly = ctx.renderCompactRow(aiTitleOnly);
check(rowTitleOnly.includes('<span class="content-label">机器翻译 · 未经人工核对</span>仅机器译名'), 'Compact row titleZh has label');
const rowHuman = ctx.renderCompactRow(humanPaper);
check(rowHuman.includes('[导读] 人工导读标题') && !rowHuman.includes('未经人工核对'), 'Compact row reviewed draft has no machine label');
const rowEn = ctx.renderCompactRow({ id: 'p-en', title: 'Plain English Paper', journal: 'BMJ' });
check(rowEn.includes('Plain English Paper') && !rowEn.includes('未经人工核对'), 'Compact row English title has no machine label');

// 6. Weekly card and weekly compact row
const wCard = ctx.weeklyCard(aiBoth, '11-13', '');
check(wCard.includes('<span class="content-label">机器翻译 · 未经人工核对</span>速览中文标题'), 'Weekly card machine title has label');
check(wCard.includes('<span class="content-label">AI 速览 · 未经人工核对</span>AI 一句话结论'), 'Weekly card AI gist has unified label');
check(!wCard.includes('未经人工核验'), 'Weekly card aligns wording with 未经人工核对');

const wRow = ctx.weeklyRow(aiBoth, '11-13', '');
check(wRow.includes('<span class="content-label">机器翻译 · 未经人工核对</span>速览中文标题'), 'Weekly compact row machine title has label');
check(wRow.includes('<span class="content-label">AI 速览 · 未经人工核对</span>AI 一句话结论'), 'Weekly compact row AI gist has label');

const wHumanCard = ctx.weeklyCard(humanPaper, '11-13', '');
const wHumanRow = ctx.weeklyRow(humanPaper, '11-13', '');
check(!wHumanCard.includes('未经人工核对') && !wHumanRow.includes('未经人工核对'), 'Weekly views omit machine labels for human-reviewed draft');

console.log('machine content labels: ' + checks + ' assertions passed');
