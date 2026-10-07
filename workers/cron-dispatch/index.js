// Existing xinzhi-cron: check the queue before starting a GitHub runner.
// GH_TOKEN stays in Cloudflare; scope: this repository, Actions read/write.
const REPO = 'dodoxiaxia/xinzhi';
const WORKFLOW = 'fulltext.yml';
const PENDING = 'https://learn.dryz.info/api/fulltext-pending';
const BASE = 'https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW;
async function request(url, init) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { ...init, redirect:'error', signal:controller.signal });
    if (response.status === 204) return { status:204, body:null };
    const reader = response.body && response.body.getReader();
    if (!reader) return { status:response.status, body:null };
    let size = 0; const parts = [];
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 262144) { await reader.cancel(); return { status:response.status, body:null }; }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; }
    return { status:response.status, body };
  } finally { clearTimeout(timer); }
}
async function dispatch(env) {
  try {
    const pending = await request(PENDING, { method:'GET', headers:{ accept:'application/json', 'User-Agent':'XinZhiFulltextDispatch/1.0' } });
    if (pending.status !== 200 || !pending.body || pending.body.ok !== true || typeof pending.body.pending !== 'boolean') return 'queue_unavailable';
    if (!pending.body.pending) return 'queue_empty';
    if (typeof env.GH_TOKEN !== 'string' || !env.GH_TOKEN.trim()) return 'dispatch_not_configured';
    const headers = { Authorization:'Bearer ' + env.GH_TOKEN, Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'XinZhiFulltextDispatch/1.0' };
    const runs = await request(BASE + '/runs?branch=main&per_page=5', { method:'GET', headers });
    if (runs.status !== 200 || !runs.body || !Array.isArray(runs.body.workflow_runs)) return 'workflow_unavailable';
    if (runs.body.workflow_runs.some(run => ['queued','in_progress','waiting','pending','requested'].includes(run.status))) return 'workflow_active';
    const result = await request(BASE + '/dispatches', { method:'POST', headers:{ ...headers, 'Content-Type':'application/json' }, body:JSON.stringify({ ref:'main' }) });
    return result.status === 204 ? 'dispatched' : 'dispatch_failed';
  } catch { return 'dispatch_unavailable'; }
}
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env).then(code => console.log('fulltext-dispatch', code)));
  },
  async fetch(request, env) {
    const configured = typeof env.GH_TOKEN === 'string' && !!env.GH_TOKEN.trim();
    const allowed = request.method === 'GET';
    return Response.json({ ok:allowed && configured, configured, service:'fulltext-dispatch', version:'v14.2' },
      { status:allowed ? configured ? 200 : 503 : 405, headers:{ 'cache-control':'no-store', 'x-content-type-options':'nosniff' } });
  },
};
