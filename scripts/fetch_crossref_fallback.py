#!/usr/bin/env python3
"""Crossref journal-level incremental fallback for allowlisted journals whose publisher RSS failed.

Only explicitly allowlisted journals in config/crossref_fallback.json are eligible,
and only when their non-PubMed publisher feed failed in the current source-health run.
Network errors, HTTP 429, and timeouts degrade gracefully without failing the pipeline.
"""
import argparse
import datetime
import hashlib
import http.client
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from abstract_quality import abstract_fields, normalize_paper
from build_data import classify
from refresh_feeds import load_previous, safe_url, write_json_js
from source_fallbacks import journal_key, public_crossref_fallback, public_crossref_fetch
from text_hygiene import clean_inline

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / 'config/crossref_fallback.json'
API = 'https://api.crossref.org/works'
DEFAULT_MAILTO = 'shijunxia1988@gmail.com'
SELECT_FIELDS = (
    'DOI,title,published,published-online,published-print,issued,'
    'type,container-title,abstract,author,update-to,relation,URL'
)
DOI_RE = re.compile(r'^10\.\d{4,9}/\S+$')
ISSN_RE = re.compile(r'^\d{4}-\d{3}[\dXx]$')
MAX_PAGES = 3
ROWS_PER_PAGE = 100
REQUEST_TIMEOUT = 12
PAUSE_SECONDS = 0.5
DEFAULT_TIME_BUDGET = 45
WINDOW_DAYS = 14
FAILED_PUBLISHER_STATUSES = {
    'not_feed', 'http_error', 'parse_error', 'network_error', 'not_checked_host_blocked',
    # Official RSS parsed but lagged behind PubMed/Crossref, or produced no in-window items.
    'stale_feed', 'filtered_empty',
}
EXCLUDED_CROSSREF_TYPES = frozenset({
    'component', 'proceedings-article', 'proceedings', 'peer-review',
    'journal', 'journal-issue', 'journal-volume', 'book-chapter', 'book-part',
    'book-section', 'posted-content', 'dataset', 'report-component', 'entry',
})
# Meeting abstracts (AHA Scientific Sessions) land as journal-article with suppl DOIs.
MEETING_ABSTRACT_DOI_RE = re.compile(r'(?i)(?:\.suppl(?:ement)?[_-]?\d*|/suppl[_-]?\d*|circ\.\d+\.suppl)')
MEETING_ABSTRACT_TITLE_RE = re.compile(r'(?i)^\s*abstract(?:s)?(?:\s+\d+|(?:\s+from\b))')
MEETING_ABSTRACT_ISSUE_RE = re.compile(r'(?i)^\s*suppl')
# Elsevier issue-level objects (Full Issue PDF, Editorial Board) use an S-ISSN DOI.
ISSUE_COMPONENT_DOI_RE = re.compile(r'(?i)^10\.1016/s\d{4}-\d{3}[0-9x]\(')
ISSUE_COMPONENT_TITLE_RE = re.compile(
    r'(?i)^\s*(full issue pdf|editorial board|cover(?: image)?|table of contents|masthead)\s*$'
)


class CrossrefBudgetExceeded(RuntimeError):
    """Total time budget for the Crossref fallback step was reached."""


def resolve_mailto():
    raw = os.environ.get('XINZHI_CROSSREF_MAILTO', '').strip()
    return raw if '@' in raw else DEFAULT_MAILTO


def crossref_headers(mailto=None):
    email = mailto or resolve_mailto()
    return {'User-Agent': f'XinZhiLearningPilot/0.2 (public journal metadata; mailto:{email})'}


def load_allowlist(path=None):
    target = Path(path) if path else CONFIG_PATH
    data = json.loads(target.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('journals'), list):
        raise ValueError('crossref_fallback.json must be version 1 with a journals list')
    entries = []
    for row in data['journals']:
        if not isinstance(row, dict):
            raise ValueError('crossref_fallback.json journal entry must be an object')
        journal = clean_inline(row.get('journal', ''))
        issns = [str(x).strip().upper() for x in (row.get('issns') or []) if str(x).strip()]
        category = str(row.get('category') or '待分类').strip()
        if not journal or not issns or any(not ISSN_RE.fullmatch(issn) for issn in issns):
            raise ValueError(f'crossref_fallback.json invalid journal or ISSN for {journal!r}')
        aliases = [clean_inline(a) for a in (row.get('aliases') or []) if clean_inline(a)]
        prefixes = []
        for raw in (row.get('includeDoiPrefixes') or []):
            prefix = str(raw or '').strip().lower()
            if prefix:
                prefixes.append(prefix)
        window_override = row.get('windowDays')
        if window_override is not None and (type(window_override) is not int or window_override < WINDOW_DAYS):
            raise ValueError(f'crossref_fallback.json windowDays must be >= {WINDOW_DAYS} for {journal!r}')
        complement = row.get('complement')
        if complement is not None and complement not in (True, False):
            raise ValueError(f'crossref_fallback.json complement must be a boolean for {journal!r}')
        entries.append({
            'journal': journal,
            'issns': issns,
            'category': category,
            'aliases': aliases,
            'includeDoiPrefixes': prefixes,
            # Crossref `query` is a loose bibliographic match. Only send it when it
            # actually narrows the window (Circulation sessions abstracts). For
            # Elsevier stems such as 10.1016/j.jacbts it can return 0 hits.
            'queryDoiPrefixes': row.get('queryDoiPrefixes') is True,
            'enabled': row.get('enabled') is True,
            'windowDays': window_override,
            'complement': complement is True,
        })
    return entries


def is_pubmed_hosted(url):
    try:
        return (urlsplit(str(url or '')).hostname or '').lower() == 'pubmed.ncbi.nlm.nih.gov'
    except ValueError:
        return False


def doi_prefix_query(entry):
    """Build a Crossref query that keeps allowlisted DOI prefixes, or None."""
    prefixes = entry.get('includeDoiPrefixes') or []
    if not prefixes:
        return None
    parts = []
    for prefix in prefixes:
        token = prefix.rstrip('.').upper()
        if token:
            parts.append(token)
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return '(' + ' OR '.join(parts) + ')'


def _crossref_title(work):
    titles = work.get('title') if isinstance(work, dict) else None
    if isinstance(titles, list) and titles:
        return clean_inline(titles[0] or '')
    return clean_inline(titles or '')


def exclusion_reason(work, entry=None):
    """Return a stable reason when a Crossref work should not enter the public feed.

    Conference abstracts and issue-level component objects are often typed as
    journal-article, so DOI / title / issue checks sit alongside the type list.
    """
    if not isinstance(work, dict):
        return 'invalid'
    work_type = str(work.get('type') or '').strip()
    if work_type and work_type in EXCLUDED_CROSSREF_TYPES:
        return 'excluded_type'
    if work_type and work_type != 'journal-article':
        return 'excluded_type'
    doi = str(work.get('DOI') or '').strip().lower()
    title = _crossref_title(work)
    issue = str(work.get('issue') or '').strip()
    if ISSUE_COMPONENT_DOI_RE.search(doi) or ISSUE_COMPONENT_TITLE_RE.match(title):
        return 'excluded_component'
    if (MEETING_ABSTRACT_DOI_RE.search(doi) or MEETING_ABSTRACT_TITLE_RE.match(title)
            or MEETING_ABSTRACT_ISSUE_RE.match(issue)):
        return 'meeting_abstract'
    prefixes = (entry or {}).get('includeDoiPrefixes') or []
    if prefixes and doi and not any(doi.startswith(prefix) for prefix in prefixes):
        return 'excluded_doi_prefix'
    return ''


def failed_publisher_sources(health):
    """Map journal_key -> failed non-PubMed publisher source rows from source-health."""
    failed = {}
    for row in (health or {}).get('sources', []):
        if not isinstance(row, dict):
            continue
        if is_pubmed_hosted(row.get('url', '')):
            continue
        if row.get('status') not in FAILED_PUBLISHER_STATUSES:
            continue
        name = row.get('name') or row.get('source') or ''
        key = journal_key(name)
        if key:
            failed.setdefault(key, []).append(row)
    return failed


def ok_publisher_sources(health):
    """Map journal_key -> successful non-PubMed publisher source rows (status ok)."""
    ok = {}
    for row in (health or {}).get('sources', []):
        if not isinstance(row, dict):
            continue
        if is_pubmed_hosted(row.get('url', '')):
            continue
        if row.get('status') != 'ok':
            continue
        name = row.get('name') or row.get('source') or ''
        key = journal_key(name)
        if key:
            ok.setdefault(key, []).append(row)
    return ok


def extract_crossref_publication_date(work):
    """Return day-precision date from published-online > published > issued, or None."""
    if not isinstance(work, dict):
        return None
    for field, basis in (
        ('published-online', 'Crossref published-online'),
        ('published', 'Crossref published'),
        ('issued', 'Crossref issued'),
    ):
        node = work.get(field)
        if not isinstance(node, dict):
            continue
        parts_list = node.get('date-parts')
        if not isinstance(parts_list, list) or not parts_list:
            continue
        parts = parts_list[0]
        if not isinstance(parts, list) or len(parts) != 3:
            continue
        if any(isinstance(part, bool) or not isinstance(part, int) for part in parts):
            continue
        year, month, day = parts
        try:
            iso = datetime.date(year, month, day).isoformat()
        except ValueError:
            continue
        return {
            'date': f'{iso}T00:00:00+00:00',
            'datePrecision': 'day',
            'dateBasis': basis,
        }
    return None


def _crossref_authors(work):
    authors = []
    for person in work.get('author') or ():
        if not isinstance(person, dict):
            continue
        name = clean_inline(' '.join(x for x in (person.get('given'), person.get('family')) if x))
        if not name:
            name = clean_inline(person.get('name') or '')
        if name:
            authors.append(name)
    return authors


def normalize_crossref_work(work, entry, *, checked_at, today=None, window_days=WINDOW_DAYS):
    """Convert one Crossref work dict into a candidate item, or return (None, reason)."""
    if not isinstance(work, dict):
        return None, 'invalid'
    blocked = exclusion_reason(work, entry)
    if blocked:
        return None, blocked
    doi = str(work.get('DOI') or '').strip().lower()
    if not DOI_RE.fullmatch(doi):
        return None, 'invalid_doi'
    titles = work.get('title')
    title = clean_inline(titles[0] if isinstance(titles, list) and titles else (titles or ''))
    if not title:
        return None, 'missing_title'
    date_info = extract_crossref_publication_date(work)
    if not date_info:
        return None, 'imprecise_date'
    if today is not None and window_days is not None:
        pub_day = datetime.date.fromisoformat(date_info['date'][:10])
        age = (today - pub_day).days
        if not 0 <= age <= window_days:
            return None, 'outside_window'
    abs_raw = work.get('abstract') or ''
    abs_fields = abstract_fields(abs_raw)
    summary = abs_fields.get('summary') or ''
    category = classify(title, entry['journal'])
    if category == '待分类':
        category = entry.get('category') or '待分类'
    url = safe_url(work.get('URL') or '') or f'https://doi.org/{doi}'
    record = {
        'id': 'crossref-' + hashlib.sha256(doi.encode()).hexdigest()[:16],
        'title': title,
        'url': url,
        'doi': doi,
        'journal': entry['journal'],
        'date': date_info['date'],
        'datePrecision': date_info['datePrecision'],
        'dateBasis': date_info['dateBasis'],
        'category': category,
        'basis': 'Crossref 期刊增量 · 待核验',
        'summary': summary[:12000],
        'summary_truncated': len(summary) > 12000,
        'abstractStatus': abs_fields.get('abstractStatus') or 'missing',
        'sourceId': 'crossref-journal-fallback',
        'sourceUrl': API,
        'fetchedAt': checked_at,
    }
    if abs_fields.get('abstractSections') and len(summary) <= 12000:
        record['abstractSections'] = abs_fields['abstractSections']
    elif record['abstractStatus'] == 'missing':
        record['abstractSections'] = []
    if abs_fields.get('nonAbstractMetadata'):
        record['nonAbstractMetadata'] = abs_fields['nonAbstractMetadata']
    authors = _crossref_authors(work)
    if authors:
        record['authors'] = authors
    if work.get('type'):
        record['type'] = str(work['type'])
    if isinstance(work.get('update-to'), list) and work['update-to']:
        record['update-to'] = work['update-to']
    if isinstance(work.get('relation'), dict) and work['relation']:
        record['relation'] = work['relation']
    return normalize_paper(record), ''


def request_crossref_page(params, *, timeout=REQUEST_TIMEOUT, mailto=None):
    query = urllib.parse.urlencode(params)
    url = f'{API}?{query}'
    req = urllib.request.Request(url, headers=crossref_headers(mailto))
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read(8_000_000).decode('utf-8'))


def classify_crossref_error(exc):
    if isinstance(exc, CrossrefBudgetExceeded):
        return None, 'crossref_time_budget_exceeded'
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code == 429:
            return 429, 'crossref_http_429'
        if 500 <= exc.code <= 599:
            return exc.code, 'crossref_http_5xx'
        return exc.code, 'crossref_http_error'
    if isinstance(exc, TimeoutError):
        return None, 'crossref_timeout'
    if isinstance(exc, urllib.error.URLError) and isinstance(getattr(exc, 'reason', None), TimeoutError):
        return None, 'crossref_timeout'
    if isinstance(exc, (urllib.error.URLError, http.client.HTTPException, OSError)):
        return None, 'crossref_network_error'
    return None, 'crossref_parse_error'



def count_issn_results(entry, *, since_date, until_date, fetcher, mailto=None,
                       deadline=None, clock=time.monotonic, call_counter=None):
    """One cheap Crossref call: ISSN + date window, no DOI prefix query."""
    mailto = mailto or resolve_mailto()
    issn_filter = ','.join(f'issn:{issn}' for issn in entry['issns'])
    params = {
        'filter': f'{issn_filter},from-pub-date:{since_date},until-pub-date:{until_date}',
        'rows': 0,
        'select': 'DOI',
        'mailto': mailto,
    }
    if deadline is not None and clock() >= deadline:
        raise CrossrefBudgetExceeded()
    if call_counter is not None:
        call_counter[0] += 1
    payload = fetcher(params)
    msg = payload.get('message') if isinstance(payload, dict) else None
    if not isinstance(msg, dict):
        raise ValueError('Invalid Crossref response payload')
    total = msg.get('total-results')
    return total if isinstance(total, int) else None


def fetch_journal_works(entry, *, since_date, until_date, fetcher=request_crossref_page,
                        mailto=None, max_pages=MAX_PAGES, rows=ROWS_PER_PAGE,
                        pause=PAUSE_SECONDS, sleep=time.sleep, deadline=None, clock=time.monotonic,
                        call_counter=None):
    """Fetch up to max_pages of Crossref works for one allowlisted journal using cursor pagination."""
    mailto = mailto or resolve_mailto()
    issn_filter = ','.join(f'issn:{issn}' for issn in entry['issns'])
    base_filter = f'{issn_filter},from-pub-date:{since_date},until-pub-date:{until_date}'
    prefix_query = doi_prefix_query(entry) if entry.get('queryDoiPrefixes') else None
    cursor = '*'
    raw_items = []
    api_calls = 0
    pages_fetched = 0
    seen_raw = 0
    total_results = None
    for page in range(max_pages):
        if deadline is not None and clock() >= deadline:
            raise CrossrefBudgetExceeded()
        if page > 0 and pause > 0:
            if deadline is not None and clock() + pause > deadline:
                raise CrossrefBudgetExceeded()
            sleep(pause)
        params = {
            'filter': base_filter,
            'rows': rows,
            'cursor': cursor,
            'select': SELECT_FIELDS,
            'mailto': mailto,
        }
        if prefix_query:
            params['query'] = prefix_query
        api_calls += 1
        if call_counter is not None:
            call_counter[0] += 1
        payload = fetcher(params)
        pages_fetched += 1
        msg = payload.get('message') if isinstance(payload, dict) else None
        if not isinstance(msg, dict) or not isinstance(msg.get('items'), list):
            raise ValueError('Invalid Crossref response payload')
        batch = msg['items']
        raw_items.extend(batch)
        seen_raw += len(batch)
        total = msg.get('total-results')
        if total_results is None and isinstance(total, int):
            total_results = total
        next_cursor = msg.get('next-cursor')
        if not batch or not next_cursor or next_cursor == cursor:
            break
        if isinstance(total, int) and seen_raw >= total:
            break
        cursor = next_cursor
    return raw_items, api_calls, pages_fetched, total_results


def _previous_items_by_journal(previous_crossref):
    grouped = {}
    for item in (previous_crossref or {}).get('items', []):
        if not isinstance(item, dict):
            continue
        key = journal_key(item.get('journal', ''))
        if key:
            grouped.setdefault(key, []).append(item)
    return grouped


def run(root=ROOT, *, now=None, fetcher=request_crossref_page, sleep=time.sleep,
        clock=time.monotonic, time_budget=DEFAULT_TIME_BUDGET, window_days=WINDOW_DAYS,
        config_path=None, health_path=None, output_path=None, mailto=None, network=None,
        dry_run=False, force_allowlist=False, max_pages=None, write=True):
    root = Path(root)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    checked_at = now.isoformat()
    today = now.astimezone(datetime.timezone.utc).date()
    until_date = today.isoformat()
    if dry_run:
        write = False
    allowlist = load_allowlist(config_path or (root / 'config/crossref_fallback.json'))
    health_file = Path(health_path) if health_path else root / 'data/source-health.json'
    out_file = Path(output_path) if output_path else root / 'data/crossref.json'
    health = load_previous(health_file)
    if not isinstance(health, dict):
        health = {}
    if not isinstance(health.get('sources'), list):
        health['sources'] = []
    previous_crossref = load_previous(out_file)
    prev_by_journal = _previous_items_by_journal(previous_crossref)
    failed_publishers = failed_publisher_sources(health)
    ok_publishers = ok_publisher_sources(health)

    if network is None:
        network = os.environ.get('XINZHI_CROSSREF_FALLBACK', '1') != '0'
    deadline = None if time_budget is None else clock() + float(time_budget)

    all_items = []
    journal_reports = []
    total_api_calls = 0
    total_pages = 0
    rate_limited = False
    degraded = False
    triggered_journals = []

    for entry in allowlist:
        jkey = journal_key(entry['journal'])
        alias_keys = {jkey} | {journal_key(a) for a in entry.get('aliases', [])}
        journal_window = entry.get('windowDays') or window_days
        since_date = (today - datetime.timedelta(days=journal_window)).isoformat()
        triggered = entry['enabled'] and (
            force_allowlist
            or any(k in failed_publishers for k in alias_keys)
            or (entry.get('complement') is True and any(k in ok_publishers for k in alias_keys))
        )
        if not triggered:
            journal_reports.append({
                'journal': entry['journal'],
                'issns': entry['issns'],
                'triggered': False,
                'status': 'skipped',
                'reason': 'disabled' if not entry['enabled'] else 'publisher_not_failed',
                'apiCalls': 0,
                'pagesFetched': 0,
                'observedItems': 0,
                'excludedImpreciseDate': 0,
                'windowDays': journal_window,
            })
            continue

        triggered_journals.append(entry['journal'])
        if not network or rate_limited:
            cached = list(prev_by_journal.get(jkey, ()))
            all_items.extend(cached)
            degraded = degraded or rate_limited
            journal_reports.append({
                'journal': entry['journal'],
                'issns': entry['issns'],
                'triggered': True,
                'status': 'failed' if rate_limited else 'skipped',
                'errorCategory': 'crossref_http_429' if rate_limited else 'crossref_network_disabled',
                'apiCalls': 0,
                'pagesFetched': 0,
                'observedItems': len(cached),
                'reusedPrevious': bool(cached),
                'excludedImpreciseDate': 0,
            })
            continue

        if total_api_calls > 0 and PAUSE_SECONDS > 0:
            if deadline is not None and clock() + PAUSE_SECONDS > deadline:
                cached = list(prev_by_journal.get(jkey, ()))
                all_items.extend(cached)
                degraded = True
                journal_reports.append({
                    'journal': entry['journal'],
                    'issns': entry['issns'],
                    'triggered': True,
                    'status': 'failed',
                    'errorCategory': 'crossref_time_budget_exceeded',
                    'apiCalls': 0,
                    'pagesFetched': 0,
                    'observedItems': len(cached),
                    'reusedPrevious': bool(cached),
                    'excludedImpreciseDate': 0,
                })
                continue
            sleep(PAUSE_SECONDS)

        call_counter = [0]
        try:
            unfiltered_total = None
            if dry_run:
                unfiltered_total = count_issn_results(
                    entry,
                    since_date=since_date,
                    until_date=until_date,
                    fetcher=fetcher,
                    mailto=mailto,
                    deadline=deadline,
                    clock=clock,
                    call_counter=call_counter,
                )
                if PAUSE_SECONDS > 0:
                    if deadline is not None and clock() + PAUSE_SECONDS > deadline:
                        raise CrossrefBudgetExceeded()
                    sleep(PAUSE_SECONDS)
            fetch_kwargs = {}
            if max_pages is not None:
                fetch_kwargs['max_pages'] = max_pages
            raw_works, api_calls, pages_fetched, total_results = fetch_journal_works(
                entry,
                since_date=since_date,
                until_date=until_date,
                fetcher=fetcher,
                mailto=mailto,
                deadline=deadline,
                clock=clock,
                sleep=sleep,
                call_counter=call_counter,
                **fetch_kwargs,
            )
            total_api_calls += api_calls
            total_pages += pages_fetched
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError,
                http.client.HTTPException, OSError, json.JSONDecodeError, ValueError,
                CrossrefBudgetExceeded) as exc:
            http_status, category = classify_crossref_error(exc)
            if category == 'crossref_http_429':
                rate_limited = True
            degraded = True
            attempted = call_counter[0]
            total_api_calls += attempted
            cached = list(prev_by_journal.get(jkey, ()))
            all_items.extend(cached)
            report = {
                'journal': entry['journal'],
                'issns': entry['issns'],
                'triggered': True,
                'status': 'failed',
                'errorCategory': category,
                'apiCalls': attempted,
                'pagesFetched': 0,
                'observedItems': len(cached),
                'reusedPrevious': bool(cached),
                'excludedImpreciseDate': 0,
            }
            if http_status is not None:
                report['httpStatus'] = http_status
            journal_reports.append(report)
            continue

        kept = []
        excluded_counts = {
            'excludedImpreciseDate': 0,
            'excludedOutsideWindow': 0,
            'excludedType': 0,
            'excludedMeetingAbstract': 0,
            'excludedComponent': 0,
            'excludedDoiPrefix': 0,
            'excludedOther': 0,
        }
        reason_map = {
            'imprecise_date': 'excludedImpreciseDate',
            'outside_window': 'excludedOutsideWindow',
            'excluded_type': 'excludedType',
            'meeting_abstract': 'excludedMeetingAbstract',
            'excluded_component': 'excludedComponent',
            'excluded_doi_prefix': 'excludedDoiPrefix',
        }
        for work in raw_works:
            item, reason = normalize_crossref_work(
                work, entry, checked_at=checked_at, today=today, window_days=journal_window
            )
            if item is not None:
                kept.append(item)
            elif reason in reason_map:
                excluded_counts[reason_map[reason]] += 1
            elif reason:
                excluded_counts['excludedOther'] += 1
        all_items.extend(kept)
        journal_reports.append({
            'journal': entry['journal'],
            'issns': entry['issns'],
            'triggered': True,
            'status': 'ok',
            'apiCalls': api_calls,
            'pagesFetched': pages_fetched,
            'rawItems': len(raw_works),
            'totalResults': total_results,
            'observedItems': len(kept),
            'checkedAt': checked_at,
            'windowDays': journal_window,
            **excluded_counts,
        })
        if unfiltered_total is not None:
            journal_reports[-1]['unfilteredTotalResults'] = unfiltered_total

    out_payload = {
        'updatedAt': checked_at,
        'windowDays': window_days,
        'fetched': len(all_items),
        'apiCalls': total_api_calls,
        'pagesFetched': total_pages,
        'degraded': degraded,
        'journals': triggered_journals,
        'journalReports': journal_reports,
        'items': all_items,
    }
    if write:
        out_file.parent.mkdir(parents=True, exist_ok=True)
        out_file.write_text(json.dumps(out_payload, ensure_ascii=False, indent=2), encoding='utf-8')

    if not triggered_journals:
        overall_status = 'skipped'
    elif degraded:
        overall_status = 'degraded'
    else:
        overall_status = 'ok'

    fetch_record = {
        'checkedAt': checked_at,
        'status': overall_status,
        'apiCalls': total_api_calls,
        'pagesFetched': total_pages,
        'itemsFetched': len(all_items),
        'triggeredJournals': triggered_journals,
        'degraded': degraded,
        'journals': [
            {k: v for k, v in rep.items() if k in {
                'journal', 'issns', 'triggered', 'status', 'apiCalls', 'pagesFetched',
                'observedItems', 'excludedImpreciseDate', 'errorCategory', 'httpStatus',
                'reusedPrevious', 'checkedAt',
            }}
            for rep in journal_reports
        ],
    }
    public_fetch = public_crossref_fetch(fetch_record)
    if public_fetch:
        health['crossrefFetch'] = public_fetch

    by_jkey = {journal_key(rep['journal']): rep for rep in journal_reports}
    for row in health['sources']:
        if not isinstance(row, dict) or is_pubmed_hosted(row.get('url', '')):
            continue
        key = journal_key(row.get('name') or row.get('source') or '')
        rep = by_jkey.get(key)
        if rep:
            fb = public_crossref_fallback(rep)
            if fb:
                row['crossrefFallback'] = fb

    if write:
        health_file.parent.mkdir(parents=True, exist_ok=True)
        write_json_js(health_file, 'SOURCE_HEALTH', health)
    return out_payload


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='Skip network calls and reuse cached crossref.json if any')
    parser.add_argument('--time-budget', type=float, default=DEFAULT_TIME_BUDGET)
    parser.add_argument('--window-days', type=int, default=WINDOW_DAYS)
    parser.add_argument('--max-pages', type=int, default=None)
    parser.add_argument('--dry-run', action='store_true',
                        help='Fetch and report counts without writing data/crossref.json or source-health')
    parser.add_argument('--force-allowlist', action='store_true',
                        help='Query every enabled allowlisted journal, even if the publisher RSS did not fail')
    parser.add_argument('--report', default='',
                        help='Optional path for the dry-run JSON report (not written under data/ by default)')
    args = parser.parse_args(argv)
    payload = run(
        ROOT,
        network=False if args.offline else None,
        time_budget=args.time_budget,
        window_days=args.window_days,
        dry_run=args.dry_run,
        force_allowlist=args.force_allowlist,
        max_pages=args.max_pages,
    )
    summary = {k: v for k, v in payload.items() if k != 'items'}
    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
