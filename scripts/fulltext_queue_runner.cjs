'use strict';
// GitHub-hosted runner calls the website with a short-lived OIDC token.
// No private PDF token, user passphrase, PDF body or model is passed to this runner.
const ENDPOINT = 'https://learn.dryz.info/api/fulltext-worker';
const AUDIENCE = ENDPOINT;

async function readJson(response) {
  const text = await response.text();
  if (text.length > 65536) throw new Error('response_too_large');
  try { return JSON.parse(text); } catch { throw new Error('invalid_json_response'); }
}
async function identityToken(env, http) {
  let url;
  try { url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); } catch { throw new Error('oidc_unavailable'); }
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)*actions\.githubusercontent\.com$/.test(url.hostname)
      || url.port || url.username || url.password || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('oidc_unavailable');
  url.searchParams.set('audience', AUDIENCE);
  const response = await http(url.href, { method:'GET', redirect:'error', signal:AbortSignal.timeout(15000),
    headers:{ authorization:'Bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } });
  if (!response.ok) throw new Error('oidc_unavailable');
  const payload = await readJson(response);
  if (typeof payload.value !== 'string' || payload.value.length > 16000 || payload.value.split('.').length !== 3) throw new Error('oidc_unavailable');
  return payload.value;
}
async function call(input, env, http) {
  const token = await identityToken(env, http);
  const response = await http(ENDPOINT, { method:'POST', redirect:'error', signal:AbortSignal.timeout(90000),
    headers:{ authorization:'Bearer ' + token, 'content-type':'application/json', accept:'application/json', 'user-agent':'XinZhiFulltextQueue/1.0' }, body:JSON.stringify(input) });
  const body = await readJson(response);
  if (!response.ok || !body || body.ok !== true) {
    const error = new Error(response.status === 409 && body.error === 'job_stale' ? 'job_sync_pending' : 'worker_unavailable');
    error.status = response.status; throw error;
  }
  return body;
}
async function runQueue(env = process.env, http = fetch, log = console.log, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  if (env.GITHUB_EVENT_NAME === 'push') {
    // The initial source push can start this job before Pages has its new API.
    let ready = false;
    for (let n = 0; n < 25; n++) {
      try {
        const response = await http(ENDPOINT, { method:'GET', redirect:'error', signal:AbortSignal.timeout(10000), headers:{ 'user-agent':'XinZhiFulltextQueue/1.0' } });
        const payload = await readJson(response);
        ready = response.status === 405 && payload.error === 'job_bad_request';
      } catch { /* The next scheduled batch can resume after deployment. */ }
      if (ready) break;
      if (n < 24) await wait(5000);
    }
    if (!ready) { log(JSON.stringify({ processed:0, status:'waiting_for_website_deploy' })); return 0; }
  }
  let processed = 0;
  for (let n = 0; n < 5; n++) {
    const result = await call({ action:'claim' }, env, http);
    if (!result.job) break;
    const job = result.job;
    if (typeof job.doi !== 'string' || !/^10\.\d{4,9}\/[\x21-\x7e]{1,200}$/.test(job.doi)
        || typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.id) || typeof job.leaseId !== 'string' || !/^[a-f0-9-]{36}$/.test(job.leaseId)) throw new Error('invalid_claim');
    let completed;
    // A successful lease write may need time to become visible at another KV location.
    for (let retry = 0; retry < 16; retry++) {
      try { completed = await call({ action:'run', id:job.id, doi:job.doi, leaseId:job.leaseId }, env, http); break; }
      catch (error) { if (error.message !== 'job_sync_pending' || retry === 15) throw error; await wait(5000); }
    }
    if (!completed.job || !['available','pending','review','queued','failed'].includes(completed.job.state)) throw new Error('invalid_result');
    processed++;
    log(JSON.stringify({ task:n + 1, state:completed.job.state, attempts:completed.job.attempts }));
  }
  log(JSON.stringify({ processed }));
  return processed;
}
module.exports = { runQueue, identityToken };
if (require.main === module) runQueue().catch(error => { console.error(['oidc_unavailable','job_sync_pending','invalid_claim','invalid_result','response_too_large','invalid_json_response'].includes(error.message) ? error.message : 'fulltext_worker_unavailable'); process.exitCode = 1; });
