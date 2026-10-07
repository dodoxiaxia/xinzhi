// Synthetic offline contracts, not archive receipts or proof of deployed R2 behavior.
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {CanonicalLedger,LEDGER_KEY,dispatchWakeup,archiveStatus} from './ledger.mjs';
import {verifyExecutorJwt} from './oidc.mjs';
globalThis.crypto ??= webcrypto;
const sha = text => createHash('sha256').update(text).digest('hex');
const seed = () => ({version:1,items:{'10.1000/existing':{doi:'10.1000/existing',sides:{local:{historical:true}}}},cloudControl:{ownerEpoch:'test-cutover',enabled:true}});
class AtomicBucket {
  constructor(value = seed()) { this.value = JSON.stringify(value); this.version = 1; this.writes = 0; }
  async get(key) { assert.equal(key,LEDGER_KEY); const value = this.value; return value === null ? null : {etag:String(this.version),size:value.length,json:async()=>JSON.parse(value)}; }
  async put(key,value,options) { assert.equal(key,LEDGER_KEY); if (options.onlyIf.etagMatches !== String(this.version)) return null; this.value = value; this.version++; this.writes++; return {etag:String(this.version)}; }
}
const actor = sha('synthetic-actor');
let bucket = new AtomicBucket(), ledger = new CanonicalLedger(bucket,'test-cutover');
const parallel = await Promise.all(Array.from({length:24},(_,i)=>new CanonicalLedger(bucket,'test-cutover').submit(i % 2 ? 'https://doi.org/10.1000/EXISTING' : '10.1000/existing',actor)));
assert.equal(parallel.filter(result=>result.created).length,1);
assert.equal(new Set(parallel.map(result=>result.id)).size,1);
assert.deepEqual(JSON.parse(bucket.value).items['10.1000/existing'].sides,{local:{historical:true}});
assert.equal(JSON.parse(bucket.value).cloudControl.quota.total,1);
// New instance sees durable state; process-local sets are not the source of truth.
assert.equal((await new CanonicalLedger(bucket,'test-cutover').submit('10.1000/existing',actor)).created,false);
const claims = await Promise.all(Array.from({length:24},(_,i)=>new CanonicalLedger(bucket,'test-cutover').claimNext(`${i+1}:1`)));
assert.equal(claims.filter(result=>result.claimed).length,1);
assert.equal((await ledger.claimNext('99:1')).reason,'executor_occupied');
assert.equal((await new CanonicalLedger(bucket,'test-cutover',()=>Date.now()+365*86400000).claimNext('99:1')).claimed,false,'elapsed time cannot steal execution');
await assert.rejects(()=>new CanonicalLedger(bucket,'unapproved-owner').submit('10.1000/new',actor),/owner_cutover_required/);
const missing = new AtomicBucket(); missing.value = null;
await assert.rejects(()=>new CanonicalLedger(missing,'test-cutover').submit('10.1000/new',actor),/ledger_unavailable/);
for (const doi of ['10.1000/../secret','10.1000/%252fsecret','http://127.0.0.1/secret','10.1000/a?url=https://x']) await assert.rejects(()=>ledger.submit(doi,actor),/bad_doi/);
bucket = new AtomicBucket(); ledger = new CanonicalLedger(bucket,'test-cutover');
for (let i=0;i<20;i++) await ledger.submit('10.1000/quota'+i,actor);
await assert.rejects(()=>ledger.submit('10.1000/quota20',actor),/daily_limit/);
assert.equal((await ledger.submit('10.1000/quota0',actor)).created,false,'reuse does not consume quota');
let calls = 0;
for (const status of [200,204,403,429,500]) {
  const result = await dispatchWakeup('synthetic-dispatch-only',async(url,options)=>{
    calls++; assert.equal(new URL(url).hostname,'api.github.com');assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{mode:'drain'}});
    return status===200 ? Response.json({workflow_run_id:123}) : new Response(null,{status});
  });
  assert.equal(result.accepted,[200,204].includes(status));
  await ledger.noteDispatch(sha('10.1000/quota0'),result);
  assert.equal(JSON.parse(bucket.value).items['10.1000/quota0'].website.status,'submitted');
}
assert.equal(calls,5,'no implicit dispatch retries');
assert.deepEqual(await dispatchWakeup('synthetic',async()=>{throw Error('private upstream text');}),{accepted:false,status:'unknown'});
const manifest = {sha256:sha('pdf'),indexSha256:sha('index'),generation:'synthetic-run-1',bytes:51200,strictVerified:true};
const receipts = Object.fromEntries(['github','drive','mac'].map(side=>[side,{...manifest,side,currentReadback:true,objectVersion:'synthetic-object-version'}]));
assert.equal(archiveStatus(manifest,receipts).status,'complete');
for (const invalid of [undefined,{...receipts.mac,currentReadback:false},{...receipts.mac,generation:'historical'},{...receipts.mac,sha256:sha('changed')},{...receipts.mac,indexSha256:sha('old-index')}]) assert.equal(archiveStatus(manifest,{...receipts,mac:invalid}).status,'sync_pending');
assert.equal(archiveStatus({...manifest,strictVerified:false},receipts).status,'sync_pending');
// Ephemeral synthetic signing keys only; no actual GitHub token is requested or stored.
const pair = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk = {...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'test-key',use:'sig',alg:'RS256'};
const now = 1791367200, workflowSha = 'a'.repeat(40), policy = {workflowShas:[workflowSha]};
const claimsBase = {iss:'https://token.actions.githubusercontent.com',aud:'https://learn.dryz.info/doi-archive',repository:'dodoxiaxia/xinzhi',repository_id:'1397425558',repository_owner_id:'214921265',ref:'refs/heads/main',event_name:'workflow_dispatch',workflow_ref:'dodoxiaxia/xinzhi/.github/workflows/archive-doi.yml@refs/heads/main',workflow_sha:workflowSha,run_id:'100',run_attempt:'1',iat:now,nbf:now,exp:now+300};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function sign(changes={},headerChanges={}) {
  const payload = encode({alg:'RS256',kid:'test-key',...headerChanges})+'.'+encode({...claimsBase,...changes});
  return payload+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(payload))).toString('base64url');
}
let jwksCalls = 0;
const jwksFetch = async(url,options)=>{jwksCalls++;assert.equal(url,'https://token.actions.githubusercontent.com/.well-known/jwks');assert.equal(options.redirect,'error');return Response.json({keys:[jwk]});};
assert.deepEqual(await verifyExecutorJwt(await sign(),policy,jwksFetch,now),{run:'100:1',workflowSha});
for (const changes of [{exp:now},{aud:'wrong'},{ref:'refs/pull/1/merge'},{repository_id:'1'},{workflow_sha:'b'.repeat(40)},{event_name:'pull_request'},{run_id:'1;unsafe'}]) await assert.rejects(()=>sign(changes).then(token=>verifyExecutorJwt(token,policy,jwksFetch,now)),/executor_unauthorized/);
assert.equal(jwksCalls,1,'invalid claims never fetch supplied key URLs');
for (const header of [{alg:'none'},{jku:'https://attacker.example/key'},{kid:'unknown'}]) await assert.rejects(()=>sign({},header).then(token=>verifyExecutorJwt(token,policy,jwksFetch,now)),/executor_unauthorized/);
const valid = await sign(),tampered=valid.split('.');tampered[1]=encode({...claimsBase,run_id:'999'});
await assert.rejects(()=>verifyExecutorJwt(tampered.join('.'),policy,jwksFetch,now),/executor_unauthorized/);
await assert.rejects(()=>verifyExecutorJwt(valid,{workflowShas:[]},jwksFetch,now),/executor_unauthorized/);
console.log('Bridge OFFLINE contracts passed: 24-way DOI dedupe/claim, durable state reload, no stale-claim takeover, quota, dispatch acknowledgement, OIDC signature/claims, historical/offline receipt exclusion. No deployment or real archive writes.');
