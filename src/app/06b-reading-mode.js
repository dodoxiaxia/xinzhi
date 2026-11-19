  // ==== src/app/06b-reading-mode.js · Expanded reading, filtered sequence and shareable URLs ====
  function parseReadingPaper(search) {
    const ids = new URLSearchParams(search).getAll('paper');
    if (!ids.length) return undefined;
    const id = ids[0];
    return ids.length === 1 && id.length <= 160 && /^[a-z0-9]/i.test(id) && !/[^a-z0-9._:-]/i.test(id) ? id : null;
  }

  function hasReadingLink() {
    return parseReadingPaper(location.search) !== undefined;
  }

  function readingUnderlyingDeepId() {
    const params = new URLSearchParams(location.search);
    return params.get('mode') === 'weekly' && params.get('read');
  }

  function readingNeighbors(papers, id) {
    const index = papers.findIndex(paper => paper.id === id);
    return index < 0 ? null : {
      position: index + 1,
      total: papers.length,
      previous: papers[index - 1] || null,
      next: papers[index + 1] || null
    };
  }

  let readingReturn = null;
  let pendingReadingLink = null;
  let readingRefreshFrame = 0;
  const readingPaperParts = ['feeds', 'radar', 'library'];

  function writeReadingPaper(id, entry = history.state) {
    try {
      const url = new URL(location.href);
      if (id) url.searchParams.set('paper', id);
      else url.searchParams.delete('paper');
      history.replaceState(entry, '', url.href);
    } catch (error) { /* sandboxed history */ }
  }

  function pushReadingHistory(id, drawerReturn) {
    pushOverlay('reading');
    const entry = history.state;
    writeReadingPaper(id, entry?.overlay === 'reading' ? { ...entry, readingDrawer: drawerReturn } : entry);
  }

  function setReadingMode(active, drawerReturn = null) {
    const drawer = $('#readerDrawer');
    const star = $('#drawerHuddleToggleBtn');
    const footer = drawer.querySelector('.drawer-footer');
    const toolbar = $('#readingToolbar');
    readingReturn = drawerReturn;
    drawer.classList.toggle('reading-mode', active);
    drawer.setAttribute('aria-label', active ? '阅读模式' : '文献阅读台');
    ['#drawerExpandBtn', '#drawerCloseBtn'].forEach(selector => { $(selector).hidden = active; });
    [toolbar, $('#readingToc'), $('#readingProgress')].forEach(el => { el.hidden = !active; });
    $('#readingBackBtn').setAttribute('aria-label', drawerReturn ? '返回阅读面板' : '返回列表');
    $('#readingTocToggle').setAttribute('aria-expanded', 'false');
    if (active) toolbar.append(star);
    else footer.insertBefore(star, $('#drawerExternalLink'));
  }

  function expandReadingMode() {
    const paper = state.activeDrawerPaper;
    if (!paper || $('#readerDrawer.reading-mode')) return;
    pendingReadingLink = null;
    const drawerReturn = { id: paper.id, top: $('#drawerBody').scrollTop };
    if (history.state?.overlay === 'drawer') writeReadingPaper(null, { ...history.state, readingDrawer: drawerReturn });
    pushReadingHistory(paper.id, drawerReturn);
    setReadingMode(true, drawerReturn);
    $('#drawerBody').scrollTop = 0;
    refreshReadingContent();
    syncReadingNeighbors();
    $('#readingBackBtn').focus({ preventScroll: true });
  }

  function readingListOpener(id) {
    return [...document.querySelectorAll('[data-action="open-drawer"]')]
      .find(el => el.dataset.paperId === id && el.getClientRects().length)
      || $('.nav-tab-btn.active') || $('#sourceStatusBtn');
  }

  function restoreReadingDrawer(drawerReturn) {
    if ($('#readerDrawer.reading-mode')) setReadingMode(false);
    const paper = allPapersMap.get(drawerReturn.id);
    if (paper && (!$('#readerDrawer.open') || state.activeDrawerPaper?.id !== paper.id)) {
      openReaderDrawer(paper, { push: false, opener: readingListOpener(paper.id) });
    }
    if (history.state?.overlay === 'drawer') OVERLAY_PUSHED.add('drawer');
    $('#drawerBody').scrollTop = drawerReturn.top;
    $('#drawerExpandBtn').focus({ preventScroll: true });
  }

  function closeReadingMode() {
    if (popOverlay('reading')) return;
    writeReadingPaper(null);
    if (readingReturn) restoreReadingDrawer(readingReturn);
    else closeReaderDrawer({ fromHistory: true });
  }

  function restoreReadingHistory(entry) {
    pendingReadingLink = null;
    if (entry.overlay === 'reading') {
      openReadingLink(entry);
      return true;
    }
    OVERLAY_PUSHED.delete('reading');
    if (entry.overlay === 'drawer' && entry.readingDrawer) {
      if (!$('#readerDrawer.open') || $('#readerDrawer.reading-mode')) restoreReadingDrawer(entry.readingDrawer);
      return true;
    }
    return false;
  }

  function openReadingLink(entry = history.state || {}) {
    const id = parseReadingPaper(location.search);
    if (id === undefined) return;
    const restore = entry.overlay === 'reading';
    if (id === null) {
      writeReadingPaper(null, restore ? null : history.state);
      showToast('没有找到这篇文献');
      return;
    }
    pendingReadingLink = { id, restore, drawerReturn: restore ? entry.readingDrawer : null };
    if (id.startsWith('doi-')) SUPPLEMENTAL_LIBRARY.promise?.then(scheduleReadingRefresh);
    resolveReadingLink();
  }

  function resolveReadingLink() {
    if (!pendingReadingLink) return;
    const { id, restore, drawerReturn } = pendingReadingLink;
    const paper = allPapersMap.get(id);
    if (paper && state.mode === 'weekly' && urlParams.has('read') && !activeDeepReadingId && partsPending('readings')) {
      prioritizeParts();
      return;
    }
    if (!paper && (partsPending(...readingPaperParts) || RADAR_LOAD.state === 'loading'
      || (id.startsWith('doi-') && SUPPLEMENTAL_LIBRARY.promise))) {
      prioritizeParts();
      return;
    }
    pendingReadingLink = null;
    if (!paper) {
      writeReadingPaper(null, restore ? null : history.state);
      showToast('没有找到这篇文献');
      return;
    }
    if (!restore) {
      // Give a direct link a clean list entry underneath the reading entry.
      writeReadingPaper(null);
      pushReadingHistory(id, null);
    } else {
      OVERLAY_PUSHED.add('reading');
    }
    if ($('#readerDrawer.reading-mode') && state.activeDrawerPaper?.id === id) return;
    const alreadyOpen = $('#readerDrawer.open');
    openReaderDrawer(paper, { push: false, opener: readingListOpener(drawerReturn?.id || id) });
    setReadingMode(true, drawerReturn);
    if (!alreadyOpen) $('#drawerBody').scrollTop = 0;
    refreshReadingContent();
    syncReadingNeighbors();
    $('#readingBackBtn').focus({ preventScroll: true });
  }

  function syncReadingNeighbors() {
    const neighbors = readingNeighbors(getFilteredArticles(), state.activeDrawerPaper.id);
    $('#readingNeighbors').hidden = !neighbors;
    $('#readingPrevBtn').disabled = !neighbors?.previous;
    $('#readingNextBtn').disabled = !neighbors?.next;
    const position = neighbors ? '第 ' + neighbors.position + ' / 共 ' + neighbors.total + ' 篇' : '';
    if ($('#readingPosition').textContent !== position) $('#readingPosition').textContent = position;
    if (document.activeElement?.closest('#readingNeighbors') && (!neighbors || document.activeElement.disabled)) {
      $('#readingBackBtn').focus({ preventScroll: true });
    }
  }

  function turnReadingPage(direction) {
    const neighbors = readingNeighbors(getFilteredArticles(), state.activeDrawerPaper.id);
    const paper = neighbors?.[direction];
    if (!paper) return;
    $('#readingTocToggle').setAttribute('aria-expanded', 'false');
    openReaderDrawer(paper);
    writeReadingPaper(paper.id);
    syncReadingNeighbors();
    $('#readingBackBtn').focus({ preventScroll: true });
  }

  function readingRegion(key) {
    return $('#drawerBody [data-drawer-region="' + key + '"]');
  }

  function setReadingNote(parent, text) {
    let note = parent?.querySelector(':scope > .reading-content-note');
    if (text && !note && parent) {
      note = document.createElement('p');
      note.className = 'reading-content-note';
      parent.prepend(note);
    }
    if (note) {
      if (text && note.textContent !== text) note.textContent = text;
      note.hidden = !text;
    }
  }

  function refreshReadingContent() {
    const paper = state.activeDrawerPaper;
    const view = fulltextState(paper);
    const hasText = !!(paper.summary?.trim() || paper.abstractSections?.some(section => section?.text?.trim()));
    const rssDescription = hasText && !paper._absFetched && !paper.weeklyPick
      && (paper.abstractSource === 'RSS' || (!paper.abstractSource && /^RSS\b/i.test(paper.basis || '')));
    const fulltextUnavailable = ['none', 'review', 'failed'].includes(view.kind);
    const abstractPending = partsPending('quicklooks', 'pregenerated') || paper._absState === 'loading';
    const abstractFailed = paper._absState === 'error'
      || (DEFERRED && ['quicklooks', 'pregenerated'].some(name => PART_STATE[name] === 'error'));
    const unconfirmed = !paper._absFetched && ['unverified', 'non_abstract_metadata'].includes(paper.abstractStatus);
    let note = '';
    if (rssDescription) note = 'RSS 短讯，非完整公开摘要';
    else if (hasText && unconfirmed) note = '公开摘要暂不可确认';
    else if (hasText && fulltextUnavailable) note = '仅摘要';
    else if (!hasText && !abstractPending && !abstractFailed) note = '暂无摘要';
    setReadingNote(readingRegion('abstract')?.querySelector('.abstract-reader'), note);
    setReadingNote($('#drawerFulltext'), fulltextUnavailable ? '全文不可得' : '');

    $('#readingTocNav').querySelectorAll('[data-reading-region]').forEach(button => {
      const region = readingRegion(button.dataset.readingRegion);
      button.hidden = !region;
      if (!region) return;
      region.id = 'reading-section-' + button.dataset.readingRegion;
      button.setAttribute('aria-controls', region.id);
    });
    syncReadingProgress();
    scheduleReadingRefresh();
  }

  function syncReadingProgress() {
    if (!$('#readerDrawer.reading-mode')) return;
    const body = $('#drawerBody');
    const max = body.scrollHeight - body.clientHeight;
    const progress = max > 0 ? Math.round(100 * body.scrollTop / max) : 100;
    $('#readingProgress').value = progress;
    const buttons = [...$('#readingTocNav').querySelectorAll('button:not([hidden])')];
    const top = body.getBoundingClientRect().top + 20;
    const current = progress === 100 && max > 0 ? buttons.at(-1)
      : buttons.findLast(button => readingRegion(button.dataset.readingRegion)?.getBoundingClientRect().top <= top) || buttons[0];
    buttons.forEach(button => {
      if (button === current) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    });
  }

  function jumpReadingSection(key) {
    const body = $('#drawerBody'), region = readingRegion(key);
    if (!region) return;
    body.scrollTo({
      top: body.scrollTop + region.getBoundingClientRect().top - body.getBoundingClientRect().top - 8,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    });
  }

  function scheduleReadingRefresh() {
    if (readingRefreshFrame || (!pendingReadingLink && !$('#readerDrawer.reading-mode'))) return;
    readingRefreshFrame = requestAnimationFrame(() => {
      readingRefreshFrame = 0;
      resolveReadingLink();
      if ($('#readerDrawer.reading-mode')) syncReadingNeighbors();
    });
  }

  function initReadingMode() {
    const drawer = $('#readerDrawer');
    if (!drawer) return;
    $('#drawerExpandBtn').addEventListener('click', expandReadingMode);
    $('#readingBackBtn').addEventListener('click', closeReadingMode);
    $('#readingPrevBtn').addEventListener('click', () => turnReadingPage('previous'));
    $('#readingNextBtn').addEventListener('click', () => turnReadingPage('next'));
    $('#readingTocToggle').addEventListener('click', event => {
      const toggle = event.currentTarget;
      toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true'));
      syncReadingProgress();
    });
    $('#readingTocNav').addEventListener('click', event => {
      const section = event.target.closest('[data-reading-region]');
      if (section) jumpReadingSection(section.dataset.readingRegion);
    });
    $('#drawerBody').addEventListener('scroll', syncReadingProgress, { passive: true });
    $('#drawerBody').addEventListener('toggle', syncReadingProgress, true);
    new ResizeObserver(syncReadingProgress).observe($('#drawerBody'));

    // Observe existing list refreshes and deferred script settlements, including errors.
    const observer = new MutationObserver(scheduleReadingRefresh);
    ['#articlesStream', '#weeklyAuto', '#nextCandidates'].forEach(selector => {
      const list = $(selector);
      if (list) observer.observe(list, { childList: true });
    });
    for (const type of ['load', 'error']) {
      document.addEventListener(type, event => {
        if (event.target.tagName === 'SCRIPT') scheduleReadingRefresh();
      }, true);
    }
    openReadingLink();
  }
