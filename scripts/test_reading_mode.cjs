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

if (process.argv.includes('--public')) {
  const publicRoot = path.join(__dirname, '../public');
  const readPublic = name => fs.readFileSync(path.join(publicRoot, name), 'utf8');
  const html = readPublic('index.html');
  const app = readPublic(html.match(/src="(assets\/app\.[a-f0-9]+\.js)"/)[1]);
  const globalData = (source, key) => JSON.parse(source.match(new RegExp('^window\\.' + key + '=(.*);$', 'm'))[1]);
  const { parts } = globalData(app, 'XINZHI_PARTS');
  const part = name => {
    const prefix = 'window.XINZHI_PART&&window.XINZHI_PART(' + JSON.stringify(name) + ',';
    const source = readPublic(parts[name].src);
    assert(source.startsWith(prefix) && source.endsWith(');'), 'Unexpected built data part: ' + name);
    return JSON.parse(source.slice(prefix.length, -2));
  };
  const archive = globalData(readPublic(globalData(app, 'RADAR_SRC')), 'RADAR_ARCHIVE');
  const records = [
    ...globalData(app, 'CURATED'), ...globalData(app, 'FEEDS').items, ...part('feeds').items,
    ...part('library').papers, ...(part('board')?.items || [])
  ];
  const radarIds = [...(part('radar')?.rows || []), ...archive.rows].map(row => 'pmid-' + row[0]);
  const ids = new Set([...records.map(paper => paper.id), ...radarIds]);
  assert(ids.size > 0, 'The built offline dataset must contain paper IDs');
  for (const id of ids) {
    assert.equal(typeof id, 'string', 'Expected a string paper ID: ' + id);
    assert.equal(parseReadingPaper(new URLSearchParams({ paper: id })), id, 'Built paper ID rejected: ' + id);
  }
  console.log('PASS reading mode whitelist for ' + ids.size + ' unique built paper IDs');
}
