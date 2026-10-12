'use strict';
// Execute the application's real filter helpers with an offline public fixture.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const fn = name => {
  if (name === 'defaultRange') return source.match(/  function defaultRange[^\n]+/)[0];
  const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  }'));
  assert(match, 'Missing application helper: ' + name);
  return match[0];
};
const paper = (id, journal, publisher, studyDesign, extra = {}) => ({
  id, title: 'Trial ' + id, cleanJournal: journal, journal, publisher, studyDesign,
  clinicalTier: '心血管旗舰顶刊', tags: ['#房颤'], date: '2026-10-08', datePrecision: 'day',
  lane: 'cardio', summary: 'Public abstract', ...extra
});
const papers = [
  paper('circ-rct', 'Circulation', 'AHA (Circulation)', 'RCT', { tags: ['#卒中'] }),
  paper('circ-cohort', 'Circulation', 'AHA (Circulation)', '队列研究'),
  paper('nejm-cohort', 'NEJM', 'MMS (NEJM)', '队列研究'),
  paper('jama-rct', 'JAMA', 'JAMA Network', 'RCT', { clinicalTier: '顶级综合与科学' }),
  paper('old', 'Circulation', 'AHA (Circulation)', 'RCT', { date: '2026-09-01' }),
  paper('future', 'Circulation', 'AHA (Circulation)', 'RCT', { date: '2026-10-10' }),
  paper('month', 'Circulation', 'AHA (Circulation)', 'RCT', { datePrecision: 'month' }),
  paper('minor', 'Circulation', 'AHA (Circulation)', 'RCT', { minor: true }),
  paper('general', 'NEJM', 'MMS (NEJM)', 'RCT', { lane: 'general' })
];
const initial = () => ({
  mode: 'candidates', lane: 'cardio', range: '14', search: '', minor: false, reading: '',
  favoritesOnly: false, favoriteJournals: ['Circulation'], clinicalTier: '', publisher: '',
  journal: '', studyDesign: '', tag: '', sort: 'date-desc', viewMode: 'compact', page: 4
});
const elements = Object.fromEntries(['tierFilterList', 'publisherAccordion', 'designFilterList', 'tagsCloud', 'activeFiltersBar'].map(id => [id, { innerHTML: '' }]));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const context = vm.createContext({
  state: initial(), expandedPublishers: new Set(), getCurrentDataset: () => papers,
  usesLane: () => true, inLane: (p, lane) => lane === 'all' || p.lane === lane,
  queryMatches: (text, query) => text.includes(query), quicklookOf: p => p.quicklook,
  hasAbstract: p => Boolean(p.summary), datePrecision: p => p.datePrecision,
  rangeStart: () => '2026-09-26', beijingToday: () => '2026-10-09',
  $: selector => elements[selector.slice(1)], esc: escapeHtml,
  journalMetricBadge: () => '', URL, viewInUrl: false,
  window: { location: { href: 'https://example.test/?mode=candidates' } }
});
context.history = { replaceState: (_state, _title, url) => { context.window.location.href = new URL(url, context.window.location.href).href; } };
vm.runInContext([
  'publisherForJournal', 'sidebarSelections', 'clearSidebarFilters', 'selectSidebarFilter',
  'browseOnlyButton', 'paperDerived', 'paperSearchText', 'matchesQuery', 'sidebarMisses', 'matchesSidebarFilters', 'matchesFilters',
  'renderSidebarFilters', 'renderActiveFilterChips', 'renderEmptyFilters', 'syncUrl', 'defaultRange'
].map(fn).join('\n') + '\n' + ['PAPER_DERIVED', 'FACET_BITS'].map(name => source.match(new RegExp('  const ' + name + ' = [^\\n]+'))[0]).join('\n'), context);
let checks = 0;
const check = (value, label) => { assert(value, label); checks++; };
const matches = () => papers.filter(p => context.matchesFilters(p, false)).map(p => p.id).join(',');
const select = (group, value, only = false) => context.selectSidebarFilter(group, value, only);
const reset = () => { context.state = initial(); };
const snapshot = () => JSON.stringify(context.state);

check(matches() === 'circ-rct,circ-cohort,nejm-cohort,jama-rct', 'Base scope excludes older, future, imprecise, minor and unrelated-domain papers');
select('journal', 'Circulation');
select('design', 'RCT');
check(matches() === 'circ-rct', 'Different dimensions intersect');
check(context.state.publisher === 'AHA (Circulation)', 'Journal sets its canonical publisher');
select('journal', 'JAMA');
check(matches() === 'jama-rct', 'Changing journal replaces the previous source and retains study design');
check(context.state.publisher === 'JAMA Network', 'Changing publisher families cannot retain a contradictory parent');
select('journal', 'JAMA');
check(matches() === 'jama-rct', 'Clicking an already selected journal retains it');
select('design', 'RCT');
check(context.state.studyDesign === 'RCT', 'Clicking the selected design retains it');
select('pub', 'AHA (Circulation)');
check(!context.state.journal && matches() === 'circ-rct', 'Choosing a publisher replaces the child journal');
select('design', '队列研究');
check(matches() === 'circ-cohort', 'Changing a design replaces it without broadening the source');
select('design', '');
check(matches() === 'circ-rct,circ-cohort', 'All designs clears only the design dimension');
select('journal', '');
check(!context.state.publisher && !context.state.journal && matches().split(',').length === 4, 'Removing the source clears both publisher and journal');

for (const [group, value] of [['tier', '顶级综合与科学'], ['pub', 'MMS (NEJM)'], ['journal', 'NEJM'], ['design', 'RCT'], ['tag', '#卒中']]) {
  reset();
  Object.assign(context.state, { clinicalTier: 'old tier', publisher: 'old publisher', journal: 'old journal', studyDesign: 'old design', tag: 'old tag', search: 'trial', reading: 'abstract', favoritesOnly: true, minor: true });
  const baseKeys = ['mode', 'lane', 'range', 'search', 'minor', 'reading', 'favoritesOnly', 'favoriteJournals', 'sort', 'viewMode'];
  const before = JSON.stringify(baseKeys.map(key => context.state[key]));
  select(group, value, true);
  check(JSON.stringify(baseKeys.map(key => context.state[key])) === before, 'Only-browse preserves all base controls: ' + group);
  check(context.sidebarSelections().length === 1 && context.sidebarSelections()[0].group === group, 'Only-browse retains exactly the requested dimension: ' + group);
  check(context.state.page === 1, 'Only-browse returns to the first page: ' + group);
}
const beforeInvalid = snapshot();
check(select('unsupported', 'value', true) === false && snapshot() === beforeInvalid, 'Invalid action cannot clear filters');
check(select('design', null, true) === false && snapshot() === beforeInvalid, 'Malformed value cannot clear filters');
context.clearSidebarFilters();
check(context.sidebarSelections().length === 0 && context.state.search === 'trial' && context.state.range === '14', 'Clear sidebar retains search and time');

reset();
select('journal', 'Circulation');
select('design', 'RCT');
context.renderSidebarFilters();
const publishers = elements.publisherAccordion.innerHTML;
check(/data-filter-journal="NEJM"[^]*?class="filter-count">0<\/span>/.test(publishers), 'Zero-count journal remains selectable');
check(publishers.includes('data-browse-only="journal" data-browse-value="NEJM"'), 'Zero-count journal offers an explicit browse action');
check(/data-filter-journal="JAMA"[^]*?class="filter-count">1<\/span>/.test(publishers), 'Journal counts ignore the current source facet');
check(/data-filter-design="队列研究"[^]*?class="filter-count">1<\/span>/.test(elements.designFilterList.innerHTML), 'Design counts keep the source but ignore the current design');
check(publishers.includes('data-pub-expand=') && publishers.includes('data-filter-publisher='), 'Expand and source selection are separate controls');
context.renderActiveFilterChips(1);
check(elements.activeFiltersBar.innerHTML.includes('当前筛选 · 同时满足'), 'Current combination explicitly states intersection');
check(elements.activeFiltersBar.innerHTML.includes('期刊：Circulation') && !elements.activeFiltersBar.innerHTML.includes('出版方：'), 'A journal and its parent appear as one source chip');
check(elements.activeFiltersBar.innerHTML.includes('data-clear="sidebar"'), 'Condition bar provides a scoped clear action');
select('tier', '综合医学与其他');
check(context.matchesSidebarFilters({ cleanJournal: 'Circulation', publisher: 'AHA (Circulation)', studyDesign: 'RCT' }), 'Unclassified source group uses the same fallback as its displayed count');
select('tier', '');

select('journal', 'NEJM');
check(matches() === '', 'Incompatible dimensions yield no result instead of implicitly switching to OR');
const beforeEmpty = snapshot(), empty = context.renderEmptyFilters();
check(snapshot() === beforeEmpty, 'Rendering the empty state never relaxes conditions');
check(empty.includes('只看NEJM · 1 篇') && empty.includes('只看RCT · 2 篇'), 'Empty suggestions count each single facet within the retained base scope');
select('design', 'RCT', true);
check(matches() === 'circ-rct,jama-rct', 'Explicit only-browse widens to the requested design');

reset();
Object.assign(context.state, { search: 'trial', range: '30', reading: 'abstract', favoritesOnly: true });
select('journal', 'NEJM');
select('design', 'RCT', true);
context.syncUrl();
const url = new URL(context.window.location.href);
check(!url.searchParams.has('journal') && !url.searchParams.has('pub') && url.searchParams.get('design') === 'RCT', 'Shareable URL matches the replaced sidebar conditions');
for (const [key, value] of [['q', 'trial'], ['range', '30'], ['lane', 'cardio'], ['reading', 'abstract'], ['favorites', '1']]) {
  check(url.searchParams.get(key) === value, 'Shareable URL preserves base control: ' + key);
}
context.clearSidebarFilters();
select('design', '<script>bad</script>');
context.renderActiveFilterChips(0);
check(!elements.activeFiltersBar.innerHTML.includes('<script>') && elements.activeFiltersBar.innerHTML.includes('&lt;script&gt;'), 'URL-derived filter values are escaped');
console.log('faceted filters: ' + checks + ' assertions passed');
