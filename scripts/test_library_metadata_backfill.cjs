'use strict';
const assert = require('node:assert/strict');
const {harness, hash, error} = require('./test_doi_library_worker.cjs');

const base = 'https://learn.dryz.info';
const fallback = 'synthetic_fallback_token_0123456789abc';
const downloader = 'synthetic_downloader_token_0123456789ab';
const cases = [
  {doi:'10.1001/jama.2026.17078', title:'Cardiovascular Magnetic Resonance to Guide Defibrillator Implantation for LVEF of 36% to 50%',
    journal:'JAMA', publication:'published-print'},
  {doi:'10.1001/jamanetworkopen.2026.44496', title:'Clinician Acceptance of Large Language Model–Generated Discharge Summaries',
    journal:'JAMA Network Open', publication:'published-online'}
];
const pdf = Buffer.from('%PDF-1.7\nSynthetic backfill fixture\n%%EOF\n');
const sha256 = hash(pdf);
function create(onCrossref = () => {}) {
  const h = harness({crossrefResponse:url => {
    const doi = decodeURIComponent(url.pathname.slice('/works/'.length));
    const fixture = cases.find(row => row.doi === doi);
    assert(fixture);
    onCrossref(h, fixture);
    return Response.json({message:{DOI:doi,title:[fixture.title],'container-title':[fixture.journal],
      [fixture.publication]:{'date-parts':[[2026,11,17]]}}});
  }});
  h.env.MACHINE_TOKENS = JSON.stringify([{id:'fallback',role:'fallback',token:fallback},{id:'downloader',role:'downloader',token:downloader}]);
  h.lookup = doi => h.request('/api/library', {method:'GET', query:doi ? 'doi=' + encodeURIComponent(doi) : ''}).then(res => res.json());
  h.backfill = (body, token = fallback) => h.context.worker.fetch(new Request(base + '/api/machine/metadata-backfill', {
    method:'POST', headers:{'content-type':'application/json',...(token ? {authorization:'Bearer ' + token} : {})}, body:JSON.stringify(body)
  }), h.env);
  return h;
}
function seed(h, {doi,title}, changes = {}) {
  const key = 'library:paper:' + doi;
  const paper = {id:'doi-' + hash(doi).slice(0,16),doi,title,journal:'',authors:[],date:'',dateBasis:'',datePrecision:'',
    ingestedAt:'2026-11-17T23:38:27.796Z',fulltextStatus:'available',...changes};
  h.values.set(key, JSON.stringify({version:1,paper,pdf:{key:'library:pdf:' + sha256,sha256,size:pdf.length,source:'muse_verified'}}));
  h.values.set('library:pdf:' + sha256, pdf);
  return key;
}

async function run() {
  for (const fixture of cases) {
    const {doi, journal, publication} = fixture;
    const h = create(), key = seed(h, fixture), original = h.values.get(key);
    assert.equal((await h.lookup(doi)).paper.journal, '');
    assert.equal((await h.lookup()).papers[0].date, '');
    assert.equal(h.calls.length, 0);
    await error(await h.backfill({doi, apply:true}, ''), 401, 'machine_unauthorized');
    await error(await h.backfill({doi, apply:true}, downloader), 403, 'machine_forbidden');
    await error(await h.backfill({doi, apply:true,journal:'Injected'}), 400, 'machine_bad_request');
    const preview = await (await h.backfill({doi})).json();
    assert.equal(preview.result, 'would_update');
    assert.equal(h.writes.length, 0);
    assert.deepEqual(preview.after, {journal,date:'2026-11-17',datePrecision:'day',dateBasis:'Crossref ' + publication});

    assert.equal((await (await h.backfill({doi,apply:true})).json()).result, 'updated');
    assert.deepEqual(h.writes.map(write => write.key), ['library:bibliography:' + doi]);
    assert.equal(h.values.get(key), original);
    for (const updated of [(await h.lookup(doi)).paper, (await h.lookup()).papers[0]]) {
      assert.equal(updated.journal, journal);
      assert.equal(updated.date, '2026-11-17');
      assert.equal(updated.title, fixture.title);
      assert.equal(updated.fulltextStatus, 'available');
      assert.equal(updated.id, JSON.parse(original).paper.id);
    }
    const download = await h.request('/api/fulltext', {doi});
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
    assert.equal((await (await h.backfill({doi,apply:true})).json()).result, 'unchanged');
    assert.equal(h.calls.length, 2, 'public lookup, download and repeated apply do not fetch Crossref');
    assert.equal(h.writes.length, 1);
  }

  const fixture = cases[0], doi = fixture.doi;
  let h = create((h, article) => seed(h, article, {title:'A conflicting title for the same DOI'}));
  seed(h, fixture);
  assert.equal((await (await h.backfill({doi, apply:true})).json()).result, 'identity_mismatch');
  assert.equal(h.writes.length, 0);
  assert.equal((await (await h.backfill({doi:'10.1000/missing',apply:true})).json()).result, 'not_in_catalog');

  h = create((h, article) => seed(h, article, {journal:'Existing verified journal'}));
  seed(h, fixture);
  assert.equal((await (await h.backfill({doi,apply:true})).json()).result, 'updated');
  assert.equal((await h.lookup(doi)).paper.journal, 'Existing verified journal');
  assert.equal((await h.lookup(doi)).paper.date, '2026-11-17');
  assert(!Object.hasOwn(JSON.parse(h.values.get('library:bibliography:' + doi)), 'journal'));
  seed(h, fixture, {title:'A different record now occupies this DOI'});
  assert.equal((await h.lookup(doi)).paper.date, '');
  console.log('DOI bibliography backfill tests passed');
}
module.exports = {run};
if (require.main === module) run().catch(err => { console.error(err); process.exitCode = 1; });
