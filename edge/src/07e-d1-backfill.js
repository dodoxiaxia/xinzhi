// ==== edge/src/07e-d1-backfill.js · One-time KV -> D1 kv_mirror backfill and per-key reconcile (verify by default) ====
// POST /api/machine/d1-backfill, fallback role only. The live shadow write (07c-d1-shadow.js) mirrors only keys written after it was
// switched on, so keys that already existed in KV have no D1 row. This endpoint closes that gap and reports the remaining difference.
//   Request body: {"prefix":"<one of D1_SHADOW_PREFIXES>","side":"kv"|"d1","cursor":"","limit":1..100,"apply":true}
//   side "kv" (default): walk the KV keys of one prefix. Each key is compared with its D1 row; with apply, missing, tombstoned and
//                        different rows are upserted from the KV value (KV is the ledger, D1 only a copy).
//   side "d1":           walk the D1 rows of one prefix. A live row whose KV key is gone (and whose TTL has not run out) is a D1-only
//                        row; with apply it is marked deleted (a tombstone, never DELETE FROM).
//   - Without "apply" nothing is written: the reply is the difference report (verify). Needs only LIBRARY_DB and QL_KV.
//   - Writing needs BOTH "apply":true AND the variable D1_BACKFILL_ENABLED = 'true' (off by default). Re-running changes nothing:
//     every write is the shadow's own conditional upsert, so a row that already matches is rewritten with identical content.
//   - Race with the live shadow: updated_at is the moment BEFORE the KV value was read, and the upsert only applies when
//     excluded.updated_at >= kv_mirror.updated_at, so a shadow write that happened after our read always wins.
//   - Rows are written exactly as the shadow writes them (UTF-8 sha256 of the raw string, value NULL above 1,000,000 bytes,
//     expires_at from the key's KV expiration).
//   The reply never contains a KV value; sample key names (at most 10 per category) are returned.
const D1_BACKFILL_SWITCH = 'D1_BACKFILL_ENABLED';
const D1_BACKFILL_LIMIT_DEFAULT = 50, D1_BACKFILL_LIMIT_MAX = 100, D1_BACKFILL_IN_BATCH = 50, D1_BACKFILL_SAMPLE = 10;
// A D1 row written less than this long ago may be a live shadow write racing the comparison: counted as 'recent', not as a difference.
const D1_BACKFILL_GRACE_MS = 120000, D1_BACKFILL_EXPIRY_GRACE_MS = 300000;
const D1_BACKFILL_SELECT_COLUMNS = 'key, entity, sha256, size, expires_at, updated_at, deleted';
const D1_BACKFILL_DIFF_CATEGORIES = ['missing_in_d1', 'kv_present_d1_deleted', 'value_diff', 'missing_in_kv'];

function d1BackfillCounters() {
  const counts = {same: 0, kv_present: 0, recent: 0, gone: 0, expired_ok: 0, deleted_ok: 0, missing_in_d1: 0, kv_present_d1_deleted: 0, value_diff: 0, missing_in_kv: 0};
  return {counts, samples: {}, written: 0};
}
function d1BackfillNote(state, category, key) {
  state.counts[category]++;
  if (D1_BACKFILL_DIFF_CATEGORIES.includes(category)) {
    const list = state.samples[category] || (state.samples[category] = []);
    if (list.length < D1_BACKFILL_SAMPLE) list.push(key);
  }
}
async function d1BackfillRows(env, keys) {
  const rows = new Map();
  for (let i = 0; i < keys.length; i += D1_BACKFILL_IN_BATCH) {
    const chunk = keys.slice(i, i + D1_BACKFILL_IN_BATCH);
    const sql = 'SELECT ' + D1_BACKFILL_SELECT_COLUMNS + ' FROM kv_mirror WHERE key IN (' + chunk.map((_, n) => '?' + (n + 1)).join(', ') + ')';
    let result;
    try { result = await env.LIBRARY_DB.prepare(sql).bind(...chunk).all(); } catch { libraryFail('machine_d1_read', 503); }
    for (const row of result && Array.isArray(result.results) ? result.results : []) rows.set(row.key, row);
  }
  return rows;
}
async function d1BackfillWrite(env, statements) {
  for (let i = 0; i < statements.length; i += D1_SHADOW_BATCH_SIZE) {
    try { await env.LIBRARY_DB.batch(statements.slice(i, i + D1_SHADOW_BATCH_SIZE)); } catch { libraryFail('machine_d1_write', 503); }
  }
}

// side "kv": one page of KV keys of the prefix.
async function d1BackfillKvPage(env, prefix, cursor, limit, apply) {
  const listing = await machineListKeys(env, prefix, cursor, limit);
  const state = d1BackfillCounters();
  const keys = listing.keys.filter(entry => typeof entry.name === 'string' && entry.name.startsWith(prefix));
  const rows = await d1BackfillRows(env, keys.map(entry => entry.name));
  const statements = [];
  const encoder = new TextEncoder();
  for (const entry of keys) {
    const key = entry.name, entity = d1ShadowEntity(key);
    if (!entity) continue;
    const readAt = Date.now(); // BEFORE the read: a shadow write after this moment must win the conditional upsert
    let value;
    try { value = await env.QL_KV.get(key); } catch { libraryFail('library_storage', 503); }
    if (typeof value !== 'string') { state.counts.gone++; continue; } // deleted or expired between the list and the read
    const bytes = encoder.encode(value);
    const sha256 = await pdfDigest('SHA-256', bytes);
    const row = rows.get(key);
    let category;
    if (!row) category = 'missing_in_d1';
    else if (row.deleted) category = 'kv_present_d1_deleted';
    else if (row.sha256 === sha256) category = 'same';
    else category = Number.isFinite(row.updated_at) && Date.now() - row.updated_at < D1_BACKFILL_GRACE_MS ? 'recent' : 'value_diff';
    d1BackfillNote(state, category, key);
    if (apply && D1_BACKFILL_DIFF_CATEGORIES.includes(category)) {
      const expiresAt = Number.isFinite(entry.expiration) ? entry.expiration * 1000 : null;
      statements.push(env.LIBRARY_DB.prepare(D1_SHADOW_UPSERT_SQL).bind(key, entity, bytes.length > D1_SHADOW_MAX_VALUE_BYTES ? null : value, bytes.length, sha256, expiresAt, readAt));
    }
  }
  if (statements.length) { await d1BackfillWrite(env, statements); state.written = statements.length; }
  const more = !listing.list_complete && typeof listing.cursor === 'string' && !!listing.cursor;
  return {state, scanned: keys.length, more, cursor: more ? listing.cursor : ''};
}

// side "d1": one page of D1 rows of the prefix, in key order. The cursor is the last key returned.
async function d1BackfillD1Page(env, prefix, cursor, limit, apply) {
  const lower = cursor && cursor > prefix ? cursor : prefix;
  const sql = 'SELECT ' + D1_BACKFILL_SELECT_COLUMNS + ' FROM kv_mirror WHERE key > ?1 AND key >= ?2 AND key < ?3 ORDER BY key LIMIT ?4';
  let result;
  try { result = await env.LIBRARY_DB.prepare(sql).bind(cursor || '', lower, prefix + '\u{10FFFF}', limit).all(); } catch { libraryFail('machine_d1_read', 503); }
  const rows = result && Array.isArray(result.results) ? result.results : [];
  const state = d1BackfillCounters();
  const statements = [];
  for (const row of rows) {
    if (typeof row.key !== 'string' || !row.key.startsWith(prefix)) continue;
    if (row.deleted) { state.counts.deleted_ok++; continue; }
    const readAt = Date.now();
    let value;
    try { value = await env.QL_KV.get(row.key); } catch { libraryFail('library_storage', 503); }
    if (typeof value === 'string') { state.counts.kv_present++; continue; } // the key exists: the kv side judges its content
    if (Number.isFinite(row.expires_at) && row.expires_at + D1_BACKFILL_EXPIRY_GRACE_MS < Date.now()) { state.counts.expired_ok++; continue; }
    if (Number.isFinite(row.updated_at) && Date.now() - row.updated_at < D1_BACKFILL_GRACE_MS) { state.counts.recent++; continue; }
    d1BackfillNote(state, 'missing_in_kv', row.key);
    if (apply) statements.push(env.LIBRARY_DB.prepare(D1_SHADOW_DELETE_SQL).bind(row.key, row.entity || d1ShadowEntity(row.key), readAt));
  }
  if (statements.length) { await d1BackfillWrite(env, statements); state.written = statements.length; }
  const more = rows.length === limit;
  return {state, scanned: rows.length, more, cursor: more ? rows[rows.length - 1].key : ''};
}

async function handleMachineD1Backfill(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    // 'abandon' is held by the fallback role only (the role that may already close tasks by hand).
    await machineAuthorize(request, env, 'abandon');
    const input = await fulltextReadJson(request, 2048, 'machine_bad_request');
    if (Object.keys(input).some(key => !['prefix', 'side', 'cursor', 'limit', 'apply'].includes(key))) libraryFail('machine_bad_request', 400);
    if (typeof input.prefix !== 'string' || !D1_SHADOW_PREFIXES.includes(input.prefix)) libraryFail('machine_bad_request', 400);
    const side = Object.hasOwn(input, 'side') ? input.side : 'kv';
    if (side !== 'kv' && side !== 'd1') libraryFail('machine_bad_request', 400);
    if (Object.hasOwn(input, 'apply') && typeof input.apply !== 'boolean') libraryFail('machine_bad_request', 400);
    if (Object.hasOwn(input, 'cursor') && (typeof input.cursor !== 'string' || input.cursor.length > 2000)) libraryFail('machine_bad_request', 400);
    const limit = Object.hasOwn(input, 'limit') ? input.limit : D1_BACKFILL_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > D1_BACKFILL_LIMIT_MAX) libraryFail('machine_bad_request', 400);
    const enabled = env[D1_BACKFILL_SWITCH] === 'true', apply = input.apply === true;
    if (apply && !enabled) libraryFail('machine_d1_backfill_disabled', 403);
    if (!d1ShadowBound(env)) libraryFail('machine_d1_unbound', 503);
    const page = side === 'kv' ? await d1BackfillKvPage(env, input.prefix, input.cursor || '', limit, apply) : await d1BackfillD1Page(env, input.prefix, input.cursor || '', limit, apply);
    const diff = D1_BACKFILL_DIFF_CATEGORIES.reduce((sum, name) => sum + page.state.counts[name], 0);
    return json({ok: true, mode: apply ? 'apply' : 'verify', applyEnabled: enabled, prefix: input.prefix, side, scanned: page.scanned,
      counts: page.state.counts, diff, written: page.state.written, samples: page.state.samples, done: !page.more, ...(page.more ? {cursor: page.cursor} : {})}, 200, {'cache-control': 'no-store'});
  } catch (error) { return machineError(error); }
}
