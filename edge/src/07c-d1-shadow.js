// ==== edge/src/07c-d1-shadow.js · D1 shadow write of KV ledger keys (write-only, off by default) ====
// Every successful QL_KV put/delete for whitelisted ledger prefixes is mirrored asynchronously into D1 (table kv_mirror)
// via ctx.waitUntil after the response is built. Reads always stay on KV. Nothing is written unless BOTH:
//   (1) env.LIBRARY_DB (with prepare and batch) and env.QL_KV exist; and
//   (2) KV switch D1_SHADOW_SWITCH_KEY holds '1' (cached 60 s per isolate; missing, other value or read error = off).
//
// Mirrored prefixes (D1_SHADOW_PREFIXES):
//   账本类：
//   - 文献记录：library:paper:
//   - 全文任务与队列：library:job:、library:queue:、library:grok-job:、library:muse-job:、library:muse-queue:、
//     library:muse-review:、library:muse-superseded:、library:machine-register:
//   - 全文状态/尝试：library:attempt:
//   - 网盘归档登记：library:drive-pending:、library:drive:
//   - 索引：library:machine-index:v1（精确匹配这一个 key）
//
// Excluded prefixes (not mirrored):
//   - library:pdf:（PDF 二进制，已有 R2 备份，文献记录里有 sha256 和大小，行里放不下）
//   - library:muse-candidate:（待核验的 PDF 二进制，7 天 TTL）
//   - library:lock:、library:cap:、library:ip:（锁和读者限流计数，短期）
//   - library:machine-rate:（机器调用方每日配额和观察计数，2 天 TTL，属限流计数）
//   - library:diagnostic:、library:muse-review-dispatch（缓存/短期标记）
//   - ai:、lock:（AI 结果缓存、任务回执、AI 锁和读者额度）
//   - cfg:（配置开关，带外写入）
const D1_SHADOW_SWITCH_KEY = 'cfg:d1_shadow_enabled', D1_SHADOW_SWITCH_TTL_MS = 60000;
const D1_SHADOW_MAX_QUEUE = 200, D1_SHADOW_BATCH_SIZE = 50, D1_SHADOW_MAX_VALUE_BYTES = 1000000;
const D1_SHADOW_PREFIX_MAP = [
  ['library:paper:', 'paper'],
  ['library:job:', 'job'],
  ['library:queue:', 'queue'],
  ['library:grok-job:', 'grok_job'],
  ['library:muse-job:', 'muse_job'],
  ['library:muse-queue:', 'muse_queue'],
  ['library:muse-review:', 'muse_review'],
  ['library:muse-superseded:', 'muse_superseded'],
  ['library:machine-register:', 'machine_register'],
  ['library:attempt:', 'attempt'],
  ['library:drive-pending:', 'drive_pending'],
  ['library:drive:', 'drive'],
  ['library:machine-index:v1', 'index', true] // exact match only
];
const D1_SHADOW_PREFIXES = D1_SHADOW_PREFIX_MAP.map(entry => entry[0]);
const D1_SHADOW_UPSERT_SQL = 'INSERT INTO kv_mirror (key, entity, value, size, sha256, expires_at, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0) ON CONFLICT(key) DO UPDATE SET entity = excluded.entity, value = excluded.value, size = excluded.size, sha256 = excluded.sha256, expires_at = excluded.expires_at, updated_at = excluded.updated_at, deleted = 0 WHERE excluded.updated_at >= kv_mirror.updated_at';
const D1_SHADOW_DELETE_SQL = 'INSERT INTO kv_mirror (key, entity, value, size, sha256, expires_at, updated_at, deleted) VALUES (?1, ?2, NULL, 0, NULL, NULL, ?3, 1) ON CONFLICT(key) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at WHERE excluded.updated_at >= kv_mirror.updated_at';
let d1ShadowSwitch = { on: false, at: -Infinity };

function d1ShadowBound(env) {
  try {
    return !!(env && env.LIBRARY_DB && typeof env.LIBRARY_DB.prepare === 'function' && typeof env.LIBRARY_DB.batch === 'function' && env.QL_KV);
  } catch {
    return false;
  }
}

function d1ShadowEntity(key) {
  if (typeof key !== 'string') return '';
  for (const [prefix, entity, exact] of D1_SHADOW_PREFIX_MAP) {
    if (exact ? key === prefix : key.startsWith(prefix)) return entity;
  }
  return '';
}

function d1ShadowExpiresAt(options, updatedAt) {
  if (!options || typeof options !== 'object') return null;
  if (typeof options.expirationTtl === 'number' && Number.isFinite(options.expirationTtl)) return updatedAt + options.expirationTtl * 1000;
  if (typeof options.expiration === 'number' && Number.isFinite(options.expiration)) return options.expiration * 1000;
  return null;
}

// Per-isolate cache of the KV switch. A missing key, any other value or a failing read all mean off.
async function d1ShadowEnabled(env) {
  const now = Date.now();
  if (now - d1ShadowSwitch.at >= 0 && now - d1ShadowSwitch.at < D1_SHADOW_SWITCH_TTL_MS) return d1ShadowSwitch.on;
  let on = false;
  try { on = (await env.QL_KV.get(D1_SHADOW_SWITCH_KEY)) === '1'; } catch { on = false; }
  d1ShadowSwitch = { on, at: now };
  return on;
}

// Called at the start of every request: returns the original env untouched when D1 is unbound,
// or a shallow copy with a Proxy-wrapped QL_KV plus flush(ctx) when LIBRARY_DB and QL_KV exist.
function d1ShadowBind(env) {
  if (!d1ShadowBound(env)) return { env, flush() {} };
  try {
    const rawEnv = env;
    const rawKv = env.QL_KV;
    const queue = new Map();
    let flushed = false;
    let savedCtx = null;

    function drain(ctx) {
      if (!queue.size) return;
      const items = [...queue.values()];
      queue.clear();
      if (!ctx || typeof ctx.waitUntil !== 'function') return;
      ctx.waitUntil(d1ShadowRun(rawEnv, items));
    }

    async function put(key, value, options) {
      const result = await rawKv.put(key, value, options);
      try {
        const entity = d1ShadowEntity(key);
        if (entity && typeof value === 'string' && (queue.has(key) || queue.size < D1_SHADOW_MAX_QUEUE)) {
          const updatedAt = Date.now();
          queue.set(key, {
            key,
            entity,
            value,
            expiresAt: d1ShadowExpiresAt(options, updatedAt),
            updatedAt,
            deleted: false
          });
          if (flushed) drain(savedCtx);
        }
      } catch { /* shadow write never affects KV or the request */ }
      return result;
    }

    async function del(key, ...rest) {
      const result = await rawKv.delete(key, ...rest);
      try {
        const entity = d1ShadowEntity(key);
        if (entity && (queue.has(key) || queue.size < D1_SHADOW_MAX_QUEUE)) {
          queue.set(key, {
            key,
            entity,
            updatedAt: Date.now(),
            deleted: true
          });
          if (flushed) drain(savedCtx);
        }
      } catch { /* shadow write never affects KV or the request */ }
      return result;
    }

    const proxy = new Proxy(rawKv, {
      get(target, prop) {
        if (prop === 'put') return put;
        if (prop === 'delete') return del;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });

    return {
      env: { ...env, QL_KV: proxy },
      flush(ctx) {
        try {
          flushed = true;
          savedCtx = ctx;
          drain(ctx);
        } catch { /* shadow write never affects the response */ }
      }
    };
  } catch {
    return { env, flush() {} };
  }
}

async function d1ShadowRun(env, items) {
  try {
    if (!d1ShadowBound(env) || !Array.isArray(items) || !items.length) return;
    if (!(await d1ShadowEnabled(env))) return;
    const encoder = new TextEncoder();
    for (let i = 0; i < items.length; i += D1_SHADOW_BATCH_SIZE) {
      const chunk = items.slice(i, i + D1_SHADOW_BATCH_SIZE);
      try {
        const stmts = [];
        for (const item of chunk) {
          if (item.deleted) {
            stmts.push(env.LIBRARY_DB.prepare(D1_SHADOW_DELETE_SQL).bind(item.key, item.entity, item.updatedAt));
          } else {
            const bytes = encoder.encode(item.value);
            const size = bytes.length;
            const sha256 = await pdfDigest('SHA-256', bytes);
            const storedValue = size > D1_SHADOW_MAX_VALUE_BYTES ? null : item.value;
            stmts.push(env.LIBRARY_DB.prepare(D1_SHADOW_UPSERT_SQL).bind(
              item.key, item.entity, storedValue, size, sha256, item.expiresAt, item.updatedAt
            ));
          }
        }
        if (stmts.length) await env.LIBRARY_DB.batch(stmts);
      } catch {
        console.warn('d1 shadow: write failed'); // fixed text only: no key, DOI, value or error detail
      }
    }
  } catch { /* shadow write never throws */ }
}
