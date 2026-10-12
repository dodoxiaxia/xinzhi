  // ==== src/app/09-weekly.js · 近7天榜 board and full-text reading panel ====
  let deepReadingHistoryLimit = 12;
  // var: syncUrl reads this before the weekly code below has run.
  var activeDeepReadingId = '';
  const DEMO_READING_ID = 'demo-tailored-af';
  const DEEP_READING_LABELS = { question: '研究问题', design: '设计与人群', findings: '主要结果', limitations: '局限与不确定性', practice: '临床讨论' };
  function dailyReadingGroups(data, today = beijingToday()) {
    const rows = (Array.isArray(data?.items) ? data.items : []).filter(p => p.scope === 'public-fulltext-body' && p.humanReviewed === false && /^\d{4}-\d{2}-\d{2}$/.test(p.publishedOn || '') && p.publishedOn <= today);
    rows.sort((a, b) => b.publishedOn.localeCompare(a.publishedOn) || (b.generatedAt || '').localeCompare(a.generatedAt || ''));
    const latestDay = rows[0]?.publishedOn || '';
    return { todayCount: rows.filter(p => p.publishedOn === today).length, latestDay, latest: rows.filter(p => p.publishedOn === latestDay), history: rows.filter(p => p.publishedOn !== latestDay) };
  }
  // Newest first; this is also the order of 上一篇 / 下一篇 in the reading panel.
  function dailyReadingList(data = window.DEEP_READINGS || {}) {
    const groups = dailyReadingGroups(data);
    return groups.latest.concat(groups.history);
  }
  // The rail is an index only: each entry opens the reading in #deepReader.
  function dailyReadingItem(p) {
    const active = p.pmcid === activeDeepReadingId, topic = p.whySelected || p.topic;
    return '<button type="button" class="deep-reading-item' + (active ? ' active' : '') + '" data-action="open-deep-reading" data-reading-id="' + esc(p.pmcid) + '" data-deep-reading="' + esc(p.pmcid) + '"' + (active ? ' aria-current="true"' : '') + '><span class="deep-reading-item-title">' + esc(p.titleZh || p.title) + '</span><small>' + esc(p.journal) + ' · 论文 ' + esc(p.date) + '</small>' + (topic ? '<span class="deep-reading-topic">' + esc(topic) + '</span>' : '') + '<span class="deep-reading-go">读精读 →</span></button>';
  }
  function deepReadingBody(p) {
    const sections = Object.entries(DEEP_READING_LABELS).map(([key, label]) => {
      const block = p.sections?.[key]; if (!block || typeof block.text !== 'string') return '';
      const quotes = Array.isArray(block.evidence) ? block.evidence : [];
      const evidence = quotes.map(e => '<blockquote><p>' + esc(e.quote || '') + '</p><cite>正文 · ' + esc(e.section || e.paragraph || '') + '</cite></blockquote>').join('');
      return '<section class="deep-reading-section" id="dr-' + key + '" data-toc="' + esc(label) + '"><h3>' + esc(label) + '</h3><p>' + esc(block.text) + '</p>' + (quotes.length ? '<details class="deep-reading-evidence"><summary>查看原文证据 · ' + quotes.length + ' 处</summary>' + evidence + '</details>' : '') + '</section>';
    }).join('');
    return '<p class="deep-reading-original">' + esc(p.title) + '</p><p class="deep-reading-scope">基于开放全文正文，未核对补充材料；模型生成，未经医生终审。</p>' + sections;
  }
  function deepReadingLinks(p) {
    const source = /^PMC\d+$/.test(p.pmcid || '') ? 'https://europepmc.org/articles/' + p.pmcid : '';
    return (source ? '<a class="btn-sm" href="' + esc(source) + '" target="_blank" rel="noopener noreferrer">开放全文 ↗</a>' : '') + (p.doi ? '<a class="btn-sm" href="' + esc('https://doi.org/' + p.doi) + '" target="_blank" rel="noopener noreferrer">出版商原文 ↗</a>' : '');
  }
  function renderDailyDeepRead() {
    const el = $('#dailyDeepRead'); if (!el) return;
    const data = window.DEEP_READINGS || {}, status = data.status || {}, groups = dailyReadingGroups(data);
    const historyOpen = !!el.querySelector('.deep-reading-history[open]');
    const reason = {
      model_not_configured: '精读生成服务尚未就绪', model_unavailable: '精读生成服务暂时不可用',
      model_output_incomplete: '生成未完整完成', discovery_unavailable: '全文来源暂时不可用',
      validation_or_fulltext_shortfall: '可读全文或证据核对不足', time_budget: '本次更新未完整完成',
      prior_attempt_uncertain: '上次生成结果待核对', provider_failed_today: '精读生成服务暂时不可用',
      durable_checkpoint_required: '自动更新尚未就绪', checkpoint_not_configured: '自动更新尚未就绪',
      checkpoint_write_failed: '更新保存未完成'
    }[status.reason] || '本次更新未完成';
    const showReason = status.day === beijingToday() && status.reason && groups.todayCount < 3;
    const notStarted = !groups.todayCount && status.day && status.day < beijingToday();
    const days = [];
    groups.history.slice(0, deepReadingHistoryLimit).forEach(p => {
      let day = days[days.length - 1];
      if (!day || day.day !== p.publishedOn) days.push(day = { day: p.publishedOn, items: [] });
      day.items.push(p);
    });
    el.innerHTML = '<p class="deep-reading-label"><span class="content-label">AI 全文精读 · 未经人工审核</span></p><p class="deep-reading-status" role="status">今日已更新 <b>' + groups.todayCount + '</b> 篇 · 每天目标 3–5 篇</p><p class="deep-reading-timing">北京时间 04:47 计划启动' + (data.updatedAt ? ' · 最近更新 ' + esc(contentDate(data.updatedAt)) : '') + '</p>' +
      (showReason ? '<p class="deep-reading-shortfall">' + esc(reason) + '，当前完成 ' + groups.todayCount + ' 篇。</p>' : '') +
      (notStarted ? '<p class="deep-reading-shortfall">今天的批次尚未生成（GitHub 定时任务常延迟数小时）；下方为最近一次批次。</p>' : '') +
      (groups.latest.length ? '<h4 class="deep-reading-batch">最新批次 · ' + esc(groups.latestDay) + ' <span>' + groups.latest.length + ' 篇</span></h4><div class="deep-reading-list">' + groups.latest.map(dailyReadingItem).join('') + '</div>' : '<p class="deep-reading-empty">今天的全文精读尚未完成；完成后会自动显示在这里。</p>') +
      (groups.history.length ? '<details class="deep-reading-history"' + (historyOpen ? ' open' : '') + '><summary>往期精读 · ' + groups.history.length + ' 篇</summary>' + days.map(d => '<h5 class="deep-reading-day">' + esc(d.day) + ' <span>' + d.items.length + ' 篇</span></h5><div class="deep-reading-list">' + d.items.map(dailyReadingItem).join('') + '</div>').join('') + (groups.history.length > deepReadingHistoryLimit ? '<button class="btn-sm" type="button" data-action="more-daily-readings">查看更多往期精读</button>' : '') + '</details>' : '');
    const count = $('#weeklyPaneReadingCount'); if (count) count.textContent = groups.latest.length || '';
  }

  function renderWeeklyHeader() {
    renderStaticJournalMetrics();
    renderWeeklyAuto();
    renderDailyDeepRead();
    renderWeeklyPane();
    // The example reading is listed only here: fetch it now so opening it is instant.
    loadDemoReading().catch(() => {});
  }

  // Narrow screens show one pane at a time; wide screens show both and ignore it.
  function renderWeeklyPane() {
    const section = $('#weeklySection'); if (!section) return;
    section.dataset.pane = state.weeklyPane;
    $$('[data-weekly-pane]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.weeklyPane === state.weeklyPane)));
  }

  // Full-text readings open in their own panel, so the close button, the section
  // list and 上一篇 / 下一篇 stay on screen however long the reading is.
  var deepReaderFocus = null;
  function deepReaderUrl(id) {
    const u = new URL(window.location.href);
    if (id) u.searchParams.set('read', id); else u.searchParams.delete('read');
    return u.pathname + u.search + u.hash;
  }
  function openDeepReading(id, { push = true } = {}) {
    const reader = $('#deepReader'), body = $('#deepReaderBody'); if (!reader || !body) return false;
    const list = dailyReadingList(), demo = id === DEMO_READING_ID;
    const item = demo ? null : list.find(p => p.pmcid === id);
    if (!demo && !item) return false;
    const wasOpen = reader.classList.contains('open');
    if (!wasOpen) deepReaderFocus = document.activeElement;
    activeDeepReadingId = id;
    if (demo) {
      $('#deepReaderLabel').textContent = '第 01 期 · 体例示范 · 人工精读';
      $('#deepReaderTitle').textContent = 'AI 指导的持续性房颤消融：获益与临床边界';
      $('#deepReaderMeta').textContent = 'TAILORED-AF · Nature Medicine · 2025-02 · 2025 年论文，非本周新文';
      body.innerHTML = '<p class="deep-reading-empty" role="status">正在载入示范精读…</p>';
      loadDemoReading().then(html => {
        if (activeDeepReadingId !== DEMO_READING_ID) return;
        body.innerHTML = html;
        renderStaticJournalMetrics();
        renderDeepReaderToc(body);
      }, () => {
        if (activeDeepReadingId === DEMO_READING_ID) body.innerHTML = '<p class="deep-reading-empty" role="status">示范精读载入失败，请检查网络后重新打开。</p>';
      });
      $('#deepReaderLinks').innerHTML = '<a class="btn-sm" target="_blank" rel="noopener" href="https://doi.org/10.1038/s41591-025-03517-w">Nature Medicine 原文 ↗</a>';
    } else {
      $('#deepReaderLabel').textContent = 'AI 全文精读 · 未经人工审核';
      $('#deepReaderTitle').textContent = item.titleZh || item.title;
      $('#deepReaderMeta').textContent = [item.journal, '论文 ' + item.date, '更新 ' + item.publishedOn].filter(Boolean).join(' · ');
      body.innerHTML = deepReadingBody(item);
      $('#deepReaderLinks').innerHTML = deepReadingLinks(item);
    }
    const index = demo ? -1 : list.indexOf(item);
    const prev = $('#deepReaderPrev'), next = $('#deepReaderNext'), pos = $('#deepReaderPos');
    if (prev) { prev.hidden = demo; prev.disabled = index <= 0; prev.dataset.readingId = index > 0 ? list[index - 1].pmcid : ''; }
    if (next) { next.hidden = demo; next.disabled = index < 0 || index >= list.length - 1; next.dataset.readingId = index >= 0 && index < list.length - 1 ? list[index + 1].pmcid : ''; }
    if (pos) pos.textContent = demo ? '' : (index + 1) + ' / ' + list.length;
    renderDeepReaderToc(body);
    body.scrollTop = 0;
    $$('.deep-reading-item').forEach(b => {
      const on = b.dataset.readingId === id;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
    reader.classList.add('open');
    reader.setAttribute('aria-hidden', 'false');
    $('#drawerBackdrop')?.classList.add('open');
    document.body.classList.add('dialog-open');
    try {
      if (push && !wasOpen) history.pushState({ deepReader: id }, '', deepReaderUrl(id));
      else history.replaceState(history.state && history.state.deepReader ? { deepReader: id } : history.state, '', deepReaderUrl(id));
    } catch (e) { /* file:// or sandboxed */ }
    if (!wasOpen) { try { reader.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    return true;
  }
  function renderDeepReaderToc(body) {
    const toc = $('#deepReaderToc');
    if (!toc) return;
    const targets = [...body.querySelectorAll('[data-toc][id]')];
    toc.hidden = targets.length < 2;
    toc.innerHTML = targets.map((t, i) => '<button type="button" data-toc-target="' + esc(t.id) + '"' + (i === 0 ? ' aria-current="true"' : '') + '>' + esc(t.dataset.toc) + '</button>').join('');
  }
  // The example reading is a 12 KB static fragment, fetched once the 近7天榜 is shown (not on first page load).
  let demoReadingRequest = null;
  function loadDemoReading() {
    if (!demoReadingRequest) {
      demoReadingRequest = fetch('demo-reading.html', { headers: { accept: 'text/html' } })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
      demoReadingRequest.catch(() => { demoReadingRequest = null; });
    }
    return demoReadingRequest;
  }
  function closeDeepReading({ fromHistory = false } = {}) {
    const reader = $('#deepReader');
    if (!reader || !reader.classList.contains('open')) return;
    // Opening pushed a history entry so the phone back button closes the panel;
    // closing by button or Esc walks back over it instead of leaving it behind.
    if (!fromHistory && history.state && history.state.deepReader) { history.back(); return; }
    const id = activeDeepReadingId;
    activeDeepReadingId = '';
    reader.classList.remove('open');
    reader.setAttribute('aria-hidden', 'true');
    if (!$('#readerDrawer.open')) { $('#drawerBackdrop')?.classList.remove('open'); document.body.classList.remove('dialog-open'); }
    $$('.deep-reading-item.active').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
    syncUrl();
    const item = [...document.querySelectorAll('.deep-reading-item')].find(b => b.dataset.readingId === id && b.getClientRects().length);
    const target = item || (deepReaderFocus && deepReaderFocus.isConnected ? deepReaderFocus : null);
    if (target && target.focus) { try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    deepReaderFocus = null;
  }
  function syncDeepReaderToc() {
    const body = $('#deepReaderBody'), toc = $('#deepReaderToc'); if (!body || !toc || toc.hidden) return;
    const top = body.getBoundingClientRect().top + 48;
    let current = '';
    body.querySelectorAll('[data-toc][id]').forEach(t => { if (!current || t.getBoundingClientRect().top <= top) current = t.id; });
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) { const all = body.querySelectorAll('[data-toc][id]'); if (all.length) current = all[all.length - 1].id; }
    toc.querySelectorAll('[data-toc-target]').forEach(b => {
      if (b.dataset.tocTarget === current) { b.setAttribute('aria-current', 'true'); if (toc.scrollWidth > toc.clientWidth) toc.scrollLeft = Math.max(0, b.offsetLeft - 16); }
      else b.removeAttribute('aria-current');
    });
  }

  // Weekly board dates are publication days in Beijing, independent of other views.
  function weeklyPublicationDate(p, now = Date.now()) {
    if (p.datePrecision && p.datePrecision !== 'day') return '';
    const value = typeof p.date === 'string' ? p.date : '';
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/.exec(value);
    if (!match) return '';
    const year = +match[1], month = +match[2], day = +match[3];
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return '';
    // Preserve known month-level issue dates from historic imports.
    if (!p.datePrecision && day === 1 && /published-print|正式期号/.test(p.dateBasis || '')) return '';
    if (!match[4]) return value;
    if (+match[4] > 23 || +match[5] > 59 || +(match[6] || 0) > 59) return '';
    const time = Date.parse(value);
    if (!Number.isFinite(time) || time > now) return '';
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(time));
  }

  function weeklyPublicationWindow(papers, now = Date.now()) {
    const end = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
    const floor = new Date(end + 'T00:00:00Z'); floor.setUTCDate(floor.getUTCDate() - 6);
    const start = floor.toISOString().slice(0, 10);
    const entries = papers.filter(p => p.weeklyPick).map(p => ({ paper: p, date: weeklyPublicationDate(p, now) }))
      .filter(row => row.date && row.date >= start && row.date <= end)
      .sort((a, b) => a.paper.weeklyPick - b.paper.weeklyPick);
    return { start, end, entries };
  }

  const WEEKLY_CATEGORIES = [['cardio', '心血管'], ['general', '综合医学'], ['aimed', 'AI 医疗'], ['aitech', 'AI 前沿']];
  function weeklyReadingIds() {
    const byDoi = new Map();
    dailyReadingList().forEach(p => { if (p.doi && !byDoi.has(String(p.doi).toLowerCase())) byDoi.set(String(p.doi).toLowerCase(), p.pmcid); });
    return byDoi;
  }
  function weeklyCard(p, date, readingId) {
    const q = quicklookOf(p), zh = (q && q.title_zh) || p.titleZh || '', huddled = state.huddle.includes(p.id);
    const med = (p.media || []).slice(0, 1).map(m => `<a class="media-pill" href="${esc(m.u)}" target="_blank" rel="noopener noreferrer" title="${esc(m.t)}">媒体关注 · ${esc(m.s)}</a>`).join('');
    const deep = readingId ? `<button type="button" class="weekly-deep-badge" data-action="open-deep-reading" data-reading-id="${esc(readingId)}">有全文精读 →</button>` : '';
    const read = hasAbstract(p) ? (validTranslation(preGeneratedOf(p)?.translation || LIVE_TR[trKeyOf(p)]) ? '阅读摘要 · 中英对照' : '阅读原摘要') : '查看文献信息';
    return `<article class="next-item weekly-auto-item" data-paper-id="${esc(p.id)}"><span class="weekly-rank">${esc(p.weeklyPick)}</span><div class="weekly-card-content"><div class="weekly-card-meta"><span class="journal-badge ${getPublisherClass(p.publisher)}">${esc(p.cleanJournal || p.journal)}</span> ${journalMetricBadge(p)} ${designBadgeHtml(p)} ${med} <span class="date-badge">${esc(date)}</span></div>` +
      publicationStatusHtml(p) + `<div class="weekly-auto-title"><button type="button" class="title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}">${esc(zh || p.title)}</button>${deep}</div>` +
      (zh ? `<div class="weekly-auto-en">${esc(p.title)}</div>` : '') +
      (q && q.one_line ? `<div class="weekly-auto-line"><span class="content-label">AI 速览 · 未经人工核验</span>${esc(q.one_line)}</div>` : '') +
      `<div class="weekly-card-actions"><button class="btn-sm" data-action="open-drawer" data-paper-id="${esc(p.id)}">${read}</button><button class="btn-sm ${huddled ? 'active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}">${huddled ? '已入精选 ✓' : '加入精选清单'}</button></div></div></article>`;
  }
  // One line per paper: rank, title, source line and the AI one-liner, with a star to collect.
  function weeklyRow(p, date, readingId) {
    const q = quicklookOf(p), zh = (q && q.title_zh) || p.titleZh || '', huddled = state.huddle.includes(p.id);
    const deep = readingId ? `<button type="button" class="weekly-deep-badge" data-action="open-deep-reading" data-reading-id="${esc(readingId)}">有全文精读 →</button>` : '';
    const design = p.publicationStatus?.label || p.studyDesign || '';
    return `<li class="weekly-row weekly-auto-item" data-paper-id="${esc(p.id)}"><span class="weekly-rank">${esc(p.weeklyPick)}</span><div class="weekly-row-main"><div class="weekly-row-title"><button type="button" class="title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}" title="${esc(p.title)}">${esc(zh || p.title)}</button>${deep}</div>` +
      publicationStatusHtml(p) + `<div class="weekly-row-meta"><span class="weekly-row-journal">${esc(p.cleanJournal || p.journal)}</span>${design ? `<span>${esc(design)}</span>` : ''}<span>${esc(date)}</span></div>` +
      (q && q.one_line ? `<div class="weekly-row-line"><span class="content-label">AI 速览</span>${esc(q.one_line)}</div>` : '') +
      `</div><button type="button" class="weekly-star${huddled ? ' active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}" aria-pressed="${huddled}" aria-label="${huddled ? '移出精选清单' : '加入精选清单'}" title="${huddled ? '已入精选清单' : '加入精选清单'}">${huddled ? '★' : '☆'}</button></li>`;
  }

  function renderWeeklyAuto() {
    const el = $('#weeklyAuto'); if (!el) return;
    const now = Date.now(), boardWindow = weeklyPublicationWindow(FEEDS.items, now);
    const reports = FEEDS.items.filter(p => p.weeklyPick).map(p => p.weeklyAt)
      .filter(value => typeof value === 'string' && value.includes('T') && weeklyPublicationDate({ date: value }, now))
      .sort((a, b) => Date.parse(b) - Date.parse(a));
    const updatedAt = reports[0] || FEEDS.updatedAt;
    const validUpdate = typeof updatedAt === 'string' && updatedAt.includes('T') && weeklyPublicationDate({ date: updatedAt }, now);
    const stale = validUpdate && now - Date.parse(updatedAt) > 6 * 3600000;
    const timing = validUpdate ? `${reports.length ? '榜单' : '来源'}更新于 ${esc(contentDate(updatedAt))}` : '更新时间暂无有效记录，时效待确认';
    const entries = boardWindow.entries.filter(({paper}) => matchesQuery(paper));
    const groups = WEEKLY_CATEGORIES.map(([id, name]) => ({ id, name, entries: entries.filter(({ paper }) => (['cardio', 'general', 'aimed', 'aitech'].includes(paper.weeklyCategory) ? paper.weeklyCategory : laneOf(paper)) === id) }));
    const boardCount = $('#weeklyPaneBoardCount'); if (boardCount) boardCount.textContent = entries.length || '';
    const preparedTranslations = entries.filter(({paper:p})=>validTranslation(preGeneratedOf(p)?.translation || LIVE_TR[trKeyOf(p)])).length;
    const preparedQuicklooks = entries.filter(({paper:p})=>quicklookOf(p)).length;
    const infoOpen = !!el.querySelector?.('.weekly-info[open]');
    const heading = `<div class="weekly-head"><h3 class="next-title">近 7 天文献榜 <span class="weekly-total">${state.search ? `匹配 ${entries.length} / ${boardWindow.entries.length}` : boardWindow.entries.length} 篇</span></h3>` +
      `<div class="weekly-meta"><span>发表于 ${boardWindow.start.slice(5)} 至 ${boardWindow.end.slice(5)}（北京时间，含今天）· ${timing}</span>${stale ? '<b class="weekly-stale">更新已超过 6 小时，时效待确认</b>' : ''}` +
      `<details class="weekly-info"${infoOpen ? ' open' : ''}><summary>榜单说明</summary><div class="weekly-info-body"><p>收录北京时间 ${boardWindow.start}–${boardWindow.end} 发表的入榜文献。分类与排序为自动规则，未经逐篇质量评审。</p><p class="weekly-preparation">摘要内容准备：中文摘要 ${preparedTranslations}/${entries.length} · AI 速览 ${preparedQuicklooks}/${entries.length}。仅依据公开摘要，模型内容未经人工核对，不代表全文精读。</p><p>点题名打开阅读台看摘要；出版商原文链接在阅读台底部。</p></div></details></div></div>`
      + specialSearchStatus('近7天榜（只筛当前入榜文献，不改变选文；其他栏目筛选不影响榜单）', entries.length, boardWindow.entries.length, '篇');
    if (!entries.length) { el.innerHTML = heading + `<p class="text-muted" role="status">${state.search ? '当前榜内没有匹配文献，可清除关键词；更大范围请到文献雷达检索。' : '近7天暂无入榜条目'}</p>`; return; }
    const cat = groups.some(g => g.id === state.weeklyCat) ? state.weeklyCat : '';
    const compact = state.viewMode === 'compact';
    const bar = `<div class="weekly-bar"><div class="weekly-category-nav" role="group" aria-label="文献榜分类"><button type="button" data-weekly-cat="" aria-pressed="${!cat}">全部 <span>${entries.length}</span></button>` +
      groups.map(g => `<button type="button" data-weekly-cat="${g.id}" aria-pressed="${cat === g.id}"${g.entries.length || cat === g.id ? '' : ' disabled'}>${g.name} <span>${g.entries.length}</span></button>`).join('') +
      `</div><div class="view-toggle weekly-view-toggle" role="group" aria-label="显示方式"><button type="button" class="view-toggle-btn${compact ? '' : ' active'}" data-weekly-view="cards" aria-pressed="${!compact}">详细</button><button type="button" class="view-toggle-btn${compact ? ' active' : ''}" data-weekly-view="compact" aria-pressed="${compact}">列表</button></div></div>`;
    const readings = weeklyReadingIds();
    const shown = cat ? groups.filter(g => g.id === cat) : groups.filter(g => g.entries.length);
    el.innerHTML = heading + bar + `<div class="weekly-board ${compact ? 'weekly-board-compact' : ''}">` + shown.map(g => `<section class="weekly-group" id="weekly-group-${g.id}" aria-labelledby="weekly-title-${g.id}"><h4 id="weekly-title-${g.id}" class="weekly-group-title">${g.name}<span>${g.entries.length} 篇</span></h4>` + (g.entries.length ?
      (compact ? '<ol class="weekly-list">' : '<div class="weekly-card-grid">') +
      g.entries.map(({ paper: p, date }) => (compact ? weeklyRow : weeklyCard)(p, date, readings.get(String(p.doi || '').toLowerCase()) || '')).join('') +
      (compact ? '</ol>' : '</div>') : `<p class="weekly-group-empty">${state.search ? '本类暂无匹配文献。' : '本类暂无入榜文献。'}</p>`) + '</section>').join('') + '</div>';
  }

  function renderNextCandidates() {
    const el = $('#nextCandidates');
    if (!el) return;
    const wrap = $('#weeklyNextWrap');
    if (state.search) { el.innerHTML = ''; if (wrap) wrap.hidden = true; return; }
    const okDesign = new Set(['RCT', '方法/模型验证', 'Meta/综述', '队列研究']);
    const top = new Set(['New England Journal of Medicine', 'The Lancet', 'JAMA', 'JAMA Cardiology', 'European Heart Journal', 'JACC', 'Circulation', 'Nature Medicine', 'npj Digital Medicine', 'EHJ-Digital Health', 'EHJ - Digital Health', 'European Heart Journal - Digital Health']);
    const score = p => (okDesign.has(p.studyDesign) ? 2 : 0) + (top.has(p.cleanJournal) ? 2 : 0) + ((p.tags || []).some(t => t !== '#大模型/NLP') ? 1 : 0) + (AI_RE.test(p.title) ? 2 : 0) + (paperCrossAI(p) ? 3 : (paperLane(p) === 'cardio' ? 2 : 0));
    const list = LIBRARY.papers
      .filter(p => okDesign.has(p.studyDesign) && (p.date || '') >= '2026-01' && paperLane(p) !== 'general' && paperLane(p) !== 'aitech')
      .map(p => [score(p), p]).filter(x => x[0] >= 4)
      .sort((a, b) => b[0] - a[0] || (b[1].date || '').localeCompare(a[1].date || ''))
      .slice(0, 5).map(x => x[1]);
    if (wrap) wrap.hidden = !list.length;
    if (!list.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<p class="weekly-next-note">公共题录中的近期心血管 / AI 论文，优先心血管与“心血管 × AI”，按研究类型与期刊自动排序，<b>尚未评估质量</b>；全文获取与共享权限需另行核验。想推荐哪篇就加入精选清单。</p>` +
      list.map(p => `<div class="next-item"><div><span class="journal-badge ${getPublisherClass(p.publisher)}">${esc(p.cleanJournal || p.journal)}</span> ${journalMetricBadge(p)} ${designBadgeHtml(p)} <span class="date-badge">${esc((p.date || '').slice(0, 10))}</span></div><div class="next-item-title">${esc(p.title)}</div><div class="next-item-actions"><button class="btn-sm ${state.huddle.includes(p.id) ? 'active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}">${state.huddle.includes(p.id) ? '已入精选 ✓' : '加入精选清单'}</button><a class="btn-sm" target="_blank" rel="noopener" href="${esc(p.url || (p.doi ? 'https://doi.org/' + p.doi : '#'))}">出版商 / 题录 ↗</a></div></div>`).join('');
  }

