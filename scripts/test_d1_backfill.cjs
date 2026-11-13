'use strict';
// Offline: POST /api/machine/d1-backfill. KV is the ledger; kv_mirror in D1 is a copy that the live shadow write only fills going forward.
// verify (default) reports the difference and writes nothing; apply needs apply:true in the body AND D1_BACKFILL_ENABLED=true.
// Hooked in at the end of test_d1_shadow.cjs (which test_muse_reader_upload.cjs already runs).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createHash} = require('crypto');
const {harness} = require('./test_doi_library_worker.cjs');

const base = 'https://learn.dryz.info';
const fallbackToken = 'synthetic_fallback_token_0123456789abc';
const downloaderToken = 'synthetic_downloader_token_0123456789ab';
const tokens = JSON.stringify([{id: 'fallback-bot', role: 'fallback', token: fallbackToken}, {id: 'dsh', role: 'downloader', token: downloaderToken}]);
const NOW = Date.parse('2026-11-14T02:00:00Z');
const sha = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const JOB = 'library:muse-job:', PAPER = 'library:paper:';

function selectRows(rows, sql, args) {
  if (/WHERE key IN \(/.test(sql)) return args.map(key => rows.get(key)).filter(Boolean);
  if (sql.includes('WHERE key > ?1 AND key >= ?2 AND key < ?3 ORDER BY key LIMIT ?4')) {
    const [after, lower, upper, limit] = args;
    return [...rows.values()].filter(r => r.key > after && r.key >= lower && r.key < upper).sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, limit);
  }
  throw new Error('Unexpected SELECT in mock D1: ' + sql);
}
function applyStatement(rows, {sql, args}) {
  if (sql.includes('deleted = 0 WHERE excluded.updated_at >= kv_mirror.updated_at')) {
    const [key, entity, value, size, sha256, expires_at, updated_at] = args, old = rows.get(key);
    if (!old || updated_at >= old.updated_at) rows.set(key, {key, entity, value, size, sha256, expires_at, updated_at, deleted: 0});
  } else if (sql.includes('deleted = 1, updated_at = excluded.updated_at WHERE excluded.updated_at >= kv_mirror.updated_at')) {
    const [key, entity, updated_at] = args, old = rows.get(key);
    if (!old) rows.set(key, {key, entity, value: null, size: 0, sha256: null, expires_at: null, updated_at, deleted: 1});
    else if (updated_at >= old.updated_at) rows.set(key, {...old, deleted: 1, updated_at});
  } else throw new Error('Unexpected write in mock D1: ' + sql);
}

function create(options = {}) {
  const clock = {now: NOW};
  const h = harness({clock});
  h.clock = clock;
  h.env.MACHINE_TOKENS = tokens;
  h.rows = new Map(); h.selects = []; h.batches = [];
  const rawList = h.env.QL_KV.list;
  h.expirations = new Map();
  h.env.QL_KV = {...h.env.QL_KV, list: async opts => {
    const listing = await rawList(opts);
    return {...listing, keys: listing.keys.map(k => (h.expirations.has(k.name) ? {...k, expiration: h.expirations.get(k.name)} : k))};
  }};
  if (options.binding !== false) h.env.LIBRARY_DB = {
    prepare(sql) {
      return {bind: (...args) => ({sql, args, all: async () => {
        h.selects.push({sql, args});
        if (options.readError) throw new Error('synthetic read failure secret=' + fallbackToken);
        return {results: selectRows(h.rows, sql, args).map(r => ({...r}))};
      }})};
    },
    async batch(stmts) {
      if (options.writeError) throw new Error('synthetic write failure secret=' + fallbackToken);
      h.batches.push(stmts.slice());
      for (const stmt of stmts) applyStatement(h.rows, stmt);
      return stmts.map(() => ({success: true}));
    }
  };
  h.put = (key, value) => h.values.set(key, value);
  h.row = (key, entity, value, extra = {}) => h.rows.set(key, {key, entity, value, size: Buffer.byteLength(value), sha256: sha(value), expires_at: null, updated_at: NOW - 3600000, deleted: 0, ...extra});
  h.call = (body, config = {}) => h.context.worker.fetch(new Request(base + '/api/machine/d1-backfill', {
    method: config.method || 'POST',
    headers: {'content-type': 'application/json', ...(config.noAuth ? {} : {authorization: 'Bearer ' + (config.token || fallbackToken)})},
    ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})
  }), h.env);
  return h;
}
const snapshot = h => JSON.stringify([...h.rows.entries()].sort());
const kvSnapshot = h => JSON.stringify([...h.values.entries()].map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('base64') : v]));

(async () => {
  // Fixture for the library:muse-job: prefix.
  //  j1 same | j2 missing in D1 | j3 D1 row is a tombstone | j4 D1 content differs (old row) | j5 D1 content differs but written 1 s ago (recent)
  //  d1-only: x1 live row, KV gone, old (missing_in_kv) | x2 live row, KV gone, TTL ran out (expired_ok) | x3 tombstone (deleted_ok)
  function fixture(options) {
    const h = create(options);
    for (const n of [1, 2, 3, 4, 5]) h.put(JOB + '10.1000/j' + n, JSON.stringify({doi: '10.1000/j' + n, n, secretish: 'value-' + n}));
    h.row(JOB + '10.1000/j1', 'muse_job', h.values.get(JOB + '10.1000/j1'));
    h.row(JOB + '10.1000/j3', 'muse_job', h.values.get(JOB + '10.1000/j3'), {deleted: 1});
    h.row(JOB + '10.1000/j4', 'muse_job', '{"stale":true}');
    h.row(JOB + '10.1000/j5', 'muse_job', '{"stale":true}', {updated_at: NOW - 1000});
    h.row(JOB + '10.1000/x1', 'muse_job', '{"gone":1}');
    h.row(JOB + '10.1000/x2', 'muse_job', '{"gone":2}', {expires_at: NOW - 3600000});
    h.row(JOB + '10.1000/x3', 'muse_job', '{"gone":3}', {deleted: 1});
    return h;
  }
  const kvPass = async (h, body = {}) => (await h.call({prefix: JOB, ...body})).json();
  const d1Pass = async (h, body = {}) => (await h.call({prefix: JOB, side: 'd1', ...body})).json();

  // 1. verify (default): the full difference, no write, no value in the reply, even with the switch on.
  let h = fixture(); h.env.D1_BACKFILL_ENABLED = 'true';
  let rowsBefore = snapshot(h), kvBefore = kvSnapshot(h);
  let res = await h.call({prefix: JOB}); assert.equal(res.status, 200);
  let text = await res.text(), body = JSON.parse(text);
  assert.equal(body.mode, 'verify'); assert.equal(body.side, 'kv'); assert.equal(body.done, true); assert.equal(body.scanned, 5);
  assert.equal(body.counts.same, 1); assert.equal(body.counts.missing_in_d1, 1); assert.equal(body.counts.kv_present_d1_deleted, 1);
  assert.equal(body.counts.value_diff, 1); assert.equal(body.counts.recent, 1); assert.equal(body.diff, 3); assert.equal(body.written, 0);
  assert.deepEqual(body.samples.missing_in_d1, [JOB + '10.1000/j2']); assert.deepEqual(body.samples.value_diff, [JOB + '10.1000/j4']);
  assert(!text.includes('value-') && !text.includes('secretish'), 'the reply carries key names only, never a KV value');
  assert.equal(h.batches.length, 0); assert.equal(snapshot(h), rowsBefore); assert.equal(kvSnapshot(h), kvBefore);
  let d1 = await d1Pass(h);
  assert.equal(d1.mode, 'verify'); assert.equal(d1.scanned, 7); assert.equal(d1.counts.kv_present, 3); assert.equal(d1.counts.missing_in_kv, 1);
  assert.equal(d1.counts.expired_ok, 1); assert.equal(d1.counts.deleted_ok, 2); assert.deepEqual(d1.samples.missing_in_kv, [JOB + '10.1000/x1']);
  assert.equal(h.batches.length, 0); assert.equal(snapshot(h), rowsBefore);

  // 2. apply is refused unless BOTH gates are open; nothing is written.
  h = fixture(); rowsBefore = snapshot(h);
  res = await h.call({prefix: JOB, apply: true}); assert.equal(res.status, 403); assert.equal((await res.json()).error, 'machine_d1_backfill_disabled');
  h.env.D1_BACKFILL_ENABLED = '1'; assert.equal((await h.call({prefix: JOB, apply: true})).status, 403, 'only the string true switches it on');
  assert.equal(h.batches.length, 0); assert.equal(snapshot(h), rowsBefore);

  // 3. apply with both gates: missing, tombstoned and different rows are filled from KV; 'recent' is left to the shadow; then the diff is 0.
  h = fixture(); h.env.D1_BACKFILL_ENABLED = 'true'; kvBefore = kvSnapshot(h);
  body = await kvPass(h, {apply: true});
  assert.equal(body.mode, 'apply'); assert.equal(body.written, 3); assert.equal(body.counts.recent, 1);
  for (const n of [2, 3, 4]) {
    const key = JOB + '10.1000/j' + n, row = h.rows.get(key), value = h.values.get(key);
    assert.equal(row.value, value, 'row ' + n); assert.equal(row.sha256, sha(value)); assert.equal(row.size, Buffer.byteLength(value));
    assert.equal(row.deleted, 0); assert.equal(row.entity, 'muse_job'); assert.equal(row.updated_at, NOW);
  }
  assert.equal(h.rows.get(JOB + '10.1000/j5').value, '{"stale":true}', 'a row written moments ago is the shadow\'s to keep');
  assert.equal(kvSnapshot(h), kvBefore, 'KV is never written');
  d1 = await d1Pass(h, {apply: true});
  assert.equal(d1.written, 1); assert.equal(h.rows.get(JOB + '10.1000/x1').deleted, 1, 'a D1-only row becomes a tombstone');
  assert(!h.batches.flat().some(s => /DELETE\s+FROM/i.test(s.sql)), 'no row is ever deleted');
  // After the shadow's grace the remaining 'recent' row is compared like any other and the whole prefix reconciles to 0.
  h.clock.now = NOW + 300000;
  body = await kvPass(h); d1 = await d1Pass(h);
  assert.equal(body.diff, 1, 'j5 still holds the old content and is now past its grace'); assert.equal(d1.diff, 0);
  body = await kvPass(h, {apply: true}); assert.equal(body.written, 1);
  body = await kvPass(h); d1 = await d1Pass(h);
  assert.equal(body.diff, 0); assert.equal(d1.diff, 0); assert.equal(body.counts.same, 5);

  // 4. Idempotent: a second apply finds nothing to write and the rows stay byte for byte the same.
  const settled = snapshot(h); const batchesBefore = h.batches.length;
  body = await kvPass(h, {apply: true}); d1 = await d1Pass(h, {apply: true});
  assert.equal(body.written, 0); assert.equal(d1.written, 0); assert.equal(h.batches.length, batchesBefore); assert.equal(snapshot(h), settled);

  // 5. Race with the live shadow: a shadow write that lands after our KV read (newer updated_at) is never overwritten.
  h = create(); h.env.D1_BACKFILL_ENABLED = 'true';
  h.put(JOB + '10.1000/r1', '{"v":"kv-old"}');
  const realGet = h.env.QL_KV.get;
  h.env.QL_KV = {...h.env.QL_KV, get: async (k, t) => {
    const value = await realGet(k, t);
    if (k === JOB + '10.1000/r1') { h.clock.now += 50; h.rows.set(k, {key: k, entity: 'muse_job', value: '{"v":"kv-new"}', size: 15, sha256: sha('{"v":"kv-new"}'), expires_at: null, updated_at: h.clock.now, deleted: 0}); }
    return value;
  }};
  body = await kvPass(h, {apply: true}); assert.equal(body.counts.missing_in_d1, 1, 'D1 had no row when we compared, then the shadow wrote one during our KV read');
  assert.equal(h.rows.get(JOB + '10.1000/r1').value, '{"v":"kv-new"}', 'updated_at is the moment before the KV read, so the shadow\'s newer row survives');
  h = create(); h.env.D1_BACKFILL_ENABLED = 'true'; h.put(JOB + '10.1000/r2', '{"v":"kv-old"}');
  h.env.LIBRARY_DB.prepare = (orig => sql => { const stmt = orig(sql); return {bind: (...args) => {
    const bound = stmt.bind(...args);
    if (sql.startsWith('SELECT')) return {...bound, all: async () => { const out = await bound.all(); // the shadow writes between our read of D1 and our write
      h.clock.now += 50; h.rows.set(JOB + '10.1000/r2', {key: JOB + '10.1000/r2', entity: 'muse_job', value: '{"v":"kv-new"}', size: 15, sha256: sha('{"v":"kv-new"}'), expires_at: null, updated_at: h.clock.now + 1000, deleted: 0}); return out; }};
    return bound; }}; })(h.env.LIBRARY_DB.prepare.bind(h.env.LIBRARY_DB));
  body = await kvPass(h, {apply: true}); assert.equal(body.counts.missing_in_d1, 1); assert.equal(body.written, 1);
  assert.equal(h.rows.get(JOB + '10.1000/r2').value, '{"v":"kv-new"}', 'the newer shadow row wins the conditional upsert');

  // 6. Row shape: expiration from the KV list, NULL value above 1,000,000 bytes with the true size and hash.
  h = create(); h.env.D1_BACKFILL_ENABLED = 'true';
  const big = 'x'.repeat(1000001);
  h.put(PAPER + '10.1000/big', big); h.put(PAPER + '10.1000/ttl', '{"t":1}'); h.expirations.set(PAPER + '10.1000/ttl', Math.floor(NOW / 1000) + 3600);
  body = await kvPass(h, {prefix: PAPER, apply: true}); assert.equal(body.written, 2);
  const bigRow = h.rows.get(PAPER + '10.1000/big'); assert.equal(bigRow.value, null); assert.equal(bigRow.size, 1000001); assert.equal(bigRow.sha256, sha(big)); assert.equal(bigRow.entity, 'paper');
  assert.equal(h.rows.get(PAPER + '10.1000/ttl').expires_at, (Math.floor(NOW / 1000) + 3600) * 1000);
  assert.equal(h.rows.get(PAPER + '10.1000/big').updated_at, NOW);

  // 7. Paging: limit 2 over five keys is three requests; cursors chain and end with done.
  h = fixture(); let seen = 0, pages = 0, cursor = '';
  do { body = await kvPass(h, {limit: 2, ...(cursor ? {cursor} : {})}); seen += body.scanned; cursor = body.cursor; pages++; assert(pages < 10); } while (!body.done);
  assert.equal(pages, 3); assert.equal(seen, 5);
  seen = 0; pages = 0; cursor = '';
  do { body = await d1Pass(h, {limit: 3, ...(cursor ? {cursor} : {})}); seen += body.scanned; cursor = body.cursor; pages++; assert(pages < 10); } while (!body.done);
  assert.equal(seen, 7); assert.equal(pages, 3);

  // 8. Only whitelisted prefixes; other prefixes (pdf blobs, config, locks) are refused.
  h = fixture();
  for (const bad of [{}, {prefix: 'library:pdf:'}, {prefix: 'cfg:'}, {prefix: 'library:'}, {prefix: JOB, side: 'both'}, {prefix: JOB, apply: 'true'}, {prefix: JOB, limit: 0}, {prefix: JOB, limit: 101}, {prefix: JOB, cursor: 5}, {prefix: JOB, extra: 1}])
    assert.equal((await h.call(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await h.call('{nope')).status, 400);
  assert.equal(h.batches.length, 0);

  // 9. Roles, method and bindings. Only the fallback role; a refused call touches neither side.
  h = fixture(); h.env.D1_BACKFILL_ENABLED = 'true'; rowsBefore = snapshot(h);
  assert.equal((await h.call({prefix: JOB}, {noAuth: true})).status, 401);
  assert.equal((await h.call({prefix: JOB}, {token: downloaderToken})).status, 403);
  assert.equal((await h.call({prefix: JOB, apply: true}, {token: downloaderToken})).status, 403);
  assert.equal((await h.call(undefined, {method: 'GET', noAuth: true})).status, 405);
  assert.equal(h.selects.length, 0); assert.equal(snapshot(h), rowsBefore);
  h = fixture({binding: false}); res = await h.call({prefix: JOB}); assert.equal(res.status, 503); assert.equal((await res.json()).error, 'machine_d1_unbound');

  // 10. D1 failures return a fixed code, never the error text; a failed batch leaves the rows as they were.
  h = fixture({readError: true}); h.env.D1_BACKFILL_ENABLED = 'true';
  res = await h.call({prefix: JOB}); text = await res.text(); assert.equal(res.status, 503); assert.equal(JSON.parse(text).error, 'machine_d1_read'); assert(!text.includes(fallbackToken));
  h = fixture({writeError: true}); h.env.D1_BACKFILL_ENABLED = 'true'; rowsBefore = snapshot(h);
  res = await h.call({prefix: JOB, apply: true}); text = await res.text(); assert.equal(res.status, 503); assert.equal(JSON.parse(text).error, 'machine_d1_write'); assert(!text.includes(fallbackToken));
  assert.equal(snapshot(h), rowsBefore);
  // Re-running after a fixed outage completes the job.
  h = fixture(); h.env.D1_BACKFILL_ENABLED = 'true'; await kvPass(h, {apply: true}); await kvPass(h, {apply: true}); body = await kvPass(h); assert.equal(body.counts.missing_in_d1, 0);

  // 11. Static: the endpoint contains no DELETE, DROP or free-form DML; writes reuse the shadow's own two statements.
  const src = fs.readFileSync(path.join(__dirname, '../edge/src/07e-d1-backfill.js'), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert(!/\bDELETE\s+FROM\b/i.test(src) && !/\bDROP\b/i.test(src) && !/\bUPDATE\s+kv_mirror\b/i.test(src) && !/\bINSERT\s+INTO\b/i.test(src), '07e-d1-backfill.js writes only through the shadow statements');
  assert(src.includes('D1_SHADOW_UPSERT_SQL') && src.includes('D1_SHADOW_DELETE_SQL'));

  // 12. The Python client that drives it (paging, both sides, verify after apply, exit codes).
  const client = require('child_process').spawnSync('python3', [path.join(__dirname, 'test_d1_backfill_client.py')], {cwd: path.join(__dirname, '..'), stdio: 'inherit'});
  assert.equal(client.status, 0, 'scripts/test_d1_backfill_client.py failed');

  console.log('D1 backfill: verify by default, two gates, row shape, shadow race, tombstones, idempotence, paging and failure isolation passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
