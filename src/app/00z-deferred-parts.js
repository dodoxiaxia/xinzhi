  // ==== src/app/00z-deferred-parts.js · Deferred data parts loader and in-place merger ====
  const DEFERRED = !!(window.XINZHI_PARTS && window.XINZHI_PARTS.parts);
  const PART_ORDER = DEFERRED ? Object.keys(window.XINZHI_PARTS.parts) : [];
  const PART_STATE = {};
  PART_ORDER.forEach(name => { PART_STATE[name] = 'idle'; });

  const TIER1_FEEDS = DEFERRED ? FEEDS.items.slice() : null;
  let pendingRadar = null;
  const partQueue = [];
  let inFlight = 0;
  const MAX_IN_FLIGHT = 2;

  function syncDataState() {
    if (!DEFERRED) return;
    window.XINZHI_DATA_STATE = { ...PART_STATE };
    if (PART_ORDER.every(n => PART_STATE[n] === 'loaded')) {
      window.XINZHI_DATA_READY = true;
    }
  }
  if (DEFERRED) {
    window.XINZHI_DATA_READY = false;
    syncDataState();
  }

  function partsReady(...names) {
    return !DEFERRED || names.every(n => !(n in PART_STATE) || PART_STATE[n] === 'loaded');
  }

  function partsSettled(...names) {
    return !DEFERRED || names.every(n => !(n in PART_STATE) || PART_STATE[n] === 'loaded' || PART_STATE[n] === 'error');
  }

  function neededParts() {
    if (!DEFERRED) return [];
    if (typeof exactDoi === 'function' && exactDoi(state.search)) return ['feeds', 'library', 'quicklooks', 'radar'];
    if (state.mode === 'sources') return ['health'];
    if (state.mode === 'weekly') return state.weeklyPane === 'reading' ? ['readings'] : [];
    if (state.search && state.search.trim()) return ['feeds', 'library', 'quicklooks', 'radar'];
    const needQuicklooks = state.reading === 'quicklook';
    if (state.mode === 'candidates') return needQuicklooks ? ['feeds', 'radar', 'quicklooks'] : ['feeds', 'radar'];
    if (state.mode === 'library') return needQuicklooks ? ['library', 'quicklooks'] : ['library'];
    return [];
  }

  function priorityParts() {
    const req = neededParts();
    if (!DEFERRED) return req;
    if ((state.mode === 'library' || state.mode === 'candidates') && !req.includes('quicklooks')) {
      return req.concat('quicklooks');
    }
    return req;
  }

  function registerPaper(p) {
    if (!p) return;
    if (p.id && !allPapersMap.has(p.id)) allPapersMap.set(p.id, p);
    STATIC_DOI_PAPERS.push(p);
  }

  function clearAllDerivedCache() {
    allPapersMap.forEach(forgetPaper);
    CURATED.forEach(forgetPaper);
    FEEDS.items.forEach(forgetPaper);
    LIBRARY.papers.forEach(forgetPaper);
  }

  function mergeFeedsPart(payload) {
    const incoming = Array.isArray(payload && payload.items) ? payload.items : [];
    const at = Array.isArray(payload && payload.at) ? payload.at : [];
    incoming.forEach(normalizePaper);
    const tier1 = TIER1_FEEDS || [];
    const tier1Set = new Set(tier1);
    const tier1At = (FEEDS.order && Array.isArray(FEEDS.order.at)) ? FEEDS.order.at : [];
    const trailing = FEEDS.items.filter(p => !tier1Set.has(p));
    const total = Math.max(
      (FEEDS.order && Number.isInteger(FEEDS.order.total)) ? FEEDS.order.total : 0,
      tier1.length + incoming.length
    );
    const rebuilt = new Array(total);
    tier1.forEach((p, idx) => {
      const pos = tier1At[idx];
      if (Number.isInteger(pos) && pos >= 0) rebuilt[pos] = p;
      else rebuilt.push(p);
    });
    incoming.forEach((p, idx) => {
      const pos = at[idx];
      if (Number.isInteger(pos) && pos >= 0) rebuilt[pos] = p;
      else rebuilt.push(p);
    });
    FEEDS.items.length = 0;
    for (let i = 0; i < rebuilt.length; i++) {
      if (rebuilt[i]) FEEDS.items.push(rebuilt[i]);
    }
    incoming.forEach(registerPaper);
    if (trailing.length) {
      const seen = new Set();
      FEEDS.items.forEach(p => {
        if (p.doi) seen.add(String(p.doi).toLowerCase());
        if (p.pmid) seen.add('pmid:' + p.pmid);
      });
      trailing.forEach(p => {
        const d = p.doi ? String(p.doi).toLowerCase() : '';
        const pm = p.pmid ? 'pmid:' + p.pmid : '';
        if ((d && seen.has(d)) || (pm && seen.has(pm))) return;
        FEEDS.items.push(p);
        if (d) seen.add(d);
        if (pm) seen.add(pm);
      });
    }
    if (pendingRadar) {
      const held = pendingRadar;
      pendingRadar = null;
      expandRadar(held, registerPaper);
    }
  }

  function mergeLibraryPart(payload) {
    const papers = Array.isArray(payload && payload.papers) ? payload.papers : [];
    const seenIds = new Set(LIBRARY.papers.map(p => p && p.id).filter(Boolean));
    papers.forEach(p => {
      normalizePaper(p);
      const doi = exactDoi(p.doi);
      if (doi && DOI_FULLTEXT.has(doi)) {
        const sup = DOI_FULLTEXT.get(doi);
        if (sameDoiTitle(p.title, sup.title)) {
          for (let i = LIBRARY.papers.length - 1; i >= 0; i--) {
            const item = LIBRARY.papers[i];
            if (!STATIC_DOI_PAPERS.includes(item) && exactDoi(item.doi) === doi) {
              LIBRARY.papers.splice(i, 1);
            }
          }
        }
      }
      if (!p.id || !seenIds.has(p.id)) {
        LIBRARY.papers.push(p);
        if (p.id) seenIds.add(p.id);
      }
      if (p.id && (!allPapersMap.has(p.id) || !STATIC_DOI_PAPERS.includes(allPapersMap.get(p.id)))) {
        allPapersMap.set(p.id, p);
      }
      STATIC_DOI_PAPERS.push(p);
    });
    if (Array.isArray(payload && payload.pdfIds)) {
      LIBRARY.pdfIds = payload.pdfIds;
      PDF_LIBRARY_IDS.clear();
      payload.pdfIds.forEach(id => PDF_LIBRARY_IDS.add(String(id)));
    } else {
      papers.filter(p => p.doi || p.title).forEach(p => PDF_LIBRARY_IDS.add(String(p.id)));
    }
    delete LIBRARY.deferred;
  }

  function afterPartMerged(name) {
    _maxDateCache = null;
    updateHeaderBadges();
    updateHuddleCounter();

    const snapshots = captureFtFormSnapshots();
    const doi = exactDoi(state.search);

    if (doi) {
      if (['feeds', 'library', 'quicklooks', 'radar'].includes(name)) {
        renderStream();
      }
    } else if (state.mode === 'weekly') {
      if (name === 'readings') {
        renderDailyDeepRead();
        renderWeeklyAuto();
        const readId = urlParams.get('read');
        if (readId && !activeDeepReadingId) openDeepReading(readId, { push: false });
      } else if (name === 'library') {
        renderNextCandidates();
      } else if (['quicklooks', 'pregenerated', 'board'].includes(name)) {
        renderWeeklyAuto();
      }
    } else if (state.mode === 'sources') {
      if (name === 'health') renderSourcesHealth();
    } else if (state.mode === 'candidates') {
      if (['feeds', 'radar', 'quicklooks'].includes(name)) {
        renderSidebarFilters();
        renderStream();
      }
    } else if (state.mode === 'library') {
      if (['library', 'quicklooks'].includes(name)) {
        renderSidebarFilters();
        renderStream();
      }
    } else if (state.mode === 'curated') {
      const relevant = (state.search && state.search.trim())
        ? ['feeds', 'library', 'quicklooks', 'radar'].includes(name)
        : ['quicklooks', 'library'].includes(name);
      if (relevant) {
        renderSidebarFilters();
        renderStream();
      }
    }

    if (state.activeDrawerPaper && $('#readerDrawer.open')) {
      const livePaper = allPapersMap.get(state.activeDrawerPaper.id) || state.activeDrawerPaper;
      if (['quicklooks', 'pregenerated'].includes(name) || livePaper !== state.activeDrawerPaper) {
        openReaderDrawer(livePaper);
      }
    }
    if ($('#huddleModalBackdrop.open')) {
      openHuddleModal();
    }
    restoreFtFormSnapshots(snapshots);
  }

  function mergePart(name, payload) {
    if (!DEFERRED) return;
    const idx = partQueue.indexOf(name);
    if (idx >= 0) partQueue.splice(idx, 1);
    if (name === 'feeds') {
      mergeFeedsPart(payload);
    } else if (name === 'radar') {
      if (PART_STATE.feeds === 'loaded' || !('feeds' in PART_STATE)) expandRadar(payload, registerPaper);
      else pendingRadar = payload;
    } else if (name === 'library') {
      mergeLibraryPart(payload);
    } else if (name === 'quicklooks') {
      const items = payload && typeof payload.items === 'object' ? payload.items : (payload || {});
      Object.assign(window.QUICKLOOKS || (window.QUICKLOOKS = {}), items);
      clearAllDerivedCache();
    } else if (name === 'pregenerated') {
      const items = payload && typeof payload.items === 'object' ? payload.items : (payload || {});
      Object.assign(window.PREGENERATED || (window.PREGENERATED = {}), items);
      clearAllDerivedCache();
    } else if (name === 'health') {
      if (Array.isArray(payload && payload.sources)) {
        HEALTH.sources.length = 0;
        payload.sources.forEach(s => HEALTH.sources.push(s));
      }
      if (payload && 'pubmedFetch' in payload) HEALTH.pubmedFetch = payload.pubmedFetch;
      delete HEALTH.deferred;
    } else if (name === 'readings') {
      window.DEEP_READINGS = payload;
    } else if (name === 'board') {
      window.WEEKLY_BOARD = payload;
    }
    PART_STATE[name] = 'loaded';
    syncDataState();
    afterPartMerged(name);
  }

  function onPartError(name) {
    const doi = exactDoi(state.search);
    if (doi && ['feeds', 'library', 'quicklooks', 'radar'].includes(name)) {
      renderStream();
    } else if (state.mode === 'sources' && name === 'health') {
      renderSourcesHealth();
    } else if (state.mode === 'weekly' && name === 'readings') {
      renderDailyDeepRead();
    } else if (neededParts().includes(name)) {
      renderStream();
    }
    if ($('#huddleModalBackdrop.open')) {
      openHuddleModal();
    }
  }

  function prioritizeParts() {
    if (!DEFERRED || !partQueue.length) return;
    const priority = priorityParts();
    partQueue.sort((a, b) => {
      const ai = priority.indexOf(a);
      const bi = priority.indexOf(b);
      const an = ai >= 0 ? ai : priority.length;
      const bn = bi >= 0 ? bi : priority.length;
      if (an !== bn) return an - bn;
      return PART_ORDER.indexOf(a) - PART_ORDER.indexOf(b);
    });
  }

  function loadPart(name) {
    if (!DEFERRED || !window.XINZHI_PARTS.parts[name]) return;
    if (PART_STATE[name] === 'loading' || PART_STATE[name] === 'loaded') return;
    const info = window.XINZHI_PARTS.parts[name];
    if (!info || !info.src) {
      PART_STATE[name] = 'error';
      syncDataState();
      onPartError(name);
      return;
    }
    PART_STATE[name] = 'loading';
    syncDataState();
    inFlight++;
    const script = document.createElement('script');
    script.src = info.src;
    script.async = true;
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      inFlight = Math.max(0, inFlight - 1);
      if (!ok && PART_STATE[name] === 'loading') {
        PART_STATE[name] = 'error';
        syncDataState();
        script.remove();
        onPartError(name);
      }
      pumpPartQueue();
    };
    script.onload = () => {
      if (PART_STATE[name] !== 'loaded') finish(false);
      else finish(true);
    };
    script.onerror = () => finish(false);
    document.head.appendChild(script);
  }

  function pumpPartQueue() {
    if (!DEFERRED) return;
    while (inFlight < MAX_IN_FLIGHT && partQueue.length) {
      const next = partQueue.shift();
      if (PART_STATE[next] === 'idle') loadPart(next);
    }
  }

  function retryParts(names) {
    if (!DEFERRED) return;
    const list = (names && names.length ? names : PART_ORDER).filter(n => PART_STATE[n] === 'error');
    const targets = list.length ? list : PART_ORDER.filter(n => PART_STATE[n] === 'error');
    if (!targets.length) return;
    targets.forEach(n => {
      PART_STATE[n] = 'idle';
      if (!partQueue.includes(n)) partQueue.push(n);
    });
    syncDataState();
    prioritizeParts();
    pumpPartQueue();
  }

  function startDeferredParts() {
    if (!DEFERRED) return;
    PART_ORDER.forEach(n => {
      if (PART_STATE[n] === 'idle' && !partQueue.includes(n)) partQueue.push(n);
    });
    prioritizeParts();
    pumpPartQueue();
  }

  if (DEFERRED) {
    window.XINZHI_PART = function (name, payload) {
      mergePart(name, payload);
    };
  }
