  // ==== src/app/01-state-helpers.js · Storage, URL state, DOM/format helpers, share text, theme ====
  // Safe storage (private mode / blocked storage must not break the page)
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function safeRemove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  // URL State & Query Params
  const urlParams = new URLSearchParams(window.location.search);
  // Maintainer-only links (Hamburg institutional access) stay hidden from colleagues.
  // ?maintainer=1 turns them on for this browser, ?maintainer=0 turns them off.
  if (urlParams.get('maintainer') === '1') safeSet('xz_maintainer', '1');
  if (urlParams.get('maintainer') === '0') safeRemove('xz_maintainer');
  const MAINTAINER = safeGet('xz_maintainer') === '1';
  // Server pages (PDF download, full-text request) read the same choice from a cookie.
  try {
    if (MAINTAINER) document.cookie = 'xz_maintainer=1; Path=/; Max-Age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    else if (/(?:^|;\s*)xz_maintainer=/.test(document.cookie)) document.cookie = 'xz_maintainer=; Path=/; Max-Age=0; SameSite=Lax';
  } catch (e) { /* cookies blocked */ }
  const validView = value => ['cards', 'compact'].includes(value);
  const validTheme = value => ['light', 'dark'].includes(value);
  const VALID_MODES = ['curated', 'weekly', 'candidates', 'library', 'sources'];
  function defaultRange(m) { return m === 'candidates' ? '14' : 'all'; }
  function readStateFromUrl(search = window.location.search) {
    const params = new URLSearchParams(search);
    const rawMode = params.get('mode') || 'curated';
    const mode = VALID_MODES.includes(rawMode) ? rawMode : 'curated';
    const nextViewInUrl = validView(params.get('view'));
    return {
      mode,
      viewInUrl: nextViewInUrl,
      viewMode: nextViewInUrl ? params.get('view') : validView(safeGet('xinzhi_view_mode')) ? safeGet('xinzhi_view_mode') : 'cards',
      search: params.get('q') || '',
      clinicalTier: params.get('tier') || '',
      publisher: params.get('pub') || '',
      journal: params.get('journal') || '',
      studyDesign: params.get('design') || '',
      tag: params.get('tag') || '',
      lane: params.get('lane') || 'core',
      sort: ['smart', 'date-desc', 'date-asc', 'journal-date'].includes(params.get('sort')) ? params.get('sort') : 'date-desc',
      range: ['7', '14', '30', '90', '365', 'all'].includes(params.get('range')) ? params.get('range') : defaultRange(mode),
      minor: params.get('minor') === '1',
      reading: ['abstract', 'guide', 'quicklook'].includes(params.get('reading')) ? params.get('reading') : '',
      favoritesOnly: params.get('favorites') === '1',
      day: params.get('day') === 'all' || /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') || '') ? params.get('day') : '',
      weeklyCat: ['cardio', 'general', 'aimed', 'aitech'].includes(params.get('wcat')) ? params.get('wcat') : '',
      weeklyPane: params.get('pane') === 'reading' ? 'reading' : 'board',
      sourceFilter: ['ok', 'attention'].includes(params.get('sf')) ? params.get('sf') : '',
      ftFilter: ['ready', 'verifying', 'queued', 'failed', 'none'].includes(params.get('ft')) ? params.get('ft') : ''
    };
  }
  const URL_STATE_KEYS = [
    'mode', 'viewMode', 'search', 'clinicalTier', 'publisher', 'journal',
    'studyDesign', 'tag', 'lane', 'sort', 'range', 'minor', 'reading',
    'favoritesOnly', 'day', 'weeklyCat', 'weeklyPane', 'sourceFilter', 'ftFilter'
  ];
  // Saved view preferences affect rendering without adding a URL parameter.
  const initialUrlState = readStateFromUrl(window.location.search);
  let viewInUrl = initialUrlState.viewInUrl;
  const savedTheme = safeGet('xinzhi_theme');
  const state = {
    mode: initialUrlState.mode, // 'curated' | 'weekly' | 'candidates' | 'library' | 'sources'
    viewMode: initialUrlState.viewMode, // 'cards' | 'compact'
    theme: window.XINZHI_BOOT ? window.XINZHI_BOOT.theme : validTheme(urlParams.get('theme')) ? urlParams.get('theme') : validTheme(savedTheme) ? savedTheme : ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'),
    search: initialUrlState.search,
    clinicalTier: initialUrlState.clinicalTier,
    publisher: initialUrlState.publisher,
    journal: initialUrlState.journal,
    studyDesign: initialUrlState.studyDesign,
    tag: initialUrlState.tag,
    lane: initialUrlState.lane,
    sort: initialUrlState.sort,
    range: initialUrlState.range,
    minor: initialUrlState.minor,
    reading: initialUrlState.reading,
    favoritesOnly: initialUrlState.favoritesOnly,
    day: initialUrlState.day,
    weeklyCat: initialUrlState.weeklyCat,
    weeklyPane: initialUrlState.weeklyPane,
    sourceFilter: initialUrlState.sourceFilter,
    ftFilter: initialUrlState.ftFilter,
    favoriteJournals: (()=>{try { const a=JSON.parse(safeGet('xz_favorite_journals')||'[]'); return Array.isArray(a)?a.filter(x=>typeof x==='string'):[]; } catch(e){return [];} })(),
    pageSize: 20,
    page: 1,
    huddle: (function () { try { const v = JSON.parse(safeGet('xinzhi_huddle_ids') || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch (e) { return []; } })(),
    // Minimal record of each shortlisted paper, so the list stays complete when its paper is not loaded.
    huddleSnap: (function () { try { const v = JSON.parse(safeGet('xinzhi_huddle_snap') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } })(),
    activeDrawerPaper: null,
    huddleCompare: [] // Explicit selection, kept only in this browser session.
  };

  // Helper DOM selectors
  const $ = selector => document.querySelector(selector);
  const $$ = selector => document.querySelectorAll(selector);

  // HTML escaping
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  function journalMetricBadge(input) {
    return typeof window !== 'undefined' && window.JournalMetrics ? window.JournalMetrics.renderBadge(input) : '';
  }
  function journalMetricDetails(input) {
    return typeof window !== 'undefined' && window.JournalMetrics ? window.JournalMetrics.renderDetails(input) : '';
  }
  function journalMetricText(input) {
    return typeof window !== 'undefined' && window.JournalMetrics ? window.JournalMetrics.compactText(input) : '';
  }
  function renderStaticJournalMetrics() {
    $$('[data-journal-metrics]').forEach(el => { el.innerHTML = journalMetricBadge(el.dataset.journalMetrics); });
    $$('[data-journal-metrics-details]').forEach(el => { el.innerHTML = journalMetricDetails(el.dataset.journalMetricsDetails); });
  }

  // Toast notification
  let toastTimer = null;
  function showToast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // Publisher brand class
  function getPublisherClass(pub) {
    const p = (pub || '').toLowerCase();
    if (p.includes('nature')) return 'journal-nature';
    if (p.includes('elsevier') || p.includes('jacc')) return 'journal-elsevier';
    if (p.includes('aha') || p.includes('circulation')) return 'journal-aha';
    if (p.includes('lancet')) return 'journal-lancet';
    if (p.includes('oxford') || p.includes('ehj')) return 'journal-oxford';
    if (p.includes('jama')) return 'journal-jama';
    if (p.includes('bmj')) return 'journal-bmj';
    if (p.includes('nejm') || p.includes('mms')) return 'journal-nejm';
    if (p.includes('wiley')) return 'journal-wiley';
    if (p.includes('pubmed')) return 'journal-pubmed';
    if (p.includes('tech') || p.includes('ai')) return 'journal-tech';
    return '';
  }

  // Study design badge class
  function getDesignClass(design) {
    const d = (design || '').toLowerCase();
    if (d === 'rct') return 'design-rct';
    if (d.includes('验证') || d.includes('算法')) return 'design-validation';
    if (d.includes('meta') || d.includes('综述')) return 'design-meta';
    if (d.includes('队列')) return 'design-cohort';
    if (d.includes('指南')) return 'design-guideline';
    return '';
  }
  function prioritizedDesign(paper) {
    if (paper.publicationStatus) return paper.publicationStatus.label;
    return ['研究方案', '述评观点', '更正声明', '撤稿声明', '关注声明', '已撤稿', '存在关注声明', 'RCT 二次分析', '二次分析'].includes(paper.studyDesign) ? paper.studyDesign : '';
  }
  function designBadgeHtml(paper) {
    const role = prioritizedDesign(paper);
    const checked = paper.hasDraft && paper.draftData?.source_checked === true && (!role || paper.draftData.study_type === paper.studyDesign);
    const label = paper.publicationStatus?.label || (checked && !role ? paper.draftData.study_type || paper.studyDesign : paper.studyDesign);
    if (!label || label === '研究类型待核验') return '';
    const type = label;
    if (paper.publicationStatus) return `<span class="design-pill publication-status-pill" title="PubMed 官方出版状态">${esc(type)}</span>`;
    return `<span class="design-pill ${checked ? getDesignClass(type) + ' design-checked' : 'design-unverified'}" title="${checked ? '已根据公开摘要核对研究类型；不是全文终审' : '来源或规则标注；尚未逐篇核对研究类型'}">${esc(type)}</span>`;
  }
  function publicationStatusHtml(paper) {
    const status = paper?.publicationStatus;
    if (!status) return '';
    const label = String(status.label ?? '').trim();
    const pubmedUrl = url => /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/[1-9]\d*\/$/.test(url || '');
    const links = [];
    if (pubmedUrl(status.sourceUrl)) links.push(`<a href="${esc(status.sourceUrl)}" target="_blank" rel="noopener noreferrer">PubMed 状态来源 ↗</a>`);
    (status.related || []).forEach(r => {
      if (r && pubmedUrl(r.url)) links.push(`<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.label)}（PMID ${esc(r.pmid)}）↗</a>`);
    });
    if (!label && !links.length) return '';
    return `<div class="publication-status" role="note">${label ? `<strong>${esc(label)}</strong>` : ''}${links.join(' · ')}</div>`;
  }
  function publicationStatusText(paper) {
    const s = paper.publicationStatus;
    if (!s) return '';
    return '\n出版状态：' + s.label + (s.sourceUrl ? ' · ' + s.sourceUrl : '') +
      (s.related || []).map(r => '\n' + r.label + '：' + r.url).join('');
  }

  // Generate standardized WeChat share text
  function generateWeChatShareText(p) {
    const title = p.draftData?.title_zh || p.title;
    const origTitle = p.draftData?.title_zh ? `\n原题：${p.title}` : '';
    const journal = p.cleanJournal || p.journal || '权威医学期刊';
    const date = p.date ? p.date.slice(0, 10) : '';
    const design = p.studyDesign || '临床研究';
    const pub = p.publisher || '';
    
    let summary = p.draftData?.summary || p.summary || '';
    if (summary.length > 280) summary = summary.slice(0, 277) + '...';

    const boundary = p.draftData?.limitations 
      ? `\n⚠️ 证据边界与局限：${p.draftData.limitations}` 
      : '';
    const question = p.draftData?.learning_question 
      ? `\n🤔 共读问题：${p.draftData.learning_question}` 
      : '';
    const url = safeSourceUrl(p);

    return `【心知文献情报 · 临床速递】\n📌 题名：${title}${origTitle}\n🏛️ 期刊：${journal} (${pub} · ${date}) | ${design}${publicationStatusText(p)}\n期刊指标：${journalMetricText(p)}\n🎯 核心速览：${summary}${boundary}${question}\n🔗 原文：${url}\n\n（来源：心知 AIHOT-Med 临床文献工作台 · 仅供学习讨论）`;
  }

  // Clipboard copy helper
  async function copyToClipboard(text, successMsg = '已复制到剪贴板') {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        showToast(successMsg);
        return true;
      }
    } catch (e) {}
    let ta = null;
    let ok = false;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy') === true;
    } catch (e) {
      ok = false;
    } finally {
      if (ta) {
        try {
          if (ta.parentNode) ta.parentNode.removeChild(ta);
          else document.body.removeChild(ta);
        } catch (e) {}
      }
    }
    showToast(ok ? successMsg : '复制失败，请手动复制');
    return ok;
  }

  // Setup Theme
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    if (window.XINZHI_BOOT) window.XINZHI_BOOT.apply(theme);
    safeSet('xinzhi_theme', theme);
  }
  applyTheme(state.theme);

  // Initialize Mode Badges
  function getCuratedList() {
    const seen = new Set();
    const out = [];
    [...CURATED, ...FEEDS.items, ...LIBRARY.papers].forEach(p => {
      if (!(p.hasDraft && p.draftData) && !p.autoPick) return;
      const key = (p.doi || p.id || '').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(p);
    });
    return out;
  }

