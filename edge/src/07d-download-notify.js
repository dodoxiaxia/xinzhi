// ==== edge/src/07d-download-notify.js · Webhook notice for a new full-text download task (off by default) ====
// When a reader asks for a full text the site does not have and a new download task is queued (handleMuseRequest and
// handleMuseRetry, the two places that create a queued Muse job), the Worker POSTs one small JSON notice to a webhook.
// Nothing is sent unless ALL of these hold:
//   (1) Worker secrets DOWNLOAD_NOTIFY_URL (an https URL) and DOWNLOAD_NOTIFY_KEY both exist;
//   (2) the KV switch DOWNLOAD_NOTIFY_SWITCH_KEY holds exactly '1' or 'true' (missing, other value or read error = off);
//   (3) the DOI has not been sent in the last hour (KV key with expirationTtl 3600);
//   (4) fewer than DOWNLOAD_NOTIFY_HOURLY_MAX notices were sent in the current UTC hour (KV counter with TTL).
// Payload: exactly {doi, task_id, ts}; no user information, title or abstract. The key travels as `Authorization: Bearer <key>`.
// The whole thing runs inside ctx.waitUntil with a 3 second limit and swallows every error, so a failing or slow webhook can
// never change the response. KV is written only when a notice is really about to be sent. The URL and key are never logged.
// The KV keys are outside the D1 shadow prefixes on purpose: they are short-lived counters, not ledger records.
const DOWNLOAD_NOTIFY_SWITCH_KEY = 'cfg:download_notify_enabled';
const DOWNLOAD_NOTIFY_DOI_PREFIX = 'notify:download:doi:', DOWNLOAD_NOTIFY_HOUR_PREFIX = 'notify:download:hour:';
const DOWNLOAD_NOTIFY_DOI_TTL = 3600, DOWNLOAD_NOTIFY_HOUR_TTL = 7200, DOWNLOAD_NOTIFY_HOURLY_MAX = 20, DOWNLOAD_NOTIFY_TIMEOUT_MS = 3000;

function downloadNotifyConfig(env) {
  try {
    const url = new URL(env.DOWNLOAD_NOTIFY_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) return null;
    if (typeof env.DOWNLOAD_NOTIFY_KEY !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(env.DOWNLOAD_NOTIFY_KEY)) return null;
    return { url: url.href, key: env.DOWNLOAD_NOTIFY_KEY };
  } catch { return null; }
}

async function downloadNotifyRun(env, doi, taskId) {
  try {
    const config = downloadNotifyConfig(env);
    if (!config || !env.QL_KV || !libraryDoi(doi) || typeof taskId !== 'string') return;
    const flag = await env.QL_KV.get(DOWNLOAD_NOTIFY_SWITCH_KEY);
    if (flag !== '1' && flag !== 'true') return;
    const doiKey = DOWNLOAD_NOTIFY_DOI_PREFIX + doi;
    if (await env.QL_KV.get(doiKey)) return;
    const now = Date.now(), hourKey = DOWNLOAD_NOTIFY_HOUR_PREFIX + new Date(now).toISOString().slice(0, 13).replace(/\D/g, '');
    const sent = Number(await env.QL_KV.get(hourKey)) || 0;
    if (sent >= DOWNLOAD_NOTIFY_HOURLY_MAX) { console.log('download notify: hourly limit reached, not sent'); return; }
    await env.QL_KV.put(doiKey, '1', { expirationTtl: DOWNLOAD_NOTIFY_DOI_TTL });
    await env.QL_KV.put(hourKey, String(sent + 1), { expirationTtl: DOWNLOAD_NOTIFY_HOUR_TTL });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), DOWNLOAD_NOTIFY_TIMEOUT_MS);
    try {
      const response = await awaitAbort(fetch(config.url, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.key },
        body: JSON.stringify({ doi, task_id: taskId, ts: new Date(now).toISOString() }) }), controller.signal, 'download_notify_timeout');
      if (!response || response.status < 200 || response.status >= 300) console.log('download notify: webhook answered ' + Number(response && response.status));
      try { if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel(); } catch { /* body is not needed */ }
    } finally { clearTimeout(timer); }
  } catch { console.log('download notify: not sent'); } // fixed text only: no URL, key, DOI or error detail
}

// Called right after a new queued task was stored. Returns at once and never throws; without ctx.waitUntil nothing is sent.
function downloadNotify(env, ctx, doi, taskId) {
  try {
    if (!ctx || typeof ctx.waitUntil !== 'function' || !env || !env.DOWNLOAD_NOTIFY_URL || !env.DOWNLOAD_NOTIFY_KEY || !env.QL_KV) return;
    ctx.waitUntil(downloadNotifyRun(env, doi, taskId));
  } catch { /* a notice never affects the request */ }
}
