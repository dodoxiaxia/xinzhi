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

  let huddleLastFocus=null;
  function openHuddleModal() {
    const modal = $('#huddleModalBackdrop');
    const body = $('#huddleModalBody');
    if (!modal || !body) return;
    const activeControl = body.contains(document.activeElement) ? document.activeElement.closest('[data-action]') : null;
    const focusAction = activeControl ? { action: activeControl.dataset.action, paperId: activeControl.dataset.paperId, mode: activeControl.dataset.mode } : null;

    const list = huddlePapers();
    const missing = state.huddle.filter(id => !huddlePaper(id));
    // Shortlists saved before records were kept: fetch the radar archive once to find older papers.
    if (missing.some(id => id.startsWith('pmid-')) && RADAR_LOAD.state === 'idle') loadRadarArchive();
    state.huddleCompare = state.huddleCompare.filter(id => state.huddle.includes(id) && huddlePaper(id));
    const selected = selectedComparePapers();
    ['clearHuddleBtn', 'copyHuddleSummaryBtn', 'exportHuddleMdBtn'].forEach(id => {
      const button = $('#' + id);
      if (!button) return;
      button.disabled = id === 'clearHuddleBtn' ? state.huddle.length === 0 : list.length === 0;
      if (button.disabled) button.setAttribute('aria-describedby', 'huddleEmptyHelp');
      else button.removeAttribute('aria-describedby');
    });
    const missingHtml = missing.map(id => `
        <div class="huddle-item huddle-item-missing">
          <div class="huddle-item-content">
            <h4>文献信息暂未载入</h4>
            <p class="huddle-original-title">${RADAR_LOAD.state === 'loading' ? '正在载入题录存档…' : '这条可能已超出站内收录范围。'}编号 ${esc(id)}</p>
          </div>
          <button class="btn-sm" data-action="remove-huddle" data-paper-id="${esc(id)}">移出</button>
        </div>`).join('');

    if (list.length === 0 && !missing.length) {
      body.innerHTML = `
        <div class="empty-state" style="padding:30px;">
          <p id="huddleEmptyHelp" role="status">精选清单当前为空，添加文献后可清空、复制或导出。</p>
          <small style="color:var(--text-muted);">从文献列表中点击“加入精选清单”，即可将心仪文献加入讨论清单。</small>
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
    if(newlyOpened) { huddleLastFocus=document.activeElement; pushOverlay('huddle'); }
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

