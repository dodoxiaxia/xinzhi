#!/usr/bin/env python3
"""Reconcile priority journals (>=45d window) and queue eligible download tasks.

Separate from the 14-day public feed window in refresh_feeds.py / merge_candidates.py:
- Reads config/priority_journal_tasks.json (default research + review only; per-journal overrides).
- Fetches Crossref works and/or official RSS/TOC over >=45 days.
- Classifies article type first by Crossref type/relations and title prefix (plus per-journal
  DOI prefix overrides); PubMed erratum tags alone never decide exclusion.
- Enforces DOI idempotency across existing machine tasks, public library snapshots, and the
  hashed private AI- index (config/pdf_index_keys.json).
- Enforces a configurable daily cap (default <= 20) and only calls POST /api/machine/register
  when explicitly invoked with --register and XINZHI_MACHINE_TOKEN_FILE.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.parse import quote

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from enrich_metadata import topic_notice_reason
from fetch_crossref_fallback import (
    API as CROSSREF_API,
    ISSN_RE,
    PAUSE_SECONDS,
    REQUEST_TIMEOUT,
    ROWS_PER_PAGE,
    SELECT_FIELDS,
    CrossrefBudgetExceeded,
    crossref_headers,
    extract_crossref_publication_date,
    resolve_mailto,
)
import machine_client
import pdf_identity
import refresh_feeds
from source_fallbacks import journal_key
from text_hygiene import clean_inline

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / 'config/priority_journal_tasks.json'
OUTPUT_PATH = ROOT / 'data/priority-journal-tasks.json'
STATE_PATH = ROOT / 'data/priority-journal-tasks-state.json'

MIN_RECONCILE_WINDOW_DAYS = 45
DEFAULT_DAILY_CAP = 20
MAX_DAILY_CAP_CEILING = machine_client.REGISTER_MAX_ITEMS
DEFAULT_ALLOWED_TYPES = ('research', 'review')
VALID_ARTICLE_TYPES = frozenset({
    'research', 'review', 'case_study', 'letter', 'editorial',
    'erratum', 'retraction', 'concern', 'other',
})
DEFAULT_MAX_PAGES = 5
DEFAULT_TIME_BUDGET = 60

_SECTION_BRACKET_RE = re.compile(r'^\s*\[(?P<label>[A-Za-z][A-Za-z ./-]{0,39})\](?:\s+|$)')
_BRACKET_TYPE_MAP = {
    'correspondence': 'letter',
    'letter': 'letter',
    'letters': 'letter',
    'editorial': 'editorial',
    'editorials': 'editorial',
    'comment': 'editorial',
    'commentary': 'editorial',
    'viewpoint': 'editorial',
    'perspective': 'editorial',
    'perspectives': 'editorial',
    'erratum': 'erratum',
    'correction': 'erratum',
    'corrigendum': 'erratum',
    'retraction': 'retraction',
    'review': 'review',
    'reviews': 'review',
    'review article': 'review',
}
_LETTER_TITLE_RE = re.compile(
    r'^(?:letter to the editor\b|correspondence\b|in reply\b|reply to\b|'
    r'authors?\'?\s+reply\b|response to\b|to the editor\b)'
    r'|(?:[-–—:]\s*|\s)reply\s*[.]?$',
    re.I,
)
_EDITORIAL_TITLE_RE = re.compile(
    r'^(?:editorial|commentary|viewpoint|perspective)\s*[:—–-]',
    re.I,
)
_REVIEW_TITLE_RE = re.compile(
    r'\b(?:systematic review|scoping review|narrative review|umbrella review|'
    r'meta-research review|meta-analysis|state-of-the-art review|literature review)\b'
    r'|:\s*a(?:n)?\s+(?:[\w-]+\s+)?review\b',
    re.I,
)
_CROSSREF_TYPE_MAP = {
    'journal-article': 'research',
    'review-article': 'review',
    'letter': 'letter',
    'correspondence': 'letter',
    'editorial': 'editorial',
    'correction': 'erratum',
    'correction-notice': 'erratum',
    'erratum': 'erratum',
    'corrigendum': 'erratum',
    'retraction': 'retraction',
    'retraction-notice': 'retraction',
    'partial-retraction': 'retraction',
    'expression-of-concern': 'concern',
    'book-chapter': 'other',
    'peer-review': 'other',
    'posted-content': 'other',
    'dataset': 'other',
    'component': 'other',
}
_CROSSREF_NOTICE_MAP = {
    'correction': 'erratum',
    'correction-notice': 'erratum',
    'erratum': 'erratum',
    'corrigendum': 'erratum',
    'retraction': 'retraction',
    'retraction-notice': 'retraction',
    'partial-retraction': 'retraction',
    'expression-of-concern': 'concern',
}
_CROSSREF_REL_NOTICE_MAP = {
    'is-correction-of': 'erratum',
    'is-erratum-for': 'erratum',
    'is-erratum-of': 'erratum',
    'is-retraction-of': 'retraction',
    'is-expression-of-concern-for': 'concern',
    'is-expression-of-concern-of': 'concern',
}


def _norm_kind(value):
    return re.sub(r'[\s_-]+', '-', str(value or '').strip().casefold())


def normalize_doi(value):
    """Normalize DOI with the exact edge/machine_client rules."""
    if not isinstance(value, str):
        return ''
    return machine_client.register_doi(value)


def normalize_register_title(value):
    """Normalize title and verify post-bracket length satisfies /api/machine/register."""
    cleaned = machine_client.register_title(clean_inline(str(value or '')))
    if not cleaned:
        return ''
    stripped = _SECTION_BRACKET_RE.sub('', cleaned).strip()
    if machine_client.register_title_chars(stripped) < 5:
        return ''
    return cleaned


def load_config(path=None):
    target = Path(path) if path else CONFIG_PATH
    data = json.loads(target.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('journals'), list):
        raise ValueError('priority_journal_tasks.json must be version 1 with a journals list')

    min_window = data.get('minReconcileWindowDays', MIN_RECONCILE_WINDOW_DAYS)
    if type(min_window) is not int or min_window < MIN_RECONCILE_WINDOW_DAYS:
        raise ValueError(f'minReconcileWindowDays must be >= {MIN_RECONCILE_WINDOW_DAYS}')

    window_days = data.get('reconcileWindowDays', min_window)
    if type(window_days) is not int or window_days < min_window:
        raise ValueError(f'reconcileWindowDays must be >= {min_window}')

    max_cap = data.get('maxDailyCap', DEFAULT_DAILY_CAP)
    if type(max_cap) is not int or not (1 <= max_cap <= MAX_DAILY_CAP_CEILING):
        raise ValueError(f'maxDailyCap must be 1..{MAX_DAILY_CAP_CEILING}')

    daily_cap = data.get('dailyCap', max_cap)
    if type(daily_cap) is not int or not (1 <= daily_cap <= max_cap):
        raise ValueError(f'dailyCap must be 1..{max_cap}')

    raw_default = data.get('defaultAllowedTypes', list(DEFAULT_ALLOWED_TYPES))
    if not isinstance(raw_default, list) or not raw_default:
        raise ValueError('defaultAllowedTypes must be a non-empty list')
    default_allowed = []
    for item in raw_default:
        kind = str(item or '').strip().lower()
        if kind not in VALID_ARTICLE_TYPES:
            raise ValueError(f'Unknown article type in defaultAllowedTypes: {item!r}')
        if kind not in default_allowed:
            default_allowed.append(kind)

    journals = []
    for row in data['journals']:
        if not isinstance(row, dict):
            raise ValueError('priority_journal_tasks.json journal entry must be an object')
        journal = clean_inline(row.get('journal', ''))
        issns = [str(x).strip().upper() for x in (row.get('issns') or []) if str(x).strip()]
        if not journal or not issns or any(not ISSN_RE.fullmatch(issn) for issn in issns):
            raise ValueError(f'Invalid journal or ISSN in priority_journal_tasks.json: {journal!r}')
        aliases = [clean_inline(a) for a in (row.get('aliases') or []) if clean_inline(a)]
        rss_urls = [str(u).strip() for u in (row.get('rssUrls') or []) if str(u).strip()]
        section = str(row.get('section') or 'MAIN').strip()
        if section not in machine_client.REGISTER_SECTIONS:
            raise ValueError(f'Invalid section for {journal!r}: {section!r}')
        source = str(row.get('source') or 'priority-journal-reconcile').strip()
        if not machine_client.REGISTER_SOURCE_RE.fullmatch(source):
            raise ValueError(f'Invalid register source tag for {journal!r}: {source!r}')
        sources = [str(s).strip().lower() for s in (row.get('sources') or ['crossref', 'rss']) if str(s).strip()]
        if not sources or any(s not in ('crossref', 'rss') for s in sources):
            raise ValueError(f'Invalid sources for {journal!r}: {sources!r}')
        j_window = row.get('reconcileWindowDays', window_days)
        if type(j_window) is not int or j_window < min_window:
            raise ValueError(f'Journal {journal!r} reconcileWindowDays must be >= {min_window}')
        raw_allowed = row.get('allowedTypes', default_allowed)
        if not isinstance(raw_allowed, list) or not raw_allowed:
            raise ValueError(f'Journal {journal!r} allowedTypes must be a non-empty list')
        allowed_types = []
        for item in raw_allowed:
            kind = str(item or '').strip().lower()
            if kind not in VALID_ARTICLE_TYPES:
                raise ValueError(f'Unknown article type {item!r} for {journal!r}')
            if kind not in allowed_types:
                allowed_types.append(kind)
        prefix_map = {}
        for prefix, ptype in (row.get('doiPrefixTypes') or {}).items():
            pnorm = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', str(prefix or '').strip(), flags=re.I).lower()
            kind = str(ptype or '').strip().lower()
            if not pnorm or kind not in VALID_ARTICLE_TYPES:
                raise ValueError(f'Invalid doiPrefixTypes entry {prefix!r}: {ptype!r} for {journal!r}')
            prefix_map[pnorm] = kind
        journals.append({
            'journal': journal,
            'issns': issns,
            'aliases': aliases,
            'rssUrls': rss_urls,
            'section': section,
            'source': source,
            'enabled': row.get('enabled') is True,
            'sources': sources,
            'reconcileWindowDays': j_window,
            'allowedTypes': allowed_types,
            'doiPrefixTypes': prefix_map,
        })

    return {
        'version': 1,
        'reconcileWindowDays': window_days,
        'minReconcileWindowDays': min_window,
        'dailyCap': daily_cap,
        'maxDailyCap': max_cap,
        'defaultAllowedTypes': default_allowed,
        'journals': journals,
    }


def extract_crossref_date_any(work):
    """Extract day-precision date from published-online > published > issued > published-print."""
    info = extract_crossref_publication_date(work)
    if info:
        return info
    if not isinstance(work, dict):
        return None
    node = work.get('published-print')
    if isinstance(node, dict):
        parts_list = node.get('date-parts')
        if isinstance(parts_list, list) and parts_list:
            parts = parts_list[0]
            if (isinstance(parts, list) and len(parts) == 3
                    and all(not isinstance(p, bool) and isinstance(p, int) for p in parts)):
                try:
                    iso = datetime.date(parts[0], parts[1], parts[2]).isoformat()
                except ValueError:
                    return None
                return {
                    'date': f'{iso}T00:00:00+00:00',
                    'datePrecision': 'day',
                    'dateBasis': 'Crossref published-print',
                }
    return None


def crossref_get(params):
    query = urllib.parse.urlencode(params)
    req = urllib.request.Request(f'{CROSSREF_API}?{query}', headers=crossref_headers())
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return json.loads(resp.read().decode('utf-8'))


def fetch_crossref_works_for_journal(entry, *, since_day, until_day, fetcher=crossref_get,
                                     sleep=time.sleep, max_pages=DEFAULT_MAX_PAGES,
                                     deadline=None):
    works = []
    api_calls = 0
    pages_fetched = 0
    degraded = False
    error_reason = ''
    mailto = resolve_mailto()
    for issn in entry['issns']:
        cursor = '*'
        seen_cursors = set()
        for page in range(max_pages):
            if deadline is not None and time.monotonic() >= deadline:
                raise CrossrefBudgetExceeded('priority journal crossref budget reached')
            if cursor in seen_cursors:
                break
            seen_cursors.add(cursor)
            params = {
                'filter': f'issn:{issn},from-pub-date:{since_day.isoformat()},until-pub-date:{until_day.isoformat()}',
                'rows': str(ROWS_PER_PAGE),
                'cursor': cursor,
                'select': SELECT_FIELDS,
                'mailto': mailto,
            }
            if page > 0 or api_calls > 0:
                sleep(PAUSE_SECONDS)
            api_calls += 1
            try:
                payload = fetcher(params)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
                degraded = True
                error_reason = type(exc).__name__
                break
            msg = payload.get('message') if isinstance(payload, dict) else None
            if not isinstance(msg, dict) or not isinstance(msg.get('items'), list):
                degraded = True
                error_reason = 'invalid_response'
                break
            pages_fetched += 1
            items = msg['items']
            works.extend(items)
            next_cursor = msg.get('next-cursor')
            if not next_cursor or not items or len(items) < ROWS_PER_PAGE:
                break
            cursor = next_cursor
    return works, {'apiCalls': api_calls, 'pagesFetched': pages_fetched, 'degraded': degraded, 'error': error_reason}


def load_local_feed_items(root, entry):
    """Collect matching items for a priority journal from data/feeds.json if present."""
    feeds_path = Path(root) / 'data/feeds.json'
    if not feeds_path.is_file():
        return []
    try:
        payload = json.loads(feeds_path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    wanted_keys = {journal_key(entry['journal'])} | {journal_key(a) for a in entry['aliases']}
    wanted_keys.discard('')
    wanted_urls = set(entry['rssUrls'])
    out = []
    for item in payload.get('items') or []:
        if not isinstance(item, dict):
            continue
        jkey = journal_key(item.get('journal', ''))
        if jkey in wanted_keys or (item.get('sourceUrl') in wanted_urls):
            out.append(item)
    return out


def fetch_live_rss_items(entry, *, fetcher=None):
    """Fetch and parse configured rssUrls using refresh_feeds.parse_feed."""
    out = []
    errors = []
    for url in entry.get('rssUrls') or []:
        source = {
            'id': refresh_feeds.source_id(url),
            'name': entry['journal'],
            'url': url,
            'category': 'AI医疗',
            'sourceType': '出版商/学术平台',
        }
        try:
            if fetcher is not None:
                raw, _final_url = fetcher(url)
            else:
                req = urllib.request.Request(url, headers={'User-Agent': 'XinZhiLearningPilot/0.2'})
                with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                    raw = resp.read()
            items = refresh_feeds.parse(raw, source)
            out.extend(items)
        except Exception as exc:  # noqa: BLE001
            errors.append(f'{url}: {type(exc).__name__}')
    return out, errors


def _title_notice_type(title):
    reason = topic_notice_reason({}, title=title)
    if not reason:
        return ''
    lowered = reason.casefold()
    if 'retraction' in lowered or '撤稿' in title:
        return 'retraction'
    if 'concern' in lowered or '关注声明' in title:
        return 'concern'
    return 'erratum'


def classify_priority_article_type(candidate, journal_entry=None):
    """Classify article type: Crossref type/relations and title prefix first.

    PubMed's Published Erratum / ErratumFor tags NEVER alone decide exclusion when
    Crossref says journal-article (without update-to / notice relation) and the
    title carries no notice prefix.
    """
    doi = normalize_doi(candidate.get('doi', ''))
    title = clean_inline(candidate.get('title', ''))
    crossref_type = _norm_kind(candidate.get('type'))
    pub_types = [str(pt).strip() for pt in (candidate.get('pubTypes') or []) if str(pt).strip()]
    pub_types_cf = {pt.casefold() for pt in pub_types}
    pubmed_rels = [r for r in (candidate.get('pubmedRelations') or []) if isinstance(r, dict)]

    has_pubmed_erratum = (
        bool(pub_types_cf & {'published erratum', 'erratum'})
        or any(r.get('type') == 'ErratumFor' for r in pubmed_rels)
    )
    has_pubmed_retraction = (
        bool(pub_types_cf & {'retraction of publication', 'retraction notice'})
        or any(r.get('type') == 'RetractionOf' for r in pubmed_rels)
    )
    has_pubmed_concern = (
        'expression of concern' in pub_types_cf
        or any(r.get('type') == 'ExpressionOfConcernFor' for r in pubmed_rels)
    )
    has_pubmed_notice = has_pubmed_erratum or has_pubmed_retraction or has_pubmed_concern

    # 1. Crossref update-to and relation notices
    for upd in candidate.get('update-to') or ():
        if isinstance(upd, dict):
            ukind = _norm_kind(upd.get('type'))
            if ukind in _CROSSREF_NOTICE_MAP:
                return {
                    'articleType': _CROSSREF_NOTICE_MAP[ukind],
                    'typeSource': 'crossref_update_to',
                    'detail': ukind,
                    'pubmedNoticeIgnored': False,
                }
    relations = candidate.get('relation')
    if isinstance(relations, dict):
        for rel_name, targets in relations.items():
            if targets:
                rnorm = _norm_kind(rel_name)
                if rnorm in _CROSSREF_REL_NOTICE_MAP:
                    return {
                        'articleType': _CROSSREF_REL_NOTICE_MAP[rnorm],
                        'typeSource': 'crossref_relation',
                        'detail': rel_name,
                        'pubmedNoticeIgnored': False,
                    }

    # 2. Explicit Crossref non-generic types
    if crossref_type and crossref_type != 'journal-article':
        mapped = _CROSSREF_TYPE_MAP.get(crossref_type, 'other')
        return {
            'articleType': mapped,
            'typeSource': 'crossref_type',
            'detail': crossref_type,
            'pubmedNoticeIgnored': False,
        }

    # 3. Title prefix / leading bracket label
    bracket_match = _SECTION_BRACKET_RE.match(title)
    unbracketed = title
    if bracket_match:
        label = bracket_match.group('label').strip().casefold()
        unbracketed = title[bracket_match.end():].strip()
        if label in _BRACKET_TYPE_MAP:
            return {
                'articleType': _BRACKET_TYPE_MAP[label],
                'typeSource': 'title_bracket',
                'detail': bracket_match.group('label'),
                'pubmedNoticeIgnored': False,
            }

    notice_kind = _title_notice_type(title)
    if notice_kind:
        return {
            'articleType': notice_kind,
            'typeSource': 'title_prefix',
            'detail': topic_notice_reason({}, title=title),
            'pubmedNoticeIgnored': False,
        }
    if _LETTER_TITLE_RE.search(unbracketed):
        return {
            'articleType': 'letter',
            'typeSource': 'title_prefix',
            'detail': 'letter_title_pattern',
            'pubmedNoticeIgnored': False,
        }
    if _EDITORIAL_TITLE_RE.search(unbracketed):
        return {
            'articleType': 'editorial',
            'typeSource': 'title_prefix',
            'detail': 'editorial_title_pattern',
            'pubmedNoticeIgnored': False,
        }

    # 4. Per-journal DOI prefix rules (longest prefix wins)
    prefix_map = (journal_entry or {}).get('doiPrefixTypes') or {}
    if doi and prefix_map:
        for prefix in sorted(prefix_map, key=len, reverse=True):
            if doi.startswith(prefix):
                return {
                    'articleType': prefix_map[prefix],
                    'typeSource': 'journal_doi_prefix',
                    'detail': prefix,
                    'pubmedNoticeIgnored': has_pubmed_notice,
                }

    # 5. Non-erratum PubMed subtype enrichment + review title cues
    if pub_types_cf & {'letter', 'comment'}:
        return {
            'articleType': 'letter',
            'typeSource': 'pubmed_pubtype',
            'detail': 'letter_or_comment',
            'pubmedNoticeIgnored': False,
        }
    if 'editorial' in pub_types_cf:
        return {
            'articleType': 'editorial',
            'typeSource': 'pubmed_pubtype',
            'detail': 'editorial',
            'pubmedNoticeIgnored': False,
        }
    if (pub_types_cf & {'review', 'systematic review', 'meta-analysis'}) or _REVIEW_TITLE_RE.search(unbracketed):
        return {
            'articleType': 'review',
            'typeSource': 'pubmed_or_title_review',
            'detail': 'review',
            'pubmedNoticeIgnored': has_pubmed_notice,
        }

    # 6. Default for Crossref journal-article (or RSS item with no exclusion signal).
    # Note: PubMed Published Erratum / ErratumFor alone does NOT exclude here.
    return {
        'articleType': 'research',
        'typeSource': 'crossref_type+title_prefix' if crossref_type == 'journal-article' else 'title_prefix_default',
        'detail': crossref_type or 'rss_default',
        'pubmedNoticeIgnored': has_pubmed_notice,
    }


def _extract_dois_from_task_payload(payload):
    rows = payload.get('tasks') if isinstance(payload, dict) else payload
    dois = set()
    if not isinstance(rows, list):
        return dois
    for row in rows:
        if isinstance(row, str):
            doi = normalize_doi(row)
        elif isinstance(row, dict):
            doi = normalize_doi(row.get('doi') or '')
        else:
            doi = ''
        if doi:
            dois.add(doi)
    return dois


def load_existing_task_dois(root, *, tasks_file=None, token=None, use_tasks_api=False):
    dois = set()
    if tasks_file:
        payload = json.loads(Path(tasks_file).read_text(encoding='utf-8'))
        dois |= _extract_dois_from_task_payload(payload)
        return dois
    if use_tasks_api and token:
        cursor = None
        for _page in range(50):
            q = '?limit=50' + (f'&cursor={quote(str(cursor), safe="")}' if cursor else '')
            code, data, _body = machine_client.request('GET', '/api/machine/tasks' + q, token=token)
            if code != 200 or not isinstance(data, dict) or not isinstance(data.get('tasks'), list):
                raise machine_client.ClientError(f'GET /api/machine/tasks failed: HTTP {code}', 5)
            dois |= _extract_dois_from_task_payload(data)
            cursor = data.get('cursor')
            if not cursor:
                break
    return dois


def _is_orphan_registration(paper):
    return (
        paper.get('fulltextStatus') == 'manual_needed'
        and (
            paper.get('machineRegistration') is True
            or (not paper.get('journal') and not paper.get('authors') and not paper.get('date'))
        )
    )


def load_public_library_dois(root):
    dois = set()
    for rel in ('editorial/public_library_snapshot.json', 'data/library.json'):
        path = Path(root) / rel
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        for paper in payload.get('papers') or []:
            if not isinstance(paper, dict):
                continue
            if _is_orphan_registration(paper):
                continue
            doi = normalize_doi(paper.get('doi') or '')
            if doi:
                dois.add(doi)
    return dois


def load_private_index_doi_hashes(root):
    path = Path(root) / pdf_identity.KEYS_PATH
    if not path.is_file():
        return set()
    snap = pdf_identity.load_snapshot(root)
    return {row[0] for row in snap.get('rows') or [] if row and row[0]}


def load_pubmed_by_doi(root):
    path = Path(root) / 'data/pubmed.json'
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    by_doi = {}
    for row in payload.get('items') or []:
        if not isinstance(row, dict):
            continue
        doi = normalize_doi(row.get('doi') or '')
        if doi:
            by_doi[doi] = row
    return by_doi


def load_daily_state(path):
    target = Path(path)
    if not target.is_file():
        return {'schemaVersion': 1, 'submittedByDay': {}}
    try:
        data = json.loads(target.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'schemaVersion': 1, 'submittedByDay': {}}
    if not isinstance(data, dict) or not isinstance(data.get('submittedByDay'), dict):
        return {'schemaVersion': 1, 'submittedByDay': {}}
    return {
        'schemaVersion': 1,
        'submittedByDay': {
            str(day): [normalize_doi(d) for d in dois if normalize_doi(d)]
            for day, dois in data['submittedByDay'].items()
            if isinstance(dois, list)
        },
    }


def save_daily_state(path, state):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def reconcile(
    root=ROOT,
    *,
    now=None,
    config_path=None,
    output_path=None,
    state_path=None,
    tasks_file=None,
    crossref_fetcher=crossref_get,
    rss_fetcher=None,
    fetch_rss=False,
    sleep=time.sleep,
    daily_cap_override=None,
    register=False,
    use_tasks_api=False,
    register_fn=None,
):
    root = Path(root)
    now_dt = now or datetime.datetime.now(datetime.timezone.utc)
    today = now_dt.date()
    today_str = today.isoformat()
    cfg = load_config(config_path or (root / 'config/priority_journal_tasks.json'))

    effective_cap = cfg['dailyCap']
    if daily_cap_override is not None:
        if not (1 <= daily_cap_override <= cfg['maxDailyCap']):
            raise ValueError(f'--daily-cap must be 1..{cfg["maxDailyCap"]}')
        effective_cap = daily_cap_override

    state_file = Path(state_path) if state_path else (root / 'data/priority-journal-tasks-state.json')
    daily_state = load_daily_state(state_file)
    submitted_today = set(daily_state['submittedByDay'].get(today_str, []))
    remaining_daily_cap = max(0, effective_cap - len(submitted_today))

    token = None
    if register or use_tasks_api:
        token = machine_client.load_token(require_env=register)

    existing_task_dois = load_existing_task_dois(
        root,
        tasks_file=tasks_file,
        token=token,
        use_tasks_api=bool(use_tasks_api or (register and not tasks_file)),
    )
    existing_task_dois |= submitted_today
    public_library_dois = load_public_library_dois(root)
    private_doi_hashes = load_private_index_doi_hashes(root)
    pubmed_by_doi = load_pubmed_by_doi(root)

    deadline = time.monotonic() + DEFAULT_TIME_BUDGET
    journal_reports = []
    eligible_candidates = []
    decisions = []
    summary = {
        'journalsEnabled': 0,
        'fetchedTotal': 0,
        'inWindow': 0,
        'outsideWindowOrBadDate': 0,
        'invalidDoiOrTitle': 0,
        'skippedDuplicate': 0,
        'skippedExistingTask': 0,
        'skippedPublicLibrary': 0,
        'skippedPrivateIndex': 0,
        'skippedExcludedType': 0,
        'pubmedNoticeIgnoredCount': 0,
        'eligibleTotal': 0,
        'selectedCount': 0,
        'cappedCount': 0,
        'registeredCount': 0,
        'registerSkippedCount': 0,
        'degraded': False,
    }

    seen_global = set()
    for entry in cfg['journals']:
        if not entry['enabled']:
            continue
        summary['journalsEnabled'] += 1
        window_days = entry['reconcileWindowDays']
        since_day = today - datetime.timedelta(days=window_days)

        by_doi = {}
        cr_meta = {'apiCalls': 0, 'pagesFetched': 0, 'degraded': False, 'error': ''}
        rss_errors = []

        if 'crossref' in entry['sources']:
            try:
                cr_works, cr_meta = fetch_crossref_works_for_journal(
                    entry,
                    since_day=since_day,
                    until_day=today,
                    fetcher=crossref_fetcher,
                    sleep=sleep,
                    deadline=deadline,
                )
            except CrossrefBudgetExceeded:
                cr_works = []
                cr_meta = {'apiCalls': 0, 'pagesFetched': 0, 'degraded': True, 'error': 'budget_exceeded'}
            if cr_meta.get('degraded'):
                summary['degraded'] = True
            for work in cr_works:
                if not isinstance(work, dict):
                    continue
                summary['fetchedTotal'] += 1
                doi = normalize_doi(work.get('DOI') or '')
                titles = work.get('title')
                raw_title = titles[0] if isinstance(titles, list) and titles else (titles or '')
                title = normalize_register_title(raw_title)
                if not doi or not title:
                    summary['invalidDoiOrTitle'] += 1
                    continue
                date_info = extract_crossref_date_any(work)
                if not date_info:
                    summary['outsideWindowOrBadDate'] += 1
                    continue
                pub_day = datetime.date.fromisoformat(date_info['date'][:10])
                age = (today - pub_day).days
                if not (0 <= age <= window_days):
                    summary['outsideWindowOrBadDate'] += 1
                    continue
                summary['inWindow'] += 1
                by_doi[doi] = {
                    'doi': doi,
                    'title': title,
                    'date': date_info['date'][:10],
                    'dateBasis': date_info['dateBasis'],
                    'type': work.get('type', ''),
                    'update-to': work.get('update-to') or [],
                    'relation': work.get('relation') or {},
                    'origin': 'crossref',
                }

        if 'rss' in entry['sources']:
            rss_items = load_local_feed_items(root, entry)
            if fetch_rss or rss_fetcher is not None:
                live_items, rss_errors = fetch_live_rss_items(entry, fetcher=rss_fetcher)
                rss_items.extend(live_items)
                if rss_errors:
                    summary['degraded'] = True
            for item in rss_items:
                if not isinstance(item, dict):
                    continue
                summary['fetchedTotal'] += 1
                doi = normalize_doi(item.get('doi') or '')
                title = normalize_register_title(item.get('title') or '')
                if not doi or not title:
                    summary['invalidDoiOrTitle'] += 1
                    continue
                date_str = str(item.get('date') or '')[:10]
                try:
                    pub_day = datetime.date.fromisoformat(date_str)
                except ValueError:
                    summary['outsideWindowOrBadDate'] += 1
                    continue
                age = (today - pub_day).days
                if not (0 <= age <= window_days):
                    summary['outsideWindowOrBadDate'] += 1
                    continue
                summary['inWindow'] += 1
                if doi not in by_doi:
                    by_doi[doi] = {
                        'doi': doi,
                        'title': title,
                        'date': date_str,
                        'dateBasis': item.get('dateBasis') or 'RSS',
                        'type': '',
                        'update-to': [],
                        'relation': {},
                        'origin': 'rss',
                    }

        j_counts = {
            'journal': entry['journal'],
            'windowDays': window_days,
            'uniqueInWindow': len(by_doi),
            'eligible': 0,
            'skippedExistingTask': 0,
            'skippedPublicLibrary': 0,
            'skippedPrivateIndex': 0,
            'skippedExcludedType': 0,
            'crossref': cr_meta,
            'rssErrors': rss_errors,
        }

        for doi in sorted(by_doi):
            rec = dict(by_doi[doi])
            if doi in seen_global:
                summary['skippedDuplicate'] += 1
                continue
            seen_global.add(doi)

            pm = pubmed_by_doi.get(doi)
            if pm:
                rec['pubTypes'] = pm.get('pubTypes') or []
                rec['pubmedRelations'] = pm.get('pubmedRelations') or []

            cls = classify_priority_article_type(rec, entry)
            if cls['pubmedNoticeIgnored']:
                summary['pubmedNoticeIgnoredCount'] += 1

            article_type = cls['articleType']
            allowed = article_type in entry['allowedTypes']
            decision = {
                'doi': doi,
                'journal': entry['journal'],
                'title': rec['title'],
                'date': rec['date'],
                'origin': rec['origin'],
                'articleType': article_type,
                'typeSource': cls['typeSource'],
                'pubmedNoticeIgnored': cls['pubmedNoticeIgnored'],
            }

            if not allowed:
                summary['skippedExcludedType'] += 1
                j_counts['skippedExcludedType'] += 1
                decision.update(action='skipped', reason='excluded_type')
                decisions.append(decision)
                continue

            if doi in existing_task_dois:
                summary['skippedExistingTask'] += 1
                j_counts['skippedExistingTask'] += 1
                decision.update(action='skipped', reason='existing_task')
                decisions.append(decision)
                continue

            if doi in public_library_dois:
                summary['skippedPublicLibrary'] += 1
                j_counts['skippedPublicLibrary'] += 1
                decision.update(action='skipped', reason='public_library')
                decisions.append(decision)
                continue

            doi_hash = pdf_identity.key_hash('doi', pdf_identity.pdf_doi(doi))
            if doi_hash and doi_hash in private_doi_hashes:
                summary['skippedPrivateIndex'] += 1
                j_counts['skippedPrivateIndex'] += 1
                decision.update(action='skipped', reason='private_index')
                decisions.append(decision)
                continue

            summary['eligibleTotal'] += 1
            j_counts['eligible'] += 1
            eligible_candidates.append({
                'doi': doi,
                'title': rec['title'],
                'source': entry['source'],
                'section': entry['section'],
                'date': rec['date'],
                'decision': decision,
            })

        journal_reports.append(j_counts)

    # Newest publications get priority when a catch-up exceeds dailyCap.
    eligible_candidates.sort(key=lambda item: (item['date'], item['doi']), reverse=True)
    selected = eligible_candidates[:remaining_daily_cap]
    capped = eligible_candidates[remaining_daily_cap:]
    summary['selectedCount'] = len(selected)
    summary['cappedCount'] = len(capped)

    for item in selected:
        item['decision'].update(action='selected', reason='within_daily_cap')
        decisions.append(item['decision'])
    for item in capped:
        item['decision'].update(action='deferred', reason='daily_cap_reached')
        decisions.append(item['decision'])

    register_items = [
        {
            'doi': item['doi'],
            'title': item['title'],
            'source': item['source'],
            'section': item['section'],
        }
        for item in selected
    ]
    if register_items:
        register_items = machine_client.validate_register_items(register_items)

    register_result = None
    if register and register_items:
        submit = register_fn or machine_client.register_with_retry
        code, data, attempts, net_err = submit(token, register_items)
        register_result = {
            'http': code,
            'attempts': attempts,
            'error': net_err,
            'response': data,
        }
        if isinstance(data, dict) and isinstance(data.get('results'), list):
            newly_registered = []
            for row in data['results']:
                if not isinstance(row, dict):
                    continue
                if row.get('result') == 'registered':
                    summary['registeredCount'] += 1
                    rdoi = normalize_doi(row.get('doi') or '')
                    if rdoi:
                        newly_registered.append(rdoi)
                elif row.get('result') == 'skipped':
                    summary['registerSkippedCount'] += 1
            if newly_registered:
                existing_day = daily_state['submittedByDay'].get(today_str, [])
                daily_state['submittedByDay'][today_str] = sorted(set(existing_day) | set(newly_registered))
                save_daily_state(state_file, daily_state)

    report = {
        'schemaVersion': 1,
        'generatedAt': now_dt.isoformat(),
        'reconcileWindowDays': cfg['reconcileWindowDays'],
        'dailyCap': effective_cap,
        'alreadySubmittedToday': len(submitted_today),
        'remainingDailyCap': remaining_daily_cap,
        'registerMode': 'execute' if register else 'dry_run',
        'summary': summary,
        'journals': journal_reports,
        'registerItems': register_items,
        'decisions': sorted(decisions, key=lambda d: (d['date'], d['doi']), reverse=True),
        'registerResult': register_result,
    }
    target = Path(output_path) if output_path else (root / 'data/priority-journal-tasks.json')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description='Reconcile priority journals (>=45d) and prepare download tasks.')
    parser.add_argument('--config', default=None, help='Path to priority_journal_tasks.json')
    parser.add_argument('--output', default=None, help='Path to output report JSON')
    parser.add_argument('--state-file', default=None, help='Path to daily cap state JSON')
    parser.add_argument('--tasks-file', default=None, help='Optional local tasks JSON snapshot (list or {"tasks": [...]})')
    parser.add_argument('--tasks-api', action='store_true', help='Fetch live existing tasks from /api/machine/tasks')
    parser.add_argument('--fetch-rss', action='store_true', help='Also fetch live rssUrls in addition to Crossref')
    parser.add_argument('--daily-cap', type=int, default=None, help='Override dailyCap (1..maxDailyCap)')
    parser.add_argument('--register', action='store_true', help='Submit selected items to POST /api/machine/register (requires XINZHI_MACHINE_TOKEN_FILE)')
    args = parser.parse_args(argv)

    report = reconcile(
        ROOT,
        config_path=args.config,
        output_path=args.output,
        state_path=args.state_file,
        tasks_file=args.tasks_file,
        fetch_rss=args.fetch_rss,
        daily_cap_override=args.daily_cap,
        register=args.register,
        use_tasks_api=args.tasks_api,
    )
    s = report['summary']
    print(
        f"Priority journal reconcile ({report['reconcileWindowDays']}d, cap={report['dailyCap']}): "
        f"inWindow={s['inWindow']} selected={s['selectedCount']} capped={s['cappedCount']} "
        f"skipped(task={s['skippedExistingTask']}, pub={s['skippedPublicLibrary']}, "
        f"priv={s['skippedPrivateIndex']}, type={s['skippedExcludedType']}) "
        f"pubmedNoticeIgnored={s['pubmedNoticeIgnoredCount']}"
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
