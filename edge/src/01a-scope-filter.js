// ==== edge/src/01a-scope-filter.js · Shared intake/dispatch clinical scope filter ====
const SCOPE_CV_CATEGORIES = new Set(['心血管','交叉研究']);
const SCOPE_AI_CATEGORIES = new Set(['AI医疗','交叉研究','AI前沿']);
const SCOPE_AI_MEDICAL_CATEGORIES = new Set(['AI医疗','交叉研究']);
const SCOPE_CV_TIERS = new Set(['心血管旗舰顶刊','心律失常与电生理','心衰与重症心肌','冠脉介入与结构','心血管影像与表型','脑血管与高血压','心血管综合与其他','定向专病与团队']);
const SCOPE_AI_TIERS = new Set(['前沿大模型与科技','AI医疗与数字医学']);
const SCOPE_AI_MEDICAL_TIER = 'AI医疗与数字医学';
const SCOPE_CV_TAGS = new Set(['#房颤/电生理','#心衰/心肌','#心电','#AI-ECG','#卒中/抗凝','#高血压/血管','#冠脉介入']);
const SCOPE_AI_TAGS = new Set(['#大模型/NLP','#AI-ECG']);
const SCOPE_CLINICAL_DESIGNS = new Set(['RCT','队列研究','病例对照研究','横断面研究','RCT 二次分析','指南共识']);
const SCOPE_CLINICAL_PUB_TYPES = new Set(['randomized controlled trial','clinical trial','multicenter study','observational study','practice guideline','guideline']);

const SCOPE_NOT_ARTICLE_TOC_RE = /^(?:\[[^\]]+\]\s*)?(?:(?:issue|table\s+of)\s+)?contents\s*[:.]?\s*$|^[\u4e00-\u9fff()（）《》·\s]{2,40}?\s*\d{4}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?\s*第\s*\d+\s*卷\s*第\s*\d+\s*期(?:\s*目录)?\s*$/i;
const SCOPE_NOT_ARTICLE_SUPPLEMENT_RE = /(?:^|[^a-z0-9])moesm\d*(?:_esm)?(?:$|[^a-z0-9])|^\d+(?:_\d+)+_esm(?:\.[a-z0-9]+)?$|\bsupplemental\s+online\s+content\b/i;

const SCOPE_MESH_ANIMAL_RE = /\b(?:mice|rats|animals|zebrafish)\b/i;
const SCOPE_MESH_HUMAN_RE = /\bhumans\b/i;

const SCOPE_BASIC_ANIMAL_MODEL_RE = /\b(?:mouse|mice|murine|rat|rats|zebrafish|rodent|animal)\s+models?\b/i;
const SCOPE_BASIC_IN_ANIMALS_RE = /\bin\s+(?:mice|rats|zebrafish)\b/i;
const SCOPE_BASIC_GENETIC_ANIMALS_RE = /\b(?:knockout|knock-out|knockin|knock-in|transgenic|wild-type|wildtype|c57bl(?:\/?6)?|balb\/c|sprague[- ]dawley|wistar)\s+(?:mice|mouse|rats?|murine|zebrafish)\b/i;
const SCOPE_BASIC_TISSUE_RE = /\b(?:neonatal\s+rat\s+ventricular\s+myocytes?|nrvms?|isolated\s+(?:adult\s+|neonatal\s+|mouse\s+|rat\s+|murine\s+)?(?:cardiomyocytes?|myocytes?|hearts?|perfused\s+hearts?)|langendorff(?:[- ]perfused)?|(?:murine|mouse|rat)\s+(?:cardiomyocytes?|myocytes?|hearts?))\b/i;
const SCOPE_BASIC_XENOGRAFT_RE = /\bxenografts?\b/i;
const SCOPE_BASIC_CULTURED_RE = /\bcultured\s+(?:[a-z-]+\s+){0,2}(?:endothelial|cardiomyocyte|cardiomyocytes|myocyte|myocytes|cardiac|vascular\s+smooth\s+muscle)\s+cells?\b|\bcultured\s+(?:cardiomyocytes?|myocytes?)\b|\bprimary\s+(?:mouse|rat|murine|neonatal)\s+(?:cardiomyocytes?|endothelial\s+cells?)\b|\bin\s+(?:vascular\s+)?smooth\s+muscle\s+cells?\b|\b(?:dna\s+targeting|line-1)\b/i;
const SCOPE_BASIC_CRISPR_RE = /\bcrispr(?:-?cas9)?\b/i;
const SCOPE_BASIC_CRISPR_ACTION_RE = /\b(?:knockout|knock-out|deletion|edited|editing)\b/i;
const SCOPE_BASIC_CRISPR_TARGET_RE = /\b(?:cells?|myocytes?|cardiomyocytes?|endothelial|mice|mouse|murine|rats?|zebrafish|in\s+vitro)\b/i;
const SCOPE_IVF_RE = /\bin[- ]vitro\s+fertili[sz]ation\b/gi;
const SCOPE_IN_VITRO_RE = /\bin[- ]vitro\b/i;
const SCOPE_IN_VITRO_CUE_RE = /\b(?:cells?|cardiomyocytes?|myocytes?|endothelial|fibroblasts?|macrophages?|cultured|isolated|knockout|crispr|transfection|proliferation|apoptosis|migration|tube\s+formation|patch[- ]clamp|assay|experiments?)\b/i;

const SCOPE_CLINICAL_TITLE_CUE_RE = /\b(?:patients?|randomi[sz]ed|clinical\s+trial|prospective\s+cohort|retrospective\s+cohort|multicenter|placebo[- ]controlled|double[- ]blind)\b/i;

const SCOPE_CV_JOURNAL_RE = /\b(?:cardiol\w*|cardiovasc\w*|heart|circulation|jacc|europace|stroke|hypertension|arrhythmi\w*|electrophysiolog\w*|atvb)\b/i;
const SCOPE_PORTAL_HTN_RE = /\bportal\s+hypertension\b/gi;
const SCOPE_CV_TEXT_RE = /\b(?:cardiac|cardiovascular|cardiology|cardio[- ]?oncolog\w*|cardiotoxic\w*|cardiomyopath\w*|myocardi\w*|endocardi\w*|pericardi\w*|coronary|atrial\s+fibrillation|afib|arrhythmi\w*|ventricular\s+(?:tachycardia|fibrillation|dysfunction|remodeling|arrhythmia)|tachycardia|bradycardia|pacemaker|defibrillator|catheter\s+ablation|pulmonary\s+vein\s+isolation|electrocardiogra\w*|ecg|ekg|echocardiogra\w*|heart\s+(?:failure|transplant\w*|disease|attack|valve|valvular|injury|toxicity|sarcomas?|myxomas?|tumou?rs?|neoplasms?|metastas[ei]s)|hfref|hfpef|hfmref|(?:atrial|ventricular)\s+(?:sarcomas?|myxomas?|tumou?rs?|neoplasms?|metastas[ei]s)|atrial\s+myxoma|valvular\s+heart|aortic\s+stenosis|mitral\s+regurgitation|tricuspid\s+regurgitation|tavr|tavi|pci|percutaneous\s+coronary|coronary\s+stent\w*|angioplasty|hypertension|hypertensive|antihypertensive|blood\s+pressure|stroke|ischemic\s+attack|anticoagul\w*|atrial\s+appendage|left\s+atrial|right\s+ventricular|left\s+ventricular|ejection\s+fraction|lvef|troponin|natriuretic\s+peptide|nt[- ]?probnp|atheroscleros\w*|atherosclerotic|dyslipidemia|hypercholesterolemi\w*|cholesterol|triglyceride\w*|statin|pcsk9|lp\(a\)|lipoprotein\(a\)|st[- ]segment\s+elevation|aortic\s+aneurysm|aortic\s+dissection|pulmonary\s+artery(?:\s+sarcoma)?|pulmonary\s+hypertension|myocarditis|thromboembol\w*|thrombectomy|basilar\s+artery|deep\s+vein\s+thrombosis|pulmonary\s+embolism)\b|心血管|心律失常|心绞痛|冠状动脉|心肌|心衰|房颤|冠脉|高血压|卒中|心电|心脏/i;

const SCOPE_AI_JOURNAL_RE = /\b(?:nature\s+machine\s+intelligence|openai\s+news|npj\s+artificial\s+intelligence|artificial\s+intelligence|ai\s+agent\s+trends|ijcai|intelligent\s+systems\s+with\s+applications|neural\s+computing\s+and\s+applications|state\s+of\s+generative\s+ai|nature\s+computational\s+science|nejm\s+ai|digital\s+(?:health|medicine)|bmj\s+digital\s+health|lancet\s+digital\s+health|medical\s+informatics|jamia|jmir(?:\s+(?:ai|medical\s+informatics))?|biomedical\s+informatics)\b|AI评论|中国科学[：:]信息科学/i;
const SCOPE_AI_TEXT_RE = /\b(?:artificial\s+intelligence|explainable[\s-]+(?:artificial\s+intelligence|ai)|xai|machine\s+learning|deep\s+learning|reinforcement\s+learning|federated\s+learning|transfer\s+learning|self[- ]supervised|contrastive\s+learning|few[- ]shot|zero[- ]shot|neural\s+networks?|neuro[- ]?symbolic|(?:(?:large|small|vision|multimodal|diffusion|protein|frontier)[\s-]+)?language\s+models?|llms?|vlms?|foundation\s+models?|generative\s+ai|agentic(?:\s+ai)?|multi[- ]?agent|agent\s+architectures?|ai\s+agents?|autonomous\s+agents?|prompt\s+engineering|retrieval[- ]augmented\s+generation|graphrag|chatgpt|gpt-?\d+(?:\.\d+)?|openai|codex|radiomics|computer[- ]aided\s+(?:detection|diagnosis)|natural\s+language\s+processing|nlp|(?:clinical\s+)?decision[- ]support\s+systems?|clinical\s+decision\s+support|digital\s+twins?|ai[- ](?:enabled|assisted|based|guided|driven|powered|ecg|ready|native|generated)|ecg[- ]ai|ml[- ](?:based|model|models|algorithm|algorithms)|llm[- ](?:based|assisted|driven|powered))\b|人工智能|大语言模型|大模型|语言模型|机器学习|深度学习|神经网络|强化学习|智能体|生成式\s*ai/i;
const SCOPE_ML_VOLUME_RE = /\b\d+(?:\.\d+)?\s*[mM][lL]\b/g;
const SCOPE_ML_UPPER_RE = /(?:^|[^A-Za-z0-9_])ML(?:$|[^A-Za-z0-9_])/;
const SCOPE_AI_UPPER_RE = /(?:^|[^A-Za-z0-9_])AI(?:$|[^A-Za-z0-9_])/;
const SCOPE_AROMATASE_RE = /\baromatase\s+inhibitor\b/i;

const SCOPE_CLINICAL_CUE_RE = /\b(?:clinical|medical|medicine|health(?:care)?|hospital\w*|patients?|screening|diagnos\w*|prognos\w*|triage|radiology|pathology|histopatholog\w*|mammogra\w*|dermatolog\w*|documentation|ehr|electronic\s+health\s+records?|discharge|outpatient|inpatient|icu|emergency\s+department|cohort|randomi[sz]ed|trial|prospective|retrospective|oncology|cancer|carcinoma|tumou?r)\b/i;
const SCOPE_MEDICAL_JOURNAL_RE = /\b(?:nejm|n\s+engl\s+j\s+med|lancet|jama|bmj|nature\s+medicine|communications\s+medicine|eclinicalmedicine|annals\s+of\s+internal\s+medicine|digital\s+(?:health|medicine)|medical\s+informatics|biomedical\s+informatics|jamia|jmir|heart|circulation|jacc|europace|stroke|hypertension|cardiol\w*)\b/i;
const SCOPE_AI_MEDICAL_JOURNAL_RE = /\b(?:nejm\s+ai|digital\s+(?:health|medicine)|bmj\s+digital\s+health|lancet\s+digital\s+health|medical\s+informatics|jamia|jmir(?:\s+(?:ai|medical\s+informatics))?|biomedical\s+informatics)\b/i;

const SCOPE_COMPUTATIONAL_OR_DIGITAL_CUE_RE = /\b(?:computational|digital|in\s+silico|algorithm\w*|bioinformatic\w*)\b|智能/i;

const SCOPE_TNF_RE = /\btumou?r\s+necrosis\s+factor(?:-?alpha|-?α)?\b/gi;
const SCOPE_ONCOLOGY_TEXT_RE = /\b(?:cancer\w*|carcinoma\w*|adenocarcinoma\w*|tumou?rs?|oncolog\w*|melanoma\w*|leukemia\w*|leukaemia\w*|lymphoma\w*|sarcoma\w*|myeloma\w*|glioblastoma\w*|glioma\w*|astrocytoma\w*|neuroblastoma\w*|mesothelioma\w*|cholangiocarcinoma\w*|hepatocellular\s+carcinoma|metasta(?:sis|ses|tic)|malignanc(?:y|ies)|neoplas(?:m|ms|tic)|chemotherap\w*|chemoradiotherap\w*|neoadjuvant|adjuvant\s+(?:chemotherapy|radiotherapy|endocrine\s+therapy|tamoxifen|trastuzumab|nivolumab|pembrolizumab)|immune\s+checkpoint\s+inhibitor\w*)\b/i;
const SCOPE_ONCOLOGY_JOURNAL_RE = /\b(?:jama\s+oncology|(?:the\s+)?lancet\s+oncology|nature\s+(?:reviews\s+clinical\s+)?cancer|nature\s+reviews\s+clinical\s+oncology|journal\s+of\s+clinical\s+oncology|annals\s+of\s+oncology|clinical\s+cancer\s+research|cancer\s+discovery|cancer\s+cell|european\s+journal\s+of\s+cancer)\b/i;

const SCOPE_OTHER_SPECIALTY_TEXT_RE = /\b(?:pneumonia|bronchopulmonary\s+dysplasia|asthma|copd|chronic\s+obstructive\s+pulmonary|hearing\s+loss|otitis\s+media|sinusitis|gout|osteoarthritis|psoriasis|atopic\s+dermatitis|eczema|acne|female\s+genital\s+mutilation|endometriosis|polycystic\s+ovary|antidepressants?|psychedelic\s+medicine|inflammatory\s+bowel|crohn.?s\s+disease|ulcerative\s+colitis|celiac\s+disease|appendicitis|glaucoma|cataracts?|macular\s+degeneration|periodontitis|dental\s+caries|alopecia|preterm\s+infants?|intestinal\s+inflammation|ana?esthesiolog\w*|undergraduate\s+medical|medical\s+students?|physical\s+therapy\s+students?)\b/i;

function scopeStr(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function scopeStrList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) if (typeof item === 'string' && item.trim()) out.push(item.trim());
  return out;
}
function scopeMeshList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
    else if (item && typeof item === 'object') {
      const name = scopeStr(item.name) || scopeStr(item.term);
      if (name) out.push(name);
    }
  }
  return out;
}
function scopeBasicCue(text) {
  if (!text) return '';
  if (SCOPE_BASIC_ANIMAL_MODEL_RE.test(text)) return '动物模型';
  if (SCOPE_BASIC_IN_ANIMALS_RE.test(text)) return '小鼠/大鼠实验';
  if (SCOPE_BASIC_GENETIC_ANIMALS_RE.test(text)) return '基因工程/品系实验动物';
  if (SCOPE_BASIC_TISSUE_RE.test(text)) return '离体心肌细胞/器官实验';
  if (SCOPE_BASIC_XENOGRAFT_RE.test(text)) return '异种移植模型';
  if (SCOPE_BASIC_CULTURED_RE.test(text)) return '体外培养细胞实验';
  if (SCOPE_BASIC_CRISPR_RE.test(text) && SCOPE_BASIC_CRISPR_ACTION_RE.test(text) && SCOPE_BASIC_CRISPR_TARGET_RE.test(text)) return '细胞/动物CRISPR敲除实验';
  const ivClean = text.replace(SCOPE_IVF_RE, ' ');
  if (SCOPE_IN_VITRO_RE.test(ivClean) && SCOPE_IN_VITRO_CUE_RE.test(ivClean)) return '体外细胞实验';
  return '';
}
function scopeHasAiCue(text) {
  if (!text) return false;
  if (SCOPE_AI_TEXT_RE.test(text)) return true;
  if (SCOPE_ML_UPPER_RE.test(text.replace(SCOPE_ML_VOLUME_RE, ' '))) return true;
  if (!SCOPE_AROMATASE_RE.test(text) && SCOPE_AI_UPPER_RE.test(text)) return true;
  return false;
}
function scopeResult(action, reason = null, detail = '') {
  return {action,reason,detail};
}
function scopeDecision(paper) {
  if (!paper || typeof paper !== 'object' || Array.isArray(paper)) return scopeResult('keep');
  const title = scopeStr(paper.title);
  const journal = scopeStr(paper.cleanJournal) || scopeStr(paper.journal);
  const rawJournal = scopeStr(paper.journal);
  const journalText = rawJournal && rawJournal !== journal ? (journal + ' ' + rawJournal).trim() : journal;
  const summary = scopeStr(paper.summary) || scopeStr(paper.abstract) || scopeStr(paper.abstractText);
  const category = scopeStr(paper.category);
  const clinicalTier = scopeStr(paper.clinicalTier);
  const studyDesign = scopeStr(paper.studyDesign);
  const tags = new Set(scopeStrList(paper.tags));
  const pubTypes = new Set(scopeStrList(paper.pubTypes).map(t => t.toLowerCase()));
  const meshTerms = scopeMeshList(paper.meshTerms);
  const combined = (title + ' ' + summary).trim();

  // 1) High-confidence not_article (TOC / supplement)
  if (title && (SCOPE_NOT_ARTICLE_TOC_RE.test(title) || SCOPE_NOT_ARTICLE_SUPPLEMENT_RE.test(title))) {
    return scopeResult('exclude', 'not_article', '期刊目录或补充材料非正文，判为非文献');
  }

  // 2) General AI / frontier-tech / any clear AI signal (before basic-research and oncology exclude)
  if (SCOPE_AI_CATEGORIES.has(category)
    || SCOPE_AI_TIERS.has(clinicalTier)
    || [...tags].some(t => SCOPE_AI_TAGS.has(t))
    || SCOPE_AI_JOURNAL_RE.test(journalText)
    || scopeHasAiCue(combined)) {
    return scopeResult('keep');
  }

  // 3) Explicit pure basic research (no AI signal from step 2)
  const hasAnimalMesh = meshTerms.some(term => SCOPE_MESH_ANIMAL_RE.test(term));
  const hasHumanMesh = meshTerms.some(term => SCOPE_MESH_HUMAN_RE.test(term));
  if (hasAnimalMesh && !hasHumanMesh) return scopeResult('exclude', 'basic_research', 'MeSH含动物模型词且无Humans，判为基础研究');

  if (!(hasAnimalMesh && hasHumanMesh)) {
    const titleBasic = scopeBasicCue(title);
    if (titleBasic) return scopeResult('exclude', 'basic_research', '标题含' + titleBasic + '，判为基础研究');

    const hasClinicalCounterCue = hasHumanMesh
      || SCOPE_CLINICAL_DESIGNS.has(studyDesign)
      || [...pubTypes].some(t => SCOPE_CLINICAL_PUB_TYPES.has(t))
      || SCOPE_CLINICAL_TITLE_CUE_RE.test(title);
    const summaryBasic = scopeBasicCue(summary);
    if (summaryBasic && !hasClinicalCounterCue) return scopeResult('exclude', 'basic_research', '摘要含' + summaryBasic + '，判为基础研究');
  }

  // 4) Cardiovascular signals
  const cvText = combined.replace(SCOPE_PORTAL_HTN_RE, ' ');
  const hasCv = SCOPE_CV_CATEGORIES.has(category)
    || SCOPE_CV_TIERS.has(clinicalTier)
    || [...tags].some(t => SCOPE_CV_TAGS.has(t))
    || SCOPE_CV_JOURNAL_RE.test(journalText)
    || SCOPE_CV_TEXT_RE.test(cvText);
  if (hasCv) return scopeResult('keep');

  // 5) Medical-AI fields backstop
  const hasClinicalContext = SCOPE_CLINICAL_CUE_RE.test(combined) || SCOPE_MEDICAL_JOURNAL_RE.test(journalText);
  const hasMedicalAi = SCOPE_AI_MEDICAL_CATEGORIES.has(category)
    || clinicalTier === SCOPE_AI_MEDICAL_TIER
    || tags.has('#AI-ECG')
    || (tags.has('#大模型/NLP') && hasClinicalContext)
    || SCOPE_AI_MEDICAL_JOURNAL_RE.test(journalText)
    || (scopeHasAiCue(combined) && hasClinicalContext);
  if (hasMedicalAi) return scopeResult('keep');

  // 6) High-confidence oncology without CV/AI (guard digital/computational cues)
  if (!SCOPE_COMPUTATIONAL_OR_DIGITAL_CUE_RE.test(combined)) {
    const oncologyText = combined.replace(SCOPE_TNF_RE, ' ');
    if (SCOPE_ONCOLOGY_TEXT_RE.test(oncologyText)) return scopeResult('exclude', 'unrelated_to_cv_or_medical_ai', '含肿瘤学主题且无心血管或AI医疗线索，判为不相关');
    if (SCOPE_ONCOLOGY_JOURNAL_RE.test(journalText)) return scopeResult('exclude', 'unrelated_to_cv_or_medical_ai', '肿瘤学期刊且标题摘要无心血管或AI医疗线索，判为不相关');

    // 7) High-confidence other-specialty clinical without CV/AI
    if (SCOPE_OTHER_SPECIALTY_TEXT_RE.test(combined)) return scopeResult('exclude', 'unrelated_to_cv_or_medical_ai', '明确其他专科主题且无心血管或AI医疗线索，判为不相关');
  }

  // 8) Incomplete metadata stays conservative keep; otherwise uncertain
  if (!title || !journal) return scopeResult('keep');
  return scopeResult('uncertain', 'uncertain_scope', '主题尚不明确，保留待人工判断，不自动机器领取');
}
