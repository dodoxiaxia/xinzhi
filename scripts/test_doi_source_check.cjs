'use strict';
const assert=require('node:assert/strict');
const {harness,doi,title,pdf,hash,record}=require('./test_doi_library_worker.cjs');
(async()=>{
  let h=harness();const form=await h.request('/api/fulltext-source',{method:'GET'});assert.equal(form.status,200);assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
  assert.equal((await h.request('/api/fulltext-source',{passphrase:'wrong'})).status,403);assert.equal(h.calls.length,0);
  h=harness({commit:'b'.repeat(40)});h.values.set('library:paper:'+doi,JSON.stringify(record('manual_needed')));
  const source=await h.request('/api/fulltext-source',{env:{DOI_LOOKUP_LATEST_MAIN:'true'}}),body=await source.json();
  assert.equal(source.status,200);assert.equal(body.configuredCommit,'a'.repeat(40));assert.equal(body.inspection.resolvedCommit,'b'.repeat(40));assert.equal(body.inspection.candidateFound,true);
  assert.equal(body.inspection.pdfObjectRead,false);assert.equal(body.inspection.indexRowCount,1);assert(!JSON.stringify(body).includes('期刊/试验.pdf'));assert.equal(h.writes.length,0);
  assert(h.calls.every(c=>c.url.pathname.endsWith('/commits/main')||decodeURIComponent(c.url.pathname).endsWith('/文献索引/文献索引.csv')));
  const entry={doi,title,path:'期刊/试验.pdf',sha256:hash(pdf),bytes:pdf.length,verification:{verified:true,method:'dual_parser_all_pages_title_doi',pages:1,sha256:hash(pdf),bytes:pdf.length}};
  h=harness({rows:[],delta:{version:1,entries:[entry]}});const reused=await h.request('/api/acquire',{env:{DOI_GITHUB_DELTA_ENABLED:'true'}});assert.equal(reused.status,200);assert.equal((await reused.json()).status,'available');assert(!h.calls.some(c=>['api.unpaywall.org','api.openalex.org'].includes(c.url.hostname)));
  assert.equal(JSON.parse(h.values.get('library:paper:'+doi)).pdf.source,'github_delta');
  for(const entries of [[{...entry,verification:{...entry.verification,verified:false}}],[entry,entry],[{...entry,path:'../unsafe.pdf'}],[{...entry,bytes:pdf.length+1,verification:{...entry.verification,bytes:pdf.length+1}}]]){
    h=harness({rows:[],delta:{version:1,entries}});const invalid=await h.request('/api/acquire',{env:{DOI_GITHUB_DELTA_ENABLED:'true'}});assert.equal((await invalid.json()).status,'review');assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));assert(!h.calls.some(c=>['api.unpaywall.org','api.openalex.org'].includes(c.url.hostname)));
  }
  console.log('Source check passed: authenticated metadata-only version evidence, latest-main opt-in, bounded verified delta reuse and no identity/path bypass.');
})().catch(e=>{console.error(e);process.exitCode=1;});
