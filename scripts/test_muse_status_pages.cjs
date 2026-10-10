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

  const queued = await html(ctx.museResponse(request,job({state:'queued'}),paper));
  assert(queued.includes('不保证即时'), 'queued tasks never promise an imminent poll');
  assert(queued.includes('可以关闭本页'));
  assert(queued.includes('href="/?mode=library&amp;q=' + encodeURIComponent(doi) + '"'), 'return link reopens this DOI on the site');
  assert(!queued.includes('三端归档'));

  const review = await html(ctx.museResponse(request,job({state:'review',leaseId:lease,leaseUntil:now - 1,driveFileId:'syntheticDriveFile01'}),paper));
  assert(review.includes('PDF 核验未通过，等待维护者核查（当前）'), 'a rejected task marks the step where it stopped');
  assert(review.includes('原件已上传私有收件箱（已完成）'));
  assert(review.includes('无需重复提交'));
  assert(!review.includes('<form'), 'no download or resubmit form while under review');

  const expired = await html(ctx.museResponse(request,job({state:'running',leaseId:lease,leaseUntil:now - 1}),paper));
  assert(expired.includes('任务已停止，等待维护者确认（当前）'));
  assert(expired.includes('href="/api/muse/retry?doi='));

  const available = await html(ctx.museResponse(request,job({state:'available'}),paper));
  assert(available.includes('action="/api/fulltext?doi=' + encodeURIComponent(doi) + '"'), 'available task offers the protected download in place');
  assert(available.includes('type="password"'));
  assert(!available.includes('http-equiv="refresh"'));

  const result = await html(ctx.libraryResult(request,{...paper,fulltextStatus:'available'}));
  assert(result.includes('action="/api/fulltext?doi='));
  assert(!result.includes('请约 1 分钟后再试'), 'a stored PDF is not described as still syncing');
  console.log('Muse status pages: stop step, next action, in-place download and return link passed.');
})().catch(error => { console.error(error); process.exit(1); });
