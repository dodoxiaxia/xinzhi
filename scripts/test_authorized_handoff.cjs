'use strict';
// Synthetic OIDC/source/storage. No Mac, production flags, private uploads or real queue claims.
const assert=require('node:assert/strict'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const {harness,doi,title,pdf,hash,record}=require('./test_doi_library_worker.cjs');
const {runAuthorized}=require('./authorized_handoff_runner.cjs');
const endpoint='https://learn.dryz.info/api/fulltext-worker',workflow='dodoxiaxia/xinzhi/.github/workflows/fulltext.yml@refs/heads/main';
const key='library:authorized:'+doi,commit='a'.repeat(40),b64=x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url');
let keys,jwk;
function setup(options={}){const h=harness({...options,jwks:[jwk]});h.env.FULLTEXT_AUTHORIZED_HANDOFF_ENABLED='true';return h;}
async function token(h,changes={}){const now=Math.floor(vm.runInContext('Date.now()',h.context)/1000),claims={iss:'https://token.actions.githubusercontent.com',aud:endpoint,repository:'dodoxiaxia/xinzhi',repository_id:'1397425558',sub:'repo:dodoxiaxia/xinzhi:ref:refs/heads/main',ref:'refs/heads/main',workflow_ref:workflow,runner_environment:'github-hosted',event_name:'workflow_dispatch',run_id:'1234',iat:now,nbf:now-1,exp:now+300,...changes};
 const value=b64({alg:'RS256',kid:jwk.kid})+'.'+b64(claims),signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,Buffer.from(value));return value+'.'+Buffer.from(signature).toString('base64url');}
async function service(h,input,changes={}){return h.context.worker.fetch(new Request(endpoint,{method:'POST',headers:{authorization:'Bearer '+await token(h,changes),'content-type':'application/json'},body:JSON.stringify(input)}),h.env);}
async function submit(h){const response=await h.request();assert.equal(response.status,202);const body=await response.json();assert.equal(body.handoff.state,'submitted');assert.equal(body.handoff.executorClaimed,false);assert.equal(body.handoff.archive.complete,false);return body.handoff;}
async function claim(h){const response=await service(h,{action:'authorized_claim',doi});assert.equal(response.status,200);return (await response.json()).handoff;}
const update=(p,state)=>({action:'authorized_update',doi,id:p.website_request_id,claim_id:p.claim_id,state,ledger_key:'doi:'+doi,owner_request_id:p.website_request_id,owner:p.owner,request_version:p.request_version,idempotency_key:p.idempotency_key,batch_id:p.batch_id});
function held(p){assert.equal(p.execution_state,'hold');assert.equal(p.ready_to_execute,false);assert.equal(p.hold_reason,'exclusion_unverified');assert.equal(Object.hasOwn(p,'executor_claimed')?p.executor_claimed:p.executorClaimed,false);}
async function regions(){
 const a=setup({rows:[]}),b=setup({rows:[]});await submit(a);const submitted=a.values.get(key),base=a.kv,views=[];
 for(const region of [a,b]){const view={value:submitted};views.push(view);region.env.QL_KV={...base,
  get:async(k,type)=>k===key?(type==='json'?JSON.parse(view.value):view.value):base.get(k,type),
  put:async(k,value,options)=>{await base.put(k,value,options);if(k===key)view.value=value;}
 };}
 return {a,b,propagate:()=>{for(const view of views)view.value=a.values.get(key);}};
}
(async()=>{
 keys=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 jwk={...await webcrypto.subtle.exportKey('jwk',keys.publicKey),kid:'handoff-key',use:'sig',alg:'RS256'};
 let h=harness({rows:[]});assert.equal((await service(h,{action:'authorized_claim'})).status,503);assert.equal(h.writes.length,0);assert.equal(h.reads.length,0);
 h=setup({rows:[]});await submit(h);const writes=h.writes.length;const first=JSON.parse(h.values.get(key));await submit(h);assert.equal(JSON.parse(h.values.get(key)).id,first.id);
 assert.equal([...h.values.keys()].filter(k=>k.startsWith('library:authorized:')).length,1);
 const readWrites=h.writes.length;const publicState=await (await h.request('/api/library',{method:'GET'})).json();assert.equal(publicState.handoff.state,'submitted');assert(!JSON.stringify(publicState).includes('claimId'));assert.equal(h.writes.length,readWrites);
 const page=await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}}),html=await page.text();assert(html.includes('网站不会自动唤醒 Mac'));assert(!html.includes('http-equiv="refresh"'));assert.equal(h.writes.length,readWrites);
 for(const changes of [{aud:'other'},{repository:'other/repo'},{ref:'refs/heads/other'},{workflow_ref:'dodoxiaxia/xinzhi/.github/workflows/daily.yml@refs/heads/main'},{runner_environment:'self-hosted'},{event_name:'pull_request'},{event_name:'push'},{event_name:'schedule'}]){const result=await service(h,{action:'authorized_claim'},changes);assert.equal(result.status,401);assert.equal(h.writes.length,readWrites);}
 const [one,two]=await Promise.all([claim(h),claim(h)]);assert.equal(one.website_request_id,two.website_request_id);assert.equal(one.claim_id,two.claim_id);assert.equal(one.executor_claimed,false);
 assert.equal(one.claim_proof,hash(JSON.stringify([one.website_request_id,one.claim_id,one.dispatcher_run_id,one.doi,one.title,one.owner,one.request_version,one.idempotency_key,one.batch_id])));
 const liveProof=(await (await h.request('/api/library',{method:'GET'})).json()).handoff;assert.equal(liveProof.claimProof,one.claim_proof);assert(!JSON.stringify(liveProof).includes(one.claim_id),'public live proof does not disclose the opaque correlation nonce');
 assert(Number.isSafeInteger(liveProof.createdAt));assert(Number.isSafeInteger(liveProof.claimedAt));assert.equal(liveProof.createdAt,first.createdAt);assert(liveProof.claimedAt>=liveProof.createdAt);assert(!Object.hasOwn(liveProof,'owner'));
 held(one);held(liveProof);assert.equal(one.fencing_guarantee,'unverified');
 assert.equal((await (await service(h,{action:'authorized_claim',doi},{run_id:'9876'})).json()).handoff,null,'later serialized run cannot reclaim another owner');
 let result=await service(h,{...update(one,'pending_browser'),owner_request_id:'request-'+'b'.repeat(32)});assert.equal(result.status,409);
 for(const field of ['owner','request_version','idempotency_key','batch_id']){const missing=update(one,'pending_browser');delete missing[field];assert.equal((await service(h,missing)).status,409,'missing backend context rejected: '+field);}
 for(const [field,value]of [['owner','other-owner'],['request_version',2],['idempotency_key','other-key'],['batch_id','other-batch']])assert.equal((await service(h,{...update(one,'pending_browser'),[field]:value})).status,409,'changed backend context rejected: '+field);
 result=await service(h,update(one,'pending_browser'));assert.equal(result.status,200);assert.equal((await result.json()).handoff.executorClaimed,false);
 result=await service(h,update(one,'verified'));assert.equal(result.status,400,'missing strict proof cannot become verified');
 result=await service(h,update(one,'complete'));assert.equal(result.status,400,'no proof cannot become complete');
 result=await service(h,{...update(one,'blocked'),reason:'browser_tool_unavailable'});assert.equal(result.status,200);assert.equal((await result.json()).handoff.archive.complete,false);
 assert.equal((await service(h,update(one,'downloaded'))).status,423,'a block never expires into permission to execute');

 // Duplicate submissions at two independent Worker isolates share one stable request ID, not an atomic claim guarantee.
 const left=setup({rows:[]}),right=setup({rows:[]});right.env.QL_KV=left.kv;
 const dup=await Promise.all([submit(left),submit(right)]);assert.equal(dup[0].id,dup[1].id);assert.equal([...left.values.keys()].filter(k=>k.startsWith('library:authorized:')).length,1);
 const originalGet=left.kv.get;left.kv.get=async(k,type)=>{const v=await originalGet(k,type);return k===key&&v?.state==='claimed'?{...v,state:'submitted',owner:undefined,claimId:undefined}:v;};
 assert.equal((await service(left,{action:'authorized_claim',doi})).status,409,'stale readback fails closed before delivering a claim');left.kv.get=originalGet;

 // Region B can still see old submitted after region A completed its claim/writeback. Both tickets are HOLD.
 let split=await regions();const firstClaim=(await (await service(split.a,{action:'authorized_claim',doi},{run_id:'2001'})).json()).handoff;
 const staleClaim=(await (await service(split.b,{action:'authorized_claim',doi},{run_id:'2002'})).json()).handoff;
 assert.equal(firstClaim.website_request_id,staleClaim.website_request_id);assert.notEqual(firstClaim.claim_id,staleClaim.claim_id);held(firstClaim);held(staleClaim);
 for(const region of [split.a,split.b])held((await (await region.request('/api/library',{method:'GET'})).json()).handoff);
 split.propagate();assert.equal((await service(split.a,update(firstClaim,'pending_browser'))).status,409,'once KV converges the overwritten correlation fails');
 // Two independent isolates can each observe their own delayed writeback during simultaneous claims.
 split=await regions();const delayed=await Promise.all([service(split.a,{action:'authorized_claim',doi},{run_id:'3001'}),service(split.b,{action:'authorized_claim',doi},{run_id:'3002'})]);
 const packets=await Promise.all(delayed.map(async response=>{assert.equal(response.status,200);return (await response.json()).handoff;}));
 assert.equal(packets[0].website_request_id,packets[1].website_request_id);assert.notEqual(packets[0].claim_id,packets[1].claim_id);for(const packet of packets)held(packet);
 assert.equal((await service(split.a,{...update(packets[0],'pending_browser'),ready_to_execute:true})).status,400,'caller cannot override HOLD');

 // Authentication precedes any body read. Valid identities have one bounded body deadline; cancel need not settle.
 for(const scenario of ['anonymous','stalled','late_read','overflow','read_error','cancel_throws']){
  const body=setup({rows:[],fastTimers:true}),counts={read:0,cancel:0},start=Date.now();let late;
  const req=new Request(endpoint,{method:'POST',headers:{'content-type':'application/json',...(scenario==='anonymous'?{}:{authorization:'Bearer '+await token(body)})},body:'{}'});
  Object.defineProperty(req,'body',{value:{getReader:()=>({
   read:()=>{counts.read++;if(scenario==='overflow')return Promise.resolve({done:false,value:new Uint8Array(2048)});if(scenario==='read_error')throw Error('private body failure');return new Promise(resolve=>{late=resolve;});},
   cancel:()=>{counts.cancel++;if(scenario==='cancel_throws')throw Error('cancel refused');return new Promise(()=>{});},releaseLock:()=>{throw Error('pending read');}
  })}});
  let watchdog;const result=await Promise.race([body.context.worker.fetch(req,body.env),new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(Error('body guard did not settle: '+scenario)),800);})]).finally(()=>clearTimeout(watchdog));
  assert.equal(result.status,scenario==='anonymous'?401:scenario==='overflow'?413:scenario==='read_error'?400:408,scenario);
  if(scenario==='anonymous'){assert.equal(counts.read,0);assert.equal(counts.cancel,0);assert.equal(body.calls.length,0);}else{assert.equal(counts.read,1);assert.equal(counts.cancel,1);}
  if(scenario==='late_read'){late({done:false,value:new TextEncoder().encode(JSON.stringify({action:'authorized_claim',doi}))});await new Promise(resolve=>setImmediate(resolve));assert.equal(counts.read,1,'late body resolution cannot resume the parser');}
  assert(Date.now()-start<600,scenario+' must settle despite ignored cancellation');assert.equal(body.writes.length,0);assert.equal(body.reads.length,0);
 }

 // Canonical strict receipt is required. Matching real fixture content is separately read from the indexed source.
 const proof={version:1,website_request_id:'',doi,title,ledger:{key:'doi:'+doi,owner_request_id:'',items:871},content:{sha256:hash(pdf),bytes:pdf.length,pages:1},verification:{verified:true,method:'dual_parser_all_pages_title_doi'},sides:{mac:{verified:true,identity_verified:true,sha256:hash(pdf),bytes:pdf.length},github:{verified:true,commit,sha256:hash(pdf),bytes:pdf.length},drive:{verified:true,account:'dryz@dryz.info',content_read_back:true,file_id:'synthetic_drive_file',root_id:'1TE_Vk8ySIdN9-1XmF7AaP1momKEsjYyE',sha256:hash(pdf),bytes:pdf.length}},indexes:{}};
 h=setup({rows:[],handoffReceipt:proof});const submitted=await submit(h),p=await claim(h);proof.website_request_id=submitted.id;proof.batch_id=p.batch_id;proof.claim_id=p.claim_id;proof.dispatcher_run_id=p.dispatcher_run_id;proof.claim_proof=p.claim_proof;proof.ledger.owner_request_id=submitted.id;proof.ledger.handoff_owner=p.owner;proof.ledger.request_version=p.request_version;proof.ledger.idempotency_key=p.idempotency_key;proof.ledger.canonical=true;proof.ledger.snapshot_sha256='d'.repeat(64);proof.ledger.snapshot_bytes=123456;proof.ledger.owner_queue='synthetic-existing-owner';proof.ledger.ownership_checked=true;proof.ledger.checked_at=new Date().toISOString();
 // Change only the synthetic source index to represent a later archive registration.
 const archive=harness({handoffReceipt:proof,jwks:[jwk]});h.env.QL_KV=archive.kv;for(const [k,v]of h.values)archive.values.set(k,v);h.context=archive.context;
 const indexCheck=await archive.request('/api/fulltext-source'),indexBody=await indexCheck.json();for(const side of ['mac','github','drive'])proof.indexes[side]={sha256:indexBody.inspection.indexSha256};
 proof.indexes.github.commit=commit;
 const before=JSON.parse(h.env.QL_KV===archive.kv?archive.values.get(key):h.values.get(key));
 for(const [label,change]of [
  ['old 815 ledger',v=>v.ledger.items=815],['unchecked canonical',v=>v.ledger.canonical=false],['old ledger readback',v=>v.ledger.checked_at='2020-01-01T00:00:00Z'],
  ['missing ledger bytes',v=>delete v.ledger.snapshot_bytes],['oversized ledger',v=>v.ledger.snapshot_bytes=16777217],['missing canonical owner queue',v=>delete v.ledger.owner_queue],['unchecked canonical owner',v=>v.ledger.ownership_checked=false],
  ['before this claim',v=>v.ledger.checked_at=new Date(before.claimedAt-1).toISOString()],['future snapshot',v=>v.ledger.checked_at=new Date(Date.now()+60000).toISOString()],
  ['ambiguous ledger timezone',v=>v.ledger.checked_at=new Date().toISOString().replace(/Z$/,'')],
  ['after claim but one hour stale',v=>{const old={...before,createdAt:Date.now()-14400000,claimedAt:Date.now()-7200000};archive.values.set(key,JSON.stringify(old));v.ledger.checked_at=new Date(Date.now()-3600000).toISOString();}],
  ['other claim receipt',v=>v.claim_id='claim-'+'b'.repeat(32)],['other dispatcher receipt',v=>v.dispatcher_run_id='9999'],['unbound receipt proof',v=>v.claim_proof='e'.repeat(64)],
  ['other receipt owner',v=>v.ledger.handoff_owner='other-owner'],['other receipt version',v=>v.ledger.request_version=2],['other receipt idempotency key',v=>v.ledger.idempotency_key='other-key'],
  ['wrong Drive root',v=>v.sides.drive.root_id='other-root'],['Drive not read back',v=>v.sides.drive.content_read_back=false],['offline Mac',v=>v.sides.mac.verified=false],
  ['different index hash',v=>v.indexes.mac.sha256='f'.repeat(64)],['same fake hashes without actual CSV',v=>{for(const side of ['mac','github','drive'])v.indexes[side].sha256='e'.repeat(64);}],
  ['verification missing',v=>v.verification.verified=false],['wrong pinned index commit',v=>v.indexes.github.commit='b'.repeat(40)],['missing pinned index commit',v=>delete v.indexes.github.commit]
 ]){const saved=structuredClone(proof);change(proof);const beforeCache=[...archive.values].filter(([k])=>/^library:(?:pdf|paper):/.test(k)),writeCount=archive.writes.length;const denied=await service(h,{...update(p,'complete'),receipt_commit:commit});assert.equal(denied.status,409,label);assert.equal(JSON.parse(archive.values.get(key)).archiveComplete,false,label+' must not mutate completed state');assert.deepEqual([...archive.values].filter(([k])=>/^library:(?:pdf|paper):/.test(k)),beforeCache,label+' cannot mutate PDF/paper cache');assert.equal(archive.writes.length,writeCount,label+' validation failure must have zero writes');for(const field of Object.keys(proof))delete proof[field];Object.assign(proof,saved);archive.values.set(key,JSON.stringify(before));}
 // A rejected complete also preserves a previously available PDF and partially verified archive record.
 const restore=[...archive.values];archive.values.set('library:paper:'+doi,JSON.stringify(record()));archive.values.set('library:pdf:'+hash(pdf),pdf);
 archive.values.set(key,JSON.stringify({...before,state:'sync_pending',receiptVerified:true,archiveSides:{mac:'verified',github:'verified',drive:'pending'}}));proof.sides.drive.verified=false;
 const existing=[...archive.values],writesBefore=archive.writes.length;assert.equal((await service(h,{...update(p,'complete'),receipt_commit:commit})).status,409);assert.deepEqual([...archive.values],existing);assert.equal(archive.writes.length,writesBefore);
 proof.sides.drive.verified=true;archive.values.clear();for(const [k,v]of restore)archive.values.set(k,v);
 const complete=await service(h,{...update(p,'complete'),receipt_commit:commit});assert.equal(complete.status,200);const completed=(await complete.json()).handoff;assert.equal(completed.archive.complete,true);assert.equal(completed.receiptVerified,true);held(completed);assert.equal(completed.ledgerLatestVerified,false);assert.equal(JSON.parse(archive.values.get(key)).receiptSha256,hash(JSON.stringify(proof)));
 assert.equal((await service(h,{...update(p,'complete'),owner:'other-owner',receipt_commit:commit})).status,409,'completed idempotent response still requires original context');
 const ready=await h.context.worker.fetch(new Request('https://site.test/api/fulltext?doi='+encodeURIComponent(doi),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'passphrase=synthetic-passphrase'}),h.env);assert.equal(ready.status,200);assert.deepEqual(Buffer.from(await ready.arrayBuffer()),pdf);

 for(const denied of [401,403,429]){const blocked=setup({rows:[],handoffReceiptResponse:()=>new Response('restricted',{status:denied})});await submit(blocked);const ticket=await claim(blocked);assert.equal((await service(blocked,{...update(ticket,'verified'),receipt_commit:commit})).status,423);const state=(await (await blocked.request('/api/library',{method:'GET'})).json()).handoff;assert.equal(state.state,'blocked');assert.equal(state.archive.complete,false);const calls=blocked.calls.length;assert.equal((await service(blocked,update(ticket,'downloaded'))).status,423);assert.equal(blocked.calls.length,calls,'paused receipt never repeats upstream request');}

 // Real runner code uses short-lived OIDC, makes exactly one call and writes only the task/status artifact.
 h=setup({rows:[]});await submit(h);const artifacts=[],logs=[];
 const http=async(url,init)=>new URL(url).hostname==='pipelines.actions.githubusercontent.com'?Response.json({value:await token(h)}):h.context.worker.fetch(new Request(url,init),h.env);
 await runAuthorized({GITHUB_EVENT_NAME:'workflow_dispatch',HANDOFF_ACTION:'authorized_claim',HANDOFF_REQUEST_JSON:JSON.stringify({doi}),ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/oidctoken',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-exchange-secret'},http,v=>artifacts.push(v),v=>logs.push(v));
 assert.equal(artifacts.length,1);assert.equal(artifacts[0].handoff.doi,doi);held(artifacts[0].handoff);assert(!JSON.stringify(artifacts).includes('synthetic-exchange-secret'));assert(!logs.join('').includes('synthetic-exchange-secret'));
 const beforeUnsafe=artifacts.length;await assert.rejects(runAuthorized({GITHUB_EVENT_NAME:'workflow_dispatch',HANDOFF_ACTION:'authorized_claim',ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/oidctoken',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-exchange-secret'},async(url,init)=>new URL(url).hostname==='pipelines.actions.githubusercontent.com'?Response.json({value:await token(h)}):Response.json({ok:true,handoff:{...artifacts[0].handoff,ready_to_execute:true}}),v=>artifacts.push(v)),/invalid_handoff_execution_permission/);assert.equal(artifacts.length,beforeUnsafe,'unsafe packet cannot be delivered to an executor');
 console.log('Authorized handoff offline passed: default-off/exact OIDC, auth-before-bounded-body including ignored cancellation, two stale/delayed-isolate double claims held without execution permission, claim-bound fresh receipt evidence, rejected complete has zero cache/archive writes, and 401/403/429 pause. Mock receipt only; no production/Mac archive success.');
})().catch(e=>{console.error(e);process.exitCode=1;});
