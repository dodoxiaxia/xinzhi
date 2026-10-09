'use strict';
const fs = require('fs');
const {identityToken} = require('./fulltext_queue_runner.cjs');
const ENDPOINT = 'https://learn.dryz.info/api/fulltext-import';
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
async function ready(endpoint, expected, http, wait) {
  for (let n = 0; n < 48; n++) {
    try {
      const response = await http(endpoint,{method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'user-agent':'XinZhiFulltextImport/1.0'}});
      const value = await readJson(response);
      if (response.status === 405 && value.error === expected) return;
      if ([401,403].includes(response.status)) throw new Error('website_denied');
    } catch (error) { if (error.message === 'website_denied') throw error; }
    if (n < 47) await wait(15000);
  }
  throw new Error('website_not_ready');
}
async function runImport(value, env = process.env, http = fetch, log = console.log, wait = ms => new Promise(r => setTimeout(r,ms))) {
  const inputs = manifest(value);
  if (env.GITHUB_EVENT_NAME === 'push') await ready(ENDPOINT,'import_bad_request',http,wait);
  for (const input of inputs) {
    let result;
    for (let n = 0; n < 3; n++) {
      const token = await identityToken(env,http,ENDPOINT);
      const response = await http(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{authorization:'Bearer ' + token,'content-type':'application/json','user-agent':'XinZhiFulltextImport/1.0'},body:JSON.stringify(input)});
      result = await readJson(response);
      if (response.status === 503 && result.error === 'library_sync_pending' && n < 2) { await wait(30000); continue; }
      if (!response.ok || result.ok !== true) throw new Error('import_unavailable');
      break;
    }
    if (result.status !== 'available' || result.paper?.doi !== input.doi || result.paper.fulltextStatus !== 'available'
        || result.source?.githubCommit !== input.githubCommit || result.source.sha256 !== input.sha256
        || result.downloadUrl !== '/api/fulltext?doi=' + encodeURIComponent(input.doi) || result.archive?.complete !== false) throw new Error('invalid_import_result');
    log(JSON.stringify({doi:input.doi,status:'available',source:'existing_github_original',archiveComplete:false}));
  }
  return inputs.length;
}
module.exports = {runImport,manifest,readJson,ready};
if (require.main === module) {
  let input; try { input = JSON.parse(fs.readFileSync(require('path').join(__dirname,'../editorial/fulltext-imports.json'),'utf8')); } catch { console.error('invalid_manifest'); process.exit(1); }
  runImport(input).catch(error => { console.error(['invalid_manifest','invalid_import_result','website_not_ready','website_denied','oidc_unavailable','response_too_large','invalid_json_response'].includes(error.message) ? error.message : 'import_unavailable'); process.exitCode = 1; });
}
