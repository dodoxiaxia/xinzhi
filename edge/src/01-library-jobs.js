// ==== edge/src/01-library-jobs.js · Supplemental DOI library, full-text jobs and OIDC claims ====
// Supplemental records/PDFs live independently of static bibliography, editorial decisions and AI caches.
const LIBRARY_PREFIX = 'library:paper:';
const LIBRARY_TASK_MS = 45000;
const LIBRARY_MAX_PDF_BYTES = 10 * 1024 * 1024;
const libraryCatalogCache = new Map();
const LIBRARY_RETRY_SECONDS = 300;
const FULLTEXT_JOB_PREFIX = 'library:job:';
const FULLTEXT_QUEUE_PREFIX = 'library:queue:';
const FULLTEXT_OIDC_AUDIENCE = 'https://learn.dryz.info/api/fulltext-worker';
const FULLTEXT_WORKFLOW_REF = 'dodoxiaxia/xinzhi/.github/workflows/fulltext.yml@refs/heads/main';
const FULLTEXT_OIDC_SUBJECTS = ['repo:dodoxiaxia/xinzhi:ref:refs/heads/main','repo:dodoxiaxia@214921265/xinzhi@1397425558:ref:refs/heads/main'];
const FULLTEXT_OIDC_BUILD_KEYS = {};
const FULLTEXT_IMPORT_POLICY = { audience:'https://learn.dryz.info/api/fulltext-import', workflow:'dodoxiaxia/xinzhi/.github/workflows/fulltext-import.yml@refs/heads/main', events:['push','workflow_dispatch'] };
const MUSE_REVIEW_POLICY = { audience:'https://learn.dryz.info/api/muse/review', workflow:'dodoxiaxia/xinzhi/.github/workflows/muse-review.yml@refs/heads/main', events:['push','workflow_dispatch','schedule'] };
const FULLTEXT_JOB_LEASE_MS = 180000;
const FULLTEXT_JOB_LIFETIME_MS = 86400000;
let fulltextOidcKeys;
const libraryLocalActive = new Set();
const LIBRARY_PDF_HOSTS = ['ncbi.nlm.nih.gov','europepmc.org','ebi.ac.uk','nature.com','springer.com','springernature.com','biomedcentral.com','plos.org','frontiersin.org','jmir.org','bmj.com','jamanetwork.com','ahajournals.org','academic.oup.com','oup.com','nejm.org','thelancet.com','sciencedirect.com','cell.com','wiley.com','arxiv.org','medrxiv.org','biorxiv.org','researchsquare.com','zenodo.org','hal.science','osf.io','figshare.com'];
class LibraryFailure extends Error {
  constructor(code, status = 502, retryAfter = 0) { super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}
const libraryFail = (code, status = 502, retryAfter = 0) => { throw new LibraryFailure(code, status, retryAfter); };
function libraryDoi(value) {
  if (typeof value !== 'string' || value.length > 500) return '';
  let doi = value.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  try { doi = decodeURIComponent(doi); } catch { return ''; }
  doi = doi.toLowerCase();
  return /^10\.\d{4,9}\/[\x21-\x7e]{1,200}$/.test(doi) && !/[<>?#@\\]/.test(doi) ? doi : '';
}
function libraryText(value, limit = 800) {
  if (typeof value !== 'string' || value.length > 8000) return '';
  const text = stripTags(value).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return text.length <= limit && !/(?:\/(?:Users|home|workspace|tmp)\/|file:\/\/|\.local\/|\b(?:ghp_|github_pat_)|\bbearer\s+\S+)/i.test(text) ? text : '';
}
function libraryPaper(record, expectedDoi = '') {
  const input = record && record.version === 1 && record.paper;
  if (!input || (expectedDoi && input.doi !== expectedDoi) || libraryDoi(input.doi) !== input.doi || !/^doi-[a-f0-9]{16}$/.test(input.id || '') || !libraryText(input.title) || !['available','pending','review','manual_needed'].includes(input.fulltextStatus)) return null;
  if (input.fulltextStatus === 'available' && (!record.pdf || !/^library:pdf:[a-f0-9]{64}$/.test(record.pdf.key || '') || record.pdf.key !== 'library:pdf:' + record.pdf.sha256 || !Number.isInteger(record.pdf.size) || record.pdf.size < 8 || record.pdf.size > LIBRARY_MAX_PDF_BYTES)) return null;
  const paper = { id:input.id, doi:input.doi, title:libraryText(input.title), journal:libraryText(input.journal || '', 300),
    url:'https://doi.org/' + encodeURIComponent(input.doi).replace(/%2F/gi, '/'), authors:(Array.isArray(input.authors) ? input.authors : []).map(name => libraryText(name, 200)).filter(Boolean).slice(0, 30),
    date:/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(input.date || '') ? input.date : '', datePrecision:['day','month','year'].includes(input.datePrecision) ? input.datePrecision : '',
    dateBasis:libraryText(input.dateBasis || '', 100), ingestedAt:typeof input.ingestedAt === 'string' && !isNaN(Date.parse(input.ingestedAt)) ? input.ingestedAt : '',
    metadataStatus:'external_bibliography_checked', fulltextStatus:input.fulltextStatus, ...(input.fulltextStatus === 'pending' && input.fulltextReason === 'temporary' ? { fulltextReason:'temporary' } : {}), basis:'官方题录来源关联 · 未做医学全文审阅' };
  return paper;
}
async function libraryGet(kv, key) {
  try { return await kv.get(key, 'json'); } catch { libraryFail('library_storage', 503); }
}
async function libraryPut(kv, key, value, options) {
  try { await kv.put(key, value, options); } catch (error) {
    const limited = error && (error.status === 429 || /\b429\b/.test(String(error.message || '')));
    libraryFail(limited ? 'library_retry_later' : 'library_storage', limited ? 429 : 503, limited ? Date.now() + 60000 : 0);
  }
}
function libraryQuery(request) {
  const url = new URL(request.url), values = url.searchParams.getAll('doi');
  const downloads = url.searchParams.getAll('download');
  if (values.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'doi' && !(key === 'download' && url.pathname === '/api/acquire'))
      || (downloads.length && (downloads.length !== 1 || downloads[0] !== '1'))) libraryFail('library_bad_doi', 400);
  const doi = libraryDoi(values[0]);
  if (!doi) libraryFail('library_bad_doi', 400);
  return { url, doi, download:downloads.length === 1 };
}
function libraryConfig(env) {
  if (!env.QL_KV) libraryFail('library_not_configured', 503);
  if (env.PDF_DOWNLOAD_ENABLED !== 'true') libraryFail('library_disabled', 503);
}
async function libraryAuthorize(request, env, url) {
  libraryOrigin(request, url);
  await pdfVerifyPassphrase(await pdfReadPassphrase(request), env, request);
}
function libraryOrigin(request, url) {
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin','none'].includes(site)) pdfFail('pdf_origin', 403);
  const origin = request.headers.get('origin');
  if (origin) {
    let parsed; try { parsed = new URL(origin).origin; } catch { pdfFail('pdf_origin', 403); }
    if (parsed !== url.origin) pdfFail('pdf_origin', 403);
  }
}
function libraryRetryInfo(retryAfter) {
  return Number.isSafeInteger(retryAfter) && retryAfter > 0 && retryAfter <= 8640000000000000 - 8 * 60 * 60 * 1000
    ? { retryAfter, retryAfterSeconds:Math.max(0, Math.ceil((retryAfter - Date.now()) / 1000)) } : {};
}
function libraryRetryHint(retryAfter) {
  const info = libraryRetryInfo(retryAfter);
  if (!info.retryAfterSeconds) return '<p>可现在手动再试。系统不会自动重试。</p>';
  const seconds = info.retryAfterSeconds, minutes = Math.floor(seconds / 60), remaining = seconds % 60;
  const wait = (minutes ? minutes + ' 分钟' : '') + (remaining ? (minutes ? ' ' : '') + remaining + ' 秒' : '');
  const time = new Date(info.retryAfter + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return '<p>请在 ' + wait + '后手动重试（北京时间 ' + time + ' 起）。系统不会自动重试。</p>';
}
function libraryUpstreamRetry(response) {
  const value = response.headers.get('retry-after');
  if (!value || value.length > 100) return 0;
  const deadline = /^\d{1,6}$/.test(value.trim()) ? Date.now() + Number(value.trim()) * 1000 : Date.parse(value);
  return Number.isSafeInteger(deadline) && deadline > Date.now() && deadline <= Date.now() + 86400000 ? deadline : 0;
}
function libraryObservedPaper(paper, attempt, active = false) {
  // Project current task progress without rewriting the saved bibliography.
  const job = active && typeof active === 'object' ? active : null;
  active = job ? ['queued','running'].includes(job.state) || job.stage === 'verifying' : active;
  if (paper && paper.fulltextStatus === 'manual_needed' && active) return {...paper,fulltextStatus:'pending'};
  // Legacy no-PDF results used a generic five-minute cooldown; this projection never writes KV.
  if (paper && paper.fulltextStatus === 'pending' && !active && !(attempt && attempt.paused)
      && ((!attempt && paper.fulltextReason !== 'temporary') || attempt && attempt.error === 'library_metadata_unavailable')) return { ...paper, fulltextStatus:'manual_needed' };
  return paper;
}
function libraryRetryResponse(response, retryAfter) {
  const info = libraryRetryInfo(retryAfter);
  if (info.retryAfterSeconds) response.headers.set('retry-after', String(info.retryAfterSeconds));
  return response;
}
function libraryRetryLink(doi, route = '/api/acquire') {
  return doi ? '<p><a href="' + route + '?doi=' + pdfEscape(encodeURIComponent(doi)) + '">' + (route === '/api/fulltext' ? '再次下载 PDF' : '再次获取全文') + '</a></p>' : '';
}
function libraryForm(doi, route, invalid = false, retryAfter = 0, manual = false, institution = false) {
  const notice = institution && route === '/api/acquire'
    ? '输入全文口令，先检查已有文件；缺全文时交给后台机构流程。需要重新登录时，任务会保留并显示处理状态。'
    : manual ? '题录已保存，全文暂不可下载，需要维护者处理。维护者登记全文后，可输入口令检查已有全文；只查询私有索引，不会再次向出版社下载（机构授权执行桥尚未接通）。等待不会自动获取。'
    : route === '/api/acquire' ? '输入一次全文口令，优先复用已有全文，再查询合法开放全文。取得 PDF 后保存题录并直接下载；需要订阅权限时显示待授权状态。' : '输入全文口令即可下载已获取的 PDF。';
  return libraryRetryResponse(pdfHtml('<p' + (invalid ? ' role="alert"' : '') + '>' + (invalid ? '全文口令不正确，请重新输入。' : notice) + '</p>' + (libraryRetryInfo(retryAfter).retryAfterSeconds ? libraryRetryHint(retryAfter) : '') + '<form method="post" action="' + route + '?doi=' + pdfEscape(encodeURIComponent(doi)) + (route === '/api/acquire' ? '&amp;download=1' : '') + '"><p><label for="passphrase">全文口令</label><br><input id="passphrase" name="passphrase" type="password" maxlength="256" autocomplete="current-password" required autofocus></p><button type="submit">' + (institution && route === '/api/acquire' ? '获取全文并查看进度' : manual ? '检查已归档全文' : route === '/api/acquire' ? '获取、保存并下载 PDF' : '下载 PDF') + '</button></form>' + pdfOfficialLink(doi), invalid ? 403 : 200, route === '/api/acquire' ? '按 DOI 获取并入库' : 'PDF 下载', doi), retryAfter);
}
function libraryArchiveStatus() {
  return { scope:'website_cache', state:'not_confirmed', complete:false, executionClaimed:false, ledgerChecked:false, sides:{github:'pending',drive:'pending',mac:'pending'} };
}
function libraryPdfResponse(paper, bytes) {
  const name = Array.from(paper.title.replace(/[\x00-\x1f\x7f\/\\":<>|?*]/g, ' ')).slice(0, 120).join('') + '.pdf';
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return new Response(bytes, { headers:{ 'content-type':'application/pdf', 'content-length':String(bytes.length), 'content-disposition':"attachment; filename=\"article.pdf\"; filename*=UTF-8''" + encoded,
    'cache-control':'private, no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer', 'content-security-policy':"default-src 'none'; frame-ancestors 'none'", 'x-xinzhi-archive-status':'not-confirmed' } });
}
async function libraryAcquireResult(request, env, paper, download, error = '', cached = false, retryAfter = 0) {
  if (download && paper.fulltextStatus === 'available') {
    const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + paper.doi);
    const current = libraryPaper(record, paper.doi);
    if (!current || current.fulltextStatus !== 'available') libraryFail('library_sync_pending', 503);
    return libraryPdfResponse(current, await libraryStoredPdf(env.QL_KV, record));
  }
  return libraryResult(request, paper, error, cached, retryAfter);
}
function libraryDownloadForm(doi) {
  // Same protected POST as /api/fulltext; the passphrase never appears in a URL.
  return '<form method="post" action="/api/fulltext?doi=' + pdfEscape(encodeURIComponent(doi)) + '"><p><label for="passphrase">全文口令</label><br><input id="passphrase" name="passphrase" type="password" maxlength="256" autocomplete="current-password" required autofocus></p><button type="submit">下载 PDF</button></form>';
}
function libraryResult(request, paper, error = '', cached = false, retryAfter = 0) {
  const status = paper.fulltextStatus;
  if (['manual_needed','review'].includes(status)) retryAfter = 0;
  const downloadUrl = status === 'available' ? '/api/fulltext?doi=' + encodeURIComponent(paper.doi) : '';
  if (!(request.headers.get('accept') || '').includes('text/html')) return libraryRetryResponse(json({ ok:true, paper, status, cached, archive:libraryArchiveStatus(), ...(error ? { error } : {}), ...(downloadUrl ? { downloadUrl } : libraryRetryInfo(retryAfter)) }, status === 'available' ? 200 : 202), retryAfter);
  const message = status === 'available' ? '全文已通过网站核验，可以下载。' : status === 'review' ? '题录已保留，全文来源关联需要核验，暂不提供下载。等待不代表核验会自动完成。' : '题录已保存，尚未取得可下载 PDF。题录保存不代表全文入库。';
  const action = status === 'manual_needed' ? '<p class="next">需要人工处理：当前没有可用的 PDF 来源，需维护者核对已有文件是否登记。订阅全文的机构授权执行桥尚未接通，等待或反复提交不会自动取得全文。维护者登记后，可用下方入口检查（只查已登记文件，不再向出版社下载）。</p><p><a href="/api/acquire/retry?doi=' + pdfEscape(encodeURIComponent(paper.doi)) + '">检查已登记的全文</a></p>' : status === 'review' ? '<p class="next">需维护者核验来源对应后再处理，无需重复提交。</p>' : libraryRetryHint(retryAfter) + libraryRetryLink(paper.doi);
  return libraryRetryResponse(pdfHtml('<p role="status">' + message + '</p><p>' + pdfEscape(paper.title) + '</p>' + (downloadUrl ? libraryDownloadForm(paper.doi) : action) + '<p>文件核验只确认 DOI、题名与页面完整，不代表医学审阅。</p>' + pdfOfficialLink(paper.doi), status === 'available' ? 200 : 202, '全文获取结果', paper.doi), retryAfter);
}
function libraryError(request, error, doi = '', route = '') {
  if (error instanceof PdfFailure) {
    if (error.code === 'pdf_passphrase_invalid' && doi && (request.headers.get('accept') || '').includes('text/html')) return libraryForm(doi, route, true);
    return pdfError(request, error.code, error.status, doi, error.diagnostic);
  }
  const code = error instanceof LibraryFailure ? error.code : 'library_server', status = error instanceof LibraryFailure ? error.status : 500;
  const retryAfter = error.retryAfter || (code === 'library_sync_pending' ? Date.now() + 60000 : 0);
  if (!(request.headers.get('accept') || '').includes('text/html')) return libraryRetryResponse(json({ ok:false, error:code, ...libraryRetryInfo(retryAfter), ...(PDF_REQUEST_DIAGNOSTICS.has(request) ? {diagnostic:sanitizePdfDiagnostic(error.diagnostic),diagnosticStatus:sanitizePdfDiagnostic(error.diagnostic) ? 'available' : 'unavailable'} : {}) }, status), retryAfter);
  const messages = { library_bad_doi:'请输入有效 DOI。', library_not_configured:'文献补录服务尚未完成配置。', library_disabled:'全文获取暂未启用。', library_storage:'文献存储暂时不可用，未确认入库成功。',
    grok_disabled:'后台机构获取尚未启用。', grok_not_configured:'后台机构获取尚未完成配置，请联系维护者。',
    grok_owner_conflict:'后台执行流程需要维护者确认，任务未重复派发。',
    library_not_found:'尚无可下载的全文，请先获取并加入文献库。', library_busy:'这篇文献的获取请求正在处理。', library_retry_later:'当前获取频率受限，请等待下方时间后再试。', library_limit:'本日按需获取次数已达到限制，额度重置后可再试。',
    library_metadata_unavailable:'暂未取得可核实的官方 DOI 题录，未入库。', muse_busy:'这篇已有 PDF 正在由 Muse 获取或等待网站核验，暂不接受重复上传。', muse_bad_pdf:'上传的文件不是完整的 PDF，或大小不在 50 KiB–10 MiB 之间。', muse_bad_request:'请通过网站页面提交。', library_identity:'DOI 或题名来源关联需要核验，暂不提供全文。', library_integrity:'已保存 PDF 的完整性校验未通过，暂不提供下载。', library_sync_pending:'全文存储仍在同步，请稍后重新下载。',
    library_paused:'来源要求授权、验证或已限制请求，获取已暂停。请维护者确认后恢复，或由已授权机构浏览器处理。', library_method:'请使用文献获取页面提交。', library_timeout:'获取全文超时，请稍后重试。', library_upstream:'文献来源暂时不可用，请稍后重试。', library_server:'文献获取服务暂时不可用。' };
  const retryable = ['library_not_found','library_busy','library_retry_later','library_limit','library_timeout','library_upstream','library_sync_pending'].includes(code);
  const retryHint = code === 'library_paused' && retryAfter ? '<p>上游返回 Retry-After，限制期限为北京时间 ' + new Date(retryAfter + 28800000).toISOString().slice(0,19).replace('T',' ') + '。到期不会自动恢复，仍需维护者确认。</p>' : retryAfter ? libraryRetryHint(retryAfter) : '';
  return libraryRetryResponse(pdfHtml('<p>' + pdfEscape(messages[code] || messages.library_server) + '</p>' + pdfDiagnosticHtml(error.diagnostic) + retryHint + (retryable ? libraryRetryLink(doi, code === 'library_sync_pending' ? route || '/api/fulltext' : '/api/acquire') : '') + pdfOfficialLink(doi), status, '全文服务提示', doi), retryAfter);
}
function librarySafeUrl(value, pdf = false) {
  let url; try { url = new URL(value); } catch { libraryFail('library_identity', 409); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || host.includes(':') || /^\d+(?:\.\d+)*$/.test(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test|lan|home|onion)$/.test(host)) libraryFail('library_identity', 409);
  if (pdf ? !LIBRARY_PDF_HOSTS.some(trusted => host === trusted || host.endsWith('.' + trusted)) : !['api.crossref.org','api.openalex.org','api.unpaywall.org'].includes(host)) libraryFail('library_identity', 409);
  return url;
}
async function libraryRead(value, context, pdf = false) {
  const controller = new AbortController(), abort = () => controller.abort();
  const diagnostic = context.diagnostic;
  pdfDiagnosticStage(diagnostic,'metadata');
  let phase = 'headers', reader;
  if (context.signal.aborted) { if (diagnostic) diagnostic.reason = 'total_timeout'; throw pdfAttachDiagnostic(new LibraryFailure('library_timeout',504),diagnostic); }
  context.signal.addEventListener('abort', abort, { once:true });
  const timer = setTimeout(abort, PDF_NETWORK_TIMEOUT_MS);
  let response;
  try {
    if (diagnostic) diagnostic.reason = 'identity';
    let url = librarySafeUrl(value, pdf);
    for (let hop = 0; hop <= 3; hop++) {
      response = await awaitAbort(fetch(url.href, { method:'GET', redirect:'manual', signal:controller.signal, headers:{ accept:pdf ? 'application/pdf, application/octet-stream' : 'application/json', 'user-agent':'XinZhiDoiLibrary/1.0' } }),controller.signal,'library_timeout');
      if (diagnostic) { diagnostic.httpStatus = response.status; diagnostic.reason = 'http_error'; }
      if (![301,302,303,307,308].includes(response.status)) break;
      if (diagnostic) diagnostic.reason = 'redirect';
      const location = response.headers.get('location');
      if (!location || hop === 3) libraryFail('library_identity', 409);
      if (response.body) pdfCancel(response.body);
      url = librarySafeUrl(new URL(location, url).href, pdf);
    }
    if (!response.ok) { if (response.body) pdfCancel(response.body); libraryFail([401,403,429].includes(response.status) ? 'library_paused' : response.status === 404 ? 'library_metadata_unavailable' : 'library_upstream', [401,403,429].includes(response.status) ? 423 : response.status === 404 ? 404 : 502, [429,503].includes(response.status) ? libraryUpstreamRetry(response) : 0); }
    if (diagnostic) diagnostic.reason = 'identity';
    if (pdf && /^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) libraryFail('library_paused', 423);
    if (pdf && !/^(?:application\/(?:pdf|octet-stream))(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) libraryFail('library_identity', 409);
    const limit = pdf ? LIBRARY_MAX_PDF_BYTES : 1024 * 1024, declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) { if (diagnostic) diagnostic.reason = /^\d+$/.test(declared) ? 'size_limit' : 'identity'; libraryFail('library_identity', 409); }
    reader = response.body && response.body.getReader(); if (!reader) { if (diagnostic) diagnostic.reason = 'no_body'; libraryFail('library_upstream'); }
    phase = 'body'; if (diagnostic) diagnostic.reason = 'network';
    const chunks = []; let length = 0;
    while (true) {
      const result = await awaitAbort(reader.read(),controller.signal,'library_timeout'); if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) { if (diagnostic) diagnostic.reason = 'size_limit'; pdfCancel(reader); libraryFail('library_identity', 409); }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (pdf) return bytes;
    if (diagnostic) diagnostic.reason = 'parse';
    try { return JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes)); } catch { libraryFail('library_upstream'); }
  } catch (error) {
    pdfCancel(reader);
    if (response && response.body && !response.body.locked) pdfCancel(response.body);
    let failure = error;
    if (context.signal.aborted) { if (diagnostic) diagnostic.reason = 'total_timeout'; failure = new LibraryFailure('library_timeout',504); }
    else if (controller.signal.aborted) {
      if (diagnostic) { diagnostic.reason = phase === 'body' ? 'body_timeout' : 'header_timeout'; if (phase === 'body') { diagnostic.stage = 'body_timeout'; diagnostic.sourceStage = 'metadata'; } }
      failure = new LibraryFailure('library_timeout',504);
    } else if (!(error instanceof LibraryFailure)) { if (diagnostic) diagnostic.reason = 'network'; failure = new LibraryFailure('library_upstream',502); }
    throw pdfAttachDiagnostic(failure,diagnostic);
  } finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); controller.abort(); }
}
function libraryPublication(message) {
  for (const [field, label] of [['published-online','Crossref published-online'],['published-print','Crossref published-print'],['published','Crossref published']]) {
    const parts = message[field] && message[field]['date-parts'] && message[field]['date-parts'][0];
    if (!Array.isArray(parts) || !parts.length || parts.length > 3 || parts.some(n => !Number.isInteger(n))) continue;
    const [year, month, day] = parts;
    if (year < 1600 || year > 2200 || (month !== undefined && (month < 1 || month > 12)) || (day !== undefined && (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()))) continue;
    return { date:parts.map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-'), datePrecision:['year','month','day'][parts.length - 1], dateBasis:label };
  }
  return { date:'', datePrecision:'', dateBasis:'发表日期未知' };
}
async function libraryMetadata(doi, context) {
  delete context.crossrefPdfSource; // Source links are request-local and cannot survive a new DOI lookup.
  const payload = await libraryRead('https://api.crossref.org/works/' + encodeURIComponent(doi), context);
  const message = payload && payload.message;
  if (context.diagnostic) context.diagnostic.reason = 'identity';
  if (!message || libraryDoi(message.DOI) !== doi || !Array.isArray(message.title) || !libraryText(message.title[0])) libraryFail('library_identity', 409);
  const urls = new Set();
  for (const link of Array.isArray(message.link) ? message.link : []) {
    if (!link || typeof link['content-type'] !== 'string' || link['content-type'].trim().toLowerCase() !== 'application/pdf') continue;
    try { urls.add(librarySafeUrl(link.URL, true).href); } catch { continue; }
    if (urls.size === 3) break;
  }
  if (urls.size) context.crossrefPdfSource = { doi, urls:[...urls] };
  return { id:'doi-' + (await pdfDigest('SHA-256', new TextEncoder().encode(doi))).slice(0, 16), doi, title:libraryText(message.title[0]), journal:libraryText((message['container-title'] || [])[0] || '', 300),
    authors:(Array.isArray(message.author) ? message.author : []).slice(0, 30).map(author => libraryText([author && author.given, author && author.family].filter(Boolean).join(' '), 200)).filter(Boolean),
    url:'https://doi.org/' + encodeURIComponent(doi).replace(/%2F/gi, '/'), ...libraryPublication(message), ingestedAt:new Date().toISOString(), metadataStatus:'external_bibliography_checked', fulltextStatus:'pending' };
}
function libraryValidatePdf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > LIBRARY_MAX_PDF_BYTES || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-' || !/%%EOF\s*$/.test(new TextDecoder().decode(bytes.slice(-1024)))) libraryFail('library_identity', 409);
}
async function libraryGithub(paper, env, context) {
  const diagnostic = context.diagnostic;
  pdfDiagnosticStage(diagnostic,'configuration','configuration');
  try {
  const decision = DOI_ADJUDICATIONS.decisions && DOI_ADJUDICATIONS.decisions[paper.doi];
  if (decision && decision.action === 'hold') return null; // Known wrong bindings never become a PDF candidate.
  const token = env.GITHUB_LIBRARY_TOKEN;
  if (typeof token !== 'string' || !token.trim()) libraryFail('library_not_configured', 503);
  let commit = env.DOI_LOOKUP_LATEST_MAIN === 'true' ? '' : env.PDF_GITHUB_COMMIT;
  if (!commit) { const latest = pdfDiagnosticJson(diagnostic, await pdfRead('https://api.github.com/repos/' + PDF_REPOSITORY + '/commits/main', 262144, { token, signal:context.signal, pauseOnDenied:true,diagnostic,stage:'configuration' })); commit = latest && latest.sha; }
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/i.test(commit)) libraryFail('library_not_configured', 503);
  commit = commit.toLowerCase();
  const indexBytes = await pdfRead(pdfContentsUrl(PDF_INDEX_PATH, commit), PDF_MAX_INDEX_BYTES, { token, signal:context.signal, pauseOnDenied:true, diagnostic,stage:'index',accept:'application/vnd.github.raw+json', rawPath:pdfRawPath(PDF_INDEX_PATH, commit) });
  if (diagnostic) diagnostic.reason = 'parse';
  const entries = pdfCsv(indexBytes);
  if (diagnostic) diagnostic.reason = 'identity';
  const rows = entries.filter(row => libraryDoi(row.DOI) === paper.doi);
  const inspection = { resolvedCommit:commit,indexRowCount:entries.length,doiMatches:rows.length,indexSha256:await pdfDigest('SHA-256',indexBytes),pdfObjectRead:false };
  let incremental = false, deltaBytes = 0;
  if (!rows.length && env.DOI_GITHUB_DELTA_ENABLED === 'true') {
    const deltaPath = '文献索引/按需全文增量.json';
    let delta;
    try { delta = pdfDiagnosticJson(diagnostic, await pdfRead(pdfContentsUrl(deltaPath, commit), 262144, { token, signal:context.signal, pauseOnDenied:true, file:true, diagnostic,stage:'index',accept:'application/vnd.github.raw+json', rawPath:pdfRawPath(deltaPath, commit) })); }
    catch (error) { if (error.code !== 'pdf_not_found') throw error; }
    if (delta) {
      if (delta.version !== 1 || !Array.isArray(delta.entries) || delta.entries.length > 200) libraryFail('library_identity', 409);
      const matches = delta.entries.filter(entry => entry && libraryDoi(entry.doi) === paper.doi);
      if (matches.length > 1) libraryFail('library_identity', 409);
      if (matches.length) {
        const entry = matches[0], proof = entry.verification;
        if (entry.doi !== paper.doi || pdfTitle(entry.title) !== pdfTitle(paper.title) || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
            || !Number.isInteger(entry.bytes) || entry.bytes < 8 || entry.bytes > LIBRARY_MAX_PDF_BYTES || !proof || proof.verified !== true
            || proof.method !== 'dual_parser_all_pages_title_doi' || !Number.isInteger(proof.pages) || proof.pages < 1
            || proof.sha256 !== entry.sha256 || proof.bytes !== entry.bytes) libraryFail('library_identity', 409);
        rows.push({ DOI:entry.doi, '题名':entry.title, '当前路径':pdfSafePath(entry.path), SHA256:entry.sha256 }); incremental = true; deltaBytes = entry.bytes;
      }
    }
  }
  if (!rows.length) return context.metadataOnly ? {...inspection,candidateFound:false} : null; // An index miss is not evidence that no file exists elsewhere.
  if (rows.length !== 1) libraryFail('library_identity', 409);
  const row = rows[0], title = pdfTitle(row['题名']);
  const accepted = decision && decision.action === 'official' && DOI_ADJUDICATIONS.sourceCommit === commit ? decision.acceptedTitles : [paper.title];
  if (!Array.isArray(accepted) || !accepted.some(value => pdfTitle(value) === title) || (decision && decision.action === 'official' && DOI_ADJUDICATIONS.sourceCommit === commit && pdfTitle(decision.metadata && decision.metadata.title) !== pdfTitle(paper.title))) libraryFail('library_identity', 409);
  const path = pdfSafePath(row['当前路径']), checksum = row.SHA256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) libraryFail('library_identity', 409);
  if (context.metadataOnly) return {...inspection,candidateFound:true,source:incremental ? 'github_delta' : 'github'};
  const endpoint = pdfContentsUrl(path, commit), metadata = pdfDiagnosticJson(diagnostic, await pdfRead(endpoint, 2 * 1024 * 1024, { token, signal:context.signal, pauseOnDenied:true, file:true, diagnostic,stage:'contents_metadata',accept:'application/vnd.github+json' }));
  if (diagnostic) diagnostic.reason = 'identity';
  if (!metadata || metadata.type !== 'file' || metadata.path !== path || metadata.target || metadata.submodule_git_url || !/^[a-f0-9]{40}$/i.test(metadata.sha || '') || !Number.isInteger(metadata.size) || metadata.size < 8 || metadata.size > LIBRARY_MAX_PDF_BYTES) libraryFail('library_identity', 409);
  const raw = await pdfRead(endpoint, LIBRARY_MAX_PDF_BYTES, { token, signal:context.signal, pauseOnDenied:true, file:true, diagnostic,stage:'contents_raw',accept:'application/vnd.github.raw+json', rawPath:pdfRawPath(path, commit) });
  const bytes = await pdfGithubBytes(metadata, raw, checksum, { token, signal:context.signal, pauseOnDenied:true, diagnostic,limit:LIBRARY_MAX_PDF_BYTES, ...(incremental ? {expectedSize:deltaBytes} : {}) });
  libraryValidatePdf(bytes);
  return { bytes, source:incremental ? 'github_delta' : 'github', commit };
  } catch (error) { throw pdfAttachDiagnostic(error,diagnostic); }
}
async function libraryOa(paper, context) {
  let review = false, unavailable = false, retryAfter = 0, diagnostic = null;
  if (context.metadataOnly) return { review, unavailable, retryAfter, diagnostic };
  const candidates = [], seen = new Set();
  let oaCandidates = 0;
  const add = value => { if (typeof value === 'string' && !seen.has(value) && oaCandidates < 3) { seen.add(value); candidates.push(value); oaCandidates++; } };
  const authoritative = context.crossrefPdfSource;
  if (authoritative && authoritative.doi === paper.doi && Array.isArray(authoritative.urls)) {
    // A publisher PDF explicitly registered under the verified Crossref DOI remains
    // usable when a secondary OA catalogue still carries an earlier article title.
    for (const candidate of authoritative.urls.slice(0, 3)) {
      if (typeof candidate !== 'string' || seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const bytes = await libraryRead(candidate, context, true);
        if (bytes.length < 50 * 1024) libraryFail('library_identity', 409);
        libraryValidatePdf(bytes);
        return { bytes, source:'crossref' };
      } catch (error) {
        diagnostic = sanitizePdfDiagnostic(pdfAttachDiagnostic(error,context.diagnostic).diagnostic) || diagnostic;
        if (context.signal.aborted || error.code === 'library_paused') throw error;
        review = review || error.code === 'library_identity';
        unavailable = unavailable || ['library_upstream','library_timeout'].includes(error.code);
        retryAfter = Math.max(retryAfter, error.retryAfter || 0);
      }
    }
  }
  try {
    const data = await libraryRead('https://api.unpaywall.org/v2/' + encodeURIComponent(paper.doi) + '?email=shijunxia1988%40gmail.com', context);
    if (libraryDoi(data.doi) !== paper.doi || pdfTitle(data.title) !== pdfTitle(paper.title)) review = true;
    else if (data.is_oa === true) { add(data.best_oa_location && data.best_oa_location.url_for_pdf); for (const location of (Array.isArray(data.oa_locations) ? data.oa_locations : []).slice(0, 10)) add(location.url_for_pdf); }
  } catch (error) { diagnostic = sanitizePdfDiagnostic(pdfAttachDiagnostic(error,context.diagnostic).diagnostic) || diagnostic; if (context.signal.aborted || error.code === 'library_paused') throw error; review = review || error.code === 'library_identity'; unavailable = unavailable || ['library_upstream','library_timeout'].includes(error.code); retryAfter = Math.max(retryAfter, error.retryAfter || 0); }
  for (const provider of [0, 1]) {
    if (provider) {
      try {
        const data = await libraryRead('https://api.openalex.org/works/doi:' + encodeURIComponent(paper.doi) + '?select=doi,title,open_access,best_oa_location,locations&mailto=shijunxia1988%40gmail.com', context);
        if (libraryDoi(data.doi) !== paper.doi || pdfTitle(data.title) !== pdfTitle(paper.title)) review = true;
        else if (data.open_access && data.open_access.is_oa === true) {
          const locations = [data.best_oa_location, ...(Array.isArray(data.locations) ? data.locations : []).slice(0, 10)];
          for (const location of locations) if (location && location.is_oa === true) add(location.pdf_url);
        }
      } catch (error) { diagnostic = sanitizePdfDiagnostic(pdfAttachDiagnostic(error,context.diagnostic).diagnostic) || diagnostic; if (context.signal.aborted || error.code === 'library_paused') throw error; review = review || error.code === 'library_identity'; unavailable = unavailable || ['library_upstream','library_timeout'].includes(error.code); retryAfter = Math.max(retryAfter, error.retryAfter || 0); }
    }
    for (const candidate of candidates.splice(0)) {
      try { const bytes = await libraryRead(candidate, context, true); libraryValidatePdf(bytes); return { bytes, source:'oa' }; }
      catch (error) { diagnostic = sanitizePdfDiagnostic(pdfAttachDiagnostic(error,context.diagnostic).diagnostic) || diagnostic; if (context.signal.aborted || error.code === 'library_paused') throw error; review = review || error.code === 'library_identity'; unavailable = unavailable || ['library_upstream','library_timeout'].includes(error.code); retryAfter = Math.max(retryAfter, error.retryAfter || 0); }
    }
  }
  return { review, unavailable, retryAfter, diagnostic };
}
async function librarySoftGate(kv, request, doi, manualOnly = false) {
  const now = Date.now(), lockKey = 'library:lock:' + doi, lock = await libraryGet(kv, lockKey);
  if (libraryLocalActive.has(doi) || (lock && lock.until > now)) libraryFail('library_busy', 409, lock && lock.until > now ? lock.until : now + LIBRARY_TASK_MS + 15000);
  const attempt = await libraryGet(kv, 'library:attempt:' + doi);
  if (attempt && attempt.paused === true) libraryFail('library_paused', 423, attempt.retryAfter || 0);
  if (attempt && attempt.retryAfter > now && !(manualOnly && attempt.error === 'library_metadata_unavailable')) libraryFail('library_retry_later', 429, attempt.retryAfter);
  const day = new Date(now).toISOString().slice(0, 10), ip = request.headers.get('cf-connecting-ip') || 'unknown';
  for (const [key, limit] of [['library:cap:' + day, 30], ['library:ip:' + day + ':' + (await pdfDigest('SHA-256', new TextEncoder().encode(ip))).slice(0, 16), 20]]) {
    const count = await libraryGet(kv, key), n = Number.isInteger(count) && count >= 0 ? count : 0;
    if (n >= limit) libraryFail('library_limit', 429, Date.parse(day) + 86400000);
    await libraryPut(kv, key, JSON.stringify(n + 1), { expirationTtl:172800 });
  }
  if (libraryLocalActive.has(doi)) libraryFail('library_busy', 409, now + LIBRARY_TASK_MS + 15000);
  const owner = crypto.randomUUID();
  libraryLocalActive.add(doi);
  try { await libraryPut(kv, lockKey, JSON.stringify({ owner, until:now + LIBRARY_TASK_MS + 15000 }), { expirationTtl:90 }); }
  catch (error) { libraryLocalActive.delete(doi); throw error; }
  return async () => { libraryLocalActive.delete(doi); try { const current = await kv.get(lockKey, 'json'); if (current && current.owner === owner) await kv.delete(lockKey); } catch { /* Best effort: KV locks/caps are advisory, not atomic. */ } };
}
async function libraryStoredPdf(kv, record) {
  let value; try { value = await kv.get(record.pdf.key, 'arrayBuffer'); } catch { libraryFail('library_storage', 503); }
  if (!value) libraryFail('library_sync_pending', 503);
  const bytes = new Uint8Array(value);
  if (bytes.length !== record.pdf.size) libraryFail('library_integrity', 502);
  try { libraryValidatePdf(bytes); } catch { libraryFail('library_integrity', 502); }
  if (await pdfDigest('SHA-256', bytes) !== record.pdf.sha256) libraryFail('library_integrity', 502);
  return bytes;
}
async function librarySave(kv, paper, fetched, error, sourceRetryAfter = 0) {
  if (paper.fulltextStatus === 'pending') paper = { ...paper, fulltextReason:'temporary' };
  const key = LIBRARY_PREFIX + paper.doi;
  const current = await libraryGet(kv, key), ready = libraryPaper(current, paper.doi);
  if (ready && ready.fulltextStatus === 'available') { await libraryStoredPdf(kv, current); return { paper:ready }; } // A failed/slow attempt must not overwrite observed success.
  let pdf;
  if (fetched && fetched.bytes) {
    const checksum = await pdfDigest('SHA-256', fetched.bytes), blobKey = 'library:pdf:' + checksum;
    await libraryPut(kv, blobKey, fetched.bytes.buffer.slice(fetched.bytes.byteOffset, fetched.bytes.byteOffset + fetched.bytes.byteLength));
    pdf = { key:blobKey, sha256:checksum, size:fetched.bytes.length, source:fetched.source, ...(fetched.commit ? { commit:fetched.commit } : {}) };
    paper = { ...paper, fulltextStatus:'available' };
  }
  const latestRecord = await libraryGet(kv, key), latest = libraryPaper(latestRecord, paper.doi);
  if (latest && latest.fulltextStatus === 'available') { await libraryStoredPdf(kv, latestRecord); return { paper:latest }; }
  await libraryPut(kv, key, JSON.stringify({ version:1, paper, ...(pdf ? { pdf } : {}) }));
  libraryCatalogCache.clear();
  const retryAfter = paper.fulltextStatus === 'pending' ? sourceRetryAfter || Date.now() + LIBRARY_RETRY_SECONDS * 1000 : 0;
  const priorAttempt = paper.fulltextStatus !== 'available' ? await libraryGet(kv, 'library:attempt:' + paper.doi) : null;
  if (paper.fulltextStatus !== 'available' && !(priorAttempt && priorAttempt.paused)) await libraryPut(kv, 'library:attempt:' + paper.doi, JSON.stringify({ status:paper.fulltextStatus, error, retryAfter }), retryAfter ? { expirationTtl:600 } : undefined);
  return { paper:libraryPaper({ version:1, paper, ...(pdf ? { pdf } : {}) }, paper.doi), retryAfter };
}
async function handleLibrary(request, env) {
  try {
    if (request.method !== 'GET') libraryFail('library_method', 405);
    if (!env.QL_KV) libraryFail('library_not_configured', 503);
    const url = new URL(request.url);
    if (url.searchParams.has('doi')) {
      const { doi } = libraryQuery(request), paper = libraryPaper(await libraryGet(env.QL_KV, LIBRARY_PREFIX + doi), doi);
      if (paper && paper.fulltextStatus === 'available') return json({ ok:true, found:true, paper, status:paper.fulltextStatus,paused:false });
      const attempt = await libraryGet(env.QL_KV, 'library:attempt:' + doi);
      const job = env.MUSE_FULLTEXT_ENABLED === 'true' ? musePublicJob(await libraryGet(env.QL_KV,MUSE_JOB_PREFIX + doi),doi)
        : env.GROK_FULLTEXT_ENABLED === 'true' && env.FULLTEXT_ASYNC_ENABLED !== 'true'
        ? grokPublicJob(await libraryGet(env.QL_KV,GROK_JOB_PREFIX + doi),doi)
        : env.FULLTEXT_ASYNC_ENABLED === 'true' ? fulltextPublicJob(await libraryGet(env.QL_KV, FULLTEXT_JOB_PREFIX + doi), doi) : null;
      const inProgress = job && (['queued','running'].includes(job.state) || job.stage === 'verifying');
      // A previous no-source attempt is not an error in the current acquisition.
      const publicAttempt = inProgress && !attempt?.paused ? {paused:false} : libraryAttemptPublic(attempt);
      if (paper) { const observed = libraryObservedPaper(paper, attempt, job); return json({ ok:true, found:true, paper:observed, status:observed.fulltextStatus, ...(!inProgress && observed.fulltextStatus === 'pending' && attempt && !attempt.paused ? libraryRetryInfo(attempt.retryAfter) : {}), ...publicAttempt, ...(job ? { job } : {}) }); }
      return json({ ok:true, found:false, ...publicAttempt, ...(!inProgress && attempt && attempt.status === 'pending' && !attempt.paused ? libraryRetryInfo(attempt.retryAfter) : {}), ...(job ? { job } : {}), ...(!inProgress && attempt && ['pending','review'].includes(attempt.status) ? { status:attempt.status } : {}) });
    }
    if ([...url.searchParams.keys()].some(key => !['cursor','limit'].includes(key)) || url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1) libraryFail('library_bad_doi', 400);
    const cursor = url.searchParams.get('cursor') || '', rawLimit = url.searchParams.get('limit') || '20';
    if (cursor.length > 2000 || /[\x00-\x1f]/.test(cursor) || !/^\d{1,2}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 20) libraryFail('library_bad_doi', 400);
    const cacheKey = rawLimit + ':' + cursor, cachedPage = libraryCatalogCache.get(cacheKey);
    if (cachedPage && cachedPage.kv === env.QL_KV && cachedPage.until > Date.now()) return json(cachedPage.payload);
    let listing; try { listing = await env.QL_KV.list({ prefix:LIBRARY_PREFIX, limit:Number(rawLimit), ...(cursor ? { cursor } : {}) }); } catch { libraryFail('library_storage', 503); }
    if (!listing || !Array.isArray(listing.keys) || listing.keys.length > 20) libraryFail('library_storage', 503);
    let papers = (await Promise.all(listing.keys.map(key => typeof key.name === 'string' && key.name.startsWith(LIBRARY_PREFIX) ? libraryGet(env.QL_KV, key.name).then(record => libraryPaper(record, key.name.slice(LIBRARY_PREFIX.length))) : null))).filter(Boolean);
    const jobs = env.MUSE_FULLTEXT_ENABLED === 'true' ? (await Promise.all(papers.map(paper => musePublicJobValue(env,paper.doi)))).filter(Boolean) : [];
    const byDoi = new Map(jobs.map(job => [job.doi,job]));
    papers = papers.map(paper => byDoi.has(paper.doi) ? libraryObservedPaper(paper,null,byDoi.get(paper.doi)) : paper);
    const payload = { ok:true, papers, ...(jobs.length ? {jobs} : {}), ...(!listing.list_complete && typeof listing.cursor === 'string' ? { cursor:listing.cursor } : {}) };
    if (libraryCatalogCache.size >= 50) libraryCatalogCache.clear();
    libraryCatalogCache.set(cacheKey, { payload, kv:env.QL_KV, until:Date.now() + 30000 });
    return json(payload);
  } catch (error) { return libraryError(request, error); }
}
function fulltextJobRecord(value, doi = '') {
  if (!value || value.version !== 1 || libraryDoi(value.doi) !== value.doi || (doi && value.doi !== doi)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id || '') || !['queued','running','available','pending','review','failed','manual_needed'].includes(value.state)
      || ![value.createdAt,value.updatedAt,value.nextAttemptAt].every(n => Number.isSafeInteger(n) && n >= 0 && n < 8640000000000000 - 28800000)
      || !Number.isInteger(value.attempts) || value.attempts < 0 || value.attempts > 3
      || (value.state === 'running' && (!/^\d{1,20}$/.test(value.owner || '') || !Number.isSafeInteger(value.leaseUntil) || !/^[a-f0-9-]{36}$/.test(value.leaseId || '')))
      || value.queueKey !== FULLTEXT_QUEUE_PREFIX + String(value.createdAt).padStart(13, '0') + ':' + value.id) return null;
  return value;
}
function fulltextJobActive(job) {
  return !!job && ['queued','running'].includes(job.state) && (Date.now() - job.createdAt < FULLTEXT_JOB_LIFETIME_MS || (job.state === 'running' && job.leaseUntil > Date.now()));
}
function fulltextPublicJob(record, doi = '') {
  const job = fulltextJobRecord(record, doi);
  if (!job) return null;
  const state = ['queued','running'].includes(job.state) && !fulltextJobActive(job) ? 'failed' : job.state;
  const messages = { queued:job.attempts ? '来源暂时不可用，已安排自动重试。' : '已排队，等待后台获取全文。', running:'后台正在获取全文。',
    available:'全文已取得，可下载。', pending:'后台已完成查询，目前未找到可获取的 PDF。', manual_needed:'题录已保存，尚无可用 PDF 来源；请核对已有文件是否登记及网站读取版本，需要人工处理。等待不会自动获取。', review:'全文来源对应需要核验，暂不提供下载。',
    failed:job.reason === 'library_paused' ? '来源要求授权、验证或已限流，任务暂停；需人工处理后恢复。' : job.reason === 'library_metadata_unavailable' ? '未能核实官方 DOI 题录，未新增文献。' : '后台未能完成获取，请稍后重新提交。' };
  return { id:job.id, doi:job.doi, state, attempts:job.attempts, createdAt:new Date(job.createdAt).toISOString(), updatedAt:new Date(job.updatedAt).toISOString(),
    message:messages[state], ...(['queued','running'].includes(state) ? { nextCheckSeconds:15 } : {}), ...(state === 'queued' && job.nextAttemptAt > Date.now() ? { nextAttemptAt:new Date(job.nextAttemptAt).toISOString() } : {}) };
}
function fulltextJobResponse(request, record, paper = null) {
  const job = fulltextPublicJob(record, record.doi), active = ['queued','running'].includes(job.state);
  if (paper && paper.fulltextStatus === 'available') return libraryResult(request, paper, '', true);
  if (paper && paper.fulltextStatus === 'manual_needed' && !active) return libraryResult(request, paper, 'library_manual_needed');
  const url = '/api/acquire?doi=' + encodeURIComponent(record.doi);
  if (!(request.headers.get('accept') || '').includes('text/html')) return json({ ok:true, status:job.state, job, ...(paper ? { paper } : {}), statusUrl:url }, active ? 202 : 200, active ? { 'retry-after':'15' } : {});
  const next = job.nextAttemptAt ? '<p>下一次自动尝试不早于北京时间 ' + new Date(record.nextAttemptAt + 28800000).toISOString().slice(0,19).replace('T',' ') + '，实际开始时间可能延迟。</p>' : '';
  const waiting = active ? '<p>后台约每 5 分钟检查下载队列，开始时间可能延迟。任务开始后通常需几十秒。无需保持页面打开，回来后仍可查看结果。</p>' + next + '<p>本页每 15 秒只更新状态，不会重复提交下载。</p><meta http-equiv="refresh" content="15;url=' + pdfEscape(url) + '">' : job.state === 'pending' ? '<p>题录已保存。来源未提供可访问的全文时，后台也无法取得 PDF；可前往官网原文查看。</p>' : '';
  const link = active ? '<p><a href="' + pdfEscape(url) + '">刷新任务状态</a></p>' : libraryRetryLink(record.doi, '/api/acquire/retry');
  const view = '/?mode=library&q=' + encodeURIComponent(record.doi);
  return pdfHtml('<p role="status">' + pdfEscape(job.message) + '</p><p>' + pdfEscape(paper ? paper.title : record.doi) + '</p>' + waiting + link
    + '<p><a href="' + pdfEscape(view) + '">在文献库查看</a></p>' + pdfOfficialLink(record.doi), active ? 202 : 200, '全文下载任务');
}
async function fulltextEnqueue(request, env, doi, paper) {
  let job = fulltextJobRecord(await libraryGet(env.QL_KV, FULLTEXT_JOB_PREFIX + doi), doi);
  if (fulltextJobActive(job)) return fulltextJobResponse(request, job, paper);
  const release = await librarySoftGate(env.QL_KV, request, doi);
  try {
    job = fulltextJobRecord(await libraryGet(env.QL_KV, FULLTEXT_JOB_PREFIX + doi), doi);
    if (fulltextJobActive(job)) return fulltextJobResponse(request, job, paper);
    const now = Date.now(), id = crypto.randomUUID();
    job = { version:1, id, doi, state:'queued', attempts:0, createdAt:now, updatedAt:now, nextAttemptAt:now,
      queueKey:FULLTEXT_QUEUE_PREFIX + String(now).padStart(13, '0') + ':' + id };
    // Save the queue pointer first. If the job write fails, the worker discards its orphan pointer.
    await libraryPut(env.QL_KV, job.queueKey, JSON.stringify({ id, doi }), { expirationTtl:172800 });
    await libraryPut(env.QL_KV, FULLTEXT_JOB_PREFIX + doi, JSON.stringify(job), { expirationTtl:604800 });
    return fulltextJobResponse(request, job, paper);
  } finally { await release(); }
}
function fulltextJwtPart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value || '')) libraryFail('job_auth', 401);
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
  catch { libraryFail('job_auth', 401); }
}
async function fulltextJobAuthorize(request, policy = {audience:FULLTEXT_OIDC_AUDIENCE,workflow:FULLTEXT_WORKFLOW_REF,events:['schedule','workflow_dispatch','push']}) {
  const auth = request.headers.get('authorization') || '';
  if (auth.length > 16000 || !auth.startsWith('Bearer ')) libraryFail('job_auth', 401);
  const parts = auth.slice(7).split('.');
  if (parts.length !== 3) libraryFail('job_auth', 401);
  let header, claims;
  try { header = JSON.parse(new TextDecoder().decode(fulltextJwtPart(parts[0]))); claims = JSON.parse(new TextDecoder().decode(fulltextJwtPart(parts[1]))); }
  catch { libraryFail('job_auth', 401); }
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(header.kid)
      || claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== policy.audience
      || claims.repository !== 'dodoxiaxia/xinzhi' || String(claims.repository_id) !== '1397425558'
      || !FULLTEXT_OIDC_SUBJECTS.includes(claims.sub) || claims.ref !== 'refs/heads/main'
      || claims.workflow_ref !== policy.workflow || claims.runner_environment !== 'github-hosted'
      || !policy.events.includes(claims.event_name) || !/^\d{1,20}$/.test(claims.run_id || '')
      || !Number.isInteger(claims.exp) || !Number.isInteger(claims.iat) || !Number.isInteger(claims.nbf)
      || claims.exp <= now || claims.exp > now + 600 || claims.iat > now + 30 || claims.iat < now - 600 || claims.nbf > now + 30) libraryFail('job_auth', 401);
  if (!fulltextOidcKeys || fulltextOidcKeys.until < Date.now() || !fulltextOidcKeys.keys.some(k => k.kid === header.kid)) {
    const published = FULLTEXT_OIDC_BUILD_KEYS;
    if (Number.isSafeInteger(published.expiresAt) && Number.isSafeInteger(published.fetchedAt) && published.fetchedAt <= Date.now() + 30000
        && published.expiresAt > Date.now() && published.expiresAt - published.fetchedAt === 86400000
        && Array.isArray(published.keys) && published.keys.some(k => k.kid === header.kid)) {
      fulltextOidcKeys = {keys:published.keys,until:Math.min(published.expiresAt,Date.now() + 600000)};
    } else {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('https://token.actions.githubusercontent.com/.well-known/jwks', { method:'GET', redirect:'manual', signal:controller.signal, headers:{ accept:'application/json','user-agent':'XinZhiFulltextOIDC/1.0' } });
      if (!response.ok) libraryFail('job_auth_unavailable', 503);
      const text = await response.text();
      if (text.length > 65536) libraryFail('job_auth_unavailable', 503);
      const payload = JSON.parse(text);
      if (!Array.isArray(payload.keys) || payload.keys.length > 20) libraryFail('job_auth_unavailable', 503);
      fulltextOidcKeys = { keys:payload.keys.filter(k => k.kty === 'RSA' && k.alg === 'RS256' && k.use === 'sig'), until:Date.now() + 600000 };
    } catch (error) { if (error instanceof LibraryFailure) throw error; libraryFail('job_auth_unavailable', 503); }
    finally { clearTimeout(timer); }
    }
  }
  const jwk = fulltextOidcKeys.keys.find(k => k.kid === header.kid);
  if (!jwk) libraryFail('job_auth', 401);
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fulltextJwtPart(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) libraryFail('job_auth', 401);
  } catch { libraryFail('job_auth', 401); }
  return claims.run_id;
}
async function fulltextJobInput(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) libraryFail('job_bad_request', 400);
  const reader = request.body && request.body.getReader();
  if (!reader) libraryFail('job_bad_request', 400);
  const chunks = []; let size = 0;
  while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 1024) { await reader.cancel(); libraryFail('job_bad_request', 413); } chunks.push(item.value); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let input; try { input = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes)); } catch { libraryFail('job_bad_request', 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['claim','run'].includes(input.action)
      || Object.keys(input).some(k => !(input.action === 'claim' ? ['action'] : ['action','doi','id','leaseId']).includes(k))
      || (input.action === 'run' && (!libraryDoi(input.doi) || input.doi !== libraryDoi(input.doi) || !/^[a-f0-9-]{36}$/.test(input.id || '') || !/^[a-f0-9-]{36}$/.test(input.leaseId || '')))) libraryFail('job_bad_request', 400);
  return input;
}
async function fulltextClaim(env, owner) {
  let cursor;
  // Bound KV operations even when every listed task needs expiration cleanup.
  for (let page = 0; page < 2; page++) {
    let listing; try { listing = await env.QL_KV.list({ prefix:FULLTEXT_QUEUE_PREFIX, limit:5, ...(cursor ? { cursor } : {}) }); } catch { libraryFail('library_storage', 503); }
    if (!listing || !Array.isArray(listing.keys) || listing.keys.length > 5) libraryFail('library_storage', 503);
    for (const entry of listing.keys) {
      if (typeof entry.name !== 'string' || !entry.name.startsWith(FULLTEXT_QUEUE_PREFIX)) continue;
      const pointer = await libraryGet(env.QL_KV, entry.name);
      if (!pointer || !libraryDoi(pointer.doi)) continue;
      const job = fulltextJobRecord(await libraryGet(env.QL_KV, FULLTEXT_JOB_PREFIX + pointer.doi), pointer.doi);
      if (!job || job.id !== pointer.id || job.queueKey !== entry.name) {
        // KV can expose the pointer before the job record; allow propagation before cleanup.
        const createdAt = Number(entry.name.slice(FULLTEXT_QUEUE_PREFIX.length).split(':')[0]);
        if (Number.isSafeInteger(createdAt) && Date.now() - createdAt > 300000) await env.QL_KV.delete(entry.name);
        continue;
      }
      if (!['queued','running'].includes(job.state)) { await env.QL_KV.delete(entry.name); continue; }
      const now = Date.now();
      if (job.state === 'running' && job.leaseUntil > now) continue;
      if (!fulltextJobActive(job) || job.attempts >= 3) {
        await libraryPut(env.QL_KV, FULLTEXT_JOB_PREFIX + job.doi, JSON.stringify({ ...job, state:'failed', updatedAt:now, reason:'job_expired' }), { expirationTtl:604800 });
        await env.QL_KV.delete(entry.name); continue;
      }
      if (job.nextAttemptAt > now) continue;
      const claimed = { ...job, state:'running', owner, leaseId:crypto.randomUUID(), leaseUntil:now + FULLTEXT_JOB_LEASE_MS, updatedAt:now, attempts:job.attempts + 1 };
      await libraryPut(env.QL_KV, FULLTEXT_JOB_PREFIX + job.doi, JSON.stringify(claimed), { expirationTtl:604800 });
      return { id:job.id, doi:job.doi, leaseId:claimed.leaseId };
    }
    if (listing.list_complete || !listing.cursor) break;
    cursor = listing.cursor;
  }
  return null;
}
async function fulltextRun(env, owner, input) {
  const key = FULLTEXT_JOB_PREFIX + input.doi, job = fulltextJobRecord(await libraryGet(env.QL_KV, key), input.doi);
  if (!job || job.id !== input.id || job.state !== 'running' || job.owner !== owner || job.leaseId !== input.leaseId || job.leaseUntil <= Date.now()) libraryFail('job_stale', 409);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), LIBRARY_TASK_MS);
  let final;
  try {
    const stored = await libraryGet(env.QL_KV, LIBRARY_PREFIX + job.doi), ready = libraryPaper(stored, job.doi);
    let paper;
    if (ready && ready.fulltextStatus === 'available') { await libraryStoredPdf(env.QL_KV, stored); paper = ready; }
    else {
      const context = { signal:controller.signal };
      paper = await libraryMetadata(job.doi, context);
      let fetched, review = false, sourceUnavailable = false, sourceRetryAfter = 0;
      try { fetched = await libraryGithub(paper, env, context); }
      catch (error) {
        if (controller.signal.aborted) libraryFail('library_timeout', 504);
        if (['library_not_configured','library_paused'].includes(error.code)) throw error;
        review = ['library_identity','pdf_integrity','pdf_index_invalid'].includes(error.code);
        sourceUnavailable = !review; sourceRetryAfter = error.retryAfter || 0;
      }
      if (!fetched && !review && !sourceUnavailable) { const oa = await libraryOa(paper, context); if (oa.bytes) fetched = oa; else { review = review || oa.review; sourceUnavailable = sourceUnavailable || oa.unavailable; sourceRetryAfter = oa.retryAfter || 0; } }
      if (controller.signal.aborted) libraryFail('library_timeout', 504);
      const current = fulltextJobRecord(await libraryGet(env.QL_KV, key), job.doi);
      if (!current || current.id !== job.id || current.owner !== owner || current.leaseId !== job.leaseId) libraryFail('job_stale', 409);
      paper = { ...paper, fulltextStatus:fetched ? 'available' : review ? 'review' : sourceUnavailable ? 'pending' : 'manual_needed' };
      const saved = await librarySave(env.QL_KV, paper, fetched, review ? 'library_identity' : sourceUnavailable ? 'library_upstream' : 'library_manual_needed', sourceRetryAfter);
      paper = saved.paper;
      if (!fetched && !review && sourceUnavailable) libraryFail('library_upstream', 502, sourceRetryAfter);
    }
    final = { ...job, state:paper.fulltextStatus, updatedAt:Date.now(), reason:'' };
  } catch (error) {
    if (error.code === 'job_stale') throw error;
    if (error.code === 'library_paused') await libraryPut(env.QL_KV, 'library:attempt:' + job.doi, JSON.stringify({ status:'pending', error:'library_paused', paused:true, retryAfter:error.retryAfter || 0 }));
    const transient = ['library_timeout','library_upstream','library_storage','library_sync_pending','pdf_timeout','pdf_upstream'].includes(error.code);
    final = { ...job, state:transient && job.attempts < 3 ? 'queued' : error.code === 'library_identity' ? 'review' : 'failed',
      updatedAt:Date.now(), nextAttemptAt:error.retryAfter || Date.now() + (job.attempts === 1 ? 60000 : 600000), reason:['library_metadata_unavailable','library_identity','library_paused'].includes(error.code) ? error.code : 'job_failed' };
  } finally { clearTimeout(timer); }
  const current = fulltextJobRecord(await libraryGet(env.QL_KV, key), job.doi);
  if (!current || current.id !== job.id || current.owner !== owner || current.leaseId !== job.leaseId) libraryFail('job_stale', 409);
  await libraryPut(env.QL_KV, key, JSON.stringify(final), { expirationTtl:604800 });
  if (final.state !== 'queued') await env.QL_KV.delete(job.queueKey);
  return fulltextPublicJob(final, job.doi);
}
async function handleFulltextWorker(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('job_bad_request', 405);
    if (env.FULLTEXT_ASYNC_ENABLED !== 'true') libraryFail('job_disabled', 503);
    const owner = await fulltextJobAuthorize(request);
    libraryConfig(env);
    const input = await fulltextJobInput(request);
    if (input.action === 'claim') return json({ ok:true, job:await fulltextClaim(env, owner) });
    return json({ ok:true, job:await fulltextRun(env, owner, input) });
  } catch (error) { return json({ ok:false, error:error instanceof LibraryFailure ? error.code : 'job_server' }, error instanceof LibraryFailure ? error.status : 500); }
}
async function handleFulltextPending(request, env) {
  try {
    if (request.method !== 'GET' || new URL(request.url).search) libraryFail('job_bad_request', 405);
    if (env.FULLTEXT_ASYNC_ENABLED !== 'true') return json({ ok:true, pending:false });
    libraryConfig(env);
    const listing = await env.QL_KV.list({ prefix:FULLTEXT_QUEUE_PREFIX, limit:20 });
    if (!listing || !Array.isArray(listing.keys) || listing.keys.length > 20) libraryFail('library_storage', 503);
    for (const entry of listing.keys) {
      if (typeof entry.name !== 'string' || !entry.name.startsWith(FULLTEXT_QUEUE_PREFIX)) continue;
      const pointer = await libraryGet(env.QL_KV, entry.name);
      if (!pointer || !libraryDoi(pointer.doi)) continue;
      const job = fulltextJobRecord(await libraryGet(env.QL_KV, FULLTEXT_JOB_PREFIX + pointer.doi), pointer.doi);
      if (!job || job.id !== pointer.id || job.queueKey !== entry.name) {
        const createdAt = Number(entry.name.slice(FULLTEXT_QUEUE_PREFIX.length).split(':')[0]);
        if (Number.isSafeInteger(createdAt) && Date.now() - createdAt > 300000) return json({ ok:true, pending:true });
        continue;
      }
      const now = Date.now();
      if (!['queued','running'].includes(job.state) || !fulltextJobActive(job)
          || (job.state === 'queued' ? job.nextAttemptAt <= now : job.leaseUntil <= now)) return json({ ok:true, pending:true });
    }
    // Only expose an aggregate signal; never titles, DOIs or reader identities.
    return json({ ok:true, pending:!listing.list_complete });
  } catch (error) { return json({ ok:false, error:error instanceof LibraryFailure ? error.code : 'job_server' }, error instanceof LibraryFailure ? error.status : 500); }
}
