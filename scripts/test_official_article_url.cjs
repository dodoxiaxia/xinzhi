'use strict';
// Offline test for officialArticleUrl() and its card / compact-row / reader-drawer call sites.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const fn = name => {
  const match = src.match(new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  }'));
  assert(match, 'Missing helper ' + name);
  return match[0];
};
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const el = (extra = {}) => ({
  innerHTML: '', href: '', hidden: false, scrollTop: 0, dataset: {},
  classList: { _s: new Set(), add(k) { this._s.add(k); }, contains(k) { return this._s.has(k); } },
  setAttribute() {}, focus() {}, contains() { return false; }, querySelector() { return null; },
  ...extra
});
const ftStatus = el();
const ftRegion = el({ appendChild() {} });
const nodes = {
  readerDrawer: el(), drawerBackdrop: el(), drawerJournalBadges: el(), drawerBody: el({
    querySelector(sel) { return String(sel).includes('fulltext') || String(sel).includes('data-drawer-region') ? ftRegion : null; }
  }),
  drawerHuddleToggleBtn: el(), drawerCopyShareBtn: el(), drawerExternalLink: el(),
  drawerInstitutionLink: el(), drawerInstitutionLoginLink: el(),
  drawerPdfLink: el({ parentElement: null }), drawerPdfForm: el({ parentElement: null }),
  drawerCloseBtn: el(),
  drawerFulltext: el({
    remove() {},
    appendChild() {},
    querySelector(sel) { return String(sel).includes('data-drawer-ft-status') ? ftStatus : null; }
  })
};
const c = vm.createContext({
  URL, encodeURIComponent, decodeURIComponent, esc,
  state: { huddle: [], search: '', activeDrawerPaper: null },
  LIVE_TR: {},
  document: { activeElement: null, body: el(), getElementById: id => nodes[id] || null },
  $: sel => nodes[sel.slice(1)] || null,
  getPublisherClass: () => 'pub-other',
  getDesignClass: () => 'design-other',
  dateLabel: () => '2026-10-01',
  quicklookOf: () => null,
  publicationStatusHtml: () => '',
  doiStatusBlock: () => '',
  journalMetricBadge: () => '',
  cardJournalName: p => (p && (p.cleanJournal || p.journal)) || '',
  designBadgeHtml: () => '',
  topicBadgeHtml: () => '',
  DEFERRED: false,
  PART_STATE: {},
  prioritizeParts: () => {},
  pumpPartQueue: () => {},
  partsReady: () => true,
  partsPending: () => false,
  cardTakeaway: () => '',
  authorAffilHtml: () => '',
  abstractMayBeIncomplete: () => false,
  forgetPaper: () => {},
  prioritizedDesign: () => '',
  huddleStarSvg: () => '',
  fetchPublicAbstract: async () => null,
  openBodyOnly: () => {},
  lastFocus: null,
  validTranslation: () => false,
  trKeyOf: p => p.id,
  fulltextStatusHtml: () => '',
  pdfDownloadUrl: () => '',
  resetDlForm: () => {},
  pushOverlay: () => {},
  hydratePreGenerated: () => {},
  aiApiCheck: () => {},
  trCheck: () => {},
  studyCheck: () => {},
  studyBoxHtml: () => '',
  aiWaitingMessage: () => '等待确认',
  renderDrawerRegions: (bodyEl, _paper, _changed, regions) => {
    bodyEl.innerHTML = regions.map(([, html]) => html).join('');
  }
});

vm.runInContext(src.match(/  const SEARCH_APOSTROPHES = [^\n]+/)[0] + '\n' + src.match(/  const SEARCH_QUOTES = [^\n]+/)[0] + '\n' + fn('foldSearch'), c);
vm.runInContext([
  'exactDoi', 'safeSourceUrl', 'officialArticleUrl',
  'renderArticleCard', 'renderCompactRow', 'openReaderDrawer'
].map(fn).join('\n'), c);
vm.runInContext(
  'function cardSideActionsHtml(p) {' +
  '  const sourceUrl = officialArticleUrl(p);' +
  '  const doiBlock = typeof doiStatusBlock === "function" ? doiStatusBlock(p) : "";' +
  '  const link = sourceUrl && !doiBlock' +
  '    ? \'<a class="text-btn card-source" href="\' + sourceUrl + \'" target="_blank" rel="noopener" title="在期刊官网打开原文">官网<span aria-hidden="true">&thinsp;↗</span></a>\'' +
  '    : "";' +
  '  return \'<div class="card-side-actions" role="group" aria-label="操作">\' + link + \'</div>\';' +
  '}',
  c
);

let checks = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); checks++; };
const ok = (v, msg) => { assert(v, msg); checks++; };

// 1. Unit behavior of officialArticleUrl() and unchanged safeSourceUrl()
const pubmedWithDoi = {
  id: 'pmid-41000001', pmid: '41000001', doi: '10.1056/NEJMoa2600001',
  title: 'PubMed paper with DOI', journal: 'NEJM', summary: 'Public abstract.',
  url: 'https://pubmed.ncbi.nlm.nih.gov/41000001/'
};
const pubmedNoDoi = {
  id: 'pmid-41000002', pmid: '41000002', doi: '',
  title: 'PubMed paper without DOI', journal: 'NEJM', summary: 'Public abstract.',
  url: 'https://pubmed.ncbi.nlm.nih.gov/41000002/'
};
const badUrlNoDoi = {
  id: 'bad-1', doi: '', title: 'Unsafe URL', journal: 'NEJM', summary: 'Public abstract.',
  url: 'javascript:alert(1)'
};

eq(c.officialArticleUrl(pubmedWithDoi), 'https://doi.org/10.1056/nejmoa2600001', 'DOI + PubMed url returns doi.org');
eq(c.safeSourceUrl(pubmedWithDoi), 'https://pubmed.ncbi.nlm.nih.gov/41000001/', 'safeSourceUrl keeps existing behavior');
eq(c.officialArticleUrl({ doi: 'DOI: 10.1001/JAMA.2026;1+2', url: 'https://pubmed.ncbi.nlm.nih.gov/1/' }),
  'https://doi.org/10.1001/jama.2026%3B1%2B2', 'DOI is URL-encoded while preserving slashes');
eq(c.officialArticleUrl(pubmedNoDoi), 'https://pubmed.ncbi.nlm.nih.gov/41000002/', 'No DOI + PubMed url returns original url');
eq(c.officialArticleUrl({ doi: 'invalid-doi', url: 'https://pubmed.ncbi.nlm.nih.gov/41000002/' }),
  'https://pubmed.ncbi.nlm.nih.gov/41000002/', 'Invalid DOI falls back to safe p.url');
eq(c.officialArticleUrl({ doi: 'invalid-doi', url: '' }), '', 'Invalid DOI without url is empty');
eq(c.officialArticleUrl(badUrlNoDoi), '', 'javascript: url is filtered');
eq(c.officialArticleUrl({ url: 'data:text/html,<script>alert(1)</script>' }), '', 'data: url is filtered');
eq(c.officialArticleUrl(null), '', 'null paper returns empty string');

// 2. Card & compact-row rendering
const cardWithDoi = c.renderArticleCard(pubmedWithDoi);
ok(cardWithDoi.includes('href="https://doi.org/10.1056/nejmoa2600001"') && cardWithDoi.includes('class="text-btn card-source"') && cardWithDoi.includes('>官网'),
  'Card official link points to doi.org when DOI exists');
ok(!cardWithDoi.includes('https://pubmed.ncbi.nlm.nih.gov/41000001/'),
  'Card official link no longer uses PubMed url when DOI exists');

const cardNoDoi = c.renderArticleCard(pubmedNoDoi);
ok(cardNoDoi.includes('href="https://pubmed.ncbi.nlm.nih.gov/41000002/"') && cardNoDoi.includes('class="text-btn card-source"') && cardNoDoi.includes('>官网'),
  'Card official link uses PubMed url when no DOI exists');

const cardBadUrl = c.renderArticleCard(badUrlNoDoi);
ok(!cardBadUrl.includes('card-source') && !cardBadUrl.includes('javascript:'), 'Card omits official link for unsafe url');

const rowWithDoi = c.renderCompactRow(pubmedWithDoi);
ok(rowWithDoi.includes('href="https://doi.org/10.1056/nejmoa2600001"') && rowWithDoi.includes('class="text-btn card-source"') && rowWithDoi.includes('title="在期刊官网打开原文"'),
  'Compact row official link points to doi.org when DOI exists');

// 3. Reader drawer (#drawerExternalLink + removed drawerBody cite/PubMed section)
c.openReaderDrawer(pubmedWithDoi);
eq(nodes.drawerExternalLink.href, 'https://doi.org/10.1056/nejmoa2600001', 'Reader drawer external link points to doi.org');
eq(nodes.drawerExternalLink.hidden, false, 'Reader drawer external link is visible');
ok(!nodes.drawerBody.innerHTML.includes('cite-section') && !nodes.drawerBody.innerHTML.includes('>PubMed ↗</a>'),
  'Removed cite/PubMed section is absent from reader drawer');

c.openReaderDrawer(pubmedNoDoi);
eq(nodes.drawerExternalLink.href, 'https://pubmed.ncbi.nlm.nih.gov/41000002/', 'Reader drawer falls back to PubMed url without DOI');
eq(nodes.drawerExternalLink.hidden, false, 'Reader drawer external link stays visible without DOI when url is valid');

c.openReaderDrawer(badUrlNoDoi);
eq(nodes.drawerExternalLink.href, '#', 'Reader drawer filters unsafe url to #');
eq(nodes.drawerExternalLink.hidden, true, 'Reader drawer hides external link for unsafe url');

console.log('officialArticleUrl: ' + checks + ' assertions passed');
