'use strict';
const assert = require('assert');
const {setup,token} = require('./test_fulltext_auth_helpers.cjs');
const {doi,pdf,hash,record,seed,error} = require('./test_doi_library_worker.cjs');
const {runImport,manifest,serviceError,failureLog,ready} = require('./fulltext_import_runner.cjs');
const endpoint = 'https://learn.dryz.info/api/fulltext-import',commit = 'a'.repeat(40);
const input = {doi,githubCommit:commit,sha256:hash(pdf)};
async function service(h,body = input,opts = {}) {
  const auth = opts.token === undefined ? await token(h,endpoint,'fulltext-import.yml',opts.claims) : opts.token;
  return h.context.worker.fetch(new Request(endpoint + (opts.query || ''),{method:opts.method || 'POST',headers:{authorization:'Bearer ' + auth,'content-type':'application/json'},
    ...((opts.method || 'POST') === 'POST' ? {body:opts.raw === undefined ? JSON.stringify(body) : opts.raw} : {})}),h.env);
}
(async () => {
  let h = await setup();
  await error(await service(h,input,{method:'GET'}),405,'import_bad_request');
  for (const claims of [{aud:'other'},{event_name:'schedule'},{event_name:'pull_request'},{repository_id:'1'},{ref:'refs/heads/other'},
    {workflow_ref:'dodoxiaxia/xinzhi/.github/workflows/fulltext.yml@refs/heads/main'},{runner_environment:'self-hosted'},{exp:1},
    {sub:'repo:dodoxiaxia@1/xinzhi@1397425558:ref:refs/heads/main'},{sub:'repo:dodoxiaxia@214921265/xinzhi@1397425559:ref:refs/heads/main'},
    {sub:'repo:dodoxiaxia@214921265/xinzhi@1397425558:ref:refs/heads/other'},{sub:'repo:dodoxiaxia@214921265/xinzhi@1397425558:environment:production'}]) {
    h = await setup(); await error(await service(h,input,{claims}),401,'job_auth'); assert.equal(h.reads.length,0); assert.equal(h.writes.length,0); assert.equal(h.calls.length,0);
  }
  h = await setup(); const signed = await token(h,endpoint,'fulltext-import.yml');
  await error(await service(h,input,{token:signed.split('.').slice(0,2).join('.') + '.d3Jvbmc'}),401,'job_auth'); assert.equal(h.reads.length,0);
  h = await setup(); assert.equal((await service(h,input,{claims:{sub:'repo:dodoxiaxia@214921265/xinzhi@1397425558:ref:refs/heads/main'}})).status,200,'GitHub immutable main subject accepted with all other claims pinned');
  h = await setup({cachedKeys:true,jwksResponse:() => new Response('unavailable',{status:503})});
  assert.equal((await service(h)).status,200); assert(!h.calls.some(c => c.url.hostname === 'token.actions.githubusercontent.com'),'fresh published public keys verify without runtime issuer fetch');
  h = await setup({cachedKeys:true,jwksResponse:() => new Response('unavailable',{status:503})});
  const badSignature = await token(h,endpoint,'fulltext-import.yml');
  await error(await service(h,input,{token:badSignature.split('.').slice(0,2).join('.') + '.d3Jvbmc'}),401,'job_auth'); assert.equal(h.reads.length,0);
  h = await setup({buildKeys:{fetchedAt:Date.now()-86400001,expiresAt:Date.now()-1,keys:[]},jwksResponse:() => new Response('unavailable',{status:503})});
  await error(await service(h),503,'job_auth_unavailable'); assert.equal(h.reads.length,0);
  for (const body of [{...input,url:'https://evil.test/x'},{...input,githubCommit:'main'},{...input,sha256:'b'},{...input,doi:'https://doi.org/' + doi},null]) {
    h = await setup(); await error(await service(h,body),400,'import_bad_request'); assert.equal(h.reads.length,0); assert.equal(h.writes.length,0);
  }
  h = await setup(); await error(await service(h,input,{raw:'x'.repeat(1025)}),413,'import_bad_request'); assert.equal(h.reads.length,0);
  h = await setup(); h.env.DOI_LOOKUP_LATEST_MAIN = 'true'; h.env.DOI_GITHUB_DELTA_ENABLED = 'true'; h.env.PDF_GITHUB_COMMIT = 'b'.repeat(40);
  h.values.set('library:paper:' + doi,JSON.stringify(record('pending')));
  const response = await service(h); assert.equal(response.status,200); const result = await response.json();
  assert.equal(result.status,'available'); assert.equal(result.source.sha256,input.sha256); assert.equal(result.source.githubCommit,commit); assert.equal(result.archive.complete,false);
  assert.equal(result.archive.sides.github,'verified'); assert.equal(result.archive.sides.drive,'pending');
  assert(!h.calls.some(x => /\/commits\/|按需|unpaywall|openalex|plos|emedien|sciencedirect|muse\.ai/.test(x.url)));
  const pdfWrites = h.writes.filter(x => /^library:(pdf|paper):/.test(x.key)).length;
  assert.equal((await service(h)).status,200); assert.equal(h.writes.filter(x => /^library:(pdf|paper):/.test(x.key)).length,pdfWrites,'repeat import does not rewrite original cache');
  assert.equal((await h.request('/api/fulltext',{passphrase:'wrong'})).status,403);
  const download = await h.request('/api/fulltext'); assert.equal(download.status,200); assert.deepEqual(Buffer.from(await download.arrayBuffer()),pdf);
  h = await setup(); await error(await service(h,{...input,sha256:'b'.repeat(64)}),409,'library_identity'); assert(!h.writes.some(x => x.key.startsWith('library:pdf:')));
  h = await setup({rows:[]}); await error(await service(h),409,'library_identity'); assert.equal(h.writes.length,0);
  const pointer = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + hash(pdf) + '\nsize ' + pdf.length + '\n');
  h = await setup({pointer,lfsBatch:() => { throw Error('private-source-credentials'); }});
  const sourceFailure = await service(h), sourceBody = await sourceFailure.json();
  assert.equal(sourceFailure.status,502); assert.equal(sourceBody.error,'pdf_upstream');
  assert.equal(sourceBody.diagnostic.stage,'lfs_batch'); assert.equal(sourceBody.diagnostic.reason,'network');
  assert(!JSON.stringify(sourceBody).includes('private-source-credentials')); assert.equal(h.writes.length,0);
  h = await setup({pointer,lfsBatch:() => new Response('private-source-credentials',{status:403})});
  const sourceDenied = await service(h), deniedBody = await sourceDenied.json();
  assert.equal(sourceDenied.status,423); assert.equal(deniedBody.diagnostic.httpStatus,403);
  assert(!h.calls.some(x => x.url.hostname === 'github-cloud.s3.amazonaws.com')); assert.equal(h.writes.length,0);
  h = await setup(); const unauthorized = await service(h,input,{claims:{aud:'other'}});
  assert(!Object.hasOwn(await unauthorized.json(),'diagnostic')); assert.equal(h.calls.length,0);
  h = await setup({rows:[['Wrong title',doi,'Heart','2026-10-07','publisher','wrong.pdf',hash(pdf)]]}); await error(await service(h),409,'library_identity'); assert.equal(h.writes.length,0);
  h = await setup(); seed(h,{...record(),pdf:{...record().pdf,sha256:'b'.repeat(64),key:'library:pdf:' + 'b'.repeat(64)}});
  await error(await service(h),409,'library_identity'); assert.equal(h.calls.length,1,'only JWKS');
  h = await setup(); h.values.set('library:paper:' + doi,JSON.stringify(record('review'))); await error(await service(h),409,'library_identity');
  h = await setup({putError:k => k.startsWith('library:pdf:')}); await error(await service(h),503,'library_storage'); assert(!h.values.has('library:paper:' + doi));
  h = await setup(); seed(h); h.values.set('library:pdf:' + hash(pdf),Buffer.from('%PDF-broken')); await error(await service(h),502,'library_integrity');
  h = await setup(); const grok = {version:1,id:'00000000-0000-4000-8000-000000000001',doi,state:'running',createdAt:Date.now(),updatedAt:Date.now()};
  h.values.set('library:grok-job:' + doi,JSON.stringify(grok)); await error(await service(h),409,'import_owner_conflict'); assert.equal(h.writes.length,0);
  h = await setup(); h.env.FULLTEXT_ASYNC_ENABLED = 'true';
  const queueToken = await token(h,'https://learn.dryz.info/api/fulltext-worker','fulltext.yml'); await error(await service(h,input,{token:queueToken}),401,'job_auth');
  const importToken = await token(h,endpoint,'fulltext-import.yml');
  const cross = await h.context.worker.fetch(new Request('https://learn.dryz.info/api/fulltext-worker',{method:'POST',headers:{authorization:'Bearer ' + importToken,'content-type':'application/json'},body:'{"action":"claim"}'}),h.env);
  assert.equal(cross.status,401);
  assert.throws(() => manifest({schemaVersion:1,requests:[input,input]}),/invalid_manifest/);
  assert.throws(() => manifest({schemaVersion:1,requests:[{...input,pdf:'secret'}]}),/invalid_manifest/);
  h = await setup(); const logs = [], env = {GITHUB_EVENT_NAME:'push',ACTIONS_ID_TOKEN_REQUEST_URL:'https://unit.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-runtime-token'};
  const http = async (url,init) => {
    if (new URL(url).hostname === 'unit.actions.githubusercontent.com') { assert.equal(new URL(url).searchParams.get('audience'),endpoint); return Response.json({value:await token(h,endpoint,'fulltext-import.yml')}); }
    return h.context.worker.fetch(new Request(url,init),h.env);
  };
  assert.equal(await runImport({schemaVersion:1,requests:[input]},env,http,x => logs.push(x),async () => {}),1);
  assert(!logs.join('').includes('synthetic-runtime-token')); assert(!logs.join('').includes('Bearer'));
  await assert.rejects(runImport({schemaVersion:1,requests:[input]},env,async () => new Response('{}',{status:403}),() => {},async () => {}),/website_denied/);
  let deniedCalls = 0;
  await assert.rejects(runImport({schemaVersion:1,requests:[input]},env,async () => {deniedCalls++;return new Response('<html>denied</html>',{status:403});},() => {},async () => {}),/website_denied/);
  assert.equal(deniedCalls,1,'HTML denial stops before JSON parsing or another probe');
  await assert.rejects(runImport({schemaVersion:1,requests:[input]},env,async () => new Response('limited',{status:429}),() => {},async () => {}),/website_denied/);
  const diagnostic = serviceError('import_unavailable',{status:401},{error:'job_auth'},await token(h,endpoint,'fulltext-import.yml'),endpoint,'fulltext-import.yml');
  assert.equal(diagnostic.reason,'job_auth'); assert.equal(diagnostic.oidcChecks.workflow,true); assert.equal(diagnostic.oidcChecks.audience,true);
  const safeLog = failureLog(diagnostic,'import_unavailable'); assert(!safeLog.includes('Bearer')); assert(!safeLog.includes('workflow_ref')); assert(!safeLog.includes('eyJ'));
  assert.equal(serviceError('import_unavailable',{status:502},{error:'https://private.test/?token=secret'},'',endpoint,'fulltext-import.yml').reason,'unclassified_response');
  const sourceLog = failureLog(serviceError('import_unavailable',{status:502},{error:'pdf_upstream',diagnostic:{...sourceBody.diagnostic,url:'https://private.test/?token=secret',body:'secret'}},'',endpoint,'fulltext-import.yml'),'import_unavailable');
  assert.equal(JSON.parse(sourceLog).sourceChecks.stage,'lfs_batch'); assert(!sourceLog.includes('private.test')); assert(!sourceLog.includes('secret'));
  let probes = 0;
  await ready(endpoint,'import_bad_request',async () => {probes++;return Response.json({error:'import_bad_request',protocolVersion:probes > 1 ? 5 : 4},{status:405});},async () => {},5);
  assert.equal(probes,2,'existing old route is not proof that the new identity policy deployed');
  console.log('fulltext import: exact OIDC scope, immutable source, protected cache, failures and runner passed');
})().catch(error => {console.error(error);process.exitCode = 1;});
