  // ==== src/app/05-list.js · Article cards, compact rows, list rendering, citations ====

  // Render Article Card
  function renderArticleCard(p) {
    const isHuddled = state.huddle.includes(p.id);
    const pubClass = getPublisherClass(p.publisher);
    const journalName = cardJournalName(p);
    const dateStr = dateLabel(p);

    const titleEn = esc(p.title);
    const reviewedZh = p.draftData?.title_zh || '';
    const machineZh = !p.hasDraft ? (quicklookOf(p)?.title_zh || p.titleZh || '') : '';
    const zh = reviewedZh || machineZh;
    const pid = esc(p.id);

    const titleBlock = `<h3 class="article-title"><button class="title-open" data-action="open-drawer" data-paper-id="${pid}">${zh ? esc(zh) : titleEn}</button></h3>`;

    // 有中文标题时，英文原题作为一行弱化副标题；英文检索命中时完整显示
    const q = (state.search || '').toLowerCase().split(/\s+/).filter(t => t.length > 1 && /[a-z]/.test(t));
    const enHit = zh && q.length && !exactDoi(state.search) && q.some(t => String(p.title || '').toLowerCase().includes(t));
    const enLine = zh ? `<p class="article-title-en${enHit ? ' is-hit' : ''}" lang="en" title="${titleEn}">${titleEn}</p>` : '';

    const gist = p.hasDraft ? (p.draftData?.summary || '') : (quicklookOf(p)?.one_line || '');
    const gistHtml = gist ? `<p class="article-gist${p.hasDraft ? '' : ' gist-ai'}">${esc(gist)}</p>` : '';

    const doiBlock = doiStatusBlock(p);

    return `
      <article class="article-card has-side-actions" data-paper-id="${pid}">
        <div class="card-main">
          <div class="card-top">
            <span class="journal-badge ${pubClass}">${esc(journalName)}</span>
            <span class="date-badge">${esc(dateStr)}</span>
            ${designBadgeHtml(p)}
          </div>
          ${publicationStatusHtml(p)}
          ${titleBlock}
          ${enLine}
          ${gistHtml}
        </div>

        ${cardSideActionsHtml(p)}
        ${doiBlock}
      </article>
    `;
  }

  // Render Compact Row
  function renderCompactRow(p) {
    const pubClass = getPublisherClass(p.publisher);
    const journalName = cardJournalName(p);
    const dateStr = dateLabel(p);
    const pid = esc(p.id);
    const titleEn = esc(p.title);
    const zh = p.draftData?.title_zh || (!p.hasDraft ? (quicklookOf(p)?.title_zh || p.titleZh || '') : '');
    const doiBlock = doiStatusBlock(p);

    return `
      <div class="compact-row" data-paper-id="${pid}">
        <div class="compact-main">
          <button class="compact-title title-open" data-action="open-drawer" data-paper-id="${pid}" title="${titleEn}">${zh ? esc(zh) : titleEn}</button>
          ${zh ? `<p class="article-title-en" lang="en" title="${titleEn}">${titleEn}</p>` : ''}
          ${publicationStatusHtml(p)}
          ${doiBlock}
          <div class="compact-meta">
            <span class="journal-badge ${pubClass}" title="${esc(journalName)}">${esc(journalName)}</span>
            <span class="date-badge">${esc(dateStr)}</span>
            ${designBadgeHtml(p)}
          </div>
        </div>
        ${cardSideActionsHtml(p)}
      </div>
    `;
  }

  // Main Render Stream
  function applyDoiSearchLayout(doi) {
    const special = state.mode === 'weekly' || state.mode === 'sources';
    const stream = $('#streamSection'), weekly = $('#weeklySection'), sources = $('#sourcesSection');
    if (stream) stream.hidden = !doi && special;
    if (weekly) weekly.hidden = !!doi || state.mode !== 'weekly';
    if (sources) sources.hidden = !!doi || state.mode !== 'sources';
    const noSidebar = !!doi || special || state.mode === 'curated';
    { const head = $('#listHead'); if (head) head.hidden = special || !!doi; }
    const rail = $('#streamRail'); if (rail) rail.hidden = !!doi || state.mode !== 'curated';
    const sidebar = $('#appSidebar'); if (sidebar) sidebar.style.display = noSidebar ? 'none' : '';
    const toggle = $('#filterToggleBtn'); if (toggle) toggle.hidden = noSidebar;
    const app = $('.app-container');
    if (app) {
      app.classList.toggle('full-width-layout', noSidebar);
      app.classList.toggle('curated-layout', !doi && state.mode === 'curated');
      app.classList.toggle('weekly-layout', !doi && state.mode === 'weekly');
      app.classList.toggle('sources-layout', !doi && state.mode === 'sources');
    }
    if (doi || special) syncToolRowVisibility();
  }
  function supplementalLibraryNotice() {
    if (SUPPLEMENTAL_LIBRARY.state === 'error') return '<div class="doi-library-notice">补录文献暂未加载，已保留现有文献。<button class="btn-sm" data-action="refresh-doi-library">重试加载</button></div>';
    if (SUPPLEMENTAL_LIBRARY.more) return '<div class="doi-library-notice">还有补录文献未显示。<button class="btn-sm" data-action="load-doi-library">继续加载补录</button></div>';
    return '';
  }
  function renderDoiStream(doi, streamEl, loadMoreBtn) {
    if (DEFERRED && !partsReady('feeds', 'library', 'quicklooks', 'radar')) {
      ['#aiDigest', '#modeNote', '#laneBar', '#rangeBar', '#ftBar', '#curatedDayBar', '#sortSelector'].forEach(selector => { const el = $(selector); if (el) el.hidden = true; });
      const filters = $('#activeFiltersBar');
      if (filters) filters.innerHTML = `<span class="results-meta">按 DOI 全站检索 · 加载中</span><span class="filter-badge-active doi-filter-badge"><span class="doi-filter-value">${esc(doi)}</span><button class="filter-badge-remove" data-clear="search" aria-label="清除 DOI 检索">&times;</button></span>`;
      const failed = ['feeds', 'library', 'quicklooks', 'radar'].filter(n => PART_STATE[n] === 'error');
      streamEl.className = state.viewMode === 'compact' ? 'articles-compact-list' : 'articles-stream';
      streamEl.innerHTML = '<p class="data-loading-note" role="status">加载中'
        + (failed.length ? ' <button type="button" class="btn-sm" data-action="retry-part">重试</button>' : '')
        + '</p>';
      if (loadMoreBtn) loadMoreBtn.hidden = true;
      if (!DOI_LOOKUPS.get(doi)) lookupSupplementalDoi(doi);
      return;
    }
    const papers = exactDoiPapers(doi), lookup = DOI_LOOKUPS.get(doi);
    const job = DOI_JOBS.get(doi), activeJob = doiJobActive(job);
    ['#aiDigest', '#modeNote', '#laneBar', '#rangeBar', '#curatedDayBar', '#sortSelector'].forEach(selector => { const el = $(selector); if (el) el.hidden = true; });
    const filters = $('#activeFiltersBar');
    if (filters) filters.innerHTML = `<span class="results-meta">按 DOI 全站检索 · <b>${papers.length}</b> 篇文献</span><span class="filter-badge-active doi-filter-badge"><span class="doi-filter-value">${esc(doi)}</span><button class="filter-badge-remove" data-clear="search" aria-label="清除 DOI 检索">&times;</button></span>`;
    const pendingLookup = !lookup || lookup.state === 'loading';
    const uncertain = lookup && ['error', 'unsupported'].includes(lookup.state);
    const radarNote = papers.length ? '' : radarArchiveNotice();
    const radarPending = !papers.length && (RADAR_LOAD.state === 'loading' || RADAR_LOAD.state === 'idle');
    const radarError = !papers.length && RADAR_LOAD.state === 'error';
    const message = pendingLookup ? '正在检查补录文献…' : uncertain ? '已检索现有题录；补录状态暂不可用。' : papers.length ? '已按完整 DOI 匹配，当前栏目与筛选条件不影响结果。' : radarNote ? '' : '站内暂未收录这个 DOI。';
    // The bibliography-conflict note is maintainer information; ordinary readers only see the one status block.
    let conflictNotice = '';
    const record = DOI_FULLTEXT.get(doi);
    if (record && ftMaintainerMode()) {
      const conflicts = STATIC_DOI_PAPERS.filter(p => exactDoi(p.doi) === doi && !sameDoiTitle(p.title, record.title));
      if (conflicts.length) conflictNotice = `<div class="doi-identity-notice"><b>维护者：原有题录对应待核实</b><p>原有题名：${esc(conflicts[0].title)}</p><p>本次官方题名：${esc(record.title)}。新全文仅与下方相符题名关联；原有导读保留。</p></div>`;
    }
    streamEl.className = state.viewMode === 'compact' ? 'articles-stream compact-mode' : 'articles-stream';
    const plainMatch = papers.length && !pendingLookup && !uncertain;
    streamEl.innerHTML = (plainMatch ? '' : `<div class="doi-search-notice"><h3>按 DOI 全站检索</h3>${message ? `<p>${message}</p>` : ''}${uncertain ? `<button class="btn-sm" data-action="refresh-doi-status" data-doi="${esc(doi)}">重试检索</button>` : ''}${radarNote}</div>`)
      + conflictNotice + papers.map(state.viewMode === 'compact' ? renderCompactRow : renderArticleCard).join('')
      + (!papers.length ? '<div class="empty-state doi-empty"><h3>' + (activeJob ? '后台任务已提交' : (pendingLookup || radarPending) ? '正在核对收录状态' : (uncertain || radarError) ? '现有题录未命中' : '未找到站内文献') + '</h3>' + fulltextStatusHtml({ doi }, true) + '</div>' : '');
    if (loadMoreBtn) loadMoreBtn.hidden = true;
    if (!lookup) lookupSupplementalDoi(doi);
  }
  function renderStream() {
    if (DEFERRED) prioritizeParts();
    if (DOI_JOB_WATCH.doi && exactDoi(state.search) !== DOI_JOB_WATCH.doi) watchDoiJob(DOI_JOB_WATCH.doi);
    const streamEl = $('#articlesStream');
    const loadMoreBtn = $('#loadMoreBtn');
    if (!streamEl) return;

    const doi = exactDoi(state.search);
    if (radarArchiveNeeded()) loadRadarArchive();
    applyDoiSearchLayout(doi);
    if (doi) { renderDoiStream(doi, streamEl, loadMoreBtn); syncUrl(); return; }
    if (state.mode === 'weekly') { renderWeeklyHeader(); renderNextCandidates(); syncUrl(); return; }
    if (state.mode === 'sources') { renderSourcesHealth(); syncUrl(); return; }

    const req = neededParts();
    if (DEFERRED && !partsReady(...req)) {
      ['#aiDigest', '#modeNote', '#laneBar', '#rangeBar', '#ftBar', '#curatedDayBar', '#sortSelector'].forEach(selector => { const el = $(selector); if (el) el.hidden = true; });
      const filters = $('#activeFiltersBar');
      if (filters) filters.innerHTML = '';
      const total = $('#listTotal');
      if (total) total.textContent = '加载中';
      const apply = $('#panelApplyBtn');
      if (apply) { apply.textContent = '加载中'; apply.dataset.empty = ''; }
      const failed = req.filter(n => PART_STATE[n] === 'error');
      streamEl.className = state.viewMode === 'compact' ? 'articles-compact-list' : 'articles-stream';
      streamEl.innerHTML = '<p class="data-loading-note" role="status">加载中'
        + (failed.length ? ' <button type="button" class="btn-sm" data-action="retry-part">重试</button>' : '')
        + '</p>';
      if (loadMoreBtn) loadMoreBtn.hidden = true;
      syncUrl();
      return;
    }

    const filtered = getFilteredArticles();
    renderDigestBar(filtered);
    renderActiveFilterChips(filtered.length);
    syncToolRowVisibility();
    renderCuratedDayBar();
    renderMoreFilters();
    { const ss = $('#sortSelector'); if (ss) { ss.hidden = state.mode === 'curated'; ss.value = state.sort; } }
    syncUrl();

    if (filtered.length === 0) {
      streamEl.innerHTML = radarArchiveNotice() + renderEmptyFilters();
      if (state.mode === 'library') streamEl.innerHTML += supplementalLibraryNotice();
        if (loadMoreBtn) loadMoreBtn.hidden = true;
      return;
    }

    const pageLen = state.viewMode === 'compact' ? 50 : state.pageSize;
    const visibleItems = filtered.slice(0, state.page * pageLen);

    const groupBy = state.mode === 'curated' ? null : (state.sort === 'journal-date' ? 'journal' : (state.sort === 'date-asc' || state.sort === 'date-desc') ? 'date' : null);
    if (groupBy && state.mode !== 'curated') {
      const maxD = maxDate();
      const recentCut = maxD ? (() => { const d = new Date(maxD.slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 45); return d.toISOString().slice(0, 10); })() : '';
      const keyOf = p => groupBy === 'journal' ? (p.cleanJournal || p.journal || '未标注期刊')
        : (datePrecision(p)==='month' ? p.date.slice(0,7)+' · 刊期（日未核验）' : ((p.date || '') >= recentCut ? (p.date || '日期待核验').slice(0, 10) : ((p.date || '').slice(0, 7) || '日期待核验')));
      const totals = new Map();
      filtered.forEach(p => { const k = keyOf(p); totals.set(k, (totals.get(k) || 0) + 1); });
      const groups = new Map();
      visibleItems.forEach(p => { const k = keyOf(p); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
      const compact = state.viewMode === 'compact';
      streamEl.className = compact ? 'articles-compact-list' : 'articles-stream';
      streamEl.innerHTML = Array.from(groups.entries()).map(([k, arr]) => {
        const first = arr[0].date ? arr[0].date.slice(0, 10) : '';
        const label = groupBy === 'journal' ? `${esc(k)} ${journalMetricBadge(k)} <small>共 ${totals.get(k)} 篇 · 最新 ${esc((filtered.find(p => (p.cleanJournal || p.journal || '未标注期刊') === k) || {}).date?.slice(0, 10) || '')}</small>` : `${esc(k)} <small>${totals.get(k)} 篇</small>`;
        return `<h2 class="day-heading">${label}</h2>` + arr.map(compact ? renderCompactRow : renderArticleCard).join('');
      }).join('');
    } else if (state.mode === 'curated') {
      streamEl.className = state.viewMode==='compact' ? 'articles-compact-list' : 'articles-stream';
      const groups = new Map();
      visibleItems.forEach(p => {
        const d = publishedDate(p);
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push(p);
      });
      streamEl.innerHTML = Array.from(groups.entries()).map(([d, arr]) =>
        `<h2 class="day-heading">${esc(d)} · 每日精选 <small>${arr.length} 篇</small></h2>` + arr.map(state.viewMode==='compact'?renderCompactRow:renderArticleCard).join('')
      ).join('');
      // At the end of one day, offer the previous day instead of a dead end.
      const days = curatedDays(), day = curatedDay(days), index = days.findIndex(([d]) => d === day);
      if (day && index >= 0 && index < days.length - 1) {
        const [older, count] = days[index + 1];
        streamEl.insertAdjacentHTML('beforeend', `<button type="button" class="load-more-btn day-next-btn" data-day="${esc(older)}">继续看 ${esc(older)} · ${count} 篇</button>`);
      }
    } else if (state.viewMode === 'compact') {
      streamEl.className = 'articles-compact-list';
      streamEl.innerHTML = visibleItems.map(renderCompactRow).join('');
    } else {
      streamEl.className = 'articles-stream';
      streamEl.innerHTML = visibleItems.map(renderArticleCard).join('');
    }

    if (state.mode === 'library') streamEl.innerHTML += supplementalLibraryNotice();
    { const note = radarArchiveNotice(); if (note) streamEl.insertAdjacentHTML('afterbegin', note); }
    if (loadMoreBtn) {
      loadMoreBtn.hidden = visibleItems.length >= filtered.length;
    }
  }

  function buildCitations(p) {
    const year = (p.date || '').slice(0, 4);
    const j=p.cleanJournal || p.journal || '';
    const journal=/^PubMed:/.test(j)?'期刊待补':j;
    const authors = Array.isArray(p.authors) ? p.authors.filter(Boolean) : [];
    const doi = p.doi || '';
    const gbAuth = authors.length ? (authors.slice(0, 3).join(', ') + (authors.length > 3 ? ', 等' : '') + '. ') : '';
    const amaAuth = authors.length ? (authors.slice(0, 6).join(', ') + (authors.length > 6 ? ', et al' : '') + '. ') : '';
    const gb = `${gbAuth}${p.title}[J]. ${journal}${year ? ', ' + year : ''}${doi ? '. DOI: ' + doi : ''}.`;
    const ama = `${amaAuth}${p.title}. ${journal}.${p.date ? ' '+dateLabel(p)+'.' : ''}${doi ? ' doi:' + doi : ''}`;
    const key = (doi || p.id || 'ref').replace(/[^A-Za-z0-9]+/g, '');
    const bib = `@article{${key},\n  title={${p.title}},\n${authors.length ? '  author={' + authors.join(' and ') + '},\n' : ''}  journal={${journal}},\n${year ? '  year={' + year + '},\n' : ''}${doi ? '  doi={' + doi + '}\n' : ''}}`;
    return { gb, ama, bibtex: bib };
  }

  let lastFocus = null;

