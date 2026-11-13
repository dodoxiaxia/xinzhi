const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const match = src.match(/  function abstractMayBeIncomplete\([^]*?\n  }/);
assert(match, 'abstractMayBeIncomplete must exist in app.js');
const context = vm.createContext({});
vm.runInContext(match[0], context);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/complete-abstracts-30.json'), 'utf8'));
assert.strictEqual(fixture.papers.length, 30, 'fixture contains 30 complete abstracts');
const falsePositives = fixture.papers.filter(paper => context.abstractMayBeIncomplete(paper));
assert.deepStrictEqual(falsePositives.map(paper => paper.doi), [], 'complete abstracts flagged as incomplete (DOIs)');
assert.strictEqual(context.abstractMayBeIncomplete({
  summary: 'These findings support community-based hypertension care with task-sharing to trained community health workers as a promising approach to maintaining blood pressure control, especially in settings with limited access to physician-led and nurse-led hypertension care.'
}), true, 'Lesotho conclusion-only summary remains incomplete');
console.log('30 complete abstracts and Lesotho summary regression assertions passed');
