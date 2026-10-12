// ==== edge/src/04-fulltext-upload.js · Open-access copy, reader/Muse uploads, /api/fulltext ====
// An open-access copy registered for this DOI needs no institutional login, so try it before
// waiting on Muse. Any failure (blocked source, timeout, wrong file) just falls back to the queue.
async function museOpenAccess(paper, context) {
  try {
    const found = await libraryOa(paper,context);
    return found.bytes && found.bytes.length >= 51200 ? found.bytes : null;
  } catch { return null; }
}
const MUSE_UPLOAD_FORM_BYTES = LIBRARY_MAX_PDF_BYTES + 65536;
function museUploadPage(doi, notice = '') {
  return pdfHtml((notice ? '<p role="alert">' + pdfEscape(notice) + '</p>' : '')
    + '<p>如果你能在自己的浏览器里打开这篇原文（开放获取，或通过汉堡登录），下载 PDF 后在这里上传，不必等 Muse。</p>'
    + '<p>原件先进入网站私有隔离区，由独立核验任务检查 DOI、题名与全部页面（每小时第 23 分钟计划执行，GitHub 队列可能延迟）；通过后凭全文口令下载。请上传出版社原版或接受稿，50 KiB–10 MiB，不要修改、压缩或加水印。</p>'
    + '<form method="post" enctype="multipart/form-data" action="/api/muse/reader-upload?doi=' + pdfEscape(encodeURIComponent(doi)) + '"><p><label for="pdf">PDF 文件</label><br><input id="pdf" name="pdf" type="file" accept="application/pdf,.pdf" required></p>'
    + '<p><label for="passphrase">全文口令</label><br><input id="passphrase" name="passphrase" type="password" maxlength="256" autocomplete="current-password" required></p><button type="submit">上传并核验</button></form>'
    + pdfOfficialLink(doi),notice ? 403 : 200,'上传全文 PDF',doi);
}
async function museReadForm(request) {
  const type = request.headers.get('content-type') || '';
  if (!/^multipart\/form-data;/i.test(type)) pdfFail('pdf_content_type',415);
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MUSE_UPLOAD_FORM_BYTES)) libraryFail('muse_bad_pdf',413);
  const reader = request.body && request.body.getReader();
  if (!reader) pdfFail('pdf_bad_form',400);
  const chunks = []; let size = 0;
  while (true) {
    let item; try { item = await reader.read(); } catch { pdfFail('pdf_bad_form',400); }
    if (item.done) break;
    size += item.value.byteLength;
    if (size > MUSE_UPLOAD_FORM_BYTES) { pdfCancel(reader); libraryFail('muse_bad_pdf',413); }
    chunks.push(item.value);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk,offset); offset += chunk.byteLength; }
  let form; try { form = await new Response(body,{headers:{'content-type':type}}).formData(); } catch { pdfFail('pdf_bad_form',400); }
  if ([...form.keys()].length !== 2 || form.getAll('passphrase').length !== 1 || form.getAll('pdf').length !== 1) pdfFail('pdf_bad_form',400);
  const passphrase = form.get('passphrase'), file = form.get('pdf');
  if (typeof passphrase !== 'string' || passphrase.length > 256 || !file || typeof file === 'string') pdfFail('pdf_bad_form',400);
  return {passphrase,file};
}
async function handleMuseReaderUpload(request, env) {
  let doi = '', release;
  try {
    const parsed = libraryQuery(request); doi = parsed.doi;
    libraryConfig(env);
    if (request.method === 'GET') return museUploadPage(doi);
    if (request.method !== 'POST') libraryFail('muse_bad_request',405);
    libraryOrigin(request,parsed.url);
    const {passphrase,file} = await museReadForm(request);
    await pdfVerifyPassphrase(passphrase,env,request);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length < 51200 || bytes.length > LIBRARY_MAX_PDF_BYTES) libraryFail('muse_bad_pdf',413);
    try { libraryValidatePdf(bytes); } catch { libraryFail('muse_bad_pdf',415); }
    let paper = libraryPaper(await libraryGet(env.QL_KV,LIBRARY_PREFIX + doi),doi);
    if (paper?.fulltextStatus === 'available') return libraryResult(request,paper,'',true);
    if (paper?.fulltextStatus === 'review') libraryFail('library_identity',409);
    const attempt = await libraryGet(env.QL_KV,'library:attempt:' + doi);
    if (attempt?.paused) libraryFail('library_paused',423);
    await museOwnerGuard(env,doi);
    release = await librarySoftGate(env.QL_KV,request,doi,true);
    const existing = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + doi),doi);
    // Never race a live Muse acquisition or a candidate that is already waiting for verification.
    if (existing && (['verifying','available'].includes(existing.state) || ['running','uploading'].includes(existing.state) && !museExpired(existing))) libraryFail('muse_busy',409);
    if (!paper) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(),15000);
      try { paper = {...await libraryMetadata(doi,{signal:controller.signal}),fulltextStatus:'manual_needed'}; } finally { clearTimeout(timer); }
      await librarySave(env.QL_KV,paper,null,'library_manual_needed');
    }
    return museResponse(request,await museIntake(env,doi,bytes,'reader_upload',existing),paper);
  } catch (error) {
    if (error instanceof PdfFailure && error.code === 'pdf_passphrase_invalid' && doi && (request.headers.get('accept') || '').includes('text/html')) return museUploadPage(doi,'全文口令不正确。请重新选择文件并输入口令。');
    return libraryError(request,error,doi,'/api/muse/reader-upload');
  } finally { if (release) await release(); }
}
async function handleMuseRequest(request, env) {
  let doi = '';
  try {
    const parsed = libraryQuery(request); doi = parsed.doi;
    museConfig(env);
    if (!['GET','POST'].includes(request.method)) libraryFail('muse_bad_request',405);
    if (request.method === 'POST') await libraryAuthorize(request,env,parsed.url);
    const existing = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + doi),doi);
    const record = await libraryGet(env.QL_KV,LIBRARY_PREFIX + doi), paper = libraryPaper(record,doi);
    if (paper?.fulltextStatus === 'available') return request.method === 'POST' ? libraryAcquireResult(request,env,paper,parsed.download,'',true) : libraryResult(request,paper,'',true);
    if (existing) return museResponse(request,existing,paper);
    if (request.method === 'GET') return pdfHtml('<p>站内还没有这篇的全文。输入全文口令提交请求后，由 Muse 获取原件，网站核验 DOI、题名与页面后开放下载。</p><ol class="steps"><li>提交请求（本页）</li><li>Muse 领取并下载原件（时间取决于 Muse 运行安排，可能需要数小时）</li><li>网站核验（每小时第 23 分钟计划执行，可能延迟）</li><li>回到网站搜索此 DOI，点“下载 PDF”并再次输入口令</li></ol><form method="post"><label>全文口令 <input name="passphrase" type="password" maxlength="256" autocomplete="current-password" required></label><button type="submit">提交全文请求</button></form><p>同一 DOI 只会建立一个任务，重复提交不会重复下载。</p>' + pdfOfficialLink(doi),200,'获取全文',doi);
    if (paper?.fulltextStatus === 'review') libraryFail('library_identity',409);
    const attempt = await libraryGet(env.QL_KV,'library:attempt:' + doi);
    if (attempt?.paused) libraryFail('library_paused',423);
    await museOwnerGuard(env,doi);
    const release = await librarySoftGate(env.QL_KV,request,doi,true);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),30000);
    try {
      const context = {signal:controller.signal}, metadata = await libraryMetadata(doi,context);
      const current = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + doi),doi);
      if (current) return museResponse(request,current,metadata);
      await museOwnerGuard(env,doi);
      const open = await museOpenAccess(metadata,context);
      if (open) {
        await librarySave(env.QL_KV,{...metadata,fulltextStatus:'manual_needed'},null,'library_manual_needed');
        return museResponse(request,await museIntake(env,doi,open,'open_access',null),metadata);
      }
      const now = Date.now(), id = crypto.randomUUID();
      const job = {version:1,id,doi,state:'queued',createdAt:now,updatedAt:now,queueKey:MUSE_QUEUE_PREFIX + String(now).padStart(13,'0') + ':' + id};
      await librarySave(env.QL_KV,{...metadata,fulltextStatus:'manual_needed'},null,'library_manual_needed');
      await musePut(env,job);
      await libraryPut(env.QL_KV,job.queueKey,JSON.stringify({doi,id}),{expirationTtl:604800});
      return museResponse(request,job,metadata);
    } finally { clearTimeout(timer); await release(); }
  } catch (error) { return libraryError(request,error,doi); }
}
async function museList(env, prefix) {
  let listing; try { listing = await env.QL_KV.list({prefix,limit:10}); } catch { libraryFail('library_storage',503); }
  if (!listing || !Array.isArray(listing.keys) || listing.keys.length > 10) libraryFail('library_storage',503);
  return listing.keys.filter(k => typeof k.name === 'string' && k.name.startsWith(prefix));
}
async function museDelete(env, key) {
  try { await env.QL_KV.delete(key); } catch { libraryFail('library_storage',503); }
}
async function handleMuseClaim(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('muse_bad_request',405);
    await museAuthorize(request,env);
    const input = await fulltextReadJson(request,128,'muse_bad_request');
    if (Object.keys(input).length) libraryFail('muse_bad_request',400);
    for (const entry of await museList(env,MUSE_QUEUE_PREFIX)) {
      const pointer = await libraryGet(env.QL_KV,entry.name);
      const job = pointer?.doi && museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + pointer.doi),pointer.doi);
      if (!job || job.id !== pointer.id || job.queueKey !== entry.name) continue;
      if (['available','review','failed','login_required','verifying'].includes(job.state)) { await museDelete(env,entry.name); continue; }
      if (['running','uploading'].includes(job.state) && job.leaseUntil <= Date.now()) { await musePut(env,{...job,state:'failed',reason:'lease_expired',updatedAt:Date.now()}); await museDelete(env,entry.name); continue; }
      if (job.state !== 'queued') continue; // Never reclaim an expired acquisition automatically.
      if (museExpired(job)) { await musePut(env,{...job,state:'failed',reason:'queue_expired',updatedAt:Date.now()}); await museDelete(env,entry.name); continue; }
      await museOwnerGuard(env,job.doi);
      const record = await libraryGet(env.QL_KV,LIBRARY_PREFIX + job.doi), paper = libraryPaper(record,job.doi);
      if (paper?.fulltextStatus === 'available') { await libraryStoredPdf(env.QL_KV,record); await musePut(env,{...job,state:'available',updatedAt:Date.now()}); await museDelete(env,entry.name); continue; }
      if (!paper || paper.fulltextStatus === 'review') libraryFail('library_identity',409);
      const claimed = {...job,state:'running',acquisitionStartedAt:Date.now(),leaseId:crypto.randomUUID(),leaseUntil:Date.now() + MUSE_LEASE_MS,updatedAt:Date.now()};
      await musePut(env,claimed);
      const observed = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + job.doi),job.doi);
      if (observed?.leaseId !== claimed.leaseId) libraryFail('muse_sync_pending',503);
      return json({ok:true,task:{schemaVersion:1,taskId:job.id,doi:job.doi,title:paper.title,leaseId:claimed.leaseId,leaseUntil:new Date(claimed.leaseUntil).toISOString(),idempotencyKey:'doi:' + job.doi,
        sources:['open_access','authorized_hamburg'],institutionLoginUrl:HAN_LOGIN_URL,institutionUrl:hanDoiUrl(job.doi),
        receiptUrl:'https://learn.dryz.info/api/muse/receipt',uploadUrl:'https://learn.dryz.info/api/muse/upload'}});
    }
    return json({ok:true,task:null});
  } catch (error) { return museError(error); }
}
function museTaskInput(value, allowed) {
  if (Object.keys(value).some(k => !allowed.includes(k)) || !libraryDoi(value.doi) || libraryDoi(value.doi) !== value.doi
      || !MUSE_UUID.test(value.taskId || '') || !MUSE_UUID.test(value.leaseId || '')) libraryFail('muse_bad_request',400);
}
async function museOwned(env, input) {
  const job = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + input.doi),input.doi);
  if (!job || job.id !== input.taskId || job.leaseId !== input.leaseId) libraryFail('muse_stale',409);
  return job;
}
function museError(error) {
  return json({ok:false,error:error instanceof LibraryFailure || error instanceof PdfFailure ? error.code : 'muse_server'},error instanceof LibraryFailure || error instanceof PdfFailure ? error.status : 500);
}
async function handleMuseReceipt(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('muse_bad_request',405);
    await museAuthorize(request,env);
    const input = await fulltextReadJson(request,1024,'muse_bad_request');
    museTaskInput(input,['taskId','doi','leaseId','state','sha256','bytes','driveFileId']);
    if (!['running','login_required','failed','uploaded'].includes(input.state)) libraryFail('muse_bad_request',400);
    if (input.state === 'uploaded') {
      if (!/^[a-f0-9]{64}$/.test(input.sha256 || '') || !Number.isInteger(input.bytes) || input.bytes < 51200 || input.bytes > LIBRARY_MAX_PDF_BYTES
          || typeof input.driveFileId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(input.driveFileId)) libraryFail('muse_bad_request',400);
    } else if (['sha256','bytes','driveFileId'].some(k => Object.hasOwn(input,k))) libraryFail('muse_bad_request',400);
    let job = await museOwned(env,input);
    if (['available','verifying'].includes(job.state)) {
      if (input.state === 'uploaded' && job.sha256 === input.sha256 && job.bytes === input.bytes && job.driveFileId === input.driveFileId) return json({ok:true,job:musePublicJob(job),needsUpload:false});
      libraryFail('muse_stale',409);
    }
    if (job.state === 'login_required' && input.state === 'running' && Date.now() - (job.acquisitionStartedAt || job.createdAt) < 86400000) job = {...job,state:'running',acquisitionStartedAt:Date.now(),leaseUntil:Date.now() + MUSE_LEASE_MS};
    if (!['running','uploading'].includes(job.state) || job.leaseUntil < Date.now()) libraryFail('muse_stale',409);
    // Progress renews only this lease, up to two hours after first creation.
    const leaseUntil = Math.min(Date.now() + MUSE_LEASE_MS,(job.acquisitionStartedAt || job.createdAt) + 7200000);
    if (leaseUntil <= Date.now()) libraryFail('muse_stale',409);
    if (job.state === 'uploading' && (input.state !== 'uploaded' || job.sha256 !== input.sha256 || job.bytes !== input.bytes || job.driveFileId !== input.driveFileId)) libraryFail('muse_stale',409);
    const next = {...job,state:input.state === 'uploaded' ? 'uploading' : input.state,leaseUntil,updatedAt:Date.now(),
      ...(input.state === 'uploaded' ? {sha256:input.sha256,bytes:input.bytes,driveFileId:input.driveFileId} : input.state === 'failed' ? {reason:'agent_failed'} : {})};
    await musePut(env,next);
    if (['failed','login_required'].includes(next.state)) await museDelete(env,job.queueKey);
    return json({ok:true,job:musePublicJob(next),needsUpload:next.state === 'uploading'});
  } catch (error) { return museError(error); }
}
async function handleMuseUpload(request, env) {
  try {
    if (request.method !== 'PUT' || new URL(request.url).search) libraryFail('muse_bad_request',405);
    await museAuthorize(request,env);
    if (request.headers.get('content-type') !== 'application/pdf') libraryFail('muse_bad_request',415);
    const input = {doi:request.headers.get('x-muse-doi'),taskId:request.headers.get('x-muse-task-id'),leaseId:request.headers.get('x-muse-lease-id')};
    museTaskInput(input,['doi','taskId','leaseId']);
    let job = await museOwned(env,input);
    if (!['uploading','verifying'].includes(job.state) || (job.state === 'uploading' && job.leaseUntil < Date.now())) libraryFail('muse_stale',409);
    const length = request.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) !== job.bytes)) libraryFail('muse_bad_pdf',413);
    const reader = request.body?.getReader(); if (!reader) libraryFail('muse_bad_pdf',400);
    const chunks = []; let size = 0;
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > job.bytes || size > LIBRARY_MAX_PDF_BYTES) { pdfCancel(reader); libraryFail('muse_bad_pdf',413); } chunks.push(item.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    if (size !== job.bytes || await pdfDigest('SHA-256',bytes) !== job.sha256) libraryFail('muse_bad_pdf',409);
    libraryValidatePdf(bytes);
    job = await museOwned(env,input);
    if (!['uploading','verifying'].includes(job.state)) libraryFail('muse_stale',409);
    const candidateKey = 'library:muse-candidate:' + job.sha256;
    await libraryPut(env.QL_KV,candidateKey,bytes.buffer,{expirationTtl:604800});
    let stored; try { stored = await env.QL_KV.get(candidateKey,'arrayBuffer'); } catch { libraryFail('library_storage',503); }
    if (!stored) libraryFail('muse_sync_pending',503);
    if (await pdfDigest('SHA-256',new Uint8Array(stored)) !== job.sha256) libraryFail('muse_bad_pdf',409);
    // Preserve the first successful delivery time across duplicate PUTs and verifier leases.
    const verifying = {...job,state:'verifying',receivedAt:job.receivedAt || (job.state === 'verifying' ? job.updatedAt : Date.now()),updatedAt:Date.now(),candidateKey};
    await musePut(env,verifying);
    await libraryPut(env.QL_KV,MUSE_REVIEW_PREFIX + job.id,JSON.stringify({doi:job.doi,id:job.id}),{expirationTtl:604800});
    await museDelete(env,job.queueKey);
    if (job.state !== 'verifying') await museRequestReview(env);
    return json({ok:true,job:musePublicJob(verifying),verified:false,archive:libraryArchiveStatus()});
  } catch (error) { return museError(error); }
}
async function handleMuseReview(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) return json({ok:false,error:'muse_bad_request',protocolVersion:3},405);
    const owner = await fulltextJobAuthorize(request,MUSE_REVIEW_POLICY);
    libraryConfig(env); // A configured verifier may finish candidates while Muse polling is disabled.
    const input = await fulltextReadJson(request,1024,'muse_bad_request');
    if (input.action === 'recheck') {
      // Only an explicit maintainer dispatch may reopen one quarantined original.
      await fulltextJobAuthorize(request,{...MUSE_REVIEW_POLICY,events:['workflow_dispatch']});
      if (Object.keys(input).length !== 2 || !libraryDoi(input.doi) || libraryDoi(input.doi) !== input.doi) libraryFail('muse_bad_request',400);
      const job = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + input.doi),input.doi);
      if (!job) libraryFail('muse_stale',409);
      if (job.state === 'available') return json({ok:true,task:null});
      const resume = job.state === 'verifying' && job.reviewOwner === owner && job.reviewLeaseUntil > Date.now();
      if (job.state !== 'review' && !resume) libraryFail('muse_stale',409);
      const valid = museRecord({...job,state:'verifying'},input.doi);
      if (!valid) libraryFail('library_integrity',502);
      const record = await libraryGet(env.QL_KV,LIBRARY_PREFIX + job.doi), paper = libraryPaper(record,job.doi);
      if (!paper || paper.fulltextStatus === 'review' || record.pdf) libraryFail('library_identity',409);
      const attempt = await libraryGet(env.QL_KV,'library:attempt:' + job.doi);
      if (attempt?.paused) libraryFail('library_paused',423);
      await museOwnerGuard(env,job.doi);
      let stored; try { stored = await env.QL_KV.get(job.candidateKey,'arrayBuffer'); } catch { libraryFail('library_storage',503); }
      if (!stored) libraryFail('muse_sync_pending',503);
      const bytes = new Uint8Array(stored);
      if (bytes.length !== job.bytes || await pdfDigest('SHA-256',bytes) !== job.sha256) libraryFail('library_integrity',502);
      libraryValidatePdf(bytes);
      const claimed = resume ? job : {...job,state:'verifying',updatedAt:Date.now(),reviewRejectedAt:job.updatedAt,
        reviewRecheckedAt:Date.now(),reviewOwner:owner,reviewLeaseId:crypto.randomUUID(),reviewLeaseUntil:Date.now() + MUSE_LEASE_MS};
      if (!resume) await musePut(env,claimed);
      await libraryPut(env.QL_KV,MUSE_REVIEW_PREFIX + job.id,JSON.stringify({doi:job.doi,id:job.id}),{expirationTtl:604800});
      const observed = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + job.doi),job.doi);
      if (observed?.reviewLeaseId !== claimed.reviewLeaseId) libraryFail('muse_sync_pending',503);
      return json({ok:true,task:{taskId:job.id,doi:job.doi,title:paper.title,sha256:job.sha256,bytes:job.bytes,leaseId:claimed.reviewLeaseId}});
    }
    if (input.action === 'claim') {
      if (Object.keys(input).length !== 1) libraryFail('muse_bad_request',400);
      for (const entry of await museList(env,MUSE_REVIEW_PREFIX)) {
        const pointer = await libraryGet(env.QL_KV,entry.name), job = pointer?.doi && museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + pointer.doi),pointer.doi);
        if (!job || job.id !== pointer.id || entry.name !== MUSE_REVIEW_PREFIX + job.id) continue;
        if (job.state !== 'verifying') { await museDelete(env,entry.name); continue; }
        if (job.reviewLeaseUntil > Date.now()) continue;
        const paper = libraryPaper(await libraryGet(env.QL_KV,LIBRARY_PREFIX + job.doi),job.doi);
        if (!paper || paper.fulltextStatus === 'review') libraryFail('library_identity',409);
        const claimed = {...job,reviewOwner:owner,reviewLeaseId:crypto.randomUUID(),reviewLeaseUntil:Date.now() + MUSE_LEASE_MS};
        await musePut(env,claimed);
        const observed = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + job.doi),job.doi);
        if (observed?.reviewLeaseId !== claimed.reviewLeaseId) libraryFail('muse_sync_pending',503);
        return json({ok:true,task:{taskId:job.id,doi:job.doi,title:paper.title,sha256:job.sha256,bytes:job.bytes,leaseId:claimed.reviewLeaseId}});
      }
      return json({ok:true,task:null});
    }
    museTaskInput(input,['action','taskId','doi','leaseId','sha256','bytes','result','pages','method']);
    if (!['bytes','complete'].includes(input.action) || (input.action === 'bytes' && Object.keys(input).some(k => !['action','taskId','doi','leaseId'].includes(k)))) libraryFail('muse_bad_request',400);
    const job = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + input.doi),input.doi);
    if (!job || job.id !== input.taskId || job.reviewOwner !== owner || job.reviewLeaseId !== input.leaseId || job.reviewLeaseUntil < Date.now()) libraryFail('muse_stale',409);
    if (input.action === 'complete' && (!['verified','rejected'].includes(input.result) || input.sha256 !== job.sha256 || input.bytes !== job.bytes
        || input.method !== 'dual_parser_all_pages_title_doi' || !Number.isInteger(input.pages) || input.pages < 0 || input.pages > 200 || (input.result === 'verified' && input.pages < 1))) libraryFail('muse_bad_request',400);
    if (input.action === 'complete' && ['available','review'].includes(job.state)) return json({ok:true,job:musePublicJob(job),archive:libraryArchiveStatus()});
    if (job.state !== 'verifying') libraryFail('muse_stale',409);
    if (input.action === 'complete' && input.result === 'rejected') {
      await musePut(env,{...job,state:'review',updatedAt:Date.now()}); await museDelete(env,MUSE_REVIEW_PREFIX + job.id);
      return json({ok:true,job:musePublicJob({...job,state:'review'}),archive:libraryArchiveStatus()});
    }
    let stored; try { stored = await env.QL_KV.get(job.candidateKey,'arrayBuffer'); } catch { libraryFail('library_storage',503); }
    if (!stored) libraryFail('muse_sync_pending',503);
    const bytes = new Uint8Array(stored);
    if (bytes.length !== job.bytes || await pdfDigest('SHA-256',bytes) !== job.sha256) libraryFail('library_integrity',502);
    libraryValidatePdf(bytes);
    if (input.action === 'bytes') return new Response(bytes,{headers:{'content-type':'application/pdf','content-length':String(bytes.length),'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
    await museOwnerGuard(env,job.doi);
    const record = await libraryGet(env.QL_KV,LIBRARY_PREFIX + job.doi), paper = libraryPaper(record,job.doi);
    if (!paper || paper.fulltextStatus === 'review' || (record.pdf && record.pdf.sha256 !== job.sha256)) libraryFail('library_identity',409);
    await librarySave(env.QL_KV,{...paper,fulltextStatus:'available'},{bytes,source:'muse_verified'},'');
    const saved = await libraryGet(env.QL_KV,LIBRARY_PREFIX + job.doi);
    if (!libraryPaper(saved,job.doi) || saved.pdf?.sha256 !== job.sha256) libraryFail('muse_sync_pending',503);
    await libraryStoredPdf(env.QL_KV,saved);
    const done = {...job,state:'available',updatedAt:Date.now(),verification:{method:input.method,pages:input.pages,sha256:job.sha256,bytes:job.bytes}};
    await musePut(env,done); await museDelete(env,MUSE_REVIEW_PREFIX + job.id);
    return json({ok:true,job:musePublicJob(done),downloadUrl:'/api/fulltext?doi=' + encodeURIComponent(job.doi),archive:{...libraryArchiveStatus(),sides:{github:'pending',drive:job.driveFileId ? 'reported' : 'pending',mac:'pending'}}});
  } catch (error) { return museError(error); }
}
async function handleAcquire(request, env) {
  let doi = '', release;
  const controller = new AbortController(); let timer;
  try {
    const parsed = libraryQuery(request); doi = parsed.doi;
    if (request.method === 'GET') {
      const stored = env.QL_KV ? libraryPaper(await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), doi) : null;
      const attempt = env.QL_KV && (!stored || stored.fulltextStatus !== 'available') ? await libraryGet(env.QL_KV, 'library:attempt:' + doi) : null;
      if (attempt && attempt.paused) libraryFail('library_paused', 423, attempt.retryAfter || 0);
      if (env.QL_KV && env.GROK_FULLTEXT_ENABLED === 'true' && env.FULLTEXT_ASYNC_ENABLED !== 'true') {
        const job = grokRecord(await libraryGet(env.QL_KV,GROK_JOB_PREFIX + doi),doi);
        if (job) {
          if (job.state === 'available' && (!stored || stored.fulltextStatus !== 'available')) libraryFail('library_sync_pending',503);
          if (stored && stored.fulltextStatus === 'available' && job.state !== 'available') return libraryResult(request,stored,'',true);
          return grokJobResponse(request,job,stored);
        }
      }
      if (env.QL_KV && env.FULLTEXT_ASYNC_ENABLED === 'true' && parsed.url.pathname !== '/api/acquire/retry') {
        const job = fulltextJobRecord(await libraryGet(env.QL_KV, FULLTEXT_JOB_PREFIX + doi), doi);
        if (job) return fulltextJobResponse(request, job, stored);
        if (stored && stored.fulltextStatus === 'available') return libraryResult(request, stored, '', true);
      }
      const observed = libraryObservedPaper(stored, attempt), manual = observed && observed.fulltextStatus === 'manual_needed';
      const institution = env.GROK_FULLTEXT_ENABLED === 'true' && env.FULLTEXT_ASYNC_ENABLED !== 'true';
      if (manual && !institution && parsed.url.pathname !== '/api/acquire/retry') return libraryResult(request, observed, 'library_manual_needed');
      return libraryForm(doi, '/api/acquire', false, manual || stored && stored.fulltextStatus === 'review' ? 0 : attempt && attempt.retryAfter, manual,institution);
    }
    if (request.method !== 'POST') libraryFail('library_method', 405);
    await libraryAuthorize(request, env, parsed.url); const diagnostic = pdfDiagnosticStart(request); libraryConfig(env);
    const cachedRecord = await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), cached = libraryPaper(cachedRecord, doi);
    if (cached && cached.fulltextStatus === 'available') { await libraryStoredPdf(env.QL_KV, cachedRecord); return await libraryAcquireResult(request, env, cached, parsed.download, '', true); }
    const institution = env.GROK_FULLTEXT_ENABLED === 'true';
    if (institution) grokConfig(env);
    if (typeof env.GITHUB_LIBRARY_TOKEN !== 'string' || !env.GITHUB_LIBRARY_TOKEN.trim() || (env.PDF_GITHUB_COMMIT !== undefined && (typeof env.PDF_GITHUB_COMMIT !== 'string' || !/^[a-f0-9]{40}$/i.test(env.PDF_GITHUB_COMMIT)))) libraryFail('library_not_configured', 503);
    const previousAttempt = await libraryGet(env.QL_KV, 'library:attempt:' + doi);
    if (previousAttempt?.paused === true) { diagnostic.historical = true; const error = new LibraryFailure('library_paused',423,previousAttempt.retryAfter || 0); error.diagnostic = await pdfLastDiagnostic(env,doi); throw error; }
    if (institution) {
      const prior = grokRecord(await libraryGet(env.QL_KV,GROK_JOB_PREFIX + doi),doi);
      if (prior) return grokJobResponse(request,prior,cached);
    }
    const priorJob = env.FULLTEXT_ASYNC_ENABLED === 'true' ? fulltextJobRecord(await libraryGet(env.QL_KV, FULLTEXT_JOB_PREFIX + doi), doi) : null;
    const observed = libraryObservedPaper(cached, previousAttempt, fulltextJobActive(priorJob)), manual = observed && observed.fulltextStatus === 'manual_needed';
    if (env.FULLTEXT_ASYNC_ENABLED === 'true' && !manual) return fulltextEnqueue(request, env, doi, cached);
    release = await librarySoftGate(env.QL_KV, request, doi, manual);
    timer = setTimeout(() => controller.abort(), LIBRARY_TASK_MS);
    const context = { signal:controller.signal,diagnostic };
    let sourceDiagnostic = null;
    if (!manual) pdfDiagnosticStage(diagnostic,'metadata');
    let paper = manual ? observed : await libraryMetadata(doi, context);
    let fetched = null, review = false, sourceUnavailable = false, sourceRetryAfter = 0;
    try { fetched = await libraryGithub(paper, env, context); }
    catch (error) { sourceDiagnostic = sanitizePdfDiagnostic(pdfAttachDiagnostic(error,diagnostic).diagnostic); if (controller.signal.aborted) { const timeout = new LibraryFailure('library_timeout',504); timeout.diagnostic = sourceDiagnostic; throw timeout; } if (['library_not_configured','library_paused'].includes(error.code)) throw error; review = ['library_identity','pdf_integrity','pdf_index_invalid'].includes(error.code); sourceUnavailable = !review; sourceRetryAfter = error.retryAfter || 0; }
    if (!manual && !fetched && !review && !sourceUnavailable) {
      const oa = await libraryOa(paper, context); if (oa.bytes) fetched = oa; else { sourceDiagnostic = oa.diagnostic || sourceDiagnostic; review = review || oa.review; sourceUnavailable = sourceUnavailable || oa.unavailable; sourceRetryAfter = oa.retryAfter || 0; }
    }
    if (controller.signal.aborted) { diagnostic.reason = 'total_timeout'; throw pdfAttachDiagnostic(new LibraryFailure('library_timeout',504),diagnostic); }
    paper = { ...paper, fulltextStatus:fetched ? 'available' : review ? 'review' : sourceUnavailable ? 'pending' : 'manual_needed' };
    const saved = await librarySave(env.QL_KV, paper, fetched, review ? 'library_identity' : sourceUnavailable ? 'library_upstream' : 'library_manual_needed', sourceRetryAfter);
    if (saved.paper.fulltextStatus !== 'available' && sourceUnavailable) { const error = new LibraryFailure('library_upstream',502,saved.retryAfter); error.diagnostic = sourceDiagnostic; throw error; }
    if (saved.paper.fulltextStatus !== 'available' && sourceDiagnostic) { await pdfSaveDiagnostic(env,doi,sourceDiagnostic); const response = await libraryAcquireResult(request,env,saved.paper,parsed.download,'library_identity',false,saved.retryAfter); return pdfDiagnosticResponse(response,sourceDiagnostic); }
    if (institution && saved.paper.fulltextStatus === 'manual_needed') return await grokEnqueue(request,env,doi,saved.paper);
    return await libraryAcquireResult(request, env, saved.paper, parsed.download, saved.paper.fulltextStatus === 'available' ? '' : review ? 'library_identity' : 'library_manual_needed', false, saved.retryAfter);
  } catch (error) {
    const diagnostic = PDF_REQUEST_DIAGNOSTICS.get(request);
    if (diagnostic && !release && ['library_paused','library_retry_later','library_busy','library_limit'].includes(error.code)) { diagnostic.historical = true; error.diagnostic = await pdfLastDiagnostic(env,doi); }
    pdfAttachDiagnostic(error,diagnostic);
    if (diagnostic && !diagnostic.historical) await pdfSaveDiagnostic(env,doi,error.diagnostic);
    if (release && doi && env.QL_KV && !String(error.code || '').startsWith('grok_')) {
      try {
        const observed = libraryPaper(await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), doi);
        if (!observed || observed.fulltextStatus !== 'available') {
          const previous = await libraryGet(env.QL_KV,'library:attempt:' + doi);
          const paused = error.code === 'library_paused', retryAfter = error.retryAfter || (paused || error.code === 'library_identity' ? 0 : Date.now() + LIBRARY_RETRY_SECONDS * 1000);
          if (!previous?.paused) await libraryPut(env.QL_KV, 'library:attempt:' + doi, JSON.stringify({ status:error.code === 'library_identity' ? 'review' : 'pending', error:error.code || 'library_server', paused, retryAfter }), paused || !retryAfter ? undefined : { expirationTtl:600 });
          error.retryAfter = retryAfter;
        }
      } catch { /* Preserve the original fixed error if storage/cooldown is unavailable. */ }
    }
    return libraryError(request, error, doi, '/api/acquire');
  }
  finally { clearTimeout(timer); if (release) await release(); }
}
async function handleFulltext(request, env) {
  let doi = '';
  try {
    const parsed = libraryQuery(request); doi = parsed.doi;
    if (request.method === 'GET') return libraryForm(doi, '/api/fulltext');
    if (request.method !== 'POST') libraryFail('library_method', 405);
    await libraryAuthorize(request, env, parsed.url); libraryConfig(env);
    const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), paper = libraryPaper(record, doi);
    if (!paper || paper.fulltextStatus !== 'available') libraryFail('library_not_found', 404);
    const bytes = await libraryStoredPdf(env.QL_KV, record);
    return libraryPdfResponse(paper, bytes);
  } catch (error) { return libraryError(request, error, doi, '/api/fulltext'); }
}

async function handleFulltextSource(request, env) {
  let doi = '', authorized = false, lastDiagnostic = null, historical = false;
  const controller = new AbortController(); let timer;
  try {
    const parsed = libraryQuery(request); doi = parsed.doi;
    if (request.method === 'GET') return pdfHtml('<p>输入既有全文口令，仅核对网站正在读取的索引版本。不读取 PDF、不执行下载任务。</p><form method="post" action="/api/fulltext-source?doi='+pdfEscape(encodeURIComponent(doi))+'"><label>全文口令 <input name="passphrase" type="password" maxlength="256" autocomplete="current-password" required></label><button type="submit">核对全文读取版本</button></form>'+pdfOfficialLink(doi),200,'全文来源快检');
    if (request.method !== 'POST') libraryFail('library_method',405);
    await libraryAuthorize(request,env,parsed.url); authorized = true;
    const diagnostic = pdfDiagnosticStart(request);
    lastDiagnostic = await pdfLastDiagnostic(env,doi);
    const attempt = env.QL_KV ? await libraryGet(env.QL_KV,'library:attempt:' + doi) : null;
    if (attempt?.paused === true) { historical = true; throw new LibraryFailure('library_paused',423,attempt.retryAfter || 0); }
    libraryConfig(env);
    if (typeof env.GITHUB_LIBRARY_TOKEN !== 'string' || !env.GITHUB_LIBRARY_TOKEN.trim()) libraryFail('library_not_configured',503);
    const stored = libraryPaper(await libraryGet(env.QL_KV,LIBRARY_PREFIX+doi),doi);
    timer = setTimeout(()=>controller.abort(),LIBRARY_TASK_MS);
    if (!stored) pdfDiagnosticStage(diagnostic,'metadata');
    const paper = stored || await libraryMetadata(doi,{signal:controller.signal,diagnostic});
    const inspection = await libraryGithub(paper,env,{signal:controller.signal,metadataOnly:true,diagnostic});
    return json({ok:true,doi,configuredCommit:pdfConfiguration(env).configuredCommit,doiLookupFollowsMain:pdfConfiguration(env).commitMode === 'latest_main',configuration:pdfConfiguration(env),lastDiagnostic,diagnosticStatus:lastDiagnostic ? 'available' : 'unavailable',inspection:inspection || {policyHold:true,pdfObjectRead:false}},200,{'referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
  } catch (error) {
    if (!authorized) return libraryError(request,error,doi,'/api/fulltext-source');
    const diagnostic = historical ? lastDiagnostic : sanitizePdfDiagnostic(pdfAttachDiagnostic(error,PDF_REQUEST_DIAGNOSTICS.get(request)).diagnostic);
    return json({ok:false,error:PDF_DIAGNOSTIC_CODES.includes(error.code) ? error.code : 'library_server',...(error.retryAfter ? libraryRetryInfo(error.retryAfter) : {}),configuration:pdfConfiguration(env),lastDiagnostic,diagnostic,diagnosticStatus:diagnostic ? 'available' : 'unavailable'},error.status || 500,{'referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
  } finally { clearTimeout(timer); controller.abort(); }
}
async function pdfDiagnosticResponse(response, diagnostic) {
  const value = sanitizePdfDiagnostic(diagnostic); if (!value) return response;
  if ((response.headers.get('content-type') || '').includes('application/json')) return json({...await response.json(),diagnostic:value,diagnosticStatus:'available'},response.status);
  return new Response((await response.text()).replace('</main>',pdfDiagnosticHtml(value) + '</main>'),{status:response.status,headers:response.headers});
}

function normKey(pmid, doi) {
  if (pmid && /^\d{1,9}$/.test(String(pmid))) return 'pmid:' + pmid;
  if (doi && /^10\.\d{4,9}\/\S{1,200}$/.test(String(doi))) return 'doi:' + String(doi).toLowerCase();
  return '';
}
const parseKey = k => {
  const m = /^(pmid|doi):(.{1,220})$/.exec(k || '');
  if (!m) return null;
  return normKey(m[1] === 'pmid' ? m[2] : '', m[1] === 'doi' ? m[2] : '') ? { type: m[1], id: m[2] } : null;
};

