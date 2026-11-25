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
    'pubmed_time_budget_exceeded',
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


CROSSREF_FETCH_STATUSES = {'ok', 'degraded', 'skipped', 'failed'}
CROSSREF_ERROR_CATEGORIES = {
    'crossref_http_429',
    'crossref_http_5xx',
    'crossref_http_error',
    'crossref_timeout',
    'crossref_network_error',
    'crossref_parse_error',
    'crossref_time_budget_exceeded',
    'crossref_network_disabled',
}


def public_crossref_fallback(record):
    """Allowlisted per-journal Crossref fallback metrics for source-health."""
    if not isinstance(record, dict):
        return None
    status = record.get('status')
    if status not in CROSSREF_FETCH_STATUSES:
        return None
    out = {'provider': 'Crossref', 'status': status}
    if isinstance(record.get('journal'), str) and record['journal'].strip():
        out['journal'] = record['journal'].strip()
    if isinstance(record.get('issns'), list):
        issns = [str(x).strip() for x in record['issns'] if isinstance(x, str) and x.strip()]
        if issns:
            out['issns'] = issns
    if isinstance(record.get('triggered'), bool):
        out['triggered'] = record['triggered']
    for key in ('apiCalls', 'pagesFetched', 'observedItems', 'excludedImpreciseDate'):
        val = record.get(key)
        if type(val) is int and val >= 0:
            out[key] = val
    if isinstance(record.get('checkedAt'), str) and record['checkedAt'].strip():
        out['checkedAt'] = record['checkedAt']
    if record.get('errorCategory') in CROSSREF_ERROR_CATEGORIES:
        out['errorCategory'] = record['errorCategory']
    http_status = record.get('httpStatus')
    if type(http_status) is int and 100 <= http_status <= 599:
        out['httpStatus'] = http_status
    if record.get('reusedPrevious') is True:
        out['reusedPrevious'] = True
    return out


def public_crossref_fetch(record):
    """Allowlisted top-level Crossref fallback call summary for source-health."""
    if not isinstance(record, dict):
        return None
    status = record.get('status')
    if status not in CROSSREF_FETCH_STATUSES:
        return None
    out = {'status': status}
    if isinstance(record.get('checkedAt'), str) and record['checkedAt'].strip():
        out['checkedAt'] = record['checkedAt']
    for key in ('apiCalls', 'pagesFetched', 'itemsFetched'):
        val = record.get(key)
        if type(val) is int and val >= 0:
            out[key] = val
    if isinstance(record.get('degraded'), bool):
        out['degraded'] = record['degraded']
    if isinstance(record.get('triggeredJournals'), list):
        out['triggeredJournals'] = [str(j) for j in record['triggeredJournals'] if isinstance(j, str) and j.strip()]
    if isinstance(record.get('journals'), list):
        journals = [public_crossref_fallback(row) for row in record['journals']]
        out['journals'] = [row for row in journals if row]
    return out


STALE_FEED_DAYS = 14
STALE_ELIGIBLE_STATUSES = {'ok', 'empty_feed', 'filtered_empty', 'stale_feed'}


def _parse_iso_day(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if not re.match(r'^\d{4}-\d{2}-\d{2}', text):
        return None
    try:
        return datetime.date.fromisoformat(text[:10])
    except ValueError:
        return None


def _alternative_latest_dates(items, today, *, days=STALE_FEED_DAYS, use_abbrev=False):
    latest = {}
    for row in items or ():
        if not isinstance(row, dict):
            continue
        precision = row.get('datePrecision')
        if precision is not None and precision != 'day':
            continue
        day = _parse_iso_day(row.get('date'))
        if day is None:
            continue
        age = (today - day).days
        if not 0 <= age <= days:
            continue
        keys = {journal_key(row.get('journal'))}
        if use_abbrev:
            keys.add(journal_key(row.get('journalAbbreviation')))
        keys.discard('')
        for key in keys:
            prev = latest.get(key)
            if prev is None or day > prev:
                latest[key] = day
    return latest


def public_stale_feed(record):
    """Allowlisted stale_feed metadata for source-health."""
    if not isinstance(record, dict):
        return None
    latest = record.get('latestItemDate')
    alt_source = record.get('alternativeSource')
    alt_date = record.get('alternativeLatestDate')
    if _parse_iso_day(latest) is None or _parse_iso_day(alt_date) is None:
        return None
    if alt_source not in {'PubMed', 'Crossref'}:
        return None
    out = {
        'latestItemDate': latest[:10],
        'alternativeSource': alt_source,
        'alternativeLatestDate': alt_date[:10],
    }
    age = record.get('ageDays')
    if type(age) is int and age > 0:
        out['ageDays'] = age
    return out


def detect_stale_feeds(health, pubmed, crossref=None, *, now=None, stale_days=STALE_FEED_DAYS):
    """Mark RSS sources whose latest item is >14d old while PubMed or Crossref has <=14d items.

    Never disables any feed; observational status only. Returns count of marked sources.
    """
    from collections import Counter
    from urllib.parse import urlsplit

    if not isinstance(health, dict) or not isinstance(health.get('sources'), list):
        return 0
    now = now or datetime.datetime.now(datetime.timezone.utc)
    today = now.astimezone(datetime.timezone.utc).date()
    pm_latest = _alternative_latest_dates((pubmed or {}).get('items'), today, days=stale_days, use_abbrev=True)
    cr_latest = _alternative_latest_dates((crossref or {}).get('items'), today, days=stale_days, use_abbrev=False)

    marked = 0
    for row in health['sources']:
        if not isinstance(row, dict):
            continue
        try:
            host = (urlsplit(str(row.get('url') or '')).hostname or '').lower()
        except ValueError:
            host = ''
        if host == 'pubmed.ncbi.nlm.nih.gov':
            continue
        if row.get('status') not in STALE_ELIGIBLE_STATUSES:
            continue
        rss_day = _parse_iso_day(row.get('latestPublishedAt'))
        if rss_day is None:
            continue
        age_days = (today - rss_day).days
        if age_days <= stale_days:
            continue
        name = row.get('name') or row.get('source') or ''
        journal = clean_journal_name(ALIASES.get(name, name))
        key = journal_key(journal)
        if not key:
            continue
        pm_day = pm_latest.get(key)
        cr_day = cr_latest.get(key)
        if pm_day is None and cr_day is None:
            continue
        if pm_day is not None and (cr_day is None or pm_day >= cr_day):
            alt_source, alt_day = 'PubMed', pm_day
        else:
            alt_source, alt_day = 'Crossref', cr_day
        row['status'] = 'stale_feed'
        row['staleFeed'] = {
            'latestItemDate': rss_day.isoformat(),
            'alternativeSource': alt_source,
            'alternativeLatestDate': alt_day.isoformat(),
            'ageDays': age_days,
        }
        marked += 1

    if marked:
        health['summary'] = dict(Counter(r.get('status') for r in health['sources'] if isinstance(r, dict) and r.get('status')))
    return marked


DEFAULT_PUBLIC_WINDOW_DAYS = 14
_PUBLIC_WINDOW_MAPS = {}


def _public_window_map(path=None):
    """Map journal_key -> windowDays for allowlisted journals that opt into a longer public catch-up."""
    from pathlib import Path as _Path
    import json
    target = (_Path(path) if path else _Path(__file__).resolve().parents[1] / 'config/crossref_fallback.json').resolve()
    cached = _PUBLIC_WINDOW_MAPS.get(target)
    if cached is not None:
        return cached
    mapping = {}
    try:
        data = json.loads(target.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        _PUBLIC_WINDOW_MAPS[target] = mapping
        return mapping
    for row in (data.get('journals') or []) if isinstance(data, dict) else []:
        if not isinstance(row, dict):
            continue
        days = row.get('windowDays')
        if type(days) is not int or days < DEFAULT_PUBLIC_WINDOW_DAYS:
            continue
        names = [row.get('journal'), *(row.get('aliases') or [])]
        for name in names:
            key = journal_key(name or '')
            if key:
                mapping[key] = days
    _PUBLIC_WINDOW_MAPS[target] = mapping
    return mapping


def public_window_days(journal, default=DEFAULT_PUBLIC_WINDOW_DAYS, path=None):
    """Public RSS/merge/Crossref window for a journal; default remains 14 days."""
    if type(default) is not int or default < 1:
        default = DEFAULT_PUBLIC_WINDOW_DAYS
    key = journal_key(journal or '')
    if not key:
        return default
    return _public_window_map(path).get(key, default)


def reset_public_window_cache():
    """Test helper: drop the cached per-journal public window maps."""
    _PUBLIC_WINDOW_MAPS.clear()
