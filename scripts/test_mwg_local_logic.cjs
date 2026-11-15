'use strict';
// Run the actual URL reader and delegated TOC handler against small fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = process.env.XINZHI_TEST_ASSET_ROOT || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/app/01-state-helpers.js'), 'utf8');
const helpers = source.slice(source.indexOf('  const validView'), source.indexOf('  const URL_STATE_KEYS'));
const context = vm.createContext({ URLSearchParams, safeGet: () => null });
vm.runInContext(helpers + '\nthis.read = readStateFromUrl;', context);
const cases = [
  ['?journals=100%25', ['100%']],
  ['?journals=bad%ZZ', ['bad%ZZ']],
  ['?journals=%E0%A4%A', ['�%A']],
  ['?journals=Nature%2520Medicine,Circulation', ['Nature Medicine', 'Circulation']],
  ['?journals=Nature%20Medicine,Circulation', ['Nature Medicine', 'Circulation']],
  ['?journals=Circulation,,Circulation', ['Circulation']],
  ['?journal=Legacy&journals=Circulation,Legacy', ['Circulation', 'Legacy']],
  ['?journal=Legacy&journals=Circulation', ['Legacy', 'Circulation']],
  ['?journal=100%25', ['100%']],
];
for (const [query, expected] of cases) {
  assert.deepEqual(Array.from(context.read(query).journals), expected, query);
}
// Same decoded comma-list representation as syncUrl: filters survive a reload.
for (const journals of [['100%', 'Circulation'], ['Nature Medicine', 'Circulation']]) {
  const params = new URLSearchParams({journals:journals.join(',')});
  assert.deepEqual(Array.from(context.read('?' + params).journals), journals);
}
const browse = fs.readFileSync(path.join(root, 'src/app/10-browse-events.js'), 'utf8');
const handler = browse.slice(browse.indexOf('    const tocTarget ='), browse.indexOf('    const sourceFilter ='));
for (const reduced of [true, false]) {
  let options;
  const body = {scrollTop: 35, getBoundingClientRect: () => ({top: 10}), scrollTo: value => {options = value;}};
  const target = {getBoundingClientRect: () => ({top: 100})};
  const ctx = vm.createContext({
    e: {target: {closest: () => ({dataset: {tocTarget:'section'}})}},
    $: () => body,
    document: {getElementById: () => target},
    window: {matchMedia: query => {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return {matches: reduced};
    }},
  });
  vm.runInContext('(function(){' + handler + '})()', ctx);
  assert.equal(options.behavior, reduced ? 'instant' : 'smooth');
  assert.equal(options.top, 113, 'preserve section offset');
}
console.log('PASS: URL literal %, malformed escapes, legacy encoding, deduplication, singular priority, reload; TOC reduced/default motion');

// Test focus lifecycle against replaced DOM nodes, including a pointer return to
// the same trigger. Native Tab order and computed colors are covered in the UI test.
const filters = fs.readFileSync(path.join(root, 'src/app/09z-quick-filters.js'), 'utf8');
const listeners = {};
const doc = {activeElement: null, addEventListener: (type, fn) => {listeners[type] = fn;}};
let controls = [], anchor;
function focus(el) {
  const previous = doc.activeElement;
  doc.activeElement = el;
  if (previous) listeners.focusout?.({target: previous, relatedTarget: el});
}
function control(id, dataset = {}) { return {id, dataset, hidden:false, focus() {focus(this);}}; }
const pop = {
  hidden: true,
  classList: {remove() {}},
  contains: el => controls.includes(el),
  querySelectorAll: () => controls,
  querySelector: selector => controls.find(el => '#' + el.id === selector),
  set innerHTML(value) { controls = value ? [control('close', {qfClose:'1'}), control('option', {qfRange:'30'})] : []; },
};
anchor = control('anchor');
const outside = control('outside');
const focusContext = vm.createContext({
  document: doc,
  $: selector => selector === '#qfPop' ? pop : selector === '#qfJournalSearch' ? null : selector === '#qfBackdrop' ? {hidden:true} : anchor,
  $$: () => [],
  qfPopHtml: () => 'fixture controls',
  qfOpen: null,
});
const lifecycle = filters.slice(filters.indexOf('  function qfAnchor('), filters.indexOf('  function qfPopHtml('));
const events = filters.slice(filters.indexOf('  let qfTabbing'), filters.indexOf("  window.addEventListener('resize', () => {", filters.indexOf('  let qfTabbing')));
vm.runInContext(lifecycle + '\nplaceQfPop = () => {};\n' + events, focusContext);
vm.runInContext("openQfPop('more')", focusContext);
assert.equal(doc.activeElement, controls[0], 'new non-search panel focuses close button');
focus(controls[1]);
const oldOption = doc.activeElement;
anchor = control('new-anchor'); // renderQuickFilters also replaces the opener.
vm.runInContext("openQfPop('more', true)", focusContext);
assert.notEqual(doc.activeElement, oldOption);
assert.equal(doc.activeElement, controls[1], 'rerender preserves corresponding selection focus');
listeners.keydown({key:'Escape', preventDefault() {}});
assert.equal(doc.activeElement, anchor, 'Escape resolves the current opener node');
vm.runInContext("openQfPop('more')", focusContext);
listeners.keydown({key:'Tab', shiftKey: true});
listeners.pointerdown?.();
focus(anchor);
assert(focusContext.qfOpen, 'pointer return to trigger after pointerdown preserves open state until click toggles');
vm.runInContext('closeQfPop()', focusContext);
assert.equal(focusContext.qfOpen, null);
vm.runInContext("openQfPop('more')", focusContext);
listeners.keydown({key:'Tab', shiftKey: true});
focus(anchor);
assert.equal(focusContext.qfOpen, null, 'Shift+Tab onto trigger still dismisses non-modal panel');
for (const shiftKey of [false, true]) {
  vm.runInContext("openQfPop('more')", focusContext);
  listeners.keydown({key:'Tab', shiftKey});
  focus(outside);
  assert.equal(focusContext.qfOpen, null, 'Tab leaves panel and dismisses');
  assert.equal(doc.activeElement, outside, 'no focus trap');
}
vm.runInContext("openQfPop('more')", focusContext);
focus(outside);
assert.equal(doc.activeElement, outside, 'external focus is not stolen');
assert.equal(focusContext.qfOpen, null);
console.log('PASS: filter initial focus, rerender, Escape return, trigger pointer toggle, Tab exit, outside focus');

// Following a journal only refreshes the list, so that path must retain focus too.
const list = {
  contains: el => controls.includes(el),
  querySelectorAll: () => controls,
  set innerHTML(value) { controls = [control('follow', {qfFollow:'Circulation'})]; },
};
focusContext.$ = selector => selector === '#qfJournalList' ? list : pop;
focusContext.qfOpen = {kind:'jtier:cardioMain', query:''};
focusContext.journalListHtml = () => 'fixture';
list.innerHTML = 'fixture';
doc.activeElement = controls[0];
const oldFollow = doc.activeElement;
const refresh = filters.slice(filters.indexOf('  function refreshJournalList('), filters.indexOf('  function specialtyPopHtml('));
vm.runInContext(refresh + '\nrefreshJournalList();', focusContext);
assert.notEqual(doc.activeElement, oldFollow);
assert.equal(doc.activeElement, controls[0], 'follow refresh preserves keyboard focus');
console.log('PASS: journal follow list refresh keeps focus');
