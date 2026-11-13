"""Journal-specific PubMed coverage from the existing bounded public cache.

Publisher fetch health stays independent of fallback evidence. Never infer a
successful fallback from configuration alone or a zero-result truncated query.
"""
import datetime
import hashlib
import re
from enrich_metadata import clean_journal_name

ALIASES = {
    'NPJ Digital Medicine': 'npj Digital Medicine',
    'EHJ - Cardiovascular Pharmacotherapy': 'European Heart Journal - Cardiovascular Pharmacotherapy',
    'EHJ- Digital Health Advance Access': 'European Heart Journal - Digital Health',
    'EHJ: Advance Access': 'European Heart Journal',
    'JAMA Cardiology Current Issue': 'JAMA Cardiology',
    'JAMA Cardiology Online First': 'JAMA Cardiology',
    'JAMA Network Open New Online': 'JAMA Network Open',
    'JACC: CE': 'JACC: Clinical Electrophysiology',
    'JACC: Cardio Imaging': 'JACC: Cardiovascular Imaging',
    'Circ Heart Failure': 'Circulation Heart Failure',
    'Circulation: CQO': 'Circulation Cardiovascular Quality and Outcomes',
    'Progress in Cardio Dis': 'Progress in Cardiovascular Diseases',
    'Heart Online First': 'Heart',
}
ADDITIONAL_JOURNALS = ('Nature Reviews Cardiology', 'Nature Aging', 'Nature Cancer',
                       'Communications Medicine', 'Nature Reviews Psychology',
                       'Nature Communications', 'Nature Machine Intelligence', 'npj Health Systems')
# Health-systems research is already within the medical watch scope. A narrow
# AI/cardio word list excludes relevant agentic health-data articles.
TOPIC_SCOPED_JOURNALS = set(ADDITIONAL_JOURNALS) - {'Nature Reviews Cardiology', 'Communications Medicine', 'npj Health Systems'}
TOPIC_TERM = '(' + ' OR '.join('"' + term + '"[Title/Abstract]' for term in
    ('cardiovascular', 'cardiac', 'coronary', 'atrial', 'heart failure', 'hypertension',
     'stroke', 'artificial intelligence', 'machine learning', 'deep learning',
     'large language model')) + ')'


def journal_key(value):
    value = clean_journal_name(str(value or '')).lower()
    known = {'heart (british cardiac society)': 'heart',
             'journal of the american college of cardiology': 'jacc',
             'the new england journal of medicine': 'n engl j med'}
    if value.startswith('europace :'):
        value = 'europace'
    return re.sub(r'[^a-z0-9]', '', known.get(value, value))


def journal_query(journal):
    term = '"' + journal + '"[Journal]'
    return '(' + term + ' AND ' + TOPIC_TERM + ')' if journal in TOPIC_SCOPED_JOURNALS else term


def snapshot_query_scope(journal, query):
    """Describe the stored journal clause, never today's query configuration."""
    if not isinstance(query, str) or not query.strip():
        return 'unknown'
    term = re.escape('"' + journal + '"[Journal]')
    scoped = re.search(term + r'\s+AND\s+\(([^()]*)\)', query, re.I)
    if scoped:
        constraint = scoped.group(1)
        if re.sub(r'\s+', ' ', constraint).casefold() == TOPIC_TERM[1:-1].casefold():
            return 'cardiovascular_or_ai'
        date_window = r'"\d{4}/\d{2}/\d{2}"\[Date - Publication\]\s*:\s*"\d{4}/\d{2}/\d{2}"\[Date - Publication\]'
        return 'journal' if re.fullmatch(date_window, constraint.strip(), re.I) else 'unknown'
    return 'journal' if re.search(term + r'\s*(?=\)|OR\b|$)', query, re.I) else 'unknown'


def coverage(source, pubmed, now):
    journal = clean_journal_name(ALIASES.get(source['name'], source['name']))
    key = journal_key(journal)
    configured = key in {journal_key(j) for j in pubmed.get('journals', [])}
    rows = [row for row in pubmed.get('items', []) if key in
            {journal_key(row.get('journal')), journal_key(row.get('journalAbbreviation'))}]
    rows = {row.get('pmid') or row.get('id'): row for row in rows if row.get('pmid') or row.get('id')}.values()
    eligible = 0
    today = now.astimezone(datetime.timezone(datetime.timedelta(hours=8))).date()
    for row in rows:
        date = row.get('date', '')
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
            continue
        try:
            day = datetime.date.fromisoformat(date)
        except ValueError:
            continue
        # Match reader-facing calendar days; retain actual publication dates.
        if today - datetime.timedelta(days=13) <= day <= today:
            eligible += 1
    try:
        stamp = datetime.datetime.fromisoformat(str(pubmed.get('updatedAt', '')).replace('Z', '+00:00'))
        stale = stamp.tzinfo is None or not datetime.timedelta(0) <= now - stamp <= datetime.timedelta(hours=6)
        checked_at = stamp.isoformat() if stamp.tzinfo is not None else None
    except ValueError:
        stale = True
        checked_at = None
    query = pubmed.get('query')
    return {'provider': 'PubMed', 'journal': journal, 'configured': configured,
            'observedItems': len(rows), 'eligibleItems': eligible,
            'checkedAt': checked_at, 'queryTruncated': pubmed.get('truncated') is True,
            'stale': stale, 'queryScope': snapshot_query_scope(journal, query),
            'queryHash': hashlib.sha256(query.encode()).hexdigest() if isinstance(query, str) and query.strip() else None,
            'status': 'records_observed' if rows else 'no_records_observed' if configured else 'not_configured'}


PUBMED_FETCH_FIELDS = {'status', 'httpStatus', 'errorCategory', 'checkedAt',
                       'reusedPrevious', 'cachedItems', 'previousUpdatedAt'}
PUBMED_FETCH_STATUSES = {'ok', 'failed'}
PUBMED_FETCH_ERROR_CATEGORIES = {
    'pubmed_upstream_timeout',
    'pubmed_http_429',
    'pubmed_http_5xx',
    'pubmed_network_error',
    'pubmed_upstream_error',
    'pubmed_client_error',
}


def public_pubmed_fetch(record):
    """Allowlisted PubMed fetch outcome for source-health. No query, IDs or keys."""
    if not isinstance(record, dict):
        return None
    status = record.get('status')
    if status not in PUBMED_FETCH_STATUSES:
        return None
    out = {'status': status}
    checked = record.get('checkedAt')
    if isinstance(checked, str) and checked.strip():
        out['checkedAt'] = checked
    if status != 'failed':
        return out
    category = record.get('errorCategory')
    if category in PUBMED_FETCH_ERROR_CATEGORIES:
        out['errorCategory'] = category
    http_status = record.get('httpStatus')
    if type(http_status) is int and 100 <= http_status <= 599:
        out['httpStatus'] = http_status
    if record.get('reusedPrevious') is True:
        out['reusedPrevious'] = True
    if type(record.get('cachedItems')) is int and record['cachedItems'] >= 0:
        out['cachedItems'] = record['cachedItems']
    previous = record.get('previousUpdatedAt')
    if isinstance(previous, str) and previous.strip():
        out['previousUpdatedAt'] = previous
    return out


def apply_pubmed_fetch(fallback, pubmed_fetch):
    """Mark reused fallback evidence stale when this round's PubMed fetch failed."""
    public = public_pubmed_fetch(pubmed_fetch)
    if not public or public.get('status') != 'failed':
        return fallback
    out = dict(fallback)
    out['stale'] = True
    out['fetchStatus'] = 'failed'
    if 'errorCategory' in public:
        out['errorCategory'] = public['errorCategory']
    if 'httpStatus' in public:
        out['httpStatus'] = public['httpStatus']
    if public.get('reusedPrevious') is True:
        out['reusedPrevious'] = True
    return out
