"""Official publication relations and conservative article-role precedence.

Never infer a retracted original from a trial name or a notice title. Original
status requires PubMed types/relations or a checked, identity-matched record.
"""
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LABELS = {
    'retracted': '已撤稿', 'concern': '存在关注声明',
    'retraction_notice': '撤稿声明', 'concern_notice': '关注声明',
    'correction_notice': '更正声明',
}
RELATIONS = {
    'RetractionIn': '撤稿声明', 'RetractionOf': '被撤稿原文',
    'ExpressionOfConcernIn': '关注声明', 'ExpressionOfConcernFor': '关联原文',
    'ErratumIn': '更正声明', 'ErratumFor': '关联原文',
}


def pubmed_relations(article):
    return [{'type': n.get('RefType'), 'pmid': n.findtext('PMID')}
            for n in article.findall('./MedlineCitation/CommentsCorrectionsList/CommentsCorrections')
            if n.get('RefType') in RELATIONS and re.fullmatch(r'[1-9]\d*', n.findtext('PMID') or '')]


def _relations(rows):
    safe = []
    for row in rows or ():
        if not isinstance(row, dict):
            continue
        kind, pmid = row.get('type'), str(row.get('pmid') or '')
        if kind in RELATIONS and re.fullmatch(r'[1-9]\d*', pmid):
            link = {'type': kind, 'pmid': pmid, 'label': RELATIONS[kind],
                    'url': f'https://pubmed.ncbi.nlm.nih.gov/{pmid}/'}
            if link not in safe:
                safe.append(link)
    return safe


def status_from_pubmed(publication_types=(), relations=()):
    types = {str(t).casefold().strip() for t in publication_types or ()}
    related = _relations(relations)
    kinds = {r['type'] for r in related}
    if types & {'retraction notice', 'retraction of publication'} or 'RetractionOf' in kinds:
        return 'retraction_notice'
    if 'expression of concern' in types or 'ExpressionOfConcernFor' in kinds:
        return 'concern_notice'
    if 'published erratum' in types or 'ErratumFor' in kinds:
        return 'correction_notice'
    if 'retracted publication' in types or 'RetractionIn' in kinds:
        return 'retracted'
    if 'ExpressionOfConcernIn' in kinds:
        return 'concern'
    return ''


def article_role(title, publication_types=()):
    """Roles override a randomized phrase, including one in a notice title."""
    text = unicodedata.normalize('NFKC', title or '').casefold()
    types = {str(t).casefold().strip() for t in publication_types or ()}
    state = status_from_pubmed(types)
    if state:
        return LABELS[state]
    if re.match(r'^\s*(?:\[)?retraction\b', text):
        return '撤稿声明'
    if re.match(r'^\s*(?:\[)?expression of concern\b', text):
        return '关注声明'
    if re.match(r'^\s*(?:author correction\b|publisher correction\b|correction(?:\s+to\b|:)|erratum\b)', text):
        return '更正声明'
    if (types & {'clinical trial protocol'} or
            re.search(r'\bprotocol\b|\brationale\s+(?:and|&)\s+(?:study\s+)?design\b|\bstudy design and rationale\b', text)):
        return '研究方案'
    if re.search(r'(?:[-–—:]\s*|\s)reply\s*[.]?$', text):
        return '述评观点'
    if re.search(r'^\s*(?:interpreting|comment on|regarding|response to|lessons from)\b', text) and re.search(r'\btrial\b', text):
        # A title referring to another trial is insufficient to establish this
        # article's design. Checked publisher roles can resolve it at projection.
        return '研究类型待核验'
    return ''


def secondary_analysis(text):
    return bool(re.search(
        r'\bpost[-\s]hoc\b|\b(?:secondary|subgroup|pooled|prespecified|pre[- ]specified) analys(?:is|es)\b|'
        r'\bsub[- ]?stud(?:y|ies)\b|\binsights from\b[^.!?]{0,100}\btrial\b', text, re.I))


def _titlekey(text):
    return re.sub(r'[^\w]', '', unicodedata.normalize('NFKC', text or '').casefold())


def checked_records(root):
    path = Path(root) / 'config/publication-status.json'
    stat = path.stat()
    return _checked_records(str(path), stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=8)
def _checked_records(path, mtime_ns, size):
    data = json.loads(Path(path).read_text())
    if type(data.get('schemaVersion')) is not int or data['schemaVersion'] != 1:
        raise ValueError('Unsupported publication status registry')
    records = data.get('records')
    if not isinstance(records, list):
        raise ValueError('Invalid publication status registry records')
    seen = set()
    for record in records:
        if (not isinstance(record, dict) or
                not re.fullmatch(r'[1-9]\d*', str(record.get('pmid') or '')) or
                not isinstance(record.get('title'), str) or not record['title'] or
                not re.fullmatch(r'10\.\d{4,9}/[^\s?#]+', record.get('doi') or '') or
                not isinstance(record.get('pubTypes'), list) or
                not all(isinstance(t, str) for t in record['pubTypes']) or
                not isinstance(record.get('relations'), list) or
                record.get('articleRole') not in (None, '述评观点') or
                record['pmid'] in seen):
            raise ValueError('Invalid publication status record')
        seen.add(record['pmid'])
    return records


def checked_record(paper, root=ROOT):
    # Unit callers may project a synthetic paper without a registry. The complete
    # release builder requires the registry before touching any public outputs.
    if not (Path(root) / 'config/publication-status.json').is_file():
        return None
    pmid = str(paper.get('pmid') or '')
    if not pmid:
        match = re.fullmatch(r'pmid-(\d+)', str(paper.get('id') or ''))
        pmid = match[1] if match else ''
    doi = str(paper.get('doi') or '').casefold().strip().removeprefix('https://doi.org/')
    for record in checked_records(str(root)):
        if (pmid and pmid == record['pmid']) or (not pmid and doi and doi == record['doi']):
            # Conflicting identifiers must not spread a status to a different article.
            if _titlekey(paper.get('title')) != _titlekey(record['title']):
                return None
            if doi and doi != record['doi']:
                return None
            return record
    return None


def annotate_publication(paper, root=ROOT):
    """Return public status derived from authoritative fields, never raw status objects."""
    from enrich_metadata import classify_study_design
    out = dict(paper)
    out.pop('publicationStatus', None)
    record = checked_record(paper, root)
    # The checked snapshot supplies missing legacy relations; it must not hide
    # a later official retraction/concern carried by newly fetched metadata.
    types = list(paper.get('pubTypes') or ()) + (record['pubTypes'] if record else [])
    relations = list(paper.get('pubmedRelations') or ()) + (record['relations'] if record else [])
    state = status_from_pubmed(types, relations)
    out['studyDesign'] = (LABELS[state] if state else
                          record.get('articleRole') if record and record.get('articleRole') else
                          classify_study_design(paper.get('title'), paper.get('summary', ''), types))
    if state:
        pmid = record['pmid'] if record else str(paper.get('pmid') or '')
        out['publicationStatus'] = {'state': state, 'label': LABELS[state],
                                    'sourceUrl': f'https://pubmed.ncbi.nlm.nih.gov/{pmid}/' if re.fullmatch(r'[1-9]\d*', pmid) else '',
                                    'related': _relations(relations)}
    return out
