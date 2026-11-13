// 期刊档次表。用规范化刊名（去首尾空白、合并空格、小写）做全名精确匹配，不用子串。
// JAMA Cardiology 不会进入 JAMA；Nature Medicine 不会进入 Nature；The Lancet Digital Health 不会进入 The Lancet。
(function (global) {
  function normalizeJournalName(s) {
    return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  const JOURNAL_TIERS = [
    {
      id: 'flagship',
      short: '顶刊',
      title: '顶刊',
      // 只放这六本主刊本身，不含任何子刊或姊妹刊。
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
      // 同一级别、由站点补入的刊，界面标「建议」。
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
      names: [
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
      ],
      suggested: [
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
      ]
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
    if (tier.id === 'other') return;
    (tier.names || []).forEach(n => register(n, tier.id, false));
    (tier.suggested || []).forEach(n => register(n, tier.id, true));
  });

  function tierOfName(name) {
    const key = normalizeJournalName(name);
    if (!key) return 'other';
    return nameToTier[key] || 'other';
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
    if (!tier || tier.id === 'other') return [];
    const list = (tier.names || []).slice();
    if (includeSuggested !== false) list.push.apply(list, tier.suggested || []);
    const seen = Object.create(null);
    return list.filter(n => {
      const k = normalizeJournalName(n);
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  global.XINZHI_JOURNAL_TIERS = {
    normalizeJournalName,
    tiers: JOURNAL_TIERS,
    tierOfName,
    canonName,
    isSuggestedName,
    namesInTier
  };
})(typeof window !== 'undefined' ? window : globalThis);
