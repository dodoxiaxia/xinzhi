/**
 * 心知 AIHOT-Med · Modern Clinical Literature Intelligence Platform
 * High-performance client-side multi-dimensional faceted aggregator.
 *
 * Built from src/app/*.js (joined in name order) by scripts/build_sources.py;
 * edit those parts, not app.js. src/app/00-core-data.js · data normalisation,
 * radar archive, search terms, supplemental DOI library.
 */
'use strict';

(function () {
  // Global Data
  const FEEDS = window.FEEDS || { items: [] };
  const LIBRARY = window.LIBRARY || { papers: [] };
  const PDF_LIBRARY_IDS = new Set(LIBRARY.papers.filter(p => p.doi || p.title).map(p => String(p.id)));
  const CURATED = window.CURATED || [];
  const HEALTH = window.SOURCE_HEALTH || { sources: [] };
  const CONTENT_STATUS = window.CONTENT_STATUS || {};

  // ---- Data normalisation (runs once): tidy titles/journals/links so filters and cards behave ----
  const KIND_MAP = { Articles: '', Article: '', Comment: '评论', Correspondence: '来信', Review: '综述', Viewpoint: '观点', News: '新闻', Series: '系列', 'World Report': '世界报道', Editorial: '社论', Obituary: '讣告' };
  const MINOR_RE = /^(author correction|publisher correction|correction to|correction:|erratum|retraction|letter by|response by|response to|reply to|reply by|reply:|comment on|regarding)/i;
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

  // 365-day PubMed title archive (compact rows -> paper objects) feeds the radar's 30 / 90 / 365-day views.
  // Recent rows ship in the first-load bundle; older ones arrive later from radar.js (see loadRadarArchive).
  function expandRadar(R, onAdd) {
    if (!R || !Array.isArray(R.rows)) return 0;
    const seen = new Set();
    let added = 0;
    FEEDS.items.forEach(p => { if (p.doi) seen.add(String(p.doi).toLowerCase()); if (p.pmid) seen.add('pmid:' + p.pmid); });
    R.rows.forEach(r => {
      if ((r[1] && seen.has(r[1])) || seen.has('pmid:' + r[0])) return;
      const p = {
        id: 'pmid-' + r[0], pmid: r[0], doi: r[1], title: r[8], date: r[2], datePrecision: 'day',
        dateBasis: R.dateBases && typeof R.dateBases[r[0]] === 'string' && R.dateBases[r[0]] ? R.dateBases[r[0]] : 'PubMed 电子/刊期日期',
        journal: R.jn[r[3]], cleanJournal: R.jn[r[3]], publisher: R.pub[r[4]], clinicalTier: R.tier[r[5]], studyDesign: R.design[r[6]],
        tags: r[7].map(i => R.tag[i]), url: r[1] ? 'https://doi.org/' + r[1] : 'https://pubmed.ncbi.nlm.nih.gov/' + r[0] + '/',
        publicationStatus: R.publicationStatuses && R.publicationStatuses[r[0]],
        basis: 'PubMed 题录 · 未核验', archived: true, quantitativeMetrics: {}
      };
      if (R.zh && R.zh[r[0]]) p.titleZh = R.zh[r[0]];
      const ab = R.abs && R.abs[r[0]];
      if (ab) p.abstractSections = ab.map(x => ({ label: x[0], text: x[1] }));
      normalizePaper(p);
      FEEDS.items.push(p);
      if (p.doi) seen.add(String(p.doi).toLowerCase());
      seen.add('pmid:' + p.pmid);
      added++;
      if (onAdd) onAdd(p);
    });
    return added;
  }
  expandRadar(window.RADAR);
  expandRadar(window.RADAR_ARCHIVE);
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
  // The segmentation depends only on the query, so it is planned once per query string
  // (the filter calls this for every paper; re-segmenting per paper froze 14k-row searches).
  function queryMatches(text, q) {
    const plans = queryMatches.plans || (queryMatches.plans = new Map());
    let plan = plans.get(q);
    if (!plan) {
      plan = q.split(/\s+/).filter(Boolean).map(term => {
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
        return { term, groups };
      });
      if (plans.size > 50) plans.clear();
      plans.set(q, plan);
    }
    return plan.every(({ term, groups }) => text.includes(term) || groups.every(alts=>alts.some(a=>text.includes(a))));
  }

  // All papers indexed by ID
  const allPapersMap = new Map();
  [...CURATED, ...FEEDS.items, ...LIBRARY.papers].forEach(p => {
    if (p.id && !allPapersMap.has(p.id)) {
      allPapersMap.set(p.id, p);
    }
  });
  const STATIC_DOI_PAPERS = [...CURATED, ...FEEDS.items, ...LIBRARY.papers];
  const RADAR_LOAD = { state: window.RADAR_ARCHIVE || !window.RADAR_SRC ? 'loaded' : 'idle' };
  // Fetch the older radar archive only when a view needs it (ranges beyond 14 days, or an exact DOI).
  function loadRadarArchive() {
    if (RADAR_LOAD.state !== 'idle') return;
    RADAR_LOAD.state = 'loading';
    window.XINZHI_RADAR_READY = () => {
      window.XINZHI_RADAR_READY = null;
      expandRadar(window.RADAR_ARCHIVE, p => {
        if (p.id && !allPapersMap.has(p.id)) allPapersMap.set(p.id, p);
        STATIC_DOI_PAPERS.push(p);
      });
      RADAR_LOAD.state = 'loaded';
      _maxDateCache = null;
      updateHeaderBadges();
      updateHuddleCounter();
      if ($('#huddleModalBackdrop.open')) openHuddleModal();
      if (state.mode === 'candidates' || exactDoi(state.search)) { renderSidebarFilters(); renderStream(); }
    };
    const script = document.createElement('script');
    script.src = window.RADAR_SRC;
    script.async = true;
    script.onerror = () => { RADAR_LOAD.state = 'error'; script.remove(); if (state.mode === 'candidates') renderStream(); if ($('#huddleModalBackdrop.open')) openHuddleModal(); };
    document.head.appendChild(script);
  }
  function radarArchiveNeeded() {
    // First-load rows cover the last three weeks, so only longer ranges (or a site-wide DOI) need the archive.
    return !!exactDoi(state.search) || (state.mode === 'candidates' && !['7', '14'].includes(state.range));
  }
  function radarArchiveNotice() {
    if (state.mode !== 'candidates' || !radarArchiveNeeded()) return '';
    if (RADAR_LOAD.state === 'loading') return '<p class="radar-archive-note" role="status">正在载入 365 天题录存档，结果将自动补全…</p>';
    if (RADAR_LOAD.state === 'error') return '<p class="radar-archive-note" role="status">365 天题录存档载入失败，当前仅显示近 3 周内容。<button type="button" class="btn-sm" data-action="retry-radar-archive">重试</button></p>';
    return '';
  }
  const DOI_FULLTEXT = new Map();
  const DOI_LOOKUPS = new Map();
  const DOI_JOBS = new Map();
  const DOI_JOB_WATCH = { timer: null, doi: '', startedAt: 0 };
  // DOIs whose full-text page the reader opened in another tab; rechecked when they come back.
  const DOI_TOUCHED = new Set();
  const SUPPLEMENTAL_LIBRARY = { state: 'idle', cursor: '', more: false, promise: null, refreshedAt: 0 };

  function exactDoi(value) {
    if (typeof value !== 'string' || value.length > 500) return '';
    let doi = value.trim();
    if (/^https?:\/\//i.test(doi)) {
      try {
        const url = new URL(doi);
        if (!['doi.org', 'dx.doi.org'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) return '';
        doi = decodeURIComponent(url.pathname.slice(1));
      } catch (e) { return ''; }
    } else doi = doi.replace(/^doi:\s*/i, '');
    return /^10\.\d{4,9}\/[^\s<>"?#@\x00-\x1f\x7f]+$/.test(doi) && /^[\x20-\x7e]+$/.test(doi) ? doi.toLowerCase() : '';
  }
  function hamburgFulltextUrl(value) {
    const doi = exactDoi(value);
    return doi ? 'https://dx-1doi-1org-10039f8q70087.emedien3.sub.uni-hamburg.de/' + encodeURIComponent(doi).replace(/%2F/gi, '/') : '';
  }
  function doiTitleKey(value) {
    return String(value || '').trim().replace(/^\[[A-Za-z ]+\]\s*/, '').normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim();
  }
  function sameDoiTitle(left, right) {
    return !!doiTitleKey(left) && doiTitleKey(left) === doiTitleKey(right);
  }
  function supplementalPaper(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^doi-[a-f0-9]{16}$/.test(raw.id)) return null;
    const doi = exactDoi(raw.doi);
    if (!doi || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 800) return null;
    const p = {
      id: raw.id, doi, title: raw.title, journal: typeof raw.journal === 'string' ? raw.journal.slice(0, 200) : '',
      authors: Array.isArray(raw.authors) ? raw.authors.filter(a => typeof a === 'string').slice(0, 30).map(a => a.slice(0, 120)) : [],
      date: typeof raw.date === 'string' && /^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(raw.date) ? raw.date : '',
      dateBasis: typeof raw.dateBasis === 'string' ? raw.dateBasis.slice(0, 160) : '发表日期未知',
      datePrecision: ['day', 'month', 'year'].includes(raw.datePrecision) ? raw.datePrecision : 'unknown',
      url: 'https://doi.org/' + doi, ingestedAt: typeof raw.ingestedAt === 'string' ? raw.ingestedAt.slice(0, 60) : '',
      metadataStatus: 'external_bibliography_checked',
      fulltextStatus: ['available', 'pending', 'review', 'manual_needed'].includes(raw.fulltextStatus) ? raw.fulltextStatus : 'pending',
      basis: '官方题录 · 非全文精读，未经医生终审', tags: [], studyDesign: '研究类型待核验', quantitativeMetrics: {}
    };
    normalizePaper(p);
    p.cleanJournal = p.journal;
    p.publisher = '其他学术刊物';
    const lane = laneOf(p);
    p.clinicalTier = lane === 'cardio' ? '心血管综合与其他' : lane === 'aimed' ? 'AI医疗与数字医学' : lane === 'aitech' ? 'AI行业动态' : '顶级综合与科学';
    p.category = lane === 'cardio' ? isCrossAI(p) ? '交叉研究' : '心血管' : lane === 'aimed' ? 'AI医疗' : lane === 'aitech' ? 'AI前沿' : '综合医学';
    return p;
  }
  function mergeSupplementalPaper(raw) {
    const p = supplementalPaper(raw);
    if (!p) return false;
    const occupied = allPapersMap.get(p.id);
    if (occupied && exactDoi(occupied.doi) !== p.doi) return false;
    if (occupied && STATIC_DOI_PAPERS.includes(occupied) && !sameDoiTitle(occupied.title, p.title)) {
      p.id = 'supplemental-' + p.id;
      const alias = allPapersMap.get(p.id);
      if (alias && (STATIC_DOI_PAPERS.includes(alias) || exactDoi(alias.doi) !== p.doi)) return false;
    }
    DOI_FULLTEXT.set(p.doi, p);
    DOI_LOOKUPS.set(p.doi, { state: 'complete', found: true });
    const existing = STATIC_DOI_PAPERS.filter(item => exactDoi(item.doi) === p.doi);
    const matching = existing.find(item => sameDoiTitle(item.title, p.title));
    // Preserve every static object and ID, including HOLD and editorial fields.
    if (existing.length) {
      if (matching) {
        for (let i = LIBRARY.papers.length - 1; i >= 0; i--) {
          const item = LIBRARY.papers[i];
          if (!STATIC_DOI_PAPERS.includes(item) && exactDoi(item.doi) === p.doi) LIBRARY.papers.splice(i, 1);
        }
        if (!LIBRARY.papers.some(item => exactDoi(item.doi) === p.doi && sameDoiTitle(item.title, p.title))) LIBRARY.papers.push(matching);
      }
      // A conflicting official title stays separate; it cannot inherit the old guide.
      if (!matching) {
        const index = LIBRARY.papers.findIndex(item => item.id === p.id && !STATIC_DOI_PAPERS.includes(item));
        if (index < 0) LIBRARY.papers.push(p); else LIBRARY.papers[index] = p;
        allPapersMap.set(p.id, p);
      }
    } else {
      const index = LIBRARY.papers.findIndex(item => exactDoi(item.doi) === p.doi);
      if (index < 0) LIBRARY.papers.push(p);
      else LIBRARY.papers[index] = p;
      allPapersMap.set(p.id, p);
    }
    _maxDateCache = null;
    return true;
  }
  function exactDoiPapers(doi) {
    const matches = [...CURATED, ...FEEDS.items, ...LIBRARY.papers].filter(p => exactDoi(p.doi) === doi);
    const preferred = papers => papers.find(p => p.hasDraft) || papers.find(p => PDF_LIBRARY_IDS.has(String(p.id))) || papers[0];
    const supplemental = DOI_FULLTEXT.get(doi);
    if (supplemental) {
      const matching = preferred(matches.filter(p => sameDoiTitle(p.title, supplemental.title)));
      return [matching || supplemental];
    }
    return matches.length ? [preferred(matches)] : [];
  }
  function fulltextConflict(p) {
    const record = p && DOI_FULLTEXT.get(exactDoi(p.doi));
    return record && !sameDoiTitle(p.title, record.title) ? record : null;
  }
  function acquireDoiUrl(doi) { return exactDoi(doi) ? '/api/acquire?doi=' + encodeURIComponent(exactDoi(doi)) : ''; }
  function doiJobActive(job) { return job && (['queued', 'running'].includes(job.state) || job.stage === 'verifying'); }
  function mergeDoiJob(doi, raw) {
    if (!raw) { DOI_JOBS.delete(doi); return; }
    if (typeof raw.id !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.id) || raw.doi !== doi
        || !['queued', 'running', 'available', 'pending', 'review', 'failed', 'manual_needed'].includes(raw.state)) throw new Error('library_unavailable');
    const stage = ['queued','running','uploading','verifying','available','login_required','review','failed'].includes(raw.stage) ? raw.stage : '';
    DOI_JOBS.set(doi, { id: raw.id, doi, state: raw.state, stage,
      message: typeof raw.message === 'string' ? raw.message.slice(0, 500) : '',
      nextCheckSeconds: Number.isInteger(raw.nextCheckSeconds) && raw.nextCheckSeconds >= 15 && raw.nextCheckSeconds <= 120 ? raw.nextCheckSeconds : 15 });
  }
  function watchDoiJob(doi) {
    if (DOI_JOB_WATCH.timer) clearTimeout(DOI_JOB_WATCH.timer);
    DOI_JOB_WATCH.timer = null;
    if (exactDoi(state.search) !== doi || !doiJobActive(DOI_JOBS.get(doi))) { DOI_JOB_WATCH.doi = ''; return; }
    if (DOI_JOB_WATCH.doi !== doi) { DOI_JOB_WATCH.doi = doi; DOI_JOB_WATCH.startedAt = Date.now(); }
    if (typeof document === 'undefined' || document.hidden || Date.now() - DOI_JOB_WATCH.startedAt > 3600000) return;
    DOI_JOB_WATCH.timer = setTimeout(() => lookupSupplementalDoi(doi, true), DOI_JOBS.get(doi).nextCheckSeconds * 1000);
  }
  function doiJobNotice(doi) {
    const job = DOI_JOBS.get(doi);
    if (!job) return '';
    const labels = { queued: '全文任务已排队，页面会自动更新状态。', running: '后台正在获取全文，完成后会显示下载入口。',
      manual_needed: '题录已保存，全文需人工处理；等待不会自动获取。', available: '全文已取得，题录与文件正在同步，可刷新状态。', pending: '后台查询已结束，目前未找到可获取的全文。',
      review: '后台查询已结束，全文来源对应需要核验。', failed: '后台未能完成获取，可重新提交任务。' };
    return '<p class="doi-job-notice" role="status">' + esc(job.message || labels[job.state]) + ' <a href="' + esc(acquireDoiUrl(doi)) + '" target="_blank" rel="noopener">查看任务</a></p>';
  }
  async function libraryJson(url) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
      if (!response.ok) { const error = new Error('library_unavailable'); error.status = response.status; throw error; }
      const result = await response.json();
      if (!result || result.ok !== true) throw new Error('library_unavailable');
      return result;
    } finally { clearTimeout(timer); }
  }
  function refreshSupplementalView() {
    updateHeaderBadges();
    if (!exactDoi(state.search) && state.mode !== 'weekly' && state.mode !== 'sources') renderSidebarFilters();
    renderStream();
    if (state.activeDrawerPaper) openReaderDrawer(allPapersMap.get(state.activeDrawerPaper.id) || state.activeDrawerPaper);
    if ($('#huddleModalBackdrop.open')) openHuddleModal();
  }
  async function lookupSupplementalDoi(doi, retry = false) {
    if (!doi || (!retry && DOI_LOOKUPS.has(doi)) || DOI_LOOKUPS.get(doi)?.state === 'loading') return;
    DOI_LOOKUPS.set(doi, { state: 'loading' });
    try {
      const result = await libraryJson('/api/library?doi=' + encodeURIComponent(doi));
      mergeDoiJob(doi, result.job);
      if (result.found === true) {
        if (!result.paper || exactDoi(result.paper.doi) !== doi || !mergeSupplementalPaper(result.paper)) throw new Error('library_unavailable');
      } else if (result.found === false) {
        const previous = DOI_FULLTEXT.get(doi);
        if (previous) DOI_FULLTEXT.set(doi, { ...previous, fulltextStatus: 'pending' });
        DOI_LOOKUPS.set(doi, { state: 'complete', found: false });
      }
      else throw new Error('library_unavailable');
    } catch (e) { DOI_LOOKUPS.set(doi, { state: e.status === 404 ? 'unsupported' : 'error' }); }
    if (exactDoi(state.search) === doi || DOI_TOUCHED.has(doi)) refreshSupplementalView();
    // Only the searched DOI owns the polling timer; a background recheck must not cancel it.
    if (exactDoi(state.search) === doi || DOI_JOB_WATCH.doi === doi) watchDoiJob(doi);
  }
  function loadSupplementalLibrary(refresh = false) {
    if (SUPPLEMENTAL_LIBRARY.promise) return SUPPLEMENTAL_LIBRARY.promise;
    if (refresh) { SUPPLEMENTAL_LIBRARY.cursor = ''; SUPPLEMENTAL_LIBRARY.more = false; }
    SUPPLEMENTAL_LIBRARY.state = 'loading';
    const run = async () => {
      try {
        const visited = new Set();
        for (let page = 0; page < 5; page++) {
          const cursor = SUPPLEMENTAL_LIBRARY.cursor;
          const result = await libraryJson('/api/library?limit=20' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
          if (!Array.isArray(result.papers) || result.papers.length > 20) throw new Error('library_unavailable');
          result.papers.forEach(mergeSupplementalPaper);
          if (Array.isArray(result.jobs) && result.jobs.length <= 20) result.jobs.forEach(job => { if (result.papers.some(p => exactDoi(p.doi) === job.doi)) mergeDoiJob(job.doi,job); });
          const next = typeof result.cursor === 'string' && result.cursor.length <= 2000 ? result.cursor : '';
          if (next && (next === cursor || visited.has(next))) throw new Error('library_unavailable');
          SUPPLEMENTAL_LIBRARY.cursor = next; SUPPLEMENTAL_LIBRARY.more = !!next;
          if (!next) break;
          visited.add(next);
        }
        SUPPLEMENTAL_LIBRARY.state = 'complete';
      } catch (e) { SUPPLEMENTAL_LIBRARY.state = e.status === 404 ? 'unsupported' : 'error'; }
      finally { SUPPLEMENTAL_LIBRARY.promise = null; SUPPLEMENTAL_LIBRARY.refreshedAt = Date.now(); refreshSupplementalView(); }
    };
    SUPPLEMENTAL_LIBRARY.promise = run();
    return SUPPLEMENTAL_LIBRARY.promise;
  }

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
  // Saved view preferences affect rendering without adding a URL parameter.
  let viewInUrl = validView(urlParams.get('view'));
  const savedView = safeGet('xinzhi_view_mode');
  const savedTheme = safeGet('xinzhi_theme');
  const state = {
    mode: urlParams.get('mode') || 'curated', // 'curated' | 'weekly' | 'candidates' | 'library' | 'sources'
    viewMode: viewInUrl ? urlParams.get('view') : validView(savedView) ? savedView : 'cards', // 'cards' | 'compact'
    theme: window.XINZHI_BOOT ? window.XINZHI_BOOT.theme : validTheme(urlParams.get('theme')) ? urlParams.get('theme') : validTheme(savedTheme) ? savedTheme : ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'),
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
    day: urlParams.get('day') === 'all' || /^\d{4}-\d{2}-\d{2}$/.test(urlParams.get('day') || '') ? urlParams.get('day') : '',
    weeklyCat: ['cardio', 'general', 'aimed', 'aitech'].includes(urlParams.get('wcat')) ? urlParams.get('wcat') : '',
    weeklyPane: urlParams.get('pane') === 'reading' ? 'reading' : 'board',
    favoriteJournals: (()=>{try { const a=JSON.parse(safeGet('xz_favorite_journals')||'[]'); return Array.isArray(a)?a.filter(x=>typeof x==='string'):[]; } catch(e){return [];} })(),
    pageSize: 20,
    page: 1,
    huddle: (function () { try { const v = JSON.parse(safeGet('xinzhi_huddle_ids') || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch (e) { return []; } })(),
    // Minimal record of each shortlisted paper, so the list stays complete when its paper is not loaded.
    huddleSnap: (function () { try { const v = JSON.parse(safeGet('xinzhi_huddle_snap') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } })(),
    activeDrawerPaper: null,
    huddleCompare: [] // Explicit selection, kept only in this browser session.
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
    const type = label || '研究类型待核验';
    if (paper.publicationStatus) return `<span class="design-pill publication-status-pill" title="PubMed 官方出版状态">${esc(type)}</span>`;
    return `<span class="design-pill ${checked ? getDesignClass(type) + ' design-checked' : 'design-unverified'}" title="${checked ? '已根据公开摘要核对研究类型；不是全文终审' : '来源或规则标注；尚未逐篇核对研究类型'}">${esc(type)}${checked || type === '研究类型待核验' ? '' : ' · 自动标注'}</span>`;
  }
  function publicationStatusHtml(paper) {
    const status = paper.publicationStatus;
    if (!status) return '';
    const pubmedUrl = url => /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/[1-9]\d*\/$/.test(url || '');
    const links = [];
    if (pubmedUrl(status.sourceUrl)) links.push(`<a href="${esc(status.sourceUrl)}" target="_blank" rel="noopener noreferrer">PubMed 状态来源 ↗</a>`);
    (status.related || []).forEach(r => {
      if (pubmedUrl(r.url)) links.push(`<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.label)}（PMID ${esc(r.pmid)}）↗</a>`);
    });
    return `<div class="publication-status" role="note"><strong>${esc(status.label)}</strong>${links.join(' · ')}</div>`;
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

  // ==== src/app/02-lanes.js · Relevance lanes, per-paper derived cache, quick-look data ====
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
  // Derived per-paper values for the filter hot path (about 14k rows once the radar archive
  // loads): lane, cross-AI flag and lower-case search text are computed once per paper.
  // forgetPaper() drops them whenever a paper's text changes (abstract fetched, AI title, etc.).
  const PAPER_DERIVED = new WeakMap();
  function paperDerived(p) {
    let d = PAPER_DERIVED.get(p);
    if (!d) PAPER_DERIVED.set(p, d = { lane: null, crossAI: null, text: null, query: null, hit: false });
    return d;
  }
  function forgetPaper(p) { if (p && typeof p === 'object') PAPER_DERIVED.delete(p); }
  function paperLane(p) { const d = paperDerived(p); return d.lane === null ? (d.lane = laneOf(p)) : d.lane; }
  function paperCrossAI(p) { const d = paperDerived(p); return d.crossAI === null ? (d.crossAI = isCrossAI(p)) : d.crossAI; }
  const LIVE_QL = {};
  function qlKey(p) { return p.doi ? String(p.doi).toLowerCase() : 'pmid-' + p.pmid; }
  function preGeneratedOf(p) {
    return (window.PREGENERATED || {})[trKeyOf(p)] || null;
  }
  function quicklookOf(p) {
    const k = qlKey(p), embedded = preGeneratedOf(p)?.quicklook;
    const valid = embedded && typeof embedded.one_line === 'string' && embedded.one_line.trim()
      && Array.isArray(embedded.findings) && embedded.findings.every(f => f && typeof f.text === 'string' && typeof f.quote === 'string');
    return (valid ? embedded : null) || (window.QUICKLOOKS || {})[k] || LIVE_QL[k] || null;
  }
  // ==== src/app/03-ai.js · AI services: shared request lifecycle (aiRun) and the six features ====
  // 一键 AI 解读：后端 /api/ql（Cloudflare _worker.js）。本地静态预览没有后端时自动隐藏按钮。
  function aiRequest(url, options = {}, onSlow = null) {
    // Bound headers and body even when an upstream ignores cancellation.
    const controller = new AbortController(), paid = options.method === 'POST';
    let deadlineTimer, slowTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => { const error = new Error('AI request deadline'); error.code = 'request_timeout'; reject(error); controller.abort(); }, paid ? 170000 : 15000);
    });
    if (paid && onSlow) slowTimer = setTimeout(onSlow, 45000);
    return Promise.race([fetch(url, { ...options, signal: controller.signal }).then(r => r.json()), deadline])
      .finally(() => { clearTimeout(deadlineTimer); if (slowTimer) clearTimeout(slowTimer); });
  }
  function aiTaskStatus(j) {
    const value = j?.taskStatus || j?.task?.status;
    return ['idle', 'waiting', 'completed', 'failed'].includes(value) ? value : '';
  }
  function aiWaitingMessage(j, timedOut = false) {
    const seconds = Number(j?.retryAfterSeconds || j?.task?.retryAfterSeconds || 0);
    return (timedOut ? '本次等待已到时限，完成状态尚未确认。' : '完成状态尚未确认。') + '请读取已有结果；不会自动重新提交。' + (seconds > 0 && seconds <= 180 ? '建议约 ' + Math.ceil(seconds) + ' 秒后重查。' : '');
  }
  function aiLookupRecord(j, previous, task, result) {
    if (j?.found && result) return { state: 'done', result, cached: true, canGenerate: !!j.canGenerate };
    if (!j?.ok) return { state: 'error', phase: 'lookup', msg: aiErrorMessage(j, task), canGenerate: false };
    const status = aiTaskStatus(j);
    if (status === 'waiting' || status === 'completed' || (previous?.state === 'waiting' && !status)) return { state: 'waiting', msg: aiWaitingMessage(j), canGenerate: false };
    if (status === 'failed') return { state: 'error', msg: aiErrorMessage({ ...j, ...j.task }, task), canGenerate: !!j.canGenerate };
    return { state: 'ready', canGenerate: !!j.canGenerate };
  }
  function aiPostRecord(j, task, result) {
    if (result && (j.ok || result.generatedBy === 'metadata-only')) return { state: 'done', result, cached: !!j.cached, canGenerate: j.canGenerate !== false };
    if (j.error === 'in_progress' || aiTaskStatus(j) === 'waiting') return { state: 'waiting', msg: aiWaitingMessage(j), canGenerate: false };
    return { state: 'error', msg: aiErrorMessage(j, task), canGenerate: j.error !== 'generation_off' && j.error !== 'not_configured' };
  }
  // ---- One request lifecycle shared by all six AI features ----
  // Quick-look, abstract translation, title translation, study structure, evidence compare and
  // brief all go through aiRun:
  //  · GET only reads a saved result (15 s limit) and never calls the model.
  //  · POST is the only paid call: a "taking longer" notice at 45 s, and at 170 s the page stops
  //    waiting. The outcome is then unknown, so the reader is offered "read the saved result"
  //    (a GET) instead of a second paid call.
  //  · A reply is applied only while current() says the request is still the newest one for
  //    its owner, so a late reply never overwrites newer state. after() always runs (re-render).
  function aiRun({ url, body, current, slow, ok, fail, after }) {
    const options = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { accept: 'application/json' } };
    return aiRequest(url, options, body && slow ? () => { if (current()) slow(); } : null)
      .then(j => { if (current()) ok(j); })
      .catch(error => { if (current()) fail(error); })
      .finally(after);
  }
  // A paid request whose reply never arrived: say so and point to the saved-result lookup.
  function aiUnconfirmed(error) { return aiWaitingMessage(null, error?.code === 'request_timeout'); }
  // Per-paper features keep their state on the paper (_ai*, _tr*, _tt*); each request takes a new token.
  function paperTask(paper, prefix) {
    const token = {};
    paper[prefix + 'Token'] = token;
    return () => paper[prefix + 'Token'] === token;
  }
  // Keyed features (study, compare, brief) store one record per key; a reply applies while that record is current.
  function recordTask(store, key, record) {
    store[key] = record;
    return () => store[key] === record;
  }
  function rerenderReader(paper) { if (state.activeDrawerPaper === paper) openReaderDrawer(paper); }
  function aiApiCheck(paper, retry = false) {
    if ((paper._aiChecked && !retry) || paper._aiLookupLoading || paper._aiState === 'loading' || (!paper.doi && !paper.pmid)) return;
    const previous = paper._aiState, current = paperTask(paper, '_ai');
    paper._aiChecked = 1; paper._aiLookupLoading = true; paper._aiState = 'checking';
    const k = paper.pmid ? 'pmid:' + paper.pmid : 'doi:' + String(paper.doi).toLowerCase();
    aiRun({ url: '/api/ql?k=' + encodeURIComponent(k), current,
      ok: j => {
        if (!j?.ok) throw Error('Lookup unavailable');
        if (j.found && j.ql) { LIVE_QL[qlKey(paper)] = j.ql; forgetPaper(paper); paper._aiState = 'done'; }
        else if (aiTaskStatus(j) === 'waiting' || aiTaskStatus(j) === 'completed' || (previous === 'waiting' && !aiTaskStatus(j))) { paper._aiState = 'waiting'; paper._aiMsg = aiWaitingMessage(j); }
        else { paper._aiState = j.canGenerate ? 'none' : 'off'; paper._aiMsg = aiTaskStatus(j) === 'failed' ? aiErrorMessage({...j, ...j.task}, 'quicklook') : ''; if (paper._aiMsg && j.canGenerate) paper._aiState = 'error'; }
      },
      fail: () => { paper._aiState = previous === 'waiting' ? 'waiting' : 'lookup-error'; paper._aiMsg = '已有解读读取失败，请重查；没有重新调用模型。'; },
      after: () => { if (current()) paper._aiLookupLoading = false; rerenderReader(paper); } });
  }
  // ---- 摘要翻译 / 多篇综述（同一后端 /api/ai，结果服务器端缓存、全站共享）----
  const LIVE_TR = {}; const BRIEFS = {}; let AI_AVAIL = null;
  const trKeyOf = p => p.pmid ? 'pmid:' + p.pmid : (p.doi ? 'doi:' + String(p.doi).toLowerCase() : '');
  function validTranslation(tr) {
    return !!(tr && typeof tr.abstract_zh === 'string' && tr.abstract_zh.trim());
  }
  function hydratePreGenerated(paper) {
    const record = preGeneratedOf(paper);
    if (!record) return;
    if (validTranslation(record.translation)) LIVE_TR[trKeyOf(paper)] = record.translation;
    const result = studyResultOf(record, 'study');
    if (result && result.papers.some(p => p.key === studyKey(paper))) STUDY_RESULTS[studyKey(paper)] = { state: 'done', result, cached: true, canGenerate: false };
  }
  function translationCanGenerate(paper) {
    return typeof paper._trCanGenerate === 'boolean' ? paper._trCanGenerate : AI_AVAIL;
  }
  function trCheck(paper, retry = false) {
    const k = trKeyOf(paper);
    if (!k || paper._trLookupState === 'loading' || paper._trState === 'loading' || (paper._trChecked && !retry)) return;
    const previous = paper._trState, current = paperTask(paper, '_tr');
    paper._trChecked = 1; paper._trLookupState = 'loading';
    aiRun({ url: '/api/ai?task=translate&k=' + encodeURIComponent(k), current,
      ok: j => {
        if (!j || j.ok === false) throw new Error('Translation lookup unavailable');
        paper._trLookupState = 'done';
        paper._trCanGenerate = typeof j.canGenerate === 'boolean' ? j.canGenerate : undefined;
        if (j.found && validTranslation(j.tr)) { LIVE_TR[k] = j.tr; if (!paper.titleZh) { paper.titleZh = j.tr.title_zh; forgetPaper(paper); } paper._trState = 'done'; }
        else if (aiTaskStatus(j) === 'waiting' || aiTaskStatus(j) === 'completed' || (previous === 'waiting' && !aiTaskStatus(j))) { paper._trState = 'waiting'; paper._trMsg = aiWaitingMessage(j); }
        else if (aiTaskStatus(j) === 'failed') { paper._trState = 'error'; paper._trMsg = aiErrorMessage({...j, ...j.task}, 'translate'); }
        else paper._trState = '';
      },
      fail: () => { paper._trLookupState = 'error'; if (previous === 'waiting') { paper._trState = 'waiting'; paper._trMsg = '已有译文读取失败，请重查；没有重新调用模型。'; } },
      after: () => rerenderReader(paper) });
  }
  function aiTranslate(paper) {
    const k = trKeyOf(paper); if (!k || ['loading', 'waiting'].includes(paper._trState) || paper._trLookupState === 'loading' || translationCanGenerate(paper) !== true) return;
    const current = paperTask(paper, '_tr'); paper._trState = 'loading'; paper._trSlow = false; openReaderDrawer(paper);
    aiRun({ url: '/api/ai', body: { task: 'translate', pmid: paper.pmid || '', doi: paper.doi || '' }, current,
      slow: () => { paper._trSlow = true; rerenderReader(paper); },
      ok: j => { if (j.ok && validTranslation(j.tr)) { LIVE_TR[k] = j.tr; if (!paper.titleZh) { paper.titleZh = j.tr.title_zh; forgetPaper(paper); } paper._trState = 'done'; } else if (j.error === 'in_progress' || aiTaskStatus(j) === 'waiting') { paper._trState = 'waiting'; paper._trMsg = aiWaitingMessage(j); } else { paper._trState = 'error'; paper._trMsg = aiErrorMessage(j, 'translate'); } },
      fail: error => { paper._trState = 'waiting'; paper._trMsg = aiUnconfirmed(error); },
      after: () => rerenderReader(paper) });
  }
  function aiTitle(paper) {
    if (!trKeyOf(paper) || ['loading', 'waiting', 'checking'].includes(paper._ttState)) return;
    const current = paperTask(paper, '_tt'); paper._ttState = 'loading'; paper._ttMsg = '翻译中…'; openReaderDrawer(paper);
    aiRun({ url: '/api/ai', body: { task: 'title', pmid: paper.pmid || '', doi: paper.doi || '' }, current,
      slow: () => { paper._ttMsg = '标题翻译用时较长，无需重复点击。'; rerenderReader(paper); },
      ok: j => { if (j.ok && j.tt) { paper.titleZh = j.tt.title_zh; forgetPaper(paper); paper._ttState = ''; paper._ttMsg = ''; } else { paper._ttState = j.error === 'in_progress' || aiTaskStatus(j) === 'waiting' ? 'waiting' : ''; paper._ttMsg = paper._ttState === 'waiting' ? aiWaitingMessage(j) : aiErrorMessage(j, 'title'); } },
      fail: error => { paper._ttState = 'waiting'; paper._ttMsg = aiUnconfirmed(error); },
      after: () => rerenderReader(paper) });
  }
  function aiTitleCheck(paper) {
    const k = trKeyOf(paper); if (!k || paper._ttState === 'checking' || paper._ttState === 'loading') return;
    const current = paperTask(paper, '_tt'); paper._ttState = 'checking';
    aiRun({ url: '/api/ai?task=title&k=' + encodeURIComponent(k), current,
      ok: j => { if (!j?.ok) throw Error('Title lookup unavailable'); if (j.found && j.tt?.title_zh) { paper.titleZh = j.tt.title_zh; forgetPaper(paper); paper._ttState = ''; paper._ttMsg = ''; } else if (['idle', 'failed'].includes(aiTaskStatus(j))) { paper._ttState = ''; paper._ttMsg = aiTaskStatus(j) === 'failed' ? aiErrorMessage({...j, ...j.task}, 'title') : '上次任务已结束，未查到标题译文。可点击重试。'; } else { paper._ttState = 'waiting'; paper._ttMsg = aiWaitingMessage(j); } },
      fail: () => { paper._ttState = 'waiting'; paper._ttMsg = '已有标题译文读取失败，请重查；没有重新调用模型。'; },
      after: () => rerenderReader(paper) });
  }
  function trBoxHtml(paper) {
    const tr = LIVE_TR[trKeyOf(paper)];
    const editorial = preGeneratedOf(paper)?.meta?.generationMeta?.translate?.origin === 'sol-session-public-abstract';
    if (validTranslation(tr)) return `<div class="tr-box">${tr.abstract_zh.split(/\n+/).map(t => `<p>${esc(t)}</p>`).join('')}<p class="translation-note">${editorial ? 'Sol 会话依据公开摘要整理译文，未经人工医学终审；以英文原文为准。' : '机器翻译，未经人工核对；以英文原文为准。'}</p></div>`;
    if (paper.weeklyPick) return '<div class="tr-box"><p class="ql-meta" role="status">本篇中文摘要尚未预生成。</p></div>';
    if (paper._trState === 'loading') return `<div class="tr-box"><p class="ql-meta" role="status">正在翻译摘要…${paper._trSlow ? '用时较长，无需重复点击。' : ''}</p></div>`;
    if (paper._trState === 'waiting') return `<div class="tr-box"><p class="ql-meta" role="status">${esc(paper._trMsg || aiWaitingMessage())}</p><button class="btn-sm" data-action="tr-check" data-paper-id="${esc(paper.id)}"${paper._trLookupState === 'loading' ? ' disabled' : ''}>读取已有译文</button></div>`;
    if (!(paper.pmid || paper.doi)) return '<p class="ql-meta" role="status">缺少文献标识，暂无法翻译。</p>';
    if (paper._trLookupState === 'error') return `<div class="tr-box"><p class="ql-meta" role="status">译文读取失败。</p><button class="btn-sm" data-action="tr-check" data-paper-id="${esc(paper.id)}">重新读取译文</button></div>`;
    if (paper._trLookupState !== 'done') return '<div class="tr-box"><p class="ql-meta" role="status">正在读取已有译文…</p></div>';
    if (translationCanGenerate(paper) === null) return '<div class="tr-box"><p class="ql-meta" role="status">正在检查翻译服务…</p></div>';
    if (!translationCanGenerate(paper)) return '<div class="tr-box"><p class="ql-meta" role="status">暂无译文，翻译服务暂不可用。</p></div>';
    return `<div class="tr-box">${paper._trState === 'error' ? `<p class="translation-error" role="status">${esc(paper._trMsg || '译文未生成，请重试。')}</p>` : '<p class="ql-meta">暂无中文译文。</p>'}<button class="btn-sm" data-action="ai-translate" data-paper-id="${esc(paper.id)}">${paper._trState === 'error' ? '重试翻译' : '翻译摘要（中英对照）'}</button></div>`;
  }
  function abstractTranslationStatus(paper) {
    if (validTranslation(LIVE_TR[trKeyOf(paper)])) return '中英对照';
    if (paper._trState === 'loading') return '译文生成中';
    if (paper._trState === 'waiting') return '译文状态待确认';
    if (paper._trState === 'error' || paper._trLookupState === 'error') return '译文暂不可用';
    return paper.weeklyPick ? '译文待预生成' : '译文未生成';
  }
  function briefItems(list) {
    const seen = new Set(), result = [];
    for (const p of list) {
      const pmid = /^\d{1,9}$/.test(String(p.pmid || '')) ? String(p.pmid) : '';
      const doi = exactDoi(p.doi || '');
      const keys = [pmid && 'pmid:' + pmid, doi && 'doi:' + doi].filter(Boolean);
      if (!keys.length || keys.some(k => seen.has(k))) continue;
      keys.forEach(k => seen.add(k)); result.push({pmid, doi});
      if (result.length === 8) break;
    }
    return result;
  }
  function briefKey(mode, items) { return mode + '|' + items.map(x => x.pmid || x.doi).sort().join(','); }
  function validBrief(value) {
    return value && typeof value.theme === 'string' && typeof value.compare === 'string' && typeof value.caveat === 'string'
      && Array.isArray(value.refs) && value.refs.length >= 2 && value.refs.length <= 8
      && value.refs.every(r => r && typeof r.title === 'string')
      && Array.isArray(value.papers) && value.papers.length === value.refs.length
      && value.papers.every(p => p && Number.isInteger(p.n) && p.n >= 1 && p.n <= value.refs.length && typeof p.point === 'string')
      && new Set(value.papers.map(p => p.n)).size === value.refs.length
      && Array.isArray(value.questions) && value.questions.every(q => typeof q === 'string');
  }
  function aiBrief(mode, list, rerender) {
    const items = briefItems(list); if (items.length < 2) { showToast('至少需要 2 篇有 PMID/DOI 的文献'); return; }
    const k = briefKey(mode, items);
    if (BRIEFS[k] && ['loading', 'waiting'].includes(BRIEFS[k].state)) return;
    const record = { state: 'loading', slow: false }, isRecord = recordTask(BRIEFS, k, record);
    rerender();
    aiRun({ url: '/api/ai', body: { task: 'brief', mode, items }, current: () => isRecord() && record.state === 'loading',
      slow: () => { record.slow = true; rerender(); },
      ok: j => { BRIEFS[k] = j.ok && validBrief(j.brief) ? { state: 'done', brief: j.brief } : j.error === 'in_progress' || aiTaskStatus(j) === 'waiting' ? { state: 'waiting', msg: aiWaitingMessage(j) } : { state: 'error', msg: j.ok ? '综述结果不完整，未展示。请重试。' : aiErrorMessage(j, 'brief') }; },
      fail: error => { BRIEFS[k] = { state: 'waiting', timedOut: error?.code === 'request_timeout' }; },
      after: () => rerender() });
  }
  function briefLookup(mode, list, rerender) {
    const items = briefItems(list); if (items.length < 2) return;
    const k = briefKey(mode, items), record = BRIEFS[k];
    if (!record || record.state !== 'waiting' || record.checking) return;
    record.checking = true; rerender();
    const keys = items.map(x => x.pmid ? 'pmid:' + x.pmid : 'doi:' + x.doi);
    aiRun({ url: '/api/ai?task=brief&mode=' + encodeURIComponent(mode) + '&keys=' + encodeURIComponent(JSON.stringify(keys)), current: () => BRIEFS[k] === record,
      ok: j => {
        if (j.ok && j.found && validBrief(j.brief)) BRIEFS[k] = {state: 'done', brief: j.brief};
        else if (j.ok && ['idle', 'failed'].includes(aiTaskStatus(j))) BRIEFS[k] = {state: 'error', msg: aiTaskStatus(j) === 'failed' ? aiErrorMessage({...j, ...j.task}, 'brief') : '上次任务已结束，未查到已保存结果。可点击重新生成。'};
        else { record.checking = false; record.msg = j.ok && !j.found ? '尚未查到已保存结果，可稍后再查；没有重新调用模型。' : '已有结果暂不可读，可稍后再查。'; }
      },
      fail: () => { record.checking = false; record.msg = '已有结果读取失败，可稍后再查；没有重新调用模型。'; },
      after: () => rerender() });
  }
  function briefHtml(mode, list) {
    const items = briefItems(list); if (items.length < 2) return '';
    const k = briefKey(mode, items), b = BRIEFS[k];
    const label = mode === 'huddle' ? 'AI 生成前 ' + items.length + ' 篇讨论提纲' : 'AI 综述当前结果前 ' + items.length + ' 篇';
    if (!b || b.state === 'error') return `<div class="brief-box">${b ? `<p class="ql-meta" role="status">${esc(b.msg)}</p>` : ''}<button class="btn-sm btn-primary" data-action="ai-brief" data-mode="${mode}">${label}</button><span class="text-muted brief-help">按当前顺序选最多 8 篇有标识的不同文献；基于可取得的公开摘要，结果全站共享。耗时随摘要与服务响应而变化。</span></div>`;
    if (b.state === 'loading') return `<div class="brief-box" aria-busy="true"><p class="ql-meta" role="status">正在读取摘要并生成，请稍候…${b.slow ? '用时较长，无需重复点击；不会自动重新提交。' : ''}</p></div>`;
    if (b.state === 'waiting') return `<div class="brief-box"><p class="ql-meta" role="status">${b.timedOut ? '本次等待已到时限，完成状态尚未确认' : '网络中断，完成状态尚未确认'}；后台可能仍在处理，未重新提交。</p>${b.msg ? `<p class="ql-meta" role="status">${esc(b.msg)}</p>` : ''}<button class="btn-sm" data-action="brief-check" data-mode="${mode}"${b.checking ? ' disabled' : ''}>${b.checking ? '读取中…' : '读取已有综述'}</button></div>`;
    const r = b.brief;
    const included = r.refs.length, omitted = Math.max(0, items.length - included);
    return `<div class="brief-box brief-done"><div class="drawer-section-title">${mode === 'huddle' ? '讨论提纲' : '综述速读'} <small class="ql-flag">模型根据公开摘要生成 · 未经人工核对</small></div>
      <p class="brief-coverage" role="status">请求 ${items.length} 篇 · 实际纳入 ${included} 篇${omitted ? ` · ${omitted} 篇公开摘要未纳入，下面结果只对应已纳入文献` : ''}</p>
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
    const top = briefItems(l);
    if (exactDoi(state.search) || AI_AVAIL !== true || state.mode === 'weekly' || top.length < 2) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false; el.innerHTML = briefHtml('digest', top);
  }
  // ---- Public-abstract study services: GET only reads cache; POST requires a click. ----
  const STUDY_FIELDS = [['question', '研究问题'], ['population', '研究对象'], ['design', '研究设计'], ['comparator', '干预与对照'], ['endpoints', '研究终点'], ['results', '主要结果']];
  const STUDY_RESULTS = {}; const COMPARE_RESULTS = {};
  function studyKey(p) {
    return p.pmid ? 'pmid:' + String(p.pmid) : (p.doi ? 'doi:' + String(p.doi).toLowerCase() : '');
  }
  function studyIds(p) {
    return { pmid: p.pmid ? String(p.pmid) : '', doi: p.doi ? String(p.doi) : '' };
  }
  function selectedComparePapers() {
    const seen = new Set();
    return state.huddle.filter(id => state.huddleCompare.includes(id)).map(huddlePaper).filter(p => {
      const key = p && studyKey(p);
      const doi = p?.doi && 'doi:' + String(p.doi).toLowerCase();
      if (!key || seen.has(key) || (doi && seen.has(doi))) return false;
      seen.add(key); if (doi) seen.add(doi); return true;
    });
  }
  function compareKey(list) {
    return JSON.stringify(list.map(studyKey).sort());
  }
  function setCompareSelection(id, checked) {
    const paper = huddlePaper(id);
    if (!state.huddle.includes(id) || !paper || !studyKey(paper)) return false;
    if (!checked) { state.huddleCompare = state.huddleCompare.filter(x => x !== id); return true; }
    if (state.huddleCompare.includes(id)) return true;
    const selected = selectedComparePapers();
    if (selected.length >= 4) { showToast('最多选择 4 篇，请先取消一篇'); return false; }
    if (selected.some(p => studyKey(p) === studyKey(paper) || (p.doi && paper.doi && String(p.doi).toLowerCase() === String(paper.doi).toLowerCase()))) { showToast('这篇文献已在对照中，请勿重复选择'); return false; }
    state.huddleCompare.push(id); return true;
  }
  function studyResultOf(j, task) {
    const r = j && j[task];
    if (!r || r.schemaVersion !== 1 || r.scope !== 'public-abstract' || !Array.isArray(r.papers) || r.papers.length > 4) return null;
    if (!Array.isArray(r.checklist) || r.checklist.some(x => typeof x !== 'string')) return null;
    if (r.papers.some(p => !p || typeof p.key !== 'string' || !['available', 'unavailable'].includes(p.status))) return null;
    return r;
  }
  function studyMissingReason(reason) {
    return { no_abstract: '未找到公开摘要', metadata_timeout: '公开摘要获取暂未完成', metadata_error: '公开摘要获取暂时失败', abstract_too_long: '公开摘要超过处理范围', missing_result: '此篇未返回可核对结果', request_timeout: '本次任务未能在时限内完成' }[reason] || '此篇公开摘要暂不可用';
  }
  function studyRows(result, requested) {
    // Keep every selected paper visible, including unavailable or omitted items.
    return requested.map((p, i) => {
      const key = studyKey(p);
      const row = result.papers.find(x => x.key === key || (p.pmid && x.pmid && String(x.pmid) === String(p.pmid)) || (p.doi && x.doi && String(x.doi).toLowerCase() === String(p.doi).toLowerCase()));
      return row ? { ...row, n: i + 1 } : { ...studyIds(p), key, n: i + 1, title: p.title || '', journal: p.cleanJournal || p.journal || '', status: 'unavailable', reason: 'missing_result' };
    });
  }
  function studyFieldHtml(paper, field) {
    if (paper.status !== 'available') return '<span class="study-missing">' + esc(studyMissingReason(paper.reason)) + '</span>';
    const value = paper[field];
    const text = value && typeof value.text === 'string' && value.text ? value.text : '摘要未提供';
    const quote = value && typeof value.quote === 'string' ? value.quote : '';
    return `<p class="study-field-text">${esc(text)}</p>${quote ? `<details class="study-quote"><summary>核对摘要原句</summary><blockquote>${esc(quote)}</blockquote></details>` : ''}`;
  }
  function studySourceHtml(paper) {
    const url = safeSourceUrl({ url: paper.source_url || '' });
    const source = paper.abstract_source || '公开摘要';
    return `<span>${esc(source)}</span>${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">摘要来源 ↗</a>` : ''}`;
  }
  function studyMetaHtml(result, cached) {
    const time = result.generatedAt ? contentDate(result.generatedAt) : '';
    return `<p class="study-boundary">仅根据公开摘要生成，未经人工核对。各篇结果不作质量排名，不合并效应量。</p><p class="study-meta">${result.generatedBy === 'metadata-only' ? '摘要获取状态 · 未调用模型' : cached ? '读取已有结果' : '本次生成'}${time ? ' · 生成时间（北京时间）：' + esc(time) : ''}${result.model ? ' · ' + esc(result.model) : ''}</p>`;
  }
  function studyChecklistHtml(result) {
    return `<details class="study-checklist"><summary>全文核对清单（待查事项）</summary><p>以下是阅读全文时需要核对的问题，并非已发现论文存在这些缺陷。</p><ul>${result.checklist.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>${result.caveat ? `<p class="study-boundary">${esc(result.caveat)}</p>` : ''}`;
  }
  function studyResultHtml(result, requested, cached, task) {
    const rows = studyRows(result, requested);
    const content = task === 'compare'
      ? `<div class="study-table-scroll" role="region" aria-label="逐篇公开摘要证据对照表" tabindex="0"><table class="study-table"><caption>逐篇证据对照 · 可横向滚动</caption><thead><tr><th scope="col">核对项目</th>${rows.map(p => `<th scope="col"><span class="study-paper-number">${p.n}.</span> ${esc(p.title)}<small>${esc(p.journal || '')}</small>${journalMetricBadge(p)}${journalMetricDetails(p)}${p.status !== 'available' ? `<small class="study-missing">${esc(studyMissingReason(p.reason))}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${STUDY_FIELDS.map(([field, label]) => `<tr><th scope="row">${label}</th>${rows.map(p => `<td>${studyFieldHtml(p, field)}</td>`).join('')}</tr>`).join('')}<tr><th scope="row">摘要来源</th>${rows.map(p => `<td>${studySourceHtml(p)}</td>`).join('')}</tr></tbody></table></div>`
      : rows.map(p => `<div class="study-paper">${p.status !== 'available' ? `<p class="study-missing">${esc(studyMissingReason(p.reason))}</p>` : ''}<dl class="study-fields">${STUDY_FIELDS.map(([field, label]) => `<div><dt>${label}</dt><dd>${studyFieldHtml(p, field)}</dd></div>`).join('')}</dl><p class="study-meta">${studySourceHtml(p)}</p></div>`).join('');
    return studyMetaHtml(result, cached) + content + studyChecklistHtml(result) + `<button class="btn-sm" data-action="study-copy" data-task="${task}"${task === 'study' ? ` data-paper-id="${esc(requested[0].id)}"` : ''}>复制${task === 'compare' ? '证据对照' : '研究结构'}与核对清单</button>`;
  }
  function studyBoxHtml(paper) {
    const key = studyKey(paper); if (!key) return '';
    const rec = STUDY_RESULTS[key];
    if (!rec && paper.weeklyPick) return '';
    let content = '<p class="study-meta" role="status">正在检查已有结果，不会调用模型…</p>';
    if (!rec && paper.weeklyPick) content = '<p class="study-meta" role="status">本篇研究结构尚未预生成。</p>';
    else if (rec?.state === 'done') content = studyResultHtml(rec.result, [paper], rec.cached, 'study') + (rec.result.generatedBy === 'metadata-only' && rec.canGenerate ? `<button class="btn-sm" data-action="ai-study" data-paper-id="${esc(paper.id)}">重新获取公开摘要</button>` : '');
    else if (rec?.state === 'loading') content = `<p class="study-meta" role="status">正在从公开来源读取摘要并提取研究结构，请稍候…${rec.slow ? '用时较长，无需重复点击。' : ''}</p>`;
    else if (rec?.state === 'waiting') content = `<p class="study-meta" role="status">${esc(rec.msg || aiWaitingMessage())}</p><button class="btn-sm" data-action="study-check" data-paper-id="${esc(paper.id)}">读取已有研究结构</button>`;
    else if (rec && rec.state !== 'checking') {
      content = (rec.msg ? `<p class="study-error" role="status">${esc(rec.msg)}</p>` : '') + (rec.canGenerate ? `<button class="btn-sm" data-action="ai-study" data-paper-id="${esc(paper.id)}">${rec.state === 'error' ? '重试生成研究结构' : '提取研究结构与核对清单'}</button><p class="study-meta">点击后由模型读取公开摘要；不会读取全文。</p>` : `<p class="study-meta">${rec.phase === 'lookup' ? '尚未读取到已有结果。' : '研究结构服务暂未开放。已有缓存仍可阅读。'}</p>${rec.phase === 'lookup' ? `<button class="btn-sm" data-action="study-check" data-paper-id="${esc(paper.id)}">重查已有结果</button>` : ''}`);
    }
    return `<section class="drawer-section study-box" aria-label="研究结构与全文核对"><div class="drawer-section-title">研究结构与全文核对 <small>公开摘要服务</small></div>${content}</section>`;
  }
  function studyCheck(paper, retry = false) {
    const key = studyKey(paper), previous = STUDY_RESULTS[key];
    if (!key || previous?.state === 'checking' || previous?.state === 'loading' || (previous && !retry)) return;
    aiRun({ url: '/api/ai?task=study&k=' + encodeURIComponent(key), current: recordTask(STUDY_RESULTS, key, { state: 'checking', previous }),
      ok: j => { STUDY_RESULTS[key] = aiLookupRecord(j, previous, 'study', studyResultOf(j, 'study')); },
      fail: () => { STUDY_RESULTS[key] = aiLookupFailure(previous); },
      after: () => rerenderReader(paper) });
  }
  // A failed saved-result lookup keeps an earlier "waiting" state; otherwise it allows a retry.
  function aiLookupFailure(previous) {
    return previous?.state === 'waiting' ? { ...previous, msg: '已有结果读取失败，请重查；没有重新调用模型。' } : { state: 'error', phase: 'lookup', msg: '无法读取已有结果，请稍后重试。', canGenerate: false };
  }
  function aiStudy(paper) {
    const key = studyKey(paper), previous = STUDY_RESULTS[key];
    if (!key || !previous?.canGenerate || ['loading', 'checking', 'waiting'].includes(previous.state)) return;
    const record = { state: 'loading', canGenerate: false }, current = recordTask(STUDY_RESULTS, key, record); openReaderDrawer(paper);
    aiRun({ url: '/api/ai', body: { task: 'study', ...studyIds(paper) }, current,
      slow: () => { record.slow = true; rerenderReader(paper); },
      ok: j => { STUDY_RESULTS[key] = aiPostRecord(j, 'study', studyResultOf(j, 'study')); },
      fail: error => { STUDY_RESULTS[key] = { state: 'waiting', msg: aiUnconfirmed(error), canGenerate: false }; },
      after: () => rerenderReader(paper) });
  }
  function compareBoxHtml(list) {
    const selected = selectedComparePapers(), valid = selected.length >= 2 && selected.length <= 4;
    const key = valid ? compareKey(selected) : '', rec = key && COMPARE_RESULTS[key];
    let content = '<p class="study-meta">请在上方明确勾选 2–4 篇有 PMID/DOI 的文献。</p>';
    if (valid) {
      if (rec?.state === 'done') content = studyResultHtml(rec.result, selected, rec.cached, 'compare') + (rec.result.generatedBy === 'metadata-only' && rec.canGenerate ? '<button class="btn-sm" data-action="ai-compare">重新获取所选文献的公开摘要</button>' : '');
      else if (!rec || rec.state === 'checking') content = '<p class="study-meta" role="status">正在检查这组文献的已有结果，不会调用模型…</p>';
      else if (rec.state === 'loading') content = `<p class="study-meta" role="status">正在逐篇读取公开摘要并整理证据对照，请稍候…${rec.slow ? '用时较长，无需重复点击。' : ''}</p>`;
      else if (rec.state === 'waiting') content = `<p class="study-meta" role="status">${esc(rec.msg || aiWaitingMessage())}</p><button class="btn-sm" data-action="compare-check">读取已有证据对照</button>`;
      else content = (rec.msg ? `<p class="study-error" role="status">${esc(rec.msg)}</p>` : '') + (rec.canGenerate ? `<button class="btn-sm btn-primary" data-action="ai-compare">${rec.state === 'error' ? '重试' : '生成'}所选 ${selected.length} 篇证据对照</button><p class="study-meta">点击后调用模型。仅发送文献标识，不发送个人清单文本；无摘要文献仍保留在结果中。</p>` : `<p class="study-meta">${rec.phase === 'lookup' ? '尚未读取到这组文献的已有结果。' : '证据对照服务暂未开放。已有缓存仍可阅读。'}</p>${rec.phase === 'lookup' ? '<button class="btn-sm" data-action="compare-check">重查已有结果</button>' : ''}`);
    }
    return `<section class="study-box compare-box" aria-label="精选证据对照" tabindex="-1"><div class="drawer-section-title">精选证据对照 <small>已选 ${selected.length}/4 篇</small></div><p class="study-boundary">按各篇公开摘要逐项核对研究问题、对象、设计、对照、终点与结果。不会据此排名或合并研究结论。</p>${content}</section>`;
  }
  function compareCheck(retry = false) {
    const list = selectedComparePapers(); if (list.length < 2 || list.length > 4) return;
    const key = compareKey(list), previous = COMPARE_RESULTS[key];
    if (previous?.state === 'checking' || previous?.state === 'loading' || (previous && !retry)) return;
    aiRun({ url: '/api/ai?task=compare&keys=' + encodeURIComponent(key), current: recordTask(COMPARE_RESULTS, key, { state: 'checking', previous }),
      ok: j => { COMPARE_RESULTS[key] = aiLookupRecord(j, previous, 'compare', studyResultOf(j, 'compare')); },
      fail: () => { COMPARE_RESULTS[key] = aiLookupFailure(previous); },
      after: () => rerenderCompare(key) });
  }
  function rerenderCompare(key) { if ($('#huddleModalBackdrop.open') && compareKey(selectedComparePapers()) === key) openHuddleModal(); }
  function aiCompare() {
    const list = selectedComparePapers(); if (list.length < 2 || list.length > 4) { showToast('请明确选择 2–4 篇有 PMID/DOI 的文献'); return; }
    const key = compareKey(list), previous = COMPARE_RESULTS[key];
    if (!previous?.canGenerate || ['loading', 'checking', 'waiting'].includes(previous.state)) return;
    const record = { state: 'loading', canGenerate: false }, current = recordTask(COMPARE_RESULTS, key, record); openHuddleModal();
    aiRun({ url: '/api/ai', body: { task: 'compare', items: list.map(studyIds) }, current,
      slow: () => { record.slow = true; rerenderCompare(key); },
      ok: j => { COMPARE_RESULTS[key] = aiPostRecord(j, 'compare', studyResultOf(j, 'compare')); },
      fail: error => { COMPARE_RESULTS[key] = { state: 'waiting', msg: aiUnconfirmed(error), canGenerate: false }; },
      after: () => rerenderCompare(key) });
  }
  function studyCopyText(result, requested) {
    let text = '公开摘要研究结构与证据对照（未经人工核对）\n不作质量排名，不合并效应量。\n';
    studyRows(result, requested).forEach(p => {
      text += `\n${p.n}. ${p.title}\n${p.journal || ''}\n期刊指标：${journalMetricText(p)}\n`;
      if (p.status !== 'available') text += studyMissingReason(p.reason) + '\n';
      else STUDY_FIELDS.forEach(([field, label]) => {
        const value = p[field];
        text += `${label}：${value && typeof value.text === 'string' ? value.text : '摘要未提供'}\n`;
        if (value && typeof value.quote === 'string' && value.quote) text += `摘要原句：${value.quote}\n`;
      });
      const source = safeSourceUrl({ url: p.source_url || '' });
      text += `摘要来源：${p.abstract_source || '公开摘要'}${source ? ' ' + source : ''}\n`;
    });
    text += '\n全文核对清单（待查事项，并非已发现的论文缺陷）\n' + result.checklist.map(x => '- ' + x).join('\n');
    if (result.caveat) text += '\n证据边界：' + result.caveat;
    if (result.generatedAt) text += '\n生成时间：' + result.generatedAt;
    return text;
  }
  // ---- End public-abstract study services. ----
  const AI_ERR = { daily_cap: '今日 AI 解读额度已用完，明天再试。', ip_cap: '你今天的解读次数已达上限。', no_abstract: '本次已完成的公开来源查询未取得可用摘要。可查看官方原文。', metadata_timeout: '公开摘要读取超时，未生成结果。请稍后重试。', metadata_error: '公开摘要来源暂时不可读，未生成结果。请稍后重试。', request_timeout: '本次任务未能在时限内完成，未保存结果。可点击重试。', task_timeout: '本次任务未能在时限内完成，未保存结果。可点击重试。', task_cancelled: '本次任务已取消，未保存结果。可点击重试。',
    model_failed: 'AI 服务未能完成处理，未保存。请稍后重试。', in_progress: '该任务仍在处理中，请读取已有结果确认进度。',
    generation_off: 'AI 功能暂未开放。', not_configured: 'AI 服务尚未配置完成，需要维护者处理。', server: '服务暂时出错，请稍后重试。', need_two: '至少需要 2 篇文献。', bad_key: '这篇缺少 PMID/DOI，无法处理。' };
  const AI_MODEL_ERR = {
    provider_auth: 'AI 服务认证失败，需要维护者修复配置。',
    provider_rate_limit: '模型服务暂时限流，请稍后重试。',
    provider_unavailable: '模型服务暂不可用，请稍后重试。',
    request_timeout: '模型服务响应超时，请稍后重试。',
    provider_network_error: '模型服务处理时发生网络错误，请稍后重试。',
    provider_budget: '今天的模型调用次数已达上限；已保存结果仍可阅读。',
    budget_unavailable: '暂时无法核对模型调用额度，请稍后重试。',
    model_redirect: '模型接口地址发生跳转，需要维护者检查配置。',
    endpoint_invalid: '模型接口地址配置无效，需要维护者处理。',
    endpoint_insecure: '模型接口需要使用有效的 HTTPS 地址。',
    fetch_dns: '暂时无法连接模型服务，请稍后重试。',
    fetch_tls: '暂时无法连接模型服务，请稍后重试。',
    fetch_connection: '暂时无法连接模型服务，请稍后重试。',
    fetch_timeout: '暂时无法连接模型服务，请稍后重试。',
    transport_error: '暂时无法连接模型服务，请稍后重试。',
    output_truncated: '模型结果未完整返回，已自动重试但仍未完成，未保存。请稍后重试。',
    output_json: '模型结果格式不正确，已自动重试，未保存。请稍后重试。',
    output_shape: '模型没有返回可用结果，未保存。请稍后重试。',
    output_empty: '模型返回了空结果，未保存。请稍后重试。',
    output_blocked: '模型服务没有提供这次结果，未保存。',
    output_incomplete: '模型未正常完成这次处理，未保存。请稍后重试。',
    context_limit: '摘要超出了模型服务的处理范围，需要维护者检查配置。',
    missing_numbers: '译文遗漏了原文数字，未保存。请重试。',
    quote_not_in_abstract: 'AI 要点的引文未能在原摘要中核对，未保存。请重试。'
  };
  function aiErrorMessage(result, task) {
    if (result?.error !== 'model_failed') return AI_ERR[result?.error] || 'AI 服务暂时出错，请稍后重试。';
    const detail = String(result.detail || '');
    if (detail === 'unsupported_numbers') return (task === 'translate' || task === 'title' ? '译文' : 'AI 结果') + '包含与原文不符的数字，未保存。请重试。';
    if (/^(?:invalid_[a-z_]+|model_not_object|not_object)$/.test(detail)) return '模型结果未符合格式要求，未保存。请重试。';
    return AI_MODEL_ERR[detail] || AI_ERR.model_failed;
  }
  function aiInterpret(paper) {
    if (['loading', 'waiting', 'checking', 'lookup-error'].includes(paper._aiState)) return;
    const current = paperTask(paper, '_ai'); paper._aiState = 'loading'; paper._aiSlow = false; openReaderDrawer(paper);
    aiRun({ url: '/api/ql', body: { pmid: paper.pmid || '', doi: paper.doi || '' }, current,
      slow: () => { paper._aiSlow = true; rerenderReader(paper); },
      ok: j => {
        if (j.ok && j.ql) { LIVE_QL[qlKey(paper)] = j.ql; forgetPaper(paper); paper._aiState = 'done'; }
        else if (j.error === 'in_progress' || aiTaskStatus(j) === 'waiting') { paper._aiState = 'waiting'; paper._aiMsg = aiWaitingMessage(j); }
        else if (j.error === 'no_abstract') { paper._aiState = 'noabs'; }
        else { paper._aiState = 'error'; paper._aiMsg = aiErrorMessage(j, 'quicklook'); }
      },
      fail: error => { paper._aiState = 'waiting'; paper._aiMsg = aiUnconfirmed(error); },
      after: () => rerenderReader(paper) });
  }
  // ==== src/app/04-filters.js · Dates, full-text links, lane/range bars, URL sync, filtering, sidebar facets ====
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
  function pdfDownloadUrl(p) {
    if (p && typeof DOI_FULLTEXT !== 'undefined') {
      const doi = exactDoi(p.doi), record = DOI_FULLTEXT.get(doi);
      if (record) return sameDoiTitle(p.title, record.title) && record.fulltextStatus === 'available' ? '/api/fulltext?doi=' + encodeURIComponent(doi) : '';
    }
    return p && PDF_LIBRARY_IDS.has(String(p.id)) ? '/api/pdf?id=' + encodeURIComponent(p.id) : '';
  }
  function pdfDownloadLink(p) {
    const conflict = fulltextConflict(p);
    if (conflict) return `<span class="fulltext-state fulltext-review" title="官方题名：${esc(conflict.title)}">题录对应待核实</span>`;
    const job = p && DOI_JOBS.get(exactDoi(p.doi));
    if (doiJobActive(job)) return '<span class="fulltext-state">' + (job.stage === 'verifying' ? '已回传，等待核验' : job.stage === 'uploading' ? 'Drive 已上传，正在回传' : job.state === 'queued' ? '全文排队中' : '全文获取中') + '</span><a href="' + esc(acquireDoiUrl(job.doi)) + '" target="_blank" rel="noopener" class="btn-sm">查看任务</a>';
    const url = pdfDownloadUrl(p);
    if (url) return `<a href="${esc(url)}" target="_blank" rel="noopener" class="btn-sm btn-primary" title="输入全文口令即可下载">下载 PDF</a>`;
    const doi = p && exactDoi(p.doi), record = DOI_FULLTEXT.get(doi);
    const manual = record?.fulltextStatus === 'manual_needed';
    if (job && ['failed','manual_needed','review'].includes(job.state)) return '<span class="fulltext-state" title="' + esc(job.message) + '">' + (job.state === 'review' ? '全文核验未通过' : '全文需人工处理') + '</span><a href="' + esc(acquireDoiUrl(doi)) + '" target="_blank" rel="noopener" class="btn-sm">查看处理状态</a>';
    const label = manual ? '全文需人工处理' : record?.fulltextStatus === 'review' ? '全文对应待核实' : '待补全文';
    const acquire = job ? '/api/acquire/retry?doi=' + encodeURIComponent(doi) : acquireDoiUrl(doi);
    return doi ? `<span class="fulltext-state">${label}</span><a href="${esc(acquire)}" target="_blank" rel="noopener" class="btn-sm">${manual ? '查看处理状态' : record || job ? '再次获取全文' : '获取全文'}</a>` : '';
  }
  function inLane(p, lane) {
    if (lane === 'all') return true;
    if (lane === 'crossai') return paperCrossAI(p);
    const l = paperLane(p);
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
      `<button type="button" class="lane-chip${state.range === v ? ' active' : ''}" data-range="${v}" aria-pressed="${state.range === v}">${n}</button>`).join('');
  }
  function renderLaneBar() {
    const el = $('#laneBar');
    if (!el) return;
    if (state.mode === 'curated') {
      // Topic counts follow the day being viewed; the selected topic stays visible to clear it.
      const counts = {}, day = curatedDay();
      getCuratedList().filter(p => !day || publishedDate(p) === day).forEach(p => (p.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
      if (state.tag && !counts[state.tag]) counts[state.tag] = 0;
      const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      el.hidden = tags.length === 0;
      el.innerHTML = tags.length ? `<span class="lane-label">主题</span>` + tags.map(([t, n]) => `<button class="lane-chip ${state.tag === t ? 'active' : ''}" data-filter-tag="${esc(t)}">${esc(t.replace(/^#/, ''))} <small>${n}</small></button>`).join('') : '';
      return;
    }
    if (!usesLane()) { el.hidden = true; el.innerHTML = ''; return; }
    // One pass: every paper that passes the non-lane conditions counts towards its own lanes.
    const counts = { core: 0, crossai: 0, cardio: 0, aimed: 0, general: 0, aitech: 0, all: 0 };
    for (const p of getCurrentDataset()) {
      if (!matchesFilters(p, true)) continue;
      const lane = paperLane(p);
      counts.all++; counts[lane]++;
      if (lane === 'cardio' || lane === 'aimed') counts.core++;
      if (paperCrossAI(p)) counts.crossai++;
    }
    el.hidden = false;
    el.innerHTML = LANES.map(l => `<button class="lane-chip ${state.lane === l.id ? 'active' : ''}" data-lane="${l.id}">${esc(l.name)} <small>${counts[l.id]}</small></button>`).join('');
  }

  // 每日精选 opens on the newest day; earlier days are one tap away instead of a long scroll.
  function curatedDays() {
    const counts = new Map();
    getCuratedList().filter(p => matchesFilters(p, false)).forEach(p => { const d = publishedDate(p); counts.set(d, (counts.get(d) || 0) + 1); });
    return [...counts.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }
  // '' means every day. An explicit day wins; otherwise a search spans all days.
  function curatedDay(days = curatedDays()) {
    if (state.day === 'all') return '';
    if (state.day && days.some(([d]) => d === state.day)) return state.day;
    return state.search || !days.length ? '' : days[0][0];
  }
  function renderCuratedDayBar() {
    const el = $('#curatedDayBar'); if (!el) return;
    if (state.mode !== 'curated' || exactDoi(state.search)) { el.hidden = true; el.innerHTML = ''; return; }
    const days = curatedDays(), active = curatedDay(days), total = days.reduce((sum, [, n]) => sum + n, 0);
    const label = d => /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : d;
    el.hidden = days.length < 2;
    el.innerHTML = '<span class="lane-label">日期</span>' + days.map(([d, n], i) => `<button type="button" class="lane-chip${d === active ? ' active' : ''}" data-day="${esc(i === 0 && !state.search ? '' : d)}" aria-pressed="${d === active}">${i === 0 ? '最新 · ' : ''}${esc(label(d))} <small>${n}</small></button>`).join('')
      + `<button type="button" class="lane-chip${active ? '' : ' active'}" data-day="all" aria-pressed="${!active}">全部 <small>${total}</small></button>`;
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
    const lb = $('#libCountBadge'); if (lb) {
      lb.textContent = LIBRARY.papers.length;
      lb.title = '已收录题录总数，含更正 / 来信；列表按当前筛选计数';
      lb.setAttribute('aria-label', `已收录 ${LIBRARY.papers.length} 条题录，含更正 / 来信；列表按当前筛选计数`);
    }

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
  const MODE_NOTES = {
    candidates: '<b>默认显示近 14 天文献与 AI 动态，可切换到近 30 / 90 / 365 天。</b>近 14 天来自 RSS 与 PubMed（多数带摘要）；更早的是 PubMed 题录（已关注的心血管与 AI 医学期刊），点“阅读摘要”再取公开摘要。自动聚合条目未经逐篇核对；已核对导读与 AI 速览分别标记。',
    library: '文献档案：按期刊与时间检索既有题录。输入全文口令后可下载已收录的 PDF；未收录全文的条目可访问官网。没有摘要的条目，可尝试获取公开摘要。刊期按月份显示，日期未知的排在最后。'
  };

  function renderModeNote() {
    const el = $('#modeNote');
    if (!el) return;
    const rail = $('#streamRail');
    if (rail) rail.hidden = state.mode !== 'curated';
    const laneBar = $('#laneBar'), laneSlot = $(state.mode === 'curated' ? '#curatedTopicsSlot' : '#streamLaneSlot');
    if (laneBar && laneSlot && laneBar.parentElement !== laneSlot) laneSlot.append(laneBar);
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
      set('wcat', state.mode === 'weekly' ? state.weeklyCat : '', '');
      set('day', state.mode === 'curated' ? state.day : '', '');
      set('pane', state.mode === 'weekly' ? state.weeklyPane : '', 'board');
      set('read', state.mode === 'weekly' ? activeDeepReadingId : '', '');
      u.searchParams.delete('maintainer');
      const filteredView = state.search || state.clinicalTier || state.publisher || state.journal || state.studyDesign || state.tag
        || state.range !== defaultRange(state.mode) || (usesLane() && (state.lane !== 'core' || state.minor || state.reading || state.favoritesOnly));
      if (viewInUrl || filteredView) u.searchParams.set('view', state.viewMode);
      else u.searchParams.delete('view');
      history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash);
    } catch (e) { /* file:// or sandboxed */ }
  }

  // Phones: the Back button closes the open panel instead of leaving the site.
  // Opening a panel pushes one history entry; closing it by button or Esc walks back over it.
  const OVERLAY_PUSHED = new Set();
  function pushOverlay(name) {
    try {
      if (OVERLAY_PUSHED.has(name) && history.state && history.state.overlay === name) return;
      history.pushState({ overlay: name }, '', location.href);
      OVERLAY_PUSHED.add(name);
    } catch (e) { /* file:// or sandboxed */ }
  }
  function popOverlay(name) {
    try {
      if (OVERLAY_PUSHED.has(name) && history.state && history.state.overlay === name) { history.back(); return true; }
    } catch (e) { /* file:// or sandboxed */ }
    return false;
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

  // A journal and its publisher share one source facet. Expanding the tree
  // is presentation state and must never change the selected papers.
  const expandedPublishers = new Set();
  function publisherForJournal(journal) {
    if (!journal) return '';
    const paper = getCurrentDataset().find(p => p.cleanJournal === journal || p.journal === journal);
    return paper ? paper.publisher || '其他学术刊物' : '';
  }
  if (state.journal) state.publisher = publisherForJournal(state.journal);
  if (state.publisher) expandedPublishers.add(state.publisher);

  function sidebarSelections() {
    return [
      { group: 'tier', value: state.clinicalTier, label: '信源分组' },
      state.journal ? { group: 'journal', value: state.journal, label: '期刊' }
        : { group: 'pub', value: state.publisher, label: '出版方' },
      { group: 'design', value: state.studyDesign, label: '研究设计' },
      { group: 'tag', value: state.tag, label: '主题' }
    ].filter(selection => selection.value);
  }
  function clearSidebarFilters() {
    state.clinicalTier = state.publisher = state.journal = state.studyDesign = state.tag = '';
    state.page = 1;
  }
  function selectSidebarFilter(group, value, only = false) {
    if (!['tier', 'pub', 'journal', 'design', 'tag'].includes(group) || typeof value !== 'string') return false;
    if (only) clearSidebarFilters();
    if (group === 'tier') state.clinicalTier = value;
    if (group === 'pub') { state.publisher = value; state.journal = ''; }
    if (group === 'journal') { state.journal = value; state.publisher = publisherForJournal(value); }
    if (group === 'design') state.studyDesign = value;
    if (group === 'tag') state.tag = value;
    if (state.publisher) expandedPublishers.add(state.publisher);
    state.page = 1;
    return true;
  }
  function browseOnlyButton(group, value, label) {
    const facet = group === 'journal' ? 'pub' : group;
    const other = sidebarSelections().some(selection => (selection.group === 'journal' ? 'pub' : selection.group) !== facet);
    if (!value || !other) return '';
    return `<button type="button" class="browse-only-btn" data-browse-only="${group}" data-browse-value="${esc(value)}" aria-label="只看${esc(label)}" title="清除其他左侧筛选；保留领域、时间、搜索和可读内容条件">只看</button>`;
  }
  function refreshFilterResults(control, group, value) {
    const focused = control && document.activeElement === control;
    const inSidebar = control && control.closest('#appSidebar');
    renderSidebarFilters();
    renderStream();
    if (!focused || control.isConnected) return;
    const attribute = { tier: 'tier', pub: 'publisher', journal: 'journal', design: 'design', tag: 'tag' }[group];
    const replacement = inSidebar && attribute && Array.from(document.querySelectorAll(`#appSidebar [data-filter-${attribute}]`))
      .find(button => button.getAttribute(`data-filter-${attribute}`) === value);
    (replacement || $('#activeFiltersBar'))?.focus({ preventScroll: true });
  }
  function changeSidebarFilter(group, value, only, control) {
    if (selectSidebarFilter(group, value, only)) refreshFilterResults(control, group, value);
  }

  // Filter & Sort
  function paperSearchText(p) {
    const d = paperDerived(p);
    if (d.text === null) d.text = [
      p.title, p.draftData?.title_zh, p.titleZh, p.cleanJournal, p.journal, p.publisher, p.doi, p.pmid, p.id,
      p.summary, ...(p.abstractSections || []).map(x => x.text), quicklookOf(p)?.title_zh,
      p.draftData?.summary, ...(p.authors || []), ...(p.tags || []),
      p.quantitativeMetrics?.trialId, p.quantitativeMetrics?.sampleSize
    ].filter(Boolean).join(' ').toLowerCase();
    return d.text;
  }
  function matchesQuery(p) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    // List, lane counts and sidebar counts all ask again for the same keyword.
    const d = paperDerived(p);
    if (d.query !== q) { d.query = q; d.hit = queryMatches(paperSearchText(p), q); }
    return d.hit;
  }
  function specialSearchStatus(scope, matched, total, noun) {
    if (!state.search) return '';
    return `<div class="special-search-status"><span class="search-scope" role="status">检索范围：${esc(scope)} · 匹配 ${matched}/${total} ${noun}；切换栏目保留关键词</span><span>搜索：${esc(state.search)}</span><button class="btn-sm" data-clear="search" aria-label="清除检索关键词">清除关键词</button></div>`;
  }
  // All conditions must hold; the cheap ones run first and the keyword search last.
  function matchesFilters(p, skipLane, skip) {
    const lane = usesLane();
    if (lane) {
      if (!state.minor && p.minor) return false;
      if (state.range !== 'all' && (datePrecision(p)!=='day' || p.date.slice(0,10)<rangeStart() || p.date.slice(0,10)>beijingToday())) return false;
      if (!skipLane && !inLane(p, state.lane)) return false;
      if (state.favoritesOnly && !state.favoriteJournals.includes(p.cleanJournal || p.journal || '')) return false;
      if (state.reading==='guide' && !p.hasDraft) return false;
    }
    if (!matchesSidebarFilters(p, skip)) return false;
    if (lane && state.reading==='abstract' && !hasAbstract(p)) return false;
    if (lane && state.reading==='quicklook' && (!quicklookOf(p) || p.hasDraft)) return false;
    return matchesQuery(p);
  }
  // Bit set of the sidebar groups a paper fails, so facet counts need one pass, not one per group.
  const FACET_BITS = { tier: 1, pub: 2, design: 4, tag: 8 };
  function sidebarMisses(p) {
    let miss = 0;
    if (state.clinicalTier && (p.clinicalTier || '综合医学与其他') !== state.clinicalTier) miss |= 1;
    if (state.publisher && (p.publisher || '其他学术刊物') !== state.publisher) miss |= 2;
    if (state.journal && (p.cleanJournal !== state.journal && p.journal !== state.journal)) miss |= 2;
    if (state.studyDesign && p.studyDesign !== state.studyDesign) miss |= 4;
    if (state.tag && (!p.tags || !p.tags.includes(state.tag))) miss |= 8;
    return miss;
  }
  function matchesSidebarFilters(p, skip) {
    if (skip === 'sidebar') return true;
    return (sidebarMisses(p) & ~(FACET_BITS[skip] || 0)) === 0;
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
      + (paperLane(p) === 'cardio' || paperCrossAI(p) ? 3 : 0) + (p.summary ? 2 : 0) + (p.abstractSections && p.abstractSections.length ? 1 : 0);
  }
  function getFilteredArticles() {
    const doi = exactDoi(state.search);
    if (doi) return exactDoiPapers(doi);
    const list = getCurrentDataset();
    const curated = state.mode === 'curated';
    let arr = list.filter(p => matchesFilters(p, false));
    if (curated) { const day = curatedDay(); if (day) arr = arr.filter(p => publishedDate(p) === day); }
    const jn = p => p.cleanJournal || p.journal || '';
    // The comparator runs O(n log n) times; rank each paper once.
    const ranks = new Map();
    const rank = p => { let r = ranks.get(p); if (r === undefined) ranks.set(p, r = richRank(p)); return r; };
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
        const d = rank(b) - rank(a);
        if (d) return d;
      }
      if (jLatest) {
        const ja = jn(a), jb = jn(b);
        if (ja !== jb) return (jLatest.get(jb) || '').localeCompare(jLatest.get(ja) || '') || ja.localeCompare(jb);
      }
      const da = (a.date || '').slice(0, 10), db = (b.date || '').slice(0, 10);
      if (!da || !db) return da ? -1 : db ? 1 : 0;
      if (state.sort === 'date-asc') return da.localeCompare(db) || rank(b) - rank(a);
      return db.localeCompare(da) || rank(b) - rank(a);
    });
  }

  // Render Sidebar Filters with dynamic counts
  function renderSidebarFilters() {
    const all = getCurrentDataset();
    const base = all.filter(p => matchesFilters(p, false, 'sidebar'));
    // One pass: a paper belongs to a group's facet when it fails no other group.
    const facets = { tier: [], pub: [], design: [], tag: [] };
    for (const p of base) {
      const miss = sidebarMisses(p);
      if (!(miss & ~FACET_BITS.tier)) facets.tier.push(p);
      if (!(miss & ~FACET_BITS.pub)) facets.pub.push(p);
      if (!(miss & ~FACET_BITS.design)) facets.design.push(p);
      if (!(miss & ~FACET_BITS.tag)) facets.tag.push(p);
    }
    const facet = skip => facets[skip];
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
      { id: '定向专病与团队', name: '定向专病与团队', dotClass: 'dot-team' },
      { id: '综合医学与其他', name: '综合医学与其他', dotClass: 'dot-general' }
    ];

    dataset.forEach(p => {
      const t = p.clinicalTier || '综合医学与其他';
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    });

    const tierListEl = $('#tierFilterList');
    if (tierListEl) {
      const availableTiers = new Set(base.map(p => p.clinicalTier || '综合医学与其他'));
      tierListEl.innerHTML = tiers.filter(t => t.id === '' || availableTiers.has(t.id) || state.clinicalTier === t.id).map(t => {
        const isAll = t.id === '';
        const count = isAll ? dataset.length : (tierCounts[t.id] || 0);
        const isActive = isAll ? !state.clinicalTier : state.clinicalTier === t.id;

        return `<li class="facet-option-row">
          <button type="button" class="filter-item-btn ${isActive ? 'active' : ''}" data-filter-tier="${esc(t.id)}" aria-pressed="${isActive}">
            <span style="display:flex; align-items:center;"><span class="tier-dot ${t.dotClass}"></span>${esc(t.name)}</span>
            <span class="filter-count">${count}</span>
          </button>
          ${browseOnlyButton('tier', t.id, t.name)}
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
    // Keep zero-count options available so "只看" can leave a combination.
    base.forEach(p => {
      const pub = p.publisher || '其他学术刊物';
      const j = p.cleanJournal || p.journal || '其他';
      if (!pubMap.has(pub)) pubMap.set(pub, new Map());
      pubMap.get(pub).set(j, 0);
    });
    if (state.publisher && !pubMap.has(state.publisher)) pubMap.set(state.publisher, new Map());
    if (state.journal) {
      const pub = state.publisher || '其他学术刊物';
      if (!pubMap.has(pub)) pubMap.set(pub, new Map());
      if (!pubMap.get(pub).has(state.journal)) pubMap.get(pub).set(state.journal, 0);
    }
    facet('pub').forEach(p => {
      const jMap = pubMap.get(p.publisher || '其他学术刊物');
      const j = p.cleanJournal || p.journal || '其他';
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
        return idxA - idxB || a[0].localeCompare(b[0]);
      });

      let accHtml = '', pubIndex = 0;
      for (const [pubName, journals] of sortedPubEntries) {
        const contentId = 'publisher-journals-' + pubIndex++;
        const pubTotal = Array.from(journals.values()).reduce((a, b) => a + b, 0);
        const isPubActive = state.publisher === pubName;
        const isOpen = expandedPublishers.has(pubName);

        // Sort journals inside publisher by volume descending, then name
        const sortedJournals = Array.from(journals.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

        let jHtml = '';
        for (const [jName, jCount] of sortedJournals) {
          const isJActive = state.journal === jName;
          jHtml += `<div class="journal-filter-item facet-option-row"><button type="button" class="accordion-journal-btn ${isJActive ? 'active' : ''}" data-filter-journal="${esc(jName)}" aria-pressed="${isJActive}">
            <span class="journal-filter-label"><span>${state.favoriteJournals?.includes(jName) ? '<span class="journal-followed" title="我的期刊">★</span> ' : ''}${esc(jName)}</span></span>
            <span class="filter-count">${jCount}</span>
          </button>${browseOnlyButton('journal', jName, jName)}</div>`;
        }

        accHtml += `
          <div class="accordion-group ${isOpen ? 'open' : ''}">
            <div class="accordion-heading">
              <button type="button" class="accordion-header ${isPubActive && !state.journal ? 'active' : ''}" data-filter-publisher="${esc(pubName)}" aria-pressed="${isPubActive && !state.journal}">
                <span>${esc(pubName)} <span class="filter-count">(${pubTotal})</span></span>
              </button>
              ${browseOnlyButton('pub', pubName, pubName)}
              <button type="button" class="accordion-expand-btn" data-pub-expand="${esc(pubName)}" aria-expanded="${isOpen}" aria-controls="${contentId}" aria-label="展开或收起${esc(pubName)}旗下期刊"><span class="accordion-arrow" aria-hidden="true">▶</span></button>
            </div>
            <div class="accordion-content" id="${contentId}">
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
      { name: 'RCT 二次分析', key: 'RCT 二次分析' },
      { name: '二次分析（母研究待核验）', key: '二次分析' },
      { name: '已撤稿', key: '已撤稿' },
      { name: '存在关注声明', key: '存在关注声明' },
      { name: '撤稿声明', key: '撤稿声明' },
      { name: '关注声明', key: '关注声明' },
      { name: '更正声明', key: '更正声明' },
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

        return `<li class="facet-option-row">
          <button type="button" class="filter-item-btn ${isActive ? 'active' : ''}" data-filter-design="${esc(d.key)}" aria-pressed="${isActive}">
            <span>${d.name}</span>
            <span class="filter-count">${count}</span>
          </button>
          ${browseOnlyButton('design', d.key, d.name)}
        </li>`;
      }).join('');
    }

    // 4. Tags Cloud
    const tagCounts = {};
    base.forEach(p => (p.tags || []).forEach(t => { tagCounts[t] = 0; }));
    if (state.tag) tagCounts[state.tag] = 0;
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
        return `<span class="facet-option-row tag-option"><button type="button" class="tag-chip ${isActive ? 'active' : ''}" data-filter-tag="${esc(tag)}" aria-pressed="${isActive}">
          ${esc(tag)} (${count})
        </button>${browseOnlyButton('tag', tag, tag)}</span>`;
      }).join('') || '<span class="text-muted" style="font-size:12px;">暂无标签</span>';
    }
  }

  // Render Active Filter Chips
  function renderActiveFilterChips(totalCount) {
    const container = $('#activeFiltersBar');
    if (!container) return;

    const selections = sidebarSelections();
    let chips = selections.length ? '<div class="sidebar-active-filters"><span class="active-filters-label">当前筛选 · 同时满足</span>'
      + selections.map(selection => `<span class="filter-badge-active"><span class="filter-badge-label">${selection.label}：${esc(selection.value)}${selection.group === 'journal' ? ' ' + journalMetricBadge(selection.value) : ''}</span><button type="button" class="filter-badge-remove" data-clear="${selection.group}" aria-label="清除${selection.label}筛选">&times;</button></span>`).join('')
      + '<button type="button" class="sidebar-clear-btn" data-clear="sidebar">清空左侧筛选</button></div>' : '';
    chips += `<span class="results-meta" role="status">共找到 <b>${totalCount}</b> 篇文献${usesLane() && !state.minor ? ' · 默认隐藏更正 / 来信' : ''}</span>`;

    if (state.search) {
      const scope = { curated: '每日精选', candidates: '文献雷达', library: '文献库' }[state.mode] || '当前栏目';
      chips += `<span class="filter-badge-active search-scope" role="status">检索范围：${scope} · 当前筛选；切换栏目保留关键词</span>`;
      chips += `<span class="filter-badge-active">搜索: "${esc(state.search)}" <button type="button" class="filter-badge-remove" data-clear="search" aria-label="清除检索关键词">&times;</button></span>`;
    }
    if (state.range !== defaultRange(state.mode) && usesLane()) {
      chips += `<span class="filter-badge-active">发表时间: ${state.range === 'all' ? '全部时间' : '近 ' + state.range + ' 天'} <button type="button" class="filter-badge-remove" data-clear="range" aria-label="恢复默认时间范围">&times;</button></span>`;
    }
    if(usesLane() && state.reading) chips+=`<span class="filter-badge-active">可读内容：${esc({'abstract':'有摘要','guide':'已核对导读','quicklook':'AI 速览'}[state.reading])}<button type="button" class="filter-badge-remove" data-clear="reading" aria-label="清除可读内容筛选">&times;</button></span>`;
    if(usesLane() && state.favoritesOnly) chips+='<span class="filter-badge-active">我的期刊（仅此浏览器保存）<button type="button" class="filter-badge-remove" data-clear="favorites" aria-label="清除我的期刊筛选">&times;</button></span>';

    container.innerHTML = chips;
  }

  function renderEmptyFilters() {
    const selections = sidebarSelections();
    const base = getCurrentDataset().filter(p => matchesFilters(p, false, 'sidebar'));
    const suggestions = selections.length > 1 ? selections.map(selection => {
      const count = base.filter(p => {
        if (selection.group === 'tier') return (p.clinicalTier || '综合医学与其他') === selection.value;
        if (selection.group === 'pub') return (p.publisher || '其他学术刊物') === selection.value;
        if (selection.group === 'journal') return p.cleanJournal === selection.value || p.journal === selection.value;
        if (selection.group === 'design') return p.studyDesign === selection.value;
        return (p.tags || []).includes(selection.value);
      }).length;
      return count ? `<button type="button" class="btn-sm" data-browse-only="${selection.group}" data-browse-value="${esc(selection.value)}">只看${esc(selection.value)} · ${count} 篇</button>` : '';
    }).join('') : '';
    const message = selections.length > 1 ? '这些条件需要同时满足，目前没有交集。可保留其中一项切换浏览。'
      : state.mode === 'curated' ? '当前条件下没有精选，可清除筛选或查看文献雷达。' : '当前领域、时间、关键词与筛选条件下暂无匹配。';
    return `<div class="empty-state"><h3>没有找到匹配的文献</h3><p>${message}</p><div class="empty-filter-actions">${suggestions}
      ${selections.length ? '<button type="button" class="btn-sm" data-clear="sidebar">清空左侧筛选</button>' : ''}
      ${state.search ? '<button type="button" class="btn-sm" data-clear="search">清除关键词</button>' : ''}
      <button type="button" class="btn-sm btn-primary" id="clearAllFiltersBtn">重置所有条件</button></div></div>`;
  }

  // ==== src/app/05-list.js · Article cards, compact rows, list rendering, citations ====
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
    // A Chinese one-line takeaway (when one exists) leads the card; the English abstract stays in the reader.
    const leadHtml = !p.hasDraft && qlc?.one_line && p.summary
      ? `<p class="card-lead"><span class="content-label" title="模型依据公开摘要生成，未经人工核对">AI 速览 · 未核对</span>${esc(qlc.one_line)}</p>${qlc.why_read ? `<p class="card-why"><b>为什么读：</b>${esc(qlc.why_read)}</p>` : ''}`
      : '';

    return `
      <article class="article-card" data-paper-id="${esc(p.id)}">
        <div class="card-top">
          <div class="meta-badges">
            <span class="journal-badge ${pubClass}">${esc(journalName)}</span>
            ${journalMetricBadge(p)}
            ${designBadgeHtml(p)}
            ${p.kind ? `<span class="tag-pill kind-pill">${esc(p.kind)}</span>` : ''}
            ${p.autoPick && !p.hasDraft ? `<span class="tag-pill auto-pick-pill" title="由规则从当日新文献中自动选出，AI 速览未经人工核验">自动精选</span>` : ''}
            ${p.clinicalTier ? `<span class="tag-pill" style="border:none; background:transparent; font-weight:500;">${esc(p.clinicalTier)}</span>` : ''}
            ${p.media && p.media.length ? p.media.slice(0, 2).map(m => `<a class="media-pill" href="${esc(m.u)}" target="_blank" rel="noopener noreferrer" title="${esc(m.t)}">媒体关注 · ${esc(m.s)}</a>`).join('') : ''}
          </div>
          <span class="date-badge" title="${esc(p.dateBasis || '来源记录日期，未经逐篇核验')}">${esc(dateStr)}</span>
        </div>

        ${publicationStatusHtml(p)}
        ${!p.hasDraft && qlc?.title_zh ? `<div class="article-title-zh ql-title"><span class="content-label">机器翻译</span>${esc(qlc.title_zh)}</div>` : ''}
        ${!p.hasDraft && !qlc?.title_zh && p.titleZh ? `<div class="article-title-zh ql-title"><span class="content-label">机器翻译</span>${esc(p.titleZh)}</div>` : ''}
        ${titleZh ? `<div class="article-title-zh"><span class="verified-badge" title="已对照期刊公开摘要核对；非全文精读，未经医生终审">摘要核对</span>${titleZh}</div>` : ''}
        <h3 class="article-title"><button class="title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}">${titleEn}</button></h3>

        ${leadHtml || `<p class="article-abstract">${summaryText}</p>`}
        ${p.draftData?.limitations ? `<p class="card-limit"><b>证据边界：</b>${esc(p.draftData.limitations)}</p>` : ''}
        ${p.draftData?.learning_question ? `<p class="card-question"><b>共读问题：</b>${esc(p.draftData.learning_question)}</p>` : ''}

        ${tagsHtml ? `<div class="article-card-tags">${tagsHtml}</div>` : ''}

        <div class="card-actions">
          <div class="action-buttons-group">
            <button class="btn-sm btn-primary" data-action="open-drawer" data-paper-id="${esc(p.id)}">${p.hasDraft ? '阅读导读与摘要' : qlc ? '阅读 AI 速览' : '阅读摘要'}</button>
            ${p.hasDraft ? `<button class="btn-sm btn-share" data-action="share-wechat" data-paper-id="${esc(p.id)}">微信群文案</button>` : ''}
            <button class="btn-sm ${isHuddled ? 'active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}">
              ${isHuddled ? '已入精选 ✓' : '加入精选清单'}
            </button>
          </div>

          <div class="card-source-actions">
            ${pdfDownloadLink(p)}
            ${doiUrl!=='#' ? `<a href="${esc(doiUrl)}" target="_blank" rel="noopener" class="btn-sm">官网原文 ↗</a>` : '<span class="text-muted">原文链接待补</span>'}
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
    const translatedTitle = p.draftData?.title_zh || quicklookOf(p)?.title_zh || p.titleZh;
    const title = esc(p.draftData?.title_zh ? `[导读] ${p.draftData.title_zh}` : translatedTitle || p.title);

    return `
      <div class="compact-row" data-paper-id="${esc(p.id)}">
        <div class="compact-main">
          <button class="compact-title title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}" title="${esc(p.title)}">${title}</button>
          ${translatedTitle ? `<div class="compact-original-title" lang="en">${esc(p.title)}</div>` : ''}
          ${publicationStatusHtml(p)}
          <div class="compact-meta">
            <span class="journal-badge ${pubClass}" title="${esc(journalName)}">${esc(journalName)}</span>
            ${journalMetricBadge(p)}
            ${designBadgeHtml(p)}
            ${p.kind ? `<span class="tag-pill kind-pill">${esc(p.kind)}</span>` : ''}
            <span class="date-badge" title="${esc(p.dateBasis || '来源记录日期，未经逐篇核验')}">${esc(dateStr)}</span>
          </div>
        </div>
        <div class="compact-actions">
          <button class="btn-sm" data-action="open-drawer" data-paper-id="${esc(p.id)}" title="速读">速读</button>
          ${p.hasDraft ? `<button class="btn-sm btn-share" data-action="share-wechat" data-paper-id="${esc(p.id)}" title="复制微信文案">文案</button>` : ''}
          <button class="btn-sm ${isHuddled ? 'active' : ''}" data-action="toggle-huddle" data-paper-id="${esc(p.id)}" title="精选清单">${isHuddled ? '已入' : '精选'}</button>
          ${pdfDownloadLink(p)}
          ${doiUrl!=='#' ? `<a href="${esc(doiUrl)}" target="_blank" rel="noopener" class="btn-sm" title="官网原文">↗</a>` : '<span class="text-muted" title="原文链接待补">—</span>'}
        </div>
      </div>
    `;
  }

  // Main Render Stream
  function applyDoiSearchLayout(doi) {
    const special = state.mode === 'weekly' || state.mode === 'sources';
    const stream = $('#streamSection'), weekly = $('#weeklySection'), sources = $('#sourcesSection');
    if (stream) stream.hidden = !doi && special;
    if (weekly) weekly.hidden = !!doi || state.mode !== 'weekly';
    if (sources) sources.hidden = !!doi || state.mode !== 'sources';
    const noSidebar = !!doi || special || state.mode === 'curated';
    const sidebar = $('#appSidebar'); if (sidebar) sidebar.style.display = noSidebar ? 'none' : '';
    const toggle = $('#filterToggleBtn'); if (toggle) toggle.hidden = noSidebar;
    const app = $('.app-container');
    if (app) {
      app.classList.toggle('full-width-layout', noSidebar);
      app.classList.toggle('weekly-layout', !doi && state.mode === 'weekly');
      app.classList.toggle('sources-layout', !doi && state.mode === 'sources');
    }
  }
  function supplementalLibraryNotice() {
    if (SUPPLEMENTAL_LIBRARY.state === 'error') return '<div class="doi-library-notice">补录文献暂未加载，已保留现有文献。<button class="btn-sm" data-action="refresh-doi-library">重试加载</button></div>';
    if (SUPPLEMENTAL_LIBRARY.more) return '<div class="doi-library-notice">还有补录文献未显示。<button class="btn-sm" data-action="load-doi-library">继续加载补录</button></div>';
    return '';
  }
  function renderDoiStream(doi, streamEl, loadMoreBtn) {
    const papers = exactDoiPapers(doi), lookup = DOI_LOOKUPS.get(doi);
    const job = DOI_JOBS.get(doi), activeJob = doiJobActive(job);
    ['#aiDigest', '#modeNote', '#laneBar', '#rangeBar', '#curatedDayBar', '#sortSelector'].forEach(selector => { const el = $(selector); if (el) el.hidden = true; });
    const filters = $('#activeFiltersBar');
    if (filters) filters.innerHTML = `<span class="results-meta">按 DOI 全站检索 · <b>${papers.length}</b> 篇文献</span><span class="filter-badge-active doi-filter-badge"><span class="doi-filter-value">${esc(doi)}</span><button class="filter-badge-remove" data-clear="search" aria-label="清除 DOI 检索">&times;</button></span>`;
    const pendingLookup = !lookup || lookup.state === 'loading';
    const uncertain = lookup && ['error', 'unsupported'].includes(lookup.state);
    const message = pendingLookup ? '正在检查补录文献…' : uncertain ? '已检索现有题录；补录状态暂不可用。' : papers.length ? '已按完整 DOI 匹配，当前栏目与筛选条件不影响结果。' : '站内暂未收录这个 DOI。';
    let conflictNotice = '';
    const record = DOI_FULLTEXT.get(doi);
    if (record) {
      const conflicts = STATIC_DOI_PAPERS.filter(p => exactDoi(p.doi) === doi && !sameDoiTitle(p.title, record.title));
      if (conflicts.length) conflictNotice = `<div class="doi-identity-notice"><b>原有题录对应待核实</b><p>原有题名：${esc(conflicts[0].title)}</p><p>本次官方题名：${esc(record.title)}。新全文仅与下方相符题名关联；原有导读保留。</p></div>`;
    }
    streamEl.className = state.viewMode === 'compact' ? 'articles-stream compact-mode' : 'articles-stream';
    streamEl.innerHTML = `<div class="doi-search-notice"><h3>按 DOI 全站检索</h3><p>${message}</p>${doiJobNotice(doi)}<button class="btn-sm" data-action="refresh-doi-status" data-doi="${esc(doi)}"${pendingLookup ? ' disabled' : ''}>刷新收录状态</button></div>`
      + conflictNotice + papers.map(state.viewMode === 'compact' ? renderCompactRow : renderArticleCard).join('')
      + (!papers.length ? '<div class="empty-state doi-empty"><h3>' + (activeJob ? '后台任务已提交' : pendingLookup ? '正在核对收录状态' : uncertain ? '现有题录未命中' : '未找到站内文献') + '</h3><p>' + (activeJob ? '后台取得官方题录后会加入文献库，取得全文后可下载。' : '输入全文口令提交请求；取得并核验全文后，这里会出现“下载 PDF”。') + '</p><a href="' + esc(job && !activeJob ? '/api/acquire/retry?doi=' + encodeURIComponent(doi) : acquireDoiUrl(doi)) + '" target="_blank" rel="noopener" class="btn-sm btn-primary">' + (activeJob ? '查看任务状态' : job ? '重新提交全文任务' : '获取全文') + '</a></div>' : '');
    if (loadMoreBtn) loadMoreBtn.hidden = true;
    if (!lookup) lookupSupplementalDoi(doi);
  }
  function renderStream() {
    if (DOI_JOB_WATCH.doi && exactDoi(state.search) !== DOI_JOB_WATCH.doi) watchDoiJob(DOI_JOB_WATCH.doi);
    const streamEl = $('#articlesStream');
    const loadMoreBtn = $('#loadMoreBtn');
    if (!streamEl) return;

    const doi = exactDoi(state.search);
    if (radarArchiveNeeded()) loadRadarArchive();
    applyDoiSearchLayout(doi);
    if (doi) { renderDoiStream(doi, streamEl, loadMoreBtn); syncUrl(); return; }
    if (state.mode === 'weekly') { renderWeeklyHeader(); renderNextCandidates(); syncUrl(); return; }
    if (state.mode === 'sources') { renderSourcesHealth(); syncUrl(); return; }

    const filtered = getFilteredArticles();
    renderDigestBar(filtered);
    renderActiveFilterChips(filtered.length);
    renderModeNote();
    renderLaneBar();
    renderCuratedDayBar();
    renderRangeBar();
    renderMoreFilters();
    { const ss = $('#sortSelector'); if (ss) { ss.hidden = state.mode === 'curated'; ss.value = state.sort; } }
    syncUrl();

    if (filtered.length === 0) {
      streamEl.innerHTML = radarArchiveNotice() + renderEmptyFilters();
      if (state.mode === 'library') streamEl.innerHTML += supplementalLibraryNotice();
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
        const label = groupBy === 'journal' ? `${esc(k)} ${journalMetricBadge(k)} <small>共 ${totals.get(k)} 篇 · 最新 ${esc((filtered.find(p => (p.cleanJournal || p.journal || '未标注期刊') === k) || {}).date?.slice(0, 10) || '')}</small>` : `${esc(k)} <small>${totals.get(k)} 篇</small>`;
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
      // At the end of one day, offer the previous day instead of a dead end.
      const days = curatedDays(), day = curatedDay(days), index = days.findIndex(([d]) => d === day);
      if (day && index >= 0 && index < days.length - 1) {
        const [older, count] = days[index + 1];
        streamEl.insertAdjacentHTML('beforeend', `<button type="button" class="load-more-btn day-next-btn" data-day="${esc(older)}">继续看 ${esc(older)} · ${count} 篇</button>`);
      }
    } else if (state.viewMode === 'compact') {
      streamEl.className = 'articles-compact-list';
      streamEl.innerHTML = visibleItems.map(renderCompactRow).join('');
    } else {
      streamEl.className = 'articles-stream';
      streamEl.innerHTML = visibleItems.map(renderArticleCard).join('');
    }

    if (state.mode === 'library') streamEl.innerHTML += supplementalLibraryNotice();
    { const note = radarArchiveNotice(); if (note) streamEl.insertAdjacentHTML('afterbegin', note); }
    if (loadMoreBtn) {
      loadMoreBtn.hidden = visibleItems.length >= filtered.length;
    }
  }

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

  // ==== src/app/08-sources-mode.js · Source health page and mode switching ====
  // Render Sources Health Grid
  function sourceHealthDetails(s) {
    const reason = {
      publisher_access_challenge: '出版商返回访问验证页，本轮停止继续请求同主机。',
      publisher_cookie_requirement: '出版商要求浏览器 Cookie，订阅请求跳转到网页。',
      publisher_login_page: '订阅请求跳转到登录页。',
      feed_redirected_to_journal_page: '旧订阅地址跳转到期刊网页，未取得 RSS。',
      html_instead_of_feed: '本轮返回网页内容，未取得有效订阅。',
      http_access_refusal: '同主机已拒绝或限流，本轮没有继续请求。'
    }[s.failureReason || s.blockedReason];
    const parts = reason ? [reason] : [];
    if (!['ok', 'empty_feed', 'filtered_empty'].includes(s.status)) {
      const last = typeof s.lastSuccessfulAt === 'string' ? Date.parse(s.lastSuccessfulAt) : NaN;
      if (Number.isFinite(last) && last <= Date.now()) {
        parts.push(s.lastSuccessfulAtBasis === 'strict_feed_parse'
          ? `最近严格解析成功：${contentDate(s.lastSuccessfulAt)}（北京时间）。`
          : `历史成功记录：${contentDate(s.lastSuccessfulAt)}（北京时间，未核验为严格订阅解析）。`);
      } else parts.push('尚无可核实的最近订阅成功记录。');
    }
    const x = s.excludedItems;
    if (x) {
      const reasons = [[x.undated, '日期缺失'], [x.olderThan14Days, '超出14天'], [x.future, '未来日期'], [x.unclassifiedOrInvalid, '主题或链接未入选']]
        .filter(([n]) => n > 0).map(([n, label]) => `${label} ${n} 条`);
      if (reasons.length) parts.push(reasons.join('；') + '。');
    } else if (s.status === 'filtered_empty') parts.push('已有订阅条目未通过日期或主题筛选，不代表期刊没有新文章。');
    const p = s.pubmedFallback;
    if (p) {
      if (p.status === 'records_observed') parts.push(`PubMed 备用快照 ${p.observedItems} 条，近14天 ${p.eligibleItems} 条${p.stale || olderThan(p.checkedAt,6) ? '（快照已过期）' : ''}。`);
      else parts.push(p.configured ? 'PubMed 备用查询尚无匹配记录。' : 'PubMed 备用查询尚未覆盖此来源。');
      if (p.checkedAt && (p.configured || p.status === 'records_observed')) parts.push(`备用检查：${contentDate(p.checkedAt)}（北京时间）。`);
      if (p.queryScope === 'cardiovascular_or_ai' && p.configured) parts.push('备用检索限心血管或 AI 主题。');
      if (p.queryTruncated && p.configured) parts.push('备用检索达到结果上限，不能据此判断完整覆盖。');
    }
    return parts.join(' ');
  }

  function renderSourcesHealth() {
    const grid = $('#sourcesHealthGrid');
    const meta = $('#sourcesHealthMeta');
    if (!grid) return;

    const sources = HEALTH.sources || [];
    const successful = s => ['ok','empty_feed','filtered_empty'].includes(s.status);
    const okCount = sources.filter(successful).length;
    const summary = $('#sourcesHealthSummary');
    if (summary) summary.innerHTML = `<div><strong>${sources.length}</strong><span>订阅信源</span></div><div><strong>${okCount}</strong><span>本轮获取成功</span></div><div class="${sources.length > okCount ? 'source-summary-attention' : ''}"><strong>${sources.length - okCount}</strong><span>需要关注</span></div>`;

    if (meta) {
      meta.textContent = `检查时间：${contentDate(HEALTH.checkedAt)}（北京时间）${olderThan(HEALTH.checkedAt,6) ? ' · 报告已过期，不能代表当前可用率' : ''}`;
      meta.classList.toggle('source-report-stale', olderThan(HEALTH.checkedAt,6));
    }

    const q = state.search.trim().toLowerCase();
    const filtered = sources.filter(s => !q || queryMatches([s.name, s.id, s.url, s.status, sourceHealthDetails(s),
      s.status === 'not_feed' ? '返回非订阅内容' : successful(s) ? '获取成功' : '获取异常 暂停'].filter(Boolean).join(' ').toLowerCase(), q));
    grid.innerHTML = specialSearchStatus('信源状态（名称、订阅地址与状态）', filtered.length, sources.length, '个信源')
      + (!filtered.length ? '<p class="special-search-empty" role="status">没有匹配的信源，请清除关键词或更换名称；论文请到文献雷达检索。</p>' : '')
      + [...filtered].sort((a, b) => Number(successful(a)) - Number(successful(b))).map(s => {
      const isOk = successful(s);
      const statusLabel = s.status === 'empty_feed' ? '有效空源' : s.status === 'filtered_empty' ? '获取成功 · 暂无入选' : isOk ? '获取成功' :
        s.status === 'not_feed' ? '返回非订阅内容' : s.status === 'not_checked_host_blocked' ? '同主机暂停检查' : s.status === 'parse_error' ? '订阅格式异常' : s.status === 'http_error' ? `来源 HTTP ${s.httpStatus || '错误'}` : '获取异常';
      return `
        <article class="source-item${isOk ? '' : ' source-needs-attention'}">
          <div class="source-item-head">
            <h3 class="source-item-name">${esc(s.name)}</h3>
            <span class="source-status-badge ${isOk ? 'source-status-ok' : 'source-status-err'}">
              ${esc(statusLabel)}
            </span>
          </div>
          <div class="source-journal-metrics">${journalMetricBadge(s.name)}${journalMetricDetails(s.name)}</div>
          <dl class="source-counts"><div><dt>原始条目</dt><dd>${isOk ? esc(s.rawItems ?? s.items ?? '未统计') : '未获取'}</dd></div><div><dt>近 14 天</dt><dd>${esc(s.eligibleItems ?? '待统计')}</dd></div><div><dt>含摘要</dt><dd>${isOk ? esc(s.itemsWithAbstracts ?? '未统计') : '未获取'}</dd></div></dl>
          ${s.cachedItems ? `<p class="source-cache-note">保留 ${esc(s.cachedItems)} 条旧缓存 · 最近缓存 ${esc(contentDate(s.lastCachedFetchAt || s.lastSuccessfulAt))}</p>` : ''}
          ${sourceHealthDetails(s) ? `<p class="source-detail-note">${esc(sourceHealthDetails(s))}</p>` : ''}
          <div class="source-item-foot"><span>检查 ${esc(contentDate(s.checkedAt || HEALTH.checkedAt))}</span>${safeSourceUrl({url:s.url}) ? `<a href="${esc(safeSourceUrl({url:s.url}))}" target="_blank" rel="noopener">查看订阅源 ↗</a>` : ''}</div>
        </article>
      `;
    }).join('');
  }

  // Switch App Mode (Candidates, Curated, Library, Weekly, Sources)
  function switchMode(newMode, keepRange) {
    if (newMode !== 'weekly') closeDeepReading({ fromHistory: true });
    if (!keepRange && newMode !== state.mode) state.range = defaultRange(newMode);
    state.mode = newMode;
    state.page = 1;
    const search = $('#globalSearch');
    if (search) {
      search.placeholder = newMode === 'sources' ? '搜索信源名称、地址或状态…' : newMode === 'weekly' ? '搜索当前榜题名、作者、DOI…' : '搜索当前栏目题名、DOI…';
      search.setAttribute('aria-label', newMode === 'sources' ? '检索信源名称、地址与状态；完整 DOI 全站匹配' : newMode === 'weekly' ? '检索近7天榜；完整 DOI 全站匹配；支持中文关键词' : '检索当前栏目文献；完整 DOI 全站匹配；支持中文关键词');
    }

    // Toggle active nav tab
    $$('.nav-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === newMode);
    });
    $('#sourceStatusBtn')?.setAttribute('aria-pressed', String(newMode === 'sources'));

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
      appContainer.classList.toggle('curated-layout', newMode === 'curated');
      appContainer.classList.toggle('weekly-layout', newMode === 'weekly');
      appContainer.classList.toggle('sources-layout', newMode === 'sources');
    }
    window.scrollTo({ top: 0 });

    if (exactDoi(state.search)) {
      if (newMode === 'sources') renderSourcesHealth();
      if (newMode === 'weekly') { renderWeeklyHeader(); renderNextCandidates(); }
      renderStream();
    } else if (newMode === 'sources') {
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
    el.innerHTML = '<p class="deep-reading-label"><span class="content-label">AI 全文精读 · 未经人工审核</span></p><p class="deep-reading-status" role="status">今日已更新 <b>' + groups.todayCount + '</b> 篇 · 每天目标 ' + (Number.isInteger(status.target) && status.target > 0 ? status.target : 8) + ' 篇</p><p class="deep-reading-timing">北京时间 04:47 计划启动' + (data.updatedAt ? ' · 最近更新 ' + esc(contentDate(data.updatedAt)) : '') + '</p>' +
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

  // ==== src/app/10-browse-events.js · Browse controls, event wiring and start-up ====
  // 更多筛选: everything beyond lane, time and search. The panel is the left column on wide
  // screens (folded away until a condition is active or the reader opens it) and a bottom sheet on phones.
  const NARROW_FILTERS = '(max-width: 1024px)';
  function moreFilterCount() {
    return sidebarSelections().length + (state.reading ? 1 : 0) + (state.favoritesOnly ? 1 : 0) + (state.minor ? 1 : 0);
  }
  function moreFiltersOpen() {
    return typeof state.moreFiltersOpen === 'boolean' ? state.moreFiltersOpen : moreFilterCount() > 0;
  }
  function renderMoreFilters() {
    const toggle = $('#filterToggleBtn'), app = $('.app-container');
    const n = moreFilterCount(), lane = usesLane();
    const narrow = !!(window.matchMedia && window.matchMedia(NARROW_FILTERS).matches);
    if (app) app.classList.toggle('filters-collapsed', lane && !moreFiltersOpen());
    if (toggle) {
      toggle.textContent = '更多筛选' + (n ? ` · ${n}` : '');
      toggle.classList.toggle('active', n > 0);
      toggle.setAttribute('aria-expanded', String(narrow ? !!$('#appSidebar.open') : lane && moreFiltersOpen()));
      toggle.setAttribute('aria-label', n ? `更多筛选，已生效 ${n} 项` : '更多筛选');
    }
    if (!lane) return;
    const reading = $('#readingSelect'); if (reading) reading.value = state.reading;
    const followed = state.favoriteJournals.includes(state.journal);
    const star = $('#favoriteJournalBtn');
    if (star) { star.disabled = !state.journal; star.textContent = followed ? '★ 已关注' : '☆ 关注期刊'; star.setAttribute('aria-pressed', String(followed)); }
    const fav = $('#favoritesOnlyBtn');
    if (fav) { fav.textContent = '我的期刊 ' + state.favoriteJournals.length; fav.classList.toggle('active', state.favoritesOnly); fav.setAttribute('aria-pressed', String(state.favoritesOnly)); }
    const minor = $('#minorToggleBtn');
    if (minor) { minor.classList.toggle('active', state.minor); minor.setAttribute('aria-pressed', String(state.minor)); }
    const period = $('#rangeExplanation');
    if (period) period.textContent = state.range === 'all' ? '日期与研究类型均以来源信息为准；未知项明确保留。' : `发表时间：北京时间 ${rangeStart()} 至 ${beijingToday()}；不含日期未知及仅有刊期的条目。`;
  }
  $('#modeNote')?.addEventListener('click',e=>{if(e.target.closest('a,button'))return;e.currentTarget.classList.toggle('note-open');});
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

  // 更多筛选: a bottom sheet on phones, a foldable left column on wide screens
  $('#filterToggleBtn')?.addEventListener('click', () => {
    const sb = $('#appSidebar');
    if (!sb) return;
    if (window.matchMedia && window.matchMedia(NARROW_FILTERS).matches) {
      const open = sb.classList.toggle('open');
      $('#filterToggleBtn').setAttribute('aria-expanded', String(open));
      return;
    }
    state.moreFiltersOpen = !moreFiltersOpen();
    renderMoreFilters();
    if (state.moreFiltersOpen) sb.querySelector('button, select')?.focus({ preventScroll: true });
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
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) {
      state.day = dayBtn.dataset.day;
      state.page = 1;
      renderStream();
      const stream = $('#streamSection'), top = stream ? stream.getBoundingClientRect().top + window.scrollY - 70 : 0;
      if (stream && window.scrollY > top) window.scrollTo({ top, behavior: 'instant' });
      $(`[data-day="${state.day}"]`)?.focus({ preventScroll: true });
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
// ==== src/app/11-page-extras.js · Standalone page helpers outside the main app scope ====

;(function () {
  const button = document.getElementById('backToTopBtn');
  if (!button) return;
  const update = () => { button.hidden = window.scrollY < 600; };
  window.addEventListener('scroll', update, { passive: true });
  button.addEventListener('click', () => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('brandLogo')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: reduced ? 'instant' : 'smooth' });
  });
  update();
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
