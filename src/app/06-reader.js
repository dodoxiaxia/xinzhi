  // ==== src/app/06-reader.js · Reading drawer and public abstracts ====
  // Slide-over Reader Drawer Open/Close
  function openReaderDrawer(paper) {
    const changedPaper = !state.activeDrawerPaper || state.activeDrawerPaper.id !== paper.id;
    hydratePreGenerated(paper);
    state.activeDrawerPaper = paper;
    let absFetchPlanned = false;
    const drawer = $('#readerDrawer');
    const backdrop = $('#drawerBackdrop');
    if (!drawer || !backdrop) return;
    if (DEFERRED && !partsReady('pregenerated', 'quicklooks')) {
      prioritizeParts();
      pumpPartQueue();
    }
    const prevScrollTop = (!changedPaper && $('#drawerBody')) ? $('#drawerBody').scrollTop : 0;

    const pubClass = getPublisherClass(paper.publisher);
    const designClass = getDesignClass(paper.studyDesign);
    const journalName = cardJournalName(paper);
    const dateStr = dateLabel(paper);
    const doiUrl = officialArticleUrl(paper) || '#';
    const isHuddled = state.huddle.includes(paper.id);

    // Header Badges
    const headerBadges = $('#drawerJournalBadges');
    if (headerBadges) {
      headerBadges.innerHTML = `
        <span class="journal-badge ${pubClass}">${esc(journalName)}</span>
        ${journalMetricBadge(paper)}
        ${designBadgeHtml(paper)}
        ${paper.kind ? `<span class="tag-pill kind-pill">${esc(paper.kind)}</span>` : ''}
        <span class="date-badge">${esc(dateStr)}</span>
      `;
    }

    // Body
    const bodyEl = $('#drawerBody');
    if (bodyEl) {
      const draft = paper.draftData;

      let editorialSection = '';
      if (draft && (draft.limitations || draft.learning_question)) {
        editorialSection = `
          <div class="drawer-section drawer-editorial-extra">
            ${draft.source_checked === true ? '<div class="drawer-section-title">已核对导读 <small>对照公开摘要核对</small></div>' : ''}
            ${draft.limitations ? `<details class="drawer-extra"><summary>证据边界</summary><p>${esc(draft.limitations)}</p></details>` : ''}
            ${draft.learning_question ? `<div class="clinical-question-box"><b>共读问题</b><p>${esc(draft.learning_question)}</p></div>` : ''}
          </div>
        `;
      }

      const authorBox = authorAffilHtml(paper);

      // Quantitative Metrics Grid
      let quantBox = '';
      const q = paper.quantitativeMetrics;
      if (q && (q.sampleSize || q.followUp || q.trialId || (q.effectSizes && q.effectSizes.length))) {
        quantBox = `
          <div class="quant-metrics-grid">
            ${q.sampleSize ? `
              <div class="quant-card">
                <span class="quant-label">样本规模</span>
                <span class="quant-value" style="color:var(--accent);">${esc(q.sampleSize)}</span>
              </div>
            ` : ''}
            ${q.followUp ? `
              <div class="quant-card">
                <span class="quant-label">随访周期</span>
                <span class="quant-value">${esc(q.followUp)}</span>
              </div>
            ` : ''}
            ${q.trialId ? `
              <div class="quant-card">
                <span class="quant-label">试验注册</span>
                <span class="quant-value"><a href="https://clinicaltrials.gov/study/${esc(q.trialId)}" target="_blank" rel="noopener">${esc(q.trialId)} ↗</a></span>
              </div>
            ` : ''}
            ${(q.effectSizes || []).map(eff => `
              <div class="quant-card">
                <span class="quant-label">效应量/显著性</span>
                <span class="quant-value" style="font-size:12px; color:var(--emerald);">${esc(eff)}</span>
              </div>
            `).join('')}
          </div>
        `;
      }

      // AI 速览 (daily batch, labelled unreviewed) + its stored public abstract
      const ql = quicklookOf(paper);
      const readerQlPending = partsPending('quicklooks', 'pregenerated');
      const readerQlFailed = !readerQlPending && DEFERRED && (PART_STATE.quicklooks === 'error' || PART_STATE.pregenerated === 'error');
      const readerPrePending = partsPending('pregenerated');
      const readerPreFailed = !readerPrePending && DEFERRED && PART_STATE.pregenerated === 'error';
      if (ql && ql.abstract && !paper.summary && !(paper.abstractSections && paper.abstractSections.length)) {
        paper.abstractSections = [{ label: '', text: ql.abstract }];
        forgetPaper(paper);
        paper._absFetched = true;
        if (!paper.pmid && ql.pmid) paper.pmid = ql.pmid;
      }
      // 公开摘要要去 Europe PMC 拉取时，先标成拉取中再渲染：速览和结构区在拉取期间显示「正在获取摘要…」，
      // 不抢跑写「暂无公开摘要」。拉取结束（含失败）后才按真实结果显示。
      absFetchPlanned = !paper.weeklyPick && partsReady('quicklooks', 'pregenerated') && !paper.summary && !(paper.abstractSections && paper.abstractSections.length) && !!(paper.doi || paper.pmid) && !paper._absTries;
      if (absFetchPlanned) { paper._absTries = 1; paper._absState = 'loading'; }
      const quickBox = (ql && !draft) ? `
        <div class="drawer-section quicklook">
          <div class="drawer-section-title">速览</div>
          ${ql.one_line && ql.one_line.trim() !== cardTakeaway(paper) ? `<p class="ql-line"><strong>${esc(ql.one_line)}</strong></p>` : ''}
          <p class="ql-meta"><span>${esc(prioritizedDesign(paper) || ql.design)}</span></p>
          <ul class="ql-findings">${ql.findings.map(f => `<li>${esc(f.text)}<blockquote>${esc(f.quote)}</blockquote></li>`).join('')}</ul>
          <p class="ql-meta"><b>局限：</b>${esc(ql.limits)}</p>
          <p class="ql-meta"><b>为什么值得看：</b>${esc(ql.why_read)}</p>
          <p class="text-muted" style="font-size:11.5px;">要点下方的英文为摘要原句，供你核对；如与原文不符，以原文为准。</p>
          ${(ql.abstractSource || ql.abstract_source) ? `<p class="text-muted" style="font-size:11.5px;">摘要来源：${esc(ql.abstractSource || ql.abstract_source)}${safeSourceUrl({url:ql.abstractSourceUrl || ql.source_url}) ? ` · <a href="${esc(safeSourceUrl({url:ql.abstractSourceUrl || ql.source_url}))}" target="_blank" rel="noopener">查看来源 ↗</a>` : ''}</p>` : ''}
        </div>` : '';
      const aiBox = (!ql && !draft) ? (() => {
        if (readerQlPending) {
          return '<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">速览</div><p class="ql-meta" role="status">加载中...</p></div>';
        }
        if (readerQlFailed) {
          const failed = ['pregenerated', 'quicklooks'].filter(n => PART_STATE[n] === 'error').join(',');
          return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">速览</div><p class="ql-meta" role="status">加载失败，请重试。<button type="button" class="btn-sm" data-action="retry-part" data-part="${failed}">重试</button></p></div>`;
        }
        if (paper.weeklyPick) return '';
        const s = paper._aiState;
        // Do not name this hasAbstract: openReaderDrawer later declares a local const hasAbstract (TDZ).
        const hasPubAbs = !!(paper.summary || (paper.abstractSections || []).some(sec => sec && sec.text) || (typeof quicklookOf === 'function' && quicklookOf(paper) && quicklookOf(paper).abstract));
        if (!hasPubAbs && paper._absState === 'loading') {
          return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">速览</div>
          <p class="ql-meta" role="status">正在获取摘要…</p></div>`;
        }
        if (!hasPubAbs && (s === 'none' || s === 'error' || s === 'noabs' || !s)) {
          return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">速览</div>
          ${s === 'error' ? `<p class="ql-meta" style="color:#b45309;">${esc(paper._aiMsg || '')}</p>` : ''}
          <p class="ql-meta">暂无公开摘要，无法生成 AI 速览。请查看官方原文。</p></div>`;
        }
        if (s === 'none' || s === 'error') return `<div class="drawer-section quicklook ai-ask">
          <div class="drawer-section-title">速览</div>
          ${s === 'error' ? `<p class="ql-meta" style="color:#b45309;">${esc(paper._aiMsg || '')}</p>` : ''}
          <p class="ql-meta">点击后由模型根据公开摘要生成 AI 速览；生成时间取决于公开来源和模型响应。生成后会保存在本站，之后所有读者可直接查看。</p>
          <button class="btn-sm btn-primary" data-action="ai-interpret" data-paper-id="${esc(paper.id)}">一键生成 AI 速览</button></div>`;
        if (s === 'noabs') return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">速览</div>
          <p class="ql-meta">本次已完成的公开来源查询未取得可用摘要，因此未生成 AI 速览。请查看官方原文；页面展示的摘要与服务本次可验证的来源可能不同。</p>
          ${!paper.titleZh ? `<button class="btn-sm" data-action="${['waiting','checking'].includes(paper._ttState) ? 'title-check' : 'ai-title'}" data-paper-id="${esc(paper.id)}"${['loading','checking'].includes(paper._ttState) ? ' disabled' : ''}>${['waiting','checking'].includes(paper._ttState) ? '读取已有标题译文' : '只翻译标题'}</button>` : ''}${paper._ttMsg ? `<span class="ql-meta" style="color:#b45309;"> ${esc(paper._ttMsg)}</span>` : ''}</div>`;
        if (s === 'waiting' || s === 'lookup-error') return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">速览</div><p class="ql-meta" role="status">${esc(paper._aiMsg || aiWaitingMessage())}</p><button class="btn-sm" data-action="ai-check" data-paper-id="${esc(paper.id)}">读取已有 AI 速览</button></div>`;
        if (s === 'checking') return '<div class="drawer-section quicklook ai-ask"><p class="ql-meta" role="status">正在读取已有 AI 速览…</p></div>';
        if (s === 'loading') return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">速览</div><p class="ql-meta">正在读取公开摘要并生成 AI 速览，请稍候…${paper._aiSlow ? '用时较长，无需重复点击。' : ''}</p></div>`;
        return '';
      })() : '';

      // Structured Abstract formatting
      let abstractHtml = '';
      if (paper.abstractSections && paper.abstractSections.length) {
        abstractHtml = paper.abstractSections.map(s => `
          <div class="abstract-section-block">
            ${s.label ? `<span class="abstract-section-label">${esc(s.label)}</span>` : ''}
            <p>${esc(s.text)}</p>
          </div>
        `).join('');
      } else if (paper.summary) {
        abstractHtml = `<p>${esc(paper.summary)}</p>`;
      } else if (readerQlPending) {
        abstractHtml = '<p class="text-muted" role="status">加载中...</p>';
      } else if (readerQlFailed && !paper.weeklyPick) {
        const failed = ['pregenerated', 'quicklooks'].filter(n => PART_STATE[n] === 'error').join(',');
        abstractHtml = `<p class="text-muted" role="status">摘要数据加载失败 <button type="button" class="btn-sm" data-action="retry-part" data-part="${failed}">重试</button></p>`;
      } else if (paper.weeklyPick) {
        abstractHtml = '<p class="text-muted">公开摘要尚未准备好，请查看官方原文。</p>';
      } else if (paper._absState === 'loading') {
        abstractHtml = '<p class="text-muted">正在从 Europe PMC 获取公开摘要…</p>';
      } else if (paper._absState === 'error') {
        abstractHtml = '<p class="text-muted">获取公开摘要失败（网络或 Europe PMC 暂不可用），请稍后重开，或前往官方原文。</p>';
      } else {
        abstractHtml = '<p class="text-muted">公开数据库（Europe PMC / PubMed）暂未收录该文摘要，可能是述评、社论或刚上线的文章。请前往官方原文查看。</p>';
      }
      const absSource = (paper.abstractSections && paper.abstractSections.length && paper._absFetched)
        ? '<p class="text-muted" style="font-size:11.5px;margin-top:8px;">摘要来自 Europe PMC / PubMed 公开数据，版权归原出版商；此处未做 AI 加工。</p>' : '';
      const hasAbstract = !!(paper.summary || (paper.abstractSections && paper.abstractSections.length));

      // Citation helpers (built from real fields only; no invented authors)
      const cites = buildCitations(paper);
      const citationSection = `
        <div class="drawer-section cite-section">
          <div class="citation-actions-bar">
            <details class="cite-menu"><summary class="btn-cite">复制引用</summary>
              <div class="cite-menu-list">
                <button type="button" class="btn-cite copy-cite-btn" data-cite="${esc(cites.gb)}">GB/T 7714</button>
                <button type="button" class="btn-cite copy-cite-btn" data-cite="${esc(cites.ama)}">AMA</button>
                <button type="button" class="btn-cite copy-cite-btn" data-cite="${esc(cites.bibtex)}">BibTeX</button>
              </div>
            </details>
            ${paper.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(paper.pmid)}/" target="_blank" rel="noopener" class="btn-cite" style="text-decoration:none;">PubMed ↗</a>` : ''}
          </div>
          ${paper.authors && paper.authors.length ? '' : '<p class="text-muted" style="font-size:11.5px;margin-top:6px;">未抓取到作者信息，引用不含作者，使用前请对照原文补全。</p>'}
        </div>
      `;

      const tagsHtml = (paper.tags || []).map(t => `<span class="tag-chip active">${esc(t)}</span>`).join('');

      const zhTitle = (draft && draft.title_zh) || (ql && ql.title_zh) || paper.titleZh || '';
      const takeaway = cardTakeaway(paper);
      const head = `
        ${publicationStatusHtml(paper)}
        ${paper.media && paper.media.length ? `<div class="drawer-media">${paper.media.slice(0, 2).map(m => `<a class="media-pill" href="${esc(m.u)}" target="_blank" rel="noopener noreferrer" title="${esc(m.t)}">媒体关注 · ${esc(m.s)}</a>`).join('')}</div>` : ''}

        <h2 class="drawer-title-en">${esc(paper.title)}</h2>
        ${zhTitle ? `<div class="drawer-title-zh">${esc(zhTitle)}</div>` : ''}
        ${takeaway ? `<p class="drawer-takeaway">${esc(takeaway)}</p>` : ''}
        ${journalMetricDetails(paper).replace(/<summary>[^<]*<\/summary>/, '<summary>指标来源与核对说明</summary>')}
      `;
      const tr = LIVE_TR[trKeyOf(paper)];
      const zhAbs = (hasAbstract && validTranslation(tr)) ? tr.abstract_zh.split(/\n+/).map(s => `<p>${esc(s)}</p>`).join('') : '';
      const translationReady = !!(hasAbstract && zhAbs);
      const trDeferredNote = (hasAbstract && !translationReady && (paper.pmid || paper.doi) && readerPrePending)
        ? '<p class="ql-meta drawer-deferred-status" role="status">加载中...</p>'
        : (hasAbstract && !translationReady && (paper.pmid || paper.doi) && readerPreFailed)
          ? '<p class="ql-meta drawer-deferred-status" role="status">中文摘要加载失败 <button type="button" class="btn-sm" data-action="retry-part" data-part="pregenerated">重试</button></p>'
          : '';
      const abstractSection = `
        <section class="drawer-section abstract-reader" aria-label="摘要">
          <div class="drawer-section-title">摘要</div>
          ${translationReady ? `
            <div class="abs-tabs" role="tablist" aria-label="摘要语言">
              <button type="button" class="abs-tab is-active" role="tab" data-abs-tab="zh" aria-selected="true">中文</button>
              <button type="button" class="abs-tab" role="tab" data-abs-tab="en" aria-selected="false">原文</button>
            </div>
            <div class="abs-panel" data-abs-panel="zh" role="tabpanel">${zhAbs}</div>
            <div class="abs-panel" data-abs-panel="en" role="tabpanel" hidden lang="en"><div class="structured-abstract">${abstractHtml}</div></div>
          ` : `${trDeferredNote}<div class="structured-abstract">${abstractHtml}</div>`}
          ${abstractMayBeIncomplete(paper) ? '<p class="abs-incomplete-note">摘要可能不完整</p>' : ''}
          ${absSource}
        </section>
        ${quantBox ? `<details class="metric-details"><summary>摘要自动提取的数字</summary>${quantBox}</details>` : ''}
        ${authorBox}
        ${tagsHtml ? `<div class="drawer-tags">${tagsHtml}</div>` : ''}
      `;
      // 口令框正在输入时整块重画：搬动 DOM 会让输入框失焦，重画后原样还给它（光标位置也保留）。
      var typingEl = document.activeElement && document.activeElement.matches && document.activeElement.matches('#drawerFulltext input[name="passphrase"]') ? document.activeElement : null;
      var typingSel = typingEl ? [typingEl.selectionStart, typingEl.selectionEnd] : null;
      const ftSection = $('#drawerFulltext');
      const pdfLinkEl = $('#drawerPdfLink');
      const pdfFormEl = $('#drawerPdfForm');
      const ftRegion = bodyEl.querySelector('[data-drawer-region="fulltext"]');
      const keepFtMounted = !changedPaper && bodyEl.dataset.paperId === String(paper.id) && !!(ftRegion && ftSection && ftSection.parentElement === ftRegion);
      if (!keepFtMounted) ftSection.remove();
      renderDrawerRegions(bodyEl, paper, changedPaper, [['head', head], ['abstract', abstractSection], ['fulltext', ''], ['editorial', editorialSection],
        ['ai', quickBox + aiBox], ['study', studyBoxHtml(paper)], ['cite', citationSection]]);
      if (!keepFtMounted) bodyEl.querySelector('[data-drawer-region="fulltext"]').appendChild(ftSection);
      const ftHtml = fulltextStatusHtml(paper, true, true);
      const ftStatus = ftSection.querySelector('[data-drawer-ft-status]');
      if (ftStatus && ftStatus.dataset.ftHtml !== ftHtml) {
        // 先把挂载在状态块里的持久节点挪回 #drawerFulltext，避免被 innerHTML 覆盖销毁。
        if (pdfLinkEl && pdfLinkEl.parentElement !== ftSection) ftSection.appendChild(pdfLinkEl);
        if (pdfFormEl && pdfFormEl.parentElement !== ftSection) ftSection.appendChild(pdfFormEl);
        ftStatus.innerHTML = ftHtml;
        ftStatus.dataset.ftHtml = ftHtml;
      }
    }

    // Footer buttons: ☆, 官网, 微信群文案。下载 PDF 留在 #drawerFulltext 固定下载区。
    const huddleBtn = $('#drawerHuddleToggleBtn');
    if (huddleBtn) {
      huddleBtn.innerHTML = huddleStarSvg(isHuddled);
      huddleBtn.className = `card-icon-btn card-star${isHuddled ? ' active' : ''}`;
      huddleBtn.setAttribute('aria-pressed', String(!!isHuddled));
      huddleBtn.setAttribute('aria-label', isHuddled ? '移出精选' : '加入精选');
      huddleBtn.title = isHuddled ? '已精选，点击移出' : '加入精选';
    }

    const shareBtn = $('#drawerCopyShareBtn');
    if (shareBtn) shareBtn.hidden = !paper.hasDraft;
    const extLink = $('#drawerExternalLink');
    if (extLink) {
      extLink.href = doiUrl; extLink.hidden=doiUrl==='#';
    }
    const institutionLink = $('#drawerInstitutionLink');
    if (institutionLink) {
      const institutionUrl = MAINTAINER ? hamburgFulltextUrl(paper.doi) : '';
      institutionLink.href = institutionUrl || '#'; institutionLink.hidden = !institutionUrl;
    }
    const institutionLogin = $('#drawerInstitutionLoginLink');
    if (institutionLogin) institutionLogin.hidden = !MAINTAINER;
    const ftSectionNow = $('#drawerFulltext');
    const pdfLink = $('#drawerPdfLink');
    const pdfForm = $('#drawerPdfForm');
    if (pdfLink) {
      const pdfUrl = pdfDownloadUrl(paper);
      pdfLink.href = pdfUrl || '#'; pdfLink.hidden = !pdfUrl;
      // 口令框跟着下载链接走：换了一篇，或同篇确已无可用下载链接且口令框正展开时才收起并清空口令。
      if (changedPaper || (!pdfUrl && pdfForm && !pdfForm.hidden && partsReady('library'))) resetDlForm(pdfForm);
      if (ftSectionNow) {
        const primarySlot = pdfUrl ? ftSectionNow.querySelector('[data-drawer-ft-primary]') : null;
        const formSlot = pdfUrl ? ftSectionNow.querySelector('[data-drawer-ft-form-slot]') : null;
        const linkTarget = primarySlot || ftSectionNow;
        const formTarget = formSlot || ftSectionNow;
        if (pdfLink.parentElement !== linkTarget) linkTarget.appendChild(pdfLink);
        if (pdfForm && pdfForm.parentElement !== formTarget) formTarget.appendChild(pdfForm);
      }
    }

    if (typeof typingEl !== 'undefined' && typingEl && typingEl.isConnected && !typingEl.disabled && !typingEl.closest('[hidden]')) {
      try { typingEl.focus({ preventScroll: true }); if (typingSel && typingSel[0] !== null) typingEl.setSelectionRange(typingSel[0], typingSel[1]); } catch (e) { /* ignore */ }
    }
    if (!drawer.classList.contains('open')) { lastFocus = document.activeElement; pushOverlay('drawer'); }
    drawer.classList.add('open');
    backdrop.classList.add('open');
    if (bodyEl) bodyEl.scrollTop = changedPaper ? 0 : prevScrollTop;
    if (changedPaper || (lastFocus && !drawer.contains(document.activeElement))) $('#drawerCloseBtn')?.focus({ preventScroll: true });
    document.body.classList.add('dialog-open');
    drawer.setAttribute('aria-hidden','false');

    if (!paper.weeklyPick) {
      if (!paper.hasDraft && !quicklookOf(paper) && partsReady('quicklooks', 'pregenerated')) aiApiCheck(paper);
      if (partsReady('pregenerated')) {
        trCheck(paper);
        studyCheck(paper);
      }
    }

    // No abstract in our data? Fetch the public one from Europe PMC (free, no API key).
    if (absFetchPlanned) {
      fetchPublicAbstract(paper).then(res => {
        if (res && res.sections.length) {
          paper.abstractSections = res.sections;
          paper._absFetched = true;
          paper._absState = 'ok';
          if (!paper.authors || !paper.authors.length) paper.authors = res.authors;
          if ((!paper.affiliations || !paper.affiliations.length) && res.affiliation) paper.affiliations = [res.affiliation];
          if (!paper.pmid && res.pmid) paper.pmid = res.pmid;
          forgetPaper(paper);
        } else {
          paper._absState = 'none';
        }
      }).catch(() => { paper._absState = 'error'; }).then(() => {
        if (state.activeDrawerPaper === paper) openBodyOnly(paper);
      });
    }
  }

  // AI lookups finish one by one and each rerenders the drawer. Replacing only the region whose
  // markup changed keeps the reader's open <details>, text selection and focus everywhere else.
  let drawerRegionHtml = {};
  function renderDrawerRegions(bodyEl, paper, changedPaper, regions) {
    const fresh = changedPaper || bodyEl.dataset.paperId !== String(paper.id) || !bodyEl.querySelector('[data-drawer-region]');
    if (fresh) {
      bodyEl.innerHTML = regions.map(([key, html]) => `<div class="drawer-region" data-drawer-region="${key}">${html}</div>`).join('');
      bodyEl.dataset.paperId = String(paper.id);
      drawerRegionHtml = Object.fromEntries(regions);
      return;
    }
    regions.forEach(([key, html]) => {
      if (drawerRegionHtml[key] === html) return;
      const el = bodyEl.querySelector(`[data-drawer-region="${key}"]`);
      if (!el) return;
      const open = new Set([...el.querySelectorAll('details[open] > summary')].map(x => x.textContent));
      const active = el.contains(document.activeElement) ? document.activeElement.closest('[data-action]') : null;
      const focus = active && { action: active.dataset.action, id: active.dataset.paperId };
      el.innerHTML = html;
      el.querySelectorAll('details > summary').forEach(x => { if (open.has(x.textContent)) x.parentElement.open = true; });
      if (focus) [...el.querySelectorAll('[data-action]')].find(x => x.dataset.action === focus.action && x.dataset.paperId === focus.id && !x.disabled)?.focus({ preventScroll: true });
      drawerRegionHtml[key] = html;
    });
  }

  function openBodyOnly(paper) {
    if (state.activeDrawerPaper === paper) openReaderDrawer(paper);
  }

  // ---- Public abstracts from Europe PMC (free, CORS-enabled, no key) ----
  const absMemo = new Map();
  function parseAbstractHtml(html) {
    if (!html) return [];
    const parts = String(html).split(/<h4[^>]*>(.*?)<\/h4>/i);
    const txt = h => (new DOMParser().parseFromString(h, 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim();
    const out = [];
    if (parts[0] && txt(parts[0])) out.push({ label: '', text: txt(parts[0]) });
    for (let i = 1; i < parts.length; i += 2) {
      const text = txt(parts[i + 1] || '');
      if (text) out.push({ label: txt(parts[i]), text });
    }
    return out;
  }
  async function fetchPublicAbstract(p) {
    const key = (p.doi || 'pmid:' + p.pmid).toLowerCase();
    if (absMemo.has(key)) return absMemo.get(key);
    try {
      const c = JSON.parse(safeGet('xz_abs_' + key) || 'null');
      if (c && c.sections && c.sections.length) { absMemo.set(key, c); return c; }
    } catch (e) { /* ignore */ }
    const q = p.doi ? 'DOI:"' + p.doi + '"' : 'EXT_ID:' + p.pmid + ' AND SRC:MED';
    const r = await fetch('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=1&query=' + encodeURIComponent(q));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const it = j && j.resultList && j.resultList.result && j.resultList.result[0];
    const res = {
      sections: it ? parseAbstractHtml(it.abstractText) : [],
      authors: it && it.authorString ? it.authorString.replace(/\.$/, '').split(/,\s*/).filter(Boolean) : [],
      affiliation: it && it.affiliation ? it.affiliation : '',
      pmid: it && it.pmid ? it.pmid : ''
    };
    if (res.sections.length) absMemo.set(key, res);
    if (res.sections.length) safeSet('xz_abs_' + key, JSON.stringify(res));
    return res;
  }

  function closeReaderDrawer({ fromHistory = false } = {}) {
    if (!$('#readerDrawer.open')) return;
    if (!fromHistory && popOverlay('drawer')) return;
    OVERLAY_PUSHED.delete('drawer');
    if (state.activeDrawerPaper && state.activeDrawerPaper._absState === 'error') { state.activeDrawerPaper._absTries = 0; state.activeDrawerPaper._absState = ''; }
    state.activeDrawerPaper = null;
    const drawer = $('#readerDrawer');
    const backdrop = $('#drawerBackdrop');
    if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); }
    document.body.classList.remove('dialog-open');
    if (backdrop) backdrop.classList.remove('open');
    let restoreFocus = lastFocus;
    // Same-paper actions can rerender the list and replace the original opener.
    if (restoreFocus && !restoreFocus.isConnected && restoreFocus.dataset?.paperId) {
      const paperId = restoreFocus.dataset.paperId;
      restoreFocus = [...document.querySelectorAll('[data-action="open-drawer"]')]
        .find(el => el.dataset.paperId === paperId && el.getClientRects().length) || null;
    }
    if (restoreFocus && restoreFocus.focus) { try { restoreFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    lastFocus = null;
  }

