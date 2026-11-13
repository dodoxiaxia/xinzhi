'use strict';
// Synthetic tokens and in-memory KV only. No live services.
const assert = require('assert');
const crypto = require('crypto');
const {setup} = require('./test_fulltext_auth_helpers.cjs');
const {hash} = require('./test_doi_library_worker.cjs');
const base = 'https://learn.dryz.info';
const dsh = 'synthetic_downloader_token_0123456789ab';
const fallback = 'synthetic_fallback_token_0123456789abcd';
const reader = 'synthetic_reader_token_0123456789abcdef';
const tokens = JSON.stringify([{id:'dsh',role:'downloader',token:dsh},{id:'fallback',role:'fallback',token:fallback},{id:'ddx',role:'reader',token:reader}]);
const INDEX = 'library:machine-index:v1';
async function create(options = {}) {
  const h = await setup({clock:{now:Date.now()},...options});
  h.env.MUSE_FULLTEXT_ENABLED = 'true';
  h.env.MACHINE_TOKENS = tokens;
  h.logs = [];
  h.context.console = {log: line => h.logs.push(String(line)), error: console.error};
  return h;
}
function call(h, route, secret, body, method = 'POST') {
  const init = {method,headers:{authorization:'Bearer ' + secret,'content-type':'application/json'}};
  if (method !== 'GET') init.body = JSON.stringify(body || {});
  return h.context.worker.fetch(new Request(base + route, init), h.env);
}
const stored = (h, key) => { const value = h.values.get(key); return value === undefined ? undefined : JSON.parse(value); };
const dois = (prefix, n) => Array.from({length:n}, (_, i) => '10.1000/' + prefix + String(i).padStart(4, '0'));
function paperRecord(doi, status = 'manual_needed') {
  return JSON.stringify({version:1,paper:{id:'doi-' + hash(doi).slice(0, 16),doi,title:'Synthetic index title ' + doi,journal:'Heart',authors:['Jane Doe'],date:'2026-10-07',datePrecision:'day',dateBasis:'Crossref published-online',ingestedAt:'2026-10-07T04:00:00.000Z',metadataStatus:'external_bibliography_checked',fulltextStatus:status}});
}
// Seed after priming, including the candidate index; queueKey always matches createdAt.
function seedJob(h, doi, state, createdAt, extra = {}) {
  const id = crypto.randomUUID();
  const queueKey = 'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id;
  const job = {version:1,id,doi,state,createdAt,updatedAt:createdAt,queueKey,...extra};
  if (['running','uploading','verifying'].includes(state)) Object.assign(job, {leaseId:crypto.randomUUID(),leaseUntil:extra.leaseUntil || createdAt + 3600000,acquisitionStartedAt:createdAt});
  h.values.set('library:muse-job:' + doi, JSON.stringify(job));
  if (state === 'queued') h.values.set(queueKey, JSON.stringify({doi,id}));
  h.values.set('library:paper:' + doi, paperRecord(doi, state === 'available' ? 'available' : 'manual_needed'));
  const doc = stored(h, INDEX);
  if (!['available','abandoned'].includes(state)) {
    const e = state === 'queued' ? createdAt + 6 * 86400000 : ['running','uploading'].includes(state) ? Math.min(job.leaseUntil, job.acquisitionStartedAt + 86400000) : 0;
    doc.entries[doi] = {i:id,s:state,c:createdAt,u:createdAt,e,w:Date.now()};
    h.values.set(INDEX, JSON.stringify(doc));
  }
  return job;
}
// A deployment whose index is already built (the first machine request builds it).
async function primed() {
  const h = await create();
  assert.equal((await (await call(h, '/api/machine/claim', dsh, {state:'to-download'})).json()).task, null);
  return h;
}

const HOUR = 3600000;
const key = doi => 'library:muse-job:' + doi;
const raw = (h, doi) => h.values.get(key(doi));
const jobWrites = (h, doi) => h.writes.filter(w => w.key === key(doi)).length;
async function list(h, state = 'failed-awaiting-fallback') {
  const response = await call(h, '/api/machine/tasks?state=' + state, reader, null, 'GET');
  assert.equal(response.status, 200, 'machine list succeeds');
  return (await response.json()).tasks;
}
async function claim(h, token = fallback, state = 'failed-awaiting-fallback') {
  const response = await call(h, '/api/machine/claim', token, {state});
  assert.equal(response.status, 200, 'machine claim succeeds');
  return (await response.json()).task;
}
async function enabled() { const h = await primed(); h.env.STALE_QUEUED_FALLBACK_ENABLED = 'true'; return h; }
function seed(h, suffix, age, state = 'queued', extra = {}) {
  const doi = '10.1000/stale-' + suffix;
  seedJob(h, doi, state, h.context.Date.now() - age, extra);
  return doi;
}
async function run() {
  for (const value of [undefined, 'false', '1']) {
    const h = await primed();
    if (value !== undefined) h.env.STALE_QUEUED_FALLBACK_ENABLED = value;
    const doi = seed(h, 'off', 7 * HOUR), before = raw(h, doi);
    const reads = h.reads.length, writes = h.writes.length;
    assert.equal(await claim(h), null, 'disabled switch ' + value + ': fallback finds no task');
    assert.equal(h.reads.length - reads, 2, 'disabled switch adds no KV read: only index and stats');
    assert(h.writes.slice(writes).every(w => w.key.startsWith('library:machine-rate:stats:')), 'disabled claim writes only stats');
    const listReads = h.reads.length;
    assert.deepEqual((await list(h, 'to-download')).map(t => t.doi), [doi], 'disabled switch leaves stale task in to-download');
    assert.equal(h.reads.length - listReads, 2, 'disabled list adds no KV read: only index and task');
    assert.equal(raw(h, doi), before, 'disabled switch leaves job byte-identical');
    assert.equal(jobWrites(h, doi), 0, 'disabled switch never writes the job');
  }

  let h = await enabled();
  const over = seed(h, 'over', 6 * HOUR + 1000), under = seed(h, 'under', 6 * HOUR - 60000);
  const underBefore = raw(h, under), start = h.context.Date.now();
  const tasks = await list(h);
  const converted = stored(h, key(over)), end = h.context.Date.now();
  assert.equal(converted.state, 'failed', '6h+1s crosses default threshold');
  assert.equal(converted.reason, 'queue_unclaimed', 'conversion records queue_unclaimed');
  assert.equal(converted.autoFallback.reason, '排队超过 6 小时无人领取（attempts=0），自动转兜底', 'conversion stores exact Chinese reason');
  assert.equal(converted.autoFallback.hours, 6, 'default threshold records six hours');
  const at = Date.parse(converted.autoFallback.at);
  assert.equal(new Date(at).toISOString(), converted.autoFallback.at, 'autoFallback.at is canonical ISO');
  assert(at >= start && at <= end, 'autoFallback.at is within sweep window');
  assert.equal(raw(h, under), underBefore, '6h-60s remains byte-identical and queued');
  assert.equal(stored(h, key(under)).state, 'queued', 'just-under threshold is still queued');
  assert(!h.values.has(converted.queueKey), 'conversion deletes queue pointer');
  assert.equal(stored(h, INDEX).entries[over].s, 'failed', 'conversion updates machine index');
  const entry = tasks.find(t => t.doi === over);
  assert(entry, 'fallback list contains converted task');
  assert.equal(entry.state, 'failed-awaiting-fallback', 'list exposes fallback public state');
  assert.equal(entry.reason, 'queue_unclaimed', 'list exposes queue_unclaimed reason');
  assert.deepEqual(entry.autoFallback, converted.autoFallback, 'list exposes autoFallback metadata');
  const first = raw(h, over), count = jobWrites(h, over);
  await list(h); await list(h, 'to-download');
  assert.equal(raw(h, over), first, 'repeated list sweeps preserve record and autoFallback.at');
  assert.equal(jobWrites(h, over), count, 'repeated sweeps do not rewrite converted key');

  // Every moved task reads its paper once; disabled-switch read counts above stay unchanged.
  for (const [doi, mode, oa] of [
    ['10.1000/hints-heart', 'normal', 'unknown'],
    ['10.1371/journal.pone.synthetic', 'normal', 'yes'],
    ['10.1097/md.synthetic', 'normal', 'yes'],
    ['10.1016/j.eclinm.synthetic', 'normal', 'yes'],
    ['10.1001/jamanetworkopen.synthetic', 'normal', 'yes'],
    ['10.1000/hints-empty', 'empty', 'unknown'],
    ['10.1000/hints-missing', 'missing', 'unknown'],
    ['10.1000/hints-read-error', 'error', 'unknown']
  ]) {
    h = await enabled();
    seedJob(h, doi, 'queued', h.context.Date.now() - 7 * HOUR);
    const paperKey = 'library:paper:' + doi;
    if (mode === 'empty') {
      const record = stored(h, paperKey); record.paper.journal = '';
      h.values.set(paperKey, JSON.stringify(record));
    }
    if (mode === 'missing') h.values.delete(paperKey);
    const originalGet = h.env.QL_KV.get;
    let paperReads = 0;
    h.env.QL_KV.get = async function(k, ...args) {
      if (k === paperKey) {
        paperReads++;
        if (mode === 'error') throw new Error('synthetic storage failure');
      }
      return originalGet.call(this, k, ...args);
    };
    const entries = await list(h);
    h.env.QL_KV.get = originalGet;
    assert.equal(paperReads, 1, 'one paper read per moved task');
    const job = stored(h, key(doi));
    assert.equal(job.state, 'failed', 'missing or unreadable paper never prevents conversion');
    const expected = {journal:mode === 'normal' ? 'Heart' : '',openAccess:oa,openAccessBasis:oa === 'yes' ? 'doi_prefix' : ''};
    // Claim requires a valid paper; restoring it must not change the saved transition hints.
    if (mode === 'missing') h.values.set(paperKey, paperRecord(doi));
    const claimed = await claim(h);
    assert(claimed, 'converted task remains claimable');
    for (const metadata of [job.autoFallback, entries.find(t => t.doi === doi).autoFallback, claimed.autoFallback]) {
      assert(metadata, 'stored record, list and claim carry metadata');
      for (const [field, value] of Object.entries(expected)) assert.equal(metadata[field], value, field + ' for ' + doi);
      assert(!Object.values(metadata).some(value => value === 'no' || value === false), 'hints never assert closed access');
    }
  }

  // Legacy records and malformed hints are normalised by the public sanitiser.
  for (const hints of [{}, {journal:42,openAccess:false,openAccessBasis:'invalid'}, {journal:'a'.repeat(250),openAccess:'no'}]) {
    h = await enabled();
    const doi = seed(h, 'legacy', 7 * HOUR, 'failed', {
      reason:'queue_unclaimed',autoFallback:{at:new Date().toISOString(),hours:6,reason:'synthetic',...hints}
    });
    for (const item of [(await list(h)).find(t => t.doi === doi), await claim(h)]) {
      assert.equal(item.autoFallback.journal, typeof hints.journal === 'string' ? hints.journal.slice(0,200) : '');
      assert.equal(item.autoFallback.openAccess, 'unknown');
      assert.equal(item.autoFallback.openAccessBasis, '');
    }
  }

  h = await enabled(); h.env.STALE_QUEUED_FALLBACK_HOURS = '12';
  const seven = seed(h, 'seven', 7 * HOUR), thirteen = seed(h, 'thirteen', 13 * HOUR), sevenBefore = raw(h, seven);
  await list(h, 'to-download');
  assert.equal(raw(h, seven), sevenBefore, 'custom 12h threshold leaves 7h task untouched');
  assert.equal(stored(h, key(thirteen)).autoFallback.hours, 12, 'custom 12h threshold converts 13h task');
  for (const value of ['0','abc','200','']) {
    h = await enabled(); h.env.STALE_QUEUED_FALLBACK_HOURS = value;
    const doi = seed(h, 'invalid', 6 * HOUR + 1000);
    await list(h);
    assert.equal(stored(h, key(doi)).autoFallback.hours, 6, 'invalid threshold ' + JSON.stringify(value) + ' defaults to 6h');
  }

  h = await enabled();
  const untouched = [];
  for (const [i, extra] of [{softFailCount:1},{returnCount:1},{claimant:'dsh'},{previousReason:'not_oa'},{attempts:2},{acquisitionStartedAt:h.context.Date.now()-HOUR}].entries()) {
    const doi = seed(h, 'attempt' + i, 8 * HOUR, 'queued', extra);
    untouched.push([doi, raw(h, doi), 'claim history ' + JSON.stringify(extra)]);
  }
  for (const state of ['failed','login_required','review','running','uploading','verifying','available','abandoned']) {
    const sha256 = 'a'.repeat(64);
    const doi = seed(h, state, 8 * HOUR, state, {leaseUntil:h.context.Date.now()+HOUR,sha256,bytes:60000,driveFileId:'syntheticDriveFileId12345',candidateKey:'library:muse-candidate:' + sha256});
    untouched.push([doi, raw(h, doi), 'other status ' + state]);
  }
  await list(h); await list(h, 'to-download');
  for (const [doi, before, label] of untouched) assert.equal(raw(h, doi), before, label + ' remains byte-identical after sweeps');

  h = await enabled();
  const claimedDoi = seed(h, 'claim', 7 * HOUR);
  const task = await claim(h);
  assert(task, 'fallback claim immediately sees newly converted task');
  assert.equal(task.doi, claimedDoi, 'fallback claims stale DOI');
  assert.equal(task.state, 'downloading', 'fallback claim exposes downloading state');
  assert.equal(task.claimant, 'fallback', 'fallback token owns claim');
  const running = stored(h, key(claimedDoi));
  assert.equal(running.state, 'running', 'claimed record is running');
  assert.equal(running.previousReason, 'queue_unclaimed', 'claim retains hard failure history');
  const initialNow = h.context.Date.now;
  try {
    h.context.Date.now = () => running.leaseUntil + 1000;
    const expired = (await list(h)).find(t => t.doi === claimedDoi);
    assert(expired, 'expired fallback lease stays in failed-awaiting-fallback');
    assert.equal(expired.reason, 'queue_unclaimed', 'expired fallback lease retains queue_unclaimed');
    assert(!(await list(h, 'to-download')).some(t => t.doi === claimedDoi), 'expired fallback lease never returns to to-download');
  } finally { h.context.Date.now = initialNow; }

  h = await enabled();
  const downloadDoi = seed(h, 'downloader', 7 * HOUR);
  assert.equal((await claim(h, dsh, 'to-download')).doi, downloadDoi, 'downloader claims stale queued task normally');
  const downloaded = stored(h, key(downloadDoi));
  assert.equal(downloaded.state, 'running', 'downloader does not convert stale task');
  assert.equal(downloaded.claimant, 'dsh', 'downloader claim establishes attempt history');
  assert(downloaded.acquisitionStartedAt > 0, 'downloader records acquisition start (attempts greater than zero)');
  assert.equal(downloaded.autoFallback, undefined, 'downloader claim never sweeps');

  h = await enabled();
  const paused = seed(h, 'paused', 7 * HOUR);
  h.values.set('library:attempt:' + paused, JSON.stringify({paused:true}));
  const pausedBefore = raw(h, paused);
  assert.equal(await claim(h), null, 'paused DOI is not claimable');
  assert.equal(raw(h, paused), pausedBefore, 'paused DOI is not converted: record byte-identical');
  assert.equal(jobWrites(h, paused), 0, 'paused DOI never written');
  const fs = require('fs'), vm = require('vm');
  const tierContext = {globalThis:{}};
  vm.runInNewContext(fs.readFileSync('src/app/journal-tiers.js','utf8'), tierContext);
  const tierApi = tierContext.globalThis.XINZHI_JOURNAL_TIERS;
  const match = fs.readFileSync('edge/_worker.js','utf8').match(/const MACHINE_JOURNAL_TIERS = (\{[\s\S]*?\n\});/);
  assert(match, 'embedded tier literal exists');
  const embedded = new Function('return (' + match[1] + ')')();
  for (const tier of ['flagship','cardioMain','cardioSub']) {
    const names = values => [...new Set(Array.from(values, tierApi.normalizeJournalName))].sort();
    assert.deepEqual(names(embedded[tier]), names(tierApi.namesInTier(tier)), 'tier drift: ' + tier);
  }
  async function backlog(on = true, vars = {}) {
    const clock = {now:Date.parse('2026-11-14T04:00:00Z')};
    const b = await create({clock});
    await claim(b, dsh, 'to-download');
    if (on) b.env.STALE_QUEUED_FALLBACK_ENABLED = 'true';
    Object.assign(b.env, vars);
    const rows = [];
    const journals = ['plain', ' Heart ', 'Circulation Research', '  THE   LANCET  '];
    for (let i=0;i<26;i++) {
      const oa = i % 3 === 0, rank = i % 4;
      const doi = (oa ? '10.1371/' : '10.1000/') + 'budget-' + String(i).padStart(2,'0');
      const createdAt = clock.now - 8*HOUR + Math.floor(i/2)*1000;
      seedJob(b, doi, 'queued', createdAt);
      const record = stored(b, 'library:paper:' + doi); record.paper.journal = journals[rank];
      b.values.set('library:paper:' + doi, JSON.stringify(record));
      rows.push({doi,oa,rank,createdAt});
    }
    rows.sort((a,b) => Number(b.oa)-Number(a.oa) || b.rank-a.rank || a.createdAt-b.createdAt || a.doi.localeCompare(b.doi));
    return {b,clock,expected:rows.map(r=>r.doi)};
  }
  const windowKey = (clock, minutes=10) => 'library:stale-fallback-window:' + Math.floor(clock.now/(minutes*60000));
  {
    const {b,clock,expected} = await backlog();
    const ordered = [];
    for (let window=0;window<6;window++) {
      const before = b.writes.length, reads = b.reads.length;
      await list(b, 'to-download');
      const moved = b.writes.slice(before).filter(w=>w.key.startsWith('library:muse-job:') && JSON.parse(w.value).reason === 'queue_unclaimed');
      ordered.push(...moved.map(w=>JSON.parse(w.value).doi));
      assert.equal(moved.length, Math.min(5,26-window*5));
      const paperReads = b.reads.slice(reads).filter(r=>r.key.startsWith('library:paper:'));
      assert.equal(new Set(paperReads.map(r=>r.key)).size,paperReads.length,'each candidate paper read once per sweep');
      assert.equal(stored(b,windowKey(clock)),moved.length);
      assert.equal(b.writes.find(w=>w.key===windowKey(clock)).opts.expirationTtl,1200);
      // Repeated list requests must preserve the exhausted budget.
      await list(b);
      // Public lists hydrate response records; isolate sweep reads for this assertion.
      const sweepReads = b.reads.length;
      await vm.runInContext('machineStaleQueuedSweep', b.context)(b.env, stored(b,INDEX), []);
      assert(!b.reads.slice(sweepReads).some(x=>x.key.startsWith('library:muse-job:')),'exhausted window reads no task records');
      assert.equal(stored(b,windowKey(clock)),moved.length);
      if (window===0) { await claim(b); await list(b); assert.equal(stored(b,windowKey(clock)),5); }
      clock.now += 10*60000;
    }
    assert.deepEqual(ordered,expected,'exact priority order across windows');
    assert.equal(new Set(ordered).size,26,'no duplicate transition');
    const reads=b.reads.length;
    await vm.runInContext('machineStaleQueuedSweep',b.context)(b.env,stored(b,INDEX),[]);
    assert.equal(b.reads.length,reads,'no candidates costs no counter read');
  }
  for (const value of [undefined,'false']) {
    const {b} = await backlog(false);
    if (value) b.env.STALE_QUEUED_FALLBACK_ENABLED=value;
    const before=new Map(b.values), reads=b.reads.length, writes=b.writes.length;
    assert.equal(await vm.runInContext('machineStaleQueuedSweep',b.context)(b.env,stored(b,INDEX),[]),0);
    assert.deepEqual(b.values,before,'disabled backlog is byte-identical');
    assert.equal(b.reads.length,reads); assert.equal(b.writes.length,writes);
  }
  {
    const {b,clock} = await backlog();
    const put = b.env.QL_KV.put;
    b.env.QL_KV.put = async function(k,...args) {
      if (k===windowKey(clock)) throw new Error('synthetic counter failure');
      return put.call(this,k,...args);
    };
    await list(b);
    assert.equal([...b.values.entries()].filter(([k,v])=>k.startsWith('library:muse-job:') && JSON.parse(v).reason==='queue_unclaimed').length,5,'counter write failure does not break conversion');
  }
  for (const value of ['0','26','abc','25']) {
    const {b,clock} = await backlog(true,{STALE_QUEUED_FALLBACK_MAX_PER_WINDOW:value});
    await list(b);
    assert.equal(stored(b,windowKey(clock)),value==='25'?25:5,'max config '+value);
  }
  for (const value of ['4','61','x','5','60']) {
    const {b,clock} = await backlog(true,{STALE_QUEUED_FALLBACK_WINDOW_MINUTES:value});
    await list(b);
    const minutes=['5','60'].includes(value)?Number(value):10;
    assert.equal(stored(b,windowKey(clock,minutes)),5,'window config '+value);
    assert.equal(b.writes.find(w=>w.key===windowKey(clock,minutes)).opts.expirationTtl,minutes*120);
  }

  // ---- N3: ineligible old tasks are excluded before the candidate cut, and cost a bounded number of reads ----
  const sweep = async (b, changes = []) => {
    // Like a real caller: the sweep mutates the open index document, which is then saved.
    const doc = stored(b, INDEX);
    const moved = await vm.runInContext('machineStaleQueuedSweep', b.context)(b.env, doc, changes);
    b.values.set(INDEX, JSON.stringify(doc));
    return moved;
  };
  const jobReads = (b, from) => b.reads.slice(from).filter(r => r.key.startsWith('library:muse-job:')).length;
  const kinds = (b, from) => b.reads.slice(from).reduce((o, r) => { const k = r.key.split(':').slice(0, 2).join(':'); o[k] = (o[k] || 0) + 1; return o; }, {});
  {
    // 70 claimed-before tasks are older than the one eligible task: the eligible one must still be converted.
    h = await enabled();
    const ineligible = Array.from({length:70}, (_, i) => seed(h, 'claimed' + String(i).padStart(2, '0'), 20 * HOUR - i * 1000, 'queued', {softFailCount:1}));
    const good = seed(h, 'good-behind', 7 * HOUR);
    const before = h.reads.length;
    assert.equal(await sweep(h), 0, 'first sweep: scan budget (60) is spent on ineligible tasks, nothing reached yet');
    const first = kinds(h, before);
    assert(first['library:muse-job'] <= 60, 'one request reads at most 60 task records: ' + JSON.stringify(first));
    assert.equal(stored(h, key(good)).state, 'queued');
    // Next request: the 60 known-ineligible tasks are skipped from memory, the scan moves on and reaches the eligible one.
    const second = h.reads.length;
    assert.equal(await sweep(h), 1, 'second sweep skips the 60 known-ineligible tasks from memory, reads the other 10, and converts the eligible one behind them');
    assert.equal(stored(h, key(good)).reason, 'queue_unclaimed');
    for (const doi of ineligible) assert.equal(jobWrites(h, doi), 0, 'ineligible task never written');
    // A steady state with only ineligible tasks left costs no task read at all.
    const steady = h.reads.length;
    assert.equal(await sweep(h), 0);
    assert.equal(h.reads.length, steady, 'all candidates known ineligible: zero KV reads ');
    assert(jobReads(h, second) <= 60 + 5, 'later requests stay bounded');
  }
  {
    // The same through the public list: 70 claimed-before tasks do not starve an eligible one for more than a few requests,
    // and every request stays under the read cap.
    h = await enabled();
    for (let i = 0; i < 70; i++) seed(h, 'claimedl' + String(i).padStart(2, '0'), 20 * HOUR - i * 1000, 'queued', {softFailCount:1});
    const good = seed(h, 'good-list', 7 * HOUR);
    let converted = false;
    for (let n = 0; n < 4 && !converted; n++) {
      const before = h.reads.length;
      await list(h, 'failed-awaiting-fallback');
      const sweepReads = h.reads.slice(before).filter(r => /^library:(muse-job|attempt|paper|stale-fallback-window)/.test(r.key)).length;
      assert(sweepReads <= 60 + 1 + 30 + 30 + 80, 'per-request reads stay bounded (' + sweepReads + ')');
      converted = stored(h, key(good)).state === 'failed';
    }
    assert(converted, 'eligible task converted within a few requests');
  }
  {
    // 40 eligible tasks, default cap of 5: exact read count of the sweep itself.
    // 1 counter + 30 task records + 30 pause marks + 30 papers + 5 task rereads + 5 pause rereads.
    h = await enabled();
    for (let i = 0; i < 40; i++) seed(h, 'dflt' + String(i).padStart(2, '0'), 9 * HOUR - i * 1000);
    const before = h.reads.length, writes = h.writes.length;
    assert.equal(await sweep(h), 5);
    const k = kinds(h, before), total = h.reads.length - before;
    assert.equal(k['library:stale-fallback-window'], 1, 'one counter read');
    assert.equal(k['library:paper'], 30, 'paper reads only for the 30-task pool');
    assert.equal(k['library:muse-job'], 35, '30 scan task records plus 5 convert rereads');
    assert.equal(k['library:attempt'], 35, '30 scan pause marks plus 5 convert rereads');
    assert.equal(total, 101, '40 eligible, default cap: exact sweep reads are 101: ' + JSON.stringify(k));
    console.log('measured default sweep: reads ' + total + ' ' + JSON.stringify(k) + ' writes ' + (h.writes.length - writes));
  }
  {
    // Worst case measured: 1 counter + 60 scan reads + 30 paper reads + moved rereads (task and pause).
    h = await enabled();
    h.env.STALE_QUEUED_FALLBACK_MAX_PER_WINDOW = '25';
    for (let i = 0; i < 40; i++) seed(h, 'wc' + String(i).padStart(2, '0'), 9 * HOUR - i * 1000);
    const before = h.reads.length, writes = h.writes.length;
    assert.equal(await sweep(h), 25);
    const k = kinds(h, before), total = h.reads.length - before;
    assert.equal(k['library:stale-fallback-window'], 1, 'one counter read');
    assert.equal(k['library:paper'], 30, 'paper reads only for the 30-task pool');
    assert.equal(k['library:muse-job'], 55, '30 scan task records plus 25 convert rereads');
    assert.equal(k['library:attempt'], 55, '30 scan pause marks plus 25 convert rereads');
    assert.equal(total, 141, 'worst case exact sweep reads are 141: ' + JSON.stringify(k));
    console.log('measured: reads ' + total + ' ' + JSON.stringify(k) + ' writes ' + (h.writes.length - writes));
  }
  {
    // Default settings through the public list: 5 moved. Measure the whole request (sweep plus list hydration).
    h = await enabled();
    for (let i = 0; i < 40; i++) seed(h, 'dfltl' + String(i).padStart(2, '0'), 9 * HOUR - i * 1000);
    const before = h.reads.length, writes = h.writes.length;
    await list(h, 'to-download');
    assert.equal([...h.values.entries()].filter(([k,v]) => k.startsWith('library:muse-job:') && JSON.parse(v).reason === 'queue_unclaimed').length, 5, 'default list request converts 5');
    const sweepWrites = h.writes.slice(writes).filter(w => /^library:(muse-job|muse-queue|stale-fallback-window)/.test(w.key)).length;
    console.log('measured default list request: writes (jobs, queue pointers, counter) ' + sweepWrites + ', reads ' + (h.reads.length - before));
    void before;
  }
  {
    // A claimed task whose record changes (updatedAt) is looked at again.
    h = await enabled();
    const doi = seed(h, 'changes', 8 * HOUR, 'queued', {softFailCount:1});
    assert.equal(await sweep(h), 0);
    const reads = h.reads.length;
    assert.equal(await sweep(h), 0);
    assert.equal(h.reads.length, reads, 'known ineligible task is skipped without a read');
    const job = stored(h, key(doi)); delete job.softFailCount; job.updatedAt += 1;
    h.values.set(key(doi), JSON.stringify(job));
    const doc = stored(h, INDEX); doc.entries[doi].u = job.updatedAt; h.values.set(INDEX, JSON.stringify(doc));
    assert.equal(await sweep(h), 1, 'changed record is re-read and now eligible');
  }

  // ---- N7: paused DOIs are not candidates; lifting the pause is picked up after the short cache expires ----
  {
    // A task paused after the scan, before conversion, must not be moved; later unpaused tasks still convert.
    h = await enabled();
    const first = seed(h, 'pause-mid-a', 8 * HOUR), second = seed(h, 'pause-mid-b', 7 * HOUR);
    const firstBefore = raw(h, first);
    const get = h.env.QL_KV.get;
    let firstJobReads = 0;
    h.env.QL_KV.get = async function(k, ...args) {
      if (k === key(first)) {
        firstJobReads++;
        if (firstJobReads === 2) h.values.set('library:attempt:' + first, JSON.stringify({paused:true}));
      }
      return get.call(this, k, ...args);
    };
    assert.equal(await sweep(h), 1, 'only the task still unpaused at convert time moves');
    h.env.QL_KV.get = get;
    assert.equal(raw(h, first), firstBefore, 'paused between scan and convert: record byte-identical');
    assert.equal(jobWrites(h, first), 0, 'paused between scan and convert: never written');
    assert.equal(stored(h, key(first)).state, 'queued', 'paused between scan and convert: stays queued');
    assert.equal(stored(h, key(second)).reason, 'queue_unclaimed', 'later unpaused task still converts');
  }
  {
    h = await enabled();
    const pausedDoi = seed(h, 'pause-a', 8 * HOUR), other = seed(h, 'pause-b', 7 * HOUR);
    h.values.set('library:attempt:' + pausedDoi, JSON.stringify({paused:true}));
    const pausedBefore = raw(h, pausedDoi);
    assert.equal(await sweep(h), 1, 'only the unpaused task moves');
    assert.equal(stored(h, key(other)).state, 'failed');
    assert.equal(raw(h, pausedDoi), pausedBefore, 'paused task untouched');
    assert.equal(jobWrites(h, pausedDoi), 0);
    assert(!stored(h, INDEX).entries[pausedDoi] || stored(h, INDEX).entries[pausedDoi].s === 'queued', 'paused task stays queued in the index');
    assert.equal((await list(h)).some(t => t.doi === pausedDoi), false, 'paused task is not listed as failed-awaiting-fallback');
    h.values.set('library:attempt:' + pausedDoi, JSON.stringify({paused:false}));
    const now = h.context.Date.now;
    h.context.Date.now = () => now() + 11 * 60000;
    assert.equal(await sweep(h), 1, 'pause lifted: converted after the short negative cache');
    h.context.Date.now = now;
    // A pause mark that cannot be read skips the task for this request only and logs a fixed line.
    h = await enabled();
    const unreadable = seed(h, 'pause-err', 8 * HOUR);
    const logs = []; h.context.console = {log: line => logs.push(String(line)), error: () => {}};
    const get = h.env.QL_KV.get;
    h.env.QL_KV.get = async function(k, ...args) { if (k === 'library:attempt:' + unreadable) throw new Error('synthetic'); return get.call(this, k, ...args); };
    assert.equal(await sweep(h), 0);
    assert.equal(stored(h, key(unreadable)).state, 'queued', 'unreadable pause mark never converts');
    assert.deepEqual(logs, ['stale queued fallback: pause mark unreadable, task skipped this request']);
    h.env.QL_KV.get = get;
    assert.equal(await sweep(h), 1, 'readable again: converted on the next request');
  }

  // ---- N2 / N4: fixed log lines, no DOI, no token ----
  {
    h = await enabled();
    const logs = []; h.context.console = {log: line => logs.push(String(line)), error: line => logs.push(String(line))};
    const doi = seed(h, 'log-ok', 8 * HOUR);
    assert.equal(await sweep(h), 1);
    const win = Math.floor(h.context.Date.now() / 600000);
    assert.deepEqual(logs, ['stale queued fallback: moved 1 task(s) to the fallback queue in window ' + win]);
    // nothing to do: no log line
    logs.length = 0;
    await sweep(h);
    assert.deepEqual(logs, [], 'no conversion, no log');
    // counter write failure
    h = await enabled();
    const l2 = []; h.context.console = {log: line => l2.push(String(line)), error: () => {}};
    seed(h, 'log-counter', 8 * HOUR);
    const put = h.env.QL_KV.put;
    h.env.QL_KV.put = async function(k, ...args) { if (k.startsWith('library:stale-fallback-window:')) throw new Error('synthetic'); return put.call(this, k, ...args); };
    assert.equal(await sweep(h), 1);
    assert.deepEqual(l2, ['stale queued fallback: window counter write failed, budget not recorded', 'stale queued fallback: moved 1 task(s) to the fallback queue in window ' + win]);
    // paper unreadable
    h = await enabled();
    const l3 = []; h.context.console = {log: line => l3.push(String(line)), error: () => {}};
    const pdoi = seed(h, 'log-paper', 8 * HOUR);
    const pget = h.env.QL_KV.get;
    h.env.QL_KV.get = async function(k, ...args) { if (k === 'library:paper:' + pdoi) throw new Error('synthetic'); return pget.call(this, k, ...args); };
    assert.equal(await sweep(h), 1);
    assert.equal(l3[0], 'stale queued fallback: paper record unreadable, journal left empty');
    // whole sweep fails
    h = await enabled();
    const l4 = []; h.context.console = {log: line => l4.push(String(line)), error: () => {}};
    seed(h, 'log-outer', 8 * HOUR);
    const oget = h.env.QL_KV.get;
    h.env.QL_KV.get = async function(k, ...args) { if (k.startsWith('library:stale-fallback-window:')) throw new Error('synthetic'); return oget.call(this, k, ...args); };
    assert.equal(await sweep(h), 0, 'a failing sweep returns 0 and never throws');
    assert.deepEqual(l4, ['stale queued fallback: sweep failed, next request retries']);
    for (const line of [...logs, ...l2, ...l3, ...l4]) assert(!/10\.1000|synthetic|token|Bearer/i.test(line), 'log line carries no DOI or secret: ' + line);
    void doi;
  }

  // ---- N5: the open-access DOI prefix table ----
  {
    const expectedOa = [
      ['10.1371/journal.pone.0000001', 'PLOS'], ['10.3389/fmed.2026.0001', 'Frontiers'], ['10.1186/s12872-026-0001', 'BMC'], ['10.3390/jcm1234567', 'MDPI'],
      ['10.1097/md.0000000000012345', 'Medicine'], ['10.1016/j.eclinm.2026.103000', 'eClinicalMedicine'], ['10.1002/ccr3.9999', 'Clinical Case Reports'],
      ['10.1001/jamanetworkopen.2026.1', 'JAMA Network Open'], ['10.1016/j.jacadv.2026.100001', 'JACC Advances'], ['10.1016/j.jaccas.2026.100001', 'JACC Case Reports'],
      ['10.1253/circrep.cr-26-0001', 'Circulation Reports']
    ];
    const table = vm.runInContext('MACHINE_OA_DOI_HINTS', h.context);
    assert.deepEqual(table.map(r => r[1]), expectedOa.map(r => r[1]), 'prefix table lists exactly these eleven sources, in this order');
    const notOa = ['10.1001/jama.2026.19482', '10.1016/j.jacc.2026.01.001', '10.1038/s41586-026-00001-1', '10.1161/circulationaha.126.000001',
      '10.1097/00000000-0000-0000', '10.1097/mdx.1', '10.1016/j.eclinmx.1', '10.1016/j.jacadvx.1', '10.1002/ccr.1', '10.13719/x1', '10.33901/x1', '10.11861/x1']
    ;
    h = await enabled();
    const all = [...expectedOa.map(r => r[0]), ...notOa];
    for (const doi of all) seedJob(h, doi, 'queued', h.context.Date.now() - 8 * HOUR);
    h.env.STALE_QUEUED_FALLBACK_MAX_PER_WINDOW = '25';
    h.env.STALE_QUEUED_FALLBACK_WINDOW_MINUTES = '60';
    // 23 tasks, one request converts 23 if the cap allows; the cap is 25.
    assert.equal(await sweep(h), all.length);
    for (const [doi] of expectedOa) {
      const a = stored(h, key(doi)).autoFallback;
      assert.equal(a.openAccess, 'yes', doi + ' is a listed open-access prefix');
      assert.equal(a.openAccessBasis, 'doi_prefix');
    }
    for (const doi of notOa) {
      const a = stored(h, key(doi)).autoFallback;
      assert.equal(a.openAccess, 'unknown', doi + ' is not in the table (hybrid journal or near miss)');
      assert.equal(a.openAccessBasis, '');
    }
  }

  console.log('stale queued fallback tests passed');
}
module.exports = {run};
if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
