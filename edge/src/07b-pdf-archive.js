// ==== edge/src/07b-pdf-archive.js · R2 backup of stored PDFs (write-only, off by default) ====
// Every place that stores verified PDF bytes under library:pdf:<sha256> (librarySave and machineReplacePdf) queues the
// bytes here. After the response is built, the router hands the queue to ctx.waitUntil. Nothing is written unless BOTH
// the PDF_ARCHIVE R2 binding exists AND the KV switch PDF_ARCHIVE_SWITCH_KEY holds '1'. R2 is only written, never read:
// downloads still come from KV. The object key is the SHA-256 of the bytes; head first, so an existing object is kept.
// Metadata is limited to the content type, sha256 and size. Nothing in here may change a response or throw.
const PDF_ARCHIVE_SWITCH_KEY = 'cfg:r2_archive_enabled', PDF_ARCHIVE_SWITCH_TTL_MS = 60000, PDF_ARCHIVE_PREFIX = 'pdf/sha256/', PDF_ARCHIVE_MAX_QUEUE = 8;
let pdfArchiveSwitch = { on: false, at: 0 }, pdfArchiveBound = false, pdfArchiveQueue = [];

// Called at the start of every request: queue only when the binding exists, so an unbound site holds no extra bytes.
function pdfArchiveBind(env) {
  try { pdfArchiveBound = !!(env && env.PDF_ARCHIVE && typeof env.PDF_ARCHIVE.head === 'function' && typeof env.PDF_ARCHIVE.put === 'function' && env.QL_KV); } catch { pdfArchiveBound = false; }
}
// Called right after the PDF bytes were stored in KV. `bytes` is the Uint8Array that was stored; it is not modified.
function pdfArchiveQueueBytes(sha256, bytes) {
  try {
    if (!pdfArchiveBound || !/^[a-f0-9]{64}$/.test(sha256) || !bytes || !bytes.length) return;
    if (pdfArchiveQueue.length < PDF_ARCHIVE_MAX_QUEUE) pdfArchiveQueue.push({ sha256, bytes });
  } catch { /* archiving never affects the request */ }
}
// Per-isolate cache of the KV switch. A missing key, any other value or a failing read all mean off.
async function pdfArchiveEnabled(env) {
  const now = Date.now();
  if (now - pdfArchiveSwitch.at >= 0 && now - pdfArchiveSwitch.at < PDF_ARCHIVE_SWITCH_TTL_MS) return pdfArchiveSwitch.on;
  let on = false;
  try { on = (await env.QL_KV.get(PDF_ARCHIVE_SWITCH_KEY)) === '1'; } catch { on = false; }
  pdfArchiveSwitch = { on, at: now };
  return on;
}
// Called after the response exists (also when routing threw). Takes the queue and returns at once; the work runs in waitUntil.
function pdfArchiveFlush(env, ctx) {
  try {
    if (!pdfArchiveQueue.length) return;
    const items = pdfArchiveQueue.splice(0);
    if (!env || !env.PDF_ARCHIVE || !env.QL_KV) return;
    const work = pdfArchiveRun(env, items);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  } catch { /* archiving never affects the request */ }
}
async function pdfArchiveRun(env, items) {
  try {
    if (!(await pdfArchiveEnabled(env))) return;
    const seen = new Set();
    for (const { sha256, bytes } of items) {
      if (seen.has(sha256)) continue;
      seen.add(sha256);
      const key = PDF_ARCHIVE_PREFIX + sha256 + '.pdf';
      let stage = 'head';
      try {
        if (await env.PDF_ARCHIVE.head(key)) continue;
        stage = 'put';
        await env.PDF_ARCHIVE.put(key, bytes, { sha256, httpMetadata: { contentType: 'application/pdf' }, customMetadata: { sha256, size: String(bytes.length) } });
      } catch { console.warn('pdf archive: ' + stage + ' failed'); } // fixed text only: no key, DOI or error detail
    }
  } catch { /* archiving never affects the request */ }
}
