"""Deterministic source selection; journal and metadata signals are not peer review.

Signal        Points
Journal       flagship 240; specialty 160; other clinical 80; unlisted 0
Article type  guideline 20; trial/meta 15; original 8; review 3; minor 0
Topic         cardiovascular AI 10; cardiovascular or medical AI 5
Prior board   20 + (25 - rank), for ranks 1–24 (20 for lower ranks)
Recency       age <=14 days 8; age <=30 days 4; otherwise 0
Design cues   randomized/meta/systematic 4; prospective/validation/multicenter 2

The 80-point tier gaps keep even the strongest secondary signals from
promoting a lower-tier paper above a higher tier. Availability scores nothing.
"""
import re
from datetime import date

from enrich_metadata import classify_clinical_tier, clean_journal_name

# Print/electronic identifiers from journal-metrics.json and journal catalogue
# spellings used by Europe PMC. An exact identifier or alias matches a venue.
TIER_JOURNALS = {
    3: {
        'New England Journal of Medicine': '0028-4793 1533-4406',
        'The Lancet': '0140-6736 1474-547X',
        'JAMA': '0098-7484 1538-3598',
        'The BMJ': '0959-8138 1756-1833',
        'Nature': '0028-0836 1476-4687',
        'Science': '0036-8075 1095-9203',
        'Nature Medicine': '1078-8956 1546-170X',
        'Annals of Internal Medicine': '0003-4819 1539-3704',
        'Circulation': '0009-7322 1524-4539',
        'JACC': '0735-1097 1558-3597',
        'European Heart Journal': '0195-668X 1522-9645',
        'JAMA Cardiology': '2380-6583',
        'Nature Reviews Cardiology': '1759-5002 1759-5010',
        'The Lancet Digital Health': '2589-7500',
        'NEJM AI': '2836-9386',
        'npj Digital Medicine': '2398-6352',
        'European Heart Journal - Digital Health': '2634-3916',
    },
    2: {
        'Journal of the American Heart Association': '2047-9980',
        'JACC: Advances': '2772-963X',
        'JACC: Basic to Translational Science': '2452-302X',
        'JACC: Cardiovascular Imaging': '1936-878X 1876-7591',
        'JACC: Cardiovascular Interventions': '1936-8798 1876-7605',
        'JACC: Clinical Electrophysiology': '2405-500X',
        'JACC: Heart Failure': '2213-1779 2213-1787',
        'JACC: Case Reports': '2666-0849',
        'JACC Asia': '2772-3747',
        'Circulation Research': '0009-7330 1524-4571',
        'Circulation Reports': '2434-0790',
        'Circulation: Arrhythmia and Electrophysiology': '1941-3149 1941-3084',
        'Circulation: Cardiovascular Imaging': '1941-9651 1942-0080',
        'Circulation: Cardiovascular Interventions': '1941-7640 1941-7632',
        'Circulation: Cardiovascular Quality and Outcomes': '1941-7713 1941-7705',
        'Circulation: Genomic and Precision Medicine': '2574-8300',
        'Circulation: Heart Failure': '1941-3289 1941-3297',
        'Europace': '1099-5129 1532-2092',
        'Heart Rhythm': '1547-5271 1556-3871',
        'Heart Rhythm O2': '2666-5018',
        'European Journal of Heart Failure': '1388-9842 1879-0844',
        'Cardiovascular Research': '0008-6363 1755-3245',
        'International Journal of Cardiology': '0167-5273 1874-1754',
        'Heart': '1355-6037 1468-201X',
        'JAMA Network Open': '2574-3805',
        'JAMA Internal Medicine': '2168-6106 2168-6114',
        'JMIR AI': '2817-1705',
        'JMIR Medical Informatics': '2291-9694',
        'Journal of the American Medical Informatics Association': '1067-5027 1527-974X',
        'Nature Machine Intelligence': '2522-5839',
        'Communications Medicine': '2730-664X',
        'Journal of Cardiovascular Electrophysiology': '1045-3873 1540-8167',
    },
}


def journal_key(name):
    return re.sub(r'[\W_]+', ' ', name.casefold()).strip()


_NAME_TIERS = {journal_key(name): tier for tier, journals in TIER_JOURNALS.items() for name in journals}
_ISSN_TIERS = {issn: tier for tier, journals in TIER_JOURNALS.items()
               for identifiers in journals.values() for issn in identifiers.split()}
PRIORITY_ISSNS = tuple(sorted(_ISSN_TIERS))
_ISO_NAMES = {
    'ann intern med': 'Annals of Internal Medicine', 'jama cardiol': 'JAMA Cardiology',
    'nat med': 'Nature Medicine', 'nat rev cardiol': 'Nature Reviews Cardiology',
    'eur heart j': 'European Heart Journal', 'eur heart j digit health': 'European Heart Journal - Digital Health',
    'j am coll cardiol': 'JACC', 'j am heart assoc': 'Journal of the American Heart Association',
    'circ res': 'Circulation Research', 'circ rep': 'Circulation Reports',
    'circ arrhythm electrophysiol': 'Circulation: Arrhythmia and Electrophysiology',
    'circ cardiovasc imaging': 'Circulation: Cardiovascular Imaging',
    'circ cardiovasc interv': 'Circulation: Cardiovascular Interventions',
    'circ cardiovasc qual outcomes': 'Circulation: Cardiovascular Quality and Outcomes',
    'circ genom precis med': 'Circulation: Genomic and Precision Medicine',
    'circ heart fail': 'Circulation: Heart Failure',
    'jacc basic transl sci': 'JACC: Basic to Translational Science',
    'jacc cardiovasc imaging': 'JACC: Cardiovascular Imaging',
    'jacc cardiovasc interv': 'JACC: Cardiovascular Interventions',
    'jacc clin electrophysiol': 'JACC: Clinical Electrophysiology',
    'jacc heart fail': 'JACC: Heart Failure',
    'heartrhythm': 'Heart Rhythm', 'eur j heart fail': 'European Journal of Heart Failure',
    'cardiovasc res': 'Cardiovascular Research', 'int j cardiol': 'International Journal of Cardiology',
    'jama intern med': 'JAMA Internal Medicine', 'jmir med inform': 'JMIR Medical Informatics',
    'j am med inform assoc': 'Journal of the American Medical Informatics Association',
    'nat mach intell': 'Nature Machine Intelligence', 'commun med': 'Communications Medicine',
    'commun med lond': 'Communications Medicine',
}
_OTHER_CLINICAL = {
    'american heart journal plus cardiology research and practice', 'annals of medicine', 'bmj open',
    'cardiology research and practice', 'cardiovascular ultrasound', 'clinical cardiology',
    'clinical and translational medicine', 'clinical reviews in allergy immunology',
    'current atherosclerosis reports', 'current cardiology reports', 'diagnostics basel switzerland',
    'eclinicalmedicine', 'egyptian heart journal', 'european heart journal open', 'european stroke journal',
    'frontiers in cardiovascular medicine', 'frontiers in medicine', 'health science reports',
    'immunologic research', 'journal of medical internet research', 'jmir formative research',
    'plos digital health', 'pulmonary circulation', 'renal failure',
}
_CLINICAL_GROUPS = {
    '心律失常与电生理', '心衰与重症心肌', '冠脉介入与结构', '心血管影像与表型',
    '脑血管与高血压', 'AI医疗与数字医学', '心血管综合与其他',
}


def journal_tier(journal_name, doi='', *, issns=()):
    for issn in issns:
        if issn.upper() in _ISSN_TIERS:
            return _ISSN_TIERS[issn.upper()]
    # Exact matches prevent flagship prefixes, e.g. Nature Communications,
    # from inheriting the flagship's tier.
    name = clean_journal_name(journal_name)
    key = journal_key(name)
    key = journal_key(_ISO_NAMES[key]) if key in _ISO_NAMES else key
    if key in _NAME_TIERS:
        return _NAME_TIERS[key]
    if key.startswith('europace european pacing arrhythmias and cardiac electrophysiology'):
        return 2
    if key.startswith('the egyptian heart journal '):
        return 1
    if key in _OTHER_CLINICAL or (name and classify_clinical_tier(name, doi=doi) in _CLINICAL_GROUPS):
        return 1
    return 0


MINOR = {'letter', 'comment', 'editorial', 'news', 'case report', 'case reports',
         'published erratum', 'biography'}
_TRIAL = re.compile(r'\brandomi[sz]ed\b|\bRCT\b|\bphase (?:i{1,3}|iv|[1-4])\b.*\btrial\b', re.I)
_META = re.compile(r'\bsystematic review\b|\bmeta[- ]analys[ie]s\b', re.I)
_GUIDELINE = re.compile(r'\b(?:clinical practice|practice|consensus|management) guideline[s]?\b|'
                        r'\bguideline[s]? for (?:the )?(?:diagnosis|management|treatment|prevention)\b', re.I)
_DESIGN = re.compile(r'prospective|external validation|multicent(?:er|re)|multi[- ]cent(?:er|re)', re.I)


def article_type(pub_types, title):
    types = {s.strip().casefold() for s in pub_types}
    if types & MINOR:
        return 'minor'
    if types & {'guideline', 'practice guideline', 'consensus development conference'} or _GUIDELINE.search(title):
        return 'guideline'
    if types & {'meta-analysis', 'systematic review', 'network meta-analysis'} or _META.search(title):
        return 'meta'
    if types & {'randomized controlled trial', 'controlled clinical trial', 'clinical trial', 'pragmatic clinical trial'} or \
            any(t.startswith('clinical trial, phase ') for t in types) or _TRIAL.search(title):
        return 'trial'
    return 'review' if 'review' in types or re.search(r'\b(?:scoping|narrative|literature) review\b', title, re.I) else 'original'


def design_points(candidate):
    text = candidate['title'] + ' ' + candidate.get('abstractText', '')
    return 4 if _TRIAL.search(text) or _META.search(text) else 2 if _DESIGN.search(text) else 0


def priority(candidate, board_rank=None, *, today):
    tier = journal_tier(candidate.get('journal', ''), candidate.get('doi', ''), issns=candidate.get('issns', ()))
    article = article_type(candidate.get('pubTypes', ()), candidate['title'])
    topic = candidate.get('topic', '')
    age = (today - date.fromisoformat(candidate['date'])).days
    parts = [
        (f'journal:{tier}', tier * 80),
        (f'article:{article}', {'guideline': 20, 'trial': 15, 'meta': 15, 'original': 8, 'review': 3, 'minor': 0}[article]),
        (f'topic:{topic}', {'心血管 × AI': 10, '心血管': 5, 'AI 医疗': 5}.get(topic, 0)),
        (f'board:{board_rank}', 20 + max(0, 25 - board_rank) if board_rank else 0),
        ('recency:14' if age <= 14 else 'recency:30', 8 if 0 <= age <= 14 else 4 if 14 < age <= 30 else 0),
        ('design', design_points(candidate)),
    ]
    return sum(points for _, points in parts), [reason for reason, points in parts if points]
