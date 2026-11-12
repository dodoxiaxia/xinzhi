'use strict';
// Reader-facing Muse task pages: every state shows where the task stopped, what to do next,
// and an available PDF is downloadable from the same page. Synthetic records only.
const assert = require('assert');
const {setup} = require('./test_fulltext_auth_helpers.cjs');
const doi = '10.1234/status.page', id = '0b3f6c1e-2a4d-4e8f-9c0b-1d2e3f4a5b6c', lease = '1b3f6c1e-2a4d-4e8f-9c0b-1d2e3f4a5b6c';
const html = async response => { assert(response.headers.get('content-type').startsWith('text/html')); return response.text(); };
(async () => {
  const h = await setup();
  const ctx = h.context, now = Date.now();
  const job = extra => ({version:1,id,doi,createdAt:now - 3600000,updatedAt:now - 60000,queueKey:'library:muse-queue:' + String(now - 3600000).padStart(13,'0') + ':' + id,...extra});
  const request = new Request('https://learn.dryz.info/api/acquire?doi=' + doi,{headers:{accept:'text/html'}});
  const paper = {doi,title:'Synthetic status page article'};

  // Every state: three fixed steps, ONE status sentence with an estimate, exactly ONE primary action, no loop copy.
  const primaries = page => (page.match(/class="primary"/g) || []).length + (/<form[^>]*>[\s\S]*?<button type="submit">/.test(page) ? 1 : 0);
  const noLoop = (page, name) => { for (const bad of ['回到网站搜索','查看任务','三端归档']) assert(!page.includes(bad), name + ' must not contain ' + bad); };
  const stepCount = page => (page.match(/<li[ >]/g) || []).length;

  const queued = await html(ctx.museResponse(request,job({state:'queued'}),paper));
  assert(queued.includes('不保证即时'), 'queued tasks never promise an imminent poll');
  assert(queued.includes('预计数小时内'));
  assert.equal(primaries(queued),1); assert(queued.includes('>刷新状态<')); assert.equal(stepCount(queued),3); noLoop(queued,'queued');
  assert(queued.includes('/api/muse/reader-upload?doi='), 'a plain text link still offers uploading a PDF you already have');
  assert(queued.includes('href="/?mode=library&amp;q=' + encodeURIComponent(doi) + '"'), 'footer navigation reopens this DOI on the site');

  const review = await html(ctx.museResponse(request,job({state:'review',leaseId:lease,leaseUntil:now - 1,driveFileId:'syntheticDriveFile01',verificationReason:'identity_mismatch'}),paper));
  assert(review.includes('核验未通过') && review.includes('aria-current="step"'), 'a rejected task marks the step where it stopped');
  assert(review.includes('<li class="done">排队下载</li>'), 'the download step is done: the file arrived and then failed verification');
  assert.equal(primaries(review),1); assert(review.includes('>直接上传 PDF<')); noLoop(review,'review');
  assert(!review.includes('<form'), 'no download or resubmit form while under review');
  assert(review.includes('<!--han-->') && review.includes('原因 identity_mismatch'), 'the reason code lives only in the maintainer block');
  assert(!review.replace(/<!--han-->[\s\S]*?<!--\/han-->/g,'').includes('identity_mismatch'));

  const expired = await html(ctx.museResponse(request,job({state:'running',leaseId:lease,leaseUntil:now - 1}),paper));
  assert(expired.includes('未能获取'));
  assert(expired.includes('href="/api/muse/retry?doi=')); assert.equal(primaries(expired),1); assert(expired.includes('>重新获取全文<')); noLoop(expired,'expired');

  const verifying = job({state:'verifying',source:'reader_upload',leaseId:lease,leaseUntil:now,receivedAt:now - 30000,sha256:'a'.repeat(64),bytes:60000,candidateKey:'library:muse-candidate:' + 'a'.repeat(64)});
  const hourly = await html(ctx.museResponse(request,verifying,paper));
  assert(hourly.includes('已收到你上传的 PDF，正在核验') && hourly.includes('等待下一轮核验')); assert.equal(primaries(hourly),1); assert.equal((hourly.match(/role="status"/g) || []).length,1); noLoop(hourly,'verifying hourly');
  require('vm').runInContext('museReviewInstant = true',ctx);
  const instant = await html(ctx.museResponse(request,verifying,paper));
  assert(instant.includes('核验通常几分钟内完成')); assert(!instant.includes('等待下一轮核验')); assert.equal(primaries(instant),1);
  assert.equal(ctx.musePublicJob(verifying).verificationMode,'immediate');
  const late = {...verifying,receivedAt:now - 700000};
  assert.equal(ctx.musePublicJob(late).verificationMode,'hourly','after ten minutes the task is honestly described as waiting for the hourly batch');
  assert(!Object.hasOwn(ctx.musePublicJob(late),'verificationExpectedAt'));
  require('vm').runInContext('museReviewInstant = false',ctx);

  const available = await html(ctx.museResponse(request,job({state:'available'}),paper));
  assert(available.includes('action="/api/fulltext?doi=' + encodeURIComponent(doi) + '"'), 'available task offers the protected download in place');
  assert(available.includes('type="password"')); assert.equal(primaries(available),1);
  assert(!available.includes('http-equiv="refresh"')); noLoop(available,'available');

  const abandoned = await html(ctx.museResponse(request,job({state:'abandoned'}),paper));
  assert(abandoned.includes('已确认不再获取') && !abandoned.includes('class="primary"'));

  const result = await html(ctx.libraryResult(request,{...paper,fulltextStatus:'available'}));
  assert(result.includes('action="/api/fulltext?doi='));
  assert(!result.includes('请约 1 分钟后再试'), 'a stored PDF is not described as still syncing');
  console.log('Muse status pages: stop step, next action, in-place download and return link passed.');
})().catch(error => { console.error(error); process.exit(1); });
