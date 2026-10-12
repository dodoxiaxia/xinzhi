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

