'use strict';
const fs = require('fs');
const {identityToken} = require('./fulltext_queue_runner.cjs');
const ENDPOINT = 'https://learn.dryz.info/api/fulltext-import';
const SAFE_ERRORS = new Set(['job_auth','job_auth_unavailable','library_not_configured','library_disabled','library_storage','library_sync_pending','library_integrity','library_identity','library_timeout','library_upstream','library_paused',
  'pdf_integrity','pdf_index_invalid','pdf_timeout','pdf_upstream','pdf_not_found','pdf_too_large','import_bad_request','import_owner_conflict','import_server','muse_bad_request','muse_stale','muse_sync_pending','muse_server']);
const SAFE_STAGES = new Set(['configuration','metadata','index','contents_metadata','contents_raw','lfs_batch','lfs_object','body_timeout']);
const SAFE_REASONS = new Set(['configuration','identity','integrity','size_limit','http_error','object_error','no_object','no_download','action_header','unsafe_host','expired_action','redirect','network','parse','no_body','header_timeout','body_timeout','total_timeout','unavailable']);
function serviceError(message, response, body, token, audience, workflow) {
  const error = new Error(message);
  error.status = response.status;
  error.reason = SAFE_ERRORS.has(body?.error) ? body.error : 'unclassified_response';
  const diagnostic = body?.diagnostic;
  if (diagnostic?.schemaVersion === 1 && SAFE_STAGES.has(diagnostic.stage) && SAFE_REASONS.has(diagnostic.reason)
      && [diagnostic.httpStatus,diagnostic.objectCode].every(code => code === null || Number.isInteger(code) && code >= 100 && code <= 599)) {
    error.sourceChecks = {stage:diagnostic.stage,reason:diagnostic.reason,httpStatus:diagnostic.httpStatus,objectCode:diagnostic.objectCode,
      ...(SAFE_STAGES.has(diagnostic.sourceStage) ? {sourceStage:diagnostic.sourceStage} : {})};
  }
  if (error.reason === 'job_auth') {
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')),now = Math.floor(Date.now() / 1000);
      error.oidcChecks = {audience:claims.aud === audience,repository:claims.repository === 'dodoxiaxia/xinzhi',repositoryId:String(claims.repository_id) === '1397425558',
        subject:['repo:dodoxiaxia/xinzhi:ref:refs/heads/main','repo:dodoxiaxia@214921265/xinzhi@1397425558:ref:refs/heads/main'].includes(claims.sub),ref:claims.ref === 'refs/heads/main',
        workflow:claims.workflow_ref === 'dodoxiaxia/xinzhi/.github/workflows/' + workflow + '@refs/heads/main',runner:claims.runner_environment === 'github-hosted',
        issuer:claims.iss === 'https://token.actions.githubusercontent.com',event:['push','workflow_dispatch','schedule'].includes(claims.event_name),
        expiresIn:Number.isInteger(claims.exp) ? claims.exp - now : null,mintedAgo:Number.isInteger(claims.iat) ? now - claims.iat : null,notBefore:Number.isInteger(claims.nbf) ? claims.nbf - now : null};
    } catch { /* Never print the token or a decoding exception. */ }
  }
  return error;
}
function failureLog(error, fallback) {
  return JSON.stringify({error:fallback,...(Number.isInteger(error.status) ? {status:error.status} : {}),...(error.reason ? {reason:error.reason} : {}),...(error.oidcChecks ? {oidcChecks:error.oidcChecks} : {}),...(error.sourceChecks ? {sourceChecks:error.sourceChecks} : {})});
}
async function readJson(response) {
  const text = await response.text();
  if (text.length > 65536) throw new Error('response_too_large');
  try { return JSON.parse(text); } catch { throw new Error('invalid_json_response'); }
}
function manifest(value) {
  if (!value || value.schemaVersion !== 1 || Object.keys(value).some(k => !['schemaVersion','requests'].includes(k))
      || !Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > 5) throw new Error('invalid_manifest');
  const seen = new Set();
  for (const input of value.requests) {
    if (!input || Object.keys(input).some(k => !['doi','githubCommit','sha256'].includes(k)) || typeof input.doi !== 'string'
        || !/^10\.\d{4,9}\/[\x21-\x7e]{1,200}$/.test(input.doi) || input.doi !== input.doi.toLowerCase() || /[<>?#@\\]/.test(input.doi)
        || !/^[a-f0-9]{40}$/.test(input.githubCommit || '') || !/^[a-f0-9]{64}$/.test(input.sha256 || '') || seen.has(input.doi)) throw new Error('invalid_manifest');
    seen.add(input.doi);
  }
  return value.requests;
}
async function ready(endpoint, expected, http, wait, version = 3) {
  for (let n = 0; n < 48; n++) {
    try {
      const response = await http(endpoint,{method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'user-agent':'XinZhiFulltextImport/1.0'}});
      if ([401,403,429].includes(response.status)) { if (response.body) await response.body.cancel(); throw new Error('website_denied'); }
      const value = await readJson(response);
      if (response.status === 405 && value.error === expected && value.protocolVersion === version) return;
    } catch (error) { if (error.message === 'website_denied') throw error; }
    if (n < 47) await wait(15000);
  }
  throw new Error('website_not_ready');
}
async function runImport(value, env = process.env, http = fetch, log = console.log, wait = ms => new Promise(r => setTimeout(r,ms))) {
  const inputs = manifest(value);
  await ready(ENDPOINT,'import_bad_request',http,wait,4);
  for (const input of inputs) {
    let result;
    for (let n = 0; n < 3; n++) {
      const token = await identityToken(env,http,ENDPOINT);
      const response = await http(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{authorization:'Bearer ' + token,'content-type':'application/json','user-agent':'XinZhiFulltextImport/1.0'},body:JSON.stringify(input)});
      result = await readJson(response);
      if (response.status === 503 && result.error === 'library_sync_pending' && n < 2) { await wait(30000); continue; }
      if (!response.ok || result.ok !== true) throw serviceError('import_unavailable',response,result,token,ENDPOINT,'fulltext-import.yml');
      break;
    }
    if (result.status !== 'available' || result.paper?.doi !== input.doi || result.paper.fulltextStatus !== 'available'
        || result.source?.githubCommit !== input.githubCommit || result.source.sha256 !== input.sha256
        || result.downloadUrl !== '/api/fulltext?doi=' + encodeURIComponent(input.doi) || result.archive?.complete !== false) throw new Error('invalid_import_result');
    log(JSON.stringify({doi:input.doi,status:'available',source:'existing_github_original',archiveComplete:false}));
  }
  return inputs.length;
}
module.exports = {runImport,manifest,readJson,ready,serviceError,failureLog};
if (require.main === module) {
  let input; try { input = JSON.parse(fs.readFileSync(require('path').join(__dirname,'../editorial/fulltext-imports.json'),'utf8')); } catch { console.error('invalid_manifest'); process.exit(1); }
  runImport(input).catch(error => { console.error(failureLog(error,['invalid_manifest','invalid_import_result','website_not_ready','website_denied','oidc_unavailable','response_too_large','invalid_json_response'].includes(error.message) ? error.message : 'import_unavailable')); process.exitCode = 1; });
}
