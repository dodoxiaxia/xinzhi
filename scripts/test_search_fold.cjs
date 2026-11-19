'use strict';
// Search folds typographic apostrophes and quotation marks on both sides, so a keyboard
// "Can't" finds the journal's "Can’t" and the reverse. Runs the real helpers from app.js.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const fn = n => { const m = src.match(new RegExp('  function ' + n + '\\([^]*?\\n  }')); if (!m) throw Error(n); return m[0]; };
const line = n => { const m = src.match(new RegExp('  const ' + n + ' =[^]*?;')); if (!m) throw Error(n); return m[0]; };
const ctx = vm.createContext({ state: { search: '' }, quicklookOf: () => null });
vm.runInContext([line('ZH_EN'), line('zhTerms'), line('SEARCH_APOSTROPHES'), line('SEARCH_QUOTES'), line('PAPER_DERIVED'),
  ...['foldSearch', 'queryMatches', 'paperDerived', 'paperSearchText', 'matchesQuery'].map(fn)].join('\n'), ctx);

let checks = 0;
const ok = (value, label) => { assert(value, label); checks++; };
const hit = (paper, query) => { ctx.state.search = query; return ctx.matchesQuery(paper); };

// Every spelling in these tables must find every other spelling; expectations come from the tables.
const apostrophes = ['\u2019', '\u2018', '\u02BC', '\u2032', '\u201B', '\uFF07', "'"];
const quotes = ['\u201C', '\u201D', '\u201E', '\u201F', '\u2033', '"'];

for (const a of apostrophes) {
  const paper = { id: 'a' + a.codePointAt(0), title: `What the Robot Still Can${a}t Do`, doi: '10.1056/nejmp2606894' };
  for (const b of apostrophes) {
    ok(hit(paper, `Can${b}t`), `title ${a.codePointAt(0).toString(16)} / query ${b.codePointAt(0).toString(16)}`);
    ok(hit(paper, `robot still can${b}t do`), 'whole phrase');
  }
}

// The same paper object searched with both spellings in turn: the per-paper cache must not leak.
const cached = { id: 'cache', title: 'What the Robot Still Can\u2019t Do' };
for (const q of ["Can't", 'Can\u2019t', 'Can\u2018t', "Can't"]) ok(hit(cached, q), 'cache ' + q);
ok(!hit(cached, 'Cannot'), 'cache after hits still rejects a different word');

for (const q1 of quotes) for (const q2 of quotes) {
  const paper = { id: 'q', title: `The ${q1}Obesity Paradox${q2} Revisited` };
  for (const k1 of quotes) for (const k2 of quotes) ok(hit(paper, `${k1}obesity paradox${k2}`), 'quotes');
}

// Case still folds; the fold applies to the abstract and to author names as well.
ok(hit({ id: 'c', title: "what can't wait" }, 'CAN\u2019T'), 'upper-case curly query');
ok(hit({ id: 'ab', title: 'x', summary: 'Patients\u2019 own choices matter' }, "patients' own"), 'abstract text folded');
ok(hit({ id: 'au', title: 'x', authors: ["Conor O\u2019Brien"] }, "o'brien"), 'author folded');

// Negatives: the apostrophe is mapped, never deleted or turned into a space.
const robot = { id: 'n', title: 'What the Robot Still Can\u2019t Do' };
for (const q of ['Cant', 'Can-t', 'Cannot']) ok(!hit(robot, q), 'must not match ' + q);
ok(!hit({ id: 'n2', title: 'Doctors cannot wait' }, "Can't"), "Can't does not match cannot");
ok(!hit(robot, 'robot unrelated'), 'unrelated word still misses');

// Existing behaviour is unchanged: Chinese expansion and multi-term AND.
ok(ctx.queryMatches('atrial fibrillation ablation', '房颤消融'), 'zh expansion');
ok(!ctx.queryMatches('atrial fibrillation', '房颤消融'), 'zh expansion needs every part');
ok(hit({ id: 'zh', title: 'Atrial fibrillation ablation outcomes' }, '房颤 消融'), 'zh through matchesQuery');
ok(!hit({ id: 'zh2', title: 'Atrial fibrillation outcomes' }, '房颤 消融'), 'zh AND through matchesQuery');

// foldSearch itself: apostrophes/quotes mapped, others untouched, null-safe.
ok(ctx.foldSearch(null) === '' && ctx.foldSearch(undefined) === '', 'null safe');
ok(ctx.foldSearch('A\u2019B\u201CC\u201D') === 'a\'b"c"', 'fold result');
ok(ctx.foldSearch('a-b \u2013 c') === 'a-b \u2013 c', 'dashes untouched');
console.log(JSON.stringify({ passed: true, checks }));
