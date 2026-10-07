// Public, allowlisted static data only. No KV, credentials, PDF or model access.
const PUBLIC_DATA_VERSION = '';
const PUBLIC_DATA_NAMES = new Set(['FEEDS', 'RECENT_RADAR', 'RADAR']);

function publicDataError(status, reason) {
  return new Response(JSON.stringify({ error: reason }), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  } });
}
function dataBytesIndex(bytes, pattern) {
  for (let i = bytes.indexOf(pattern[0]); i >= 0 && i <= bytes.length - pattern.length;
       i = bytes.indexOf(pattern[0], i + 1)) {
    let j = 1;
    while (j < pattern.length && bytes[i + j] === pattern[j]) j++;
    if (j === pattern.length) return i;
  }
  return -1;
}
function joinDataBytes(a, b) {
  const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out;
}

async function handlePublicData(request, env) {
  const url = new URL(request.url);
  const match = /^\/public-data\/([a-f0-9]{64})\/(FEEDS|RECENT_RADAR|RADAR)\.json$/.exec(url.pathname);
  if (!match || !PUBLIC_DATA_NAMES.has(match[2])) return publicDataError(404, 'data_not_found');
  if (!['GET', 'HEAD'].includes(request.method)) return publicDataError(405, 'method_not_allowed');
  if (match[1] !== PUBLIC_DATA_VERSION) return publicDataError(409, 'data_version_changed');
  const assetUrl = new URL('/public.js', url.origin);
  // Do not forward browser cookies, Authorization, Range or caller-supplied paths.
  const asset = await env.ASSETS.fetch(new Request(assetUrl, { signal: request.signal }));
  if (!asset.ok || !asset.body) return publicDataError(503, 'data_unavailable');
  const reader = asset.body.getReader(), encoder = new TextEncoder();
  const header = encoder.encode('window.PUBLIC_DATA_VERSION="' + PUBLIC_DATA_VERSION + '";');
  let pending = new Uint8Array(), ended = false;
  while (pending.length < header.length) {
    const next = await reader.read();
    if (next.done) { await reader.cancel(); return publicDataError(503, 'data_unavailable'); }
    pending = joinDataBytes(pending, next.value);
  }
  if (header.some((b, i) => pending[i] !== b)) {
    await reader.cancel(); return publicDataError(409, 'data_version_changed');
  }
  const start = encoder.encode(';\n;\nwindow.' + match[2] + '='), stop = encoder.encode(';\n;\n');
  // Only a top-level builder assignment can match: JSON strings escape newlines.
  while (true) {
    const at = dataBytesIndex(pending, start);
    if (at >= 0) { pending = pending.slice(at + start.length); break; }
    pending = pending.slice(Math.max(0, pending.length - start.length + 1));
    const next = await reader.read();
    if (next.done) { await reader.cancel(); return publicDataError(503, 'data_unavailable'); }
    pending = joinDataBytes(pending, next.value);
  }
  if (request.method === 'HEAD') {
    await reader.cancel(); return new Response(null, { headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-public-data-version': PUBLIC_DATA_VERSION, 'x-content-type-options': 'nosniff'
    } });
  }
  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (!ended) {
          const at = dataBytesIndex(pending, stop);
          if (at >= 0) {
            if (at) controller.enqueue(pending.slice(0, at));
            ended = true; await reader.cancel(); controller.close(); return;
          }
          const length = Math.max(0, pending.length - stop.length + 1);
          if (length) {
            controller.enqueue(pending.slice(0, length)); pending = pending.slice(length); return;
          }
          const next = await reader.read();
          if (next.done) throw new Error('Truncated public data assignment');
          pending = joinDataBytes(pending, next.value);
        }
      } catch (error) { ended = true; await reader.cancel(); controller.error(error); }
    },
    cancel(reason) { ended = true; return reader.cancel(reason); }
  });
  return new Response(body, { headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-public-data-version': PUBLIC_DATA_VERSION, 'x-content-type-options': 'nosniff'
  } });
}
