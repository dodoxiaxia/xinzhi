'use strict';
const {identityToken} = require('./fulltext_queue_runner.cjs');
const {readJson,ready} = require('./fulltext_import_runner.cjs');
const fs = require('fs/promises'),path = require('path'),os = require('os'),crypto = require('crypto');
const {promisify} = require('util'),execFile = promisify(require('child_process').execFile);
const ENDPOINT = 'https://learn.dryz.info/api/muse/review';
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
  if (env.GITHUB_EVENT_NAME === 'push') await ready(ENDPOINT,'muse_bad_request',http,wait);
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
      const error = new Error(response.status === 503 && ['muse_sync_pending','library_sync_pending'].includes(body.error) ? 'review_sync_pending' : 'review_unavailable');
      throw error;
    }
    if (binary) throw new Error('invalid_candidate');
    return body;
  };
  let processed = 0;
  for (let n = 0; n < 5; n++) {
    const claimed = await call({action:'claim'}), task = claimed.task;
    if (task === null) break;
    if (!task || typeof task.doi !== 'string' || !/^10\.\d{4,9}\/[\x21-\x7e]{1,200}$/.test(task.doi) || /[<>?#@\\]/.test(task.doi)
        || task.doi !== task.doi.toLowerCase() || typeof task.title !== 'string' || !task.title || task.title.length > 800
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
    const input = {action:'complete',...identity,result:proof.verified ? 'verified' : 'rejected',sha256:proof.sha256,bytes:proof.bytes,pages:proof.pages,method:proof.method};
    let done;
    for (let retry = 0; retry < 3; retry++) {
      try { done = await call(input); break; }
      catch (error) { if (error.message !== 'review_sync_pending' || retry === 2) throw error; await wait(30000); }
    }
    if (done.job?.doi !== task.doi || done.job.id !== task.taskId || done.job.state !== (proof.verified ? 'available' : 'review') || done.archive?.complete !== false) throw new Error('invalid_verification');
    processed++;
    log(JSON.stringify({doi:task.doi,status:done.job.state,pages:proof.pages,archiveComplete:false}));
  }
  log(JSON.stringify({processed,scope:'uploaded_originals_only'}));
  return processed;
}
module.exports = {runReview,verifyOriginal};
if (require.main === module) runReview().catch(error => { console.error(['invalid_candidate','invalid_verification','review_sync_pending','website_not_ready','website_denied','oidc_unavailable','response_too_large','invalid_json_response'].includes(error.message) ? error.message : 'review_unavailable'); process.exitCode = 1; });
