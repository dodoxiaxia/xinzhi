'use strict';
// Exercise actual routes with synthetic webhook, repository and receipt responses.
// No live Bot, publisher, credentials or PDF downloads.
const assert = require('node:assert/strict');
const {harness,doi,title,pdf,hash,seed,error} = require('./test_doi_library_worker.cjs');
const webhook = 'https://api.cursor.sh/synthetic-routine';
const webhookKey = 'synthetic-webhook-key-01234567890123456789';
const receiptKey = 'synthetic-receipt-key-01234567890123456789';
const jobKey = 'library:grok-job:' + doi;
function setup(options = {}, respond = () => new Response(null,{status:200})) {
  const sources = {rows:[],oa:false,...options}, h = harness(sources), original = h.context.fetch;
  Object.assign(h.env,{GROK_FULLTEXT_ENABLED:'true',GROK_FULLTEXT_WEBHOOK_URL:webhook,
    GROK_FULLTEXT_WEBHOOK_KEY:webhookKey,GROK_FULLTEXT_RECEIPT_KEY:receiptKey});
  h.webhooks = [];
  h.context.fetch = async (url,init) => {
    if (new URL(url).hostname !== 'api.cursor.sh') return original(url,init);
    h.webhooks.push({url:String(url),init});
    assert.equal(init.method,'POST'); assert.equal(init.redirect,'manual');
    assert.equal(init.headers.authorization,'Bearer ' + webhookKey);
    assert.equal(init.headers.cookie,undefined);
    assert(!JSON.stringify(init).includes('synthetic-private-token'));
    const body = JSON.parse(init.body);
    assert(!init.body.includes(receiptKey)); assert(!init.body.includes(webhookKey));
    assert(!init.body.includes('synthetic-passphrase')); assert.equal(body.doi,doi);
    assert.equal(body.idempotencyKey,'doi:' + doi);
    assert.equal(body.receiptUrl,'https://learn.dryz.info/api/grok-fulltext-receipt');
    assert.equal(body.institutionLoginUrl,'https://login.emedien3.sub.uni-hamburg.de/han/ScienceDirectElsevierJournalBackfiles');
    assert.equal(body.institutionUrl,'https://dx-1doi-1org-10039f8q70087.emedien3.sub.uni-hamburg.de/' + doi);
    assert.equal(JSON.parse(h.values.get(jobKey)).id,body.taskId,'persist correlation before dispatch');
    return respond(url,init,h);
  };
  h.sources = sources;
  return h;
}
async function receipt(h,body,options = {}) {
  return h.context.worker.fetch(new Request('https://site.test/api/grok-fulltext-receipt' + (options.query || ''),{
    method:options.method || 'POST',headers:{authorization:'Bearer ' + (options.key === undefined ? receiptKey : options.key),
      'content-type':options.type || 'application/json'},
    ...((options.method || 'POST') === 'POST' ? {body:options.raw === undefined ? JSON.stringify(body) : options.raw} : {})
  }),h.env);
}
async function submit(h) {
  const response = await h.request();
  assert.equal(response.status,202);
  const body = await response.json();
  assert.equal(body.job.state,'queued');
  assert.equal(body.archive.complete,false);
  const publicText = JSON.stringify(body);
  for (const secret of [webhookKey,receiptKey,'synthetic-private-token','synthetic-passphrase']) assert(!publicText.includes(secret));
  return body.job;
}
function published(h) {
  h.sources.commit = 'b'.repeat(40);
  h.sources.rows = [[title,doi,'Heart','2026-10-07','publisher','期刊/试验.pdf',hash(pdf)]];
  return {taskId:JSON.parse(h.values.get(jobKey)).id,doi,state:'uploaded',
    githubCommit:h.sources.commit,sha256:hash(pdf),reportedSides:{mac:true,drive:true}};
}
async function browserCheck() {
  const fs = require('node:fs'), {chromium} = require('playwright');
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium'});
  const h = setup(), origin = 'https://grok-browser.invalid', requests = [];
  try {
    const page = await browser.newPage();
    await page.route('**/*',async route => {
      const req = route.request();
      assert.equal(new URL(req.url()).origin,origin,'the institution is never navigated in this test');
      requests.push({method:req.method(),url:req.url()});
      const response = await h.context.worker.fetch(new Request(req.url(),{method:req.method(),headers:req.headers(),
        ...(req.method() === 'POST' ? {body:req.postData()} : {})}),h.env);
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    await page.goto(origin + '/api/acquire?doi=' + encodeURIComponent(doi));
    await page.locator('#passphrase').fill('synthetic-passphrase');
    await page.locator('button[type="submit"]').click();
    await page.getByText('后台已接受任务，正在等待处理结果。',{exact:true}).waitFor();
    assert.equal(h.webhooks.length,1);
    const taskId = JSON.parse(h.values.get(jobKey)).id;
    await receipt(h,{taskId,doi,state:'login_required'});
    await page.getByRole('link',{name:'刷新任务状态',exact:true}).click();
    await page.getByText('后台机构会话需要重新登录，请维护者在原浏览器中处理后继续。',{exact:true}).waitFor();
    assert.equal(await page.locator('meta[http-equiv="refresh"]').count(),0);
    const loginLink = page.getByRole('link',{name:'汉堡登录入口',exact:true});
    assert.equal(await loginLink.getAttribute('href'),'https://login.emedien3.sub.uni-hamburg.de/han/ScienceDirectElsevierJournalBackfiles');
    assert.equal(await loginLink.getAttribute('target'),'_blank');
    assert((await loginLink.getAttribute('rel')).includes('noreferrer'));
    assert.equal(await page.getByRole('link',{name:'通过汉堡访问全文',exact:true}).getAttribute('href'),
      'https://dx-1doi-1org-10039f8q70087.emedien3.sub.uni-hamburg.de/' + doi);
    await receipt(h,{taskId,doi,state:'running'});
    assert.equal((await receipt(h,published(h))).status,200);
    await page.getByRole('link',{name:'刷新任务状态',exact:true}).click();
    await page.getByRole('link',{name:'下载 PDF',exact:true}).waitFor();
    assert((await page.locator('main').innerText()).includes('Drive 已报告，待确认'));
    assert((await page.locator('main').innerText()).includes('三端完成尚未确认'));
    await page.getByRole('link',{name:'下载 PDF',exact:true}).click();
    await page.locator('#passphrase').fill('synthetic-passphrase');
    const [download] = await Promise.all([page.waitForEvent('download'),page.locator('button[type="submit"]').click()]);
    assert.deepEqual(fs.readFileSync(await download.path()),pdf);
    assert.equal(h.webhooks.length,1,'status refresh and the protected download never re-dispatch');
    assert.equal(requests.filter(r => r.method === 'POST').length,2,'one acquisition submission and one later protected download');
    assert(requests.every(r => !r.url.includes('synthetic-passphrase')));
    console.log('Offline Grok browser passed: protected form, accepted task, login pause, same-task verified completion, partial archive display and exact PDF download.');
  } finally { await browser.close(); }
}
(async()=>{
  let h = setup();
  delete h.env.GROK_FULLTEXT_ENABLED;
  const page = await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}});
  const html = await page.text();
  assert(html.includes('https://dx-1doi-1org-10039f8q70087.emedien3.sub.uni-hamburg.de/10.1000/exact'));
  assert(html.includes('noopener noreferrer')); assert.equal(h.calls.length,0); assert.equal(h.writes.length,0);
  assert.equal((await (await h.request()).json()).status,'manual_needed'); assert.equal(h.webhooks.length,0,'off preserves the old path');
  await error(await receipt(h,{}),503,'grok_disabled');
  for (const invalid of [{GROK_FULLTEXT_WEBHOOK_KEY:undefined},{GROK_FULLTEXT_RECEIPT_KEY:webhookKey},
    {GROK_FULLTEXT_WEBHOOK_URL:'http://api.cursor.sh/routine'},{GROK_FULLTEXT_WEBHOOK_URL:'https://api.cursor.sh.attacker.invalid/routine'},
    {GROK_FULLTEXT_WEBHOOK_URL:'https://user:secret@api.cursor.sh/routine'},{GROK_FULLTEXT_WEBHOOK_URL:'https://api.cursor.sh:8443/routine'}]) {
    h = setup(); Object.assign(h.env,invalid);
    await error(await h.request(),503,'grok_not_configured'); assert.equal(h.calls.length,0); assert.equal(h.webhooks.length,0);
  }
  h = setup(); h.env.FULLTEXT_ASYNC_ENABLED = 'true';
  await error(await h.request(),409,'grok_owner_conflict'); assert.equal(h.webhooks.length,0);
  h = setup();
  const ownerTime = Date.now(), ownerId = '00000000-0000-4000-8000-000000000002';
  h.values.set('library:job:' + doi,JSON.stringify({version:1,id:ownerId,doi,state:'queued',attempts:0,
    createdAt:ownerTime,updatedAt:ownerTime,nextAttemptAt:ownerTime,queueKey:'library:queue:' + String(ownerTime).padStart(13,'0') + ':' + ownerId}));
  await error(await h.request(),409,'grok_owner_conflict'); assert.equal(h.webhooks.length,0,'disabled old queue tasks still retain their acquisition owner');
  // Cached, GitHub and OA originals remain first choice, including with the Bot enabled.
  for (const source of ['cache','github','oa']) {
    h = setup(source === 'github' ? {rows:[[title,doi,'Heart','2026-10-07','publisher','期刊/试验.pdf',hash(pdf)]]} : source === 'oa' ? {oa:true} : {});
    if (source === 'cache') seed(h);
    const ready = await h.request('/api/acquire',{query:'doi=' + encodeURIComponent(doi) + '&download=1'});
    assert.equal(ready.status,200); assert.deepEqual(Buffer.from(await ready.arrayBuffer()),pdf);
    assert.equal(h.webhooks.length,0,'existing files do not invoke a Bot');
  }
  h = setup();
  await error(await h.request('/api/acquire',{passphrase:'wrong'}),403,'pdf_passphrase_invalid');
  assert.equal(h.reads.length,0); assert.equal(h.writes.length,0); assert.equal(h.webhooks.length,0);
  await error(await h.request('/api/acquire',{headers:{origin:'https://attacker.invalid'}}),403,'pdf_origin');
  assert.equal(h.webhooks.length,0);
  // A genuine index miss and no OA location produces exactly one dispatch.
  h = setup(); const task = await submit(h);
  assert.equal(h.webhooks.length,1); assert.equal(JSON.parse(h.values.get(jobKey)).state,'accepted');
  const sourceCalls = h.calls.length, writes = h.writes.length;
  assert.equal((await (await h.request()).json()).job.id,task.id);
  assert.equal(h.webhooks.length,1); assert.equal(h.calls.length,sourceCalls); assert.equal(h.writes.length,writes);
  const polling = await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}});
  assert((await polling.text()).includes('http-equiv="refresh"')); assert.equal(h.webhooks.length,1);
  const lookup = await (await h.request('/api/library',{method:'GET'})).json();
  assert.equal(lookup.job.id,task.id); assert.equal(lookup.job.state,'queued');
  await error(await receipt(h,{taskId:task.id,doi,state:'running'},{key:'wrong'}),401,'grok_unauthorized');
  await error(await receipt(h,{taskId:'00000000-0000-4000-8000-000000000001',doi,state:'running'}),409,'job_stale');
  const beforeBad = h.writes.length;
  for (const body of [
    {taskId:task.id,doi:'',state:'running'},
    {taskId:task.id,doi,state:'uploaded',githubCommit:'b'.repeat(40),sha256:hash(pdf),url:'https://attacker.invalid/pdf'},
    {taskId:task.id,doi,state:'running',reportedSides:{mac:true}},
    {taskId:task.id,doi,state:'uploaded',githubCommit:'main',sha256:hash(pdf)},
    {taskId:task.id,doi,state:'uploaded',githubCommit:'b'.repeat(40),sha256:hash(pdf),reportedSides:{mac:'verified'}},
    {taskId:task.id,doi,state:'complete'}
  ]) await error(await receipt(h,body),400,'grok_bad_receipt');
  await error(await receipt(h,{}, {raw:'x'.repeat(2049)}),413,'grok_bad_receipt');
  await error(await receipt(h,{}, {query:'?url=https://attacker.invalid'}),405,'grok_bad_receipt');
  assert.equal(h.writes.length,beforeBad);
  await receipt(h,{taskId:task.id,doi,state:'running'});
  await receipt(h,{taskId:task.id,doi,state:'login_required'});
  const login = await (await h.request('/api/acquire',{method:'GET'})).json();
  assert.equal(login.job.state,'manual_needed'); assert(login.job.message.includes('重新登录'));
  assert.equal(h.webhooks.length,1); assert.equal(h.calls.length,sourceCalls,'login progress never probes the institution');
  // Resume the same task and verify the exact new commit, not the old pinned snapshot.
  await receipt(h,{taskId:task.id,doi,state:'running'});
  h.env.DOI_LOOKUP_LATEST_MAIN = 'true';
  const upload = published(h), completed = await receipt(h,upload);
  assert.equal(completed.status,200); const completion = await completed.json();
  assert.equal(completion.job.state,'available'); assert.equal(completion.archive.complete,false);
  assert.equal(completion.archive.sides.github,'verified'); assert.equal(completion.archive.sides.drive,'reported');
  assert.equal(completion.archive.sides.mac,'reported','Bot reports do not become three-end verification');
  const progress = await (await h.request('/api/acquire',{method:'GET'})).json();
  assert.equal(progress.job.state,'available'); assert.equal(progress.paper.fulltextStatus,'available');
  assert.equal(progress.archive.sides.drive,'reported'); assert(progress.downloadUrl.startsWith('/api/fulltext?'));
  assert(h.calls.slice(sourceCalls).every(call => call.url.hostname === 'api.github.com' && call.url.searchParams.get('ref') === upload.githubCommit));
  const finishedCalls = h.calls.length, finishedWrites = h.writes.length;
  assert.equal((await (await receipt(h,{taskId:task.id,doi,state:'running'})).json()).job.state,'available');
  assert.equal((await (await receipt(h,upload)).json()).job.state,'available');
  assert.equal(h.calls.length,finishedCalls); assert.equal(h.writes.length,finishedWrites,'old progress cannot downgrade completion');
  const download = await h.request('/api/fulltext'); assert.equal(download.status,200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),pdf); assert.equal(h.webhooks.length,1);
  for (const value of h.writes) if (typeof value.value === 'string') for (const secret of [webhookKey,receiptKey,'synthetic-passphrase']) assert(!value.value.includes(secret));
  // Forged uploaded claims do not mark files available. There is no publisher fallback.
  for (const invalid of ['sha','title','missing']) {
    h = setup(); await submit(h); const data = published(h), callsBefore = h.calls.length;
    if (invalid === 'sha') data.sha256 = '0'.repeat(64);
    if (invalid === 'title') h.sources.rows[0][0] = 'A different paper';
    if (invalid === 'missing') h.sources.rows = [];
    await error(await receipt(h,data),409,'library_identity');
    assert.equal(JSON.parse(h.values.get(jobKey)).state,'review');
    assert.equal(JSON.parse(h.values.get('library:paper:' + doi)).paper.fulltextStatus,'manual_needed');
    assert(!h.writes.some(w => w.key.startsWith('library:pdf:')));
    assert(h.calls.slice(callsBefore).every(c => c.url.hostname === 'api.github.com'));
    await error(await receipt(h,data),409,'grok_receipt_review_required');
  }
  for (const [status,code,expectedStatus] of [[404,'pdf_not_found',404],[403,'library_paused',423],[503,'library_upstream',502]]) {
    h = setup(); await submit(h); const data = published(h);
    h.sources.githubPdfResponse = () => new Response('synthetic unavailable PDF',{status});
    await error(await receipt(h,data),expectedStatus,code);
    assert.equal(JSON.parse(h.values.get(jobKey)).state,'review','missing or denied uploaded files never remain in an active queue');
    assert(!h.writes.some(w => w.key.startsWith('library:pdf:')));
  }
  // Persist failures and uncertain sends; user retries do not spend another Bot run.
  for (const status of [401,429,503]) {
    h = setup({},() => new Response(null,{status}));
    const failed = await (await h.request()).json(); assert.equal(failed.job.state,'failed');
    await h.request(); assert.equal(h.webhooks.length,1);
  }
  h = setup({},() => {throw Error('synthetic webhook network failure');});
  const unknown = await (await h.request()).json(); assert.equal(unknown.job.state,'manual_needed');
  await h.request(); assert.equal(h.webhooks.length,1);
  assert.equal((await receipt(h,published(h))).status,200,'a lost dispatch response may still finish via a correlated receipt');
  h = setup({fastTimers:true},() => new Promise(() => {}));
  assert.equal((await (await h.request()).json()).job.state,'manual_needed'); assert.equal(h.webhooks.length,1);
  const clock = {now:Date.now()}; h = setup({clock}); await submit(h); clock.now += 86400001;
  assert.equal((await (await h.request('/api/acquire',{method:'GET'})).json()).job.state,'manual_needed');
  await h.request(); assert.equal(h.webhooks.length,1,'expired progress does not spend another Bot run');
  // Fast progress and writes failing before dispatch preserve the correct state.
  h = setup({},async (_url,init,ctx) => {
    const body = JSON.parse(init.body);
    await receipt(ctx,{taskId:body.taskId,doi,state:'running'});
    return new Response(null,{status:200});
  });
  assert.equal((await (await h.request()).json()).job.state,'running');
  h = setup({},async (_url,_init,ctx) => {
    assert.equal((await receipt(ctx,published(ctx))).status,200);
    return new Response(null,{status:200});
  });
  const fastComplete = await (await h.request()).json();
  assert.equal(fastComplete.job.state,'available'); assert.equal(fastComplete.paper.fulltextStatus,'available','fast completion returns the current paper');
  h = setup({putError:key => key.startsWith('library:grok-job:')});
  await error(await h.request(),503,'library_storage'); assert.equal(h.webhooks.length,0);
  console.log('Grok fulltext passed: default-off, protected dispatch, original reuse, persisted dedup, callback identity/schema, same-task login recovery, exact-commit PDF verification, partial archive reporting, uncertain sends and callback races.');
  if (process.argv.includes('--browser')) await browserCheck();
})().catch(error=>{console.error(error);process.exitCode=1;});
