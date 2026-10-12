  // ==== src/app/03-ai.js · AI services: shared request lifecycle (aiRun) and the six features ====
  // 一键 AI 解读：后端 /api/ql（Cloudflare _worker.js）。本地静态预览没有后端时自动隐藏按钮。
  function aiRequest(url, options = {}, onSlow = null) {
    // Bound headers and body even when an upstream ignores cancellation.
    const controller = new AbortController(), paid = options.method === 'POST';
    let deadlineTimer, slowTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => { const error = new Error('AI request deadline'); error.code = 'request_timeout'; reject(error); controller.abort(); }, paid ? 170000 : 15000);
    });
    if (paid && onSlow) slowTimer = setTimeout(onSlow, 45000);
    return Promise.race([fetch(url, { ...options, signal: controller.signal }).then(r => r.json()), deadline])
      .finally(() => { clearTimeout(deadlineTimer); if (slowTimer) clearTimeout(slowTimer); });
  }
  function aiTaskStatus(j) {
    const value = j?.taskStatus || j?.task?.status;
    return ['idle', 'waiting', 'completed', 'failed'].includes(value) ? value : '';
  }
  function aiWaitingMessage(j, timedOut = false) {
    const seconds = Number(j?.retryAfterSeconds || j?.task?.retryAfterSeconds || 0);
    return (timedOut ? '本次等待已到时限，完成状态尚未确认。' : '完成状态尚未确认。') + '请读取已有结果；不会自动重新提交。' + (seconds > 0 && seconds <= 180 ? '建议约 ' + Math.ceil(seconds) + ' 秒后重查。' : '');
  }
  function aiLookupRecord(j, previous, task, result) {
    if (j?.found && result) return { state: 'done', result, cached: true, canGenerate: !!j.canGenerate };
    if (!j?.ok) return { state: 'error', phase: 'lookup', msg: aiErrorMessage(j, task), canGenerate: false };
    const status = aiTaskStatus(j);
    if (status === 'waiting' || status === 'completed' || (previous?.state === 'waiting' && !status)) return { state: 'waiting', msg: aiWaitingMessage(j), canGenerate: false };
    if (status === 'failed') return { state: 'error', msg: aiErrorMessage({ ...j, ...j.task }, task), canGenerate: !!j.canGenerate };
    return { state: 'ready', canGenerate: !!j.canGenerate };
  }
  function aiPostRecord(j, task, result) {
    if (result && (j.ok || result.generatedBy === 'metadata-only')) return { state: 'done', result, cached: !!j.cached, canGenerate: j.canGenerate !== false };
    if (j.error === 'in_progress' || aiTaskStatus(j) === 'waiting') return { state: 'waiting', msg: aiWaitingMessage(j), canGenerate: false };
    return { state: 'error', msg: aiErrorMessage(j, task), canGenerate: j.error !== 'generation_off' && j.error !== 'not_configured' };
  }
  // ---- One request lifecycle shared by all six AI features ----
  // Quick-look, abstract translation, title translation, study structure, evidence compare and
  // brief all go through aiRun:
  //  · GET only reads a saved result (15 s limit) and never calls the model.
  //  · POST is the only paid call: a "taking longer" notice at 45 s, and at 170 s the page stops
  //    waiting. The outcome is then unknown, so the reader is offered "read the saved result"
  //    (a GET) instead of a second paid call.
  //  · A reply is applied only while current() says the request is still the newest one for
  //    its owner, so a late reply never overwrites newer state. after() always runs (re-render).
  function aiRun({ url, body, current, slow, ok, fail, after }) {
    const options = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { accept: 'application/json' } };
    return aiRequest(url, options, body && slow ? () => { if (current()) slow(); } : null)
      .then(j => { if (current()) ok(j); })
      .catch(error => { if (current()) fail(error); })
      .finally(after);
  }
  // A paid request whose reply never arrived: say so and point to the saved-result lookup.
  function aiUnconfirmed(error) { return aiWaitingMessage(null, error?.code === 'request_timeout'); }
  // Per-paper features keep their state on the paper (_ai*, _tr*, _tt*); each request takes a new token.
  function paperTask(paper, prefix) {
    const token = {};
    paper[prefix + 'Token'] = token;
    return () => paper[prefix + 'Token'] === token;
  }
  // Keyed features (study, compare, brief) store one record per key; a reply applies while that record is current.
  function recordTask(store, key, record) {
    store[key] = record;
    return () => store[key] === record;
  }
  function rerenderReader(paper) { if (state.activeDrawerPaper === paper) openReaderDrawer(paper); }
  function aiApiCheck(paper, retry = false) {
    if ((paper._aiChecked && !retry) || paper._aiLookupLoading || paper._aiState === 'loading' || (!paper.doi && !paper.pmid)) return;
    const previous = paper._aiState, current = paperTask(paper, '_ai');
    paper._aiChecked = 1; paper._aiLookupLoading = true; paper._aiState = 'checking';
    const k = paper.pmid ? 'pmid:' + paper.pmid : 'doi:' + String(paper.doi).toLowerCase();
    aiRun({ url: '/api/ql?k=' + encodeURIComponent(k), current,
      ok: j => {
        if (!j?.ok) throw Error('Lookup unavailable');
        if (j.found && j.ql) { LIVE_QL[qlKey(paper)] = j.ql; forgetPaper(paper); paper._aiState = 'done'; }
        else if (aiTaskStatus(j) === 'waiting' || aiTaskStatus(j) === 'completed' || (previous === 'waiting' && !aiTaskStatus(j))) { paper._aiState = 'waiting'; paper._aiMsg = aiWaitingMessage(j); }
        else { paper._aiState = j.canGenerate ? 'none' : 'off'; paper._aiMsg = aiTaskStatus(j) === 'failed' ? aiErrorMessage({...j, ...j.task}, 'quicklook') : ''; if (paper._aiMsg && j.canGenerate) paper._aiState = 'error'; }
      },
      fail: () => { paper._aiState = previous === 'waiting' ? 'waiting' : 'lookup-error'; paper._aiMsg = '已有解读读取失败，请重查；没有重新调用模型。'; },
      after: () => { if (current()) paper._aiLookupLoading = false; rerenderReader(paper); } });
  }
  // ---- 摘要翻译 / 多篇综述（同一后端 /api/ai，结果服务器端缓存、全站共享）----
  const LIVE_TR = {}; const BRIEFS = {}; let AI_AVAIL = null;
  const trKeyOf = p => p.pmid ? 'pmid:' + p.pmid : (p.doi ? 'doi:' + String(p.doi).toLowerCase() : '');
  function validTranslation(tr) {
    return !!(tr && typeof tr.abstract_zh === 'string' && tr.abstract_zh.trim());
  }
  function hydratePreGenerated(paper) {
    const record = preGeneratedOf(paper);
    if (!record) return;
    if (validTranslation(record.translation)) LIVE_TR[trKeyOf(paper)] = record.translation;
    const result = studyResultOf(record, 'study');
    if (result && result.papers.some(p => p.key === studyKey(paper))) STUDY_RESULTS[studyKey(paper)] = { state: 'done', result, cached: true, canGenerate: false };
  }
  function translationCanGenerate(paper) {
    return typeof paper._trCanGenerate === 'boolean' ? paper._trCanGenerate : AI_AVAIL;
  }
  function trCheck(paper, retry = false) {
    const k = trKeyOf(paper);
    if (!k || paper._trLookupState === 'loading' || paper._trState === 'loading' || (paper._trChecked && !retry)) return;
    const previous = paper._trState, current = paperTask(paper, '_tr');
    paper._trChecked = 1; paper._trLookupState = 'loading';
    aiRun({ url: '/api/ai?task=translate&k=' + encodeURIComponent(k), current,
      ok: j => {
        if (!j || j.ok === false) throw new Error('Translation lookup unavailable');
        paper._trLookupState = 'done';
        paper._trCanGenerate = typeof j.canGenerate === 'boolean' ? j.canGenerate : undefined;
        if (j.found && validTranslation(j.tr)) { LIVE_TR[k] = j.tr; if (!paper.titleZh) { paper.titleZh = j.tr.title_zh; forgetPaper(paper); } paper._trState = 'done'; }
        else if (aiTaskStatus(j) === 'waiting' || aiTaskStatus(j) === 'completed' || (previous === 'waiting' && !aiTaskStatus(j))) { paper._trState = 'waiting'; paper._trMsg = aiWaitingMessage(j); }
        else if (aiTaskStatus(j) === 'failed') { paper._trState = 'error'; paper._trMsg = aiErrorMessage({...j, ...j.task}, 'translate'); }
        else paper._trState = '';
      },
      fail: () => { paper._trLookupState = 'error'; if (previous === 'waiting') { paper._trState = 'waiting'; paper._trMsg = '已有译文读取失败，请重查；没有重新调用模型。'; } },
      after: () => rerenderReader(paper) });
  }
  function aiTranslate(paper) {
    const k = trKeyOf(paper); if (!k || ['loading', 'waiting'].includes(paper._trState) || paper._trLookupState === 'loading' || translationCanGenerate(paper) !== true) return;
    const current = paperTask(paper, '_tr'); paper._trState = 'loading'; paper._trSlow = false; openReaderDrawer(paper);
    aiRun({ url: '/api/ai', body: { task: 'translate', pmid: paper.pmid || '', doi: paper.doi || '' }, current,
      slow: () => { paper._trSlow = true; rerenderReader(paper); },
      ok: j => { if (j.ok && validTranslation(j.tr)) { LIVE_TR[k] = j.tr; if (!paper.titleZh) { paper.titleZh = j.tr.title_zh; forgetPaper(paper); } paper._trState = 'done'; } else if (j.error === 'in_progress' || aiTaskStatus(j) === 'waiting') { paper._trState = 'waiting'; paper._trMsg = aiWaitingMessage(j); } else { paper._trState = 'error'; paper._trMsg = aiErrorMessage(j, 'translate'); } },
      fail: error => { paper._trState = 'waiting'; paper._trMsg = aiUnconfirmed(error); },
      after: () => rerenderReader(paper) });
  }
  function aiTitle(paper) {
    if (!trKeyOf(paper) || ['loading', 'waiting', 'checking'].includes(paper._ttState)) return;
    const current = paperTask(paper, '_tt'); paper._ttState = 'loading'; paper._ttMsg = '翻译中…'; openReaderDrawer(paper);
    aiRun({ url: '/api/ai', body: { task: 'title', pmid: paper.pmid || '', doi: paper.doi || '' }, current,
      slow: () => { paper._ttMsg = '标题翻译用时较长，无需重复点击。'; rerenderReader(paper); },
      ok: j => { if (j.ok && j.tt) { paper.titleZh = j.tt.title_zh; forgetPaper(paper); paper._ttState = ''; paper._ttMsg = ''; } else { paper._ttState = j.error === 'in_progress' || aiTaskStatus(j) === 'waiting' ? 'waiting' : ''; paper._ttMsg = paper._ttState === 'waiting' ? aiWaitingMessage(j) : aiErrorMessage(j, 'title'); } },
      fail: error => { paper._ttState = 'waiting'; paper._ttMsg = aiUnconfirmed(error); },
      after: () => rerenderReader(paper) });
  }
  function aiTitleCheck(paper) {
    const k = trKeyOf(paper); if (!k || paper._ttState === 'checking' || paper._ttState === 'loading') return;
    const current = paperTask(paper, '_tt'); paper._ttState = 'checking';
    aiRun({ url: '/api/ai?task=title&k=' + encodeURIComponent(k), current,
      ok: j => { if (!j?.ok) throw Error('Title lookup unavailable'); if (j.found && j.tt?.title_zh) { paper.titleZh = j.tt.title_zh; forgetPaper(paper); paper._ttState = ''; paper._ttMsg = ''; } else if (['idle', 'failed'].includes(aiTaskStatus(j))) { paper._ttState = ''; paper._ttMsg = aiTaskStatus(j) === 'failed' ? aiErrorMessage({...j, ...j.task}, 'title') : '上次任务已结束，未查到标题译文。可点击重试。'; } else { paper._ttState = 'waiting'; paper._ttMsg = aiWaitingMessage(j); } },
      fail: () => { paper._ttState = 'waiting'; paper._ttMsg = '已有标题译文读取失败，请重查；没有重新调用模型。'; },
      after: () => rerenderReader(paper) });
  }
  function trBoxHtml(paper) {
    const tr = LIVE_TR[trKeyOf(paper)];
    const editorial = preGeneratedOf(paper)?.meta?.generationMeta?.translate?.origin === 'sol-session-public-abstract';
    if (validTranslation(tr)) return `<div class="tr-box">${tr.abstract_zh.split(/\n+/).map(t => `<p>${esc(t)}</p>`).join('')}<p class="translation-note">${editorial ? 'Sol 会话依据公开摘要整理译文，未经人工医学终审；以英文原文为准。' : '机器翻译，未经人工核对；以英文原文为准。'}</p></div>`;
    if (paper.weeklyPick) return '<div class="tr-box"><p class="ql-meta" role="status">本篇中文摘要尚未预生成。</p></div>';
    if (paper._trState === 'loading') return `<div class="tr-box"><p class="ql-meta" role="status">正在翻译摘要…${paper._trSlow ? '用时较长，无需重复点击。' : ''}</p></div>`;
    if (paper._trState === 'waiting') return `<div class="tr-box"><p class="ql-meta" role="status">${esc(paper._trMsg || aiWaitingMessage())}</p><button class="btn-sm" data-action="tr-check" data-paper-id="${esc(paper.id)}"${paper._trLookupState === 'loading' ? ' disabled' : ''}>读取已有译文</button></div>`;
    if (!(paper.pmid || paper.doi)) return '<p class="ql-meta" role="status">缺少文献标识，暂无法翻译。</p>';
    if (paper._trLookupState === 'error') return `<div class="tr-box"><p class="ql-meta" role="status">译文读取失败。</p><button class="btn-sm" data-action="tr-check" data-paper-id="${esc(paper.id)}">重新读取译文</button></div>`;
    if (paper._trLookupState !== 'done') return '<div class="tr-box"><p class="ql-meta" role="status">正在读取已有译文…</p></div>';
    if (translationCanGenerate(paper) === null) return '<div class="tr-box"><p class="ql-meta" role="status">正在检查翻译服务…</p></div>';
    if (!translationCanGenerate(paper)) return '<div class="tr-box"><p class="ql-meta" role="status">暂无译文，翻译服务暂不可用。</p></div>';
    return `<div class="tr-box">${paper._trState === 'error' ? `<p class="translation-error" role="status">${esc(paper._trMsg || '译文未生成，请重试。')}</p>` : '<p class="ql-meta">暂无中文译文。</p>'}<button class="btn-sm" data-action="ai-translate" data-paper-id="${esc(paper.id)}">${paper._trState === 'error' ? '重试翻译' : '翻译摘要（中英对照）'}</button></div>`;
  }
  function abstractTranslationStatus(paper) {
    if (validTranslation(LIVE_TR[trKeyOf(paper)])) return '中英对照';
    if (paper._trState === 'loading') return '译文生成中';
    if (paper._trState === 'waiting') return '译文状态待确认';
    if (paper._trState === 'error' || paper._trLookupState === 'error') return '译文暂不可用';
    return paper.weeklyPick ? '译文待预生成' : '译文未生成';
  }
  function briefItems(list) {
    const seen = new Set(), result = [];
    for (const p of list) {
      const pmid = /^\d{1,9}$/.test(String(p.pmid || '')) ? String(p.pmid) : '';
      const doi = exactDoi(p.doi || '');
      const keys = [pmid && 'pmid:' + pmid, doi && 'doi:' + doi].filter(Boolean);
      if (!keys.length || keys.some(k => seen.has(k))) continue;
      keys.forEach(k => seen.add(k)); result.push({pmid, doi});
      if (result.length === 8) break;
    }
    return result;
  }
  function briefKey(mode, items) { return mode + '|' + items.map(x => x.pmid || x.doi).sort().join(','); }
  function validBrief(value) {
    return value && typeof value.theme === 'string' && typeof value.compare === 'string' && typeof value.caveat === 'string'
      && Array.isArray(value.refs) && value.refs.length >= 2 && value.refs.length <= 8
      && value.refs.every(r => r && typeof r.title === 'string')
      && Array.isArray(value.papers) && value.papers.length === value.refs.length
      && value.papers.every(p => p && Number.isInteger(p.n) && p.n >= 1 && p.n <= value.refs.length && typeof p.point === 'string')
      && new Set(value.papers.map(p => p.n)).size === value.refs.length
      && Array.isArray(value.questions) && value.questions.every(q => typeof q === 'string');
  }
  function aiBrief(mode, list, rerender) {
    const items = briefItems(list); if (items.length < 2) { showToast('至少需要 2 篇有 PMID/DOI 的文献'); return; }
    const k = briefKey(mode, items);
    if (BRIEFS[k] && ['loading', 'waiting'].includes(BRIEFS[k].state)) return;
    const record = { state: 'loading', slow: false }, isRecord = recordTask(BRIEFS, k, record);
    rerender();
    aiRun({ url: '/api/ai', body: { task: 'brief', mode, items }, current: () => isRecord() && record.state === 'loading',
      slow: () => { record.slow = true; rerender(); },
      ok: j => { BRIEFS[k] = j.ok && validBrief(j.brief) ? { state: 'done', brief: j.brief } : j.error === 'in_progress' || aiTaskStatus(j) === 'waiting' ? { state: 'waiting', msg: aiWaitingMessage(j) } : { state: 'error', msg: j.ok ? '综述结果不完整，未展示。请重试。' : aiErrorMessage(j, 'brief') }; },
      fail: error => { BRIEFS[k] = { state: 'waiting', timedOut: error?.code === 'request_timeout' }; },
      after: () => rerender() });
  }
  function briefLookup(mode, list, rerender) {
    const items = briefItems(list); if (items.length < 2) return;
    const k = briefKey(mode, items), record = BRIEFS[k];
    if (!record || record.state !== 'waiting' || record.checking) return;
    record.checking = true; rerender();
    const keys = items.map(x => x.pmid ? 'pmid:' + x.pmid : 'doi:' + x.doi);
    aiRun({ url: '/api/ai?task=brief&mode=' + encodeURIComponent(mode) + '&keys=' + encodeURIComponent(JSON.stringify(keys)), current: () => BRIEFS[k] === record,
      ok: j => {
        if (j.ok && j.found && validBrief(j.brief)) BRIEFS[k] = {state: 'done', brief: j.brief};
        else if (j.ok && ['idle', 'failed'].includes(aiTaskStatus(j))) BRIEFS[k] = {state: 'error', msg: aiTaskStatus(j) === 'failed' ? aiErrorMessage({...j, ...j.task}, 'brief') : '上次任务已结束，未查到已保存结果。可点击重新生成。'};
        else { record.checking = false; record.msg = j.ok && !j.found ? '尚未查到已保存结果，可稍后再查；没有重新调用模型。' : '已有结果暂不可读，可稍后再查。'; }
      },
      fail: () => { record.checking = false; record.msg = '已有结果读取失败，可稍后再查；没有重新调用模型。'; },
      after: () => rerender() });
  }
  function briefHtml(mode, list) {
    const items = briefItems(list); if (items.length < 2) return '';
    const k = briefKey(mode, items), b = BRIEFS[k];
    const label = mode === 'huddle' ? 'AI 生成前 ' + items.length + ' 篇讨论提纲' : 'AI 综述前 ' + items.length + ' 篇';
    const help = '按当前顺序选最多 8 篇有标识的不同文献；基于可取得的公开摘要，结果全站共享。耗时随摘要与服务响应而变化。';
    if (!b || b.state === 'error') return `<div class="brief-box">${b ? `<p class="ql-meta" role="status">${esc(b.msg)}</p>` : ''}<button class="btn-sm ${mode === 'digest' && !b ? 'brief-start' : 'btn-primary'}" data-action="ai-brief" data-mode="${mode}" title="${help}">${mode === 'digest' && !b ? '<span aria-hidden="true">✦</span> ' : ''}${label}</button><span class="text-muted brief-help">${help}</span></div>`;
    if (b.state === 'loading') return `<div class="brief-box" aria-busy="true"><p class="ql-meta" role="status">正在读取摘要并生成，请稍候…${b.slow ? '用时较长，无需重复点击；不会自动重新提交。' : ''}</p></div>`;
    if (b.state === 'waiting') return `<div class="brief-box"><p class="ql-meta" role="status">${b.timedOut ? '本次等待已到时限，完成状态尚未确认' : '网络中断，完成状态尚未确认'}；后台可能仍在处理，未重新提交。</p>${b.msg ? `<p class="ql-meta" role="status">${esc(b.msg)}</p>` : ''}<button class="btn-sm" data-action="brief-check" data-mode="${mode}"${b.checking ? ' disabled' : ''}>${b.checking ? '读取中…' : '读取已有综述'}</button></div>`;
    const r = b.brief;
    const included = r.refs.length, omitted = Math.max(0, items.length - included);
    return `<div class="brief-box brief-done"><div class="drawer-section-title">${mode === 'huddle' ? '讨论提纲' : '综述速读'} <small class="ql-flag">模型根据公开摘要生成 · 未经人工核对</small></div>
      <p class="brief-coverage" role="status">请求 ${items.length} 篇 · 实际纳入 ${included} 篇${omitted ? ` · ${omitted} 篇公开摘要未纳入，下面结果只对应已纳入文献` : ''}</p>
      <p class="ql-line"><strong>${esc(r.theme)}</strong></p>
      <ol class="brief-papers">${r.papers.map(x => `<li>${esc(x.point)}<small> ——《${esc((r.refs[x.n - 1] || {}).title || '')}》</small></li>`).join('')}</ol>
      <p class="ql-meta"><b>共同点与分歧：</b>${esc(r.compare)}</p>
      <p class="ql-meta"><b>${mode === 'huddle' ? '讨论问题' : '值得追问'}：</b></p><ul>${r.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>
      <p class="ql-meta"><b>证据边界：</b>${esc(r.caveat)}</p></div>`;
  }
  function renderDigestBar(list) {
    const el = $('#aiDigest'); if (!el) return;
    if (list) state._digestList = list;
    const l = state._digestList || [];
    const top = briefItems(l);
    if (exactDoi(state.search) || AI_AVAIL !== true || state.mode === 'weekly' || top.length < 2) { el.hidden = true; el.innerHTML = ''; return; }
    // Before the first request the button sits in the toolbar; progress and the
    // result move below it so the sticky toolbar never grows.
    const idle = !BRIEFS[briefKey('digest', briefItems(top))];
    const home = idle ? $('.stream-controls') : $('.stream-toolbar');
    if (home && idle && el.parentElement !== home) home.prepend(el);
    if (home && !idle && el.previousElementSibling !== home) home.after(el);
    el.classList.toggle('digest-idle', idle);
    el.hidden = false; el.innerHTML = briefHtml('digest', top);
  }
  // ---- Public-abstract study services: GET only reads cache; POST requires a click. ----
  const STUDY_FIELDS = [['question', '研究问题'], ['population', '研究对象'], ['design', '研究设计'], ['comparator', '干预与对照'], ['endpoints', '研究终点'], ['results', '主要结果']];
  const STUDY_RESULTS = {}; const COMPARE_RESULTS = {};
  function studyKey(p) {
    return p.pmid ? 'pmid:' + String(p.pmid) : (p.doi ? 'doi:' + String(p.doi).toLowerCase() : '');
  }
  function studyIds(p) {
    return { pmid: p.pmid ? String(p.pmid) : '', doi: p.doi ? String(p.doi) : '' };
  }
  function selectedComparePapers() {
    const seen = new Set();
    return state.huddle.filter(id => state.huddleCompare.includes(id)).map(huddlePaper).filter(p => {
      const key = p && studyKey(p);
      const doi = p?.doi && 'doi:' + String(p.doi).toLowerCase();
      if (!key || seen.has(key) || (doi && seen.has(doi))) return false;
      seen.add(key); if (doi) seen.add(doi); return true;
    });
  }
  function compareKey(list) {
    return JSON.stringify(list.map(studyKey).sort());
  }
  function setCompareSelection(id, checked) {
    const paper = huddlePaper(id);
    if (!state.huddle.includes(id) || !paper || !studyKey(paper)) return false;
    if (!checked) { state.huddleCompare = state.huddleCompare.filter(x => x !== id); return true; }
    if (state.huddleCompare.includes(id)) return true;
    const selected = selectedComparePapers();
    if (selected.length >= 4) { showToast('最多选择 4 篇，请先取消一篇'); return false; }
    if (selected.some(p => studyKey(p) === studyKey(paper) || (p.doi && paper.doi && String(p.doi).toLowerCase() === String(paper.doi).toLowerCase()))) { showToast('这篇文献已在对照中，请勿重复选择'); return false; }
    state.huddleCompare.push(id); return true;
  }
  function studyResultOf(j, task) {
    const r = j && j[task];
    if (!r || r.schemaVersion !== 1 || r.scope !== 'public-abstract' || !Array.isArray(r.papers) || r.papers.length > 4) return null;
    if (!Array.isArray(r.checklist) || r.checklist.some(x => typeof x !== 'string')) return null;
    if (r.papers.some(p => !p || typeof p.key !== 'string' || !['available', 'unavailable'].includes(p.status))) return null;
    return r;
  }
  function studyMissingReason(reason) {
    return { no_abstract: '未找到公开摘要', metadata_timeout: '公开摘要获取暂未完成', metadata_error: '公开摘要获取暂时失败', abstract_too_long: '公开摘要超过处理范围', missing_result: '此篇未返回可核对结果', request_timeout: '本次任务未能在时限内完成' }[reason] || '此篇公开摘要暂不可用';
  }
  function studyRows(result, requested) {
    // Keep every selected paper visible, including unavailable or omitted items.
    return requested.map((p, i) => {
      const key = studyKey(p);
      const row = result.papers.find(x => x.key === key || (p.pmid && x.pmid && String(x.pmid) === String(p.pmid)) || (p.doi && x.doi && String(x.doi).toLowerCase() === String(p.doi).toLowerCase()));
      return row ? { ...row, n: i + 1 } : { ...studyIds(p), key, n: i + 1, title: p.title || '', journal: p.cleanJournal || p.journal || '', status: 'unavailable', reason: 'missing_result' };
    });
  }
  function studyFieldHtml(paper, field) {
    if (paper.status !== 'available') return '<span class="study-missing">' + esc(studyMissingReason(paper.reason)) + '</span>';
    const value = paper[field];
    const text = value && typeof value.text === 'string' && value.text ? value.text : '摘要未提供';
    const quote = value && typeof value.quote === 'string' ? value.quote : '';
    return `<p class="study-field-text">${esc(text)}</p>${quote ? `<details class="study-quote"><summary>核对摘要原句</summary><blockquote>${esc(quote)}</blockquote></details>` : ''}`;
  }
  function studySourceHtml(paper) {
    const url = safeSourceUrl({ url: paper.source_url || '' });
    const source = paper.abstract_source || '公开摘要';
    return `<span>${esc(source)}</span>${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">摘要来源 ↗</a>` : ''}`;
  }
  function studyMetaHtml(result, cached) {
    const time = result.generatedAt ? contentDate(result.generatedAt) : '';
    return `<p class="study-boundary">仅根据公开摘要生成，未经人工核对。各篇结果不作质量排名，不合并效应量。</p><p class="study-meta">${result.generatedBy === 'metadata-only' ? '摘要获取状态 · 未调用模型' : cached ? '读取已有结果' : '本次生成'}${time ? ' · 生成时间（北京时间）：' + esc(time) : ''}${result.model ? ' · ' + esc(result.model) : ''}</p>`;
  }
  function studyChecklistHtml(result) {
    return `<details class="study-checklist"><summary>全文核对清单（待查事项）</summary><p>以下是阅读全文时需要核对的问题，并非已发现论文存在这些缺陷。</p><ul>${result.checklist.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>${result.caveat ? `<p class="study-boundary">${esc(result.caveat)}</p>` : ''}`;
  }
  function studyResultHtml(result, requested, cached, task) {
    const rows = studyRows(result, requested);
    const content = task === 'compare'
      ? `<div class="study-table-scroll" role="region" aria-label="逐篇公开摘要证据对照表" tabindex="0"><table class="study-table"><caption>逐篇证据对照 · 可横向滚动</caption><thead><tr><th scope="col">核对项目</th>${rows.map(p => `<th scope="col"><span class="study-paper-number">${p.n}.</span> ${esc(p.title)}<small>${esc(p.journal || '')}</small>${journalMetricBadge(p)}${journalMetricDetails(p)}${p.status !== 'available' ? `<small class="study-missing">${esc(studyMissingReason(p.reason))}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${STUDY_FIELDS.map(([field, label]) => `<tr><th scope="row">${label}</th>${rows.map(p => `<td>${studyFieldHtml(p, field)}</td>`).join('')}</tr>`).join('')}<tr><th scope="row">摘要来源</th>${rows.map(p => `<td>${studySourceHtml(p)}</td>`).join('')}</tr></tbody></table></div>`
      : rows.map(p => `<div class="study-paper">${p.status !== 'available' ? `<p class="study-missing">${esc(studyMissingReason(p.reason))}</p>` : ''}<dl class="study-fields">${STUDY_FIELDS.map(([field, label]) => `<div><dt>${label}</dt><dd>${studyFieldHtml(p, field)}</dd></div>`).join('')}</dl><p class="study-meta">${studySourceHtml(p)}</p></div>`).join('');
    return studyMetaHtml(result, cached) + content + studyChecklistHtml(result) + `<button class="btn-sm" data-action="study-copy" data-task="${task}"${task === 'study' ? ` data-paper-id="${esc(requested[0].id)}"` : ''}>复制${task === 'compare' ? '证据对照' : '研究结构'}与核对清单</button>`;
  }
  function studyBoxHtml(paper) {
    const key = studyKey(paper); if (!key) return '';
    const rec = STUDY_RESULTS[key];
    if (!rec && paper.weeklyPick) return '';
    let content = '<p class="study-meta" role="status">正在检查已有结果，不会调用模型…</p>';
    if (!rec && paper.weeklyPick) content = '<p class="study-meta" role="status">本篇研究结构尚未预生成。</p>';
    else if (rec?.state === 'done') content = studyResultHtml(rec.result, [paper], rec.cached, 'study') + (rec.result.generatedBy === 'metadata-only' && rec.canGenerate ? `<button class="btn-sm" data-action="ai-study" data-paper-id="${esc(paper.id)}">重新获取公开摘要</button>` : '');
    else if (rec?.state === 'loading') content = `<p class="study-meta" role="status">正在从公开来源读取摘要并提取研究结构，请稍候…${rec.slow ? '用时较长，无需重复点击。' : ''}</p>`;
    else if (rec?.state === 'waiting') content = `<p class="study-meta" role="status">${esc(rec.msg || aiWaitingMessage())}</p><button class="btn-sm" data-action="study-check" data-paper-id="${esc(paper.id)}">读取已有研究结构</button>`;
    else if (rec && rec.state !== 'checking') {
      content = (rec.msg ? `<p class="study-error" role="status">${esc(rec.msg)}</p>` : '') + (rec.canGenerate ? `<button class="btn-sm" data-action="ai-study" data-paper-id="${esc(paper.id)}">${rec.state === 'error' ? '重试生成研究结构' : '提取研究结构与核对清单'}</button><p class="study-meta">点击后由模型读取公开摘要；不会读取全文。</p>` : `<p class="study-meta">${rec.phase === 'lookup' ? '尚未读取到已有结果。' : '研究结构服务暂未开放。已有缓存仍可阅读。'}</p>${rec.phase === 'lookup' ? `<button class="btn-sm" data-action="study-check" data-paper-id="${esc(paper.id)}">重查已有结果</button>` : ''}`);
    }
    return `<section class="drawer-section study-box" aria-label="研究结构与全文核对"><div class="drawer-section-title">研究结构与全文核对 <small>公开摘要服务</small></div>${content}</section>`;
  }
  function studyCheck(paper, retry = false) {
    const key = studyKey(paper), previous = STUDY_RESULTS[key];
    if (!key || previous?.state === 'checking' || previous?.state === 'loading' || (previous && !retry)) return;
    aiRun({ url: '/api/ai?task=study&k=' + encodeURIComponent(key), current: recordTask(STUDY_RESULTS, key, { state: 'checking', previous }),
      ok: j => { STUDY_RESULTS[key] = aiLookupRecord(j, previous, 'study', studyResultOf(j, 'study')); },
      fail: () => { STUDY_RESULTS[key] = aiLookupFailure(previous); },
      after: () => rerenderReader(paper) });
  }
  // A failed saved-result lookup keeps an earlier "waiting" state; otherwise it allows a retry.
  function aiLookupFailure(previous) {
    return previous?.state === 'waiting' ? { ...previous, msg: '已有结果读取失败，请重查；没有重新调用模型。' } : { state: 'error', phase: 'lookup', msg: '无法读取已有结果，请稍后重试。', canGenerate: false };
  }
  function aiStudy(paper) {
    const key = studyKey(paper), previous = STUDY_RESULTS[key];
    if (!key || !previous?.canGenerate || ['loading', 'checking', 'waiting'].includes(previous.state)) return;
    const record = { state: 'loading', canGenerate: false }, current = recordTask(STUDY_RESULTS, key, record); openReaderDrawer(paper);
    aiRun({ url: '/api/ai', body: { task: 'study', ...studyIds(paper) }, current,
      slow: () => { record.slow = true; rerenderReader(paper); },
      ok: j => { STUDY_RESULTS[key] = aiPostRecord(j, 'study', studyResultOf(j, 'study')); },
      fail: error => { STUDY_RESULTS[key] = { state: 'waiting', msg: aiUnconfirmed(error), canGenerate: false }; },
      after: () => rerenderReader(paper) });
  }
  function compareBoxHtml(list) {
    const selected = selectedComparePapers(), valid = selected.length >= 2 && selected.length <= 4;
    const key = valid ? compareKey(selected) : '', rec = key && COMPARE_RESULTS[key];
    let content = '<p class="study-meta">请在上方明确勾选 2–4 篇有 PMID/DOI 的文献。</p>';
    if (valid) {
      if (rec?.state === 'done') content = studyResultHtml(rec.result, selected, rec.cached, 'compare') + (rec.result.generatedBy === 'metadata-only' && rec.canGenerate ? '<button class="btn-sm" data-action="ai-compare">重新获取所选文献的公开摘要</button>' : '');
      else if (!rec || rec.state === 'checking') content = '<p class="study-meta" role="status">正在检查这组文献的已有结果，不会调用模型…</p>';
      else if (rec.state === 'loading') content = `<p class="study-meta" role="status">正在逐篇读取公开摘要并整理证据对照，请稍候…${rec.slow ? '用时较长，无需重复点击。' : ''}</p>`;
      else if (rec.state === 'waiting') content = `<p class="study-meta" role="status">${esc(rec.msg || aiWaitingMessage())}</p><button class="btn-sm" data-action="compare-check">读取已有证据对照</button>`;
      else content = (rec.msg ? `<p class="study-error" role="status">${esc(rec.msg)}</p>` : '') + (rec.canGenerate ? `<button class="btn-sm btn-primary" data-action="ai-compare">${rec.state === 'error' ? '重试' : '生成'}所选 ${selected.length} 篇证据对照</button><p class="study-meta">点击后调用模型。仅发送文献标识，不发送个人清单文本；无摘要文献仍保留在结果中。</p>` : `<p class="study-meta">${rec.phase === 'lookup' ? '尚未读取到这组文献的已有结果。' : '证据对照服务暂未开放。已有缓存仍可阅读。'}</p>${rec.phase === 'lookup' ? '<button class="btn-sm" data-action="compare-check">重查已有结果</button>' : ''}`);
    }
    return `<section class="study-box compare-box" aria-label="精选证据对照" tabindex="-1"><div class="drawer-section-title">精选证据对照 <small>已选 ${selected.length}/4 篇</small></div><p class="study-boundary">按各篇公开摘要逐项核对研究问题、对象、设计、对照、终点与结果。不会据此排名或合并研究结论。</p>${content}</section>`;
  }
  function compareCheck(retry = false) {
    const list = selectedComparePapers(); if (list.length < 2 || list.length > 4) return;
    const key = compareKey(list), previous = COMPARE_RESULTS[key];
    if (previous?.state === 'checking' || previous?.state === 'loading' || (previous && !retry)) return;
    aiRun({ url: '/api/ai?task=compare&keys=' + encodeURIComponent(key), current: recordTask(COMPARE_RESULTS, key, { state: 'checking', previous }),
      ok: j => { COMPARE_RESULTS[key] = aiLookupRecord(j, previous, 'compare', studyResultOf(j, 'compare')); },
      fail: () => { COMPARE_RESULTS[key] = aiLookupFailure(previous); },
      after: () => rerenderCompare(key) });
  }
  function rerenderCompare(key) { if ($('#huddleModalBackdrop.open') && compareKey(selectedComparePapers()) === key) openHuddleModal(); }
  function aiCompare() {
    const list = selectedComparePapers(); if (list.length < 2 || list.length > 4) { showToast('请明确选择 2–4 篇有 PMID/DOI 的文献'); return; }
    const key = compareKey(list), previous = COMPARE_RESULTS[key];
    if (!previous?.canGenerate || ['loading', 'checking', 'waiting'].includes(previous.state)) return;
    const record = { state: 'loading', canGenerate: false }, current = recordTask(COMPARE_RESULTS, key, record); openHuddleModal();
    aiRun({ url: '/api/ai', body: { task: 'compare', items: list.map(studyIds) }, current,
      slow: () => { record.slow = true; rerenderCompare(key); },
      ok: j => { COMPARE_RESULTS[key] = aiPostRecord(j, 'compare', studyResultOf(j, 'compare')); },
      fail: error => { COMPARE_RESULTS[key] = { state: 'waiting', msg: aiUnconfirmed(error), canGenerate: false }; },
      after: () => rerenderCompare(key) });
  }
  function studyCopyText(result, requested) {
    let text = '公开摘要研究结构与证据对照（未经人工核对）\n不作质量排名，不合并效应量。\n';
    studyRows(result, requested).forEach(p => {
      text += `\n${p.n}. ${p.title}\n${p.journal || ''}\n期刊指标：${journalMetricText(p)}\n`;
      if (p.status !== 'available') text += studyMissingReason(p.reason) + '\n';
      else STUDY_FIELDS.forEach(([field, label]) => {
        const value = p[field];
        text += `${label}：${value && typeof value.text === 'string' ? value.text : '摘要未提供'}\n`;
        if (value && typeof value.quote === 'string' && value.quote) text += `摘要原句：${value.quote}\n`;
      });
      const source = safeSourceUrl({ url: p.source_url || '' });
      text += `摘要来源：${p.abstract_source || '公开摘要'}${source ? ' ' + source : ''}\n`;
    });
    text += '\n全文核对清单（待查事项，并非已发现的论文缺陷）\n' + result.checklist.map(x => '- ' + x).join('\n');
    if (result.caveat) text += '\n证据边界：' + result.caveat;
    if (result.generatedAt) text += '\n生成时间：' + result.generatedAt;
    return text;
  }
  // ---- End public-abstract study services. ----
  const AI_ERR = { daily_cap: '今日 AI 解读额度已用完，明天再试。', ip_cap: '你今天的解读次数已达上限。', no_abstract: '本次已完成的公开来源查询未取得可用摘要。可查看官方原文。', metadata_timeout: '公开摘要读取超时，未生成结果。请稍后重试。', metadata_error: '公开摘要来源暂时不可读，未生成结果。请稍后重试。', request_timeout: '本次任务未能在时限内完成，未保存结果。可点击重试。', task_timeout: '本次任务未能在时限内完成，未保存结果。可点击重试。', task_cancelled: '本次任务已取消，未保存结果。可点击重试。',
    model_failed: 'AI 服务未能完成处理，未保存。请稍后重试。', in_progress: '该任务仍在处理中，请读取已有结果确认进度。',
    generation_off: 'AI 功能暂未开放。', not_configured: 'AI 服务尚未配置完成，需要维护者处理。', server: '服务暂时出错，请稍后重试。', need_two: '至少需要 2 篇文献。', bad_key: '这篇缺少 PMID/DOI，无法处理。' };
  const AI_MODEL_ERR = {
    provider_auth: 'AI 服务认证失败，需要维护者修复配置。',
    provider_rate_limit: '模型服务暂时限流，请稍后重试。',
    provider_unavailable: '模型服务暂不可用，请稍后重试。',
    request_timeout: '模型服务响应超时，请稍后重试。',
    provider_network_error: '模型服务处理时发生网络错误，请稍后重试。',
    provider_budget: '今天的模型调用次数已达上限；已保存结果仍可阅读。',
    budget_unavailable: '暂时无法核对模型调用额度，请稍后重试。',
    model_redirect: '模型接口地址发生跳转，需要维护者检查配置。',
    endpoint_invalid: '模型接口地址配置无效，需要维护者处理。',
    endpoint_insecure: '模型接口需要使用有效的 HTTPS 地址。',
    fetch_dns: '暂时无法连接模型服务，请稍后重试。',
    fetch_tls: '暂时无法连接模型服务，请稍后重试。',
    fetch_connection: '暂时无法连接模型服务，请稍后重试。',
    fetch_timeout: '暂时无法连接模型服务，请稍后重试。',
    transport_error: '暂时无法连接模型服务，请稍后重试。',
    output_truncated: '模型结果未完整返回，已自动重试但仍未完成，未保存。请稍后重试。',
    output_json: '模型结果格式不正确，已自动重试，未保存。请稍后重试。',
    output_shape: '模型没有返回可用结果，未保存。请稍后重试。',
    output_empty: '模型返回了空结果，未保存。请稍后重试。',
    output_blocked: '模型服务没有提供这次结果，未保存。',
    output_incomplete: '模型未正常完成这次处理，未保存。请稍后重试。',
    context_limit: '摘要超出了模型服务的处理范围，需要维护者检查配置。',
    missing_numbers: '译文遗漏了原文数字，未保存。请重试。',
    quote_not_in_abstract: 'AI 要点的引文未能在原摘要中核对，未保存。请重试。'
  };
  function aiErrorMessage(result, task) {
    if (result?.error !== 'model_failed') return AI_ERR[result?.error] || 'AI 服务暂时出错，请稍后重试。';
    const detail = String(result.detail || '');
    if (detail === 'unsupported_numbers') return (task === 'translate' || task === 'title' ? '译文' : 'AI 结果') + '包含与原文不符的数字，未保存。请重试。';
    if (/^(?:invalid_[a-z_]+|model_not_object|not_object)$/.test(detail)) return '模型结果未符合格式要求，未保存。请重试。';
    return AI_MODEL_ERR[detail] || AI_ERR.model_failed;
  }
  function aiInterpret(paper) {
    if (['loading', 'waiting', 'checking', 'lookup-error'].includes(paper._aiState)) return;
    const current = paperTask(paper, '_ai'); paper._aiState = 'loading'; paper._aiSlow = false; openReaderDrawer(paper);
    aiRun({ url: '/api/ql', body: { pmid: paper.pmid || '', doi: paper.doi || '' }, current,
      slow: () => { paper._aiSlow = true; rerenderReader(paper); },
      ok: j => {
        if (j.ok && j.ql) { LIVE_QL[qlKey(paper)] = j.ql; forgetPaper(paper); paper._aiState = 'done'; }
        else if (j.error === 'in_progress' || aiTaskStatus(j) === 'waiting') { paper._aiState = 'waiting'; paper._aiMsg = aiWaitingMessage(j); }
        else if (j.error === 'no_abstract') { paper._aiState = 'noabs'; }
        else { paper._aiState = 'error'; paper._aiMsg = aiErrorMessage(j, 'quicklook'); }
      },
      fail: error => { paper._aiState = 'waiting'; paper._aiMsg = aiUnconfirmed(error); },
      after: () => rerenderReader(paper) });
  }
