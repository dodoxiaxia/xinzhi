  // ==== src/app/04-filters.js · Dates, full-text links, lane/range bars, URL sync, filtering, sidebar facets ====
  function hasAbstract(p) { return !!(p.summary || (p.abstractSections||[]).some(x=>x.text) || quicklookOf(p)?.abstract); }
  function datePrecision(p) {
    if (p.datePrecision) return p.datePrecision;
    if (!p.date) return 'unknown';
    if (/^\d{4}-\d{2}$/.test(p.date)) return 'month';
    // Historic import flattened month-level issue dates to the first day. Never assert that day.
    if (p.date.slice(8,10)==='01' && /published-print|正式期号/.test(p.dateBasis||'')) return 'month';
    return 'day';
  }
  function dateLabel(p) { return !p.date ? '日期待核验' : datePrecision(p)==='month' ? p.date.slice(0,7)+' · 刊期' : p.date.slice(0,10); }
  // Cached: this runs inside per-paper filters, so building an Intl formatter each call froze the page on 10k+ rows
  const BJ_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
  let _bj = { t: 0, v: '' };
  function beijingToday() { const n = Date.now(); if (n - _bj.t > 30000) _bj = { t: n, v: BJ_FMT.format(new Date(n)) }; return _bj.v; }
  function safeSourceUrl(p) {
    const val=p.url || (p.doi?'https://doi.org/'+p.doi:'');
    try { const u=new URL(val); return ['https:','http:'].includes(u.protocol)?u.href:''; } catch(e){return '';}
  }
  function pdfDownloadUrl(p) {
    if (p && typeof DOI_FULLTEXT !== 'undefined') {
      const doi = exactDoi(p.doi), record = DOI_FULLTEXT.get(doi);
      if (record) return sameDoiTitle(p.title, record.title) && record.fulltextStatus === 'available' ? '/api/fulltext?doi=' + encodeURIComponent(doi) : '';
    }
    return p && PDF_LIBRARY_IDS.has(String(p.id)) ? '/api/pdf?id=' + encodeURIComponent(p.id) : '';
  }
  function pdfDownloadLink(p) {
    const conflict = fulltextConflict(p);
    if (conflict) return `<span class="fulltext-state fulltext-review" title="官方题名：${esc(conflict.title)}">题录对应待核实</span>`;
    const job = p && DOI_JOBS.get(exactDoi(p.doi));
    if (doiJobActive(job)) return '<span class="fulltext-state">' + (job.stage === 'verifying' ? '已回传，等待核验' : job.stage === 'uploading' ? 'Drive 已上传，正在回传' : job.state === 'queued' ? '全文排队中' : '全文获取中') + '</span><a href="' + esc(acquireDoiUrl(job.doi)) + '" target="_blank" rel="noopener" class="btn-sm">查看任务</a>';
    const url = pdfDownloadUrl(p);
    if (url) return `<a href="${esc(url)}" target="_blank" rel="noopener" class="btn-sm btn-primary" title="输入全文口令即可下载">下载 PDF</a>`;
    const doi = p && exactDoi(p.doi), record = DOI_FULLTEXT.get(doi);
    const manual = record?.fulltextStatus === 'manual_needed';
    if (job && ['failed','manual_needed','review'].includes(job.state)) return '<span class="fulltext-state" title="' + esc(job.message) + '">' + (job.state === 'review' ? '全文核验未通过' : '全文需人工处理') + '</span><a href="' + esc(acquireDoiUrl(doi)) + '" target="_blank" rel="noopener" class="btn-sm">查看处理状态</a>';
    const label = manual ? '全文需人工处理' : record?.fulltextStatus === 'review' ? '全文对应待核实' : '待补全文';
    const acquire = job ? '/api/acquire/retry?doi=' + encodeURIComponent(doi) : acquireDoiUrl(doi);
    return doi ? `<span class="fulltext-state">${label}</span><a href="${esc(acquire)}" target="_blank" rel="noopener" class="btn-sm">${manual ? '查看处理状态' : record || job ? '再次获取全文' : '获取全文'}</a>` : '';
  }
  function inLane(p, lane) {
    if (lane === 'all') return true;
    if (lane === 'crossai') return paperCrossAI(p);
    const l = paperLane(p);
    return lane === 'core' ? (l === 'cardio' || l === 'aimed') : l === lane;
  }
  const usesLane = () => state.mode === 'candidates' || state.mode === 'library';

  const RANGES_BY_MODE = {
    candidates: [['7', '近 7 天'], ['14', '近 14 天'], ['30', '近 30 天'], ['90', '近 90 天'], ['365', '近 365 天']],
    library: [['all', '全部时间'], ['30', '近 30 天'], ['90', '近 90 天'], ['365', '近 365 天']]
  };
  function renderRangeBar() {
    const el = $('#rangeBar');
    if (!el) return;
    if (!usesLane()) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<span class="range-label">发表时间</span>' + (RANGES_BY_MODE[state.mode] || RANGES_BY_MODE.library).map(([v, n]) =>
      `<button type="button" class="lane-chip${state.range === v ? ' active' : ''}" data-range="${v}" aria-pressed="${state.range === v}">${n}</button>`).join('');
  }
  function renderLaneBar() {
    const el = $('#laneBar');
    if (!el) return;
    if (state.mode === 'curated') {
      const counts = {};
      getCuratedList().forEach(p => (p.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
      const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      el.hidden = tags.length === 0;
      el.innerHTML = tags.length ? `<span class="lane-label">主题</span>` + tags.map(([t, n]) => `<button class="lane-chip ${state.tag === t ? 'active' : ''}" data-filter-tag="${esc(t)}">${esc(t.replace(/^#/, ''))} <small>${n}</small></button>`).join('') : '';
      return;
    }
    if (!usesLane()) { el.hidden = true; el.innerHTML = ''; return; }
    // One pass: every paper that passes the non-lane conditions counts towards its own lanes.
    const counts = { core: 0, crossai: 0, cardio: 0, aimed: 0, general: 0, aitech: 0, all: 0 };
    for (const p of getCurrentDataset()) {
      if (!matchesFilters(p, true)) continue;
      const lane = paperLane(p);
      counts.all++; counts[lane]++;
      if (lane === 'cardio' || lane === 'aimed') counts.core++;
      if (paperCrossAI(p)) counts.crossai++;
    }
    el.hidden = false;
    el.innerHTML = LANES.map(l => `<button class="lane-chip ${state.lane === l.id ? 'active' : ''}" data-lane="${l.id}">${esc(l.name)} <small>${counts[l.id]}</small></button>`).join('');
  }

  function publishedDate(p) {
    if (p.autoPick && !(p.draftData && (p.draftData.published || p.draftData.source_date))) return p.autoPick.d;
    return ((p.draftData && (p.draftData.published || p.draftData.source_date)) || '日期待核验').slice(0, 10);
  }

  function radarDefaultCount() {
    const d = new Date(beijingToday() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 13);
    const s0 = d.toISOString().slice(0, 10), t0 = beijingToday();
    return FEEDS.items.filter(p => !p.minor && datePrecision(p) === 'day' && p.date.slice(0, 10) >= s0 && p.date.slice(0, 10) <= t0).length;
  }
  function updateHeaderBadges() {
    const cb = $('#candCountBadge'); if (cb) cb.textContent = radarDefaultCount();
    const cub = $('#curatedCountBadge'); if (cub) cub.textContent = getCuratedList().length;
    const lb = $('#libCountBadge'); if (lb) {
      lb.textContent = LIBRARY.papers.length;
      lb.title = '已收录题录总数，含更正 / 来信；列表按当前筛选计数';
      lb.setAttribute('aria-label', `已收录 ${LIBRARY.papers.length} 条题录，含更正 / 来信；列表按当前筛选计数`);
    }

  }

  function contentDate(value) {
    if (!value) return '尚无记录';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '日期待核验' : d.toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
  }
  function olderThan(value, hours) {
    const time = Date.parse(value || '');
    return !Number.isFinite(time) || Date.now() - time > hours * 3600000;
  }
  const MODE_NOTES = {
    candidates: '<b>默认显示近 14 天文献与 AI 动态，可切换到近 30 / 90 / 365 天。</b>近 14 天来自 RSS 与 PubMed（多数带摘要）；更早的是 PubMed 题录（已关注的心血管与 AI 医学期刊），点“阅读摘要”再取公开摘要。自动聚合条目未经逐篇核对；已核对导读与 AI 速览分别标记。',
    library: '文献档案：按期刊与时间检索既有题录。输入全文口令后可下载已收录的 PDF；未收录全文的条目可访问官网。没有摘要的条目，可尝试获取公开摘要。刊期按月份显示，日期未知的排在最后。'
  };

  function renderModeNote() {
    const el = $('#modeNote');
    if (!el) return;
    const intro = $('#homeIntro');
    if (intro) intro.hidden = state.mode !== 'curated';
    const rail = $('#streamRail');
    if (rail) rail.hidden = state.mode !== 'curated';
    const laneBar = $('#laneBar'), laneSlot = $(state.mode === 'curated' ? '#curatedTopicsSlot' : '#streamLaneSlot');
    if (laneBar && laneSlot && laneBar.parentElement !== laneSlot) laneSlot.append(laneBar);
    const note = MODE_NOTES[state.mode];
    el.innerHTML = note || '';
    el.hidden = !note;
  }

  // URL <-> state sync so filtered views are shareable / survive refresh
  function syncUrl() {
    try {
      const u = new URL(window.location.href);
      const set = (k, v, def) => { if (v && v !== def) u.searchParams.set(k, v); else u.searchParams.delete(k); };
      set('mode', state.mode, 'curated');
      set('q', state.search, '');
      set('tier', state.clinicalTier, '');
      set('pub', state.publisher, '');
      set('journal', state.journal, '');
      set('design', state.studyDesign, '');
      set('tag', state.tag, '');
      set('lane', usesLane() ? state.lane : '', 'core');
      set('sort', state.sort, 'date-desc');
      set('range', state.range, defaultRange(state.mode));
      set('minor', state.minor ? '1' : '', '');
      set('reading', usesLane()?state.reading:'', '');
      set('favorites', usesLane()&&state.favoritesOnly ? '1' : '', '');
      set('wcat', state.mode === 'weekly' ? state.weeklyCat : '', '');
      set('pane', state.mode === 'weekly' ? state.weeklyPane : '', 'board');
      set('read', state.mode === 'weekly' ? activeDeepReadingId : '', '');
      u.searchParams.delete('maintainer');
      const filteredView = state.search || state.clinicalTier || state.publisher || state.journal || state.studyDesign || state.tag
        || state.range !== defaultRange(state.mode) || (usesLane() && (state.lane !== 'core' || state.minor || state.reading || state.favoritesOnly));
      if (viewInUrl || filteredView) u.searchParams.set('view', state.viewMode);
      else u.searchParams.delete('view');
      history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash);
    } catch (e) { /* file:// or sandboxed */ }
  }

  // Phones: the Back button closes the open panel instead of leaving the site.
  // Opening a panel pushes one history entry; closing it by button or Esc walks back over it.
  const OVERLAY_PUSHED = new Set();
  function pushOverlay(name) {
    try {
      if (OVERLAY_PUSHED.has(name) && history.state && history.state.overlay === name) return;
      history.pushState({ overlay: name }, '', location.href);
      OVERLAY_PUSHED.add(name);
    } catch (e) { /* file:// or sandboxed */ }
  }
  function popOverlay(name) {
    try {
      if (OVERLAY_PUSHED.has(name) && history.state && history.state.overlay === name) { history.back(); return true; }
    } catch (e) { /* file:// or sandboxed */ }
    return false;
  }

  // Get current dataset based on mode
  function getCurrentDataset() {
    if (state.mode === 'curated') {
      return getCuratedList();
    }
    if (state.mode === 'library') {
      return LIBRARY.papers;
    }
    // Default: candidates
    return FEEDS.items;
  }

  // A journal and its publisher share one source facet. Expanding the tree
  // is presentation state and must never change the selected papers.
  const expandedPublishers = new Set();
  function publisherForJournal(journal) {
    if (!journal) return '';
    const paper = getCurrentDataset().find(p => p.cleanJournal === journal || p.journal === journal);
    return paper ? paper.publisher || '其他学术刊物' : '';
  }
  if (state.journal) state.publisher = publisherForJournal(state.journal);
  if (state.publisher) expandedPublishers.add(state.publisher);

  function sidebarSelections() {
    return [
      { group: 'tier', value: state.clinicalTier, label: '信源分组' },
      state.journal ? { group: 'journal', value: state.journal, label: '期刊' }
        : { group: 'pub', value: state.publisher, label: '出版方' },
      { group: 'design', value: state.studyDesign, label: '研究设计' },
      { group: 'tag', value: state.tag, label: '主题' }
    ].filter(selection => selection.value);
  }
  function clearSidebarFilters() {
    state.clinicalTier = state.publisher = state.journal = state.studyDesign = state.tag = '';
    state.page = 1;
  }
  function selectSidebarFilter(group, value, only = false) {
    if (!['tier', 'pub', 'journal', 'design', 'tag'].includes(group) || typeof value !== 'string') return false;
    if (only) clearSidebarFilters();
    if (group === 'tier') state.clinicalTier = value;
    if (group === 'pub') { state.publisher = value; state.journal = ''; }
    if (group === 'journal') { state.journal = value; state.publisher = publisherForJournal(value); }
    if (group === 'design') state.studyDesign = value;
    if (group === 'tag') state.tag = value;
    if (state.publisher) expandedPublishers.add(state.publisher);
    state.page = 1;
    return true;
  }
  function browseOnlyButton(group, value, label) {
    const facet = group === 'journal' ? 'pub' : group;
    const other = sidebarSelections().some(selection => (selection.group === 'journal' ? 'pub' : selection.group) !== facet);
    if (!value || !other) return '';
    return `<button type="button" class="browse-only-btn" data-browse-only="${group}" data-browse-value="${esc(value)}" aria-label="只看${esc(label)}" title="清除其他左侧筛选；保留领域、时间、搜索和可读内容条件">只看</button>`;
  }
  function refreshFilterResults(control, group, value) {
    const focused = control && document.activeElement === control;
    const inSidebar = control && control.closest('#appSidebar');
    renderSidebarFilters();
    renderStream();
    if (!focused || control.isConnected) return;
    const attribute = { tier: 'tier', pub: 'publisher', journal: 'journal', design: 'design', tag: 'tag' }[group];
    const replacement = inSidebar && attribute && Array.from(document.querySelectorAll(`#appSidebar [data-filter-${attribute}]`))
      .find(button => button.getAttribute(`data-filter-${attribute}`) === value);
    (replacement || $('#activeFiltersBar'))?.focus({ preventScroll: true });
  }
  function changeSidebarFilter(group, value, only, control) {
    if (selectSidebarFilter(group, value, only)) refreshFilterResults(control, group, value);
  }

  // Filter & Sort
  function paperSearchText(p) {
    const d = paperDerived(p);
    if (d.text === null) d.text = [
      p.title, p.draftData?.title_zh, p.titleZh, p.cleanJournal, p.journal, p.publisher, p.doi, p.pmid, p.id,
      p.summary, ...(p.abstractSections || []).map(x => x.text), quicklookOf(p)?.title_zh,
      p.draftData?.summary, ...(p.authors || []), ...(p.tags || []),
      p.quantitativeMetrics?.trialId, p.quantitativeMetrics?.sampleSize
    ].filter(Boolean).join(' ').toLowerCase();
    return d.text;
  }
  function matchesQuery(p) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    // List, lane counts and sidebar counts all ask again for the same keyword.
    const d = paperDerived(p);
    if (d.query !== q) { d.query = q; d.hit = queryMatches(paperSearchText(p), q); }
    return d.hit;
  }
  function specialSearchStatus(scope, matched, total, noun) {
    if (!state.search) return '';
    return `<div class="special-search-status"><span class="search-scope" role="status">检索范围：${esc(scope)} · 匹配 ${matched}/${total} ${noun}；切换栏目保留关键词</span><span>搜索：${esc(state.search)}</span><button class="btn-sm" data-clear="search" aria-label="清除检索关键词">清除关键词</button></div>`;
  }
  // All conditions must hold; the cheap ones run first and the keyword search last.
  function matchesFilters(p, skipLane, skip) {
    const lane = usesLane();
    if (lane) {
      if (!state.minor && p.minor) return false;
      if (state.range !== 'all' && (datePrecision(p)!=='day' || p.date.slice(0,10)<rangeStart() || p.date.slice(0,10)>beijingToday())) return false;
      if (!skipLane && !inLane(p, state.lane)) return false;
      if (state.favoritesOnly && !state.favoriteJournals.includes(p.cleanJournal || p.journal || '')) return false;
      if (state.reading==='guide' && !p.hasDraft) return false;
    }
    if (!matchesSidebarFilters(p, skip)) return false;
    if (lane && state.reading==='abstract' && !hasAbstract(p)) return false;
    if (lane && state.reading==='quicklook' && (!quicklookOf(p) || p.hasDraft)) return false;
    return matchesQuery(p);
  }
  // Bit set of the sidebar groups a paper fails, so facet counts need one pass, not one per group.
  const FACET_BITS = { tier: 1, pub: 2, design: 4, tag: 8 };
  function sidebarMisses(p) {
    let miss = 0;
    if (state.clinicalTier && (p.clinicalTier || '综合医学与其他') !== state.clinicalTier) miss |= 1;
    if (state.publisher && (p.publisher || '其他学术刊物') !== state.publisher) miss |= 2;
    if (state.journal && (p.cleanJournal !== state.journal && p.journal !== state.journal)) miss |= 2;
    if (state.studyDesign && p.studyDesign !== state.studyDesign) miss |= 4;
    if (state.tag && (!p.tags || !p.tags.includes(state.tag))) miss |= 8;
    return miss;
  }
  function matchesSidebarFilters(p, skip) {
    if (skip === 'sidebar') return true;
    return (sidebarMisses(p) & ~(FACET_BITS[skip] || 0)) === 0;
  }

  let _maxDateCache = null;
  function maxDate() {
    if (_maxDateCache && _maxDateCache.ds === getCurrentDataset()) return _maxDateCache.v;
    const ds = getCurrentDataset();
    let v = '';
    ds.forEach(p => { if ((p.date || '') > v && p.date <= '9999') v = p.date; });
    _maxDateCache = { ds, v };
    return v;
  }
  const _rs = { key: '', v: '' };
  function rangeStart() {
    if (state.range === 'all') return '';
    const key = state.range + '|' + beijingToday();
    if (_rs.key === key) return _rs.v;
    const d = new Date(beijingToday() + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - parseInt(state.range, 10) + 1);
    _rs.key = key; _rs.v = d.toISOString().slice(0, 10);
    return _rs.v;
  }
  // Within the same day, papers that come with something to read (guide > AI quick-look > abstract) go first
  function richRank(p) {
    return (p.hasDraft ? 8 : 0) + (quicklookOf(p) ? 4 : 0)
      + (p.media ? 2 + Math.min(4, p.media.reduce((s, m) => s + (m.w || 1), 0)) : 0)
      + (paperLane(p) === 'cardio' || paperCrossAI(p) ? 3 : 0) + (p.summary ? 2 : 0) + (p.abstractSections && p.abstractSections.length ? 1 : 0);
  }
  function getFilteredArticles() {
    const doi = exactDoi(state.search);
    if (doi) return exactDoiPapers(doi);
    const list = getCurrentDataset();
    const curated = state.mode === 'curated';
    const arr = list.filter(p => matchesFilters(p, false));
    const jn = p => p.cleanJournal || p.journal || '';
    // The comparator runs O(n log n) times; rank each paper once.
    const ranks = new Map();
    const rank = p => { let r = ranks.get(p); if (r === undefined) ranks.set(p, r = richRank(p)); return r; };
    let jLatest = null;
    if (!curated && state.sort === 'journal-date') {
      jLatest = new Map();
      arr.forEach(p => { const j = jn(p); if ((p.date || '') > (jLatest.get(j) || '')) jLatest.set(j, p.date || ''); });
    }
    return arr.sort((a, b) => {
      if (curated) {
        const c = publishedDate(b).localeCompare(publishedDate(a));
        if (c) return c;
      }
      if (state.sort === 'smart') {
        const d = rank(b) - rank(a);
        if (d) return d;
      }
      if (jLatest) {
        const ja = jn(a), jb = jn(b);
        if (ja !== jb) return (jLatest.get(jb) || '').localeCompare(jLatest.get(ja) || '') || ja.localeCompare(jb);
      }
      const da = (a.date || '').slice(0, 10), db = (b.date || '').slice(0, 10);
      if (!da || !db) return da ? -1 : db ? 1 : 0;
      if (state.sort === 'date-asc') return da.localeCompare(db) || rank(b) - rank(a);
      return db.localeCompare(da) || rank(b) - rank(a);
    });
  }

  // Render Sidebar Filters with dynamic counts
  function renderSidebarFilters() {
    const all = getCurrentDataset();
    const base = all.filter(p => matchesFilters(p, false, 'sidebar'));
    // One pass: a paper belongs to a group's facet when it fails no other group.
    const facets = { tier: [], pub: [], design: [], tag: [] };
    for (const p of base) {
      const miss = sidebarMisses(p);
      if (!(miss & ~FACET_BITS.tier)) facets.tier.push(p);
      if (!(miss & ~FACET_BITS.pub)) facets.pub.push(p);
      if (!(miss & ~FACET_BITS.design)) facets.design.push(p);
      if (!(miss & ~FACET_BITS.tag)) facets.tag.push(p);
    }
    const facet = skip => facets[skip];
    const dataset = facet('tier');

    // 1. Clinical Tier Counts
    const tierCounts = {};
    const tiers = [
      { id: '', name: '全部专科', dotClass: 'dot-all' },
      { id: '心血管旗舰顶刊', name: '心血管旗舰顶刊', dotClass: 'dot-flagship' },
      { id: '心律失常与电生理', name: '心律失常与电生理', dotClass: 'dot-ep' },
      { id: '心衰与重症心肌', name: '心衰与重症心肌', dotClass: 'dot-hf' },
      { id: '冠脉介入与结构', name: '冠脉介入与结构', dotClass: 'dot-cad' },
      { id: '心血管影像与表型', name: '心血管影像与表型', dotClass: 'dot-imaging' },
      { id: '脑血管与高血压', name: '脑血管与高血压', dotClass: 'dot-neuro' },
      { id: 'AI医疗与数字医学', name: 'AI医疗与数字医学', dotClass: 'dot-aimed' },
      { id: '顶级综合与科学', name: '顶级综合与科学', dotClass: 'dot-general' },
      { id: '前沿大模型与科技', name: '前沿大模型与科技', dotClass: 'dot-tech' },
      { id: '定向专病与团队', name: '定向专病与团队', dotClass: 'dot-team' },
      { id: '综合医学与其他', name: '综合医学与其他', dotClass: 'dot-general' }
    ];

    dataset.forEach(p => {
      const t = p.clinicalTier || '综合医学与其他';
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    });

    const tierListEl = $('#tierFilterList');
    if (tierListEl) {
      const availableTiers = new Set(base.map(p => p.clinicalTier || '综合医学与其他'));
      tierListEl.innerHTML = tiers.filter(t => t.id === '' || availableTiers.has(t.id) || state.clinicalTier === t.id).map(t => {
        const isAll = t.id === '';
        const count = isAll ? dataset.length : (tierCounts[t.id] || 0);
        const isActive = isAll ? !state.clinicalTier : state.clinicalTier === t.id;

        return `<li class="facet-option-row">
          <button type="button" class="filter-item-btn ${isActive ? 'active' : ''}" data-filter-tier="${esc(t.id)}" aria-pressed="${isActive}">
            <span style="display:flex; align-items:center;"><span class="tier-dot ${t.dotClass}"></span>${esc(t.name)}</span>
            <span class="filter-count">${count}</span>
          </button>
          ${browseOnlyButton('tier', t.id, t.name)}
        </li>`;
      }).join('');
    }

    // 2. Publisher & Journals Tree (Sorted by prestigious academic hierarchy)
    const PUBLISHER_ORDER = [
      'MMS (NEJM)',
      'The Lancet Group',
      'JAMA Network',
      'AHA (Circulation)',
      'Elsevier / ACC / HRS',
      'Oxford (OUP / ESC)',
      'BMJ Group',
      'Nature Portfolio',
      'Wiley',
      'AAAS (Science)',
      'NAS (PNAS)',
      'PubMed 专题追踪',
      'AI 与科技前沿',
      '其他学术刊物'
    ];

    const pubMap = new Map();
    // Keep zero-count options available so "只看" can leave a combination.
    base.forEach(p => {
      const pub = p.publisher || '其他学术刊物';
      const j = p.cleanJournal || p.journal || '其他';
      if (!pubMap.has(pub)) pubMap.set(pub, new Map());
      pubMap.get(pub).set(j, 0);
    });
    if (state.publisher && !pubMap.has(state.publisher)) pubMap.set(state.publisher, new Map());
    if (state.journal) {
      const pub = state.publisher || '其他学术刊物';
      if (!pubMap.has(pub)) pubMap.set(pub, new Map());
      if (!pubMap.get(pub).has(state.journal)) pubMap.get(pub).set(state.journal, 0);
    }
    facet('pub').forEach(p => {
      const jMap = pubMap.get(p.publisher || '其他学术刊物');
      const j = p.cleanJournal || p.journal || '其他';
      jMap.set(j, (jMap.get(j) || 0) + 1);
    });

    const pubAccEl = $('#publisherAccordion');
    if (pubAccEl) {
      // Sort publishers strictly by PUBLISHER_ORDER
      const sortedPubEntries = Array.from(pubMap.entries()).sort((a, b) => {
        let idxA = PUBLISHER_ORDER.indexOf(a[0]);
        let idxB = PUBLISHER_ORDER.indexOf(b[0]);
        if (idxA === -1) idxA = 999;
        if (idxB === -1) idxB = 999;
        return idxA - idxB || a[0].localeCompare(b[0]);
      });

      let accHtml = '', pubIndex = 0;
      for (const [pubName, journals] of sortedPubEntries) {
        const contentId = 'publisher-journals-' + pubIndex++;
        const pubTotal = Array.from(journals.values()).reduce((a, b) => a + b, 0);
        const isPubActive = state.publisher === pubName;
        const isOpen = expandedPublishers.has(pubName);

        // Sort journals inside publisher by volume descending, then name
        const sortedJournals = Array.from(journals.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

        let jHtml = '';
        for (const [jName, jCount] of sortedJournals) {
          const isJActive = state.journal === jName;
          jHtml += `<div class="journal-filter-item facet-option-row"><button type="button" class="accordion-journal-btn ${isJActive ? 'active' : ''}" data-filter-journal="${esc(jName)}" aria-pressed="${isJActive}">
            <span class="journal-filter-label"><span>${state.favoriteJournals?.includes(jName) ? '<span class="journal-followed" title="我的期刊">★</span> ' : ''}${esc(jName)}</span></span>
            <span class="filter-count">${jCount}</span>
          </button>${browseOnlyButton('journal', jName, jName)}</div>`;
        }

        accHtml += `
          <div class="accordion-group ${isOpen ? 'open' : ''}">
            <div class="accordion-heading">
              <button type="button" class="accordion-header ${isPubActive && !state.journal ? 'active' : ''}" data-filter-publisher="${esc(pubName)}" aria-pressed="${isPubActive && !state.journal}">
                <span>${esc(pubName)} <span class="filter-count">(${pubTotal})</span></span>
              </button>
              ${browseOnlyButton('pub', pubName, pubName)}
              <button type="button" class="accordion-expand-btn" data-pub-expand="${esc(pubName)}" aria-expanded="${isOpen}" aria-controls="${contentId}" aria-label="展开或收起${esc(pubName)}旗下期刊"><span class="accordion-arrow" aria-hidden="true">▶</span></button>
            </div>
            <div class="accordion-content" id="${contentId}">
              ${jHtml}
            </div>
          </div>
        `;
      }
      pubAccEl.innerHTML = accHtml || '<p class="text-muted" style="padding:10px; font-size:12px;">暂无匹配期刊</p>';
    }

    // 3. Study Design Counts
    const designCounts = {};
    facet('design').forEach(p => {
      const d = p.studyDesign || '研究类型待核验';
      designCounts[d] = (designCounts[d] || 0) + 1;
    });

    const designs = [
      { name: '全部设计', key: '' },
      { name: 'RCT 随机对照', key: 'RCT' },
      { name: 'RCT 二次分析', key: 'RCT 二次分析' },
      { name: '二次分析（母研究待核验）', key: '二次分析' },
      { name: '已撤稿', key: '已撤稿' },
      { name: '存在关注声明', key: '存在关注声明' },
      { name: '撤稿声明', key: '撤稿声明' },
      { name: '关注声明', key: '关注声明' },
      { name: '更正声明', key: '更正声明' },
      { name: '队列研究', key: '队列研究' },
      { name: 'Meta/系统综述', key: 'Meta/综述' },
      { name: '方法/模型验证', key: '方法/模型验证' },
      { name: '指南共识', key: '指南共识' },
      { name: '述评观点', key: '述评观点' },
      { name: '叙述综述', key: '叙述综述' },
      { name: '研究方案', key: '研究方案' },
      { name: '横断面研究', key: '横断面研究' },
      { name: '研究类型待核验', key: '研究类型待核验' }
    ];

    const designListEl = $('#designFilterList');
    if (designListEl) {
      designListEl.innerHTML = designs.map(d => {
        const isAll = d.key === '';
        const count = isAll ? facet('design').length : (designCounts[d.key] || 0);
        const isActive = isAll ? !state.studyDesign : state.studyDesign === d.key;

        return `<li class="facet-option-row">
          <button type="button" class="filter-item-btn ${isActive ? 'active' : ''}" data-filter-design="${esc(d.key)}" aria-pressed="${isActive}">
            <span>${d.name}</span>
            <span class="filter-count">${count}</span>
          </button>
          ${browseOnlyButton('design', d.key, d.name)}
        </li>`;
      }).join('');
    }

    // 4. Tags Cloud
    const tagCounts = {};
    base.forEach(p => (p.tags || []).forEach(t => { tagCounts[t] = 0; }));
    if (state.tag) tagCounts[state.tag] = 0;
    facet('tag').forEach(p => {
      (p.tags || []).forEach(t => {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      });
    });

    const tagsCloudEl = $('#tagsCloud');
    if (tagsCloudEl) {
      const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
      tagsCloudEl.innerHTML = sortedTags.map(([tag, count]) => {
        const isActive = state.tag === tag;
        return `<span class="facet-option-row tag-option"><button type="button" class="tag-chip ${isActive ? 'active' : ''}" data-filter-tag="${esc(tag)}" aria-pressed="${isActive}">
          ${esc(tag)} (${count})
        </button>${browseOnlyButton('tag', tag, tag)}</span>`;
      }).join('') || '<span class="text-muted" style="font-size:12px;">暂无标签</span>';
    }
  }

  // Render Active Filter Chips
  function renderActiveFilterChips(totalCount) {
    const container = $('#activeFiltersBar');
    if (!container) return;

    const selections = sidebarSelections();
    let chips = selections.length ? '<div class="sidebar-active-filters"><span class="active-filters-label">当前筛选 · 同时满足</span>'
      + selections.map(selection => `<span class="filter-badge-active"><span class="filter-badge-label">${selection.label}：${esc(selection.value)}${selection.group === 'journal' ? ' ' + journalMetricBadge(selection.value) : ''}</span><button type="button" class="filter-badge-remove" data-clear="${selection.group}" aria-label="清除${selection.label}筛选">&times;</button></span>`).join('')
      + '<button type="button" class="sidebar-clear-btn" data-clear="sidebar">清空左侧筛选</button></div>' : '';
    chips += `<span class="results-meta" role="status">共找到 <b>${totalCount}</b> 篇文献${usesLane() && !state.minor ? ' · 默认隐藏更正 / 来信' : ''}</span>`;

    if (state.search) {
      const scope = { curated: '每日精选', candidates: '文献雷达', library: '文献库' }[state.mode] || '当前栏目';
      chips += `<span class="filter-badge-active search-scope" role="status">检索范围：${scope} · 当前筛选；切换栏目保留关键词</span>`;
      chips += `<span class="filter-badge-active">搜索: "${esc(state.search)}" <button type="button" class="filter-badge-remove" data-clear="search" aria-label="清除检索关键词">&times;</button></span>`;
    }
    if (state.range !== defaultRange(state.mode) && usesLane()) {
      chips += `<span class="filter-badge-active">发表时间: ${state.range === 'all' ? '全部时间' : '近 ' + state.range + ' 天'} <button type="button" class="filter-badge-remove" data-clear="range" aria-label="恢复默认时间范围">&times;</button></span>`;
    }
    if(usesLane() && state.reading) chips+=`<span class="filter-badge-active">可读内容：${esc({'abstract':'有摘要','guide':'已核对导读','quicklook':'AI 速览'}[state.reading])}<button type="button" class="filter-badge-remove" data-clear="reading" aria-label="清除可读内容筛选">&times;</button></span>`;
    if(usesLane() && state.favoritesOnly) chips+='<span class="filter-badge-active">我的期刊（仅此浏览器保存）<button type="button" class="filter-badge-remove" data-clear="favorites" aria-label="清除我的期刊筛选">&times;</button></span>';

    container.innerHTML = chips;
  }

  function renderEmptyFilters() {
    const selections = sidebarSelections();
    const base = getCurrentDataset().filter(p => matchesFilters(p, false, 'sidebar'));
    const suggestions = selections.length > 1 ? selections.map(selection => {
      const count = base.filter(p => {
        if (selection.group === 'tier') return (p.clinicalTier || '综合医学与其他') === selection.value;
        if (selection.group === 'pub') return (p.publisher || '其他学术刊物') === selection.value;
        if (selection.group === 'journal') return p.cleanJournal === selection.value || p.journal === selection.value;
        if (selection.group === 'design') return p.studyDesign === selection.value;
        return (p.tags || []).includes(selection.value);
      }).length;
      return count ? `<button type="button" class="btn-sm" data-browse-only="${selection.group}" data-browse-value="${esc(selection.value)}">只看${esc(selection.value)} · ${count} 篇</button>` : '';
    }).join('') : '';
    const message = selections.length > 1 ? '这些条件需要同时满足，目前没有交集。可保留其中一项切换浏览。'
      : state.mode === 'curated' ? '当前条件下没有精选，可清除筛选或查看文献雷达。' : '当前领域、时间、关键词与筛选条件下暂无匹配。';
    return `<div class="empty-state"><h3>没有找到匹配的文献</h3><p>${message}</p><div class="empty-filter-actions">${suggestions}
      ${selections.length ? '<button type="button" class="btn-sm" data-clear="sidebar">清空左侧筛选</button>' : ''}
      ${state.search ? '<button type="button" class="btn-sm" data-clear="search">清除关键词</button>' : ''}
      <button type="button" class="btn-sm btn-primary" id="clearAllFiltersBtn">重置所有条件</button></div></div>`;
  }

