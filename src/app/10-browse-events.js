  // ==== src/app/10-browse-events.js · Browse controls, event wiring and start-up ====
  // 筛选 panel: a right-hand drawer on wide screens and a bottom sheet on phones. Its groups share state with the
  // filter row (领域, 全文); picking an option applies at once and "查看 N 篇" only closes the panel.
  function moreFilterCount() {
    if (!usesLane()) return 0;
    return sidebarSelections().length + (state.reading ? 1 : 0) + (state.favoritesOnly ? 1 : 0) + (state.minor ? 1 : 0)
      + (state.lane !== 'core' ? 1 : 0) + (state.range !== defaultRange(state.mode) ? 1 : 0) + (state.mode === 'library' && state.ftFilter ? 1 : 0);
  }
  const READING_OPTS = [['', '全部内容'], ['abstract', '有公开摘要'], ['guide', '已核对导读'], ['quicklook', 'AI 速览（未核对）']];
  const PANEL_GROUPS = () => [
    ['lane', '#panelOptLane', LANES.map(l => [l.id, l.short || l.name]), state.lane],
    ['ft', '#panelOptFt', FT_FILTERS.map(([v, n]) => [v, v === '' ? '全部全文' : n]), state.ftFilter || ''],
    ['reading', '#panelOptReading', READING_OPTS, state.reading || ''],
    ['range', '#panelOptRange', RANGES_BY_MODE[state.mode] || RANGES_BY_MODE.library, state.range],
    ['journal', '#panelOptJournal', [['all', '全部期刊'], ['mine', '我的期刊']], state.favoritesOnly ? 'mine' : 'all'],
    ['type', '#panelOptType', [['orig', '不含更正/来信（默认）'], ['minor', '含更正/来信']], state.minor ? 'minor' : 'orig']
  ];
  function renderPanelGroups() {
    const body = $('#panelBody');
    if (!body) return;
    const rebuild = body.dataset.mode !== state.mode;
    body.dataset.mode = state.mode;
    PANEL_GROUPS().forEach(([id, sel, options, current]) => {
      const host = $(sel); if (!host) return;
      if (rebuild) host.innerHTML = options.map(([v, n]) => `<button type="button" class="panel-opt" data-panel="${id}" data-value="${esc(v)}" aria-pressed="false">${esc(n)}</button>`).join('');
      host.querySelectorAll('.panel-opt').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === String(current))));
    });
    const ft = $('#pgFt'); if (ft) ft.hidden = state.mode !== 'library';
  }
  function renderMoreFilters() {
    const toggle = $('#filterToggleBtn');
    const n = moreFilterCount(), lane = usesLane();
    if (toggle) {
      toggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg><span class="filter-label">' + (n ? `筛选 · ${n}` : '筛选') + '</span>';
      toggle.classList.toggle('active', n > 0);
      toggle.setAttribute('aria-expanded', String(!!$('#appSidebar.open')));
      toggle.setAttribute('aria-label', n ? `筛选，已生效 ${n} 项` : '筛选');
    }
    if (!lane) return;
    renderPanelGroups();
    const followed = state.favoriteJournals.includes(state.journal);
    const star = $('#favoriteJournalBtn');
    if (star) { star.disabled = !state.journal; star.textContent = followed ? '★ 已关注' : '☆ 关注期刊'; star.setAttribute('aria-pressed', String(followed)); }
  }
  document.addEventListener('click', e => {
    const opt = e.target.closest && e.target.closest('.panel-opt[data-panel]');
    if (!opt) return;
    const v = opt.dataset.value;
    if (opt.dataset.panel === 'lane') state.lane = v;
    else if (opt.dataset.panel === 'ft') state.ftFilter = v;
    else if (opt.dataset.panel === 'reading') state.reading = v;
    else if (opt.dataset.panel === 'range') state.range = v;
    else if (opt.dataset.panel === 'journal') state.favoritesOnly = v === 'mine';
    else if (opt.dataset.panel === 'type') state.minor = v === 'minor';
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  });
  // 重置: every filter in the row and the panel, including time; the search keyword stays.
  function resetPanelFilters() {
    clearSidebarFilters();
    state.lane = 'core'; state.range = defaultRange(state.mode); state.ftFilter = ''; state.reading = ''; state.favoritesOnly = false; state.minor = false;
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  }
  $('#panelResetBtn')?.addEventListener('click', resetPanelFilters);
  $('#modeNote')?.addEventListener('click',e=>{const t=e.target.closest('.mode-note-toggle');if(!t)return;const open=e.currentTarget.classList.toggle('note-open');t.setAttribute('aria-expanded',String(open));});
  $('#favoriteJournalBtn')?.addEventListener('click',()=>{if(!state.journal)return; const f=state.favoriteJournals;state.favoriteJournals=f.includes(state.journal)?f.filter(j=>j!==state.journal):[...f,state.journal];safeSet('xz_favorite_journals',JSON.stringify(state.favoriteJournals));renderSidebarFilters();renderStream();});
  $('#favoritesOnlyBtn')?.addEventListener('click',()=>{state.favoritesOnly=!state.favoritesOnly;state.page=1;renderSidebarFilters();renderStream();});

  // Reset Filters
  function resetAllFilters() {
    state.search = '';
    clearSidebarFilters();
    state.range = defaultRange(state.mode);
    state.lane = 'core'; state.reading=''; state.favoritesOnly=false; state.minor=false; state.ftFilter='';
    state.page = 1;
    const sInput = $('#globalSearch');
    if (sInput) sInput.value = '';
    renderSidebarFilters();
    renderStream();
  }

  // ==================== Event Listeners ====================
  const header = $('header.app-header');
  function measureStickyHeader() {
    const height = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
    // While the phone header is tucked away, sticky bars slide up to the top edge.
    document.documentElement.style.setProperty('--sticky-header-h', `${document.documentElement.classList.contains('header-tucked') ? 0 : height}px`);
    document.documentElement.style.setProperty('--mobile-header-h', `${height}px`);
    const toolbar = $('.stream-toolbar'), toc = $('.weekly-toc');
    document.documentElement.style.setProperty('--sticky-toolbar-h', `${toolbar ? Math.ceil(toolbar.getBoundingClientRect().height) : 0}px`);
    document.documentElement.style.setProperty('--sticky-toc-h', `${toc ? Math.ceil(toc.getBoundingClientRect().height) : 0}px`);
  }
  measureStickyHeader();
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(measureStickyHeader);
    [header, $('.stream-toolbar'), $('.weekly-toc')].filter(Boolean).forEach(element => observer.observe(element));
  }
  window.addEventListener('resize', measureStickyHeader);
  // The header is one row of four sections now, so it stays put instead of tucking away.
  // Backward tabbing must reveal the focused control below sticky surfaces.
  document.addEventListener('focusin', event => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('header,.stream-toolbar,.weekly-toc,#readerDrawer,#huddleModalBackdrop,.modal-backdrop')) return;
    const rect = target.getBoundingClientRect();
    const surfaces = [header, $('.stream-toolbar'), $('.weekly-toc')].filter(element => element && element.getClientRects().length && element.getBoundingClientRect().top <= parseFloat(getComputedStyle(element).top) + 1);
    const bottom = Math.max(0, ...surfaces.map(element => element.getBoundingClientRect().bottom));
    if (rect.top < bottom + 8) window.scrollBy({ top: rect.top - bottom - 12, behavior: 'instant' });
  });

  // Header Nav Tab Clicks
  $$('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === state.mode) return switchMode(btn.dataset.mode);
      // A new entry per tab, so the phone Back button returns to the previous tab.
      try { history.pushState(null, '', location.href); } catch (e) { /* file:// or sandboxed */ }
      switchMode(btn.dataset.mode);
    });
  });

  const openSheet = () => {
    const sb = $('#appSidebar'); if (!sb) return;
    sb.classList.add('open'); $('#filterToggleBtn')?.setAttribute('aria-expanded', 'true');
    (sb.querySelector('.panel-opt[data-panel][aria-pressed="true"]') || sb.querySelector('button'))?.focus({ preventScroll: true });
  };
  $('#filterToggleBtn')?.addEventListener('click', () => { if ($('#appSidebar')?.classList.contains('open')) closeSheet(); else openSheet(); });
  $('#panelApplyBtn')?.addEventListener('click', e => {
    if (e.currentTarget.dataset.empty === '1') { resetPanelFilters(); return; }
    closeSheet();
    ($('#listHead') || $('#streamSection'))?.scrollIntoView({ block: 'start' });
  });

  // Mobile filter sheet: close button, backdrop tap (via body::after), Esc
  function closeSheet() { const sb = $('#appSidebar'); const was = sb && sb.classList.contains('open'); if (sb) sb.classList.remove('open'); const t = $('#filterToggleBtn'); if (t) { t.setAttribute('aria-expanded', 'false'); if (was) t.focus({ preventScroll: true }); } }
  $('#sheetClose')?.addEventListener('click', closeSheet);
  document.addEventListener('click', e => { if (e.target === document.body && $('#appSidebar')?.classList.contains('open')) closeSheet(); });

  // Global Search Input with debounce
  let searchTimer = null;
  const searchInput = $('#globalSearch');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value.trim();
        state.page = 1;
        syncSearchPanel();
        if (!exactDoi(state.search) && state.mode !== 'weekly' && state.mode !== 'sources') renderSidebarFilters();
        renderStream();
      }, 180);
    });
  }

  const searchBtn = $('#searchToggleBtn');
  // Prevent pointer mousedown on the toggle from blurring #globalSearch before click sees the open panel.
  searchBtn?.addEventListener('mousedown', e => e.preventDefault());
  searchBtn?.addEventListener('click', () => {
    const panel = $('#searchPanel');
    if (!panel) return;
    if (!panel.hidden && !state.search && !searchInput?.value) {
      panel.hidden = true;
      searchBtn.setAttribute('aria-expanded', 'false');
      searchBtn.classList.remove('active');
      searchBtn.focus({ preventScroll: true });
      return;
    }
    syncSearchPanel(true);
    searchInput?.focus();
  });
  searchInput?.addEventListener('blur', () => { if (!searchInput.value && !state.search) { const p = $('#searchPanel'); if (p) p.hidden = true; searchBtn?.setAttribute('aria-expanded', 'false'); searchBtn?.classList.remove('active'); } });
  // Hotkey '/' for search
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey
        || $('#huddleModalBackdrop.open') || $('#readerDrawer.open') || $('#deepReader.open')
        || document.activeElement?.matches('input,textarea,select') || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      syncSearchPanel(true);
      searchInput?.focus();
    } else if (e.key === 'Tab') {
      const modal = $('#huddleModalBackdrop.open .modal-dialog') || $('#readerDrawer.open') || $('#deepReader.open') || $('#appSidebar.open');
      if (modal) {
        const nodes = [...modal.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && !x.hidden && !x.closest('[hidden],[inert]') && x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden' && (!x.checkVisibility || x.checkVisibility({ checkVisibilityCSS: true })) && !(x.closest('details:not([open])') && !(x.tagName === 'SUMMARY' && x.parentElement?.matches('details:not([open])'))));
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) return;
        if (!modal.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    } else if (e.key === 'Escape') {
      // One press closes the topmost layer only: shortlist, then reader, then full-text reading, then filters.
      if ($('#huddleModalBackdrop.open')) closeHuddleModal();
      else if ($('#readerDrawer.open')) closeReaderDrawer();
      else if ($('#deepReader.open')) closeDeepReading();
      else if ($('#appSidebar.open')) closeSheet();
    }
  });

  document.addEventListener('click', e => {
    const retryShard = e.target.closest('[data-action="retry-reading-shard"]');
    if (retryShard) { openDeepReading(retryShard.dataset.readingId, { push: false }); return; }
    const deepOpen = e.target.closest('[data-action="open-deep-reading"]');
    if (deepOpen) { openDeepReading(deepOpen.dataset.readingId); return; }
    if (e.target.closest('[data-action="more-daily-readings"]')) {
      deepReadingHistoryLimit += 12;
      renderDailyDeepRead();
      return;
    }
    const tocTarget = e.target.closest('[data-toc-target]');
    if (tocTarget) {
      const body = $('#deepReaderBody'), target = body && document.getElementById(tocTarget.dataset.tocTarget);
      if (target) body.scrollTo({ top: target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12, behavior: 'smooth' });
      return;
    }
    const sourceFilter = e.target.closest('[data-source-filter]');
    if (sourceFilter) {
      state.sourceFilter = sourceFilter.dataset.sourceFilter;
      renderSourcesHealth(); syncUrl();
      return;
    }
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) {
      state.day = dayBtn.dataset.day;
      state.page = 1;
      renderStream();
      const stream = $('#streamSection'), top = stream ? stream.getBoundingClientRect().top + window.scrollY - 70 : 0;
      if (stream && window.scrollY > top) window.scrollTo({ top, behavior: 'instant' });
      $(`[data-day="${state.day}"]`)?.focus({ preventScroll: true });
      return;
    }
    const weeklyCat = e.target.closest('[data-weekly-cat]');
    if (weeklyCat) {
      state.weeklyCat = weeklyCat.dataset.weeklyCat;
      renderWeeklyAuto();
      syncUrl();
      // Keep the bar in place: a shorter list must not leave the reader below its end.
      const board = $('#weeklyAuto'), top = board ? board.getBoundingClientRect().top + window.scrollY : 0;
      if (board && window.scrollY > top) window.scrollTo({ top, behavior: 'instant' });
      $(`[data-weekly-cat="${state.weeklyCat}"]`)?.focus({ preventScroll: true });
      return;
    }
    const weeklyView = e.target.closest('[data-weekly-view]');
    if (weeklyView) {
      state.viewMode = weeklyView.dataset.weeklyView;
      viewInUrl = true;
      safeSet('xinzhi_view_mode', state.viewMode);
      $('#viewCardsBtn')?.classList.toggle('active', state.viewMode === 'cards');
      $('#viewCompactBtn')?.classList.toggle('active', state.viewMode === 'compact');
      renderWeeklyAuto();
      syncUrl();
      $(`[data-weekly-view="${state.viewMode}"]`)?.focus({ preventScroll: true });
      return;
    }
    const weeklyPane = e.target.closest('[data-weekly-pane]');
    if (weeklyPane) {
      state.weeklyPane = weeklyPane.dataset.weeklyPane;
      renderWeeklyPane();
      syncUrl();
      const section = $('#weeklySection');
      if (section && section.getBoundingClientRect().top < 0) window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - 70, behavior: 'instant' });
      return;
    }
    const mb = e.target.closest('[data-minor]');
    if (mb) { state.minor = !state.minor; state.page = 1; renderSidebarFilters(); renderStream(); return; }
    const ftBtn = e.target.closest('[data-ft-filter]');
    if (ftBtn) {
      state.ftFilter = ftBtn.dataset.ftFilter || '';
      state.page = 1;
      renderSidebarFilters();
      renderStream();
      return;
    }
    const b = e.target.closest('[data-range]');
    if (!b) return;
    state.range = b.dataset.range;
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  });

  // Lane, time range and full-text status are native selects in the filter row.
  document.addEventListener('change', e => {
    const q = sel => e.target.closest && e.target.closest(sel);
    const lane = q('select[data-lane-select]'), range = q('select[data-range-select]'), ft = q('select[data-ft-select]');
    if (!lane && !range && !ft) return;
    if (lane) state.lane = lane.value; else if (range) state.range = range.value; else state.ftFilter = ft.value;
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  });

  // Sort Selector
  const sortSelect = $('#sortSelector');
  if (sortSelect) {
    sortSelect.value = state.sort;
    sortSelect.addEventListener('change', e => {
      state.sort = e.target.value; state.page=1;
      renderStream();
    });
  }

  // View Mode Toggles
  const btnCards = $('#viewCardsBtn');
  const btnCompact = $('#viewCompactBtn');
  if (btnCards && btnCompact) {
    btnCards.addEventListener('click', () => {
      state.viewMode = 'cards';
      viewInUrl = true;
      safeSet('xinzhi_view_mode', 'cards');
      btnCards.classList.add('active');
      btnCompact.classList.remove('active');
      renderStream();
    });
    btnCompact.addEventListener('click', () => {
      state.viewMode = 'compact';
      viewInUrl = true;
      safeSet('xinzhi_view_mode', 'compact');
      btnCompact.classList.add('active');
      btnCards.classList.remove('active');
      renderStream();
    });
    if (state.viewMode === 'compact') {
      btnCompact.classList.add('active');
      btnCards.classList.remove('active');
    }
  }

  // Dark/Light Theme Toggle
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const nextTheme = state.theme === 'light' ? 'dark' : 'light';
      applyTheme(nextTheme);
    });
  }

  // Sidebar Filter Reset buttons

  // Global Document Clicks Delegation
  // 卡片内口令下载：服务端 /api/ai?task=status 返回 pdfSignedLink:true 才启用；默认 false，此时「下载 PDF」照旧新开标签。
  let PDF_SIGNED_LINK = false;
  const DL_MSG = {
    invalid: '口令不正确，请重新输入。',
    limited: '口令错误次数过多，请一小时后再试。',
    network: '网络异常，请稍后重试。',
    other: '暂时无法下载，请稍后重试，或到官网原文获取。',
    empty: '请输入全文口令。'
  };
  function dlSetBusy(form, busy, label) {
    const input = form.querySelector('input[name="passphrase"]'), btn = form.querySelector('button[type="submit"]');
    if (input) input.disabled = busy;
    if (btn) { btn.disabled = busy; btn.textContent = label; }
    form.classList.toggle('is-busy', busy);
    if (busy) form.setAttribute('aria-busy', 'true'); else form.removeAttribute('aria-busy');
  }
  // 提交口令换取签名链接：口令只放在 POST 正文里，不写 console / localStorage / URL。
  async function submitDownloadForm(form) {
    if (form.dataset.busy === '1') return;
    const link = dlLinkFor(form), input = form.querySelector('input[name="passphrase"]'), err = form.querySelector('.ft-error');
    const showError = msg => { if (err) err.textContent = msg; };
    const passphrase = input ? input.value : '';
    showError('');
    if (!passphrase.trim()) { showError(DL_MSG.empty); if (input) input.focus(); return; }
    const href = link ? (link.getAttribute('href') || '') : '';
    if (!/^\/api\/(pdf|fulltext)\?/.test(href)) { showError(DL_MSG.other); return; }
    form.dataset.busy = '1';
    dlSetBusy(form, true, '正在验证口令…');
    const restore = () => { delete form.dataset.busy; dlSetBusy(form, false, DL_BTN_LABEL); };
    const fail = msg => { restore(); showError(msg); if (input) input.focus(); };
    let status = 0, data = null;
    try {
      const resp = await fetch(href + '&link=1', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: 'passphrase=' + encodeURIComponent(passphrase),
        credentials: 'same-origin',
        cache: 'no-store'
      });
      status = resp.status;
      data = await resp.json().catch(() => null);
    } catch (e) { data = null; }
    if (!data || typeof data !== 'object') { fail(DL_MSG.network); return; }
    if (data.ok === true) {
      const url = typeof data.url === 'string' ? data.url : '';
      if (!/^\/api\/(pdf|fulltext)\?/.test(url)) { fail(DL_MSG.other); return; }
      if (input) input.value = '';
      dlSetBusy(form, true, '正在取回 PDF…');
      location.assign(url);
      setTimeout(() => { resetDlForm(form); showToast('已开始下载'); }, 2000);
      return;
    }
    const code = typeof data.error === 'string' ? data.error : '';
    if (code === 'pdf_link_disabled') {
      // 服务端关闭了签名链接：退回旧行为，新开标签到服务端口令页。
      PDF_SIGNED_LINK = false;
      resetDlForm(form);
      window.open(href, '_blank', 'noopener');
      return;
    }
    if (code === 'pdf_rate_limited' || status === 429) { fail(DL_MSG.limited); return; }
    if (code === 'pdf_passphrase_invalid' || code === 'library_passphrase_invalid' || status === 403) { fail(DL_MSG.invalid); return; }
    fail(DL_MSG.other);
  }
  document.addEventListener('submit', e => {
    const dlForm = e.target.closest && e.target.closest('form[data-ft-dl-form]');
    if (dlForm) { e.preventDefault(); submitDownloadForm(dlForm); return; }
    const form = e.target.closest && e.target.closest('form[data-ft-form]');
    if (form) { e.preventDefault(); submitFulltextForm(form); }
  });
  document.addEventListener('click', e => {
    const dl = e.target.closest('a[data-ft-download]');
    if (dl && PDF_SIGNED_LINK && !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button)) {
      const dlForm = dlFormFor(dl);
      if (dlForm) {
        e.preventDefault();
        if (dlForm.dataset.busy === '1') return;
        if (dlForm.hidden) { dlForm.hidden = false; dlForm.querySelector('input')?.focus(); }
        else resetDlForm(dlForm);
        return;
      }
    }
    const ft = e.target.closest('[data-ft-action]');
    if (ft) {
      const doi = exactDoi(ft.dataset.doi), box = ft.closest('[data-ft-doi]') || ft.parentElement;
      if (ft.dataset.ftAction === 'open-form') {
        const form = (box.querySelector('[data-ft-form]') || (box.parentElement && box.parentElement.querySelector('[data-ft-form]')));
        if (form) { form.hidden = false; form.querySelector('input')?.focus(); }
      } else if (ft.dataset.ftAction === 'refresh') { ft.disabled = true; lookupSupplementalDoi(doi, true).then(refreshSupplementalView); }
      return;
    }
    const refreshDoi = e.target.closest('[data-action="refresh-doi-status"]');
    if (refreshDoi) { lookupSupplementalDoi(exactDoi(refreshDoi.dataset.doi), true); renderStream(); return; }
    if (e.target.closest('[data-action="retry-radar-archive"]')) { RADAR_LOAD.state = 'idle'; renderStream(); return; }
    if (e.target.closest('[data-action="refresh-doi-library"]')) { loadSupplementalLibrary(true); return; }
    if (e.target.closest('[data-action="load-doi-library"]')) { loadSupplementalLibrary(); return; }
    const browseBtn = e.target.closest('[data-browse-only]');
    if (browseBtn) {
      changeSidebarFilter(browseBtn.dataset.browseOnly, browseBtn.dataset.browseValue, true, browseBtn);
      return;
    }
    // 1. Clinical Tier click
    const tierBtn = e.target.closest('[data-filter-tier]');
    if (tierBtn) {
      changeSidebarFilter('tier', tierBtn.dataset.filterTier, false, tierBtn);
      return;
    }

    // 1.5 Lane chip
    const laneBtn = e.target.closest('[data-lane]');
    if (laneBtn) {
      state.lane = laneBtn.dataset.lane;
      state.page = 1;
      renderSidebarFilters();
      renderStream();
      return;
    }

    // Expand without selecting; select the publisher through its name.
    const pubExpand = e.target.closest('[data-pub-expand]');
    if (pubExpand) {
      const open = pubExpand.closest('.accordion-group').classList.toggle('open');
      if (open) expandedPublishers.add(pubExpand.dataset.pubExpand);
      else expandedPublishers.delete(pubExpand.dataset.pubExpand);
      pubExpand.setAttribute('aria-expanded', String(open));
      return;
    }
    const pubBtn = e.target.closest('[data-filter-publisher]');
    if (pubBtn) {
      changeSidebarFilter('pub', pubBtn.dataset.filterPublisher, false, pubBtn);
      return;
    }

    // 3. Journal filter click
    const jBtn = e.target.closest('[data-filter-journal]');
    if (jBtn) {
      changeSidebarFilter('journal', jBtn.dataset.filterJournal, false, jBtn);
      return;
    }

    // 4. Study Design filter click
    const designBtn = e.target.closest('[data-filter-design]');
    if (designBtn) {
      changeSidebarFilter('design', designBtn.dataset.filterDesign, false, designBtn);
      return;
    }

    // 5. Tag chip click
    const tagBtn = e.target.closest('[data-filter-tag]');
    if (tagBtn) {
      changeSidebarFilter('tag', tagBtn.dataset.filterTag, false, tagBtn);
      return;
    }

    // 6. Clear active filter badge
    const clearBtn = e.target.closest('[data-clear]');
    if (clearBtn) {
      const type = clearBtn.dataset.clear;
      if (type === 'search') { state.search = ''; if (searchInput) searchInput.value = ''; }
      if (type === 'sidebar') clearSidebarFilters();
      if (type === 'tier') state.clinicalTier = '';
      if (['pub', 'publisher', 'journal'].includes(type)) { state.publisher = ''; state.journal = ''; }
      if (type === 'range') state.range = defaultRange(state.mode);
      if (type === 'lane') state.lane = 'core';
      if (type === 'minor') state.minor = false;
      if (type === 'design') state.studyDesign = '';
      if (type === 'tag') state.tag = '';
      if (type === 'reading') state.reading = '';
      if (type === 'favorites') state.favoritesOnly = false;
      if (type === 'ft') state.ftFilter = '';
      state.page = 1;
      refreshFilterResults(clearBtn);
      return;
    }

    // 7. Clear all filters button in empty state
    if (e.target.id === 'clearAllFiltersBtn') {
      resetAllFilters();
      return;
    }

    // 8. Open Drawer
    const drawerAction = e.target.closest('[data-action="open-drawer"]');
    if (drawerAction) {
      const paperId = drawerAction.dataset.paperId;
      const paper = allPapersMap.get(paperId);
      if (paper) openReaderDrawer(paper);
      return;
    }

    const aiCheckAction = e.target.closest('[data-action="ai-check"]');
    if (aiCheckAction) { const paper = allPapersMap.get(aiCheckAction.dataset.paperId); if (paper) { aiApiCheck(paper, true); openReaderDrawer(paper); } return; }
    const titleCheckAction = e.target.closest('[data-action="title-check"]');
    if (titleCheckAction) { const paper = allPapersMap.get(titleCheckAction.dataset.paperId); if (paper) { aiTitleCheck(paper); openReaderDrawer(paper); } return; }
    const aiAction = e.target.closest('[data-action="ai-interpret"]');
    if (aiAction) {
      const paper = allPapersMap.get(aiAction.dataset.paperId);
      if (paper) aiInterpret(paper);
      return;
    }

    const ttAction = e.target.closest('[data-action="ai-title"]');
    if (ttAction) { const paper = allPapersMap.get(ttAction.dataset.paperId); if (paper) aiTitle(paper); return; }
    const trAction = e.target.closest('[data-action="ai-translate"]');
    if (trAction) { const paper = allPapersMap.get(trAction.dataset.paperId); if (paper) aiTranslate(paper); return; }
    const trCheckAction = e.target.closest('[data-action="tr-check"]');
    if (trCheckAction) { const paper = allPapersMap.get(trCheckAction.dataset.paperId); if (paper) { trCheck(paper, true); openReaderDrawer(paper); } return; }
    const abstractJump = e.target.closest('[data-action="abstract-jump"]');
    if (abstractJump) {
      const selector = abstractJump.dataset.column === 'translation' ? '.abstract-translation' : '.abstract-original';
      const heading = $('#drawerBody')?.querySelector(selector + ' .abstract-column-title');
      if (heading) { heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start' }); }
      return;
    }
    const studyAction = e.target.closest('[data-action="ai-study"]');
    if (studyAction) { const paper = allPapersMap.get(studyAction.dataset.paperId); if (paper) aiStudy(paper); return; }
    const studyCheckAction = e.target.closest('[data-action="study-check"]');
    if (studyCheckAction) { const paper = allPapersMap.get(studyCheckAction.dataset.paperId); if (paper) { studyCheck(paper, true); openReaderDrawer(paper); } return; }
    if (e.target.closest('[data-action="ai-compare"]')) { aiCompare(); return; }
    if (e.target.closest('[data-action="compare-check"]')) { compareCheck(true); openHuddleModal(); return; }
    const studyCopyAction = e.target.closest('[data-action="study-copy"]');
    if (studyCopyAction) {
      const task = studyCopyAction.dataset.task;
      const paper = task === 'study' && allPapersMap.get(studyCopyAction.dataset.paperId);
      const requested = paper ? [paper] : selectedComparePapers();
      const rec = task === 'study' ? STUDY_RESULTS[paper && studyKey(paper)] : COMPARE_RESULTS[compareKey(requested)];
      if (rec?.state === 'done') copyToClipboard(studyCopyText(rec.result, requested), '已复制研究结构、摘要原句与全文核对清单');
      return;
    }
    const briefAction = e.target.closest('[data-action="ai-brief"], [data-action="brief-check"]');
    if (briefAction) {
      const mode = briefAction.dataset.mode;
      const action = briefAction.dataset.action === 'brief-check' ? briefLookup : aiBrief;
      if (mode === 'huddle') action('huddle', huddlePapers(), () => { if ($('#huddleModalBackdrop')?.classList.contains('open')) openHuddleModal(); });
      else action('digest', state._digestList || [], () => renderDigestBar());
      return;
    }

    // 9. Share to WeChat
    const shareAction = e.target.closest('[data-action="share-wechat"]');
    if (shareAction) {
      const paperId = shareAction.dataset.paperId;
      const paper = allPapersMap.get(paperId);
      if (paper) {
        const text = generateWeChatShareText(paper);
        copyToClipboard(text, '已复制微信群精炼分享文案');
      }
      return;
    }

    // 9.1 Copy Citation
    const copyCiteBtn = e.target.closest('.copy-cite-btn');
    if (copyCiteBtn) {
      const citeText = copyCiteBtn.dataset.cite;
      if (citeText) {
        copyToClipboard(citeText, '已复制学术引用');
      } else {
        showToast('暂无该格式引用');
      }
      return;
    }

    // 10. Toggle Morning Huddle
    const huddleAction = e.target.closest('[data-action="toggle-huddle"]');
    if (huddleAction) {
      toggleHuddle(huddleAction.dataset.paperId);
      return;
    }

    // 11. Remove from huddle inside modal
    const removeHuddleAction = e.target.closest('[data-action="remove-huddle"]');
    if (removeHuddleAction) {
      const paperId = removeHuddleAction.dataset.paperId;
      state.huddle = state.huddle.filter(id => id !== paperId);
      updateHuddleCounter();
      openHuddleModal();
      renderStream();
      return;
    }
  });

  // Drawer events
  $('#drawerCloseBtn')?.addEventListener('click', () => closeReaderDrawer());
  $('#drawerBackdrop')?.addEventListener('click', () => { if ($('#readerDrawer.open')) closeReaderDrawer(); else closeDeepReading(); });
  $('#deepReaderClose')?.addEventListener('click', () => closeDeepReading());
  ['#deepReaderPrev', '#deepReaderNext'].forEach(sel => $(sel)?.addEventListener('click', e => { const id = e.currentTarget.dataset.readingId; if (id) openDeepReading(id); }));
  $('#deepReaderBody')?.addEventListener('scroll', () => requestAnimationFrame(syncDeepReaderToc), { passive: true });
  window.addEventListener('popstate', () => {
    const entry = history.state || {};
    if (entry.overlay !== 'huddle') closeHuddleModal({ fromHistory: true });
    if (entry.overlay !== 'drawer') closeReaderDrawer({ fromHistory: true });
    const id = entry.deepReader;
    if (id && state.mode === 'weekly') openDeepReading(id, { push: false });
    else closeDeepReading({ fromHistory: true });
    // Back after switching tabs returns to the previous tab.
    const mode = new URLSearchParams(location.search).get('mode') || 'curated';
    if (!entry.overlay && !entry.deepReader && mode !== state.mode && ['curated', 'weekly', 'candidates', 'library', 'sources'].includes(mode)) switchMode(mode);
  });

  $('#drawerCopyShareBtn')?.addEventListener('click', () => {
    if (state.activeDrawerPaper) {
      const text = generateWeChatShareText(state.activeDrawerPaper);
      copyToClipboard(text, '已复制微信群精炼分享文案');
    }
  });

  $('#drawerHuddleToggleBtn')?.addEventListener('click', () => {
    if (state.activeDrawerPaper) toggleHuddle(state.activeDrawerPaper.id);
  });

  // Load More Button
  $('#loadMoreBtn')?.addEventListener('click', () => {
    state.page += 1;
    renderStream();
  });

  // Morning Huddle Modal Events
  $('#huddleModalBody')?.addEventListener('change', e => {
    const checkbox = e.target.closest('[data-action="compare-select"]');
    if (!checkbox) return;
    const id = checkbox.dataset.paperId;
    if (!setCompareSelection(id, checkbox.checked)) { checkbox.checked = false; return; }
    openHuddleModal();
    [...$('#huddleModalBody').querySelectorAll('[data-action="compare-select"]')].find(x => x.dataset.paperId === id)?.focus({ preventScroll: true });
  });
  $('#openHuddleBtn')?.addEventListener('click', openHuddleModal);
  $('#closeHuddleModalBtn')?.addEventListener('click', () => closeHuddleModal());
  $('#huddleModalBackdrop')?.addEventListener('click', e => {
    if (e.target.id === 'huddleModalBackdrop') closeHuddleModal();
  });
  $('#exportHuddleMdBtn')?.addEventListener('click', exportHuddleMarkdown);
  $('#copyHuddleSummaryBtn')?.addEventListener('click', copyHuddleSummary);
  // Clearing the whole shortlist asks once more: the first tap arms the button, the second one clears.
  let clearArmTimer = null;
  $('#clearHuddleBtn')?.addEventListener('click', e => {
    const btn = e.currentTarget;
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = `再点一次，确认清空 ${state.huddle.length} 篇`;
      clearTimeout(clearArmTimer);
      clearArmTimer = setTimeout(() => { delete btn.dataset.armed; btn.textContent = '清空清单'; }, 4000);
      return;
    }
    clearTimeout(clearArmTimer);
    delete btn.dataset.armed; btn.textContent = '清空清单';
    state.huddle = [];
    state.huddleCompare = [];
    updateHuddleCounter();
    openHuddleModal();
    renderStream();
    showToast('已清空精选清单');
  });
  // Cards follow their full-text task by themselves: a gentle poll, only while the page is visible.
  let autoSince = 0;
  setInterval(() => {
    if (document.hidden) return;
    const active = [...DOI_JOBS.entries()].filter(([, job]) => doiJobActive(job)).slice(0, 5);
    if (!active.length) { autoSince = 0; return; }
    if (!autoSince) autoSince = Date.now();
    if (Date.now() - autoSince > 3600000) return;
    active.forEach(([doi]) => { if (DOI_TOUCHED.size < 10) DOI_TOUCHED.add(doi); lookupSupplementalDoi(doi, true); });
  }, 60000);

  // Initialize
  // A reload keeps history.state; a panel marker left from before the reload no longer has a panel.
  try { if (history.state && history.state.overlay) history.replaceState(null, '', location.href); } catch (e) { /* sandboxed */ }
  updateHeaderBadges();
  updateHuddleCounter();
  if (!['curated', 'weekly', 'candidates', 'library', 'sources'].includes(state.mode)) state.mode = 'curated';
  if (searchInput && state.search) searchInput.value = state.search;
  switchMode(state.mode, true);
  loadSupplementalLibrary();
  const refreshLibraryAfterReturn = () => {
    if (Date.now() - SUPPLEMENTAL_LIBRARY.refreshedAt < 2000) return;
    loadSupplementalLibrary(true);
    const doi = exactDoi(state.search); if (doi) lookupSupplementalDoi(doi, true);
    DOI_TOUCHED.forEach(touched => { if (touched !== doi) lookupSupplementalDoi(touched, true); });
  };
  document.addEventListener('click', e => {
    const link = e.target.closest && e.target.closest('a[href^="/api/acquire"], a[href^="/api/muse/"], a[href^="/api/fulltext"]');
    const doi = link && exactDoi(new URL(link.getAttribute('href'), location.origin).searchParams.get('doi') || '');
    if (doi && DOI_TOUCHED.size < 10) DOI_TOUCHED.add(doi);
  });
  window.addEventListener('focus', refreshLibraryAfterReturn);
  window.addEventListener('pageshow', event => { if (event.persisted) refreshLibraryAfterReturn(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && doiJobActive(DOI_JOBS.get(exactDoi(state.search)))) lookupSupplementalDoi(exactDoi(state.search), true); });
  aiRequest('/api/ai?task=status', { headers: { accept: 'application/json' } })
    .then(j => { AI_AVAIL = !!(j && j.canGenerate); PDF_SIGNED_LINK = !!(j && j.pdfSignedLink === true); renderDigestBar(); if (state.activeDrawerPaper) openReaderDrawer(state.activeDrawerPaper); })
    .catch(() => { AI_AVAIL = false; PDF_SIGNED_LINK = false; if (state.activeDrawerPaper) openReaderDrawer(state.activeDrawerPaper); });

  if (state.mode === 'weekly' && urlParams.get('read')) openDeepReading(urlParams.get('read'), { push: false });

  if (urlParams.get('drawer') === 'first') {
    const list = getFilteredArticles();
    if (list.length > 0) openReaderDrawer(list[0]);
  }

})();

  // 窄屏（<380px）列表头放不下视图切换：只留排序，详细/列表挪到页脚。
  (() => {
    const mq = window.matchMedia && window.matchMedia('(max-width: 379px)');
    const toggle = document.querySelector('.list-head .view-toggle');
    const footer = document.getElementById('appFooter'), tools = document.getElementById('listHeadTools');
    if (!mq || !toggle || !footer || !tools) return;
    const place = () => { if (mq.matches) footer.prepend(toggle); else tools.append(toggle); };
    place();
    (mq.addEventListener ? mq.addEventListener('change', place) : mq.addListener(place));
  })();
