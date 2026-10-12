  // ==== src/app/05-list.js · Article cards, compact rows, list rendering, citations ====
  // Render Article Card
  function renderArticleCard(p) {
    const isHuddled = state.huddle.includes(p.id);
    const pubClass = getPublisherClass(p.publisher);
    const designClass = getDesignClass(p.studyDesign);
    const journalName = p.cleanJournal || p.journal || '期刊';
    const dateStr = dateLabel(p);
    const doiUrl = safeSourceUrl(p) || '#';

    const titleEn = esc(p.title);
    const titleZh = p.draftData?.title_zh ? esc(p.draftData.title_zh) : '';

    const tagsHtml = (p.tags || []).map(t => `<span class="tag-pill">${esc(t)}</span>`).join('');
    const qlc = quicklookOf(p);
    const summaryText = esc(p.draftData?.summary || p.summary || (qlc ? 'AI 速览（未核对）：' + qlc.one_line : ('暂无随附摘要，可尝试获取 Europe PMC / PubMed 公开摘要。')));
    // A Chinese one-line takeaway (when one exists) leads the card; the English abstract stays in the reader.
    const leadHtml = !p.hasDraft && qlc?.one_line && p.summary
      ? `<p class="card-lead"><span class="content-label" title="模型依据公开摘要生成，未经人工核对">AI 速览 · 未核对</span>${esc(qlc.one_line)}</p>${qlc.why_read ? `<p class="card-why"><b>为什么读：</b>${esc(qlc.why_read)}</p>` : ''}`
      : '';

    return `
      <article class="article-card" data-paper-id="${esc(p.id)}">
        <div class="card-top">
          <div class="meta-badges">
            <span class="journal-badge ${pubClass}">${esc(journalName)}</span>
            ${journalMetricBadge(p)}
            ${designBadgeHtml(p)}
            ${p.kind ? `<span class="tag-pill kind-pill">${esc(p.kind)}</span>` : ''}
            ${p.autoPick && !p.hasDraft ? `<span class="tag-pill auto-pick-pill" title="由规则从当日新文献中自动选出，AI 速览未经人工核验">自动精选</span>` : ''}
            ${p.clinicalTier ? `<span class="tag-pill" style="border:none; background:transparent; font-weight:500;">${esc(p.clinicalTier)}</span>` : ''}
            ${p.media && p.media.length ? p.media.slice(0, 2).map(m => `<a class="media-pill" href="${esc(m.u)}" target="_blank" rel="noopener noreferrer" title="${esc(m.t)}">媒体关注 · ${esc(m.s)}</a>`).join('') : ''}
          </div>
          <span class="date-badge" title="${esc(p.dateBasis || '来源记录日期，未经逐篇核验')}">${esc(dateStr)}</span>
        </div>

        ${publicationStatusHtml(p)}
        ${!p.hasDraft && qlc?.title_zh ? `<div class="article-title-zh ql-title"><span class="content-label">机器翻译</span>${esc(qlc.title_zh)}</div>` : ''}
        ${!p.hasDraft && !qlc?.title_zh && p.titleZh ? `<div class="article-title-zh ql-title"><span class="content-label">机器翻译</span>${esc(p.titleZh)}</div>` : ''}
        ${titleZh ? `<div class="article-title-zh"><span class="verified-badge" title="已对照期刊公开摘要核对；非全文精读，未经医生终审">摘要核对</span>${titleZh}</div>` : ''}
        <h3 class="article-title"><button class="title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}">${titleEn}</button></h3>

        ${leadHtml || `<p class="article-abstract">${summaryText}</p>`}
        ${p.draftData?.limitations ? `<p class="card-limit"><b>证据边界：</b>${esc(p.draftData.limitations)}</p>` : ''}
        ${p.draftData?.learning_question ? `<p class="card-question"><b>共读问题：</b>${esc(p.draftData.learning_question)}</p>` : ''}

        ${tagsHtml ? `<div class="article-card-tags">${tagsHtml}</div>` : ''}

        <div class="card-actions">
          <div class="action-buttons-group">
            <button class="btn-sm btn-primary" data-action="open-drawer" data-paper-id="${esc(p.id)}">${p.hasDraft ? '阅读导读与摘要' : qlc ? '阅读 AI 速览' : '阅读摘要'}</button>
            ${p.hasDraft ? `<button class="btn-sm btn-share" data-action="share-wechat" data-paper-id="${esc(p.id)}">微信群文案</button>` : ''}
            <button class="btn-sm ${isHuddled ? 'active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}">
              ${isHuddled ? '已入精选 ✓' : '加入精选清单'}
            </button>
          </div>

          <div class="card-source-actions">
            ${pdfDownloadLink(p)}
            ${doiUrl!=='#' ? `<a href="${esc(doiUrl)}" target="_blank" rel="noopener" class="btn-sm">官网原文 ↗</a>` : '<span class="text-muted">原文链接待补</span>'}
          </div>
        </div>
      </article>
    `;
  }

  // Render Compact Row
  function renderCompactRow(p) {
    const isHuddled = state.huddle.includes(p.id);
    const pubClass = getPublisherClass(p.publisher);
    const designClass = getDesignClass(p.studyDesign);
    const journalName = p.cleanJournal || p.journal || '期刊';
    const dateStr = dateLabel(p);
    const doiUrl = safeSourceUrl(p) || '#';
    const translatedTitle = p.draftData?.title_zh || quicklookOf(p)?.title_zh || p.titleZh;
    const title = esc(p.draftData?.title_zh ? `[导读] ${p.draftData.title_zh}` : translatedTitle || p.title);

    return `
      <div class="compact-row" data-paper-id="${esc(p.id)}">
        <div class="compact-main">
          <button class="compact-title title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}" title="${esc(p.title)}">${title}</button>
          ${translatedTitle ? `<div class="compact-original-title" lang="en">${esc(p.title)}</div>` : ''}
          ${publicationStatusHtml(p)}
          <div class="compact-meta">
            <span class="journal-badge ${pubClass}" title="${esc(journalName)}">${esc(journalName)}</span>
            ${journalMetricBadge(p)}
            ${designBadgeHtml(p)}
            ${p.kind ? `<span class="tag-pill kind-pill">${esc(p.kind)}</span>` : ''}
            <span class="date-badge" title="${esc(p.dateBasis || '来源记录日期，未经逐篇核验')}">${esc(dateStr)}</span>
          </div>
        </div>
        <div class="compact-actions">
          <button class="btn-sm" data-action="open-drawer" data-paper-id="${esc(p.id)}" title="速读">速读</button>
          ${p.hasDraft ? `<button class="btn-sm btn-share" data-action="share-wechat" data-paper-id="${esc(p.id)}" title="复制微信文案">文案</button>` : ''}
          <button class="btn-sm ${isHuddled ? 'active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}" title="精选清单">${isHuddled ? '已入' : '精选'}</button>
          ${pdfDownloadLink(p)}
          ${doiUrl!=='#' ? `<a href="${esc(doiUrl)}" target="_blank" rel="noopener" class="btn-sm" title="官网原文">↗</a>` : '<span class="text-muted" title="原文链接待补">—</span>'}
        </div>
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
    const sidebar = $('#appSidebar'); if (sidebar) sidebar.style.display = noSidebar ? 'none' : '';
    const toggle = $('#filterToggleBtn'); if (toggle) toggle.hidden = noSidebar;
    const app = $('.app-container');
    if (app) {
      app.classList.toggle('full-width-layout', noSidebar);
      app.classList.toggle('weekly-layout', !doi && state.mode === 'weekly');
      app.classList.toggle('sources-layout', !doi && state.mode === 'sources');
    }
  }
  function supplementalLibraryNotice() {
    if (SUPPLEMENTAL_LIBRARY.state === 'error') return '<div class="doi-library-notice">补录文献暂未加载，已保留现有文献。<button class="btn-sm" data-action="refresh-doi-library">重试加载</button></div>';
    if (SUPPLEMENTAL_LIBRARY.more) return '<div class="doi-library-notice">还有补录文献未显示。<button class="btn-sm" data-action="load-doi-library">继续加载补录</button></div>';
    return '';
  }
  function renderDoiStream(doi, streamEl, loadMoreBtn) {
    const papers = exactDoiPapers(doi), lookup = DOI_LOOKUPS.get(doi);
    const job = DOI_JOBS.get(doi), activeJob = doiJobActive(job);
    ['#aiDigest', '#modeNote', '#laneBar', '#rangeBar', '#browseBar', '#browseToggle', '#homeIntro', '#sortSelector'].forEach(selector => { const el = $(selector); if (el) el.hidden = true; });
    const filters = $('#activeFiltersBar');
    if (filters) filters.innerHTML = `<span class="results-meta">按 DOI 全站检索 · <b>${papers.length}</b> 篇文献</span><span class="filter-badge-active doi-filter-badge"><span class="doi-filter-value">${esc(doi)}</span><button class="filter-badge-remove" data-clear="search" aria-label="清除 DOI 检索">&times;</button></span>`;
    const pendingLookup = !lookup || lookup.state === 'loading';
    const uncertain = lookup && ['error', 'unsupported'].includes(lookup.state);
    const message = pendingLookup ? '正在检查补录文献…' : uncertain ? '已检索现有题录；补录状态暂不可用。' : papers.length ? '已按完整 DOI 匹配，当前栏目与筛选条件不影响结果。' : '站内暂未收录这个 DOI。';
    let conflictNotice = '';
    const record = DOI_FULLTEXT.get(doi);
    if (record) {
      const conflicts = STATIC_DOI_PAPERS.filter(p => exactDoi(p.doi) === doi && !sameDoiTitle(p.title, record.title));
      if (conflicts.length) conflictNotice = `<div class="doi-identity-notice"><b>原有题录对应待核实</b><p>原有题名：${esc(conflicts[0].title)}</p><p>本次官方题名：${esc(record.title)}。新全文仅与下方相符题名关联；原有导读保留。</p></div>`;
    }
    streamEl.className = state.viewMode === 'compact' ? 'articles-stream compact-mode' : 'articles-stream';
    streamEl.innerHTML = `<div class="doi-search-notice"><h3>按 DOI 全站检索</h3><p>${message}</p>${doiJobNotice(doi)}<button class="btn-sm" data-action="refresh-doi-status" data-doi="${esc(doi)}"${pendingLookup ? ' disabled' : ''}>刷新收录状态</button></div>`
      + conflictNotice + papers.map(state.viewMode === 'compact' ? renderCompactRow : renderArticleCard).join('')
      + (!papers.length ? '<div class="empty-state doi-empty"><h3>' + (activeJob ? '后台任务已提交' : pendingLookup ? '正在核对收录状态' : uncertain ? '现有题录未命中' : '未找到站内文献') + '</h3><p>' + (activeJob ? '后台取得官方题录后会加入文献库，取得全文后可下载。' : '输入全文口令提交请求；取得并核验全文后，这里会出现“下载 PDF”。') + '</p><a href="' + esc(job && !activeJob ? '/api/acquire/retry?doi=' + encodeURIComponent(doi) : acquireDoiUrl(doi)) + '" target="_blank" rel="noopener" class="btn-sm btn-primary">' + (activeJob ? '查看任务状态' : job ? '重新提交全文任务' : '获取全文') + '</a></div>' : '');
    if (loadMoreBtn) loadMoreBtn.hidden = true;
    if (!lookup) lookupSupplementalDoi(doi);
  }
  function renderStream() {
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

    const filtered = getFilteredArticles();
    renderDigestBar(filtered);
    renderActiveFilterChips(filtered.length);
    renderModeNote();
    renderLaneBar();
    renderRangeBar();
    renderBrowseBar();
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

