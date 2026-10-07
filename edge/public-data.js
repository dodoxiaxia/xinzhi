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
  let downstream, reader, pending = new Uint8Array(), ended = false;
  const detach = () => request.signal.removeEventListener('abort', abort);
  const stopReader = async reason => { ended = true; detach(); if (reader) await reader.cancel(reason).catch(() => {}); };
  const abort = () => { const error = new Error('Request aborted'); void stopReader(error); if (downstream) downstream.error(error); };
  const read = async () => {
    if (request.signal.aborted || ended) throw new Error('Request aborted');
    const next = await reader.read();
    if (request.signal.aborted || ended) throw new Error('Request aborted');
    return next;
  };
  const encoder = new TextEncoder();
  const header = encoder.encode('window.PUBLIC_DATA_VERSION="' + PUBLIC_DATA_VERSION + '";');
  const start = encoder.encode(';\n;\nwindow.' + match[2] + '='), stop = encoder.encode(';\n;\n');
  try {
    const asset = await env.ASSETS.fetch(new Request(assetUrl, { signal: request.signal }));
    if (!asset.ok || !asset.body) { if (asset.body) await asset.body.cancel().catch(() => {}); return publicDataError(503, 'data_unavailable'); }
    reader = asset.body.getReader();
    request.signal.addEventListener('abort', abort, { once: true });
    while (pending.length < header.length) {
      const next = await read();
      if (next.done) { await stopReader(); return publicDataError(503, 'data_unavailable'); }
      pending = joinDataBytes(pending, next.value);
    }
    if (header.some((b, i) => pending[i] !== b)) {
      await stopReader(); return publicDataError(409, 'data_version_changed');
    }
    // Only a top-level builder assignment can match: JSON strings escape newlines.
    while (true) {
      const at = dataBytesIndex(pending, start);
      if (at >= 0) { pending = pending.slice(at + start.length); break; }
      pending = pending.slice(Math.max(0, pending.length - start.length + 1));
      const next = await read();
      if (next.done) { await stopReader(); return publicDataError(503, 'data_unavailable'); }
      pending = joinDataBytes(pending, next.value);
    }
    if (request.method === 'HEAD') {
      await stopReader(); return new Response(null, { headers: {
        'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-public-data-version': PUBLIC_DATA_VERSION, 'x-content-type-options': 'nosniff'
      } });
    }
  } catch (error) { await stopReader(error); return publicDataError(503, 'data_unavailable'); }
  const body = new ReadableStream({
    start(controller) { downstream = controller; },
    async pull(controller) {
      try {
        while (!ended) {
          const at = dataBytesIndex(pending, stop);
          if (at >= 0) {
            if (at) controller.enqueue(pending.slice(0, at));
            await stopReader(); controller.close(); return;
          }
          const length = Math.max(0, pending.length - stop.length + 1);
          if (length) {
            controller.enqueue(pending.slice(0, length)); pending = pending.slice(length); return;
          }
          const next = await read();
          if (next.done) throw new Error('Truncated public data assignment');
          pending = joinDataBytes(pending, next.value);
        }
      } catch (error) { await stopReader(error); controller.error(error); }
    },
    cancel(reason) { return stopReader(reason); }
  });
  return new Response(body, { headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-public-data-version': PUBLIC_DATA_VERSION, 'x-content-type-options': 'nosniff'
  } });
}
