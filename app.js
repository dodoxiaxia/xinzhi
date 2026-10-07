/**
 * 心知 AIHOT-Med · Modern Clinical Literature Intelligence Platform
 * High-performance client-side multi-dimensional faceted aggregator.
 */
'use strict';

(function () {
  // Global Data
  const FEEDS = window.FEEDS || { items: [] };
  const LIBRARY = window.LIBRARY || { papers: [] };
  const CURATED = window.CURATED || [];
  const HEALTH = window.SOURCE_HEALTH || { sources: [] };
  const CONTENT_STATUS = window.CONTENT_STATUS || {};

  // ---- Data normalisation (runs once): tidy titles/journals/links so filters and cards behave ----
  const KIND_MAP = { Articles: '', Article: '', Comment: '评论', Correspondence: '来信', Review: '综述', Viewpoint: '观点', News: '新闻', Series: '系列', 'World Report': '世界报道', Editorial: '社论', Obituary: '讣告' };
  const MINOR_RE = /^(author correction|publisher correction|correction to|correction:|erratum|retraction|letter by|response by|reply to|reply by|comment on|regarding)/i;
  function shortJournal(j) {
    if (!j) return j;
    const s0 = String(j).split(' : ')[0].trim();
    return s0.length > 48 ? s0.slice(0, 45) + '…' : s0;
  }
  function normalizePaper(p) {
    const m = /^\[([A-Za-z ]+)\]\s*/.exec(p.title || '');
    if (m) {
      p.kind = Object.prototype.hasOwnProperty.call(KIND_MAP, m[1]) ? KIND_MAP[m[1]] : m[1];
      p.title = p.title.slice(m[0].length);
      if (['评论', '来信', '观点', '新闻', '社论', '世界报道', '讣告'].includes(p.kind)) p.studyDesign = '述评观点';
    }
    // 部分 RSS 只给“期刊, Volume x, Issue y, Page z”这种出处行，并非摘要：移到 citationLine，避免被当成有摘要
    if (p.summary && p.summary.length < 240 && /\b(?:Volume|Vol\.)\s*\d+/i.test(p.summary) && /\b(?:Issue|Page|pp?\.)/i.test(p.summary)) { p.citationLine = p.summary; p.summary = ''; }
    p.minor = p.kind === '来信' || MINOR_RE.test(p.title || '');
    // Retain canonical journal names for citation and matching; CSS handles display width.
    const pm = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/.exec(p.url || '');
    if (pm) { if (!p.pmid) p.pmid = pm[1]; p.url = String(p.url).split('?')[0]; }
  }
  FEEDS.items.forEach(normalizePaper);
  LIBRARY.papers.forEach(normalizePaper);

  // 365-day PubMed title archive (compact rows -> paper objects) feeds the radar's 30 / 90 / 365-day views
  (function expandRadar() {
    const R = window.RADAR;
    if (!R || !Array.isArray(R.rows)) return;
    const seen = new Set();
    FEEDS.items.forEach(p => { if (p.doi) seen.add(String(p.doi).toLowerCase()); if (p.pmid) seen.add('pmid:' + p.pmid); });
    R.rows.forEach(r => {
      if ((r[1] && seen.has(r[1])) || seen.has('pmid:' + r[0])) return;
      const p = {
        id: 'pmid-' + r[0], pmid: r[0], doi: r[1], title: r[8], date: r[2], datePrecision: 'day', dateBasis: 'PubMed 电子/刊期日期',
        journal: R.jn[r[3]], cleanJournal: R.jn[r[3]], publisher: R.pub[r[4]], clinicalTier: R.tier[r[5]], studyDesign: R.design[r[6]],
        tags: r[7].map(i => R.tag[i]), url: r[1] ? 'https://doi.org/' + r[1] : 'https://pubmed.ncbi.nlm.nih.gov/' + r[0] + '/',
        basis: 'PubMed 题录 · 未核验', archived: true, quantitativeMetrics: {}
      };
      if (R.zh && R.zh[r[0]]) p.titleZh = R.zh[r[0]];
      const ab = R.abs && R.abs[r[0]];
      if (ab) p.abstractSections = ab.map(x => ({ label: x[0], text: x[1] }));
      normalizePaper(p);
      FEEDS.items.push(p);
    });
  })();
  CURATED.forEach(normalizePaper);

  // Chinese -> English search expansion (titles/abstracts are English)
  const ZH_EN = {
    '房颤': ['atrial fibrillation'], '房扑': ['atrial flutter'], '心衰': ['heart failure'], '心力衰竭': ['heart failure'], '消融': ['ablation'],
    '射频': ['radiofrequency'], '冷冻': ['cryo'], '脉冲场': ['pulsed field'], '冠脉': ['coronary'], '冠心病': ['coronary artery disease', 'coronary'],
    '心梗': ['myocardial infarction'], '心肌梗死': ['myocardial infarction'], '高血压': ['hypertension'], '卒中': ['stroke'], '中风': ['stroke'],
    '起搏': ['pacing', 'pacemaker'], '除颤': ['defibrillator'], '瓣膜': ['valve', 'valvular'], '主动脉': ['aortic', 'aorta'], '心肌病': ['cardiomyopathy'],
    '心肌炎': ['myocarditis'], '淀粉样': ['amyloid'], '肺动脉高压': ['pulmonary hypertension', 'pulmonary arterial hypertension'], '心脏骤停': ['cardiac arrest'],
    '猝死': ['sudden cardiac death', 'sudden death'], '左心耳': ['left atrial appendage'], '抗凝': ['anticoagul'], '血脂': ['lipid', 'cholesterol'],
    '他汀': ['statin'], '糖尿病': ['diabetes'], '心电图': ['electrocardiogram', 'ECG'], '心电': ['ECG', 'electrocardio'], '超声': ['echocardiograph', 'ultrasound'],
    '磁共振': ['magnetic resonance', 'CMR'], '影像': ['imaging'], '支架': ['stent'], '介入': ['intervention', 'PCI'], '搭桥': ['bypass', 'CABG'],
    '先心': ['congenital'], '先天性': ['congenital'], '心律失常': ['arrhythmia'], '室速': ['ventricular tachycardia'], '室颤': ['ventricular fibrillation'],
    '心脏康复': ['cardiac rehabilitation'], '穿戴': ['wearable'], '大模型': ['large language model', 'LLM'], '语言模型': ['language model'],
    '人工智能': ['artificial intelligence'], '机器学习': ['machine learning'], '深度学习': ['deep learning'], '预测模型': ['prediction model'],
    '随机对照': ['randomized', 'randomised'], '荟萃': ['meta-analysis'], '综述': ['review'], '指南': ['guideline'], '共识': ['consensus'],
    '心脏': ['cardiac', 'heart'], '血管': ['vascular'], '心血管': ['cardiovascular'], '血栓': ['thrombo'], '出血': ['bleeding', 'hemorrhage'],
    '肥厚': ['hypertrophic'], '扩张型': ['dilated'], 'TAVR': ['transcatheter aortic'], '二尖瓣': ['mitral'], '三尖瓣': ['tricuspid']
  };
  const zhTerms = Object.keys(ZH_EN).sort((a,b) => b.length - a.length);
  // Segment adjacent Chinese terms: 房颤消融 and 房颤 消融 both mean AND.
  function queryMatches(text, q) {
    return q.split(/\s+/).filter(Boolean).every(term => {
      if (text.includes(term)) return true;
      const groups = []; let rest = term;
      while (rest) {
        const zh = zhTerms.find(k => rest.startsWith(k.toLowerCase()));
        if (zh) { groups.push([zh.toLowerCase(), ...ZH_EN[zh].map(x=>x.toLowerCase())]); rest = rest.slice(zh.length); }
        else {
          const next = [...rest].findIndex((_,i) => i>0 && zhTerms.some(k=>rest.slice(i).startsWith(k.toLowerCase())));
          const n = next > 0 ? next : rest.length;
          groups.push([rest.slice(0,n)]); rest = rest.slice(n);
        }
      }
      return groups.every(alts=>alts.some(a=>text.includes(a)));
    });
  }

  // All papers indexed by ID
  const allPapersMap = new Map();
  [...CURATED, ...FEEDS.items, ...LIBRARY.papers].forEach(p => {
    if (p.id && !allPapersMap.has(p.id)) {
      allPapersMap.set(p.id, p);
    }
  });

  // Safe storage (private mode / blocked storage must not break the page)
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // URL State & Query Params
  const urlParams = new URLSearchParams(window.location.search);
  const state = {
    mode: urlParams.get('mode') || 'curated', // 'curated' | 'weekly' | 'candidates' | 'library' | 'sources'
    viewMode: urlParams.get('view') || safeGet('xinzhi_view_mode') || 'cards', // 'cards' | 'compact'
    theme: urlParams.get('theme') || safeGet('xinzhi_theme') || ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'),
    search: urlParams.get('q') || '',
    clinicalTier: urlParams.get('tier') || '',
    publisher: urlParams.get('pub') || '',
    journal: urlParams.get('journal') || '',
    studyDesign: urlParams.get('design') || '',
    tag: urlParams.get('tag') || '',
    lane: urlParams.get('lane') || 'core',
    sort: (['smart','date-desc','date-asc','journal-date'].includes(urlParams.get('sort'))) ? urlParams.get('sort') : 'date-desc',
    range: ['7','14','30','90','365','all'].includes(urlParams.get('range')) ? urlParams.get('range') : '',
    minor: urlParams.get('minor') === '1',
    reading: ['abstract','guide','quicklook'].includes(urlParams.get('reading')) ? urlParams.get('reading') : '',
    favoritesOnly: urlParams.get('favorites') === '1',
    favoriteJournals: (()=>{try { const a=JSON.parse(safeGet('xz_favorite_journals')||'[]'); return Array.isArray(a)?a.filter(x=>typeof x==='string'):[]; } catch(e){return [];} })(),
    pageSize: 20,
    page: 1,
    huddle: (function () { try { const v = JSON.parse(safeGet('xinzhi_huddle_ids') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } })(),
    activeDrawerPaper: null
  };

  function defaultRange(m) { return m === 'candidates' ? '14' : 'all'; }
  if (!state.range) state.range = defaultRange(state.mode);

  // Helper DOM selectors
  const $ = selector => document.querySelector(selector);
  const $$ = selector => document.querySelectorAll(selector);

  // HTML escaping
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

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

    return `【心知文献情报 · 临床速递】\n📌 题名：${title}${origTitle}\n🏛️ 期刊：${journal} (${pub} · ${date}) | ${design}\n🎯 核心速览：${summary}${boundary}${question}\n🔗 原文：${url}\n\n（来源：心知 AIHOT-Med 临床文献工作台 · 仅供学习讨论）`;
  }

  // Clipboard copy helper
  async function copyToClipboard(text, successMsg = '已复制到剪贴板') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMsg);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(successMsg);
    }
  }

  // Setup Theme
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
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

  // ---- Relevance lanes: keep the reader's default view on cardiology + medical AI ----
  const CARDIO_TIERS = new Set(['心血管旗舰顶刊', '心律失常与电生理', '心衰与重症心肌', '冠脉介入与结构', '心血管影像与表型', '脑血管与高血压', '心血管综合与其他', '定向专病与团队']);
  const LANES = [
    { id: 'core', name: '心血管 + AI 医疗' },
    { id: 'crossai', name: '心血管 × AI' },
    { id: 'cardio', name: '心血管' },
    { id: 'aimed', name: 'AI 医疗' },
    { id: 'general', name: '综合医学' },
    { id: 'aitech', name: 'AI 行业动态' },
    { id: 'all', name: '全部' }
  ];
  const AI_RE = /artificial intelligence|machine learning|deep learning|neural network|language model|\bLLMs?\b|\bAI\b|foundation model|generative (?:AI|model)|ChatGPT|\bGPT-?\d|transformer|federated learning|convolutional|natural language processing|computer[- ]aided|radiomics/i;
  const CARDIO_RE = /\bcardi[a-z]*|\bheart\b|atrial|ventric|coronary|myocard|arrhythm|\bECG\b|\bEKG\b|electrocardio|aort|hypertens|stroke|vascular|angio|valv|thrombo|anticoag|lipoprotein|cholesterol|statin|pacemaker|defibrill|tachycardia|fibrillation/i;
  function paperText(p) { return [p.title,p.summary,...(p.abstractSections||[]).map(x=>x.text)].filter(Boolean).join(' '); }
  function laneOf(p) {
    if (p.clinicalTier === '前沿大模型与科技') return 'aitech';
    if (CARDIO_TIERS.has(p.clinicalTier) || CARDIO_RE.test(p.title || '')) return 'cardio';
    if (p.clinicalTier === 'AI医疗与数字医学') return 'aimed';
    if (AI_RE.test(paperText(p))) return /patient|clinic|medical|medicine|health|diagnos|treatment|hospital|disease|drug|surgery|radiolog/i.test(p.title||'') ? 'aimed' : 'aitech';
    return 'general';
  }
  function isCrossAI(p) {
    return AI_RE.test(paperText(p)) && (laneOf(p)==='cardio' || CARDIO_RE.test(p.title || ''));
  }
  const LIVE_QL = {};
  function qlKey(p) { return p.doi ? String(p.doi).toLowerCase() : 'pmid-' + p.pmid; }
  function quicklookOf(p) { const k = qlKey(p); return (window.QUICKLOOKS||{})[k] || LIVE_QL[k] || null; }
  // 一键 AI 解读：后端 /api/ql（Cloudflare _worker.js）。本地静态预览没有后端时自动隐藏按钮。
  function aiApiCheck(paper) {
    if (paper._aiChecked || (!paper.doi && !paper.pmid)) return;
    paper._aiChecked = 1; paper._aiState = 'checking';
    const k = paper.pmid ? 'pmid:' + paper.pmid : 'doi:' + String(paper.doi).toLowerCase();
    fetch('/api/ql?k=' + encodeURIComponent(k), { headers: { accept: 'application/json' } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => {
        if (j && j.found && j.ql) { LIVE_QL[qlKey(paper)] = j.ql; paper._aiState = 'done'; }
        else paper._aiState = j && j.canGenerate ? 'none' : 'off';
      })
      .catch(() => { paper._aiState = 'off'; })
      .then(() => { if (state.activeDrawerPaper === paper) openReaderDrawer(paper); });
  }
  // ---- 摘要翻译 / 多篇综述（同一后端 /api/ai，结果服务器端缓存、全站共享）----
  const LIVE_TR = {}; const BRIEFS = {}; let AI_AVAIL = null;
  const trKeyOf = p => p.pmid ? 'pmid:' + p.pmid : (p.doi ? 'doi:' + String(p.doi).toLowerCase() : '');
  function trCheck(paper) {
    const k = trKeyOf(paper);
    if (!k || paper._trChecked || AI_AVAIL === false) return;
    paper._trChecked = 1;
    fetch('/api/ai?task=translate&k=' + encodeURIComponent(k), { headers: { accept: 'application/json' } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => { if (j && j.found && j.tr) { LIVE_TR[k] = j.tr; if (!paper.titleZh) paper.titleZh = j.tr.title_zh; if (state.activeDrawerPaper === paper) openReaderDrawer(paper); } })
      .catch(() => {});
  }
  function aiTranslate(paper) {
    const k = trKeyOf(paper); if (!k || paper._trState === 'loading') return;
    paper._trState = 'loading'; openReaderDrawer(paper);
    fetch('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'translate', pmid: paper.pmid || '', doi: paper.doi || '' }) })
      .then(r => r.json().catch(() => ({ ok: false, error: 'server' })))
      .then(j => { if (j.ok && j.tr) { LIVE_TR[k] = j.tr; if (!paper.titleZh) paper.titleZh = j.tr.title_zh; paper._trState = 'done'; } else { paper._trState = 'error'; paper._trMsg = AI_ERR[j.error] || '翻译失败，请稍后重试。'; } })
      .catch(() => { paper._trState = 'error'; paper._trMsg = '网络错误，请稍后重试。'; })
      .then(() => { if (state.activeDrawerPaper === paper) openReaderDrawer(paper); });
  }
  function aiTitle(paper) {
    if (paper._ttState === 'loading') return;
    paper._ttState = 'loading'; paper._ttMsg = '翻译中…'; openReaderDrawer(paper);
    fetch('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'title', pmid: paper.pmid || '', doi: paper.doi || '' }) })
      .then(r => r.json().catch(() => ({ ok: false, error: 'server' })))
      .then(j => { if (j.ok && j.tt) { paper.titleZh = j.tt.title_zh; paper._ttMsg = ''; } else paper._ttMsg = AI_ERR[j.error] || '翻译失败，请稍后重试。'; })
      .catch(() => { paper._ttMsg = '网络错误，请稍后重试。'; })
      .then(() => { paper._ttState = ''; if (state.activeDrawerPaper === paper) openReaderDrawer(paper); });
  }
  function trBoxHtml(paper) {
    const tr = LIVE_TR[trKeyOf(paper)];
    if (tr) return `<div class="tr-box"><div class="tr-head"><span class="content-label">机器翻译 · 中文对照</span></div>${tr.abstract_zh.split(/\n+/).map(t => `<p>${esc(t)}</p>`).join('')}<p class="text-muted" style="font-size:11.5px;">由模型翻译公开摘要，未经人工核对；以英文原文为准。</p></div>`;
    if (AI_AVAIL === false || !(paper.pmid || paper.doi)) return '';
    if (paper._trState === 'loading') return '<div class="tr-box"><p class="ql-meta">正在翻译摘要，请稍候…</p></div>';
    return `<div class="tr-box">${paper._trState === 'error' ? `<p class="ql-meta" style="color:#b45309;">${esc(paper._trMsg || '')}</p>` : ''}<button class="btn-sm" data-action="ai-translate" data-paper-id="${esc(paper.id)}">翻译摘要（中英对照）</button></div>`;
  }
  function briefItems(list) { return list.filter(p => p.pmid || p.doi).slice(0, 8).map(p => ({ pmid: p.pmid || '', doi: p.doi || '' })); }
  function briefKey(mode, items) { return mode + '|' + items.map(x => x.pmid || x.doi).sort().join(','); }
  function aiBrief(mode, list, rerender) {
    const items = briefItems(list); if (items.length < 2) { showToast('至少需要 2 篇有 PMID/DOI 的文献'); return; }
    const k = briefKey(mode, items);
    if (BRIEFS[k] && BRIEFS[k].state === 'loading') return;
    BRIEFS[k] = { state: 'loading' }; rerender();
    fetch('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'brief', mode, items }) })
      .then(r => r.json().catch(() => ({ ok: false, error: 'server' })))
      .then(j => { BRIEFS[k] = j.ok && j.brief ? { state: 'done', brief: j.brief } : { state: 'error', msg: AI_ERR[j.error] || '生成失败，请稍后重试。' }; })
      .catch(() => { BRIEFS[k] = { state: 'error', msg: '网络错误，请稍后重试。' }; })
      .then(rerender);
  }
  function briefHtml(mode, list) {
    const items = briefItems(list); if (items.length < 2) return '';
    const k = briefKey(mode, items), b = BRIEFS[k];
    const label = mode === 'huddle' ? 'AI 生成讨论提纲' : 'AI 综述本页前 ' + items.length + ' 篇';
    if (!b || b.state === 'error') return `<div class="brief-box">${b ? `<p class="ql-meta" style="color:#b45309;">${esc(b.msg)}</p>` : ''}<button class="btn-sm btn-primary" data-action="ai-brief" data-mode="${mode}">${label}</button><span class="text-muted" style="font-size:12px;margin-left:8px;">读取各篇公开摘要后生成，约 15–30 秒；结果全站共享。</span></div>`;
    if (b.state === 'loading') return '<div class="brief-box"><p class="ql-meta">正在读取摘要并生成，请稍候…</p></div>';
    const r = b.brief;
    return `<div class="brief-box brief-done"><div class="drawer-section-title">${mode === 'huddle' ? '讨论提纲' : '综述速读'} <small class="ql-flag">模型根据公开摘要生成 · 未经人工核对</small></div>
      <p class="ql-line"><strong>${esc(r.theme)}</strong></p>
      <ol class="brief-papers">${r.papers.map(x => `<li>${esc(x.point)}<small> ——《${esc((r.refs[x.n - 1] || {}).title || '')}》</small></li>`).join('')}</ol>
      <p class="ql-meta"><b>共同点与分歧：</b>${esc(r.compare)}</p>
      <p class="ql-meta"><b>${mode === 'huddle' ? '讨论问题' : '值得追问'}：</b></p><ul>${r.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>
      <p class="ql-meta"><b>证据边界：</b>${esc(r.caveat)}</p></div>`;
  }
  function renderDigestBar(list) {
    const el = $('#aiDigest'); if (!el) return;
    if (list) state._digestList = list;
    const l = state._digestList || [];
    const top = l.filter(p => p.pmid || p.doi).slice(0, 8);
    if (AI_AVAIL !== true || state.mode === 'weekly' || top.length < 2) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false; el.innerHTML = briefHtml('digest', top);
  }
  const AI_ERR = { daily_cap: '今日 AI 解读额度已用完，明天再试。', ip_cap: '你今天的解读次数已达上限。', no_abstract: '各公开渠道都没有找到这篇的摘要。',
    model_failed: '模型输出未通过校验（引句或数字与摘要不符），未保存。可稍后重试。', in_progress: '这篇正在被生成，稍后刷新即可查看。',
    generation_off: 'AI 功能暂未开放。', server: '服务暂时出错，请稍后重试。', need_two: '至少需要 2 篇文献。', bad_key: '这篇缺少 PMID/DOI，无法处理。' };
  function aiInterpret(paper) {
    if (paper._aiState === 'loading') return;
    paper._aiState = 'loading'; openReaderDrawer(paper);
    fetch('/api/ql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pmid: paper.pmid || '', doi: paper.doi || '' }) })
      .then(r => r.json().catch(() => ({ ok: false, error: 'server' })))
      .then(j => {
        if (j.ok && j.ql) { LIVE_QL[qlKey(paper)] = j.ql; paper._aiState = 'done'; }
        else if (j.error === 'no_abstract') { paper._aiState = 'noabs'; }
        else { paper._aiState = 'error'; paper._aiMsg = AI_ERR[j.error] || '生成失败，请稍后重试。'; }
      })
      .catch(() => { paper._aiState = 'error'; paper._aiMsg = '网络错误，请稍后重试。'; })
      .then(() => { if (state.activeDrawerPaper === paper) openReaderDrawer(paper); });
  }
  function hasAbstract(p) { return !!(p.summary || (p.abstractSections||[]).some(x=>x.text) || quicklookOf(p)?.abstract); }
  function datePrecision(p) {
    if (p.datePrecision) return p.datePrecision;
    if (!p.date) return 'unknown';
    if (/^\d{4}-\d{2}$/.test(p.date)) return 'month';
    // Historic import flattened month-level issue dates to the first day. Never assert that day.
    if (p.date.slice(8,10)==='01' && /published-print|正式期号/.test(p.dateBasis||'')) return 'month';
    return 'day';
  }
  function dateLabel(p) { return !p.date ? '日期待核验' : datePrecision(p)==='month' ? p.date.slice(0,7)+' · 刊期' : p.date.slice(0,10); }
  // Cached: this runs inside per-paper filters, so building an Intl formatter each call froze the page on 10k+ rows
  const BJ_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
  let _bj = { t: 0, v: '' };
  function beijingToday() { const n = Date.now(); if (n - _bj.t > 30000) _bj = { t: n, v: BJ_FMT.format(new Date(n)) }; return _bj.v; }
  function safeSourceUrl(p) {
    const val=p.url || (p.doi?'https://doi.org/'+p.doi:'');
    try { const u=new URL(val); return ['https:','http:'].includes(u.protocol)?u.href:''; } catch(e){return '';}
  }
  function inLane(p, lane) {
    if (lane === 'all') return true;
    if (lane === 'crossai') return isCrossAI(p);
    const l = laneOf(p);
    return lane === 'core' ? (l === 'cardio' || l === 'aimed') : l === lane;
  }
  const usesLane = () => state.mode === 'candidates' || state.mode === 'library';

  const RANGES_BY_MODE = {
    candidates: [['7', '近 7 天'], ['14', '近 14 天'], ['30', '近 30 天'], ['90', '近 90 天'], ['365', '近 365 天']],
    library: [['all', '全部时间'], ['30', '近 30 天'], ['90', '近 90 天'], ['365', '近 365 天']]
  };
  function renderRangeBar() {
    const el = $('#rangeBar');
    if (!el) return;
    if (!usesLane()) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<span class="range-label">发表时间</span>' + (RANGES_BY_MODE[state.mode] || RANGES_BY_MODE.library).map(([v, n]) =>
      `<button type="button" class="lane-chip${state.range === v ? ' active' : ''}" data-range="${v}" aria-pressed="${state.range === v}">${n}</button>`).join('')
      + `<span class="range-sep"></span><button type="button" class="lane-chip${state.minor ? ' active' : ''}" data-minor="1" aria-pressed="${state.minor}" title="更正、来信、回复等非原创内容默认隐藏">含更正 / 来信</button>`;
  }
  function renderLaneBar() {
    const el = $('#laneBar');
    if (!el) return;
    if (state.mode === 'curated') {
      const counts = {};
      getCuratedList().forEach(p => (p.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
      const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      el.hidden = tags.length === 0;
      el.innerHTML = tags.length ? `<span class="lane-label">主题</span>` + tags.map(([t, n]) => `<button class="lane-chip ${state.tag === t ? 'active' : ''}" data-filter-tag="${esc(t)}">${esc(t.replace(/^#/, ''))} <small>${n}</small></button>`).join('') : '';
      return;
    }
    if (!usesLane()) { el.hidden = true; el.innerHTML = ''; return; }
    const base = getCurrentDataset();
    el.hidden = false;
    el.innerHTML = LANES.map(l => {
      const n = base.filter(p => inLane(p, l.id) && matchesFilters(p, true)).length;
      return `<button class="lane-chip ${state.lane === l.id ? 'active' : ''}" data-lane="${l.id}">${esc(l.name)} <small>${n}</small></button>`;
    }).join('');
  }

  function publishedDate(p) {
    if (p.autoPick && !(p.draftData && (p.draftData.published || p.draftData.source_date))) return p.autoPick.d;
    return ((p.draftData && (p.draftData.published || p.draftData.source_date)) || '日期待核验').slice(0, 10);
  }

  function radarDefaultCount() {
    const d = new Date(beijingToday() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 13);
    const s0 = d.toISOString().slice(0, 10), t0 = beijingToday();
    return FEEDS.items.filter(p => !p.minor && datePrecision(p) === 'day' && p.date.slice(0, 10) >= s0 && p.date.slice(0, 10) <= t0).length;
  }
  function updateHeaderBadges() {
    const cb = $('#candCountBadge'); if (cb) cb.textContent = radarDefaultCount();
    const cub = $('#curatedCountBadge'); if (cub) cub.textContent = getCuratedList().length;
    const lb = $('#libCountBadge'); if (lb) lb.textContent = LIBRARY.papers.length;

    const up = $('#siteUpdated');
    if (up) {
      up.textContent = `${CONTENT_STATUS.release || ''} · 雷达 ${contentDate(FEEDS.updatedAt)} · 计划每 2 小时查新，内容变化时发布`;
    }
    renderContentStatus();
  }

  function contentDate(value) {
    if (!value) return '尚无记录';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '日期待核验' : d.toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
  }
  function olderThan(value, hours) {
    const time = Date.parse(value || '');
    return !Number.isFinite(time) || Date.now() - time > hours * 3600000;
  }
  function renderContentStatus() {
    const el = $('#contentStatus'); if (!el) return;
    const radar = CONTENT_STATUS.radarUpdatedAt || FEEDS.updatedAt;
    const ai = CONTENT_STATUS.quicklookLatestAt;
    el.innerHTML = `<span><b>自动查新</b> ${esc(contentDate(radar))}${olderThan(radar,6) ? ' · 更新待确认' : ''}</span>` +
      `<span><b>摘要核对导读</b> ${esc(contentDate(CONTENT_STATUS.guideLatestPublishedAt))}</span>` +
      `<span><b>AI 速览</b> ${esc(contentDate(ai))}${olderThan(ai,48) ? ' · 补充中' : ''} · 未经人工核验</span>` +
      `<span><b>全文精读</b> ${currentWeekIssues().length ? '本周已发布' : '本周尚未发布'}</span>`;
  }

  const MODE_NOTES = {
    curated: '带“摘要核对”标记的是已对照期刊摘要核对来源的导读，<b>非全文精读，未经医生终审</b>；带“自动精选”标记的是每天由规则从新文献中选出、附 AI 速览，<b>未经人工核验，请以原文为准</b>。',
    candidates: '<b>默认显示近 14 天文献与 AI 动态，可切换到近 30 / 90 / 365 天。</b>近 14 天来自 RSS 与 PubMed（多数带摘要）；更早的是 PubMed 题录（已关注的心血管与 AI 医学期刊），点“阅读摘要”再取公开摘要。自动聚合条目未经逐篇核对；已核对导读与 AI 速览分别标记。',
    library: '文献档案：按期刊与时间检索既有题录；本站不提供 PDF。没有摘要的条目，可尝试获取公开摘要。刊期按月份显示，日期未知的排在最后。'
  };

  function renderModeNote() {
    const el = $('#modeNote');
    if (!el) return;
    const intro = $('#homeIntro');
    if (intro) intro.hidden = state.mode !== 'curated';
    const note = MODE_NOTES[state.mode];
    el.innerHTML = note || '';
    el.hidden = !note;
  }

  // URL <-> state sync so filtered views are shareable / survive refresh
  function syncUrl() {
    try {
      const u = new URL(window.location.href);
      const set = (k, v, def) => { if (v && v !== def) u.searchParams.set(k, v); else u.searchParams.delete(k); };
      set('mode', state.mode, 'curated');
      set('q', state.search, '');
      set('tier', state.clinicalTier, '');
      set('pub', state.publisher, '');
      set('journal', state.journal, '');
      set('design', state.studyDesign, '');
      set('tag', state.tag, '');
      set('lane', usesLane() ? state.lane : '', 'core');
      set('sort', state.sort, 'date-desc');
      set('range', state.range, defaultRange(state.mode));
      set('minor', state.minor ? '1' : '', '');
      set('reading', usesLane()?state.reading:'', '');
      set('favorites', usesLane()&&state.favoritesOnly ? '1' : '', '');
      set('view', state.viewMode, 'cards');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    } catch (e) { /* file:// or sandboxed */ }
  }

  // Get current dataset based on mode
  function getCurrentDataset() {
    if (state.mode === 'curated') {
      return getCuratedList();
    }
    if (state.mode === 'library') {
      return LIBRARY.papers;
    }
    // Default: candidates
    return FEEDS.items;
  }

  // Filter & Sort
  function matchesFilters(p, skipLane, skip) {
    const q = state.search.trim().toLowerCase();
    if (!skipLane && usesLane() && !inLane(p, state.lane)) return false;
    if (q) {
      const text = [
        p.title, p.draftData?.title_zh, p.titleZh, p.cleanJournal, p.journal, p.publisher, p.doi, p.pmid, p.id,
        p.summary, ...(p.abstractSections||[]).map(x=>x.text), quicklookOf(p)?.title_zh, p.draftData?.summary, ...(p.authors || []), ...(p.tags || []),
        p.quantitativeMetrics?.trialId, p.quantitativeMetrics?.sampleSize
      ].filter(Boolean).join(' ').toLowerCase();
      if (!queryMatches(text, q)) return false;
    }
    if (!state.minor && usesLane() && p.minor) return false;
    if (state.range !== 'all' && usesLane() && (datePrecision(p)!=='day' || p.date.slice(0,10)<rangeStart() || p.date.slice(0,10)>beijingToday())) return false;
    if (usesLane() && state.favoritesOnly && !state.favoriteJournals.includes(p.cleanJournal || p.journal || '')) return false;
    if (usesLane() && state.reading==='abstract' && !hasAbstract(p)) return false;
    if (usesLane() && state.reading==='guide' && !p.hasDraft) return false;
    if (usesLane() && state.reading==='quicklook' && (!quicklookOf(p) || p.hasDraft)) return false;
    if (skip !== 'tier' && state.clinicalTier && p.clinicalTier !== state.clinicalTier) return false;
    if (skip !== 'pub' && state.publisher && p.publisher !== state.publisher) return false;
    if (skip !== 'pub' && state.journal && (p.cleanJournal !== state.journal && p.journal !== state.journal)) return false;
    if (skip !== 'design' && state.studyDesign && p.studyDesign !== state.studyDesign) return false;
    if (skip !== 'tag' && state.tag && (!p.tags || !p.tags.includes(state.tag))) return false;
    return true;
  }

  let _maxDateCache = null;
  function maxDate() {
    if (_maxDateCache && _maxDateCache.ds === getCurrentDataset()) return _maxDateCache.v;
    const ds = getCurrentDataset();
    let v = '';
    ds.forEach(p => { if ((p.date || '') > v && p.date <= '9999') v = p.date; });
    _maxDateCache = { ds, v };
    return v;
  }
  const _rs = { key: '', v: '' };
  function rangeStart() {
    if (state.range === 'all') return '';
    const key = state.range + '|' + beijingToday();
    if (_rs.key === key) return _rs.v;
    const d = new Date(beijingToday() + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - parseInt(state.range, 10) + 1);
    _rs.key = key; _rs.v = d.toISOString().slice(0, 10);
    return _rs.v;
  }
  // Within the same day, papers that come with something to read (guide > AI quick-look > abstract) go first
  function richRank(p) {
    return (p.hasDraft ? 8 : 0) + (quicklookOf(p) ? 4 : 0)
      + (p.media ? 2 + Math.min(4, p.media.reduce((s, m) => s + (m.w || 1), 0)) : 0)
      + (laneOf(p) === 'cardio' || isCrossAI(p) ? 3 : 0) + (p.summary ? 2 : 0) + (p.abstractSections && p.abstractSections.length ? 1 : 0);
  }
  function getFilteredArticles() {
    const list = getCurrentDataset();
    const curated = state.mode === 'curated';
    const arr = list.filter(p => matchesFilters(p, false));
    const jn = p => p.cleanJournal || p.journal || '';
    let jLatest = null;
    if (!curated && state.sort === 'journal-date') {
      jLatest = new Map();
      arr.forEach(p => { const j = jn(p); if ((p.date || '') > (jLatest.get(j) || '')) jLatest.set(j, p.date || ''); });
    }
    return arr.sort((a, b) => {
      if (curated) {
        const c = publishedDate(b).localeCompare(publishedDate(a));
        if (c) return c;
      }
      if (state.sort === 'smart') {
        const d = richRank(b) - richRank(a);
        if (d) return d;
      }
      if (jLatest) {
        const ja = jn(a), jb = jn(b);
        if (ja !== jb) return (jLatest.get(jb) || '').localeCompare(jLatest.get(ja) || '') || ja.localeCompare(jb);
      }
      const da = (a.date || '').slice(0, 10), db = (b.date || '').slice(0, 10);
      if (!da || !db) return da ? -1 : db ? 1 : 0;
      if (state.sort === 'date-asc') return da.localeCompare(db) || richRank(b) - richRank(a);
      return db.localeCompare(da) || richRank(b) - richRank(a);
    });
  }

  // Render Sidebar Filters with dynamic counts
  function renderSidebarFilters() {
    const all = getCurrentDataset();
    const facet = skip => all.filter(p => matchesFilters(p, false, skip));
    const dataset = facet('tier');

    // 1. Clinical Tier Counts
    const tierCounts = {};
    const tiers = [
      { id: '', name: '全部专科', dotClass: 'dot-all' },
      { id: '心血管旗舰顶刊', name: '心血管旗舰顶刊', dotClass: 'dot-flagship' },
      { id: '心律失常与电生理', name: '心律失常与电生理', dotClass: 'dot-ep' },
      { id: '心衰与重症心肌', name: '心衰与重症心肌', dotClass: 'dot-hf' },
      { id: '冠脉介入与结构', name: '冠脉介入与结构', dotClass: 'dot-cad' },
      { id: '心血管影像与表型', name: '心血管影像与表型', dotClass: 'dot-imaging' },
      { id: '脑血管与高血压', name: '脑血管与高血压', dotClass: 'dot-neuro' },
      { id: 'AI医疗与数字医学', name: 'AI医疗与数字医学', dotClass: 'dot-aimed' },
      { id: '顶级综合与科学', name: '顶级综合与科学', dotClass: 'dot-general' },
      { id: '前沿大模型与科技', name: '前沿大模型与科技', dotClass: 'dot-tech' },
      { id: '定向专病与团队', name: '定向专病与团队', dotClass: 'dot-team' }
    ];

    dataset.forEach(p => {
      const t = p.clinicalTier || '综合医学与其他';
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    });

    const tierListEl = $('#tierFilterList');
    if (tierListEl) {
      tierListEl.innerHTML = tiers.filter(t => t.id === '' || tierCounts[t.id] || state.clinicalTier === t.id).map(t => {
        const isAll = t.id === '';
        const count = isAll ? dataset.length : (tierCounts[t.id] || 0);
        const isActive = isAll ? !state.clinicalTier : state.clinicalTier === t.id;

        return `<li>
          <button class="filter-item-btn ${isActive ? 'active' : ''}" data-filter-tier="${esc(t.id)}">
            <span style="display:flex; align-items:center;"><span class="tier-dot ${t.dotClass}"></span>${esc(t.name)}</span>
            <span class="filter-count">${count}</span>
          </button>
        </li>`;
      }).join('');
    }

    // 2. Publisher & Journals Tree (Sorted by prestigious academic hierarchy)
    const PUBLISHER_ORDER = [
      'MMS (NEJM)',
      'The Lancet Group',
      'JAMA Network',
      'AHA (Circulation)',
      'Elsevier / ACC / HRS',
      'Oxford (OUP / ESC)',
      'BMJ Group',
      'Nature Portfolio',
      'Wiley',
      'AAAS (Science)',
      'NAS (PNAS)',
      'PubMed 专题追踪',
      'AI 与科技前沿',
      '其他学术刊物'
    ];

    const pubMap = new Map();
    facet('pub').forEach(p => {
      const pub = p.publisher || '其他学术刊物';
      const j = p.cleanJournal || p.journal || '其他';
      if (!pubMap.has(pub)) pubMap.set(pub, new Map());
      const jMap = pubMap.get(pub);
      jMap.set(j, (jMap.get(j) || 0) + 1);
    });

    const pubAccEl = $('#publisherAccordion');
    if (pubAccEl) {
      // Sort publishers strictly by PUBLISHER_ORDER
      const sortedPubEntries = Array.from(pubMap.entries()).sort((a, b) => {
        let idxA = PUBLISHER_ORDER.indexOf(a[0]);
        let idxB = PUBLISHER_ORDER.indexOf(b[0]);
        if (idxA === -1) idxA = 999;
        if (idxB === -1) idxB = 999;
        return idxA - idxB;
      });

      let accHtml = '';
      for (const [pubName, journals] of sortedPubEntries) {
        const pubTotal = Array.from(journals.values()).reduce((a, b) => a + b, 0);
        const isPubActive = state.publisher === pubName;
        const isOpen = isPubActive;

        // Sort journals inside publisher by volume descending, then name
        const sortedJournals = Array.from(journals.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

        let jHtml = '';
        for (const [jName, jCount] of sortedJournals) {
          const isJActive = state.journal === jName;
          jHtml += `<button class="accordion-journal-btn ${isJActive ? 'active' : ''}" data-filter-journal="${esc(jName)}" data-filter-pub="${esc(pubName)}">
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(jName)}</span>
            <span class="filter-count">${jCount}</span>
          </button>`;
        }

        accHtml += `
          <div class="accordion-group ${isOpen ? 'open' : ''}">
            <button class="accordion-header" data-pub-toggle="${esc(pubName)}">
              <span>${esc(pubName)} (${pubTotal})</span>
              <span class="accordion-arrow">▶</span>
            </button>
            <div class="accordion-content">
              ${jHtml}
            </div>
          </div>
        `;
      }
      pubAccEl.innerHTML = accHtml || '<p class="text-muted" style="padding:10px; font-size:12px;">暂无匹配期刊</p>';
    }

    // 3. Study Design Counts
    const designCounts = {};
    facet('design').forEach(p => {
      const d = p.studyDesign || '研究类型待核验';
      designCounts[d] = (designCounts[d] || 0) + 1;
    });

    const designs = [
      { name: '全部设计', key: '' },
      { name: 'RCT 随机对照', key: 'RCT' },
      { name: '队列研究', key: '队列研究' },
      { name: 'Meta/系统综述', key: 'Meta/综述' },
      { name: '方法/模型验证', key: '方法/模型验证' },
      { name: '指南共识', key: '指南共识' },
      { name: '述评观点', key: '述评观点' },
      { name: '叙述综述', key: '叙述综述' },
      { name: '研究方案', key: '研究方案' },
      { name: '横断面研究', key: '横断面研究' },
      { name: '研究类型待核验', key: '研究类型待核验' }
    ];

    const designListEl = $('#designFilterList');
    if (designListEl) {
      designListEl.innerHTML = designs.map(d => {
        const isAll = d.key === '';
        const count = isAll ? facet('design').length : (designCounts[d.key] || 0);
        const isActive = isAll ? !state.studyDesign : state.studyDesign === d.key;

        return `<li>
          <button class="filter-item-btn ${isActive ? 'active' : ''}" data-filter-design="${esc(d.key)}">
            <span>${d.name}</span>
            <span class="filter-count">${count}</span>
          </button>
        </li>`;
      }).join('');
    }

    // 4. Tags Cloud
    const tagCounts = {};
    facet('tag').forEach(p => {
      (p.tags || []).forEach(t => {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      });
    });

    const tagsCloudEl = $('#tagsCloud');
    if (tagsCloudEl) {
      const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
      tagsCloudEl.innerHTML = sortedTags.map(([tag, count]) => {
        const isActive = state.tag === tag;
        return `<button class="tag-chip ${isActive ? 'active' : ''}" data-filter-tag="${esc(tag)}">
          ${esc(tag)} (${count})
        </button>`;
      }).join('') || '<span class="text-muted" style="font-size:12px;">暂无标签</span>';
    }
  }

  // Render Active Filter Chips
  function renderActiveFilterChips(totalCount) {
    const container = $('#activeFiltersBar');
    if (!container) return;

    let chips = `<span class="results-meta">共找到 <b>${totalCount}</b> 篇文献</span>`;

    if (state.search) {
      chips += `<span class="filter-badge-active">搜索: "${esc(state.search)}" <button class="filter-badge-remove" data-clear="search">&times;</button></span>`;
    }
    if (state.clinicalTier) {
      chips += `<span class="filter-badge-active">专科: ${esc(state.clinicalTier)} <button class="filter-badge-remove" data-clear="tier">&times;</button></span>`;
    }
    if (state.publisher) {
      chips += `<span class="filter-badge-active">出版方: ${esc(state.publisher)} <button class="filter-badge-remove" data-clear="publisher">&times;</button></span>`;
    }
    if (state.range !== defaultRange(state.mode) && usesLane()) {
      chips += `<span class="filter-badge-active">发表时间: ${state.range === 'all' ? '全部时间' : '近 ' + state.range + ' 天'} <button class="filter-badge-remove" data-clear="range">&times;</button></span>`;
    }
    if (state.journal) {
      chips += `<span class="filter-badge-active">期刊: ${esc(state.journal)} <button class="filter-badge-remove" data-clear="journal">&times;</button></span>`;
    }
    if (state.studyDesign) {
      chips += `<span class="filter-badge-active">设计: ${esc(state.studyDesign)} <button class="filter-badge-remove" data-clear="design">&times;</button></span>`;
    }
    if(usesLane() && state.reading) chips+=`<span class="filter-badge-active">可读内容：${esc({'abstract':'有摘要','guide':'已核对导读','quicklook':'AI 速览'}[state.reading])}</span>`;
    if(usesLane() && state.favoritesOnly) chips+='<span class="filter-badge-active">我的期刊（仅此浏览器保存）</span>';
    if (state.tag) {
      chips += `<span class="filter-badge-active">标签: ${esc(state.tag)} <button class="filter-badge-remove" data-clear="tag">&times;</button></span>`;
    }

    container.innerHTML = chips;
  }

  // Render Article Card
  function renderArticleCard(p) {
    const isHuddled = state.huddle.includes(p.id);
    const pubClass = getPublisherClass(p.publisher);
    const designClass = getDesignClass(p.studyDesign);
    const journalName = p.cleanJournal || p.journal || '期刊';
    const dateStr = dateLabel(p);
    const doiUrl = safeSourceUrl(p) || '#';

    const titleEn = esc(p.title);
    const titleZh = p.draftData?.title_zh ? esc(p.draftData.title_zh) : '';

    const tagsHtml = (p.tags || []).map(t => `<span class="tag-pill">${esc(t)}</span>`).join('');
    const qlc = quicklookOf(p);
    const summaryText = esc(p.draftData?.summary || p.summary || (qlc ? 'AI 速览（未核对）：' + qlc.one_line : ('暂无随附摘要，可尝试获取 Europe PMC / PubMed 公开摘要。')));

    return `
      <article class="article-card" data-paper-id="${esc(p.id)}">
        <div class="card-top">
          <div class="meta-badges">
            <span class="journal-badge ${pubClass}">${esc(journalName)}</span>
            <span class="design-pill ${designClass}">${esc(p.studyDesign || '研究类型待核验')}</span>
            ${p.kind ? `<span class="tag-pill kind-pill">${esc(p.kind)}</span>` : ''}
            ${p.autoPick && !p.hasDraft ? `<span class="tag-pill auto-pick-pill" title="由规则从当日新文献中自动选出，AI 速览未经人工核验">自动精选</span>` : ''}
            ${p.clinicalTier ? `<span class="tag-pill" style="border:none; background:transparent; font-weight:500;">${esc(p.clinicalTier)}</span>` : ''}
            ${p.media && p.media.length ? p.media.slice(0, 2).map(m => `<a class="media-pill" href="${esc(m.u)}" target="_blank" rel="noopener noreferrer" title="${esc(m.t)}">媒体关注 · ${esc(m.s)}</a>`).join('') : ''}
          </div>
          <span class="date-badge" title="${esc(p.dateBasis || '来源记录日期，未经逐篇核验')}">${esc(dateStr)}</span>
        </div>

        ${!p.hasDraft && qlc?.title_zh ? `<div class="article-title-zh ql-title"><span class="content-label">机器翻译</span>${esc(qlc.title_zh)}</div>` : ''}
        ${!p.hasDraft && !qlc?.title_zh && p.titleZh ? `<div class="article-title-zh ql-title"><span class="content-label">机器翻译</span>${esc(p.titleZh)}</div>` : ''}
        ${titleZh ? `<div class="article-title-zh"><span class="verified-badge" title="已对照期刊公开摘要核对；非全文精读，未经医生终审">摘要核对</span>${titleZh}</div>` : ''}
        <h3 class="article-title"><button class="title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}">${titleEn}</button></h3>

        <p class="article-abstract">${summaryText}</p>
        ${p.draftData?.limitations ? `<p class="card-limit"><b>证据边界：</b>${esc(p.draftData.limitations)}</p>` : ''}
        ${p.draftData?.learning_question ? `<p class="card-question"><b>共读问题：</b>${esc(p.draftData.learning_question)}</p>` : ''}

        ${tagsHtml ? `<div class="article-card-tags">${tagsHtml}</div>` : ''}

        <div class="card-actions">
          <div class="action-buttons-group">
            <button class="btn-sm btn-primary" data-action="open-drawer" data-paper-id="${esc(p.id)}">${p.hasDraft ? '阅读导读与摘要' : qlc ? '阅读 AI 速览' : '阅读摘要'}</button>
            ${p.hasDraft ? `<button class="btn-sm btn-share" data-action="share-wechat" data-paper-id="${esc(p.id)}">微信群文案</button>` : ''}
            <button class="btn-sm ${isHuddled ? 'active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}">
              ${isHuddled ? '已入晨会 ✓' : '加入晨会单'}
            </button>
          </div>

          <div style="display:flex; align-items:center; gap:10px;">
            ${p.doi ? `<span class="doi-link">DOI: ${esc(p.doi)}</span>` : ''}
            ${doiUrl!=='#' ? `<a href="${esc(doiUrl)}" target="_blank" rel="noopener" class="btn-sm">原文 ↗</a>` : '<span class="text-muted">原文链接待补</span>'}
          </div>
        </div>
      </article>
    `;
  }

  // Render Compact Row
  function renderCompactRow(p) {
    const isHuddled = state.huddle.includes(p.id);
    const pubClass = getPublisherClass(p.publisher);
    const designClass = getDesignClass(p.studyDesign);
    const journalName = p.cleanJournal || p.journal || '期刊';
    const dateStr = dateLabel(p);
    const doiUrl = safeSourceUrl(p) || '#';
    const title = esc(p.draftData?.title_zh ? `[导读] ${p.draftData.title_zh}` : p.title);

    return `
      <div class="compact-row" data-paper-id="${esc(p.id)}">
        <div class="compact-main">
          <button class="compact-title title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}" title="${esc(p.title)}">${title}</button>
          ${!p.hasDraft && p.titleZh ? `<div class="compact-zh">${esc(p.titleZh)}</div>` : ''}
          <div class="compact-meta">
            <span class="journal-badge ${pubClass}" title="${esc(journalName)}">${esc(journalName)}</span>
            <span class="design-pill ${designClass}">${esc(p.studyDesign || '研究类型待核验')}</span>
            ${p.kind ? `<span class="tag-pill kind-pill">${esc(p.kind)}</span>` : ''}
            <span class="date-badge" title="${esc(p.dateBasis || '来源记录日期，未经逐篇核验')}">${esc(dateStr)}</span>
          </div>
        </div>
        <div class="compact-actions">
          <button class="btn-sm" data-action="open-drawer" data-paper-id="${esc(p.id)}" title="速读">速读</button>
          ${p.hasDraft ? `<button class="btn-sm btn-share" data-action="share-wechat" data-paper-id="${esc(p.id)}" title="复制微信文案">文案</button>` : ''}
          <button class="btn-sm ${isHuddled ? 'active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}" title="晨会清单">${isHuddled ? '已入' : '晨会'}</button>
          ${doiUrl!=='#' ? `<a href="${esc(doiUrl)}" target="_blank" rel="noopener" class="btn-sm" title="官网原文">↗</a>` : '<span class="text-muted" title="原文链接待补">—</span>'}
        </div>
      </div>
    `;
  }

  // Main Render Stream
  function renderStream() {
    const streamEl = $('#articlesStream');
    const loadMoreBtn = $('#loadMoreBtn');
    if (!streamEl) return;

    const filtered = getFilteredArticles();
    renderDigestBar(filtered);
    renderActiveFilterChips(filtered.length);
    renderModeNote();
    renderLaneBar();
    renderRangeBar();
    renderBrowseBar();
    { const ss = $('#sortSelector'); if (ss) { ss.hidden = state.mode === 'curated'; ss.value = state.sort; } }
    syncUrl();

    if (filtered.length === 0) {
      streamEl.innerHTML = `
        <div class="empty-state">
          <h3>没有找到匹配的文献</h3>
          <p>${state.mode === 'curated' ? '当前条件下没有精选，可清除筛选或查看文献雷达。' : '尝试清除过滤条件或更换关键词'}</p>
          <button class="btn-sm btn-primary" id="clearAllFiltersBtn" style="margin-top:12px;">重置所有筛选</button>
        </div>
      `;
      if (loadMoreBtn) loadMoreBtn.hidden = true;
      return;
    }

    const pageLen = state.viewMode === 'compact' ? 50 : state.pageSize;
    const visibleItems = filtered.slice(0, state.page * pageLen);

    const groupBy = state.mode === 'curated' ? null : (state.sort === 'journal-date' ? 'journal' : (state.sort === 'date-asc' || state.sort === 'date-desc') ? 'date' : null);
    if (groupBy && state.mode !== 'curated') {
      const maxD = maxDate();
      const recentCut = maxD ? (() => { const d = new Date(maxD.slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 45); return d.toISOString().slice(0, 10); })() : '';
      const keyOf = p => groupBy === 'journal' ? (p.cleanJournal || p.journal || '未标注期刊')
        : (datePrecision(p)==='month' ? p.date.slice(0,7)+' · 刊期（日未核验）' : ((p.date || '') >= recentCut ? (p.date || '日期待核验').slice(0, 10) : ((p.date || '').slice(0, 7) || '日期待核验')));
      const totals = new Map();
      filtered.forEach(p => { const k = keyOf(p); totals.set(k, (totals.get(k) || 0) + 1); });
      const groups = new Map();
      visibleItems.forEach(p => { const k = keyOf(p); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
      const compact = state.viewMode === 'compact';
      streamEl.className = compact ? 'articles-compact-list' : 'articles-stream';
      streamEl.innerHTML = Array.from(groups.entries()).map(([k, arr]) => {
        const first = arr[0].date ? arr[0].date.slice(0, 10) : '';
        const label = groupBy === 'journal' ? `${esc(k)} <small>共 ${totals.get(k)} 篇 · 最新 ${esc((filtered.find(p => (p.cleanJournal || p.journal || '未标注期刊') === k) || {}).date?.slice(0, 10) || '')}</small>` : `${esc(k)} <small>${totals.get(k)} 篇</small>`;
        return `<h2 class="day-heading">${label}</h2>` + arr.map(compact ? renderCompactRow : renderArticleCard).join('');
      }).join('');
    } else if (state.mode === 'curated') {
      streamEl.className = state.viewMode==='compact' ? 'articles-compact-list' : 'articles-stream';
      const groups = new Map();
      visibleItems.forEach(p => {
        const d = publishedDate(p);
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push(p);
      });
      streamEl.innerHTML = Array.from(groups.entries()).map(([d, arr]) =>
        `<h2 class="day-heading">${esc(d)} · 每日精选 <small>${arr.length} 篇</small></h2>` + arr.map(state.viewMode==='compact'?renderCompactRow:renderArticleCard).join('')
      ).join('');
    } else if (state.viewMode === 'compact') {
      streamEl.className = 'articles-compact-list';
      streamEl.innerHTML = visibleItems.map(renderCompactRow).join('');
    } else {
      streamEl.className = 'articles-stream';
      streamEl.innerHTML = visibleItems.map(renderArticleCard).join('');
    }

    if (loadMoreBtn) {
      loadMoreBtn.hidden = visibleItems.length >= filtered.length;
    }
  }

  const DESIGN_TIPS = {
    'RCT': ['主要终点是硬终点（死亡、卒中、再入院）还是替代/软终点？开放标签设计下软终点易受知情偏倚影响。', '看分析集：ITT / mITT / PP 的差别，以及失访和方案违背比例。', '关注绝对获益（ARR/NNT）与安全性事件，而不只是 P 值和 HR。', '入排标准与中心水平：结果能否外推到我们的患者与设备条件？'],
    '队列研究': ['是观察性关联，不能直接当因果；先想混杂（尤其适应证混杂）如何处理。', '暴露与结局的定义是否清晰，随访是否足够、失访是否平衡。', '是否做了敏感性分析或倾向评分匹配，结果是否稳健。'],
    'Meta/综述': ['检索与纳入是否可重复；纳入研究质量与异质性（I²）如何。', '有无发表偏倚；合并不同设计/人群的研究是否合理。', '结论强度是否与纳入证据的质量相匹配。'],
    '方法/模型验证': ['验证对象是测量方法、设备、量表还是预测模型？对照标准和误差定义是否合适。', '是否有独立、外部或前瞻性验证；样本与实际使用场景是否一致。', '按方法选择指标：一致性、重复性或预测性能；预测模型还应看校准和阈值。', '技术表现改善是否转化为临床结局或工作流获益？适用条件和人工复核要求是什么。'],
    '指南共识': ['区分推荐级别（Class）与证据水平（LOE）。', '关注利益冲突声明，以及与国内现行指南的差异。'],
    '述评观点': ['这是观点/评论而非新数据；区分作者立场与被引证据。'],
    '研究类型待核验': ['先确认研究类型（RCT、观察性、模型开发等），再套用对应的评价要点。', '看样本量、对照设置、主要终点与作者自述的局限。']
  };

  function buildCitations(p) {
    const year = (p.date || '').slice(0, 4);
    const j=p.cleanJournal || p.journal || '';
    const journal=/^PubMed:/.test(j)?'期刊待补':j;
    const authors = Array.isArray(p.authors) ? p.authors.filter(Boolean) : [];
    const doi = p.doi || '';
    const gbAuth = authors.length ? (authors.slice(0, 3).join(', ') + (authors.length > 3 ? ', 等' : '') + '. ') : '';
    const amaAuth = authors.length ? (authors.slice(0, 6).join(', ') + (authors.length > 6 ? ', et al' : '') + '. ') : '';
    const gb = `${gbAuth}${p.title}[J]. ${journal}${year ? ', ' + year : ''}${doi ? '. DOI: ' + doi : ''}.`;
    const ama = `${amaAuth}${p.title}. ${journal}.${p.date ? ' '+dateLabel(p)+'.' : ''}${doi ? ' doi:' + doi : ''}`;
    const key = (doi || p.id || 'ref').replace(/[^A-Za-z0-9]+/g, '');
    const bib = `@article{${key},\n  title={${p.title}},\n${authors.length ? '  author={' + authors.join(' and ') + '},\n' : ''}  journal={${journal}},\n${year ? '  year={' + year + '},\n' : ''}${doi ? '  doi={' + doi + '}\n' : ''}}`;
    return { gb, ama, bibtex: bib };
  }

  let lastFocus = null;

  // Slide-over Reader Drawer Open/Close
  function openReaderDrawer(paper) {
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
        <span class="design-pill ${designClass}">${esc(paper.studyDesign || '研究类型待核验')}</span>
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
      if (ql && ql.abstract && !paper.summary && !(paper.abstractSections && paper.abstractSections.length)) {
        paper.abstractSections = [{ label: '', text: ql.abstract }];
        paper._absFetched = true;
        if (!paper.pmid && ql.pmid) paper.pmid = ql.pmid;
      }
      const quickBox = (ql && !draft) ? `
        <div class="drawer-section quicklook">
          <div class="drawer-section-title">AI 速览 <small class="ql-flag">模型根据公开摘要生成 · 未经人工核对</small></div>
          <p class="ql-line"><strong>${esc(ql.one_line)}</strong></p>
          <p class="ql-meta"><span>${esc(ql.design)}</span></p>
          <ul class="ql-findings">${ql.findings.map(f => `<li>${esc(f.text)}<blockquote>${esc(f.quote)}</blockquote></li>`).join('')}</ul>
          <p class="ql-meta"><b>局限：</b>${esc(ql.limits)}</p>
          <p class="ql-meta"><b>为什么值得看：</b>${esc(ql.why_read)}</p>
          <p class="text-muted" style="font-size:11.5px;">要点下方的英文为摘要原句，供你核对；如与原文不符，以原文为准。</p>
          ${(ql.abstractSource || ql.abstract_source) ? `<p class="text-muted" style="font-size:11.5px;">摘要来源：${esc(ql.abstractSource || ql.abstract_source)}${safeSourceUrl({url:ql.abstractSourceUrl || ql.source_url}) ? ` · <a href="${esc(safeSourceUrl({url:ql.abstractSourceUrl || ql.source_url}))}" target="_blank" rel="noopener">查看来源 ↗</a>` : ''}</p>` : ''}
        </div>` : '';
      const aiBox = (!ql && !draft) ? (() => {
        const s = paper._aiState;
        if (s === 'none' || s === 'error') return `<div class="drawer-section quicklook ai-ask">
          <div class="drawer-section-title">AI 解读</div>
          ${s === 'error' ? `<p class="ql-meta" style="color:#b45309;">${esc(paper._aiMsg || '')}</p>` : ''}
          <p class="ql-meta">一键让模型根据公开摘要生成中文解读（约 10–20 秒；本站没有摘要时会依次到 PubMed、OpenAlex、Crossref 和期刊页面去找）。生成后会保存在本站，之后所有读者可直接查看；内容未经人工核对。</p>
          <button class="btn-sm btn-primary" data-action="ai-interpret" data-paper-id="${esc(paper.id)}">一键 AI 解读</button></div>`;
        if (s === 'noabs') return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">AI 解读</div>
          <p class="ql-meta">已依次查询 Europe PMC、PubMed、OpenAlex、Crossref 和期刊页面的公开元数据，都没有这篇的摘要（多见于读者来信、述评、新闻），所以不生成解读，以免编造。请直接看原文。</p>
          ${!paper.titleZh ? `<button class="btn-sm" data-action="ai-title" data-paper-id="${esc(paper.id)}">只翻译标题</button>` : ''}${paper._ttMsg ? `<span class="ql-meta" style="color:#b45309;"> ${esc(paper._ttMsg)}</span>` : ''}</div>`;
        if (s === 'loading') return `<div class="drawer-section quicklook ai-ask"><div class="drawer-section-title">AI 解读</div><p class="ql-meta">正在读取公开摘要并生成解读，请稍候…</p></div>`;
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

      // Generic reading tips by study design (NOT a paper-specific appraisal)
      const tips = DESIGN_TIPS[paper.studyDesign] || DESIGN_TIPS['研究类型待核验'];
      const appraisalSection = `
        <div class="drawer-section" style="border-top:1px dashed var(--border); padding-top:14px;">
          <details class="reading-tips">
            <summary>阅读这类研究要看什么 <small>（按研究类型的通用提示，不是对本文的评价）</small></summary>
            <ul>${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
          </details>
        </div>
      `;

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

      bodyEl.innerHTML = `
        <div class="drawer-meta-line">
          <span style="font-size:12px; color:var(--text-muted);">${esc(paper.publisher || '')} · ${esc(paper.clinicalTier || '')}</span>
          ${paper.doi ? `<span class="doi-link" style="margin-left:auto;">DOI: ${esc(paper.doi)}</span>` : ''}
        </div>

        ${!draft && ql?.title_zh ? `<div class="drawer-title-zh"><small class="content-label">机器翻译</small>${esc(ql.title_zh)}</div>` : ''}
        ${!draft && !ql?.title_zh && paper.titleZh ? `<div class="drawer-title-zh"><small class="content-label">机器翻译</small>${esc(paper.titleZh)}</div>` : ''}
        ${draft?.title_zh ? `<div class="drawer-title-zh">${esc(draft.title_zh)}</div>` : ''}
        <h2 class="drawer-title-en">${esc(paper.title)}</h2>

        ${authorBox}

        ${tagsHtml ? `<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px;">${tagsHtml}</div>` : ''}

        ${quantBox ? `<details class="metric-details"><summary>摘要自动提取的数字（请对照下方原文核验）</summary>${quantBox}</details>` : ''}

        ${editorialSection}

        ${quickBox}${aiBox}

        <div class="drawer-section">
          <div class="drawer-section-title">公开摘要 · 原文</div>
          <div class="structured-abstract">
            ${abstractHtml}${absSource}
          </div>
          ${hasAbstract ? trBoxHtml(paper) : ''}
        </div>

        ${(hasAbstract || draft) ? appraisalSection : ''}

        ${citationSection}
      `;
    }

    // Footer buttons
    const huddleBtn = $('#drawerHuddleToggleBtn');
    if (huddleBtn) {
      huddleBtn.textContent = isHuddled ? '已在晨会单 ✓' : '加入晨会单';
      huddleBtn.className = `btn-sm ${isHuddled ? 'active' : ''}`;
    }

    const shareBtn = $('#drawerCopyShareBtn');
    if (shareBtn) shareBtn.hidden = !paper.hasDraft;
    const extLink = $('#drawerExternalLink');
    if (extLink) {
      extLink.href = doiUrl; extLink.hidden=doiUrl==='#';
    }

    if (!drawer.classList.contains('open')) lastFocus = document.activeElement;
    drawer.classList.add('open');
    backdrop.classList.add('open');
    if (lastFocus && !drawer.contains(document.activeElement)) $('#drawerCloseBtn')?.focus({ preventScroll: true });
    document.body.classList.add('dialog-open');
    drawer.setAttribute('aria-hidden','false');

    if (!paper.hasDraft && !quicklookOf(paper)) aiApiCheck(paper);
    trCheck(paper);

    // No abstract in our data? Fetch the public one from Europe PMC (free, no API key).
    const needsAbs = !paper.summary && !(paper.abstractSections && paper.abstractSections.length) && (paper.doi || paper.pmid) && !paper._absTries;
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
        } else {
          paper._absState = 'none';
        }
      }).catch(() => { paper._absState = 'error'; }).then(() => {
        if (state.activeDrawerPaper === paper) openBodyOnly(paper);
      });
    }
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

  function closeReaderDrawer() {
    if (state.activeDrawerPaper && state.activeDrawerPaper._absState === 'error') { state.activeDrawerPaper._absTries = 0; state.activeDrawerPaper._absState = ''; }
    state.activeDrawerPaper = null;
    const drawer = $('#readerDrawer');
    const backdrop = $('#drawerBackdrop');
    if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); }
    document.body.classList.remove('dialog-open');
    if (backdrop) backdrop.classList.remove('open');
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    lastFocus = null;
  }

  // Morning Huddle Modal Logic
  function updateHuddleCounter() {
    const counter = $('#huddleCounter');
    if (counter) counter.textContent = state.huddle.length;
    safeSet('xinzhi_huddle_ids', JSON.stringify(state.huddle));
  }

  let huddleLastFocus=null;
  function openHuddleModal() {
    const modal = $('#huddleModalBackdrop');
    const body = $('#huddleModalBody');
    if (!modal || !body) return;

    const list = state.huddle.map(id => allPapersMap.get(id)).filter(Boolean);

    if (list.length === 0) {
      body.innerHTML = `
        <div class="empty-state" style="padding:30px;">
          <p>晨会清单当前为空</p>
          <small style="color:var(--text-muted);">从文献列表中点击“加入晨会单”，即可将心仪文献加入讨论清单。</small>
        </div>
      `;
    } else {
      body.innerHTML = list.map((p, i) => `
        <div class="huddle-item">
          <div class="huddle-item-content">
            <h4>${i + 1}. ${esc(p.draftData?.title_zh || p.title)}</h4>
            <div class="huddle-item-meta">
              <span>${esc(p.cleanJournal || p.journal)}</span> · 
              <span>${esc(p.studyDesign || '研究类型待核验')}</span> · 
              <span>${esc(p.date ? p.date.slice(0, 10) : '')}</span>
            </div>
          </div>
          <button class="btn-sm" data-action="remove-huddle" data-paper-id="${esc(p.id)}">移出</button>
        </div>
      `).join('') + (AI_AVAIL === true ? briefHtml('huddle', list) : '');
    }

    if(!modal.classList.contains('open')) huddleLastFocus=document.activeElement;
    modal.classList.add('open'); document.body.classList.add('dialog-open');
    $('#closeHuddleModalBtn')?.focus({preventScroll:true});
  }

  function closeHuddleModal() {
    const modal = $('#huddleModalBackdrop');
    if (modal) modal.classList.remove('open');
    if(!$('#readerDrawer.open')) document.body.classList.remove('dialog-open');
    huddleLastFocus?.focus({preventScroll:true});huddleLastFocus=null;
  }

  // Export Huddle Markdown
  function exportHuddleMarkdown() {
    const list = state.huddle.map(id => allPapersMap.get(id)).filter(Boolean);
    if (!list.length) {
      showToast('清单为空，无法导出');
      return;
    }

    const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    let md = `# 心知文献情报 · 晨会研讨清单 (${todayStr})\n\n`;
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
      if (p.doi) md += `- **DOI / 原文**：[${p.doi}](${url})\n`;
      md += `- **核心速览**：${p.draftData?.summary || p.summary || '待讨论'}\n`;
      if (p.draftData?.limitations) md += `- **证据边界**：${p.draftData.limitations}\n`;
      if (p.draftData?.learning_question) md += `- **晨会思考题**：${p.draftData.learning_question}\n`;
      md += `\n---\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `晨会文献清单-${todayStr}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
    showToast('已导出 Markdown 清单');
  }

  // Copy Huddle Batch Summary for WeChat
  function copyHuddleSummary() {
    const list = state.huddle.map(id => allPapersMap.get(id)).filter(Boolean);
    if (!list.length) {
      showToast('清单为空');
      return;
    }
    const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    let text = `【心知文献情报 · 晨会研讨速递】(${todayStr})\n\n`;
    list.forEach((p, i) => {
      const title = p.draftData?.title_zh || p.title;
      const journal = p.cleanJournal || p.journal;
      const design = p.studyDesign || '研究';
      text += `${i + 1}. [${journal} | ${design}] ${title}\n`;
      if (p.draftData?.summary) text += `   要点：${p.draftData.summary.slice(0, 100)}...\n`;
      text += `   原文：${safeSourceUrl(p)}\n\n`;
    });
    copyToClipboard(text, '已复制晨会汇总文字');
  }

  // Render Sources Health Grid
  function renderSourcesHealth() {
    const grid = $('#sourcesHealthGrid');
    const meta = $('#sourcesHealthMeta');
    if (!grid) return;

    const sources = HEALTH.sources || [];
    const successful = s => ['ok','empty_feed','filtered_empty'].includes(s.status);
    const okCount = sources.filter(successful).length;

    if (meta) {
      meta.textContent = `信源共 ${sources.length} 个 · 本轮获取成功 ${okCount} 个 · 最近自检：${contentDate(HEALTH.checkedAt)}（北京时间）${olderThan(HEALTH.checkedAt,6) ? ' · 报告已过期，不能代表当前可用率' : ''}`;
    }

    grid.innerHTML = sources.map(s => {
      const isOk = successful(s);
      const statusLabel = s.status === 'empty_feed' ? '有效空源' : s.status === 'filtered_empty' ? '近 14 天无新条目' : isOk ? '获取成功' : '获取异常';
      return `
        <div class="source-item">
          <div class="source-item-name">
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(s.name)}</span>
            <span class="source-status-badge ${isOk ? 'source-status-ok' : 'source-status-err'}">
              ${esc(statusLabel)}
            </span>
          </div>
          <div style="font-size:11px; color:var(--text-muted); display:flex; justify-content:space-between;">
            <span>原始条数: ${isOk ? (s.rawItems ?? s.items ?? 0) : '未获取'} · 近 14 天: ${s.eligibleItems ?? '待统计'}</span>
            <span>含摘要: ${s.itemsWithAbstracts || 0}</span>
          </div>
          ${s.cachedItems ? `<small>保留 ${esc(s.cachedItems)} 条旧缓存 · 最近缓存 ${esc(contentDate(s.lastCachedFetchAt || s.lastSuccessfulAt))}</small>` : ''}
          <a href="${esc(s.url)}" target="_blank" rel="noopener" style="font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--accent);">
            ${esc(s.url)} ↗
          </a>
        </div>
      `;
    }).join('');
  }

  // Switch App Mode (Candidates, Curated, Library, Weekly, Sources)
  function switchMode(newMode, keepRange) {
    if (!keepRange && newMode !== state.mode) state.range = defaultRange(newMode);
    state.mode = newMode;
    state.page = 1;

    // Toggle active nav tab
    $$('.nav-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === newMode);
    });

    // Toggle main sections
    const streamSection = $('#streamSection');
    const weeklySection = $('#weeklySection');
    const sourcesSection = $('#sourcesSection');
    const sidebar = $('#appSidebar');

    if (streamSection) streamSection.hidden = (newMode === 'weekly' || newMode === 'sources');
    if (weeklySection) weeklySection.hidden = (newMode !== 'weekly');
    if (sourcesSection) sourcesSection.hidden = (newMode !== 'sources');
    const noSidebar = (newMode === 'weekly' || newMode === 'sources' || newMode === 'curated');
    if (sidebar) sidebar.style.display = noSidebar ? 'none' : '';
    const ftb = $('#filterToggleBtn');
    if (ftb) ftb.hidden = noSidebar;
    if (sidebar) sidebar.classList.remove('open');

    const appContainer = $('.app-container');
    if (appContainer) {
      appContainer.classList.toggle('full-width-layout', noSidebar);
    }
    window.scrollTo({ top: 0 });

    if (newMode === 'sources') {
      renderSourcesHealth();
      syncUrl();
    } else if (newMode === 'weekly') {
      renderWeeklyHeader();
      renderNextCandidates();
      syncUrl();
    } else {
      renderSidebarFilters();
      renderStream();
    }
  }

  const ISSUES = [
    { no: 1, demo: true, published: '2026-09-29', title: 'AI 指导的持续性房颤消融：获益与临床边界', meta: 'TAILORED-AF · Nature Medicine 2025 · 全文精读' }
  ];

  function isoWeekStart(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (x.getDay() + 6) % 7; // Mon=0
    x.setDate(x.getDate() - day);
    return x;
  }
  function currentWeekIssues() {
    const today = new Date(beijingToday() + 'T12:00:00');
    const start = isoWeekStart(today), end = new Date(start); end.setDate(end.getDate() + 7);
    return ISSUES.filter(i => !i.demo && (() => { const t = new Date(i.published + 'T12:00:00'); return t >= start && t < end; })());
  }

  function renderWeeklyHeader() {
    const status = $('#weeklyStatus');
    const list = $('#issueList');
    const now = new Date(beijingToday() + 'T12:00:00');
    const ws = isoWeekStart(now);
    const we = new Date(ws); we.setDate(we.getDate() + 7);
    const fmt = d => d.toISOString ? `${d.getMonth() + 1}/${d.getDate()}` : '';
    const thisWeek = currentWeekIssues();
    if (status) {
      status.innerHTML = thisWeek.length
        ? `本周（${fmt(ws)}–${fmt(new Date(we.getTime() - 86400000))}）精读已发布：第 ${String(thisWeek[0].no).padStart(2, '0')} 期。`
        : `<b>本周（${fmt(ws)}–${fmt(new Date(we.getTime() - 86400000))}）全文精读尚未发布。</b>下方「近 7 天文献榜」随内容刷新（约每 2 小时）自动更新，可阅读已取得的原摘要；全文精读需取得全文并完成审查后发布，第 01 期为体例示范。`;
    }
    renderWeeklyAuto();
    if (list) {
      list.innerHTML = ISSUES.map(i => `<button class="issue-card" data-issue="${i.no}"><b>第 ${String(i.no).padStart(2, '0')} 期 · ${esc(i.published)}</b>${esc(i.title)}<br><small>${esc(i.meta)}</small></button>`).join('');
    }
  }

  function renderWeeklyAuto() {
    const el = $('#weeklyAuto'); if (!el) return;
    const items = FEEDS.items.filter(p => p.weeklyPick).sort((a, b) => a.weeklyPick - b.weeklyPick);
    if (!items.length) { el.innerHTML = ''; return; }
    const at = items.map(p => p.weeklyAt).filter(Boolean)[0];
    let upd = '';
    if (at) { try { upd = new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { upd = ''; } }
    el.innerHTML = `<h3 class="next-title">近 7 天文献榜 <small>${upd ? '更新于 ' + upd + '（北京时间）；' : ''}按专科相关性、研究类型、期刊与媒体关注度规则排序；原摘要与 AI 速览分别标注，请以原文为准。</small></h3>` +
      items.map((p, i) => {
        const q = quicklookOf(p), zh = (q && q.title_zh) || p.titleZh || '';
        const med = (p.media || []).slice(0, 1).map(m => `<a class="media-pill" href="${esc(m.u)}" target="_blank" rel="noopener noreferrer" title="${esc(m.t)}">媒体关注 · ${esc(m.s)}</a>`).join('');
        return `<div class="next-item weekly-auto-item"><span class="weekly-rank">${i + 1}</span><div><span class="journal-badge ${getPublisherClass(p.publisher)}">${esc(p.cleanJournal || p.journal)}</span> <span class="design-pill ${getDesignClass(p.studyDesign)}">${esc(p.studyDesign || '研究类型待核验')}</span> ${med} <span class="date-badge">${esc((p.date || '').slice(0, 10))}</span>` +
          `<div class="weekly-auto-title"><a href="${esc(p.url || ('https://doi.org/' + p.doi))}" target="_blank" rel="noopener noreferrer">${esc(zh || p.title)}</a></div>` +
          (zh ? `<div class="weekly-auto-en">${esc(p.title)}</div>` : '') +
          (q && q.one_line ? `<div class="weekly-auto-line"><span class="content-label">AI 速览 · 未经人工核验</span>${esc(q.one_line)}</div>` : '') +
          ((p.abstractSections?.length || p.summary) ? `<details class="weekly-abstract"><summary>阅读原摘要</summary><p>${esc(p.abstractSections?.length ? p.abstractSections.map(s => (s.label ? s.label + ': ' : '') + s.text).join('\n\n') : p.summary)}</p></details>` : '<small>摘要待补充</small>') + `</div></div>`;
      }).join('');
  }

  function renderNextCandidates() {
    const el = $('#nextCandidates');
    if (!el) return;
    const okDesign = new Set(['RCT', '方法/模型验证', 'Meta/综述', '队列研究']);
    const top = new Set(['New England Journal of Medicine', 'The Lancet', 'JAMA', 'JAMA Cardiology', 'European Heart Journal', 'JACC', 'Circulation', 'Nature Medicine', 'npj Digital Medicine', 'EHJ-Digital Health', 'EHJ - Digital Health', 'European Heart Journal - Digital Health']);
    const score = p => (okDesign.has(p.studyDesign) ? 2 : 0) + (top.has(p.cleanJournal) ? 2 : 0) + ((p.tags || []).some(t => t !== '#大模型/NLP') ? 1 : 0) + (AI_RE.test(p.title) ? 2 : 0) + (isCrossAI(p) ? 3 : (laneOf(p) === 'cardio' ? 2 : 0));
    const list = LIBRARY.papers
      .filter(p => p.localAvailable === true && okDesign.has(p.studyDesign) && (p.date || '') >= '2026-01' && laneOf(p) !== 'general' && laneOf(p) !== 'aitech')
      .map(p => [score(p), p]).filter(x => x[0] >= 4)
      .sort((a, b) => b[0] - a[0] || (b[1].date || '').localeCompare(a[1].date || ''))
      .slice(0, 5).map(x => x[1]);
    if (!list.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<h3 class="next-title">下期候选 <small>科室文献库里有全文 PDF 的近期心血管 / AI 论文，优先心血管与“心血管 × AI”，按研究类型与期刊自动排序，<b>尚未评估质量</b>；编辑会从中选定。想推荐哪篇就加入晨会单。</small></h3>` +
      list.map(p => `<div class="next-item"><div><span class="journal-badge ${getPublisherClass(p.publisher)}">${esc(p.cleanJournal || p.journal)}</span> <span class="design-pill ${getDesignClass(p.studyDesign)}">${esc(p.studyDesign || '研究类型待核验')}</span> <span class="date-badge">${esc((p.date || '').slice(0, 10))}</span></div><div class="next-item-title">${esc(p.title)}</div><div class="next-item-actions"><button class="btn-sm ${state.huddle.includes(p.id) ? 'active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}">${state.huddle.includes(p.id) ? '已入晨会 ✓' : '加入晨会单'}</button><a class="btn-sm" target="_blank" rel="noopener" href="${esc(p.url || (p.doi ? 'https://doi.org/' + p.doi : '#'))}">原文 ↗</a></div></div>`).join('');
  }

  function renderBrowseBar() {
    const bar=$('#browseBar'); if(!bar)return;
    bar.hidden=!usesLane(); if(bar.hidden)return;
    const journals=[...new Set(getCurrentDataset().map(p=>p.cleanJournal||p.journal).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    const sel=$('#journalSelect');
    sel.innerHTML='<option value="">所有期刊 / 信源</option>'+journals.map(j=>`<option value="${esc(j)}" ${state.journal===j?'selected':''}>${state.favoriteJournals.includes(j)?'★ ':''}${esc(j)}</option>`).join('');
    $('#readingSelect').value=state.reading;
    const star=$('#favoriteJournalBtn');star.disabled=!state.journal;star.textContent=state.favoriteJournals.includes(state.journal)?'★ 已关注':'☆ 关注期刊';star.setAttribute('aria-pressed',String(state.favoriteJournals.includes(state.journal)));
    const fav=$('#favoritesOnlyBtn');fav.textContent='我的期刊 '+state.favoriteJournals.length;fav.classList.toggle('active',state.favoritesOnly);fav.setAttribute('aria-pressed',String(state.favoritesOnly));
    const period=$('#rangeExplanation');period.textContent=state.range==='all'?'日期与研究类型均以来源信息为准；未知项明确保留。':`北京时间 ${rangeStart()} 至 ${beijingToday()}；不含日期未知及仅有刊期的条目。`;
  }
  $('#journalSelect')?.addEventListener('change',e=>{state.journal=e.target.value;state.publisher='';state.page=1;renderSidebarFilters();renderStream();});
  $('#readingSelect')?.addEventListener('change',e=>{state.reading=e.target.value;state.page=1;renderSidebarFilters();renderStream();});
  $('#favoriteJournalBtn')?.addEventListener('click',()=>{if(!state.journal)return; const f=state.favoriteJournals;state.favoriteJournals=f.includes(state.journal)?f.filter(j=>j!==state.journal):[...f,state.journal];safeSet('xz_favorite_journals',JSON.stringify(state.favoriteJournals));renderSidebarFilters();renderStream();});
  $('#favoritesOnlyBtn')?.addEventListener('click',()=>{state.favoritesOnly=!state.favoritesOnly;state.page=1;renderSidebarFilters();renderStream();});

  // Reset Filters
  function resetAllFilters() {
    state.search = '';
    state.clinicalTier = '';
    state.publisher = '';
    state.journal = '';
    state.studyDesign = '';
    state.tag = '';
    state.range = defaultRange(state.mode);
    state.lane = 'core'; state.reading=''; state.favoritesOnly=false;
    state.page = 1;
    const sInput = $('#globalSearch');
    if (sInput) sInput.value = '';
    renderSidebarFilters();
    renderStream();
  }

  // ==================== Event Listeners ====================

  // Header Nav Tab Clicks
  $$('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
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
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  // Global Search Input with debounce
  let searchTimer = null;
  const searchInput = $('#globalSearch');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value.trim();
        state.page = 1;
        renderSidebarFilters();
        renderStream();
      }, 180);
    });
  }

  // Hotkey '/' for search
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput?.focus();
    } else if (e.key === 'Tab') {
      const modal=$('#huddleModalBackdrop.open .modal-dialog') || $('#readerDrawer.open');
      if (modal) {const nodes=[...modal.querySelectorAll('button,a[href],input,select,summary,[tabindex="0"]')].filter(x=>!x.hidden && x.getClientRects().length);const first=nodes[0],last=nodes[nodes.length-1]; if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus();} else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus();}}
    } else if (e.key === 'Escape') {
      closeReaderDrawer();
      closeHuddleModal();
    }
  });

  document.addEventListener('click', e => {
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
      safeSet('xinzhi_view_mode', 'cards');
      btnCards.classList.add('active');
      btnCompact.classList.remove('active');
      renderStream();
    });
    btnCompact.addEventListener('click', () => {
      state.viewMode = 'compact';
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
  $('#resetTierBtn')?.addEventListener('click', () => {
    state.clinicalTier = '';
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  });
  $('#resetPubBtn')?.addEventListener('click', () => {
    state.publisher = '';
    state.journal = '';
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  });
  $('#resetDesignBtn')?.addEventListener('click', () => {
    state.studyDesign = '';
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  });
  $('#resetTagBtn')?.addEventListener('click', () => {
    state.tag = '';
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  });

  // Global Document Clicks Delegation
  document.addEventListener('click', e => {
    // 1. Clinical Tier click
    const tierBtn = e.target.closest('[data-filter-tier]');
    if (tierBtn) {
      state.clinicalTier = (state.clinicalTier === tierBtn.dataset.filterTier) ? '' : tierBtn.dataset.filterTier;
      state.page = 1;
      renderSidebarFilters();
      renderStream();
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

    // 2. Publisher Accordion toggle
    const pubToggle = e.target.closest('[data-pub-toggle]');
    if (pubToggle) {
      const group = pubToggle.closest('.accordion-group');
      if (group) group.classList.toggle('open');
      const pubName = pubToggle.dataset.pubToggle;
      state.publisher = state.publisher === pubName ? '' : pubName;
      state.journal = '';
      state.page = 1;
      renderSidebarFilters();
      renderStream();
      return;
    }

    // 3. Journal filter click
    const jBtn = e.target.closest('[data-filter-journal]');
    if (jBtn) {
      const jName = jBtn.dataset.filterJournal;
      state.journal = state.journal === jName ? '' : jName;
      state.publisher = jBtn.dataset.filterPub || state.publisher;
      state.page = 1;
      renderSidebarFilters();
      renderStream();
      return;
    }

    // 4. Study Design filter click
    const designBtn = e.target.closest('[data-filter-design]');
    if (designBtn) {
      state.studyDesign = (state.studyDesign === designBtn.dataset.filterDesign) ? '' : designBtn.dataset.filterDesign;
      state.page = 1;
      renderSidebarFilters();
      renderStream();
      return;
    }

    // 5. Tag chip click
    const tagBtn = e.target.closest('[data-filter-tag]');
    if (tagBtn) {
      const t = tagBtn.dataset.filterTag;
      state.tag = state.tag === t ? '' : t;
      state.page = 1;
      renderSidebarFilters();
      renderStream();
      return;
    }

    // 6. Clear active filter badge
    const clearBtn = e.target.closest('[data-clear]');
    if (clearBtn) {
      const type = clearBtn.dataset.clear;
      if (type === 'search') { state.search = ''; if (searchInput) searchInput.value = ''; }
      if (type === 'tier') state.clinicalTier = '';
      if (type === 'publisher') { state.publisher = ''; state.journal = ''; }
      if (type === 'journal') state.journal = '';
      if (type === 'range') state.range = defaultRange(state.mode);
      if (type === 'design') state.studyDesign = '';
      if (type === 'tag') state.tag = '';
      state.page = 1;
      renderSidebarFilters();
      renderStream();
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
    const briefAction = e.target.closest('[data-action="ai-brief"]');
    if (briefAction) {
      const mode = briefAction.dataset.mode;
      if (mode === 'huddle') aiBrief('huddle', state.huddle.map(id => allPapersMap.get(id)).filter(Boolean), openHuddleModal);
      else aiBrief('digest', (state._digestList || []).filter(p => p.pmid || p.doi).slice(0, 8), () => renderDigestBar());
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
      const paperId = huddleAction.dataset.paperId;
      if (state.huddle.includes(paperId)) {
        state.huddle = state.huddle.filter(id => id !== paperId);
        showToast('已从晨会单移出');
      } else {
        state.huddle.push(paperId);
        showToast('已加入晨会研讨清单');
      }
      updateHuddleCounter();
      renderStream();
      if (state.mode === 'weekly') renderNextCandidates();
      if (state.activeDrawerPaper?.id === paperId) {
        openReaderDrawer(state.activeDrawerPaper);
      }
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
  $('#drawerCloseBtn')?.addEventListener('click', closeReaderDrawer);
  $('#drawerBackdrop')?.addEventListener('click', closeReaderDrawer);

  $('#drawerCopyShareBtn')?.addEventListener('click', () => {
    if (state.activeDrawerPaper) {
      const text = generateWeChatShareText(state.activeDrawerPaper);
      copyToClipboard(text, '已复制微信群精炼分享文案');
    }
  });

  $('#drawerHuddleToggleBtn')?.addEventListener('click', () => {
    if (state.activeDrawerPaper) {
      const paperId = state.activeDrawerPaper.id;
      if (state.huddle.includes(paperId)) {
        state.huddle = state.huddle.filter(id => id !== paperId);
        showToast('已从晨会单移出');
      } else {
        state.huddle.push(paperId);
        showToast('已加入晨会研讨清单');
      }
      updateHuddleCounter();
      renderStream();
      openReaderDrawer(state.activeDrawerPaper);
    }
  });

  // Load More Button
  $('#loadMoreBtn')?.addEventListener('click', () => {
    state.page += 1;
    renderStream();
  });

  // Morning Huddle Modal Events
  $('#openHuddleBtn')?.addEventListener('click', openHuddleModal);
  $('#closeHuddleModalBtn')?.addEventListener('click', closeHuddleModal);
  $('#huddleModalBackdrop')?.addEventListener('click', e => {
    if (e.target.id === 'huddleModalBackdrop') closeHuddleModal();
  });
  $('#exportHuddleMdBtn')?.addEventListener('click', exportHuddleMarkdown);
  $('#copyHuddleSummaryBtn')?.addEventListener('click', copyHuddleSummary);
  $('#clearHuddleBtn')?.addEventListener('click', () => {
    state.huddle = [];
    updateHuddleCounter();
    openHuddleModal();
    renderStream();
    showToast('已清空晨会清单');
  });

  // Initialize
  updateHeaderBadges();
  updateHuddleCounter();
  renderSidebarFilters();
  if (!['curated', 'weekly', 'candidates', 'library', 'sources'].includes(state.mode)) state.mode = 'curated';
  if (searchInput && state.search) searchInput.value = state.search;
  switchMode(state.mode, true);
  fetch('/api/ql?k=pmid:1', { headers: { accept: 'application/json' } }).then(r => r.ok ? r.json() : Promise.reject())
    .then(j => { AI_AVAIL = !!(j && j.canGenerate); renderDigestBar(); }).catch(() => { AI_AVAIL = false; });

  if (urlParams.get('drawer') === 'first') {
    const list = getFilteredArticles();
    if (list.length > 0) openReaderDrawer(list[0]);
  }

})();

;(function () { /* 界面风格选择器:页眉按钮 + 菜单,记住读者的选择 */
  const STYLES = [
    ['a', '临床期刊', '白底蓝灰，盒状卡片，稳重专业', '#1b4f9c'],
    ['b', '资讯榜单', '编号列表，信息密度高，扫读最快', '#d13a1f'],
    ['c', '卡片杂志', '浅灰底大圆角卡片，轻松友好', '#0b8f7e'],
    ['d', '纸感', '米色纸张质感，安静耐读', '#9b2335']
  ];
  const BAR = { // 浏览器地址栏/状态栏颜色，跟随页眉，避免顶部出现突兀的色块
    light: { a: '#ffffff', b: '#d13a1f', c: '#ffffff', d: '#f5f2ea' },
    dark:  { a: '#141d2b', b: '#b8321a', c: '#1c2024', d: '#14120f' }
  };
  const root = document.documentElement;
  const get = () => { try { return localStorage.getItem('xz-style'); } catch (e) { return null; } };
  const put = v => { try { localStorage.setItem('xz-style', v); } catch (e) {} };
  const valid = v => STYLES.some(x => x[0] === v);
  function syncBar() {
    const m = document.querySelector('meta[name="theme-color"]'); if (!m) return;
    const t = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    m.setAttribute('content', BAR[t][root.dataset.style] || '#ffffff');
  }
  let st = new URLSearchParams(location.search).get('style');
  if (!valid(st)) st = get();
  if (!valid(st)) st = 'a';
  root.dataset.style = st; put(st);
  new MutationObserver(syncBar).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-style'] });
  syncBar();

  const btn = document.getElementById('styleBtn'), menu = document.getElementById('styleMenu'), label = document.getElementById('styleBtnLabel');
  if (!btn || !menu) return;
  const name = k => (STYLES.find(x => x[0] === k) || [])[1] || '风格';
  function paint() {
    label.textContent = name(root.dataset.style);
    menu.innerHTML = '<div class="style-menu-head">选择你喜欢的界面风格</div>' + STYLES.map(([k, n, d, c]) =>
      `<button type="button" role="menuitemradio" class="style-opt" data-s="${k}" aria-checked="${k === root.dataset.style}">` +
      `<span class="style-swatch" style="background:${c}">${k.toUpperCase()}</span>` +
      `<span class="style-opt-text"><b>${n}</b><small>${d}</small></span>` +
      `<span class="style-opt-check">${k === root.dataset.style ? '✓' : ''}</span></button>`).join('');
  }
  function setOpen(o) {
    menu.hidden = !o; btn.setAttribute('aria-expanded', String(o));
    if (o) { paint(); (menu.querySelector('[aria-checked="true"]') || menu.querySelector('.style-opt'))?.focus(); }
  }
  btn.addEventListener('click', e => { e.stopPropagation(); setOpen(menu.hidden); });
  menu.addEventListener('click', e => {
    const b = e.target.closest('.style-opt'); if (!b) return;
    root.dataset.style = b.dataset.s; put(b.dataset.s); paint(); label.textContent = name(b.dataset.s);
    setOpen(false); btn.focus();
  });
  document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('#stylePicker')) setOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { setOpen(false); btn.focus(); } });
  label.textContent = name(root.dataset.style);
})();

;(function () { /* 页面开着时发现新版本就提示刷新；后台计划每 2 小时查新 */
  let tag = null, shown = false;
  async function probe() {
    if (shown || document.hidden) return;
    try {
      const r = await fetch('/?_=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
      const t = r.headers.get('etag') || r.headers.get('last-modified'); if (!t) return;
      if (tag === null) { tag = t; return; }
      if (t !== tag) notify();
    } catch (e) {}
  }
  function notify() {
    shown = true;
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = '内容已更新，点击刷新';
    b.setAttribute('style', 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:400;padding:10px 18px;border:0;border-radius:999px;background:var(--ink,#222);color:var(--on-ink,#fff);font:inherit;font-size:14px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25)');
    b.addEventListener('click', () => location.reload());
    document.body.appendChild(b);
  }
  probe();
  setInterval(probe, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) probe(); });
})();
