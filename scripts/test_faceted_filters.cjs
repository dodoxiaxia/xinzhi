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
  journal: '', journals: [], journalTier: '', journalTierLegacy: false, studyDesign: '',
  tag: '', tags: [], topicUnclassified: false, sort: 'date-desc', viewMode: 'compact', page: 4
});
const elements = Object.fromEntries(['tierFilterList', 'publisherAccordion', 'designFilterList', 'tagsCloud', 'activeFiltersBar'].map(id => [id, { innerHTML: '' }]));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const context = vm.createContext({DEFERRED:false,partsReady:()=>true,neededParts:()=>[],
  state: initial(), expandedPublishers: new Set(), getCurrentDataset: () => papers,
  usesLane: () => true, inLane: (p, lane) => lane === 'all' || p.lane === lane,
  paperLane: p => p.lane, paperCrossAI: () => false, isCaseReport: p => p.studyDesign === '病例报告',
  exactDoi: () => '', activeDeepReadingId: '', publishedDate: p => p.date || '', curatedDay: () => '',
  queryMatches: (text, query) => text.includes(query), quicklookOf: p => p.quicklook,
  hasAbstract: p => Boolean(p.summary), datePrecision: p => p.datePrecision,
  rangeStart: () => '2026-09-26', beijingToday: () => '2026-10-09',
  $: selector => elements[selector.slice(1)], esc: escapeHtml,
  journalMetricBadge: () => '', URL, viewInUrl: false,
  window: { location: { href: 'https://example.test/?mode=candidates' } }
});
context.history = { state: null, replaceState: (_state, _title, url) => { context.history.state = _state; context.window.location.href = new URL(url, context.window.location.href).href; } };
vm.runInContext([
  'paperTopicTags', 'parseTopicParams', 'selectedTags', 'isTopicUnclassified', 'hasTopicFilter',
  'publisherForJournal', 'sidebarSelections', 'clearSidebarFilters', 'selectSidebarFilter',
  'browseOnlyButton', 'foldSearch', 'paperDerived', 'paperSearchText', 'matchesQuery', 'selectedJournals', 'sidebarMisses', 'matchesSidebarFilters', 'matchesFilters',
  'renderSidebarFilters', 'renderActiveFilterChips', 'renderEmptyFilters', 'syncUrl', 'defaultRange'
].map(fn).join('\n') + '\n'
  + source.match(/  const TOPIC_TAGS = \[[^]*?\n  \];/)[0] + '\n'
  + ['UNCLASSIFIED_TOPIC', 'PAPER_DERIVED', 'FACET_BITS', 'SEARCH_APOSTROPHES', 'SEARCH_QUOTES'].map(name => source.match(new RegExp('  const ' + name + ' = [^\\n]+'))[0]).join('\n'), context);
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
check(context.state.journal === 'Circulation' && context.selectedJournals().join() === 'Circulation' && !context.state.publisher, 'Selected journal is recorded without inventing a publisher');
select('journal', 'JAMA');
check(matches() === 'circ-rct,jama-rct', 'Adding a second journal unions the sources and retains study design');
check(context.selectedJournals().slice().sort().join() === 'Circulation,JAMA' && !context.state.publisher, 'Journals can be combined and do not keep a parent publisher');
select('journal', 'JAMA');
check(context.selectedJournals().join() === 'Circulation' && context.state.journal === 'Circulation' && !context.state.publisher && matches() === 'circ-rct', 'Clicking an already selected journal toggles only that journal off while retaining design');
select('design', 'RCT');
check(context.state.studyDesign === 'RCT', 'Clicking the selected design retains it');
select('pub', 'AHA (Circulation)');
check(!context.state.journal && matches() === 'circ-rct', 'Choosing a publisher replaces the child journal');
select('design', '队列研究');
check(matches() === 'circ-cohort', 'Changing a design replaces it without broadening the source');
select('design', '');
check(matches() === 'circ-rct,circ-cohort', 'All designs clears only the design dimension');
select('pub', '');
check(!context.state.publisher && !context.state.journal && !context.selectedJournals().length && matches().split(',').length === 4, 'Removing the publisher source clears it and leaves the base scope');

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
const chipClass = (html, attr, value) => (html.match(new RegExp('class="([^"]*)"[^>]*' + attr + '="' + value + '"')) || [])[1] || '';
check(chipClass(publishers, 'data-filter-journal', 'NEJM').includes('is-empty'), 'Zero-result journal remains selectable but is dimmed');
check(!publishers.includes('filter-count') && !elements.tierFilterList.innerHTML.includes('filter-count') && !elements.designFilterList.innerHTML.includes('filter-count'), 'Panel chips show no numbers');
check(!chipClass(publishers, 'data-filter-journal', 'JAMA').includes('is-empty'), 'Journal availability ignores the current source facet');
check(!chipClass(elements.designFilterList.innerHTML, 'data-filter-design', '队列研究').includes('is-empty'), 'Design availability keeps the source but ignores the current design');
check(publishers.includes('data-pub-expand=') && publishers.includes('data-filter-publisher='), 'Expand and source selection are separate controls');
context.renderActiveFilterChips(1);
check(!elements.activeFiltersBar.innerHTML.includes('当前筛选'), 'Condition bar carries no explanatory label');
check(context.sidebarSelections().some(s => s.group === 'journal' && s.value === 'Circulation') && !context.sidebarSelections().some(s => s.group === 'pub'), 'A selected journal is the source condition; its publisher is not a second condition');
check(context.sidebarSelections().some(s => s.group === 'design' && s.value === 'RCT'), 'Study design remains a listed condition');
select('tier', '综合医学与其他');
check(context.matchesSidebarFilters({ cleanJournal: 'Circulation', publisher: 'AHA (Circulation)', studyDesign: 'RCT' }), 'Unclassified source group uses the same fallback as its displayed count');
select('tier', '');

select('journal', 'NEJM', true);
select('design', 'RCT');
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
context.renderSidebarFilters();
context.renderActiveFilterChips(0);
const panelHtml = [elements.tierFilterList, elements.publisherAccordion, elements.designFilterList, elements.tagsCloud, elements.activeFiltersBar].map(el => el.innerHTML).join('\n');
check(!panelHtml.includes('<script>'), 'Sidebar and condition bar do not interpolate unsanitized markup');

reset();
Object.assign(context.state, { favoritesOnly: true, favoriteJournals: [], search: '', mode: 'candidates' });
const followEmpty = context.renderEmptyFilters();
check(followEmpty.includes('还没有关注期刊，点期刊名旁的 ☆ 关注'), 'Zero followed journals explains how to follow, rather than a generic empty list');
check(!followEmpty.includes('当前领域、时间、关键词与筛选条件下暂无匹配'), 'Zero-follow empty state does not use the generic no-match copy');

// Article topic multi-select OR, uncategorized mutual exclusion, cross-axis AND, unknown tags, and URL serialization
papers.push(
  paper('untagged-cohort', 'Circulation', 'AHA (Circulation)', '队列研究', { tags: [] }),
  paper('af-hf-rct', 'Circulation', 'AHA (Circulation)', 'RCT', { tags: ['#房颤/电生理', '#心衰/心肌'] }),
  paper('ai-ecg-cohort', 'NEJM', 'MMS (NEJM)', '队列研究', { tags: ['#AI-ECG', '#大模型/NLP'] }),
  paper('bad-tag-rct', 'JAMA', 'JAMA Network', 'RCT', { tags: ['no-hash', '  #未知自定义  ', 123] })
);
reset();
select('tag', '#房颤/电生理');
select('tag', '#AI-ECG');
check(matches() === 'af-hf-rct,ai-ecg-cohort', 'Multiple selected article topics use OR on the topic axis');
check(context.selectedTags().join(',') === '#房颤/电生理,#AI-ECG' && !context.isTopicUnclassified(), 'Selected tags hold multiple topics without uncategorized');
select('design', '队列研究');
check(matches() === 'ai-ecg-cohort', 'Multi-topic OR intersects with studyDesign via AND');
select('tag', 'uncategorized');
check(matches() === 'untagged-cohort', 'Selecting uncategorized clears specific tags and intersects with design');
check(context.selectedTags().length === 0 && context.isTopicUnclassified() === true, 'Uncategorized is mutually exclusive with specific tags');
select('tag', '#AI-ECG');
check(matches() === 'ai-ecg-cohort' && !context.isTopicUnclassified(), 'Selecting a specific tag clears uncategorized');
select('tag', '');
check(!context.hasTopicFilter() && context.state.studyDesign === '队列研究', 'Clearing topic removes topic condition while keeping design filter');
{
  const afterClear = matches().split(',').filter(Boolean);
  const designed = papers.filter(p => p.studyDesign === context.state.studyDesign).map(p => p.id);
  check(afterClear.every(id => designed.includes(id)) && afterClear.includes('untagged-cohort') && afterClear.includes('ai-ecg-cohort') && !afterClear.includes('bad-tag-rct'), 'Same-fixture papers keep the remaining design after topics are cleared; a different design is excluded');
}

reset();
check(context.paperTopicTags({ tags: ['bad', ' #未知自定义 ', '#未知自定义', 42, '#影像'] }).join(',') === '#未知自定义,#影像', 'Malformed non-# values are ignored safely and valid # tags deduplicated');
select('tag', '#未知自定义');
check(matches() === 'bad-tag-rct', 'Unknown #-prefixed tags can still match safely without colliding with journal or disease tiers');
select('tag', '');
select('tag', 'uncategorized');
check(matches() === 'untagged-cohort', 'Papers with only unknown #-prefixed tags are not treated as untagged');

reset();
select('tag', '#房颤/电生理');
select('tag', '#大模型/NLP');
context.syncUrl();
let topicUrl = new URL(context.window.location.href);
check(topicUrl.searchParams.get('tags') === '#房颤/电生理,#大模型/NLP' && !topicUrl.searchParams.has('tag'), 'Multiple topics serialize to ?tags= comma list');
select('tag', '#大模型/NLP');
context.syncUrl();
topicUrl = new URL(context.window.location.href);
check(topicUrl.searchParams.get('tag') === '#房颤/电生理' && !topicUrl.searchParams.has('tags'), 'Single topic serializes to ?tag= for legacy compatibility');
select('tag', 'uncategorized');
context.syncUrl();
topicUrl = new URL(context.window.location.href);
check(topicUrl.searchParams.get('tags') === 'uncategorized' && !topicUrl.searchParams.has('tag'), 'Uncategorized serializes to ?tags=uncategorized');
const pSingle = context.parseTopicParams('#心电', '');
check(pSingle.tags.join(',') === '#心电' && pSingle.tag === '#心电' && !pSingle.topicUnclassified, 'Legacy ?tag= parses into topic state');
const pMulti = context.parseTopicParams('', '#房颤/电生理,#AI-ECG');
check(pMulti.tags.join(',') === '#房颤/电生理,#AI-ECG' && !pMulti.topicUnclassified, 'Multi ?tags= parses into tags array');
const pUncat = context.parseTopicParams('', 'uncategorized');
check(pUncat.tags.length === 0 && pUncat.topicUnclassified === true, 'Uncategorized URL param parses cleanly');

console.log('faceted filters: ' + checks + ' assertions passed');
