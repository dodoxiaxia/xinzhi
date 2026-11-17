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
  h.values.set('library:paper:' + paperOnly, original[paperOnly] = JSON.stringify({version:1,paper:{id:'doi-' + hash(paperOnly).slice(0, 16),doi:paperOnly,title:'Paper without any task record',journal:'Heart',authors:[],date:'',datePrecision:'',dateBasis:'',ingestedAt:'2026-10-07T04:00:00.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:'manual_needed'}}));
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
  // No task, paper, queue or quota record is written for an existing DOI. The only write is the candidate index: a replay puts the
  // tasks that belong in it (waiting, failed, login_required, review) back, which is what repairs a batch that was cut off.
  const INDEX_KEY = 'library:machine-index:v1';
  assert.deepEqual(h.writes.slice(writesAtStart).map(write => write.key), [INDEX_KEY]);
  assert.deepEqual([...h.values].filter(([key]) => key !== INDEX_KEY), [...keysBefore].filter(([key]) => key !== INDEX_KEY));
  assert.deepEqual(Object.keys(stored(h, INDEX_KEY).entries).sort(), ['10.1000/state.failed','10.1000/state.login_required','10.1000/state.queued','10.1000/state.review']);
  // an available paper reports done
  h.values.set('library:paper:10.1000/avail', JSON.stringify({version:1,paper:{id:'doi-' + hash('10.1000/avail').slice(0, 16),doi:'10.1000/avail',title:'Already available paper',journal:'',authors:[],date:'',datePrecision:'',dateBasis:'',ingestedAt:'2026-10-07T04:00:00.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:'available'},pdf:{key:'library:pdf:' + 'a'.repeat(64),sha256:'a'.repeat(64),size:100000,source:'github'}}));
  const avail = await (await register(h, dsh, [item(0,{doi:'10.1000/avail'})])).json();
  assert.equal(avail.results[0].result, 'skipped');
  assert.equal(avail.results[0].state, 'done');

  // ---- a registration cut off after the paper write (no job, no register record) is registered again; with a register record or a journal it is left alone
  h = await create();
  const halfPaper = doi => ({version:1,paper:{id:'doi-' + hash(doi).slice(0, 16),doi,title:'Synthetic registration title number 7',journal:'',authors:[],date:'',datePrecision:'',dateBasis:'',ingestedAt:'2026-11-14T01:28:51.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:'manual_needed'}});
  h.values.set('library:paper:10.1000/reg.7', JSON.stringify(halfPaper('10.1000/reg.7')));
  h.values.set('library:paper:10.1000/reg.8', JSON.stringify(halfPaper('10.1000/reg.8')));
  h.values.set('library:machine-register:10.1000/reg.8', JSON.stringify({version:1,doi:'10.1000/reg.8',title:'Synthetic registration title number 8',source:'x',section:'MAIN',registeredBy:'dsh',registeredAt:1,taskId:crypto.randomUUID()}));
  const healed = await (await register(h, dsh, [item(7), item(8)])).json();
  assert.deepEqual(healed.results.map(r => r.result + ':' + (r.state || '')), ['registered:to-download','skipped:no-task']);
  assert.equal(stored(h, 'library:muse-job:10.1000/reg.7').state, 'queued');
  assert(!h.values.has('library:muse-job:10.1000/reg.8'));

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
  // Items of one group are written in parallel, so the ones next to the failing DOI finish too; they are counted and indexed.
  assert.equal(stored(h, quotaKey('dsh', h)), 3);
  assert(h.values.has('library:muse-job:10.1000/reg.2'));
  for (const key of ['library:muse-job:10.1000/reg.3','library:paper:10.1000/reg.3','library:attempt:10.1000/reg.3','library:machine-register:10.1000/reg.3']) assert(!h.values.has(key), key);
  assert.equal([...h.values.keys()].filter(key => key.startsWith('library:muse-queue:')).length, 3);
  assert.deepEqual(Object.keys(stored(h, 'library:machine-index:v1').entries).sort(), ['10.1000/reg.1','10.1000/reg.2','10.1000/reg.4']);
  failing = false;
  const retry = await (await register(h, dsh, [item(1), item(2), item(3), item(4)])).json();
  assert.deepEqual(retry.results.map(r => r.result), ['skipped','skipped','registered','skipped']);
  assert.equal(stored(h, quotaKey('dsh', h)), 4);
  assert.equal(Object.keys(stored(h, 'library:machine-index:v1').entries).length, 4);

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
  for (let n = 0; n < 20; n++) if ((await (await post(h, '/api/machine/requeue', dsh, {reindex:true})).json()).reindex.ready) break; // the record was edited behind the index
  const requeued = await (await post(h, '/api/machine/requeue', dsh, {})).json();
  assert.equal(requeued.requeued.length, 1);
  assert.equal(stored(h, 'library:muse-job:10.1000/reg.1').registration.section, 'CARDIO');
  await crossrefTitles();
  console.log('machine register tests passed');
}
const vmGroup = h => require('vm').runInContext('MACHINE_REGISTER_GROUP', h.context);
// Registration stores the Crossref title when Crossref answers (mocked here; no network), else the submitted RSS title.
async function crossrefTitles() {
  const official = {
    '10.1000/xr.dash':'Synthetic Anticoagulant Timing after Stroke in Atrial Fibrillation\u3000\u2015 SYNTH-ICH Registry 12-Month Outcomes \u2015',
    '10.1000/xr.same':'Synthetic exact title for a Crossref match',
    '10.1000/xr.articles':'ClinicalAge, a framework for synthetic biological age estimation',
    '10.1000/xr.tags':'<i>Synthetic</i> tagged title from Crossref'
  };
  const answer = (h, extra = {}) => create({crossrefResponse:u => {
    const doi = decodeURIComponent(u.pathname.slice('/works/'.length));
    if (extra[doi]) return extra[doi]();
    return official[doi] ? Response.json({message:{DOI:doi,title:[official[doi]]}}) : new Response('missing', {status:404});
  }});
  const crossrefCalls = h => h.calls.filter(call => call.url.hostname === 'api.crossref.org');
  const paperOf = (h, doi) => stored(h, 'library:paper:' + doi).paper;
  const reported = (h, doi) => h.context.libraryPaper(stored(h, 'library:paper:' + doi), doi);

  let h = await answer();
  const rss = {
    // The feed shortened the title: a real difference, so the marker is set.
    dash:'Synthetic Anticoagulant Timing after Stroke: SYNTH-ICH Registry 12-Month Outcomes',
    same:'Synthetic exact title for a Crossref match.',
    articles:'[Articles] ClinicalAge, a framework for synthetic biological age estimation',
    comment:'[Comment] A novel ageing biomarker in synthetic cohorts'
  };
  const body = await (await register(h, dsh, [
    item('x1',{doi:'10.1000/xr.dash',title:rss.dash}), item('x2',{doi:'10.1000/xr.same',title:rss.same}),
    item('x3',{doi:'10.1000/xr.articles',title:rss.articles}), item('x4',{doi:'10.1000/xr.comment',title:rss.comment}),
    item('x5',{doi:'10.1000/xr.tags'})])).json();
  assert.deepEqual(body.results.map(r => r.result), ['registered','registered','registered','registered','registered']);
  // 存的是 Crossref 题名，提交的原题名记在 registeredTitle。
  // libraryText cleans every official title the same way (the ideographic space becomes an ASCII one).
  const dashTitle = h.context.libraryText(official['10.1000/xr.dash']);
  assert(dashTitle.includes('\u2015'));
  let paper = paperOf(h, '10.1000/xr.dash');
  assert.equal(paper.title, dashTitle);
  assert.equal(paper.titleSource, 'crossref');
  assert.equal(paper.titleMismatch, true);
  assert.equal(paper.registeredTitle, rss.dash);
  assert.equal(paper.metadataStatus, 'external_bibliography_checked');
  assert.equal(reported(h, '10.1000/xr.dash').metadataStatus, 'external_bibliography_checked');
  let meta = stored(h, 'library:machine-register:10.1000/xr.dash');
  assert.deepEqual({title:meta.title,paperTitle:meta.paperTitle,titleSource:meta.titleSource,titleMismatch:meta.titleMismatch,registeredTitle:meta.registeredTitle},
    {title:rss.dash,paperTitle:dashTitle,titleSource:'crossref',titleMismatch:true,registeredTitle:rss.dash});
  // Same title after normalization (punctuation, case): no marker.
  paper = paperOf(h, '10.1000/xr.same');
  assert.equal(paper.title, official['10.1000/xr.same']);
  assert.equal(paper.titleSource, 'crossref');
  assert(!('titleMismatch' in paper) && !('registeredTitle' in paper));
  // Lancet-family RSS section label: Crossref has the bare title, so after the label is dropped the two agree.
  paper = paperOf(h, '10.1000/xr.articles');
  assert.equal(paper.title, official['10.1000/xr.articles']);
  assert(!('titleMismatch' in paper));
  assert.equal(stored(h, 'library:machine-register:10.1000/xr.articles').title, 'ClinicalAge, a framework for synthetic biological age estimation');
  // Crossref has no record: fallback to the submitted title, label dropped, and the bibliography is not reported as checked.
  paper = paperOf(h, '10.1000/xr.comment');
  assert.equal(paper.title, 'A novel ageing biomarker in synthetic cohorts');
  assert.equal(paper.titleSource, 'registration');
  assert.equal(paper.metadataStatus, 'registration_title_only');
  assert.equal(reported(h, '10.1000/xr.comment').metadataStatus, 'registration_title_only');
  assert.equal(stored(h, 'library:machine-register:10.1000/xr.comment').paperTitle, 'A novel ageing biomarker in synthetic cohorts');
  // Markup in a Crossref title is stripped the same way as every other official title.
  assert.equal(paperOf(h, '10.1000/xr.tags').title, 'Synthetic tagged title from Crossref');
  // Only the title comes from Crossref: the registration shape (no journal/authors/date) and the orphan rule are unchanged.
  for (const doi of ['10.1000/xr.dash','10.1000/xr.comment']) {
    paper = paperOf(h, doi);
    assert.deepEqual([paper.journal,paper.authors,paper.date], ['',[],'']);
    assert.equal(h.context.machineOrphanPaper(stored(h, 'library:paper:' + doi), reported(h, doi)), true);
  }
  assert.equal(crossrefCalls(h).length, 5);
  // A replay looks nothing up again.
  const before = crossrefCalls(h).length;
  const replay = await (await register(h, dsh, [item('x1',{doi:'10.1000/xr.dash',title:rss.dash})])).json();
  assert.equal(replay.results[0].result, 'skipped');
  assert.equal(crossrefCalls(h).length, before);

  // Records written before this change, without metadataStatus, keep the old report; unknown values are not passed through.
  const legacy = {...stored(h, 'library:paper:10.1000/xr.comment')};
  legacy.paper = {...legacy.paper}; delete legacy.paper.metadataStatus;
  assert.equal(h.context.libraryPaper(legacy, '10.1000/xr.comment').metadataStatus, 'external_bibliography_checked');
  legacy.paper.metadataStatus = 'made_up_status';
  assert.equal(h.context.libraryPaper(legacy, '10.1000/xr.comment').metadataStatus, 'external_bibliography_checked');

  // A label alone is not a title, with or without the trailing space that libraryText trims.
  h = await answer();
  const bare = await (await register(h, dsh, [item('x6',{doi:'10.1000/xr.bare',title:'[Articles] '})])).json();
  assert.deepEqual(bare.results[0], {doi:'10.1000/xr.bare',result:'rejected',error:'bad_title'});
  const bareExact = await (await register(h, dsh, [item('x6b',{doi:'10.1000/xr.bare2',title:'[Articles]'})])).json();
  assert.deepEqual(bareExact.results[0], {doi:'10.1000/xr.bare2',result:'rejected',error:'bad_title'});
  // Only one leading label is dropped.
  h = await answer();
  await register(h, dsh, [item('x7',{doi:'10.1000/xr.twice',title:'[Articles] [Corrigendum] Synthetic twice labelled title'})]);
  assert.equal(paperOf(h, '10.1000/xr.twice').title, '[Corrigendum] Synthetic twice labelled title');

  // Radiotracer brackets are part of the printed title (cardiac PET / myocardial imaging) and must stay.
  // They start with a digit, so they are not a section label; [Articles] / [Comment] still drop, as above.
  h = await answer();
  const tracers = [
    ['10.1000/xr.f18a', '[18F]FDG PET imaging in a synthetic cardiac cohort'],
    ['10.1000/xr.f18b', '[18F]-FDG uptake in synthetic myocardium'],
    ['10.1000/xr.tc99', '[99mTc]sestamibi perfusion in synthetic cohorts'],
    ['10.1000/xr.c11', '[11C]methionine PET in synthetic cardiomyocytes']
  ];
  await register(h, dsh, tracers.map(([doi, title], n) => item('tr' + n, {doi, title})));
  for (const [doi, title] of tracers) {
    assert.equal(paperOf(h, doi).title, title);
    assert.equal(stored(h, 'library:machine-register:' + doi).title, title);
    assert.equal(paperOf(h, doi).titleSource, 'registration');
  }

  // Crossref limiting requests (429): lookups already started in the same group finish; later groups of the batch fall back
  // without a lookup. Every item still registers.
  const group = vmGroup(h);
  h = await answer(null, {'10.1000/xr.limit.0':() => new Response('slow down', {status:429})});
  const limitedItems = Array.from({length:group + 2}, (_, n) => item('L' + n, {doi:'10.1000/xr.limit.' + n}));
  const limited = await (await register(h, dsh, limitedItems)).json();
  assert(limited.results.every(r => r.result === 'registered'));
  const looked = new Set(crossrefCalls(h).map(call => decodeURIComponent(call.url.pathname).slice('/works/'.length)));
  assert(looked.has('10.1000/xr.limit.0'));
  for (const entry of limitedItems.slice(group)) assert(!looked.has(entry.doi), entry.doi + ' was looked up after the 429');
  for (const entry of limitedItems) {
    assert.equal(paperOf(h, entry.doi).titleSource, 'registration');
    assert.equal(paperOf(h, entry.doi).metadataStatus, 'registration_title_only');
  }

  // Crossref returning 403: same as 429 — lookups already started in the same group finish; later groups of the
  // batch fall back without a lookup. Every item still registers, with the submitted title and
  // metadataStatus=registration_title_only.
  h = await answer(null, {'10.1000/xr.forbid.0':() => new Response('forbidden', {status:403})});
  const forbiddenItems = Array.from({length:group + 2}, (_, n) => item('G' + n, {doi:'10.1000/xr.forbid.' + n}));
  const forbidden = await (await register(h, dsh, forbiddenItems)).json();
  assert(forbidden.results.every(r => r.result === 'registered'));
  const forbidLooked = new Set(crossrefCalls(h).map(call => decodeURIComponent(call.url.pathname).slice('/works/'.length)));
  assert(forbidLooked.has('10.1000/xr.forbid.0'));
  for (const entry of forbiddenItems.slice(group)) assert(!forbidLooked.has(entry.doi), entry.doi + ' was looked up after the 403');
  for (const entry of forbiddenItems) {
    assert.equal(paperOf(h, entry.doi).titleSource, 'registration');
    assert.equal(paperOf(h, entry.doi).metadataStatus, 'registration_title_only');
    assert.equal(paperOf(h, entry.doi).title, entry.title);
  }

  // Crossref down or answering with another DOI: fallback, never an error for the batch.
  h = await answer(null, {'10.1000/xr.dash':() => new Response('down', {status:503}), '10.1000/xr.same':() => Response.json({message:{DOI:'10.1000/other',title:['Wrong paper']}})});
  const down = await (await register(h, dsh, [item('x1',{doi:'10.1000/xr.dash',title:rss.dash}), item('x2',{doi:'10.1000/xr.same',title:rss.same})])).json();
  assert.deepEqual(down.results.map(r => r.result), ['registered','registered']);
  assert.equal(paperOf(h, '10.1000/xr.dash').title, rss.dash);
  assert.equal(paperOf(h, '10.1000/xr.same').title, rss.same);
  assert.equal(paperOf(h, '10.1000/xr.same').metadataStatus, 'registration_title_only');

  // "Title: Subtitle" from the feed and "Title\u3000\u2015 Subtitle \u2015" from Crossref are the same title once dashes count as
  // punctuation: the Crossref form is stored and no mismatch is recorded (shape of Circulation Reports cr-26-0249).
  h = await answer();
  await register(h, dsh, [item('x8',{doi:'10.1000/xr.dash',title:'Synthetic Anticoagulant Timing after Stroke in Atrial Fibrillation: SYNTH-ICH Registry 12-Month Outcomes'})]);
  paper = paperOf(h, '10.1000/xr.dash');
  assert.equal(paper.titleSource, 'crossref');
  assert(paper.title.includes('\u2015'));
  assert(!('titleMismatch' in paper) && !('registeredTitle' in paper));
}
// scripts/test_machine_download.cjs awaits run(), so the CI jobs that already run that file also run these checks.
module.exports = {run};
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
