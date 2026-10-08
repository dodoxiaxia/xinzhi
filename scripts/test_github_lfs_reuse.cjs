'use strict';
const assert=require('node:assert/strict');
const {harness,doi,title,pdf,hash}=require('./test_doi_library_worker.cjs');
const {createHash}=require('node:crypto');
const blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const pointer=Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:'+hash(pdf)+'\nsize '+pdf.length+'\n');
(async()=>{
  let h=harness({pointer});const response=await h.request('/api/acquire',{query:'doi='+encodeURIComponent(doi)+'&download=1'});
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
  assert.equal(h.calls.filter(c=>c.url.hostname==='github.com').length,1);assert.equal(h.calls.filter(c=>c.url.hostname==='github-cloud.s3.amazonaws.com').length,1);
  const before=h.calls.length;assert.equal((await (await h.request()).json()).cached,true);assert.equal(h.calls.length,before);
  // Real JACC dimensions, synthetic bytes only: 131-byte Git pointer and 598,792-byte PDF object.
  const original=Buffer.alloc(598792,32);original.write('%PDF-1.7\nSynthetic sized LFS fixture\n');original.write('%%EOF\n',original.length-6);
  const sizedPointer=Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:'+hash(original)+'\nsize '+original.length+'\n');assert.equal(sizedPointer.length,131);
  const rows=[[title,doi,'Heart','2026-10-07','publisher','期刊/试验.pdf',hash(original)]];
  for(const reportedSize of [131,598792]){
    h=harness({pointer:sizedPointer,pdfBytes:original,rows,metadata:{type:'file',path:'期刊/试验.pdf',size:reportedSize,sha:blob(sizedPointer)}});
    const sized=await h.request('/api/acquire',{query:'doi='+encodeURIComponent(doi)+'&download=1'});assert.equal(sized.status,200);assert.deepEqual(Buffer.from(await sized.arrayBuffer()),original);
    assert.equal(JSON.parse(h.calls.find(c=>c.url.hostname==='github.com').init.body).objects[0].size,598792,'batch binds original size, not pointer blob size');
  }
  for(const size of [130,132]){h=harness({pointer:sizedPointer,pdfBytes:original,rows,metadata:{type:'file',path:'期刊/试验.pdf',size,sha:blob(sizedPointer)}});assert.notEqual((await h.request()).status,200);assert(!h.calls.some(c=>c.url.hostname==='github.com'));}
  h=harness({pointer:sizedPointer,pdfBytes:original,rows,lfsObject:()=>new Response(original.subarray(0,-1))});assert.notEqual((await h.request()).status,200);assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));
  const wrongSize=Buffer.from(sizedPointer.toString().replace('size 598792','size 598793'));h=harness({pointer:wrongSize,pdfBytes:original,rows});assert.notEqual((await h.request()).status,200);assert(!h.calls.some(c=>c.url.hostname==='github-cloud.s3.amazonaws.com'));
  const tooLarge=Buffer.from(sizedPointer.toString().replace('size 598792','size '+(10*1024*1024+1)));h=harness({pointer:tooLarge,pdfBytes:original,rows});assert.notEqual((await h.request()).status,200);assert(!h.calls.some(c=>c.url.hostname==='github.com'));
  const entry={doi,title,path:'期刊/试验.pdf',sha256:hash(original),bytes:598792,verification:{verified:true,method:'dual_parser_all_pages_title_doi',pages:13,sha256:hash(original),bytes:598792}};
  h=harness({pointer:sizedPointer,pdfBytes:original,rows:[],delta:{version:1,entries:[entry]}});assert.equal((await h.request('/api/acquire',{env:{DOI_GITHUB_DELTA_ENABLED:'true'}})).status,200,'delta bytes bind the LFS original, not pointer metadata');
  h=harness({pointer:sizedPointer,pdfBytes:original,rows:[],delta:{version:1,entries:[{...entry,bytes:598793,verification:{...entry.verification,bytes:598793}}]}});assert.notEqual((await h.request('/api/acquire',{env:{DOI_GITHUB_DELTA_ENABLED:'true'}})).status,200);assert(!h.calls.some(c=>c.url.hostname==='github.com'));
  for(const indexed of [[rows[0],rows[0]],[[ 'Wrong identity',...rows[0].slice(1)]]]){h=harness({pointer:sizedPointer,pdfBytes:original,rows:indexed,delta:{version:1,entries:[entry]}});assert.equal((await (await h.request('/api/acquire',{env:{DOI_GITHUB_DELTA_ENABLED:'true'}})).json()).status,'review');assert(!h.calls.some(c=>decodeURIComponent(c.url.pathname).endsWith('按需全文增量.json')));}
  for(const lfsUrl of ['https://127.0.0.1/file','https://github-cloud.s3.amazonaws.com.attacker.invalid/file','http://github-cloud.s3.amazonaws.com/file','https://user:secret@github-cloud.s3.amazonaws.com/file','https://github-cloud.s3.amazonaws.com:8443/file']){
    h=harness({pointer,lfsUrl});const rejected=await h.request();assert.notEqual(rejected.status,200);assert(!h.calls.some(c=>c.url.hostname==='github-cloud.s3.amazonaws.com'));assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));
  }
  h=harness({pointer,lfsBatch:()=>Response.json({objects:[{oid:'b'.repeat(64),size:pdf.length,actions:{download:{href:'https://github-cloud.s3.amazonaws.com/file'}}}]})});assert.notEqual((await h.request()).status,200);assert(!h.calls.some(c=>c.url.hostname==='github-cloud.s3.amazonaws.com'));
  h=harness({pointer,lfsObject:()=>new Response(Buffer.from('%PDF-1.7\nchanged\n%%EOF'))});assert.equal((await (await h.request()).json()).status,'review');assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));
  h=harness({pointer,metadata:{type:'file',path:'期刊/试验.pdf',size:pdf.length,sha:'b'.repeat(40)}});assert.equal((await (await h.request()).json()).status,'review');assert(!h.calls.some(c=>c.url.hostname==='github.com'),'pointer Git blob must match before LFS resolution');
  for(const status of [401,403,429]){
    h=harness({pointer,lfsBatch:()=>new Response('blocked',{status})});const stopped=await h.request();assert.equal(stopped.status,423);const calls=h.calls.length;assert.equal((await h.request()).status,423);assert.equal(h.calls.length,calls);assert(!h.calls.some(c=>c.url.hostname==='github-cloud.s3.amazonaws.com'));
  }
  for(const status of [401,403,429]){h=harness({pointer,lfsObject:()=>new Response('blocked',{status})});assert.equal((await h.request()).status,423);const calls=h.calls.length;assert.equal((await h.request()).status,423);assert.equal(h.calls.length,calls);assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));}
  for(const stage of ['batch','object']){
    const redirect=()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});
    h=harness({pointer,...(stage==='batch'?{lfsBatch:redirect}:{lfsObject:redirect})});assert.notEqual((await h.request()).status,200);assert(!h.calls.some(c=>c.url.hostname==='127.0.0.1'));assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));
  }
  console.log('LFS reuse passed: real 131/598792 dimensions, pointer Git blob vs original OID/size/hash, delta target size, bounded originals, true 302 rejection and batch/object 401/403/429 pause; synthetic fixtures, zero real requests.');
})().catch(e=>{console.error(e);process.exitCode=1;});
