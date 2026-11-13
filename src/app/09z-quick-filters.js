  // ==== src/app/09z-quick-filters.js · 列表顶栏快捷筛选条 ====
  const QF_RECENT_KEY = 'xz_recent_journals';
  const QF_PRESET_KEY = 'xz_filter_presets';
  const QF_DESIGN_OPTS = [
    ['', '全部设计'],
    ['RCT', 'RCT 随机对照'],
    ['RCT 二次分析', 'RCT 二次分析'],
    ['二次分析', '二次分析（母研究待核验）'],
    ['已撤稿', '已撤稿'],
    ['存在关注声明', '存在关注声明'],
    ['撤稿声明', '撤稿声明'],
    ['关注声明', '关注声明'],
    ['更正声明', '更正声明'],
    ['队列研究', '队列研究'],
    ['病例对照研究', '病例对照研究'],
    ['Meta/综述', 'Meta/系统综述'],
    ['方法/模型验证', '方法/模型验证'],
    ['指南共识', '指南共识'],
    ['述评观点', '述评观点'],
    ['叙述综述', '叙述综述'],
    ['研究方案', '研究方案'],
    ['横断面研究', '横断面研究'],
    ['病例报告', '病例报告'],
    ['研究类型待核验', '研究类型待核验']
  ];

  let qfOpen = null; // { kind, query }

  function loadRecentJournals() {
    try {
      const a = JSON.parse(safeGet(QF_RECENT_KEY) || '[]');
      return Array.isArray(a) ? a.filter(x => typeof x === 'string') : [];
    } catch (e) { return []; }
  }
  function rememberJournal(name) {
    if (!name) return;
    const list = loadRecentJournals().filter(j => j !== name);
    list.unshift(name);
    safeSet(QF_RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  }
  function loadFilterPresets() {
    try {
      const a = JSON.parse(safeGet(QF_PRESET_KEY) || '[]');
      return Array.isArray(a) ? a.filter(x => x && typeof x === 'object') : [];
    } catch (e) { return []; }
  }
  function qfSnapshot() {
    return {
      lane: state.lane,
      range: state.range,
      ftFilter: state.ftFilter,
      reading: state.reading,
      favoritesOnly: state.favoritesOnly,
      excludeCaseReports: state.excludeCaseReports,
      journals: selectedJournals().slice(),
      journalTier: state.journalTier || '',
      clinicalTier: state.clinicalTier,
      publisher: state.publisher,
      studyDesign: state.studyDesign,
      tag: state.tag,
      minor: state.minor
    };
  }
  function qfRestore(data) {
    if (!data || typeof data !== 'object') return;
    ['lane', 'range', 'ftFilter', 'reading', 'favoritesOnly', 'excludeCaseReports',
      'clinicalTier', 'publisher', 'studyDesign', 'tag', 'minor'].forEach(k => {
      if (k in data) state[k] = data[k];
    });
    state.journals = Array.isArray(data.journals) ? data.journals.slice() : [];
    state.journalTier = data.journalTier || '';
    state.journal = state.journals[0] || '';
  }
  function saveFilterPreset(name) {
    const presets = loadFilterPresets();
    const label = String(name || '').trim() || ('预设 ' + (presets.length + 1));
    presets.push({ id: Date.now(), name: label, data: qfSnapshot() });
    safeSet(QF_PRESET_KEY, JSON.stringify(presets.slice(-20)));
    if (typeof showToast === 'function') showToast('已保存「' + label + '」，可在 ⋯ 中取用；不会自动套用');
  }
  function applyFilterPreset(id) {
    const p = loadFilterPresets().find(x => String(x.id) === String(id));
    if (!p) return;
    qfRestore(p.data);
    qfApply();
  }
  function deleteFilterPreset(id) {
    safeSet(QF_PRESET_KEY, JSON.stringify(loadFilterPresets().filter(x => String(x.id) !== String(id))));
  }

  function qfPapers() {
    if (state.mode === 'weekly') {
      try { return weeklyPublicationWindow(FEEDS.items, Date.now()).entries.map(e => e.paper); }
      catch (e) { return (FEEDS && FEEDS.items) || []; }
    }
    if (state.mode === 'sources') return [];
    return getCurrentDataset();
  }
  function matchesQuickFilters(p) {
    if (state.favoritesOnly && !state.favoriteJournals.includes(p.cleanJournal || p.journal || '')) return false;
    if (state.excludeCaseReports && isCaseReport(p)) return false;
    if (!matchesSidebarFilters(p)) return false;
    return true;
  }

  const JT = () => (typeof window !== 'undefined' && window.XINZHI_JOURNAL_TIERS) || null;
  function normJournal(name) {
    const api = JT();
    return api ? api.normalizeJournalName(name) : String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }
  function paperJournalKey(p) {
    const name = typeof cardJournalName === 'function' ? cardJournalName(p) : (p && (p.cleanJournal || p.journal)) || '';
    if (!name || name === '期刊待补') return '';
    if (typeof isInternalSourceName === 'function' && isInternalSourceName(name)) return '';
    const api = JT();
    return api ? api.canonName(name) : name;
  }
  function paperTierId(p) {
    const name = paperJournalKey(p);
    if (!name) return '';
    const api = JT();
    return api ? api.tierOfName(name) : 'other';
  }
  function paperMatchesJournalFilter(p) {
    if (!state.journalTier && !(selectedJournals().length)) return true;
    const name = paperJournalKey(p);
    if (!name) return false;
    const js = selectedJournals();
    if (js.length) {
      const set = new Set(js.map(normJournal));
      return set.has(normJournal(name));
    }
    if (!state.journalTier) return true;
    return paperTierId(p) === state.journalTier;
  }
  function journalNamesInColumn() {
    const counts = new Map();
    qfPapers().forEach(p => {
      const name = paperJournalKey(p);
      if (!name) return;
      const canon = name;
      counts.set(normJournal(canon), { name: canon, n: (counts.get(normJournal(canon)) || { n: 0 }).n + 1 });
    });
    return counts;
  }
  function tierJournalRows(tierId) {
    const api = JT();
    const counts = journalNamesInColumn();
    if (tierId === 'other') {
      return Array.from(counts.values())
        .filter(row => !api || api.tierOfName(row.name) === 'other')
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh'))
        .map(row => Object.assign(row, { suggested: false }));
    }
    const names = api ? api.namesInTier(tierId, true) : [];
    const seen = new Set();
    const rows = [];
    names.forEach(n => {
      const k = normJournal(n);
      if (!k || seen.has(k)) return;
      seen.add(k);
      const hit = counts.get(k);
      rows.push({ name: (hit && hit.name) || (api && api.canonName(n)) || n, n: hit ? hit.n : 0, suggested: !!(api && api.isSuggestedName(n)) });
    });
    // 当前栏目里规范名落入本档、但不在表中的刊（不应出现，除非 other）
    return rows;
  }
  function tierHasPapers(tierId) {
    return qfPapers().some(p => {
      const name = paperJournalKey(p);
      if (!name) return false;
      const id = paperTierId(p);
      return tierId === 'other' ? (id === 'other' || !id) : id === tierId;
    });
  }
  function currentTierSubset(tierId) {
    if (state.journalTier !== tierId) return [];
    return selectedJournals();
  }
  function tierIsOn(tierId) {
    return state.journalTier === tierId;
  }
  function selectWholeTier(tierId) {
    if (state.journalTier === tierId && !selectedJournals().length) {
      state.journalTier = '';
      state.journals = [];
      state.journal = '';
    } else {
      state.journalTier = tierId;
      state.journals = [];
      state.journal = '';
      state.publisher = '';
    }
  }
  function toggleJournalInTier(tierId, name) {
    const rows = tierJournalRows(tierId);
    const present = rows.filter(r => r.n > 0 || currentTierSubset(tierId).some(j => normJournal(j) === normJournal(r.name)));
    let list = (state.journalTier === tierId ? selectedJournals() : []).slice();
    const key = normJournal(name);
    if (list.some(j => normJournal(j) === key)) list = list.filter(j => normJournal(j) !== key);
    else list.push(name);
    // 若选中本档全部已出现的刊，视为整档
    const presentKeys = new Set(present.map(r => normJournal(r.name)));
    const selectedKeys = new Set(list.map(normJournal));
    const allOn = presentKeys.size && [...presentKeys].every(k => selectedKeys.has(k));
    state.journalTier = list.length ? tierId : '';
    state.journals = (list.length && !allOn) ? list : [];
    state.journal = state.journals[0] || '';
    state.publisher = '';
    if (name && typeof rememberJournal === 'function') rememberJournal(name);
  }
  function tierDef(id) {
    const api = JT();
    return (api && api.tiers || []).find(t => t.id === id) || { id, short: id, title: id };
  }

  function qfChipVis() {
    const papers = qfPapers();
    const has = pred => papers.some(pred);
    const doi = typeof exactDoi === 'function' && exactDoi(state.search);
    const api = JT();
    const tiers = {};
    (api && api.tiers || []).forEach(tier => { tiers[tier.id] = tierHasPapers(tier.id); });
    return {
      bar: !doi && state.mode !== 'sources',
      scope: usesLane() && !doi,
      star: has(p => paperJournalKey(p)),
      tiers,
      specialty: has(p => p.clinicalTier),
      nocase: has(isCaseReport),
      design: has(p => p.studyDesign),
      more: has(p => p.publisher) || has(p => p.clinicalTier) || has(isCaseReport) || has(p => p.studyDesign) || usesLane() || state.mode === 'library'
    };
  }
  function journalNameOf(p) { return paperJournalKey(p); }
  function columnJournalCounts() {
    const counts = new Map();
    journalNamesInColumn().forEach(row => counts.set(row.name, row.n));
    return counts;
  }
  function qfHasActive() {
    const vis = qfChipVis();
    if (state.favoritesOnly || state.excludeCaseReports || selectedJournals().length || state.journalTier) return true;
    if (state.clinicalTier || state.publisher || state.studyDesign || state.tag) return true;
    if (vis.scope && (state.lane !== 'core' || state.range !== defaultRange(state.mode))) return true;
    if (state.mode === 'library' && state.ftFilter) return true;
    if (usesLane() && (state.minor || state.reading)) return true;
    return false;
  }
  function clearQuickFilters() {
    state.favoritesOnly = false;
    state.excludeCaseReports = false;
    state.journals = [];
    state.journal = '';
    if (typeof clearSidebarFilters === 'function') clearSidebarFilters();
    if (usesLane()) {
      state.lane = 'core';
      state.range = defaultRange(state.mode);
      state.reading = '';
      state.minor = false;
    }
    if (state.mode === 'library') state.ftFilter = '';
  }
  function qfApply() {
    state.page = 1;
    if (state.mode === 'weekly') {
      if (typeof renderWeeklyAuto === 'function') renderWeeklyAuto();
      if (typeof renderNextCandidates === 'function') renderNextCandidates();
      if (typeof syncUrl === 'function') syncUrl();
    } else if (typeof renderStream === 'function') {
      if (typeof renderSidebarFilters === 'function' && state.mode !== 'sources') renderSidebarFilters();
      renderStream();
    }
    renderQuickFilters();
  }

  function scopeLabel() {
    const lane = (typeof LANES !== 'undefined' ? LANES : []).find(l => l.id === state.lane);
    const laneName = (lane && (lane.short || lane.name)) || '领域';
    const rangeName = state.range === 'all' ? '全部时间' : ('近 ' + state.range + ' 天');
    if (state.mode === 'library' && state.ftFilter) {
      const ft = (typeof FT_FILTERS !== 'undefined' ? FT_FILTERS : []).find(([v]) => v === state.ftFilter);
      return laneName + ' · ' + rangeName + ' · ' + ((ft && ft[1]) || '全文');
    }
    return laneName + ' · ' + rangeName;
  }

  function renderQuickFilters() {
    const bar = $('#quickBar');
    const row = $('#qfChipRow');
    const scopeBtn = $('#qfScopeBtn');
    const summary = $('#qfSummary');
    if (!bar || !row) return;
    const vis = qfChipVis();
    bar.hidden = !vis.bar;
    if (scopeBtn) {
      scopeBtn.hidden = !vis.scope;
      if (vis.scope) {
        scopeBtn.textContent = scopeLabel();
        scopeBtn.classList.toggle('is-on', state.lane !== 'core' || state.range !== defaultRange(state.mode) || !!(state.mode === 'library' && state.ftFilter));
        scopeBtn.setAttribute('aria-expanded', String(!!(qfOpen && qfOpen.kind === 'scope')));
      }
    }
    if (!vis.bar) {
      if (summary) summary.hidden = true;
      if (qfOpen) closeQfPop();
      return;
    }
    const chip = (kind, label, on, extra) =>
      `<button type="button" class="qf-chip${on ? ' is-on' : ''}" data-qf="${kind}" aria-pressed="${on}"${extra || ''}>${label}</button>`;
    const parts = [];
    if (vis.star) parts.push(chip('star', state.favoritesOnly ? '★' : '☆', !!state.favoritesOnly, ' aria-label="只看关注期刊" title="只看关注期刊"'));
    (JT() && JT().tiers || []).forEach(tier => {
      if (!vis.tiers[tier.id]) return;
      const subset = currentTierSubset(tier.id);
      const on = tierIsOn(tier.id);
      const label = subset.length ? (tier.short + ' · ' + subset.length) : tier.short;
      const openKind = 'jtier:' + tier.id;
      parts.push(`<span class="qf-split${on ? ' is-on' : ''}">
        <button type="button" class="qf-chip qf-chip-main${on ? ' is-on' : ''}" data-qf-jtier="${esc(tier.id)}" aria-pressed="${on}" aria-label="筛选${esc(tier.title)}">${esc(label)}</button>
        <button type="button" class="qf-chip qf-chip-caret${on ? ' is-on' : ''}" data-qf-jtier-menu="${esc(tier.id)}" aria-haspopup="dialog" aria-expanded="${!!(qfOpen && qfOpen.kind === openKind)}" aria-label="打开${esc(tier.title)}清单"><span class="qf-caret" aria-hidden="true">▾</span></button>
      </span>`);
    });
    if (vis.more) parts.push(chip('more', '⋯', qfMoreActive(), ' aria-haspopup="dialog" aria-label="更多筛选"'));
    row.innerHTML = parts.join('');
    renderQfSummary();
    if (qfOpen) openQfPop(qfOpen.kind, true);
  }
  function qfMoreActive() {
    return !!(state.publisher || state.clinicalTier || state.excludeCaseReports || state.studyDesign || (usesLane() && (state.minor || state.reading)) || (state.mode === 'library' && state.ftFilter && !qfChipVis().scope));
  }

  function renderQfSummary() {
    const el = $('#qfSummary');
    if (!el) return;
    if (!qfHasActive()) { el.hidden = true; el.innerHTML = ''; return; }
    const item = (label, key, value) =>
      `<button type="button" class="qf-sum-item" data-qf-clear="${esc(key)}"${value != null ? ` data-qf-clear-value="${esc(value)}"` : ''} aria-label="清除${esc(label)}">${esc(label)} <span aria-hidden="true">×</span></button>`;
    const bits = [];
    if (state.favoritesOnly) bits.push(item('只看关注期刊', 'favorites'));
    if (state.journalTier && !selectedJournals().length) {
      bits.push(item(tierDef(state.journalTier).title || state.journalTier, 'jtier'));
    } else if (selectedJournals().length) {
      const prefix = state.journalTier ? (tierDef(state.journalTier).short + '：') : '';
      selectedJournals().forEach(j => bits.push(item(prefix + j, 'journal', j)));
    }
    if (state.clinicalTier) bits.push(item(state.clinicalTier, 'tier'));
    if (state.excludeCaseReports) bits.push(item('已排除病例报告', 'nocase'));
    if (state.studyDesign) bits.push(item(state.studyDesign, 'design'));
    if (state.publisher && !selectedJournals().length) bits.push(item(state.publisher, 'pub'));
    if (state.tag) bits.push(item(state.tag, 'tag'));
    if (usesLane() && state.minor) bits.push(item('含更正/来信', 'minor'));
    if (usesLane() && state.reading) bits.push(item('可读内容', 'reading'));
    if (state.mode === 'library' && state.ftFilter) bits.push(item('全文状态', 'ft'));
    if (usesLane() && state.lane !== 'core') bits.push(item((LANES.find(l => l.id === state.lane) || {}).short || '领域', 'lane'));
    if (usesLane() && state.range !== defaultRange(state.mode)) bits.push(item(state.range === 'all' ? '全部时间' : ('近 ' + state.range + ' 天'), 'range'));
    el.hidden = false;
    el.innerHTML = bits.join('<span class="qf-dot" aria-hidden="true">·</span>')
      + '<span class="qf-dot" aria-hidden="true">·</span>'
      + '<button type="button" class="qf-sum-action" data-qf-clear="all">清除</button>'
      + '<span class="qf-dot" aria-hidden="true">·</span>'
      + '<button type="button" class="qf-sum-action" data-qf-save="1" title="把当前条件存成预设，仅此浏览器，不会自动套用">☆保存</button>';
  }

  function closeQfPop() {
    qfOpen = null;
    const pop = $('#qfPop'), back = $('#qfBackdrop');
    if (pop) { pop.hidden = true; pop.innerHTML = ''; pop.classList.remove('is-sheet'); }
    if (back) back.hidden = true;
    $$('.qf-chip[aria-expanded="true"], #qfScopeBtn').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  function placeQfPop(anchor) {
    const pop = $('#qfPop');
    if (!pop) return;
    const narrow = window.innerWidth <= 600;
    pop.classList.toggle('is-sheet', narrow);
    pop.hidden = false;
    const back = $('#qfBackdrop');
    if (back) back.hidden = false;
    if (narrow || !anchor) {
      pop.style.left = '';
      pop.style.top = '';
      pop.style.width = '';
      pop.style.maxWidth = '';
      return;
    }
    const r = anchor.getBoundingClientRect();
    const w = Math.min(420, Math.max(280, window.innerWidth - 16));
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    pop.style.width = w + 'px';
    pop.style.maxWidth = w + 'px';
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    const ph = pop.getBoundingClientRect().height;
    if (r.bottom + 6 + ph > window.innerHeight - 8) {
      const up = r.top - ph - 6;
      pop.style.top = Math.max(8, up) + 'px';
    }
  }
  function openQfPop(kind, keepQuery) {
    const pop = $('#qfPop');
    if (!pop) return;
    const query = keepQuery && qfOpen ? (qfOpen.query || '') : '';
    qfOpen = { kind, query };
    pop.innerHTML = qfPopHtml(kind, query);
    let anchor;
    if (kind === 'scope') anchor = $('#qfScopeBtn');
    else if (kind && kind.slice(0, 6) === 'jtier:') anchor = $(`.qf-chip-caret[data-qf-jtier-menu="${kind.slice(6)}"]`);
    else anchor = $(`.qf-chip[data-qf="${kind}"]`);
    $$('.qf-chip, #qfScopeBtn').forEach(b => b.setAttribute('aria-expanded', String(b === anchor)));
    placeQfPop(anchor);
    const input = $('#qfJournalSearch');
    if (input) {
      input.value = query;
      if (!keepQuery) setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
    }
  }

  function qfPopHtml(kind, query) {
    if (kind && kind.slice(0, 6) === 'jtier:') return journalPopHtml(kind.slice(6), query);
    if (kind === 'journal') return journalPopHtml('other', query);
    if (kind === 'specialty') return specialtyPopHtml();
    if (kind === 'design') return designPopHtml();
    if (kind === 'scope') return scopePopHtml();
    if (kind === 'more') return morePopHtml();
    return '';
  }

  function journalPopHtml(tierId, query) {
    const def = tierDef(tierId);
    return `<div class="qf-pop-head"><strong>${esc(def.title)}</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>
      <div class="qf-pop-actions"><button type="button" class="qf-opt${state.journalTier === tierId && !selectedJournals().length ? ' is-on' : ''}" data-qf-jtier-all="${esc(tierId)}">查看整档</button></div>
      <div class="qf-search-wrap"><input type="search" id="qfJournalSearch" class="qf-search" placeholder="搜索刊名…" value="${esc(query || '')}" autocomplete="off" aria-label="搜索期刊"></div>
      <div class="qf-journal-list" id="qfJournalList">${journalListHtml(query || '', tierId)}</div>`;
  }
  function journalListHtml(query, tierId) {
    const id = tierId || (qfOpen && qfOpen.kind && qfOpen.kind.slice(0, 6) === 'jtier:' ? qfOpen.kind.slice(6) : '');
    const q = String(query || '').trim().toLowerCase();
    const rows = tierJournalRows(id);
    const subset = currentTierSubset(id);
    const whole = state.journalTier === id && !subset.length;
    const fav = new Set((state.favoriteJournals || []).map(normJournal));
    const filtered = rows.filter(r => !q || r.name.toLowerCase().includes(q));
    if (!filtered.length) return '<p class="qf-empty">没有匹配的期刊</p>';
    return filtered.map(r => {
      const on = whole || subset.some(j => normJournal(j) === normJournal(r.name));
      const starred = fav.has(normJournal(r.name));
      const sug = r.suggested ? '<small class="qf-suggested">建议</small>' : '';
      return `<div class="qf-jrow${on ? ' is-on' : ''}${r.n ? '' : ' is-empty'}" data-qf-journal="${esc(r.name)}" data-qf-journal-tier="${esc(id)}">
        <button type="button" class="qf-jstar${starred ? ' is-starred' : ''}" data-qf-follow="${esc(r.name)}" aria-label="${starred ? '取消关注' : '关注期刊'}" aria-pressed="${starred}">${starred ? '★' : '☆'}</button>
        <button type="button" class="qf-jname" data-qf-pick-journal="${esc(r.name)}" data-qf-journal-tier="${esc(id)}" aria-pressed="${on}">${esc(r.name)}${sug}<small>${r.n}</small></button>
      </div>`;
    }).join('');
  }
  function refreshJournalList() {
    const list = $('#qfJournalList');
    if (!list || !qfOpen || !qfOpen.kind) return;
    if (qfOpen.kind !== 'journal' && qfOpen.kind.slice(0, 6) !== 'jtier:') return;
    const tierId = qfOpen.kind.slice(0, 6) === 'jtier:' ? qfOpen.kind.slice(6) : '';
    list.innerHTML = journalListHtml(qfOpen.query || '', tierId);
  }

  function specialtyPopHtml() {
    const counts = {};
    qfPapers().filter(p => matchesFilters(p, false, 'tier')).forEach(p => {
      const t = p.clinicalTier || '综合医学与其他';
      counts[t] = (counts[t] || 0) + 1;
    });
    const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, 'zh'));
    const opts = ['<button type="button" class="qf-opt' + (!state.clinicalTier ? ' is-on' : '') + '" data-qf-tier="" aria-pressed="' + (!state.clinicalTier) + '">全部分组</button>']
      .concat(keys.filter(k => counts[k] || k === state.clinicalTier).map(k =>
        `<button type="button" class="qf-opt${state.clinicalTier === k ? ' is-on' : ''}" data-qf-tier="${esc(k)}" aria-pressed="${state.clinicalTier === k}">${esc(k)} <small>${counts[k] || 0}</small></button>`
      ));
    return `<div class="qf-pop-head"><strong>专科来源</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>
      <p class="qf-hint">按来源期刊分组，不是每篇文章的临床主题。</p>
      <div class="qf-opt-list">${opts.join('')}</div>`;
  }

  function designPopHtml() {
    const counts = {};
    qfPapers().filter(p => matchesFilters(p, false, 'design')).forEach(p => {
      const d = p.studyDesign || '研究类型待核验';
      counts[d] = (counts[d] || 0) + 1;
    });
    const pending = counts['研究类型待核验'] || 0;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const seen = new Set();
    const keys = QF_DESIGN_OPTS.map(([k, n]) => {
      seen.add(k);
      return [k, n, k ? (counts[k] || 0) : total];
    });
    Object.keys(counts).forEach(k => { if (!seen.has(k)) keys.splice(keys.length - 1, 0, [k, k, counts[k]]); });
    const opts = keys.filter(([k, , n]) => !k || n || k === '病例报告' || k === state.studyDesign || k === '研究类型待核验').map(([k, name, n]) => {
      const on = k ? state.studyDesign === k : !state.studyDesign;
      const mark = k === '研究类型待核验' ? ` <small>待核验 ${pending} 篇${total ? '（' + Math.round(pending * 100 / total) + '%）' : ''}</small>`
        : (k ? ` <small>${n}</small>` : '');
      return `<button type="button" class="qf-opt${on ? ' is-on' : ''}" data-qf-design="${esc(k)}" aria-pressed="${on}">${esc(name)}${mark}</button>`;
    });
    return `<div class="qf-pop-head"><strong>研究设计</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>
      <p class="qf-hint">筛选只作用于已标注文献。当前栏目研究类型待核验 ${pending} 篇${total ? '，约占 ' + Math.round(pending * 100 / total) + '%' : ''}。</p>
      <div class="qf-opt-list">${opts.join('')}</div>`;
  }

  function scopePopHtml() {
    const lanes = (typeof LANES !== 'undefined' ? LANES : []).map(l =>
      `<button type="button" class="qf-opt${state.lane === l.id ? ' is-on' : ''}" data-qf-lane="${esc(l.id)}" aria-pressed="${state.lane === l.id}">${esc(l.short || l.name)}</button>`
    ).join('');
    const ranges = ((typeof RANGES_BY_MODE !== 'undefined' && RANGES_BY_MODE[state.mode]) || []).map(([v, n]) =>
      `<button type="button" class="qf-opt${state.range === v ? ' is-on' : ''}" data-qf-range="${esc(v)}" aria-pressed="${state.range === v}">${esc(n)}</button>`
    ).join('');
    let ft = '';
    if (state.mode === 'library' && typeof FT_FILTERS !== 'undefined') {
      ft = '<h4>全文状态</h4><div class="qf-opt-list">' + FT_FILTERS.map(([v, n]) =>
        `<button type="button" class="qf-opt${(state.ftFilter || '') === v ? ' is-on' : ''}" data-qf-ft="${esc(v)}" aria-pressed="${(state.ftFilter || '') === v}">${esc(v === '' ? '全部全文' : n)}</button>`
      ).join('') + '</div>';
    }
    return `<div class="qf-pop-head"><strong>领域与时间</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>
      <h4>领域</h4><div class="qf-opt-list">${lanes}</div>
      <h4>发表时间</h4><div class="qf-opt-list">${ranges}</div>${ft}`;
  }

  function morePopHtml() {
    const pubCounts = {};
    qfPapers().forEach(p => {
      if (!matchesQuery(p)) return;
      const pub = p.publisher || '其他学术刊物';
      pubCounts[pub] = (pubCounts[pub] || 0) + 1;
    });
    const pubs = Object.keys(pubCounts).sort((a, b) => pubCounts[b] - pubCounts[a] || a.localeCompare(b, 'zh'));
    const pubHtml = pubs.map(name =>
      `<button type="button" class="qf-opt${state.publisher === name && !selectedJournals().length ? ' is-on' : ''}" data-qf-pub="${esc(name)}" aria-pressed="${state.publisher === name && !selectedJournals().length}">${esc(name)} <small>${pubCounts[name]}</small></button>`
    ).join('') || '<p class="qf-empty">暂无出版方</p>';
    let extra = '';
    if (usesLane()) {
      extra += `<h4>文章类型</h4><div class="qf-opt-list">
        <button type="button" class="qf-opt${!state.minor ? ' is-on' : ''}" data-qf-minor="0" aria-pressed="${!state.minor}">不含更正/来信（默认）</button>
        <button type="button" class="qf-opt${state.minor ? ' is-on' : ''}" data-qf-minor="1" aria-pressed="${!!state.minor}">含更正/来信</button>
      </div>`;
      extra += `<h4>可读内容</h4><div class="qf-opt-list">
        <button type="button" class="qf-opt${!state.reading ? ' is-on' : ''}" data-qf-reading="" aria-pressed="${!state.reading}">全部内容</button>
        <button type="button" class="qf-opt${state.reading === 'abstract' ? ' is-on' : ''}" data-qf-reading="abstract" aria-pressed="${state.reading === 'abstract'}">有公开摘要</button>
        <button type="button" class="qf-opt${state.reading === 'guide' ? ' is-on' : ''}" data-qf-reading="guide" aria-pressed="${state.reading === 'guide'}">已核对导读</button>
        <button type="button" class="qf-opt${state.reading === 'quicklook' ? ' is-on' : ''}" data-qf-reading="quicklook" aria-pressed="${state.reading === 'quicklook'}">AI 速览</button>
      </div>`;
    }
    const visMore = qfChipVis();
    let moved = '';
    if (visMore.nocase) {
      moved += `<h4>病例报告</h4><div class="qf-opt-list"><button type="button" class="qf-opt${state.excludeCaseReports ? ' is-on' : ''}" data-qf="nocase" aria-pressed="${!!state.excludeCaseReports}">不看病例</button></div>`;
    }
    if (visMore.specialty) moved += specialtyPopHtml().replace(/<div class="qf-pop-head">[\s\S]*?<\/div>/, '');
    if (visMore.design) moved += designPopHtml().replace(/<div class="qf-pop-head">[\s\S]*?<\/div>/, '');
    const presets = loadFilterPresets();
    const presetHtml = presets.length
      ? `<h4>已保存的预设</h4><p class="qf-hint">仅此浏览器保存，不会自动套用。</p><div class="qf-opt-list">` +
        presets.map(p => `<div class="qf-preset-row"><button type="button" class="qf-opt" data-qf-preset="${esc(String(p.id))}">${esc(p.name || '未命名预设')}</button><button type="button" class="qf-preset-del" data-qf-del-preset="${esc(String(p.id))}" aria-label="删除预设">×</button></div>`).join('') +
        `</div>`
      : '<p class="qf-hint">用列表上方的 ☆保存，可以把当前条件存成预设。仅此浏览器保存，打开站点时不会自动套用。</p>';
    return `<div class="qf-pop-head"><strong>更多筛选</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>${moved}
      <h4>出版方</h4><p class="qf-hint">可选的浏览方式。选刊不会自动带上出版方。</p>
      <div class="qf-opt-list">${pubHtml}</div>${extra}${presetHtml}`;
  }

  function toggleJournal(name) {
    if (!name) return;
    let list = selectedJournals().slice();
    if (list.includes(name)) list = list.filter(j => j !== name);
    else { list.push(name); rememberJournal(name); }
    state.journals = list;
    state.journal = list[0] || '';
    // 选刊不自动带上出版方
    if (list.length) state.publisher = '';
    qfApply();
  }
  function toggleFollow(name) {
    if (!name) return;
    const f = state.favoriteJournals || [];
    state.favoriteJournals = f.includes(name) ? f.filter(j => j !== name) : [...f, name];
    safeSet('xz_favorite_journals', JSON.stringify(state.favoriteJournals));
    if (qfOpen && qfOpen.kind && qfOpen.kind.slice(0, 6) === 'jtier:') refreshJournalList();
    else renderQuickFilters();
  }

  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('[data-qf], #qfScopeBtn, [data-qf-close], [data-qf-pick-journal], [data-qf-follow], [data-qf-jtier], [data-qf-jtier-menu], [data-qf-jtier-all], [data-qf-tier], [data-qf-design], [data-qf-lane], [data-qf-range], [data-qf-ft], [data-qf-pub], [data-qf-minor], [data-qf-reading], [data-qf-preset], [data-qf-del-preset], [data-qf-clear], [data-qf-save]');
    if (!t) {
      if (qfOpen && !$('#qfPop')?.contains(e.target) && !e.target.closest('#quickBar')) closeQfPop();
      return;
    }
    if (t.hasAttribute('data-qf-close')) { closeQfPop(); return; }
    if (t.id === 'qfScopeBtn') { qfOpen && qfOpen.kind === 'scope' ? closeQfPop() : openQfPop('scope'); return; }
    const kind = t.getAttribute('data-qf');
    if (kind === 'star') { state.favoritesOnly = !state.favoritesOnly; closeQfPop(); qfApply(); return; }
    if (kind === 'nocase') {
      state.excludeCaseReports = !state.excludeCaseReports;
      if (state.excludeCaseReports && state.studyDesign === '病例报告') state.studyDesign = '';
      closeQfPop(); qfApply(); return;
    }
    if (kind === 'journal' || kind === 'specialty' || kind === 'design' || kind === 'more') {
      qfOpen && qfOpen.kind === kind ? closeQfPop() : openQfPop(kind);
      return;
    }
    if (t.hasAttribute('data-qf-jtier-menu')) {
      const id = t.getAttribute('data-qf-jtier-menu');
      const k = 'jtier:' + id;
      qfOpen && qfOpen.kind === k ? closeQfPop() : openQfPop(k);
      return;
    }
    if (t.hasAttribute('data-qf-jtier-all')) {
      const id = t.getAttribute('data-qf-jtier-all');
      state.journalTier = id;
      state.journals = [];
      state.journal = '';
      state.publisher = '';
      qfApply();
      return;
    }
    if (t.hasAttribute('data-qf-jtier')) {
      selectWholeTier(t.getAttribute('data-qf-jtier'));
      closeQfPop();
      qfApply();
      return;
    }
    const follow = t.getAttribute('data-qf-follow');
    if (follow) { e.preventDefault(); e.stopPropagation(); toggleFollow(follow); return; }
    if (t.hasAttribute('data-qf-pick-journal') || t.hasAttribute('data-qf-journal')) {
      const name = t.getAttribute('data-qf-pick-journal') || t.getAttribute('data-qf-journal');
      const tierId = t.getAttribute('data-qf-journal-tier') || (t.closest('[data-qf-journal-tier]') && t.closest('[data-qf-journal-tier]').getAttribute('data-qf-journal-tier')) || (qfOpen && qfOpen.kind && qfOpen.kind.slice(0, 6) === 'jtier:' ? qfOpen.kind.slice(6) : '');
      if (tierId) toggleJournalInTier(tierId, name);
      else toggleJournal(name);
      qfApply();
      return;
    }
    if (t.hasAttribute('data-qf-tier')) {
      const v = t.getAttribute('data-qf-tier');
      state.clinicalTier = state.clinicalTier === v ? '' : v;
      closeQfPop(); qfApply(); return;
    }
    if (t.hasAttribute('data-qf-design')) {
      const v = t.getAttribute('data-qf-design');
      state.studyDesign = state.studyDesign === v ? '' : v;
      if (state.studyDesign === '病例报告') state.excludeCaseReports = false;
      closeQfPop(); qfApply(); return;
    }
    if (t.hasAttribute('data-qf-lane')) { state.lane = t.getAttribute('data-qf-lane') || 'core'; qfApply(); return; }
    if (t.hasAttribute('data-qf-range')) { state.range = t.getAttribute('data-qf-range') || defaultRange(state.mode); qfApply(); return; }
    if (t.hasAttribute('data-qf-ft')) { state.ftFilter = t.getAttribute('data-qf-ft') || ''; qfApply(); return; }
    if (t.hasAttribute('data-qf-pub')) {
      const v = t.getAttribute('data-qf-pub');
      if (state.publisher === v && !selectedJournals().length) state.publisher = '';
      else { state.publisher = v; state.journals = []; state.journal = ''; }
      qfApply(); return;
    }
    if (t.hasAttribute('data-qf-minor')) { state.minor = t.getAttribute('data-qf-minor') === '1'; qfApply(); return; }
    if (t.hasAttribute('data-qf-reading')) { state.reading = t.getAttribute('data-qf-reading') || ''; qfApply(); return; }
    if (t.hasAttribute('data-qf-tag')) {
      const v = t.getAttribute('data-qf-tag');
      state.tag = state.tag === v ? '' : v;
      qfApply(); return;
    }
    if (t.hasAttribute('data-qf-preset')) { closeQfPop(); applyFilterPreset(t.getAttribute('data-qf-preset')); return; }
    if (t.hasAttribute('data-qf-del-preset')) { deleteFilterPreset(t.getAttribute('data-qf-del-preset')); openQfPop('more', true); return; }
    if (t.hasAttribute('data-qf-save')) {
      const n = loadFilterPresets().length + 1;
      saveFilterPreset('预设 ' + n);
      renderQfSummary();
      return;
    }
    if (t.hasAttribute('data-qf-clear')) {
      const key = t.getAttribute('data-qf-clear');
      const val = t.getAttribute('data-qf-clear-value');
      if (key === 'all') clearQuickFilters();
      else if (key === 'jtier') { state.journalTier = ''; state.journals = []; state.journal = ''; }
      else if (key === 'favorites') state.favoritesOnly = false;
      else if (key === 'nocase') state.excludeCaseReports = false;
      else if (key === 'journal') {
        state.journals = selectedJournals().filter(j => j !== val);
        state.journal = state.journals[0] || '';
        if (!state.journals.length) state.journalTier = '';
      }
      else if (key === 'tier') state.clinicalTier = '';
      else if (key === 'design') state.studyDesign = '';
      else if (key === 'pub') state.publisher = '';
      else if (key === 'tag') state.tag = '';
      else if (key === 'minor') state.minor = false;
      else if (key === 'reading') state.reading = '';
      else if (key === 'ft') state.ftFilter = '';
      else if (key === 'lane') state.lane = 'core';
      else if (key === 'range') state.range = defaultRange(state.mode);
      closeQfPop(); qfApply(); return;
    }
  });
  document.addEventListener('input', e => {
    if (e.target && e.target.id === 'qfJournalSearch') {
      if (!qfOpen) qfOpen = { kind: 'journal', query: '' };
      qfOpen.query = e.target.value;
      refreshJournalList();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && qfOpen) { closeQfPop(); e.preventDefault(); }
  });
  window.addEventListener('resize', () => {
    if (!qfOpen) return;
    let anchor;
    if (qfOpen.kind === 'scope') anchor = $('#qfScopeBtn');
    else if (qfOpen.kind && qfOpen.kind.slice(0, 6) === 'jtier:') anchor = $(`.qf-chip-caret[data-qf-jtier-menu="${qfOpen.kind.slice(6)}"]`);
    else anchor = $(`.qf-chip[data-qf="${qfOpen.kind}"]`);
    placeQfPop(anchor);
  });
