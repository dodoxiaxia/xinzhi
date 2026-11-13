// ==== edge/src/04b-machine-download.js · Per-caller download queue ====
// Machine callers (a downloader, a fallback bot, a read-only caller) use their own tokens.
// They never enter the human daily gate. Legacy Muse claim/receipt/upload/retry stay as they are.
const MACHINE_FAILURE_REASONS = ['not_oa','han_login','han_quota','source_blocked','wrong_paper','other'];
const MACHINE_SOFT_RETRY_REASONS = ['lease_expired','source_blocked'];
const MACHINE_SOFT_RETRY_LIMIT = 2;
const MACHINE_LEASE_EXTEND_MS = MUSE_LEASE_MS;
const MACHINE_LEASE_MAX_MS = 7200000;
const MACHINE_RETURN_LIMIT = 3;
const MACHINE_VERIFICATION_REASONS = ['invalid_pdf','invalid_identity','identity_mismatch','verification_rejected'];
const MACHINE_PUBLIC_STATES = ['to-download','downloading','uploaded-awaiting-verification','done','failed-awaiting-fallback','confirmed-abandoned'];
const MACHINE_STAGE_TAGS = ['han','yiigle'];
const MACHINE_STATUS_DETAIL_MAX = 500;
const MACHINE_STATUS_DETAILS = ['just_accepted'];
const MACHINE_ROLE_CAPS = {
  downloader:['upload','replace','status','claim','renew','return','list','requeue','register','abandoned','protocol'],
  fallback:['upload','replace','status','abandon','claim','renew','return','list','abandoned','protocol'],
  reader:['list','abandoned','protocol']
};
const MACHINE_UPLOAD_DAILY_DEFAULT = 80;
const MACHINE_IDENTITY_REASONS = ['doi_invalid','title_too_short','page_tree_not_found','contents_not_found','objstm_unsupported','inflate_failed','filter_unsupported','page_text_empty','doi_not_found','title_not_found','identity_mismatch'];
const MACHINE_REQUEUE_DAILY_DEFAULT = 200;
const MACHINE_REGISTER_DAILY_DEFAULT = 200;
const MACHINE_LIST_LIMIT_DEFAULT = 20;
const MACHINE_LIST_LIMIT_MAX = 50;
const MACHINE_LIST_SCAN_PAGES_MAX = 50;
const MACHINE_LIST_SCAN_PAGE_KEYS = 100;
const MACHINE_REGISTER_MAX_ITEMS = 50;
const MACHINE_REGISTER_SECTIONS = ['MAIN','CARDIO'];
const MACHINE_REGISTER_PREFIX = 'library:machine-register:';
const MACHINE_REGISTER_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A 409 from the first-page check carries an internal reason code and which checks passed. Never PDF text.
class MachineIdentityFailure extends LibraryFailure {
  constructor(code, reason, checks) { super(code, 409); this.reason = reason; this.checks = checks || null; }
}
function machineError(error) {
  const known = error instanceof LibraryFailure || error instanceof PdfFailure;
  const body = {ok:false,error:known ? error.code : 'machine_server'};
  if (error instanceof MachineIdentityFailure) { body.reason = error.reason; if (error.checks) body.checks = error.checks; }
  if (typeof error.explain === 'string' && error.explain) body.message = error.explain;
  if (error.extra && typeof error.extra === 'object') Object.assign(body, error.extra);
  const retry = known && error.retryAfter ? libraryRetryInfo(error.retryAfter) : {};
  Object.assign(body, retry);
  return json(body, known ? error.status : 500, retry.retryAfterSeconds ? {'retry-after':String(retry.retryAfterSeconds)} : {});
}
function machineFail(code, status, explain, extra) {
  const error = new LibraryFailure(code, status);
  if (explain) error.explain = explain;
  if (extra) error.extra = extra;
  throw error;
}
function machineLimit(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) libraryFail('machine_not_configured', 503);
  return value;
}
function machineTokenTable(env) {
  if (env.MACHINE_TOKENS === undefined || env.MACHINE_TOKENS === '') return [];
  if (typeof env.MACHINE_TOKENS !== 'string' || env.MACHINE_TOKENS.length > 20000) libraryFail('machine_not_configured', 503);
  let parsed;
  try { parsed = JSON.parse(env.MACHINE_TOKENS); } catch { libraryFail('machine_not_configured', 503); }
  if (!Array.isArray(parsed) || parsed.length > 20) libraryFail('machine_not_configured', 503);
  const ids = new Set(), secrets = new Set(), rows = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) libraryFail('machine_not_configured', 503);
    if (Object.keys(item).some(key => !['id','role','token','revoked'].includes(key))) libraryFail('machine_not_configured', 503);
    if (!MACHINE_CALLER_ID.test(item.id || '') || !MACHINE_ROLE_CAPS[item.role]) libraryFail('machine_not_configured', 503);
    if (typeof item.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(item.token)) libraryFail('machine_not_configured', 503);
    if (Object.hasOwn(item,'revoked') && typeof item.revoked !== 'boolean') libraryFail('machine_not_configured', 503);
    if (ids.has(item.id) || secrets.has(item.token)) libraryFail('machine_not_configured', 503);
    ids.add(item.id); secrets.add(item.token);
    rows.push({id:item.id,role:item.role,token:item.token,revoked:item.revoked === true});
  }
  return rows;
}
function machineLegacyCaller(env) {
  if (env.MACHINE_LEGACY_REVOKED === 'true') return null;
  if (typeof env.MUSE_FULLTEXT_KEY !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(env.MUSE_FULLTEXT_KEY)) return null;
  return {id:'muse',role:'downloader',token:env.MUSE_FULLTEXT_KEY,revoked:false,legacy:true};
}
async function machineAuthorize(request, env, capability) {
  libraryConfig(env);
  const header = request.headers.get('authorization') || '';
  if (header.length > 180 || !header.startsWith('Bearer ')) libraryFail('machine_unauthorized', 401);
  const actual = await pdfDigest('SHA-256', new TextEncoder().encode(header));
  const rows = machineTokenTable(env);
  let matched = null;
  for (const row of rows) {
    const expected = await pdfDigest('SHA-256', new TextEncoder().encode('Bearer ' + row.token));
    let difference = 0;
    for (let n = 0; n < 64; n++) difference |= expected.charCodeAt(n) ^ actual.charCodeAt(n);
    if (!difference) matched = row;
  }
  const legacy = machineLegacyCaller(env);
  let legacyMatch = false;
  if (legacy) {
    const expected = await pdfDigest('SHA-256', new TextEncoder().encode('Bearer ' + legacy.token));
    let difference = 0;
    for (let n = 0; n < 64; n++) difference |= expected.charCodeAt(n) ^ actual.charCodeAt(n);
    legacyMatch = !difference;
  }
  const caller = matched || (legacyMatch ? legacy : null);
  if (!caller) libraryFail('machine_unauthorized', 401);
  if (caller.revoked) libraryFail('machine_revoked', 401);
  if (!MACHINE_ROLE_CAPS[caller.role].includes(capability)) libraryFail('machine_forbidden', 403);
  return caller;
}
function machineRateKey(caller, bucket) {
  return 'library:machine-rate:' + bucket + ':' + caller.id + ':' + new Date().toISOString().slice(0, 10);
}
async function machineRemaining(env, caller, bucket, limit) {
  const count = await libraryGet(env.QL_KV, machineRateKey(caller, bucket));
  const used = Number.isInteger(count) && count >= 0 ? count : 0;
  if (used >= limit) libraryFail('machine_rate_limit', 429, Date.parse(new Date().toISOString().slice(0, 10)) + 86400000);
  return limit - used;
}
async function machineConsume(env, caller, bucket, amount) {
  if (!amount) return;
  const key = machineRateKey(caller, bucket);
  const count = await libraryGet(env.QL_KV, key);
  const used = Number.isInteger(count) && count >= 0 ? count : 0;
  await libraryPut(env.QL_KV, key, JSON.stringify(used + amount), {expirationTtl:172800});
}
// Daily observation counters share the same key pattern and 2-day TTL as the quota keys, but live in one
// JSON document per caller per UTC day so a request that bumps one field still costs one read and one write.
// Quota keys (upload/requeue/register) stay integers and are not mixed into this document.
const MACHINE_STATS_FIELDS = ['claim','emptyClaim','upload409','release'];
function machineStatsKey(caller) {
  return 'library:machine-rate:stats:' + caller.id + ':' + new Date().toISOString().slice(0, 10);
}
function machineStatsNormalize(value) {
  const doc = {version:1};
  for (const field of MACHINE_STATS_FIELDS) doc[field] = value && Number.isInteger(value[field]) && value[field] >= 0 ? value[field] : 0;
  return doc;
}
async function machineStatsBump(env, caller, field, amount = 1) {
  if (!amount || !caller || !MACHINE_STATS_FIELDS.includes(field)) return;
  const key = machineStatsKey(caller);
  const current = machineStatsNormalize(await libraryGet(env.QL_KV, key));
  current[field] += amount;
  await libraryPut(env.QL_KV, key, JSON.stringify(current), {expirationTtl:172800});
}
async function machineReadBody(request, max) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) libraryFail('muse_bad_pdf', 413);
  const reader = request.body && request.body.getReader();
  if (!reader) libraryFail('machine_bad_request', 400);
  const chunks = [];
  let size = 0;
  while (true) {
    let item;
    try { item = await reader.read(); } catch { libraryFail('machine_bad_request', 400); }
    if (item.done) break;
    size += item.value.byteLength;
    if (size > max) { pdfCancel(reader); libraryFail('muse_bad_pdf', 413); }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function machineReadUpload(request) {
  const type = request.headers.get('content-type') || '';
  if (request.method === 'PUT' && type === 'application/pdf') {
    const doi = libraryDoi(request.headers.get('x-machine-doi') || '');
    if (!doi) libraryFail('machine_bad_request', 400);
    return {doi, bytes:await machineReadBody(request, LIBRARY_MAX_PDF_BYTES)};
  }
  if (request.method === 'POST' && /^multipart\/form-data;/i.test(type)) {
    const declared = request.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > LIBRARY_MAX_PDF_BYTES + 65536)) libraryFail('muse_bad_pdf', 413);
    const body = await machineReadBody(request, LIBRARY_MAX_PDF_BYTES + 65536);
    let form;
    try { form = await new Response(body, {headers:{'content-type':type}}).formData(); } catch { libraryFail('machine_bad_request', 400); }
    if ([...form.keys()].length !== 2 || form.getAll('doi').length !== 1 || form.getAll('pdf').length !== 1) libraryFail('machine_bad_request', 400);
    const doiText = form.get('doi'), file = form.get('pdf');
    const doi = typeof doiText === 'string' ? libraryDoi(doiText) : '';
    if (!doi || !file || typeof file === 'string') libraryFail('machine_bad_request', 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > LIBRARY_MAX_PDF_BYTES) libraryFail('muse_bad_pdf', 413);
    return {doi, bytes};
  }
  libraryFail('machine_bad_request', 415);
}
function machineSoftFailCount(job) {
  return job && Number.isInteger(job.softFailCount) && job.softFailCount > 0 ? job.softFailCount : 0;
}
function machineHasHardFailureHistory(job) {
  // A task claimed out of failed-awaiting-fallback keeps previousReason (not_oa, han_login, etc.).
  // Those must not be soft-retried back to to-download when the new lease expires.
  return !!(job && typeof job.previousReason === 'string' && job.previousReason);
}
function machineWouldSoftRetry(job, reason) {
  return MACHINE_SOFT_RETRY_REASONS.includes(reason) && !machineHasHardFailureHistory(job) && machineSoftFailCount(job) + 1 < MACHINE_SOFT_RETRY_LIMIT;
}
function machinePublicState(job) {
  if (!job) return '';
  if (job.state === 'abandoned') return 'confirmed-abandoned';
  if (job.state === 'available') return 'done';
  if (job.state === 'verifying') return 'uploaded-awaiting-verification';
  // A queued task that waited six days is still a hard failure. A lease expiry is a soft retry until the second time.
  if (job.state === 'queued' && museExpired(job)) return 'failed-awaiting-fallback';
  if (['running','uploading'].includes(job.state) && museExpired(job)) {
    return machineWouldSoftRetry(job, 'lease_expired') ? 'to-download' : 'failed-awaiting-fallback';
  }
  if (job.state === 'queued') return 'to-download';
  if (job.state === 'running' || job.state === 'uploading') return 'downloading';
  return 'failed-awaiting-fallback';
}
function machineSoftRetryPlan(job, reason, now) {
  const {leaseId:_leaseId,leaseUntil:_leaseUntil,reviewOwner:_ro,reviewLeaseId:_rl,reviewLeaseUntil:_ru,stage:_stage, ...kept} = job;
  if (!machineWouldSoftRetry(job, reason)) {
    const keptReason = job.previousReason || job.reason || reason;
    const state = keptReason === 'han_login' ? 'login_required' : 'failed';
    return {queued:false,next:{...kept,state,reason:keptReason,updatedAt:now,
      ...(job.previousReason ? {previousReason:job.previousReason} : {softFailCount:machineSoftFailCount(job) + 1,lastSoftFailReason:reason})}};
  }
  const softFailCount = machineSoftFailCount(job) + 1;
  const {claimant:_c,acquisitionStartedAt:_a,reason:_reason,previousReason:_prev, ...rest} = kept;
  return {queued:true,next:{...rest,state:'queued',updatedAt:now,softFailCount,lastSoftFailReason:reason}};
}
async function machineCommitSoftRetry(env, job, reason, now, options = {}) {
  const plan = machineSoftRetryPlan(job, reason, now);
  await musePut(env, plan.next, options);
  if (plan.queued) {
    if (plan.next.queueKey) await libraryPut(env.QL_KV, plan.next.queueKey, JSON.stringify({doi:plan.next.doi,id:plan.next.id}), {expirationTtl:604800});
  } else if (job.queueKey) {
    await museDelete(env, job.queueKey);
  }
  return plan.next;
}
function machineReason(job) {
  if (MACHINE_FAILURE_REASONS.includes(job.reason)) return job.reason;
  if (MACHINE_VERIFICATION_REASONS.includes(job.verificationReason)) return job.verificationReason;
  if (MACHINE_VERIFICATION_REASONS.includes(job.reason)) return job.reason;
  if (job.state === 'login_required') return 'han_login';
  if (job.previousReason && (MACHINE_FAILURE_REASONS.includes(job.previousReason) || ['lease_expired','queue_expired','agent_failed'].includes(job.previousReason)) && ['running','uploading'].includes(job.state) && museExpired(job)) return job.previousReason;
  if (['lease_expired','queue_expired','agent_failed'].includes(job.reason)) return job.reason;
  if (museExpired(job)) return job.state === 'queued' ? 'queue_expired' : 'lease_expired';
  return '';
}
function machineStage(job) {
  if (MACHINE_STAGE_TAGS.includes(job.stage)) return job.stage;
  if (job.state === 'login_required' || job.reason === 'han_login' || job.reason === 'han_quota') return 'han';
  return '';
}
// Open-access sources the site dropped because the file was the wrong paper: only a public URL without query, and a reason code.
function machineOaRejected(job) {
  if (!Array.isArray(job.oaRejected)) return [];
  return job.oaRejected.slice(0,3).filter(item => item && typeof item.source === 'string' && typeof item.reason === 'string').map(item => ({source:item.source.slice(0,200),reason:/^[a-z_]{1,40}$/.test(item.reason) ? item.reason : 'identity_mismatch',...(typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256) ? {sha256:item.sha256} : {}),...(Number.isSafeInteger(item.at) && item.at > 0 ? {at:new Date(item.at).toISOString()} : {})}));
}
function machineClaimable(job) {
  // Only the task record already in hand: review (verification failed) cannot be claimed or requeued.
  // Do not read the paper record here; that would add a KV get on every list item.
  return !job || job.state !== 'review';
}
function machineListItem(job) {
  const registration = job.registration && typeof job.registration === 'object' ? job.registration : null;
  const state = machinePublicState(job);
  const claimable = machineClaimable(job);
  // A failure reason belongs to failed states only. A claimed or queued task must not show the failure it came from.
  const claimedAt = Number.isSafeInteger(job.acquisitionStartedAt) && job.acquisitionStartedAt > 0 ? job.acquisitionStartedAt : 0;
  const receivedAt = Number.isSafeInteger(job.receivedAt) && job.receivedAt > 0 ? job.receivedAt : 0;
  return {doi:job.doi,state,reason:state === 'failed-awaiting-fallback' || state === 'confirmed-abandoned' ? machineReason(job) : '',stage:machineStage(job),
    claimant:typeof job.claimant === 'string' ? job.claimant : '',updatedAt:new Date(job.updatedAt).toISOString(),taskId:job.id,claimable,
    ...(claimable ? {} : {unclaimableReason:'verification_failed'}),
    ...(claimedAt ? {claimedAt:new Date(claimedAt).toISOString()} : {}),
    ...(claimedAt && receivedAt && receivedAt >= claimedAt ? {claimDurationSeconds:Math.round((receivedAt - claimedAt) / 1000)} : {}),
    ...(job.supersededFrom && typeof job.supersededFrom.taskId === 'string' && job.supersededFrom.taskId ? {supersededFrom:job.supersededFrom} : {}),
    ...(Number.isInteger(job.returnCount) && job.returnCount > 0 ? {returnCount:job.returnCount} : {}),
    ...(machineOaRejected(job).length ? {oaRejected:machineOaRejected(job)} : {}),
    ...(registration && MACHINE_REGISTER_SOURCE.test(registration.source || '') && MACHINE_REGISTER_SECTIONS.includes(registration.section)
      ? {registeredSource:registration.source,section:registration.section} : {}),
    ...((state === 'failed-awaiting-fallback' || state === 'confirmed-abandoned') && job.detail === 'just_accepted' ? {detail:job.detail} : {})};
}
function machineUploadDecision(job, paper, sha256, caller) {
  if ((paper && paper.fulltextStatus === 'available') || (job && job.state === 'available')) return {type:'done'};
  if (job && job.state === 'abandoned') return {type:'closed'};
  if (job && job.state === 'verifying') return job.sha256 === sha256 ? {type:'replay',job} : {type:'conflict'};
  if (job && ['running','uploading'].includes(job.state) && !museExpired(job) && job.claimant && job.claimant !== caller.id) return {type:'busy'};
  return {type:'accept'};
}
function machineReplacePublic(replace) {
  return {by:replace.by,at:new Date(replace.at).toISOString(),oldSha256:replace.oldSha256,newSha256:replace.newSha256};
}
function machineMayReplace(caller) {
  // New path: only a MACHINE_TOKENS caller of role downloader or fallback, never the legacy shared Muse key.
  return !caller.legacy && ['downloader','fallback'].includes(caller.role) && MACHINE_ROLE_CAPS[caller.role].includes('replace');
}
function machineReplaceDecision(job, paper, record, sha256, caller) {
  if (job && job.state === 'verifying' && job.replace && job.sha256 === sha256) return {type:'replay',job};
  if (!paper || paper.fulltextStatus !== 'available' || !record || !record.pdf || !/^[a-f0-9]{64}$/.test(record.pdf.sha256 || '')) return {type:'unneeded'};
  if (record.pdf.sha256 === sha256) return {type:'same'};
  if (job && job.state === 'abandoned') return {type:'closed'};
  if (job && job.state === 'verifying') return {type:'conflict'};
  const now = Date.now();
  if (job && ((['running','uploading'].includes(job.state) && !museExpired(job) && job.claimant !== caller.id) || job.reviewLeaseUntil > now)) return {type:'busy'};
  return {type:'accept',oldSha:record.pdf.sha256};
}
// A verified replacement overwrites the stored original; the old blob key stays in KV and the Drive archive keeps the old sha.
async function machineReplacePdf(kv, record, bytes, source) {
  const paper = libraryPaper(record, record.paper.doi), checksum = await pdfDigest('SHA-256', bytes), blobKey = 'library:pdf:' + checksum;
  await libraryPut(kv, blobKey, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  pdfArchiveQueueBytes(checksum, bytes); // optional R2 copy, written after the response; off unless bound and switched on
  await libraryPut(kv, DRIVE_PENDING_PREFIX + checksum, JSON.stringify({doi:paper.doi}));
  await libraryPut(kv, LIBRARY_PREFIX + paper.doi, JSON.stringify({version:1, paper:{...paper,fulltextStatus:'available'}, pdf:{key:blobKey,sha256:checksum,size:bytes.length,source,replacedSha256:record.pdf.sha256}}));
  libraryCatalogCache.clear();
}
function handleMachineProtocol(request, env) {
  if (request.method !== 'GET' || new URL(request.url).search) return json({ok:false,error:'machine_bad_request'}, 405);
  let configured = false;
  try {
    const legacy = machineLegacyCaller(env);
    configured = machineTokenTable(env).some(row => !row.revoked) || !!legacy;
  } catch { configured = false; }
  return json({ok:true,schemaVersion:1,configured,website:'https://learn.dryz.info',
    auth:{header:'Authorization',scheme:'Bearer',secret:'MACHINE_TOKENS',legacySecret:'MUSE_FULLTEXT_KEY',legacyRevoke:'MACHINE_LEGACY_REVOKED'},
    humanGate:'exempt',
    states:MACHINE_PUBLIC_STATES,
    stateMap:{queued:'to-download',running:'downloading',uploading:'downloading',verifying:'uploaded-awaiting-verification',available:'done',failed:'failed-awaiting-fallback',login_required:'failed-awaiting-fallback',review:'failed-awaiting-fallback',abandoned:'confirmed-abandoned'},
    failureReasons:MACHINE_FAILURE_REASONS,verificationReasons:MACHINE_VERIFICATION_REASONS,stageTags:MACHINE_STAGE_TAGS,
    limits:{uploadDailyDefault:MACHINE_UPLOAD_DAILY_DEFAULT,uploadDailyEnv:'MACHINE_UPLOAD_DAILY_LIMIT',requeueDailyDefault:MACHINE_REQUEUE_DAILY_DEFAULT,requeueDailyEnv:'MACHINE_REQUEUE_DAILY_LIMIT',requeuePerCall:50,emptyClaimRetrySeconds:MACHINE_EMPTY_CLAIM_RETRY_SECONDS,claimScanMax:MACHINE_CLAIM_SCAN_MAX,claimScanLimitRetrySeconds:MACHINE_CLAIM_SCAN_LIMIT_RETRY_SECONDS,
      registerDailyDefault:MACHINE_REGISTER_DAILY_DEFAULT,registerDailyEnv:'MACHINE_REGISTER_DAILY_LIMIT',registerMaxItems:MACHINE_REGISTER_MAX_ITEMS,listLimitDefault:MACHINE_LIST_LIMIT_DEFAULT,listLimitMax:MACHINE_LIST_LIMIT_MAX,listScanPagesMax:MACHINE_LIST_SCAN_PAGES_MAX,listScanPageKeys:MACHINE_LIST_SCAN_PAGE_KEYS},
    emptyClaimRetry:{bodyField:'retryAfter',legacyBodyField:'retryAfterSeconds',header:'Retry-After',emptyQueueSeconds:MACHINE_EMPTY_CLAIM_RETRY_SECONDS,scanLimitSeconds:MACHINE_CLAIM_SCAN_LIMIT_RETRY_SECONDS,indexBuildingSeconds:MACHINE_INDEX_BUILDING_RETRY_SECONDS,note:'空领取（task 为 null）时，响应体同时带 retryAfter 与 retryAfterSeconds，单位都是秒，与 Retry-After 响应头相同。现有客户端若读不到响应头，请读 retryAfter。队列真空 300 秒，claim_scan_limit 与索引回填中各 60 秒。'},
    stats:{keyPattern:'library:machine-rate:stats:<caller-id>:<utc-date>',fields:MACHINE_STATS_FIELDS,ttlSeconds:172800,
      note:'每个调用方、每个 UTC 日共用一个 JSON 键，记录领取、空领取、上传 409 和退回次数。额度键（upload/requeue/register）仍是整数，互不混写。完成记录若有领取时间，列表和上传响应会带 claimedAt 与 claimDurationSeconds。旧客户端可忽略这些字段。'},
    registerSections:MACHINE_REGISTER_SECTIONS,registerSourcePattern:MACHINE_REGISTER_SOURCE.source,
    legacyMuse:{retireOn:museRetireOn(env),autoDisable:false,closed:museLegacyClosed(env),closedEndpoints:museLegacyClosed(env) ? MUSE_LEGACY_ENDPOINTS : [],endpoints:['/api/muse/claim','/api/muse/receipt','/api/muse/upload','/api/muse/retry']},
    replace:{header:'X-Machine-Replace',value:'1',roles:['downloader','fallback'],legacyMuse:false,note:'覆盖已完成原件：重新全套首页身份检查与双解析器核验，计入当日上传额度；核验通过前旧原件继续可下载。'},
    identityReasons:MACHINE_IDENTITY_REASONS,
    claimable:{field:'claimable',unclaimableReasonField:'unclaimableReason',unclaimableReasons:['verification_failed'],
      note:'列表保持六个对外状态。内部状态为 review（核验未通过）的条目仍列在 failed-awaiting-fallback，但 claimable 为 false，并带 unclaimableReason: verification_failed。领取和重排仍会跳过它们，请直接上传正式版 PDF。旧客户端可忽略这两个新字段。'},
    softRetry:{reasons:MACHINE_SOFT_RETRY_REASONS,limit:MACHINE_SOFT_RETRY_LIMIT,
      note:'lease_expired 与 source_blocked 第一次把任务退回待下载并记 softFailCount；同一篇累计两次才进失败待兜底，失败记录保留 claimant 与领取时间。带 previousReason 的条目（从失败待兜底领走的硬失败，如 not_oa）租约到期仍回失败待兜底，并保留原原因，不会回到待下载。not_oa、wrong_paper、han_login、han_quota、other 仍直接进失败待兜底。queue_expired 仍是硬失败。同一次领取不会把刚退回的篇再领走。'},
    supersede:{field:'supersededFrom',archiveKeyPattern:'library:muse-superseded:<doi>:<old-task-id>',
      note:'每个 DOI 只有一把 library:muse-job:<doi>。museIntake 只要覆盖这把键上的任何现有任务，就会先把旧记录原样写到上述键（含旧 sha256 与旧状态），带 supersededBy 为新 taskId、supersededAt，以及原来的 reason / previousReason，不设过期。这包括失败/review/尚未完成的任务，以及用 X-Machine-Replace 替换已是 done/available 的原件。新任务立即带 supersededFrom。若新任务后来核验失败进入 review 再重新上传，链会接续。旧客户端可忽略。'},
    oaVerify:{source:'open_access',limit:2,note:'开放获取来源核验未通过时，第一次把任务退回待下载，候选文件只留记录不删，并记入 oaRejected。同一篇第二次核验未通过则留在 review，claimable 为 false。机器或读者上传核验未通过仍直接进 review。旧客户端可忽略新计数字段。'},
    lease:{extendMinutes:20,maxMinutesFromClaim:120,returnLimit:MACHINE_RETURN_LIMIT,
      note:'仅当前未过期租约的持有人可 POST /api/machine/renew 或 /api/machine/return。每次续期 +20 分钟，从领取开始最多 120 分钟，到上限后拒绝（machine_lease_limit）。下载端退回不是失败，任务回到待下载并保留原 FIFO，同一篇最多 3 次，超过后拒绝（machine_return_limit），只能改报失败。兜底角色退回（以及带 previousReason 的条目）回到失败待兜底并保留原原因，不会回到待下载。旧客户端不调用这两个接口即可。'},
    statusDetail:{field:'detail',maxChars:MACHINE_STATUS_DETAIL_MAX,allowed:MACHINE_STATUS_DETAILS,reasons:['source_blocked'],
      note:'POST /api/machine/status 的可选字段 detail。目前只允许在 reason 为 source_blocked 时写入 just_accepted（例如期刊仍是 Just Accepted、排版尚未完成，要等正式出版后再处理）。其他原因或状态带 detail 返回 400，并在 message 里说明。写入后出现在失败待兜底和确认放弃列表里。旧客户端可忽略。'},
    endpoints:{upload:'PUT /api/machine/upload',status:'POST /api/machine/status',tasks:'GET /api/machine/tasks',abandoned:'GET /api/machine/abandoned',claim:'POST /api/machine/claim',renew:'POST /api/machine/renew',return:'POST /api/machine/return',requeue:'POST /api/machine/requeue',register:'POST /api/machine/register'}});
}
async function handleMachineUpload(request, env) {
  // Exempt from librarySoftGate (30/day site-wide and 20/IP). Only the per-token counter applies.
  let caller = null;
  try {
    if (!['PUT','POST'].includes(request.method) || new URL(request.url).search) libraryFail('machine_bad_request', request.method === 'PUT' || request.method === 'POST' ? 400 : 405);
    caller = await machineAuthorize(request, env, 'upload');
    const replaceHeader = request.headers.get('x-machine-replace');
    if (replaceHeader !== null && replaceHeader !== '1') libraryFail('machine_bad_request', 400);
    const replacing = replaceHeader === '1';
    if (replacing && !machineMayReplace(caller)) libraryFail('machine_forbidden', 403);
    const {doi, bytes} = await machineReadUpload(request);
    if (bytes.length < 51200 || bytes.length > LIBRARY_MAX_PDF_BYTES) libraryFail('muse_bad_pdf', 413);
    try { libraryValidatePdf(bytes); } catch { libraryFail('muse_bad_pdf', 415); }
    const sha256 = await pdfDigest('SHA-256', bytes);
    const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi);
    let paper = libraryPaper(record, doi);
    let fresh = null;
    if (!paper) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      try { fresh = {...await libraryMetadata(doi, {signal:controller.signal}), fulltextStatus:'manual_needed'}; }
      finally { clearTimeout(timer); }
      paper = fresh;
    }
    if (paper.fulltextStatus === 'review') libraryFail('library_identity', 409);
    const identity = await machineIdentity(bytes, paper.doi, paper.title);
    if (identity.verdict !== 'ok') throw new MachineIdentityFailure(identity.verdict === 'invalid' ? 'machine_identity' : 'machine_identity_mismatch', identity.reason, identity.checks);
    const attempt = await libraryGet(env.QL_KV, 'library:attempt:' + doi);
    if (attempt && attempt.paused) libraryFail('library_paused', 423);
    await museOwnerGuard(env, doi);
    const existing = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
    const decision = replacing ? machineReplaceDecision(existing, paper, record, sha256, caller) : machineUploadDecision(existing, paper, sha256, caller);
    if (decision.type === 'replay') return json({ok:true,idempotent:true,task:{...machineListItem(decision.job),caller:decision.job.caller || '',sha256:decision.job.sha256,...(decision.job.identityLevel ? {identity:decision.job.identityLevel} : {}),...(decision.job.replace ? {replace:machineReplacePublic(decision.job.replace)} : {})}});
    if (decision.type === 'unneeded') libraryFail('machine_replace_unneeded', 409);
    if (decision.type === 'same') libraryFail('machine_replace_same', 409);
    if (decision.type === 'done') libraryFail('machine_done', 409);
    if (decision.type === 'conflict') libraryFail('machine_conflict', 409);
    if (decision.type === 'busy') libraryFail('machine_busy', 409);
    if (decision.type === 'closed') libraryFail('machine_closed', 409);
    await machineRemaining(env, caller, 'upload', machineLimit(env, 'MACHINE_UPLOAD_DAILY_LIMIT', MACHINE_UPLOAD_DAILY_DEFAULT));
    if (fresh) await librarySave(env.QL_KV, fresh, null, 'library_manual_needed');
    await machineConsume(env, caller, 'upload', 1);
    const replace = replacing ? {by:caller.id,at:Date.now(),oldSha256:decision.oldSha,newSha256:sha256,previous:existing && existing.state === 'available' ? existing : null} : null;
    const job = await museIntake(env, doi, bytes, caller.id, existing || null, {identityLevel:identity.level,...(replace ? {replace} : {})});
    return json({ok:true,idempotent:false,task:{...machineListItem(job),caller:caller.id,sha256,identity:identity.level,...(replace ? {replace:machineReplacePublic(replace)} : {})}}, 202);
  } catch (error) {
    if (caller && error instanceof LibraryFailure && error.status === 409) {
      try { await machineStatsBump(env, caller, 'upload409'); } catch {}
    }
    return machineError(error);
  }
}
function machineStatusDetail(input, allowed) {
  if (!Object.hasOwn(input, 'detail')) return undefined;
  if (!allowed) machineFail('machine_bad_request', 400, 'detail 只允许在 just_accepted 结果下使用（reason 须为 source_blocked）');
  if (typeof input.detail !== 'string') machineFail('machine_bad_request', 400, 'detail 必须是字符串，最长 ' + MACHINE_STATUS_DETAIL_MAX + ' 字，且目前只允许 just_accepted');
  const text = input.detail.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!text || text.length > MACHINE_STATUS_DETAIL_MAX || !MACHINE_STATUS_DETAILS.includes(text)) {
    machineFail('machine_bad_request', 400, 'detail 目前只允许 just_accepted（最长 ' + MACHINE_STATUS_DETAIL_MAX + ' 字，已去除控制字符）');
  }
  return text;
}
async function handleMachineStatus(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    const caller = await machineAuthorize(request, env, 'status');
    const input = await fulltextReadJson(request, 2048, 'machine_bad_request');
    if (Object.keys(input).some(key => !['doi','state','reason','stage','driveFileId','detail'].includes(key))) libraryFail('machine_bad_request', 400);
    const doi = libraryDoi(input.doi);
    if (!doi || doi !== input.doi) libraryFail('machine_bad_request', 400);
    const abandoning = input.state === 'confirmed-abandoned';
    const failing = input.state === 'failed-awaiting-fallback';
    const backfill = !Object.hasOwn(input,'state') && Object.hasOwn(input,'driveFileId');
    if (!abandoning && !failing && !backfill) libraryFail('machine_bad_request', 400);
    if (abandoning && caller.role !== 'fallback') libraryFail('machine_forbidden', 403);
    if (failing && !MACHINE_FAILURE_REASONS.includes(input.reason)) libraryFail('machine_bad_reason', 400);
    if (abandoning && Object.hasOwn(input,'reason') && !MACHINE_FAILURE_REASONS.includes(input.reason)) libraryFail('machine_bad_reason', 400);
    if (Object.hasOwn(input,'stage') && !MACHINE_STAGE_TAGS.includes(input.stage)) libraryFail('machine_bad_request', 400);
    if (backfill && (Object.hasOwn(input,'reason') || Object.hasOwn(input,'stage'))) libraryFail('machine_bad_request', 400);
    if (Object.hasOwn(input,'driveFileId') && (typeof input.driveFileId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(input.driveFileId))) libraryFail('machine_bad_request', 400);
    const incomingDetail = machineStatusDetail(input, failing && input.reason === 'source_blocked');
    const job = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
    if (!job) libraryFail('machine_not_found', 404);
    if (abandoning && job.state === 'abandoned') return json({ok:true,idempotent:true,task:{...machineListItem(job),abandonedBy:job.abandonedBy || ''}});
    if ((failing || abandoning) && job.state === 'available') libraryFail('machine_done', 409);
    if ((failing || abandoning) && job.state === 'verifying') libraryFail('machine_conflict', 409);
    if (!abandoning && job.state === 'abandoned') libraryFail('machine_closed', 409);
    const now = Date.now();
    let next = job, queuedBack = false;
    if (failing) {
      const stage = MACHINE_STAGE_TAGS.includes(input.stage) ? input.stage : (input.reason === 'han_login' || input.reason === 'han_quota' ? 'han' : '');
      if (MACHINE_SOFT_RETRY_REASONS.includes(input.reason)) {
        const plan = machineSoftRetryPlan(job, input.reason, now);
        next = plan.next;
        queuedBack = plan.queued;
        if (!queuedBack && stage) next = {...next,stage};
        if (input.driveFileId) next = {...next,driveFileId:input.driveFileId};
      } else {
        next = {...job,state:input.reason === 'han_login' ? 'login_required' : 'failed',reason:input.reason,updatedAt:now,
          ...(stage ? {stage} : {}),...(input.driveFileId ? {driveFileId:input.driveFileId} : {})};
      }
    } else if (abandoning) {
      next = {...job,state:'abandoned',updatedAt:now,abandonedBy:caller.id,
        ...(input.reason ? {reason:input.reason} : {}),...(input.stage ? {stage:input.stage} : {}),...(input.driveFileId ? {driveFileId:input.driveFileId} : {})};
    } else {
      next = {...job,driveFileId:input.driveFileId,updatedAt:now};
    }
    const detail = incomingDetail !== undefined ? incomingDetail : (job.detail === 'just_accepted' ? job.detail : '');
    next = detail ? {...next,detail} : next;
    await musePut(env, next);
    if (queuedBack && next.queueKey) await libraryPut(env.QL_KV, next.queueKey, JSON.stringify({doi:next.doi,id:next.id}), {expirationTtl:604800});
    else if ((failing || abandoning) && job.queueKey) await museDelete(env, job.queueKey);
    if (next.state === 'available' && next.sha256 && input.driveFileId && !await libraryGet(env.QL_KV, DRIVE_ARCHIVE_PREFIX + next.sha256)) {
      await libraryPut(env.QL_KV, DRIVE_ARCHIVE_PREFIX + next.sha256, JSON.stringify({version:1,doi,sha256:next.sha256,driveFileId:input.driveFileId,source:'machine',archivedAt:now}));
    }
    return json({ok:true,idempotent:false,task:{...machineListItem(next),...(next.driveFileId ? {driveFileId:next.driveFileId} : {}),...(next.abandonedBy ? {abandonedBy:next.abandonedBy} : {})}});
  } catch (error) { return machineError(error); }
}
function machineCursorEncode(cursor) {
  return btoa(JSON.stringify({c:cursor.c,skip:cursor.skip})).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function machineCursorDecode(value) {
  if (!value) return {c:'',skip:0};
  try {
    const pad = value.length % 4 ? '='.repeat(4 - (value.length % 4)) : '';
    const parsed = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad));
    if (!parsed || typeof parsed.c !== 'string' || parsed.c.length > 1800 || !Number.isInteger(parsed.skip) || parsed.skip < 0 || parsed.skip > 1000) libraryFail('machine_bad_request', 400);
    return {c:parsed.c,skip:parsed.skip};
  } catch (error) {
    if (error instanceof LibraryFailure) throw error;
    libraryFail('machine_bad_request', 400);
  }
}
async function machineListKeys(env, prefix, cursor, limit) {
  let listing;
  try { listing = await env.QL_KV.list({prefix,limit,...(cursor ? {cursor} : {})}); } catch { libraryFail('library_storage', 503); }
  if (!listing || !Array.isArray(listing.keys) || listing.keys.length > limit) libraryFail('library_storage', 503);
  return listing;
}
// Scan path: every job key, in key order. Used for states the index does not hold (done, confirmed-abandoned) and for an unfiltered list.
async function machineCollectScan(env, state, cursorText, limit) {
  let position = machineCursorDecode(cursorText);
  const tasks = [];
  for (let page = 0; page < MACHINE_LIST_SCAN_PAGES_MAX && tasks.length < limit; page++) {
    const listing = await machineListKeys(env, MUSE_JOB_PREFIX, position.c, MACHINE_LIST_SCAN_PAGE_KEYS);
    const keys = listing.keys.filter(entry => typeof entry.name === 'string' && entry.name.startsWith(MUSE_JOB_PREFIX));
    if (position.skip > keys.length) libraryFail('machine_bad_request', 400);
    let index = position.skip;
    for (; index < keys.length && tasks.length < limit; index++) {
      const doi = keys[index].name.slice(MUSE_JOB_PREFIX.length);
      const job = museRecord(await libraryGet(env.QL_KV, keys[index].name), doi);
      if (!job) continue;
      const item = machineListItem(job);
      if (state && item.state !== state) continue;
      tasks.push(item);
    }
    if (tasks.length >= limit && index < keys.length) return {tasks,cursor:machineCursorEncode({c:position.c,skip:index})};
    if (listing.list_complete || typeof listing.cursor !== 'string' || !listing.cursor) return {tasks,cursor:null};
    position = {c:listing.cursor,skip:0};
    if (tasks.length >= limit) return {tasks,cursor:machineCursorEncode(position)};
  }
  return {tasks,cursor:position.c ? machineCursorEncode(position) : null,truncated:true};
}
// The index is not complete until its one-time backfill has finished; a list or requeue then waits instead of answering from part of the table.
function machineIndexReadyOrWait(doc) {
  if (!doc.ready) libraryFail('machine_index_building', 503, Date.now() + MACHINE_INDEX_BUILDING_RETRY_SECONDS * 1000);
}
function machineIndexCursorEncode(key) {
  return machineCursorEncode({c:'idx:' + key,skip:0});
}
function machineIndexCursorDecode(value) {
  if (!value) return '';
  const position = machineCursorDecode(value);
  if (!position.c.startsWith('idx:') || position.skip !== 0) libraryFail('machine_bad_request', 400);
  return position.c.slice(4);
}
function machineIndexSortKey(doi, entry) {
  return String(entry.c).padStart(13, '0') + ':' + doi;
}
// Per-state list from the index: one read for the index plus one record read per returned task, no key listing.
async function machineCollectIndexed(env, state, cursorText, limit) {
  const after = machineIndexCursorDecode(cursorText);
  const doc = await museIndexOpen(env);
  machineIndexReadyOrWait(doc);
  const candidates = museIndexPublicCandidates(doc, state, Date.now()).filter(([doi, entry]) => machineIndexSortKey(doi, entry) > after);
  const tasks = [], fixes = [];
  let last = '', more = false;
  for (let n = 0; n < candidates.length; n++) {
    const [doi, entry] = candidates[n];
    if (tasks.length >= limit) { more = true; break; }
    last = machineIndexSortKey(doi, entry);
    const job = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
    const actual = museIndexEntry(job);
    if (!museIndexSame(actual, entry)) fixes.push({doi,entry:actual});
    if (!job) continue;
    const item = machineListItem(job);
    if (item.state === state) tasks.push(item);
  }
  await museIndexApply(env, fixes);
  return {tasks,cursor:more ? machineIndexCursorEncode(last) : null};
}
async function machineCollect(env, state, cursorText, limit) {
  return MACHINE_INDEXED_PUBLIC_STATES.includes(state) ? machineCollectIndexed(env, state, cursorText, limit) : machineCollectScan(env, state, cursorText, limit);
}
function machineQuery(request, allowed) {
  const url = new URL(request.url);
  if (request.method !== 'GET') libraryFail('machine_bad_request', 405);
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key))) libraryFail('machine_bad_request', 400);
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? MACHINE_LIST_LIMIT_DEFAULT : Number(limitText);
  if (Number.isInteger(limit) && String(limit) === String(limitText) && limit > MACHINE_LIST_LIMIT_MAX) {
    machineFail('machine_bad_request', 400, 'limit 超过上限 ' + MACHINE_LIST_LIMIT_MAX, {listLimitMax:MACHINE_LIST_LIMIT_MAX});
  }
  if (!Number.isInteger(limit) || String(limit) !== String(limitText === null ? MACHINE_LIST_LIMIT_DEFAULT : limitText) || limit < 1) libraryFail('machine_bad_request', 400);
  const cursor = url.searchParams.get('cursor') || '';
  if (cursor.length > 2048) libraryFail('machine_bad_request', 400);
  return {url,limit,cursor};
}
async function handleMachineTasks(request, env) {
  try {
    await machineAuthorize(request, env, 'list');
    const query = machineQuery(request, ['state','cursor','limit']);
    const state = query.url.searchParams.get('state') || '';
    if (state && !MACHINE_PUBLIC_STATES.includes(state)) libraryFail('machine_bad_request', 400);
    const page = await machineCollect(env, state, query.cursor, query.limit);
    return json({ok:true,tasks:page.tasks,cursor:page.cursor,...(page.truncated ? {truncated:true} : {})});
  } catch (error) { return machineError(error); }
}
async function handleMachineAbandoned(request, env) {
  try {
    await machineAuthorize(request, env, 'abandoned');
    const query = machineQuery(request, ['cursor','limit']);
    const page = await machineCollect(env, 'confirmed-abandoned', query.cursor, query.limit);
    return json({ok:true,tasks:page.tasks.map(task => task),cursor:page.cursor,...(page.truncated ? {truncated:true} : {})});
  } catch (error) { return machineError(error); }
}
function machineClaimPayload(job, paper) {
  return {...machineListItem(job),state:'downloading',title:paper && paper.title || '',leaseId:job.leaseId,
    leaseUntil:new Date(job.leaseUntil).toISOString(),sources:['open_access','authorized_hamburg'],
    institutionLoginUrl:HAN_LOGIN_URL,institutionUrl:hanDoiUrl(job.doi)};
}
// Claim candidates come from the index; every record is re-read before it is touched. KV is not atomic: the
// lease id is checked after the write, and a lost race is machine_sync_pending. All index changes of one claim
// (corrections of stale entries and the claim itself) are applied together at the end.
async function machineClaimQueued(env, caller) {
  const doc = await museIndexOpen(env);
  const changes = [];
  let task = null, scanLimited = false;
  try {
    const candidates = museIndexQueuedCandidates(doc, Date.now());
    let scanned = 0;
    for (let i = 0; i < candidates.length && !task; i++) {
      if (scanned >= MACHINE_CLAIM_SCAN_MAX) { scanLimited = true; break; }
      scanned++;
      const [doi, entry] = candidates[i];
      const job = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
      if (!museIndexSame(museIndexEntry(job), entry)) changes.push({doi,entry:museIndexEntry(job)});
      if (!job) continue;
      if (['available','review','failed','login_required','verifying','abandoned'].includes(job.state)) { await museDelete(env, job.queueKey); continue; }
      if (['running','uploading'].includes(job.state) && job.leaseUntil <= Date.now()) {
        await machineCommitSoftRetry(env, job, 'lease_expired', Date.now(), {indexChanges:changes});
        continue;
      }
      if (job.state !== 'queued') continue;
      if (museExpired(job)) { await musePut(env, {...job,state:'failed',reason:'queue_expired',updatedAt:Date.now()}, {indexChanges:changes}); await museDelete(env, job.queueKey); continue; }
      const attempt = await libraryGet(env.QL_KV, 'library:attempt:' + job.doi);
      if (attempt && attempt.paused) continue;
      await museOwnerGuard(env, job.doi);
      const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + job.doi), paper = libraryPaper(record, job.doi);
      if (paper && paper.fulltextStatus === 'available') { await libraryStoredPdf(env.QL_KV, record); await musePut(env, {...job,state:'available',updatedAt:Date.now()}, {indexChanges:changes}); await museDelete(env, job.queueKey); continue; }
      if (!paper || paper.fulltextStatus === 'review') continue;
      const scope = scopeDecision(paper);
      if (scope.action === 'exclude') {
        await musePut(env, {...job,state:'failed',reason:'out_of_scope',scopeExcluded:true,scopeReason:scope.reason,scopeDetail:scope.detail,updatedAt:Date.now()}, {indexChanges:changes});
        if (job.queueKey) await museDelete(env, job.queueKey);
        continue;
      }
      const now = Date.now();
      const claimed = {...job,state:'running',claimant:caller.id,acquisitionStartedAt:now,leaseId:crypto.randomUUID(),leaseUntil:now + MUSE_LEASE_MS,updatedAt:now};
      await musePut(env, claimed, {indexChanges:changes});
      const observed = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + job.doi), job.doi);
      if (!observed || observed.leaseId !== claimed.leaseId || observed.claimant !== caller.id) libraryFail('machine_sync_pending', 503);
      task = machineClaimPayload(claimed, paper);
    }
  } finally { await machineIndexFlush(env, changes); }
  return {task,building:!doc.ready,scanLimited};
}
async function machineClaimFailed(env, caller) {
  const doc = await museIndexOpen(env);
  const changes = [];
  let task = null, scanLimited = false;
  try {
    const candidates = museIndexFailedCandidates(doc, Date.now());
    let scanned = 0;
    for (let i = 0; i < candidates.length && !task; i++) {
      if (scanned >= MACHINE_CLAIM_SCAN_MAX) { scanLimited = true; break; }
      scanned++;
      const [doi, entry] = candidates[i];
      const job = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
      if (!museIndexSame(museIndexEntry(job), entry)) changes.push({doi,entry:museIndexEntry(job)});
      if (!job) continue;
      if (['running','uploading'].includes(job.state) && job.leaseUntil <= Date.now()) {
        await machineCommitSoftRetry(env, job, 'lease_expired', Date.now(), {indexChanges:changes});
        continue;
      }
      if (machinePublicState(job) !== 'failed-awaiting-fallback') continue;
      const attempt = await libraryGet(env.QL_KV, 'library:attempt:' + doi);
      if (attempt && attempt.paused) continue;
      if (['running','uploading'].includes(job.state) && job.leaseUntil > Date.now()) continue;
      if (job.state === 'queued' && museExpired(job)) {
        await musePut(env, {...job,state:'failed',reason:'queue_expired',updatedAt:Date.now()}, {indexChanges:changes});
        if (job.queueKey) await museDelete(env, job.queueKey);
        continue;
      }
      const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), paper = libraryPaper(record, doi);
      if (paper && paper.fulltextStatus === 'available') { await musePut(env, {...job,state:'available',updatedAt:Date.now()}, {indexChanges:changes}); continue; }
      if (paper && paper.fulltextStatus === 'review') continue;
      // A task whose PDF failed verification keeps its candidate and reason; a claim must not overwrite it.
      if (job.state === 'review') continue;
      const scope = paper ? scopeDecision(paper) : null;
      if (scope && scope.action === 'exclude') {
        await musePut(env, {...job,state:'failed',reason:'out_of_scope',scopeExcluded:true,scopeReason:scope.reason,scopeDetail:scope.detail,updatedAt:Date.now()}, {indexChanges:changes});
        if (job.queueKey) await museDelete(env, job.queueKey);
        continue;
      }
      await museOwnerGuard(env, doi);
      const now = Date.now();
      // The failure that made this task claimable is history, not the state of the new lease.
      const {reason:previousReason, ...rest} = job;
      const claimed = {...rest,state:'running',claimant:caller.id,acquisitionStartedAt:now,leaseId:crypto.randomUUID(),leaseUntil:now + MUSE_LEASE_MS,updatedAt:now,...(previousReason ? {previousReason} : {})};
      await musePut(env, claimed, {indexChanges:changes});
      const observed = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
      if (!observed || observed.leaseId !== claimed.leaseId) libraryFail('machine_sync_pending', 503);
      if (job.queueKey) await museDelete(env, job.queueKey);
      task = machineClaimPayload(claimed, paper);
    }
  } finally { await machineIndexFlush(env, changes); }
  return {task,building:!doc.ready,scanLimited};
}
// Applies the collected index changes. Never hides the error that ended the request: a failed flush only leaves
// stale entries behind, which the next claim corrects from the records.
async function machineIndexFlush(env, changes) {
  try { await museIndexApply(env, changes); } catch {}
}
async function handleMachineClaim(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    const caller = await machineAuthorize(request, env, 'claim');
    const input = await fulltextReadJson(request, 256, 'machine_bad_request');
    if (Object.keys(input).some(key => key !== 'state') || !['to-download','failed-awaiting-fallback'].includes(input.state)) libraryFail('machine_bad_request', 400);
    if (caller.role === 'downloader' && input.state !== 'to-download') libraryFail('machine_forbidden', 403);
    if (caller.role === 'fallback' && input.state !== 'failed-awaiting-fallback') libraryFail('machine_forbidden', 403);
    const result = input.state === 'to-download' ? await machineClaimQueued(env, caller) : await machineClaimFailed(env, caller);
    if (result.task) {
      try { await machineStatsBump(env, caller, 'claim'); } catch {}
      return json({ok:true,task:result.task});
    }
    // Nothing to claim: tell the caller how long to wait before asking again (the same value in the Retry-After header).
    const scanLimited = !!result.scanLimited;
    const wait = result.building ? MACHINE_INDEX_BUILDING_RETRY_SECONDS : scanLimited ? MACHINE_CLAIM_SCAN_LIMIT_RETRY_SECONDS : MACHINE_EMPTY_CLAIM_RETRY_SECONDS;
    // claim_scan_limit is a short retry, not a true empty queue, so it does not bump the daily emptyClaim counter.
    if (!scanLimited) {
      try { await machineStatsBump(env, caller, 'emptyClaim'); } catch {}
    }
    return json({ok:true,task:null,retryAfterSeconds:wait,retryAfter:wait,...(scanLimited ? {reason:'claim_scan_limit'} : {})}, 200, {'retry-after':String(wait)});
  } catch (error) { return machineError(error); }
}

function machineReturnCount(job) {
  return job && Number.isInteger(job.returnCount) && job.returnCount > 0 ? job.returnCount : 0;
}
function machineRequireLease(job, caller, input) {
  if (!job) libraryFail('machine_not_found', 404);
  if (job.state === 'available') libraryFail('machine_done', 409);
  if (job.state === 'abandoned') libraryFail('machine_closed', 409);
  if (job.state === 'verifying') libraryFail('machine_conflict', 409);
  if (!['running','uploading'].includes(job.state) || museExpired(job) || job.claimant !== caller.id) libraryFail('machine_lease_required', 409);
  if (input && input.leaseId && input.leaseId !== job.leaseId) libraryFail('machine_lease_required', 409);
}
async function handleMachineRenew(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    const caller = await machineAuthorize(request, env, 'renew');
    const input = await fulltextReadJson(request, 256, 'machine_bad_request');
    if (Object.keys(input).some(key => !['doi','leaseId'].includes(key))) libraryFail('machine_bad_request', 400);
    const doi = libraryDoi(input.doi);
    if (!doi || doi !== input.doi) libraryFail('machine_bad_request', 400);
    const job = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
    machineRequireLease(job, caller, input);
    const now = Date.now();
    const started = Number.isSafeInteger(job.acquisitionStartedAt) && job.acquisitionStartedAt > 0 ? job.acquisitionStartedAt : job.createdAt;
    const cap = started + MACHINE_LEASE_MAX_MS;
    if (now >= cap || job.leaseUntil >= cap) libraryFail('machine_lease_limit', 409);
    const leaseUntil = Math.min(job.leaseUntil + MACHINE_LEASE_EXTEND_MS, cap);
    if (leaseUntil <= job.leaseUntil) libraryFail('machine_lease_limit', 409);
    const next = {...job,leaseUntil,updatedAt:now};
    await musePut(env, next);
    return json({ok:true,task:{...machineClaimPayload(next, null),claimant:caller.id,leaseUntil:new Date(leaseUntil).toISOString(),leaseExpiresAt:new Date(cap).toISOString()}});
  } catch (error) { return machineError(error); }
}
async function handleMachineReturn(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    const caller = await machineAuthorize(request, env, 'return');
    const input = await fulltextReadJson(request, 256, 'machine_bad_request');
    if (Object.keys(input).some(key => !['doi','leaseId'].includes(key))) libraryFail('machine_bad_request', 400);
    const doi = libraryDoi(input.doi);
    if (!doi || doi !== input.doi) libraryFail('machine_bad_request', 400);
    const job = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
    machineRequireLease(job, caller, input);
    const now = Date.now();
    const {leaseId:_leaseId,leaseUntil:_leaseUntil,reviewOwner:_ro,reviewLeaseId:_rl,reviewLeaseUntil:_ru,stage:_stage, ...kept} = job;
    // Fallback (and any task already claimed from failed-awaiting-fallback) must not land in to-download.
    // Return the job to failed, keeping reason / previousReason and the claim identity.
    if (caller.role === 'fallback' || machineHasHardFailureHistory(job)) {
      const keptReason = job.previousReason || job.reason || 'other';
      const next = {...kept,state:keptReason === 'han_login' ? 'login_required' : 'failed',reason:keptReason,updatedAt:now,
        ...(job.previousReason ? {previousReason:job.previousReason} : {})};
      await musePut(env, next);
      if (job.queueKey) await museDelete(env, job.queueKey);
      return json({ok:true,task:machineListItem(next)});
    }
    if (machineReturnCount(job) >= MACHINE_RETURN_LIMIT) libraryFail('machine_return_limit', 409);
    const {claimant:_c,acquisitionStartedAt:_a,reason:_reason,previousReason:_prev, ...rest} = kept;
    const next = {...rest,state:'queued',updatedAt:now,returnCount:machineReturnCount(job) + 1};
    await musePut(env, next);
    if (next.queueKey) await libraryPut(env.QL_KV, next.queueKey, JSON.stringify({doi:next.doi,id:next.id}), {expirationTtl:604800});
    try { await machineStatsBump(env, caller, 'release'); } catch {}
    return json({ok:true,task:machineListItem(next)});
  } catch (error) { return machineError(error); }
}
function machineRequeueCandidate(job) {
  if (!job || job.scopeExcluded === true || job.reason === 'out_of_scope' || ['review','available','abandoned','verifying'].includes(job.state)) return false;
  if (job.state === 'failed' || job.state === 'login_required') return true;
  return ['queued','running','uploading'].includes(job.state) && museExpired(job);
}
async function machineRequeueOne(env, job, changes) {
  const now = Date.now(), id = crypto.randomUUID();
  const next = {version:1,id,doi:job.doi,state:'queued',createdAt:now,updatedAt:now,queueKey:MUSE_QUEUE_PREFIX + String(now).padStart(13, '0') + ':' + id,
    ...(job.registration ? {registration:job.registration} : {}),
    ...(Number.isInteger(job.softFailCount) && job.softFailCount > 0 ? {softFailCount:job.softFailCount} : {}),
    ...(job.lastSoftFailReason ? {lastSoftFailReason:job.lastSoftFailReason} : {}),
    ...(Number.isInteger(job.returnCount) && job.returnCount > 0 ? {returnCount:job.returnCount} : {})};
  await libraryPut(env.QL_KV, next.queueKey, JSON.stringify({doi:job.doi,id}), {expirationTtl:604800});
  await musePut(env, next, {indexChanges:changes});
  if (job.queueKey && job.queueKey !== next.queueKey) await museDelete(env, job.queueKey);
  return next;
}
async function handleMachineRequeue(request, env) {
  // Exempt from librarySoftGate. A per-token daily budget limits how many tasks one apply can put back.
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    const caller = await machineAuthorize(request, env, 'requeue');
    const input = await fulltextReadJson(request, 256, 'machine_bad_request');
    if (Object.keys(input).some(key => !['dryRun','limit','reindex'].includes(key))) libraryFail('machine_bad_request', 400);
    if (Object.hasOwn(input,'dryRun') && typeof input.dryRun !== 'boolean') libraryFail('machine_bad_request', 400);
    if (Object.hasOwn(input,'reindex')) {
      // Rebuild the candidate index from the job keys: send {"reindex":true} until the reply says ready. It changes no task.
      if (input.reindex !== true || Object.keys(input).length !== 1) libraryFail('machine_bad_request', 400);
      const doc = await museIndexRestart(env);
      return json({ok:true,reindex:{ready:doc.ready,entries:Object.keys(doc.entries).length}});
    }
    const dryRun = input.dryRun === true;
    const limit = Object.hasOwn(input,'limit') ? input.limit : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) libraryFail('machine_bad_request', 400);
    const room = dryRun ? limit : Math.min(limit, await machineRemaining(env, caller, 'requeue', machineLimit(env, 'MACHINE_REQUEUE_DAILY_LIMIT', MACHINE_REQUEUE_DAILY_DEFAULT)));
    const doc = await museIndexOpen(env);
    machineIndexReadyOrWait(doc);
    const requeued = [], skippedPaused = [], changes = [];
    let truncated = false;
    try {
      const candidates = museIndexRequeueCandidates(doc, Date.now());
      for (let n = 0; n < candidates.length; n++) {
        if (requeued.length >= room || n >= MACHINE_REQUEUE_EXAMINE_MAX) { truncated = true; break; }
        const [doi, entry] = candidates[n];
        const job = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
        if (!museIndexSame(museIndexEntry(job), entry)) changes.push({doi,entry:museIndexEntry(job)});
        if (!machineRequeueCandidate(job)) continue;
        const attempt = await libraryGet(env.QL_KV, 'library:attempt:' + doi);
        if (attempt && attempt.paused) { skippedPaused.push({doi}); continue; }
        const paper = libraryPaper(await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), doi);
        if (paper && paper.fulltextStatus === 'available') continue;
        requeued.push({doi,from:job.state});
        if (!dryRun) await machineRequeueOne(env, job, changes);
      }
    } finally { await machineIndexFlush(env, changes); }
    if (!dryRun) await machineConsume(env, caller, 'requeue', requeued.length);
    return json({ok:true,dryRun,limit,requeued,skippedPaused,truncated});
  } catch (error) { return machineError(error); }
}

function machineRegisterItem(raw) {
  // Returns {doi,title,source,section} or {error}. Never throws: a bad item is reported, the rest of the batch continues.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {error:'bad_item'};
  if (Object.keys(raw).some(key => !['doi','title','source','section'].includes(key))) return {error:'bad_item'};
  const doi = libraryDoi(raw.doi);
  if (!doi) return {error:'bad_doi'};
  const title = typeof raw.title === 'string' ? libraryText(raw.title) : '';
  // Upload identity check needs at least five normalized characters of title, otherwise the paper could never be uploaded.
  if (!title || machineNormalize(title).length < 5) return {doi,error:'bad_title'};
  if (typeof raw.source !== 'string' || !MACHINE_REGISTER_SOURCE.test(raw.source)) return {doi,error:'bad_source'};
  if (typeof raw.section !== 'string' || !MACHINE_REGISTER_SECTIONS.includes(raw.section)) return {doi,error:'bad_section'};
  return {doi,title,source:raw.source,section:raw.section};
}
async function machineRegisterExisting(env, doi) {
  // Any record of this DOI, in any state, wins. Returns null when the DOI is genuinely new.
  const raw = await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi);
  if (raw) { const job = museRecord(raw, doi); return {where:'ledger',state:job ? machinePublicState(job) : 'unknown'}; }
  const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi);
  if (record) { const paper = libraryPaper(record, doi); return {where:'paper',state:paper && paper.fulltextStatus === 'available' ? 'done' : 'no-task'}; }
  if (await libraryGet(env.QL_KV, FULLTEXT_JOB_PREFIX + doi) || await libraryGet(env.QL_KV, GROK_JOB_PREFIX + doi)) return {where:'legacy_job',state:'legacy-task'};
  return null;
}
async function machineRegisterOne(env, caller, item, changes) {
  const now = Date.now(), id = crypto.randomUUID();
  const registration = {source:item.source,section:item.section};
  const job = {version:1,id,doi:item.doi,state:'queued',createdAt:now,updatedAt:now,queueKey:MUSE_QUEUE_PREFIX + String(now).padStart(13, '0') + ':' + id,registration};
  const paper = {id:'doi-' + (await pdfDigest('SHA-256', new TextEncoder().encode(item.doi))).slice(0, 16),doi:item.doi,title:item.title,journal:'',authors:[],date:'',datePrecision:'',dateBasis:'',
    ingestedAt:new Date(now).toISOString(),metadataStatus:'external_bibliography_checked',fulltextStatus:'manual_needed'};
  // Same order as a site-owner selection: paper record, job, queue pointer. A half-written DOI would later look
  // like "already exists" and never enter the queue, so a failure removes what this call wrote.
  const local = [];
  try {
    await librarySave(env.QL_KV, paper, null, 'library_manual_needed');
    await musePut(env, job, {indexChanges:local});
    await libraryPut(env.QL_KV, job.queueKey, JSON.stringify({doi:item.doi,id}), {expirationTtl:604800});
    await libraryPut(env.QL_KV, MACHINE_REGISTER_PREFIX + item.doi, JSON.stringify({version:1,doi:item.doi,title:item.title,source:item.source,section:item.section,registeredBy:caller.id,registeredAt:now,taskId:id}));
  } catch (error) {
    for (const key of [MUSE_JOB_PREFIX + item.doi, job.queueKey, MACHINE_REGISTER_PREFIX + item.doi, LIBRARY_PREFIX + item.doi, 'library:attempt:' + item.doi]) {
      try { await env.QL_KV.delete(key); } catch {}
    }
    libraryCatalogCache.clear();
    throw error;
  }
  // KV is not atomic: if another writer created the ledger entry first, report skipped and leave their record alone.
  // The index entry is recorded once per batch (see handleMachineRegister), only for a task that was really written.
  changes.push(...local);
  const observed = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + item.doi), item.doi);
  return observed && observed.id === id;
}
async function handleMachineRegister(request, env) {
  // Exempt from librarySoftGate. Only a downloader may register; the daily budget counts newly registered DOIs per caller.
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    const caller = await machineAuthorize(request, env, 'register');
    // Another full-text owner (Grok bot or the GitHub queue) must not get a second queue that nobody would work off.
    if (env.GROK_FULLTEXT_ENABLED === 'true' || env.FULLTEXT_ASYNC_ENABLED === 'true') libraryFail('muse_owner_conflict', 409);
    const input = await fulltextReadJson(request, 262144, 'machine_bad_request');
    if (Object.keys(input).some(key => key !== 'items') || !Array.isArray(input.items) || !input.items.length) libraryFail('machine_bad_request', 400);
    if (input.items.length > MACHINE_REGISTER_MAX_ITEMS) libraryFail('machine_batch_too_large', 400);
    const limit = machineLimit(env, 'MACHINE_REGISTER_DAILY_LIMIT', MACHINE_REGISTER_DAILY_DEFAULT);
    const usedBefore = await libraryGet(env.QL_KV, machineRateKey(caller, 'register'));
    const used = Number.isInteger(usedBefore) && usedBefore >= 0 ? usedBefore : 0;
    const results = [], seen = new Set(), changes = [];
    let registered = 0, failure = null;
    try {
      for (const raw of input.items) {
        const item = machineRegisterItem(raw);
        if (item.error) { results.push({doi:item.doi || null,result:'rejected',error:item.error}); continue; }
        if (seen.has(item.doi)) { results.push({doi:item.doi,result:'skipped',reason:'duplicate_in_batch'}); continue; }
        seen.add(item.doi);
        const existing = await machineRegisterExisting(env, item.doi);
        if (existing) { results.push({doi:item.doi,result:'skipped',reason:'exists',state:existing.state,where:existing.where}); continue; }
        if (used + registered >= limit) { results.push({doi:item.doi,result:'over_quota'}); continue; }
        if (await machineRegisterOne(env, caller, item, changes)) { registered++; results.push({doi:item.doi,result:'registered',state:'to-download',section:item.section,source:item.source}); }
        else results.push({doi:item.doi,result:'skipped',reason:'exists',state:'unknown',where:'ledger'});
      }
    } catch (error) { failure = error; }
    // Count what really got written, even when a later item failed; a retry then sees those DOIs as skipped.
    // The candidate index gets the whole batch in one write.
    try { await museIndexApply(env, changes); } catch (error) { failure = failure || error; }
    await machineConsume(env, caller, 'register', registered);
    if (failure) throw failure;
    const count = name => results.filter(entry => entry.result === name).length;
    return json({ok:true,counts:{registered,skipped:count('skipped'),overQuota:count('over_quota'),rejected:count('rejected')},results,
      quota:{limit,used:used + registered,remaining:Math.max(0, limit - used - registered),resetsAt:new Date(Date.parse(new Date().toISOString().slice(0, 10)) + 86400000).toISOString()}});
  } catch (error) { return machineError(error); }
}
