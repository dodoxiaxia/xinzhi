// ==== edge/src/04b-machine-download.js · Per-caller download queue ====
// Machine callers (a downloader, a fallback bot, a read-only caller) use their own tokens.
// They never enter the human daily gate. Legacy Muse claim/receipt/upload/retry stay as they are.
const MACHINE_FAILURE_REASONS = ['not_oa','han_login','han_quota','source_blocked','wrong_paper','other'];
const MACHINE_VERIFICATION_REASONS = ['invalid_pdf','invalid_identity','identity_mismatch','verification_rejected'];
const MACHINE_PUBLIC_STATES = ['to-download','downloading','uploaded-awaiting-verification','done','failed-awaiting-fallback','confirmed-abandoned'];
const MACHINE_STAGE_TAGS = ['han','yiigle'];
const MACHINE_ROLE_CAPS = {
  downloader:['upload','status','claim','list','requeue','abandoned','protocol'],
  fallback:['upload','status','abandon','claim','list','abandoned','protocol'],
  reader:['list','abandoned','protocol']
};
const MACHINE_UPLOAD_DAILY_DEFAULT = 80;
const MACHINE_REQUEUE_DAILY_DEFAULT = 200;
function machineError(error) {
  const known = error instanceof LibraryFailure || error instanceof PdfFailure;
  const body = {ok:false,error:known ? error.code : 'machine_server'};
  if (known && error.retryAfter) Object.assign(body, libraryRetryInfo(error.retryAfter));
  return json(body, known ? error.status : 500);
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
function machineNormalize(value) {
  const stripped = String(value || '').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '');
  let out = '';
  for (const char of stripped) {
    const code = char.codePointAt(0);
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code > 127) out += char;
  }
  return out;
}
function machineLatin1(bytes) {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  }
  return out;
}
function machinePdfObject(text, id) {
  const needle = id + ' 0 obj';
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(needle, from);
    if (start < 0) return '';
    const before = start ? text[start - 1] : '';
    if (!/[0-9]/.test(before)) {
      const end = text.indexOf('endobj', start);
      return end < 0 ? '' : text.slice(start, end);
    }
    from = start + needle.length;
  }
  return '';
}
function machinePdfStrings(content) {
  let out = '';
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '(') continue;
    let text = '', depth = 1;
    for (index++; index < content.length && depth; index++) {
      const char = content[index];
      if (char === '\\') { text += content[index + 1] || ''; index++; continue; }
      if (char === '(') { depth++; text += '('; continue; }
      if (char === ')') { depth--; if (depth) text += ')'; continue; }
      text += char;
    }
    index--;
    out += text + '\n';
  }
  return out;
}
async function machineInflate(bytes) {
  if (typeof DecompressionStream !== 'function') return '';
  try {
    const stream = new DecompressionStream('deflate');
    const writer = stream.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const reader = stream.readable.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > LIBRARY_MAX_PDF_BYTES) return '';
      chunks.push(item.value);
    }
    const inflated = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { inflated.set(chunk, offset); offset += chunk.byteLength; }
    return machineLatin1(inflated);
  } catch { return ''; }
}
async function machineStreamText(object) {
  const marker = /stream\r?\n/.exec(object);
  if (!marker) return '';
  const start = marker.index + marker[0].length;
  const end = object.indexOf('endstream', start);
  if (end < 0) return '';
  const raw = object.slice(start, end);
  if (/\/FlateDecode\b/.test(object.slice(0, marker.index))) {
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index) & 255;
    const inflated = await machineInflate(bytes);
    return inflated ? machinePdfStrings(inflated) + '\n' + inflated : '';
  }
  return machinePdfStrings(raw) + '\n' + raw;
}
async function machineFirstPageText(bytes) {
  const text = machineLatin1(bytes);
  const pages = /\/Type\s*\/Pages\b[\s\S]*?\/Kids\s*\[([^\]]*)\]/.exec(text);
  const kid = pages && /(\d+)\s+\d+\s+R/.exec(pages[1]);
  const page = kid ? machinePdfObject(text, kid[1]) : '';
  const contents = /\/Contents\s*\[([^\]]*)\]/.exec(page) || /\/Contents\s+(\d+)\s+\d+\s+R/.exec(page);
  const ids = contents
    ? (/\[/.test(contents[0]) ? [...contents[1].matchAll(/(\d+)\s+\d+\s+R/g)].map(match => match[1]) : [contents[1]])
    : [];
  let combined = '';
  for (const id of ids) combined += await machineStreamText(machinePdfObject(text, id));
  return combined;
}
function machineDoiPresent(text, doi) {
  const escaped = [...doi].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  return new RegExp('(?<![A-Za-z0-9])' + escaped + '(?![A-Za-z0-9])', 'i').test(text);
}
async function machineIdentity(bytes, doi, title) {
  const expected = machineNormalize(title);
  if (!libraryDoi(doi) || expected.length < 5) return 'invalid';
  const page = await machineFirstPageText(bytes);
  if (!page || !machineDoiPresent(page, doi) || !machineNormalize(page).includes(expected)) return 'mismatch';
  return 'ok';
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
function machinePublicState(job) {
  if (!job) return '';
  if (job.state === 'abandoned') return 'confirmed-abandoned';
  if (job.state === 'available') return 'done';
  if (job.state === 'verifying') return 'uploaded-awaiting-verification';
  if (['queued','running','uploading'].includes(job.state) && museExpired(job)) return 'failed-awaiting-fallback';
  if (job.state === 'queued') return 'to-download';
  if (job.state === 'running' || job.state === 'uploading') return 'downloading';
  return 'failed-awaiting-fallback';
}
function machineReason(job) {
  if (MACHINE_FAILURE_REASONS.includes(job.reason)) return job.reason;
  if (MACHINE_VERIFICATION_REASONS.includes(job.verificationReason)) return job.verificationReason;
  if (MACHINE_VERIFICATION_REASONS.includes(job.reason)) return job.reason;
  if (job.state === 'login_required') return 'han_login';
  if (['lease_expired','queue_expired','agent_failed'].includes(job.reason)) return job.reason;
  return '';
}
function machineStage(job) {
  if (MACHINE_STAGE_TAGS.includes(job.stage)) return job.stage;
  if (job.state === 'login_required' || job.reason === 'han_login' || job.reason === 'han_quota') return 'han';
  return '';
}
function machineListItem(job) {
  return {doi:job.doi,state:machinePublicState(job),reason:machineReason(job),stage:machineStage(job),
    claimant:typeof job.claimant === 'string' ? job.claimant : '',updatedAt:new Date(job.updatedAt).toISOString(),taskId:job.id};
}
function machineUploadDecision(job, paper, sha256, caller) {
  if ((paper && paper.fulltextStatus === 'available') || (job && job.state === 'available')) return {type:'done'};
  if (job && job.state === 'abandoned') return {type:'closed'};
  if (job && job.state === 'verifying') return job.sha256 === sha256 ? {type:'replay',job} : {type:'conflict'};
  if (job && ['running','uploading'].includes(job.state) && !museExpired(job) && job.claimant && job.claimant !== caller.id) return {type:'busy'};
  return {type:'accept'};
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
    limits:{uploadDailyDefault:MACHINE_UPLOAD_DAILY_DEFAULT,uploadDailyEnv:'MACHINE_UPLOAD_DAILY_LIMIT',requeueDailyDefault:MACHINE_REQUEUE_DAILY_DEFAULT,requeueDailyEnv:'MACHINE_REQUEUE_DAILY_LIMIT',requeuePerCall:50},
    legacyMuse:{retireOn:museRetireOn(env),autoDisable:false,endpoints:['/api/muse/claim','/api/muse/receipt','/api/muse/upload','/api/muse/retry']},
    endpoints:{upload:'PUT /api/machine/upload',status:'POST /api/machine/status',tasks:'GET /api/machine/tasks',abandoned:'GET /api/machine/abandoned',claim:'POST /api/machine/claim',requeue:'POST /api/machine/requeue'}});
}
async function handleMachineUpload(request, env) {
  // Exempt from librarySoftGate (30/day site-wide and 20/IP). Only the per-token counter applies.
  try {
    if (!['PUT','POST'].includes(request.method) || new URL(request.url).search) libraryFail('machine_bad_request', request.method === 'PUT' || request.method === 'POST' ? 400 : 405);
    const caller = await machineAuthorize(request, env, 'upload');
    const {doi, bytes} = await machineReadUpload(request);
    if (bytes.length < 51200 || bytes.length > LIBRARY_MAX_PDF_BYTES) libraryFail('muse_bad_pdf', 413);
    try { libraryValidatePdf(bytes); } catch { libraryFail('muse_bad_pdf', 415); }
    const sha256 = await pdfDigest('SHA-256', bytes);
    let paper = libraryPaper(await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), doi);
    let fresh = null;
    if (!paper) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      try { fresh = {...await libraryMetadata(doi, {signal:controller.signal}), fulltextStatus:'manual_needed'}; }
      finally { clearTimeout(timer); }
      paper = fresh;
    }
    if (paper.fulltextStatus === 'review') libraryFail('library_identity', 409);
    const verdict = await machineIdentity(bytes, paper.doi, paper.title);
    if (verdict !== 'ok') libraryFail(verdict === 'invalid' ? 'machine_identity' : 'machine_identity_mismatch', 409);
    const attempt = await libraryGet(env.QL_KV, 'library:attempt:' + doi);
    if (attempt && attempt.paused) libraryFail('library_paused', 423);
    await museOwnerGuard(env, doi);
    const existing = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
    const decision = machineUploadDecision(existing, paper, sha256, caller);
    if (decision.type === 'replay') return json({ok:true,idempotent:true,task:{...machineListItem(decision.job),caller:decision.job.caller || '',sha256:decision.job.sha256}});
    if (decision.type === 'done') libraryFail('machine_done', 409);
    if (decision.type === 'conflict') libraryFail('machine_conflict', 409);
    if (decision.type === 'busy') libraryFail('machine_busy', 409);
    if (decision.type === 'closed') libraryFail('machine_closed', 409);
    await machineRemaining(env, caller, 'upload', machineLimit(env, 'MACHINE_UPLOAD_DAILY_LIMIT', MACHINE_UPLOAD_DAILY_DEFAULT));
    if (fresh) await librarySave(env.QL_KV, fresh, null, 'library_manual_needed');
    await machineConsume(env, caller, 'upload', 1);
    const job = await museIntake(env, doi, bytes, caller.id, existing || null);
    return json({ok:true,idempotent:false,task:{...machineListItem(job),caller:caller.id,sha256}}, 202);
  } catch (error) { return machineError(error); }
}
async function handleMachineStatus(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    const caller = await machineAuthorize(request, env, 'status');
    const input = await fulltextReadJson(request, 2048, 'machine_bad_request');
    if (Object.keys(input).some(key => !['doi','state','reason','stage','driveFileId'].includes(key))) libraryFail('machine_bad_request', 400);
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
    const job = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
    if (!job) libraryFail('machine_not_found', 404);
    if (abandoning && job.state === 'abandoned') return json({ok:true,idempotent:true,task:{...machineListItem(job),abandonedBy:job.abandonedBy || ''}});
    if ((failing || abandoning) && job.state === 'available') libraryFail('machine_done', 409);
    if ((failing || abandoning) && job.state === 'verifying') libraryFail('machine_conflict', 409);
    if (!abandoning && job.state === 'abandoned') libraryFail('machine_closed', 409);
    const now = Date.now();
    let next = job;
    if (failing) {
      const stage = MACHINE_STAGE_TAGS.includes(input.stage) ? input.stage : (input.reason === 'han_login' || input.reason === 'han_quota' ? 'han' : '');
      next = {...job,state:input.reason === 'han_login' ? 'login_required' : 'failed',reason:input.reason,updatedAt:now,
        ...(stage ? {stage} : {}),...(input.driveFileId ? {driveFileId:input.driveFileId} : {})};
    } else if (abandoning) {
      next = {...job,state:'abandoned',updatedAt:now,abandonedBy:caller.id,
        ...(input.reason ? {reason:input.reason} : {}),...(input.stage ? {stage:input.stage} : {}),...(input.driveFileId ? {driveFileId:input.driveFileId} : {})};
    } else {
      next = {...job,driveFileId:input.driveFileId,updatedAt:now};
    }
    await musePut(env, next);
    if ((failing || abandoning) && job.queueKey) await museDelete(env, job.queueKey);
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
async function machineCollect(env, state, cursorText, limit) {
  let position = machineCursorDecode(cursorText);
  const tasks = [];
  for (let page = 0; page < 50 && tasks.length < limit; page++) {
    const listing = await machineListKeys(env, MUSE_JOB_PREFIX, position.c, 100);
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
  return {tasks,cursor:position.c ? machineCursorEncode(position) : null};
}
function machineQuery(request, allowed) {
  const url = new URL(request.url);
  if (request.method !== 'GET') libraryFail('machine_bad_request', 405);
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key))) libraryFail('machine_bad_request', 400);
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? 20 : Number(limitText);
  if (!Number.isInteger(limit) || String(limit) !== String(limitText === null ? 20 : limitText) || limit < 1 || limit > 50) libraryFail('machine_bad_request', 400);
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
    return json({ok:true,tasks:page.tasks,cursor:page.cursor});
  } catch (error) { return machineError(error); }
}
async function handleMachineAbandoned(request, env) {
  try {
    await machineAuthorize(request, env, 'abandoned');
    const query = machineQuery(request, ['cursor','limit']);
    const page = await machineCollect(env, 'confirmed-abandoned', query.cursor, query.limit);
    return json({ok:true,tasks:page.tasks.map(task => task),cursor:page.cursor});
  } catch (error) { return machineError(error); }
}
async function machineWalk(env, prefix, visit) {
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const listing = await machineListKeys(env, prefix, cursor, 100);
    for (const entry of listing.keys) {
      if (await visit(entry)) return {stopped:true};
    }
    if (listing.list_complete || typeof listing.cursor !== 'string' || !listing.cursor) return {stopped:false};
    cursor = listing.cursor;
  }
  return {stopped:false,cursor};
}
function machineClaimPayload(job, paper) {
  return {...machineListItem(job),state:'downloading',title:paper && paper.title || '',leaseId:job.leaseId,
    leaseUntil:new Date(job.leaseUntil).toISOString(),sources:['open_access','authorized_hamburg'],
    institutionLoginUrl:HAN_LOGIN_URL,institutionUrl:hanDoiUrl(job.doi)};
}
async function machineClaimQueued(env, caller) {
  let task = null;
  // QL_KV is not atomic. The lease id is checked after the write; a lost race is machine_sync_pending.
  await machineWalk(env, MUSE_QUEUE_PREFIX, async entry => {
    if (typeof entry.name !== 'string' || !entry.name.startsWith(MUSE_QUEUE_PREFIX)) return false;
    const pointer = await libraryGet(env.QL_KV, entry.name);
    const job = pointer && pointer.doi && museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + pointer.doi), pointer.doi);
    if (!job || job.id !== pointer.id || job.queueKey !== entry.name) return false;
    if (['available','review','failed','login_required','verifying','abandoned'].includes(job.state)) { await museDelete(env, entry.name); return false; }
    if (['running','uploading'].includes(job.state) && job.leaseUntil <= Date.now()) {
      await musePut(env, {...job,state:'failed',reason:'lease_expired',updatedAt:Date.now()});
      await museDelete(env, entry.name);
      return false;
    }
    if (job.state !== 'queued') return false;
    if (museExpired(job)) { await musePut(env, {...job,state:'failed',reason:'queue_expired',updatedAt:Date.now()}); await museDelete(env, entry.name); return false; }
    const attempt = await libraryGet(env.QL_KV, 'library:attempt:' + job.doi);
    if (attempt && attempt.paused) return false;
    await museOwnerGuard(env, job.doi);
    const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + job.doi), paper = libraryPaper(record, job.doi);
    if (paper && paper.fulltextStatus === 'available') { await libraryStoredPdf(env.QL_KV, record); await musePut(env, {...job,state:'available',updatedAt:Date.now()}); await museDelete(env, entry.name); return false; }
    if (!paper || paper.fulltextStatus === 'review') return false;
    const now = Date.now();
    const claimed = {...job,state:'running',claimant:caller.id,acquisitionStartedAt:now,leaseId:crypto.randomUUID(),leaseUntil:now + MUSE_LEASE_MS,updatedAt:now};
    await musePut(env, claimed);
    const observed = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + job.doi), job.doi);
    if (!observed || observed.leaseId !== claimed.leaseId || observed.claimant !== caller.id) libraryFail('machine_sync_pending', 503);
    task = machineClaimPayload(claimed, paper);
    return true;
  });
  return task;
}
async function machineClaimFailed(env, caller) {
  let task = null;
  await machineWalk(env, MUSE_JOB_PREFIX, async entry => {
    if (typeof entry.name !== 'string' || !entry.name.startsWith(MUSE_JOB_PREFIX)) return false;
    const doi = entry.name.slice(MUSE_JOB_PREFIX.length);
    const job = museRecord(await libraryGet(env.QL_KV, entry.name), doi);
    if (!job || machinePublicState(job) !== 'failed-awaiting-fallback') return false;
    const attempt = await libraryGet(env.QL_KV, 'library:attempt:' + doi);
    if (attempt && attempt.paused) return false;
    if (['running','uploading'].includes(job.state) && job.leaseUntil > Date.now()) return false;
    const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), paper = libraryPaper(record, doi);
    if (paper && paper.fulltextStatus === 'available') { await musePut(env, {...job,state:'available',updatedAt:Date.now()}); return false; }
    if (paper && paper.fulltextStatus === 'review') return false;
    await museOwnerGuard(env, doi);
    const now = Date.now();
    const claimed = {...job,state:'running',claimant:caller.id,acquisitionStartedAt:now,leaseId:crypto.randomUUID(),leaseUntil:now + MUSE_LEASE_MS,updatedAt:now};
    await musePut(env, claimed);
    const observed = museRecord(await libraryGet(env.QL_KV, entry.name), doi);
    if (!observed || observed.leaseId !== claimed.leaseId) libraryFail('machine_sync_pending', 503);
    if (job.queueKey) await museDelete(env, job.queueKey);
    task = machineClaimPayload(claimed, paper);
    return true;
  });
  return task;
}
async function handleMachineClaim(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    const caller = await machineAuthorize(request, env, 'claim');
    const input = await fulltextReadJson(request, 256, 'machine_bad_request');
    if (Object.keys(input).some(key => key !== 'state') || !['to-download','failed-awaiting-fallback'].includes(input.state)) libraryFail('machine_bad_request', 400);
    if (caller.role === 'downloader' && input.state !== 'to-download') libraryFail('machine_forbidden', 403);
    if (caller.role === 'fallback' && input.state !== 'failed-awaiting-fallback') libraryFail('machine_forbidden', 403);
    const task = input.state === 'to-download' ? await machineClaimQueued(env, caller) : await machineClaimFailed(env, caller);
    return json({ok:true,task});
  } catch (error) { return machineError(error); }
}
function machineRequeueCandidate(job) {
  if (!job || ['review','available','abandoned','verifying'].includes(job.state)) return false;
  if (job.state === 'failed' || job.state === 'login_required') return true;
  return ['queued','running','uploading'].includes(job.state) && museExpired(job);
}
async function machineRequeueOne(env, job) {
  const now = Date.now(), id = crypto.randomUUID();
  const next = {version:1,id,doi:job.doi,state:'queued',createdAt:now,updatedAt:now,queueKey:MUSE_QUEUE_PREFIX + String(now).padStart(13, '0') + ':' + id};
  await libraryPut(env.QL_KV, next.queueKey, JSON.stringify({doi:job.doi,id}), {expirationTtl:604800});
  await musePut(env, next);
  if (job.queueKey && job.queueKey !== next.queueKey) await museDelete(env, job.queueKey);
  return next;
}
async function handleMachineRequeue(request, env) {
  // Exempt from librarySoftGate. A per-token daily budget limits how many tasks one apply can put back.
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    const caller = await machineAuthorize(request, env, 'requeue');
    const input = await fulltextReadJson(request, 256, 'machine_bad_request');
    if (Object.keys(input).some(key => !['dryRun','limit'].includes(key))) libraryFail('machine_bad_request', 400);
    if (Object.hasOwn(input,'dryRun') && typeof input.dryRun !== 'boolean') libraryFail('machine_bad_request', 400);
    const dryRun = input.dryRun === true;
    const limit = Object.hasOwn(input,'limit') ? input.limit : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) libraryFail('machine_bad_request', 400);
    const room = dryRun ? limit : Math.min(limit, await machineRemaining(env, caller, 'requeue', machineLimit(env, 'MACHINE_REQUEUE_DAILY_LIMIT', MACHINE_REQUEUE_DAILY_DEFAULT)));
    const requeued = [], skippedPaused = [];
    let truncated = false;
    const walk = await machineWalk(env, MUSE_JOB_PREFIX, async entry => {
      if (requeued.length >= room) { truncated = true; return true; }
      if (typeof entry.name !== 'string' || !entry.name.startsWith(MUSE_JOB_PREFIX)) return false;
      const doi = entry.name.slice(MUSE_JOB_PREFIX.length);
      const job = museRecord(await libraryGet(env.QL_KV, entry.name), doi);
      if (!machineRequeueCandidate(job)) return false;
      const attempt = await libraryGet(env.QL_KV, 'library:attempt:' + doi);
      if (attempt && attempt.paused) { skippedPaused.push({doi}); return false; }
      const paper = libraryPaper(await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), doi);
      if (paper && paper.fulltextStatus === 'available') return false;
      requeued.push({doi,from:job.state});
      if (!dryRun) await machineRequeueOne(env, job);
      return false;
    });
    if (walk.cursor) truncated = true;
    if (!dryRun) await machineConsume(env, caller, 'requeue', requeued.length);
    return json({ok:true,dryRun,limit,requeued,skippedPaused,truncated});
  } catch (error) { return machineError(error); }
}
