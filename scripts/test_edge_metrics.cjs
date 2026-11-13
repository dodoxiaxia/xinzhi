'use strict';
// Offline: Analytics Engine request metrics. A data point is written only when the METRICS binding exists AND the KV
// switch cfg:metrics_enabled is '1'. It never changes a response and never carries sensitive content.
// Hooked in at the end of test_muse_reader_upload.cjs (like test_muse_legacy_switch.cjs), so CI runs it from there.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {setup} = require('./test_fulltext_auth_helpers.cjs');
const {doi} = require('./test_doi_library_worker.cjs');
const base = 'https://learn.dryz.info', SWITCH = 'cfg:metrics_enabled';
const machineToken = 'synthetic_machine_token_0123456789abcdef', passphrase = 'synthetic-passphrase-for-metrics-test';
const museKey = 'synthetic_muse_key_0123456789_abcdef';

async function create(options = {}) {
  const clock = {now: Date.parse('2026-11-13T04:00:00Z')};
  const h = await setup({clock});
  h.clock = clock;
  Object.assign(h.env, {MUSE_FULLTEXT_ENABLED:'true', MUSE_FULLTEXT_KEY:museKey, MACHINE_TOKENS:JSON.stringify([{id:'fallback', role:'fallback', token:machineToken}])});
  h.env.ASSETS = {fetch: async () => new Response('not found', {status: 404})};
  h.points = [];
  h.waits = [];
  if (options.binding !== false) h.env.METRICS = {writeDataPoint: point => { if (options.throws) throw new Error('synthetic metrics failure'); h.points.push(point); }};
  if (options.on) h.values.set(SWITCH, '1');
  return h;
}
const ctxFor = h => ({waitUntil: promise => h.waits.push(promise)});
async function call(h, method, route, headers, body, ctx = true) {
  const response = await h.context.worker.fetch(new Request(base + route, {method, headers, ...(body === undefined ? {} : {body})}), h.env, ctx ? ctxFor(h) : undefined);
  await Promise.all(h.waits);
  return response;
}
async function snapshot(response) { return {status: response.status, headers: [...response.headers].sort(), body: await response.text()}; }
const machineAuth = {authorization: 'Bearer ' + machineToken, 'content-type': 'application/json'};
const calls = [
  h => call(h, 'GET', '/api/machine/protocol', {}),
  h => call(h, 'GET', '/api/machine/tasks?limit=999&doi=' + encodeURIComponent(doi) + '&passphrase=' + passphrase, machineAuth),
  h => call(h, 'POST', '/api/machine/claim', machineAuth, '{}'),
  h => call(h, 'POST', '/api/machine/claim', {authorization: 'Bearer wrong', 'content-type': 'application/json'}, '{}'),
  h => call(h, 'POST', '/api/machine/status', machineAuth, '{"doi":"' + doi + '"}'),
  h => call(h, 'GET', '/api/no-such-route?token=abc', {}),
  h => call(h, 'POST', '/api/acquire?doi=' + encodeURIComponent(doi), {'content-type': 'application/x-www-form-urlencoded'}, 'passphrase=wrong')
];

(async () => {
  // 1. No METRICS binding: no write, KV switch never read, response identical to a run with metrics fully on.
  const reference = [];
  for (const run of calls) { const h = await create({binding: false, on: true}); reference.push(await snapshot(await run(h))); assert(!h.reads.some(r => r.key === SWITCH), 'no binding: switch is not even read'); }

  // 2. Binding present, switch missing or not exactly '1': no write, and responses are identical.
  for (const value of [undefined, '0', 'true', '', ' 1']) {
    for (const [index, run] of calls.entries()) {
      const h = await create();
      if (value !== undefined) h.values.set(SWITCH, value);
      assert.deepEqual(await snapshot(await run(h)), reference[index], 'switch ' + JSON.stringify(value));
      assert.equal(h.points.length, 0, 'switch ' + JSON.stringify(value) + ' writes nothing');
    }
  }
  // 2b. Switch read failure means off.
  { const h = await create({on: true}); h.env.QL_KV = {...h.env.QL_KV, get: async key => { if (key === SWITCH) throw new Error('synthetic kv failure'); return h.kv.get(key); }};
    const before = await snapshot(await calls[0](h)); assert.equal(h.points.length, 0); assert.deepEqual(before, reference[0]); }

  // 3. Switch on: exactly one data point per /api/* request, same response, only the allowed fields.
  const allowed = {blobs: 4, doubles: 2, indexes: 1};
  for (const [index, run] of calls.entries()) {
    const h = await create({on: true});
    assert.deepEqual(await snapshot(await run(h)), reference[index], 'switch on leaves the response unchanged');
    assert.equal(h.points.length, 1, 'exactly one data point');
    const point = h.points[0];
    assert.deepEqual(Object.keys(point).sort(), ['blobs', 'doubles', 'indexes']);
    assert.equal(point.blobs.length, allowed.blobs); assert.equal(point.doubles.length, allowed.doubles); assert.equal(point.indexes.length, allowed.indexes);
    assert(point.blobs.every(b => typeof b === 'string') && point.doubles.every(Number.isFinite));
    const text = JSON.stringify(point);
    for (const secret of [machineToken, museKey, passphrase, doi, 'abc', 'wrong', 'limit=', '?', 'https://', 'authorization', 'Bearer']) assert(!text.includes(secret), 'no sensitive content: ' + secret);
    assert.equal(point.blobs[2], String(reference[index].status));
    let bodyError = ''; try { bodyError = JSON.parse(reference[index].body).error || ''; } catch { bodyError = ''; }
    if (reference[index].status >= 400 && reference[index].headers.some(([k, v]) => k === 'content-type' && v.includes('json'))) assert.equal(point.blobs[3], bodyError, 'error code mirrors the JSON error field');
    else assert.equal(point.blobs[3], '');
    assert.equal(point.indexes[0], point.blobs[0]);
    assert.equal(point.doubles[1], 1);
  }
  let h = await create({on: true});
  await calls[1](h); await calls[2](h); await calls[3](h); await calls[5](h);
  assert.deepEqual(h.points[0].blobs.slice(0, 3), ['/api/machine/tasks', 'GET', '400']);
  assert.match(h.points[0].blobs[3], /^[a-z0-9_]+$/); assert.notEqual(h.points[0].blobs[3], '');
  assert.deepEqual(h.points[1].blobs.slice(0, 3), ['/api/machine/claim', 'POST', String(reference[2].status)]);
  assert.deepEqual(h.points[2].blobs.slice(0, 3), ['/api/machine/claim', 'POST', '401']); assert.equal(h.points[2].blobs[3], 'machine_unauthorized');
  assert.equal(h.points[3].blobs[0], '/api/other', 'unknown API path is grouped, never recorded verbatim');

  // 3b. Non-API requests (static assets) are not recorded and never read the switch.
  h = await create({on: true});
  h.env.ASSETS = {fetch: async () => new Response('asset', {status: 200})};
  assert.equal(await (await call(h, 'GET', '/index.html?x=1', {})).text(), 'asset'); assert.equal(h.points.length, 0); assert(!h.reads.some(r => r.key === SWITCH));

  // 3c. The switch is cached per isolate for 60 s: one KV read, then re-read after expiry; turning it off takes effect then.
  h = await create({on: true});
  await calls[0](h); await calls[0](h); await calls[0](h);
  assert.equal(h.reads.filter(r => r.key === SWITCH).length, 1); assert.equal(h.points.length, 3);
  h.values.delete(SWITCH); await calls[0](h); assert.equal(h.points.length, 4, 'still cached');
  h.clock.now += 61000; await calls[0](h); assert.equal(h.points.length, 4, 'off after the cache expires');
  assert.equal(h.reads.filter(r => r.key === SWITCH).length, 2);

  // 4. writeDataPoint throwing: response unchanged, nothing escapes.
  for (const [index, run] of calls.entries()) {
    h = await create({on: true, throws: true});
    assert.deepEqual(await snapshot(await run(h)), reference[index], 'a throwing writeDataPoint changes nothing');
  }
  // 4b. No ctx (older callers) and a ctx.waitUntil that throws: still unchanged.
  h = await create({on: true});
  assert.deepEqual(await snapshot(await call(h, 'GET', '/api/machine/protocol', {}, undefined, false)), reference[0]);
  const broken = await h.context.worker.fetch(new Request(base + '/api/machine/protocol'), h.env, {waitUntil() { throw new Error('synthetic waitUntil failure'); }});
  assert.equal(broken.status, 200);

  // 5. A routing exception is rethrown unchanged (and counted as status 500 / exception when the switch is on).
  h = await create({on: true});
  h.env.ASSETS = {fetch: async () => { throw new Error('synthetic asset failure'); }};
  await assert.rejects(h.context.worker.fetch(new Request(base + '/api/other-thing'), h.env, ctxFor(h)), /synthetic asset failure/);
  await Promise.all(h.waits);
  assert.deepEqual(h.points[0].blobs, ['/api/other', 'GET', '500', 'exception']);

  // 6. The metrics route list is not hand-copied: it must equal the set of /api paths routeRequest can match, both ways.
  // Derived from edge/_worker.js (the file that is deployed). routeRequest matches only exact `url.pathname === '/api/...'`
  // literals today; any other matching form (prefix, regex, :param template) makes this test fail until it is taught about it.
  {
    const worker = fs.readFileSync(path.join(__dirname, '../edge/_worker.js'), 'utf8');
    const routerStart = worker.indexOf('async function routeRequest(');
    assert(routerStart >= 0, 'routeRequest not found in edge/_worker.js');
    const routerBody = worker.slice(routerStart);
    const literal = /url\.pathname === '(\/api\/[a-z0-9\/_-]+)'/g;
    const routed = [...routerBody.matchAll(literal)].map(m => m[1]);
    assert(routed.length >= 20, 'routeRequest: too few literal /api routes found (' + routed.length + ')');
    assert.equal(new Set(routed).size, routed.length, 'routeRequest: a path is routed twice');
    const rest = routerBody.replace(literal, '');
    assert(!/\/api\//.test(rest.slice(0, rest.indexOf('env.ASSETS.fetch'))), 'routeRequest has an /api/ string that is not an exact pathname match; teach this test the new form');
    assert(!/(startsWith|endsWith|RegExp|\.match\(|\.test\(|split\(|switch\s*\()/.test(rest.slice(0, rest.indexOf('env.ASSETS.fetch'))), 'routeRequest uses a matching form this test does not understand (prefix/regex/switch); teach this test and METRICS_ROUTES template handling');
    const listSource = worker.match(/const METRICS_ROUTES = new Set\(\[([\s\S]*?)\]\);/);
    assert(listSource, 'METRICS_ROUTES not found in edge/_worker.js');
    const listed = [...listSource[1].matchAll(/'([^']*)'/g)].map(m => m[1]);
    assert.equal(new Set(listed).size, listed.length, 'METRICS_ROUTES has a duplicate entry');
    assert(listed.every(r => /^\/api\/[a-z0-9\/_-]+$/.test(r)), 'METRICS_ROUTES entries must be plain /api paths');
    const missing = routed.filter(r => !listed.includes(r)), stale = listed.filter(r => !routed.includes(r));
    assert.deepEqual(missing, [], 'routed in routeRequest but missing from METRICS_ROUTES (would be counted as /api/other): ' + missing.join(', '));
    assert.deepEqual(stale, [], 'in METRICS_ROUTES but routeRequest cannot match it: ' + stale.join(', '));

    // Behavioural cross-check on the real worker: every listed path is handled before the static-asset fallback, and an
    // unlisted /api path falls through to it. (Only ASSETS usage is observed; handler responses are irrelevant here.)
    for (const route of [...listed, '/api/__not_a_route__']) {
      const probe = await create();
      let assetHits = 0;
      probe.env.ASSETS = {fetch: async () => { assetHits += 1; return new Response('asset', {status: 200}); }};
      try { await call(probe, 'GET', route, {}); } catch { /* a handler may throw; only the fallback matters */ }
      assert.equal(assetHits === 0, route !== '/api/__not_a_route__', 'worker routing disagrees with METRICS_ROUTES for ' + route);
    }
  }
  console.log('edge metrics checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
