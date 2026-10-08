'use strict';
// Real Worker routes with synthetic sources; no publisher requests or credentials.
const assert = require('node:assert/strict');
const {harness,doi,title,pdf,hash,record,error} = require('./test_doi_library_worker.cjs');
const paperKey='library:paper:'+doi, attemptKey='library:attempt:'+doi;
const now=Date.parse('2026-10-08T00:15:44Z');
async function manual(response) {
  assert.equal(response.status,202);assert.equal(response.headers.get('retry-after'),null);
  const body=await response.json();assert.equal(body.status,'manual_needed');assert.equal(body.paper.fulltextStatus,'manual_needed');
  assert.equal(body.archive.complete,false);assert(!body.downloadUrl);assert(!Object.hasOwn(body,'retryAfter'));return body;
}
(async()=>{
  // OA metadata may say open while providing no usable PDF location, as in the reported JACC case.
  const rows=[];
  let h=harness({rows,clock:{now},unpaywallResponse:()=>Response.json({doi,title,is_oa:true,oa_locations:[]}),openalex:{doi,title,open_access:{is_oa:true},locations:[]}});
  await manual(await h.request());
  assert.equal(JSON.parse(h.values.get(paperKey)).paper.fulltextStatus,'manual_needed');assert(!JSON.parse(h.values.get(paperKey)).pdf);
  assert.equal(JSON.parse(h.values.get(attemptKey)).retryAfter,0);assert.equal(h.writes.find(w=>w.key===attemptKey).opts,undefined,'manual-needed is not a five-minute timer');
  const count=h.calls.length;
  await manual(await h.request());
  assert(h.calls.slice(count).every(c=>c.url.hostname==='api.github.com'),'repeat checks existing archive only, with no metadata/OA/publisher request');
  const writes=h.writes.length,calls=h.calls.length;
  const lookup=await (await h.request('/api/library',{method:'GET'})).json();assert.equal(lookup.status,'manual_needed');assert(!Object.hasOwn(lookup,'retryAfter'));
  const page=await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}}),html=await page.text();
  assert.equal(page.headers.get('retry-after'),null);assert(html.includes('需要人工处理'));assert(html.includes('核对已有文件是否登记及网站读取版本'));assert(html.includes('确需新的订阅获取时'));assert(html.includes('等待或反复提交不会自动取得全文'));
  assert(!html.includes('后手动重试'));assert(!html.includes('北京时间'));assert(!html.includes('<form'));assert(!html.includes('http-equiv="refresh"'));
  const form=await h.request('/api/acquire/retry',{method:'GET',headers:{accept:'text/html'}}),formHtml=await form.text();
  assert(formHtml.includes('检查已归档全文'));assert(formHtml.includes('只查询私有索引'));assert(!formHtml.includes('后手动重试'));
  assert.equal(h.writes.length,writes);assert.equal(h.calls.length,calls,'GET never launches a third acquisition');
  // A later verified archive entry is reused, rather than permanently trapping the saved bibliography.
  rows.push([title,doi,'Heart','2026-10-07','publisher','期刊/试验.pdf',hash(pdf)]);
  const ready=await h.request('/api/acquire',{query:'doi='+encodeURIComponent(doi)+'&download=1'});
  assert.equal(ready.status,200);assert.equal(ready.headers.get('content-type'),'application/pdf');assert.deepEqual(Buffer.from(await ready.arrayBuffer()),pdf);
  assert.equal(JSON.parse(h.values.get(paperKey)).paper.fulltextStatus,'available');

  // Legacy pending/no-source records render truthfully immediately, without clearing their marker.
  h=harness({rows:[],clock:{now}});h.values.set(paperKey,JSON.stringify(record('pending')));
  const legacy=JSON.stringify({status:'pending',error:'library_metadata_unavailable',retryAfter:now+300000});h.values.set(attemptKey,legacy);
  const legacyLookup=await (await h.request('/api/library',{method:'GET'})).json();assert.equal(legacyLookup.status,'manual_needed');assert(!Object.hasOwn(legacyLookup,'retryAfter'));
  const legacyPage=await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}});assert(!(await legacyPage.text()).includes('后手动重试'));
  assert.equal(h.values.get(attemptKey),legacy);assert.equal(h.writes.length,0);assert.equal(h.calls.length,0);
  await manual(await h.request());assert(h.calls.every(c=>c.url.hostname==='api.github.com'));

  // A fixed old snapshot cannot see a newly archived row; default main resolves it.
  const oldCommit='a'.repeat(40), newCommit='b'.repeat(40), archiveRow=[title,doi,'Heart','2026-10-07','publisher','期刊/试验.pdf',hash(pdf)];
  h=harness({commit:newCommit,indexes:{[oldCommit]:[],[newCommit]:[archiveRow]},clock:{now}});
  h.values.set(paperKey,JSON.stringify(record('manual_needed')));
  await manual(await h.request());assert(h.calls.every(c=>c.url.searchParams.get('ref')===oldCommit));
  const fromMain=await h.request('/api/acquire',{env:{PDF_GITHUB_COMMIT:undefined},query:'doi='+encodeURIComponent(doi)+'&download=1'});
  assert.equal(fromMain.status,200);assert.deepEqual(Buffer.from(await fromMain.arrayBuffer()),pdf);
  assert(h.calls.some(c=>c.url.pathname.endsWith('/commits/main')));
  assert(h.calls.filter(c=>c.url.searchParams.get('ref')===newCommit).length>=3);assert(h.calls.every(c=>c.url.hostname==='api.github.com'));

  // Existing pause blocks the manual archive check and survives time passing.
  h=harness({rows:[],clock:{now}});h.values.set(paperKey,JSON.stringify(record('manual_needed')));
  const paused=JSON.stringify({status:'pending',error:'library_paused',paused:true,retryAfter:now-1000});h.values.set(attemptKey,paused);
  await error(await h.request(),423,'library_paused');assert.equal(h.values.get(attemptKey),paused);assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);

  // Real upstream 429 deadlines are retained; expiry is not permission to resume.
  for(const header of ['120',new Date(now+120000).toUTCString()]){
    const clock={now};h=harness({clock,crossrefResponse:()=>new Response('limited',{status:429,headers:{'retry-after':header}})});
    const limited=await h.request();await error(limited,423,'library_paused');assert.equal(limited.headers.get('retry-after'),'120');
    const marker=h.values.get(attemptKey);assert.equal(JSON.parse(marker).retryAfter,now+120000);assert.equal(h.writes.find(w=>w.key===attemptKey).opts,undefined);
    clock.now+=130000;await error(await h.request(),423,'library_paused');assert.equal(h.calls.length,1);assert.equal(h.values.get(attemptKey),marker);
    const pausedPage=await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}}),pausedHtml=await pausedPage.text();
    assert(pausedHtml.includes('上游返回 Retry-After'));assert(pausedHtml.includes('仍需维护者确认'));assert(!pausedHtml.includes('后手动重试'));
  }
  // A metadata/OA service failure is temporary, not a false no-source determination.
  h=harness({rows:[],clock:{now},unpaywallResponse:()=>new Response('temporary',{status:503,headers:{'retry-after':'75'}})});
  const temporary=await h.request();await error(temporary,502,'library_upstream');assert.equal(temporary.headers.get('retry-after'),'75');
  assert.equal(JSON.parse(h.values.get(paperKey)).paper.fulltextStatus,'pending');assert.equal(JSON.parse(h.values.get(attemptKey)).retryAfter,now+75000);
  assert.equal((await (await h.request('/api/library',{method:'GET'})).json()).status,'pending');
  h.values.delete(attemptKey);assert.equal((await (await h.request('/api/library',{method:'GET'})).json()).status,'pending','an expired cooldown does not reclassify a known temporary failure as no source');
  console.log('Manual-needed passed: open metadata/no PDF, stable read-only legacy projection, protected archive reuse, persistent pause and actual upstream retry deadlines.');
})().catch(e=>{console.error(e);process.exitCode=1;});
