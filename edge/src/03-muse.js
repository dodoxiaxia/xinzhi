// ==== edge/src/03-muse.js · Muse full-text queue ====
// Muse polls its own inbox; raw originals remain private until an independent
// GitHub-hosted verifier parses/renders every page and confirms DOI/title.
const MUSE_JOB_PREFIX = 'library:muse-job:';
const MUSE_QUEUE_PREFIX = 'library:muse-queue:';
const MUSE_REVIEW_PREFIX = 'library:muse-review:';
const MUSE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MUSE_STATES = ['queued','running','uploading','verifying','login_required','available','review','failed','abandoned'];
const MUSE_LEASE_MS = 1200000;
// Muse has no fixed polling schedule, so an unclaimed request waits almost the whole job lifetime
// (KV TTL 7 days) instead of dying after one day nobody ran Muse.
// Terminal records (available, abandoned) are written without a TTL; see musePut.
const MUSE_QUEUE_MS = 6 * 86400000;
// 2026-11-12 plus the agreed 30-day transition. MUSE_DOWNLOAD_RETIRE_ON overrides the displayed date only.
const MUSE_DOWNLOAD_RETIRE_ON_DEFAULT = '2026-12-12';
const MACHINE_CALLER_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const MACHINE_FIXED_SOURCES = ['reader_upload','open_access','machine'];
// Early shutdown of the legacy Muse download endpoints (claim, receipt, upload). Only the exact string 'true' closes them.
// It never touches request, retry, reader-upload, review, /api/acquire or /api/machine/*.
const MUSE_LEGACY_ENDPOINTS = ['/api/muse/claim','/api/muse/receipt','/api/muse/upload'];
function museLegacyClosed(env) {
  return !!env && env.MUSE_LEGACY_ENDPOINTS_DISABLED === 'true';
}
function museRetiredResponse() {
  return json({ok:false,error:'muse_retired',replacement:'/api/machine/protocol'},410);
}
function museRetireOn(env) {
  const configured = env && env.MUSE_DOWNLOAD_RETIRE_ON;
  return typeof configured === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(configured) ? configured : MUSE_DOWNLOAD_RETIRE_ON_DEFAULT;
}
function museSourceOk(source) {
  return MACHINE_FIXED_SOURCES.includes(source) || MACHINE_CALLER_ID.test(source);
}
function machineCallerSource(source) {
  return MACHINE_CALLER_ID.test(source || '') && !MACHINE_FIXED_SOURCES.includes(source);
}
function handleMuseProtocol(request, env) {
  if (request.method !== 'GET' || new URL(request.url).search) return json({ok:false,error:'muse_bad_request'},405);
  const protocol = {schemaVersion:1,website:'https://learn.dryz.info',
    enabled:env.MUSE_FULLTEXT_ENABLED === 'true' && /^[A-Za-z0-9_-]{32,128}$/.test(env.MUSE_FULLTEXT_KEY || '') && env.GROK_FULLTEXT_ENABLED !== 'true' && env.FULLTEXT_ASYNC_ENABLED !== 'true' && env.PDF_DOWNLOAD_ENABLED === 'true' && !!env.QL_KV,
    auth:{header:'Authorization',scheme:'Bearer',privateSetting:'MUSE_FULLTEXT_KEY'},
    poll:{intervalMinutes:10,maxPerRun:3,parallelism:1,emptyResponse:{ok:true,task:null}},
    sources:['open_access','authorized_hamburg'],
    claim:{url:'https://learn.dryz.info/api/muse/claim',method:'POST',contentType:'application/json',body:{}},
    receipt:{url:'https://learn.dryz.info/api/muse/receipt',method:'POST',contentType:'application/json',identityFields:['taskId','doi','leaseId'],states:['running','login_required','failed','uploaded'],uploadedFields:['sha256','bytes','driveFileId']},
    upload:{url:'https://learn.dryz.info/api/muse/upload',method:'PUT',contentType:'application/pdf',body:'original_pdf_bytes',headers:{'X-Muse-Doi':'task.doi','X-Muse-Task-Id':'task.taskId','X-Muse-Lease-Id':'task.leaseId'}},
    limits:{minBytes:51200,maxBytes:LIBRARY_MAX_PDF_BYTES,maxPages:200,leaseMinutes:20,renewEveryMinutes:5,maxAcquisitionMinutes:120},
    deprecation:{downloadRole:'retired',retireOn:museRetireOn(env),autoDisable:false,closed:museLegacyClosed(env),closedEndpoints:museLegacyClosed(env) ? MUSE_LEGACY_ENDPOINTS : [],endpoints:['/api/muse/claim','/api/muse/receipt','/api/muse/upload','/api/muse/retry'],
      note:museLegacyClosed(env) ? 'Muse 已退出下载角色，领取、回执、上传接口已关闭（返回 410 muse_retired）；读者入口（request、retry、reader-upload）不受影响。新的下载队列见 /api/machine/protocol。'
        : 'Muse 已退出下载角色。过渡期内上述接口保持可用，日期可用 MUSE_DOWNLOAD_RETIRE_ON 调整；到点不会自动关闭，关闭需另一次变更。新的下载队列见 /api/machine/protocol。'},
    instructions:['使用现有 Muse 下载流程与领取账本，已有原件直接复用；只使用 sources 列出的来源。',
      '上传私有 Drive 文献收件箱后，回传同一 PDF 的 SHA256、字节数及 Drive 文件 ID，再上传原二进制；不改动 PDF。',
      'uploaded 回执不是网站核验成功；网站独立双解析器核验任务每小时第 23 分钟处理，实际排队可能延迟。',
      '需要汉堡登录时回传 login_required，维护者在原授权浏览器处理后，用原任务回传 running 恢复。',
      '重复回传复用原任务；超时或进度不明不另建任务、不再次下载。401/403/409/413/415 停止并通知维护者，不绕过拒绝。',
      '无变化的轮询保持静默。密钥、密码、Cookie 和临时 URL 不写入回执、文件或日志。',
      'Drive 上传仅记为报告；网站缓存可用与正式三端归档分别确认，archive.complete 始终为 false。']};
  if (!(request.headers.get('accept') || '').includes('text/html')) return json(protocol);
  return pdfHtml((museLegacyClosed(env) ? '<p>Muse 的下载角色已停止，领取、回执、上传接口已关闭（410 muse_retired）；读者请求、重试和上传入口不受影响。</p>' : '<p>Muse 的下载角色已停止。领取、回执、上传和读者恢复入口在过渡期仍可用，计划日期 ' + pdfEscape(protocol.deprecation.retireOn) + '（可用 MUSE_DOWNLOAD_RETIRE_ON 调整）。到这一天不会自动关闭。</p>') + '<p>当前接入：' + (protocol.enabled ? '已启用' : '尚未启用') + '。</p>'
    + '<p>维护者需在 Cloudflare Pages 的 Production 私密配置中设置 MUSE_FULLTEXT_ENABLED=true 和独立随机 Secret MUSE_FULLTEXT_KEY，并在 Muse 私密配置保存同一个密钥。GROK_FULLTEXT_ENABLED 与 FULLTEXT_ASYNC_ENABLED 保持关闭。保存后重新部署 Production，确认本页显示“已启用”。密钥不要发到聊天中。</p>'
    + '<p>把本页链接交给 Muse：先读取协议，使用已有下载流程，上传 Drive 后回传原件，等待网站核验。</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">' + pdfEscape(JSON.stringify(protocol,null,2)) + '</pre>',200,'Muse 网站接入说明');
}
function museConfig(env) {
  if (env.MUSE_FULLTEXT_ENABLED !== 'true') libraryFail('muse_disabled',503);
  if (env.GROK_FULLTEXT_ENABLED === 'true' || env.FULLTEXT_ASYNC_ENABLED === 'true') libraryFail('muse_owner_conflict',409);
  if (typeof env.MUSE_FULLTEXT_KEY !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(env.MUSE_FULLTEXT_KEY)) libraryFail('muse_not_configured',503);
  libraryConfig(env);
}
async function museAuthorize(request, env) {
  museConfig(env);
  const header = request.headers.get('authorization') || '';
  if (header.length > 140) libraryFail('muse_unauthorized',401);
  const expected = await pdfDigest('SHA-256',new TextEncoder().encode('Bearer ' + env.MUSE_FULLTEXT_KEY));
  const actual = await pdfDigest('SHA-256',new TextEncoder().encode(header));
  let difference = 0; for (let n = 0; n < 64; n++) difference |= expected.charCodeAt(n) ^ actual.charCodeAt(n);
  if (difference) libraryFail('muse_unauthorized',401);
}
function museRecord(value, doi = '') {
  if (!value || value.version !== 1 || !MUSE_UUID.test(value.id || '') || !libraryDoi(value.doi) || libraryDoi(value.doi) !== value.doi
      || (doi && value.doi !== doi) || !MUSE_STATES.includes(value.state)
      || ![value.createdAt,value.updatedAt].every(n => Number.isSafeInteger(n) && n > 0 && n < 8640000000000000 - 28800000)
      || (Object.hasOwn(value,'receivedAt') && (!Number.isSafeInteger(value.receivedAt) || value.receivedAt < 1 || value.receivedAt >= 8640000000000000 - 28800000))
      || value.queueKey !== MUSE_QUEUE_PREFIX + String(value.createdAt).padStart(13,'0') + ':' + value.id
      || (['running','uploading','verifying'].includes(value.state) && (!MUSE_UUID.test(value.leaseId || '') || !Number.isSafeInteger(value.leaseUntil) || value.leaseUntil < 1))
      || (Object.hasOwn(value,'source') && !museSourceOk(value.source))
      || (Object.hasOwn(value,'driveFileId') && (typeof value.driveFileId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(value.driveFileId)))
      || (Object.hasOwn(value,'caller') && !MACHINE_CALLER_ID.test(value.caller))
      || (Object.hasOwn(value,'claimant') && !/^(?:muse|[a-z][a-z0-9_-]{0,31})$/.test(value.claimant))
      || (Object.hasOwn(value,'stage') && !['han','yiigle'].includes(value.stage))
      || (Object.hasOwn(value,'verificationReason') && !['invalid_pdf','invalid_identity','identity_mismatch','verification_rejected'].includes(value.verificationReason))
      || (['uploading','verifying'].includes(value.state) && (!/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isInteger(value.bytes) || value.bytes < 51200 || value.bytes > LIBRARY_MAX_PDF_BYTES || (!value.source && !/^[A-Za-z0-9_-]{10,200}$/.test(value.driveFileId || ''))))
      || (value.state === 'verifying' && value.candidateKey !== 'library:muse-candidate:' + value.sha256)) return null;
  return value;
}
function museNextVerificationAt(now = Date.now()) {
  // GitHub's hourly :23 schedule is a planned time, not an execution deadline.
  const hour = 3600000, scheduled = Math.floor(now / hour) * hour + 23 * 60000;
  return new Date(scheduled > now ? scheduled : scheduled + hour).toISOString();
}
// An immediate dispatch normally verifies within a few minutes; after ten minutes the candidate is treated as
// waiting for the hourly schedule, which GitHub often runs hours late.
const MUSE_INSTANT_REVIEW_MS = 180000, MUSE_INSTANT_GIVE_UP_MS = 600000;
function museVerificationInstant(job) {
  return museReviewInstant && Date.now() - (job.receivedAt || job.updatedAt) < MUSE_INSTANT_GIVE_UP_MS;
}
function musePublicJob(value, doi = '') {
  const job = museRecord(value,doi); if (!job) return null;
  const expired = museExpired(job);
  const kept = ['lease_expired','queue_expired','agent_failed','not_oa','han_login','han_quota','source_blocked','wrong_paper','other','invalid_pdf','invalid_identity','identity_mismatch','verification_rejected'];
  const reason = expired ? job.state === 'queued' ? 'queue_expired' : 'lease_expired'
    : job.state === 'login_required' ? 'login_required'
    : job.state === 'review' ? (kept.includes(job.verificationReason) ? job.verificationReason : 'verification_rejected')
    : job.state === 'failed' ? (kept.includes(job.reason) ? job.reason : job.leaseUntil <= Date.now() ? 'lease_expired' : 'agent_failed') : '';
  const state = expired || job.state === 'login_required' ? 'manual_needed' : job.state === 'uploading' ? 'running' : job.state === 'verifying' ? 'pending' : job.state;
  const stage = expired ? 'failed' : job.state;
  const planned = job.state === 'verifying' ? museNextVerificationAt(job.receivedAt || job.updatedAt) : '';
  const verificationDelayed = !!planned && Date.parse(planned) <= Date.now();
  const messages = {queued:'已在下载队列中，等待领取；领取时间取决于下载端的运行安排，不保证即时。手里已有 PDF 可以直接上传。',running:'已领取，正在获取全文。',uploading:'Drive 已报告上传，正在向网站回传 PDF。',verifying:job.source === 'reader_upload' ? '已收到你上传的 PDF，等待网站核验 DOI、题名与全部页面。' : job.source === 'open_access' ? '已从开放获取来源取得 PDF，等待网站核验 DOI、题名与全部页面。' : 'PDF 已收到，等待网站核验 DOI、题名与全部页面。',
    login_required:'汉堡会话需要重新登录，请维护者在原授权浏览器中处理。',available:'全文已核验，可下载。',review:'PDF 核验未通过，需维护者核查。',failed:'下载未完成，任务已停止，等待维护者确认。',abandoned:'已确认不再获取这篇全文。'};
  const reasons = {lease_expired:'领取凭据已过期，任务已停止；需维护者检查原任务与已下载文件，不会自动重复下载。',
    queue_expired:'任务排队过久仍未被领取，已停止。可以直接上传 PDF，或用全文口令重新排队。'};
  return {id:job.id,doi:job.doi,state,stage,attempts:0,createdAt:new Date(job.createdAt).toISOString(),updatedAt:new Date(job.updatedAt).toISOString(),
    message:reasons[reason] || (verificationDelayed ? 'PDF 已收到，计划核验时间已到，核验尚未完成；实际执行以 GitHub 队列为准。' : messages[job.state]), ...(reason ? {reason} : {}),
    ...(job.state === 'verifying' ? {nextVerificationAt:planned,verificationDelayed,verificationSchedule:'每小时第 23 分钟；GitHub 队列可能延迟。',
      verificationMode:museVerificationInstant(job) ? 'immediate' : 'hourly',
      ...(museVerificationInstant(job) ? {verificationExpectedAt:new Date((job.receivedAt || job.updatedAt) + MUSE_INSTANT_REVIEW_MS).toISOString()} : {})} : {}),
    sourceKind:job.source === 'reader_upload' ? 'reader_upload' : job.source === 'open_access' ? 'open_access' : 'download',
    ...(['queued','running','pending'].includes(state) ? {nextCheckSeconds:60} : {})};
}
async function musePublicJobValue(env, doi) {
  return musePublicJob(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + doi),doi);
}
function museTerminalRecord(job) {
  return job.state === 'available' || job.state === 'abandoned';
}
async function musePut(env, job, options = {}) {
  // Done and confirmed-abandoned stay in KV until deleted. Other states keep the 7-day TTL.
  await libraryPut(env.QL_KV,MUSE_JOB_PREFIX + job.doi,JSON.stringify(job),museTerminalRecord(job) ? undefined : {expirationTtl:604800});
  libraryCatalogCache.clear();
  // Keep the machine candidate index in step with every state change. A caller that writes many tasks passes
  // indexChanges and applies them once with museIndexApply.
  const change = {doi:job.doi,entry:museIndexEntry(job)};
  if (Array.isArray(options.indexChanges)) options.indexChanges.push(change);
  else await museIndexApply(env,[change]);
}
function museExpired(job) {
  // A queued request may wait six days; an acquisition's 24 hours start when Muse claims it.
  const now = Date.now();
  return job.state === 'queued' ? now - job.createdAt >= MUSE_QUEUE_MS
    : ['running','uploading'].includes(job.state) && (now - (job.acquisitionStartedAt || job.createdAt) >= 86400000 || job.leaseUntil <= now);
}
function museRecoverable(job) {
  return job && (job.state === 'failed' || museExpired(job));
}
function museResponse(request, job, paper) {
  const publicJob = musePublicJob(job), statusUrl = '/api/muse/request?doi=' + encodeURIComponent(job.doi);
  const archive = {...libraryArchiveStatus(),executionClaimed:job.state !== 'queued',sides:{github:'pending',drive:job.driveFileId ? 'reported' : 'pending',mac:'pending'}};
  if (!(request.headers.get('accept') || '').includes('text/html')) return json({ok:true,status:publicJob.state,job:publicJob,...(paper ? {paper:libraryObservedPaper(paper,null,publicJob)} : {}),archive,statusUrl,
    ...(job.state === 'available' ? {downloadUrl:'/api/fulltext?doi=' + encodeURIComponent(job.doi)} : {})},job.state === 'available' ? 200 : 202);
  const view = museTaskView(job,publicJob), refreshUrl = statusUrl;
  const check = publicJob.nextCheckSeconds ? '<meta http-equiv="refresh" content="60">' : '';
  const steps = MUSE_TASK_STEPS.map((label,i) => {
    if (view.stopped && i === view.step) return '<li class="stop" aria-current="step">' + pdfEscape(view.stopLabel) + '</li>';
    const done = i < view.step || (i === view.step && job.state === 'available');
    return '<li' + (done ? ' class="done"' : '') + (!view.stopped && i === view.step ? ' aria-current="step"' : '') + '>' + pdfEscape(label) + '</li>';
  }).join('');
  const action = view.action === 'download' ? libraryDownloadForm(job.doi)
    : view.action === 'refresh' ? '<p><a class="primary" href="' + pdfEscape(refreshUrl) + '">刷新状态</a></p>'
    : view.action === 'retry' ? '<p><a class="primary" href="/api/muse/retry?doi=' + pdfEscape(encodeURIComponent(job.doi)) + '">重新获取全文</a></p>'
    : view.action === 'upload' ? '<p><a class="primary" href="/api/muse/reader-upload?doi=' + pdfEscape(encodeURIComponent(job.doi)) + '">直接上传 PDF</a></p>' : '';
  const secondary = view.secondaryUpload ? '<p class="hint">手里已有这篇的 PDF？<a href="/api/muse/reader-upload?doi=' + pdfEscape(encodeURIComponent(job.doi)) + '">直接上传</a>，不必等下载队列。</p>' : '';
  // Maintainer-only detail: hideInstitutionLinks removes this block unless the browser is in maintainer mode.
  const maintainer = HAN_BLOCK_START + '<p class="maint">维护者信息：状态 ' + pdfEscape(job.state) + (publicJob.reason ? '，原因 ' + pdfEscape(publicJob.reason) : '') + '，最近更新北京时间 '
    + new Date(job.updatedAt + 28800000).toISOString().slice(0,19).replace('T',' ') + '。</p>' + HAN_BLOCK_END;
  return pdfHtml(check + (paper?.title ? '<p class="paper-title">' + pdfEscape(paper.title) + '</p>' : '') + '<ol class="steps">' + steps + '</ol>'
    + '<p role="status" class="status"><b>' + pdfEscape(view.headline) + '</b>' + (view.eta ? '<br>' + pdfEscape(view.eta) : '') + '</p>'
    + action + secondary + maintainer
    + (job.state === 'abandoned' || job.state === 'available' ? '' : '<p class="hint">可以关闭本页，状态会保留；网页上的这篇文献显示同样的进度。' + (publicJob.nextCheckSeconds ? '本页每 60 秒只更新状态，不会重新下载。' : '') + '</p>')
    + pdfOfficialLink(job.doi),job.state === 'available' ? 200 : 202,'全文任务',job.doi);
}
const MUSE_TASK_STEPS = ['排队下载','核验中','可阅读'];
// One status description per task, shared by the task page; the website script mirrors it so the card and this page never disagree.
function museTaskView(job, publicJob) {
  const recoverable = museRecoverable(job);
  const received = job.source === 'reader_upload' ? '你上传的 PDF' : job.source === 'open_access' ? '开放获取的 PDF' : ' PDF';
  if (job.state === 'available') return {step:2,stopped:false,headline:'全文已核验，可以阅读和下载。',eta:'',action:'download'};
  if (job.state === 'abandoned') return {step:0,stopped:true,stopLabel:'未取得',headline:'已确认不再获取这篇全文。',eta:'',action:'none'};
  if (job.state === 'review') return {step:1,stopped:true,stopLabel:'未取得',headline:'已收到 PDF，但核验没有通过，不能确认它是这篇文献的原文。',eta:'可以直接上传正确的 PDF，核验通常几分钟内完成。',action:'upload'};
  if (job.state === 'login_required') return {step:0,stopped:true,stopLabel:'未取得',headline:'这次没能自动取得全文。',eta:'可以直接上传这篇的 PDF。',action:'upload'};
  if (recoverable) return {step:0,stopped:true,stopLabel:'未取得',headline:publicJob.reason === 'queue_expired' ? '排队过久仍未被领取，任务已停止。' : '这次没能取得全文。',eta:'可以重新提交，不会重复下载已取得的文件。',action:'retry',secondaryUpload:true};
  if (job.state === 'verifying') return {step:1,stopped:false,headline:'已收到' + received + '，正在核验 DOI、题名与全部页面。',
    eta:publicJob.verificationMode === 'immediate' ? '核验通常几分钟内完成。'
      : '即时核验没有赶上，正在等待下一轮核验，具体时间不固定，可能需要数小时。',action:'refresh'};
  if (job.state === 'queued') return {step:0,stopped:false,headline:'已排入下载队列，等待下载端领取。',eta:'预计数小时内，不保证即时。',action:'refresh',secondaryUpload:true};
  return {step:0,stopped:false,headline:'下载端已领取，正在获取全文。',eta:'通常几十分钟内；取得后会自动进入核验。',action:'refresh',secondaryUpload:true};
}
async function museOwnerGuard(env, doi) {
  const previous = fulltextJobRecord(await libraryGet(env.QL_KV,FULLTEXT_JOB_PREFIX + doi),doi);
  const bot = grokRecord(await libraryGet(env.QL_KV,GROK_JOB_PREFIX + doi),doi);
  if ((previous && ['queued','running'].includes(previous.state)) || (bot && !['available','failed','review'].includes(bot.state))) libraryFail('muse_owner_conflict',409);
}
async function handleMuseRetry(request, env, ctx) {
  let doi = '', release;
  try {
    const parsed = libraryQuery(request); doi = parsed.doi;
    museConfig(env);
    if (!['GET','POST'].includes(request.method)) libraryFail('muse_bad_request',405);
    if (request.method === 'POST') await libraryAuthorize(request,env,parsed.url);
    const existing = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + doi),doi);
    const record = await libraryGet(env.QL_KV,LIBRARY_PREFIX + doi), paper = libraryPaper(record,doi);
    if (paper?.fulltextStatus === 'available') return request.method === 'POST' ? libraryAcquireResult(request,env,paper,parsed.download,'',true) : libraryResult(request,paper,'',true);
    if (!existing || !paper) libraryFail('library_not_found',404);
    if (!museRecoverable(existing)) return museResponse(request,existing,paper);
    if (request.method === 'GET') return pdfHtml('<p>原任务已停止。确认没有仍在进行的下载后，把任务放回下载队列；请优先复用已下载 PDF，不会自动发起新的下载。</p><form method="post"><label>全文口令 <input name="passphrase" type="password" maxlength="256" autocomplete="current-password" required></label><button type="submit">确认重新入队</button></form>' + pdfOfficialLink(doi),200,'放回下载队列',doi);
    if (paper.fulltextStatus === 'review') libraryFail('library_identity',409);
    const attempt = await libraryGet(env.QL_KV,'library:attempt:' + doi);
    if (attempt?.paused) libraryFail('library_paused',423);
    await museOwnerGuard(env,doi);
    release = await librarySoftGate(env.QL_KV,request,doi,true);
    const current = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + doi),doi);
    if (!current) libraryFail('library_not_found',404);
    if (!museRecoverable(current)) return museResponse(request,current,paper);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),25000);
    let open = null; const oaRejected = [];
    try { const context = {signal:controller.signal}; open = await museOpenAccess(await libraryMetadata(doi,context),context,oaRejected); }
    catch { open = null; } finally { clearTimeout(timer); }
    if (open) return museResponse(request,await museIntake(env,doi,open,'open_access',current),paper);
    const now = Date.now(), id = crypto.randomUUID();
    const job = {version:1,id,doi,state:'queued',createdAt:now,updatedAt:now,queueKey:MUSE_QUEUE_PREFIX + String(now).padStart(13,'0') + ':' + id,...(oaRejected.length ? {oaRejected} : {})};
    // An orphan pointer is discarded by claim; it never resurrects the old lease.
    await libraryPut(env.QL_KV,job.queueKey,JSON.stringify({doi,id}),{expirationTtl:604800});
    await musePut(env,job);
    await museDelete(env,current.queueKey);
    downloadNotify(env,ctx,doi,id); // optional webhook notice for the new task; never blocks or fails the response
    return museResponse(request,job,paper);
  } catch (error) { return libraryError(request,error,doi,'/api/muse/retry'); }
  finally { if (release) await release(); }
}
// GitHub runs the hourly :23 schedule hours late, so a new candidate asks for a verification run
// at once. Optional and best effort: without MUSE_REVIEW_DISPATCH_TOKEN (a fine-grained token with
// only Actions write on this repository) the schedule still picks the candidate up.
async function museRequestReview(env) {
  const token = env.MUSE_REVIEW_DISPATCH_TOKEN;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(token)) return false;
  try {
    // One run verifies every waiting candidate, so a burst of uploads needs one dispatch. KV's shortest TTL is
    // 60 seconds; the dispatched run keeps claiming for about two minutes (scripts/muse_review_runner.cjs), so an
    // upload inside this window is still picked up by the run that is already coming.
    if (await env.QL_KV.get('library:muse-review-dispatch')) return false;
    await env.QL_KV.put('library:muse-review-dispatch','1',{expirationTtl:60});
  } catch { return false; }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(),5000);
  try {
    const response = await fetch('https://api.github.com/repos/dodoxiaxia/xinzhi/actions/workflows/muse-review.yml/dispatches',{method:'POST',redirect:'manual',signal:controller.signal,
      headers:{authorization:'Bearer ' + token,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'XinZhiMuseReview/1.0','x-github-api-version':'2022-11-28'},
      body:JSON.stringify({ref:'main'})});
    return response.status === 204;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// True when the Worker can ask GitHub for an immediate verification run. Set once per request by the
// router so task pages and job JSON can promise "minutes" only when that path exists.
let museReviewInstant = false;
function museReviewConfigured(env) {
  const token = env && env.MUSE_REVIEW_DISPATCH_TOKEN;
  return typeof token === 'string' && /^[A-Za-z0-9_]{20,255}$/.test(token);
}
// Bytes that did not come through Muse (reader upload, open access) enter the same private candidate
// area; the GitHub dual-parser verifier still has to confirm DOI, title and every page before download.
const MUSE_SUPERSEDED_PREFIX = 'library:muse-superseded:';
function museSupersededKey(doi, taskId) {
  return MUSE_SUPERSEDED_PREFIX + doi + ':' + taskId;
}
function museShouldSupersedePrevious(job) {
  // Each DOI has one library:muse-job:{doi} key. Any overwrite of an existing task is archived first,
  // including a failed/review/not-done job and an already done/available original replaced via
  // X-Machine-Replace (for example swapping an early publication for the official version).
  return !!(job && typeof job.id === 'string' && job.id);
}
function museSupersedeSnapshot(job) {
  // Keep the record as-is, including replace / replaceRejected. Only candidateKey is dropped:
  // it points at a temporary candidate copy that expires after seven days.
  const skip = new Set(['candidateKey']);
  const snap = {};
  for (const [key, value] of Object.entries(job)) if (!skip.has(key)) snap[key] = value;
  return snap;
}
function museSupersededFrom(snapshot) {
  if (!snapshot || typeof snapshot.id !== 'string' || !snapshot.id) return null;
  const reason = snapshot.reason || snapshot.previousReason || snapshot.verificationReason || '';
  let prior = null;
  if (snapshot.supersededFrom && typeof snapshot.supersededFrom.taskId === 'string' && snapshot.supersededFrom.taskId && snapshot.supersededFrom.taskId !== snapshot.id) {
    prior = snapshot.supersededFrom;
  } else if (snapshot.supersedes && snapshot.supersedes.id && snapshot.supersedes.id !== snapshot.id) {
    prior = museSupersededFrom(snapshot.supersedes);
  }
  return {taskId:snapshot.id,...(reason ? {reason} : {}),...(snapshot.state ? {previousState:snapshot.state} : {}),...(prior ? {supersedes:prior} : {})};
}
async function museArchiveSuperseded(env, previous, newId, doi, now) {
  if (!previous || !newId || !doi || previous.id === newId) return null;
  const snapshot = museSupersedeSnapshot(previous);
  const pointer = museSupersededFrom(snapshot);
  if (!pointer) return null;
  const record = {...snapshot,supersededBy:newId,supersededAt:now};
  await libraryPut(env.QL_KV, museSupersededKey(doi, snapshot.id), JSON.stringify(record));
  return pointer;
}

async function museIntake(env, doi, bytes, source, previous, extra = {}) {
  if (bytes.length < 51200 || bytes.length > LIBRARY_MAX_PDF_BYTES) libraryFail('muse_bad_pdf',413);
  try { libraryValidatePdf(bytes); } catch { libraryFail('muse_bad_pdf',415); }
  const sha256 = await pdfDigest('SHA-256',bytes), candidateKey = 'library:muse-candidate:' + sha256;
  await libraryPut(env.QL_KV,candidateKey,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset + bytes.byteLength),{expirationTtl:604800});
  let stored; try { stored = await env.QL_KV.get(candidateKey,'arrayBuffer'); } catch { libraryFail('library_storage',503); }
  if (!stored) libraryFail('muse_sync_pending',503);
  if (await pdfDigest('SHA-256',new Uint8Array(stored)) !== sha256) libraryFail('library_integrity',502);
  const now = Date.now(), id = crypto.randomUUID(), callerName = machineCallerSource(source) ? source : '';
  // Keep the claim identity and start time on the new verifying/done record so duration can be read later.
  const inherited = {};
  if (previous && typeof previous.claimant === 'string' && previous.claimant) inherited.claimant = previous.claimant;
  if (previous && Number.isSafeInteger(previous.acquisitionStartedAt) && previous.acquisitionStartedAt > 0) inherited.acquisitionStartedAt = previous.acquisitionStartedAt;
  if (previous && previous.registration) inherited.registration = previous.registration;
  if (previous && Number.isInteger(previous.softFailCount) && previous.softFailCount > 0) inherited.softFailCount = previous.softFailCount;
  if (previous && previous.lastSoftFailReason) inherited.lastSoftFailReason = previous.lastSoftFailReason;
  if (previous && Number.isInteger(previous.returnCount) && previous.returnCount > 0) inherited.returnCount = previous.returnCount;
  if (previous && Number.isInteger(previous.oaVerificationFails) && previous.oaVerificationFails > 0) inherited.oaVerificationFails = previous.oaVerificationFails;
  if (previous && Array.isArray(previous.oaRejected) && previous.oaRejected.length) inherited.oaRejected = previous.oaRejected;
  // Archive the old same-DOI record before overwriting library:muse-job:{doi}, so the previous task is
  // not lost if this new one is still verifying or later fails review.
  if (previous && museShouldSupersedePrevious(previous)) {
    const pointer = await museArchiveSuperseded(env, previous, id, doi, now);
    if (pointer) inherited.supersededFrom = pointer;
  }
  const job = {version:1,id,doi,state:'verifying',source,createdAt:now,updatedAt:now,receivedAt:now,queueKey:MUSE_QUEUE_PREFIX + String(now).padStart(13,'0') + ':' + id,
    leaseId:crypto.randomUUID(),leaseUntil:now,sha256,bytes:bytes.length,candidateKey,...(callerName ? {caller:callerName} : {}),...inherited,...extra};
  await musePut(env,job);
  await libraryPut(env.QL_KV,MUSE_REVIEW_PREFIX + id,JSON.stringify({doi,id}),{expirationTtl:604800});
  if (previous) await museDelete(env,previous.queueKey);
  await museRequestReview(env);
  return job;
}
