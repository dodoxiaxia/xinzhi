// ==== edge/src/02-acquire-import.js · Acquisition bot queue (Grok) and owner import ====
// The existing Bot remains the only acquisition owner. No cookies or credentials
// travel in task bodies. KV dedup is soft; the Bot must also claim the original ledger.
const GROK_JOB_PREFIX = 'library:grok-job:';
const GROK_JOB_STATES = ['dispatching','accepted','uncertain','running','login_required','available','review','failed'];
function grokConfig(env) {
  if (env.GROK_FULLTEXT_ENABLED !== 'true') libraryFail('grok_disabled', 503);
  if (env.FULLTEXT_ASYNC_ENABLED === 'true' || env.MUSE_FULLTEXT_ENABLED === 'true') libraryFail('grok_owner_conflict', 409);
  let url;
  try { url = new URL(env.GROK_FULLTEXT_WEBHOOK_URL); } catch { libraryFail('grok_not_configured', 503); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
      || !/^(?:[a-z0-9-]+\.)*(?:cursor\.sh|cursor\.com|x\.ai)$/.test(url.hostname)
      || url.href.length > 2048
      || typeof env.GROK_FULLTEXT_WEBHOOK_KEY !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(env.GROK_FULLTEXT_WEBHOOK_KEY)
      || typeof env.GROK_FULLTEXT_RECEIPT_KEY !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(env.GROK_FULLTEXT_RECEIPT_KEY)
      || env.GROK_FULLTEXT_WEBHOOK_KEY === env.GROK_FULLTEXT_RECEIPT_KEY) libraryFail('grok_not_configured', 503);
  return {url:url.href,key:env.GROK_FULLTEXT_WEBHOOK_KEY};
}
function grokRecord(value, doi = '') {
  if (!value || value.version !== 1 || !libraryDoi(value.doi) || libraryDoi(value.doi) !== value.doi || (doi && value.doi !== doi)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id || '')
      || !GROK_JOB_STATES.includes(value.state)
      || ![value.createdAt,value.updatedAt].every(n => Number.isSafeInteger(n) && n >= 0 && n < 8640000000000000 - 28800000)) return null;
  return value;
}
function grokPublicJob(value, doi = '') {
  const job = grokRecord(value, doi);
  if (!job) return null;
  const expired = ['dispatching','accepted','running'].includes(job.state) && Date.now() - job.createdAt >= 86400000;
  const internal = expired ? 'uncertain' : job.state;
  const state = {dispatching:'queued',accepted:'queued',uncertain:'manual_needed',login_required:'manual_needed'}[internal] || internal;
  const messages = {
    dispatching:'正在提交后台全文任务。', accepted:'后台已接受任务，正在等待处理结果。',
    running:'后台正在获取并归档全文。', login_required:'后台机构会话需要重新登录，请维护者在原浏览器中处理后继续。',
    uncertain:'暂时无法确认后台任务进度，请维护者核查原任务；系统不会重复触发。',
    available:'全文已核验，可下载。三端归档状态另行确认。',
    review:'上传结果未通过来源或文件核验，请维护者处理。', failed:'后台未能完成任务，请维护者核查原因。'
  };
  return {id:job.id,doi:job.doi,state,attempts:0,createdAt:new Date(job.createdAt).toISOString(),
    updatedAt:new Date(job.updatedAt).toISOString(),message:messages[internal],
    ...(['queued','running'].includes(state) ? {nextCheckSeconds:15} : {})};
}
async function grokPutJob(env, job) {
  await libraryPut(env.QL_KV, GROK_JOB_PREFIX + job.doi, JSON.stringify(job), {expirationTtl:604800});
}
function grokJobResponse(request, record, paper = null) {
  const job = grokPublicJob(record), active = ['queued','running'].includes(job.state);
  const url = '/api/acquire?doi=' + encodeURIComponent(job.doi);
  const archive = {...libraryArchiveStatus(),executionClaimed:['running','available'].includes(record.state),
    sides:{github:record.state === 'available' ? 'verified' : 'pending',
      mac:record.reportedSides?.mac === true ? 'reported' : 'pending',drive:record.reportedSides?.drive === true ? 'reported' : 'pending'}};
  if (!(request.headers.get('accept') || '').includes('text/html')) return json({ok:true,status:job.state,job,
    ...(paper ? {paper} : {}),archive,statusUrl:url,
    ...(job.state === 'available' ? {downloadUrl:'/api/fulltext?doi=' + encodeURIComponent(job.doi)} : {})},
    active ? 202 : 200, active ? {'retry-after':'15'} : {});
  const poll = active ? '<p>任务会在后台继续执行，无需保持页面打开。</p><meta http-equiv="refresh" content="15;url=' + pdfEscape(url) + '">' : '';
  const download = job.state === 'available' ? '<p><a href="/api/fulltext?doi=' + pdfEscape(encodeURIComponent(job.doi)) + '">下载 PDF</a></p>' : '';
  const sideLabels = {verified:'已核验',reported:'已报告，待确认',pending:'待处理'};
  const archiveText = '归档进度：GitHub ' + sideLabels[archive.sides.github] + '；Drive ' + sideLabels[archive.sides.drive] + '；Mac ' + sideLabels[archive.sides.mac] + '。三端完成尚未确认。';
  return pdfHtml('<p role="status">' + pdfEscape(job.message) + '</p><p>' + pdfEscape(paper?.title || job.doi) + '</p>' + poll
    + '<p><a href="' + pdfEscape(url) + '">刷新任务状态</a></p>' + download
    + '<p>' + pdfEscape(archiveText) + '</p>' + pdfOfficialLink(job.doi),
    active ? 202 : 200, '全文下载任务');
}
async function grokEnqueue(request, env, doi, paper) {
  const config = grokConfig(env);
  const existing = grokRecord(await libraryGet(env.QL_KV, GROK_JOB_PREFIX + doi), doi);
  if (existing) return grokJobResponse(request, existing, paper);
  const previousOwner = fulltextJobRecord(await libraryGet(env.QL_KV, FULLTEXT_JOB_PREFIX + doi), doi);
  if (previousOwner && ['queued','running'].includes(previousOwner.state)) libraryFail('grok_owner_conflict', 409);
  const now = Date.now();
  let job = {version:1,id:crypto.randomUUID(),doi,state:'dispatching',createdAt:now,updatedAt:now};
  // Persist before sending. Ambiguous dispatches are never automatically resent.
  await grokPutJob(env, job);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  let state = 'uncertain';
  try {
    const response = await awaitAbort(fetch(config.url, {method:'POST',redirect:'manual',signal:controller.signal,
      headers:{authorization:'Bearer ' + config.key,'content-type':'application/json'},
      body:JSON.stringify({schemaVersion:1,taskId:job.id,doi,idempotencyKey:'doi:' + doi,
        institutionLoginUrl:HAN_LOGIN_URL,institutionUrl:hanDoiUrl(doi),receiptUrl:'https://learn.dryz.info/api/grok-fulltext-receipt'})}),
      controller.signal,'grok_dispatch_timeout');
    state = response.status === 200 ? 'accepted' : 'failed';
    pdfCancel(response.body);
  } catch { /* Keep uncertainty; a lost response may have started the Bot. */ }
  finally { clearTimeout(timer); }
  const current = grokRecord(await libraryGet(env.QL_KV, GROK_JOB_PREFIX + doi), doi);
  if (!current || current.id !== job.id) libraryFail('job_stale', 409);
  // A fast callback can arrive before the webhook response. Preserve its progress.
  if (current.state === 'dispatching') {
    job = {...current,state,updatedAt:Date.now()};
    await grokPutJob(env, job);
  } else job = current;
  if (job.state === 'available') {
    paper = libraryPaper(await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi),doi);
    if (!paper || paper.fulltextStatus !== 'available') libraryFail('library_sync_pending',503);
  }
  return grokJobResponse(request, job, paper);
}
async function grokReceiptInput(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) libraryFail('grok_bad_receipt', 415);
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 2048)) libraryFail('grok_bad_receipt', 413);
  const reader = request.body?.getReader();
  if (!reader) libraryFail('grok_bad_receipt', 400);
  const chunks = []; let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > 2048) { pdfCancel(reader); libraryFail('grok_bad_receipt', 413); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { libraryFail('grok_bad_receipt', 400); }
  if (!value || Array.isArray(value) || Object.keys(value).some(k => !['taskId','doi','state','githubCommit','sha256','reportedSides'].includes(k))
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.taskId || '')
      || !libraryDoi(value.doi) || libraryDoi(value.doi) !== value.doi || !['running','login_required','uploaded','failed'].includes(value.state)) libraryFail('grok_bad_receipt', 400);
  if (value.state === 'uploaded') {
    if (!/^[a-f0-9]{40}$/.test(value.githubCommit || '') || !/^[a-f0-9]{64}$/.test(value.sha256 || '')
        || (value.reportedSides !== undefined && (!value.reportedSides || Array.isArray(value.reportedSides)
          || typeof value.reportedSides !== 'object' || Object.entries(value.reportedSides).some(([k,v]) => !['mac','drive'].includes(k) || typeof v !== 'boolean')))) libraryFail('grok_bad_receipt', 400);
  } else if (['githubCommit','sha256','reportedSides'].some(k => Object.hasOwn(value,k))) libraryFail('grok_bad_receipt', 400);
  return value;
}
async function handleGrokReceipt(request, env) {
  let job;
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('grok_bad_receipt', 405);
    grokConfig(env);
    const expected = await pdfDigest('SHA-256',new TextEncoder().encode('Bearer ' + env.GROK_FULLTEXT_RECEIPT_KEY));
    const actual = await pdfDigest('SHA-256',new TextEncoder().encode(request.headers.get('authorization') || ''));
    let difference = 0;
    for (let i = 0; i < 64; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
    if (difference) libraryFail('grok_unauthorized', 401);
    libraryConfig(env);
    const input = await grokReceiptInput(request);
    job = grokRecord(await libraryGet(env.QL_KV, GROK_JOB_PREFIX + input.doi), input.doi);
    if (!job || job.id !== input.taskId) libraryFail('job_stale', 409);
    // Finished work cannot be downgraded by delayed or duplicated progress messages.
    if (job.state === 'available') return json({ok:true,job:grokPublicJob(job)});
    if (['review','failed'].includes(job.state)) libraryFail('grok_receipt_review_required', 409);
    if (input.state !== 'uploaded') {
      job = {...job,state:input.state,updatedAt:Date.now()};
      await grokPutJob(env, job);
      return json({ok:true,job:grokPublicJob(job)});
    }
    const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + input.doi), paper = libraryPaper(record,input.doi);
    if (!paper || paper.fulltextStatus === 'review' || (record.pdf && record.pdf.sha256 !== input.sha256)) libraryFail('library_identity', 409);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), LIBRARY_TASK_MS);
    try {
      // Read only the original repository's exact commit and mother index; no Bot-supplied paths/URLs.
      const fetched = await libraryGithub(paper, {...env,PDF_GITHUB_COMMIT:input.githubCommit,
        DOI_LOOKUP_LATEST_MAIN:'false',DOI_GITHUB_DELTA_ENABLED:'false'}, {signal:controller.signal});
      if (!fetched || await pdfDigest('SHA-256',fetched.bytes) !== input.sha256) libraryFail('library_identity', 409);
      const current = grokRecord(await libraryGet(env.QL_KV,GROK_JOB_PREFIX + job.doi),job.doi);
      if (!current || current.id !== job.id || ['review','failed'].includes(current.state)) libraryFail('job_stale',409);
      if (current.state === 'available') return json({ok:true,job:grokPublicJob(current)});
      if (controller.signal.aborted) libraryFail('library_timeout',504);
      await librarySave(env.QL_KV,{...paper,fulltextStatus:'available'},fetched,'');
      const saved = await libraryGet(env.QL_KV,LIBRARY_PREFIX + input.doi);
      if (saved?.pdf?.sha256 !== input.sha256) libraryFail('library_identity',409);
      await libraryStoredPdf(env.QL_KV,saved);
      job = {...current,state:'available',updatedAt:Date.now(),reportedSides:input.reportedSides || {}};
      await grokPutJob(env,job);
      return grokJobResponse(request,job,libraryPaper(saved,input.doi));
    } finally { clearTimeout(timer); }
  } catch (error) {
    if (job && !['available','review','failed'].includes(job.state)
        && ['library_identity','library_integrity','library_timeout','library_upstream','library_paused','pdf_integrity','pdf_index_invalid','pdf_timeout','pdf_upstream','pdf_not_found','pdf_too_large'].includes(error.code)) {
      try {
        const current = grokRecord(await libraryGet(env.QL_KV,GROK_JOB_PREFIX + job.doi),job.doi);
        if (current && current.id === job.id && current.state !== 'available') await grokPutJob(env,{...current,state:'review',updatedAt:Date.now()});
      } catch { /* Storage failure must still return a bounded, fixed error. */ }
    }
    return json({ok:false,error:error instanceof LibraryFailure || error instanceof PdfFailure ? error.code : 'grok_receipt_server'},
      error instanceof LibraryFailure || error instanceof PdfFailure ? error.status : 500);
  }
}
// Owner import reads only an already archived original at an exact commit.
async function fulltextReadJson(request, limit, code) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) libraryFail(code,415);
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) libraryFail(code,413);
  const reader = request.body?.getReader();
  if (!reader) libraryFail(code,400);
  const chunks = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) { pdfCancel(reader); libraryFail(code,413); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  let value; try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { libraryFail(code,400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) libraryFail(code,400);
  return value;
}
function fulltextFixedSource(input, code = 'import_bad_request') {
  if (Object.keys(input).some(k => !['doi','githubCommit','sha256'].includes(k)) || !libraryDoi(input.doi) || libraryDoi(input.doi) !== input.doi
      || !/^[a-f0-9]{40}$/.test(input.githubCommit || '') || !/^[a-f0-9]{64}$/.test(input.sha256 || '')) libraryFail(code,400);
  return input;
}
async function fulltextImportGuard(env, input) {
  const record = await libraryGet(env.QL_KV,LIBRARY_PREFIX + input.doi), paper = libraryPaper(record,input.doi);
  if (paper?.fulltextStatus === 'review' || (record?.pdf && record.pdf.sha256 !== input.sha256)) libraryFail('library_identity',409);
  const queued = fulltextJobRecord(await libraryGet(env.QL_KV,FULLTEXT_JOB_PREFIX + input.doi),input.doi);
  const bot = grokRecord(await libraryGet(env.QL_KV,GROK_JOB_PREFIX + input.doi),input.doi);
  const muse = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + input.doi),input.doi);
  if ((queued && ['queued','running'].includes(queued.state)) || (bot && !['available','failed','review'].includes(bot.state))
      || (muse && !['available','failed','review'].includes(muse.state))) libraryFail('import_owner_conflict',409);
  return paper;
}
async function handleFulltextImport(request, env) {
  let diagnostic;
  try {
    if (request.method !== 'POST' || new URL(request.url).search) return json({ok:false,error:'import_bad_request',protocolVersion:7},405);
    await fulltextJobAuthorize(request,FULLTEXT_IMPORT_POLICY);
    const input = fulltextFixedSource(await fulltextReadJson(request,1024,'import_bad_request'));
    diagnostic = pdfDiagnosticStart(request);
    libraryConfig(env);
    await fulltextImportGuard(env,input);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),LIBRARY_TASK_MS);
    try {
      const context = {signal:controller.signal,diagnostic};
      const paper = await libraryMetadata(input.doi,context);
      const fetched = await libraryGithub(paper,{...env,PDF_GITHUB_COMMIT:input.githubCommit,DOI_LOOKUP_LATEST_MAIN:'false',DOI_GITHUB_DELTA_ENABLED:'false'},context);
      if (!fetched || fetched.commit !== input.githubCommit || await pdfDigest('SHA-256',fetched.bytes) !== input.sha256) libraryFail('library_identity',409);
      await fulltextImportGuard(env,input);
      if (controller.signal.aborted) libraryFail('library_timeout',504);
      await librarySave(env.QL_KV,{...paper,fulltextStatus:'available'},fetched,'');
      const saved = await libraryGet(env.QL_KV,LIBRARY_PREFIX + input.doi), current = libraryPaper(saved,input.doi);
      if (!current || current.fulltextStatus !== 'available') libraryFail('library_sync_pending',503);
      if (saved.pdf.sha256 !== input.sha256) libraryFail('library_identity',409);
      await libraryStoredPdf(env.QL_KV,saved);
      return json({ok:true,status:'available',paper:current,downloadUrl:'/api/fulltext?doi=' + encodeURIComponent(input.doi),
        source:{githubCommit:input.githubCommit,sha256:input.sha256,bytes:fetched.bytes.length},
        archive:{...libraryArchiveStatus(),sides:{github:'verified',drive:'pending',mac:'pending'}}});
    } finally { clearTimeout(timer); }
  } catch (error) {
    const safe = sanitizePdfDiagnostic(pdfAttachDiagnostic(error,diagnostic).diagnostic);
    return json({ok:false,error:error instanceof LibraryFailure || error instanceof PdfFailure ? error.code : 'import_server',...(safe ? {diagnostic:safe} : {}),...(diagnostic && error.lfsTarget ? {sourceTarget:error.lfsTarget} : {})},error instanceof LibraryFailure || error instanceof PdfFailure ? error.status : 500);
  }
}
