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
