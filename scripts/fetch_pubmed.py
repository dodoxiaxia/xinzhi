#!/usr/bin/env python3
"""Public PubMed metadata fallback for watched journals. Never downloads PDFs.

An error or partial E-utilities payload is retried at most three times, with
5s, 15s and 45s backoff plus 0-20% jitter, staying at or above the NCBI
E-utilities rate limit (3 requests/second without a key). Retryable failures
include HTTP 429 and 5xx, network timeouts, incomplete reads, and HTTP 400
bodies that report Timeout, Empty Response, or External viewer error. A 429
with Retry-After waits that value, still bounded by the step time budget; a
429 without the header uses the same 5/15/45 backoff. A genuine HTTP 400
parameter error is not retried. The whole PubMed step has a 4-minute time
budget (overridable by --time-budget or XINZHI_PUBMED_TIME_BUDGET_SECONDS).
If a wait would exceed the remaining budget, or the budget is already gone,
the step reuses the previous snapshot when one exists, records
pubmed_time_budget_exceeded in source-health, and exits successfully. A
genuine parameter error, or a missing previous snapshot, still fails the step.
"""
import argparse, datetime, email.utils, hashlib, http.client, json, os, random, time, urllib.request, urllib.parse, urllib.error, xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from build_data import clean, classify
from scope_filter import scope_decision
from source_fallbacks import ADDITIONAL_JOURNALS, journal_query

ROOT = Path(__file__).resolve().parents[1]

JOURNALS = [
    'Circulation', 'Circulation Research', 'Circulation Heart Failure',
    'Circulation Cardiovascular Imaging', 'Circulation Cardiovascular Interventions',
    'Circulation Arrhythmia and Electrophysiology', 'Circulation Genomic and Precision Medicine',
    'Hypertension', 'Journal of the American Heart Association', 'Stroke',
    'JACC', 'JACC: Heart Failure', 'JACC: Cardiovascular Interventions',
    'JACC: Clinical Electrophysiology', 'JACC: Cardiovascular Imaging', 'JACC: Advances',
    'European Heart Journal', 'European Heart Journal - Digital Health',
    'European Heart Journal - Cardiovascular Pharmacotherapy', 'European Heart Journal - Cardiovascular Imaging',
    'Europace', 'Cardiovascular Research', 'European Journal of Heart Failure',
    'Heart Rhythm', 'Journal of Cardiovascular Electrophysiology', 'Heart',
    'N Engl J Med', 'NEJM AI', 'NEJM Evid', 'The Lancet', 'The Lancet Digital Health',
    'JAMA', 'JAMA Cardiology', 'JAMA Internal Medicine', 'JAMA Network Open',
    'Nature Medicine', 'npj Digital Medicine', 'Cardiovascular Diabetology', 'BMJ Digital Health & AI'
]
JOURNALS += list(ADDITIONAL_JOURNALS)
TRANSIENT_HTTP = {429, 500, 502, 503, 504}
TRANSIENT_400_MARKERS = ('timeout', 'empty response', 'external viewer error')
REQUEST_RETRIES = 3
REQUEST_ATTEMPTS = REQUEST_RETRIES + 1
REQUEST_TIMEOUT = 30
# E-utilities allows 3 requests/second without a key. Batch spacing stays at or
# above this interval. Retry backoff (5, 15, 45) is slower. This module does not send a key.
NCBI_MIN_INTERVAL = 0.4
RETRY_BACKOFFS = (5.0, 15.0, 45.0)
RETRY_JITTER = 0.20
DEFAULT_TIME_BUDGET = 240
TIME_BUDGET_ENV = 'XINZHI_PUBMED_TIME_BUDGET_SECONDS'

class PubmedError(RuntimeError):
    """A complete public metadata response was not obtained. The previous file stays."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)

class PubmedBudgetExceeded(PubmedError):
    """The PubMed step would exceed its time budget. A previous snapshot may be reused."""

    def __init__(self):
        super().__init__('pubmed_time_budget_exceeded')


def resolve_time_budget(value=None):
    if value is not None:
        seconds = float(value)
    else:
        raw = os.environ.get(TIME_BUDGET_ENV)
        seconds = float(raw) if raw not in (None, '') else float(DEFAULT_TIME_BUDGET)
    if seconds < 0:
        raise ValueError('time budget must be >= 0')
    return seconds


def retry_delay(attempt, rng=None):
    """Return the 5/15/45s backoff for this retry, plus 0-20% jitter from rng()."""
    base = RETRY_BACKOFFS[attempt]
    jitter = 0.0 if rng is None else float(rng())
    if jitter < 0 or jitter > 1:
        raise ValueError('retry jitter rng must return a value in 0..1')
    return base * (1.0 + RETRY_JITTER * jitter)


def retry_after_seconds(exc):
    """Parse a Retry-After header as seconds. Invalid or missing values return None."""
    headers = getattr(exc, 'headers', None)
    raw = headers.get('Retry-After') if headers is not None and hasattr(headers, 'get') else None
    if raw is None or str(raw).strip() == '':
        return None
    text = str(raw).strip()
    try:
        return max(0.0, float(int(text)))
    except (TypeError, ValueError):
        try:
            when = email.utils.parsedate_to_datetime(text)
        except (TypeError, ValueError, OverflowError, IndexError):
            return None
        if when is None:
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=datetime.timezone.utc)
        now = datetime.datetime.now(datetime.timezone.utc)
        return max(0.0, (when - now).total_seconds())


def next_retry_delay(attempt, exc=None, rng=None):
    if exc is not None and isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
        after = retry_after_seconds(exc)
        if after is not None:
            return after
    return retry_delay(attempt, rng)


def remaining_budget(budget, started, clock):
    if budget is None:
        return None
    return budget - (clock() - started)


def wait_within_budget(seconds, wait, budget=None, started=None, clock=None):
    """Wait only when the delay fits the remaining budget. Never sleep past it."""
    if budget is not None:
        left = remaining_budget(budget, started, clock)
        if seconds > left:
            raise PubmedBudgetExceeded()
    wait(seconds)


def public_error_detail(body):
    """Return a short public upstream message. Never include the request query."""
    text = ' '.join((body or '').split())
    message = ''
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            message = parsed.get('error', '')
    except (ValueError, AttributeError, TypeError):
        try:
            xml = ET.fromstring(body)
            match = xml if xml.tag == 'ERROR' else xml.find('.//ERROR')
            message = ''.join(match.itertext()) if match is not None else ''
        except ET.ParseError:
            message = text
    if not isinstance(message, str) or not message.strip():
        message = text
    return ' '.join(message.split())[:200]


def is_transient_http(code, detail=''):
    if code in TRANSIENT_HTTP:
        return True
    if code == 400:
        text = (detail or '').lower()
        return any(marker in text for marker in TRANSIENT_400_MARKERS)
    return False


def http_error_detail(exc):
    detail = getattr(exc, 'pubmed_detail', '')
    if detail:
        return detail
    for note in getattr(exc, '__notes__', ()):
        try:
            data = json.loads(note)
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict) and 'upstreamError' in data:
            return str(data.get('upstreamError') or '')
    return ''


def request(action, params, attempts=REQUEST_ATTEMPTS, wait=None, clock=None, rng=None, budget=None, started=None):
    wait = time.sleep if wait is None else wait
    clock = time.monotonic if clock is None else clock
    rng = random.random if rng is None else rng
    if budget is not None and started is None:
        started = clock()
    endpoint = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/' + action
    encoded = urllib.parse.urlencode(params)
    headers = {'User-Agent': 'XinZhiLearningPilot/0.1 (public journal metadata)'}
    # E-utilities supports POST for long terms; retain every field without a long URI.
    if len(endpoint) + 1 + len(encoded) > 1800:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        req = urllib.request.Request(endpoint, data=encoded.encode('ascii'), headers=headers, method='POST')
    else:
        req = urllib.request.Request(endpoint + '?' + encoded, headers=headers)
    last = None
    for attempt in range(attempts):
        left = remaining_budget(budget, started, clock)
        if left is not None and left <= 0:
            raise PubmedBudgetExceeded()
        timeout = REQUEST_TIMEOUT if left is None else min(REQUEST_TIMEOUT, left)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(10_000_000)
        except urllib.error.HTTPError as exc:
            # CI retains only the tail of stderr. Keep the failed public action
            # identifiable there, without logging query/IDs/headers. A genuine
            # client error is not retried. 429, 5xx, and HTTP 400 timeout
            # bodies are bounded and then re-raised.
            detail = ''
            try:
                body = exc.read(4096).decode('utf-8', 'replace')
                detail = public_error_detail(body)
            except (OSError, AttributeError):
                pass
            exc.pubmed_detail = detail
            exc.add_note(json.dumps({'publicPubmedRequest': action,
                                     'method': req.get_method(),
                                     'httpStatus': exc.code,
                                     'upstreamError': detail}, ensure_ascii=False))
            last = exc
            if not is_transient_http(exc.code, detail) or attempt == attempts - 1:
                raise
        except (http.client.IncompleteRead, TimeoutError, urllib.error.URLError, OSError) as exc:
            # Discard partial bytes and retry the same public metadata request.
            last = exc
            if attempt == attempts - 1:
                raise
        wait_within_budget(next_retry_delay(attempt, last, rng), wait, budget, started, clock)
    raise last

def _error_text(value):
    if isinstance(value, str) and value.strip():
        return True
    return isinstance(value, list) and any(isinstance(item, str) and item.strip() for item in value)

def parse_esearch(payload):
    """Return the esearch result only when it has a real id list.

    NCBI sometimes answers HTTP 200 with an ERROR field and no idlist. That is
    not an empty search. An empty idlist with a count is a complete zero-hit result.
    """
    if not isinstance(payload, dict):
        raise PubmedError('pubmed_response_invalid')
    if _error_text(payload.get('ERROR')) or _error_text(payload.get('error')):
        raise PubmedError('pubmed_upstream_error')
    found = payload.get('esearchresult')
    if not isinstance(found, dict):
        raise PubmedError('pubmed_esearchresult_missing')
    if _error_text(found.get('ERROR')) or _error_text(found.get('error')):
        raise PubmedError('pubmed_upstream_error')
    if 'idlist' not in found or not isinstance(found.get('idlist'), list):
        raise PubmedError('pubmed_idlist_missing')
    if any(type(item) is not str or not item.isdigit() for item in found['idlist']):
        raise PubmedError('pubmed_idlist_invalid')
    if not isinstance(found.get('count'), str) or not found['count'].isdigit():
        raise PubmedError('pubmed_count_missing')
    return found

def load_esearch(params, attempts=REQUEST_ATTEMPTS, wait=None, clock=None, rng=None, budget=None, started=None):
    """Search once per attempt. Transport retries live in request(); payload errors share the same 3-retry budget."""
    wait = time.sleep if wait is None else wait
    clock = time.monotonic if clock is None else clock
    rng = random.random if rng is None else rng
    if budget is not None and started is None:
        started = clock()
    last = None
    for attempt in range(attempts):
        left = remaining_budget(budget, started, clock)
        if left is not None and left <= 0:
            raise PubmedBudgetExceeded()
        try:
            return parse_esearch(json.loads(request('esearch.fcgi', params, attempts=attempts,
                                                   wait=wait, clock=clock, rng=rng, budget=budget, started=started)))
        except PubmedBudgetExceeded:
            raise
        except PubmedError as exc:
            last = exc
        except (json.JSONDecodeError, UnicodeError):
            last = PubmedError('pubmed_response_invalid')
        except (urllib.error.HTTPError, http.client.IncompleteRead, TimeoutError, urllib.error.URLError, OSError):
            raise
        if attempt == attempts - 1:
            raise last
        wait_within_budget(retry_delay(attempt, rng), wait, budget, started, clock)
    raise last

def parse_fetch(raw, excluded_out=None):
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise PubmedError('pubmed_efetch_invalid') from exc
    if root.tag == 'ERROR' or root.find('.//ERROR') is not None:
        raise PubmedError('pubmed_efetch_error')
    return parse(root, excluded_out=excluded_out)

def commit_output(path, data):
    """Replace path only after the full JSON text exists. A failure leaves the previous file."""
    text = json.dumps(data, ensure_ascii=False, indent=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '.tmp')
    try:
        tmp.write_text(text)
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

def parse(root, excluded_out=None):
    items = []
    for row in root.findall('.//PubmedArticle'):
        article = row.find('./MedlineCitation/Article')
        pmid = row.findtext('./MedlineCitation/PMID')
        if article is None or not pmid:
            continue
        title = clean(''.join(article.find('ArticleTitle').itertext())) if article.find('ArticleTitle') is not None else ''
        journal = article.findtext('./Journal/Title') or article.findtext('./Journal/ISOAbbreviation') or 'PubMed'
        doi = next((n.text for n in row.findall('./PubmedData/ArticleIdList/ArticleId') if n.get('IdType') == 'doi'), '') or ''
        
        # Authors
        authors = []
        for auth in article.findall('./AuthorList/Author'):
            last = auth.findtext('LastName', '').strip()
            fore = (auth.findtext('ForeName', '') or auth.findtext('Initials', '')).strip()
            if last:
                authors.append(f"{last} {fore}".strip())
            elif auth.findtext('CollectiveName'):
                authors.append(auth.findtext('CollectiveName').strip())

        # Affiliations
        affiliations = []
        for aff in article.findall('.//AffiliationInfo/Affiliation'):
            t = clean(''.join(aff.itertext()))
            if t and t not in affiliations:
                affiliations.append(t)

        # Publication types
        pub_types = [clean(''.join(pt.itertext())) for pt in article.findall('./PublicationTypeList/PublicationType')]
        from publication_status import pubmed_relations

        # MeSH terms
        mesh_terms = [clean(''.join(m.find('DescriptorName').itertext())) for m in row.findall('.//MeshHeadingList/MeshHeading') if m.find('DescriptorName') is not None]

        # Abstract sections
        abstract_sections = []
        for n in article.findall('./Abstract/AbstractText'):
            label = (n.get('Label') or '').strip()
            txt = clean(''.join(n.itertext()))
            if txt:
                abstract_sections.append({'label': label, 'text': txt})

        abstract = '\n\n'.join(((s['label'] + ': ') if s['label'] else '') + s['text'] for s in abstract_sections)

        ad = article.find('ArticleDate')
        date_basis = 'ArticleDate'
        if ad is None:
            ad = article.find('./Journal/JournalIssue/PubDate')
            date_basis = 'JournalIssue PubDate'
        date = ''
        if ad is not None:
            year = ad.findtext('Year', '')
            month = ad.findtext('Month', '')
            day = ad.findtext('Day', '')
            if year and month.isdigit() and day.isdigit():
                date = f'{year}-{int(month):02d}-{int(day):02d}'
            elif year:
                date = year + (('-' + month.zfill(2)) if month.isdigit() else '')
            else:
                date = ad.findtext('MedlineDate', '')

        item = {
            'id': 'pmid-' + pmid,
            'pmid': pmid,
            'title': title,
            'doi': doi.lower().strip(),
            'url': 'https://doi.org/' + doi if doi else 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/',
            'pubmed_url': 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/',
            'journal': journal,
            'journalAbbreviation': article.findtext('./Journal/ISOAbbreviation') or '',
            'date': date,
            'dateBasis': date_basis,
            'category': classify(title, journal),
            'basis': 'PubMed 官方结构化元数据',
            'summary': clean(abstract),
            'summary_truncated': False,
            'authors': authors,
            'leadAuthor': authors[0] if authors else '',
            'lastAuthor': authors[-1] if len(authors) > 1 else '',
            'affiliations': affiliations,
            'pubTypes': pub_types,
            'pubmedRelations': pubmed_relations(row),
            'meshTerms': mesh_terms,
            'abstractSections': abstract_sections,
            'sourceId': 'pubmed-journal-fallback',
            'fetchedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        decision = scope_decision(item)
        if decision['action'] == 'exclude':
            if excluded_out is not None:
                excluded_out.append({
                    'pmid': pmid,
                    'title': title,
                    'doi': item['doi'],
                    'url': item['url'],
                    'reason': decision['reason'],
                    'detail': decision['detail'],
                })
            continue
        items.append(item)
    return items

def refresh(path, days, limit, now=None, wait=None, clock=None, rng=None, budget=None, started=None):
    """Fetch a complete PubMed snapshot. On any incomplete response, path is left unchanged."""
    wait = time.sleep if wait is None else wait
    clock = time.monotonic if clock is None else clock
    rng = random.random if rng is None else rng
    if budget is not None and started is None:
        started = clock()
    now = now or datetime.datetime.now(datetime.timezone.utc)
    start = (now - datetime.timedelta(days=days)).strftime('%Y/%m/%d')
    end = now.strftime('%Y/%m/%d')
    term = '(' + ' OR '.join(journal_query(j) for j in JOURNALS) + ') AND ("' + start + '"[Date - Publication] : "' + end + '"[Date - Publication])'
    found = load_esearch({'db': 'pubmed', 'term': term, 'retmode': 'json', 'retmax': limit, 'sort': 'pub date'},
                         wait=wait, clock=clock, rng=rng, budget=budget, started=started)
    ids = found['idlist']
    wait_within_budget(NCBI_MIN_INTERVAL, wait, budget, started, clock)
    items, excluded_scope = [], []
    for offset in range(0, len(ids), 150):
        wait_within_budget(NCBI_MIN_INTERVAL, wait, budget, started, clock)
        items.extend(parse_fetch(request('efetch.fcgi', {'db': 'pubmed', 'id': ','.join(ids[offset:offset+150]), 'retmode': 'xml'},
                                        wait=wait, clock=clock, rng=rng, budget=budget, started=started), excluded_out=excluded_scope))
    for exc in excluded_scope:
        print(f"[scope_filter] PubMed excluded (pmid:{exc['pmid']}): {exc['reason']} | {exc['detail']} | {exc['title'][:120]}")
    data = {
        'updatedAt': now.isoformat(),
        'query': term,
        'totalHits': int(found['count']),
        'fetched': len(items) + len(excluded_scope),
        'truncated': int(found['count']) > len(ids),
        'journals': JOURNALS,
        'excludedScopeCount': len(excluded_scope),
        'excludedScopeReasons': dict(Counter(e['reason'] for e in excluded_scope)),
        'excludedScope': excluded_scope,
        'items': items,
        'note': 'Indexing may lag publisher publication; zero hits does not prove the journal has no new articles. Structured XML parsed.'
    }
    commit_output(path, data)
    return data

def classify_failure(exc):
    """Return (httpStatus or None, fixed error category). Never include a query or key."""
    if isinstance(exc, urllib.error.HTTPError):
        detail = http_error_detail(exc)
        if exc.code == 429:
            return exc.code, 'pubmed_http_429'
        if exc.code in TRANSIENT_HTTP:
            return exc.code, 'pubmed_http_5xx'
        if is_transient_http(exc.code, detail):
            return exc.code, 'pubmed_upstream_timeout'
        return exc.code, 'pubmed_client_error'
    if isinstance(exc, TimeoutError):
        return None, 'pubmed_upstream_timeout'
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        if isinstance(reason, TimeoutError) or 'timed out' in str(reason).lower():
            return None, 'pubmed_upstream_timeout'
        return None, 'pubmed_network_error'
    if isinstance(exc, PubmedError):
        if exc.code == 'pubmed_time_budget_exceeded':
            return None, 'pubmed_time_budget_exceeded'
        return None, 'pubmed_upstream_error'
    return None, 'pubmed_network_error'


def load_previous_snapshot(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if isinstance(data, dict) and isinstance(data.get('items'), list):
        return data
    return None


def can_reuse_previous(exc, snapshot):
    if snapshot is None:
        return False
    _status, category = classify_failure(exc)
    return category != 'pubmed_client_error'


def record_pubmed_fetch(health_path, record):
    """Merge a public PubMed fetch record into source-health; keep existing feed rows."""
    from refresh_feeds import write_json_js
    from source_fallbacks import public_pubmed_fetch
    public = public_pubmed_fetch(record)
    if not public:
        raise ValueError('pubmed fetch record is not publishable')
    try:
        health = json.loads(health_path.read_text())
        if not isinstance(health, dict):
            health = {}
    except (OSError, UnicodeError, json.JSONDecodeError):
        health = {'checkedAt': public.get('checkedAt'), 'sources': []}
    if not isinstance(health.get('sources'), list):
        health['sources'] = []
    health['pubmedFetch'] = public
    health_path.parent.mkdir(parents=True, exist_ok=True)
    write_json_js(health_path, 'SOURCE_HEALTH', health)
    return public


def run(path, days, limit, now=None, wait=None, health_path=None, clock=None, rng=None, time_budget=None):
    """Refresh PubMed metadata, or reuse the previous snapshot after a transient failure."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    clock = time.monotonic if clock is None else clock
    rng = random.random if rng is None else rng
    budget = resolve_time_budget(time_budget)
    started = clock()
    health_path = Path(health_path) if health_path else path.parent / 'source-health.json'
    degradable = (urllib.error.HTTPError, TimeoutError, urllib.error.URLError,
                  http.client.IncompleteRead, OSError, PubmedError)
    try:
        data = refresh(path, days, limit, now=now, wait=wait, clock=clock, rng=rng, budget=budget, started=started)
    except degradable as exc:
        if isinstance(exc, urllib.error.HTTPError) and classify_failure(exc)[1] == 'pubmed_client_error':
            raise
        snapshot = load_previous_snapshot(path)
        if not can_reuse_previous(exc, snapshot):
            raise
        http_status, category = classify_failure(exc)
        record = {
            'status': 'failed',
            'errorCategory': category,
            'checkedAt': now.isoformat(),
            'reusedPrevious': True,
            'cachedItems': len(snapshot.get('items') or []),
        }
        if http_status is not None:
            record['httpStatus'] = http_status
        previous = snapshot.get('updatedAt')
        if isinstance(previous, str) and previous.strip():
            record['previousUpdatedAt'] = previous
        public = record_pubmed_fetch(health_path, record)
        print(json.dumps({'degraded': True, **public}, ensure_ascii=False))
        return {'degraded': True, 'pubmedFetch': public, 'items': snapshot['items']}
    record_pubmed_fetch(health_path, {'status': 'ok', 'checkedAt': now.isoformat()})
    return data


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--days', type=int, default=30)
    p.add_argument('--limit', type=int, default=1500)
    p.add_argument('--time-budget', type=float, default=None,
                   help='Maximum seconds for this PubMed step (default 240, or XINZHI_PUBMED_TIME_BUDGET_SECONDS)')
    a = p.parse_args()
    if not 1 <= a.days <= 90 or not 1 <= a.limit <= 2500:
        p.error('days 1..90; limit 1..2500')
    if a.time_budget is not None and a.time_budget < 0:
        p.error('time-budget must be >= 0')
    data = run(ROOT / 'data/pubmed.json', a.days, a.limit, time_budget=a.time_budget)
    if data.get('degraded'):
        return
    print(json.dumps({k: v for k, v in data.items() if k != 'items'}, ensure_ascii=False))

if __name__ == '__main__':
    main()
