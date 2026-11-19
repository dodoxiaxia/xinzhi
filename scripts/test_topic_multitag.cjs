'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const fn = name => {
  const pattern = name === 'defaultRange' ? '  function defaultRange[^\n]+' : '  function ' + name + '\\([^]*?\n  }';
  const match = source.match(new RegExp(pattern));
  assert(match, name);
  return match[0];
};
const initial = () => ({
  mode: 'library', lane: 'cardio', range: '14', search: '', clinicalTier: '',
  publisher: '', studyDesign: '', favoriteJournals: [], reading: '', ftFilter: '',
  tag: '', tags: [], tagMode: 'any', topicUnclassified: false,
  journals: [], journal: '', journalTier: '', sort: 'date-desc'
});
const A = '#房颤/电生理', B = '#AI-ECG', C = '#心衰/心肌', EXTRA = '#夹具主题';
const row = (id, tags, extra = {}) => ({
  id, tags, title: 'Trial ' + id, date: '2026-11-19', datePrecision: 'day',
  journal: 'Circulation', clinicalTier: '心血管旗舰顶刊', studyDesign: 'RCT',
  publisher: 'AHA', lane: 'cardio', status: 'ready', ...extra
});
const papers = [
  row('a', [A]), row('b', [B]), row('ab', [A, B]), row('abc', [A, B, C, EXTRA]),
  row('none', ['invalid', null]), row('general', [A, B], {journal: 'The BMJ'}),
  row('cohort', [A, B], {studyDesign: '队列研究'}), row('old', [A, B], {date: '2026-09-01'}),
  row('other-source', [A, B], {clinicalTier: '顶级综合与科学', publisher: 'BMJ'}),
  row('other-lane', [A, B], {lane: 'general'}), row('other-search', [A, B], {title: 'Other'}),
  row('no-fulltext', [A, B], {status: 'none'})
];
const context = vm.createContext({
  URL, URLSearchParams, state: initial(), viewInUrl: false, CURRENT: papers,
  window: {location: {href: 'https://example.test/?mode=library', search: '?mode=library'}},
  history: {replaceState(_state, _title, url) { context.window.location.href = new URL(url, context.window.location.href).href; }},
  VALID_MODES: ['library', 'curated', 'weekly', 'candidates'], safeGet: () => '',
  validView: () => false, parseJournalList: (journals, journal) => journals ? journals.split(',') : journal ? [journal] : [],
  usesLane: () => ['library', 'candidates'].includes(context.state.mode), inLane: (p, lane) => lane === p.lane,
  datePrecision: p => p.datePrecision, rangeStart: () => '2026-11-06', beijingToday: () => '2026-11-19',
  exactDoi: () => '', activeDeepReadingId: '', richRank: () => 0,
  getCurrentDataset: () => context.CURRENT, qfPapers: () => context.CURRENT,
  expandedPublishers: new Set(), matchesQuery: p => p.title.toLowerCase().includes(context.state.search),
  isCaseReport: () => false, hasAbstract: p => Boolean(p.summary), quicklookOf: p => p.quicklook,
  fulltextFilterBucket: p => p.status, getCuratedList: () => context.CURRENT, publishedDate: p => p.date,
  paperTierId: p => p.journal === 'Circulation' ? 'cardioClinical' : 'generalMedicine',
  esc: s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
});
context.paperMatchesJournalFilter = p => {
  const js = context.selectedJournals();
  return js.length ? js.includes(p.journal) : !context.state.journalTier || context.paperTierId(p) === context.state.journalTier;
};
const constants = [
  ...['TOPIC_TAGS', 'TOPIC_GROUPS'].map(name => source.match(new RegExp('  const ' + name + ' = \\[[^]*?\n  \\];'))[0]),
  ...['UNCLASSIFIED_TOPIC', 'FACET_BITS'].map(name => source.match(new RegExp('  const ' + name + ' = [^\n]+'))[0])
];
vm.runInContext(constants.join('\n') + '\n' + [
  'defaultRange', 'paperTopicTags', 'parseTopicParams', 'readStateFromUrl', 'selectedTags', 'isTopicUnclassified',
  'normalizeTagMode', 'topicToggle', 'paperMatchesTopics', 'curatedDays', 'curatedDay', 'topicResultCount',
  'topicOptionCounts', 'topicGroupsFor', 'topicPickerHtml', 'topicBadgeHtml', 'selectedJournals',
  'sidebarMisses', 'matchesSidebarFilters', 'matchesFilters', 'selectSidebarFilter', 'clearSidebarFilters',
  'getFilteredArticles', 'syncUrl', 'qfSnapshot', 'qfRestore', 'quickTierResultCounts', 'selectWholeTier'
].map(fn).join('\n'), context);
const sorted = items => Array.from(items).sort();
const groups = vm.runInContext('TOPIC_GROUPS', context);
const keys = vm.runInContext('TOPIC_TAGS', context);
assert.deepEqual(sorted(groups.flatMap(([, tags]) => tags)), sorted(keys));
assert.deepEqual(sorted(context.topicGroupsFor([], [EXTRA]).at(-1)[1]), [EXTRA]);
assert.equal(context.topicGroupsFor(papers, []).at(-1)[0], '其他');

const articleTags = p => (Array.isArray(p.tags) ? p.tags : []).filter(t => typeof t === 'string' && t.startsWith('#'));
for (const mode of ['any', 'all']) {
  for (const tags of [[], [A], [A, B], [A, B, C]]) {
    for (const paper of papers) {
      const hits = tags.filter(t => articleTags(paper).includes(t)).length;
      assert.equal(context.paperMatchesTopics(paper, tags, mode), !tags.length || (mode === 'all' ? hits === tags.length : hits > 0));
    }
  }
}
assert.equal(context.paperMatchesTopics(row('bad', [' ', 8]), ['uncategorized'], 'all'), true);
assert.equal(context.paperMatchesTopics(papers[0], ['uncategorized'], 'any'), false);
assert.equal(context.paperMatchesTopics(papers[0], [A, B], 'xyz'), true);

const tagUrl = (tags, mode) => new URLSearchParams({mode: 'library', view: 'cards', ...tags, ...(mode ? {tagmode: mode} : {})});
for (const [input, mode, expectedTags, unclassified, resultMode] of [
  [{tag: A}, '', [A], false, 'any'],
  [{tags: [A, B].join(',')}, '', [A, B], false, 'any'],
  [{tags: [A, B].join(',')}, 'xyz', [A, B], false, 'any'],
  [{tags: [A, B].join(',')}, 'all', [A, B], false, 'all'],
  [{tag: A}, 'all', [A], false, 'all'],
  [{}, 'all', [], false, 'all'],
  [{tags: 'uncategorized'}, 'all', [], true, 'any'],
  [{tags: 'uncategorized,' + A}, 'all', [A], false, 'all']
]) {
  const params = tagUrl(input, mode);
  context.window.location.href = 'https://example.test/?' + params;
  context.state = context.readStateFromUrl('?' + params);
  const topic = state => [Array.from(state.tags), state.topicUnclassified, state.tagMode];
  assert.deepEqual(topic(context.state), [expectedTags, unclassified, resultMode]);
  context.syncUrl();
  const url = new URL(context.window.location.href);
  assert.equal(url.searchParams.get('tagmode'), resultMode === 'all' ? 'all' : null);
  assert.deepEqual(topic(context.readStateFromUrl(url.search)), topic(context.state));
}
context.state = {...initial(), tagMode: 'all', tags: [A, B], journalTier: 'cardioClinical'};
const saved = context.qfSnapshot();
context.qfRestore({...saved, tagMode: undefined});
assert.equal(context.state.tagMode, 'any');
context.qfRestore(saved);
assert.equal(context.state.tagMode, 'all');
assert.deepEqual(sorted(context.selectedTags()), sorted([A, B]));
context.selectSidebarFilter('tag', 'uncategorized');
assert.equal(context.state.tagMode, 'any');
assert.deepEqual(sorted(context.selectedTags()), []);
context.qfRestore({...saved, topicUnclassified: true});
assert.equal(context.state.tagMode, 'any');
assert.deepEqual(sorted(context.selectedTags()), []);
context.qfRestore(saved);
context.clearSidebarFilters();
assert.equal(context.state.tagMode, 'any');

const filtered = () => sorted(context.getFilteredArticles().map(p => p.id));
context.state = {...initial(), search: 'trial', tags: [A, B], tagMode: 'all', clinicalTier: '心血管旗舰顶刊',
  studyDesign: 'RCT', ftFilter: 'ready', journalTier: 'cardioClinical'};
assert.deepEqual(filtered(), ['ab', 'abc']);
context.state.tagMode = 'any';
assert.deepEqual(filtered(), ['a', 'ab', 'abc', 'b']);
context.selectWholeTier('generalMedicine');
assert.deepEqual(filtered(), ['general']);
assert.equal(context.selectedTags().length, 2);
context.selectSidebarFilter('journal', 'Circulation');
assert.deepEqual(filtered(), ['a', 'ab', 'abc', 'b']);
context.selectWholeTier('generalMedicine');
context.selectWholeTier('generalMedicine');
context.selectSidebarFilter('pub', 'BMJ');
assert.deepEqual(filtered(), []);
context.selectSidebarFilter('tier', '');
assert.deepEqual(filtered(), ['other-source']);

let clicks = 0;
let zero = false;
function verifyOptions(seed) {
  context.state = structuredClone(seed);
  const scoped = papers.filter(p => context.matchesFilters(p, false, 'tag'));
  const html = context.topicPickerHtml(scoped);
  const options = [...html.matchAll(/<button[^>]*class="([^"]+)" data-qf-topic(-all|-unclassified|-mode)?="([^"]+)"[^>]*>(?:[^<]*|<span>[^<]*<\/span> )<small>(\d+)<\/small>/g)];
  assert(options.length >= keys.length + 4);
  for (const [, classes, kind, value, rawCount] of options) {
    if (kind === '-mode' && seed.topicUnclassified) continue;
    context.state = structuredClone(seed);
    if (kind === '-mode') context.state.tagMode = value;
    else context.selectSidebarFilter('tag', kind === '-all' ? '' : kind === '-unclassified' ? 'uncategorized' : value);
    const count = Number(rawCount);
    assert.equal(count, filtered().length, JSON.stringify({seed, kind, value}));
    assert.equal(classes.includes('is-empty'), count === 0);
    zero ||= count === 0;
    clicks++;
  }
}
for (const mode of ['any', 'all']) {
  for (const journalTier of ['', 'cardioClinical']) {
    const seed = {...initial(), tags: [A, B], tagMode: mode, journalTier};
    verifyOptions(seed);
    context.state = structuredClone(seed);
    const counts = context.quickTierResultCounts();
    for (const tier of ['cardioClinical', 'generalMedicine']) {
      context.state = structuredClone(seed);
      context.selectWholeTier(tier);
      assert.equal(counts.get(tier) || 0, filtered().length, 'Tier chip click includes topics');
    }
  }
}
verifyOptions({...initial(), topicUnclassified: true});
verifyOptions({...initial(), mode: 'curated', day: '2026-09-01', tags: [A], tagMode: 'all'});
assert(zero, 'A legal zero-count option is styled and still selectable');
assert.equal(context.topicBadgeHtml(row('untagged', [])), '');
const badgeHtml = context.topicBadgeHtml(papers.find(p => p.id === 'abc'));
assert.equal((badgeHtml.match(/data-filter-tag=/g) || []).length, 3);
assert(badgeHtml.includes('+1') && !badgeHtml.includes(EXTRA));
console.log(`topic multitag: ${clicks} option predictions matched actual lists (OR/AND, with/without a tier, uncategorized, curated date fallback); legal zero verified`);
