// Offline end-to-end tests. No request can leave this fixture fetch implementation.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../edge/_worker.js'), 'utf8').replace('export default {', 'globalThis.worker = {');
const fields = ['question', 'population', 'design', 'comparator', 'endpoints', 'results'];
const quotesA = {
  question: 'This post hoc analysis evaluates preventive PCI in vulnerable plaques.',
  population: 'This analysis included 598 patients with vulnerable plaques.',
  design: 'This post hoc analysis used data from the PREVENT randomized trial.',
  comparator: 'Preventive PCI was compared with optimal medical therapy.',
  endpoints: 'The primary outcome was death or myocardial infarction.',
  results: 'No benefit was observed in the non-LRP group (5.5% versus 4.2%).'
};
const quotesB = {
  question: 'This prospective cohort evaluates a prognostic imaging marker.',
  population: 'This cohort included 888 patients with stable coronary disease.',
  design: 'This study was a prospective observational cohort analysis.',
  comparator: 'Participants with high marker values were compared with those with low values.',
  endpoints: 'The primary endpoint was hospitalization for heart failure.',
  results: 'Hospitalization occurred in 6.1% of the cohort during follow-up.'
};
const records = {
  '111': { pmid: '111', doi: '10.1234/first', title: 'PREVENT post hoc fixture', journalTitle: 'Fixture Journal', abstractText: Object.values(quotesA).join(' ') },
  '222': { pmid: '222', doi: '10.1234/second', title: 'Prospective cohort fixture', journalTitle: 'Fixture Journal', abstractText: Object.values(quotesB).join(' ') },
  '333': { pmid: '333', title: 'No abstract fixture', journalTitle: 'Fixture Journal' }
};
const unknown = { text: '摘要未提供', quote: '' };
function outputFor(arts) {
  return { papers: arts.map(art => {
    const first = art.title.startsWith('PREVENT'), quotes = first ? quotesA : quotesB;
    const text = first ? {
      question: '评估易损斑块中的预防性PCI', population: '纳入598例患者', design: 'PREVENT母试验的事后分析', comparator: '预防性PCI与最佳药物治疗比较', endpoints: '死亡或心肌梗死', results: 'non-LRP组未观察到获益（5.5%对4.2%）'
    } : {
      question: '评估影像标志物的预后意义', population: '纳入888例患者', design: '前瞻性观察队列分析', comparator: '标志物高值与低值比较', endpoints: '因心力衰竭住院', results: '随访期间6.1%发生住院'
    };
    const paper = { id: art.id };
    for (const field of fields) paper[field] = art.evidence ? { text: text[field], quote_id: art.evidence.find(e => e.quote === quotes[field]).id } : { text: text[field], quote: quotes[field] };
    return paper;
  }) };
}
function harness({ model, timers, fixtureRecords = records } = {}) {
  const stores = new Map(), ttls = new Map();
  const stats = { metadata: 0, model: 0, modelPayloads: [], active: 0, peak: 0 };
  const kv = { get: async (key, type) => { const value = stores.get(key); return type === 'json' && value ? JSON.parse(value) : value || null; },
    put: async (key, value, opts) => { stores.set(key, value); ttls.set(key, opts && opts.expirationTtl); }, delete: async key => stores.delete(key) };
  const ctx = vm.createContext({ URL, Response, Request, TextEncoder, AbortController, setTimeout: timers || setTimeout, clearTimeout, crypto: require('crypto').webcrypto, console });
  ctx.fetch = async (url, opts) => {
    url = String(url);
    if (url === 'https://model.fixture/api') {
      stats.model++;
      assert.equal(opts.redirect, 'manual');
      const payload = JSON.parse(opts.body), arts = JSON.parse(payload.messages[1].content);
      stats.modelPayloads.push(payload);
      assert(arts.every(a => Object.keys(a).sort().join(',') === 'abstract,evidence,id,journal,title'));
      if (model) return model(arts, stats.model, payload);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(outputFor(arts)) } }] });
    }
    assert(url.startsWith('https://www.ebi.ac.uk/') || url.startsWith('https://eutils.ncbi.nlm.nih.gov/'), 'Unexpected fixture URL: ' + url);
    stats.metadata++; stats.active++; stats.peak = Math.max(stats.peak, stats.active);
    await new Promise(resolve => setImmediate(resolve));
    stats.active--;
    if (url.includes('europepmc')) {
      const query = new URL(url).searchParams.get('query');
      const pmid = /EXT_ID:(\d+)/.exec(query)?.[1];
      const doi = /DOI:"([^"]+)"/.exec(query)?.[1];
      const record = pmid ? fixtureRecords[pmid] : Object.values(fixtureRecords).find(r => r.doi === doi);
      return Response.json({ resultList: { result: record ? [record] : [] } });
    }
    return new Response('No public abstract', { status: 404 });
  };
  vm.runInContext(source, ctx);
  const env = { QL_KV: kv, LLM_ENDPOINT: 'https://model.fixture/api', LLM_MODEL: 'glm-5.3-fixture', LLM_API_KEY: 'synthetic-test-only' };
  const post = async (body, overrides = {}, origin) => {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': 'fixture-reader' };
    if (origin) headers.origin = origin;
    const response = await ctx.worker.fetch(new Request('https://site.fixture/api/ai', { method: 'POST', headers, body: JSON.stringify(body) }), { ...env, ...overrides });
    return { status: response.status, body: await response.json() };
  };
  const get = async (task, keys, overrides = {}) => {
    const params = new URLSearchParams({ task });
    if (task === 'study') params.set('k', keys[0]); else params.set('keys', JSON.stringify(keys));
    const response = await ctx.worker.fetch(new Request('https://site.fixture/api/ai?' + params), { ...env, ...overrides });
    return { status: response.status, body: await response.json() };
  };
  return { ctx, stores, ttls, stats, env, post, get };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
(async () => {
  // Matching an unrelated assertion's number somewhere in the abstract must not pass.
  const h = harness(), arts = [{ n: 1, abstract: records['111'].abstractText }, { n: 2, abstract: records['222'].abstractText }];
  const good = outputFor([{ id: '1', title: records['111'].title }, { id: '2', title: records['222'].title }]);
  assert.equal(h.ctx.checkStudy(good, arts).get('1').design.text, 'PREVENT母试验的事后分析');
  let bad = clone(good); bad.papers[0].population.text = '纳入888例';
  assert.throws(() => h.ctx.checkStudy(bad, arts), /numbers_not_in_source/);
  bad = clone(good); bad.papers[0].population.text = '纳入5.5例';
  assert.throws(() => h.ctx.checkStudy(bad, arts), /numbers_not_in_source/);
  bad = clone(good); bad.papers[1].population.quote = quotesA.population;
  assert.throws(() => h.ctx.checkStudy(bad, arts), /quote_not_in_abstract/);
  bad = clone(good); bad.papers[1].id = '1';
  assert.throws(() => h.ctx.checkStudy(bad, arts), /invalid_study_id/);
  bad = clone(good); bad.papers[1].id = '9';
  assert.throws(() => h.ctx.checkStudy(bad, arts), /invalid_study_id/);
  bad = clone(good); bad.papers[0].comparator = { text: '摘要没有说明', quote: '' };
  assert.throws(() => h.ctx.checkStudy(bad, arts), /invalid_study_quote_length/);
  bad = clone(good); bad.papers[0].comparator = { ...unknown, quote: quotesA.comparator };
  assert.throws(() => h.ctx.checkStudy(bad, arts), /invalid_study_unknown/);
  bad = clone(good); bad.papers[0].comparator = unknown;
  assert.equal(h.ctx.checkStudy(bad, arts).get('1').comparator.text, '摘要未提供');
  bad = clone(good); bad.papers[0].private_notes = 'unrequested material';
  assert.throws(() => h.ctx.checkStudy(bad, arts), /invalid_study_id/);

  // Read-only cache misses never consume a model call, source request, quota or lock.
  const miss = await h.get('study', ['pmid:111']);
  assert.equal(miss.status, 200); assert.equal(miss.body.found, false); assert.equal(miss.body.canGenerate, true); assert.equal(h.stores.size, 0);
  assert.equal(h.stats.metadata + h.stats.model, 0);
  const single = await h.post({ task: 'study', pmid: '111', doi: '10.1234/reader-hint-ignored' });
  assert.equal(single.status, 200); assert.equal(single.body.study.schemaVersion, 1); assert.equal(single.body.study.scope, 'public-abstract');
  const paper = single.body.study.papers[0];
  assert.equal(paper.status, 'available'); assert.equal(paper.pmid, '111'); assert.equal(paper.doi, '10.1234/first');
  assert.equal(paper.source_url, 'https://pubmed.ncbi.nlm.nih.gov/111/'); assert.equal(paper.abstract_source, 'Europe PMC 公开摘要'); assert(paper.sourceFingerprint);
  assert.equal(single.body.study.checklist.length, 4); assert(single.body.study.checklist.every(q => typeof q === 'string'));
  assert.equal(h.stats.model, 1); assert.equal(h.stats.metadata, 1); assert.equal(h.ttls.get('study:v1:pmid:111'), 2592000);
  // Oversized public citation metadata cannot expand the model request; preserve the source citation.
  const longRecord = { ...records['111'], title: 'PREVENT ' + 'A'.repeat(40000), journalTitle: 'J'.repeat(20000) };
  const boundedMetadata = harness({ fixtureRecords: { '111': longRecord } });
  const longResult = await boundedMetadata.post({ task: 'study', pmid: '111' });
  assert.equal(longResult.status, 200);
  const boundedPayload = boundedMetadata.stats.modelPayloads[0], boundedPaper = JSON.parse(boundedPayload.messages[1].content)[0];
  assert.equal(boundedPaper.title.length, 1000); assert.equal(boundedPaper.journal.length, 200);
  assert.equal(boundedPaper.abstract, records['111'].abstractText);
  assert(Buffer.byteLength(JSON.stringify(boundedPayload), 'utf8') < 16000);
  assert.equal(longResult.body.study.papers[0].title, longRecord.title); assert.equal(longResult.body.study.papers[0].journal, longRecord.journalTitle);
  const snapshots = [...h.stores.entries()];
  const cachedOff = await h.get('study', ['pmid:111'], { AI_ENABLED: 'off' });
  assert.equal(cachedOff.body.found, true); assert.equal(cachedOff.body.canGenerate, false); assert.equal(h.stats.model, 1);
  assert.deepEqual([...h.stores.entries()], snapshots);
  const cachedPost = await h.post({ task: 'study', pmid: '111' }, { AI_ENABLED: 'off' });
  assert.equal(cachedPost.status, 200); assert.equal(cachedPost.body.cached, true); assert.equal(h.stats.model, 1);

  // A group reuses a single-paper extraction and only sends the missing paper to the model.
  const compared = await h.post({ task: 'compare', items: [{ pmid: '222' }, { pmid: '111' }] });
  assert.equal(compared.status, 200); assert.equal(compared.body.compare.papers.length, 2);
  assert.equal(compared.body.compare.papers[0].key, 'pmid:111'); assert.equal(compared.body.compare.papers[1].n, 2);
  assert.equal(compared.body.compare.papers[1].population.text, '纳入888例患者'); assert.equal(h.stats.model, 2);
  assert.equal(JSON.parse(h.stats.modelPayloads[1].messages[1].content).length, 1);
  assert.equal(h.stats.metadata, 2); assert(h.stats.peak <= 2);
  const before = [...h.stores.entries()];
  const compareGet = await h.get('compare', ['pmid:222', 'pmid:111'], { AI_ENABLED: 'off' });
  assert.equal(compareGet.status, 200); assert.equal(compareGet.body.found, true); assert.equal(compareGet.body.canGenerate, false);
  assert.deepEqual([...h.stores.entries()], before); assert.equal(h.stats.model, 2); assert.equal(h.stats.metadata, 2);
  assert.equal((await h.get('study', ['pmid:222'])).body.found, true);
  // DOI delimiters cannot make two different selected groups share a cache key.
  const collisionA = ['doi:10.1234/a', 'doi:10.1234/b|doi:10.1234/c'];
  const collisionB = ['doi:10.1234/a|doi:10.1234/b', 'doi:10.1234/c'];
  assert.equal(collisionA.join('|'), collisionB.join('|'));
  assert.notEqual(await h.ctx.studyCacheKey('compare', collisionA), await h.ctx.studyCacheKey('compare', collisionB));
  const injectedKey = await h.ctx.studyCacheKey('compare', ['pmid:111', 'pmid:444']);
  h.stores.set(injectedKey, JSON.stringify(compared.body.compare));
  assert.equal((await h.get('compare', ['pmid:111', 'pmid:444'])).body.found, false);

  // A partially unavailable group retains every selected paper and no invented claims.
  const partial = await h.post({ task: 'compare', items: [{ pmid: '111' }, { pmid: '333' }] });
  assert.equal(partial.status, 200); assert.equal(partial.body.compare.papers.length, 2);
  const missing = partial.body.compare.papers[1];
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.title, 'No abstract fixture'); assert.equal(missing.key, 'pmid:333');
  assert.deepEqual(partial.body.compare.missingKeys, ['pmid:333']); assert.equal(missing.results.text, '摘要未提供');
  assert.equal(h.stats.model, 2);
  const partialKey = await h.ctx.studyCacheKey('compare', ['pmid:111', 'pmid:333']);
  assert.equal(h.ttls.get(partialKey), 3600);
  const empty = harness();
  const allMissing = await empty.post({ task: 'compare', items: [{ pmid: '333' }, { pmid: '444' }] });
  assert.equal(allMissing.status, 422); assert.equal(allMissing.body.papers.length, 2); assert.equal(allMissing.body.error, 'no_abstract');
  assert.equal(empty.stats.model, 0); assert(![...empty.stores.keys()].some(k => k.startsWith('study:') || k.startsWith('compare:') || k.startsWith('lock:')));
  const noAbstract = await empty.post({ task: 'study', pmid: '333' }); assert.equal(noAbstract.status, 422); assert.equal(noAbstract.body.papers.length, 1);
  assert.equal(noAbstract.body.study.generatedBy, 'metadata-only'); assert.equal(noAbstract.body.study.generatedAt, ''); assert.equal(noAbstract.body.study.model, '');

  // Invalid/free-text/private-material inputs are rejected before source/model requests.
  const invalid = harness();
  for (const input of [
    { task: 'study', pmid: '111', abstract: 'reader supplied private text' },
    { task: 'study', pmid: '111', title: 'untrusted title' },
    { task: 'compare', items: [{ pmid: '111', text: 'untrusted text' }, { pmid: '222' }] },
    { task: 'compare', items: [{ pmid: '111' }] },
    { task: 'compare', items: [{ pmid: '111' }, { pmid: '111' }] },
    { task: 'compare', items: ['pmid:111', 'pmid:222'] },
    { task: 'compare', items: Array.from({ length: 5 }, (_, i) => ({ pmid: String(100 + i) })) },
    { task: 'study', pmid: [['111']] },
    { task: 'study', pmid: 'invalid', doi: '10.1234/first' }, null
  ]) assert.equal((await invalid.post(input)).status, 400);
  assert.equal((await invalid.post({ task: 'study', pmid: '111' }, {}, 'https://other.fixture')).status, 403);
  assert.equal((await invalid.get('compare', ['pmid:111', 'not-an-id'])).status, 400);
  assert.equal(invalid.stats.metadata + invalid.stats.model, 0);

  // A cache-only new combination remains accessible with generation off and exhausted quotas.
  const assembled = harness();
  await assembled.post({ task: 'study', pmid: '111' }); await assembled.post({ task: 'study', pmid: '222' });
  for (const key of assembled.stores.keys()) if (key.startsWith('cap:') || key.startsWith('ip:')) assembled.stores.set(key, '150');
  const assemblySnapshot = [...assembled.stores.entries()], assemblyCalls = assembled.stats.model, assemblyMetadata = assembled.stats.metadata;
  const assembledGet = await assembled.get('compare', ['pmid:222', 'pmid:111'], { AI_ENABLED: 'off' });
  assert.equal(assembledGet.status, 200); assert.equal(assembledGet.body.found, true); assert.equal(assembledGet.body.canGenerate, false);
  assert.equal(assembledGet.body.compare.generatedBy, 'cache-assembly'); assert.deepEqual([...assembled.stores.entries()], assemblySnapshot);
  const assembledPost = await assembled.post({ task: 'compare', items: [{ pmid: '111' }, { pmid: '222' }] }, { AI_ENABLED: 'off' });
  assert.equal(assembledPost.status, 200); assert.equal(assembledPost.body.cached, true);
  assert.equal(assembled.stats.model, assemblyCalls); assert.equal(assembled.stats.metadata, assemblyMetadata);

  // PMID/DOI aliases resolving to the same article cannot form a two-paper comparison.
  const duplicate = harness();
  const same = await duplicate.post({ task: 'compare', items: [{ pmid: '111' }, { doi: '10.1234/first' }] });
  assert.equal(same.status, 400); assert.equal(same.body.error, 'need_two_unique'); assert.equal(duplicate.stats.model, 0);

  // Metadata fallbacks must verify the response's identity, not merely the query URL.
  const wrongPubmed = harness();
  wrongPubmed.ctx.fetch = async url => String(url).includes('europepmc') ? Response.json({ resultList: { result: [records['222']] } }) :
    new Response('<PubmedArticle><MedlineCitation><PMID>222</PMID><ArticleTitle>Wrong paper</ArticleTitle><Abstract><AbstractText>' + records['222'].abstractText + '</AbstractText></Abstract></MedlineCitation></PubmedArticle>');
  const wrongPaper = await wrongPubmed.post({ task: 'study', pmid: '111' });
  assert.equal(wrongPaper.status, 422); assert.equal(wrongPaper.body.papers[0].pmid, '111'); assert.equal(wrongPubmed.stats.model, 0);
  const inverse = {};
  records['111'].abstractText.split(' ').forEach((word, index) => { (inverse[word] ||= []).push(index); });
  const wrongDoi = harness();
  wrongDoi.ctx.fetch = async url => {
    url = String(url);
    if (url.includes('europepmc')) return Response.json({ resultList: { result: [] } });
    if (url.includes('openalex')) return Response.json({ doi: 'https://doi.org/10.1234/wrong', title: 'Wrong paper', abstract_inverted_index: inverse });
    if (url.includes('crossref')) return Response.json({ message: { DOI: '10.1234/wrong', title: ['Wrong paper'], abstract: records['111'].abstractText } });
    assert(url === 'https://doi.org/10.1234/target');
    return new Response('<meta name="citation_doi" content="10.1234/wrong"><meta name="citation_abstract" content="' + records['111'].abstractText + '">', { headers: { 'content-type': 'text/html' } });
  };
  assert.equal((await wrongDoi.post({ task: 'study', doi: '10.1234/target' })).status, 422); assert.equal(wrongDoi.stats.model, 0);
  const correctOpenalex = harness();
  const normalFetch = correctOpenalex.ctx.fetch;
  correctOpenalex.ctx.fetch = async (url, opts) => {
    if (String(url).includes('europepmc')) return Response.json({ resultList: { result: [] } });
    if (String(url).includes('openalex')) {
      assert(new URL(url).searchParams.get('select').includes('doi'));
      return Response.json({ doi: 'https://doi.org/10.1234/target', title: records['111'].title, abstract_inverted_index: inverse });
    }
    return normalFetch(url, opts);
  };
  const fallback = await correctOpenalex.post({ task: 'study', doi: '10.1234/target' });
  assert.equal(fallback.status, 200); assert.equal(fallback.body.study.papers[0].abstract_source, 'OpenAlex'); assert.equal(fallback.body.study.papers[0].source_url, 'https://doi.org/10.1234/target');
  const fallbackAlias = harness();
  await fallbackAlias.post({ task: 'study', pmid: '111' });
  const aliasFetch = fallbackAlias.ctx.fetch;
  fallbackAlias.ctx.fetch = async (url, opts) => {
    if (String(url).includes('europepmc')) return Response.json({ resultList: { result: [] } });
    if (String(url).includes('openalex')) return Response.json({ doi: 'https://doi.org/10.1234/first', title: records['111'].title, abstract_inverted_index: inverse });
    return aliasFetch(url, opts);
  };
  const duplicateFallback = await fallbackAlias.post({ task: 'compare', items: [{ pmid: '111' }, { doi: '10.1234/first' }] });
  assert.equal(duplicateFallback.status, 400); assert.equal(duplicateFallback.body.error, 'need_two_unique'); assert.equal(fallbackAlias.stats.model, 1);
  // The same aliases also remain distinct-checked when both views are already cached.
  await fallbackAlias.post({ task: 'study', doi: '10.1234/first' });
  const duplicateCached = await fallbackAlias.get('compare', ['pmid:111', 'doi:10.1234/first']);
  assert.equal(duplicateCached.status, 400); assert.equal(duplicateCached.body.error, 'need_two_unique'); assert.equal(fallbackAlias.stats.model, 2);

  // At most one validation retry; failed generations do not create result caches.
  const repaired = harness({ model: (used, call) => {
    const output = outputFor(used); if (call === 1) output.papers[0].results.quote_id = '1:nonexistent';
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
  } });
  assert.equal((await repaired.post({ task: 'study', pmid: '111' })).status, 200); assert.equal(repaired.stats.model, 2);
  const failed = harness({ model: used => {
    const output = outputFor(used); output.papers[0].population.text = '纳入999例';
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
  } });
  const failure = await failed.post({ task: 'study', pmid: '111' });
  assert.equal(failure.status, 502); assert.equal(failure.body.detail, 'unsupported_numbers'); assert.equal(failed.stats.model, 2);
  const attemptDay = new Date().toISOString().slice(0, 10);
  assert.equal(failed.stores.get('model-attempt:' + attemptDay), '2');
  assert.equal(failed.stores.get('cap:' + attemptDay), '0');
  assert(![...failed.stores.keys()].some(k => k.startsWith('study:') || k.startsWith('lock:')));
  for (const status of [401, 403, 429, 500]) {
    const provider = harness({ model: () => Response.json({ error: 'synthetic-private-provider-content' }, { status }) });
    const response = await provider.post({ task: 'study', pmid: '111' });
    assert.equal(response.status, 502); assert.equal(provider.stats.model, 1); assert(!JSON.stringify(response.body).includes('synthetic-private'));
    assert(![...provider.stores.keys()].some(k => k.startsWith('study:') || k.startsWith('lock:')));
  }
  const capped = harness({ model: () => Response.json({ error: 'fixture auth failure' }, { status: 401 }) });
  assert.equal((await capped.post({ task: 'study', pmid: '111' }, { MODEL_CALL_CAP: '1' })).body.detail, 'provider_auth');
  const cappedAgain = await capped.post({ task: 'study', pmid: '111' }, { MODEL_CALL_CAP: '1' });
  assert.equal(cappedAgain.body.detail, 'provider_budget'); assert.equal(capped.stats.model, 1); assert.equal(capped.stores.get('model-attempt:' + attemptDay), '1');
  const truncated = harness({ model: () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }) });
  assert.equal((await truncated.post({ task: 'compare', items: [{ pmid: '111' }, { pmid: '222' }] })).body.detail, 'output_truncated');
  assert.equal(truncated.stats.model, 2); assert(truncated.stats.modelPayloads.every(p => p.max_tokens <= 7600));

  // A metadata stall cannot keep the new service waiting indefinitely or trigger a model call.
  const deadline = harness({ timers: (callback, delay) => setTimeout(callback, delay === 35000 ? 5 : delay) });
  deadline.ctx.resolveMeta = async () => new Promise(() => {});
  const expired = await deadline.post({ task: 'compare', items: [{ pmid: '111' }, { pmid: '222' }] });
  assert.equal(expired.status, 422); assert(expired.body.papers.every(p => p.reason === 'metadata_timeout')); assert.equal(deadline.stats.model, 0);
  // The metadata deadline aborts the actual fetch signal even after headers arrive.
  const bodyStall = harness({ timers: (callback, delay) => setTimeout(callback, delay === 35000 ? 10 : delay) });
  const bodyFetch = bodyStall.ctx.fetch;
  let stalledSignal;
  bodyStall.ctx.fetch = async (url, opts) => {
    if (String(url).includes('europepmc') && new URL(url).searchParams.get('query').includes('EXT_ID:222')) {
      stalledSignal = opts.signal;
      return new Response(new ReadableStream({ start(controller) { opts.signal.addEventListener('abort', () => controller.error(Error('fixture abort')), { once: true }); } }), { headers: { 'content-type': 'application/json' } });
    }
    return bodyFetch(url, opts);
  };
  const partialStall = await bodyStall.post({ task: 'compare', items: [{ pmid: '111' }, { pmid: '222' }] });
  assert.equal(partialStall.status, 200); assert.equal(partialStall.body.compare.papers[1].reason, 'metadata_timeout'); assert(stalledSignal.aborted);
  // One malformed metadata record cannot discard another selected paper.
  const malformed = harness(), originalResolve = malformed.ctx.resolveMeta;
  malformed.ctx.resolveMeta = (...args) => args[0].id === '222' ? Promise.reject(TypeError('fixture metadata parse failure')) : originalResolve(...args);
  const malformedPartial = await malformed.post({ task: 'compare', items: [{ pmid: '111' }, { pmid: '222' }] });
  assert.equal(malformedPartial.status, 200); assert.equal(malformedPartial.body.compare.papers[0].status, 'available'); assert.equal(malformedPartial.body.compare.papers[1].reason, 'metadata_error');

  // Lock/IP rejections reserve no quota; refunds use the original UTC day and are idempotent.
  const quota = harness(), request = () => new Request('https://site.fixture/api/ai', { headers: { 'cf-connecting-ip': 'quota-fixture' } });
  quota.stores.set('lock:occupied', '1');
  for (let i = 0; i < 3; i++) assert.equal((await quota.ctx.gate(quota.env, request(), 'occupied')).status, 409);
  assert(![...quota.stores.keys()].some(k => k.startsWith('cap:') || k.startsWith('ip:')));
  const day = new Date().toISOString().slice(0, 10), ipKey = 'ip:' + day + ':' + await quota.ctx.sha('quota-fixture');
  quota.stores.set('cap:' + day, '1'); quota.stores.set(ipKey, '1');
  for (let i = 0; i < 3; i++) assert.equal((await quota.ctx.gate({ ...quota.env, IP_CAP: '1' }, request(), 'new-' + i)).status, 429);
  assert.equal(quota.stores.get('cap:' + day), '1'); assert.equal(quota.stores.get(ipKey), '1');
  let fixtureNow = '2026-10-07T23:59:59.999Z';
  quota.ctx.Date = class extends Date { constructor(value) { super(arguments.length ? value : fixtureNow); } static now() { return new Date(fixtureNow).getTime(); } };
  const midnightRequest = request();
  assert.equal(await quota.ctx.gate(quota.env, midnightRequest, 'midnight'), null);
  const oldDayKey = 'cap:2026-10-07', oldIpKey = 'ip:2026-10-07:' + await quota.ctx.sha('quota-fixture');
  const oldDayReserved = Number(quota.stores.get(oldDayKey)), oldIpReserved = Number(quota.stores.get(oldIpKey));
  fixtureNow = '2026-10-08T00:00:00.001Z';
  const newDayKey = 'cap:2026-10-08', newIpKey = 'ip:2026-10-08:' + await quota.ctx.sha('quota-fixture');
  quota.stores.set(newDayKey, '7'); quota.stores.set(newIpKey, '7');
  await quota.ctx.refund(quota.env, midnightRequest); await quota.ctx.refund(quota.env, midnightRequest);
  assert.equal(Number(quota.stores.get(oldDayKey)), oldDayReserved - 1); assert.equal(Number(quota.stores.get(oldIpKey)), oldIpReserved - 1);
  assert.equal(quota.stores.get(newDayKey), '7'); assert.equal(quota.stores.get(newIpKey), '7');
  console.log('Study/compare offline services passed: scoped evidence, unique paper IDs, partial abstracts, shared caches, ID-only input, bounded metadata and provider retries.');
})().catch(error => { console.error(error); process.exitCode = 1; });
