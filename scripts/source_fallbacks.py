"""Journal-specific PubMed coverage from the existing bounded public cache.

Publisher fetch health stays independent of fallback evidence. Never infer a
successful fallback from configuration alone or a zero-result truncated query.
"""
import datetime
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
TOPIC_SCOPED_JOURNALS = set(ADDITIONAL_JOURNALS) - {'Nature Reviews Cardiology', 'Communications Medicine'}
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
    return {'provider': 'PubMed', 'journal': journal, 'configured': configured,
            'observedItems': len(rows), 'eligibleItems': eligible,
            'checkedAt': checked_at, 'queryTruncated': pubmed.get('truncated') is True,
            'stale': stale, 'queryScope': 'cardiovascular_or_ai' if journal in TOPIC_SCOPED_JOURNALS else 'journal',
            'status': 'records_observed' if rows else 'no_records_observed' if configured else 'not_configured'}
