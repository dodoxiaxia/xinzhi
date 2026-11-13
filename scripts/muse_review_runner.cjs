'use strict';
const {identityToken} = require('./fulltext_queue_runner.cjs');
const {readJson,ready,serviceError,failureLog} = require('./fulltext_import_runner.cjs');
const fs = require('fs/promises'),path = require('path'),os = require('os'),crypto = require('crypto');
const {promisify} = require('util'),execFile = promisify(require('child_process').execFile);
const ENDPOINT = 'https://learn.dryz.info/api/muse/review';
const CLAIM_IDLE_POLLS = 9, CLAIM_IDLE_MS = 15000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
async function verifyOriginal(bytes, task) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'xinzhi-muse-'));
  try {
    const file = path.join(directory,'original.pdf');
    await fs.writeFile(file,bytes,{mode:0o600});
    const result = await execFile('python3',[path.join(__dirname,'muse_pdf_verifier.py'),file,'--doi',task.doi,'--title',task.title],{timeout:90000,maxBuffer:8192});
    return JSON.parse(result.stdout);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
}
async function runReview(env = process.env, http = fetch, verify = verifyOriginal, log = console.log, wait = ms => new Promise(r => setTimeout(r,ms))) {
  const recheckDoi = typeof env.MUSE_RECHECK_DOI === 'string' ? env.MUSE_RECHECK_DOI.trim().toLowerCase() : '';
  if (env.MUSE_RECHECK_DOI && (typeof env.MUSE_RECHECK_DOI !== 'string' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || !/^10\.\d{4,9}\/[\x21-\x7e]{1,200}$/.test(recheckDoi) || /[<>?#@\\]/.test(recheckDoi))) throw new Error('invalid_recheck');
  await ready(ENDPOINT,'muse_bad_request',http,wait);
  const call = async (input, binary = false) => {
    const token = await identityToken(env,http,ENDPOINT);
    const response = await http(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),
      headers:{authorization:'Bearer ' + token,'content-type':'application/json','user-agent':'XinZhiMuseVerifier/1.0'},body:JSON.stringify(input)});
    if (binary && response.ok && response.headers.get('content-type') === 'application/pdf') {
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new Error('invalid_candidate'); chunks.push(chunk); }
      return Buffer.concat(chunks,size);
    }
    const body = await readJson(response);
    if (!response.ok || body.ok !== true) {
      const error = serviceError(response.status === 503 && ['muse_sync_pending','library_sync_pending'].includes(body.error) ? 'review_sync_pending' : 'review_unavailable',response,body,token,ENDPOINT,'muse-review.yml');
      throw error;
    }
    if (binary) throw new Error('invalid_candidate');
    return body;
  };
  let processed = 0, idle = 0;
  // A run the website dispatches right after an upload can start before Cloudflare KV shows the new
  // candidate (list and read are eventually consistent), so it used to find nothing and exit while
  // the upload waited for the late hourly schedule. A dispatched run therefore keeps asking for
  // about two minutes after the last candidate; the website coalesces dispatches inside 60 seconds,
  // so every upload falls inside some run's window. Scheduled and recheck runs never wait.
  const patient = !recheckDoi && env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  for (let n = 0; n < (recheckDoi ? 1 : 5); n++) {
    const claimed = await call(recheckDoi ? {action:'recheck',doi:recheckDoi} : {action:'claim'}), task = claimed.task;
    if (task === null) {
      if (patient && idle < CLAIM_IDLE_POLLS) { idle++; n--; await wait(CLAIM_IDLE_MS); continue; }
      break;
    }
    idle = 0;
    if (!task || typeof task.doi !== 'string' || !/^10\.\d{4,9}\/[\x21-\x7e]{1,200}$/.test(task.doi) || /[<>?#@\\]/.test(task.doi)
        || task.doi !== task.doi.toLowerCase() || (recheckDoi && task.doi !== recheckDoi) || typeof task.title !== 'string' || !task.title || task.title.length > 800
        || !uuid.test(task.taskId || '') || !uuid.test(task.leaseId || '') || !/^[a-f0-9]{64}$/.test(task.sha256 || '')
        || !Number.isInteger(task.bytes) || task.bytes < 51200 || task.bytes > 10 * 1024 * 1024) throw new Error('invalid_candidate');
    const identity = {taskId:task.taskId,doi:task.doi,leaseId:task.leaseId};
    const bytes = await call({action:'bytes',...identity},true);
    if (bytes.length !== task.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== task.sha256) throw new Error('invalid_candidate');
    let proof;
    try { proof = await verify(bytes,task); }
    catch { proof = {verified:false,pages:0,sha256:task.sha256,bytes:task.bytes,method:'dual_parser_all_pages_title_doi'}; }
    if (!proof || proof.sha256 !== task.sha256 || proof.bytes !== task.bytes || proof.method !== 'dual_parser_all_pages_title_doi'
        || typeof proof.verified !== 'boolean' || !Number.isInteger(proof.pages) || proof.pages < 0 || proof.pages > 200 || (proof.verified && proof.pages < 1)) throw new Error('invalid_verification');
    const reason = !proof.verified && ['invalid_pdf','invalid_identity','identity_mismatch'].includes(proof.reason) ? proof.reason : '';
    const input = {action:'complete',...identity,result:proof.verified ? 'verified' : 'rejected',sha256:proof.sha256,bytes:proof.bytes,pages:proof.pages,method:proof.method,...(reason ? {reason} : {})};
    let done;
    for (let retry = 0; retry < 3; retry++) {
      try { done = await call(input); break; }
      catch (error) { if (error.message !== 'review_sync_pending' || retry === 2) throw error; await wait(30000); }
    }
    if (done.job?.doi !== task.doi || done.job.id !== task.taskId || done.job.state !== (proof.verified ? 'available' : 'review') || done.archive?.complete !== false) throw new Error('invalid_verification');
    processed++;
    log(JSON.stringify({doi:task.doi,status:done.job.state,pages:proof.pages,archiveComplete:false,...(reason ? {reason} : {})}));
  }
  log(JSON.stringify({processed,scope:'uploaded_originals_only'}));
  return processed;
}
// Compares the website's job records with its machine candidate index and repairs the gap (the website decides whether it may repair).
// Run after the review loop, with the same OIDC identity; no machine token. A mismatch is a warning annotation; one that is still there
// after the website's repair (or when repair is off) fails the run so the red job is the alert. An older website that does not know the
// action answers 400 muse_bad_request: that is a warning only, because a push run can start before the new code is deployed.
async function runIndexAudit(env = process.env, http = fetch, log = console.log) {
  const totals = {scanned:0,candidates:0,missing:0,stale:0,extra:0,repaired:0};
  const orphanDois = [];
  let cursor = '', chunks = 0, indexed = null, building = false, repair = true, orphans = 0, papers = 0;
  for (; chunks < 40; ) {
    const token = await identityToken(env,http,ENDPOINT);
    const response = await http(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),
      headers:{authorization:'Bearer ' + token,'content-type':'application/json','user-agent':'XinZhiMuseVerifier/1.0'},body:JSON.stringify(cursor ? {action:'index-audit',cursor} : {action:'index-audit'})});
    const body = await readJson(response);
    if (response.status === 400 && body.error === 'muse_bad_request') { log('::warning::索引核对：网站尚未部署 index-audit，本次跳过'); return {skipped:true}; }
    if (!response.ok || body.ok !== true) throw serviceError('index_audit_unavailable',response,body,token,ENDPOINT,'muse-review.yml');
    chunks++;
    for (const key of Object.keys(totals)) if (!Number.isSafeInteger(body[key]) || body[key] < 0) throw new Error('invalid_index_audit'); else totals[key] += body[key];
    // Orphans: papers a cut-off registration left without a task. Reported only; the website never creates the task from here.
    if (!Number.isSafeInteger(body.orphans) || body.orphans < 0 || !Number.isSafeInteger(body.papers) || body.papers < 0
        || !Array.isArray(body.orphanDois) || body.orphanDois.length > 20 || body.orphanDois.some(doi => typeof doi !== 'string' || !/^10\.\d{4,9}\/[\x21-\x7e]{1,200}$/.test(doi))) throw new Error('invalid_index_audit');
    orphans += body.orphans; papers += body.papers;
    for (const doi of body.orphanDois) if (orphanDois.length < 20) orphanDois.push(doi);
    if (indexed === null) indexed = body.indexed;
    repair = body.repair === true;
    if (body.ready === false) { building = true; break; }
    if (body.done === true) break;
    if (typeof body.cursor !== 'string' || !body.cursor || body.cursor.length > 512) throw new Error('invalid_index_audit');
    cursor = body.cursor;
  }
  const mismatch = totals.missing + totals.stale + totals.extra;
  const summary = {indexAudit:{...totals,indexedBefore:indexed,requests:chunks,repair,...(building ? {building:true} : {}),mismatch,papers,orphans,orphanDois}};
  log(JSON.stringify(summary));
  if (building) log('::warning::索引核对：索引还在重建，本次未核对完');
  if (mismatch > 0) log('::warning::索引核对：索引条数与可领任务数对不上（漏 ' + totals.missing + '、过期 ' + totals.stale + '、多余 ' + totals.extra + '），已修复 ' + totals.repaired + ' 条');
  if (orphans > 0) log('::warning::索引核对：有 ' + orphans + ' 条只有题录、没有任务的孤儿记录（' + orphanDois.slice(0,10).join('、') + (orphans > 10 ? ' 等' : '') + '）。重发含它们的登记批次即可补建任务；核对本身不补建。');
  if (mismatch > 0 && totals.repaired < mismatch) { const error = new Error('index_mismatch'); error.counts = totals; throw error; }
  return summary.indexAudit;
}
module.exports = {runReview,verifyOriginal,runIndexAudit};
if (require.main === module) (async () => {
  try { await runReview(); }
  catch (error) { console.error(failureLog(error,['invalid_recheck','invalid_candidate','invalid_verification','review_sync_pending','website_not_ready','website_denied','oidc_unavailable','response_too_large','invalid_json_response'].includes(error.message) ? error.message : 'review_unavailable')); process.exitCode = 1; }
  // The index comparison also runs when the review step failed; a single-DOI recheck is only about that DOI.
  if (process.env.MUSE_RECHECK_DOI) return;
  try { await runIndexAudit(); }
  catch (error) {
    console.error(failureLog(error,['index_mismatch','invalid_index_audit','website_denied','oidc_unavailable','response_too_large','invalid_json_response'].includes(error.message) ? error.message : 'index_audit_unavailable'));
    // Only a gap that is still there after the repair fails the run; an audit that could not run (website busy) is a warning.
    if (error.message === 'index_mismatch') process.exitCode = 1; else console.log('::warning::索引核对没有跑完，下一小时再核对');
  }
})();
