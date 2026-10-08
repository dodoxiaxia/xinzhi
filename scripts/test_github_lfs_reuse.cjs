'use strict';
const assert=require('node:assert/strict');
const {harness,doi,pdf,hash}=require('./test_doi_library_worker.cjs');
const pointer=Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:'+hash(pdf)+'\nsize '+pdf.length+'\n');
(async()=>{
  let h=harness({pointer});const response=await h.request('/api/acquire',{query:'doi='+encodeURIComponent(doi)+'&download=1'});
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
  assert.equal(h.calls.filter(c=>c.url.hostname==='github.com').length,1);assert.equal(h.calls.filter(c=>c.url.hostname==='github-cloud.s3.amazonaws.com').length,1);
  const before=h.calls.length;assert.equal((await (await h.request()).json()).cached,true);assert.equal(h.calls.length,before);
  for(const lfsUrl of ['https://127.0.0.1/file','https://github-cloud.s3.amazonaws.com.attacker.invalid/file','http://github-cloud.s3.amazonaws.com/file','https://user:secret@github-cloud.s3.amazonaws.com/file','https://github-cloud.s3.amazonaws.com:8443/file']){
    h=harness({pointer,lfsUrl});const rejected=await h.request();assert.notEqual(rejected.status,200);assert(!h.calls.some(c=>c.url.hostname==='github-cloud.s3.amazonaws.com'));assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));
  }
  h=harness({pointer,lfsBatch:()=>Response.json({objects:[{oid:'b'.repeat(64),size:pdf.length,actions:{download:{href:'https://github-cloud.s3.amazonaws.com/file'}}}]})});assert.notEqual((await h.request()).status,200);assert(!h.calls.some(c=>c.url.hostname==='github-cloud.s3.amazonaws.com'));
  h=harness({pointer,lfsObject:()=>new Response(Buffer.from('%PDF-1.7\nchanged\n%%EOF'))});assert.equal((await (await h.request()).json()).status,'review');assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));
  h=harness({pointer,metadata:{type:'file',path:'期刊/试验.pdf',size:pdf.length,sha:'b'.repeat(40)}});assert.equal((await (await h.request()).json()).status,'review');assert(!h.calls.some(c=>c.url.hostname==='github.com'),'pointer Git blob must match before LFS resolution');
  for(const status of [401,403,429]){
    h=harness({pointer,lfsBatch:()=>new Response('blocked',{status})});const stopped=await h.request();assert.equal(stopped.status,423);const calls=h.calls.length;assert.equal((await h.request()).status,423);assert.equal(h.calls.length,calls);assert(!h.calls.some(c=>c.url.hostname==='github-cloud.s3.amazonaws.com'));
  }
  console.log('LFS reuse passed: pointer blob + object size/SHA binding, authenticated download batch only, no credential forwarding, safe host/redirect boundaries and pause.');
})().catch(e=>{console.error(e);process.exitCode=1;});
