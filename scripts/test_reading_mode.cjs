'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/app/06b-reading-mode.js'), 'utf8');
const context = vm.createContext({ URLSearchParams });
for (const name of ['parseReadingPaper', 'readingNeighbors']) {
  const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  }'));
  assert(match, 'Missing reading mode helper: ' + name);
  vm.runInContext(match[0], context);
}

const { parseReadingPaper, readingNeighbors } = context;
assert.equal(parseReadingPaper('?mode=library&id=a'), undefined);
assert.equal(parseReadingPaper('?read=demo-tailored-af&paper=pmid-42808215'), 'pmid-42808215');
assert.equal(parseReadingPaper('?paper=doi-0123456789abcdef'), 'doi-0123456789abcdef');
for (const query of ['?paper', '?paper=', '?paper=%20', '?paper=valid%0A',
  '?paper=' + 'a'.repeat(161), '?paper=' + encodeURIComponent('<script>alert(1)</script>'),
  '?paper=first&paper=second', '?paper=first&paper=first']) {
  assert.equal(parseReadingPaper(query), null, query);
}

const first = { id: 'z' }, middle = { id: 'a' }, last = { id: 'b' };
const results = [first, middle, last]; // Deliberately different from ID order.
assert.equal(readingNeighbors([], first.id), null);
assert.equal(readingNeighbors(results, 'outside-filter'), null);
for (const [input, paper, position, previous, next] of [
  [[middle], middle, 1, null, null],
  [results, first, 1, null, middle],
  [results, middle, 2, first, last],
  [results, last, 3, middle, null],
]) {
  const result = readingNeighbors(input, paper.id);
  assert.equal(result.total, input.length);
  assert.equal(result.position, position);
  assert.equal(result.previous, previous);
  assert.equal(result.next, next);
}
console.log('PASS reading mode paper validation and filtered sequence');
