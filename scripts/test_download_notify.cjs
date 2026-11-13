'use strict';
// Offline: webhook notice for a new full-text download task. Nothing is sent unless the Worker secrets
// DOWNLOAD_NOTIFY_URL and DOWNLOAD_NOTIFY_KEY exist AND the KV switch cfg:download_notify_enabled is '1' or 'true'.
// Payload is exactly {doi, task_id, ts}; one notice per DOI per hour; at most 20 per UTC hour; a failing or slow webhook never
// changes the response. Hooked in at the end of test_muse_reader_upload.cjs (like test_edge_metrics.cjs), so CI runs it from there.
const assert = require('assert');
const {setup} = require('./test_fulltext_auth_helpers.cjs');
const {doi, title, seed} = require('./test_doi_library_worker.cjs');
const base = 'https://learn.dryz.info', SWITCH = 'cfg:download_notify_enabled';
const hookUrl = 'https://hooks.example.test/webhook/synthetic-path', hookKey = 'synthetic_notify_key_0123456789_abcdef';
const museKey = 'synthetic_muse_key_0123456789_abcdef';

async function create(options = {}) {
  const clock = {now: Date.parse('2026-11-14T03:10:00Z')};
  const h = await setup({clock, fastTimers: true, ...(options.harness || {})});
  h.clock = clock;
  Object.assign(h.env, {MUSE_FULLTEXT_ENABLED: 'true', MUSE_FULLTEXT_KEY: museKey});
  if (options.secrets !== false) Object.assign(h.env, {DOWNLOAD_NOTIFY_URL: hookUrl, DOWNLOAD_NOTIFY_KEY: hookKey}, options.secrets || {});
  for (const [name, value] of Object.entries(options.secrets || {})) if (value === undefined) delete h.env[name];
  if (options.switch !== undefined) h.values.set(SWITCH, options.switch);
  h.hooks = []; h.waits = []; h.logs = [];
  const original = h.context.fetch;
  h.context.fetch = async (url, init) => {
    if (String(url) !== hookUrl) return original(url, init);
    h.hooks.push({url: String(url), init});
    return options.hook ? options.hook(init, h) : new Response('{"ok":true}', {status: 200});
  };
  h.context.console = {log: (...args) => h.logs.push(args.join(' ')), warn: (...args) => h.logs.push(args.join(' ')), error: (...args) => h.logs.push(args.join(' '))};
  return h;
}
const ctxFor = h => ({waitUntil: promise => h.waits.push(promise)});
const form = h => ({'content-type': 'application/x-www-form-urlencoded'});
async function ask(h, route = '/api/acquire', options = {}) {
  const url = base + route + '?doi=' + encodeURIComponent(options.doi || doi);
  const request = new Request(url, {method: 'POST', headers: form(h), body: new URLSearchParams({passphrase: h.env.PDF_DOWNLOAD_PASSPHRASE}).toString()});
  const ctx = options.ctx === false ? undefined : options.ctx || ctxFor(h);
  const response = await h.context.worker.fetch(request, h.env, ctx);
  const early = {status: response.status, text: await response.clone().text()};
  await Promise.all(h.waits);
  return {response, early};
}
const notifyWrites = h => h.writes.filter(w => w.key.startsWith('notify:download:'));
const notifyReads = h => h.reads.filter(r => r.key.startsWith('notify:download:') || r.key === SWITCH);
const jobOf = async result => (await result.response.json()).job;

(async () => {
  // 1. Reference run: no secrets, no switch. The user answer is the baseline every other run must match in status and shape.
  let h = await create({secrets: false});
  const reference = await ask(h);
  assert.equal(reference.early.status, 202);
  const referenceBody = JSON.parse(reference.early.text);
  assert.equal(referenceBody.job.state, 'queued');
  assert.equal(h.hooks.length, 0); assert.equal(notifyReads(h).length, 0, 'no secrets: not even the switch is read'); assert.equal(h.waits.length, 0);

  // 2. Switch missing or not exactly '1'/'true': nothing is sent and nothing is written (reads only).
  for (const value of [undefined, '0', 'false', '', ' 1', 'TRUE', 'yes', '11']) {
    h = await create({switch: value});
    const result = await ask(h);
    assert.equal(result.early.status, 202, 'switch ' + JSON.stringify(value));
    assert.equal(h.hooks.length, 0, 'switch ' + JSON.stringify(value) + ' sends nothing');
    assert.equal(notifyWrites(h).length, 0, 'switch ' + JSON.stringify(value) + ' writes nothing');
  }
  // 2b. A failing switch read means off, and the response is unaffected.
  h = await create({switch: '1'});
  const rawGet = h.env.QL_KV.get;
  h.env.QL_KV = {...h.env.QL_KV, get: async (key, type) => { if (key === SWITCH) throw new Error('synthetic kv failure'); return rawGet(key, type); }};
  let result = await ask(h); assert.equal(result.early.status, 202); assert.equal(h.hooks.length, 0); assert.equal(notifyWrites(h).length, 0);

  // 3. Missing, unusable or non-https secrets: nothing is sent, no notify KV access at all.
  for (const secrets of [{DOWNLOAD_NOTIFY_URL: undefined}, {DOWNLOAD_NOTIFY_KEY: undefined}, {DOWNLOAD_NOTIFY_URL: '', DOWNLOAD_NOTIFY_KEY: ''},
      {DOWNLOAD_NOTIFY_URL: 'http://hooks.example.test/x'}, {DOWNLOAD_NOTIFY_URL: 'not a url'}, {DOWNLOAD_NOTIFY_URL: 'https://user:pw@hooks.example.test/x'},
      {DOWNLOAD_NOTIFY_KEY: 'has space'}, {DOWNLOAD_NOTIFY_KEY: 'line\nbreak'}]) {
    h = await create({switch: '1', secrets});
    result = await ask(h);
    assert.equal(result.early.status, 202, JSON.stringify(Object.keys(secrets)));
    assert.equal(h.hooks.length, 0, 'unusable secrets send nothing: ' + JSON.stringify(Object.keys(secrets)));
    assert.equal(notifyWrites(h).length, 0);
  }

  // 4. Switch on ('1' and 'true'): exactly one POST, Authorization: Bearer <key>, payload exactly doi, task_id, ts.
  for (const value of ['1', 'true']) {
    h = await create({switch: value});
    result = await ask(h);
    assert.equal(result.early.status, 202); const job = await jobOf(result);
    assert.equal(h.hooks.length, 1, 'switch ' + value + ' sends one notice');
    const {url, init} = h.hooks[0];
    assert.equal(url, hookUrl); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual'); assert(init.signal, 'bounded by an abort signal');
    assert.deepEqual(Object.keys(init.headers).sort(), ['authorization', 'content-type']);
    assert.equal(init.headers.authorization, 'Bearer ' + hookKey); assert.equal(init.headers['content-type'], 'application/json');
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['doi', 'task_id', 'ts'], 'payload has exactly three fields');
    assert.equal(body.doi, doi); assert.equal(body.task_id, job.id); assert.equal(body.ts, '2026-11-14T03:10:00.000Z');
    for (const text of [title, 'Jane Doe', 'Heart', 'passphrase', h.env.PDF_DOWNLOAD_PASSPHRASE, hookKey]) assert(!init.body.includes(text), 'payload carries no title, author, journal or secret: ' + text);
    // KV: a DOI key with TTL 3600 and an hour counter with a TTL, nothing else.
    const writes = notifyWrites(h); assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], {key: 'notify:download:doi:' + doi, value: '1', opts: {expirationTtl: 3600}});
    assert.equal(writes[1].key, 'notify:download:hour:2026111403'); assert.equal(writes[1].value, '1'); assert.equal(writes[1].opts.expirationTtl, 7200);
    assert.deepEqual(JSON.parse(result.early.text).job.state, 'queued', 'the user answer is the usual one');
    assert(!result.early.text.includes(hookKey) && !result.early.text.includes(hookUrl));
    assert(h.logs.every(line => !line.includes(hookKey) && !line.includes(hookUrl) && !line.includes(doi)), 'logs never carry the URL, key or DOI');
    // The answer has the same shape as the run without any notice (ids differ per task).
    assert.deepEqual(Object.keys(JSON.parse(result.early.text)).sort(), Object.keys(referenceBody).sort());
    // Not a D1 shadow prefix: counters are not ledger records.
    assert.equal(h.context.d1ShadowEntity('notify:download:doi:' + doi), ''); assert.equal(h.context.d1ShadowEntity('notify:download:hour:2026111403'), '');
  }

  // 5. An existing task answers as before and notifies nobody; a DOI that already has its full text never notifies.
  h = await create({switch: '1'});
  const first = await ask(h); const again = await ask(h);
  assert.equal(again.early.status, 202); assert.equal((await jobOf(again)).id, (await jobOf(first)).id);
  assert.equal(h.hooks.length, 1, 'repeat click on an existing task sends nothing more');
  h = await create({switch: '1'}); seed(h);
  result = await ask(h);
  assert.equal(result.early.status, 200); assert.equal(h.hooks.length, 0, 'full text already present: no notice');
  assert.equal(notifyReads(h).length, 0); assert.equal(notifyWrites(h).length, 0);

  // 6. Same DOI once per hour: a second NEW task for the DOI (retry after a failure) is held back, and goes out once the key expires.
  h = await create({switch: '1'});
  const queued = await jobOf(await ask(h)); assert.equal(h.hooks.length, 1);
  const stored = JSON.parse(h.values.get('library:muse-job:' + doi)); h.values.set('library:muse-job:' + doi, JSON.stringify({...stored, state: 'failed', reason: 'lease_expired'}));
  let retry = await ask(h, '/api/muse/retry'); assert.equal(retry.early.status, 202); const retried = await jobOf(retry);
  assert.notEqual(retried.id, queued.id); assert.equal(h.hooks.length, 1, 'same DOI inside the hour is not sent again');
  assert.equal(notifyWrites(h).length, 2, 'a suppressed notice writes nothing');
  h.values.delete('notify:download:doi:' + doi); // what the 3600 s TTL does
  h.values.set('library:muse-job:' + doi, JSON.stringify({...JSON.parse(h.values.get('library:muse-job:' + doi)), state: 'failed', reason: 'lease_expired'}));
  h.clock.now += 3601000;
  retry = await ask(h, '/api/muse/retry'); assert.equal(retry.early.status, 202);
  assert.equal(h.hooks.length, 2, 'after the hour the same DOI is sent again');
  assert.equal(JSON.parse(h.hooks[1].init.body).task_id, (await jobOf(retry)).id);

  // 7. Retry path alone: a recoverable task put back in the queue is a new task and is announced.
  h = await create({switch: '1'});
  await ask(h, '/api/acquire', {ctx: false}); // the first task is created while nothing is announced (no ctx)
  assert.equal(h.hooks.length, 0, 'without ctx.waitUntil nothing is sent');
  h.values.set('library:muse-job:' + doi, JSON.stringify({...JSON.parse(h.values.get('library:muse-job:' + doi)), state: 'failed', reason: 'lease_expired'}));
  retry = await ask(h, '/api/muse/retry'); assert.equal(retry.early.status, 202);
  assert.equal(h.hooks.length, 1); assert.equal(JSON.parse(h.hooks[0].init.body).task_id, (await jobOf(retry)).id);

  // 8. Hourly cap of 20 across the site: counted per UTC hour, over the cap only logged, not sent, nothing written.
  h = await create({switch: '1'});
  const env = h.env, run = (d, id) => h.context.downloadNotifyRun(env, d, id);
  for (let i = 0; i < 20; i++) await run('10.1000/cap' + i, 'task-' + i);
  assert.equal(h.hooks.length, 20, 'twenty notices go out');
  assert.equal(h.values.get('notify:download:hour:2026111403'), '20');
  const writesBefore = h.writes.length, logsBefore = h.logs.length;
  await run('10.1000/cap-over', 'task-over');
  assert.equal(h.hooks.length, 20, 'the twenty-first is not sent'); assert.equal(h.writes.length, writesBefore, 'over the cap nothing is written');
  assert(h.logs.slice(logsBefore).some(line => line.includes('hourly limit')), 'over the cap it is only logged');
  assert(h.logs.every(line => !line.includes('cap-over')), 'the log has no DOI');
  assert.equal(h.values.has('notify:download:doi:10.1000/cap-over'), false, 'a suppressed DOI is not marked as sent');
  h.clock.now += 3600000; // next UTC hour: a fresh bucket
  await run('10.1000/cap-next', 'task-next');
  assert.equal(h.hooks.length, 21); assert.equal(h.values.get('notify:download:hour:2026111404'), '1');
  // The counter write carries a TTL so old buckets disappear.
  assert(h.writes.filter(w => w.key.startsWith('notify:download:hour:')).every(w => w.opts && w.opts.expirationTtl === 7200));

  // 9. A failing, rejecting, redirecting or hanging webhook never changes the user response, and the failure is swallowed.
  const failures = {
    rejects: (init, hh) => Promise.reject(new Error('synthetic network failure ' + hookKey)),
    status500: () => new Response('boom', {status: 500}),
    redirect: () => new Response(null, {status: 302, headers: {location: 'https://elsewhere.example.test/'}}),
    hangs: (init, hh) => { hh.hangSignal = init.signal; return new Promise(() => {}); }
  };
  for (const [name, hook] of Object.entries(failures)) {
    h = await create({switch: '1', hook});
    const started = Date.now();
    result = await ask(h);
    assert.equal(result.early.status, 202, name); assert.equal((await jobOf(result)).state, 'queued', name);
    assert.equal(h.hooks.length, 1, name);
    assert(Date.now() - started < 2000, name + ' stays bounded (timers are shortened in this harness)');
    assert(h.logs.every(line => !line.includes(hookKey) && !line.includes(hookUrl)), name + ': logs carry no secret');
    if (name === 'hangs') assert.equal(h.hangSignal.aborted, true, 'a hanging webhook is aborted by the timeout');
  }
  // The real limit is 3 seconds: the abort timer is armed with exactly that value.
  { h = await create({switch: '1', hook: () => new Promise(() => {})}); const delays = []; const realTimeout = h.context.setTimeout;
    h.context.setTimeout = (callback, ms) => { delays.push(ms); return realTimeout(callback, Math.min(ms, 5)); };
    result = await ask(h); assert.equal(result.early.status, 202); assert(delays.includes(3000), 'webhook timeout is 3000 ms'); }
  // The answer reaches the caller before the webhook finishes: the notice only runs inside ctx.waitUntil.
  { let release; h = await create({switch: '1', hook: () => new Promise(resolve => { release = () => resolve(new Response('ok')); })});
    const request = new Request(base + '/api/acquire?doi=' + encodeURIComponent(doi), {method: 'POST', headers: form(h), body: new URLSearchParams({passphrase: h.env.PDF_DOWNLOAD_PASSPHRASE}).toString()});
    const response = await h.context.worker.fetch(request, h.env, ctxFor(h));
    assert.equal(response.status, 202); assert.equal(h.waits.length, 1, 'the notice is handed to ctx.waitUntil');
    await new Promise(resolve => setTimeout(resolve, 30)); release(); await Promise.all(h.waits); assert.equal(h.hooks.length, 1); }
  // A broken ctx.waitUntil cannot break the response either.
  h = await create({switch: '1'});
  result = await ask(h, '/api/acquire', {ctx: {waitUntil() { throw new Error('synthetic waitUntil failure'); }}});
  assert.equal(result.early.status, 202); assert.equal((await jobOf(result)).state, 'queued');
  // KV write failure after the check: swallowed, nothing is sent, response unchanged.
  h = await create({switch: '1', harness: {putError: key => key.startsWith('notify:download:')}});
  result = await ask(h); assert.equal(result.early.status, 202); assert.equal(h.hooks.length, 0);

  console.log('Download notice webhook: switch, secrets, payload, de-duplication, hourly cap and failure isolation passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
