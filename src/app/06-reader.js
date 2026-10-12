  // ==== src/app/06-reader.js · Reading drawer and public abstracts ====
  // Slide-over Reader Drawer Open/Close
  function openReaderDrawer(paper) {
    const changedPaper = !state.activeDrawerPaper || state.activeDrawerPaper.id !== paper.id;
    hydratePreGenerated(paper);
    state.activeDrawerPaper = paper;
    const drawer = $('#readerDrawer');
    const backdrop = $('#drawerBackdrop');
    if (!drawer || !backdrop) return;

    const pubClass = getPublisherClass(paper.publisher);
    const designClass = getDesignClass(paper.studyDesign);
    const journalName = paper.cleanJournal || paper.journal || '期刊';
    const dateStr = dateLabel(paper);
    const doiUrl = safeSourceUrl(paper) || '#';
    const isHuddled = state.huddle.includes(paper.id);

    // Header Badges
    const headerBadges = $('#drawerJournalBadges');
    if (headerBadges) {
      headerBadges.innerHTML = `
        <span class="journal-badge ${pubClass}">${esc(journalName)}</span>
        ${journalMetricBadge(paper)}
        ${designBadgeHtml(paper)}
        <span class="date-badge">${esc(dateStr)}</span>
      `;
    }

    // Body
    const bodyEl = $('#drawerBody');
    if (bodyEl) {
      const draft = paper.draftData;

      let editorialSection = '';
      if (draft) {
        editorialSection = `
          <div class="drawer-section">
            <div class="drawer-section-title">中文核心导读 (AI 辅助核对)</div>
            <div class="editorial-box">
              <p>${esc(draft.summary)}</p>
              ${draft.limitations ? `<p style="margin-top:8px; font-size:12px; color:var(--rose);"><b>证据边界：</b>${esc(draft.limitations)}</p>` : ''}
            </div>
            ${draft.learning_question ? `
              <div class="clinical-question-box">
                <b>共读问题：</b>
                <p>${esc(draft.learning_question)}</p>
              </div>
            ` : ''}
          </div>
        `;
      }

      // Authors & Affiliations Box
      let authorBox = '';
      if (paper.authors && paper.authors.length) {
        authorBox = `
          <div class="drawer-authors-box">
            <div class="drawer-authors-line">
              <span style="color:var(--text-muted); font-size:11.5px;">研究团队：</span>
              <span>${esc(paper.authors.slice(0, 5).join(', '))}${paper.authors.length > 5 ? ' 等' : ''}</span>
            </div>
            ${paper.affiliations && paper.affiliations.length ? `
              <div class="drawer-affiliations-line">
                <span style="color:var(--text-muted);">收录机构：</span>${esc(paper.affiliations[0])}
              </div>
            ` : ''}
          </div>
        `;
      }

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
      const editorialQuicklook = ql === preGeneratedOf(paper)?.quicklook && preGeneratedOf(paper)?.meta?.generationMeta?.quicklook?.origin === 'sol-session-public-abstract';
      if (ql && ql.abstract && !paper.summary && !(paper.abstractSections && paper.abstractSections.length)) {
        paper.abstractSections = [{ label: '', text: ql.abstract }];
        forgetPaper(paper);
        paper._absFetched = true;
        if (!paper.pmid && ql.pmid) paper.pmid = ql.pmid;
      }
      const quickBox = (ql && !draft) ? `
        <div class="drawer-section quicklook">
          <div class="drawer-section-title">AI 速览 <small class="ql-flag">${editorialQuicklook ? 'Sol 会话根据公开摘要整理 · 未经人工医学终审' : '模型根据公开摘要生成 · 未经人工核对'}</small></div>
          <p class="ql-line"><strong>${esc(ql.one_line)}</strong></p>
          <p class="ql-meta"><span>${esc(prioritizedDesign(paper) || ql.design)}</span></p>
          <ul class="ql-findings">${ql.findings.map(f => `<li>${esc(f.text)}<blockquote>${esc(f.quote)}</blockquote></li>`).join('')}</ul>
          <p class="ql-meta"><b>局限：</b>${esc(ql.limits)}</p>
          <p class="ql-meta"><b>为什么值得看：</b>${esc(ql.why_read)}</p>
          <p class="text-muted" style="font-size:11.5px;">要点下方的英文为摘要原句，供你核对；如与原文不符，以原文为准。</p>
          ${(ql.abstractSource || ql.abstract_source) ? `<p class="text-muted" style="font-size:11.5px;">摘要来源：${esc(ql.abstractSource || ql.abstract_source)}${safeSourceUrl({url:ql.abstractSourceUrl || ql.source_url}) ? ` · <a href="${esc(safeSourceUrl({url:ql.abstractSourceUrl || ql.source_url}))}" target="_blank" rel="noopener">查看来源 ↗</a>` : ''}</p>` : ''}
        </div>` : '';
      const aiBox = (!ql && !draft) ? (() => {
        if (paper.weeklyPick) return '';
        const s = paper._aiState;
        if (s === 'none' || s === 'error') return `<div class="drawer-section quicklook ai-ask">
          <div class="drawer-section-title">AI 解读</div>
          ${s === 'error' ? `<p class="ql-meta" style="color:#b45309;">${esc(paper._aiMsg || '')}</p>` : ''}
          <p class="ql-meta">点击后由模型根据公开摘要生成中文解读；生成时间取决于公开来源和模型响应。生成后会保存在本站，之后所有读者可直接查看；内容未经人工核对。</p>
          <button class="btn-sm btn-primary" data-action="ai-interpret" data-paper-id="${esc(paper.id)}">一键 AI 解读</button></div>`;
        if (s === 'noabs') return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">AI 解读</div>
          <p class="ql-meta">本次已完成的公开来源查询未取得可用摘要，因此未生成解读。请查看官方原文；页面展示的摘要与服务本次可验证的来源可能不同。</p>
          ${!paper.titleZh ? `<button class="btn-sm" data-action="${['waiting','checking'].includes(paper._ttState) ? 'title-check' : 'ai-title'}" data-paper-id="${esc(paper.id)}"${['loading','checking'].includes(paper._ttState) ? ' disabled' : ''}>${['waiting','checking'].includes(paper._ttState) ? '读取已有标题译文' : '只翻译标题'}</button>` : ''}${paper._ttMsg ? `<span class="ql-meta" style="color:#b45309;"> ${esc(paper._ttMsg)}</span>` : ''}</div>`;
        if (s === 'waiting' || s === 'lookup-error') return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">AI 解读</div><p class="ql-meta" role="status">${esc(paper._aiMsg || aiWaitingMessage())}</p><button class="btn-sm" data-action="ai-check" data-paper-id="${esc(paper.id)}">读取已有解读</button></div>`;
        if (s === 'checking') return '<div class="drawer-section quicklook ai-ask"><p class="ql-meta" role="status">正在读取已有解读…</p></div>';
        if (s === 'loading') return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">AI 解读</div><p class="ql-meta">正在读取公开摘要并生成解读，请稍候…${paper._aiSlow ? '用时较长，无需重复点击。' : ''}</p></div>`;
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
      const translationReady = hasAbstract && validTranslation(LIVE_TR[trKeyOf(paper)]);
      const translationHtml = hasAbstract ? `<div class="abstract-translation" lang="zh-CN"><h3 class="abstract-column-title" tabindex="-1">${translationReady ? '中文译文' : '中文译文状态'}</h3>${trBoxHtml(paper)}</div>` : '';

      // Citation helpers (built from real fields only; no invented authors)
      const cites = buildCitations(paper);
      const citationSection = `
        <div class="drawer-section" style="border-top:1px dashed var(--border); padding-top:16px;">
          <div class="drawer-section-title">题录引用草稿与原文入口</div>
          <div class="citation-actions-bar">
            <button class="btn-cite copy-cite-btn" data-cite="${esc(cites.gb)}">复制 GB/T 引用草稿</button>
            <button class="btn-cite copy-cite-btn" data-cite="${esc(cites.ama)}">复制 AMA 引用草稿</button>
            <button class="btn-cite copy-cite-btn" data-cite="${esc(cites.bibtex)}">复制 BibTeX 题录</button>
            ${paper.doi ? `<a href="https://doi.org/${esc(paper.doi)}" target="_blank" rel="noopener" class="btn-cite" style="text-decoration:none;">DOI ↗</a>` : ''}
            ${paper.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(paper.pmid)}/" target="_blank" rel="noopener" class="btn-cite" style="text-decoration:none;">PubMed ↗</a>` : ''}
          </div>
          ${paper.authors && paper.authors.length ? '' : '<p class="text-muted" style="font-size:11.5px;margin-top:6px;">本条目未抓取到作者信息，引用文本不含作者，使用前请对照原文补全。</p>'}
        </div>
      `;

      const tagsHtml = (paper.tags || []).map(t => `<span class="tag-chip active">${esc(t)}</span>`).join('');

      const head = `
        ${publicationStatusHtml(paper)}
        <div class="drawer-meta-line">
          <span style="font-size:12px; color:var(--text-muted);">${esc(paper.publisher || '')} · ${esc(paper.clinicalTier || '')}</span>
          ${paper.doi ? `<span class="doi-link" style="margin-left:auto;">DOI: ${esc(paper.doi)}</span>` : ''}
        </div>

        ${!draft && ql?.title_zh ? `<div class="drawer-title-zh"><small class="content-label">机器翻译</small>${esc(ql.title_zh)}</div>` : ''}
        ${!draft && !ql?.title_zh && paper.titleZh ? `<div class="drawer-title-zh"><small class="content-label">机器翻译</small>${esc(paper.titleZh)}</div>` : ''}
        ${draft?.title_zh ? `<div class="drawer-title-zh">${esc(draft.title_zh)}</div>` : ''}
        <h2 class="drawer-title-en">${esc(paper.title)}</h2>

        ${journalMetricDetails(paper)}

        ${authorBox}

        ${tagsHtml ? `<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px;">${tagsHtml}</div>` : ''}

        ${quantBox ? `<details class="metric-details"><summary>摘要自动提取的数字（请对照下方原文核验）</summary>${quantBox}</details>` : ''}
      `;
      const abstractSection = `
        <section class="drawer-section abstract-reader" aria-label="公开摘要阅读">
          <div class="drawer-section-title">公开摘要 <small class="abstract-translation-status" role="status">${hasAbstract ? abstractTranslationStatus(paper) : '原文'}</small></div>
          ${hasAbstract ? `<nav class="abstract-jump-nav" aria-label="摘要阅读位置"><button type="button" class="btn-sm" data-action="abstract-jump" data-column="original">原始摘要</button><button type="button" class="btn-sm" data-action="abstract-jump" data-column="translation">${validTranslation(LIVE_TR[trKeyOf(paper)]) ? '中文译文' : '译文状态'}</button></nav>` : ''}
          <div class="abstract-columns${!hasAbstract ? ' abstract-only' : translationReady ? ' abstract-paired' : ' abstract-pending'}">
            ${!translationReady ? translationHtml : ''}
            <div class="abstract-original" lang="en"><h3 class="abstract-column-title" tabindex="-1">英文原文</h3><div class="structured-abstract">${abstractHtml}</div></div>
            ${translationReady ? translationHtml : ''}
          </div>
          ${absSource}
        </section>
      `;
      renderDrawerRegions(bodyEl, paper, changedPaper, [['head', head], ['editorial', editorialSection], ['abstract', abstractSection],
        ['ai', quickBox + aiBox], ['study', studyBoxHtml(paper)], ['cite', citationSection]]);
    }

    // Footer buttons
    const huddleBtn = $('#drawerHuddleToggleBtn');
    if (huddleBtn) {
      huddleBtn.textContent = isHuddled ? '已在精选清单 ✓' : '加入精选清单';
      huddleBtn.className = `btn-sm ${isHuddled ? 'active' : ''}`;
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
    const pdfLink = $('#drawerPdfLink');
    if (pdfLink) {
      const pdfUrl = pdfDownloadUrl(paper);
      pdfLink.href = pdfUrl || '#'; pdfLink.hidden = !pdfUrl;
    }

    if (!drawer.classList.contains('open')) { lastFocus = document.activeElement; pushOverlay('drawer'); }
    drawer.classList.add('open');
    backdrop.classList.add('open');
    if (changedPaper && bodyEl) bodyEl.scrollTop = 0;
    if (changedPaper || (lastFocus && !drawer.contains(document.activeElement))) $('#drawerCloseBtn')?.focus({ preventScroll: true });
    document.body.classList.add('dialog-open');
    drawer.setAttribute('aria-hidden','false');

    if (!paper.weeklyPick) {
      if (!paper.hasDraft && !quicklookOf(paper)) aiApiCheck(paper);
      trCheck(paper);
      studyCheck(paper);
    }

    // No abstract in our data? Fetch the public one from Europe PMC (free, no API key).
    const needsAbs = !paper.weeklyPick && !paper.summary && !(paper.abstractSections && paper.abstractSections.length) && (paper.doi || paper.pmid) && !paper._absTries;
    if (needsAbs) {
      paper._absTries = 1;
      paper._absState = 'loading';
      openBodyOnly(paper);
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

