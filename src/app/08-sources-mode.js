  // ==== src/app/08-sources-mode.js · Source health page and mode switching ====
  // Render Sources Health Grid
  function sourceHealthDetails(s) {
    const reason = {
      publisher_access_challenge: '出版商返回访问验证页，本轮停止继续请求同主机。',
      publisher_cookie_requirement: '出版商要求浏览器 Cookie，订阅请求跳转到网页。',
      publisher_login_page: '订阅请求跳转到登录页。',
      feed_redirected_to_journal_page: '旧订阅地址跳转到期刊网页，未取得 RSS。',
      html_instead_of_feed: '本轮返回网页内容，未取得有效订阅。',
      http_access_refusal: '同主机已拒绝或限流，本轮没有继续请求。'
    }[s.failureReason || s.blockedReason];
    const parts = reason ? [reason] : [];
    if (!['ok', 'empty_feed', 'filtered_empty'].includes(s.status)) {
      const last = typeof s.lastSuccessfulAt === 'string' ? Date.parse(s.lastSuccessfulAt) : NaN;
      if (Number.isFinite(last) && last <= Date.now()) {
        parts.push(s.lastSuccessfulAtBasis === 'strict_feed_parse'
          ? `最近严格解析成功：${contentDate(s.lastSuccessfulAt)}（北京时间）。`
          : `历史成功记录：${contentDate(s.lastSuccessfulAt)}（北京时间，未核验为严格订阅解析）。`);
      } else parts.push('尚无可核实的最近订阅成功记录。');
    }
    const x = s.excludedItems;
    if (x) {
      const reasons = [[x.undated, '日期缺失'], [x.olderThan14Days, '超出14天'], [x.future, '未来日期'], [x.unclassifiedOrInvalid, '主题或链接未入选']]
        .filter(([n]) => n > 0).map(([n, label]) => `${label} ${n} 条`);
      if (reasons.length) parts.push(reasons.join('；') + '。');
    } else if (s.status === 'filtered_empty') parts.push('已有订阅条目未通过日期或主题筛选，不代表期刊没有新文章。');
    const p = s.pubmedFallback;
    if (p) {
      if (p.status === 'records_observed') parts.push(`PubMed 备用快照 ${p.observedItems} 条，近14天 ${p.eligibleItems} 条${p.stale || olderThan(p.checkedAt,6) ? '（快照已过期）' : ''}。`);
      else parts.push(p.configured ? 'PubMed 备用查询尚无匹配记录。' : 'PubMed 备用查询尚未覆盖此来源。');
      if (p.checkedAt && (p.configured || p.status === 'records_observed')) parts.push(`备用检查：${contentDate(p.checkedAt)}（北京时间）。`);
      if (p.queryScope === 'cardiovascular_or_ai' && p.configured) parts.push('备用检索限心血管或 AI 主题。');
      if (p.queryTruncated && p.configured) parts.push('备用检索达到结果上限，不能据此判断完整覆盖。');
    }
    return parts.join(' ');
  }

  function renderSourcesHealth() {
    const grid = $('#sourcesHealthGrid');
    const meta = $('#sourcesHealthMeta');
    if (!grid) return;

    const sources = HEALTH.sources || [];
    const successful = s => ['ok','empty_feed','filtered_empty'].includes(s.status);
    const okCount = sources.filter(successful).length;
    const summary = $('#sourcesHealthSummary');
    if (summary) summary.innerHTML = `<div><strong>${sources.length}</strong><span>订阅信源</span></div><div><strong>${okCount}</strong><span>本轮获取成功</span></div><div class="${sources.length > okCount ? 'source-summary-attention' : ''}"><strong>${sources.length - okCount}</strong><span>需要关注</span></div>`;

    if (meta) {
      meta.textContent = `检查时间：${contentDate(HEALTH.checkedAt)}（北京时间）${olderThan(HEALTH.checkedAt,6) ? ' · 报告已过期，不能代表当前可用率' : ''}`;
      meta.classList.toggle('source-report-stale', olderThan(HEALTH.checkedAt,6));
    }

    const q = state.search.trim().toLowerCase();
    const filtered = sources.filter(s => !q || queryMatches([s.name, s.id, s.url, s.status, sourceHealthDetails(s),
      s.status === 'not_feed' ? '返回非订阅内容' : successful(s) ? '获取成功' : '获取异常 暂停'].filter(Boolean).join(' ').toLowerCase(), q));
    grid.innerHTML = specialSearchStatus('信源状态（名称、订阅地址与状态）', filtered.length, sources.length, '个信源')
      + (!filtered.length ? '<p class="special-search-empty" role="status">没有匹配的信源，请清除关键词或更换名称；论文请到文献雷达检索。</p>' : '')
      + [...filtered].sort((a, b) => Number(successful(a)) - Number(successful(b))).map(s => {
      const isOk = successful(s);
      const statusLabel = s.status === 'empty_feed' ? '有效空源' : s.status === 'filtered_empty' ? '获取成功 · 暂无入选' : isOk ? '获取成功' :
        s.status === 'not_feed' ? '返回非订阅内容' : s.status === 'not_checked_host_blocked' ? '同主机暂停检查' : s.status === 'parse_error' ? '订阅格式异常' : s.status === 'http_error' ? `来源 HTTP ${s.httpStatus || '错误'}` : '获取异常';
      return `
        <article class="source-item${isOk ? '' : ' source-needs-attention'}">
          <div class="source-item-head">
            <h3 class="source-item-name">${esc(s.name)}</h3>
            <span class="source-status-badge ${isOk ? 'source-status-ok' : 'source-status-err'}">
              ${esc(statusLabel)}
            </span>
          </div>
          <div class="source-journal-metrics">${journalMetricBadge(s.name)}${journalMetricDetails(s.name)}</div>
          <dl class="source-counts"><div><dt>原始条目</dt><dd>${isOk ? esc(s.rawItems ?? s.items ?? '未统计') : '未获取'}</dd></div><div><dt>近 14 天</dt><dd>${esc(s.eligibleItems ?? '待统计')}</dd></div><div><dt>含摘要</dt><dd>${isOk ? esc(s.itemsWithAbstracts ?? '未统计') : '未获取'}</dd></div></dl>
          ${s.cachedItems ? `<p class="source-cache-note">保留 ${esc(s.cachedItems)} 条旧缓存 · 最近缓存 ${esc(contentDate(s.lastCachedFetchAt || s.lastSuccessfulAt))}</p>` : ''}
          ${sourceHealthDetails(s) ? `<p class="source-detail-note">${esc(sourceHealthDetails(s))}</p>` : ''}
          <div class="source-item-foot"><span>检查 ${esc(contentDate(s.checkedAt || HEALTH.checkedAt))}</span>${safeSourceUrl({url:s.url}) ? `<a href="${esc(safeSourceUrl({url:s.url}))}" target="_blank" rel="noopener">查看订阅源 ↗</a>` : ''}</div>
        </article>
      `;
    }).join('');
  }

  // Switch App Mode (Candidates, Curated, Library, Weekly, Sources)
  function switchMode(newMode, keepRange) {
    if (newMode !== 'weekly') closeDeepReading({ fromHistory: true });
    if (!keepRange && newMode !== state.mode) state.range = defaultRange(newMode);
    state.mode = newMode;
    state.page = 1;
    const search = $('#globalSearch');
    if (search) {
      search.placeholder = newMode === 'sources' ? '搜索信源名称、地址或状态…' : newMode === 'weekly' ? '搜索当前榜题名、作者、DOI…' : '搜索当前栏目题名、DOI…';
      search.setAttribute('aria-label', newMode === 'sources' ? '检索信源名称、地址与状态；完整 DOI 全站匹配' : newMode === 'weekly' ? '检索近7天榜；完整 DOI 全站匹配；支持中文关键词' : '检索当前栏目文献；完整 DOI 全站匹配；支持中文关键词');
    }

    // Toggle active nav tab
    $$('.nav-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === newMode);
    });
    $('#sourceStatusBtn')?.setAttribute('aria-pressed', String(newMode === 'sources'));

    // Toggle main sections
    const streamSection = $('#streamSection');
    const weeklySection = $('#weeklySection');
    const sourcesSection = $('#sourcesSection');
    const sidebar = $('#appSidebar');

    if (streamSection) streamSection.hidden = (newMode === 'weekly' || newMode === 'sources');
    if (weeklySection) weeklySection.hidden = (newMode !== 'weekly');
    if (sourcesSection) sourcesSection.hidden = (newMode !== 'sources');
    const noSidebar = (newMode === 'weekly' || newMode === 'sources' || newMode === 'curated');
    if (sidebar) sidebar.style.display = noSidebar ? 'none' : '';
    const ftb = $('#filterToggleBtn');
    if (ftb) ftb.hidden = noSidebar;
    if (sidebar) sidebar.classList.remove('open');

    const appContainer = $('.app-container');
    if (appContainer) {
      appContainer.classList.toggle('full-width-layout', noSidebar);
      appContainer.classList.toggle('curated-layout', newMode === 'curated');
      appContainer.classList.toggle('weekly-layout', newMode === 'weekly');
      appContainer.classList.toggle('sources-layout', newMode === 'sources');
    }
    window.scrollTo({ top: 0 });

    if (exactDoi(state.search)) {
      if (newMode === 'sources') renderSourcesHealth();
      if (newMode === 'weekly') { renderWeeklyHeader(); renderNextCandidates(); }
      renderStream();
    } else if (newMode === 'sources') {
      renderSourcesHealth();
      syncUrl();
    } else if (newMode === 'weekly') {
      renderWeeklyHeader();
      renderNextCandidates();
      syncUrl();
    } else {
      renderSidebarFilters();
      renderStream();
    }
  }


