#!/usr/bin/env python3
"""Enrich candidate and library metadata with publishers, normalized journals,
source groups, tentative study-design tags and extractable source metadata.
Paper-specific interpretation belongs only to source-checked editorial content.
"""
import datetime, json, re, unicodedata
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]

# Known journal aliases only: preserve the raw `journal` field as provenance.
def _journal_key(journal):
    text = unicodedata.normalize('NFKC', journal or '').casefold().strip()
    return re.sub(r'\s+', ' ', re.sub(r'[:.\-–—]+', ' ', text)).strip()


_JOURNAL_GROUPS = {
    'New England Journal of Medicine': ['NEJM', 'N Engl J Med', 'The New England journal of medicine'],
    'NEJM AI': [], 'NEJM Evidence': ['NEJM Evid'], 'NEJM Catalyst': [],
    'JAMA': ['JAMA Online First', 'JAMA Current Issue'],
    'JAMA Internal Medicine': ['JAMA IM Current Issue', 'JAMA IM Online First'],
    'JAMA Network Open': ['JAMA Network Open New Online', 'JAMA Network Open Most Read'],
    'JAMA Cardiology': ['JAMA Cardiology Current Issue', 'JAMA Cardiology Online First', 'JAMA: Cardiology Topic Collection'],
    'Journal of the American Heart Association': ['JAHA'],
    'Circulation': [], 'Circulation Research': [],
    'Circulation: Cardiovascular Interventions': ['Circ: Cardiovascular Interventions', 'Circulation: Interventions'],
    'Circulation: Cardiovascular Imaging': ['Circ CV Imaging', 'Circulation: Imaging'],
    'Circulation: Heart Failure': ['Circ Heart Failure'],
    'Circulation: Arrhythmia and Electrophysiology': ['Circulation: AE', 'Circ: AE', 'Circulation: Arrhythmia & EP'],
    'Circulation: Genomic and Precision Medicine': ['Circ Genomic and Precision Medicine', 'Circulation: Genomic Med'],
    'Circulation: Cardiovascular Quality and Outcomes': ['Circulation: CQO', 'Circulation: Outcomes'],
    'Arteriosclerosis, Thrombosis, and Vascular Biology': ['ATVB'],
    'Hypertension': ['Hypertension (Dallas, Tex. : 1979)'], 'Stroke': [],
    'European Heart Journal': ['EHJ', 'EHJ: Current Issue', 'EHJ: Advance Access'],
    'European Heart Journal - Digital Health': ['EHJ-Digital Health', 'EHJ- Digital Health Advance Access'],
    'European Heart Journal - Cardiovascular Pharmacotherapy': ['EHJ - Cardiovascular Pharmacotherapy', 'EHJ - Cardiovasc Pharmacotherapy'],
    'European Heart Journal - Cardiovascular Imaging': [],
    'European Heart Journal Supplements': [],
    'European Journal of Heart Failure': ['EJHF', 'Euro J Heart Failure'],
    'Cardiovascular Research': [], 'Europace': [],
    'JACC': [], 'JACC: Advances': ['JACC Advances'],
    'JACC: Clinical Electrophysiology': ['JACC: CE'],
    'JACC: Cardiovascular Imaging': ['JACC: Cardio Imaging'],
    'JACC: Cardiovascular Interventions': ['JACC: Interventions'],
    'JACC: Heart Failure': ['JACC Heart Failure'],
    'JACC: Case Reports': [],
    'JACC: Basic to Translational Science': ['JACC: BTS'], 'JACC Asia': [],
    'Journal of Cardiovascular Electrophysiology': ['JCE', 'J. Cardiovasc. Electrophysiol. (JCE)'],
    'International Journal of Cardiology': ['IJC', 'Int. J. Cardiology (IJC)'],
    'Heart Rhythm': [], 'Heart Rhythm O2': [],
    'Heart': ['Heart Online First', 'Heart (British Cardiac Society)'],
    'The BMJ': ['BMJ', 'BMJ (Clinical research ed.)'],
    'BMJ Digital Health & AI': ['BMJ Digital Health', 'BMJ Digital Health & AI current issue', 'BMJ Digital Health & AI recent issues'],
    'The Lancet': ['Lancet (London, England)'],
    'The Lancet Digital Health': ['Lancet Digital Health'],
    'The Lancet Primary Care': ['Lancet Primary Care'],
    'The Lancet Rheumatology': ['Lancet Rheumatology'],
    'eClinicalMedicine': [],
    'Journal of the American Medical Informatics Association': ['JAMIA', 'JAMIA-1', 'JAMIA-2'],
    'Nature Medicine': [], 'Nature Machine Intelligence': [],
    'Nature Reviews Cardiology': [], 'Nature Cardiovascular Research': [],
    'npj Digital Medicine': [], 'npj Artificial Intelligence': [],
    'npj Cardiovascular Health': [], 'npj Health Systems': [],
    'Communications Medicine': [], 'Communications Psychology': [],
    'Scientific Reports': [], 'Cardiovascular Diabetology': [],
    'Science': ['Science Magazine'], 'Science Advances': ['Science Advances: ToC'],
    'PNAS': ['PNAS-current'], 'PNAS Nexus': [],
    # These are collection/source labels, deliberately not fabricated journal names.
    'PubMed: 丹麦房颤队列追踪': ['danish cohort atrial fibrillation'],
    'PubMed: 房颤专病追踪': ['atrial fibrillation'],
    'PubMed: 中国心血管病报告': ['CN CVD2022'],
    'PubMed: 安贞团队论文追踪': ['AZ team'],
}
# Canonical spelling for additional known source names (no guessed abbreviations).
for _name in (
    'JAMA Surgery', 'JAMA Health Forum', 'JAMA Ophthalmology', 'JAMA Neurology',
    'JAMA Psychiatry', 'JAMA Pediatrics', 'JAMA Oncology', 'JAMA Otolaryngology-Head & Neck Surgery',
    'BMJ Evidence-Based Medicine', 'BMJ Open', 'JN Learning',
    'The Lancet Global Health', 'The Lancet Oncology', 'The Lancet Diabetes & Endocrinology',
    'The Lancet Public Health', 'The Lancet Neurology', 'The Lancet Healthy Longevity',
    'Journal of Arrhythmia', 'Pacing and Clinical Electrophysiology', 'American Heart Journal',
    'Trends in Cardiovascular Medicine', 'Progress in Cardiovascular Diseases',
    'Nature', 'Nature News', 'Nature Biomedical Engineering', 'Nature Reviews Psychology',
    'Nature Health', 'Nature Communications', 'Nature Cancer', 'Nature Reviews Bioengineering',
    'Nature Computational Science', 'Nature Reviews Cancer', 'Nature Methods',
    'Nature Biotechnology', 'Nature Reviews Neurology', 'Nature Reviews Gastroenterology & Hepatology',
    'Nature Human Behaviour', 'Nature Mental Health', 'Nature Protocols', 'Nature Electronics',
    'Nature Metabolism', 'Nature Microbiology', 'Nature Reviews Clinical Oncology',
    'Nature Materials', 'Nature Reviews Urology', 'npj Gut and Liver',
    'International Journal of Medical Informatics', 'Journal of Biomedical Informatics',
    'JMIR Medical Informatics', 'JMIR AI', 'Frontiers in Digital Health',
    'BMC Medical Informatics and Decision Making', 'Journal of Imaging Informatics in Medicine',
    'BMC Cardiovascular Disorders', 'Stroke and Vascular Neurology', 'National Science Review',
    'Annals of Internal Medicine', 'Science Robotics', 'OpenAI News', 'arXiv', 'TechRxiv', 'Artificial Intelligence',
):
    _JOURNAL_GROUPS.setdefault(_name, [])
_JOURNAL_ALIASES = {_journal_key(alias): canonical
                    for canonical, aliases in _JOURNAL_GROUPS.items()
                    for alias in [canonical, *aliases]}
_JOURNAL_ALIASES[_journal_key('Progress in Cardio Dis')] = 'Progress in Cardiovascular Diseases'


def clean_journal_name(journal):
    j = (journal or '').strip()
    key = _journal_key(j)
    if key.startswith('europace european pacing, arrhythmias, and cardiac electrophysiology '):
        return 'Europace'
    return _JOURNAL_ALIASES.get(key, j)


# 1. Normalized publisher mapping. A DOI/PubMed link is not a publisher identity.
def classify_publisher(journal, url=''):
    j = clean_journal_name(journal)
    jl = j.casefold()
    try:
        host = (urlsplit(url or '').hostname or '').casefold()
    except ValueError:
        host = ''
    def at(domain):
        return host == domain or host.endswith('.' + domain)
    if re.match(r'^(?:nature\b|npj\b)', jl) or j in {'Communications Medicine', 'Communications Psychology', 'Scientific Reports'} or at('nature.com'):
        return 'Nature Portfolio'
    if re.match(r'^(?:jacc\b|heart rhythm\b)', jl) or j in {'International Journal of Cardiology', 'Trends in Cardiovascular Medicine', 'Progress in Cardiovascular Diseases', 'American Heart Journal'} or at('sciencedirect.com'):
        return 'Elsevier / ACC / HRS'
    if re.match(r'^circulation\b', jl) or j in {'Stroke', 'Hypertension', 'Journal of the American Heart Association', 'Arteriosclerosis, Thrombosis, and Vascular Biology'} or at('ahajournals.org'):
        return 'AHA (Circulation)'
    if re.match(r'^(?:the )?lancet\b', jl) or j == 'eClinicalMedicine' or at('thelancet.com'):
        return 'The Lancet Group'
    if re.match(r'^european heart journal\b', jl) or j in {'Europace', 'Cardiovascular Research', 'Journal of the American Medical Informatics Association', 'PNAS Nexus', 'National Science Review'} or at('academic.oup.com'):
        return 'Oxford (OUP / ESC)'
    if re.match(r'^jama\b', jl) or j == 'JN Learning' or at('jamanetwork.com'):
        return 'JAMA Network'
    if re.match(r'^bmj\b', jl) or j in {'The BMJ', 'Heart', 'Stroke and Vascular Neurology'} or at('bmj.com'):
        return 'BMJ Group'
    if re.match(r'^nejm\b', jl) or j == 'New England Journal of Medicine' or at('nejm.org'):
        return 'MMS (NEJM)'
    if j in {'Science', 'Science Advances', 'Science Robotics'} or at('science.org'):
        return 'AAAS (Science)'
    if j == 'PNAS' or at('pnas.org'):
        return 'NAS (PNAS)'
    if j in {'Journal of Cardiovascular Electrophysiology', 'European Journal of Heart Failure', 'Journal of Arrhythmia', 'Pacing and Clinical Electrophysiology'} or at('wiley.com'):
        return 'Wiley'
    if j == 'OpenAI News' or at('openai.com'):
        return 'AI 与科技前沿'
    if jl.startswith('pubmed:'):
        return 'PubMed 专题追踪'
    return '其他学术刊物'

# 3. Clinical Tier & Specialty Matrix
def classify_clinical_tier(journal, title=''):
    # This is a source group plus explicit title cues, not a verified article specialty.
    j = clean_journal_name(journal)
    jl = j.casefold()
    tl = (title or '').lower()
    if j in {'Circulation: Arrhythmia and Electrophysiology', 'JACC: Clinical Electrophysiology', 'Europace', 'Heart Rhythm', 'Heart Rhythm O2', 'Journal of Cardiovascular Electrophysiology', 'Journal of Arrhythmia', 'Pacing and Clinical Electrophysiology', 'PubMed: 房颤专病追踪', 'PubMed: 丹麦房颤队列追踪'}:
        return '心律失常与电生理'
    if j in {'Circulation: Heart Failure', 'JACC: Heart Failure', 'European Journal of Heart Failure'}:
        return '心衰与重症心肌'
    if j in {'Circulation: Cardiovascular Interventions', 'JACC: Cardiovascular Interventions'}:
        return '冠脉介入与结构'
    if j in {'Circulation: Cardiovascular Imaging', 'JACC: Cardiovascular Imaging', 'European Heart Journal - Cardiovascular Imaging'}:
        return '心血管影像与表型'
    if j in {'Stroke', 'Hypertension', 'Arteriosclerosis, Thrombosis, and Vascular Biology', 'Stroke and Vascular Neurology'}:
        return '脑血管与高血压'
    if j in {'npj Digital Medicine', 'NEJM AI', 'The Lancet Digital Health', 'European Heart Journal - Digital Health', 'BMJ Digital Health & AI', 'Journal of the American Medical Informatics Association', 'International Journal of Medical Informatics', 'Journal of Biomedical Informatics', 'JMIR Medical Informatics', 'JMIR AI', 'Frontiers in Digital Health', 'BMC Medical Informatics and Decision Making', 'Journal of Imaging Informatics in Medicine'}:
        return 'AI医疗与数字医学'
    if j in {'JACC', 'Circulation', 'European Heart Journal', 'Nature Reviews Cardiology', 'JAMA Cardiology', 'Heart'}:
        return '心血管旗舰顶刊'
    if j in {'PubMed: 安贞团队论文追踪', 'PubMed: 中国心血管病报告'}:
        return '定向专病与团队'
    ai_title = bool(re.search(r'\b(?:ai|artificial intelligence|machine learning|deep learning|neural networks?|large language models?|foundation models?|generative ai|chatgpt|digital health)\b', tl))
    cv_title = bool(re.search(r'\b(?:cardiac|cardiovascular|cardiology|coronary|atrial|ventricular|myocardial|arrhythmia|electrocardiogram|hypertension|stroke)\b|\bheart (?:failure|disease|transplant|attack)\b', tl))
    medical_title = bool(re.search(r'\b(?:clinical|medical|medicine|health|patients?)\b', tl)) or cv_title
    if j in {'Nature Machine Intelligence', 'npj Artificial Intelligence', 'Artificial Intelligence', 'OpenAI News', 'arXiv', 'TechRxiv'}:
        if ai_title and medical_title:
            return 'AI医疗与数字医学'
        return '前沿大模型与科技'
    if j in {'Journal of the American Heart Association', 'Circulation Research', 'Circulation: Genomic and Precision Medicine', 'Circulation: Cardiovascular Quality and Outcomes', 'JACC: Advances', 'JACC: Case Reports', 'JACC: Basic to Translational Science', 'JACC Asia', 'European Heart Journal - Cardiovascular Pharmacotherapy', 'European Heart Journal Supplements', 'Cardiovascular Research', 'International Journal of Cardiology', 'American Heart Journal', 'Trends in Cardiovascular Medicine', 'Nature Cardiovascular Research', 'npj Cardiovascular Health', 'Cardiovascular Diabetology', 'BMC Cardiovascular Disorders'}:
        return '心血管综合与其他'
    # General medical journals do not acquire an AI label from "failure"/"brain".
    if ai_title and (medical_title or j in {'Nature Medicine', 'Communications Medicine'}):
        return 'AI医疗与数字医学'
    if cv_title:
        return '心血管综合与其他'
    if j in {'New England Journal of Medicine', 'NEJM Evidence', 'The BMJ', 'The Lancet', 'Nature', 'Nature Medicine', 'Communications Medicine', 'Science', 'Science Advances', 'PNAS', 'Annals of Internal Medicine'} or re.match(r'^(?:jama|the lancet|nature)\b', jl):
        return '顶级综合与科学'
    return '综合医学与其他'

# 4. Study Design
def classify_study_design(title, summary='', publication_types=()):
    """Use direct design evidence, never a mention of a design in prior work.

    Titles and PubMed publication types take precedence over abstract keywords.
    An unlabelled abstract is used only when it explicitly describes this study;
    a phase number, ECG, EHR, AI method, or follow-up alone proves no design.
    These are unreviewed metadata labels, not assessments of evidence quality.
    """
    title_text = (title or '').lower()
    abstract = (summary or '').lower()
    types = {str(t).lower().strip() for t in (publication_types or ())}

    synthesis = r'\bmeta[- ]analys(?:is|es)\b|\bsystematic reviews?\b|\bnetwork meta\b'
    commentary = r'\b(?:editorial|viewpoint|perspective|commentary)\b|^\s*(?:\[)?(?:comment|correspondence|letter|response|reply)\b'
    case_control = r'\bcase[-\s\u2010-\u2015]+control\b'
    observational = r'\bcohort\b|\bregistry\b|\bobservational (?:study|studies|analysis|registry)\b'
    cross_sectional = r'\bcross[- ]sectional\b'
    validation = r'\bexternal validation\b|\bvalidation study\b|\b(?:development and |derivation and )?validation of\b'
    randomized_trial = r'\brandomi[sz]ed(?:[- ,]+[a-z]+){0,4}[- ,]+(?:trial|controlled study)\b|\brct\b'

    # A protocol, review or observational paper can discuss many randomized trials.
    if re.search(r'\bprotocol\b', title_text):
        return '研究方案'
    if re.search(commentary, title_text) or types & {'editorial', 'comment', 'letter'}:
        return '述评观点'
    if re.search(synthesis, title_text) or types & {'meta-analysis', 'systematic review'}:
        return 'Meta/综述'
    review_title = re.sub(r'\b(?:peer|chart|medical records?|records?) reviews?\b', '', title_text)
    if re.search(r'\breview\b', review_title) or 'review' in types:
        return '叙述综述'
    if re.search(cross_sectional, title_text):
        return '横断面研究'
    explicit_random = re.search(randomized_trial, title_text) and not re.search(r'\bnon[- ]?randomi[sz]ed\b|\bsingle[- ]arm\b', title_text)
    if explicit_random and (re.search(observational, title_text) or re.search(case_control, title_text)):
        return '研究类型待核验'
    if re.search(case_control, title_text):
        return '病例对照研究'
    if re.search(observational, title_text) or types & {'observational study'}:
        return '队列研究'
    if re.search(r'\bcase reports?\b|\bcase series\b', title_text) or 'case reports' in types:
        return '病例报告'
    if types & {'guideline', 'practice guideline', 'consensus development conference'} or (re.search(r'^\s*(?:\d{4}[- :]*\s*)?(?:aha|acc|esc|ehra|hrs|american|european|clinical practice|practice guideline|guidelines?|expert consensus)\b', title_text) and re.search(r'\bguidelines?\b|\bconsensus (?:statement|document|recommendations)\b', title_text) and not re.search(r'interpretation|adherence|implementation|concordance|guideline[- ]directed|language model', title_text)) or re.search(r'^.*:\s*(?:a |an )?(?:scientific statement|position paper)\b',title_text):
        return '指南共识'

    def without_negated_randomization(text):
        return re.sub(r'\bnon[- ]?randomi[sz]ed\b|\bnot(?: a)? randomi[sz]ed\b', '', text)

    # Single-arm, non-randomized and phase-only studies must not become RCTs.
    single_arm = bool(re.search(r'\bsingle[- ]arm\b|\bnon[- ]?randomi[sz]ed\b', title_text))
    if not single_arm and (re.search(randomized_trial, without_negated_randomization(title_text)) or 'randomized controlled trial' in types):
        return 'RCT'
    if re.search(validation, title_text):
        return '方法/模型验证'

    # Prefer the METHODS/DESIGN section; exclude BACKGROUND and cited prior trials.
    method_sections = re.findall(
        r'\b(?:methods?|study design|design(?:\s*,\s*setting\s*,\s*(?:and\s+)?participants)?|materials and methods)\s*:\s*(.*?)(?=\b(?:results?|conclusions?(?:\s+and\s+relevance)?|background|importance|objectives?|findings|interpretation|discussion|exposures?|interventions?|main outcomes and measures|trial registration)\s*:|$)',
        abstract, flags=re.S)
    direct = ' '.join(method_sections)
    if not direct:
        direct = ' '.join(s for s in re.split(r'(?<=[.!?])\s+', abstract)
                          if re.search(r'\b(?:we (?:conducted|performed|undertook)|this (?:study|trial|review|analysis) (?:is|was)|in this (?:study|trial|review|registry))\b', s))
    if re.search(synthesis, direct):
        return 'Meta/综述'
    if re.search(cross_sectional, direct):
        return '横断面研究'
    if re.search(case_control, direct):
        return '病例对照研究'
    if re.search(observational, direct):
        return '队列研究'
    if re.search(r'\bcase reports?\b|\bcase series\b', direct):
        return '病例报告'
    # Searching or including other trials describes evidence synthesis, not allocation.
    describes_synthesis = bool(re.search(r'\b(?:searched|included studies|included trials|literature search)\b', direct))
    assigns_randomly = r'\b(?:patients|participants|adults|children|women|men)\b[^.!?]{0,100}\b(?:were|was) (?:randomly assigned|randomi[sz]ed)\b|\bwe randomi[sz]ed\s+(?:\d+\s+)?(?:patients|participants|adults|children|women|men)\b|\b(?:a|an|this|the) (?:[a-z-]+[ ,]+){0,4}randomi[sz]ed(?:[- ,]+[a-z]+){0,4}[- ,]+trial\b'
    if not single_arm and not describes_synthesis and re.search(assigns_randomly, without_negated_randomization(direct)):
        return 'RCT'
    if re.search(validation, direct):
        return '方法/模型验证'
    return '研究类型待核验'

# 5. Modality & Clinical Tags
TAG_RULES = [
    ('#房颤/电生理', r'\batrial fibrillation\b|\bafib\b|\bcatheter ablation\b|\belectrophysiolog|\bpvi\b|\barrhythmi|\bpulmonary vein\b|\bantiarrhythmic\b'),
    ('#心衰/心肌', r'\bheart failure\b|\bhfref\b|\bhfpef\b|\bcardiomyopath|\bgdmt\b|\bejection fraction\b|\bsglt2\b|\bsacubitril\b'),
    ('#心电', r'\becg\b|\belectrocardiogram|\b12-lead\b|\belectrocardiographic\b|\bqt interval\b'),
    ('#大模型/NLP', r'\blanguage model\b|\bllm\b|\bchatgpt\b|\bgenerative ai\b|\bnlp\b|\bgpt\b|\btransformer\b'),
    ('#卒中/抗凝', r'\bstroke\b|\banticoagula|\bthrombos|\bbleeding\b|\bnoac\b|\bdoac\b|\bischemic attack\b|\bwarfarin\b'),
    ('#高血压/血管', r'\bhypertension\b|\bblood pressure\b|\bvascular\b|\barterial\b|\batvb\b|\bantihypertensive\b'),
    ('#冠脉介入', r'\bpci\b|\bstent\b|\bcoronary\b|\bangioplasty\b|\bmyocardial infarction\b|\bacs\b'),
    ('#穿戴/远程监测', r'\bwearable\b|\bsmartwatch\b|\bremote monitoring\b|\btelehealth\b|\bdigital biomarker\b|\bphotoplethysmography\b|\bppg\b'),
    ('#影像', r'\bcomputed tomography\b|\bmri\b|\bmagnetic resonance\b|\bechocardiograph|\bultrasound\b|\bperfusion\b|\bangio\b')
]

def extract_tags(title, summary=''):
    text = f"{title or ''} {summary or ''}".lower()
    matched = []
    for tag, pat in TAG_RULES:
        if re.search(pat, text):
            matched.append(tag)
    if '#心电' in matched and re.search(r'\bartificial intelligence\b|\bmachine learning\b|\bdeep learning\b|\bneural network\b|\bai\b', text):
        matched[matched.index('#心电')] = '#AI-ECG'
    return matched[:4]

# 6. Quantitative Metrics Extraction
def extract_quantitative_metrics(title, summary=''):
    text = f"{title or ''} {summary or ''}"
    metrics = {}

    # Consume the entire numeric token before validating the integer format, so a
    # grouped count (725 205) or a decimal cannot be misread as its final digits.
    # Four-digit counts remain valid; only explicit calendar-year contexts are excluded.
    number_token = r'(?<![\w.,+\-\u2010-\u2015])([0-9](?:[0-9,. \u00a0\u202f]*[0-9])?)'
    count_integer = r'(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,3}(?:[ \u00a0\u202f]+[0-9]{3})+)'
    count_prefix = r'\b(?:n\s*=\s*|total of\s+|enrolled\s+|cohort of\s+|comprising\s+|among\s+)'
    count_units = r'\s*(?:patients|participants|individuals|subjects|cases|records|ecgs|scans|examinations|users)\b'
    fallback_units = r'\s*(?:patients|participants|individuals|subjects)\b'
    calendar_context = r'(?:\b(?:in|during|since|until|before|after|from|through)\s+|\b(?:between|from)\s+[0-9]{4}\s+(?:and|to|through)\s+|\b[0-9]{4}\s*[-\u2013\u2014]\s*)$'
    for pattern in (count_prefix + number_token + count_units, number_token + fallback_units):
        for match in re.finditer(pattern, text, re.I):
            token = match.group(1)
            if not re.fullmatch(count_integer, token):
                continue
            value = int(re.sub(r'[, \u00a0\u202f]', '', token))
            prefix = text[:match.start(1)]
            if value <= 5 or (1800 <= value <= 2100 and re.search(calendar_context, prefix, re.I)):
                continue
            metrics['sampleSize'] = f"n = {value:,}"
            break
        if 'sampleSize' in metrics:
            break

    # Follow-up
    fu_matches = re.findall(r'\b(?:median|mean|average)?\s*(?:follow[- ]up\s*(?:of|duration)?\s*(?:was|is)?\s*|followed for\s*)([\d\.]+\s*(?:years?|months?|days?|weeks?))\b', text, re.I)
    if fu_matches:
        metrics['followUp'] = fu_matches[0].strip()

    # Trial registration ID (NCT, ISRCTN, ChiCTR)
    trial_matches = re.findall(r'\b(NCT\d{8}|ISRCTN\d{8}|ChiCTR\d{10})\b', text, re.I)
    if trial_matches:
        metrics['trialId'] = trial_matches[0].upper()

    # Primary Endpoints & Effect sizes
    effects = []
    # HR / OR / RR with 95% CI
    stat_matches = re.findall(r'\b((?:hazard ratio|odds ratio|relative risk|HR|OR|RR)\s*(?:of|was|is|[:=])?\s*[\d\.]+\s*(?:;\s*95%\s*CI,?\s*[\d\.\s–-]+|\(95%\s*CI,?\s*[\d\.\s–-]+\))?)', text, re.I)
    for m in stat_matches[:2]:
        cleaned_m = re.sub(r'\s+', ' ', m).strip()
        if len(cleaned_m) > 4 and cleaned_m not in effects:
            effects.append(cleaned_m)

    # AUC / C-index
    auc_matches = re.findall(r'\b((?:AUC|AUROC|C[- ]statistic|C[- ]index)\s*(?:of|was|is|[:=])?\s*0?\.\d+)', text, re.I)
    for a in auc_matches[:1]:
        cleaned_a = re.sub(r'\s+', ' ', a).strip()
        if cleaned_a not in effects:
            effects.append(cleaned_a)

    # P-value
    p_matches = re.findall(r'\b(p\s*[<>=]\s*0?\.?\d+)\b', text, re.I)
    if p_matches:
        effects.append(p_matches[0].strip())

    if effects:
        metrics['effectSizes'] = effects[:3]

    return metrics

# 7. Substantive 4-Pillar Clinical Appraisal Generator
def generate_clinical_appraisal(p):
    """Generate high-rigor, substantive clinical learning and critical appraisal
    tailored to study design, clinical specialty, and therapeutic trade-offs.
    Adheres strictly to the '重点说不好' posture of Donald Xia (Cardiologist, CMO).
    """
    design = p.get('studyDesign', '论著探索')
    tier = p.get('clinicalTier', '综合医学与其他')
    tags = p.get('tags', [])
    summary = (p.get('summary') or '').lower()
    title = (p.get('title') or '').lower()

    # Pillar 1: 方法学审慎点与偏倚审查 (Methodological Appraisal & Bias Watch)
    if design == 'RCT':
        methodology = (
            "【盲法与终点裁决】核实本研究是否采用双盲或开放标签盲态终点评估（PROBE设计）。"
            "若为PROBE设计，患者主诉与软指标极易受治疗知情偏倚影响，主要终点必须依赖盲态独立裁决委员会（CEC）裁决的硬终点（心血管死亡、致残性卒中、心衰住院）。\n"
            "【统计集审视】核查主要疗效终点采用意向性治疗分析（mITT）还是符合方案集（PP）。在非劣效性检验中PP分析更为严格，而在优效性检验中mITT能避免虚假获益，需严防脱落率（Loss to follow-up > 10%）导致的耗损偏倚。"
        )
    elif design == '队列研究':
        methodology = (
            "【适应证混杂（Confounding by Indication）】真实世界观察性队列中，病情更重或合并症更复杂的患者常被优先赋予强化干预。"
            "需审视多元回归或倾向性评分匹配（PSM）后的基线残余混杂（Residual Confounding），尤其是未记录的虚弱度（Frailty）与生活方式变量。\n"
            "【时间窗偏倚】严查是否存在永生时间偏倚（Immortal Time Bias），从入组至实际接受干预的等待期若未按时变协变量（Time-varying covariate）校正，会虚假拔高干预组生存率。"
        )
    elif design == '算法验证':
        methodology = (
            "【患者级隔离与信息泄漏】严查训练集、验证集与独立测试集是否在患者层级（Patient-level）严格拆分，同患者多次复查或不同导联数据切片交叉进入测试集会导致离线AUC严重虚高。\n"
            "【频谱偏倚与离线陷阱】核实模型是否经过跨中心、跨硬件厂商（如GE/Philips/Mindray多设备异质性）外部测试。离线高AUROC往往在低患病率真实人群中遭遇大量假阳性与临床警报疲劳（Alarm Fatigue）。证据链条仅停留在L0/L1跑分，缺乏前瞻性临床结局RCT（L4）证据。"
        )
    elif design == 'Meta/综述':
        methodology = (
            "【异质性与发表偏倚】关注异质性检验统计量（I² > 50%提示高度临床/方法学异质性），必须核查亚组分析与敏感性分析是否稳健；"
            "检查漏斗图（Funnel Plot）对称性与Egger回归，警惕阴性小样本研究未发表导致的整体效应量虚假放大。"
        )
    elif design == '指南共识':
        methodology = (
            "【推荐等级与证据源流】严格区分推荐等级（Class I/IIa/IIb/III）与证据级别（Level A/B/C），审视关键推荐是基于高质量大样本多中心RCT还是专家委员会经验共识；"
            "关注不同学术机构（如ACC/AHA与ESC）在靶目标值（如血压130/80 vs 140/90）及药物优先级的跨洋分歧与利益冲突声明。"
        )
    else:
        methodology = (
            "【探索性假说验证局限】本研究多属假设生成性（Hypothesis-generating）或单中心探索性设计，统计效能（Power）可能不足。"
            "研究结论不可直接跨人群或跨病种外推，其生物标志物或中间替代终点（Surrogate Endpoint）与长期临床硬终点的因果链条仍待前瞻性验证。"
        )

    # Pillar 2: 核心临床权衡与安全红线 (Clinical Trade-offs & Safety Nuance)
    if '房颤' in tier or '#房颤/电生理' in tags or 'atrial fibrillation' in title or 'ablation' in title:
        tradeoffs = (
            "【抗凝净获益（Net Clinical Benefit）天平】缺血性脑卒中预防获益 vs 致命性颅内出血与消化道大出血风险。"
            "合并慢性肾脏病（eGFR 15-30 mL/min）、高龄（≥75岁）或极低体重患者，严格遵循减量标准，切忌无指征盲目减量导致抗凝失败。\n"
            "【节律控制手术红线】导管消融维持窦律虽能改善症状与心衰预后，但需警惕术中急性风险（心包压塞、膈神经麻痹、食管心房瘘）以及术后肺静脉狭窄；盲目扩大基质消融范围可能破坏心房机械收缩功能并诱发复杂房扑。"
        )
    elif '心衰' in tier or '#心衰/心肌' in tags or 'heart failure' in title:
        tradeoffs = (
            "【GDMT四大支柱滴定权衡】SGLT2i、ARNI、β受体阻滞剂与MRA在滴定起始期常伴随一过性肌酐升高（升幅<30%可接受）、血钾波动及低血压。"
            "需权衡长期心肾硬终点获益与短期血流动力学不耐受，动态监测电解质与eGFR。\n"
            "【绝对禁忌红线】HFrEF患者严禁使用非二氢吡啶类CCB（地尔硫䓬/维拉帕米）；严重肾功能衰竭（eGFR < 20）启动新药需密切监测血钾，警惕高钾血症致死性心律失常。"
        )
    elif '冠脉' in tier or '#冠脉介入' in tags or 'pci' in title or 'coronary' in title:
        tradeoffs = (
            "【缺血与出血双重风险评估】双联抗血小板（DAPT）时程的个体化权衡（1-3个月超短DAPT vs 12个月常规DAPT）。"
            "高出血风险（HBR）患者需权衡支架内血栓（Stent Thrombosis）与BARC 3-5级严重出血风险，合理利用PRECISE-DAPT或ARC-HBR评分指导降阶梯策略。"
        )
    elif 'AI医疗' in tier or '数字医学' in tags or 'ai' in title or 'machine learning' in title:
        tradeoffs = (
            "【假阴性漏诊代价 vs 假阳性过度医疗】AI辅助预警系统的阈值设定权衡：提高灵敏度会导致大量低危患者被标记为异常，诱发无指征冠脉CTA/心导管造影、不必要抗凝及患者焦虑；"
            "降低敏感度则可能漏掉致命性恶性心律失常（VT/VF）或不典型心梗，临床必须预设清晰的人机分工与人工复核降级通道（Plan B）。"
        )
    else:
        tradeoffs = (
            "【疗效获益与不良事件对称评估】临床干预决策必须计算“需治疗人数（NNT）”与“需致害人数（NNH）”的比值，"
            "警惕相对危险度降低（RRR）在低绝对风险人群中被过度包装，重点关注全因死亡率与严重不良事件（SAE）发生率是否实现真获益。"
        )

    # Pillar 3: 真实世界落地壁垒 (Real-World Implementation Barriers)
    if 'AI' in tier or '数字医学' in tier or '模型' in tier:
        barriers = (
            "【医保支付与商业闭环】国内医保严禁单独加收AI辅助诊疗费（属扩展项无法直接医保报销）。"
            "商业变现核心必须依托DRG/DIP医保结余留用分成、降低并发症缩短平均住院日，或药械真实世界研究（RWS）付费；单纯软件订阅模式在公立医院采购壁垒极高。\n"
            "【工作流整合摩擦】算法若脱离医院PACS/HIS系统而需要医生二次登录、手动上传DICOM或切换屏幕，临床依从性将断崖式下跌，必须做到全自动后台触发与静默赋能。"
        )
    else:
        barriers = (
            "【DRG/DIP控费与药物可及性】新型创新药械或复杂介入耗材进入临床常受限于DRG病组点数封顶与医院药占比/耗占比考核，可能面临“进院难、处方受限”的落地阻力。\n"
            "【长期依从性衰减】院外慢病管理与滴定方案高度依赖患者服药依从性与定期随访复查。真实世界中患者因经济负担、不良反应或复查繁琐，6-12个月脱落率常高达30%-50%。"
        )

    # Pillar 4: 科室晨读与查房研讨三问 (Morning Huddle Critical Questions)
    questions = []
    if '房颤' in tier or '#房颤/电生理' in tags or 'atrial fibrillation' in title:
        questions = [
            "Q1（人群外推）：该研究纳入的人群中合并心衰（HFpEF/HFrEF）或严重肾功能不全（CKD 4-5期）的比例是多少？其主要疗效与安全性结果在这些极高危亚组中是否依然稳健？",
            "Q2（终点驱动）：主要复合终点（MACE/卒中/再住院）的驱动力主要来自于死亡硬终点，还是仅仅由软指标（非致死性再入院或心悸主诉）驱动？",
            "Q3（临床替代）：如果本科室明天收治类似患者，现有的抗凝策略或消融术式是否需要立即改变？支持改变的绝对获益（ARR）是否足以抵御潜在并发症风险？"
        ]
    elif '心衰' in tier or '#心衰/心肌' in tags or 'heart failure' in title:
        questions = [
            "Q1（药物滴定）：在患者起始或上调剂量时，血肌酐允许上升的合理上限是多少？如果出现轻度无症状低血压（收缩压85-90 mmHg），是否应该立即停药或减量？",
            "Q2（对照组标准）：对照组接受的基础治疗是否已经达标当代指南推荐的完整GDMT？如果对照组治疗不足，该药展示的优效性是否存在水分？",
            "Q3（终点构成）：心衰再住院终点事件是否经过标准化且独立的临床事件委员会（CEC）统一盲态裁决？还是依赖各中心研究者的主观临床判断？"
        ]
    elif 'AI' in tier or '数字医学' in tier or '模型' in tier:
        questions = [
            "Q1（泛化鲁棒性）：该算法模型如果在非原研开发医院（不同医疗中心、不同病种分布、不同品牌心电/影像采集设备）上部署，其AUC与阳性预测值（PPV）是否会出现严重衰减？",
            "Q2（人机协同增益）：研究是否证实了“AI+医生”在前瞻性真实临床环境下的表现显著超越“单顶级专家”？还是仅展示了AI在离线测试集上对低年资规培医生的单点跑分超越？",
            "Q3（成本与警报负担）：如果该系统在全科室或病房上线，每天每名护士/医生平均会收到多少条警报？其中的假警报比例是多少，是否会导致警报疲劳甚至关停系统？"
        ]
    else:
        questions = [
            "Q1（证据边界）：该研究的排除标准（Exclusion Criteria）排除了哪些常见的真实临床复杂患者（如合并多脏器功能不全、高龄虚弱体质、妊娠等）？在多大程度上影响该结论的真实外推性？",
            "Q2（绝对风险降低）：作者强调的相对风险降低（RRR）对应的绝对风险降低（ARR）是多少？需治疗人数（NNT）是多少？是否具备卫生经济学价值？",
            "Q3（方案违背率）：研究期间发生交叉治疗（Crossover）或提前停药的患者比例是多少？对最终优效性判定的干扰有多大？"
        ]

    return {
        "methodologyWatch": methodology,
        "clinicalTradeoffs": tradeoffs,
        "realWorldBarriers": barriers,
        "morningHuddleQuestions": questions
    }

# 8. Citation & Formatter
def format_citation(p):
    authors = p.get('authors', [])
    title = p.get('title', '')
    journal = p.get('cleanJournal', p.get('journal', ''))
    date = p.get('date', '')[:4]
    doi = p.get('doi', '')
    url = p.get('url', '')

    if authors:
        if len(authors) > 3:
            author_str = f"{authors[0]}, {authors[1]}, {authors[2]}, et al."
        else:
            author_str = ', '.join(authors)
    else:
        author_str = 'XinZhi Monitored Group'

    # GB/T 7714-2015
    gb = f"{author_str}. {title}[J]. {journal}, {date}."
    if doi:
        gb += f" DOI: {doi}."

    # AMA
    ama = f"{author_str}. {title}. {journal}. Published online {p.get('date', '')[:10]}."
    if doi:
        ama += f" doi:{doi}"

    # BibTeX
    clean_id = re.sub(r'[^a-zA-Z0-9]', '', (authors[0].split()[0] if authors else 'article') + date)
    bibtex = f"@article{{{clean_id},\n  title={{{title}}},\n  author={{{' and '.join(authors[:5]) if authors else 'Authors'}}},\n  journal={{{journal}}},\n  year={{{date}}},\n  doi={{{doi}}}\n}}"

    return {
        'gb': gb,
        'ama': ama,
        'bibtex': bibtex,
        'authorSummary': f"{authors[0]} et al." if len(authors) > 1 else (authors[0] if authors else '')
    }

def enrich_paper(p, drafts_by_doi={}, drafts_by_url={}):
    doi = (p.get('doi') or '').lower().strip()
    url = p.get('url') or ''
    title = p.get('title') or ''
    summary = p.get('summary') or ''
    journal = p.get('journal') or ''

    pub = classify_publisher(journal, url)
    clean_j = clean_journal_name(journal)
    tier = classify_clinical_tier(journal, title)
    design = classify_study_design(title, summary, p.get('pubTypes', ()))
    tags = extract_tags(title, summary)
    quant_metrics = extract_quantitative_metrics(title, summary)

    p['publisher'] = pub
    p['cleanJournal'] = clean_j
    p['clinicalTier'] = tier
    p['studyDesign'] = design
    p['tags'] = tags
    p['quantitativeMetrics'] = quant_metrics

    # Editorial draft linkage
    draft = drafts_by_doi.get(doi) or drafts_by_url.get(url)
    if draft:
        p['hasDraft'] = True
        p['draftData'] = draft
    else:
        p['hasDraft'] = False

    # A label is not a paper-specific appraisal; never fabricate evaluation or authors.
    p.pop('clinicalAppraisal', None)
    p.pop('citations', None)

    return p

def main():
    # Load editorial drafts
    drafts_file = ROOT / 'editorial/source_checked_drafts.json'
    drafts_by_doi = {}
    drafts_by_url = {}
    if drafts_file.exists():
        try:
            d_json = json.loads(drafts_file.read_text())
            for d in d_json.get('articles', []):
                d.setdefault('published', str(d_json.get('prepared_on', ''))[:10])
                if d.get('doi'):
                    drafts_by_doi[d['doi'].lower().strip()] = d
                if d.get('source_url'):
                    drafts_by_url[d['source_url'].strip()] = d
        except Exception as e:
            print("Draft load warning:", e)

    # 1. Enrich candidates
    cand_file = ROOT / 'data/candidates.json'
    if cand_file.exists():
        cand = json.loads(cand_file.read_text())
        enriched_items = [enrich_paper(p, drafts_by_doi, drafts_by_url) for p in cand.get('items', [])]
        cand['items'] = enriched_items
        cand['enrichedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        cand_file.write_text(json.dumps(cand, ensure_ascii=False, indent=2))
        (ROOT / 'data/candidates.js').write_text(
            'window.FEEDS=' + json.dumps(cand, ensure_ascii=False).replace('</', '<\\/') + ';'
        )
        print(f"Enriched {len(enriched_items)} candidates with tentative source metadata.")

    # 2. Enrich library
    lib_file = ROOT / 'data/library.json'
    if lib_file.exists():
        lib = json.loads(lib_file.read_text())
        enriched_papers = [enrich_paper(p, drafts_by_doi, drafts_by_url) for p in lib.get('papers', [])]
        lib['papers'] = enriched_papers
        lib['enrichedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        lib_file.write_text(json.dumps(lib, ensure_ascii=False, indent=2))
        (ROOT / 'data/library.js').write_text(
            'window.LIBRARY=' + json.dumps(lib, ensure_ascii=False).replace('</', '<\\/') + ';'
        )
        print(f"Enriched {len(enriched_papers)} library papers.")

if __name__ == '__main__':
    main()
