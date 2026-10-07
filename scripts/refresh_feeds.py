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
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import urllib.error
import urllib.request
from urllib.parse import unquote, unquote_plus, urlsplit, urlunsplit
import xml.etree.ElementTree as ET

from build_data import clean, classify
from abstract_quality import abstract_fields, normalize_paper

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
    def __init__(self, status, reason, metadata=None):
        self.status = status
        self.metadata = metadata or {}
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


def abstract_text(element):
    for key in ('description', 'summary', 'abstract'):
        for child in element:
            if local(child.tag) == key:
                value = (child.text or '') + ''.join(ET.tostring(node, encoding='unicode') for node in child)
                if value.strip():
                    return value
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


def _prefix_end(value, start=0):
    """Skip only XML prolog whitespace, processing instructions and comments."""
    cursor = start
    while True:
        while cursor < len(value) and value[cursor] in '\ufeff \t\r\n':
            cursor += 1
        marker = '?>' if value.startswith('<?', cursor) else '-->' if value.startswith('<!--', cursor) else None
        if marker is None:
            return cursor
        end = value.find(marker, cursor)
        if end < 0:
            return cursor
        cursor = end + len(marker)


def _root_qname(value):
    cursor = _prefix_end(value)
    match = re.match(r'<([A-Za-z_][A-Za-z0-9_.:-]*)(?=\s|/?>)', value[cursor:])
    return match.group(1) if match else ''


def _root_kind(qname):
    name = qname.rsplit(':', 1)[-1].lower()
    return {'rss': 'rss', 'feed': 'atom', 'rdf': 'rdf', 'html': 'html'}.get(name, 'other' if name else 'unknown')


def _exact_utf_text(raw):
    """Determine UTF byte order from its XML signature; never replace bytes."""
    signatures = ((b'\xff\xfe\x00\x00', 'utf-32-le', 4), (b'\x00\x00\xfe\xff', 'utf-32-be', 4),
                  (b'\xff\xfe', 'utf-16-le', 2), (b'\xfe\xff', 'utf-16-be', 2),
                  (b'\xef\xbb\xbf', 'utf-8', 3),
                  (b'\x00\x00\x00<', 'utf-32-be', 0), (b'<\x00\x00\x00', 'utf-32-le', 0),
                  (b'\x00<', 'utf-16-be', 0), (b'<\x00', 'utf-16-le', 0))
    codec, bom = 'utf-8', 0
    for signature, candidate, length in signatures:
        if raw.startswith(signature):
            codec, bom = candidate, length
            break
    value = raw[bom:].decode(codec, errors='strict')
    if value.encode(codec) != raw[bom:]:
        raise UnicodeError('UTF content is not round-trip exact')
    declaration = re.match(r'\s*<\?xml[^>]*encoding=[\'"]([^\'"]+)', value, re.I)
    if declaration:
        declared = declaration.group(1).lower().replace('_', '-').replace('utf8', 'utf-8')
        allowed = {codec, codec.split('-le')[0].split('-be')[0]}
        if declared not in allowed:
            raise UnicodeError('Declared encoding disagrees with the UTF signature')
    return value, codec, bom


def _without_safe_doctype(raw, diagnostic):
    """Remove one safe prolog declaration; no external resources are resolved."""
    metadata = {'rootKind': _root_kind(_root_qname(diagnostic)), 'doctypeKind': 'none'}
    declarations = list(re.finditer(r'<!\s*DOCTYPE\b', diagnostic, re.I))
    entity = re.search(r'<!\s*ENTITY\b', diagnostic, re.I)
    if not declarations:
        if entity:
            metadata['doctypeKind'] = 'entity_declaration'
            raise FeedParseError('parse_error', 'Entity declarations are not supported', metadata)
        return raw, diagnostic, metadata
    if len(declarations) != 1:
        metadata['doctypeKind'] = 'multiple'
        raise FeedParseError('parse_error', 'Only one pre-root DOCTYPE is supported', metadata)
    start = declarations[0].start()
    quote, subset, depth, end = None, False, 0, None
    for cursor in range(start, len(diagnostic)):
        character = diagnostic[cursor]
        if quote:
            if character == quote:
                quote = None
        elif character in {'\'', '"'}:
            quote = character
        elif character == '[':
            subset, depth = True, depth + 1
        elif character == ']':
            subset, depth = True, max(depth - 1, 0)
        elif character == '>' and depth == 0:
            end = cursor + 1
            break
    if end is None:
        metadata['doctypeKind'] = 'malformed'
        raise FeedParseError('parse_error', 'Incomplete DOCTYPE declaration', metadata)
    root_name = _root_qname(diagnostic[:start] + diagnostic[end:])
    metadata['rootKind'] = _root_kind(root_name)
    if entity or subset:
        metadata['doctypeKind'] = 'internal_subset' if subset else 'entity_declaration'
        raise FeedParseError('parse_error', 'Internal subsets and entity declarations are not supported', metadata)
    if start != _prefix_end(diagnostic):
        metadata['doctypeKind'] = 'not_pre_root'
        raise FeedParseError('parse_error', 'DOCTYPE must precede the document root', metadata)
    declaration = diagnostic[start:end]
    name = r'([A-Za-z_][A-Za-z0-9_.:-]*)'
    literal = r'(?:"[^\"]*"|\'[^\']*\')'
    patterns = (('simple', r'<!DOCTYPE\s+' + name + r'\s*>'),
                ('external_system', r'<!DOCTYPE\s+' + name + r'\s+SYSTEM\s+' + literal + r'\s*>'),
                ('external_public', r'<!DOCTYPE\s+' + name + r'\s+PUBLIC\s+' + literal + r'\s+' + literal + r'\s*>'))
    matched = None
    for kind, pattern in patterns:
        matched = re.fullmatch(pattern, declaration)
        if matched:
            metadata['doctypeKind'] = kind
            break
    if not matched:
        metadata['doctypeKind'] = 'malformed'
        raise FeedParseError('parse_error', 'Unsupported DOCTYPE syntax', metadata)
    if metadata['rootKind'] not in {'rss', 'atom', 'rdf'}:
        raise FeedParseError('not_feed', 'Response root is not RSS/Atom/RDF', metadata)
    if matched.group(1) != root_name:
        metadata['doctypeKind'] = 'name_mismatch'
        raise FeedParseError('parse_error', 'DOCTYPE name does not match the actual feed root', metadata)
    try:
        exact, codec, bom = _exact_utf_text(raw)
    except (UnicodeError, LookupError):
        metadata['doctypeKind'] = 'encoding_rejected'
        raise FeedParseError('parse_error', 'DOCTYPE cannot be removed with an exact supported UTF encoding', metadata) from None
    # Recheck positions against strict decoding, then delete only those original
    # bytes. Feed content, XML declaration and byte order are untouched.
    exact_start = _prefix_end(exact)
    if exact[exact_start:exact_start + len(declaration)] != declaration:
        metadata['doctypeKind'] = 'encoding_rejected'
        raise FeedParseError('parse_error', 'DOCTYPE span is not exact in the original encoding', metadata)
    exact_end = exact_start + len(declaration)
    byte_start = bom + len(exact[:exact_start].encode(codec))
    byte_end = bom + len(exact[:exact_end].encode(codec))
    return raw[:byte_start] + raw[byte_end:], exact[:exact_start] + exact[exact_end:], metadata


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
            # html.unescape accepts partial legacy names (e.g. &copycat;),
            # so only an exact known entity spelling is eligible for recovery.
            if name + ';' not in html.entities.html5:
                raise FeedParseError('parse_error', 'Unknown XML entity')
            # Keep the expansion as XML text (including inside attributes).
            # &LT;/&QUOT; must never manufacture tags or quote delimiters.
            expanded = html.escape(html.unescape(match.group(0)), quote=True)
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
        raise FeedParseError('parse_error', 'Feed exceeds the bounded byte limit', {'rootKind': 'unknown', 'doctypeKind': 'unknown'})
    diagnostic, encoding = _diagnostic_text(raw)
    raw, diagnostic, metadata = _without_safe_doctype(raw, diagnostic)
    parser = 'strict'
    warnings = ['doctype_ignored_without_resolution'] if metadata['doctypeKind'] != 'none' else []
    try:
        root = _xml(raw)
    except (ET.ParseError, LookupError, ValueError) as error:
        if isinstance(error, FeedParseError):
            raise
        hint = _root_hint(diagnostic)
        if hint not in {'rss', 'feed', 'rdf'}:
            raise FeedParseError('not_feed', 'Response root is not RSS/Atom/RDF', metadata) from None
        declaration = re.match(r'\s*<\?xml[^>]*encoding=[\'"]([^\'"]+)', diagnostic, re.I)
        if encoding != 'utf-8' or '\ufffd' in diagnostic or declaration and declaration.group(1).lower().replace('_', '-') not in {'utf-8', 'utf8'}:
            raise FeedParseError('parse_error', 'Malformed feed cannot be recovered without guessing its encoding', metadata) from None
        try:
            repaired, recovered_warnings = _recover(diagnostic)
            warnings.extend(recovered_warnings)
        except FeedParseError as error:
            error.metadata = metadata
            raise
        try:
            root = _xml(repaired)
        except (ET.ParseError, LookupError, ValueError):
            raise FeedParseError('parse_error', 'Malformed feed XML remains invalid after bounded text recovery', metadata) from None
        parser = 'recovered'
    try:
        kind, entries = _entries(root)
    except FeedParseError as error:
        error.metadata = metadata
        raise
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
        abstract = normalize_paper({'title': title, 'doi': extract_doi(link, entry),
                                    **abstract_fields(abstract_text(entry))})
        description = abstract['summary']
        abstracts += bool(description) and abstract.get('abstractStatus') != 'unverified'
        if not title or not valid_link:
            continue
        category = classify(title, source['name'])
        if category == '待分类':
            continue
        output.append(normalize_paper({'id': 'rss-' + hashlib.sha256(link.encode()).hexdigest()[:16], 'title': title,
                       'url': safe_url(link), 'doi': extract_doi(link, entry), 'journal': source['name'],
                       'date': dateval(text(entry, 'pubDate') or text(entry, 'date') or text(entry, 'published') or text(entry, 'updated')),
                       'category': category, 'basis': 'RSS 元数据 · 待编辑核验', 'summary': description[:12000],
                       'summary_truncated': len(description) > 12000, 'sourceId': source['id'],
                       'sourceUrl': safe_url(source.get('url', '')), 'fetchedAt': checked_at,
                       **{k:v for k,v in abstract.items() if k not in {'summary','doi','title'} and (k!='abstractSections' or len(description)<=12000)}}))
    return {'items': output, 'rawItems': len(entries), 'classifiedItems': len(output),
            'itemsWithLinks': links, 'itemsWithAbstracts': abstracts,
            'feedType': kind, 'parser': parser, 'parserWarnings': warnings, **metadata}


def parse(raw, source):
    return parse_feed(raw, source)['items']


def select_sources(library, *, all_sources=False):
    # Health is observational evidence. It never permanently removes a source.
    return [source for source in library['feeds'] if (source.get('enabled') is True or source['name'] == 'OpenAI News')
            and (all_sources or source['name'] in PILOT)]


def _report(source, **fields):
    return {'id': source['id'], 'source': source['name'], 'url': safe_url(source['url']),
            'checkedAt': utcnow().isoformat(), **fields}


class _AccessPageHints(HTMLParser):
    """Observe verification resources and canonical/form targets; never fetch them."""
    def __init__(self):
        super().__init__()
        self.verification = False
        self.cookie_requirement = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        keys = ('src',) if tag in {'img', 'script', 'iframe'} else ('action',) if tag == 'form' else ()
        if tag == 'link' and 'canonical' in (attrs.get('rel') or '').lower().split():
            keys = ('href',)
        for key in keys:
            try:
                parts = urlsplit(attrs.get(key) or '')
            except ValueError:
                continue
            self.verification |= parts.hostname == 'verify.nature.com'
            self.cookie_requirement |= 'cookies_not_supported' in parts.query.lower()


def non_feed_reason(raw, response_url):
    """Classify public landing/challenge pages without retaining their text."""
    value, _ = _diagnostic_text(raw[:100_000])
    lower = value.lower()
    hints = _AccessPageHints()
    try:
        hints.feed(value)
    except (AssertionError, ValueError):
        # Malformed HTML still stays a failed feed; diagnostic hints are optional.
        pass
    parts = urlsplit(response_url)
    if hints.cookie_requirement or 'cookies_not_supported' in parts.query.lower():
        return 'publisher_cookie_requirement'
    if hints.verification or any(marker in lower for marker in ('just a moment', 'checking your browser',
                                          'enable javascript and cookies', '_cf_chl_',
                                          'verify you are human', 'access denied')):
        return 'publisher_access_challenge'
    if re.search(r'/(?:login|signin|sign-in|sso)(?:/|$)', parts.path, re.I):
        return 'publisher_login_page'
    if parts.hostname == 'link.springer.com' and re.match(r'^/journal/\d+(?:/articles)?/?$', parts.path):
        return 'feed_redirected_to_journal_page'
    return 'html_instead_of_feed'


def fetch(source):
    started = utcnow().isoformat()
    code = None
    response_meta = {}
    raw = b''
    response_url = source['url']
    try:
        if has_credentials(source['url']):
            return _report(source, ok=False, status='configuration_error', items=0, rawItems=None,
                           startedAt=started, attempted=False, error='Credential-bearing source URLs are not requested'), []
        request = urllib.request.Request(source['url'], headers={'User-Agent': 'XinZhiLearningPilot/0.1 (RSS metadata only)'})
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read(MAX_BYTES + 1)
            code = response.getcode()
            response_url = response.geturl()
            response_meta = {'responseUrl': safe_url(response_url),
                             'responseContentType': response.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()[:120]}
        checked = utcnow().isoformat()
        details = parse_feed(raw, source, checked_at=checked)
        items = details.pop('items')
        return _report(source, ok=True, status='empty_feed' if details['rawItems'] == 0 else 'ok',
                       items=len(items), startedAt=started, checkedAt=checked, httpStatus=code,
                       attempted=True, **response_meta, **details), items
    except urllib.error.HTTPError as error:
        return _report(source, ok=False, status='http_error', items=0, rawItems=None,
                       startedAt=started, httpStatus=error.code, code=error.code, attempted=True,
                       responseUrl=safe_url(error.geturl()),
                       responseContentType=(error.headers.get('Content-Type', '') if error.headers else '').split(';', 1)[0].strip().lower()[:120],
                       error='HTTP ' + str(error.code), errorClass=type(error).__name__), []
    except FeedParseError as error:
        return _report(source, ok=False, status=error.status, items=0, rawItems=None,
                       startedAt=started, attempted=True, httpStatus=code, error=str(error), errorClass=type(error).__name__,
                       **({'failureReason': non_feed_reason(raw, response_url)} if error.status == 'not_feed' else {}),
                       **response_meta, **error.metadata), []
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
    results, blocked, blocked_reason = [], None, None
    for source in sources:
        if blocked or blocked_reason:
            report = _report(source, ok=False, status='not_checked_host_blocked', items=0, rawItems=None,
                             attempted=False, error=('Same host returned HTTP ' + str(blocked) if blocked else 'Same host requires interactive access') + '; URL not requested',
                             code=blocked, blockedReason=blocked_reason or 'http_access_refusal')
            results.append((report, []))
            continue
        report, items = fetcher(source)
        results.append((report, items))
        if report.get('code', report.get('httpStatus')) in {401, 403, 429}:
            blocked = report.get('code', report.get('httpStatus'))
        if report.get('failureReason') in {'publisher_access_challenge', 'publisher_cookie_requirement', 'publisher_login_page'}:
            blocked_reason = report['failureReason']
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
            reasons = Counter(eligible(item, now)[1] for item in items if not eligible(item, now)[0])
            report['excludedItems'] = {reason: reasons[reason] for reason in ('undated', 'future', 'olderThan14Days')}
            report['excludedItems']['unclassifiedOrInvalid'] = max(0, report['rawItems'] - len(items))
            report['latestPublishedAt'] = max((dateval(item.get('date', '')) for item in items), default=None) or None
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
