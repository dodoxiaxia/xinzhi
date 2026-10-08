'use strict';
// Synthetic OIDC keys, storage and sources. No real GitHub credentials or network.
const assert=require('assert'),vm=require('vm'),{webcrypto}=require('crypto');
const {harness,doi,pdf,hash,record,seed}=require('./test_doi_library_worker.cjs');
const {runQueue}=require('./fulltext_queue_runner.cjs');
const ENDPOINT='https://learn.dryz.info/api/fulltext-worker';
const workflow='dodoxiaxia/xinzhi/.github/workflows/fulltext.yml@refs/heads/main';
const b64=x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url');
let keypair,jwk;
async function setup(options={}) {
 const h=harness({...options,jwks:[jwk]});h.env.FULLTEXT_ASYNC_ENABLED='true';return h;
}
async function token(h,changes={},header={}) {
 const now=Math.floor(vm.runInContext('Date.now()',h.context)/1000);
 const claims={iss:'https://token.actions.githubusercontent.com',aud:ENDPOINT,repository:'dodoxiaxia/xinzhi',repository_id:'1397425558',
  sub:'repo:dodoxiaxia/xinzhi:ref:refs/heads/main',ref:'refs/heads/main',workflow_ref:workflow,runner_environment:'github-hosted',
  event_name:'schedule',run_id:'1234',iat:now,nbf:now-1,exp:now+300,...changes};
 const value=b64({alg:'RS256',typ:'JWT',kid:jwk.kid,...header})+'.'+b64(claims);
 const signed=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keypair.privateKey,Buffer.from(value));
 return value+'.'+Buffer.from(signed).toString('base64url');
}
async function service(h,input,opts={}) {
 const identity=opts.token===undefined?await token(h,opts.claims||{},opts.header||{}):opts.token;
 return h.context.worker.fetch(new Request(ENDPOINT,{method:opts.method||'POST',headers:{authorization:'Bearer '+identity,'content-type':'application/json'},
  ...((opts.method||'POST')==='POST'?{body:opts.raw===undefined?JSON.stringify(input):opts.raw}:{})}),h.env);
}
async function enqueue(h) {const response=await h.request();assert.equal(response.status,202);return (await response.json()).job;}
async function claimRun(h) {
 const claimed=await service(h,{action:'claim'});assert.equal(claimed.status,200);const pointer=(await claimed.json()).job;
 assert(pointer);const ran=await service(h,{action:'run',...pointer});assert.equal(ran.status,200);return (await ran.json()).job;
}
(async()=>{
 keypair=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 jwk={...await webcrypto.subtle.exportKey('jwk',keypair.publicKey),kid:'00000000-0000-4000-8000-000000000001',use:'sig',alg:'RS256'};
 let h=await setup();
 const signal=async h=>{const response=await h.request('/api/fulltext-pending',{method:'GET',query:''});assert.equal(response.status,200);return response.json();};
 assert.deepEqual(await signal(h),{ok:true,pending:false});assert.equal(h.writes.length,0);assert.equal(h.calls.length,0);
 assert.equal((await h.request('/api/fulltext-pending',{query:''})).status,405);assert.equal(h.writes.length,0);
 const wrong=await h.request('/api/acquire',{passphrase:'wrong'});assert.equal(wrong.status,403);assert.equal(h.writes.length,0);assert.equal(h.reads.length,0);assert.equal(h.calls.length,0);
 const queued=await enqueue(h);assert.equal(queued.state,'queued');assert.equal(h.calls.length,0,'submitting never contacts metadata, PDF sources or a model');
 const writes=h.writes.length;const duplicate=await enqueue(h);assert.equal(duplicate.id,queued.id);assert.equal(h.writes.length,writes,'duplicate request reuses task');
 assert.deepEqual(await signal(h),{ok:true,pending:true});assert.equal(h.writes.length,writes);assert.equal(h.calls.length,0,'aggregate signal never starts acquisition or exposes task details');
 const lookup=await (await h.request('/api/library',{method:'GET'})).json();assert.equal(lookup.found,false);assert.equal(lookup.job.state,'queued');
 const page=await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}});assert.equal(page.status,202);const html=await page.text();assert(html.includes('本页每 15 秒只更新状态'));assert(html.includes('http-equiv="refresh"'));assert(!html.includes('<form'));assert(!html.includes('synthetic-private-token'));
 const completed=await claimRun(h);assert.equal(completed.state,'available');assert.equal(completed.attempts,1);
 const stored=JSON.parse(h.values.get('library:paper:'+doi));assert.equal(stored.pdf.sha256,hash(pdf));assert(h.values.has(stored.pdf.key));
 assert.equal([...h.values.keys()].filter(k=>k.startsWith('library:queue:')).length,0);
 assert.deepEqual(await signal(h),{ok:true,pending:false});
 const calls=h.calls.length;const ready=await h.request('/api/fulltext');assert.equal(ready.status,200);assert.deepEqual(Buffer.from(await ready.arrayBuffer()),pdf);
 assert.equal(h.calls.length,calls);assert.equal((await (await h.request()).json()).cached,true);
 const publicPaper=await (await h.request('/api/library',{method:'GET'})).json();assert.equal(publicPaper.paper.fulltextStatus,'available');assert(!JSON.stringify(publicPaper).includes('synthetic-private-token'));
 for(const claims of [{aud:'other'},{repository:'evil/repo'},{repository_id:'1'},{sub:'repo:dodoxiaxia/xinzhi:pull_request'},{ref:'refs/heads/other'},
  {workflow_ref:'dodoxiaxia/xinzhi/.github/workflows/daily.yml@refs/heads/main'},{runner_environment:'self-hosted'},{event_name:'pull_request'},{exp:1},{nbf:9999999999},{iss:'https://evil.example'}]) {
  h=await setup();const result=await service(h,{action:'claim'},{claims});assert.equal(result.status,401);assert.equal(h.reads.length,0);assert.equal(h.writes.length,0);assert.equal(h.calls.length,0);
 }
 h=await setup();const valid=await token(h);const segments=valid.split('.');const malformed=segments[0]+'.'+segments[1]+'.'+b64('wrong signature');
 assert.equal((await service(h,{action:'claim'},{token:malformed})).status,401);assert.equal(h.reads.length,0);
 assert.equal((await service(h,{action:'claim'},{header:{alg:'none'}})).status,401);
 assert.equal((await service(h,{action:'claim'},{header:{kid:'unknown-key'}})).status,401);
 assert.equal((await service(h,{action:'claim'},{token:'azyy'})).status,401,'reader password never authorizes worker actions');
 assert.equal((await service(h,{action:'claim',url:'https://evil.example'})).status,400);
 assert.equal((await service(h,{action:'claim'},{raw:'x'.repeat(1025)})).status,413);
 assert.equal((await service(h,{action:'claim'},{method:'GET'})).status,405);
 assert.equal(h.writes.length,0);
 h=await setup();const closed=await enqueue(h);h.values.set('library:paper:'+doi,JSON.stringify(record('pending'))); // existing bibliography remains safe
 const pendingHarness=await setup({rows:[],oa:false});await enqueue(pendingHarness);const pending=await claimRun(pendingHarness);assert.equal(pending.state,'manual_needed');
 assert.equal([...pendingHarness.values.keys()].filter(k=>k.startsWith('library:paper:')).length,1);
 const pendingPage=await pendingHarness.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}});const pendingText=await pendingPage.text();assert(pendingText.includes('/api/acquire/retry?doi='));assert(!pendingText.includes('http-equiv="refresh"'));
 const retryForm=await pendingHarness.request('/api/acquire/retry',{method:'GET',headers:{accept:'text/html'}});assert.equal(retryForm.status,200);assert((await retryForm.text()).includes('<form method="post"'));
 const clock={now:Date.now()},transient=await setup({clock,githubPdfResponse:()=>new Response('temporary failure',{status:503})});
 await enqueue(transient);
 for(let attempt=1;attempt<=3;attempt++) {
  const result=await claimRun(transient);assert.equal(result.attempts,attempt);assert.equal(result.state,attempt<3?'queued':'failed');
  if(attempt<3){assert.deepEqual(await signal(transient),{ok:true,pending:false});assert.equal((await (await service(transient,{action:'claim'})).json()).job,null);clock.now+=attempt===1?61000:601000;assert.deepEqual(await signal(transient),{ok:true,pending:true});}
 }
 assert.equal([...transient.values.keys()].filter(k=>k.startsWith('library:queue:')).length,0);
 for(const status of [401,403,429]){
  const paused=await setup({rows:[],unpaywallResponse:()=>new Response('authorization needed',{status})});await enqueue(paused);
  const stopped=await claimRun(paused);assert.equal(stopped.state,'failed');assert.equal(stopped.attempts,1);assert(stopped.message.includes('任务暂停'));
  assert(!paused.calls.some(c=>c.url.hostname==='api.openalex.org'));assert.equal([...paused.values.keys()].filter(k=>k.startsWith('library:queue:')).length,0);
 }
 assert.equal(JSON.parse(transient.values.get('library:cap:'+new Date(clock.now).toISOString().slice(0,10))),1,'automatic retries do not consume another reader submission');
 h=await setup({crossref:{DOI:'10.1000/wrong'}});await enqueue(h);assert.equal((await claimRun(h)).state,'review');assert(!h.values.has('library:paper:'+doi));
 h=await setup();await enqueue(h);const pointer=(await (await service(h,{action:'claim'})).json()).job;
 assert.equal((await service(h,{action:'run',...pointer},{claims:{run_id:'9876'}})).status,409);
 assert.equal((await (await service(h,{action:'claim'})).json()).job,null,'live lease cannot be reclaimed');
 assert.deepEqual(await signal(h),{ok:true,pending:false},'active lease does not start another runner');
 // A newly listed pointer may be visible before its job. It must survive KV propagation.
 h=await setup();await enqueue(h);const jobKey='library:job:'+doi,original=h.values.get(jobKey);h.values.delete(jobKey);
 assert.equal((await (await service(h,{action:'claim'})).json()).job,null);assert.equal([...h.values.keys()].filter(k=>k.startsWith('library:queue:')).length,1);
 h.values.set(jobKey,original);assert.equal((await claimRun(h)).state,'available');
 h=await setup();await enqueue(h);const queuedRecord=JSON.parse(h.values.get(jobKey));h.values.set(jobKey,JSON.stringify({...queuedRecord,state:'running',attempts:3,owner:'9876',leaseId:'00000000-0000-4000-8000-000000000002',leaseUntil:Date.now()+60000}));
 assert.equal((await (await service(h,{action:'claim'})).json()).job,null);assert.equal(JSON.parse(h.values.get(jobKey)).state,'running','third active attempt is not prematurely failed');
 // Drive the real runner module through synthetic OIDC exchange and worker API.
 h=await setup();await enqueue(h);let oidcRequests=0;const logs=[];
 const http=async(url,init)=>{
  if(new URL(url).hostname==='pipelines.actions.githubusercontent.com'){oidcRequests++;assert.equal(new URL(url).searchParams.get('audience'),ENDPOINT);return Response.json({value:await token(h)});}
  assert.equal(url,ENDPOINT);return h.context.worker.fetch(new Request(url,init),h.env);
 };
 const env={ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/oidctoken',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-exchange-secret'};
 assert.equal(await runQueue(env,http,value=>logs.push(value)),1);assert(oidcRequests>=3);assert.equal(JSON.parse(h.values.get(jobKey)).state,'available');
 assert(!logs.join('').includes('synthetic-exchange-secret'));assert(!logs.join('').includes('synthetic-private-token'));
 h=await setup();await enqueue(h);
 assert.equal(await runQueue({...env,GITHUB_EVENT_NAME:'push'},http,value=>logs.push(value)),1,'first push waits for a real API before claims');
 assert.equal(await runQueue({...env,GITHUB_EVENT_NAME:'push'},async()=>new Response('<html>old site</html>'),value=>logs.push(value),async()=>{}),0);
 console.log('Fulltext jobs passed: durable enqueue/dedup, OIDC scope/signature, runner execution, verified PDF return, bounded automatic retries, KV propagation and manual recovery.');
})().catch(error=>{console.error(error);process.exitCode=1;});
