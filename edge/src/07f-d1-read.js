// ==== edge/src/07f-d1-read.js · Optional read-only D1 display path for library records ====
const D1_READ_SWITCH_KEY = 'cfg:d1_read_enabled', D1_READ_SWITCH_TTL_MS = 60000;
let d1ReadSwitch = { on:false, at:-Infinity };

async function d1ReadEnabled(env) {
  const now = Date.now();
  if (now - d1ReadSwitch.at >= 0 && now - d1ReadSwitch.at < D1_READ_SWITCH_TTL_MS) return d1ReadSwitch.on;
  let on = false;
  try { on = (await env.QL_KV.get(D1_READ_SWITCH_KEY)) === '1'; } catch { on = false; }
  d1ReadSwitch = { on, at:now };
  return on;
}

async function libraryGetDisplay(env, key) {
  const db = env && env.LIBRARY_DB;
  if (!db || typeof db.prepare !== 'function' || typeof key !== 'string' || !key.startsWith('library:paper:')) return libraryGet(env.QL_KV, key);
  if (!(await d1ReadEnabled(env))) return libraryGet(env.QL_KV, key);
  try {
    const row = await db.prepare('SELECT value, deleted, expires_at FROM kv_mirror WHERE key = ?1').bind(key).first();
    if (!row) return libraryGet(env.QL_KV, key);
    if (row.deleted === 1 || row.deleted === true) return null;
    if (row.value === null || typeof row.value !== 'string') return libraryGet(env.QL_KV, key);
    if (row.expires_at !== null && row.expires_at !== undefined && Number(row.expires_at) <= Date.now()) return libraryGet(env.QL_KV, key);
    try { return JSON.parse(row.value); } catch { return libraryGet(env.QL_KV, key); }
  } catch {
    console.warn('d1 read: fallback to kv');
    return libraryGet(env.QL_KV, key);
  }
}
