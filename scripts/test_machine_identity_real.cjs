'use strict';
// Optional local regression on genuine publisher originals. The originals are copyrighted: never commit them and
// never paste their content anywhere. Runs the site's own first-page identity function (edge/_worker.js, the same
// code the Worker runs for PUT /api/machine/upload) and skips quietly when the directory is not set or missing.
//   XINZHI_REAL_PDF_DIR=/path/with/pdfs  node scripts/test_machine_identity_real.cjs
// Files are named like the DOI with "/" replaced by "_" (10.1001_jama.2026.24331.pdf). Titles come, in order, from
// $XINZHI_REAL_TITLES or <dir>/titles.json ({"doi":"title"}), then from the repo's public data (data/*.json).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const dir = process.env.XINZHI_REAL_PDF_DIR;
if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.log('skip: XINZHI_REAL_PDF_DIR is not set or not a directory'); process.exit(0); }
const titles = new Map();
function collect(value) {
  if (Array.isArray(value)) { for (const item of value) collect(item); return; }
  if (!value || typeof value !== 'object') return;
  if (typeof value.doi === 'string' && typeof value.title === 'string' && !titles.has(value.doi.toLowerCase())) titles.set(value.doi.toLowerCase(), value.title.replace(/\.$/, ''));
  for (const child of Object.values(value)) if (child && typeof child === 'object') collect(child);
}
for (const file of [process.env.XINZHI_REAL_TITLES, path.join(dir, 'titles.json')]) {
  if (file && fs.existsSync(file)) for (const [doi, title] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) titles.set(doi.toLowerCase(), title);
}
for (const name of ['radar-archive.json', 'candidates.json', 'archive-full.json', 'pubmed.json']) {
  const file = path.join(__dirname, '../data', name);
  if (fs.existsSync(file)) { try { collect(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* optional data */ } }
}
const byStem = new Map([...titles].map(([doi, title]) => [doi.replace(/\//g, '_'), {doi, title}]));
const context = vm.createContext({URL, URLSearchParams, Response, Request, TextEncoder, TextDecoder, Uint8Array, AbortController, setTimeout, clearTimeout, crypto:require('crypto').webcrypto, fetch:async () => { throw new Error('offline'); }, console, Date, atob, btoa, DecompressionStream});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../edge/_worker.js'), 'utf8').replace('export default {', 'globalThis.worker = {'), context);
const identity = vm.runInContext('machineIdentity', context);
(async () => {
  const papers = [];
  for (const name of fs.readdirSync(dir).filter(file => /\.pdf$/i.test(file)).sort()) {
    const known = byStem.get(name.replace(/\.pdf$/i, '').toLowerCase());
    if (!known) { console.log('skip ' + name + ': no DOI/title known for it'); continue; }
    papers.push({name, ...known, bytes:new Uint8Array(fs.readFileSync(path.join(dir, name)))});
  }
  if (!papers.length) { console.log('skip: no PDF in ' + dir + ' with a known DOI and title'); return; }
  for (const paper of papers) {
    const verdict = await identity(paper.bytes, paper.doi, paper.title);
    console.log((verdict.verdict === 'ok' ? 'ok       ' : 'MISMATCH ') + paper.doi + ' level=' + (verdict.level || '-') + ' reason=' + (verdict.reason || '-') + ' checks=' + JSON.stringify(verdict.checks || {}));
    assert.equal(verdict.verdict, 'ok', paper.name + ' must pass the site check');
  }
  // Wrong-paper protection: every original against every other paper's DOI/title must still be refused.
  let refused = 0;
  for (const paper of papers) for (const other of papers) {
    if (other === paper) continue;
    for (const [doi, title] of [[other.doi, paper.title], [paper.doi, other.title], [other.doi, other.title]]) {
      const verdict = await identity(paper.bytes, doi, title);
      assert.equal(verdict.verdict, 'mismatch', paper.name + ' must not pass as ' + doi);
      refused++;
    }
  }
  console.log('Real originals: ' + papers.length + ' passed, ' + refused + ' wrong-paper combinations refused');
})().catch(error => { console.error(error); process.exitCode = 1; });
