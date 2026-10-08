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

 // Canonical strict receipt is required. Matching real fixture content is separately read from the indexed source.
 const proof={version:1,website_request_id:'',doi,title,ledger:{key:'doi:'+doi,owner_request_id:'',items:871},content:{sha256:hash(pdf),bytes:pdf.length,pages:1},verification:{verified:true,method:'dual_parser_all_pages_title_doi'},sides:{mac:{verified:true,identity_verified:true,sha256:hash(pdf),bytes:pdf.length},github:{verified:true,commit,sha256:hash(pdf),bytes:pdf.length},drive:{verified:true,account:'dryz@dryz.info',content_read_back:true,file_id:'synthetic_drive_file',root_id:'1TE_Vk8ySIdN9-1XmF7AaP1momKEsjYyE',sha256:hash(pdf),bytes:pdf.length}},indexes:{}};
 h=setup({rows:[],handoffReceipt:proof});const submitted=await submit(h),p=await claim(h);proof.website_request_id=submitted.id;proof.batch_id=p.batch_id;proof.ledger.owner_request_id=submitted.id;proof.ledger.handoff_owner=p.owner;proof.ledger.request_version=p.request_version;proof.ledger.idempotency_key=p.idempotency_key;proof.ledger.canonical=true;proof.ledger.snapshot_sha256='d'.repeat(64);proof.ledger.checked_at=new Date().toISOString();
 // Change only the synthetic source index to represent a later archive registration.
 const archive=harness({handoffReceipt:proof,jwks:[jwk]});h.env.QL_KV=archive.kv;for(const [k,v]of h.values)archive.values.set(k,v);h.context=archive.context;
 const indexCheck=await archive.request('/api/fulltext-source'),indexBody=await indexCheck.json();for(const side of ['mac','github','drive'])proof.indexes[side]={sha256:indexBody.inspection.indexSha256};
 const before=JSON.parse(h.env.QL_KV===archive.kv?archive.values.get(key):h.values.get(key));
 for(const [label,change]of [
  ['old 815 ledger',v=>v.ledger.items=815],['unchecked canonical',v=>v.ledger.canonical=false],['old ledger readback',v=>v.ledger.checked_at='2020-01-01T00:00:00Z'],
  ['other receipt owner',v=>v.ledger.handoff_owner='other-owner'],['other receipt version',v=>v.ledger.request_version=2],['other receipt idempotency key',v=>v.ledger.idempotency_key='other-key'],
  ['wrong Drive root',v=>v.sides.drive.root_id='other-root'],['Drive not read back',v=>v.sides.drive.content_read_back=false],['offline Mac',v=>v.sides.mac.verified=false],
  ['different index hash',v=>v.indexes.mac.sha256='f'.repeat(64)],['same fake hashes without actual CSV',v=>{for(const side of ['mac','github','drive'])v.indexes[side].sha256='e'.repeat(64);}],
  ['verification missing',v=>v.verification.verified=false]
 ]){const saved=structuredClone(proof);change(proof);const denied=await service(h,{...update(p,'complete'),receipt_commit:commit});assert.equal(denied.status,409,label);assert.equal(JSON.parse(archive.values.get(key)).archiveComplete,false,label+' must not mutate completed state');for(const field of Object.keys(proof))delete proof[field];Object.assign(proof,saved);archive.values.set(key,JSON.stringify(before));}
 const complete=await service(h,{...update(p,'complete'),receipt_commit:commit});assert.equal(complete.status,200);const completed=(await complete.json()).handoff;assert.equal(completed.archive.complete,true);assert.equal(completed.executorClaimed,true);
 assert.equal((await service(h,{...update(p,'complete'),owner:'other-owner',receipt_commit:commit})).status,409,'completed idempotent response still requires original context');
 const ready=await h.context.worker.fetch(new Request('https://site.test/api/fulltext?doi='+encodeURIComponent(doi),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'passphrase=synthetic-passphrase'}),h.env);assert.equal(ready.status,200);assert.deepEqual(Buffer.from(await ready.arrayBuffer()),pdf);

 for(const denied of [401,403,429]){const blocked=setup({rows:[],handoffReceiptResponse:()=>new Response('restricted',{status:denied})});await submit(blocked);const ticket=await claim(blocked);assert.equal((await service(blocked,{...update(ticket,'verified'),receipt_commit:commit})).status,423);const state=(await (await blocked.request('/api/library',{method:'GET'})).json()).handoff;assert.equal(state.state,'blocked');assert.equal(state.archive.complete,false);const calls=blocked.calls.length;assert.equal((await service(blocked,update(ticket,'downloaded'))).status,423);assert.equal(blocked.calls.length,calls,'paused receipt never repeats upstream request');}

 // Real runner code uses short-lived OIDC, makes exactly one call and writes only the task/status artifact.
 h=setup({rows:[]});await submit(h);const artifacts=[],logs=[];
 const http=async(url,init)=>new URL(url).hostname==='pipelines.actions.githubusercontent.com'?Response.json({value:await token(h)}):h.context.worker.fetch(new Request(url,init),h.env);
 await runAuthorized({GITHUB_EVENT_NAME:'workflow_dispatch',HANDOFF_ACTION:'authorized_claim',HANDOFF_REQUEST_JSON:JSON.stringify({doi}),ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/oidctoken',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-exchange-secret'},http,v=>artifacts.push(v),v=>logs.push(v));
 assert.equal(artifacts.length,1);assert.equal(artifacts[0].handoff.doi,doi);assert(!JSON.stringify(artifacts).includes('synthetic-exchange-secret'));assert(!logs.join('').includes('synthetic-exchange-secret'));
 console.log('Authorized handoff offline passed: default-off, exact existing OIDC scope, stable duplicate tickets, serialized/idempotent claims, stale/owner/block refusal and proof-gated completion. Mock receipt only; no production/Mac archive success.');
})().catch(e=>{console.error(e);process.exitCode=1;});
