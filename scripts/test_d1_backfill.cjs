'use strict';
// Offline: POST /api/machine/d1-backfill. KV is the ledger; kv_mirror in D1 is a copy that the live shadow write only fills going forward.
// Prefix mode is strictly read-only (verify only); apply requires an explicit keys+sha256 manifest AND D1_BACKFILL_ENABLED=true.
// Loaded directly by test_muse_reader_upload.cjs (the daily.yml offline list) and by run_all_tests.sh (scripts/test_*.cjs).
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
const JOB = 'library:muse-job:', PAPER = 'library:paper:', INDEX = 'library:machine-index:v1';

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
const manifestOf = (h, keys) => keys.map(key => ({key, sha256: sha(h.values.get(key))}));

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
  const jobKeys = [1, 2, 3, 4, 5].map(n => JOB + '10.1000/j' + n);
  const kvPass = async (h, body = {}) => (await h.call({prefix: JOB, ...body})).json();
  const d1Pass = async (h, body = {}) => (await h.call({prefix: JOB, side: 'd1', ...body})).json();
  const manifestPass = async (h, keys, apply = false) => (await h.call({keys: manifestOf(h, keys), ...(apply ? {apply: true} : {})})).json();

  // 1. verify (prefix and manifest): the full difference, no write, no value in the reply, even with the switch on.
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
  const listsBefore = h.lists.length;
  res = await h.call({keys: manifestOf(h, jobKeys)}); assert.equal(res.status, 200);
  text = await res.text(); body = JSON.parse(text);
  assert.equal(body.mode, 'verify'); assert.equal(body.scope, 'manifest'); assert.equal(body.done, true); assert.equal(body.scanned, 5);
  assert.equal(body.diff, 3); assert.equal(body.written, 0);
  assert(!text.includes('value-') && !text.includes('secretish') && !text.includes(sha(h.values.get(jobKeys[0]))));
  assert.equal(h.lists.length, listsBefore, 'manifest verify never calls KV.list');
  assert.equal(h.batches.length, 0); assert.equal(snapshot(h), rowsBefore);

  // 2. apply without manifest is always 400 (including prefix + apply and side d1); manifest apply is 403 unless D1_BACKFILL_ENABLED === 'true'.
  h = fixture(); h.env.D1_BACKFILL_ENABLED = 'true'; rowsBefore = snapshot(h);
  for (const noManifestApply of [{apply: true}, {prefix: JOB, apply: true}, {prefix: JOB, side: 'd1', apply: true}]) {
    res = await h.call(noManifestApply);
    assert.equal(res.status, 400, JSON.stringify(noManifestApply));
    assert.equal((await res.json()).error, 'machine_d1_backfill_manifest_required');
  }
  assert.equal(h.batches.length, 0); assert.equal(snapshot(h), rowsBefore);

  h = fixture(); rowsBefore = snapshot(h);
  res = await h.call({keys: manifestOf(h, jobKeys), apply: true});
  assert.equal(res.status, 403); assert.equal((await res.json()).error, 'machine_d1_backfill_disabled');
  h.env.D1_BACKFILL_ENABLED = '1';
  assert.equal((await h.call({keys: manifestOf(h, jobKeys), apply: true})).status, 403, 'only the string true switches it on');
  assert.equal(h.batches.length, 0); assert.equal(snapshot(h), rowsBefore);

  // 3. manifest apply with both gates: missing, tombstoned and different rows in manifest are filled from KV;
  //    'recent' is left to the shadow; keys outside the manifest are never touched; exact library:machine-index:v1 works.
  h = fixture(); h.env.D1_BACKFILL_ENABLED = 'true';
  const outsideKey = JOB + '10.1000/outside-manifest';
  h.put(outsideKey, '{"outside":true}');
  h.put(INDEX, '{"ready":true,"entries":{}}');
  kvBefore = kvSnapshot(h);
  const applyKeys = [...jobKeys, INDEX];
  body = await manifestPass(h, applyKeys, true);
  assert.equal(body.mode, 'apply'); assert.equal(body.scope, 'manifest'); assert.equal(body.written, 4); assert.equal(body.counts.recent, 1);
  for (const n of [2, 3, 4]) {
    const key = JOB + '10.1000/j' + n, row = h.rows.get(key), value = h.values.get(key);
    assert.equal(row.value, value, 'row ' + n); assert.equal(row.sha256, sha(value)); assert.equal(row.size, Buffer.byteLength(value));
    assert.equal(row.deleted, 0); assert.equal(row.entity, 'muse_job'); assert.equal(row.updated_at, NOW);
  }
  assert.equal(h.rows.get(INDEX).entity, 'index'); assert.equal(h.rows.get(INDEX).value, h.values.get(INDEX));
  assert.equal(h.rows.get(JOB + '10.1000/j5').value, '{"stale":true}', 'a row written moments ago is the shadow\'s to keep');
  assert.equal(h.rows.has(outsideKey), false, 'keys outside the manifest are never written');
  assert.equal(kvSnapshot(h), kvBefore, 'KV is never written');
  d1 = await d1Pass(h);
  assert.equal(d1.counts.missing_in_kv, 1, 'side d1 remains verify-only and reports x1');
  // After the shadow's grace the remaining 'recent' row is compared like any other and the manifest reconciles to 0.
  h.clock.now = NOW + 300000;
  body = await manifestPass(h, applyKeys, false);
  assert.equal(body.diff, 1, 'j5 still holds the old content and is now past its grace');
  body = await manifestPass(h, applyKeys, true); assert.equal(body.written, 1);
  body = await manifestPass(h, applyKeys, false);
  assert.equal(body.diff, 0); assert.equal(body.counts.same, 6);

  // 4. Idempotent: a second manifest apply finds nothing to write and the rows stay byte for byte the same.
  const settled = snapshot(h); const batchesBefore = h.batches.length;
  body = await manifestPass(h, applyKeys, true);
  assert.equal(body.written, 0); assert.equal(h.batches.length, batchesBefore); assert.equal(snapshot(h), settled);

  // 5. Race with the live shadow (via manifest apply): a shadow write that lands after our KV read (newer updated_at) is never overwritten.
  h = create(); h.env.D1_BACKFILL_ENABLED = 'true';
  h.put(JOB + '10.1000/r1', '{"v":"kv-old"}');
  const realGet = h.env.QL_KV.get;
  h.env.QL_KV = {...h.env.QL_KV, get: async (k, t) => {
    const value = await realGet(k, t);
    if (k === JOB + '10.1000/r1') { h.clock.now += 50; h.rows.set(k, {key: k, entity: 'muse_job', value: '{"v":"kv-new"}', size: 15, sha256: sha('{"v":"kv-new"}'), expires_at: null, updated_at: h.clock.now, deleted: 0}); }
    return value;
  }};
  body = await manifestPass(h, [JOB + '10.1000/r1'], true); assert.equal(body.counts.missing_in_d1, 1, 'D1 had no row when we compared, then the shadow wrote one during our KV read');
  assert.equal(h.rows.get(JOB + '10.1000/r1').value, '{"v":"kv-new"}', 'updated_at is the moment before the KV read, so the shadow\'s newer row survives');
  h = create(); h.env.D1_BACKFILL_ENABLED = 'true'; h.put(JOB + '10.1000/r2', '{"v":"kv-old"}');
  h.env.LIBRARY_DB.prepare = (orig => sql => { const stmt = orig(sql); return {bind: (...args) => {
    const bound = stmt.bind(...args);
    if (sql.startsWith('SELECT')) return {...bound, all: async () => { const out = await bound.all(); // the shadow writes between our read of D1 and our write
      h.clock.now += 50; h.rows.set(JOB + '10.1000/r2', {key: JOB + '10.1000/r2', entity: 'muse_job', value: '{"v":"kv-new"}', size: 15, sha256: sha('{"v":"kv-new"}'), expires_at: null, updated_at: h.clock.now + 1000, deleted: 0}); return out; }};
    return bound; }}; })(h.env.LIBRARY_DB.prepare.bind(h.env.LIBRARY_DB));
  body = await manifestPass(h, [JOB + '10.1000/r2'], true); assert.equal(body.counts.missing_in_d1, 1); assert.equal(body.written, 1);
  assert.equal(h.rows.get(JOB + '10.1000/r2').value, '{"v":"kv-new"}', 'the newer shadow row wins the conditional upsert');

  // 6. Row shape & 100-key manifest budget (via manifest apply): expiration preserved, NULL value above 1,000,000 bytes with true size and hash.
  h = create(); h.env.D1_BACKFILL_ENABLED = 'true';
  const big = 'x'.repeat(1000001);
  h.put(PAPER + '10.1000/big', big); h.put(PAPER + '10.1000/ttl', '{"t":1}'); h.expirations.set(PAPER + '10.1000/ttl', Math.floor(NOW / 1000) + 3600);
  body = await manifestPass(h, [PAPER + '10.1000/big', PAPER + '10.1000/ttl'], true); assert.equal(body.written, 2);
  const bigRow = h.rows.get(PAPER + '10.1000/big'); assert.equal(bigRow.value, null); assert.equal(bigRow.size, 1000001); assert.equal(bigRow.sha256, sha(big)); assert.equal(bigRow.entity, 'paper');
  assert.equal(h.rows.get(PAPER + '10.1000/ttl').expires_at, (Math.floor(NOW / 1000) + 3600) * 1000);
  assert.equal(h.rows.get(PAPER + '10.1000/big').updated_at, NOW);

  h = create(); h.env.D1_BACKFILL_ENABLED = 'true';
  const hundredKeys = [];
  for (let i = 0; i < 100; i++) {
    const k = PAPER + '10.1000/bulk-' + String(i).padStart(3, '0');
    h.put(k, '{"i":' + i + '}');
    hundredKeys.push(k);
  }
  const bulkPayload = JSON.stringify({keys: manifestOf(h, hundredKeys), apply: true});
  assert(bulkPayload.length > 2048 && bulkPayload.length <= 32768, '100-item manifest fits within 32768-byte limit');
  res = await h.call(bulkPayload); assert.equal(res.status, 200); assert.equal((await res.json()).written, 100);
  assert.equal((await h.call('x'.repeat(32769))).status, 413);

  // 7. Paging (prefix verify): limit 2 over five keys is three requests; cursors chain and end with done.
  h = fixture(); let seen = 0, pages = 0, cursor = '';
  do { body = await kvPass(h, {limit: 2, ...(cursor ? {cursor} : {})}); seen += body.scanned; cursor = body.cursor; pages++; assert(pages < 10); } while (!body.done);
  assert.equal(pages, 3); assert.equal(seen, 5);
  seen = 0; pages = 0; cursor = '';
  do { body = await d1Pass(h, {limit: 3, ...(cursor ? {cursor} : {})}); seen += body.scanned; cursor = body.cursor; pages++; assert(pages < 10); } while (!body.done);
  assert.equal(seen, 7); assert.equal(pages, 3);

  // 8. Validation and manifest mismatch rejection (no writes).
  h = fixture(); h.env.D1_BACKFILL_ENABLED = 'true'; rowsBefore = snapshot(h);
  const validOne = {key: jobKeys[0], sha256: sha(h.values.get(jobKeys[0]))};
  for (const bad of [
    {}, {prefix: 'library:pdf:'}, {prefix: 'cfg:'}, {prefix: 'library:'}, {prefix: JOB, side: 'both'},
    {prefix: JOB, apply: 'true'}, {prefix: JOB, limit: 0}, {prefix: JOB, limit: 101}, {prefix: JOB, cursor: 5}, {prefix: JOB, extra: 1},
    {keys: [validOne], prefix: JOB}, {keys: [validOne], prefix: JOB, apply: true},
    {keys: [validOne], side: 'kv'}, {keys: [validOne], cursor: ''}, {keys: [validOne], limit: 10}, {keys: [validOne], extra: 1}
  ]) {
    res = await h.call(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).error, 'machine_bad_request', JSON.stringify(bad));
  }
  const oneHundredOne = Array.from({length: 101}, (_, i) => ({key: JOB + '10.1000/over-' + i, sha256: validOne.sha256}));
  for (const badManifest of [
    {keys: null}, {keys: 'not-array'}, {keys: []}, {keys: oneHundredOne},
    {keys: [null]}, {keys: [[]]}, {keys: [{key: validOne.key}]}, {keys: [{sha256: validOne.sha256}]},
    {keys: [{...validOne, extra: 1}]},
    {keys: [{key: 'library:pdf:abc', sha256: validOne.sha256}]},
    {keys: [{key: 'cfg:d1_shadow_enabled', sha256: validOne.sha256}]},
    {keys: [{key: 'library:machine-rate:x', sha256: validOne.sha256}]},
    {keys: [{key: INDEX + ':extra', sha256: validOne.sha256}]},
    {keys: [{key: PAPER, sha256: validOne.sha256}]},
    {keys: [{key: validOne.key, sha256: validOne.sha256.toUpperCase()}]},
    {keys: [{key: validOne.key, sha256: validOne.sha256.slice(0, 63)}]},
    {keys: [{key: validOne.key, sha256: 'g'.repeat(64)}]},
    {keys: [validOne, validOne]}
  ]) {
    for (const applyFlag of [false, true]) {
      res = await h.call({...badManifest, ...(applyFlag ? {apply: true} : {})});
      assert.equal(res.status, 400, JSON.stringify(badManifest));
      assert.equal((await res.json()).error, 'machine_d1_backfill_manifest_invalid', JSON.stringify(badManifest));
    }
  }
  assert.equal((await h.call('{nope')).status, 400);

  // Manifest KV missing & sha256 mismatch -> 409 machine_d1_backfill_manifest_mismatch, no write, no KV value or hash leaked.
  const missingKey = JOB + '10.1000/not-in-kv';
  res = await h.call({keys: [validOne, {key: missingKey, sha256: validOne.sha256}], apply: true});
  text = await res.text(); body = JSON.parse(text);
  assert.equal(res.status, 409); assert.equal(body.error, 'machine_d1_backfill_manifest_mismatch');
  assert.deepEqual(body.mismatches, [{key: missingKey, category: 'kv_missing'}]);
  assert(!text.includes('secretish') && !text.includes('value-') && !text.includes(validOne.sha256));

  const staleHash = sha('{"stale":"manifest"}');
  res = await h.call({keys: [validOne, {key: jobKeys[1], sha256: staleHash}], apply: true});
  text = await res.text(); body = JSON.parse(text);
  assert.equal(res.status, 409); assert.equal(body.error, 'machine_d1_backfill_manifest_mismatch');
  assert.deepEqual(body.mismatches, [{key: jobKeys[1], category: 'sha256_mismatch'}]);
  assert(!text.includes('secretish') && !text.includes('value-') && !text.includes(staleHash) && !text.includes(sha(h.values.get(jobKeys[1]))));
  assert.equal(h.batches.length, 0); assert.equal(snapshot(h), rowsBefore);

  // 9. Roles, method and bindings. Only the fallback role; a refused call touches neither side.
  h = fixture(); h.env.D1_BACKFILL_ENABLED = 'true'; rowsBefore = snapshot(h);
  const validReq = {keys: manifestOf(h, jobKeys), apply: true};
  assert.equal((await h.call({prefix: JOB}, {noAuth: true})).status, 401);
  assert.equal((await h.call(validReq, {noAuth: true})).status, 401);
  assert.equal((await h.call({prefix: JOB}, {token: downloaderToken})).status, 403);
  assert.equal((await h.call(validReq, {token: downloaderToken})).status, 403);
  assert.equal((await h.call(undefined, {method: 'GET', noAuth: true})).status, 405);
  assert.equal(h.selects.length, 0); assert.equal(snapshot(h), rowsBefore);
  h = fixture({binding: false});
  res = await h.call({prefix: JOB}); assert.equal(res.status, 503); assert.equal((await res.json()).error, 'machine_d1_unbound');
  res = await h.call({keys: manifestOf(h, jobKeys)}); assert.equal(res.status, 503); assert.equal((await res.json()).error, 'machine_d1_unbound');
  h.env.D1_BACKFILL_ENABLED = 'true';
  res = await h.call({keys: manifestOf(h, jobKeys), apply: true}); assert.equal(res.status, 503); assert.equal((await res.json()).error, 'machine_d1_unbound');

  // 10. D1 failures return a fixed code, never the error text; a failed batch leaves the rows as they were.
  h = fixture({readError: true}); h.env.D1_BACKFILL_ENABLED = 'true';
  res = await h.call({prefix: JOB}); text = await res.text(); assert.equal(res.status, 503); assert.equal(JSON.parse(text).error, 'machine_d1_read'); assert(!text.includes(fallbackToken));
  h = fixture({writeError: true}); h.env.D1_BACKFILL_ENABLED = 'true'; rowsBefore = snapshot(h);
  res = await h.call({keys: manifestOf(h, jobKeys), apply: true}); text = await res.text(); assert.equal(res.status, 503); assert.equal(JSON.parse(text).error, 'machine_d1_write'); assert(!text.includes(fallbackToken));
  assert.equal(snapshot(h), rowsBefore);
  // Re-running after a fixed outage completes the job.
  h = fixture(); h.env.D1_BACKFILL_ENABLED = 'true'; await manifestPass(h, jobKeys, true); await manifestPass(h, jobKeys, true); body = await manifestPass(h, jobKeys, false); assert.equal(body.counts.missing_in_d1, 0);

  // 11. Static: the endpoint contains no DELETE, DROP or free-form DML; writes reuse the shadow's own two statements.
  const src = fs.readFileSync(path.join(__dirname, '../edge/src/07e-d1-backfill.js'), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert(!/\bDELETE\s+FROM\b/i.test(src) && !/\bDROP\b/i.test(src) && !/\bUPDATE\s+kv_mirror\b/i.test(src) && !/\bINSERT\s+INTO\b/i.test(src), '07e-d1-backfill.js writes only through the shadow statements');
  assert(src.includes('D1_SHADOW_UPSERT_SQL') && src.includes('D1_SHADOW_DELETE_SQL'));

  // 12. A freshly written tombstone whose KV key is still present is 'recent': it is not counted in diff, and apply does not resurrect it.
  //     An old tombstone in the same manifest is still kv_present_d1_deleted. After the grace window the fresh one is compared like any other tombstone and apply restores it from KV.
  h = create(); h.env.D1_BACKFILL_ENABLED = 'true';
  const freshKey = JOB + '10.1000/fresh-del', oldKey = JOB + '10.1000/old-del';
  h.put(freshKey, '{"v":1}'); h.put(oldKey, '{"v":2}');
  h.row(freshKey, 'muse_job', '{"v":1}', {deleted: 1, updated_at: NOW - 1000});
  h.row(oldKey, 'muse_job', '{"v":2}', {deleted: 1, updated_at: NOW - 3600000});
  body = await kvPass(h);
  assert.equal(body.counts.recent, 1); assert.equal(body.counts.kv_present_d1_deleted, 1); assert.equal(body.diff, 1); assert.equal(body.written, 0);
  assert.deepEqual(body.samples.kv_present_d1_deleted, [oldKey]);
  assert.equal(body.samples.recent, undefined, 'recent is not a difference category and carries no sample list');
  body = await manifestPass(h, [freshKey, oldKey], true);
  assert.equal(body.mode, 'apply'); assert.equal(body.written, 1); assert.equal(body.counts.recent, 1);
  assert.equal(h.rows.get(freshKey).deleted, 1, 'a tombstone written moments ago is not resurrected');
  assert.equal(h.rows.get(oldKey).deleted, 0, 'an old tombstone is still filled from KV');
  assert.equal(h.rows.get(oldKey).value, '{"v":2}');
  h.clock.now = NOW + 300000;
  body = await kvPass(h);
  assert.equal(body.counts.recent, 0); assert.equal(body.counts.kv_present_d1_deleted, 1); assert.equal(body.diff, 1);
  assert.deepEqual(body.samples.kv_present_d1_deleted, [freshKey]);
  body = await manifestPass(h, [freshKey, oldKey], true);
  assert.equal(body.written, 1); assert.equal(h.rows.get(freshKey).deleted, 0); assert.equal(h.rows.get(freshKey).value, '{"v":1}');
  body = await kvPass(h);
  assert.equal(body.diff, 0); assert.equal(body.counts.same, 2);

  // 13. The Python client that drives it (prefix verify paging, manifest verify/apply, local guardrails, exit codes).
  const client = require('child_process').spawnSync('python3', [path.join(__dirname, 'test_d1_backfill_client.py')], {cwd: path.join(__dirname, '..'), stdio: 'inherit'});
  assert.equal(client.status, 0, 'scripts/test_d1_backfill_client.py failed');

  console.log('D1 backfill: prefix verify, explicit manifest apply, mismatch rejection, scope isolation, row shape, shadow race, recent-tombstone grace, idempotence, paging and failure isolation passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
