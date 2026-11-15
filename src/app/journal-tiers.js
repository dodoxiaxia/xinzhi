// 期刊档次表。用规范化刊名（去首尾空白、合并空格、小写）做全名精确匹配，不用子串。
// JAMA Cardiology 不会进入 JAMA；Nature Medicine 不会进入 Nature；The Lancet Digital Health 不会进入 The Lancet。
(function (global) {
  function normalizeJournalName(s) {
    return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function dedupeNames(list) {
    const seen = Object.create(null);
    return list.filter(n => {
      const k = normalizeJournalName(n);
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  const AI_NAMES = [
    'NEJM AI',
    'The Lancet Digital Health',
    'npj Digital Medicine',
    'NPJ Digital Medicine',
    'Nature Machine Intelligence',
    'JMIR',
    'JMIR AI',
    'JMIR Biomedical Engineering',
    'JMIR Medical Informatics',
    'Journal of the American Medical Informatics Association',
    'European Heart Journal - Digital Health'
  ];

  const AI_SUGGESTED = [
    'BMJ Digital Health & AI',
    'npj Artificial Intelligence',
    'International Journal of Medical Informatics',
    'BMC Medical Informatics and Decision Making',
    'Frontiers in Digital Health',
    'Intelligent Medicine',
    'Informatics in Medicine Unlocked',
    'Journal of Biomedical Informatics',
    'Journal of Imaging Informatics in Medicine',
    'Artificial Intelligence'
  ];

  const JOURNAL_TIERS = [
    {
      id: 'generalMedicine',
      short: '综合',
      title: '综合医学',
      names: [
        'Nature Medicine',
        'New England Journal of Medicine',
        'The Lancet',
        'JAMA',
        'The BMJ'
      ],
      suggested: []
    },
    {
      id: 'cardioClinical',
      short: '临床',
      title: '心血管临床',
      names: [
        'Circulation',
        'JACC',
        'JAMA Cardiology',
        'European Heart Journal',
        'Circulation: Cardiovascular Interventions',
        'Circulation: Heart Failure',
        'Circulation: Genomic and Precision Medicine',
        'Circulation: Cardiovascular Imaging',
        'Circulation: Cardiovascular Quality and Outcomes',
        'JACC: Case Reports',
        'JACC: Cardiovascular Interventions',
        'JACC: Advances',
        'JACC: Heart Failure',
        'JACC: Cardiovascular Imaging',
        'JACC: Clinical Electrophysiology',
        'JACC Asia',
        'European Heart Journal - Cardiovascular Imaging',
        'European Heart Journal - Cardiovascular Pharmacotherapy',
        'European Heart Journal Supplements',
        'Heart Rhythm',
        'Heart Rhythm O2',
        'Journal of the American Heart Association',
        'Heart',
        'Europace'
      ],
      suggested: []
    },
    {
      id: 'basicTranslational',
      short: '转化',
      title: '基础与转化',
      names: [
        'Circulation Research',
        'JACC: Basic to Translational Science'
      ],
      suggested: []
    },
    {
      id: 'review',
      short: '综述',
      title: '综述',
      names: [
        'Nature Reviews Cardiology'
      ],
      suggested: []
    },
    {
      id: 'flagship',
      short: '顶刊',
      title: '顶刊',
      names: [
        'Science',
        'Nature'
      ],
      suggested: []
    },
    {
      id: 'ai',
      short: 'AI',
      title: 'AI 期刊',
      names: AI_NAMES.slice(),
      suggested: AI_SUGGESTED.slice()
    },
    {
      id: 'other',
      short: '其他',
      title: '其他期刊',
      names: [
        'Nature Biomedical Engineering'
      ],
      // 原补录心血管/待核刊保留在「其他」中具名可发现，不标为已核定医学类。
      suggested: [
        'Nature Cardiovascular Research',
        'European Journal of Heart Failure',
        'Journal of Cardiovascular Electrophysiology',
        'Cardiovascular Research',
        'Hypertension',
        'Arteriosclerosis, Thrombosis, and Vascular Biology',
        'Pacing and Clinical Electrophysiology',
        'npj Cardiovascular Health',
        'American Heart Journal',
        'Journal of Arrhythmia',
        '中华心血管病杂志'
      ]
    }
  ];

  // 历史档次表：专供旧 jtier URL 兼容解析与筛选，不影响可见菜单。
  const LEGACY_JOURNAL_TIERS = [
    {
      id: 'flagship',
      short: '顶刊',
      title: '顶刊',
      names: [
        'New England Journal of Medicine',
        'The Lancet',
        'JAMA',
        'The BMJ',
        'Science',
        'Nature'
      ],
      suggested: []
    },
    {
      id: 'cardioMain',
      short: '心刊',
      title: '心血管主刊',
      names: [
        'Circulation',
        'JACC',
        'JAMA Cardiology',
        'European Heart Journal',
        'Nature Medicine'
      ],
      suggested: [
        'Nature Cardiovascular Research',
        'Nature Reviews Cardiology',
        'Circulation Research'
      ]
    },
    {
      id: 'cardioSub',
      short: '子刊',
      title: '心血管子刊',
      names: [
        'Circulation: Cardiovascular Interventions',
        'Circulation: Heart Failure',
        'Circulation: Genomic and Precision Medicine',
        'Circulation: Cardiovascular Imaging',
        'Circulation: Cardiovascular Quality and Outcomes',
        'JACC: Case Reports',
        'JACC: Cardiovascular Interventions',
        'JACC: Advances',
        'JACC: Heart Failure',
        'JACC: Cardiovascular Imaging',
        'JACC: Clinical Electrophysiology',
        'JACC Asia',
        'JACC: Basic to Translational Science',
        'European Heart Journal - Cardiovascular Imaging',
        'European Heart Journal - Cardiovascular Pharmacotherapy',
        'European Heart Journal Supplements',
        'Heart Rhythm',
        'Heart Rhythm O2',
        'Journal of the American Heart Association',
        'Heart',
        'Europace'
      ],
      suggested: [
        'European Journal of Heart Failure',
        'Journal of Cardiovascular Electrophysiology',
        'Cardiovascular Research',
        'Hypertension',
        'Arteriosclerosis, Thrombosis, and Vascular Biology',
        'Pacing and Clinical Electrophysiology',
        'npj Cardiovascular Health',
        'American Heart Journal',
        'Journal of Arrhythmia',
        '中华心血管病杂志'
      ]
    },
    {
      id: 'ai',
      short: 'AI',
      title: 'AI 期刊',
      names: AI_NAMES.slice(),
      suggested: AI_SUGGESTED.slice()
    },
    {
      id: 'other',
      short: '其他',
      title: '其他期刊',
      names: [],
      suggested: []
    }
  ];

  const nameToTier = Object.create(null);
  const nameToCanon = Object.create(null);
  const suggestedSet = Object.create(null);

  function register(name, tierId, suggested) {
    const key = normalizeJournalName(name);
    if (!key) return;
    if (nameToTier[key] && nameToTier[key] !== tierId) {
      throw new Error('journal-tiers: "' + name + '" is assigned to both ' + nameToTier[key] + ' and ' + tierId);
    }
    nameToTier[key] = tierId;
    if (!nameToCanon[key]) nameToCanon[key] = name;
    if (suggested) suggestedSet[key] = true;
  }

  JOURNAL_TIERS.forEach(tier => {
    (tier.names || []).forEach(n => register(n, tier.id, false));
    (tier.suggested || []).forEach(n => register(n, tier.id, true));
  });

  const legacyNameToTier = Object.create(null);
  LEGACY_JOURNAL_TIERS.forEach(tier => {
    if (tier.id === 'other') return;
    const all = (tier.names || []).concat(tier.suggested || []);
    all.forEach(n => {
      const key = normalizeJournalName(n);
      if (key && !legacyNameToTier[key]) legacyNameToTier[key] = tier.id;
    });
  });

  function tierOfName(name) {
    const key = normalizeJournalName(name);
    if (!key) return 'other';
    return nameToTier[key] || 'other';
  }

  function legacyTierOfName(name) {
    const key = normalizeJournalName(name);
    if (!key) return 'other';
    return legacyNameToTier[key] || 'other';
  }

  function canonName(name) {
    const key = normalizeJournalName(name);
    return nameToCanon[key] || String(name || '').trim().replace(/\s+/g, ' ');
  }

  function isSuggestedName(name) {
    return !!suggestedSet[normalizeJournalName(name)];
  }

  function namesInTier(tierId, includeSuggested) {
    const tier = JOURNAL_TIERS.find(t => t.id === tierId);
    if (!tier) return [];
    const list = (tier.names || []).slice();
    if (includeSuggested !== false) list.push.apply(list, tier.suggested || []);
    return dedupeNames(list);
  }

  function namesInLegacyTier(tierId, includeSuggested) {
    const tier = LEGACY_JOURNAL_TIERS.find(t => t.id === tierId);
    if (!tier || tier.id === 'other') return [];
    const list = (tier.names || []).slice();
    if (includeSuggested !== false) list.push.apply(list, tier.suggested || []);
    return dedupeNames(list);
  }

  function isLegacyTierId(tierId) {
    return LEGACY_JOURNAL_TIERS.some(t => t.id === tierId);
  }

  function isVisibleTierId(tierId) {
    return JOURNAL_TIERS.some(t => t.id === tierId);
  }

  function legacyTierDef(tierId) {
    return LEGACY_JOURNAL_TIERS.find(t => t.id === tierId) || null;
  }

  global.XINZHI_JOURNAL_TIERS = {
    normalizeJournalName,
    tiers: JOURNAL_TIERS,
    LEGACY: LEGACY_JOURNAL_TIERS,
    legacyTiers: LEGACY_JOURNAL_TIERS,
    tierOfName,
    legacyTierOfName,
    canonName,
    isSuggestedName,
    namesInTier,
    namesInLegacyTier,
    isLegacyTierId,
    isVisibleTierId,
    legacyTierDef
  };
})(typeof window !== 'undefined' ? window : globalThis);
