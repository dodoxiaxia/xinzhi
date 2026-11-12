'use strict';
// Offline: MUSE_LEGACY_ENDPOINTS_DISABLED closes only /api/muse/claim, receipt and upload (410 muse_retired, before any
// authentication, secret or KV access). Everything else behaves as before. Hooked in at the end of test_muse_reader_upload.cjs.
const assert = require('assert');
const {setup, token} = require('./test_fulltext_auth_helpers.cjs');
const {doi} = require('./test_doi_library_worker.cjs');
const base = 'https://learn.dryz.info', museKey = 'synthetic_muse_key_0123456789_abcdef', fallbackToken = 'synthetic_fallback_token_0123456789abcd';
const pdfBytes = Buffer.from('%PDF-1.7\n' + 'x'.repeat(52000) + '\n%%EOF\n');
async function create(flag) {
  const h = await setup({});
  Object.assign(h.env, {MUSE_FULLTEXT_ENABLED:'true', MUSE_FULLTEXT_KEY:museKey, MACHINE_TOKENS:JSON.stringify([{id:'fallback', role:'fallback', token:fallbackToken}])});
  if (flag !== undefined) h.env.MUSE_LEGACY_ENDPOINTS_DISABLED = flag;
  return h;
}
const send = (h, method, route, headers, body) => h.context.worker.fetch(new Request(base + route, {method, headers, ...(body === undefined ? {} : {body})}), h.env);
const museAuth = {authorization:'Bearer ' + museKey, 'content-type':'application/json'};
const legacyCalls = h => [
  () => send(h, 'POST', '/api/muse/claim', museAuth, '{}'),
  () => send(h, 'POST', '/api/muse/receipt', museAuth, JSON.stringify({taskId:'00000000-0000-4000-8000-000000000000', doi, leaseId:'00000000-0000-4000-8000-000000000001', state:'running'})),
  () => send(h, 'PUT', '/api/muse/upload', {authorization:'Bearer ' + museKey, 'content-type':'application/pdf', 'x-muse-doi':doi, 'x-muse-task-id':'00000000-0000-4000-8000-000000000000', 'x-muse-lease-id':'00000000-0000-4000-8000-000000000001'}, pdfBytes),
  // The shutdown comes before authentication: a wrong key, no key and the wrong method are all 410 too.
  () => send(h, 'POST', '/api/muse/claim', {authorization:'Bearer wrong', 'content-type':'application/json'}, '{}'),
  () => send(h, 'POST', '/api/muse/claim', {'content-type':'application/json'}, '{}'),
  () => send(h, 'GET', '/api/muse/receipt', {}),
  () => send(h, 'POST', '/api/muse/upload?x=1', {}, 'x')
];
(async () => {
  // Switch off, unset, or anything other than the exact string 'true': legacy behaviour is unchanged.
  for (const flag of [undefined, 'false', '', 'TRUE', '1', 'yes', ' true']) {
    const h = await create(flag);
    const claim = await send(h, 'POST', '/api/muse/claim', museAuth, '{}');
    assert.equal(claim.status, 200, 'flag ' + JSON.stringify(flag)); assert.equal((await claim.json()).task, null);
    assert.equal((await send(h, 'POST', '/api/muse/claim', {authorization:'Bearer wrong', 'content-type':'application/json'}, '{}')).status, 401);
    const protocol = await (await send(h, 'GET', '/api/muse/protocol', {})).json();
    assert.equal(protocol.deprecation.closed, false); assert.deepEqual(protocol.deprecation.closedEndpoints, []); assert.equal(protocol.deprecation.autoDisable, false);
    const machine = await (await send(h, 'GET', '/api/machine/protocol', {})).json();
    assert.equal(machine.legacyMuse.closed, false); assert.deepEqual(machine.legacyMuse.closedEndpoints, []);
  }

  // Switch on: claim, receipt and upload answer 410 before authentication, and touch neither the secret nor KV.
  let h = await create('true');
  for (const call of legacyCalls(h)) {
    const reads = h.reads.length, writes = h.writes.length, lists = h.lists.length, calls = h.calls.length;
    const response = await call();
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.deepEqual(body, {ok:false, error:'muse_retired', replacement:'/api/machine/protocol'});
    assert.equal(h.reads.length, reads, 'no KV read'); assert.equal(h.writes.length, writes, 'no KV write'); assert.equal(h.lists.length, lists, 'no KV list'); assert.equal(h.calls.length, calls, 'no outbound call');
  }
  // Even with no key configured at all (nothing to compare against), the answer is the same 410, not 503.
  h = await create('true'); delete h.env.MUSE_FULLTEXT_KEY;
  assert.equal((await send(h, 'POST', '/api/muse/claim', {}, '{}')).status, 410);

  // Protocols reflect the switch; the status page says it is closed and everything else stays.
  h = await create('true');
  const protocol = await (await send(h, 'GET', '/api/muse/protocol', {})).json();
  assert.equal(protocol.deprecation.closed, true); assert.deepEqual(protocol.deprecation.closedEndpoints, ['/api/muse/claim', '/api/muse/receipt', '/api/muse/upload']);
  assert(protocol.deprecation.note.includes('410')); assert.equal(protocol.deprecation.autoDisable, false);
  assert(protocol.deprecation.endpoints.includes('/api/muse/retry'), 'retry stays listed and stays open');
  const page = await (await send(h, 'GET', '/api/muse/protocol', {accept:'text/html'})).text();
  assert(page.includes('已关闭')); assert(!page.includes('过渡期仍可用'));
  const machine = await (await send(h, 'GET', '/api/machine/protocol', {})).json();
  assert.equal(machine.legacyMuse.closed, true); assert.deepEqual(machine.legacyMuse.closedEndpoints, ['/api/muse/claim', '/api/muse/receipt', '/api/muse/upload']);
  assert.equal(machine.legacyMuse.autoDisable, false);

  // Unchanged with the switch on: site request/acquire, retry page, reader-upload page, review, machine API.
  const requested = await h.request(); assert.equal(requested.status, 202); assert.equal((await requested.json()).job.stage, 'queued');
  const acquired = await h.request('/api/acquire'); assert([200, 202].includes(acquired.status));
  assert.equal((await send(h, 'GET', '/api/muse/request?doi=' + encodeURIComponent(doi), {accept:'application/json'})).status, 202);
  assert.equal((await send(h, 'GET', '/api/muse/retry?doi=' + encodeURIComponent(doi), {accept:'text/html'})).status, 202, 'a live queued task is simply shown, as before');
  assert.equal((await send(h, 'GET', '/api/muse/reader-upload?doi=' + encodeURIComponent(doi), {accept:'text/html'})).status, 200);
  const reviewUrl = base + '/api/muse/review', auth = await token(h, reviewUrl, 'muse-review.yml');
  const review = await send(h, 'POST', '/api/muse/review', {authorization:'Bearer ' + auth, 'content-type':'application/json'}, JSON.stringify({action:'claim'}));
  assert.equal(review.status, 200, 'the hourly verifier keeps working');
  const list = await send(h, 'GET', '/api/machine/tasks?state=to-download', {authorization:'Bearer ' + fallbackToken});
  assert.equal(list.status, 200); assert.equal((await list.json()).tasks.length, 1);
  const claimed = await send(h, 'POST', '/api/machine/claim', {authorization:'Bearer ' + fallbackToken, 'content-type':'application/json'}, JSON.stringify({state:'failed-awaiting-fallback'}));
  assert.equal(claimed.status, 200);
  console.log('Muse legacy switch: off leaves behaviour unchanged; on closes claim/receipt/upload with 410 before auth and KV, everything else unchanged passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
