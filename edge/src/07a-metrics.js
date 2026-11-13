// ==== edge/src/07a-metrics.js · Request/error metrics (Analytics Engine, off by default) ====
// One data point per /api/* request, written only when BOTH the METRICS binding exists AND the runtime KV
// switch METRICS_SWITCH_KEY holds '1'. Nothing here may change a response, so every step is guarded and the
// write is handed to ctx.waitUntil. No DOI, title, token, passphrase, query string, IP or user agent is recorded.
const METRICS_SWITCH_KEY = 'cfg:metrics_enabled', METRICS_SWITCH_TTL_MS = 60000, METRICS_ERROR_CODE = /^[a-z0-9_]{1,48}$/;
const METRICS_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
const METRICS_ROUTES = new Set([
  '/api/library', '/api/fulltext-worker', '/api/fulltext-import', '/api/muse/protocol', '/api/muse/request', '/api/muse/retry',
  '/api/muse/claim', '/api/muse/receipt', '/api/muse/upload', '/api/muse/reader-upload', '/api/muse/review',
  '/api/machine/protocol', '/api/machine/upload', '/api/machine/status', '/api/machine/tasks', '/api/machine/abandoned',
  '/api/machine/claim', '/api/machine/renew', '/api/machine/return', '/api/machine/requeue', '/api/machine/register',
  '/api/drive-archive', '/api/fulltext-pending', '/api/grok-fulltext-receipt', '/api/acquire', '/api/acquire/retry',
  '/api/fulltext', '/api/fulltext-source', '/api/pdf', '/api/ql', '/api/ai'
]);
let metricsSwitch = { on: false, at: 0 };

// Per-isolate cache of the KV switch. A missing key, any other value or a failing read all mean off.
async function metricsEnabled(env) {
  const now = Date.now();
  if (now - metricsSwitch.at >= 0 && now - metricsSwitch.at < METRICS_SWITCH_TTL_MS) return metricsSwitch.on;
  let on = false;
  try { on = (await env.QL_KV.get(METRICS_SWITCH_KEY)) === '1'; } catch { on = false; }
  metricsSwitch = { on, at: now };
  return on;
}

// Start before the response is returned; never throws and never touches the response that is returned.
// Returns nothing the caller needs. `failure` is set when routing itself threw (reported as status 500).
function metricsRecord(request, env, ctx, response, startedAt, failure) {
  try {
    if (!env || !env.METRICS || typeof env.METRICS.writeDataPoint !== 'function' || !env.QL_KV) return;
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return;
    const route = METRICS_ROUTES.has(path) ? path : '/api/other';
    const method = METRICS_METHODS.has(request.method) ? request.method : 'OTHER';
    const status = failure ? 500 : response.status;
    let errorSource = null;
    if (!failure && status >= 400 && (response.headers.get('content-type') || '').includes('application/json')) errorSource = response.clone();
    const work = (async () => {
      try {
        if (!(await metricsEnabled(env))) return;
        let errorCode = failure ? 'exception' : '';
        if (errorSource) {
          try {
            const text = await errorSource.text();
            const code = text.length <= 4096 ? JSON.parse(text).error : '';
            errorCode = typeof code === 'string' && METRICS_ERROR_CODE.test(code) ? code : 'other';
          } catch { errorCode = 'other'; }
        }
        env.METRICS.writeDataPoint({ blobs: [route, method, String(status), errorCode], doubles: [Math.max(0, Date.now() - startedAt), 1], indexes: [route] });
      } catch { /* metrics never affect the request */ }
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  } catch { /* metrics never affect the request */ }
}
