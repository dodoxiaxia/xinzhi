// Offline regression over a saved real public abstract and historical 502 metadata.
// Every model-shaped payload below is constructed: no failed production output survived.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'editorial/week_study_failure_fixture_20261007.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'edge/_worker.js'), 'utf8').replace('export default {', 'globalThis.worker = {');
let networkCalls = 0, checks = 0;
const ctx = vm.createContext({ URL, Response, Request, TextEncoder, AbortController, setTimeout, clearTimeout,
  crypto: crypto.webcrypto, console, fetch: async () => { networkCalls++; throw new Error('Unexpected network in offline evidence regression'); } });
vm.runInContext(source, ctx);
function test(name, fn) { fn(); checks++; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
const fields = ['question', 'population', 'design', 'comparator', 'endpoints', 'results'];
const art = fixture.article, arts = [art], mortality = fixture.constructedCases.mortalitySentence;
function literalPayload(text, quote) {
  const paper = { id: String(art.n) };
  for (const field of fields) paper[field] = { text: '摘要未提供', quote: '' };
  paper.results = { text, quote };
  return { papers: [paper] };
}
function selectedPayload(text, quoteId, sources = arts) {
  return { papers: sources.map(a => {
    const paper = { id: String(a.n) };
    for (const field of fields) paper[field] = { text: '摘要未提供', quote_id: '' };
    if (String(a.n) === String(art.n)) paper.results = { text, quote_id: quoteId };
    return paper;
  }) };
}

test('Historical provenance does not invent a recovered model response', () => {
  assert.equal(fixture.historicalObservation.httpStatus, 502);
  assert.equal(fixture.historicalObservation.detail, 'quote_not_in_abstract');
  assert.equal(fixture.historicalObservation.rawModelOutputPreserved, false);
  assert.equal(fixture.historicalObservation.rawModelOutput, null);
  assert.equal(fixture.historicalObservation.failingField, null);
  assert.equal(fixture.historicalObservation.requestSourceFingerprintPreserved, false);
  assert.equal(crypto.createHash('sha256').update(art.title + '\n' + art.abstract).digest('hex'), fixture.provenance.sourceHash);
  assert.equal(art.abstract.length, 2952);
  assert.equal(vm.runInContext('stripTags', ctx)(art.abstract), art.abstract);
});
test('Real Results section exists literally but exceeds the quote limit', () => {
  const long = fixture.constructedCases.entireResultsSection;
  assert.equal(long.quote.length, 1098); assert(art.abstract.includes(long.quote));
  assert.throws(() => ctx.checkStudy(literalPayload('摘要结果', long.quote), arts), /invalid_study_quote_length/);
});
test('A short quote receives the specific length error', () => {
  assert.throws(() => ctx.checkStudy(literalPayload('摘要结果', 'Results'), arts), /invalid_study_quote_length/);
});
test('Exact 343-character real sentence supports its own numbers', () => {
  assert.equal(mortality.quote.length, 343);
  const output = ctx.checkStudy(literalPayload(mortality.supportedText, mortality.quote), arts).get(String(art.n));
  assert.equal(output.results.quote, mortality.quote);
});
test('A number elsewhere in the same abstract cannot support this quote', () => {
  assert(art.abstract.includes('36 studies')); assert(!mortality.quote.includes('36'));
  assert.throws(() => ctx.checkStudy(literalPayload(mortality.unsupportedSameQuoteText, mortality.quote), arts), /numbers_not_in_source:36/);
});
test('Chinese quantitative notation cannot evade the Arabic-number gate', () => {
  for (const text of ['纳入九百九十九例患者', '纳入九例患者', '随访十年'])
    assert.throws(() => ctx.checkStudy(literalPayload(text, mortality.quote), arts), /invalid_study_numeric_notation/);
});
test('Typographic dash replacement cannot bypass literal evidence validation', () => {
  const altered = mortality.quote.replace(mortality.unicodeMutationFrom, mortality.unicodeMutationTo);
  assert.notEqual(altered, mortality.quote); assert(!art.abstract.includes(altered));
  assert.throws(() => ctx.checkStudy(literalPayload(mortality.supportedText, altered), arts), /quote_not_in_abstract/);
});
test('Whitespace replacement cannot bypass literal evidence validation', () => {
  const altered = mortality.quote.replace('Mortality excesses', 'Mortality  excesses');
  assert.throws(() => ctx.checkStudy(literalPayload(mortality.supportedText, altered), arts), /quote_not_in_abstract/);
});

assert.equal(typeof ctx.studyEvidence, 'function', 'Worker must expose studyEvidence(art)');
assert.equal(typeof ctx.resolveStudyEvidence, 'function', 'Worker must expose resolveStudyEvidence(output, arts)');
const evidence = ctx.studyEvidence(art);
test('Every candidate preserves an exact contiguous source span and paper-local ID', () => {
  assert(evidence.length > 0);
  const ids = new Set();
  for (const e of evidence) {
    assert.deepEqual(Object.keys(e).sort(), ['end', 'id', 'quote', 'start']);
    assert.match(e.id, new RegExp('^' + art.n + ':e[0-9]+$'));
    assert(!ids.has(e.id)); ids.add(e.id);
    assert(Number.isInteger(e.start) && Number.isInteger(e.end));
    assert(e.start >= 0 && e.end <= art.abstract.length && e.start < e.end);
    assert.equal(e.quote, art.abstract.slice(e.start, e.end));
    assert(e.quote.length >= 12 && e.quote.length <= 360);
  }
  assert.equal(JSON.stringify(ctx.studyEvidence(art)), JSON.stringify(evidence), 'Candidate IDs and spans must be deterministic');
});
const mortalityEvidence = evidence.find(e => e.quote === mortality.quote);
test('Sentence selection preserves the complete supported mortality comparison', () => {
  assert(mortalityEvidence, 'Do not split or trim the 343-character mortality sentence');
  assert(mortalityEvidence.quote.includes('with null estimates at or after age 45 years'));
});
test('A selected ID restores only the original quote and preserves the public schema', () => {
  const output = ctx.resolveStudyEvidence(selectedPayload(mortality.supportedText, mortalityEvidence.id), arts).get(String(art.n));
  assert.equal(output.results.quote, mortality.quote);
  assert.equal(output.results.text, mortality.supportedText);
  assert.deepEqual(Object.keys(output.results).sort(), ['quote', 'text']);
  assert.equal(output.population.text, '摘要未提供'); assert.equal(output.population.quote, '');
});
test('Selected evidence still enforces same-quote numbers', () => {
  assert.throws(() => ctx.resolveStudyEvidence(selectedPayload(mortality.unsupportedSameQuoteText, mortalityEvidence.id), arts), /numbers_not_in_source:36/);
});
test('Unknown evidence IDs fail', () => {
  assert.throws(() => ctx.resolveStudyEvidence(selectedPayload(mortality.supportedText, art.n + ':e999999'), arts));
});
test('Another paper cannot lend its evidence ID even when the source text is identical', () => {
  const other = { ...art, n: 2 }, both = [art, other];
  const otherEvidence = ctx.studyEvidence(other).find(e => e.quote === mortality.quote);
  assert(otherEvidence); assert.notEqual(otherEvidence.id, mortalityEvidence.id);
  assert.throws(() => ctx.resolveStudyEvidence(selectedPayload(mortality.supportedText, otherEvidence.id, both), both));
});
test('Joined evidence IDs cannot synthesize a discontinuous quote', () => {
  for (const separator of [',', ' ', '+', '\n'])
    assert.throws(() => ctx.resolveStudyEvidence(selectedPayload(mortality.supportedText, mortalityEvidence.id + separator + evidence[0].id), arts));
});
test('An evidence ID array cannot replace the single-string contract', () => {
  assert.throws(() => ctx.resolveStudyEvidence(selectedPayload(mortality.supportedText, [mortalityEvidence.id]), arts));
});
test('A caller-supplied quote cannot override the selected source', () => {
  const payload = selectedPayload(mortality.supportedText, mortalityEvidence.id);
  payload.papers[0].results.quote = mortality.quote;
  assert.throws(() => ctx.resolveStudyEvidence(payload, arts));
});
test('Unknown claims require exactly an empty evidence ID', () => {
  assert.throws(() => ctx.resolveStudyEvidence(selectedPayload('摘要未提供', mortalityEvidence.id), arts));
  assert.throws(() => ctx.resolveStudyEvidence(selectedPayload(mortality.supportedText, ''), arts));
  const output = ctx.resolveStudyEvidence(selectedPayload('摘要未提供', ''), arts).get(String(art.n));
  assert.equal(output.results.text, '摘要未提供'); assert.equal(output.results.quote, '');
});
test('Paper IDs cannot be duplicated, replaced, or enriched with arbitrary fields', () => {
  const good = selectedPayload(mortality.supportedText, mortalityEvidence.id);
  let bad = clone(good); bad.papers[0].id = '2'; assert.throws(() => ctx.resolveStudyEvidence(bad, arts));
  bad = clone(good); bad.papers.push(clone(bad.papers[0])); assert.throws(() => ctx.resolveStudyEvidence(bad, arts));
  bad = clone(good); bad.papers[0].evidence = evidence; assert.throws(() => ctx.resolveStudyEvidence(bad, arts));
  bad = clone(good); bad.papers[0].results.extra = 'untrusted'; assert.throws(() => ctx.resolveStudyEvidence(bad, arts));
});
test('Long-source segmentation preserves offsets, decimals, unicode, and original spacing', () => {
  const synthetic = { n: 9, abstract: 'First population comprised 105 women; the estimate was 1.25 (95% CI, 1.04–1.37).\n\n' +
    'The source preserves two  spaces and Unicode “quotation marks”. ' + 'Long source clause with unchanged words and spaces '.repeat(12) +
    'with no detected benefit. The final outcome was measured at 3.5 years.' };
  const spans = ctx.studyEvidence(synthetic);
  assert(spans.length > 2);
  for (const e of spans) {
    assert.equal(e.quote, synthetic.abstract.slice(e.start, e.end));
    assert(e.quote.length >= 12 && e.quote.length <= 360);
    assert.match(e.id, /^9:e[0-9]+$/);
  }
  assert(spans.some(e => e.quote.includes('1.25 (95% CI, 1.04–1.37)')), 'Sentence splitting must not split decimal numbers');
  assert(spans.some(e => e.quote.includes('two  spaces')), 'Candidate extraction must not normalize source whitespace');
});
assert.equal(networkCalls, 0);
console.log('Study evidence regression: ' + checks + ' cases passed; real public source, honest historical-failure provenance, exact spans, strict citation IDs and same-quote numbers; zero network calls.');
