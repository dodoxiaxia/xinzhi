'use strict';
// Offline contracts for explicit public-abstract study/compare interactions.
// Runs the actual app helpers, with a controlled fetch and small UI boundary.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const fn = name => {
  const m = src.match(new RegExp('  function ' + name + '\\([^]*?\\n  }'));
  if (!m) throw Error('Missing app helper: ' + name);
  return m[0];
};
const cs = name => {
  const m = src.match(new RegExp('  const ' + name + ' =[^]*?;'));
  if (!m) throw Error('Missing app constant: ' + name);
  return m[0];
};
const start = src.indexOf('  // ---- Public-abstract study services:');
const end = src.indexOf('  // ---- End public-abstract study services.');
assert(start > 0 && end > start);
const code = [
  src.slice(src.indexOf('  const esc ='), src.indexOf('  // Toast notification')),
  fn('aiRequest'), fn('aiTaskStatus'), fn('aiWaitingMessage'), fn('aiLookupRecord'), fn('aiPostRecord'), fn('safeSourceUrl'), fn('contentDate'), cs('AI_ERR'), cs('AI_MODEL_ERR'), fn('aiErrorMessage'),
  src.slice(start, end)
].join('\n');
let assertions = 0;
const check = (v, label) => { assert(v, label); assertions++; };
const same = (a, b, label) => { assert.deepStrictEqual(a, b, label); assertions++; };
const plain = x => JSON.parse(JSON.stringify(x));
const calls = [], replies = [], toasts = [], renders = [];
let modalOpen = true;
const paper = (id, pmid, doi) => ({ id, pmid, doi, title: 'Study ' + id, journal: 'Public Journal', summary: 'Never send the local summary' });
const papers = [paper('a', '1001', '10.1000/A'), paper('b', '1002', '10.1000/B'), paper('c', '1003', ''), paper('d', '1004', ''), paper('e', '1005', ''), paper('alias', '', '10.1000/a'), paper('noid', '', '')];
const state = { huddle: papers.map(p => p.id), huddleCompare: [], activeDrawerPaper: null };
const c = vm.createContext({
  AbortController, setTimeout, clearTimeout, state, allPapersMap: new Map(papers.map(p => [p.id, p])), URL, Date,
  huddlePaper: id => papers.find(p => p.id === id) || null,
  showToast: text => toasts.push(text),
  openReaderDrawer: p => renders.push(['drawer', p.id]),
  openHuddleModal: () => renders.push(['huddle']),
  $: () => modalOpen ? {} : null,
  fetch: (url, options) => {
    calls.push({ url, options });
    const reply = replies.shift();
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({ json: () => Promise.resolve(reply) });
  }
});
vm.runInContext(code, c);
const studies = vm.runInContext('STUDY_RESULTS', c), compares = vm.runInContext('COMPARE_RESULTS', c);
const flush = () => new Promise(resolve => setImmediate(resolve));
const result = (rows) => ({ schemaVersion: 1, scope: 'public-abstract', papers: rows, checklist: ['核对完整研究流程'], caveat: '摘要信息有限', generatedAt: '2026-10-07T06:59:00Z', model: 'public-model' });
const available = p => ({ ...p, key: c.studyKey(p), status: 'available', source_url: 'https://pubmed.ncbi.nlm.nih.gov/' + p.pmid + '/', abstract_source: 'PubMed', ...Object.fromEntries(['question', 'population', 'design', 'comparator', 'endpoints', 'results'].map(k => [k, { text: '公开摘要要点', quote: 'Original source quote <4' }])) });
async function run() {
  same(c.studyKey(papers[0]), 'pmid:1001', 'PMID is preferred');
  same(c.studyKey(papers[5]), 'doi:10.1000/a', 'DOI is normalized');
  same(c.studyKey(papers[6]), '', 'Missing IDs stay unavailable');
  same(plain(c.selectedComparePapers()), [], 'No implicit first papers');
  check(c.compareBoxHtml(papers).includes('明确勾选 2–4'), 'Empty selection prompts explicit choice');
  check(c.setCompareSelection('a', true), 'Select first item');
  check(c.setCompareSelection('a', true), 'Repeated same event is idempotent');
  same(state.huddleCompare.length, 1);
  check(!c.setCompareSelection('alias', true), 'DOI alias cannot duplicate a PMID item');
  check(!c.setCompareSelection('noid', true), 'No-ID item cannot be selected');
  check(!c.setCompareSelection('not-in-huddle', true));
  for (const id of ['b', 'c', 'd']) check(c.setCompareSelection(id, true));
  check(!c.setCompareSelection('e', true), 'Fifth item refused without silently trimming');
  same(plain(c.selectedComparePapers()).map(p => p.id), ['a', 'b', 'c', 'd']);
  check(c.setCompareSelection('d', false));
  check(c.setCompareSelection('c', false));
  same(c.compareKey([papers[1], papers[0]]), '["pmid:1001","pmid:1002"]', 'Cache group key is sorted');
  same(calls.length, 0, 'Selection never calls the model or performs a request');

  const single = result([available(papers[0])]);
  replies.push({ ok: true, found: true, study: single, canGenerate: false });
  state.activeDrawerPaper = papers[0];
  c.studyCheck(papers[0]); c.studyCheck(papers[0]);
  same(calls.length, 1, 'Drawer cache check is deduplicated');
  same(calls[0].options.method, undefined, 'Drawer uses GET');
  check(calls[0].url.includes('task=study&k=pmid%3A1001'));
  await flush();
  same(studies['pmid:1001'].state, 'done');
  check(!studies['pmid:1001'].canGenerate, 'Generation disabled does not hide cache');
  const html = c.studyBoxHtml(papers[0]);
  check(html.includes('读取已有结果'));
  check(html.includes('核对摘要原句'));
  check(html.includes('Original source quote &lt;4'), 'Source quote remains text');
  check(html.includes('全文核对清单（待查事项）'));
  check(html.includes('并非已发现论文存在这些缺陷'));
  check(html.includes('生成时间（北京时间）'));
  check(!html.includes('data-action="ai-study"'), 'Disabled generation cache has no paid button');
  const before = calls.length; c.aiStudy(papers[0]);
  same(calls.length, before, 'Generation requires capability obtained from cache endpoint');

  replies.push({ ok: true, found: false, canGenerate: true });
  c.studyCheck(papers[1]); await flush();
  check(c.studyBoxHtml(papers[1]).includes('data-action="ai-study"'));
  replies.push({ ok: true, study: result([available(papers[1])]), cached: false });
  c.aiStudy(papers[1]); c.aiStudy(papers[1]);
  same(calls.filter(x => x.options.method === 'POST').length, 1, 'Loading prevents duplicate paid call');
  const studyCall = calls.find(x => x.options.method === 'POST');
  same(JSON.parse(studyCall.options.body), { task: 'study', pmid: '1002', doi: '10.1000/B' }, 'Only identifiers reach study API');
  check(c.studyBoxHtml(papers[1]).includes('role="status"'), 'Loading is announced');
  await flush();
  same(studies['pmid:1002'].state, 'done');

  replies.push({ ok: true, found: false, canGenerate: true });
  c.compareCheck(); c.compareCheck(); await flush();
  const key = c.compareKey(c.selectedComparePapers());
  const lookup = calls[calls.length - 1];
  same(JSON.parse(new URL('https://example.test' + lookup.url).searchParams.get('keys')), ['pmid:1001', 'pmid:1002']);
  check(!lookup.options.method, 'Compare cache uses GET only');
  const partial = result([available(papers[0]), { ...papers[1], key: 'pmid:1002', status: 'unavailable', reason: 'no_abstract' }]);
  replies.push({ ok: true, compare: partial, cached: false });
  c.aiCompare(); c.aiCompare();
  const compareCall = calls[calls.length - 1];
  same(JSON.parse(compareCall.options.body), { task: 'compare', items: [{ pmid: '1001', doi: '10.1000/A' }, { pmid: '1002', doi: '10.1000/B' }] }, 'Compare sends IDs, no personal list text');
  await flush();
  same(compares[key].state, 'done');
  const comparison = c.compareBoxHtml(papers);
  check(comparison.includes('Study b'), 'Missing abstract does not remove selected paper');
  check(comparison.includes('未找到公开摘要'));
  check(comparison.includes('scope="row"'));
  check(comparison.includes('aria-label="逐篇公开摘要证据对照表"'));
  check(comparison.includes('data-action="study-copy"'));
  check(comparison.includes('摘要来源 ↗'));
  const incomplete = result([available(papers[0])]);
  same(c.studyRows(incomplete, [papers[0], papers[1]]).length, 2, 'Missing result row also remains visible');
  const copy = c.studyCopyText(partial, [papers[0], papers[1]]);
  check(copy.includes('Original source quote <4'));
  check(copy.includes('Study b'));
  check(copy.includes('待查事项，并非已发现的论文缺陷'));
  check(copy.includes('摘要来源：PubMed https://pubmed.ncbi.nlm.nih.gov/1001/'));

  const unsafe = result([{ ...available(papers[0]), title: '<script>alert(1)</script>', source_url: 'javascript:alert(1)', results: { text: '<img onerror=x>', quote: '<svg onload=x>' } }]);
  const unsafeHtml = c.studyResultHtml(unsafe, [papers[0]], true, 'compare');
  check(!unsafeHtml.includes('<script>') && unsafeHtml.includes('&lt;script&gt;'), 'Paper metadata is escaped');
  check(!unsafeHtml.includes('<img') && unsafeHtml.includes('&lt;img'), 'Model field text is escaped');
  check(!unsafeHtml.includes('href="javascript:'), 'Unsafe source links are omitted');
  check(!c.studyCopyText(unsafe, [papers[0]]).includes('javascript:'), 'Unsafe links also omitted from copied text');
  check(!c.studyResultOf({ study: { ...single, scope: 'private-fulltext' } }, 'study'), 'Private/fulltext cache shape is rejected');
  check(!c.studyResultOf({ study: { ...single, schemaVersion: 2 } }, 'study'), 'Unknown cache schema is rejected');
  check(!c.studyResultOf({ study: { ...single, checklist: [{}] } }, 'study'), 'Unexpected checklist payload is rejected');
  same(c.studyFieldHtml({ status: 'available' }, 'results'), '<p class="study-field-text">摘要未提供</p>', 'Absent evidence is not invented');
  check(c.studyMissingReason('metadata_timeout').includes('暂未完成'));

  replies.push(new Error('Do not expose a provider URL or request body'));
  c.studyCheck(papers[2]); await flush();
  check(c.studyBoxHtml(papers[2]).includes('重查已有结果'));
  check(!c.studyBoxHtml(papers[2]).includes('provider URL'), 'Raw network error is never displayed');
  replies.push({ ok: true, found: false, canGenerate: true });
  c.studyCheck(papers[2], true); await flush();
  const metadataOnly = { ...result([{ ...papers[2], key: 'pmid:1003', status: 'unavailable', reason: 'metadata_error' }]), generatedAt: '', model: '', generatedBy: 'metadata-only', checklist: [], caveat: '未取得可用摘要，未调用模型。' };
  replies.push({ ok: false, error: 'no_abstract', study: metadataOnly });
  c.aiStudy(papers[2]); await flush();
  const missingHtml = c.studyBoxHtml(papers[2]);
  check(missingHtml.includes('摘要获取状态 · 未调用模型'), 'All-unavailable 422 result is visible without claiming generation');
  check(missingHtml.includes('公开摘要获取暂时失败'));
  check(missingHtml.includes('重新获取公开摘要'));
  check(!missingHtml.includes('本次生成'), 'Metadata-only status is not labelled as model output');
  replies.push({ ok: false, error: 'model_failed', detail: 'provider_budget' });
  c.aiStudy(papers[2]); await flush();
  check(c.studyBoxHtml(papers[2]).includes('调用次数已达上限'), 'Budget failure is presented as a budget issue');
  check(!c.studyBoxHtml(papers[2]).includes('引文未能'), 'Budget failure is not presented as evidence validation');
  delete compares[key];
  replies.push({ ok: true, found: true, compare: partial, canGenerate: false });
  c.compareCheck(); await flush();
  check(c.compareBoxHtml(papers).includes('读取已有结果'), 'Disabled generation still displays existing group cache');
  check(!c.compareBoxHtml(papers).includes('data-action="ai-compare"'));
  for (const detail of ['provider_network_error', 'provider_budget', 'budget_unavailable', 'model_redirect', 'endpoint_invalid', 'endpoint_insecure', 'fetch_dns', 'fetch_tls', 'fetch_connection', 'fetch_timeout']) {
    const message = c.aiErrorMessage({ error: 'model_failed', detail }, 'study');
    check(message && !message.includes(detail), 'Safe provider error: ' + detail);
  }
  check(!c.aiErrorMessage({ error: 'model_failed', detail: 'secret https://private.example' }, 'study').includes('private.example'));
  modalOpen = false;
  console.log(`${assertions} public-abstract study UI assertions passed`);
}
run().catch(e => { console.error(e); process.exitCode = 1; });
