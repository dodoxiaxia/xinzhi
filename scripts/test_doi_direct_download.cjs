'use strict';
// Actual Worker routes, synthetic sources only. No real credentials or publisher requests.
const assert = require('node:assert/strict');
const {harness,doi,pdf,record,seed,error} = require('./test_doi_library_worker.cjs');
async function browserCheck() {
  const fs=require('node:fs'),{chromium}=require('playwright');
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',args:['--no-sandbox']});
  try {
    const page=await browser.newPage(),h=harness(),requests=[],origin='https://doi-browser.invalid';
    await page.route(origin+'/**',async route=>{
      const req=route.request();requests.push({method:req.method(),url:req.url()});
      const response=await h.context.worker.fetch(new Request(req.url(),{method:req.method(),headers:req.headers(),...(req.method()==='POST'?{body:req.postData()}:{})}),h.env);
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    await page.goto(origin+'/api/acquire?doi='+encodeURIComponent(doi));
    await page.locator('#passphrase').fill('synthetic-passphrase');
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('button[type="submit"]').click()]);
    assert.deepEqual(fs.readFileSync(await download.path()),pdf);
    assert.equal(requests.filter(r=>r.method==='POST').length,1,'one form submission returns download without a second password prompt');
    assert(requests.every(r=>!r.url.includes('synthetic-passphrase')));
    assert(!requests.some(r=>r.url.includes('/api/fulltext?')),'no second download authorization request');
    assert.equal(JSON.parse(h.values.get('library:paper:'+doi)).paper.fulltextStatus,'available');
    assert(!h.writes.some(w=>typeof w.value==='string' && w.value.includes('synthetic-passphrase')));
    console.log('Offline browser direct download passed: real form/CSP, one password POST, attachment event and persisted cache. Synthetic sources only.');
  } finally { await browser.close(); }
}
const query = 'doi=' + encodeURIComponent(doi) + '&download=1';
async function downloaded(response) {
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/pdf');
  assert(response.headers.get('content-disposition').startsWith('attachment;'));
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('x-xinzhi-archive-status'),'not-confirmed');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
}
(async()=>{
  let h=harness();
  const form=await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}});
  const html=await form.text();assert(html.includes('&amp;download=1'));assert(html.includes('输入一次'));assert(!html.includes('<script'));
  assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
  // One password-bearing POST persists the cache and directly returns the file.
  await downloaded(await h.request('/api/acquire',{query}));
  assert.equal(JSON.parse(h.values.get('library:paper:'+doi)).paper.fulltextStatus,'available');
  const calls=h.calls.length,writes=h.writes.length;
  await downloaded(await h.request('/api/acquire',{query}));assert.equal(h.calls.length,calls);assert.equal(h.writes.length,writes);
  assert(!h.writes.some(w=>/passphrase|cookie|session/.test(w.key)));
  assert(!h.writes.some(w=>typeof w.value==='string' && w.value.includes('synthetic-passphrase')));
  h=harness({rows:[],oa:true});await downloaded(await h.request('/api/acquire',{query}));assert.equal(JSON.parse(h.values.get('library:paper:'+doi)).pdf.source,'oa');
  h=harness();await error(await h.request('/api/acquire',{query,passphrase:'wrong'}),403,'pdf_passphrase_invalid');assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
  h=harness();await error(await h.request('/api/acquire',{query,headers:{origin:'https://attacker.invalid'}}),403,'pdf_origin');assert.equal(h.calls.length,0);
  for(const invalid of [query+'&download=1',query.replace('download=1','download=0'),query+'&url=https://attacker.invalid']){h=harness();await error(await h.request('/api/acquire',{query:invalid}),400,'library_bad_doi');assert.equal(h.calls.length,0);}
  for(const route of ['/api/library','/api/fulltext']){h=harness();await error(await h.request(route,{query,method:route==='/api/library'?'GET':'POST'}),400,'library_bad_doi');assert.equal(h.calls.length,0);}
  h=harness();const ready=record();seed(h,ready);h.values.set(ready.pdf.key,Buffer.from('corrupt'));await error(await h.request('/api/acquire',{query}),502,'library_integrity');assert.equal(h.calls.length,0);
  h=harness({onRecordRead:n=>n===2?null:undefined});seed(h);await error(await h.request('/api/acquire',{query}),503,'library_sync_pending');assert.equal(h.calls.length,0,'late storage errors remain structured, never unhandled rejections');
  h=harness({rows:[],oa:false});const pending=await h.request('/api/acquire',{query,headers:{accept:'text/html'}});assert.equal(pending.status,202);assert(pending.headers.get('content-type').startsWith('text/html'));assert.equal(pending.headers.get('content-disposition'),null);assert((await pending.text()).includes('机构授权执行桥'));
  h=harness();const result=await (await h.request()).json();assert.equal(result.archive.complete,false);assert.equal(result.archive.ledgerChecked,false);assert.equal(result.archive.sides.mac,'pending');
  // Denied/rate-limited/HTML sources pause rather than fetching another provider.
  for(const status of [401,403,429])for(const source of ['crossref','oa','github']){
    h=harness(source==='crossref'?{crossrefResponse:()=>new Response('denied',{status})}:source==='oa'?{rows:[],unpaywallResponse:()=>new Response('denied',{status})}:{githubPdfResponse:()=>new Response('denied',{status})});
    await error(await h.request('/api/acquire',{query}),423,'library_paused');const pausedCalls=h.calls.length;
    assert(!h.calls.some(c=>c.url.hostname==='api.openalex.org'));await error(await h.request('/api/acquire',{query}),423,'library_paused');assert.equal(h.calls.length,pausedCalls);
    const paused=await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}});assert.equal(paused.status,423);assert.equal(paused.headers.get('retry-after'),null);
  }
  h=harness({rows:[],oa:true,pdfResponse:()=>new Response('<html>Login or CAPTCHA</html>',{headers:{'content-type':'text/html'}})});await error(await h.request('/api/acquire',{query}),423,'library_paused');assert(!h.calls.some(c=>c.url.hostname==='api.openalex.org'));
  h=harness({githubPdfResponse:()=>new Response('temporary',{status:503}),oa:true});await error(await h.request('/api/acquire',{query}),502,'library_upstream');assert(!h.calls.some(c=>['api.unpaywall.org','api.openalex.org'].includes(c.url.hostname)));
  console.log('DOI direct download passed: one authenticated POST, persist-before-attachment, existing/OA/cache reuse, unchanged JSON API, no credential storage, origin/body/query boundaries, cache integrity and 401/403/429/login pause.');
  if(process.argv.includes('--browser')) await browserCheck();
})().catch(e=>{console.error(e);process.exitCode=1;});
