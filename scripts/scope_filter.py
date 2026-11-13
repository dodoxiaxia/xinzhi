#!/usr/bin/env python3
"""Shared scope decision for intake and dispatch: exclude clear basic research
and clearly unrelated non-CV/non-medical-AI papers; keep uncertain cases."""
import re

CV_CATEGORIES = {'心血管', '交叉研究'}
AI_MEDICAL_CATEGORIES = {'AI医疗', '交叉研究'}
CV_TIERS = {
    '心血管旗舰顶刊', '心律失常与电生理', '心衰与重症心肌', '冠脉介入与结构',
    '心血管影像与表型', '脑血管与高血压', '心血管综合与其他', '定向专病与团队',
}
AI_MEDICAL_TIER = 'AI医疗与数字医学'
CV_TAGS = {'#房颤/电生理', '#心衰/心肌', '#心电', '#AI-ECG', '#卒中/抗凝', '#高血压/血管', '#冠脉介入'}
CLINICAL_DESIGNS = {'RCT', '队列研究', '病例对照研究', '横断面研究', 'RCT 二次分析', '指南共识'}
CLINICAL_PUB_TYPES = {
    'randomized controlled trial', 'clinical trial', 'multicenter study',
    'observational study', 'practice guideline', 'guideline',
}

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
    r'\bprimary\s+(?:mouse|rat|murine|neonatal)\s+(?:cardiomyocytes?|endothelial\s+cells?)\b',
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
    r'bradycardia|pacemaker|defibrillator|catheter\s+ablation|pulmonary\s+vein\s+isolation|electrocardiogra\w*|ecg|ekg|echocardiogra\w*|'
    r'heart\s+(?:failure|transplant\w*|disease|attack|valve|valvular|injury|toxicity)|hfref|hfpef|hfmref|'
    r'valvular\s+heart|aortic\s+stenosis|mitral\s+regurgitation|tricuspid\s+regurgitation|tavr|tavi|pci|percutaneous\s+coronary|'
    r'coronary\s+stent\w*|angioplasty|hypertension|antihypertensive|blood\s+pressure|stroke|ischemic\s+attack|anticoagul\w*|'
    r'atrial\s+appendage|left\s+atrial|right\s+ventricular|left\s+ventricular|ejection\s+fraction|lvef|troponin|'
    r'natriuretic\s+peptide|nt[- ]?probnp|atheroscleros\w*|dyslipidemia|statin|pcsk9|aortic\s+aneurysm|aortic\s+dissection|'
    r'pulmonary\s+hypertension|myocarditis|thromboembol\w*|deep\s+vein\s+thrombosis|pulmonary\s+embolism)\b',
    re.I,
)

AI_TEXT_RE = re.compile(
    r'\b(?:artificial\s+intelligence|machine\s+learning|deep\s+learning|neural\s+networks?|large\s+language\s+models?|llms?|'
    r'foundation\s+models?|generative\s+ai|chatgpt|gpt-?4|radiomics|computer[- ]aided\s+(?:detection|diagnosis)|'
    r'natural\s+language\s+processing|clinical\s+decision\s+support|ai[- ](?:enabled|assisted|based|guided|driven|powered|ecg)|'
    r'ecg[- ]ai|ml[- ](?:based|model|models|algorithm|algorithms))\b',
    re.I,
)
ML_VOLUME_RE = re.compile(r'\b\d+(?:\.\d+)?\s*[mM][lL]\b')
ML_UPPER_RE = re.compile(r'\bML\b')
AI_UPPER_RE = re.compile(r'\bAI\b')
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
    r'\b(?:nejm\s+ai|digital\s+(?:health|medicine)|medical\s+informatics|jamia|jmir\s+(?:ai|medical\s+informatics)|biomedical\s+informatics)\b',
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


def _decision(action, reason=None, detail=''):
    return {'action': action, 'reason': reason, 'detail': detail}


def scope_decision(paper):
    if not isinstance(paper, dict):
        return _decision('keep')

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

    has_animal_mesh = any(MESH_ANIMAL_RE.search(term) for term in mesh_terms)
    has_human_mesh = any(MESH_HUMAN_RE.search(term) for term in mesh_terms)
    if has_animal_mesh and not has_human_mesh:
        return _decision('exclude', 'basic_research', 'MeSH含动物模型词且无Humans，判为基础研究')
    if has_animal_mesh and has_human_mesh:
        return _decision('keep', None, 'MeSH同时含Humans与动物词，按转化医学保留')

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

    combined = (title + ' ' + summary).strip()
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

    oncology_text = TNF_RE.sub(' ', combined)
    if ONCOLOGY_TEXT_RE.search(oncology_text):
        return _decision('exclude', 'unrelated_to_cv_or_medical_ai', '含肿瘤学主题且无心血管或AI医疗线索，判为不相关')
    if ONCOLOGY_JOURNAL_RE.search(journal_text):
        return _decision('exclude', 'unrelated_to_cv_or_medical_ai', '肿瘤学期刊且标题摘要无心血管或AI医疗线索，判为不相关')

    return _decision('keep')
