  // ==== src/app/07-shortlist.js · Shortlist (精选清单) modal, export and copy ====
  // Morning Huddle Modal Logic
  // The shortlist keeps a small record of each paper. Radar papers older than three weeks load
  // only on demand, and old ones leave the archive, so the IDs alone cannot always be resolved.
  const HUDDLE_SNAP_PAPERS = new Map();
  function huddleSnapshot(p) {
    return { title: String(p.title || '').slice(0, 800), titleZh: p.draftData?.title_zh || quicklookOf(p)?.title_zh || p.titleZh || '',
      journal: p.cleanJournal || p.journal || '', date: String(p.date || '').slice(0, 10), doi: p.doi ? String(p.doi) : '',
      pmid: p.pmid ? String(p.pmid) : '', url: safeSourceUrl(p), studyDesign: p.studyDesign || '' };
  }
  function huddlePaper(id) {
    const live = allPapersMap.get(id);
    if (live) return live;
    const snap = state.huddleSnap[id];
    if (!snap || typeof snap.title !== 'string' || !snap.title) return null;
    if (!HUDDLE_SNAP_PAPERS.has(id)) HUDDLE_SNAP_PAPERS.set(id, { ...snap, id, cleanJournal: snap.journal, tags: [], quantitativeMetrics: {}, snapshot: true });
    return HUDDLE_SNAP_PAPERS.get(id);
  }
  function huddlePapers() { return state.huddle.map(huddlePaper).filter(Boolean); }
  function updateHuddleCounter() {
    const counter = $('#huddleCounter');
    if (counter) counter.textContent = state.huddle.length;
    const snap = {};
    state.huddle.forEach(id => {
      const live = allPapersMap.get(id);
      if (live) snap[id] = huddleSnapshot(live);
      else if (state.huddleSnap[id]) snap[id] = state.huddleSnap[id];
    });
    state.huddleSnap = snap;
    safeSet('xinzhi_huddle_ids', JSON.stringify(state.huddle));
    safeSet('xinzhi_huddle_snap', JSON.stringify(snap));
  }
  function toggleHuddle(paperId) {
    if (state.huddle.includes(paperId)) {
      state.huddle = state.huddle.filter(id => id !== paperId);
      showToast('已从精选清单移出');
    } else {
      state.huddle.push(paperId);
      showToast('已加入精选清单');
    }
    updateHuddleCounter();
    renderStream();
    if (state.mode === 'weekly') { renderWeeklyAuto(); renderNextCandidates(); }
    if (state.activeDrawerPaper?.id === paperId) openReaderDrawer(state.activeDrawerPaper);
  }

  const SHORTLIST_SHARE_LIMIT = 60;
  const SHORTLIST_SHARE_URL_LIMIT = 2000;
  const SHORTLIST_SHARE_ID_LIMIT = 160;
  const shortlistPaperParts = ['feeds', 'library', 'radar'];

  function shortlistIdKey(id) {
    if (typeof id !== 'string' || !id || id.length > SHORTLIST_SHARE_ID_LIMIT || /[^\x21-\x7e]/.test(id)) return '';
    if (/^10\.\d{4,9}\/[a-z0-9._/%()+;:\-=]+$/i.test(id)) return id.toLowerCase();
    const pmid = /^(?:pmid-)?([1-9]\d{0,9})$/i.exec(id);
    if (pmid) return 'pmid-' + pmid[1];
    return /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id : '';
  }

  function encodeShortlistShare(ids) {
    return 'v1.' + btoa(ids.join('\n')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeShortlistShare(value) {
    const ids = [];
    let ignored = false;
    if (typeof value !== 'string' || value.length >= SHORTLIST_SHARE_URL_LIMIT || !value.startsWith('v1.')
      || value.length === 3 || /[^a-z0-9_-]/i.test(value.slice(3))) {
      return { ids, ignored: true };
    }
    let tokens;
    try {
      tokens = atob(value.slice(3).replace(/-/g, '+').replace(/_/g, '/')).split('\n');
    } catch (e) {
      return { ids, ignored: true };
    }
    const seen = new Set();
    for (const id of tokens) {
      const key = shortlistIdKey(id);
      if (!key || seen.has(key) || ids.length >= SHORTLIST_SHARE_LIMIT) {
        ignored = true;
        continue;
      }
      ids.push(id);
      seen.add(key);
    }
    return { ids, ignored };
  }

  function buildShortlistShareUrl(pageUrl, ids) {
    const url = new URL(pageUrl);
    // Start from the page itself. Filters, request parameters, and reader state stay in this browser.
    url.search = '';
    url.hash = '';
    const accepted = [];
    const seen = new Set();
    let limited = false;
    for (const id of ids) {
      const key = shortlistIdKey(id);
      if (!key || seen.has(key)) continue;
      url.searchParams.set('list', encodeShortlistShare([...accepted, id]));
      if (accepted.length >= SHORTLIST_SHARE_LIMIT || url.href.length >= SHORTLIST_SHARE_URL_LIMIT) {
        limited = true;
        break;
      }
      accepted.push(id);
      seen.add(key);
    }
    if (!accepted.length) return { href: '', count: 0, limited };
    url.searchParams.set('list', encodeShortlistShare(accepted));
    return { href: url.href, count: accepted.length, limited };
  }

  function publicShortlistPapers(ids) {
    const wanted = new Set(ids.map(shortlistIdKey).filter(Boolean));
    const matches = new Map();
    const aliases = new Map();
    if (!wanted.size) return [];
    // Static published records include deferred parts and the radar archive once loaded.
    // The broader drawer index also includes supplemental lookups and is unsuitable here.
    for (const paper of STATIC_DOI_PAPERS) {
      const key = shortlistIdKey(paper.id);
      if (!key) continue;
      if (wanted.has(key) && !matches.has(key)) matches.set(key, paper);
      const doi = exactDoi(paper.doi);
      const pmid = paper.pmid ? 'pmid-' + paper.pmid : '';
      for (const alias of [doi, pmid]) {
        if (wanted.has(alias) && !aliases.has(alias)) aliases.set(alias, paper);
      }
    }
    return ids.map(id => {
      const key = shortlistIdKey(id);
      return matches.get(key) || aliases.get(key);
    });
  }

  function shareableHuddleIds(ids) {
    const papers = publicShortlistPapers(ids);
    // Use the canonical public record ID even if a saved selection used an alias.
    return [...new Set(papers.filter(Boolean).map(paper => paper.id))];
  }

  async function copyShortlistShare() {
    const button = $('#copyShortlistShareBtn');
    const field = $('#shortlistShareCopyField');
    const notice = $('#shortlistShareCopyNotice');
    field.hidden = true;
    const publicIds = shareableHuddleIds(state.huddle);
    const omitted = new Set(state.huddle).size - publicIds.length;
    if (omitted && (partsPending(...shortlistPaperParts) || RADAR_LOAD.state === 'loading' || RADAR_LOAD.state === 'idle')) {
      loadRadarArchive();
      notice.textContent = '正在查找可分享的公开题录，请稍后再复制。';
      return;
    }
    const link = buildShortlistShareUrl(location.href, publicIds);
    if (!link.href) {
      notice.textContent = '清单中没有可通过链接分享的公开题录。';
      return;
    }
    const messages = [];
    if (link.limited) messages.push(`链接长度或篇数已达上限，可分享前 ${link.count} 篇公开题录。`);
    if (omitted) messages.push('已略过未匹配到公开题录或重复的条目。');
    notice.textContent = messages.join('');
    if (link.limited && button.dataset.sharePrefix !== link.href) {
      button.dataset.sharePrefix = link.href;
      button.textContent = `复制前 ${link.count} 篇的链接`;
      return;
    }
    delete button.dataset.sharePrefix;
    button.textContent = '复制分享链接';
    const input = $('#shortlistShareCopyUrl');
    const copied = navigator.clipboard?.writeText && await copyToClipboard(link.href, '已复制分享链接');
    if (!copied && $('#huddleModalBackdrop.open')) {
      field.hidden = false;
      input.value = link.href;
      input.focus();
      input.select();
    }
  }

  let renderedShortlistShare = null;
  let sharedShortlistIds = [];
  function renderSharedShortlist() {
    const view = $('#sharedShortlist');
    if (!view) return;
    const value = state.shortlistShare;
    view.hidden = value === null;
    if (view.hidden) {
      renderedShortlistShare = null;
      sharedShortlistIds = [];
      $('#sharedShortlistRows').replaceChildren();
      return;
    }
    if (value === renderedShortlistShare) return;
    const { ids, ignored } = decodeShortlistShare(value);
    const pending = ids.length > 0 && partsPending(...shortlistPaperParts);
    const matches = pending ? [] : publicShortlistPapers(ids);
    const missing = ids.filter((id, index) => !matches[index]);
    if (!pending && missing.length) loadRadarArchive();
    const loading = pending || (missing.length > 0 && RADAR_LOAD.state === 'loading');
    const failed = !partsReady(...shortlistPaperParts) || RADAR_LOAD.state === 'error';
    const papers = new Map();
    if (!loading) {
      for (const paper of matches) if (paper && !papers.has(paper.id)) papers.set(paper.id, paper);
    }
    sharedShortlistIds = [...papers.keys()];
    const count = loading ? ids.length : sharedShortlistIds.length;
    $('#sharedShortlistTitle').textContent = `正在查看分享的清单（${count} 篇）`;
    $('#mergeSharedShortlistBtn').disabled = sharedShortlistIds.length === 0;
    const messages = [];
    const duplicateMatches = !loading && matches.length - missing.length > papers.size;
    if (ignored || duplicateMatches) messages.push('已忽略无效、重复或超出限制的分享条目。');
    if (loading) messages.push('正在查找公开题录…');
    $('#sharedShortlistNotice').textContent = messages.join('');
    const missingGroup = $('#sharedShortlistMissing');
    missingGroup.hidden = loading || !missing.length;
    missingGroup.open = false;
    $('#sharedShortlistMissingLabel').textContent = failed
      ? `${missing.length} 篇暂无法确认（部分题录加载失败，请刷新重试）`
      : `${missing.length} 篇在本站未找到`;
    $('#sharedShortlistMissingIds').textContent = missing.join('\n');
    if (loading) {
      $('#sharedShortlistRows').replaceChildren();
      return;
    }
    const rows = document.createElement('template');
    rows.innerHTML = [...papers.values()].map(renderCompactRow).join('');
    rows.content.querySelectorAll('.card-side-actions, .ft-status, .fulltext-state').forEach(node => node.remove());
    rows.content.querySelectorAll('button.topic-badge').forEach(button => {
      const badge = document.createElement('span');
      badge.className = button.className;
      badge.textContent = button.textContent;
      button.replaceWith(badge);
    });
    $('#sharedShortlistRows').replaceChildren(rows.content);
    renderedShortlistShare = value;
  }

  function mergeSharedShortlist() {
    const existing = new Set([...state.huddle, ...shareableHuddleIds(state.huddle)]);
    const added = sharedShortlistIds.filter(id => !existing.has(id));
    if (!added.length) {
      showToast('这些文献已在你的精选清单中');
      return;
    }
    state.huddle.push(...added);
    updateHuddleCounter();
    renderStream();
    if (state.mode === 'weekly') renderWeeklyAuto();
    showToast(`已加入 ${added.length} 篇到你的精选清单`);
  }

  let huddleLastFocus=null;
  function openHuddleModal() {
    const modal = $('#huddleModalBackdrop');
    const body = $('#huddleModalBody');
    if (!modal || !body) return;
    const activeControl = body.contains(document.activeElement) ? document.activeElement.closest('[data-action]') : null;
    const focusAction = activeControl ? { action: activeControl.dataset.action, paperId: activeControl.dataset.paperId, mode: activeControl.dataset.mode } : null;

    const list = huddlePapers();
    const missing = state.huddle.filter(id => !huddlePaper(id));
    const shareButton = $('#copyShortlistShareBtn');
    if (shareButton) shareButton.disabled = state.huddle.length === 0;
    // Shortlists saved before records were kept: fetch the radar archive once to find older papers.
    if (missing.some(id => id.startsWith('pmid-')) && RADAR_LOAD.state === 'idle') loadRadarArchive();
    if (!DEFERRED || partsSettled('feeds', 'library', 'radar')) {
      state.huddleCompare = state.huddleCompare.filter(id => state.huddle.includes(id) && huddlePaper(id));
    } else {
      state.huddleCompare = state.huddleCompare.filter(id => state.huddle.includes(id));
    }
    const selected = selectedComparePapers();
    ['clearHuddleBtn', 'copyHuddleSummaryBtn', 'exportHuddleMdBtn'].forEach(id => {
      const button = $('#' + id);
      if (!button) return;
      button.disabled = id === 'clearHuddleBtn' ? state.huddle.length === 0 : list.length === 0;
      if (button.disabled) button.setAttribute('aria-describedby', 'huddleEmptyHelp');
      else button.removeAttribute('aria-describedby');
    });
    const pendingParts = DEFERRED && ['feeds', 'library', 'radar'].some(n => PART_STATE[n] === 'idle' || PART_STATE[n] === 'loading');
    const erroredParts = DEFERRED && !pendingParts && ['feeds', 'library', 'radar'].some(n => PART_STATE[n] === 'error');
    const missingMsg = pendingParts ? '加载中… '
      : RADAR_LOAD.state === 'loading' ? '正在载入题录存档…'
      : erroredParts ? '部分题录加载失败。'
      : '这条可能已超出站内收录范围。';
    const missingRetry = erroredParts ? ' <button type="button" class="btn-sm" data-action="retry-part">重试</button>' : '';
    const missingHtml = missing.map(id => `
        <div class="huddle-item huddle-item-missing">
          <div class="huddle-item-content">
            <h4>文献信息暂未载入</h4>
            <p class="huddle-original-title">${missingMsg}编号 ${esc(id)}${missingRetry}</p>
          </div>
          <button class="btn-sm" data-action="remove-huddle" data-paper-id="${esc(id)}">移出</button>
        </div>`).join('');

    if (list.length === 0 && !missing.length) {
      body.innerHTML = `
        <div class="empty-state" style="padding:30px;">
          <p id="huddleEmptyHelp" role="status">精选清单当前为空，添加文献后可清空、复制或导出。</p>
          <small style="color:var(--text-muted);">在文献列表中点卡片上的“精选”加入精选清单。</small>
        </div>
      `;
    } else {
      body.innerHTML = '<p class="study-selection-help" id="compareSelectionHelp">勾选 2–4 篇生成证据对照；选择仅保留在当前浏览器会话，勾选不会调用模型。</p>' + list.map((p, i) => `
        <div class="huddle-item">
          <div class="huddle-item-content">
            <h4>${i + 1}. ${esc(p.draftData?.title_zh || quicklookOf(p)?.title_zh || p.titleZh || p.title)}</h4>
            ${(p.draftData?.title_zh || quicklookOf(p)?.title_zh || p.titleZh) ? `<p class="huddle-original-title" lang="en">${esc(p.title)}</p>` : ''}
            <div class="huddle-item-meta">
              <span>${esc(p.cleanJournal || p.journal)}</span> ${journalMetricBadge(p)} ·
              <span>${esc(p.studyDesign || '研究类型待核验')}</span> · 
              <span>${esc(p.date ? p.date.slice(0, 10) : '')}</span>
            </div>
            ${publicationStatusHtml(p)}
            <label class="study-select"><input type="checkbox" data-action="compare-select" data-paper-id="${esc(p.id)}" aria-label="将 ${esc(p.title)} 纳入证据对照" aria-describedby="compareSelectionHelp" ${state.huddleCompare.includes(p.id) ? 'checked' : ''} ${!studyKey(p) || (!state.huddleCompare.includes(p.id) && selected.length >= 4) ? 'disabled' : ''}>纳入证据对照${!studyKey(p) ? '（缺少 PMID/DOI）' : ''}</label>
          </div>
          <button class="btn-sm" data-action="remove-huddle" data-paper-id="${esc(p.id)}">移出</button>
        </div>
      `).join('') + missingHtml + (list.length ? compareBoxHtml(list) + (AI_AVAIL === true ? briefHtml('huddle', list) : '') : '');
    }

    window.CITATION_EXPORT?.mount(body, list, { formatter: buildCitations, copy: copyToClipboard, today: beijingToday });

    const newlyOpened = !modal.classList.contains('open');
    if(newlyOpened) {
      if (shareButton) {
        delete shareButton.dataset.sharePrefix;
        shareButton.textContent = '复制分享链接';
        $('#shortlistShareCopyField').hidden = true;
        $('#shortlistShareCopyNotice').textContent = '';
      }
      huddleLastFocus=document.activeElement;
      pushOverlay('huddle');
    }
    modal.classList.add('open'); document.body.classList.add('dialog-open');
    if(newlyOpened) $('#closeHuddleModalBtn')?.focus({preventScroll:true});
    else if (focusAction) {
      const nextControl = [...body.querySelectorAll('[data-action]')].find(x => x.dataset.action === focusAction.action && x.dataset.paperId === focusAction.paperId && x.dataset.mode === focusAction.mode);
      (nextControl || body.querySelector('.compare-box') || $('#closeHuddleModalBtn'))?.focus({ preventScroll: true });
    }
    compareCheck();
  }

  function closeHuddleModal({ fromHistory = false } = {}) {
    if (!$('#huddleModalBackdrop.open')) return;
    if (!fromHistory && popOverlay('huddle')) return;
    OVERLAY_PUSHED.delete('huddle');
    const modal = $('#huddleModalBackdrop');
    if (modal) modal.classList.remove('open');
    if(!$('#readerDrawer.open')) document.body.classList.remove('dialog-open');
    huddleLastFocus?.focus({preventScroll:true});huddleLastFocus=null;
  }

  // Export Huddle Markdown
  function exportHuddleMarkdown() {
    const list = huddlePapers();
    if (!list.length) {
      showToast('清单为空，无法导出');
      return;
    }

    const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    let md = `# 心知文献情报 · 精选清单 (${todayStr})\n\n`;
    md += `共纳入 ${list.length} 篇前沿文献，用于科室文献研读与临床思辨。\n\n---\n\n`;

    list.forEach((p, i) => {
      const title = p.draftData?.title_zh || p.title;
      const journal = p.cleanJournal || p.journal || '期刊';
      const date = p.date ? p.date.slice(0, 10) : '';
      const design = p.studyDesign || '临床研究';
      const url = safeSourceUrl(p);

      md += `### ${i + 1}. ${title}\n\n`;
      if (p.draftData?.title_zh) md += `- **英文原题**：${p.title}\n`;
      md += `- **期刊来源**：${journal} (${date}) | ${design}\n`;
      if (p.publicationStatus) md += publicationStatusText(p) + '\n';
      md += `- **期刊指标**：${journalMetricText(p)}\n`;
      if (p.doi) md += `- **DOI / 原文**：[${p.doi}](${url})\n`;
      md += `- **核心速览**：${p.draftData?.summary || p.summary || '待讨论'}\n`;
      if (p.draftData?.limitations) md += `- **证据边界**：${p.draftData.limitations}\n`;
      if (p.draftData?.learning_question) md += `- **精选思考题**：${p.draftData.learning_question}\n`;
      md += `\n---\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `精选文献清单-${todayStr}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
    showToast('已导出 Markdown 清单');
  }

  // Copy Huddle Batch Summary for WeChat
  function copyHuddleSummary() {
    const list = huddlePapers();
    if (!list.length) {
      showToast('清单为空');
      return;
    }
    const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    let text = `【心知文献情报 · 精选文献速递】(${todayStr})\n\n`;
    list.forEach((p, i) => {
      const title = p.draftData?.title_zh || p.title;
      const journal = p.cleanJournal || p.journal;
      const design = p.studyDesign || '研究';
      text += `${i + 1}. [${journal} | ${design}] ${title}\n期刊指标：${journalMetricText(p)}\n`;
      if (p.publicationStatus) text += publicationStatusText(p) + '\n';
      if (p.draftData?.summary) text += `   要点：${p.draftData.summary.slice(0, 100)}...\n`;
      text += `   原文：${safeSourceUrl(p)}\n\n`;
    });
    copyToClipboard(text, '已复制精选汇总文字');
  }

  // This-Browser Request History Modal
  function updateRequestsCounter() {
    const el = $('#requestsCounter');
    if (!el || typeof loadBrowserRequests !== 'function') return;
    el.textContent = loadBrowserRequests().length;
  }
  function resolveBrowserRequestView(rec) {
    const live = exactDoiPapers(rec.doi)[0] || DOI_FULLTEXT.get(rec.doi);
    const staticPaper = ['ingested', 'already_in_library'].includes(rec.libraryState)
      ? requestLibraryMatch(rec.doi, rec.title) : null;
    const detailPaper = staticPaper || (live && (allPapersMap.get(live.id) || live));
    const dlUrl = live ? pdfDownloadUrl(live) : '';
    const ft = live && fulltextState(live);
    let kind = rec.status;
    let label = {
      queued: '排队下载', running: '排队下载', verifying: '核验中',
      failed: '未取得', manual_needed: '未取得', review: ft?.kind === 'review' ? ft.short : '未取得',
      pending: '待处理 / 查无进行中任务',
    }[rec.status] || '已记录';
    if (rec.status === 'available') {
      kind = 'ready';
      label = rec.libraryState === 'ingested' && (staticPaper || LIBRARY.deferred) ? '已入库'
        : rec.libraryState === 'already_in_library' && (staticPaper || LIBRARY.deferred) ? '库里已有'
        : '已取得全文，待归类入库';
      if (rec.libraryState === 'identity_conflict') {
        kind = 'review'; label = '题录冲突，待人工核验';
      }
    } else if (rec.reason === 'identity_hold' || rec.reason === 'identity_hold_rejected') {
      kind = 'review'; label = rec.reason === 'identity_hold' ? '待人工核验' : '人工核验未通过，可重新提交';
    }
    const title = detailPaper?.title || rec.title;
    const key = doiTitleKey(title);
    const otherDois = rec.status === 'available' && !rec.libraryState && key ? [...new Set(
      [...requestLibraryPapers()].filter(p => doiTitleKey(p.title) === key)
        .map(p => exactDoi(p.doi)).filter(doi => doi && doi !== rec.doi)
    )] : [];
    const journal = detailPaper?.cleanJournal || detailPaper?.journal || rec.journal;
    return { livePaper: detailPaper, staticPaper, kind, label, dlUrl, title: title || rec.doi, journal, otherDois };
  }
  function renderRequestsModal() {
    const body = $('#requestsModalBody');
    if (!body || typeof loadBrowserRequests !== 'function') return;
    const list = loadBrowserRequests();
    updateRequestsCounter();
    const refreshAllBtn = $('#refreshRequestsBtn');
    if (refreshAllBtn) refreshAllBtn.disabled = list.length === 0 || !!browserRequestsRefreshing;
    const disclosure = `<p class="req-disclosure" role="note">仅保存在这台设备的这个浏览器（localStorage）中，不是账号同步，也不是服务器持久账本；状态刷新按完整 DOI 点查，不受默认领域筛选或动态补录前 100 条分页上限影响。仅在服务器确认提交或查到记录后才保存，网络不确定时不会自动重新排队。</p>`;
    if (!list.length) {
      body.innerHTML = disclosure + `<div class="empty-state" style="padding:24px;">
        <p role="status">当前浏览器还没有已确认的全文申请记录。</p>
        <small style="color:var(--text-muted);">提交获取全文且经服务器确认后，会记在这里以便随时回查状态。</small>
      </div>`;
      return;
    }
    const modeNames = { curated: '每日精选', weekly: '近7天榜', candidates: '文献雷达', library: '文献库' };
    body.innerHTML = disclosure + list.map(rec => {
      const v = resolveBrowserRequestView(rec);
      const timeText = rec.requestedAt ? rec.requestedAt.slice(0, 16).replace('T', ' ') : '';
      const srcLabel = rec.sourceMode && modeNames[rec.sourceMode] ? modeNames[rec.sourceMode] : '';
      const checkedText = rec.lastCheckedAt ? ('最近核对 ' + rec.lastCheckedAt.slice(0, 16).replace('T', ' ')) : '';
      const dlHtml = v.dlUrl
        ? `<a href="${esc(v.dlUrl)}" target="_blank" rel="noopener" class="btn-sm btn-primary" data-ft-download="1">下载 PDF</a>`
          + `<form class="ft-form ft-dl-form" data-ft-dl-form data-doi="${esc(rec.doi)}" hidden><label>全文口令 <input name="passphrase" type="password" maxlength="256" autocomplete="current-password" required></label><button type="submit" class="btn-sm btn-primary">下载</button><span class="ft-error" role="alert"></span></form>`
        : '';
      const detailHtml = v.livePaper
        ? `<button type="button" class="btn-sm" data-action="open-request-paper" data-doi="${esc(rec.doi)}">阅读详情</button>`
        : `<button type="button" class="btn-sm" data-action="search-request-doi" data-doi="${esc(rec.doi)}">按 DOI 检索</button>`;
      return `<article class="req-item" data-req-doi="${esc(rec.doi)}">
        <div class="req-item-head">
          <h4>${esc(v.title)}</h4>
          <span class="req-status-badge req-status-${esc(v.kind)}">${esc(v.label)}</span>
        </div>
        <div class="req-item-meta">
          <span>DOI: <code>${esc(rec.doi)}</code></span>
          ${v.journal ? `<span>· ${esc(v.journal)}</span>` : ''}
          ${srcLabel ? `<span>· 来自${esc(srcLabel)}</span>` : ''}
          ${timeText ? `<span>· 申请于 ${esc(timeText)}</span>` : ''}
          ${checkedText ? `<span>· ${esc(checkedText)}</span>` : ''}
          ${v.dlUrl ? '<span>· 全文可下载</span>' : ''}
        </div>
        ${v.staticPaper ? `<p class="req-item-note req-classification">期刊档：${esc(v.staticPaper.clinicalTier || '未分类')} · 出版方：${esc(v.staticPaper.publisher || '未分类')} · 研究设计：${esc(v.staticPaper.studyDesign || '未分类')} · 主题标签：${esc(v.staticPaper.tags?.join('、') || '未分类')}</p>` : ''}
        ${v.otherDois.length ? `<p class="req-item-note req-possible-duplicate">题名相同但 DOI 不同，仅供人工核对：${esc(v.otherDois.join('、'))}</p>` : ''}
        ${rec.note ? `<p class="req-item-note">${esc(rec.note)}</p>` : ''}
        <div class="req-item-actions">
          ${detailHtml}
          ${dlHtml}
          <button type="button" class="btn-sm" data-action="refresh-request-doi" data-doi="${esc(rec.doi)}">刷新状态</button>
          <button type="button" class="btn-sm" data-action="remove-request-doi" data-doi="${esc(rec.doi)}">移除</button>
        </div>
      </article>`;
    }).join('');
  }
  let requestsLastFocus = null;
  function openRequestsModal() {
    const modal = $('#requestsModalBackdrop');
    if (!modal) return;
    renderRequestsModal();
    const newlyOpened = !modal.classList.contains('open');
    if (newlyOpened) { requestsLastFocus = document.activeElement; pushOverlay('requests'); }
    modal.classList.add('open');
    document.body.classList.add('dialog-open');
    if (newlyOpened) $('#closeRequestsModalBtn')?.focus({ preventScroll: true });
    if (typeof refreshBrowserRequests === 'function') {
      refreshBrowserRequests({ activeOnly: true, limit: 10 }).then(() => {
        if ($('#requestsModalBackdrop.open')) renderRequestsModal();
      });
    }
  }
  function closeRequestsModal({ fromHistory = false } = {}) {
    if (!$('#requestsModalBackdrop.open')) return;
    if (!fromHistory && popOverlay('requests')) return;
    OVERLAY_PUSHED.delete('requests');
    const modal = $('#requestsModalBackdrop');
    if (modal) modal.classList.remove('open');
    if (!$('#readerDrawer.open') && !$('#huddleModalBackdrop.open')) document.body.classList.remove('dialog-open');
    requestsLastFocus?.focus({ preventScroll: true });
    requestsLastFocus = null;
  }
