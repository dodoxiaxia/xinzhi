'use strict';
// Full text without Muse: reader upload and open-access copies enter the same quarantine and
// verifier as Muse originals; unclaimed requests wait for Muse instead of dying after one day.
// Synthetic offline fixtures only.
const assert = require('assert');
const {setup,token} = require('./test_fulltext_auth_helpers.cjs');
const {doi,title,hash,error} = require('./test_doi_library_worker.cjs');
const base = 'https://learn.dryz.info',reviewUrl = base + '/api/muse/review',secret = 'synthetic_muse_key_0123456789_abcdef';
const original = Buffer.from('%PDF-1.7\nSynthetic reader copy\n' + 'x'.repeat(52000) + '\n%%EOF\n');
async function create(options = {}) {const h = await setup(options);h.env.MUSE_FULLTEXT_ENABLED = 'true';h.env.MUSE_FULLTEXT_KEY = secret;return h;}
function form(fields) {const data = new FormData();for (const [k,v] of fields) data.append(k,v);return data;}
function readerUpload(h,options = {}) {
  const body = options.body || form([['pdf',new Blob([options.bytes || original],{type:'application/pdf'}),'paper.pdf'],['passphrase',options.passphrase || 'synthetic-passphrase']]);
  return h.context.worker.fetch(new Request(base + '/api/muse/reader-upload?doi=' + encodeURIComponent(doi),{method:'POST',body,headers:{accept:options.accept || 'application/json',...(options.headers || {})}}),h.env);
}
async function claimMuse(h) {return h.context.worker.fetch(new Request(base + '/api/muse/claim',{method:'POST',headers:{authorization:'Bearer ' + secret,'content-type':'application/json'},body:'{}'}),h.env);}
async function review(h,body) {
  const auth = await token(h,reviewUrl,'muse-review.yml');
  return h.context.worker.fetch(new Request(reviewUrl,{method:'POST',headers:{authorization:'Bearer ' + auth,'content-type':'application/json'},body:JSON.stringify(body)}),h.env);
}
const job = h => JSON.parse(h.values.get('library:muse-job:' + doi));
(async () => {
  // The upload page is a plain form and never asks Muse or a publisher for anything.
  let h = await create();
  const page = await h.context.worker.fetch(new Request(base + '/api/muse/reader-upload?doi=' + encodeURIComponent(doi),{headers:{accept:'text/html'}}),h.env);
  const pageHtml = await page.text();
  assert.equal(page.status,200); assert(pageHtml.includes('enctype="multipart/form-data"')); assert(pageHtml.includes('type="file"')); assert(!/<script\b/i.test(pageHtml));
  assert.equal(h.calls.length,0); assert.equal(h.writes.length,0);

  // Wrong passphrase, cross-site posts and non-PDF files are refused before anything is stored.
  await error(await readerUpload(h,{passphrase:'wrong'}),403,'pdf_passphrase_invalid');
  const retryPage = await readerUpload(h,{passphrase:'wrong',accept:'text/html'}); assert.equal(retryPage.status,403); assert((await retryPage.text()).includes('全文口令不正确'));
  await error(await readerUpload(h,{headers:{'sec-fetch-site':'cross-site'}}),403,'pdf_origin');
  await error(await readerUpload(h,{bytes:Buffer.from('<html>' + 'x'.repeat(60000) + '</html>')}),415,'muse_bad_pdf');
  await error(await readerUpload(h,{bytes:Buffer.from('%PDF-1.7\nsmall\n%%EOF\n')}),413,'muse_bad_pdf');
  await error(await readerUpload(h,{body:form([['pdf',new Blob([original]),'a.pdf'],['passphrase','synthetic-passphrase'],['extra','x']])}),400,'pdf_bad_form');
  assert.equal(h.writes.filter(w => w.key.startsWith('library:muse')).length,0);

  // A reader upload with no earlier request saves the official bibliography and goes to quarantine.
  const accepted = await readerUpload(h); assert.equal(accepted.status,202);
  const intake = await accepted.json(); assert.equal(intake.job.stage,'verifying'); assert.equal(intake.status,'pending'); assert(intake.job.message.includes('上传的 PDF'));
  assert.equal(intake.archive.sides.drive,'pending','a reader upload is not a Drive copy');
  assert.equal(job(h).source,'reader_upload'); assert(!('driveFileId' in job(h)));
  assert(!h.values.has('library:pdf:' + hash(original)),'unverified upload is never downloadable');
  assert.equal((await (await claimMuse(h)).json()).task,null,'Muse is not asked to fetch a paper the reader already supplied');
  await error(await readerUpload(h),409,'muse_busy');

  // The existing GitHub verifier finishes it exactly like a Muse original.
  const candidate = (await (await review(h,{action:'claim'})).json()).task;
  assert.equal(candidate.doi,doi); assert.equal(candidate.title,title); assert.equal(candidate.sha256,hash(original));
  const done = await review(h,{action:'complete',taskId:candidate.taskId,doi,leaseId:candidate.leaseId,sha256:candidate.sha256,bytes:candidate.bytes,result:'verified',pages:3,method:'dual_parser_all_pages_title_doi'});
  const result = await done.json(); assert.equal(result.job.state,'available'); assert.equal(result.archive.sides.drive,'pending');
  const download = await h.request('/api/fulltext'); assert.equal(download.status,200); assert.deepEqual(Buffer.from(await download.arrayBuffer()),original);

  // A request whose queue time ran out offers the upload, and the upload replaces the stopped task.
  let clock = {now:Date.now()};
  h = await create({clock});
  assert.equal((await h.request()).status,202);
  const queuedHtml = await (await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}})).text();
  assert(queuedHtml.includes('/api/muse/reader-upload?doi='),'a waiting request already offers the upload');
  const firstQueue = job(h).queueKey;
  clock.now += 2 * 86400000;
  assert.equal(h.context.musePublicJob(job(h)).state,'queued','two days without Muse is still a live request');
  const lateClaim = await (await claimMuse(h)).json(); assert.equal(lateClaim.task.doi,doi,'Muse can still pick it up after a day');
  clock = {now:Date.now()};
  h = await create({clock}); assert.equal((await h.request()).status,202);
  clock.now += 6 * 86400000 + 1000;
  assert.equal((await (await claimMuse(h)).json()).task,null);
  const stopped = job(h); assert.equal(stopped.state,'failed'); assert.equal(stopped.reason,'queue_expired');
  const stoppedHtml = await (await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}})).text();
  assert(stoppedHtml.includes('排队过久')); assert(stoppedHtml.includes('/api/muse/reader-upload?doi=')); assert(stoppedHtml.includes('/api/muse/retry?doi='));
  const replaced = await readerUpload(h); assert.equal(replaced.status,202); assert.notEqual(job(h).id,stopped.id); assert.equal(job(h).state,'verifying');
  assert(!h.values.has(stopped.queueKey)); assert(firstQueue);

  // A live Muse acquisition is never raced by an upload.
  h = await create(); assert.equal((await h.request()).status,202); assert((await (await claimMuse(h)).json()).task);
  await error(await readerUpload(h),409,'muse_busy'); assert.equal(job(h).state,'running');

  // An open-access PDF registered for the DOI skips the Muse queue but still waits for verification.
  h = await create({oa:true,pdfResponse:() => new Response(original,{headers:{'content-type':'application/pdf'}})});
  const oa = await h.request(); assert.equal(oa.status,202); const oaJob = (await oa.json()).job;
  assert.equal(oaJob.stage,'verifying'); assert.equal(job(h).source,'open_access');
  assert(!h.values.has('library:pdf:' + hash(original))); assert.equal((await (await claimMuse(h)).json()).task,null);
  assert(![...h.values.keys()].some(k => k.startsWith('library:muse-queue:')),'nothing is queued for Muse');

  // A blocked or too-small open-access copy falls back to the Muse queue.
  h = await create({oa:true,pdfResponse:() => new Response('blocked',{status:403})});
  assert.equal((await (await h.request()).json()).job.stage,'queued');
  h = await create({oa:true});
  assert.equal((await (await h.request()).json()).job.stage,'queued','a tiny file is not treated as the article');
  // A new candidate asks GitHub for a verification run right away; one run covers a burst.
  const dispatches = h => h.calls.filter(c => c.url.href === 'https://api.github.com/repos/dodoxiaxia/xinzhi/actions/workflows/muse-review.yml/dispatches');
  h = await create(); h.env.MUSE_REVIEW_DISPATCH_TOKEN = 'github_pat_synthetic_dispatch_0123456789';
  assert.equal((await readerUpload(h)).status,202,'a failed dispatch never fails the upload');
  assert.equal(dispatches(h).length,1); const sent = dispatches(h)[0].init;
  assert.equal(sent.method,'POST'); assert.equal(sent.headers.authorization,'Bearer github_pat_synthetic_dispatch_0123456789'); assert.deepEqual(JSON.parse(sent.body),{ref:'main'});
  h.values.delete('library:muse-job:' + doi);
  assert.equal((await readerUpload(h,{bytes:Buffer.concat([original.subarray(0,20),Buffer.from('y'),original.subarray(20)])})).status,202);
  assert.equal(dispatches(h).length,1,'a second candidate inside two minutes reuses the pending run');
  h = await create(); assert.equal((await readerUpload(h)).status,202); assert.equal(dispatches(h).length,0,'no token, no dispatch');
  console.log('Muse reader upload, open-access first and six-day queue window passed');
})().catch(error => {console.error(error);process.exitCode = 1;});
