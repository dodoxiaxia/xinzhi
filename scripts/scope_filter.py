#!/usr/bin/env python3
"""Shared scope decision for intake and dispatch:
- keep: cardiovascular clinical, medical AI, and general AI / frontier tech
- exclude: high-confidence non-article (TOC/supplement), pure basic research,
  or clearly unrelated oncology / other-specialty clinical papers
- uncertain: ambiguous / general clinical papers kept at intake, skipped at machine claim."""
import json
from pathlib import Path
import re

SCOPE_KEEPS_PATH = Path(__file__).resolve().parents[1] / 'config/public_library_scope_keeps.json'
_DOI_PREFIX_RE = re.compile(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', re.I)
_KEEPS_CACHE = {}

CV_CATEGORIES = {'心血管', '交叉研究'}
AI_CATEGORIES = {'AI医疗', '交叉研究', 'AI前沿'}
AI_MEDICAL_CATEGORIES = {'AI医疗', '交叉研究'}
CV_TIERS = {
    '心血管旗舰顶刊', '心律失常与电生理', '心衰与重症心肌', '冠脉介入与结构',
    '心血管影像与表型', '脑血管与高血压', '心血管综合与其他', '定向专病与团队',
}
AI_TIERS = {'前沿大模型与科技', 'AI医疗与数字医学'}
AI_MEDICAL_TIER = 'AI医疗与数字医学'
CV_TAGS = {'#房颤/电生理', '#心衰/心肌', '#心电', '#AI-ECG', '#卒中/抗凝', '#高血压/血管', '#冠脉介入'}
AI_TAGS = {'#大模型/NLP', '#AI-ECG'}
CLINICAL_DESIGNS = {'RCT', '队列研究', '病例对照研究', '横断面研究', 'RCT 二次分析', '指南共识'}
CLINICAL_PUB_TYPES = {
    'randomized controlled trial', 'clinical trial', 'multicenter study',
    'observational study', 'practice guideline', 'guideline',
}

NOT_ARTICLE_TOC_RE = re.compile(
    r'^(?:\[[^\]]+\]\s*)?(?:(?:issue|table\s+of)\s+)?contents\s*[:.]?\s*$|'
    r'^[\u4e00-\u9fff()（）《》·\s]{2,40}?\s*\d{4}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?\s*第\s*\d+\s*卷\s*第\s*\d+\s*期(?:\s*目录)?\s*$',
    re.I,
)
NOT_ARTICLE_SUPPLEMENT_RE = re.compile(
    r'(?:^|[^a-z0-9])moesm\d*(?:_esm)?(?:$|[^a-z0-9])|'
    r'^\d+(?:_\d+)+_esm(?:\.[a-z0-9]+)?$|'
    r'\bsupplemental\s+online\s+content\b',
    re.I,
)

MESH_ANIMAL_RE = re.compile(r'\b(?:mice|rats|animals|zebrafish)\b', re.I)
MESH_HUMAN_RE = re.compile(r'\bhumans\b', re.I)

BASIC_ANIMAL_MODEL_RE = re.compile(r'\b(?:mouse|mice|murine|rat|rats|zebrafish|rodent|animal)\s+models?\b', re.I)
BASIC_IN_ANIMALS_RE = re.compile(r'\bin\s+(?:mice|rats|zebrafish)\b', re.I)
BASIC_GENETIC_ANIMALS_RE = re.compile(
    r'\b(?:knockout|knock-out|knockin|knock-in|transgenic|wild-type|wildtype|c57bl(?:/?6)?|balb/c|sprague[- ]dawley|wistar)\s+(?:mice|mouse|rats?|murine|zebrafish)\b',
    re.I,
)
BASIC_TISSUE_RE = re.compile(
    r'\b(?:neonatal\s+rat\s+ventricular\s+myocytes?|nrvms?|'
    r'isolated\s+(?:adult\s+|neonatal\s+|mouse\s+|rat\s+|murine\s+)?(?:cardiomyocytes?|myocytes?|hearts?|perfused\s+hearts?)|'
    r'langendorff(?:[- ]perfused)?|'
    r'(?:murine|mouse|rat)\s+(?:cardiomyocytes?|myocytes?|hearts?))\b',
    re.I,
)
BASIC_XENOGRAFT_RE = re.compile(r'\bxenografts?\b', re.I)
BASIC_CULTURED_RE = re.compile(
    r'\bcultured\s+(?:[a-z-]+\s+){0,2}(?:endothelial|cardiomyocyte|cardiomyocytes|myocyte|myocytes|cardiac|vascular\s+smooth\s+muscle)\s+cells?\b|'
    r'\bcultured\s+(?:cardiomyocytes?|myocytes?)\b|'
    r'\bprimary\s+(?:mouse|rat|murine|neonatal)\s+(?:cardiomyocytes?|endothelial\s+cells?)\b|'
    r'\bin\s+(?:vascular\s+)?smooth\s+muscle\s+cells?\b|'
    r'\b(?:dna\s+targeting|line-1)\b',
    re.I,
)
BASIC_CRISPR_RE = re.compile(r'\bcrispr(?:-?cas9)?\b', re.I)
BASIC_CRISPR_ACTION_RE = re.compile(r'\b(?:knockout|knock-out|deletion|edited|editing)\b', re.I)
BASIC_CRISPR_TARGET_RE = re.compile(r'\b(?:cells?|myocytes?|cardiomyocytes?|endothelial|mice|mouse|murine|rats?|zebrafish|in\s+vitro)\b', re.I)
IVF_RE = re.compile(r'\bin[- ]vitro\s+fertili[sz]ation\b', re.I)
IN_VITRO_RE = re.compile(r'\bin[- ]vitro\b', re.I)
IN_VITRO_CUE_RE = re.compile(
    r'\b(?:cells?|cardiomyocytes?|myocytes?|endothelial|fibroblasts?|macrophages?|cultured|isolated|knockout|crispr|transfection|proliferation|apoptosis|migration|tube\s+formation|patch[- ]clamp|assay|experiments?)\b',
    re.I,
)

CLINICAL_TITLE_CUE_RE = re.compile(
    r'\b(?:patients?|randomi[sz]ed|clinical\s+trial|prospective\s+cohort|retrospective\s+cohort|multicenter|placebo[- ]controlled|double[- ]blind)\b',
    re.I,
)

CV_JOURNAL_RE = re.compile(
    r'\b(?:cardiol\w*|cardiovasc\w*|heart|circulation|jacc|europace|stroke|hypertension|arrhythmi\w*|electrophysiolog\w*|atvb)\b',
    re.I,
)
PORTAL_HTN_RE = re.compile(r'\bportal\s+hypertension\b', re.I)
CV_TEXT_RE = re.compile(
    r'\b(?:cardiac|cardiovascular|cardiology|cardio[- ]?oncolog\w*|cardiotoxic\w*|cardiomyopath\w*|myocardi\w*|endocardi\w*|pericardi\w*|'
    r'coronary|atrial\s+fibrillation|afib|arrhythmi\w*|ventricular\s+(?:tachycardia|fibrillation|dysfunction|remodeling|arrhythmia)|'
    r'tachycardia|bradycardia|pacemaker|defibrillator|catheter\s+ablation|pulmonary\s+vein\s+isolation|electrocardiogra\w*|ecg|ekg|echocardiogra\w*|'
    r'heart\s+(?:failure|transplant\w*|disease|attack|valve|valvular|injury|toxicity|sarcomas?|myxomas?|tumou?rs?|neoplasms?|metastas[ei]s)|hfref|hfpef|hfmref|'
    r'(?:atrial|ventricular)\s+(?:sarcomas?|myxomas?|tumou?rs?|neoplasms?|metastas[ei]s)|atrial\s+myxoma|'
    r'valvular\s+heart|aortic\s+stenosis|mitral\s+regurgitation|tricuspid\s+regurgitation|tavr|tavi|pci|percutaneous\s+coronary|'
    r'coronary\s+stent\w*|angioplasty|hypertension|hypertensive|antihypertensive|blood\s+pressure|stroke|ischemic\s+attack|anticoagul\w*|'
    r'atrial\s+appendage|left\s+atrial|right\s+ventricular|left\s+ventricular|ejection\s+fraction|lvef|troponin|'
    r'natriuretic\s+peptide|nt[- ]?probnp|atheroscleros\w*|atherosclerotic|dyslipidemia|hypercholesterolemi\w*|cholesterol|triglyceride\w*|'
    r'statin|pcsk9|lp\(a\)|lipoprotein\(a\)|st[- ]segment\s+elevation|aortic\s+aneurysm|aortic\s+dissection|'
    r'pulmonary\s+artery(?:\s+sarcoma)?|pulmonary\s+hypertension|myocarditis|thromboembol\w*|thrombectomy|basilar\s+artery|'
    r'deep\s+vein\s+thrombosis|pulmonary\s+embolism)\b|'
    r'心血管|心律失常|心绞痛|冠状动脉|心肌|心衰|房颤|冠脉|高血压|卒中|心电|心脏',
    re.I,
)

AI_JOURNAL_RE = re.compile(
    r'\b(?:nature\s+machine\s+intelligence|openai\s+news|npj\s+artificial\s+intelligence|artificial\s+intelligence|'
    r'ai\s+agent\s+trends|ijcai|intelligent\s+systems\s+with\s+applications|neural\s+computing\s+and\s+applications|'
    r'state\s+of\s+generative\s+ai|nature\s+computational\s+science|'
    r'nejm\s+ai|digital\s+(?:health|medicine)|bmj\s+digital\s+health|lancet\s+digital\s+health|'
    r'medical\s+informatics|jamia|jmir(?:\s+(?:ai|medical\s+informatics))?|biomedical\s+informatics)\b|'
    r'AI评论|中国科学[：:]信息科学',
    re.I,
)
AI_TEXT_RE = re.compile(
    r'\b(?:artificial\s+intelligence|explainable[\s-]+(?:artificial\s+intelligence|ai)|xai|'
    r'machine\s+learning|deep\s+learning|reinforcement\s+learning|federated\s+learning|transfer\s+learning|'
    r'self[- ]supervised|contrastive\s+learning|few[- ]shot|zero[- ]shot|neural\s+networks?|neuro[- ]?symbolic|'
    r'(?:(?:large|small|vision|multimodal|diffusion|protein|frontier)[\s-]+)?language\s+models?|llms?|vlms?|'
    r'foundation\s+models?|generative\s+ai|agentic(?:\s+ai)?|multi[- ]?agent|agent\s+architectures?|ai\s+agents?|autonomous\s+agents?|'
    r'prompt\s+engineering|retrieval[- ]augmented\s+generation|graphrag|chatgpt|gpt-?\d+(?:\.\d+)?|openai|codex|'
    r'radiomics|computer[- ]aided\s+(?:detection|diagnosis)|natural\s+language\s+processing|nlp|'
    r'(?:clinical\s+)?decision[- ]support\s+systems?|clinical\s+decision\s+support|digital\s+twins?|'
    r'ai[- ](?:enabled|assisted|based|guided|driven|powered|ecg|ready|native|generated)|'
    r'ecg[- ]ai|ml[- ](?:based|model|models|algorithm|algorithms)|llm[- ](?:based|assisted|driven|powered))\b|'
    r'人工智能|大语言模型|大模型|语言模型|机器学习|深度学习|神经网络|强化学习|智能体|生成式\s*ai',
    re.I,
)
ML_VOLUME_RE = re.compile(r'\b\d+(?:\.\d+)?\s*[mM][lL]\b')
ML_UPPER_RE = re.compile(r'(?:^|[^A-Za-z0-9_])ML(?:$|[^A-Za-z0-9_])')
AI_UPPER_RE = re.compile(r'(?:^|[^A-Za-z0-9_])AI(?:$|[^A-Za-z0-9_])')
AROMATASE_RE = re.compile(r'\baromatase\s+inhibitor\b', re.I)

CLINICAL_CUE_RE = re.compile(
    r'\b(?:clinical|medical|medicine|health(?:care)?|hospital\w*|patients?|screening|diagnos\w*|prognos\w*|triage|'
    r'radiology|pathology|histopatholog\w*|mammogra\w*|dermatolog\w*|documentation|ehr|electronic\s+health\s+records?|'
    r'discharge|outpatient|inpatient|icu|emergency\s+department|cohort|randomi[sz]ed|trial|prospective|retrospective|'
    r'oncology|cancer|carcinoma|tumou?r)\b',
    re.I,
)
MEDICAL_JOURNAL_RE = re.compile(
    r'\b(?:nejm|n\s+engl\s+j\s+med|lancet|jama|bmj|nature\s+medicine|communications\s+medicine|eclinicalmedicine|'
    r'annals\s+of\s+internal\s+medicine|digital\s+(?:health|medicine)|medical\s+informatics|biomedical\s+informatics|'
    r'jamia|jmir|heart|circulation|jacc|europace|stroke|hypertension|cardiol\w*)\b',
    re.I,
)
AI_MEDICAL_JOURNAL_RE = re.compile(
    r'\b(?:nejm\s+ai|digital\s+(?:health|medicine)|bmj\s+digital\s+health|lancet\s+digital\s+health|'
    r'medical\s+informatics|jamia|jmir(?:\s+(?:ai|medical\s+informatics))?|biomedical\s+informatics)\b',
    re.I,
)

COMPUTATIONAL_OR_DIGITAL_CUE_RE = re.compile(
    r'\b(?:computational|digital|in\s+silico|algorithm\w*|bioinformatic\w*)\b|智能',
    re.I,
)

TNF_RE = re.compile(r'\btumou?r\s+necrosis\s+factor(?:-?alpha|-?α)?\b', re.I)
ONCOLOGY_TEXT_RE = re.compile(
    r'\b(?:cancer\w*|carcinoma\w*|adenocarcinoma\w*|tumou?rs?|oncolog\w*|melanoma\w*|leukemia\w*|leukaemia\w*|'
    r'lymphoma\w*|sarcoma\w*|myeloma\w*|glioblastoma\w*|glioma\w*|astrocytoma\w*|neuroblastoma\w*|mesothelioma\w*|'
    r'cholangiocarcinoma\w*|hepatocellular\s+carcinoma|metasta(?:sis|ses|tic)|malignanc(?:y|ies)|neoplas(?:m|ms|tic)|'
    r'chemotherap\w*|chemoradiotherap\w*|neoadjuvant|adjuvant\s+(?:chemotherapy|radiotherapy|endocrine\s+therapy|tamoxifen|trastuzumab|nivolumab|pembrolizumab)|'
    r'immune\s+checkpoint\s+inhibitor\w*)\b',
    re.I,
)
ONCOLOGY_JOURNAL_RE = re.compile(
    r'\b(?:jama\s+oncology|(?:the\s+)?lancet\s+oncology|nature\s+(?:reviews\s+clinical\s+)?cancer|nature\s+reviews\s+clinical\s+oncology|'
    r'journal\s+of\s+clinical\s+oncology|annals\s+of\s+oncology|clinical\s+cancer\s+research|cancer\s+discovery|cancer\s+cell|european\s+journal\s+of\s+cancer)\b',
    re.I,
)

OTHER_SPECIALTY_TEXT_RE = re.compile(
    r'\b(?:pneumonia|bronchopulmonary\s+dysplasia|asthma|copd|chronic\s+obstructive\s+pulmonary|'
    r'hearing\s+loss|otitis\s+media|sinusitis|'
    r'gout|osteoarthritis|psoriasis|atopic\s+dermatitis|eczema|acne|'
    r'female\s+genital\s+mutilation|endometriosis|polycystic\s+ovary|'
    r'antidepressants?|psychedelic\s+medicine|'
    r'inflammatory\s+bowel|crohn.?s\s+disease|ulcerative\s+colitis|celiac\s+disease|appendicitis|'
    r'glaucoma|cataracts?|macular\s+degeneration|periodontitis|dental\s+caries|alopecia|'
    r'preterm\s+infants?|intestinal\s+inflammation|ana?esthesiolog\w*|'
    r'undergraduate\s+medical|medical\s+students?|physical\s+therapy\s+students?)\b',
    re.I,
)


def _str(value):
    return value.strip() if isinstance(value, str) else ''


def _str_list(value):
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
    return out


def _mesh_list(value):
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif isinstance(item, dict):
            name = _str(item.get('name')) or _str(item.get('term'))
            if name:
                out.append(name)
    return out


def _basic_cue(text):
    if not text:
        return ''
    if BASIC_ANIMAL_MODEL_RE.search(text):
        return '动物模型'
    if BASIC_IN_ANIMALS_RE.search(text):
        return '小鼠/大鼠实验'
    if BASIC_GENETIC_ANIMALS_RE.search(text):
        return '基因工程/品系实验动物'
    if BASIC_TISSUE_RE.search(text):
        return '离体心肌细胞/器官实验'
    if BASIC_XENOGRAFT_RE.search(text):
        return '异种移植模型'
    if BASIC_CULTURED_RE.search(text):
        return '体外培养细胞实验'
    if BASIC_CRISPR_RE.search(text) and BASIC_CRISPR_ACTION_RE.search(text) and BASIC_CRISPR_TARGET_RE.search(text):
        return '细胞/动物CRISPR敲除实验'
    iv_clean = IVF_RE.sub(' ', text)
    if IN_VITRO_RE.search(iv_clean) and IN_VITRO_CUE_RE.search(iv_clean):
        return '体外细胞实验'
    return ''


def _has_ai_cue(text):
    if not text:
        return False
    if AI_TEXT_RE.search(text):
        return True
    if ML_UPPER_RE.search(ML_VOLUME_RE.sub(' ', text)):
        return True
    if not AROMATASE_RE.search(text) and AI_UPPER_RE.search(text):
        return True
    return False


def normalize_scope_doi(value):
    if not isinstance(value, str):
        return ''
    return _DOI_PREFIX_RE.sub('', value.strip()).lower()


def load_scope_keep_dois(path=SCOPE_KEEPS_PATH):
    target = Path(path)
    try:
        stat = target.stat()
    except FileNotFoundError:
        return frozenset()
    except OSError as exc:
        raise ValueError(f'Failed to load scope keeps config {target}: {exc}') from exc
    cache_key = (str(target), stat.st_mtime_ns, stat.st_size)
    cached = _KEEPS_CACHE.get(cache_key)
    if cached is not None:
        return cached
    try:
        raw = json.loads(target.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return frozenset()
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f'Failed to load scope keeps config {target}: {exc}') from exc
    if not isinstance(raw, dict) or not isinstance(raw.get('dois'), list):
        raise ValueError(f'Malformed scope keeps config {target}: expected object with dois list')
    dois = set()
    for item in raw['dois']:
        if not isinstance(item, str):
            raise ValueError(f'Malformed scope keep DOI in {target}: expected string')
        doi = normalize_scope_doi(item)
        if doi:
            dois.add(doi)
    result = frozenset(dois)
    _KEEPS_CACHE[cache_key] = result
    return result


def _resolve_keep_dois(keep_dois=None, keeps_path=None):
    if keep_dois is not None:
        return frozenset(d for d in (normalize_scope_doi(v) for v in keep_dois) if d)
    return load_scope_keep_dois(SCOPE_KEEPS_PATH if keeps_path is None else keeps_path)


def _decision(action, reason=None, detail=''):
    return {'action': action, 'reason': reason, 'detail': detail}


def scope_decision(paper, *, keep_dois=None, keeps_path=None):
    if not isinstance(paper, dict):
        return _decision('keep')

    # Manual force-keep by DOI overrides all automated rules (including not_article).
    doi = normalize_scope_doi(paper.get('doi'))
    if doi and doi in _resolve_keep_dois(keep_dois=keep_dois, keeps_path=keeps_path):
        return _decision('keep', 'forced_keep', '按 DOI 人工放行，优先于自动范围判定')

    title = _str(paper.get('title'))
    journal = _str(paper.get('cleanJournal')) or _str(paper.get('journal'))
    raw_journal = _str(paper.get('journal'))
    journal_text = (journal + ' ' + raw_journal).strip() if raw_journal and raw_journal != journal else journal
    summary = _str(paper.get('summary')) or _str(paper.get('abstract')) or _str(paper.get('abstractText'))
    category = _str(paper.get('category'))
    clinical_tier = _str(paper.get('clinicalTier'))
    study_design = _str(paper.get('studyDesign'))
    tags = set(_str_list(paper.get('tags')))
    pub_types = {t.lower() for t in _str_list(paper.get('pubTypes'))}
    mesh_terms = _mesh_list(paper.get('meshTerms'))
    combined = (title + ' ' + summary).strip()

    # 1) High-confidence not_article (TOC / supplement)
    if title and (NOT_ARTICLE_TOC_RE.search(title) or NOT_ARTICLE_SUPPLEMENT_RE.search(title)):
        return _decision('exclude', 'not_article', '期刊目录或补充材料非正文，判为非文献')

    # 2) General AI / frontier-tech / any clear AI signal (before basic-research and oncology exclude)
    if (
        category in AI_CATEGORIES
        or clinical_tier in AI_TIERS
        or bool(tags & AI_TAGS)
        or bool(AI_JOURNAL_RE.search(journal_text))
        or _has_ai_cue(combined)
    ):
        return _decision('keep')

    # 3) Explicit pure basic research (no AI signal from step 2)
    has_animal_mesh = any(MESH_ANIMAL_RE.search(term) for term in mesh_terms)
    has_human_mesh = any(MESH_HUMAN_RE.search(term) for term in mesh_terms)
    if has_animal_mesh and not has_human_mesh:
        return _decision('exclude', 'basic_research', 'MeSH含动物模型词且无Humans，判为基础研究')

    if not (has_animal_mesh and has_human_mesh):
        title_basic = _basic_cue(title)
        if title_basic:
            return _decision('exclude', 'basic_research', f'标题含{title_basic}，判为基础研究')

        has_clinical_counter_cue = (
            has_human_mesh
            or study_design in CLINICAL_DESIGNS
            or bool(pub_types & CLINICAL_PUB_TYPES)
            or bool(CLINICAL_TITLE_CUE_RE.search(title))
        )
        summary_basic = _basic_cue(summary)
        if summary_basic and not has_clinical_counter_cue:
            return _decision('exclude', 'basic_research', f'摘要含{summary_basic}，判为基础研究')

    # 4) Cardiovascular signals
    cv_text = PORTAL_HTN_RE.sub(' ', combined)
    has_cv = (
        category in CV_CATEGORIES
        or clinical_tier in CV_TIERS
        or bool(tags & CV_TAGS)
        or bool(CV_JOURNAL_RE.search(journal_text))
        or bool(CV_TEXT_RE.search(cv_text))
    )
    if has_cv:
        return _decision('keep')

    # 5) Medical-AI fields backstop
    has_clinical_context = bool(CLINICAL_CUE_RE.search(combined)) or bool(MEDICAL_JOURNAL_RE.search(journal_text))
    has_medical_ai = (
        category in AI_MEDICAL_CATEGORIES
        or clinical_tier == AI_MEDICAL_TIER
        or '#AI-ECG' in tags
        or ('#大模型/NLP' in tags and has_clinical_context)
        or bool(AI_MEDICAL_JOURNAL_RE.search(journal_text))
        or (_has_ai_cue(combined) and has_clinical_context)
    )
    if has_medical_ai:
        return _decision('keep')

    # 6) High-confidence oncology without CV/AI (guard digital/computational cues)
    if not COMPUTATIONAL_OR_DIGITAL_CUE_RE.search(combined):
        oncology_text = TNF_RE.sub(' ', combined)
        if ONCOLOGY_TEXT_RE.search(oncology_text):
            return _decision('exclude', 'unrelated_to_cv_or_medical_ai', '含肿瘤学主题且无心血管或AI医疗线索，判为不相关')
        if ONCOLOGY_JOURNAL_RE.search(journal_text):
            return _decision('exclude', 'unrelated_to_cv_or_medical_ai', '肿瘤学期刊且标题摘要无心血管或AI医疗线索，判为不相关')

        # 7) High-confidence other-specialty clinical without CV/AI
        if OTHER_SPECIALTY_TEXT_RE.search(combined):
            return _decision('exclude', 'unrelated_to_cv_or_medical_ai', '明确其他专科主题且无心血管或AI医疗线索，判为不相关')

    # 8) Incomplete metadata stays conservative keep; otherwise uncertain
    if not title or not journal:
        return _decision('keep')
    return _decision('uncertain', 'uncertain_scope', '主题尚不明确，保留待人工判断，不自动机器领取')
