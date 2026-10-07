#!/usr/bin/env python3
"""Fetch bounded RSS metadata once; preserve failed-source cache and current health."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import concurrent.futures
import datetime
import email.utils
import hashlib
import html
import json
from pathlib import Path
import re
import urllib.error
import urllib.request
from urllib.parse import unquote, unquote_plus, urlsplit, urlunsplit
import xml.etree.ElementTree as ET

from build_data import clean, classify

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 3_000_000
WINDOW_DAYS = 14
PILOT = ['BMJ Digital Health & AI current issue', 'Heart Online First', 'Nature Medicine',
         'NPJ Digital Medicine', 'Nature Reviews Cardiology', 'JAMA Cardiology Online First',
         'EHJ- Digital Health Advance Access', 'JACC', 'Circulation',
         'The Lancet Digital Health', 'EHJ: Advance Access', 'JAMA Network Open New Online']
ATOM_NS = 'http://www.w3.org/2005/Atom'
RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
RSS1_NS = 'http://purl.org/rss/1.0/'
SECRET_KEYS = {'token', 'access_token', 'refresh_token', 'api_key', 'apikey', 'key', 'auth',
               'authorization', 'credential', 'credentials', 'secret', 'password', 'passwd',
               'signature', 'sig', 'session', 'sessionid', 'session_id', 'jwt', 'code'}


class FeedParseError(ValueError):
    def __init__(self, status, reason):
        self.status = status
        super().__init__(reason)


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def local(tag):
    return tag.rsplit('}', 1)[-1].lower()


def namespace(tag):
    return tag[1:].split('}', 1)[0] if tag.startswith('{') else ''


def safe_url(value):
    """Keep endpoint identity useful without exposing URL credential values."""
    parts = urlsplit(value)
    host = parts.hostname or ''
    host = '[' + host + ']' if ':' in host else host
    if parts.port:
        host += ':' + str(parts.port)
    query = []
    for part in parts.query.split('&') if parts.query else []:
        key = unquote_plus(part.split('=', 1)[0]).lower().replace('-', '_')
        query.append(part.split('=', 1)[0] + '=<redacted>' if key in SECRET_KEYS or key.startswith('x_amz_') else part)
    return urlunsplit((parts.scheme, host, parts.path, '&'.join(query), ''))


def has_credentials(value):
    parts = urlsplit(value)
    if parts.username or parts.password:
        return True
    for part in parts.query.split('&') if parts.query else []:
        key = unquote_plus(part.split('=', 1)[0]).lower().replace('-', '_')
        if key in SECRET_KEYS or key.startswith('x_amz_'):
            return True
    return False


def text(element, key):
    for child in element:
        if local(child.tag) == key.lower():
            return ''.join(child.itertext()).strip()
    return ''


def dateval(raw):
    try:
        parsed = email.utils.parsedate_to_datetime(raw)
    except (ValueError, TypeError):
        try:
            parsed = datetime.datetime.fromisoformat(raw.replace('Z', '+00:00'))
        except (ValueError, TypeError, AttributeError):
            return ''
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.isoformat()


def extract_doi(link, entry):
    for child in entry:
        if local(child.tag) == 'doi':
            value = ''.join(child.itertext()).strip().lower()
            return re.sub(r'^https?://(?:dx\.)?doi\.org/', '', value)
    parsed = urlsplit(link)
    path = unquote(parsed.path)
    if parsed.hostname in ('doi.org', 'dx.doi.org'):
        return path.lstrip('/').lower()
    if parsed.hostname in ('nature.com', 'www.nature.com') and path.startswith('/articles/'):
        slug = path.split('/')[2]
        return '10.1038/' + slug.lower() if re.fullmatch(r'[a-z0-9-]+', slug) else ''
    match = re.search(r'10\.\d{4,9}/[^\s<>"?]+', path)
    value = match.group(0).rstrip('.,') if match else ''
    if parsed.hostname == 'academic.oup.com':
        value = re.sub(r'/\d+$', '', value)
    return value.lower()


def _diagnostic_text(raw):
    for prefix, encoding in ((b'\xff\xfe\x00\x00', 'utf-32'), (b'\x00\x00\xfe\xff', 'utf-32'),
                             (b'\xff\xfe', 'utf-16'), (b'\xfe\xff', 'utf-16'),
                             (b'\x00\x00\x00<', 'utf-32-be'), (b'<\x00\x00\x00', 'utf-32-le'),
                             (b'\x00<', 'utf-16-be'), (b'<\x00', 'utf-16-le')):
        if raw.startswith(prefix):
            return raw.decode(encoding, errors='replace'), encoding
    return raw.decode('utf-8-sig', errors='replace'), 'utf-8'


def _root_hint(value):
    value = value.lstrip('\ufeff \t\r\n')
    while value.startswith(('<?', '<!--')):
        end = '?>' if value.startswith('<?') else '-->'
        index = value.find(end)
        if index < 0:
            return ''
        value = value[index + len(end):].lstrip()
    match = re.match(r'<([A-Za-z_][A-Za-z0-9_.:-]*)(?=\s|/?>)', value)
    return match.group(1).rsplit(':', 1)[-1].lower() if match else ''


class _NoDTD(ET.TreeBuilder):
    def doctype(self, name, pubid, system):
        raise FeedParseError('parse_error', 'DTD declarations are not supported')


def _xml(value):
    return ET.fromstring(value, parser=ET.XMLParser(target=_NoDTD()))


def _entries(root):
    kind, ns = local(root.tag), namespace(root.tag)
    if kind == 'rss' and not ns:
        channels = [child for child in root if local(child.tag) == 'channel' and not namespace(child.tag)]
        if len(channels) != 1:
            raise FeedParseError('parse_error', 'RSS requires exactly one channel')
        return 'rss', [child for child in channels[0] if local(child.tag) == 'item' and not namespace(child.tag)]
    if kind == 'feed' and ns in ('', ATOM_NS):
        return 'atom', [child for child in root if local(child.tag) == 'entry' and namespace(child.tag) in ('', ATOM_NS)]
    if kind == 'rdf' and ns in ('', RDF_NS):
        channels = [child for child in root if local(child.tag) == 'channel' and namespace(child.tag) in ('', RSS1_NS)]
        entries = [child for child in root if local(child.tag) == 'item' and namespace(child.tag) in ('', RSS1_NS)]
        if channels:
            return 'rdf', entries
        raise FeedParseError('not_feed', 'RDF response has no RSS channel')
    raise FeedParseError('not_feed', 'Response root is not RSS/Atom/RDF')


def _recover(value):
    """Repair bounded text defects; never manufacture channels or missing tags."""
    changes = []
    protected = re.compile(r'<!\[CDATA\[.*?\]\]>|<!--.*?-->|<\?.*?\?>', re.S)
    parts, start = [], 0
    def segment(part):
        def entity(match):
            name = match.group(1)
            if name in {'amp', 'lt', 'gt', 'quot', 'apos'} or name.startswith('#'):
                return match.group(0)
            expanded = html.unescape(match.group(0))
            if expanded == match.group(0):
                raise FeedParseError('parse_error', 'Unknown XML entity')
            changes.append('html_entity')
            return expanded
        part = re.sub(r'&([A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);', entity, part)
        part, count = re.subn(r'&(?!#x[0-9a-fA-F]+;|#[0-9]+;|amp;|lt;|gt;|quot;|apos;)', '&amp;', part)
        if count:
            changes.append('bare_ampersand')
        part, count = re.subn(r'<(?=[^!?/A-Za-z_:])', '&lt;', part)
        if count:
            changes.append('text_less_than')
        return part
    for match in protected.finditer(value):
        parts.extend((segment(value[start:match.start()]), match.group(0)))
        start = match.end()
    parts.append(segment(value[start:]))
    return ''.join(parts), sorted(set(changes))


def parse_feed(raw, source, *, checked_at=None):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise FeedParseError('parse_error', 'Feed exceeds the bounded byte limit')
    diagnostic, encoding = _diagnostic_text(raw)
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', diagnostic, re.I):
        raise FeedParseError('parse_error', 'DTD/entity declarations are not supported')
    parser, warnings = 'strict', []
    try:
        root = _xml(raw)
    except (ET.ParseError, LookupError, ValueError) as error:
        if isinstance(error, FeedParseError):
            raise
        hint = _root_hint(diagnostic)
        if hint not in {'rss', 'feed', 'rdf'}:
            raise FeedParseError('not_feed', 'Response root is not RSS/Atom/RDF') from None
        declaration = re.match(r'\s*<\?xml[^>]*encoding=[\'"]([^\'"]+)', diagnostic, re.I)
        if encoding != 'utf-8' or '\ufffd' in diagnostic or declaration and declaration.group(1).lower().replace('_', '-') not in {'utf-8', 'utf8'}:
            raise FeedParseError('parse_error', 'Malformed feed cannot be recovered without guessing its encoding') from None
        repaired, warnings = _recover(diagnostic)
        try:
            root = _xml(repaired)
        except (ET.ParseError, LookupError, ValueError):
            raise FeedParseError('parse_error', 'Malformed feed XML remains invalid after bounded text recovery') from None
        parser = 'recovered'
    kind, entries = _entries(root)
    checked_at = checked_at or utcnow().isoformat()
    output, links, abstracts = [], 0, 0
    for entry in entries:
        title = clean(text(entry, 'title'))
        link = text(entry, 'link') if kind != 'atom' else ''
        if not link:
            for child in entry:
                if local(child.tag) == 'link' and child.get('rel', 'alternate') == 'alternate':
                    link = child.get('href', '')
                    if link:
                        break
        try:
            parsed = urlsplit(link)
            valid_link = parsed.scheme.lower() in {'http', 'https'} and bool(parsed.hostname) and not has_credentials(link)
        except ValueError:
            valid_link = False
        links += bool(valid_link)
        description = clean(text(entry, 'description') or text(entry, 'summary') or text(entry, 'abstract'))
        abstracts += bool(description)
        if not title or not valid_link:
            continue
        category = classify(title, source['name'])
        if category == '待分类':
            continue
        output.append({'id': 'rss-' + hashlib.sha256(link.encode()).hexdigest()[:16], 'title': title,
                       'url': safe_url(link), 'doi': extract_doi(link, entry), 'journal': source['name'],
                       'date': dateval(text(entry, 'pubDate') or text(entry, 'date') or text(entry, 'published') or text(entry, 'updated')),
                       'category': category, 'basis': 'RSS 元数据 · 待编辑核验', 'summary': description[:12000],
                       'summary_truncated': len(description) > 12000, 'sourceId': source['id'],
                       'sourceUrl': safe_url(source.get('url', '')), 'fetchedAt': checked_at})
    return {'items': output, 'rawItems': len(entries), 'classifiedItems': len(output),
            'itemsWithLinks': links, 'itemsWithAbstracts': abstracts,
            'feedType': kind, 'parser': parser, 'parserWarnings': warnings}


def parse(raw, source):
    return parse_feed(raw, source)['items']


def select_sources(library, *, all_sources=False):
    # Health is observational evidence. It never permanently removes a source.
    return [source for source in library['feeds'] if (source.get('enabled') is True or source['name'] == 'OpenAI News')
            and (all_sources or source['name'] in PILOT)]


def _report(source, **fields):
    return {'id': source['id'], 'source': source['name'], 'url': safe_url(source['url']),
            'checkedAt': utcnow().isoformat(), **fields}


def fetch(source):
    started = utcnow().isoformat()
    code = None
    try:
        if has_credentials(source['url']):
            return _report(source, ok=False, status='configuration_error', items=0, rawItems=None,
                           startedAt=started, attempted=False, error='Credential-bearing source URLs are not requested'), []
        request = urllib.request.Request(source['url'], headers={'User-Agent': 'XinZhiLearningPilot/0.1 (RSS metadata only)'})
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read(MAX_BYTES + 1)
            code = response.getcode()
        checked = utcnow().isoformat()
        details = parse_feed(raw, source, checked_at=checked)
        items = details.pop('items')
        return _report(source, ok=True, status='empty_feed' if details['rawItems'] == 0 else 'ok',
                       items=len(items), startedAt=started, checkedAt=checked, httpStatus=code,
                       attempted=True, **details), items
    except urllib.error.HTTPError as error:
        return _report(source, ok=False, status='http_error', items=0, rawItems=None,
                       startedAt=started, httpStatus=error.code, code=error.code, attempted=True,
                       error='HTTP ' + str(error.code), errorClass=type(error).__name__), []
    except FeedParseError as error:
        return _report(source, ok=False, status=error.status, items=0, rawItems=None,
                       startedAt=started, attempted=True, httpStatus=code, error=str(error), errorClass=type(error).__name__), []
    except urllib.error.URLError as error:
        # A tunnel denial is still an access refusal. Inspect only for a status
        # code and never serialize the exception's proxy/redirect URL string.
        denied = re.search(r'(?i)(?:tunnel connection failed:|HTTP Error)\s*(401|403|429)\b', str(error.reason))
        access_code = int(denied.group(1)) if denied else None
        reason = 'Transport refused request (HTTP ' + str(access_code) + ')' if access_code else 'Metadata transport request failed'
        return _report(source, ok=False, status='network_error', items=0, rawItems=None,
                       startedAt=started, attempted=True, code=access_code, error=reason, errorClass=type(error).__name__), []
    except Exception as error:
        # Exception strings can contain credential-bearing redirect/proxy URLs.
        reason = 'Request timed out' if isinstance(error, TimeoutError) else 'Metadata request failed'
        return _report(source, ok=False, status='network_error', items=0, rawItems=None,
                       startedAt=started, attempted=True, error=reason, errorClass=type(error).__name__), []


def fetch_group(sources, fetcher=fetch):
    results, blocked = [], None
    for source in sources:
        if blocked:
            report = _report(source, ok=False, status='not_checked_host_blocked', items=0, rawItems=None,
                             attempted=False, error='Same host returned HTTP ' + str(blocked) + '; URL not requested', code=blocked)
            results.append((report, []))
            continue
        report, items = fetcher(source)
        results.append((report, items))
        if report.get('code', report.get('httpStatus')) in {401, 403, 429}:
            blocked = report.get('code', report.get('httpStatus'))
    return results


def collect(sources, fetcher=fetch):
    groups = defaultdict(list)
    for source in sources:
        groups[urlsplit(source['url']).hostname].append(source)
    output = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for rows in pool.map(lambda group: fetch_group(group, fetcher), groups.values()):
            output.extend(rows)
    return output


def eligible(item, now):
    value = dateval(item.get('date', ''))
    if not value:
        return False, 'undated'
    age = (now - datetime.datetime.fromisoformat(value)).total_seconds() / 86400
    if age < -1:
        return False, 'future'
    if age > WINDOW_DAYS:
        return False, 'olderThan14Days'
    return True, None


def _previous_cache(source, previous):
    # Legacy reports omit id and names can repeat. Match both id on items and
    # the exact endpoint/name pair on reports; never join by name alone.
    endpoint = safe_url(source['url'])
    linked = any(safe_url(row.get('url', '')) == endpoint and
                 (row.get('id') == source['id'] or row.get('source', row.get('name')) == source['name']) for row in previous.get('reports', []))
    if not linked:
        return []
    return [dict(item, cacheStatus='retained_after_source_failure') for item in previous.get('items', [])
            if item.get('sourceId') == source['id'] and
            (not item.get('sourceUrl') or safe_url(item['sourceUrl']) == endpoint)]


def build_results(sources, fetched, *, previous_feeds=None, previous_health=None, now=None):
    now = now or utcnow()
    previous_feeds, previous_health = previous_feeds or {}, previous_health or {}
    source_by_id = {source['id']: source for source in sources}
    old_health = {row.get('id'): row for row in previous_health.get('sources', [])}
    reports, fresh, cached = [], [], []
    for report, items in fetched:
        source = source_by_id[report['id']]
        report = dict(report)
        report['eligibleItems'] = sum(eligible(item, now)[0] for item in items) if report['ok'] else None
        report['classifiedItems'] = len(items) if report['ok'] else None
        if report['ok']:
            fresh.extend(items)
            if report['rawItems'] and not report['eligibleItems']:
                report['status'] = 'filtered_empty'
            report['cachedItems'] = 0
        else:
            retained = _previous_cache(source, previous_feeds)
            report['cachedItems'] = sum(eligible(item, now)[0] for item in retained)
            cached.extend(retained)
        prior = old_health.get(source['id'], {})
        if safe_url(prior.get('url', '')) != safe_url(source['url']):
            # A reused catalogue ID does not transfer health across endpoints.
            prior = {}
        prior_success = prior.get('lastSuccessfulAt')
        if not prior_success and prior.get('status') in {'ok', 'empty_feed', 'filtered_empty'}:
            prior_success = prior.get('checkedAt')
        report['lastSuccessfulAt'] = report['checkedAt'] if report['ok'] else prior_success
        report['lastSuccessfulAtBasis'] = 'strict_feed_parse' if report['ok'] else prior.get('lastSuccessfulAtBasis', 'historical_health_report') if prior_success else None
        values = [item.get('fetchedAt') for item in _previous_cache(source, previous_feeds) if item.get('fetchedAt')]
        report['lastCachedFetchAt'] = max(values) if values else None
        reports.append(report)
    allitems = {}
    # A current successful observation wins over stale failed-source cache.
    for item in fresh + cached:
        allitems.setdefault((item.get('doi') or '').lower() or item['url'], item)
    output, excluded = [], Counter({'undated': 0, 'future': 0, 'olderThan14Days': 0})
    for item in allitems.values():
        keep, reason = eligible(item, now)
        if keep:
            output.append(item)
        else:
            excluded[reason] += 1
    output.sort(key=lambda item: dateval(item['date']), reverse=True)
    feeds = {'updatedAt': now.isoformat(), 'windowDays': WINDOW_DAYS, 'reports': reports,
             'candidateCount': len(output), 'excluded': dict(excluded), 'items': output,
             'allFetchedCount': len(allitems), 'currentFetchedCount': len(fresh),
             'cachedItemCount': sum(item.get('cacheStatus') == 'retained_after_source_failure' for item in output),
             'allFetchedCountBasis': 'Current classified items plus prior eligible cache retained for failed endpoints'}
    health_rows = [{**report, 'name': report['source'], 'items': report.get('rawItems'),
                    'reason': report.get('error')} for report in reports]
    health = {'checkedAt': now.isoformat(), 'summary': dict(Counter(row['status'] for row in health_rows)),
              'sources': health_rows, 'generatedBy': 'refresh_feeds',
              'note': 'Current fetch outcomes; valid feed, filtered zero and failures differ. Cached items retain their original fetchedAt. Host restrictions are not bypassed.'}
    return feeds, health


def load_previous(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_json_js(path, variable, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    path.with_suffix('.js').write_text('window.' + variable + '=' + json.dumps(value, ensure_ascii=False).replace('</', '<\\/') + ';')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--all', action='store_true', help='Fetch all enabled academic and AI sources')
    args = parser.parse_args(argv)
    library = json.loads((ROOT / 'data/library.json').read_text())
    sources = select_sources(library, all_sources=args.all)
    feeds, health = build_results(sources, collect(sources),
                                  previous_feeds=load_previous(ROOT / 'data/feeds.json'),
                                  previous_health=load_previous(ROOT / 'data/source-health.json'))
    write_json_js(ROOT / 'data/feeds.json', 'FEEDS', feeds)
    write_json_js(ROOT / 'data/source-health.json', 'SOURCE_HEALTH', health)
    print(json.dumps({key: value for key, value in feeds.items() if key != 'items'}, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
