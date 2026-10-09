'use strict';
const assert = require('assert');
const {setup,token} = require('./test_fulltext_auth_helpers.cjs');
const {doi,title,pdf,hash,seed,error} = require('./test_doi_library_worker.cjs');
const {runReview} = require('./muse_review_runner.cjs');
const base = 'https://learn.dryz.info',reviewUrl = base + '/api/muse/review',secret = 'synthetic_muse_key_0123456789_abcdef';
const original = Buffer.from('%PDF-1.7\nSynthetic private original\n' + 'x'.repeat(52000) + '\n%%EOF\n');
async function create(options = {}) {const h = await setup(options);h.env.MUSE_FULLTEXT_ENABLED = 'true';h.env.MUSE_FULLTEXT_KEY = secret;return h;}
async function api(h,path,body = {},options = {}) {
  const headers = {authorization:'Bearer ' + (options.key || secret),'content-type':'application/json',...(options.headers || {})};
  return h.context.worker.fetch(new Request(base + '/api/muse/' + path,{method:options.method || 'POST',headers,body:options.raw === undefined ? JSON.stringify(body) : options.raw}),h.env);
}
async function review(h,body,options = {}) {
  const auth = options.token === undefined ? await token(h,reviewUrl,'muse-review.yml',options.claims) : options.token;
  return h.context.worker.fetch(new Request(reviewUrl,{method:'POST',headers:{authorization:'Bearer ' + auth,'content-type':'application/json'},body:JSON.stringify(body)}),h.env);
}
async function enqueue(h) {const r = await h.request();assert.equal(r.status,202);return (await r.json()).job;}
async function claim(h) {const r = await api(h,'claim');assert.equal(r.status,200);return (await r.json()).task;}
function identity(task) {return {doi:task.doi,taskId:task.taskId,leaseId:task.leaseId};}
async function upload(h,task,bytes = original) {
  const receipt = await api(h,'receipt',{...identity(task),state:'uploaded',sha256:hash(bytes),bytes:bytes.length,driveFileId:'syntheticDriveFileId12345'});
  assert.equal(receipt.status,200);
  const progress = await receipt.json(); assert.equal(progress.job.stage,'uploading'); assert(!JSON.stringify(progress.job).includes('leaseId'));
  return api(h,'upload',{}, {method:'PUT',raw:bytes,headers:{'content-type':'application/pdf','x-muse-doi':task.doi,'x-muse-task-id':task.taskId,'x-muse-lease-id':task.leaseId}});
}
const proof = task => ({action:'complete',...identity(task),sha256:task.sha256,bytes:task.bytes,result:'verified',pages:13,method:'dual_parser_all_pages_title_doi'});
(async () => {
  let h = await setup(); await error(await api(h,'claim'),503,'muse_disabled'); assert.equal(h.reads.length,0);
  const protocol = await (await h.context.worker.fetch(new Request(base + '/api/muse/protocol'),h.env)).json(); assert.equal(protocol.enabled,false); assert.equal(protocol.upload.body,'original_pdf_bytes'); assert.equal(h.reads.length,0); assert.equal(h.calls.length,0);
  h = await create(); await error(await api(h,'claim',{}, {key:'wrong'}),401,'muse_unauthorized'); assert.equal(h.reads.length,0); assert.equal(h.writes.length,0); assert.equal(h.calls.length,0);
  const enabledProtocol = await (await h.context.worker.fetch(new Request(base + '/api/muse/protocol'),h.env)).json(); assert.equal(enabledProtocol.enabled,true); assert(!JSON.stringify(enabledProtocol).includes(secret));
  await error(await review(h,{action:'claim'},{token:secret}),401,'job_auth'); assert.equal(h.reads.length,0);
  h.env.GROK_FULLTEXT_ENABLED = 'true'; await error(await api(h,'claim'),409,'muse_owner_conflict'); assert.equal(h.reads.length,0);
  h = await create(); h.env.FULLTEXT_ASYNC_ENABLED = 'true'; await error(await api(h,'claim'),409,'muse_owner_conflict');
  h = await create(); const queued = await enqueue(h),writes = h.writes.length;
  const again = await enqueue(h); assert.equal(again.id,queued.id); assert.equal(h.writes.length,writes);
  assert(h.calls.every(c => /crossref/.test(c.url))); assert(!JSON.stringify(again).includes(secret));
  const lookup = await (await h.request('/api/library',{method:'GET'})).json(); assert.equal(lookup.job.state,'queued'); assert.equal(lookup.job.stage,'queued'); assert.equal(lookup.status,'pending'); assert.equal(lookup.paper.fulltextStatus,'pending'); assert.equal(JSON.parse(h.values.get('library:paper:' + doi)).paper.fulltextStatus,'manual_needed','projection does not mutate bibliography');
  assert.equal(h.context.museNextVerificationAt(Date.parse('2026-10-09T11:22:00Z')),'2026-10-09T11:23:00.000Z');
  assert.equal(h.context.museNextVerificationAt(Date.parse('2026-10-09T11:23:00Z')),'2026-10-09T12:23:00.000Z');
  const page = await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}}); assert.equal(page.status,202); assert((await page.text()).includes('60 秒只更新状态'));
  const task = await claim(h); assert.equal(task.taskId,queued.id); assert.equal(task.title,title); assert.deepEqual(task.sources,['open_access','authorized_hamburg']);
  assert.equal((await (await api(h,'claim')).json()).task,null,'one acquisition owner, no repeated lease');
  await error(await api(h,'receipt',{...identity(task),leaseId:'00000000-0000-4000-8000-000000000001',state:'failed'}),409,'muse_stale');
  await error(await api(h,'receipt',{...identity(task),state:'uploaded',sha256:hash(original),bytes:original.length,driveFileId:'https://evil.test/pdf'}),400,'muse_bad_request');
  await error(await api(h,'receipt',{...identity(task),state:'running',cookie:'secret'}),400,'muse_bad_request');
  const uploaded = await upload(h,task); assert.equal(uploaded.status,200); const intake = await uploaded.json(); assert.equal(intake.verified,false); assert.equal(intake.job.state,'pending'); assert.equal(intake.job.stage,'verifying'); assert(intake.job.nextVerificationAt); assert.equal(intake.job.nextCheckSeconds,60);
  const verifyingLookup = await (await h.request('/api/library',{method:'GET'})).json(); assert.equal(verifyingLookup.status,'pending'); assert.equal(verifyingLookup.job.stage,'verifying');
  const catalog = await (await h.request('/api/library',{method:'GET',query:'limit=20'})).json(); assert.equal(catalog.papers[0].fulltextStatus,'pending'); assert.equal(catalog.jobs[0].stage,'verifying');
  const waitingHtml = await (await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}})).text(); assert(waitingHtml.includes('下一次计划核验')); assert(waitingHtml.includes('GitHub 队列可能延迟')); assert(waitingHtml.includes('aria-current="step"')); assert(!waitingHtml.includes('syntheticDriveFileId')); assert(!waitingHtml.includes(task.leaseId)); assert.equal(intake.archive.complete,false);
  const current = JSON.parse(h.values.get('library:paper:' + doi)); assert.notEqual(current.paper.fulltextStatus,'available');
  assert(!h.values.has('library:pdf:' + hash(original)),'unverified bytes cannot be served as full text');
  const duplicate = await api(h,'receipt',{...identity(task),state:'uploaded',sha256:hash(original),bytes:original.length,driveFileId:'syntheticDriveFileId12345'}); assert.equal(duplicate.status,200); assert.equal((await duplicate.json()).needsUpload,false);
  const reviewClaim = await review(h,{action:'claim'}); assert.equal(reviewClaim.status,200); const candidate = (await reviewClaim.json()).task;
  assert.equal(candidate.sha256,hash(original)); assert.notEqual(candidate.leaseId,task.leaseId);
  const privateBytes = await review(h,{action:'bytes',...identity(candidate)}); assert.deepEqual(Buffer.from(await privateBytes.arrayBuffer()),original);
  await error(await review(h,{...proof(candidate),pages:0}),400,'muse_bad_request');
  await error(await review(h,{...proof(candidate),method:'agent_says_ok'}),400,'muse_bad_request');
  const done = await review(h,proof(candidate)); assert.equal(done.status,200); const result = await done.json(); assert.equal(result.job.state,'available'); assert.equal(result.job.stage,'available');
  const readyCatalog = await (await h.request('/api/library',{method:'GET',query:'limit=20'})).json(); assert.equal(readyCatalog.papers[0].fulltextStatus,'available','task transitions invalidate catalog cache'); assert.equal(result.archive.complete,false); assert.equal(result.archive.sides.drive,'reported');
  const ready = await h.request('/api/fulltext'); assert.equal(ready.status,200); assert.deepEqual(Buffer.from(await ready.arrayBuffer()),original); assert.equal(ready.headers.get('x-xinzhi-archive-status'),'not-confirmed');
  assert.equal((await h.request('/api/fulltext',{passphrase:'wrong'})).status,403);
  const savedWrites = h.writes.length; assert.equal((await review(h,proof(candidate))).status,200); assert.equal(h.writes.length,savedWrites,'duplicate verified receipt is idempotent');
  assert(!JSON.stringify(result).includes('syntheticDriveFileId')); assert(!JSON.stringify(result).includes('leaseId')); assert(!JSON.stringify(result).includes(secret));
  h = await create(); await enqueue(h); const bad = await claim(h); const malformed = Buffer.from('<html>' + 'x'.repeat(52000) + '</html>'); await error(await upload(h,bad,malformed),409,'library_identity'); assert(!h.values.has('library:pdf:' + hash(malformed)));
  h = await create({putError:k => k.startsWith('library:muse-candidate:')}); await enqueue(h); const failed = await claim(h); await error(await upload(h,failed),503,'library_storage'); assert.equal(JSON.parse(h.values.get('library:muse-job:' + doi)).state,'uploading');
  h = await create(); await enqueue(h); const loginTask = await claim(h); assert.equal((await api(h,'receipt',{...identity(loginTask),state:'login_required'})).status,200);
  assert.equal((await (await api(h,'claim')).json()).task,null); assert.equal((await api(h,'receipt',{...identity(loginTask),state:'running'})).status,200,'same owner resumes after browser login');
  assert.equal(JSON.parse(h.values.get('library:muse-job:' + doi)).id,loginTask.taskId);
  h = await create(); await enqueue(h); const rejectedTask = await claim(h); assert.equal((await upload(h,rejectedTask)).status,200); const rejectedCandidate = (await (await review(h,{action:'claim'})).json()).task;
  assert.equal((await review(h,{...proof(rejectedCandidate),result:'rejected',pages:0})).status,200); assert(!h.values.has('library:pdf:' + hash(original))); assert.equal(JSON.parse(h.values.get('library:muse-job:' + doi)).state,'review');
  h = await create(); await enqueue(h); const corruptedTask = await claim(h); await upload(h,corruptedTask); const corruptedCandidate = (await (await review(h,{action:'claim'})).json()).task;
  h.values.set('library:muse-candidate:' + hash(original),Buffer.from('corrupt')); await error(await review(h,proof(corruptedCandidate)),502,'library_integrity'); assert(!h.values.has('library:pdf:' + hash(original)));
  h = await create(); await enqueue(h); const conflictTask = await claim(h); await upload(h,conflictTask); const conflictCandidate = (await (await review(h,{action:'claim'})).json()).task;
  seed(h); await error(await review(h,proof(conflictCandidate)),409,'library_identity'); assert.deepEqual(h.values.get('library:pdf:' + hash(pdf)),pdf);
  h = await create({clock:{now:Date.now()}}); await enqueue(h); const expired = await claim(h); h.context.Date.now = () => Date.now() + 1300000;
  await error(await api(h,'receipt',{...identity(expired),state:'running'}),409,'muse_stale'); assert.equal((await (await api(h,'claim')).json()).task,null,'expired acquisitions are not redownloaded');
  const expiredLookup = await (await h.request('/api/library',{method:'GET'})).json(); assert.equal(expiredLookup.job.reason,'lease_expired'); assert(expiredLookup.job.message.includes('领取凭据已过期')); assert(!expiredLookup.job.nextCheckSeconds);
  const restoreWrites = h.writes.length, restoreCalls = h.calls.length;
  const restoreForm = await h.request('/api/muse/retry',{method:'GET',headers:{accept:'text/html'}});
  assert.equal(restoreForm.status,200); assert((await restoreForm.text()).includes('确认重新入队')); assert.equal(h.writes.length,restoreWrites); assert.equal(h.calls.length,restoreCalls);
  assert.equal((await h.request('/api/muse/retry',{passphrase:'wrong'})).status,403); assert.equal(h.writes.length,restoreWrites);
  const restored = await h.request('/api/muse/retry'); assert.equal(restored.status,202); const restoredJob = (await restored.json()).job;
  assert.notEqual(restoredJob.id,expired.taskId); assert.equal(restoredJob.state,'queued'); assert.equal(h.calls.length,restoreCalls,'recover reuses saved official bibliography');
  const restoreDedup = h.writes.length; assert.equal((await h.request('/api/muse/retry')).status,202); assert.equal(h.writes.length,restoreDedup,'double confirmation does not replace active job');
  await error(await api(h,'receipt',{...identity(expired),state:'running'}),409,'muse_stale');
  const resumed = await claim(h); assert.equal(resumed.taskId,restoredJob.id);
  const protectedWrites = h.writes.length; await h.request('/api/muse/retry'); assert.equal(h.writes.length,protectedWrites,'an active lease is never replaced');
  assert.equal((await upload(h,resumed)).status,200); const candidateWrites = h.writes.length; await h.request('/api/muse/retry'); assert.equal(h.writes.length,candidateWrites,'a verification candidate is never replaced');
  h = await create(); await enqueue(h); const pausedTask = await claim(h); await api(h,'receipt',{...identity(pausedTask),state:'failed'});
  h.values.set('library:attempt:' + doi,JSON.stringify({paused:true,error:'library_paused'}));
  await error(await h.request('/api/muse/retry'),423,'library_paused'); assert.equal((await (await api(h,'claim')).json()).task,null);
  h = await create(); await enqueue(h); const agentFailed = await claim(h); await api(h,'receipt',{...identity(agentFailed),state:'failed'});
  assert.equal((await (await h.request('/api/library',{method:'GET'})).json()).job.reason,'agent_failed');
  h = await create(); await enqueue(h); const runnerTask = await claim(h); await upload(h,runnerTask);
  const env = {GITHUB_EVENT_NAME:'workflow_dispatch',ACTIONS_ID_TOKEN_REQUEST_URL:'https://unit.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-runtime-token'},logs = [];
  const http = async (url,init) => {
    if (new URL(url).hostname === 'unit.actions.githubusercontent.com') { assert.equal(new URL(url).searchParams.get('audience'),reviewUrl); return Response.json({value:await token(h,reviewUrl,'muse-review.yml')}); }
    return h.context.worker.fetch(new Request(url,init),h.env);
  };
  assert.equal(await runReview(env,http,async (bytes,t) => {assert.deepEqual(bytes,original);return {verified:true,pages:13,method:'dual_parser_all_pages_title_doi',sha256:t.sha256,bytes:t.bytes};},x => logs.push(x),async () => {}),1);
  assert(!logs.join('').includes(secret)); assert(!logs.join('').includes('synthetic-runtime-token')); assert(!logs.join('').includes('Bearer'));
  for (const changes of [{aud:'https://learn.dryz.info/api/fulltext-import'},{event_name:'pull_request'},{repository_id:'2'},{workflow_ref:'dodoxiaxia/xinzhi/.github/workflows/fulltext.yml@refs/heads/main'}]) {
    h = await create(); await error(await review(h,{action:'claim'},{claims:changes}),401,'job_auth'); assert.equal(h.reads.length,0);
  }
  h = await create(); const immutableClaim = await review(h,{action:'claim'},{claims:{sub:'repo:dodoxiaxia@214921265/xinzhi@1397425558:ref:refs/heads/main'}});
  assert.equal(immutableClaim.status,200); assert.equal((await immutableClaim.json()).task,null);
  console.log('Muse: protected polling, ownership, bounded original upload, independent OIDC verification, quarantine and cache passed');
})().catch(error => {console.error(error);process.exitCode = 1;});
