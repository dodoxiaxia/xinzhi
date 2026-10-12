  // ==== src/app/10-browse-events.js · Browse controls, event wiring and start-up ====
  function renderBrowseBar() {
    const bar=$('#browseBar'); if(!bar)return;
    bar.hidden=!usesLane();
    const tog=$('#browseToggle');
    if(tog){
      const n=(state.journal?1:0)+(state.reading?1:0)+(state.favoritesOnly?1:0);
      const open=state.browseOpen||n>0;
      tog.hidden=bar.hidden; bar.classList.toggle('browse-open',open);
      tog.setAttribute('aria-expanded',String(open));
      tog.textContent='期刊与可读内容'+(n?` · ${n} 项`:'')+(open?' ▴':' ▾');
      tog.disabled=n>0;
    }
    if(bar.hidden)return;
    const journals=[...new Set(getCurrentDataset().map(p=>p.cleanJournal||p.journal).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    if (state.journal && !journals.includes(state.journal)) journals.push(state.journal);
    const sel=$('#journalSelect');
    sel.innerHTML='<option value="">所有期刊 / 信源</option>'+journals.map(j=>`<option value="${esc(j)}" ${state.journal===j?'selected':''}>${state.favoriteJournals.includes(j)?'★ ':''}${esc(j)} · ${esc(journalMetricText(j))}</option>`).join('');
    $('#readingSelect').value=state.reading;
    const star=$('#favoriteJournalBtn');star.disabled=!state.journal;star.textContent=state.favoriteJournals.includes(state.journal)?'★ 已关注':'☆ 关注期刊';star.setAttribute('aria-pressed',String(state.favoriteJournals.includes(state.journal)));
    const fav=$('#favoritesOnlyBtn');fav.textContent='我的期刊 '+state.favoriteJournals.length;fav.classList.toggle('active',state.favoritesOnly);fav.setAttribute('aria-pressed',String(state.favoritesOnly));
    const period=$('#rangeExplanation');period.textContent=state.range==='all'?'日期与研究类型均以来源信息为准；未知项明确保留。':`北京时间 ${rangeStart()} 至 ${beijingToday()}；不含日期未知及仅有刊期的条目。`;
  }
  $('#browseToggle')?.addEventListener('click',()=>{state.browseOpen=!state.browseOpen;renderBrowseBar();});
  $('#modeNote')?.addEventListener('click',e=>{if(e.target.closest('a,button'))return;e.currentTarget.classList.toggle('note-open');});
  $('#journalSelect')?.addEventListener('change',e=>changeSidebarFilter('journal', e.target.value, false, e.target));
  $('#readingSelect')?.addEventListener('change',e=>{state.reading=e.target.value;state.page=1;renderSidebarFilters();renderStream();});
  $('#favoriteJournalBtn')?.addEventListener('click',()=>{if(!state.journal)return; const f=state.favoriteJournals;state.favoriteJournals=f.includes(state.journal)?f.filter(j=>j!==state.journal):[...f,state.journal];safeSet('xz_favorite_journals',JSON.stringify(state.favoriteJournals));renderSidebarFilters();renderStream();});
  $('#favoritesOnlyBtn')?.addEventListener('click',()=>{state.favoritesOnly=!state.favoritesOnly;state.page=1;renderSidebarFilters();renderStream();});

  // Reset Filters
  function resetAllFilters() {
    state.search = '';
    clearSidebarFilters();
    state.range = defaultRange(state.mode);
    state.lane = 'core'; state.reading=''; state.favoritesOnly=false; state.minor=false;
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
  // Phones: the three-row header (about a fifth of the screen) hides while reading down and
  // returns on any upward scroll, near the top, or while something inside it has focus.
  {
    const root = document.documentElement, narrow = window.matchMedia('(max-width: 720px)');
    let lastY = window.scrollY;
    const setTucked = tucked => {
      if (root.classList.contains('header-tucked') === tucked) return;
      root.classList.toggle('header-tucked', tucked);
      measureStickyHeader();
    };
    window.addEventListener('scroll', () => {
      const y = window.scrollY, delta = y - lastY;
      if (!narrow.matches || y < 160 || (header && header.contains(document.activeElement)) || $('#appSidebar.open')) setTucked(false);
      else if (delta > 6) setTucked(true);
      else if (delta < -6) setTucked(false);
      if (Math.abs(delta) > 6 || y < 160) lastY = y;
    }, { passive: true });
    header?.addEventListener('focusin', () => setTucked(false));
    narrow.addEventListener?.('change', () => setTucked(false));
  }
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

  // Mobile: collapsible filter panel
  $('#filterToggleBtn')?.addEventListener('click', () => {
    const sb = $('#appSidebar');
    if (!sb) return;
    const open = sb.classList.toggle('open');
    $('#filterToggleBtn').setAttribute('aria-expanded', String(open));
  });

  // Mobile filter sheet: close button, backdrop tap (via body::after), Esc
  const closeSheet = () => { const sb = $('#appSidebar'); if (sb) sb.classList.remove('open'); const t = $('#filterToggleBtn'); if (t) t.setAttribute('aria-expanded', 'false'); };
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
        if (!exactDoi(state.search) && state.mode !== 'weekly' && state.mode !== 'sources') renderSidebarFilters();
        renderStream();
      }, 180);
    });
  }

  // Hotkey '/' for search
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey
        || $('#huddleModalBackdrop.open') || $('#readerDrawer.open') || $('#deepReader.open')
        || document.activeElement?.matches('input,textarea,select') || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      searchInput?.focus();
    } else if (e.key === 'Tab') {
      const modal=$('#huddleModalBackdrop.open .modal-dialog') || $('#readerDrawer.open') || $('#deepReader.open');
      if (modal) {const nodes=[...modal.querySelectorAll('button,a[href],input,select,summary,[tabindex="0"]')].filter(x=>!x.disabled && !x.hidden && x.getClientRects().length);const first=nodes[0],last=nodes[nodes.length-1]; if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus();} else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus();}}
    } else if (e.key === 'Escape') {
      // One press closes the topmost layer only: shortlist, then reader, then full-text reading, then filters.
      if ($('#styleMenu:not([hidden])')) return;
      if ($('#huddleModalBackdrop.open')) closeHuddleModal();
      else if ($('#readerDrawer.open')) closeReaderDrawer();
      else if ($('#deepReader.open')) closeDeepReading();
      else if ($('#appSidebar.open')) closeSheet();
    }
  });

  document.addEventListener('click', e => {
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
    const b = e.target.closest('[data-range]');
    if (!b) return;
    state.range = b.dataset.range;
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
  $('#resetTierBtn')?.addEventListener('click', e => changeSidebarFilter('tier', '', false, e.target));
  $('#resetPubBtn')?.addEventListener('click', e => changeSidebarFilter('pub', '', false, e.target));
  $('#resetDesignBtn')?.addEventListener('click', e => changeSidebarFilter('design', '', false, e.target));
  $('#resetTagBtn')?.addEventListener('click', e => changeSidebarFilter('tag', '', false, e.target));

  // Global Document Clicks Delegation
  document.addEventListener('click', e => {
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
      if (type === 'design') state.studyDesign = '';
      if (type === 'tag') state.tag = '';
      if (type === 'reading') state.reading = '';
      if (type === 'favorites') state.favoritesOnly = false;
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
  $('#clearHuddleBtn')?.addEventListener('click', () => {
    state.huddle = [];
    state.huddleCompare = [];
    updateHuddleCounter();
    openHuddleModal();
    renderStream();
    showToast('已清空精选清单');
  });

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
    .then(j => { AI_AVAIL = !!(j && j.canGenerate); renderDigestBar(); if (state.activeDrawerPaper) openReaderDrawer(state.activeDrawerPaper); })
    .catch(() => { AI_AVAIL = false; if (state.activeDrawerPaper) openReaderDrawer(state.activeDrawerPaper); });

  if (state.mode === 'weekly' && urlParams.get('read')) openDeepReading(urlParams.get('read'), { push: false });

  if (urlParams.get('drawer') === 'first') {
    const list = getFilteredArticles();
    if (list.length > 0) openReaderDrawer(list[0]);
  }

})();
