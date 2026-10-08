// Offline only: every network/provider call is intercepted by fixture fetch.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), crypto = require('crypto');
const workerPath = require('path').join(__dirname, '../edge/_worker.js');
const marker = 'const PUBLIC_ABSTRACT_SOURCES = /* public-abstract-sources */ null;';
const abstract = 'This prospective study included 598 participants. The primary outcome was hospitalization. The randomized study compared treatment with usual care. No benefit was observed in the prespecified population. The results require confirmation in additional studies. Follow-up and limitations were described in the public abstract. ';
const row = (pmid = '111') => {
  const title = 'Published fixture ' + pmid;
  return { paperID: 'pub-' + pmid, pmid, doi: '10.1234/paper-' + pmid, title, journal: 'Fixture Journal', abstract,
    sourceHash: crypto.createHash('sha256').update(title + '\n' + abstract).digest('hex'), abstractSource: 'PubMed', abstractSourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/', date: '2026-10-01' };
};
function harness({ snapshot, fetcher, timers } = {}) {
  const stores = new Map(), stats = { metadata: 0, model: 0, writes: 0, deletes: 0 };
  const kv = { get: async (key, type) => { const value = stores.get(key); return value && type === 'json' ? JSON.parse(value) : value || null; },
    put: async (key, value) => { stats.writes++; stores.set(key, value); }, delete: async key => { stats.deletes++; stores.delete(key); } };
  const ctx = vm.createContext({ URL, Response, Request, TextEncoder, AbortController, ReadableStream, crypto: crypto.webcrypto,
    setTimeout: timers || setTimeout, clearTimeout, console: { warn() {} } });
  ctx.fetch = async (url, opts = {}) => {
    const model = String(url) === 'https://model.fixture/api'; stats[model ? 'model' : 'metadata']++;
    if (fetcher) { const response = await fetcher(String(url), opts, stats); if (response !== undefined) return response; }
    if (model) {
      const payload = JSON.parse(opts.body), arts = JSON.parse(payload.messages[1].content);
      let output;
      if (arts[0].evidence) output = { papers: arts.map(a => ({ id: a.id, ...Object.fromEntries(['question','population','design','comparator','endpoints','results'].map(k => [k, { text: '摘要未提供', quote_id: '' }])) })) };
      else output = { theme: '研究讨论', papers: arts.map(a => ({ id: a.id, point: '核对研究原文' })), compare: '比较研究设计', questions: ['人群如何界定？','结局如何定义？','有哪些局限？'], caveat: '仅使用公开摘要' };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
    }
    assert(String(url).startsWith('https://www.ebi.ac.uk/') || String(url).startsWith('https://eutils.ncbi.nlm.nih.gov/') || String(url).startsWith('https://api.openalex.org/') || String(url).startsWith('https://api.crossref.org/') || String(url).startsWith('https://doi.org/'), 'Unexpected network fixture');
    if (String(url).includes('europepmc')) {
      const query = new URL(url).searchParams.get('query'), pmid = /EXT_ID:(\d+)/.exec(query)?.[1];
      return Response.json({ resultList: { result: pmid ? [{ pmid, title: 'Fixture ' + pmid, abstractText: abstract, journalTitle: 'Fixture Journal' }] : [] } });
    }
    return new Response('', { status: 404 });
  };
  let source = fs.readFileSync(workerPath, 'utf8');
  if (snapshot) source = source.replace(marker, 'const PUBLIC_ABSTRACT_SOURCES = ' + JSON.stringify(snapshot) + ';');
  vm.runInContext(source.replace('export default {', 'globalThis.worker = {'), ctx);
  const env = { QL_KV: kv, LLM_ENDPOINT: 'https://model.fixture/api', LLM_API_KEY: 'fixture-only', LLM_MODEL: 'glm-5.3-fixture' };
  const post = async (body, signal) => {
    const response = await ctx.worker.fetch(new Request('https://site.fixture/api/ai', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': 'fixture-reader' }, body: JSON.stringify(body), signal }), env);
    return { status: response.status, body: await response.json() };
  };
  const get = async (task, keys, mode = 'huddle') => {
    const params = new URLSearchParams({ task });
    if (keys.length === 1) params.set('k', keys[0]); else { params.set('keys', JSON.stringify(keys)); if (task === 'brief') params.set('mode', mode); }
    const response = await ctx.worker.fetch(new Request('https://site.fixture/api/ai?' + params), env);
    return { status: response.status, body: await response.json() };
  };
  return { ctx, stores, stats, env, post, get };
}
const fastTimers = (fn, ms) => setTimeout(fn, ms > 100000 ? 60 : ms === 35000 ? 20 : ms === 45000 ? 12 : ms === 8000 ? 5 : ms);
const stalledResponse = () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
const snapshot = items => ({ schemaVersion: 1, scope: 'published-public-abstract', items });
(async () => {
  // Headers arrive, but the body never completes and ignores abort. The local body deadline still settles.
  const bodyStall = harness({ timers: fastTimers, fetcher: url => url.includes('europepmc') ? stalledResponse() : new Response('', { status: 404 }) });
  const startBody = Date.now();
  const bodyResult = await bodyStall.post({ task: 'study', pmid: '111' });
  assert.equal(bodyResult.status, 504); assert.equal(bodyResult.body.error, 'metadata_timeout'); assert(Date.now() - startBody < 500);
  assert.equal(bodyStall.stats.model, 0); assert(!bodyStall.stores.has('lock:study:v1:pmid:111'));
  // Eight selected keys share one 35-second batch bound, with at most two source workers.
  const batch = harness({ timers: fastTimers }); let active = 0, peak = 0, signals = [];
  batch.ctx.resolveMeta = async (key, _doi, _pmid, options) => { active++; peak = Math.max(peak, active); signals.push(options.signal); return new Promise(() => {}); };
  const batchStarted = Date.now();
  const batchResult = await batch.post({ task: 'brief', mode: 'huddle', items: Array.from({ length: 8 }, (_, i) => ({ pmid: String(100 + i) })) });
  assert.equal(batchResult.status, 504); assert.equal(batchResult.body.error, 'metadata_timeout'); assert(Date.now() - batchStarted < 500);
  assert.equal(batch.stats.model, 0); assert.equal(peak, 2); assert(signals.every(s => s.aborted));
  // A provider body stall is bounded independently from its response headers; charge one real attempt.
  const modelStall = harness({ snapshot: snapshot([row()]), timers: fastTimers, fetcher: url => url.includes('model.fixture') ? { ok: true, status: 200, json: () => new Promise(() => {}) } : undefined });
  const modelResult = await modelStall.post({ task: 'study', pmid: '111' });
  assert.equal(modelResult.status, 502); assert.equal(modelResult.body.detail, 'request_timeout'); assert.equal(modelStall.stats.model, 1);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(modelStall.stores.get('model-attempt:' + day), '1'); assert.equal(modelStall.stores.get('cap:' + day), '0');
  const failureSnapshot = [...modelStall.stores.entries()], modelCalls = modelStall.stats.model;
  const failedGet = await modelStall.get('study', ['pmid:111']);
  assert.equal(failedGet.body.taskStatus, 'failed'); assert.equal(failedGet.body.task.error, 'model_failed'); assert.equal(failedGet.body.task.detail, 'request_timeout');
  assert.deepEqual([...modelStall.stores.entries()], failureSnapshot); assert.equal(modelStall.stats.model, modelCalls);
  // Total task deadline survives even a work function that ignores its signal; late cache writes are rejected.
  const total = harness({ timers: (fn, ms) => setTimeout(fn, ms > 100000 ? 10 : ms) });
  const totalRequest = new Request('https://site.fixture/api/ai');
  assert.equal(await total.ctx.gate(total.env, totalRequest, 'total-fixture'), null);
  let lateEnv;
  const totalResult = await total.ctx.runAITask(totalRequest, total.env, 'total-fixture', env => { lateEnv = env; return new Promise(() => {}); });
  assert.equal(totalResult.status, 504); assert.equal((await totalResult.json()).error, 'task_timeout');
  await assert.rejects(total.ctx.aiPut(lateEnv, 'late-result', 'bad'), /task_timeout/); assert(!total.stores.has('late-result'));
  // A delayed old task cannot release or publish over a replacement owner's lease/receipt.
  const owner = harness(), request = new Request('https://site.fixture/api/ai');
  assert.equal(await owner.ctx.gate(owner.env, request, 'owner-fixture'), null);
  const oldLease = JSON.parse(owner.stores.get('lock:owner-fixture'));
  const replacement = { ...oldLease, owner: crypto.randomUUID(), deadline: oldLease.deadline + 180000 };
  const replacementReceipt = JSON.stringify({ ...replacement, status: 'waiting' });
  const result = await owner.ctx.runAITask(request, owner.env, 'owner-fixture', async env => {
    owner.stores.set('lock:owner-fixture', JSON.stringify(replacement)); owner.stores.set('ai:task:owner-fixture', replacementReceipt);
    await assert.rejects(owner.ctx.aiPut(env, 'old-cache', 'bad'), /task_cancelled/);
    return Response.json({ ok: false, error: 'task_cancelled' }, { status: 499 });
  });
  assert.equal(result.status, 499); assert.equal(owner.stores.get('lock:owner-fixture'), JSON.stringify(replacement)); assert.equal(owner.stores.get('ai:task:owner-fixture'), replacementReceipt);
  // Explicit client cancellation releases only its own lease and returns reader quota once.
  let enteredResolve; const entered = new Promise(resolve => { enteredResolve = resolve; });
  const cancelled = harness({ snapshot: snapshot([row()]), fetcher: url => url.includes('model.fixture') ? (enteredResolve(), new Promise(() => {})) : undefined });
  const controller = new AbortController(), cancelling = cancelled.post({ task: 'study', pmid: '111' }, controller.signal);
  await entered; controller.abort(); const cancelledResult = await cancelling;
  assert.equal(cancelledResult.status, 499); assert.equal(cancelledResult.body.error, 'task_cancelled'); assert(!cancelled.stores.has('lock:study:v1:pmid:111'));
  assert.equal(cancelled.stores.get('cap:' + day), '0'); assert.equal(cancelled.stores.get('model-attempt:' + day), '1');
  // Legacy advisory locks remain readable and intact; repeated POSTs reserve no quota.
  const legacy = harness(); legacy.stores.set('lock:study:v1:pmid:111', '1');
  const beforeLegacy = [...legacy.stores.entries()];
  for (let i = 0; i < 3; i++) { const query = await legacy.get('study', ['pmid:111']); assert.equal(query.body.taskStatus, 'waiting'); assert.equal(query.body.retryAfterSeconds, 3); }
  assert.equal((await legacy.post({ task: 'study', pmid: '111' })).status, 409);
  assert.deepEqual([...legacy.stores.entries()], beforeLegacy); assert.equal(legacy.stats.model + legacy.stats.metadata, 0);
  // Upstream error is distinct from a successfully fetched authoritative record with no abstract.
  const broken = harness({ fetcher: () => new Response('', { status: 503 }) });
  const errorResult = await broken.post({ task: 'study', pmid: '111' });
  assert.equal(errorResult.status, 502); assert.equal(errorResult.body.error, 'metadata_error'); assert.equal(errorResult.body.papers[0].reason, 'metadata_error');
  const absent = harness({ fetcher: url => url.includes('europepmc') ? Response.json({ resultList: { result: [{ pmid: '111', title: 'No abstract' }] } }) : new Response('', { status: 404 }) });
  assert.equal((await absent.post({ task: 'study', pmid: '111' })).body.error, 'no_abstract');
  // Published snapshot hash and exact PMID/DOI identity are checked before any model call.
  const good = harness({ snapshot: snapshot([row(), row('222')]) });
  const study = await good.post({ task: 'study', pmid: '111' });
  assert.equal(study.status, 200); assert.equal(good.stats.metadata, 0); assert(study.body.study.papers[0].abstract_source.startsWith('已发布公开摘要快照'));
  assert.equal((await good.get('study', ['pmid:111'])).body.taskStatus, 'completed');
  const brief = await good.post({ task: 'brief', mode: 'huddle', items: [{ pmid: '111' }, { pmid: '222' }] });
  assert.equal(brief.status, 200); assert.equal(brief.body.brief.refs.length, 2); assert.equal(good.stats.metadata, 0); assert.equal(good.stats.model, 2);
  const source = await good.ctx.publishedAbstract({ type: 'doi', id: row().doi }); assert.equal(source.pmid, '111');
  for (const items of [[{ ...row(), sourceHash: '0'.repeat(64) }], [row(), { ...row(), paperID: 'conflict' }], [{ ...row(), abstract: abstract + 'tampered' }], [{ ...row(), title: 'a'.repeat(1001) }], [{ ...row(), abstractSourceUrl: 'http://unsafe.fixture' }], [{ ...row(), abstractSourceUrl: 'https://unapproved.fixture/source' }], [{ ...row(), abstractSourceUrl: 'https://pubmed.ncbi.nlm.nih.gov:8443/111/' }]]) {
    const invalid = harness({ snapshot: snapshot(items) }); assert.equal(await invalid.ctx.publishedAbstract({ type: 'pmid', id: '111' }), null);
  }
  assert.equal(await good.ctx.publishedAbstract({ type: 'pmid', id: '999' }), null);
  const saved = JSON.parse(good.stores.get('study:v1:pmid:111')); saved.papers[0].sourceFingerprint = 'bad-old-source';
  good.stores.set('study:v1:pmid:111', JSON.stringify(saved));
  assert.equal((await good.get('study', ['pmid:111'])).body.found, false);
  // Expired leases and malformed receipts produce fixed safe status, with no cleanup side effects.
  const statusOnly = harness(), staleLease = { version: 1, owner: crypto.randomUUID(), deadline: Date.now() - 1 };
  statusOnly.stores.set('lock:study:v1:pmid:111', JSON.stringify(staleLease));
  const statusBefore = [...statusOnly.stores.entries()];
  assert.equal((await statusOnly.get('study', ['pmid:111'])).body.task.error, 'task_timeout');
  assert.deepEqual([...statusOnly.stores.entries()], statusBefore);
  statusOnly.stores.delete('lock:study:v1:pmid:111');
  statusOnly.stores.set('ai:task:study:v1:pmid:111', JSON.stringify({ ...staleLease, status: 'failed', error: 'private_raw_error', detail: 'private_internal_message' }));
  const safe = (await statusOnly.get('study', ['pmid:111'])).body.task;
  assert.equal(safe.error, 'server'); assert.equal(safe.detail, undefined);
  statusOnly.stores.set('ai:task:study:v1:pmid:111', JSON.stringify({ ...staleLease, deadline: Date.now() + 10000, status: 'waiting' }));
  assert.equal((await statusOnly.get('study', ['pmid:111'])).body.taskStatus, 'waiting');
  assert.equal(statusOnly.stats.model + statusOnly.stats.metadata, 0);
  // Title and translation recovery share POST cache keys and stay read-only on miss, wait and completion.
  const titleRead = harness();
  assert.equal((await titleRead.get('title', ['pmid:111'])).body.taskStatus, 'idle');
  titleRead.stores.set('lock:tt:pmid:111', '1');
  assert.equal((await titleRead.get('title', ['pmid:111'])).body.taskStatus, 'waiting');
  titleRead.stores.set('tt:pmid:111', JSON.stringify({ title_zh: '已保存题名' }));
  const titleHit = await titleRead.get('title', ['pmid:111']);
  assert.equal(titleHit.body.found, true); assert.equal(titleHit.body.tt.title_zh, '已保存题名'); assert.equal(titleHit.body.taskStatus, 'completed');
  assert.equal((await titleRead.get('translate', ['pmid:111'])).body.canGenerate, true);
  assert.equal(titleRead.stats.writes + titleRead.stats.deletes + titleRead.stats.model + titleRead.stats.metadata, 0);
  console.log('AI deadline lifecycle offline regressions passed: body/batch/task deadlines, lease ownership, read-only failure status, quotas/attempts, legacy locks, strict published snapshots.');
})().catch(error => { console.error(error); process.exitCode = 1; });
