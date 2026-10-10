'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const start = source.indexOf('  function expandRadar(');
const end = source.indexOf('  CURATED.forEach(normalizePaper);', start);
assert(start >= 0 && end > start, 'exercise the actual archive expansion code');
const code = source.slice(start, end);
const official = '期刊官网 published-online（已复核）';
const fallback = 'PubMed 电子/刊期日期';
const rows = [
  ['42832198', '10.1001/jamanetworkopen.2026.37533', '2026-10-05', 0, 0, 0, 0, [], 'Reviewed date'],
  ['42', '10.1000/other', '2026-10-01', 0, 0, 0, 0, [], 'Other article']
];
function expand(extra = {}) {
  const feeds = { items: [] };
  const context = vm.createContext({
    window: { RADAR: { rows, jn: ['JAMA Network Open'], pub: ['JAMA'], tier: ['Cardiology'], design: ['Cohort'], tag: [], ...extra } },
    FEEDS: feeds, normalizePaper() {}
  });
  vm.runInContext(code, context);
  return feeds.items;
}

const corrected = expand({ dateBases: { '42832198': official } });
assert.equal(corrected[0].dateBasis, official);
assert.equal(corrected[0].date, '2026-10-05');
assert.equal(corrected[1].dateBasis, fallback);
assert.equal(corrected[1].date, '2026-10-01');
const oldBundle = expand();
assert.equal(oldBundle[0].dateBasis, fallback);
assert.equal(oldBundle[1].dateBasis, fallback);
for (const value of [null, 42, '']) {
  assert.equal(expand({ dateBases: { '42832198': value } })[0].dateBasis, fallback);
}
console.log('publication date UI: 10 assertions passed');
