'use strict';
// POST /api/machine/register: idempotent DOI registration. Synthetic tokens and an in-memory KV only.
const assert = require('assert');
const crypto = require('crypto');
const {setup} = require('./test_fulltext_auth_helpers.cjs');
const {error, hash} = require('./test_doi_library_worker.cjs');
const base = 'https://learn.dryz.info';
const dsh = 'synthetic_downloader_token_0123456789ab';
const dsh2 = 'synthetic_second_downloader_token_0123456';
const fallback = 'synthetic_fallback_token_0123456789abcd';
const reader = 'synthetic_reader_token_0123456789abcdef';
const revoked = 'synthetic_revoked_token_0123456789abcdef';
const unknown = 'synthetic_unknown_token_0123456789abcd';
const tokens = JSON.stringify([
  {id:'dsh',role:'downloader',token:dsh},
  {id:'dsh2',role:'downloader',token:dsh2},
  {id:'fallback',role:'fallback',token:fallback},
  {id:'ddx',role:'reader',token:reader},
  {id:'old',role:'downloader',token:revoked,revoked:true}
]);
async function create(options = {}) {
  const h = await setup(options);
  h.env.MUSE_FULLTEXT_ENABLED = 'true';
  h.env.MACHINE_TOKENS = tokens;
  return h;
}
function post(h, path, secret, body, options = {}) {
  const headers = {'content-type':'application/json',...(secret ? {authorization:'Bearer ' + secret} : {}),...(options.headers || {})};
  const init = {method:options.method || 'POST',headers};
  if (init.method !== 'GET') init.body = options.raw === undefined ? JSON.stringify(body) : options.raw;
  return h.context.worker.fetch(new Request(base + path, init), h.env);
}
const register = (h, secret, items, options) => post(h, '/api/machine/register', secret, {items}, options);
const item = (n, extra = {}) => ({doi:'10.1000/reg.' + n,title:'Synthetic registration title number ' + n,source:'rss-2026-11-12-am',section:'MAIN',...extra});
const stored = (h, key) => { const value = h.values.get(key); return value === undefined ? undefined : JSON.parse(value); };
const day = h => new h.context.Date().toISOString().slice(0, 10);
const quotaKey = (caller, h) => 'library:machine-rate:register:' + caller + ':' + day(h);
const jobKeys = h => [...h.values.keys()].filter(key => key.startsWith('library:muse-job:'));
const writesTo = (h, doi) => h.writes.filter(write => write.key.includes(doi));
async function run() {
  for (const secret of [dsh, dsh2, fallback, reader, revoked, unknown]) assert(/^[A-Za-z0-9_-]{32,128}$/.test(secret));

  // ---- permissions: nothing is written for a rejected caller
  let h = await create();
  const before = h.writes.length;
  await error(await register(h, fallback, [item(1)]), 403, 'machine_forbidden');
  await error(await register(h, reader, [item(1)]), 403, 'machine_forbidden');
  await error(await register(h, revoked, [item(1)]), 401, 'machine_revoked');
  await error(await register(h, unknown, [item(1)]), 401, 'machine_unauthorized');
  await error(await register(h, '', [item(1)]), 401, 'machine_unauthorized');
  await error(await post(h, '/api/machine/register', dsh, null, {method:'GET'}), 405, 'machine_bad_request');
  assert.equal(h.writes.length, before);
  assert.equal(h.calls.length, 0);

  h.env.GROK_FULLTEXT_ENABLED = 'true';
  await error(await register(h, dsh, [item(1)]), 409, 'muse_owner_conflict');
  delete h.env.GROK_FULLTEXT_ENABLED;
  h.env.FULLTEXT_ASYNC_ENABLED = 'true';
  await error(await register(h, dsh, [item(1)]), 409, 'muse_owner_conflict');
  assert.equal(h.writes.length, before);

  // ---- downloader registers; same shape as a site-owner selection
  h = await create();
  const first = await register(h, dsh, [item(1), item(2,{section:'CARDIO',source:'rss-2026-11-12-pm'})]);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(firstBody.counts, {registered:2,skipped:0,overQuota:0,rejected:0});
  assert.deepEqual(firstBody.results.map(r => r.result), ['registered','registered']);
  assert.equal(firstBody.results[0].state, 'to-download');
  assert.equal(firstBody.quota.limit, 200);
  assert.equal(firstBody.quota.used, 2);
  assert.equal(firstBody.quota.remaining, 198);
  const job = stored(h, 'library:muse-job:10.1000/reg.1');
  assert.equal(job.state, 'queued');
  assert.equal(job.doi, '10.1000/reg.1');
  assert.deepEqual(job.registration, {source:'rss-2026-11-12-am',section:'MAIN'});
  assert.deepEqual(stored(h, job.queueKey), {doi:'10.1000/reg.1',id:job.id});
  const paper = stored(h, 'library:paper:10.1000/reg.1').paper;
  assert.equal(paper.title, 'Synthetic registration title number 1');
  assert.equal(paper.fulltextStatus, 'manual_needed');
  assert.equal(paper.id, 'doi-' + crypto.createHash('sha256').update('10.1000/reg.1').digest('hex').slice(0, 16));
  const meta = stored(h, 'library:machine-register:10.1000/reg.2');
  assert.deepEqual({title:meta.title,source:meta.source,section:meta.section,registeredBy:meta.registeredBy}, {title:'Synthetic registration title number 2',source:'rss-2026-11-12-pm',section:'CARDIO',registeredBy:'dsh'});
  assert.equal(stored(h, quotaKey('dsh', h)), 2);

  // ---- the existing flow sees them: list, then claim by the downloader
  const listed = await (await post(h, '/api/machine/tasks?state=to-download&limit=10', dsh, null, {method:'GET'})).json();
  assert.deepEqual(listed.tasks.map(t => t.doi).sort(), ['10.1000/reg.1','10.1000/reg.2']);
  assert.equal(listed.tasks.find(t => t.doi === '10.1000/reg.2').section, 'CARDIO');
  const claim = await (await post(h, '/api/machine/claim', dsh, {state:'to-download'})).json();
  assert.equal(claim.task.state, 'downloading');
  assert.equal(claim.task.claimant, 'dsh');
  assert(claim.task.title.startsWith('Synthetic registration title number'));
  assert(['MAIN','CARDIO'].includes(claim.task.section));

  // ---- idempotency: same DOI again does not change state, does not enqueue again
  const queueBefore = [...h.values.keys()].filter(key => key.startsWith('library:muse-queue:')).length;
  const snapshot = Object.fromEntries(['library:muse-job:10.1000/reg.1','library:muse-job:10.1000/reg.2','library:paper:10.1000/reg.1'].map(key => [key, h.values.get(key)]));
  const writesBefore = h.writes.length;
  const again = await (await register(h, dsh, [item(1,{title:'A completely different title for the same paper',section:'CARDIO'}), item(2)])).json();
  assert.deepEqual(again.counts, {registered:0,skipped:2,overQuota:0,rejected:0});
  assert(again.results.every(r => r.result === 'skipped' && r.reason === 'exists' && r.where === 'ledger'));
  assert.deepEqual(again.results.map(r => r.state).sort(), ['downloading','to-download'], 'each skipped DOI reports its current state');
  assert.equal(h.writes.length, writesBefore, 'a skipped DOI causes no write at all');
  for (const [key, value] of Object.entries(snapshot)) assert.equal(h.values.get(key), value);
  assert.equal([...h.values.keys()].filter(key => key.startsWith('library:muse-queue:')).length, queueBefore);
  assert.equal(stored(h, quotaKey('dsh', h)), 2, 'skipped items do not use quota');

  // ---- DOI normalisation: prefix and case variants are the same DOI
  const variant = await (await register(h, dsh, [item(1,{doi:'https://doi.org/10.1000/REG.1'}), item(1,{doi:'doi:10.1000/Reg.1'})])).json();
  assert.deepEqual(variant.results.map(r => [r.doi, r.result]), [['10.1000/reg.1','skipped'],['10.1000/reg.1','skipped']]);
  assert.equal(variant.results[0].reason, 'exists');
  assert.equal(variant.results[1].reason, 'duplicate_in_batch');

  // ---- duplicates inside one batch: first wins, one job only
  h = await create();
  const dup = await (await register(h, dsh, [item(5), item(5,{doi:'10.1000/REG.5',title:'Other title that must be ignored here',section:'CARDIO'}), item(6)])).json();
  assert.deepEqual(dup.results.map(r => r.result), ['registered','skipped','registered']);
  assert.equal(dup.results[1].reason, 'duplicate_in_batch');
  assert.equal(dup.counts.registered, 2);
  assert.equal(jobKeys(h).length, 2);
  assert.equal(stored(h, 'library:muse-job:10.1000/reg.5').registration.section, 'MAIN');
  assert.equal(stored(h, quotaKey('dsh', h)), 2);

  // ---- existing state is never changed, whatever it is (every ledger state, paper-only, legacy job)
  h = await create();
  const created = Date.now() - 1000;
  const states = ['queued','failed','login_required','review','abandoned'];
  const original = {};
  states.forEach((state, n) => {
    const doi = '10.1000/state.' + state, id = crypto.randomUUID();
    const queueKey = 'library:muse-queue:' + String(created).padStart(13, '0') + ':' + id;
    h.values.set('library:muse-job:' + doi, original[doi] = JSON.stringify({version:1,id,doi,state,createdAt:created,updatedAt:created,queueKey}));
  });
  const paperOnly = '10.1000/paper-only';
  h.values.set('library:paper:' + paperOnly, original[paperOnly] = JSON.stringify({version:1,paper:{id:'doi-' + hash(paperOnly).slice(0, 16),doi:paperOnly,title:'Paper without any task record',journal:'',authors:[],date:'',datePrecision:'',dateBasis:'',ingestedAt:'2026-10-07T04:00:00.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:'manual_needed'}}));
  const legacy = '10.1000/legacy-job';
  h.values.set('library:job:' + legacy, original[legacy] = JSON.stringify({version:1,doi:legacy,state:'queued'}));
  const corrupt = '10.1000/corrupt';
  h.values.set('library:muse-job:' + corrupt, original[corrupt] = JSON.stringify({unexpected:true}));
  const items = [...states.map(state => item(0,{doi:'10.1000/state.' + state})), item(0,{doi:paperOnly}), item(0,{doi:legacy}), item(0,{doi:corrupt})];
  const keysBefore = new Map([...h.values]);
  const writesAtStart = h.writes.length;
  const skippedAll = await (await register(h, dsh, items)).json();
  assert.deepEqual(skippedAll.counts, {registered:0,skipped:items.length,overQuota:0,rejected:0});
  assert.deepEqual(skippedAll.results.map(r => r.state), ['to-download','failed-awaiting-fallback','failed-awaiting-fallback','failed-awaiting-fallback','confirmed-abandoned','no-task','legacy-task','unknown']);
  assert.equal(h.writes.length, writesAtStart);
  assert.deepEqual([...h.values], [...keysBefore]);
  // an available paper reports done
  h.values.set('library:paper:10.1000/avail', JSON.stringify({version:1,paper:{id:'doi-' + hash('10.1000/avail').slice(0, 16),doi:'10.1000/avail',title:'Already available paper',journal:'',authors:[],date:'',datePrecision:'',dateBasis:'',ingestedAt:'2026-10-07T04:00:00.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:'available'},pdf:{key:'library:pdf:' + 'a'.repeat(64),sha256:'a'.repeat(64),size:100000,source:'github'}}));
  const avail = await (await register(h, dsh, [item(0,{doi:'10.1000/avail'})])).json();
  assert.equal(avail.results[0].result, 'skipped');
  assert.equal(avail.results[0].state, 'done');

  // ---- batch limit: 50 ok, 51 rejected before any write
  h = await create();
  const fifty = Array.from({length:50}, (_, n) => item(100 + n));
  const okFifty = await register(h, dsh, fifty);
  assert.equal(okFifty.status, 200);
  assert.equal((await okFifty.json()).counts.registered, 50);
  const h2 = await create();
  await error(await register(h2, dsh, [...fifty, item(999)]), 400, 'machine_batch_too_large');
  assert.equal(h2.writes.length, 0);
  await error(await register(h2, dsh, []), 400, 'machine_bad_request');
  await error(await post(h2, '/api/machine/register', dsh, {items:'x'}), 400, 'machine_bad_request');
  await error(await post(h2, '/api/machine/register', dsh, {items:[item(1)],extra:1}), 400, 'machine_bad_request');
  await error(await post(h2, '/api/machine/register', dsh, null, {raw:'{'}), 400, 'machine_bad_request');
  await error(await post(h2, '/api/machine/register', dsh, {items:[item(1)]}, {headers:{'content-type':'text/plain'}}), 415, 'machine_bad_request');
  assert.equal(h2.writes.length, 0);

  // ---- per-item validation: the rest of the batch still goes through
  h = await create();
  const mixed = await (await register(h, dsh, [
    item(1,{section:'main'}), item(2,{section:'OTHER'}), item(3,{section:undefined}), item(4,{source:'Bad Source!'}), item(5,{source:'x'.repeat(65)}), item(6,{source:undefined}),
    item(7,{title:''}), item(8,{title:'Hi'}), item(9,{doi:'not-a-doi'}), item(10,{extra:'x'}), 'string', null, item(11)
  ])).json();
  assert.deepEqual(mixed.results.map(r => r.error || r.result), ['bad_section','bad_section','bad_section','bad_source','bad_source','bad_source','bad_title','bad_title','bad_doi','bad_item','bad_item','bad_item','registered']);
  assert.deepEqual(mixed.counts, {registered:1,skipped:0,overQuota:0,rejected:12});
  assert.equal(jobKeys(h).length, 1);

  // ---- quota: default 200, configurable, per caller, only new items count, over-quota items are reported
  h = await create();
  h.env.MACHINE_REGISTER_DAILY_LIMIT = '3';
  const limited = await (await register(h, dsh, [item(1), item(2), item(3), item(4), item(5)])).json();
  assert.deepEqual(limited.results.map(r => r.result), ['registered','registered','registered','over_quota','over_quota']);
  assert.deepEqual(limited.counts, {registered:3,skipped:0,overQuota:2,rejected:0});
  assert.deepEqual({limit:limited.quota.limit,used:limited.quota.used,remaining:limited.quota.remaining}, {limit:3,used:3,remaining:0});
  assert(!h.values.has('library:muse-job:10.1000/reg.4'));
  assert(!h.values.has('library:paper:10.1000/reg.5'));
  assert.equal(stored(h, quotaKey('dsh', h)), 3);
  const afterQuota = await (await register(h, dsh, [item(1), item(4)])).json();
  assert.deepEqual(afterQuota.results.map(r => r.result), ['skipped','over_quota'], 'skips are free even at zero remaining');
  assert.equal(stored(h, quotaKey('dsh', h)), 3);
  const other = await (await register(h, dsh2, [item(4)])).json();
  assert.equal(other.results[0].result, 'registered', 'another caller has its own budget');
  assert.equal(stored(h, quotaKey('dsh2', h)), 1);
  assert.equal(h.values.get(quotaKey('dsh', h)), '3');
  assert.equal(stored(h, 'library:machine-register:10.1000/reg.4').registeredBy, 'dsh2');
  h.env.MACHINE_REGISTER_DAILY_LIMIT = '0';
  await error(await register(h, dsh, [item(1)]), 503, 'machine_not_configured');
  h.env.MACHINE_REGISTER_DAILY_LIMIT = '501';
  await error(await register(h, dsh, [item(1)]), 503, 'machine_not_configured');
  // the upload and requeue budgets are separate buckets
  assert.equal(h.values.get('library:machine-rate:upload:dsh:' + day(h)), undefined);

  // ---- a storage failure part way: finished items stay counted, the failing DOI leaves nothing behind, a retry completes
  let failing = true;
  h = await create({putError:key => failing && key === 'library:muse-job:10.1000/reg.3'});
  await error(await register(h, dsh, [item(1), item(2), item(3), item(4)]), 503, 'library_storage');
  assert.equal(stored(h, quotaKey('dsh', h)), 2);
  assert(h.values.has('library:muse-job:10.1000/reg.2'));
  for (const key of ['library:muse-job:10.1000/reg.3','library:paper:10.1000/reg.3','library:attempt:10.1000/reg.3','library:machine-register:10.1000/reg.3']) assert(!h.values.has(key), key);
  assert.equal([...h.values.keys()].filter(key => key.startsWith('library:muse-queue:')).length, 2);
  failing = false;
  const retry = await (await register(h, dsh, [item(1), item(2), item(3), item(4)])).json();
  assert.deepEqual(retry.results.map(r => r.result), ['skipped','skipped','registered','registered']);
  assert.equal(stored(h, quotaKey('dsh', h)), 4);

  // ---- protocol and registered metadata survive a requeue
  h = await create();
  const protocol = await (await h.context.worker.fetch(new Request(base + '/api/machine/protocol'), h.env)).json();
  assert.equal(protocol.endpoints.register, 'POST /api/machine/register');
  assert.equal(protocol.limits.registerDailyDefault, 200);
  assert.equal(protocol.limits.registerDailyEnv, 'MACHINE_REGISTER_DAILY_LIMIT');
  assert.equal(protocol.limits.registerMaxItems, 50);
  assert.deepEqual(protocol.registerSections, ['MAIN','CARDIO']);
  assert(!JSON.stringify(protocol).includes(dsh));
  await register(h, dsh, [item(1,{section:'CARDIO'})]);
  const stale = stored(h, 'library:muse-job:10.1000/reg.1');
  h.values.set('library:muse-job:10.1000/reg.1', JSON.stringify({...stale,state:'failed',reason:'other'}));
  const requeued = await (await post(h, '/api/machine/requeue', dsh, {})).json();
  assert.equal(requeued.requeued.length, 1);
  assert.equal(stored(h, 'library:muse-job:10.1000/reg.1').registration.section, 'CARDIO');
  console.log('machine register tests passed');
}
// scripts/test_machine_download.cjs awaits run(), so the CI jobs that already run that file also run these checks.
module.exports = {run};
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
