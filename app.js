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
  // The build lists the papers whose file the server can find in the literature index; local preview data has no list and keeps the old rule.
  const PDF_LIBRARY_IDS = new Set(Array.isArray(LIBRARY.pdfIds) ? LIBRARY.pdfIds.map(String) : LIBRARY.papers.filter(p => p.doi || p.title).map(p => String(p.id)));
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
    script.onerror = () => { window.XINZHI_RADAR_READY = null; RADAR_LOAD.state = 'error'; script.remove(); if (state.mode === 'candidates' || exactDoi(state.search)) renderStream(); if ($('#huddleModalBackdrop.open')) openHuddleModal(); };
    document.head.appendChild(script);
  }
  function radarArchiveNeeded() {
    // First-load rows cover the last three weeks, so only longer ranges (or a site-wide DOI) need the archive.
    return !!exactDoi(state.search) || (state.mode === 'candidates' && !['7', '14'].includes(state.range));
  }
  function radarArchiveNotice() {
    const forDoi = !!exactDoi(state.search);
    if (!forDoi && (state.mode !== 'candidates' || !radarArchiveNeeded())) return '';
    if (forDoi) {
      if (RADAR_LOAD.state === 'loading' || RADAR_LOAD.state === 'idle') return '<p class="radar-archive-note" role="status">正在检索旧雷达存档…</p>';
      if (RADAR_LOAD.state === 'error') return '<p class="radar-archive-note" role="status">旧雷达存档加载失败，暂时无法确认站内是否收录这个 DOI。<button type="button" class="btn-sm" data-action="retry-radar-archive">重试</button></p>';
      return '';
    }
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
  const LIBRARY_REFRESH_TTL_MS = 60000;

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
    return String(value || '').trim().replace(/^\[[A-Za-z ]+\]\s*/, '').normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim().replace(/[\s.。!?;:,，；：]+$/u, '');
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
      basis: '官方题录 · 非全文精读', tags: [], studyDesign: '研究类型待核验', quantitativeMetrics: {}
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
    const iso = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : '';
    DOI_JOBS.set(doi, { id: raw.id, doi, state: raw.state, stage,
      message: typeof raw.message === 'string' ? raw.message.slice(0, 500) : '',
      verificationMode: ['immediate', 'hourly'].includes(raw.verificationMode) ? raw.verificationMode : '',
      verificationExpectedAt: iso(raw.verificationExpectedAt), nextVerificationAt: iso(raw.nextVerificationAt),
      sourceKind: ['reader_upload', 'open_access', 'download'].includes(raw.sourceKind) ? raw.sourceKind : '',
      reason: typeof raw.reason === 'string' && /^[a-z_]{1,40}$/.test(raw.reason) ? raw.reason : '',
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
  // Submitting a request, retrying and refreshing all happen inside the status block, so there is no second page
  // to visit and come back from. The passphrase goes in the POST body of a same-origin request, never in a URL.
  function liveFtForm(doi, form, inDrawer) {
    if (form && form.isConnected) return form;
    const forms = [...document.querySelectorAll('form[data-ft-form]')].filter(f => exactDoi(f.dataset.doi) === doi);
    if (inDrawer) {
      const df = forms.find(f => f.closest('#drawerFulltext'));
      if (df) return df;
    }
    return forms.find(f => !f.hidden && !f.closest('#drawerFulltext')) || forms.find(f => !f.hidden) || forms[0] || null;
  }
  function setFtRecheckButton(form, doi, show, disabled = false) {
    if (!form) return;
    let recheck = form.querySelector('[data-ft-action="refresh"]');
    if (!show) { if (recheck) recheck.remove(); return; }
    if (!recheck) {
      recheck = document.createElement('button');
      recheck.type = 'button';
      recheck.className = 'btn-sm ft-recheck-btn';
      recheck.dataset.ftAction = 'refresh';
      recheck.dataset.doi = doi;
      recheck.textContent = '刷新状态';
      form.appendChild(recheck);
    }
    recheck.disabled = !!disabled;
  }
  async function reconcileFtFormAfterLookup(doi, form, inDrawer, prev = null) {
    if (DOI_TOUCHED.size < 10) DOI_TOUCHED.add(doi);
    await lookupSupplementalDoi(doi, true);
    if (exactDoi(state.search) !== doi && !DOI_TOUCHED.has(doi)) refreshSupplementalView();
    const lookup = DOI_LOOKUPS.get(doi);
    const job = DOI_JOBS.get(doi);
    const paper = exactDoiPapers(doi)[0] || DOI_FULLTEXT.get(doi) || { doi };
    const view = fulltextState(paper);
    const hasProgress = doiJobActive(job) || ['ready', 'verifying', 'queued', 'running', 'review'].includes(view.kind)
      || (!!job && (!prev || prev.mode === 'submit' || job.id !== prev.jobId || job.state !== prev.jobState));
    const live = liveFtForm(doi, form, inDrawer);
    if (hasProgress) {
      if (live) {
        const inp = live.querySelector('input[name="passphrase"]'), btn = live.querySelector('button[type="submit"]'), err = live.querySelector('.ft-error');
        if (inp) inp.value = '';
        if (err) err.textContent = '已提交，正在处理';
        if (btn) btn.disabled = true;
        delete live.dataset.busy;
        delete live.dataset.ftUncertain;
        setFtRecheckButton(live, doi, false);
        live.hidden = true;
      }
      showToast('已提交，正在处理');
      return;
    }
    if (lookup && lookup.state === 'complete') {
      if (live) {
        const btn = live.querySelector('button[type="submit"]'), err = live.querySelector('.ft-error');
        if (err) err.textContent = '核对后确认没有提交上，可以重试';
        if (btn) btn.disabled = false;
        delete live.dataset.busy;
        delete live.dataset.ftUncertain;
        setFtRecheckButton(live, doi, false);
        live.hidden = false;
      }
      return;
    }
    if (live) {
      const btn = live.querySelector('button[type="submit"]'), err = live.querySelector('.ft-error');
      if (err) err.textContent = '仍无法确认是否已提交，请稍后再点“刷新状态”核对，先不要重复提交';
      if (btn) btn.disabled = true;
      delete live.dataset.busy;
      live.dataset.ftUncertain = '1';
      setFtRecheckButton(live, doi, true, false);
      live.hidden = false;
    }
  }
  async function submitFulltextForm(form) {
    if (!form || form.dataset.busy === '1' || form.dataset.ftUncertain === '1') return;
    const doi = exactDoi(form.dataset.doi), input = form.querySelector('input[name="passphrase"]'), error = form.querySelector('.ft-error'), button = form.querySelector('button[type="submit"]');
    if (!doi || !input || !input.value || (button && button.disabled)) return;
    const inDrawer = !!(form.closest && form.closest('#drawerFulltext'));
    const mode = form.dataset.mode, route = mode === 'muse-retry' ? '/api/muse/retry' : mode === 'legacy-retry' ? '/api/acquire/retry' : '/api/acquire';
    const prevJob = DOI_JOBS.get(doi);
    const prev = { mode: mode || 'submit', jobId: prevJob ? prevJob.id : '', jobState: prevJob ? prevJob.state : '' };
    const messages = { pdf_passphrase_invalid: '全文口令不正确，请重新输入。', pdf_rate_limited: '口令错误次数过多，请一小时后再试。', library_paused: '这篇暂时停止获取，请稍后再试。', library_identity: '这篇的全文来源还在核对中，暂时不能重新提交。', muse_owner_conflict: '这篇已有任务在进行，请刷新状态。' };
    if (error) error.textContent = ''; if (button) button.disabled = true;
    form.dataset.busy = '1';
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(route + '?doi=' + encodeURIComponent(doi), { method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passphrase: input.value }).toString() });
      let result = null; try { result = await response.json(); } catch (e) { result = null; }
      if (!response.ok && response.status !== 202) {
        const code = result && typeof result.error === 'string' ? result.error : '';
        if (code && (Object.prototype.hasOwnProperty.call(messages, code) || (response.status >= 400 && response.status < 500 && result.ok === false))) {
          throw Object.assign(new Error(code), { code, knownError: true });
        }
        throw Object.assign(new Error(code || 'submit_failed'), { code, uncertain: true });
      }
      if (!result || result.ok !== true) {
        throw Object.assign(new Error('submit_unconfirmed'), { uncertain: true });
      }
      const liveNow = liveFtForm(doi, form, inDrawer);
      const liveNowInput = liveNow && liveNow.querySelector('input[name="passphrase"]');
      if (liveNowInput) liveNowInput.value = '';
      input.value = '';
      if (result && result.job) mergeDoiJob(doi, result.job);
      if (DOI_TOUCHED.size < 10) DOI_TOUCHED.add(doi);
      await lookupSupplementalDoi(doi, true);
      if (exactDoi(state.search) !== doi && !DOI_TOUCHED.has(doi)) refreshSupplementalView();
      const live = liveFtForm(doi, form, inDrawer);
      if (live) {
        const liveInput = live.querySelector('input[name="passphrase"]'), liveBtn = live.querySelector('button[type="submit"]');
        if (liveInput) liveInput.value = '';
        if (liveBtn) liveBtn.disabled = false;
        delete live.dataset.busy;
        delete live.dataset.ftUncertain;
        setFtRecheckButton(live, doi, false);
      }
    } catch (e) {
      if (e && e.knownError) {
        const live = liveFtForm(doi, form, inDrawer);
        if (live) {
          const liveErr = live.querySelector('.ft-error'), liveBtn = live.querySelector('button[type="submit"]');
          if (liveErr) liveErr.textContent = messages[e.code] || '提交没有成功，请稍后再试。';
          if (liveBtn) liveBtn.disabled = false;
          delete live.dataset.busy;
          delete live.dataset.ftUncertain;
          setFtRecheckButton(live, doi, false);
        }
        return;
      }
      const live = liveFtForm(doi, form, inDrawer);
      if (live) {
        const liveErr = live.querySelector('.ft-error'), liveBtn = live.querySelector('button[type="submit"]');
        if (liveErr) liveErr.textContent = '不确定是否已提交，正在核对状态…';
        if (liveBtn) liveBtn.disabled = true;
        live.dataset.busy = '1';
      }
      await reconcileFtFormAfterLookup(doi, form, inDrawer, prev);
    } finally { clearTimeout(timer); }
  }
  function captureFtFormSnapshots() {
    if (typeof document === 'undefined') return [];
    const snaps = [];
    const drawerOpen = !!$('#readerDrawer.open');
    const drawerPaperId = state.activeDrawerPaper ? String(state.activeDrawerPaper.id) : '';
    document.querySelectorAll('form[data-ft-form]:not([hidden]), form[data-ft-dl-form]:not([hidden])').forEach(form => {
      const inDrawer = !!form.closest('#drawerFulltext');
      if (inDrawer && !drawerOpen) return;
      const isDl = form.hasAttribute('data-ft-dl-form');
      const paperEl = form.closest('[data-paper-id]');
      const paperId = inDrawer ? drawerPaperId : (paperEl ? String(paperEl.dataset.paperId || '') : '');
      const doi = isDl ? '' : exactDoi(form.dataset.doi);
      if (!isDl && !doi) return;
      if (isDl && form.id !== 'drawerPdfForm' && !paperId) return;
      const input = form.querySelector('input[name="passphrase"]');
      const btn = form.querySelector('button[type="submit"]');
      const err = form.querySelector('.ft-error');
      const recheck = form.querySelector('[data-ft-action="refresh"]');
      const inputFocused = !!(input && document.activeElement === input);
      const btnFocused = !!(btn && document.activeElement === btn);
      const recheckFocused = !!(recheck && document.activeElement === recheck);
      snaps.push({
        isDl,
        inDrawer,
        isDrawerPdfForm: form.id === 'drawerPdfForm',
        paperId,
        doi,
        value: input ? input.value : '',
        inputDisabled: !!(input && input.disabled),
        btnDisabled: !!(btn && btn.disabled),
        btnText: btn ? btn.textContent : '',
        errorText: err ? err.textContent : '',
        busy: form.dataset.busy || '',
        uncertain: form.dataset.ftUncertain || '',
        isBusyClass: form.classList.contains('is-busy'),
        ariaBusy: form.getAttribute('aria-busy'),
        hasRecheck: !!recheck,
        recheckDisabled: !!(recheck && recheck.disabled),
        inputFocused,
        btnFocused,
        recheckFocused,
        selStart: inputFocused && typeof input.selectionStart === 'number' ? input.selectionStart : null,
        selEnd: inputFocused && typeof input.selectionEnd === 'number' ? input.selectionEnd : null,
        selDir: inputFocused ? (input.selectionDirection || 'none') : null
      });
    });
    return snaps;
  }
  function findFtSnapshotTarget(snap) {
    if (snap.isDrawerPdfForm) {
      const drawer = $('#readerDrawer.open');
      const form = $('#drawerPdfForm');
      const link = $('#drawerPdfLink');
      if (!drawer || !form || !link || link.hidden) return null;
      if (snap.paperId && String(state.activeDrawerPaper?.id || '') !== snap.paperId) return null;
      return form;
    }
    if (snap.isDl) {
      if (!snap.paperId) return null;
      const cards = [...document.querySelectorAll('#articlesStream [data-paper-id]')].filter(el => String(el.dataset.paperId || '') === snap.paperId);
      for (const card of cards) {
        const form = card.querySelector('form[data-ft-dl-form]');
        if (form) return form;
      }
      return null;
    }
    if (snap.inDrawer) {
      if (!$('#readerDrawer.open')) return null;
      if (snap.paperId && String(state.activeDrawerPaper?.id || '') !== snap.paperId) return null;
      return [...document.querySelectorAll('#drawerFulltext form[data-ft-form]')].find(f => exactDoi(f.dataset.doi) === snap.doi) || null;
    }
    const streamForms = [...document.querySelectorAll('#articlesStream form[data-ft-form]')].filter(f => exactDoi(f.dataset.doi) === snap.doi);
    if (snap.paperId) {
      const exact = streamForms.find(f => String(f.closest('[data-paper-id]')?.dataset.paperId || '') === snap.paperId);
      if (exact) return exact;
    }
    return streamForms[0] || null;
  }
  function restoreFtFormSnapshots(snaps) {
    if (!snaps || !snaps.length) return;
    for (const snap of snaps) {
      const form = findFtSnapshotTarget(snap);
      if (!form) continue;
      form.hidden = false;
      const input = form.querySelector('input[name="passphrase"]');
      const btn = form.querySelector('button[type="submit"]');
      const err = form.querySelector('.ft-error');
      if (input) {
        input.value = snap.value;
        input.disabled = snap.inputDisabled;
      }
      if (btn) {
        btn.disabled = snap.btnDisabled;
        if (snap.btnText) btn.textContent = snap.btnText;
      }
      if (err) err.textContent = snap.errorText;
      if (snap.busy) form.dataset.busy = snap.busy; else delete form.dataset.busy;
      if (snap.uncertain) form.dataset.ftUncertain = snap.uncertain; else delete form.dataset.ftUncertain;
      form.classList.toggle('is-busy', snap.isBusyClass);
      if (snap.ariaBusy) form.setAttribute('aria-busy', snap.ariaBusy); else form.removeAttribute('aria-busy');
      if (!snap.isDl) setFtRecheckButton(form, snap.doi, snap.hasRecheck, snap.recheckDisabled);
      if (snap.inputFocused && input && !input.disabled) {
        try {
          input.focus({ preventScroll: true });
          if (snap.selStart !== null && snap.selEnd !== null) {
            input.setSelectionRange(snap.selStart, snap.selEnd, snap.selDir || 'none');
          }
        } catch (e) { /* ignore */ }
      } else if (snap.btnFocused && btn && !btn.disabled) {
        try { btn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      } else if (snap.recheckFocused) {
        const recheck = form.querySelector('[data-ft-action="refresh"]');
        if (recheck && !recheck.disabled) { try { recheck.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      }
    }
  }
  function refreshSupplementalView() {
    const snapshots = captureFtFormSnapshots();
    updateHeaderBadges();
    if (!exactDoi(state.search) && state.mode !== 'weekly' && state.mode !== 'sources') renderSidebarFilters();
    renderStream();
    if (state.activeDrawerPaper) openReaderDrawer(allPapersMap.get(state.activeDrawerPaper.id) || state.activeDrawerPaper);
    if ($('#huddleModalBackdrop.open')) openHuddleModal();
    restoreFtFormSnapshots(snapshots);
  }
  async function lookupSupplementalDoi(doi, retry = false) {
    if (!doi) return;
    const current = DOI_LOOKUPS.get(doi);
    if (!retry && current) return current.promise;
    if (current?.state === 'loading' && current.promise) await current.promise;
    if (DOI_LOOKUPS.get(doi)?.state === 'loading') return DOI_LOOKUPS.get(doi).promise;
    const run = (async () => {
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
    })();
    DOI_LOOKUPS.set(doi, { state: 'loading', promise: run });
    return run;
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
  const VALID_MODES = ['curated', 'weekly', 'candidates', 'library', 'sources'];
  function parseJournalList(many, one) {
    const out = [];
    String(many || '').split(',').forEach(s => { const v = decodeURIComponent(s).trim(); if (v && !out.includes(v)) out.push(v); });
    const single = String(one || '').trim();
    if (single && !out.includes(single)) out.unshift(single);
    return out;
  }
  function selectedJournals() {
    if (Array.isArray(state.journals) && state.journals.length) return state.journals;
    return state.journal ? [state.journal] : [];
  }
  function isCaseReport(p) { return (p && p.studyDesign) === '病例报告'; }
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
      excludeCaseReports: params.get('nocase') === '1',
      journals: parseJournalList(params.get('journals'), params.get('journal')),
      journalTier: ['flagship', 'cardioMain', 'cardioSub', 'ai', 'other'].includes(params.get('jtier') || '') ? params.get('jtier') : '',
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
    'favoritesOnly', 'excludeCaseReports', 'journals', 'journalTier', 'day', 'weeklyCat', 'weeklyPane', 'sourceFilter', 'ftFilter'
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
    excludeCaseReports: initialUrlState.excludeCaseReports,
    journals: initialUrlState.journals || [],
    journalTier: initialUrlState.journalTier || '',
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

  function isInternalSourceName(s) {
    return /^PubMed\s*:/i.test(s) || String(s).includes('追踪');
  }
  function cardJournalName(p) {
    const clean = String((p && p.cleanJournal) || '').trim();
    const raw = String((p && p.journal) || '').trim();
    // A PubMed/追踪 feed label is not a journal; do not fall back to the feed topic (e.g. "atrial fibrillation").
    if (clean && !isInternalSourceName(clean)) return clean;
    if (clean && isInternalSourceName(clean)) return '期刊待补';
    if (raw && !isInternalSourceName(raw)) return raw;
    return '期刊待补';
  }
  function huddleStarSvg(on) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.9l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }

  // One-line takeaway: only existing brief / takeaway / editorial summary / quicklook one_line. Never invent. paper.summary is the abstract, not used here.
  function cardTakeaway(p) {
    const d = (p && p.draftData) || {};
    const ql = typeof quicklookOf === 'function' ? quicklookOf(p) : null;
    const raw = [d.takeaway, d.brief, p && p.takeaway, p && p.brief, ql && ql.one_line, d.summary]
      .find(v => typeof v === 'string' && v.trim());
    return raw ? String(raw).trim() : '';
  }
  function cardSideActionsHtml(p) {
    const isHuddled = state.huddle.includes(p.id);
    const sourceUrl = officialArticleUrl(p);
    const doiBlock = doiStatusBlock(p);
    const pid = esc(p.id);
    return `<div class="card-side-actions" role="group" aria-label="操作">
          <button type="button" class="card-icon-btn card-star${isHuddled ? ' active' : ''}" data-action="toggle-huddle" data-paper-id="${pid}" aria-pressed="${isHuddled}" aria-label="${isHuddled ? '移出精选' : '加入精选'}" title="${isHuddled ? '已精选，点击移出' : '加入精选'}">${huddleStarSvg(isHuddled)}</button>
          ${sourceUrl && !doiBlock ? `<a class="text-btn card-source" href="${esc(sourceUrl)}" target="_blank" rel="noopener" title="在期刊官网打开原文">官网<span aria-hidden="true">&thinsp;↗</span></a>` : ''}
          ${pdfDownloadLink(p)}
        </div>`;
  }
  function authorAffilHtml(p) {
    const authors = Array.isArray(p.authors) ? p.authors.filter(Boolean) : [];
    const affs = Array.isArray(p.affiliations) ? p.affiliations.filter(Boolean) : [];
    if (!authors.length && !affs.length) return '';
    const who = authors.length ? (authors.length > 1 ? `${authors[0]} 等` : authors[0]) : '';
    const aff = affs[0] || '';
    const summary = [who, aff].filter(Boolean).join(' · ');
    const full = [
      authors.length ? `<p class="drawer-bylines-authors">${esc(authors.join('，'))}</p>` : '',
      affs.length ? `<p class="drawer-bylines-affils">${esc(affs.join('；'))}</p>` : ''
    ].join('');
    return `<details class="drawer-bylines"><summary>${esc(summary)}</summary><div class="drawer-bylines-full">${full}</div></details>`;
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

  // ==== src/app/02-lanes.js · Relevance lanes, per-paper derived cache, quick-look data ====
  // ---- Relevance lanes: keep the reader's default view on cardiology + medical AI ----
  const CARDIO_TIERS = new Set(['心血管旗舰顶刊', '心律失常与电生理', '心衰与重症心肌', '冠脉介入与结构', '心血管影像与表型', '脑血管与高血压', '心血管综合与其他', '定向专病与团队']);
  const LANES = [
    { id: 'core', name: '心血管 + AI 医疗', short: '心血管+AI' },
    { id: 'crossai', name: '心血管 × AI', short: '心血管×AI' },
    { id: 'cardio', name: '心血管', short: '心血管' },
    { id: 'aimed', name: 'AI 医疗', short: 'AI 医疗' },
    { id: 'general', name: '综合医学', short: '综合医学' },
    { id: 'aitech', name: 'AI 行业动态', short: 'AI 行业' },
    { id: 'all', name: '全部', short: '全部领域' }
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
  // 一键生成 AI 速览：后端 /api/ql（Cloudflare _worker.js）。本地静态预览没有后端时自动隐藏按钮。
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
      fail: () => { paper._aiState = previous === 'waiting' ? 'waiting' : 'lookup-error'; paper._aiMsg = '已有 AI 速览读取失败，请重查；没有重新调用模型。'; },
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
    if (validTranslation(tr)) return `<div class="tr-box">${tr.abstract_zh.split(/\n+/).map(t => `<p>${esc(t)}</p>`).join('')}</div>`;
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
    const label = mode === 'huddle' ? 'AI 生成前 ' + items.length + ' 篇讨论提纲' : 'AI 综述前 ' + items.length + ' 篇';
    const help = '按当前顺序选最多 8 篇有标识的不同文献；基于可取得的公开摘要，结果全站共享。耗时随摘要与服务响应而变化。';
    if (!b || b.state === 'error') return `<div class="brief-box">${b ? `<p class="ql-meta" role="status">${esc(b.msg)}</p>` : ''}<button class="btn-sm ${mode === 'digest' && !b ? 'brief-start' : 'btn-primary'}" data-action="ai-brief" data-mode="${mode}" title="${help}">${mode === 'digest' && !b ? '<span aria-hidden="true">✦</span> ' : ''}${label}</button><span class="text-muted brief-help">${help}</span></div>`;
    if (b.state === 'loading') return `<div class="brief-box" aria-busy="true"><p class="ql-meta" role="status">正在读取摘要并生成，请稍候…${b.slow ? '用时较长，无需重复点击；不会自动重新提交。' : ''}</p></div>`;
    if (b.state === 'waiting') return `<div class="brief-box"><p class="ql-meta" role="status">${b.timedOut ? '本次等待已到时限，完成状态尚未确认' : '网络中断，完成状态尚未确认'}；后台可能仍在处理，未重新提交。</p>${b.msg ? `<p class="ql-meta" role="status">${esc(b.msg)}</p>` : ''}<button class="btn-sm" data-action="brief-check" data-mode="${mode}"${b.checking ? ' disabled' : ''}>${b.checking ? '读取中…' : '读取已有综述'}</button></div>`;
    const r = b.brief;
    const included = r.refs.length, omitted = Math.max(0, items.length - included);
    return `<div class="brief-box brief-done"><div class="drawer-section-title">${mode === 'huddle' ? '讨论提纲' : '综述速读'}</div>
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
    // Before the first request the button sits in the toolbar; progress and the
    // result move below it so the sticky toolbar never grows.
    const idle = !BRIEFS[briefKey('digest', briefItems(top))];
    const home = idle ? $('#listHeadTools') : $('#listHead');
    if (home && idle && el.parentElement !== home) home.prepend(el);
    if (home && !idle && el.previousElementSibling !== home) home.after(el);
    el.classList.toggle('digest-idle', idle);
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
    return `<p class="study-boundary">仅根据公开摘要生成。各篇结果不作质量排名，不合并效应量。</p><p class="study-meta">${result.generatedBy === 'metadata-only' ? '摘要获取状态 · 未调用模型' : cached ? '读取已有结果' : '本次生成'}</p>`;
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
    const hasPubAbs = typeof hasAbstract === 'function' ? hasAbstract(paper) : !!(paper.summary || (paper.abstractSections || []).some(s => s && s.text) || (typeof quicklookOf === 'function' && quicklookOf(paper) && quicklookOf(paper).abstract));
    const noAbsMsg = '<p class="study-meta">暂无公开摘要，无法提取研究结构。请查看官方原文。</p>';
    let content = '<p class="study-meta" role="status">正在检查已有结果，不会调用模型…</p>';
    if (!rec && paper.weeklyPick) content = '<p class="study-meta" role="status">本篇研究结构尚未预生成。</p>';
    else if (rec?.state === 'done') content = studyResultHtml(rec.result, [paper], rec.cached, 'study') + (rec.result.generatedBy === 'metadata-only' && rec.canGenerate && hasPubAbs ? `<button class="btn-sm" data-action="ai-study" data-paper-id="${esc(paper.id)}">重新获取公开摘要</button>` : '');
    else if (rec?.state === 'loading') content = `<p class="study-meta" role="status">正在从公开来源读取摘要并提取研究结构，请稍候…${rec.slow ? '用时较长，无需重复点击。' : ''}</p>`;
    else if (rec?.state === 'waiting') content = `<p class="study-meta" role="status">${esc(rec.msg || aiWaitingMessage())}</p><button class="btn-sm" data-action="study-check" data-paper-id="${esc(paper.id)}">读取已有研究结构</button>`;
    else if (!hasPubAbs && paper._absState === 'loading') content = '<p class="study-meta" role="status">正在获取摘要…</p>';
    else if (!hasPubAbs) content = noAbsMsg;
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
  const AI_ERR = { daily_cap: '今日 AI 额度已用完，明天再试。', ip_cap: '你今天的 AI 调用次数已达上限。', no_abstract: '本次已完成的公开来源查询未取得可用摘要。可查看官方原文。', metadata_timeout: '公开摘要读取超时，未生成结果。请稍后重试。', metadata_error: '公开摘要来源暂时不可读，未生成结果。请稍后重试。', request_timeout: '本次任务未能在时限内完成，未保存结果。可点击重试。', task_timeout: '本次任务未能在时限内完成，未保存结果。可点击重试。', task_cancelled: '本次任务已取消，未保存结果。可点击重试。',
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
  // 摘要明显不完整（只有结论）：保守判定，只在下面两种情况成立，其余一律不提示。
  // 1) 有分段：所有分段的标题都是 Conclusion(s) / 结论，没有 Background、Methods、Results 等其他段。
  // 2) 无分段（单段无标题，或只有 summary）：全文不超过 600 字，且以 Conclusion(s): / In conclusion, 开头，
  //    或以 “These/Our findings|results support|suggest|indicate|show|demonstrate|highlight” 这类结论句型开头。
  function abstractMayBeIncomplete(p) {
    if (!p) return false;
    const concluding = t => {
      t = String(t || '').trim();
      return t.length > 0 && t.length <= 600 && (/^(conclusions?|in conclusion)\s*[:：.,]/i.test(t) || /^(these|our) (findings|results) (support|suggest|indicate|show|demonstrate|highlight)\b/i.test(t));
    };
    const secs = (p.abstractSections || []).filter(x => x && String(x.text || '').trim());
    if (secs.length) {
      if (secs.every(x => /^(conclusions?|结论)\s*[:：]?$/i.test(String(x.label || '').trim()))) return true;
      return secs.length === 1 && !String(secs[0].label || '').trim() && concluding(secs[0].text);
    }
    return concluding(p.summary);
  }
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
  function officialArticleUrl(p) {
    const doi = p && exactDoi(p.doi);
    if (doi) return 'https://doi.org/' + encodeURIComponent(doi).replace(/%2F/gi, '/');
    return p && p.url ? safeSourceUrl({ url: p.url }) : '';
  }
  function pdfDownloadUrl(p) {
    if (p && typeof DOI_FULLTEXT !== 'undefined') {
      const doi = exactDoi(p.doi), record = DOI_FULLTEXT.get(doi);
      if (record) return sameDoiTitle(p.title, record.title) && record.fulltextStatus === 'available' ? '/api/fulltext?doi=' + encodeURIComponent(doi) : '';
    }
    return p && PDF_LIBRARY_IDS.has(String(p.id)) ? '/api/pdf?id=' + encodeURIComponent(p.id) : '';
  }
  // One status description per paper for the whole page. The card, the DOI search view and the empty state all
  // render it, so the same task never shows different words in two places (see docs/使用说明.md "全文状态").
  const FT_STEPS = ['排队下载', '核验中', '可阅读'];
  function ftMaintainerMode() { return typeof MAINTAINER !== 'undefined' && MAINTAINER === true; }
  function fulltextView(p) {
    const view = fulltextState(p);
    view.headline = (view.kind === 'ready' ? '' : '暂无 PDF：') + view.headline;
    view.eta = '下一步：' + (view.action === 'refresh' ? '稍后点「查看进度」；' : '') + view.eta;
    return view;
  }
  function fulltextState(p) {
    const doi = p && exactDoi(p.doi), job = doi ? DOI_JOBS.get(doi) : null, url = p ? pdfDownloadUrl(p) : '';
    if (url) return { kind: 'ready', step: 2, headline: '全文已核验，可以下载', short: '可下载', eta: '点「下载 PDF」获取已核验的全文', action: 'download', url };
    if (!doi) return { kind: 'none', step: -1, short: '未申请', headline: '这篇没有 DOI，无法向站内申请全文', eta: '到官网原文查看', action: 'official' };
    const record = DOI_FULLTEXT.get(doi), received = job && job.sourceKind === 'reader_upload' ? '已收到你上传的 PDF' : job && job.sourceKind === 'open_access' ? '已取得开放获取的 PDF' : '已收到 PDF';
    if (job && doiJobActive(job)) {
      if (job.stage === 'verifying') {
        const fast = job.verificationMode === 'immediate';
        return { kind: 'verifying', step: 1, headline: received + '，正在核验', short: '核验中', action: 'refresh',
          eta: fast ? '核验通常几分钟内完成' : '即时核验没有赶上，正在等待下一轮核验，具体时间不固定，可能需要数小时' };
      }
      if (job.stage === 'queued' || job.state === 'queued') return { kind: 'queued', step: 0, headline: '已排入下载队列，等待下载端领取', short: '排队下载', eta: '预计数小时内，不保证即时', action: 'refresh', upload: true };
      return { kind: 'running', step: 0, headline: '下载端正在获取全文', short: '排队下载', eta: '通常几十分钟内；取得后自动进入核验', action: 'refresh', upload: true };
    }
    if ((job && job.state === 'review') || (!job && record && record.fulltextStatus === 'review'))
      return job ? { kind: 'review', step: 1, stopped: true, stopLabel: '未取得', short: '未取得 · 核验未通过', headline: '已收到 PDF，但核验没有通过，不能确认它是这篇文献的原文', eta: '可以直接上传正确的 PDF，核验通常几分钟内完成', action: 'upload' }
        : { kind: 'review', step: 1, stopped: true, stopLabel: '未取得', short: '未取得 · 来源核对中', headline: '这篇文献的全文来源还在核对中', eta: '暂时没有可下载的 PDF，可以先看官网原文', action: 'official' };
    if ((job && ['failed', 'manual_needed'].includes(job.state)) || (record && record.fulltextStatus === 'manual_needed'))
      return { kind: 'failed', step: 0, stopped: true, stopLabel: '未取得', short: '未取得', headline: '这次没能取得全文', eta: '可以重新提交；已有 PDF 也可以直接上传', action: 'retry', upload: true };
    return { kind: 'none', step: -1, short: '未申请', headline: '站内还没有这篇的全文', eta: '点「获取全文」提交，通常数小时内；也可以直接上传已有 PDF', action: job ? 'retry' : 'submit', upload: true };
  }
  // 卡片内口令下载：表单标记写在 fulltextStatusHtml 里（卡片、DOI 搜索视图共用）；阅读台在 index.html 里有同样结构的 #drawerPdfForm。
  const DL_BTN_LABEL = '下载';
  // 下载链接 ↔ 口令表单：卡片里表单紧跟在链接后面；全文状态块里在同一个 .ft-status 内；阅读台用固定 id。
  function dlFormFor(link) {
    if (!link) return null;
    if (link.id === 'drawerPdfLink') return document.getElementById('drawerPdfForm');
    const next = link.nextElementSibling;
    if (next && next.matches('form[data-ft-dl-form]')) return next;
    const box = link.closest('.ft-status');
    return box ? box.querySelector('form[data-ft-dl-form]') : null;
  }
  function dlLinkFor(form) {
    if (!form) return null;
    if (form.id === 'drawerPdfForm') return document.getElementById('drawerPdfLink');
    const prev = form.previousElementSibling;
    if (prev && prev.matches('a[data-ft-download]')) return prev;
    const box = form.closest('.ft-status');
    return box ? box.querySelector('a[data-ft-download]') : null;
  }
  // 收起并清空：口令不留在页面上。
  function resetDlForm(form) {
    if (!form) return;
    const input = form.querySelector('input[name="passphrase"]'), btn = form.querySelector('button[type="submit"]'), err = form.querySelector('.ft-error');
    if (input) { input.value = ''; input.disabled = false; }
    if (btn) { btn.disabled = false; btn.textContent = DL_BTN_LABEL; }
    if (err) err.textContent = '';
    form.classList.remove('is-busy');
    form.removeAttribute('aria-busy');
    delete form.dataset.busy;
    form.hidden = true;
  }
  function fulltextStatusHtml(p, full, drawer = false) {
    const conflict = fulltextConflict(p);
    if (conflict) return ftMaintainerMode() ? '<span class="fulltext-state fulltext-review" title="官方题名：' + esc(conflict.title) + '">维护者：题录对应待核实</span>' : '';
    const view = fulltextView(p), doi = p && exactDoi(p.doi);
    if (!view) return '';
    const job = doi && DOI_JOBS.get(doi), safeDoi = esc(doi || '');
    const upload = doi && view.upload ? '<a class="ft-link" href="/api/muse/reader-upload?doi=' + encodeURIComponent(doi) + '" target="_blank" rel="noopener">已有 PDF？直接上传</a>' : '';
    const officialUrl = officialArticleUrl(p);
    const official = officialUrl ? '<a class="ft-link" href="' + esc(officialUrl) + '" target="_blank" rel="noopener">官网原文 ↗</a>' : '';
    const mode = job && job.stage ? 'muse' : 'legacy';
    const primary = view.action === 'download' ? '<a href="' + esc(view.url) + '" target="_blank" rel="noopener" class="btn-sm btn-primary" data-ft-download title="输入全文口令即可下载">下载 PDF</a>'
      : view.action === 'refresh' ? (full ? '<button type="button" class="btn-sm btn-primary" data-ft-action="refresh" data-doi="' + safeDoi + '">查看进度</button>' : '<button type="button" class="btn-sm btn-primary" data-action="open-drawer" data-paper-id="' + esc(p.id) + '">查看进度</button>')
      : view.action === 'upload' ? '<a class="btn-sm btn-primary" href="/api/muse/reader-upload?doi=' + encodeURIComponent(doi) + '" target="_blank" rel="noopener">直接上传 PDF</a>'
      : view.action === 'official' ? (officialUrl ? '<a class="btn-sm btn-primary" href="' + esc(officialUrl) + '" target="_blank" rel="noopener">官网原文 ↗</a>' : '')
      : '<button type="button" class="btn-sm btn-primary" data-ft-action="open-form" data-doi="' + safeDoi + '">' + (view.action === 'retry' ? '重新获取全文' : '获取全文') + '</button>';
    // 已可下载：口令框默认隐藏；仅当服务端开关 pdfSignedLink 打开时，点「下载 PDF」才会原位展开（见 10-browse-events.js）。
    const form = view.action === 'download' ? '<form class="ft-form ft-dl-form" data-ft-dl-form hidden><label>全文口令 <input name="passphrase" type="password" maxlength="256" autocomplete="current-password" required></label><button type="submit" class="btn-sm btn-primary">下载</button><span class="ft-error" role="alert"></span></form>' : view.action === 'submit' || view.action === 'retry'
      ? '<form class="ft-form" data-ft-form data-doi="' + safeDoi + '" data-mode="' + (view.action === 'retry' ? mode + '-retry' : 'submit') + '" hidden><label>全文口令 <input name="passphrase" type="password" maxlength="256" autocomplete="current-password" required></label><button type="submit" class="btn-sm btn-primary">提交</button><span class="ft-error" role="alert"></span></form>' : '';
    const maint = ftMaintainerMode() && job ? '<small class="ft-maint">维护者：任务状态 ' + esc(job.state) + (job.stage ? ' / ' + esc(job.stage) : '') + (job.reason ? ' / ' + esc(job.reason) : '') + '</small>' : '';
    if (!full) {
      const badgeTitle = view.headline + (view.eta ? '。' + view.eta : '');
      const badgeAria = view.short + '：' + badgeTitle;
      if (view.action === 'download') return '<span class="ft-badge ft-badge-ready" role="status" title="' + esc(badgeTitle) + '" aria-label="' + esc(badgeAria) + '">可下载</span>' + primary + form;
      const compactBadge = view.kind === 'none' ? '' : '<span class="ft-badge ft-badge-' + view.kind + '" title="' + esc(badgeTitle) + '" aria-label="' + esc(badgeAria) + '">' + esc(view.short) + '</span>';
      const compactPrimary = view.kind === 'none' ? primary.replace(/^(<(?:button|a)\b)/, '$1 title="' + esc(badgeTitle) + '"') : primary;
      return '<span class="ft-status ft-compact ft-' + view.kind + '" role="status" data-ft-doi="' + safeDoi + '">' + compactBadge + '<span class="ft-summary">' + esc(badgeTitle) + '</span>' + compactPrimary + '</span>' + form;
    }
    const steps = FT_STEPS.map((label, i) => {
      const stop = view.stopped && i === view.step, done = !stop && (i < view.step || (i === view.step && view.kind === 'ready'));
      return '<li class="' + (stop ? 'stop' : done ? 'done' : i === view.step ? 'current' : '') + '"' + (i === view.step ? ' aria-current="step"' : '') + '>' + esc(stop ? view.stopLabel : label) + '</li>';
    }).join('');
    const fullBadge = view.kind === 'none' ? '' : '<span class="ft-badge ft-badge-' + view.kind + '">' + esc(view.short) + '</span>';
    if (drawer) {
      const secondary = (view.eta ? '<span class="ft-eta">' + esc(view.eta) + '</span>' : '')
        + ((view.action !== 'official' && official) || upload ? '<span class="ft-actions">' + (view.action === 'official' ? '' : official) + upload + '</span>' : '');
      return '<div class="ft-status ft-full ft-' + view.kind + '" data-ft-doi="' + safeDoi + '">'
        + '<div class="ft-head">' + fullBadge
        + '<p class="ft-line" role="status"><b title="' + esc(view.headline) + '">' + esc(view.headline) + '</b></p>'
        + '<span class="ft-head-action" data-drawer-ft-primary>' + (view.action === 'download' ? '' : primary) + '</span></div>'
        + (view.action === 'download' ? '<div class="ft-dl-slot" data-drawer-ft-form-slot></div>' : form)
        + (view.kind === 'ready' ? '' : '<ol class="ft-steps">' + steps + '</ol>')
        + (secondary ? '<div class="ft-sub">' + secondary + '</div>' : '')
        + maint + '</div>';
    }
    return '<div class="ft-status ft-full ft-' + view.kind + '" data-ft-doi="' + safeDoi + '">' + fullBadge + (view.kind === 'ready' ? '' : '<ol class="ft-steps">' + steps + '</ol>')
      + '<p class="ft-line" role="status"><b>' + esc(view.headline) + '</b>' + (view.eta ? '<span class="ft-eta">' + esc(view.eta) + '</span>' : '') + '</p>'
      + '<div class="ft-actions">' + primary + (view.action === 'official' ? '' : official) + upload + '</div>' + form + maint + '</div>';
  }
  function pdfDownloadLink(p) {
    // In the DOI search view the card carries the full status block instead, so it is never repeated.
    const doi = p && exactDoi(p.doi);
    if (doi && exactDoi(state.search) === doi) return '';
    return fulltextStatusHtml(p, false);
  }
  function doiStatusBlock(p) {
    const doi = p && exactDoi(p.doi);
    return doi && exactDoi(state.search) === doi ? fulltextStatusHtml(p, true) : '';
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
    if (!usesLane() || exactDoi(state.search)) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const ranges = RANGES_BY_MODE[state.mode] || RANGES_BY_MODE.library;
    el.innerHTML = '<span class="range-label">发表时间</span><select class="range-select" data-range-select aria-label="发表时间">' + ranges.map(([v, n]) => `<option value="${v}"${state.range === v ? ' selected' : ''}>${n}</option>`).join('') + '</select>';
  }
  const FT_FILTERS = [['', '全部'], ['ready', '可阅读'], ['verifying', '核验中'], ['queued', '排队下载'], ['failed', '未取得'], ['none', '未申请']];
  function fulltextFilterBucket(p) {
    const view = fulltextView(p);
    if (view && view.kind === 'ready') return 'ready';
    if (view && view.kind === 'verifying') return 'verifying';
    if (view && (view.kind === 'queued' || view.kind === 'running')) return 'queued';
    if (view && (view.kind === 'failed' || view.kind === 'review')) return 'failed';
    return 'none';
  }
  function fulltextFilterCounts() {
    const counts = { '': 0, ready: 0, verifying: 0, queued: 0, failed: 0, none: 0 };
    for (const p of getCurrentDataset()) {
      if (!matchesFilters(p, false, 'ft')) continue;
      counts['']++;
      counts[fulltextFilterBucket(p)]++;
    }
    return counts;
  }
  function renderFtBar() {
    const el = $('#ftBar');
    if (!el) return;
    if (state.mode !== 'library' || exactDoi(state.search)) { el.hidden = true; el.innerHTML = ''; return; }
    const counts = fulltextFilterCounts();
    const active = state.ftFilter || '';
    el.hidden = false;
    el.innerHTML = '<select class="range-select ft-select" data-ft-select aria-label="全文状态（各档篇数按当前领域、时间与搜索统计）">' + FT_FILTERS.map(([v, n]) =>
      `<option value="${v}" data-count="${counts[v]}"${active === v ? ' selected' : ''}>${v === '' ? '全部全文' : n}</option>`).join('') + '</select>';
  }
  function renderLaneBar() {
    const el = $('#laneBar');
    if (!el) return;
    if (exactDoi(state.search)) { el.hidden = true; el.innerHTML = ''; return; }
    if (state.mode === 'curated') {
      // 主题芯片整行已按站长要求去掉；日期条仍由 curatedDayBar 渲染。
      el.hidden = true;
      el.innerHTML = '';
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
    el.innerHTML = '<span class="lane-label">领域</span>' + '<select class="lane-select" data-lane-select aria-label="领域">' + LANES.map(l => `<option value="${l.id}" data-count="${counts[l.id]}"${state.lane === l.id ? ' selected' : ''}>${esc(l.short || l.name)}</option>`).join('') + '</select>';
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
    candidates: '自动聚合的期刊新文献，未经逐篇核对。<span class="mode-note-more">近 14 天来自 RSS 与 PubMed（多数带摘要）；更早的是 PubMed 题录（已关注的心血管与 AI 医学期刊），点题名打开阅读面板再取公开摘要。已核对导读与 AI 速览分别标记。</span><button type="button" class="mode-note-toggle" aria-expanded="false">数据来源</button>',
    library: '既往题录档案，按期刊与时间检索。<span class="mode-note-more">输入全文口令后可下载已收录的 PDF；未收录全文的条目可访问官网。没有摘要的条目，可尝试获取公开摘要。刊期按月份显示，日期未知的排在最后。</span><button type="button" class="mode-note-toggle" aria-expanded="false">说明</button>'
  };

  function renderModeNote() {
    const el = $('#modeNote');
    if (!el) return;
    const rail = $('#streamRail');
    if (rail) rail.hidden = state.mode !== 'curated';
    const laneBar = $('#laneBar'), laneSlot = $(state.mode === 'curated' ? '#curatedTopicsSlot' : '#streamLaneSlot');
    if (laneBar && laneSlot && laneBar.parentElement !== laneSlot) laneSlot.append(laneBar);
    el.innerHTML = '';
    el.hidden = true;
  }
  function syncToolRowVisibility() {
    renderModeNote();
    renderLaneBar();
    renderRangeBar();
    renderFtBar();
    const toggle = document.querySelector('#filterToggleBtn');
    if (toggle) toggle.hidden = true;
    if (typeof renderQuickFilters === 'function') renderQuickFilters();
  }

  // URL <-> state sync so filtered views are shareable / survive refresh
  function syncUrl() {
    if (typeof syncSearchPanel === 'function') syncSearchPanel();
    try {
      const u = new URL(window.location.href);
      const set = (k, v, def) => { if (v && v !== def) u.searchParams.set(k, v); else u.searchParams.delete(k); };
      set('mode', state.mode, 'curated');
      set('q', state.search, '');
      set('tier', state.clinicalTier, '');
      set('pub', state.publisher, '');
      const js = selectedJournals();
      set('journal', js.length === 1 ? js[0] : '', '');
      set('journals', js.length > 1 ? js.join(',') : '', '');
      set('jtier', state.journalTier || '', '');
      set('nocase', state.excludeCaseReports ? '1' : '', '');
      set('design', state.studyDesign, '');
      set('tag', state.tag, '');
      set('lane', usesLane() ? state.lane : '', 'core');
      set('sort', state.sort, 'date-desc');
      set('range', state.range, defaultRange(state.mode));
      set('minor', state.minor ? '1' : '', '');
      set('reading', usesLane()?state.reading:'', '');
      set('favorites', state.favoritesOnly ? '1' : '', '');
      set('wcat', state.mode === 'weekly' ? state.weeklyCat : '', '');
      set('day', state.mode === 'curated' ? state.day : '', '');
      set('pane', state.mode === 'weekly' ? state.weeklyPane : '', 'board');
      set('sf', state.mode === 'sources' ? state.sourceFilter : '', '');
      set('read', state.mode === 'weekly' ? activeDeepReadingId : '', '');
      set('ft', state.mode === 'library' ? state.ftFilter : '', '');
      u.searchParams.delete('maintainer');
      const filteredView = state.search || state.clinicalTier || state.publisher || selectedJournals().length || state.studyDesign || state.tag
        || state.ftFilter || state.range !== defaultRange(state.mode) || state.favoritesOnly || state.excludeCaseReports || (usesLane() && (state.lane !== 'core' || state.minor || state.reading));
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
  // 快捷条选刊不再自动带上出版方。
  if (state.publisher) expandedPublishers.add(state.publisher);

  function sidebarSelections() {
    const journals = selectedJournals();
    return [
      { group: 'tier', value: state.clinicalTier, label: '信源分组' },
      ...journals.map(j => ({ group: 'journal', value: j, label: '期刊' })),
      ...(journals.length ? [] : [{ group: 'pub', value: state.publisher, label: '出版方' }]),
      { group: 'design', value: state.studyDesign, label: '研究设计' },
      { group: 'tag', value: state.tag, label: '主题' }
    ].filter(selection => selection.value);
  }
  function clearSidebarFilters() {
    state.clinicalTier = state.publisher = state.journal = state.studyDesign = state.tag = '';
    state.journals = [];
    state.journalTier = '';
    state.excludeCaseReports = false;
    state.page = 1;
  }
  function selectSidebarFilter(group, value, only = false) {
    if (!['tier', 'pub', 'journal', 'design', 'tag'].includes(group) || typeof value !== 'string') return false;
    if (only) clearSidebarFilters();
    if (group === 'tier') state.clinicalTier = value;
    if (group === 'pub') {
      const clear = !only && value && state.publisher === value && !selectedJournals().length;
      state.publisher = clear ? '' : value;
      state.journal = '';
      state.journals = [];
    }
    if (group === 'journal') {
      const list = selectedJournals();
      if (!value) {
        state.journals = [];
        state.journal = '';
      } else {
        const clear = !only && list.includes(value);
        state.journals = clear ? list.filter(j => j !== value) : (only ? [value] : list.concat(value).filter((j, i, a) => a.indexOf(j) === i));
        state.journal = state.journals[0] || '';
        if (state.journals.length) state.publisher = '';
      }
    }
    if (group === 'design') {
      state.studyDesign = value;
      if (state.studyDesign === '病例报告') state.excludeCaseReports = false;
    }
    if (group === 'tag') state.tag = !only && value && state.tag === value ? '' : value;
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
      if (state.reading==='guide' && !p.hasDraft) return false;
    }
    if (state.favoritesOnly && !state.favoriteJournals.includes(p.cleanJournal || p.journal || '')) return false;
    if (state.excludeCaseReports && isCaseReport(p)) return false;
    if (!matchesSidebarFilters(p, skip)) return false;
    if (lane && state.reading==='abstract' && !hasAbstract(p)) return false;
    if (lane && state.reading==='quicklook' && (!quicklookOf(p) || p.hasDraft)) return false;
    if (state.mode === 'library' && skip !== 'ft' && state.ftFilter && fulltextFilterBucket(p) !== state.ftFilter) return false;
    return matchesQuery(p);
  }
  // Bit set of the sidebar groups a paper fails, so facet counts need one pass, not one per group.
  const FACET_BITS = { tier: 1, pub: 2, design: 4, tag: 8 };
  function sidebarMisses(p) {
    let miss = 0;
    if (state.clinicalTier && (p.clinicalTier || '综合医学与其他') !== state.clinicalTier) miss |= 1;
    if (typeof paperMatchesJournalFilter === 'function') {
      if (!paperMatchesJournalFilter(p)) miss |= 2;
    } else {
      const js = selectedJournals();
      if (js.length) {
        if (!js.includes(p.cleanJournal) && !js.includes(p.journal)) miss |= 2;
      } else if (state.journalTier) {
        miss |= 2;
      }
    }
    if (!selectedJournals().length && !state.journalTier && state.publisher && (p.publisher || '其他学术刊物') !== state.publisher) miss |= 2;
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

        return `<button type="button" class="panel-opt${isActive ? ' active' : ''}" data-filter-tier="${esc(t.id)}" aria-pressed="${isActive}">${esc(isAll ? '全部信源' : t.name)}</button>`;
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
          jHtml += `<button type="button" class="panel-opt accordion-journal-btn${isJActive ? ' active' : ''}${jCount ? '' : ' is-empty'}" data-filter-journal="${esc(jName)}" aria-pressed="${isJActive}">${state.favoriteJournals?.includes(jName) ? '★ ' : ''}<span class="journal-filter-label">${esc(jName)}</span></button>`;
        }

        accHtml += `<div class="accordion-group ${isOpen ? 'open' : ''}">
            <div class="accordion-heading panel-opt${isPubActive && !state.journal ? ' active' : ''}${pubTotal ? '' : ' is-empty'}">
              <button type="button" class="accordion-header ${isPubActive && !state.journal ? 'active' : ''}" data-filter-publisher="${esc(pubName)}" aria-pressed="${isPubActive && !state.journal}">${esc(pubName)}</button>
              <button type="button" class="accordion-expand-btn" data-pub-expand="${esc(pubName)}" aria-expanded="${isOpen}" aria-controls="${contentId}" aria-label="展开或收起${esc(pubName)}旗下期刊"><span class="accordion-arrow" aria-hidden="true">▸</span></button>
            </div>
            <div class="accordion-content panel-options" id="${contentId}">${jHtml}</div>
          </div>`;
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
      { name: '病例报告', key: '病例报告' },
      { name: '研究类型待核验', key: '研究类型待核验' }
    ];

    const designListEl = $('#designFilterList');
    if (designListEl) {
      designListEl.innerHTML = designs.map(d => {
        const isAll = d.key === '';
        const count = isAll ? facet('design').length : (designCounts[d.key] || 0);
        const isActive = isAll ? !state.studyDesign : state.studyDesign === d.key;

        return `<button type="button" class="panel-opt${isActive ? ' active' : ''}${isAll || designCounts[d.key] ? '' : ' is-empty'}" data-filter-design="${esc(d.key)}" aria-pressed="${isActive}">${esc(isAll ? '全部设计' : d.name)}</button>`;
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
        return `<button type="button" class="panel-opt tag-chip${isActive ? ' active' : ''}${count ? '' : ' is-empty'}" data-filter-tag="${esc(tag)}" aria-pressed="${isActive}">${esc(tag)}</button>`;
      }).join('') || '<span class="text-muted" style="font-size:12px;">暂无标签</span>';
    }
  }

  // Render Active Filter Chips
  let streamTotal = 0;
  function renderActiveFilterChips(totalCount) {
    const container = $('#activeFiltersBar');
    if (!container) return;

    let chips = '';
    streamTotal = totalCount;
    if (typeof renderStreamTotal === 'function') renderStreamTotal();
    if (state.search) {
      const scope = { curated: '每日精选', candidates: '文献雷达', library: '文献库' }[state.mode] || '当前栏目';
      chips += `<span class="filter-badge-active search-scope" role="status">检索范围：${scope} · 当前筛选；切换栏目保留关键词</span>`;
    }
    container.innerHTML = chips;
    if (typeof renderQfSummary === 'function') renderQfSummary();
  }
  // 共 N 篇 sits at the head of the list, with sort, view and the AI digest link beside it.
  function renderStreamTotal() {
    const total = $('#listTotal');
    if (total) total.textContent = `共 ${streamTotal} 篇`;
    const apply = $('#panelApplyBtn');
    if (apply) { apply.textContent = streamTotal ? `查看 ${streamTotal} 篇` : '无结果，清除条件'; apply.dataset.empty = streamTotal ? '' : '1'; }
  }
  // Search opens above the filter row; it stays open while there is a keyword.
  function syncSearchPanel(forceOpen) {
    const panel = $('#searchPanel'), btn = $('#searchToggleBtn'), input = $('#globalSearch');
    if (!panel || !btn) return;
    const open = !!forceOpen || !!(input && input.value) || !!state.search || (!panel.hidden && document.activeElement === input);
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('active', open);
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
    const noFollowed = !!(state.favoritesOnly && !(state.favoriteJournals || []).length);
    const message = noFollowed ? '还没有关注期刊，点期刊名旁的 ☆ 关注。关注后可在这里只看这些期刊。'
      : selections.length > 1 ? '这些条件需要同时满足，目前没有交集。可保留其中一项切换浏览。'
      : state.mode === 'curated' ? '当前条件下没有精选，可清除筛选或查看文献雷达。' : '当前领域、时间、关键词与筛选条件下暂无匹配。';
    const heading = noFollowed ? '还没有关注期刊' : '没有找到匹配的文献';
    return `<div class="empty-state"><h3>${heading}</h3><p>${message}</p><div class="empty-filter-actions">${suggestions}
      ${selections.length ? '<button type="button" class="btn-sm" data-clear="sidebar">清空左侧筛选</button>' : ''}
      ${state.search ? '<button type="button" class="btn-sm" data-clear="search">清除关键词</button>' : ''}
      <button type="button" class="btn-sm btn-primary" id="clearAllFiltersBtn">重置所有条件</button></div></div>`;
  }

  // ==== src/app/05-list.js · Article cards, compact rows, list rendering, citations ====

  // Render Article Card
  function renderArticleCard(p) {
    const isHuddled = state.huddle.includes(p.id);
    const pubClass = getPublisherClass(p.publisher);
    const journalName = cardJournalName(p);
    const dateStr = dateLabel(p);

    const titleEn = esc(p.title);
    const reviewedZh = p.draftData?.title_zh || '';
    const machineZh = !p.hasDraft ? (quicklookOf(p)?.title_zh || p.titleZh || '') : '';
    const zh = reviewedZh || machineZh;
    const pid = esc(p.id);

    const titleBlock = `<h3 class="article-title"><button class="title-open" data-action="open-drawer" data-paper-id="${pid}">${zh ? esc(zh) : titleEn}</button></h3>`;

    // 有中文标题时，英文原题作为一行弱化副标题；英文检索命中时完整显示
    const q = (state.search || '').toLowerCase().split(/\s+/).filter(t => t.length > 1 && /[a-z]/.test(t));
    const enHit = zh && q.length && !exactDoi(state.search) && q.some(t => String(p.title || '').toLowerCase().includes(t));
    const enLine = zh ? `<p class="article-title-en${enHit ? ' is-hit' : ''}" lang="en" title="${titleEn}">${titleEn}</p>` : '';

    const gist = p.hasDraft ? (p.draftData?.summary || '') : (quicklookOf(p)?.one_line || '');
    const gistHtml = gist ? `<p class="article-gist${p.hasDraft ? '' : ' gist-ai'}">${esc(gist)}</p>` : '';

    const doiBlock = doiStatusBlock(p);

    return `
      <article class="article-card has-side-actions" data-paper-id="${pid}">
        <div class="card-main">
          <div class="card-top">
            <span class="journal-badge ${pubClass}">${esc(journalName)}</span>
            <span class="date-badge">${esc(dateStr)}</span>
            ${designBadgeHtml(p)}
          </div>
          ${publicationStatusHtml(p)}
          ${titleBlock}
          ${enLine}
          ${gistHtml}
        </div>

        ${cardSideActionsHtml(p)}
        ${doiBlock}
      </article>
    `;
  }

  // Render Compact Row
  function renderCompactRow(p) {
    const pubClass = getPublisherClass(p.publisher);
    const journalName = cardJournalName(p);
    const dateStr = dateLabel(p);
    const pid = esc(p.id);
    const titleEn = esc(p.title);
    const zh = p.draftData?.title_zh || (!p.hasDraft ? (quicklookOf(p)?.title_zh || p.titleZh || '') : '');
    const doiBlock = doiStatusBlock(p);

    return `
      <div class="compact-row" data-paper-id="${pid}">
        <div class="compact-main">
          <button class="compact-title title-open" data-action="open-drawer" data-paper-id="${pid}" title="${titleEn}">${zh ? esc(zh) : titleEn}</button>
          ${zh ? `<p class="article-title-en" lang="en" title="${titleEn}">${titleEn}</p>` : ''}
          ${publicationStatusHtml(p)}
          ${doiBlock}
          <div class="compact-meta">
            <span class="journal-badge ${pubClass}" title="${esc(journalName)}">${esc(journalName)}</span>
            <span class="date-badge">${esc(dateStr)}</span>
            ${designBadgeHtml(p)}
          </div>
        </div>
        ${cardSideActionsHtml(p)}
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
    { const head = $('#listHead'); if (head) head.hidden = special || !!doi; }
    const rail = $('#streamRail'); if (rail) rail.hidden = !!doi || state.mode !== 'curated';
    const sidebar = $('#appSidebar'); if (sidebar) sidebar.style.display = noSidebar ? 'none' : '';
    const toggle = $('#filterToggleBtn'); if (toggle) toggle.hidden = noSidebar;
    const app = $('.app-container');
    if (app) {
      app.classList.toggle('full-width-layout', noSidebar);
      app.classList.toggle('curated-layout', !doi && state.mode === 'curated');
      app.classList.toggle('weekly-layout', !doi && state.mode === 'weekly');
      app.classList.toggle('sources-layout', !doi && state.mode === 'sources');
    }
    if (doi || special) syncToolRowVisibility();
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
    const radarNote = papers.length ? '' : radarArchiveNotice();
    const radarPending = !papers.length && (RADAR_LOAD.state === 'loading' || RADAR_LOAD.state === 'idle');
    const radarError = !papers.length && RADAR_LOAD.state === 'error';
    const message = pendingLookup ? '正在检查补录文献…' : uncertain ? '已检索现有题录；补录状态暂不可用。' : papers.length ? '已按完整 DOI 匹配，当前栏目与筛选条件不影响结果。' : radarNote ? '' : '站内暂未收录这个 DOI。';
    // The bibliography-conflict note is maintainer information; ordinary readers only see the one status block.
    let conflictNotice = '';
    const record = DOI_FULLTEXT.get(doi);
    if (record && ftMaintainerMode()) {
      const conflicts = STATIC_DOI_PAPERS.filter(p => exactDoi(p.doi) === doi && !sameDoiTitle(p.title, record.title));
      if (conflicts.length) conflictNotice = `<div class="doi-identity-notice"><b>维护者：原有题录对应待核实</b><p>原有题名：${esc(conflicts[0].title)}</p><p>本次官方题名：${esc(record.title)}。新全文仅与下方相符题名关联；原有导读保留。</p></div>`;
    }
    streamEl.className = state.viewMode === 'compact' ? 'articles-stream compact-mode' : 'articles-stream';
    const plainMatch = papers.length && !pendingLookup && !uncertain;
    streamEl.innerHTML = (plainMatch ? '' : `<div class="doi-search-notice"><h3>按 DOI 全站检索</h3>${message ? `<p>${message}</p>` : ''}${uncertain ? `<button class="btn-sm" data-action="refresh-doi-status" data-doi="${esc(doi)}">重试检索</button>` : ''}${radarNote}</div>`)
      + conflictNotice + papers.map(state.viewMode === 'compact' ? renderCompactRow : renderArticleCard).join('')
      + (!papers.length ? '<div class="empty-state doi-empty"><h3>' + (activeJob ? '后台任务已提交' : (pendingLookup || radarPending) ? '正在核对收录状态' : (uncertain || radarError) ? '现有题录未命中' : '未找到站内文献') + '</h3>' + fulltextStatusHtml({ doi }, true) + '</div>' : '');
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
    syncToolRowVisibility();
    renderCuratedDayBar();
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
    let absFetchPlanned = false;
    const drawer = $('#readerDrawer');
    const backdrop = $('#drawerBackdrop');
    if (!drawer || !backdrop) return;

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
      if (ql && ql.abstract && !paper.summary && !(paper.abstractSections && paper.abstractSections.length)) {
        paper.abstractSections = [{ label: '', text: ql.abstract }];
        forgetPaper(paper);
        paper._absFetched = true;
        if (!paper.pmid && ql.pmid) paper.pmid = ql.pmid;
      }
      // 公开摘要要去 Europe PMC 拉取时，先标成拉取中再渲染：速览和结构区在拉取期间显示「正在获取摘要…」，
      // 不抢跑写「暂无公开摘要」。拉取结束（含失败）后才按真实结果显示。
      absFetchPlanned = !paper.weeklyPick && !paper.summary && !(paper.abstractSections && paper.abstractSections.length) && !!(paper.doi || paper.pmid) && !paper._absTries;
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
          ` : `<div class="structured-abstract">${abstractHtml}</div>`}
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
      ftSection.remove();
      renderDrawerRegions(bodyEl, paper, changedPaper, [['head', head], ['abstract', abstractSection], ['fulltext', ''], ['editorial', editorialSection],
        ['ai', quickBox + aiBox], ['study', studyBoxHtml(paper)], ['cite', citationSection]]);
      bodyEl.querySelector('[data-drawer-region="fulltext"]').appendChild(ftSection);
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
      // 口令框跟着下载链接走：链接隐藏或换了一篇就收起并清空口令。
      if (!pdfUrl || changedPaper) resetDlForm(pdfForm);
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
    // The three totals double as filters; counts always describe the whole report.
    const view = ['ok', 'attention'].includes(state.sourceFilter) ? state.sourceFilter : '';
    const tile = (value, n, label, cls = '') => `<button type="button" class="source-filter${cls}" data-source-filter="${value}" aria-pressed="${view === value}"><strong>${n}</strong><span>${label}</span></button>`;
    if (summary) summary.innerHTML = tile('', sources.length, '订阅信源') + tile('ok', okCount, '本轮获取成功') + tile('attention', sources.length - okCount, '需要关注', sources.length > okCount ? ' source-summary-attention' : '');

    if (meta) {
      meta.textContent = `检查时间：${contentDate(HEALTH.checkedAt)}（北京时间）${olderThan(HEALTH.checkedAt,6) ? ' · 报告已过期，不能代表当前可用率' : ''}`;
      meta.classList.toggle('source-report-stale', olderThan(HEALTH.checkedAt,6));
    }

    const q = state.search.trim().toLowerCase();
    const filtered = sources.filter(s => !q || queryMatches([s.name, s.id, s.url, s.status, sourceHealthDetails(s),
      s.status === 'not_feed' ? '返回非订阅内容' : successful(s) ? '获取成功' : '获取异常 暂停'].filter(Boolean).join(' ').toLowerCase(), q));
    const shown = filtered.filter(s => !view || (view === 'ok') === successful(s));
    let group = null;
    grid.innerHTML = specialSearchStatus('信源状态（名称、订阅地址与状态）', filtered.length, sources.length, '个信源')
      + (!filtered.length ? '<p class="special-search-empty" role="status">没有匹配的信源，请清除关键词或更换名称；论文请到文献雷达检索。</p>' : '')
      + (filtered.length && !shown.length ? `<p class="special-search-empty" role="status">${view === 'ok' ? '没有获取成功的信源。' : '没有需要关注的信源。'}<button type="button" class="btn-sm" data-source-filter="">查看全部</button></p>` : '')
      + [...shown].sort((a, b) => Number(successful(a)) - Number(successful(b))).map(s => {
      const isOk = successful(s);
      // Problems come first; a heading marks where each group starts.
      const heading = group === isOk ? '' : `<h3 class="source-group-title">${isOk ? '获取成功' : '需要关注'} <span>${shown.filter(x => successful(x) === isOk).length}</span></h3>`;
      group = isOk;
      const statusLabel = s.status === 'empty_feed' ? '有效空源' : s.status === 'filtered_empty' ? '获取成功 · 暂无入选' : isOk ? '获取成功' :
        s.status === 'not_feed' ? '返回非订阅内容' : s.status === 'not_checked_host_blocked' ? '同主机暂停检查' : s.status === 'parse_error' ? '订阅格式异常' : s.status === 'http_error' ? `来源 HTTP ${s.httpStatus || '错误'}` : '获取异常';
      return heading + `
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
      syncToolRowVisibility();
      renderSourcesHealth();
      syncUrl();
    } else if (newMode === 'weekly') {
      syncToolRowVisibility();
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
    return '<p class="deep-reading-original">' + esc(p.title) + '</p><p class="deep-reading-scope">基于开放全文正文，未核对补充材料。</p>' + sections;
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
    el.innerHTML = '<p class="deep-reading-status" role="status">今日已更新 <b>' + groups.todayCount + '</b> 篇 · 每天目标 ' + (Number.isInteger(status.target) && status.target > 0 ? status.target : 12) + ' 篇</p><p class="deep-reading-timing">北京时间 04:47 计划启动' + (data.updatedAt ? ' · 最近更新 ' + esc(contentDate(data.updatedAt)) : '') + '</p>' +
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
  var deepReaderPushed = false;
  function deepReaderUrl(id) {
    const u = new URL(window.location.href);
    if (id) u.searchParams.set('read', id); else u.searchParams.delete('read');
    return u.pathname + u.search + u.hash;
  }
  const READING_LOAD = {};
  function readingMonth(p) {
    return /^\d{4}-\d{2}-\d{2}$/.test(p && p.publishedOn || '') ? p.publishedOn.slice(0, 7) : 'undated';
  }
  function readingBodyReady(p) {
    return !!(p && p.sections && typeof p.sections === 'object');
  }
  function readingShardSrc(month) {
    const src = window.DEEP_READINGS && window.DEEP_READINGS.shards && window.DEEP_READINGS.shards[month];
    return typeof src === 'string' && /^shards\/readings-(?:\d{4}-\d{2}|undated)\.[0-9a-f]{12}\.js$/.test(src) ? src : '';
  }
  function mergeReadingShard(month) {
    const payload = window.XINZHI_READING_SHARDS && window.XINZHI_READING_SHARDS[month];
    const bodies = payload && payload.items;
    if (!bodies || typeof bodies !== 'object') return false;
    let applied = false;
    ((window.DEEP_READINGS && window.DEEP_READINGS.items) || []).forEach(p => {
      const sections = bodies[p && p.pmcid];
      if (p && readingMonth(p) === month && sections && typeof sections === 'object') { p.sections = sections; applied = true; }
    });
    return applied;
  }
  function ensureReadingReadyHook() {
    if (window.XINZHI_READING_READY && window.XINZHI_READING_READY._xinzhiShard) return;
    function ready(month) {
      const slot = READING_LOAD[month];
      if (!slot || slot.state !== 'loading') return;
      const ok = mergeReadingShard(month);
      slot.state = ok ? 'loaded' : 'error';
      if (!ok && READING_LOAD[month] === slot) delete READING_LOAD[month];
      if (slot.done) slot.done(ok);
    }
    ready._xinzhiShard = true;
    window.XINZHI_READING_READY = ready;
  }
  // The index in the first script lists every reading. The month file is fetched only when one is opened.
  function loadReadingShard(month) {
    const src = readingShardSrc(month);
    if (!src) return Promise.resolve(false);
    const existing = READING_LOAD[month];
    if (existing && existing.state === 'loaded') return Promise.resolve(true);
    if (existing && existing.state === 'loading' && existing.promise) return existing.promise;
    ensureReadingReadyHook();
    const slot = { state: 'loading', promise: null, done: null };
    READING_LOAD[month] = slot;
    slot.promise = new Promise(resolve => {
      slot.done = ok => { slot.done = null; resolve(ok); };
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onerror = () => {
        slot.state = 'error';
        script.remove();
        if (READING_LOAD[month] === slot) delete READING_LOAD[month];
        if (slot.done) slot.done(false);
      };
      script.onload = () => {
        if (slot.state !== 'loading') return;
        const ok = mergeReadingShard(month);
        slot.state = ok ? 'loaded' : 'error';
        if (!ok && READING_LOAD[month] === slot) delete READING_LOAD[month];
        if (slot.done) slot.done(ok);
      };
      document.head.appendChild(script);
    });
    return slot.promise;
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
      $('#deepReaderLabel').textContent = '';
      $('#deepReaderTitle').textContent = item.titleZh || item.title;
      $('#deepReaderMeta').textContent = [item.journal, '论文 ' + item.date, '更新 ' + item.publishedOn].filter(Boolean).join(' · ');
      $('#deepReaderLinks').innerHTML = deepReadingLinks(item);
      const paintBody = current => {
        if (activeDeepReadingId !== id) return;
        if (current && readingBodyReady(current)) body.innerHTML = deepReadingBody(current);
        else body.innerHTML = '<p class="deep-reading-empty" role="status">这篇精读暂时载入失败，请重试。</p><p><button type="button" class="btn-sm" data-action="retry-reading-shard" data-reading-id="' + esc(id) + '">重试</button></p>';
        renderDeepReaderToc(body);
      };
      if (readingBodyReady(item)) paintBody(item);
      else {
        body.innerHTML = '<p class="deep-reading-empty" role="status">正在载入这篇精读…</p>';
        renderDeepReaderToc(body);
        loadReadingShard(readingMonth(item)).then(ok => paintBody(ok ? (dailyReadingList().find(p => p.pmcid === id) || item) : null));
      }
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
      if (push && !wasOpen) {
        history.pushState({ deepReader: id }, '', deepReaderUrl(id));
        deepReaderPushed = true;
      } else {
        const nextState = deepReaderPushed && history.state && history.state.deepReader ? { deepReader: id } : (history.state && history.state.deepReader ? null : history.state);
        history.replaceState(nextState, '', deepReaderUrl(id));
      }
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
    if (!fromHistory && deepReaderPushed && history.state && history.state.deepReader) { history.back(); return; }
    deepReaderPushed = false;
    const id = activeDeepReadingId;
    activeDeepReadingId = '';
    reader.classList.remove('open');
    reader.setAttribute('aria-hidden', 'true');
    if (!$('#readerDrawer.open')) { $('#drawerBackdrop')?.classList.remove('open'); document.body.classList.remove('dialog-open'); }
    $$('.deep-reading-item.active').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
    try { if (history.state && history.state.deepReader) history.replaceState(null, '', location.href); } catch (e) { /* file:// or sandboxed */ }
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
  // 近7天榜的分类口径：榜单预生成的 weeklyCategory 优先，缺省按领域回退。分类条和快捷条的 AI 档共用这一处。
  function weeklyCategoryOf(p) {
    return ['cardio', 'general', 'aimed', 'aitech'].includes(p.weeklyCategory) ? p.weeklyCategory : laneOf(p);
  }
  function weeklyReadingIds() {
    const byDoi = new Map();
    dailyReadingList().forEach(p => { if (p.doi && !byDoi.has(String(p.doi).toLowerCase())) byDoi.set(String(p.doi).toLowerCase(), p.pmcid); });
    return byDoi;
  }
  function weeklyCard(p, date, readingId) {
    const q = quicklookOf(p), draftZh = p.draftData?.title_zh || '', machineZh = !p.hasDraft && !draftZh ? ((q && q.title_zh) || p.titleZh || '') : '', zh = draftZh || machineZh;
    const line = cardTakeaway(p);
    const med = (p.media || []).slice(0, 1).map(m => `<a class="media-pill" href="${esc(m.u)}" target="_blank" rel="noopener noreferrer" title="${esc(m.t)}">媒体关注 · ${esc(m.s)}</a>`).join('');
    const deep = readingId ? `<button type="button" class="weekly-deep-badge" data-action="open-deep-reading" data-reading-id="${esc(readingId)}">有全文精读 →</button>` : '';
    return `<article class="next-item weekly-auto-item" data-paper-id="${esc(p.id)}"><span class="weekly-rank">${esc(p.weeklyPick)}</span><div class="weekly-card-content"><div class="weekly-card-body"><div class="weekly-card-meta"><span class="journal-badge ${getPublisherClass(p.publisher)}">${esc(cardJournalName(p))}</span> ${journalMetricBadge(p)} ${designBadgeHtml(p)} ${med} <span class="date-badge">${esc(date)}</span></div>` +
      publicationStatusHtml(p) + `<div class="weekly-auto-title"><button type="button" class="title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}">${esc(zh || p.title)}</button>${deep}</div>` +
      (zh ? `<div class="weekly-auto-en">${esc(p.title)}</div>` : '') +
      (line ? `<div class="weekly-auto-line">${esc(line)}</div>` : '') +
      `</div>${cardSideActionsHtml(p)}</div></article>`;
  }
  // One line per paper: rank, title, source line and the AI one-liner, with a star to collect.
  function weeklyRow(p, date, readingId) {
    const q = quicklookOf(p), draftZh = p.draftData?.title_zh || '', machineZh = !p.hasDraft && !draftZh ? ((q && q.title_zh) || p.titleZh || '') : '', zh = draftZh || machineZh;
    const line = cardTakeaway(p);
    const deep = readingId ? `<button type="button" class="weekly-deep-badge" data-action="open-deep-reading" data-reading-id="${esc(readingId)}">有全文精读 →</button>` : '';
    const design = p.publicationStatus?.label || p.studyDesign || '';
    return `<li class="weekly-row weekly-auto-item" data-paper-id="${esc(p.id)}"><span class="weekly-rank">${esc(p.weeklyPick)}</span><div class="weekly-row-main"><div class="weekly-row-title"><button type="button" class="title-open" data-action="open-drawer" data-paper-id="${esc(p.id)}" title="${esc(p.title)}">${esc(zh || p.title)}</button>${deep}</div>` +
      publicationStatusHtml(p) + `<div class="weekly-row-meta"><span class="weekly-row-journal">${esc(cardJournalName(p))}</span>${design ? `<span>${esc(design)}</span>` : ''}<span>${esc(date)}</span></div>` +
      (line ? `<div class="weekly-row-line">${esc(line)}</div>` : '') +
      `</div>${cardSideActionsHtml(p)}</li>`;
  }

  function renderWeeklyAuto() {
    const el = $('#weeklyAuto'); if (!el) return;
    if (typeof renderQuickFilters === 'function') renderQuickFilters();
    const now = Date.now(), boardWindow = weeklyPublicationWindow(FEEDS.items, now);
    const reports = FEEDS.items.filter(p => p.weeklyPick).map(p => p.weeklyAt)
      .filter(value => typeof value === 'string' && value.includes('T') && weeklyPublicationDate({ date: value }, now))
      .sort((a, b) => Date.parse(b) - Date.parse(a));
    const updatedAt = reports[0] || FEEDS.updatedAt;
    const validUpdate = typeof updatedAt === 'string' && updatedAt.includes('T') && weeklyPublicationDate({ date: updatedAt }, now);
    const stale = validUpdate && now - Date.parse(updatedAt) > 6 * 3600000;
    const timing = validUpdate ? `${reports.length ? '榜单' : '来源'}更新于 ${esc(contentDate(updatedAt))}` : '更新时间暂无有效记录，时效待确认';
    const entries = boardWindow.entries.filter(({paper}) => matchesQuery(paper) && (typeof matchesQuickFilters === 'function' ? matchesQuickFilters(paper) : true));
    const groups = WEEKLY_CATEGORIES.map(([id, name]) => ({ id, name, entries: entries.filter(({ paper }) => weeklyCategoryOf(paper) === id) }));
    const boardCount = $('#weeklyPaneBoardCount'); if (boardCount) boardCount.textContent = entries.length || '';
    const preparedTranslations = entries.filter(({paper:p})=>validTranslation(preGeneratedOf(p)?.translation || LIVE_TR[trKeyOf(p)])).length;
    const preparedQuicklooks = entries.filter(({paper:p})=>quicklookOf(p)).length;
    const infoOpen = !!el.querySelector?.('.weekly-info[open]');
    const compactEarly = state.viewMode === 'compact';
    const viewToggle = `<div class="view-toggle weekly-view-toggle" role="group" aria-label="显示方式"><button type="button" class="view-toggle-btn${compactEarly ? '' : ' active'}" data-weekly-view="cards" aria-pressed="${!compactEarly}">详细</button><button type="button" class="view-toggle-btn${compactEarly ? ' active' : ''}" data-weekly-view="compact" aria-pressed="${compactEarly}">列表</button></div>`;
    const heading = `<div class="weekly-head"><h3 class="next-title">近 7 天文献榜 <span class="weekly-total">${state.search ? `匹配 ${entries.length} / ${boardWindow.entries.length}` : boardWindow.entries.length} 篇</span></h3>` + viewToggle +
      `<div class="weekly-meta"><span>发表于 ${boardWindow.start.slice(5)} 至 ${boardWindow.end.slice(5)}（北京时间，含今天）· ${timing}</span>${stale ? '<b class="weekly-stale">更新已超过 6 小时，时效待确认</b>' : ''}` +
      `<details class="weekly-info"${infoOpen ? ' open' : ''}><summary>榜单说明</summary><div class="weekly-info-body"><p>收录北京时间 ${boardWindow.start}–${boardWindow.end} 发表的入榜文献。分类与排序为自动规则，未经逐篇质量评审。</p><p class="weekly-preparation">摘要内容准备：中文摘要 ${preparedTranslations}/${entries.length} · AI 速览 ${preparedQuicklooks}/${entries.length}。仅依据公开摘要，不代表全文精读。</p><p>点题名打开阅读台看摘要；出版商原文链接在阅读台底部。</p></div></details></div></div>`
      + specialSearchStatus('近7天榜（只筛当前入榜文献，不改变选文；其他栏目筛选不影响榜单）', entries.length, boardWindow.entries.length, '篇');
    if (!entries.length) { el.innerHTML = heading + `<p class="text-muted" role="status">${state.search ? '当前榜内没有匹配文献，可清除关键词；更大范围请到文献雷达检索。' : '近7天暂无入榜条目'}</p>`; return; }
    const cat = groups.some(g => g.id === state.weeklyCat) ? state.weeklyCat : '';
    const compact = compactEarly;
    const bar = `<div class="weekly-bar"><div class="weekly-category-nav" role="group" aria-label="文献榜分类"><button type="button" data-weekly-cat="" aria-pressed="${!cat}">全部 <span>${entries.length}</span></button>` +
      groups.map(g => `<button type="button" data-weekly-cat="${g.id}" aria-pressed="${cat === g.id}"${g.entries.length || cat === g.id ? '' : ' disabled'}>${g.name} <span>${g.entries.length}</span></button>`).join('') +
      `</div></div>`;
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

  // ==== src/app/09z-quick-filters.js · 列表顶栏快捷筛选条 ====
  const QF_RECENT_KEY = 'xz_recent_journals';
  const QF_PRESET_KEY = 'xz_filter_presets';
  const QF_DESIGN_OPTS = [
    ['', '全部设计'],
    ['RCT', 'RCT 随机对照'],
    ['RCT 二次分析', 'RCT 二次分析'],
    ['二次分析', '二次分析（母研究待核验）'],
    ['已撤稿', '已撤稿'],
    ['存在关注声明', '存在关注声明'],
    ['撤稿声明', '撤稿声明'],
    ['关注声明', '关注声明'],
    ['更正声明', '更正声明'],
    ['队列研究', '队列研究'],
    ['病例对照研究', '病例对照研究'],
    ['Meta/综述', 'Meta/系统综述'],
    ['方法/模型验证', '方法/模型验证'],
    ['指南共识', '指南共识'],
    ['述评观点', '述评观点'],
    ['叙述综述', '叙述综述'],
    ['研究方案', '研究方案'],
    ['横断面研究', '横断面研究'],
    ['病例报告', '病例报告'],
    ['研究类型待核验', '研究类型待核验']
  ];

  let qfOpen = null; // { kind, query }
  function loadRecentJournals() {
    try {
      const a = JSON.parse(safeGet(QF_RECENT_KEY) || '[]');
      return Array.isArray(a) ? a.filter(x => typeof x === 'string') : [];
    } catch (e) { return []; }
  }
  function rememberJournal(name) {
    if (!name) return;
    const list = loadRecentJournals().filter(j => j !== name);
    list.unshift(name);
    safeSet(QF_RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  }
  function loadFilterPresets() {
    try {
      const a = JSON.parse(safeGet(QF_PRESET_KEY) || '[]');
      return Array.isArray(a) ? a.filter(x => x && typeof x === 'object') : [];
    } catch (e) { return []; }
  }
  function qfSnapshot() {
    return {
      lane: state.lane,
      range: state.range,
      ftFilter: state.ftFilter,
      reading: state.reading,
      favoritesOnly: state.favoritesOnly,
      excludeCaseReports: state.excludeCaseReports,
      journals: selectedJournals().slice(),
      journalTier: state.journalTier || '',
      clinicalTier: state.clinicalTier,
      publisher: state.publisher,
      studyDesign: state.studyDesign,
      tag: state.tag,
      minor: state.minor
    };
  }
  function qfRestore(data) {
    if (!data || typeof data !== 'object') return;
    ['lane', 'range', 'ftFilter', 'reading', 'favoritesOnly', 'excludeCaseReports',
      'clinicalTier', 'publisher', 'studyDesign', 'tag', 'minor'].forEach(k => {
      if (k in data) state[k] = data[k];
    });
    state.journals = Array.isArray(data.journals) ? data.journals.slice() : [];
    state.journalTier = data.journalTier || '';
    state.journal = state.journals[0] || '';
  }
  function saveFilterPreset(name) {
    const presets = loadFilterPresets();
    const label = String(name || '').trim() || ('预设 ' + (presets.length + 1));
    presets.push({ id: Date.now(), name: label, data: qfSnapshot() });
    safeSet(QF_PRESET_KEY, JSON.stringify(presets.slice(-20)));
    if (typeof showToast === 'function') showToast('已保存「' + label + '」，可在 ⋯ 中取用；不会自动套用');
  }
  function applyFilterPreset(id) {
    const p = loadFilterPresets().find(x => String(x.id) === String(id));
    if (!p) return;
    qfRestore(p.data);
    qfApply();
  }
  function deleteFilterPreset(id) {
    safeSet(QF_PRESET_KEY, JSON.stringify(loadFilterPresets().filter(x => String(x.id) !== String(id))));
  }

  function qfPapers() {
    if (state.mode === 'weekly') {
      try { return weeklyPublicationWindow(FEEDS.items, Date.now()).entries.map(e => e.paper); }
      catch (e) { return (FEEDS && FEEDS.items) || []; }
    }
    if (state.mode === 'sources') return [];
    return getCurrentDataset();
  }
  function matchesQuickFilters(p) {
    if (state.favoritesOnly && !state.favoriteJournals.includes(p.cleanJournal || p.journal || '')) return false;
    if (state.excludeCaseReports && isCaseReport(p)) return false;
    if (!matchesSidebarFilters(p)) return false;
    return true;
  }

  const JT = () => (typeof window !== 'undefined' && window.XINZHI_JOURNAL_TIERS) || null;
  function normJournal(name) {
    const api = JT();
    return api ? api.normalizeJournalName(name) : String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }
  function paperJournalKey(p) {
    const name = typeof cardJournalName === 'function' ? cardJournalName(p) : (p && (p.cleanJournal || p.journal)) || '';
    if (!name || name === '期刊待补') return '';
    if (typeof isInternalSourceName === 'function' && isInternalSourceName(name)) return '';
    const api = JT();
    return api ? api.canonName(name) : name;
  }
  function paperTierId(p) {
    const name = paperJournalKey(p);
    if (!name) return '';
    const api = JT();
    return api ? api.tierOfName(name) : 'other';
  }
  // 近7天榜里「AI」档按分类条的口径：AI 医疗 + AI 前沿，不按期刊名单；其他栏目仍按 AI 期刊档。
  function weeklyAiTier() { return state.mode === 'weekly'; }
  function paperIsWeeklyAi(p) {
    const c = typeof weeklyCategoryOf === 'function' ? weeklyCategoryOf(p) : '';
    return c === 'aimed' || c === 'aitech';
  }
  function paperMatchesJournalFilter(p) {
    if (!state.journalTier && !(selectedJournals().length)) return true;
    if (weeklyAiTier() && state.journalTier === 'ai' && !selectedJournals().length) return paperIsWeeklyAi(p);
    const name = paperJournalKey(p);
    if (!name) return false;
    const js = selectedJournals();
    if (js.length) {
      const set = new Set(js.map(normJournal));
      return set.has(normJournal(name));
    }
    if (!state.journalTier) return true;
    return paperTierId(p) === state.journalTier;
  }
  function journalNamesInColumn() {
    const counts = new Map();
    qfPapers().forEach(p => {
      const name = paperJournalKey(p);
      if (!name) return;
      const canon = name;
      counts.set(normJournal(canon), { name: canon, n: (counts.get(normJournal(canon)) || { n: 0 }).n + 1 });
    });
    return counts;
  }
  function tierJournalRows(tierId) {
    const api = JT();
    const counts = journalNamesInColumn();
    if (tierId === 'other') {
      return Array.from(counts.values())
        .filter(row => !api || api.tierOfName(row.name) === 'other')
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh'))
        .map(row => Object.assign(row, { suggested: false }));
    }
    const names = api ? api.namesInTier(tierId, true) : [];
    const seen = new Set();
    const rows = [];
    names.forEach(n => {
      const k = normJournal(n);
      if (!k || seen.has(k)) return;
      seen.add(k);
      const hit = counts.get(k);
      rows.push({ name: (hit && hit.name) || (api && api.canonName(n)) || n, n: hit ? hit.n : 0, suggested: !!(api && api.isSuggestedName(n)) });
    });
    // 当前栏目里规范名落入本档、但不在表中的刊（不应出现，除非 other）
    return rows;
  }
  function tierHasPapers(tierId) {
    if (tierId === 'ai' && weeklyAiTier()) return qfPapers().some(paperIsWeeklyAi);
    return qfPapers().some(p => {
      const name = paperJournalKey(p);
      if (!name) return false;
      const id = paperTierId(p);
      return tierId === 'other' ? (id === 'other' || !id) : id === tierId;
    });
  }
  function currentTierSubset(tierId) {
    if (state.journalTier !== tierId) return [];
    return selectedJournals();
  }
  function tierIsOn(tierId) {
    return state.journalTier === tierId;
  }
  function selectWholeTier(tierId) {
    if (state.journalTier === tierId && !selectedJournals().length) {
      state.journalTier = '';
      state.journals = [];
      state.journal = '';
    } else {
      state.journalTier = tierId;
      state.journals = [];
      state.journal = '';
      state.publisher = '';
    }
  }
  function toggleJournalInTier(tierId, name) {
    const rows = tierJournalRows(tierId);
    const present = rows.filter(r => r.n > 0 || currentTierSubset(tierId).some(j => normJournal(j) === normJournal(r.name)));
    let list = (state.journalTier === tierId ? selectedJournals() : []).slice();
    const key = normJournal(name);
    if (list.some(j => normJournal(j) === key)) list = list.filter(j => normJournal(j) !== key);
    else list.push(name);
    // 若选中本档全部已出现的刊，视为整档
    const presentKeys = new Set(present.map(r => normJournal(r.name)));
    const selectedKeys = new Set(list.map(normJournal));
    const allOn = presentKeys.size && [...presentKeys].every(k => selectedKeys.has(k));
    state.journalTier = list.length ? tierId : '';
    state.journals = (list.length && !allOn) ? list : [];
    state.journal = state.journals[0] || '';
    state.publisher = '';
    if (name && typeof rememberJournal === 'function') rememberJournal(name);
  }
  function tierDef(id) {
    const api = JT();
    return (api && api.tiers || []).find(t => t.id === id) || { id, short: id, title: id };
  }

  function qfChipVis() {
    const papers = qfPapers();
    const has = pred => papers.some(pred);
    const doi = typeof exactDoi === 'function' && exactDoi(state.search);
    const api = JT();
    const tiers = {};
    (api && api.tiers || []).forEach(tier => { tiers[tier.id] = tierHasPapers(tier.id); });
    return {
      bar: !doi && state.mode !== 'sources',
      scope: usesLane() && !doi,
      star: has(p => paperJournalKey(p)),
      tiers,
      specialty: has(p => p.clinicalTier),
      nocase: has(isCaseReport),
      design: has(p => p.studyDesign),
      more: has(p => p.publisher) || has(p => p.clinicalTier) || has(isCaseReport) || has(p => p.studyDesign) || usesLane() || state.mode === 'library'
    };
  }
  function journalNameOf(p) { return paperJournalKey(p); }
  function columnJournalCounts() {
    const counts = new Map();
    journalNamesInColumn().forEach(row => counts.set(row.name, row.n));
    return counts;
  }
  function qfHasActive() {
    const vis = qfChipVis();
    if (state.favoritesOnly || state.excludeCaseReports || selectedJournals().length || state.journalTier) return true;
    if (state.clinicalTier || state.publisher || state.studyDesign || state.tag) return true;
    if (vis.scope && (state.lane !== 'core' || state.range !== defaultRange(state.mode))) return true;
    if (state.mode === 'library' && state.ftFilter) return true;
    if (usesLane() && (state.minor || state.reading)) return true;
    return false;
  }
  function clearQuickFilters() {
    state.favoritesOnly = false;
    state.excludeCaseReports = false;
    state.journals = [];
    state.journal = '';
    if (typeof clearSidebarFilters === 'function') clearSidebarFilters();
    if (usesLane()) {
      state.lane = 'core';
      state.range = defaultRange(state.mode);
      state.reading = '';
      state.minor = false;
    }
    if (state.mode === 'library') state.ftFilter = '';
  }
  function qfApply() {
    state.page = 1;
    if (state.mode === 'weekly') {
      if (typeof renderWeeklyAuto === 'function') renderWeeklyAuto();
      if (typeof renderNextCandidates === 'function') renderNextCandidates();
      if (typeof syncUrl === 'function') syncUrl();
    } else if (typeof renderStream === 'function') {
      if (typeof renderSidebarFilters === 'function' && state.mode !== 'sources') renderSidebarFilters();
      renderStream();
    }
    renderQuickFilters();
  }

  function scopeLabel() {
    const lane = (typeof LANES !== 'undefined' ? LANES : []).find(l => l.id === state.lane);
    const laneName = (lane && (lane.short || lane.name)) || '领域';
    const rangeName = state.range === 'all' ? '全部时间' : ('近 ' + state.range + ' 天');
    if (state.mode === 'library' && state.ftFilter) {
      const ft = (typeof FT_FILTERS !== 'undefined' ? FT_FILTERS : []).find(([v]) => v === state.ftFilter);
      return laneName + ' · ' + rangeName + ' · ' + ((ft && ft[1]) || '全文');
    }
    return laneName + ' · ' + rangeName;
  }

  let qfLastMode = null;
  // 右侧渐隐：条超出一屏且还没滚到尽头时才显示，滚到尽头去掉，最后一个芯片完整可见。
  function qfSyncFade(row) {
    if (!row) return;
    const overflow = row.scrollWidth > row.clientWidth + 2;
    const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 2;
    row.classList.toggle('qf-fade', overflow && !atEnd);
  }
  function qfBindFade(row) {
    if (!row.dataset || row.dataset.qfFadeBound || typeof row.addEventListener !== 'function') return;
    row.dataset.qfFadeBound = '1';
    row.addEventListener('scroll', () => qfSyncFade(row), { passive: true });
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', () => qfSyncFade(row));
  }

  function renderQuickFilters() {
    const bar = $('#quickBar');
    const row = $('#qfChipRow');
    const scopeBtn = $('#qfScopeBtn');
    const summary = $('#qfSummary');
    if (!bar || !row) return;
    const vis = qfChipVis();
    bar.hidden = !vis.bar;
    if (scopeBtn) {
      scopeBtn.hidden = !vis.scope;
      if (vis.scope) {
        scopeBtn.textContent = scopeLabel();
        scopeBtn.classList.toggle('is-on', state.lane !== 'core' || state.range !== defaultRange(state.mode) || !!(state.mode === 'library' && state.ftFilter));
        scopeBtn.setAttribute('aria-expanded', String(!!(qfOpen && qfOpen.kind === 'scope')));
      }
    }
    if (!vis.bar) {
      if (summary) summary.hidden = true;
      if (qfOpen) closeQfPop();
      return;
    }
    const chip = (kind, label, on, extra) =>
      `<button type="button" class="qf-chip${on ? ' is-on' : ''}" data-qf="${kind}" aria-pressed="${on}"${extra || ''}>${label}</button>`;
    const parts = [];
    if (vis.star) parts.push(chip('star', state.favoritesOnly ? '★' : '☆', !!state.favoritesOnly, ' aria-label="只看关注期刊" title="只看关注期刊"'));
    (JT() && JT().tiers || []).forEach(tier => {
      if (!vis.tiers[tier.id]) return;
      const subset = currentTierSubset(tier.id);
      const on = tierIsOn(tier.id);
      const label = subset.length ? (tier.short + ' · ' + subset.length) : tier.short;
      const openKind = 'jtier:' + tier.id;
      if (tier.id === 'ai' && weeklyAiTier()) {
        parts.push(`<button type="button" class="qf-chip qf-chip-ai${on ? ' is-on' : ''}" data-qf-jtier="ai" aria-pressed="${on}" aria-label="筛选 AI 医疗 / AI 前沿" title="与榜内分类条的「AI 医疗」「AI 前沿」口径一致">${esc(tier.short)}</button>`);
        return;
      }
      parts.push(`<span class="qf-split${on ? ' is-on' : ''}">
        <button type="button" class="qf-chip qf-chip-main${on ? ' is-on' : ''}" data-qf-jtier="${esc(tier.id)}" aria-pressed="${on}" aria-label="筛选${esc(tier.title)}">${esc(label)}</button>
        <button type="button" class="qf-chip qf-chip-caret${on ? ' is-on' : ''}" data-qf-jtier-menu="${esc(tier.id)}" aria-haspopup="dialog" aria-expanded="${!!(qfOpen && qfOpen.kind === openKind)}" aria-label="打开${esc(tier.title)}清单"><span class="qf-caret" aria-hidden="true">▾</span></button>
      </span>`);
    });
    if (vis.more) parts.push(chip('more', '⋯', qfMoreActive(), ' aria-haspopup="dialog" aria-label="更多筛选"'));
    row.innerHTML = parts.join('');
    // 换栏目（页签）时快捷条横向位置归零，避免上一栏滑出去的位置留在新栏目里。
    if (qfLastMode !== state.mode) { row.scrollLeft = 0; qfLastMode = state.mode; }
    qfBindFade(row);
    qfSyncFade(row);
    renderQfSummary();
    if (qfOpen) openQfPop(qfOpen.kind, true);
  }
  function qfMoreActive() {
    return !!(state.publisher || state.clinicalTier || state.excludeCaseReports || state.studyDesign || (usesLane() && (state.minor || state.reading)) || (state.mode === 'library' && state.ftFilter && !qfChipVis().scope));
  }

  function renderQfSummary() {
    const el = $('#qfSummary');
    if (!el) return;
    if (!qfHasActive()) { el.hidden = true; el.innerHTML = ''; return; }
    const item = (label, key, value) =>
      `<button type="button" class="qf-sum-item" data-qf-clear="${esc(key)}"${value != null ? ` data-qf-clear-value="${esc(value)}"` : ''} aria-label="清除${esc(label)}">${esc(label)} <span aria-hidden="true">×</span></button>`;
    const bits = [];
    if (state.favoritesOnly) bits.push(item('只看关注期刊', 'favorites'));
    if (state.journalTier && !selectedJournals().length) {
      bits.push(item(state.journalTier === 'ai' && weeklyAiTier() ? 'AI 医疗 / AI 前沿' : (tierDef(state.journalTier).title || state.journalTier), 'jtier'));
    } else if (selectedJournals().length) {
      const prefix = state.journalTier ? (tierDef(state.journalTier).short + '：') : '';
      selectedJournals().forEach(j => bits.push(item(prefix + j, 'journal', j)));
    }
    if (state.clinicalTier) bits.push(item(state.clinicalTier, 'tier'));
    if (state.excludeCaseReports) bits.push(item('已排除病例报告', 'nocase'));
    if (state.studyDesign) bits.push(item(state.studyDesign, 'design'));
    if (state.publisher && !selectedJournals().length) bits.push(item(state.publisher, 'pub'));
    if (state.tag) bits.push(item(state.tag, 'tag'));
    if (usesLane() && state.minor) bits.push(item('含更正/来信', 'minor'));
    if (usesLane() && state.reading) bits.push(item('可读内容', 'reading'));
    if (state.mode === 'library' && state.ftFilter) bits.push(item('全文状态', 'ft'));
    if (usesLane() && state.lane !== 'core') bits.push(item((LANES.find(l => l.id === state.lane) || {}).short || '领域', 'lane'));
    if (usesLane() && state.range !== defaultRange(state.mode)) bits.push(item(state.range === 'all' ? '全部时间' : ('近 ' + state.range + ' 天'), 'range'));
    el.hidden = false;
    el.innerHTML = bits.join('<span class="qf-dot" aria-hidden="true">·</span>')
      + '<span class="qf-dot" aria-hidden="true">·</span>'
      + '<button type="button" class="qf-sum-action" data-qf-clear="all">清除</button>'
      + '<span class="qf-dot" aria-hidden="true">·</span>'
      + '<button type="button" class="qf-sum-action" data-qf-save="1" title="把当前条件存成预设，仅此浏览器，不会自动套用">☆保存</button>';
  }

  function closeQfPop() {
    qfOpen = null;
    const pop = $('#qfPop'), back = $('#qfBackdrop');
    if (pop) { pop.hidden = true; pop.innerHTML = ''; pop.classList.remove('is-sheet'); }
    if (back) back.hidden = true;
    $$('.qf-chip[aria-expanded="true"], #qfScopeBtn').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  function placeQfPop(anchor) {
    const pop = $('#qfPop');
    if (!pop) return;
    const narrow = window.innerWidth <= 600;
    pop.classList.toggle('is-sheet', narrow);
    pop.hidden = false;
    const back = $('#qfBackdrop');
    if (back) back.hidden = false;
    if (narrow || !anchor) {
      pop.style.left = '';
      pop.style.top = '';
      pop.style.width = '';
      pop.style.maxWidth = '';
      return;
    }
    const r = anchor.getBoundingClientRect();
    const w = Math.min(420, Math.max(280, window.innerWidth - 16));
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    pop.style.width = w + 'px';
    pop.style.maxWidth = w + 'px';
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    const ph = pop.getBoundingClientRect().height;
    if (r.bottom + 6 + ph > window.innerHeight - 8) {
      const up = r.top - ph - 6;
      pop.style.top = Math.max(8, up) + 'px';
    }
  }
  function openQfPop(kind, keepQuery) {
    const pop = $('#qfPop');
    if (!pop) return;
    const query = keepQuery && qfOpen ? (qfOpen.query || '') : '';
    qfOpen = { kind, query };
    pop.innerHTML = qfPopHtml(kind, query);
    let anchor;
    if (kind === 'scope') anchor = $('#qfScopeBtn');
    else if (kind && kind.slice(0, 6) === 'jtier:') anchor = $(`.qf-chip-caret[data-qf-jtier-menu="${kind.slice(6)}"]`);
    else anchor = $(`.qf-chip[data-qf="${kind}"]`);
    $$('.qf-chip, #qfScopeBtn').forEach(b => b.setAttribute('aria-expanded', String(b === anchor)));
    placeQfPop(anchor);
    const input = $('#qfJournalSearch');
    if (input) {
      input.value = query;
      if (!keepQuery) setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
    }
  }

  function qfPopHtml(kind, query) {
    if (kind && kind.slice(0, 6) === 'jtier:') return journalPopHtml(kind.slice(6), query);
    if (kind === 'journal') return journalPopHtml('other', query);
    if (kind === 'specialty') return specialtyPopHtml();
    if (kind === 'design') return designPopHtml();
    if (kind === 'scope') return scopePopHtml();
    if (kind === 'more') return morePopHtml();
    return '';
  }

  function journalPopHtml(tierId, query) {
    const def = tierDef(tierId);
    return `<div class="qf-pop-head"><strong>${esc(def.title)}</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>
      <div class="qf-pop-actions"><button type="button" class="qf-opt${state.journalTier === tierId && !selectedJournals().length ? ' is-on' : ''}" data-qf-jtier-all="${esc(tierId)}">查看整档</button></div>
      <div class="qf-search-wrap"><input type="search" id="qfJournalSearch" class="qf-search" placeholder="搜索刊名…" value="${esc(query || '')}" autocomplete="off" aria-label="搜索期刊"></div>
      <div class="qf-journal-list" id="qfJournalList">${journalListHtml(query || '', tierId)}</div>`;
  }
  function journalListHtml(query, tierId) {
    const id = tierId || (qfOpen && qfOpen.kind && qfOpen.kind.slice(0, 6) === 'jtier:' ? qfOpen.kind.slice(6) : '');
    const q = String(query || '').trim().toLowerCase();
    const rows = tierJournalRows(id);
    const subset = currentTierSubset(id);
    const whole = state.journalTier === id && !subset.length;
    const fav = new Set((state.favoriteJournals || []).map(normJournal));
    const filtered = rows.filter(r => !q || r.name.toLowerCase().includes(q));
    if (!filtered.length) return '<p class="qf-empty">没有匹配的期刊</p>';
    return filtered.map(r => {
      const on = whole || subset.some(j => normJournal(j) === normJournal(r.name));
      const starred = fav.has(normJournal(r.name));
      const sug = r.suggested ? '<small class="qf-suggested">建议</small>' : '';
      return `<div class="qf-jrow${on ? ' is-on' : ''}${r.n ? '' : ' is-empty'}" data-qf-journal="${esc(r.name)}" data-qf-journal-tier="${esc(id)}">
        <button type="button" class="qf-jstar${starred ? ' is-starred' : ''}" data-qf-follow="${esc(r.name)}" aria-label="${starred ? '取消关注' : '关注期刊'}" aria-pressed="${starred}">${starred ? '★' : '☆'}</button>
        <button type="button" class="qf-jname" data-qf-pick-journal="${esc(r.name)}" data-qf-journal-tier="${esc(id)}" aria-pressed="${on}">${esc(r.name)}${sug}<small>${r.n}</small></button>
      </div>`;
    }).join('');
  }
  function refreshJournalList() {
    const list = $('#qfJournalList');
    if (!list || !qfOpen || !qfOpen.kind) return;
    if (qfOpen.kind !== 'journal' && qfOpen.kind.slice(0, 6) !== 'jtier:') return;
    const tierId = qfOpen.kind.slice(0, 6) === 'jtier:' ? qfOpen.kind.slice(6) : '';
    list.innerHTML = journalListHtml(qfOpen.query || '', tierId);
  }

  function specialtyPopHtml() {
    const counts = {};
    qfPapers().filter(p => matchesFilters(p, false, 'tier')).forEach(p => {
      const t = p.clinicalTier || '综合医学与其他';
      counts[t] = (counts[t] || 0) + 1;
    });
    const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, 'zh'));
    const opts = ['<button type="button" class="qf-opt' + (!state.clinicalTier ? ' is-on' : '') + '" data-qf-tier="" aria-pressed="' + (!state.clinicalTier) + '">全部分组</button>']
      .concat(keys.filter(k => counts[k] || k === state.clinicalTier).map(k =>
        `<button type="button" class="qf-opt${state.clinicalTier === k ? ' is-on' : ''}" data-qf-tier="${esc(k)}" aria-pressed="${state.clinicalTier === k}">${esc(k)} <small>${counts[k] || 0}</small></button>`
      ));
    return `<div class="qf-pop-head"><strong>专科来源</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>
      <p class="qf-hint">按来源期刊分组，不是每篇文章的临床主题。</p>
      <div class="qf-opt-list">${opts.join('')}</div>`;
  }

  function designPopHtml() {
    const counts = {};
    qfPapers().filter(p => matchesFilters(p, false, 'design')).forEach(p => {
      const d = p.studyDesign || '研究类型待核验';
      counts[d] = (counts[d] || 0) + 1;
    });
    const pending = counts['研究类型待核验'] || 0;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const seen = new Set();
    const keys = QF_DESIGN_OPTS.map(([k, n]) => {
      seen.add(k);
      return [k, n, k ? (counts[k] || 0) : total];
    });
    Object.keys(counts).forEach(k => { if (!seen.has(k)) keys.splice(keys.length - 1, 0, [k, k, counts[k]]); });
    const opts = keys.filter(([k, , n]) => !k || n || k === '病例报告' || k === state.studyDesign || k === '研究类型待核验').map(([k, name, n]) => {
      const on = k ? state.studyDesign === k : !state.studyDesign;
      const mark = k === '研究类型待核验' ? ` <small>待核验 ${pending} 篇${total ? '（' + Math.round(pending * 100 / total) + '%）' : ''}</small>`
        : (k ? ` <small>${n}</small>` : '');
      return `<button type="button" class="qf-opt${on ? ' is-on' : ''}" data-qf-design="${esc(k)}" aria-pressed="${on}">${esc(name)}${mark}</button>`;
    });
    return `<div class="qf-pop-head"><strong>研究设计</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>
      <p class="qf-hint">筛选只作用于已标注文献。当前栏目研究类型待核验 ${pending} 篇${total ? '，约占 ' + Math.round(pending * 100 / total) + '%' : ''}。</p>
      <div class="qf-opt-list">${opts.join('')}</div>`;
  }

  function scopePopHtml() {
    const lanes = (typeof LANES !== 'undefined' ? LANES : []).map(l =>
      `<button type="button" class="qf-opt${state.lane === l.id ? ' is-on' : ''}" data-qf-lane="${esc(l.id)}" aria-pressed="${state.lane === l.id}">${esc(l.short || l.name)}</button>`
    ).join('');
    const ranges = ((typeof RANGES_BY_MODE !== 'undefined' && RANGES_BY_MODE[state.mode]) || []).map(([v, n]) =>
      `<button type="button" class="qf-opt${state.range === v ? ' is-on' : ''}" data-qf-range="${esc(v)}" aria-pressed="${state.range === v}">${esc(n)}</button>`
    ).join('');
    let ft = '';
    if (state.mode === 'library' && typeof FT_FILTERS !== 'undefined') {
      const counts = typeof fulltextFilterCounts === 'function' ? fulltextFilterCounts() : {};
      ft = '<h4>全文状态</h4><div class="qf-opt-list">' + FT_FILTERS.map(([v, n]) =>
        `<button type="button" class="qf-opt${(state.ftFilter || '') === v ? ' is-on' : ''}" data-qf-ft="${esc(v)}" data-count="${counts[v] || 0}" aria-pressed="${(state.ftFilter || '') === v}">${esc(v === '' ? '全部全文' : n)} <small>${counts[v] || 0}</small></button>`
      ).join('') + '</div>';
    }
    return `<div class="qf-pop-head"><strong>领域与时间</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>
      <h4>领域</h4><div class="qf-opt-list">${lanes}</div>
      <h4>发表时间</h4><div class="qf-opt-list">${ranges}</div>${ft}`;
  }

  function morePopHtml() {
    const pubCounts = {};
    qfPapers().forEach(p => {
      if (!matchesQuery(p)) return;
      const pub = p.publisher || '其他学术刊物';
      pubCounts[pub] = (pubCounts[pub] || 0) + 1;
    });
    const pubs = Object.keys(pubCounts).sort((a, b) => pubCounts[b] - pubCounts[a] || a.localeCompare(b, 'zh'));
    const pubHtml = pubs.map(name =>
      `<button type="button" class="qf-opt${state.publisher === name && !selectedJournals().length ? ' is-on' : ''}" data-qf-pub="${esc(name)}" aria-pressed="${state.publisher === name && !selectedJournals().length}">${esc(name)} <small>${pubCounts[name]}</small></button>`
    ).join('') || '<p class="qf-empty">暂无出版方</p>';
    let extra = '';
    if (usesLane()) {
      extra += `<h4>文章类型</h4><div class="qf-opt-list">
        <button type="button" class="qf-opt${!state.minor ? ' is-on' : ''}" data-qf-minor="0" aria-pressed="${!state.minor}">不含更正/来信（默认）</button>
        <button type="button" class="qf-opt${state.minor ? ' is-on' : ''}" data-qf-minor="1" aria-pressed="${!!state.minor}">含更正/来信</button>
      </div>`;
      extra += `<h4>可读内容</h4><div class="qf-opt-list">
        <button type="button" class="qf-opt${!state.reading ? ' is-on' : ''}" data-qf-reading="" aria-pressed="${!state.reading}">全部内容</button>
        <button type="button" class="qf-opt${state.reading === 'abstract' ? ' is-on' : ''}" data-qf-reading="abstract" aria-pressed="${state.reading === 'abstract'}">有公开摘要</button>
        <button type="button" class="qf-opt${state.reading === 'guide' ? ' is-on' : ''}" data-qf-reading="guide" aria-pressed="${state.reading === 'guide'}">已核对导读</button>
        <button type="button" class="qf-opt${state.reading === 'quicklook' ? ' is-on' : ''}" data-qf-reading="quicklook" aria-pressed="${state.reading === 'quicklook'}">AI 速览</button>
      </div>`;
    }
    const visMore = qfChipVis();
    let moved = '';
    if (visMore.nocase) {
      moved += `<h4>病例报告</h4><div class="qf-opt-list"><button type="button" class="qf-opt${state.excludeCaseReports ? ' is-on' : ''}" data-qf="nocase" aria-pressed="${!!state.excludeCaseReports}">不看病例</button></div>`;
    }
    if (visMore.specialty) moved += specialtyPopHtml().replace(/<div class="qf-pop-head">[\s\S]*?<\/div>/, '');
    if (visMore.design) moved += designPopHtml().replace(/<div class="qf-pop-head">[\s\S]*?<\/div>/, '');
    const presets = loadFilterPresets();
    const presetHtml = presets.length
      ? `<h4>已保存的预设</h4><p class="qf-hint">仅此浏览器保存，不会自动套用。</p><div class="qf-opt-list">` +
        presets.map(p => `<div class="qf-preset-row"><button type="button" class="qf-opt" data-qf-preset="${esc(String(p.id))}">${esc(p.name || '未命名预设')}</button><button type="button" class="qf-preset-del" data-qf-del-preset="${esc(String(p.id))}" aria-label="删除预设">×</button></div>`).join('') +
        `</div>`
      : '<p class="qf-hint">用列表上方的 ☆保存，可以把当前条件存成预设。仅此浏览器保存，打开站点时不会自动套用。</p>';
    return `<div class="qf-pop-head"><strong>更多筛选</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>${moved}
      <h4>出版方</h4><p class="qf-hint">可选的浏览方式。选刊不会自动带上出版方。</p>
      <div class="qf-opt-list">${pubHtml}</div>${extra}${presetHtml}`;
  }

  function toggleJournal(name) {
    if (!name) return;
    let list = selectedJournals().slice();
    if (list.includes(name)) list = list.filter(j => j !== name);
    else { list.push(name); rememberJournal(name); }
    state.journals = list;
    state.journal = list[0] || '';
    // 选刊不自动带上出版方
    if (list.length) state.publisher = '';
    qfApply();
  }
  function toggleFollow(name) {
    if (!name) return;
    const f = state.favoriteJournals || [];
    state.favoriteJournals = f.includes(name) ? f.filter(j => j !== name) : [...f, name];
    safeSet('xz_favorite_journals', JSON.stringify(state.favoriteJournals));
    if (qfOpen && qfOpen.kind && qfOpen.kind.slice(0, 6) === 'jtier:') refreshJournalList();
    else renderQuickFilters();
  }

  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('[data-qf], #qfScopeBtn, [data-qf-close], [data-qf-pick-journal], [data-qf-follow], [data-qf-jtier], [data-qf-jtier-menu], [data-qf-jtier-all], [data-qf-tier], [data-qf-design], [data-qf-lane], [data-qf-range], [data-qf-ft], [data-qf-pub], [data-qf-minor], [data-qf-reading], [data-qf-preset], [data-qf-del-preset], [data-qf-clear], [data-qf-save]');
    if (!t) {
      if (qfOpen && !$('#qfPop')?.contains(e.target) && !e.target.closest('#quickBar')) closeQfPop();
      return;
    }
    if (t.hasAttribute('data-qf-close')) { closeQfPop(); return; }
    if (t.id === 'qfScopeBtn') { qfOpen && qfOpen.kind === 'scope' ? closeQfPop() : openQfPop('scope'); return; }
    const kind = t.getAttribute('data-qf');
    if (kind === 'star') { state.favoritesOnly = !state.favoritesOnly; closeQfPop(); qfApply(); return; }
    if (kind === 'nocase') {
      state.excludeCaseReports = !state.excludeCaseReports;
      if (state.excludeCaseReports && state.studyDesign === '病例报告') state.studyDesign = '';
      closeQfPop(); qfApply(); return;
    }
    if (kind === 'journal' || kind === 'specialty' || kind === 'design' || kind === 'more') {
      qfOpen && qfOpen.kind === kind ? closeQfPop() : openQfPop(kind);
      return;
    }
    if (t.hasAttribute('data-qf-jtier-menu')) {
      const id = t.getAttribute('data-qf-jtier-menu');
      const k = 'jtier:' + id;
      qfOpen && qfOpen.kind === k ? closeQfPop() : openQfPop(k);
      return;
    }
    if (t.hasAttribute('data-qf-jtier-all')) {
      const id = t.getAttribute('data-qf-jtier-all');
      state.journalTier = id;
      state.journals = [];
      state.journal = '';
      state.publisher = '';
      qfApply();
      return;
    }
    if (t.hasAttribute('data-qf-jtier')) {
      selectWholeTier(t.getAttribute('data-qf-jtier'));
      closeQfPop();
      qfApply();
      return;
    }
    const follow = t.getAttribute('data-qf-follow');
    if (follow) { e.preventDefault(); e.stopPropagation(); toggleFollow(follow); return; }
    if (t.hasAttribute('data-qf-pick-journal') || t.hasAttribute('data-qf-journal')) {
      const name = t.getAttribute('data-qf-pick-journal') || t.getAttribute('data-qf-journal');
      const tierId = t.getAttribute('data-qf-journal-tier') || (t.closest('[data-qf-journal-tier]') && t.closest('[data-qf-journal-tier]').getAttribute('data-qf-journal-tier')) || (qfOpen && qfOpen.kind && qfOpen.kind.slice(0, 6) === 'jtier:' ? qfOpen.kind.slice(6) : '');
      if (tierId) toggleJournalInTier(tierId, name);
      else toggleJournal(name);
      qfApply();
      return;
    }
    if (t.hasAttribute('data-qf-tier')) {
      const v = t.getAttribute('data-qf-tier');
      state.clinicalTier = state.clinicalTier === v ? '' : v;
      closeQfPop(); qfApply(); return;
    }
    if (t.hasAttribute('data-qf-design')) {
      const v = t.getAttribute('data-qf-design');
      state.studyDesign = state.studyDesign === v ? '' : v;
      if (state.studyDesign === '病例报告') state.excludeCaseReports = false;
      closeQfPop(); qfApply(); return;
    }
    if (t.hasAttribute('data-qf-lane')) { state.lane = t.getAttribute('data-qf-lane') || 'core'; qfApply(); return; }
    if (t.hasAttribute('data-qf-range')) { state.range = t.getAttribute('data-qf-range') || defaultRange(state.mode); qfApply(); return; }
    if (t.hasAttribute('data-qf-ft')) { state.ftFilter = t.getAttribute('data-qf-ft') || ''; qfApply(); return; }
    if (t.hasAttribute('data-qf-pub')) {
      const v = t.getAttribute('data-qf-pub');
      if (state.publisher === v && !selectedJournals().length) state.publisher = '';
      else { state.publisher = v; state.journals = []; state.journal = ''; }
      qfApply(); return;
    }
    if (t.hasAttribute('data-qf-minor')) { state.minor = t.getAttribute('data-qf-minor') === '1'; qfApply(); return; }
    if (t.hasAttribute('data-qf-reading')) { state.reading = t.getAttribute('data-qf-reading') || ''; qfApply(); return; }
    if (t.hasAttribute('data-qf-tag')) {
      const v = t.getAttribute('data-qf-tag');
      state.tag = state.tag === v ? '' : v;
      qfApply(); return;
    }
    if (t.hasAttribute('data-qf-preset')) { closeQfPop(); applyFilterPreset(t.getAttribute('data-qf-preset')); return; }
    if (t.hasAttribute('data-qf-del-preset')) { deleteFilterPreset(t.getAttribute('data-qf-del-preset')); openQfPop('more', true); return; }
    if (t.hasAttribute('data-qf-save')) {
      const n = loadFilterPresets().length + 1;
      saveFilterPreset('预设 ' + n);
      renderQfSummary();
      return;
    }
    if (t.hasAttribute('data-qf-clear')) {
      const key = t.getAttribute('data-qf-clear');
      const val = t.getAttribute('data-qf-clear-value');
      if (key === 'all') clearQuickFilters();
      else if (key === 'jtier') { state.journalTier = ''; state.journals = []; state.journal = ''; }
      else if (key === 'favorites') state.favoritesOnly = false;
      else if (key === 'nocase') state.excludeCaseReports = false;
      else if (key === 'journal') {
        state.journals = selectedJournals().filter(j => j !== val);
        state.journal = state.journals[0] || '';
        if (!state.journals.length) state.journalTier = '';
      }
      else if (key === 'tier') state.clinicalTier = '';
      else if (key === 'design') state.studyDesign = '';
      else if (key === 'pub') state.publisher = '';
      else if (key === 'tag') state.tag = '';
      else if (key === 'minor') state.minor = false;
      else if (key === 'reading') state.reading = '';
      else if (key === 'ft') state.ftFilter = '';
      else if (key === 'lane') state.lane = 'core';
      else if (key === 'range') state.range = defaultRange(state.mode);
      closeQfPop(); qfApply(); return;
    }
  });
  document.addEventListener('input', e => {
    if (e.target && e.target.id === 'qfJournalSearch') {
      if (!qfOpen) qfOpen = { kind: 'journal', query: '' };
      qfOpen.query = e.target.value;
      refreshJournalList();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && qfOpen) { closeQfPop(); e.preventDefault(); }
  });
  window.addEventListener('resize', () => {
    if (!qfOpen) return;
    let anchor;
    if (qfOpen.kind === 'scope') anchor = $('#qfScopeBtn');
    else if (qfOpen.kind && qfOpen.kind.slice(0, 6) === 'jtier:') anchor = $(`.qf-chip-caret[data-qf-jtier-menu="${qfOpen.kind.slice(6)}"]`);
    else anchor = $(`.qf-chip[data-qf="${qfOpen.kind}"]`);
    placeQfPop(anchor);
  });
  // ==== src/app/10-browse-events.js · Browse controls, event wiring and start-up ====
  // 筛选 panel: a right-hand drawer on wide screens and a bottom sheet on phones. Its groups share state with the
  // filter row (领域, 全文); picking an option applies at once and "查看 N 篇" only closes the panel.
  function moreFilterCount() {
    if (!usesLane()) return 0;
    return sidebarSelections().length + (state.reading ? 1 : 0) + (state.favoritesOnly ? 1 : 0) + (state.minor ? 1 : 0)
      + (state.lane !== 'core' ? 1 : 0) + (state.range !== defaultRange(state.mode) ? 1 : 0) + (state.mode === 'library' && state.ftFilter ? 1 : 0);
  }
  const READING_OPTS = [['', '全部内容'], ['abstract', '有公开摘要'], ['guide', '已核对导读'], ['quicklook', 'AI 速览']];
  const PANEL_GROUPS = () => [
    ['lane', '#panelOptLane', LANES.map(l => [l.id, l.short || l.name]), state.lane],
    ['ft', '#panelOptFt', FT_FILTERS.map(([v, n]) => [v, v === '' ? '全部全文' : n]), state.ftFilter || ''],
    ['reading', '#panelOptReading', READING_OPTS, state.reading || ''],
    ['range', '#panelOptRange', RANGES_BY_MODE[state.mode] || RANGES_BY_MODE.library, state.range],
    ['journal', '#panelOptJournal', [['all', '全部期刊'], ['mine', '我的期刊']], state.favoritesOnly ? 'mine' : 'all'],
    ['type', '#panelOptType', [['orig', '不含更正/来信（默认）'], ['minor', '含更正/来信']], state.minor ? 'minor' : 'orig']
  ];
  function renderPanelGroups() {
    const body = $('#panelBody');
    if (!body) return;
    const rebuild = body.dataset.mode !== state.mode;
    body.dataset.mode = state.mode;
    PANEL_GROUPS().forEach(([id, sel, options, current]) => {
      const host = $(sel); if (!host) return;
      if (rebuild) host.innerHTML = options.map(([v, n]) => `<button type="button" class="panel-opt" data-panel="${id}" data-value="${esc(v)}" aria-pressed="false">${esc(n)}</button>`).join('');
      host.querySelectorAll('.panel-opt').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === String(current))));
    });
    const ft = $('#pgFt'); if (ft) ft.hidden = state.mode !== 'library';
  }
  function renderMoreFilters() {
    const toggle = $('#filterToggleBtn');
    const n = moreFilterCount(), lane = usesLane();
    if (toggle) {
      toggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg><span class="filter-label">' + (n ? `筛选 · ${n}` : '筛选') + '</span>';
      toggle.classList.toggle('active', n > 0);
      toggle.setAttribute('aria-expanded', String(!!$('#appSidebar.open')));
      toggle.setAttribute('aria-label', n ? `筛选，已生效 ${n} 项` : '筛选');
    }
    if (!lane) return;
    renderPanelGroups();
    const followed = state.favoriteJournals.includes(state.journal);
    const star = $('#favoriteJournalBtn');
    if (star) { star.disabled = !state.journal; star.textContent = followed ? '★ 已关注' : '☆ 关注期刊'; star.setAttribute('aria-pressed', String(followed)); }
  }
  document.addEventListener('click', e => {
    const opt = e.target.closest && e.target.closest('.panel-opt[data-panel]');
    if (!opt) return;
    const v = opt.dataset.value;
    if (opt.dataset.panel === 'lane') state.lane = v;
    else if (opt.dataset.panel === 'ft') state.ftFilter = v;
    else if (opt.dataset.panel === 'reading') state.reading = v;
    else if (opt.dataset.panel === 'range') state.range = v;
    else if (opt.dataset.panel === 'journal') state.favoritesOnly = v === 'mine';
    else if (opt.dataset.panel === 'type') state.minor = v === 'minor';
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  });
  // 重置: every filter in the row and the panel, including time; the search keyword stays.
  function resetPanelFilters() {
    clearSidebarFilters();
    state.lane = 'core'; state.range = defaultRange(state.mode); state.ftFilter = ''; state.reading = ''; state.favoritesOnly = false; state.minor = false;
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  }
  $('#panelResetBtn')?.addEventListener('click', resetPanelFilters);
  $('#modeNote')?.addEventListener('click',e=>{const t=e.target.closest('.mode-note-toggle');if(!t)return;const open=e.currentTarget.classList.toggle('note-open');t.setAttribute('aria-expanded',String(open));});
  $('#favoriteJournalBtn')?.addEventListener('click',()=>{if(!state.journal)return; const f=state.favoriteJournals;state.favoriteJournals=f.includes(state.journal)?f.filter(j=>j!==state.journal):[...f,state.journal];safeSet('xz_favorite_journals',JSON.stringify(state.favoriteJournals));renderSidebarFilters();renderStream();});
  $('#favoritesOnlyBtn')?.addEventListener('click',()=>{state.favoritesOnly=!state.favoritesOnly;state.page=1;renderSidebarFilters();renderStream();});

  // Reset Filters
  function resetAllFilters() {
    state.search = '';
    clearSidebarFilters();
    state.range = defaultRange(state.mode);
    state.lane = 'core'; state.reading=''; state.favoritesOnly=false; state.minor=false; state.ftFilter='';
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
  // The header is one row of four sections now, so it stays put instead of tucking away.
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

  const openSheet = () => {
    const sb = $('#appSidebar'); if (!sb) return;
    sb.classList.add('open'); $('#filterToggleBtn')?.setAttribute('aria-expanded', 'true');
    (sb.querySelector('.panel-opt[data-panel][aria-pressed="true"]') || sb.querySelector('button'))?.focus({ preventScroll: true });
  };
  $('#filterToggleBtn')?.addEventListener('click', () => { if ($('#appSidebar')?.classList.contains('open')) closeSheet(); else openSheet(); });
  $('#panelApplyBtn')?.addEventListener('click', e => {
    if (e.currentTarget.dataset.empty === '1') { resetPanelFilters(); return; }
    closeSheet();
    ($('#listHead') || $('#streamSection'))?.scrollIntoView({ block: 'start' });
  });

  // Mobile filter sheet: close button, backdrop tap (via body::after), Esc
  function closeSheet() { const sb = $('#appSidebar'); const was = sb && sb.classList.contains('open'); if (sb) sb.classList.remove('open'); const t = $('#filterToggleBtn'); if (t) { t.setAttribute('aria-expanded', 'false'); if (was) t.focus({ preventScroll: true }); } }
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
        syncSearchPanel();
        if (!exactDoi(state.search) && state.mode !== 'weekly' && state.mode !== 'sources') renderSidebarFilters();
        renderStream();
      }, 180);
    });
  }

  const searchBtn = $('#searchToggleBtn');
  // Prevent pointer mousedown on the toggle from blurring #globalSearch before click sees the open panel.
  searchBtn?.addEventListener('mousedown', e => e.preventDefault());
  searchBtn?.addEventListener('click', () => {
    const panel = $('#searchPanel');
    if (!panel) return;
    if (!panel.hidden && !state.search && !searchInput?.value) {
      panel.hidden = true;
      searchBtn.setAttribute('aria-expanded', 'false');
      searchBtn.classList.remove('active');
      searchBtn.focus({ preventScroll: true });
      return;
    }
    syncSearchPanel(true);
    searchInput?.focus();
  });
  searchInput?.addEventListener('blur', () => { if (!searchInput.value && !state.search) { const p = $('#searchPanel'); if (p) p.hidden = true; searchBtn?.setAttribute('aria-expanded', 'false'); searchBtn?.classList.remove('active'); } });
  // Hotkey '/' for search
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey
        || $('#huddleModalBackdrop.open') || $('#readerDrawer.open') || $('#deepReader.open')
        || document.activeElement?.matches('input,textarea,select') || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      syncSearchPanel(true);
      searchInput?.focus();
    } else if (e.key === 'Tab') {
      const modal = $('#huddleModalBackdrop.open .modal-dialog') || $('#readerDrawer.open') || $('#deepReader.open') || $('#appSidebar.open');
      if (modal) {
        const nodes = [...modal.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && !x.hidden && !x.closest('[hidden],[inert]') && x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden' && (!x.checkVisibility || x.checkVisibility({ checkVisibilityCSS: true })) && !(x.closest('details:not([open])') && !(x.tagName === 'SUMMARY' && x.parentElement?.matches('details:not([open])'))));
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) return;
        if (!modal.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    } else if (e.key === 'Escape') {
      // One press closes the topmost layer only: shortlist, then reader, then full-text reading, then filters.
      if ($('#huddleModalBackdrop.open')) closeHuddleModal();
      else if ($('#readerDrawer.open')) closeReaderDrawer();
      else if ($('#deepReader.open')) closeDeepReading();
      else if ($('#appSidebar.open')) closeSheet();
    }
  });

  document.addEventListener('click', e => {
    const retryShard = e.target.closest('[data-action="retry-reading-shard"]');
    if (retryShard) { openDeepReading(retryShard.dataset.readingId, { push: false }); return; }
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
    const sourceFilter = e.target.closest('[data-source-filter]');
    if (sourceFilter) {
      state.sourceFilter = sourceFilter.dataset.sourceFilter;
      renderSourcesHealth(); syncUrl();
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
    const ftBtn = e.target.closest('[data-ft-filter]');
    if (ftBtn) {
      state.ftFilter = ftBtn.dataset.ftFilter || '';
      state.page = 1;
      renderSidebarFilters();
      renderStream();
      return;
    }
    const b = e.target.closest('[data-range]');
    if (!b) return;
    state.range = b.dataset.range;
    state.page = 1;
    renderSidebarFilters();
    renderStream();
  });

  // Lane, time range and full-text status are native selects in the filter row.
  document.addEventListener('change', e => {
    const q = sel => e.target.closest && e.target.closest(sel);
    const lane = q('select[data-lane-select]'), range = q('select[data-range-select]'), ft = q('select[data-ft-select]');
    if (!lane && !range && !ft) return;
    if (lane) state.lane = lane.value; else if (range) state.range = range.value; else state.ftFilter = ft.value;
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

  // Global Document Clicks Delegation
  // 卡片内口令下载：服务端 /api/ai?task=status 返回 pdfSignedLink:true 才启用；默认 false，此时「下载 PDF」照旧新开标签。
  let PDF_SIGNED_LINK = false;
  const DL_MSG = {
    invalid: '口令不正确，请重新输入。',
    limited: '口令错误次数过多，请一小时后再试。',
    network: '网络异常，请稍后重试。',
    other: '暂时无法下载，请稍后重试，或到官网原文获取。',
    empty: '请输入全文口令。'
  };
  function dlSetBusy(form, busy, label) {
    const input = form.querySelector('input[name="passphrase"]'), btn = form.querySelector('button[type="submit"]');
    if (input) input.disabled = busy;
    if (btn) { btn.disabled = busy; btn.textContent = label; }
    form.classList.toggle('is-busy', busy);
    if (busy) form.setAttribute('aria-busy', 'true'); else form.removeAttribute('aria-busy');
  }
  // 提交口令换取签名链接：口令只放在 POST 正文里，不写 console / localStorage / URL。
  async function submitDownloadForm(form) {
    if (form.dataset.busy === '1') return;
    const link = dlLinkFor(form), input = form.querySelector('input[name="passphrase"]'), err = form.querySelector('.ft-error');
    const showError = msg => { if (err) err.textContent = msg; };
    const passphrase = input ? input.value : '';
    showError('');
    if (!passphrase.trim()) { showError(DL_MSG.empty); if (input) input.focus(); return; }
    const href = link ? (link.getAttribute('href') || '') : '';
    if (!/^\/api\/(pdf|fulltext)\?/.test(href)) { showError(DL_MSG.other); return; }
    form.dataset.busy = '1';
    dlSetBusy(form, true, '正在验证口令…');
    const restore = () => { delete form.dataset.busy; dlSetBusy(form, false, DL_BTN_LABEL); };
    const fail = msg => { restore(); showError(msg); if (input) input.focus(); };
    let status = 0, data = null;
    try {
      const resp = await fetch(href + '&link=1', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: 'passphrase=' + encodeURIComponent(passphrase),
        credentials: 'same-origin',
        cache: 'no-store'
      });
      status = resp.status;
      data = await resp.json().catch(() => null);
    } catch (e) { data = null; }
    if (!data || typeof data !== 'object') { fail(DL_MSG.network); return; }
    if (data.ok === true) {
      const url = typeof data.url === 'string' ? data.url : '';
      if (!/^\/api\/(pdf|fulltext)\?/.test(url)) { fail(DL_MSG.other); return; }
      if (input) input.value = '';
      dlSetBusy(form, true, '正在取回 PDF…');
      location.assign(url);
      setTimeout(() => { resetDlForm(form); showToast('已开始下载'); }, 2000);
      return;
    }
    const code = typeof data.error === 'string' ? data.error : '';
    if (code === 'pdf_link_disabled') {
      // 服务端关闭了签名链接：退回旧行为，新开标签到服务端口令页。
      PDF_SIGNED_LINK = false;
      resetDlForm(form);
      window.open(href, '_blank', 'noopener');
      return;
    }
    if (code === 'pdf_rate_limited' || status === 429) { fail(DL_MSG.limited); return; }
    if (code === 'pdf_passphrase_invalid' || code === 'library_passphrase_invalid' || status === 403) { fail(DL_MSG.invalid); return; }
    fail(DL_MSG.other);
  }
  document.addEventListener('submit', e => {
    const dlForm = e.target.closest && e.target.closest('form[data-ft-dl-form]');
    if (dlForm) { e.preventDefault(); submitDownloadForm(dlForm); return; }
    const form = e.target.closest && e.target.closest('form[data-ft-form]');
    if (form) { e.preventDefault(); submitFulltextForm(form); }
  });
  document.addEventListener('click', e => {
    const dl = e.target.closest('a[data-ft-download]');
    if (dl && PDF_SIGNED_LINK && !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button)) {
      const dlForm = dlFormFor(dl);
      if (dlForm) {
        e.preventDefault();
        if (dlForm.dataset.busy === '1') return;
        if (dlForm.hidden) { dlForm.hidden = false; dlForm.querySelector('input')?.focus(); }
        else resetDlForm(dlForm);
        return;
      }
    }
    const ft = e.target.closest('[data-ft-action]');
    if (ft) {
      const doi = exactDoi(ft.dataset.doi), box = ft.closest('[data-ft-doi]') || ft.parentElement;
      if (ft.dataset.ftAction === 'open-form') {
        const form = (box.querySelector('[data-ft-form]') || (box.parentElement && box.parentElement.querySelector('[data-ft-form]')));
        if (form) { form.hidden = false; form.querySelector('input')?.focus(); }
      } else if (ft.dataset.ftAction === 'refresh') {
        ft.disabled = true;
        const form = ft.closest('form[data-ft-form]');
        if (form) {
          const inDrawer = !!form.closest('#drawerFulltext');
          const err = form.querySelector('.ft-error');
          if (err) err.textContent = '正在核对状态…';
          reconcileFtFormAfterLookup(doi, form, inDrawer);
        } else {
          lookupSupplementalDoi(doi, true).then(refreshSupplementalView);
        }
      }
      return;
    }
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
      if (['pub', 'publisher'].includes(type)) { state.publisher = ''; if (!selectedJournals().length && !state.journalTier) state.journal = ''; }
      if (['journal', 'journals', 'jtier'].includes(type)) { state.journal = ''; state.journals = []; state.journalTier = ''; }
      if (type === 'range') state.range = defaultRange(state.mode);
      if (type === 'lane') state.lane = 'core';
      if (type === 'minor') state.minor = false;
      if (type === 'design') state.studyDesign = '';
      if (type === 'tag') state.tag = '';
      if (type === 'reading') state.reading = '';
      if (type === 'favorites') state.favoritesOnly = false;
      if (type === 'nocase') state.excludeCaseReports = false;
      if (type === 'ft') state.ftFilter = '';
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
    const absTab = e.target.closest('[data-abs-tab]');
    if (absTab) {
      const wrap = absTab.closest('.abstract-reader') || absTab.parentElement;
      const key = absTab.getAttribute('data-abs-tab');
      wrap.querySelectorAll('[data-abs-tab]').forEach(btn => {
        const on = btn.getAttribute('data-abs-tab') === key;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      wrap.querySelectorAll('[data-abs-panel]').forEach(panel => {
        panel.hidden = panel.getAttribute('data-abs-panel') !== key;
      });
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
    if (entry.overlay || entry.deepReader) return;
    const next = readStateFromUrl();
    if (!URL_STATE_KEYS.some(k => state[k] !== next[k])) return;
    clearTimeout(searchTimer);
    viewInUrl = next.viewInUrl;
    URL_STATE_KEYS.forEach(k => { state[k] = next[k]; });
    if (searchInput) searchInput.value = state.search;
    if (sortSelect) sortSelect.value = state.sort;
    $('#viewCardsBtn')?.classList.toggle('active', state.viewMode === 'cards');
    $('#viewCompactBtn')?.classList.toggle('active', state.viewMode === 'compact');
    syncSearchPanel();
    switchMode(next.mode, true);
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
  // Clearing the whole shortlist asks once more: the first tap arms the button, the second one clears.
  let clearArmTimer = null;
  $('#clearHuddleBtn')?.addEventListener('click', e => {
    const btn = e.currentTarget;
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = `再点一次，确认清空 ${state.huddle.length} 篇`;
      clearTimeout(clearArmTimer);
      clearArmTimer = setTimeout(() => { delete btn.dataset.armed; btn.textContent = '清空清单'; }, 4000);
      return;
    }
    clearTimeout(clearArmTimer);
    delete btn.dataset.armed; btn.textContent = '清空清单';
    state.huddle = [];
    state.huddleCompare = [];
    updateHuddleCounter();
    openHuddleModal();
    renderStream();
    showToast('已清空精选清单');
  });
  // Cards follow their full-text task by themselves: a gentle poll, only while the page is visible.
  let autoSince = 0;
  setInterval(() => {
    if (document.hidden) return;
    const active = [...DOI_JOBS.entries()].filter(([, job]) => doiJobActive(job)).slice(0, 5);
    if (!active.length) { autoSince = 0; return; }
    if (!autoSince) autoSince = Date.now();
    if (Date.now() - autoSince > 3600000) return;
    active.forEach(([doi]) => { if (DOI_TOUCHED.size < 10) DOI_TOUCHED.add(doi); lookupSupplementalDoi(doi, true); });
  }, 60000);

  // Initialize
  // A reload keeps history.state; a panel marker left from before the reload no longer has a panel.
  try { if (history.state && (history.state.overlay || history.state.deepReader)) history.replaceState(null, '', location.href); } catch (e) { /* sandboxed */ }
  updateHeaderBadges();
  updateHuddleCounter();
  if (!['curated', 'weekly', 'candidates', 'library', 'sources'].includes(state.mode)) state.mode = 'curated';
  if (searchInput && state.search) searchInput.value = state.search;
  switchMode(state.mode, true);
  loadSupplementalLibrary();
  const refreshLibraryAfterReturn = () => {
    if (SUPPLEMENTAL_LIBRARY.promise) return;
    const doi = exactDoi(state.search);
    if (Date.now() - SUPPLEMENTAL_LIBRARY.refreshedAt < LIBRARY_REFRESH_TTL_MS) {
      if (doi && doiJobActive(DOI_JOBS.get(doi))) lookupSupplementalDoi(doi, true);
      return;
    }
    loadSupplementalLibrary(true);
    if (doi) lookupSupplementalDoi(doi, true);
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
    .then(j => { AI_AVAIL = !!(j && j.canGenerate); PDF_SIGNED_LINK = !!(j && j.pdfSignedLink === true); renderDigestBar(); if (state.activeDrawerPaper) openReaderDrawer(state.activeDrawerPaper); })
    .catch(() => { AI_AVAIL = false; PDF_SIGNED_LINK = false; if (state.activeDrawerPaper) openReaderDrawer(state.activeDrawerPaper); });

  if (state.mode === 'weekly' && urlParams.get('read')) openDeepReading(urlParams.get('read'), { push: false });

  if (urlParams.get('drawer') === 'first') {
    const list = getFilteredArticles();
    if (list.length > 0) openReaderDrawer(list[0]);
  }

})();

  // 窄屏（<380px）列表头放不下视图切换：只留排序，详细/列表挪到页脚。
  (() => {
    const mq = window.matchMedia && window.matchMedia('(max-width: 379px)');
    const toggle = document.querySelector('.list-head .view-toggle');
    const footer = document.getElementById('appFooter'), tools = document.getElementById('listHeadTools');
    if (!mq || !toggle || !footer || !tools) return;
    const place = () => { if (mq.matches) footer.prepend(toggle); else tools.append(toggle); };
    place();
    (mq.addEventListener ? mq.addEventListener('change', place) : mq.addListener(place));
  })();
// ==== src/app/11-page-extras.js · Standalone page helpers outside the main app scope ====

;(function () {
  const button = document.getElementById('backToTopBtn');
  if (!button) return;
  const update = () => { button.hidden = window.scrollY < 600; };
  window.addEventListener('scroll', update, { passive: true });
  button.addEventListener('click', () => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    (document.querySelector('.header-nav .nav-tab-btn.active') || document.querySelector('.header-nav .nav-tab-btn'))?.focus({ preventScroll: true });
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

  // 阅读台底部固定栏的实测高度，供正文底部留白使用（栏高 + 安全区），内容再短也不会盖住最后一个按钮。
  (() => {
    const foot = document.querySelector('.drawer-footer');
    if (!foot) return;
    const sync = () => document.documentElement.style.setProperty('--drawer-foot-h', Math.ceil(foot.getBoundingClientRect().height) + 'px');
    sync();
    if (window.ResizeObserver) new ResizeObserver(sync).observe(foot);
    window.addEventListener('resize', sync);
  })();
