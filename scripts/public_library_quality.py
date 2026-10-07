"""Reviewed, finite corrections to public bibliography only; no source/PDF I/O.

Raw approved snapshots and their ID-retention guards stay intact. Public omissions
and aliases are explicit in a local audit, never inferred from missing identifiers.
"""
import copy

from apply_public_library import DERIVED_FIELDS
from sync_public_library import PUBLIC_FIELDS, normalize_doi, normalize_pmid, public_text

QUALITY_FIELDS = {'onlineDate', 'issueDate', 'issueDateBasis', 'issueDatePrecision',
                  'volume', 'issue', 'publicationStatus', 'bibliographicEvidenceUrl'}
PROJECT_FIELDS = PUBLIC_FIELDS | DERIVED_FIELDS | QUALITY_FIELDS | {
    'dateConfidence', 'hasDraft', 'draftData', 'abstractStatus', 'abstractSource', 'abstractSourceUrl', 'nonAbstractMetadata'}
AUDIT_FIELDS = {'id', 'title', 'journal', 'doi', 'pmid', 'url', 'date', 'dateBasis', 'datePrecision'}
NAVIGATION = {
    'c7991c9cd94838c4': ('查看所有期刊 搜索 登录 内容 关于 出版 订阅提醒 RSS订阅', 'Nature Medicine'),
    '82c4998e9b7ccb09': ('查看所有期刊 搜索 登录 内容 关于 发布 注册接收警报 RSS 提要', 'Nature Machine Intelligence'),
    '816ecabbd93dfa60': ('查看所有期刊 搜索 登录 内容 关于 发布 注册接收警报 RSS 提要', 'Nature Machine Intelligence'),
}
AGENTIC_IDS = ('79904b5d153128dc', 'e94e5de9640300e9')
AGENTIC_DOI = '10.1016/j.landig.2026.101010'
AGENTIC_TITLE = 'The rise of the agentic AI colleague'
AGENTIC_FRAGMENT = ('The rise of the agentic AI colleague Artificial intelligence (AI) systems are rapidly '
                    'evolving into of standardised data and the persistence of “information')
AGENTIC_OLD_DOIS = {
    AGENTIC_IDS[0]: '10.1038/s41551-', AGENTIC_IDS[1]: '10.1016/j.landig.2025'}
ONLINE_CORRECTIONS = {
    'a76a3fd5e0e70fd7': ('10.3760/cma.j.cn112139-20260730-00329', '42765414', '2026-09-21'),
    '47e6d48cc22b6000': ('10.3760/cma.j.cn112139-20260603-00245', '42765408', '2026-09-21'),
    'a762c60c31fbd3e2': ('10.1038/s41746-026-03312-y', '', '2026-09-26'),
}


def _hold(code):
    raise ValueError('public_library_quality_hold:' + code)


def _audit(paper):
    return {key: public_text(paper[key]) for key in sorted(AUDIT_FIELDS)
            if key in paper and isinstance(paper[key], str)}


def _official(paper, date, url, basis):
    paper.update(date=date, onlineDate=date, datePrecision='day', dateBasis=basis,
                 metadataStatus='official_bibliography_checked', bibliographicEvidenceUrl=url,
                 basis='公共书目信息已复核 · 私有 PDF 身份未核验 · 未读全文',
                 fulltextStatus='not_verified', localAvailable=False)


def project_public_library(papers):
    """Return public copies plus a public-field-only *local* quarantine audit.

    Only enumerated published IDs can be changed. Neither titles nor missing DOI
    fields establish a private PDF identity. No ingestion timestamps are invented.
    """
    by_id = {}
    for paper in papers:
        if not isinstance(paper, dict) or not isinstance(paper.get('id'), str) or paper['id'] in by_id:
            _hold('duplicate_or_invalid_id')
        by_id[paper['id']] = copy.deepcopy({k: v for k, v in paper.items() if k in PROJECT_FIELDS})
    audit = {'schemaVersion': 1, 'checkedOn': '2026-10-07', 'inputCount': len(papers),
             'quarantined': [], 'aliases': [], 'corrections': [], 'pdfBindingHoldIds': [],
             'scope': 'public_bibliography_only', 'privatePdfBodiesRead': 0}
    for identifier, (title, journal) in NAVIGATION.items():
        paper = by_id.get(identifier)
        if paper is None:
            continue
        if (paper.get('title') != title or paper.get('journal') != journal
                or any(paper.get(key) for key in ('doi', 'pmid', 'url', 'date'))):
            _hold('navigation_identity_changed')
        audit['quarantined'].append({'record': _audit(paper), 'status': 'quarantined',
                                     'reason': 'publisher_navigation_not_article'})
        del by_id[identifier]
    agentic = [by_id[identifier] for identifier in AGENTIC_IDS if identifier in by_id]
    if agentic:
        for paper in agentic:
            doi = normalize_doi(paper.get('doi', ''))
            pmid = normalize_pmid(str(paper.get('pmid') or ''))
            if (doi not in {AGENTIC_OLD_DOIS[paper['id']], AGENTIC_DOI}
                    or pmid not in {'', '41966941'}
                    or paper.get('title') not in {AGENTIC_TITLE, AGENTIC_FRAGMENT}
                    or paper.get('journal') != 'Lancet Digital Health'):
                _hold('agentic_identity_changed')
        if any(p['id'] not in AGENTIC_IDS and (p.get('doi') == AGENTIC_DOI or str(p.get('pmid')) == '41966941')
               for p in by_id.values()):
            _hold('agentic_official_identity_already_present')
        canonical = agentic[0]  # Explicit historical ID priority, never input/title order.
        before = _audit(canonical)
        # Old DOI-keyed content cannot become evidence for the corrected article.
        for key in ('titleZh', 'authors', 'affiliations', 'pubTypes', 'summary', 'abstractSections',
                    'quantitativeMetrics', 'draftData', 'abstractStatus', 'abstractSource',
                    'abstractSourceUrl', 'nonAbstractMetadata'):
            canonical.pop(key, None)
        canonical['hasDraft'] = False
        canonical.update(title=AGENTIC_TITLE, doi=AGENTIC_DOI, pmid='41966941',
                         url='https://doi.org/' + AGENTIC_DOI, issueDate='2026-03',
                         issueDatePrecision='month', issueDateBasis='PubMed JournalIssue/PubDate（已复核）',
                         volume='8', issue='3', publicationStatus='published_online')
        _official(canonical, '2026-04-10', 'https://pubmed.ncbi.nlm.nih.gov/41966941/',
                  'PubMed ArticleDate Electronic（已复核）')
        audit['corrections'].append({'before': before, 'after': _audit(canonical),
                                      'evidenceUrl': canonical['bibliographicEvidenceUrl']})
        audit['pdfBindingHoldIds'].append(canonical['id'])
        for alias in agentic[1:]:
            audit['aliases'].append({'record': _audit(alias), 'canonicalId': canonical['id'],
                                     'status': 'public_bibliographic_duplicate',
                                     'evidenceUrl': canonical['bibliographicEvidenceUrl']})
            del by_id[alias['id']]
    for identifier, (doi, pmid, date) in ONLINE_CORRECTIONS.items():
        paper = by_id.get(identifier)
        if paper is None:
            continue
        if (normalize_doi(paper.get('doi', '')) != doi
                or normalize_pmid(str(paper.get('pmid') or '')) not in {'', pmid}):
            _hold('online_correction_identity_changed')
        before = _audit(paper)
        if pmid:
            if paper.get('journal') != '中华外科杂志' or paper.get('date') not in {'2026-11', date}:
                _hold('surgery_issue_identity_changed')
            # November is the existing indexed issue month, NOT a newly verified
            # online date. PubMed independently confirms 64(11) and Electronic Sep21.
            paper.update(pmid=pmid, issueDate='2026-11', issueDatePrecision='month',
                         issueDateBasis='原公共索引刊期（月精度，月份未独立复核）',
                         volume='64', issue='11', publicationStatus='online_ahead_of_print')
            url = 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/'
            basis = 'PubMed ArticleDate Electronic（已复核）'
        else:
            url = 'https://www.nature.com/articles/s41746-026-03312-y'
            basis = '期刊官网 published-online（已复核）'
            paper['publicationStatus'] = 'published_online'
        _official(paper, date, url, basis)
        audit['corrections'].append({'before': before, 'after': _audit(paper), 'evidenceUrl': url})
    result = sorted(by_id.values(), key=lambda p: (p.get('date') or '', p['id']), reverse=True)
    audit['outputCount'] = len(result)
    audit['withoutDoiOrUrlBefore'] = sum(not p.get('doi') and not p.get('url') for p in papers)
    audit['withoutDoiOrUrlAfter'] = sum(not p.get('doi') and not p.get('url') for p in result)
    return result, audit
