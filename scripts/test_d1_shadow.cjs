'use strict';
// Offline: D1 shadow write of whitelisted QL_KV ledger keys. The site mirrors puts and deletes into LIBRARY_DB
// (table kv_mirror) via ctx.waitUntil ONLY when BOTH LIBRARY_DB (prepare + batch) and QL_KV exist AND the KV switch
// cfg:d1_shadow_enabled is '1'. Reads always stay on KV. Hooked in at the end of test_muse_reader_upload.cjs.
const assert = require('assert');
const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {setup, token} = require('./test_fulltext_auth_helpers.cjs');
const fixtures = require('./machine_identity_fixtures.cjs');
const {doi: libDoi, pdf: libPdf, hash} = require('./test_doi_library_worker.cjs');

const base = 'https://learn.dryz.info';
const reviewUrl = base + '/api/muse/review';
const SWITCH = 'cfg:d1_shadow_enabled';
const museKey = 'synthetic_muse_key_0123456789_abcdef';
const dsh = 'synthetic_downloader_token_0123456789ab';
const tokens = JSON.stringify([{id: 'dsh', role: 'downloader', token: dsh}]);

function applyD1Statement(rows, stmt) {
  const {sql, args} = stmt;
  if (sql.includes('deleted = 0 WHERE excluded.updated_at >= kv_mirror.updated_at')) {
    const [key, entity, value, size, sha256, expires_at, updated_at] = args;
    const existing = rows.get(key);
    if (!existing || updated_at >= existing.updated_at) {
      rows.set(key, {key, entity, value, size, sha256, expires_at, updated_at, deleted: 0});
    }
    return;
  }
  if (sql.includes('deleted = 1, updated_at = excluded.updated_at WHERE excluded.updated_at >= kv_mirror.updated_at')) {
    const [key, entity, updated_at] = args;
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, {key, entity, value: null, size: 0, sha256: null, expires_at: null, updated_at, deleted: 1});
    } else if (updated_at >= existing.updated_at) {
      rows.set(key, {...existing, deleted: 1, updated_at});
    }
    return;
  }
  throw new Error('Unexpected SQL in mock D1: ' + sql);
}

async function create(options = {}) {
  const clock = options.clock || {now: Date.parse('2026-11-13T04:00:00Z')};
  const h = await setup({...(options.setup || {}), clock});
  h.clock = clock;
  h.context.DecompressionStream = DecompressionStream;
  Object.assign(h.env, {
    MACHINE_TOKENS: tokens,
    ...(options.muse === false ? {} : {MUSE_FULLTEXT_ENABLED: 'true', MUSE_FULLTEXT_KEY: museKey})
  });
  h.d1 = {prepares: [], batches: [], rows: new Map(), gate: null};
  h.waits = [];
  h.warnings = [];
  h.context.console = {...console, warn: message => h.warnings.push(String(message))};
  let batchFailCount = 0;
  if (options.binding !== false) {
    h.env.LIBRARY_DB = {
      prepare(sql) {
        h.d1.prepares.push(sql);
        if (options.throwOn === 'prepare') throw new Error('synthetic d1 prepare failure for key=' + libDoi);
        return {
          bind(...args) {
            return {sql, args};
          }
        };
      },
      async batch(stmts) {
        if (h.d1.gate) await h.d1.gate;
        h.d1.batches.push(stmts.slice());
        if (options.throwOn === 'batch' || (options.throwFirstBatchOnly && batchFailCount++ === 0)) {
          throw new Error('synthetic d1 batch failure for secret=' + dsh);
        }
        for (const stmt of stmts) applyD1Statement(h.d1.rows, stmt);
        return stmts.map(() => ({success: true}));
      }
    };
  }
  if (options.on) h.values.set(SWITCH, '1');
  if (options.switchValue !== undefined) h.values.set(SWITCH, options.switchValue);
  const original = h.context.worker.fetch.bind(h.context.worker);
  h.context.worker.fetch = (request, env, ctxOverride) => {
    const ctx = ctxOverride === undefined ? {waitUntil: promise => h.waits.push(promise)} : ctxOverride;
    return original(request, env, ctx);
  };
  h.trace = [];
  h.flush = async () => {
    while (h.waits.length) {
      await Promise.all(h.waits.splice(0));
    }
  };
  return h;
}

const normUuid = s => String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');

async function recordResponse(h, response) {
  const clone = response.clone();
  const text = normUuid(await clone.text());
  h.trace.push({status: response.status, body: text});
  return response;
}

function kvSnapshot(h) {
  const out = {};
  for (const [k, v] of [...h.values.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (k === SWITCH) continue;
    out[normUuid(k)] = Buffer.isBuffer(v) ? v.toString('base64') : normUuid(v);
  }
  return out;
}

function seedPaper(h, doi, title, status) {
  const paper = {
    id: 'doi-' + hash(doi).slice(0, 16),
    doi,
    title,
    journal: 'Synthetic',
    authors: ['Jane Doe'],
    date: '2026-10-07',
    datePrecision: 'day',
    dateBasis: 'Crossref published-online',
    ingestedAt: '2026-10-07T04:00:00.000Z',
    metadataStatus: 'external_bibliography_checked',
    fulltextStatus: status
  };
  h.values.set('library:paper:' + doi, JSON.stringify({version: 1, paper}));
}

async function send(h, method, route, headers, body) {
  const res = await h.context.worker.fetch(new Request(base + route, {
    method,
    headers,
    ...(body === undefined ? {} : {body})
  }), h.env);
  return recordResponse(h, res);
}

async function verifyNext(h, doi) {
  for (const [key, value] of [...h.values]) {
    if (key.startsWith('library:muse-review:') && JSON.parse(value).doi !== doi) h.values.delete(key);
  }
  const task = (await (await send(h, 'POST', '/api/muse/review', {
    authorization: 'Bearer ' + await token(h, reviewUrl, 'muse-review.yml'),
    'content-type': 'application/json'
  }, JSON.stringify({action: 'claim'}))).json()).task;
  assert.equal(task && task.doi, doi);
  const done = await send(h, 'POST', '/api/muse/review', {
    authorization: 'Bearer ' + await token(h, reviewUrl, 'muse-review.yml'),
    'content-type': 'application/json'
  }, JSON.stringify({
    action: 'complete',
    taskId: task.taskId,
    doi: task.doi,
    leaseId: task.leaseId,
    sha256: task.sha256,
    bytes: task.bytes,
    result: 'verified',
    pages: 3,
    method: 'dual_parser_all_pages_title_doi'
  }));
  assert.equal(done.status, 200);
}

const scenarios = {
  // 1. Open-access / GitHub acquire -> librarySave writes library:paper:<doi>, library:drive-pending:<sha>
  acquire: {
    opts: {muse: false},
    async run(h) {
      const res = await send(h, 'POST', '/api/acquire?doi=' + encodeURIComponent(libDoi), {
        'content-type': 'application/x-www-form-urlencoded'
      }, new URLSearchParams({passphrase: h.env.PDF_DOWNLOAD_PASSPHRASE}).toString());
      assert.equal(res.status, 200);
      return {paperKey: 'library:paper:' + libDoi, pdfKey: 'library:pdf:' + hash(libPdf), drivePendingKey: 'library:drive-pending:' + hash(libPdf)};
    }
  },
  // 2. Machine upload + review verify -> writes machine-rate, muse-job, muse-review, paper, machine-index:v1, drive-pending; deletes muse-review & muse-candidate
  machine: {
    opts: {muse: true},
    async run(h) {
      const d = '10.9999/synthetic.d1.machine';
      const copy = fixtures.flateEol({doi: d, title: fixtures.samples.flate.title});
      seedPaper(h, d, fixtures.samples.flate.title, 'manual_needed');
      const up = await send(h, 'PUT', '/api/machine/upload', {
        authorization: 'Bearer ' + dsh,
        'content-type': 'application/pdf',
        'x-machine-doi': d
      }, copy);
      assert.equal(up.status, 202);
      await verifyNext(h, d);
      const day = new Date(h.clock.now).toISOString().slice(0, 10);
      return {
        paperKey: 'library:paper:' + d,
        jobKey: 'library:muse-job:' + d,
        rateKey: 'library:machine-rate:upload:dsh:' + day,
        indexKey: 'library:machine-index:v1',
        candidateKey: 'library:muse-candidate:' + hash(copy)
      };
    }
  },
  // 3. Muse request queue -> writes library:muse-job:<doi>, library:muse-queue:..., library:paper:<doi>
  museRequest: {
    opts: {muse: true, setup: {rows: [], oa: false}},
    async run(h) {
      const res = await send(h, 'POST', '/api/acquire?doi=' + encodeURIComponent(libDoi), {
        'content-type': 'application/x-www-form-urlencoded'
      }, new URLSearchParams({passphrase: h.env.PDF_DOWNLOAD_PASSPHRASE}).toString());
      assert.equal(res.status, 202);
      const jobKey = 'library:muse-job:' + libDoi;
      const job = JSON.parse(h.values.get(jobKey));
      return {jobKey, queueKey: job.queueKey, paperKey: 'library:paper:' + libDoi};
    }
  },
  // 4. Temporary failure -> writes library:attempt:<doi> with expirationTtl: 600
  attempt: {
    opts: {
      muse: false,
      setup: {rows: [], unpaywallResponse: () => new Response('temporary', {status: 503, headers: {'retry-after': '120'}})}
    },
    async run(h) {
      const res = await send(h, 'POST', '/api/acquire?doi=' + encodeURIComponent(libDoi), {
        'content-type': 'application/x-www-form-urlencoded'
      }, new URLSearchParams({passphrase: h.env.PDF_DOWNLOAD_PASSPHRASE}).toString());
      assert.equal(res.status, 502);
      return {attemptKey: 'library:attempt:' + libDoi};
    }
  }
};

async function runScenario(name, options = {}) {
  const sc = scenarios[name];
  const h = await create({...sc.opts, ...options});
  const keys = await sc.run(h);
  await h.flush();
  return {h, keys};
}

function assertD1MatchesKv(h, key, expectedEntity) {
  const kvVal = h.values.get(key);
  assert.equal(typeof kvVal, 'string', key + ' must exist in KV as string');
  const row = h.d1.rows.get(key);
  assert(row, key + ' must exist in D1');
  assert.equal(row.deleted, 0, key + ' must not be deleted');
  assert.equal(row.value, kvVal, key + ' D1 value must match KV');
  const bytes = Buffer.from(kvVal, 'utf8');
  assert.equal(row.size, bytes.length, key + ' size mismatch');
  assert.equal(row.sha256, hash(bytes), key + ' sha256 mismatch');
  if (expectedEntity) assert.equal(row.entity, expectedEntity, key + ' entity mismatch');
  return row;
}

(async () => {
  // Check exported constants on vm context
  {
    const h = await create({binding: false});
    const prefixes = vm.runInContext('D1_SHADOW_PREFIXES', h.context);
    const switchKey = vm.runInContext('D1_SHADOW_SWITCH_KEY', h.context);
    assert(Array.isArray(prefixes) && prefixes.includes('library:paper:') && prefixes.includes('library:machine-index:v1'));
    assert.equal(switchKey, SWITCH);
  }

  // 1. No LIBRARY_DB binding: D1 not called, switch key never read, env untouched, responses & KV match baseline
  const reference = {};
  for (const name of Object.keys(scenarios)) {
    const {h} = await runScenario(name, {binding: false, on: true});
    reference[name] = {trace: h.trace, kv: kvSnapshot(h)};
    assert(!h.reads.some(r => r.key === SWITCH), name + ': no binding means switch key is never read');
    const bound = h.context.d1ShadowBind(h.env);
    assert.strictEqual(bound.env, h.env, 'unbound env is returned untouched');
  }

  // 2. Binding present, switch missing/'0'/'true'/''/' 1', or switch read throws: no D1 calls, identical responses & KV
  for (const name of Object.keys(scenarios)) {
    for (const value of [undefined, '0', 'true', '', ' 1']) {
      const {h} = await runScenario(name, {switchValue: value});
      assert.equal(h.d1.prepares.length, 0, name + ' switch ' + JSON.stringify(value) + ': no prepare');
      assert.equal(h.d1.batches.length, 0, name + ' switch ' + JSON.stringify(value) + ': no batch');
      assert.deepEqual(h.trace, reference[name].trace, name + ' switch ' + JSON.stringify(value) + ': trace');
      assert.deepEqual(kvSnapshot(h), reference[name].kv, name + ' switch ' + JSON.stringify(value) + ': kv');
    }
    const sc = scenarios[name];
    const h = await create({...sc.opts, on: true});
    h.env.QL_KV = {
      ...h.env.QL_KV,
      get: async (key, type) => {
        if (key === SWITCH) throw new Error('synthetic kv switch read failure');
        return h.kv.get(key, type);
      }
    };
    await sc.run(h);
    await h.flush();
    assert.equal(h.d1.prepares.length, 0, name + ': failing switch read makes no prepare');
    assert.equal(h.d1.batches.length, 0, name + ': failing switch read makes no batch');
    assert.deepEqual(h.trace, reference[name].trace, name + ': failing switch read leaves trace unchanged');
  }

  // 3. Switch on: drive real paths and verify D1 rows, sha256, size, expires_at, deleted=0, and identical responses/KV
  const allMirroredKeys = [];
  {
    const {h, keys} = await runScenario('acquire', {on: true});
    assert.deepEqual(h.trace, reference.acquire.trace);
    assert.deepEqual(kvSnapshot(h), reference.acquire.kv);
    const paperRow = assertD1MatchesKv(h, keys.paperKey, 'paper');
    assert.equal(paperRow.expires_at, null);
    assertD1MatchesKv(h, keys.drivePendingKey, 'drive_pending');
    assert(!h.d1.rows.has(keys.pdfKey), 'binary PDF key must not be mirrored to D1');
    allMirroredKeys.push(...h.d1.rows.keys());
  }
  {
    const {h, keys} = await runScenario('machine', {on: true});
    assert.deepEqual(h.trace, reference.machine.trace);
    assert.deepEqual(kvSnapshot(h), reference.machine.kv);
    assertD1MatchesKv(h, keys.paperKey, 'paper');
    assertD1MatchesKv(h, keys.jobKey, 'muse_job');
    const rateRow = assertD1MatchesKv(h, keys.rateKey, 'quota');
    assert.equal(rateRow.expires_at, rateRow.updated_at + 172800 * 1000);
    assertD1MatchesKv(h, keys.indexKey, 'index');
    assert(!h.d1.rows.has(keys.candidateKey), 'muse-candidate binary must not be mirrored');
    const deletedReviews = [...h.d1.rows.entries()].filter(([k, r]) => k.startsWith('library:muse-review:') && r.deleted === 1);
    assert(deletedReviews.length >= 1, 'verified muse-review key is marked deleted=1 in D1');
    allMirroredKeys.push(...h.d1.rows.keys());
  }
  {
    const {h, keys} = await runScenario('museRequest', {on: true});
    assert.deepEqual(h.trace, reference.museRequest.trace);
    assert.deepEqual(kvSnapshot(h), reference.museRequest.kv);
    assertD1MatchesKv(h, keys.jobKey, 'muse_job');
    const queueRow = assertD1MatchesKv(h, keys.queueKey, 'muse_queue');
    assert.equal(queueRow.expires_at, queueRow.updated_at + 604800 * 1000);
    assertD1MatchesKv(h, keys.paperKey, 'paper');
    allMirroredKeys.push(...h.d1.rows.keys());
  }
  {
    const {h, keys} = await runScenario('attempt', {on: true});
    assert.deepEqual(h.trace, reference.attempt.trace);
    assert.deepEqual(kvSnapshot(h), reference.attempt.kv);
    const attemptRow = assertD1MatchesKv(h, keys.attemptKey, 'attempt');
    assert.equal(attemptRow.expires_at, attemptRow.updated_at + 600 * 1000);
    allMirroredKeys.push(...h.d1.rows.keys());
  }

  // Unit-level driver on proxy via d1ShadowBind for remaining prefixes, expiration, >1MB value, post-flush writes, and excluded prefixes
  {
    const h = await create({on: true});
    const bound = h.context.d1ShadowBind(h.env);
    assert.notStrictEqual(bound.env, h.env);
    assert.equal(Object.getPrototypeOf(bound.env), vm.runInContext('Object.prototype', h.context), 'bound env must be plain object');
    assert.strictEqual(({...bound.env}).QL_KV, bound.env.QL_KV, 'spread of bound env preserves QL_KV proxy');
    assert.equal(bound.env.LIBRARY_DB, h.env.LIBRARY_DB);

    const extraKeys = [
      ['library:job:10.1/j', '{"ok":1}', undefined],
      ['library:queue:001', '{"id":"1"}', {expirationTtl: 3600}],
      ['library:grok-job:10.1/g', '{"g":1}', {expiration: 1800000000}],
      ['library:muse-superseded:10.1/s:old', '{"old":1}', undefined],
      ['library:machine-register:10.1/r', '{"reg":1}', undefined],
      ['library:drive:sha123', '{"drive":"id"}', undefined],
      ['library:machine-index:v1', '{"ready":true}', undefined]
    ];
    for (const [k, v, opts] of extraKeys) await bound.env.QL_KV.put(k, v, opts);
    // Overwrite same key before flush: later value must win
    await bound.env.QL_KV.put('library:job:10.1/j', '{"ok":2}');

    // > 1,000,000 bytes: D1 value is NULL, sha256 & size still stored
    const bigVal = 'x'.repeat(1000001);
    await bound.env.QL_KV.put('library:paper:10.1/big', bigVal);

    // 4. Excluded keys and binary values must NOT appear in D1
    const excludedKeys = [
      'library:pdf:abc',
      'library:muse-candidate:abc',
      'library:lock:10.1/x',
      'library:cap:2026-11-13',
      'library:ip:1.2.3.4:2026-11-13',
      'library:diagnostic:10.1/x',
      'library:muse-review-dispatch',
      'library:machine-index:v1-other',
      'ai:cache:1',
      'lock:ai:1',
      'cfg:other'
    ];
    for (const k of excludedKeys) {
      await bound.env.QL_KV.put(k, 'should-not-mirror');
      await bound.env.QL_KV.delete(k);
    }
    // Non-string (binary) value under whitelisted prefix must not be queued
    await bound.env.QL_KV.put('library:paper:binary', new Uint8Array([1, 2, 3, 4]));

    const waits = [];
    bound.flush({waitUntil: p => waits.push(p)});
    assert.equal(waits.length, 1);
    await Promise.all(waits.splice(0));

    assert.equal(h.d1.rows.get('library:job:10.1/j').value, '{"ok":2}');
    assert.equal(h.d1.rows.get('library:queue:001').expires_at, h.clock.now + 3600000);
    assert.equal(h.d1.rows.get('library:grok-job:10.1/g').expires_at, 1800000000000);
    assertD1MatchesKv(h, 'library:muse-superseded:10.1/s:old', 'muse_superseded');
    assertD1MatchesKv(h, 'library:machine-register:10.1/r', 'machine_register');
    assertD1MatchesKv(h, 'library:drive:sha123', 'drive');
    assertD1MatchesKv(h, 'library:machine-index:v1', 'index');

    const bigRow = h.d1.rows.get('library:paper:10.1/big');
    assert.strictEqual(bigRow.value, null, '>1,000,000 byte value must be stored as NULL');
    assert.equal(bigRow.size, 1000001);
    assert.equal(bigRow.sha256, hash(Buffer.from(bigVal, 'utf8')));

    for (const k of excludedKeys) assert(!h.d1.rows.has(k), 'excluded key must not be in D1: ' + k);
    assert(!h.d1.rows.has('library:paper:binary'), 'non-string value must not be in D1');

    // Post-flush write (e.g., background task) must trigger a new waitUntil and not be lost
    await bound.env.QL_KV.put('library:paper:10.1/post-flush', '{"post":true}');
    assert.equal(waits.length, 1, 'post-flush write triggers waitUntil immediately');
    await Promise.all(waits.splice(0));
    assertD1MatchesKv(h, 'library:paper:10.1/post-flush', 'paper');

    allMirroredKeys.push(...h.d1.rows.keys());

    // Assert every single mirrored key across scenarios starts with one of D1_SHADOW_PREFIXES
    const prefixes = vm.runInContext('D1_SHADOW_PREFIXES', h.context);
    assert(allMirroredKeys.length > 0);
    for (const k of allMirroredKeys) {
      assert(prefixes.some(p => k.startsWith(p)), 'D1 key must start with a whitelisted prefix: ' + k);
    }
  }

  // 5. D1 batch throws, prepare throws, missing ctx, throwing waitUntil: response unchanged, fixed warning only
  for (const throwOn of ['batch', 'prepare']) {
    const {h} = await runScenario('acquire', {on: true, throwOn});
    assert.deepEqual(h.trace, reference.acquire.trace, throwOn + ' error leaves response unchanged');
    assert.deepEqual(kvSnapshot(h), reference.acquire.kv, throwOn + ' error leaves KV unchanged');
    assert.deepEqual(h.warnings, ['d1 shadow: write failed'], throwOn + ': only fixed warning text');
  }
  {
    // Chunk 1 fails, chunk 2 still executes
    const h = await create({on: true, throwFirstBatchOnly: true});
    const bound = h.context.d1ShadowBind(h.env);
    for (let i = 0; i < 75; i++) await bound.env.QL_KV.put('library:paper:p' + i, 'v' + i);
    const waits = [];
    bound.flush({waitUntil: p => waits.push(p)});
    await Promise.all(waits);
    assert.equal(h.d1.batches.length, 2);
    assert.equal(h.warnings.length, 1);
    assert.equal(h.warnings[0], 'd1 shadow: write failed');
    assert.equal(h.d1.rows.size, 25, 'second chunk still succeeds when first fails');
  }
  {
    const h = await create({on: true, muse: false});
    const originalFetch = h.context.worker.fetch;
    const noCtxRes = await originalFetch(new Request('https://site.test/api/acquire?doi=' + encodeURIComponent(libDoi), {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({passphrase: h.env.PDF_DOWNLOAD_PASSPHRASE}).toString()
    }), h.env, undefined);
    assert.equal(noCtxRes.status, 200);
    assert.equal(await noCtxRes.text(), reference.acquire.trace[0].body);
  }
  {
    const h = await create({on: true, muse: false});
    const originalFetch = h.context.worker.fetch;
    const throwingCtxRes = await originalFetch(new Request('https://site.test/api/acquire?doi=' + encodeURIComponent(libDoi), {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({passphrase: h.env.PDF_DOWNLOAD_PASSPHRASE}).toString()
    }), h.env, {waitUntil() { throw new Error('synthetic waitUntil failure'); }});
    assert.equal(throwingCtxRes.status, 200);
    assert.equal(await throwingCtxRes.text(), reference.acquire.trace[0].body);
  }

  // 6. Delete: existing key -> deleted=1, value preserved, updated_at updated; missing key -> deleted=1 row; KV delete/put throwing -> no D1 write
  {
    const clock = {now: Date.parse('2026-11-13T04:00:00Z')};
    const h = await create({on: true, clock});
    const bound = h.context.d1ShadowBind(h.env);
    await bound.env.QL_KV.put('library:paper:10.1/del-existing', '{"title":"keep-me"}');
    const waits = [];
    bound.flush({waitUntil: p => waits.push(p)});
    await Promise.all(waits.splice(0));
    const before = h.d1.rows.get('library:paper:10.1/del-existing');
    assert.equal(before.deleted, 0);
    assert.equal(before.value, '{"title":"keep-me"}');

    clock.now += 5000;
    await bound.env.QL_KV.delete('library:paper:10.1/del-existing');
    await bound.env.QL_KV.delete('library:paper:10.1/del-missing');
    await Promise.all(waits.splice(0));

    const after = h.d1.rows.get('library:paper:10.1/del-existing');
    assert.equal(after.deleted, 1);
    assert.equal(after.value, '{"title":"keep-me"}', 'delete preserves existing D1 value for audit');
    assert.equal(after.updated_at, clock.now);

    const missingRow = h.d1.rows.get('library:paper:10.1/del-missing');
    assert(missingRow);
    assert.equal(missingRow.deleted, 1);
    assert.strictEqual(missingRow.value, null);
    assert.equal(missingRow.updated_at, clock.now);
  }
  {
    const h = await create({on: true});
    const throwingKv = {
      ...h.env.QL_KV,
      async put() { throw new Error('kv put failed'); },
      async delete() { throw new Error('kv delete failed'); }
    };
    const bound = h.context.d1ShadowBind({...h.env, QL_KV: throwingKv});
    await assert.rejects(() => bound.env.QL_KV.put('library:paper:10.1/fail', 'v'), /kv put failed/);
    await assert.rejects(() => bound.env.QL_KV.delete('library:paper:10.1/fail'), /kv delete failed/);
    const waits = [];
    bound.flush({waitUntil: p => waits.push(p)});
    await Promise.all(waits);
    assert.equal(h.d1.batches.length, 0, 'failed KV put/delete never produces D1 writes');
  }

  // 7. Out-of-order protection: newer updated_at cannot be overwritten by older updated_at
  {
    const clock = {now: 2000000};
    const h = await create({on: true, clock});
    const b1 = h.context.d1ShadowBind(h.env);
    await b1.env.QL_KV.put('library:paper:10.1/ooo', 'newer');
    const w1 = [];
    b1.flush({waitUntil: p => w1.push(p)});

    clock.now = 1000000;
    const b2 = h.context.d1ShadowBind(h.env);
    await b2.env.QL_KV.put('library:paper:10.1/ooo', 'older');
    const w2 = [];
    b2.flush({waitUntil: p => w2.push(p)});

    await Promise.all(w1);
    await Promise.all(w2);
    assert.equal(h.d1.rows.get('library:paper:10.1/ooo').value, 'newer');
    const upsertSql = vm.runInContext('D1_SHADOW_UPSERT_SQL', h.context);
    const deleteSql = vm.runInContext('D1_SHADOW_DELETE_SQL', h.context);
    assert(upsertSql.includes('WHERE excluded.updated_at >= kv_mirror.updated_at'));
    assert(deleteSql.includes('WHERE excluded.updated_at >= kv_mirror.updated_at'));
  }

  // 8. Switch cached for 60 s per isolate: 1 KV read inside window, re-reads after expiry and stops
  {
    const clock = {now: Date.parse('2026-11-13T04:00:00Z')};
    const h = await create({on: true, muse: false, clock});
    await scenarios.acquire.run(h);
    await h.flush();
    assert.equal(h.d1.batches.length, 1);
    assert.equal(h.reads.filter(r => r.key === SWITCH).length, 1);

    h.values.delete(SWITCH);
    h.values.delete('library:paper:' + libDoi);
    await scenarios.acquire.run(h);
    await h.flush();
    assert.equal(h.d1.batches.length, 2, 'still cached on inside 60s window');
    assert.equal(h.reads.filter(r => r.key === SWITCH).length, 1, 'only one KV read inside window');

    clock.now += 61000;
    h.values.delete('library:paper:' + libDoi);
    await scenarios.acquire.run(h);
    await h.flush();
    assert.equal(h.d1.batches.length, 2, 'stopped writing after cache expires');
    assert.equal(h.reads.filter(r => r.key === SWITCH).length, 2);
  }

  // 9. Write runs after response, chunking (120 -> 3 batches <= 50), and queue cap (200)
  {
    const h = await create({on: true, muse: false});
    let release;
    h.d1.gate = new Promise(resolve => { release = resolve; });
    await scenarios.acquire.run(h);
    assert.equal(h.d1.batches.length, 0, 'response returned while D1 batch is still pending');
    assert(h.waits.length >= 1, 'D1 work handed to waitUntil');
    release();
    await h.flush();
    assert.equal(h.d1.batches.length, 1);
    assert(h.d1.rows.has('library:paper:' + libDoi));
  }
  {
    const h = await create({on: true});
    const bound = h.context.d1ShadowBind(h.env);
    for (let i = 0; i < 120; i++) await bound.env.QL_KV.put('library:paper:chunk-' + i, 'v' + i);
    const waits = [];
    bound.flush({waitUntil: p => waits.push(p)});
    await Promise.all(waits);
    assert.equal(h.d1.batches.length, 3, '120 items split into 3 batches');
    assert.deepEqual(h.d1.batches.map(b => b.length), [50, 50, 20]);
    assert(h.d1.batches.every(b => b.length <= 50));
  }
  {
    const h = await create({on: true});
    const bound = h.context.d1ShadowBind(h.env);
    for (let i = 0; i < 210; i++) await bound.env.QL_KV.put('library:paper:cap-' + i, 'v' + i);
    // Overwriting an existing key in the Map still succeeds at cap 200
    await bound.env.QL_KV.put('library:paper:cap-0', 'updated-v0');
    const waits = [];
    bound.flush({waitUntil: p => waits.push(p)});
    await Promise.all(waits);
    assert.equal(h.d1.rows.size, 200, 'queue cap drops entries beyond 200');
    assert.equal(h.d1.rows.get('library:paper:cap-0').value, 'updated-v0');
    assert(!h.d1.rows.has('library:paper:cap-200'));
  }

  // 10. Static source check on edge/src/07c-d1-shadow.js
  {
    const src = fs.readFileSync(path.join(__dirname, '../edge/src/07c-d1-shadow.js'), 'utf8');
    assert(!/\bSELECT\b/i.test(src), '07c-d1-shadow.js must not contain SELECT');
    assert(!/\bDELETE\s+FROM\b/i.test(src), '07c-d1-shadow.js must not contain DELETE FROM');
    assert(!/\bDROP\b/i.test(src), '07c-d1-shadow.js must not contain DROP');
  }

  // 11. Run scripts/test_d1_kv_reconcile.py if present
  {
    const reconcileTest = path.join(__dirname, 'test_d1_kv_reconcile.py');
    if (fs.existsSync(reconcileTest)) {
      const res = spawnSync('python3', [reconcileTest], {cwd: path.join(__dirname, '..'), stdio: 'inherit'});
      assert.equal(res.status, 0, 'scripts/test_d1_kv_reconcile.py failed with status ' + res.status);
    } else {
      console.log('Skipping test_d1_kv_reconcile.py (not found)');
    }
  }

  console.log('D1 shadow checks passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
