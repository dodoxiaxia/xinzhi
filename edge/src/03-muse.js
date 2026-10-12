// ==== edge/src/03-muse.js · Muse full-text queue ====
// Muse polls its own inbox; raw originals remain private until an independent
// GitHub-hosted verifier parses/renders every page and confirms DOI/title.
const MUSE_JOB_PREFIX = 'library:muse-job:';
const MUSE_QUEUE_PREFIX = 'library:muse-queue:';
const MUSE_REVIEW_PREFIX = 'library:muse-review:';
const MUSE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MUSE_STATES = ['queued','running','uploading','verifying','login_required','available','review','failed'];
const MUSE_LEASE_MS = 1200000;
// Muse has no fixed polling schedule, so an unclaimed request waits almost the whole job lifetime
// (KV TTL 7 days) instead of dying after one day nobody ran Muse.
const MUSE_QUEUE_MS = 6 * 86400000;
const MUSE_SOURCES = ['reader_upload','open_access'];
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
    instructions:['使用现有 Muse 下载流程与领取账本，已有原件直接复用；只使用 sources 列出的来源。',
      '上传私有 Drive 文献收件箱后，回传同一 PDF 的 SHA256、字节数及 Drive 文件 ID，再上传原二进制；不改动 PDF。',
      'uploaded 回执不是网站核验成功；网站独立双解析器核验任务每小时第 23 分钟处理，实际排队可能延迟。',
      '需要汉堡登录时回传 login_required，维护者在原授权浏览器处理后，用原任务回传 running 恢复。',
      '重复回传复用原任务；超时或进度不明不另建任务、不再次下载。401/403/409/413/415 停止并通知维护者，不绕过拒绝。',
      '无变化的轮询保持静默。密钥、密码、Cookie 和临时 URL 不写入回执、文件或日志。',
      'Drive 上传仅记为报告；网站缓存可用与正式三端归档分别确认，archive.complete 始终为 false。']};
  if (!(request.headers.get('accept') || '').includes('text/html')) return json(protocol);
  return pdfHtml('<p>Muse 可以按下方协议建立一个定时任务，每 10 分钟领取一次，最多三篇、串行处理。当前接入：' + (protocol.enabled ? '已启用' : '尚未启用') + '。</p>'
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
      || (Object.hasOwn(value,'source') && !MUSE_SOURCES.includes(value.source)) || (value.source && Object.hasOwn(value,'driveFileId'))
      || (['uploading','verifying'].includes(value.state) && (!/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isInteger(value.bytes) || value.bytes < 51200 || value.bytes > LIBRARY_MAX_PDF_BYTES || (!value.source && !/^[A-Za-z0-9_-]{10,200}$/.test(value.driveFileId || ''))))
      || (value.state === 'verifying' && value.candidateKey !== 'library:muse-candidate:' + value.sha256)) return null;
  return value;
}
function museNextVerificationAt(now = Date.now()) {
  // GitHub's hourly :23 schedule is a planned time, not an execution deadline.
  const hour = 3600000, scheduled = Math.floor(now / hour) * hour + 23 * 60000;
  return new Date(scheduled > now ? scheduled : scheduled + hour).toISOString();
}
function musePublicJob(value, doi = '') {
  const job = museRecord(value,doi); if (!job) return null;
  const expired = museExpired(job);
  const reason = expired ? job.state === 'queued' ? 'queue_expired' : 'lease_expired'
    : job.state === 'login_required' ? 'login_required' : job.state === 'review' ? 'verification_rejected'
    : job.state === 'failed' ? ['lease_expired','queue_expired','agent_failed'].includes(job.reason) ? job.reason : job.leaseUntil <= Date.now() ? 'lease_expired' : 'agent_failed' : '';
  const state = expired || job.state === 'login_required' ? 'manual_needed' : job.state === 'uploading' ? 'running' : job.state === 'verifying' ? 'pending' : job.state;
  const stage = expired ? 'failed' : job.state;
  const planned = job.state === 'verifying' ? museNextVerificationAt(job.receivedAt || job.updatedAt) : '';
  const verificationDelayed = !!planned && Date.parse(planned) <= Date.now();
  const messages = {queued:'已加入 Muse 待办，等待 Muse 领取；领取时间取决于 Muse 的运行安排，不保证即时。手里已有 PDF 可以直接上传，不必等 Muse。',running:'Muse 已领取，正在获取全文。',uploading:'Drive 已报告上传，正在向网站回传 PDF。',verifying:job.source === 'reader_upload' ? '已收到你上传的 PDF，等待网站核验 DOI、题名与全部页面。' : job.source === 'open_access' ? '已从开放获取来源取得 PDF，等待网站核验 DOI、题名与全部页面。' : 'PDF 已收到，等待网站核验 DOI、题名与全部页面。',
    login_required:'汉堡会话需要重新登录，请维护者在 Muse 的授权浏览器中处理。',available:'全文已核验，可下载。',review:'PDF 核验未通过，需维护者核查。',failed:'Muse 报告任务失败，需维护者核查。'};
  const reasons = {lease_expired:'Muse 领取凭据已过期，任务已停止；需维护者检查原任务与已下载文件，不会自动重复下载。',
    queue_expired:'任务排队过久仍未被 Muse 领取，已停止。可以直接上传 PDF，或用全文口令重新排队。'};
  return {id:job.id,doi:job.doi,state,stage,attempts:0,createdAt:new Date(job.createdAt).toISOString(),updatedAt:new Date(job.updatedAt).toISOString(),
    message:reasons[reason] || (verificationDelayed ? 'PDF 已收到，计划核验时间已到，核验尚未完成；实际执行以 GitHub 队列为准。' : messages[job.state]), ...(reason ? {reason} : {}),
    ...(job.state === 'verifying' ? {nextVerificationAt:planned,verificationDelayed,verificationSchedule:'每小时第 23 分钟；GitHub 队列可能延迟。'} : {}),
    ...(['queued','running','pending'].includes(state) ? {nextCheckSeconds:60} : {})};
}
async function musePublicJobValue(env, doi) {
  return musePublicJob(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + doi),doi);
}
async function musePut(env, job) {
  await libraryPut(env.QL_KV,MUSE_JOB_PREFIX + job.doi,JSON.stringify(job),{expirationTtl:604800});
  libraryCatalogCache.clear();
}
function museExpired(job) {
  const age = Date.now() - job.createdAt;
  return job.state === 'queued' ? age >= MUSE_QUEUE_MS : ['running','uploading'].includes(job.state) && (age >= 86400000 || job.leaseUntil <= Date.now());
}
function museRecoverable(job) {
  return job && (job.state === 'failed' || museExpired(job));
}
function museResponse(request, job, paper) {
  const publicJob = musePublicJob(job), statusUrl = '/api/muse/request?doi=' + encodeURIComponent(job.doi);
  const archive = {...libraryArchiveStatus(),executionClaimed:job.state !== 'queued',sides:{github:'pending',drive:job.driveFileId ? 'reported' : 'pending',mac:'pending'}};
  if (!(request.headers.get('accept') || '').includes('text/html')) return json({ok:true,status:publicJob.state,job:publicJob,...(paper ? {paper:libraryObservedPaper(paper,null,publicJob)} : {}),archive,statusUrl,
    ...(job.state === 'available' ? {downloadUrl:'/api/fulltext?doi=' + encodeURIComponent(job.doi)} : {})},job.state === 'available' ? 200 : 202);
  const check = publicJob.nextCheckSeconds ? '<meta http-equiv="refresh" content="60"><p>本页每 60 秒只更新状态，不会重新下载。</p>' : '';
  // Reader uploads and open-access copies skip Muse entirely, so they show the shorter path they actually took.
  const stages = job.source ? [['queued','提交请求'],['verifying',(job.source === 'reader_upload' ? '已收到上传的 PDF' : '已取得开放获取 PDF') + '，等待网站核验'],['available','核验通过，可下载']]
    : [['queued','待 Muse 领取'],['running','Muse 已领取，正在获取全文'],['uploading','原件已上传私有收件箱'],['verifying','网站已收到 PDF，等待核验'],['available','核验通过，可下载']];
  // Infer how far a stopped task got from the evidence it carries, so the list never shows no step at all.
  const reached = job.source ? job.state === 'available' ? 2 : job.state === 'review' || job.candidateKey ? 1 : 0
    : job.state === 'available' ? 4 : job.state === 'review' || job.candidateKey ? 3 : job.driveFileId ? 2 : job.leaseId ? 1 : 0;
  const index = stages.findIndex(([stage]) => stage === publicJob.stage);
  const stopped = index < 0 || publicJob.stage === 'failed';
  const stopLabels = {review:'PDF 核验未通过，等待维护者核查',login_required:'汉堡会话需重新登录（维护者处理）',failed:'任务已停止，等待维护者确认'};
  const current = stopped ? reached : index;
  const progress = '<ol class="steps">' + stages.map(([,label],i) => {
    if (stopped && i === current) return '<li class="stop" aria-current="step">' + pdfEscape(stopLabels[job.state === 'login_required' ? 'login_required' : job.state === 'review' ? 'review' : 'failed']) + '（当前）</li>';
    return '<li' + (i < current || (i === current && job.state === 'available') ? ' class="done"' : '') + (!stopped && i === current ? ' aria-current="step"' : '') + '>' + pdfEscape(label) + (i < current || (i === current && job.state === 'available') ? '（已完成）' : i === current ? '（当前）' : '') + '</li>';
  }).join('') + '</ol>';
  const planned = publicJob.nextVerificationAt ? '<p>本批原件计划核验：北京时间 ' + new Date(Date.parse(publicJob.nextVerificationAt) + 28800000).toISOString().slice(0,19).replace('T',' ') + '。GitHub 队列可能延迟；等待期间不会重复下载。</p>' : '';
  const next = job.state === 'available' ? ''
    : museRecoverable(job) ? '<p class="next">无需重复提交。确认 Muse 没有仍在运行的下载后，可用全文口令<a href="/api/muse/retry?doi=' + pdfEscape(encodeURIComponent(job.doi)) + '">恢复这个任务</a>；会优先复用已下载文件。</p>'
    : ['review','login_required'].includes(job.state) ? '<p class="next">无需重复提交。维护者处理后，本页和网站上的状态会更新。</p>'
    : '<p class="next">可以关闭本页。之后回到网站搜索这个 DOI 即可看到最新状态；可下载时，文献卡片会出现“下载 PDF”。</p>';
  const upload = ['queued','review','login_required'].includes(job.state) || museRecoverable(job) ? museUploadLink(job.doi) : '';
  return pdfHtml(check + '<p role="status">' + pdfEscape(publicJob.message) + '</p>' + (paper?.title ? '<p>' + pdfEscape(paper.title) + '</p>' : '') + progress + '<p>最近更新：北京时间 ' + new Date(job.updatedAt + 28800000).toISOString().slice(0,19).replace('T',' ') + '</p>' + planned + next + upload
    + (job.state === 'available' ? libraryDownloadForm(job.doi) : '')
    + pdfOfficialLink(job.doi),job.state === 'available' ? 200 : 202,'Muse 全文任务',job.doi);
}
function museUploadLink(doi) {
  return '<p>已经拿到这篇的 PDF（开放获取，或汉堡登录后下载）？<a href="/api/muse/reader-upload?doi=' + pdfEscape(encodeURIComponent(doi)) + '">直接上传 PDF</a>，不必等 Muse；网站核验 DOI、题名与全部页面后即可下载。</p>';
}
async function museOwnerGuard(env, doi) {
  const previous = fulltextJobRecord(await libraryGet(env.QL_KV,FULLTEXT_JOB_PREFIX + doi),doi);
  const bot = grokRecord(await libraryGet(env.QL_KV,GROK_JOB_PREFIX + doi),doi);
  if ((previous && ['queued','running'].includes(previous.state)) || (bot && !['available','failed','review'].includes(bot.state))) libraryFail('muse_owner_conflict',409);
}
async function handleMuseRetry(request, env) {
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
    if (request.method === 'GET') return pdfHtml('<p>原任务已停止。确认 Muse 没有仍在运行的下载，再重新入队；请优先复用已下载 PDF，不会自动发起新的下载。</p><form method="post"><label>全文口令 <input name="passphrase" type="password" maxlength="256" autocomplete="current-password" required></label><button type="submit">确认重新入队</button></form>' + pdfOfficialLink(doi),200,'恢复 Muse 全文任务',doi);
    if (paper.fulltextStatus === 'review') libraryFail('library_identity',409);
    const attempt = await libraryGet(env.QL_KV,'library:attempt:' + doi);
    if (attempt?.paused) libraryFail('library_paused',423);
    await museOwnerGuard(env,doi);
    release = await librarySoftGate(env.QL_KV,request,doi,true);
    const current = museRecord(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + doi),doi);
    if (!current) libraryFail('library_not_found',404);
    if (!museRecoverable(current)) return museResponse(request,current,paper);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),25000);
    let open = null;
    try { const context = {signal:controller.signal}; open = await museOpenAccess(await libraryMetadata(doi,context),context); }
    catch { open = null; } finally { clearTimeout(timer); }
    if (open) return museResponse(request,await museIntake(env,doi,open,'open_access',current),paper);
    const now = Date.now(), id = crypto.randomUUID();
    const job = {version:1,id,doi,state:'queued',createdAt:now,updatedAt:now,queueKey:MUSE_QUEUE_PREFIX + String(now).padStart(13,'0') + ':' + id};
    // An orphan pointer is discarded by claim; it never resurrects the old lease.
    await libraryPut(env.QL_KV,job.queueKey,JSON.stringify({doi,id}),{expirationTtl:604800});
    await musePut(env,job);
    await museDelete(env,current.queueKey);
    return museResponse(request,job,paper);
  } catch (error) { return libraryError(request,error,doi,'/api/muse/retry'); }
  finally { if (release) await release(); }
}
// Bytes that did not come through Muse (reader upload, open access) enter the same private candidate
// area; the GitHub dual-parser verifier still has to confirm DOI, title and every page before download.
async function museIntake(env, doi, bytes, source, previous) {
  if (bytes.length < 51200 || bytes.length > LIBRARY_MAX_PDF_BYTES) libraryFail('muse_bad_pdf',413);
  try { libraryValidatePdf(bytes); } catch { libraryFail('muse_bad_pdf',415); }
  const sha256 = await pdfDigest('SHA-256',bytes), candidateKey = 'library:muse-candidate:' + sha256;
  await libraryPut(env.QL_KV,candidateKey,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset + bytes.byteLength),{expirationTtl:604800});
  let stored; try { stored = await env.QL_KV.get(candidateKey,'arrayBuffer'); } catch { libraryFail('library_storage',503); }
  if (!stored) libraryFail('muse_sync_pending',503);
  if (await pdfDigest('SHA-256',new Uint8Array(stored)) !== sha256) libraryFail('library_integrity',502);
  const now = Date.now(), id = crypto.randomUUID();
  const job = {version:1,id,doi,state:'verifying',source,createdAt:now,updatedAt:now,receivedAt:now,queueKey:MUSE_QUEUE_PREFIX + String(now).padStart(13,'0') + ':' + id,
    leaseId:crypto.randomUUID(),leaseUntil:now,sha256,bytes:bytes.length,candidateKey};
  await musePut(env,job);
  await libraryPut(env.QL_KV,MUSE_REVIEW_PREFIX + id,JSON.stringify({doi,id}),{expirationTtl:604800});
  if (previous) await museDelete(env,previous.queueKey);
  return job;
}
