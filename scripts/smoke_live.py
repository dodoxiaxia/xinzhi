#!/usr/bin/env python3
"""Run the t15 read-only deployment smoke checks; never submit a form."""
import argparse
from contextlib import ExitStack
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from functools import cached_property
import json
import os
from pathlib import Path
import re
import shutil
import sys
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from check_first_screen_budget import check_first_screen_budget
from check_guardrails import SECRET_PATTERNS
from public_bundle import _global
from public_split import (
    FIRST_SCREEN_DATA_BUDGET_BR, FIRST_SCREEN_GZIP_TO_BR_RATIO,
    FIRST_SCREEN_TOTAL_BUDGET_BR, critical_assets_from_html, measure_first_screen,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SITE = 'https://learn.dryz.info'
USER_AGENT = 'xinzhi-smoke/1.0 read-only'
METHODS = frozenset({'GET', 'HEAD'})
REQUEST_LIMIT = 60
BODY_LIMIT = 26 * 1024 * 1024
ASSET = re.compile(r'/(?:assets/[a-z0-9-]+\.[a-f0-9]{12}\.(?:css|js)|'
                   r'shards/readings-(?:\d{4}-\d{2}|undated)\.[a-f0-9]{12}\.js)')
MISS_DOI = '10.99999/xinzhi-smoke-not-a-paper'
NOTICE = re.compile(r'^\s*(?:retraction|expression of concern|erratum|(?:publisher\s+)?correction)\b', re.I)
NOTICE_MERGED = datetime.fromisoformat('2026-11-19T12:15:20+00:00')
NOTICE_DEPLOYED = datetime.fromisoformat('2026-11-19T12:25:10+00:00')
BEIJING = timezone(timedelta(hours=8))


class CheckError(Exception):
    pass


class SkipCheck(Exception):
    pass


def require(condition, expected, observed):
    if not condition:
        raise CheckError(f'expected {expected}; observed {observed}')


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass
class Response:
    status: int
    headers: dict
    body: bytes

    def text(self):
        return self.body.decode('utf-8')


class ReadOnlyHTTP:
    def __init__(self, base, timeout):
        parsed = urlsplit(base)
        if (parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username is not None
                or parsed.path not in {'', '/'} or parsed.query or parsed.fragment):
            raise ValueError('--base-url must be an HTTP(S) origin without credentials, path, query or fragment')
        self.base = base.rstrip('/')
        self.timeout = timeout
        self.opener = build_opener(NoRedirects)
        self.cache = {}
        self.attempts = 0
        self.write_aborts = 0
        self.other_blocks = 0

    def allowed(self, url):
        parsed = urlsplit(url)
        if (parsed.scheme, parsed.netloc) != (urlsplit(self.base).scheme, urlsplit(self.base).netloc):
            return False
        path, query = parsed.path, parsed.query
        if path == '/':
            return True
        if not query and (ASSET.fullmatch(path) or path in {'/icon.png', '/favicon.ico', '/demo-reading.html'}):
            return True
        # Only these reviewed public read paths; never allow acquisition, PDF or machine routes.
        if path == '/api/ai':
            return query == 'task=status'
        if path == '/api/library':
            params = parse_qs(query, keep_blank_values=True)
            if set(params) == {'doi'}:
                return len(params['doi']) == 1 and bool(re.fullmatch(r'10\.\d{4,9}/\S{1,240}', params['doi'][0]))
            return (set(params) <= {'cursor', 'limit'} and params.get('limit') == ['20']
                    and ('cursor' not in params or len(params['cursor']) == 1 and len(params['cursor'][0]) <= 2000))
        return False

    def _read(self, url, method):
        path = urlsplit(url).path
        require(method in METHODS, 'GET or HEAD', method)
        require(self.allowed(url), 'allowlisted same-origin read', path)
        key = (method, url)
        if key not in self.cache:
            require(self.attempts < REQUEST_LIMIT, f'at most {REQUEST_LIMIT} upstream reads',
                    f'budget exhausted before {path}')
            self.attempts += 1
            request = Request(url, method=method, headers={'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity'})
            try:
                try:
                    upstream = self.opener.open(request, timeout=self.timeout)
                except HTTPError as exc:
                    upstream = exc
                with upstream:
                    body = upstream.read(BODY_LIMIT + 1)
                    require(len(body) <= BODY_LIMIT, 'bounded response body', f'{path} exceeds {BODY_LIMIT} bytes')
                    self.cache[key] = Response(upstream.code, dict((k.lower(), v) for k, v in upstream.headers.items()), body)
            except (OSError, ValueError) as exc:
                raise CheckError(f'expected HTTP response at {path}; observed {type(exc).__name__}: {exc}') from exc
        return self.cache[key]

    def get(self, path):
        return self._read(urljoin(self.base + '/', path), 'GET')

    def head(self, path):
        return self._read(urljoin(self.base + '/', path), 'HEAD')

    def browser_route(self, route):
        request = route.request
        if request.method not in METHODS:
            self.write_aborts += 1
            route.abort()
            return
        if not self.allowed(request.url):
            self.other_blocks += 1
            route.abort()
            return
        try:
            response = self._read(request.url, request.method)
        except CheckError:
            route.fulfill(status=502, body='Smoke transport could not read the response')
            return
        if 300 <= response.status < 400:
            self.other_blocks += 1
            route.abort()
            return
        # The browser only receives these already-read bytes; no upstream cookies or redirects.
        headers = {k: v for k, v in response.headers.items()
                   if k in {'content-type', 'cache-control', 'content-security-policy', 'x-content-type-options'}}
        route.fulfill(status=response.status, headers=headers, body=response.body)


class PublicSite:
    def __init__(self, http):
        self.http = http

    def bytes(self, path):
        response = self.http.get(path)
        require(response.status == 200, f'GET {path} HTTP 200', f'HTTP {response.status}')
        return response.body

    @cached_property
    def html(self):
        return self.bytes('/')

    @cached_property
    def critical(self):
        refs, _, scripts = critical_assets_from_html(self.html.decode('utf-8'))
        apps = [s for s in scripts if re.fullmatch(r'assets/app\.[a-f0-9]{12}\.js', s)]
        require(len(apps) == 1, 'one content-hashed app script', len(apps))
        return refs, apps[0]

    @cached_property
    def app(self):
        return self.bytes(self.critical[1]).decode('utf-8')

    @cached_property
    def parts(self):
        return {name: info['src'] for name, info in _global(self.app, 'XINZHI_PARTS')['parts'].items()}

    @cached_property
    def radar_src(self):
        return _global(self.app, 'RADAR_SRC')

    def part(self, name):
        text = self.bytes(self.parts[name]).decode('utf-8')
        label = 'window.XINZHI_PART(' + json.dumps(name) + ','
        require(label in text, f'{name} data wrapper', f'wrapper missing at {self.parts[name]}')
        return json.JSONDecoder().raw_decode(text.split(label, 1)[1].lstrip())[0]

    @cached_property
    def readings(self):
        return self.part('readings')

    def assets(self):
        refs = dict.fromkeys([*self.critical[0], *self.parts.values(), self.radar_src])
        require(any(path.endswith('.css') for path in refs), 'hashed stylesheet', 'no stylesheet')
        shards = self.readings['shards'] if self.readings is not None else {}
        paths = dict.fromkeys([*refs, *shards.values()])
        failures = []
        for path in paths:
            if not ASSET.fullmatch('/' + path):
                failures.append('non-hashed or unsafe reference')
                continue
            response = self.http.get(path) if path in refs else self.http.head(path)
            header = response.headers.get('cache-control', '')
            directives = {x.strip().lower() for x in header.split(',')}
            if response.status != 200 or directives != {'public', 'max-age=31536000', 'immutable'}:
                failures.append(f'{path}: HTTP {response.status}, Cache-Control: {header or "(missing)"}')
        require(not failures, f'{len(paths)} hashed assets HTTP 200 with public, max-age=31536000, immutable',
                '; '.join(failures))
        return f'/ HTTP 200; {len(paths)} immutable hashed files ({len(shards)} reading shard references)'

    def budget(self):
        payloads = {'index.html': self.html, **{path: self.bytes(path) for path in self.critical[0]}}
        limits = {'data': FIRST_SCREEN_DATA_BUDGET_BR, 'total': FIRST_SCREEN_TOTAL_BUDGET_BR}
        try:
            import brotli
        except ImportError:
            report = measure_first_screen(payloads, brotli_module=None)
            for key, limit in limits.items():
                maximum = round(limit * FIRST_SCREEN_GZIP_TO_BR_RATIO)
                measured = report[key]['gzip']
                require(measured <= maximum, f'{key} gzip(9) <= {maximum} B', f'{measured} B')
            raise SkipCheck(f"Brotli unavailable; gzip passed (data {report['data']['gzip']} B, "
                            f"total {report['total']['gzip']} B)") from None
        report = check_first_screen_budget(payloads, brotli_module=brotli)
        return '; '.join(f"{key} gzip {report[key]['gzip']} B / brotli {report[key]['br']} B" for key in limits)

    def secrets(self):
        self.html  # Ensure --only secrets always has coverage, including the hashed app and its manifest.
        self.app
        for path in dict.fromkeys([*self.critical[0], *self.parts.values(), self.radar_src]):
            self.bytes(path)
        scanned = 0
        for (method, url), response in self.http.cache.items():
            if method != 'GET' or not response.body:
                continue
            scanned += 1
            content = response.body.decode('utf-8', errors='replace')
            for index, pattern in enumerate(SECRET_PATTERNS, 1):
                require(not pattern.search(content), 'no credential-pattern matches',
                        f'guardrail pattern {index} matched at {urlsplit(url).path} (value withheld)')
        return f'{scanned} response bodies, 0 credential-pattern matches'

    def reading_catalog(self):
        data = self.readings
        catalog_keys = {'schemaVersion', 'status', 'items', 'updatedAt', 'shards'}
        item_keys = {'pmcid', 'pmid', 'doi', 'title', 'titleZh', 'journal', 'date', 'publishedOn', 'topic',
                     'generatedAt', 'retrievedAt', 'sourceHash', 'whySelected', 'sourceUrl', 'scope', 'humanReviewed'}
        required = {'pmcid', 'title', 'titleZh', 'journal', 'date', 'publishedOn', 'sourceUrl', 'scope'}
        require(isinstance(data, dict), 'reading catalog object', type(data).__name__)
        require(set(data) <= catalog_keys, 'public catalog fields only', sorted(set(data) - catalog_keys))
        status = data.get('status', {})
        require(isinstance(status, dict) and set(status) <= {'day', 'target', 'completed', 'state', 'reason'},
                'public batch status only', 'unexpected status structure/fields')
        require(all(type(value) in {int, str} for value in status.values())
                and isinstance(data.get('updatedAt', ''), str),
                'scalar public status values', 'non-scalar value')
        shards = data.get('shards')
        require(isinstance(shards, dict) and all(isinstance(p, str) and p.startswith('shards/')
                and ASSET.fullmatch('/' + p) for p in shards.values()), 'public reading shard paths', 'invalid shard map')
        items = data.get('items')
        require(type(data.get('schemaVersion')) is int and data['schemaVersion'] == 1 and isinstance(items, list),
                'schemaVersion 1 with items list', 'missing or invalid schema/items')
        today = datetime.now(BEIJING).date()
        days = {(today - timedelta(days=i)).isoformat(): [] for i in range(7)}
        pdf_reference = re.compile(r'(?:/|\\)[^\s]*\.pdf\b', re.I)
        require(not any(pdf_reference.search(value) for value in [data.get('updatedAt', ''), *status.values()]
                        if isinstance(value, str)), 'no PDF paths or URLs', 'catalog metadata has a PDF reference')
        for index, item in enumerate(items):
            require(isinstance(item, dict), 'reading item object', f'item {index}: {type(item).__name__}')
            require(set(item) <= item_keys, 'public catalog item fields only',
                    f'item {index}: unexpected {sorted(set(item) - item_keys)}')
            require(all(type(v) is (bool if k == 'humanReviewed' else str) for k, v in item.items()),
                    'scalar public item fields', f'item {index}: unexpected value type')
            require(not any(pdf_reference.search(v)
                            for v in item.values() if isinstance(v, str)),
                    'no PDF paths or URLs', f'item {index}: PDF reference (value withheld)')
            batch_day = item.get('publishedOn')
            require(isinstance(batch_day, str) and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', batch_day)),
                    'publishedOn batch date', f'item {index}: missing or malformed publishedOn')
            date.fromisoformat(batch_day)
            if batch_day in days:
                missing = sorted(key for key in required if not item.get(key, '').strip())
                require(not missing, 'required nonempty catalog fields', f'item {index} ({batch_day}): missing {missing}')
                require(item['scope'] == 'public-fulltext-body' and
                        item['sourceUrl'] == 'https://europepmc.org/articles/' + item['pmcid'],
                        'public full-text scope and Europe PMC source link', f'item {index}: unexpected source/scope')
                days[batch_day].append(item)
        info = []
        week_ids, week_dois = set(), set()
        for day, rows in days.items():
            require(len(rows) <= 12, '≤12 readings per day', f'{day}: {len(rows)}')
            for row in rows:
                pmcid = row['pmcid'].strip().casefold()
                doi = row.get('doi', '').strip().casefold()
                require(pmcid not in week_ids and (not doi or doi not in week_dois),
                        'unique IDs and nonempty DOIs in the seven-day window', f'{day}: duplicate ID/DOI for {pmcid}')
                week_ids.add(pmcid)
                if doi:
                    week_dois.add(doi)
            journals = ', '.join(sorted({row['journal'] for row in rows})) or '—'
            info.append(f'{day}: {len(rows)} ({journals})')
        return '7 Beijing dates; journals (informational): ' + '; '.join(info)

    def notice_tags(self):
        from enrich_metadata import _load_tag_overlay, _overlay_entry

        stale = []

        def fresh(value, floor, label):
            seen = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else None
            if seen is None or seen.tzinfo is None or seen < floor:
                stale.append(f'{label}={value} (not yet regenerated; required ≥ {floor.isoformat()})')

        feeds = _global(self.app, 'FEEDS')
        radar = [self.part('radar'), _global(self.bytes(self.radar_src).decode('utf-8'), 'RADAR_ARCHIVE')]
        fresh(_global(self.app, 'CONTENT_STATUS')['builtAt'], NOTICE_MERGED, 'public build builtAt')
        fresh(feeds.get('updatedAt'), NOTICE_DEPLOYED, 'recent feeds updatedAt')
        for label, part in zip(('recent radar', 'archive radar'), radar):
            if part is not None and part.get('updatedAt') is not None:
                fresh(part['updatedAt'], NOTICE_DEPLOYED, label + ' updatedAt')
            else:
                require(part is None or not part['rows'], f'timestamp for nonempty {label}', 'missing updatedAt')
        records = [*feeds['items'], *self.part('feeds')['items']]
        for part in radar:
            if part is None:
                continue
            records.extend({'id': 'pmid:' + str(row[0]), 'doi': row[1], 'title': row[8],
                            'tags': [part['tag'][i] for i in row[7]]} for row in part['rows'])
        require(records, 'nonempty public radar data', '0 records')
        notices = [record for record in records if NOTICE.match(record['title'])]
        bad = []
        for record in notices:
            tags = record.get('tags') or []
            if tags:
                human = _overlay_entry(record, _load_tag_overlay())
                if not human or human[0] != 'human' or set(tags) - set(human[1]):
                    bad.append(record.get('id') or record.get('doi') or '(unknown id)')
        tag_evidence = f'{len(bad)}/{len(notices)} machine/unattributed tagged notices'
        if bad:
            tag_evidence += f'; IDs: {", ".join(bad[:5])}'
        require(not bad and not stale, 'fresh radar data and no machine/unattributed tags on notice titles',
                '; '.join([tag_evidence, *stale]))
        return f'{len(records)} records, {len(notices)} notices, 0 machine-tagged; feeds {feeds["updatedAt"]}'


TOTAL = re.compile(r'^共\s*([\d,]+)\s*篇$')
PAPER_BUTTON = '#articlesStream article[data-paper-id] [data-action="open-drawer"]'
READING = '#readerDrawer.open.reading-mode'
TRANSLATE = '[data-action="ai-translate"], [data-action="tr-check"]'
AI_MENU = '[data-qf-jtier-menu="ai"]'
JOURNAL = '#qfPop [data-qf-pick-journal]'
TOPIC = '#qfPop [data-qf-topic]'


def attr(name, value):
    return '[' + name + '=' + json.dumps(value, ensure_ascii=False) + ']'


def params(page):
    return {key: values[0] for key, values in parse_qs(urlsplit(page.url).query).items()}


def number(locator):
    text = locator.inner_text().strip().replace(',', '')
    require(text.isdecimal(), 'numeric preview in <small>', repr(text))
    return int(text)


def total(page, expected=None):
    locator = page.locator('#listTotal')
    page.wait_for_function(
        r'() => /^共\s*[\d,]+\s*篇$/.test(document.querySelector("#listTotal")?.textContent.trim())')
    text = locator.inner_text().strip()
    n = int(TOTAL.fullmatch(text)[1].replace(',', ''))
    if expected is not None:
        require(n == expected, f'#listTotal = {expected}', f'#listTotal = {n}')
    return n


def document_width(page):
    return page.evaluate('''async () => {
        await document.fonts.ready;
        return [document.documentElement.scrollWidth, document.documentElement.clientWidth];
    }''')


class BrowserChecks:
    def __init__(self, browser, site):
        self.browser = browser
        self.site = site

    def page(self, stack, width=1280, height=800, init=None):
        ctx = self.browser.new_context(viewport={'width': width, 'height': height}, user_agent=USER_AGENT,
                                       service_workers='block', accept_downloads=False)
        stack.callback(ctx.close)
        ctx.set_default_timeout(self.site.http.timeout * 1000)
        ctx.route('**/*', self.site.http.browser_route)
        ctx.route_web_socket('**/*', lambda ws: ws.close())
        if init:
            ctx.add_init_script(init)
        return ctx.new_page()

    def go(self, page, **query):
        path = '/?' + urlencode(query) if query else '/'
        response = page.goto(self.site.http.base + path, wait_until='load')
        require(response and response.status == 200, f'{path} HTTP 200', response.status if response else 'no response')

    def mode_ready(self, page, mode):
        tab = page.locator('.nav-tab-btn' + attr('data-mode', mode))
        tab.wait_for()
        require('active' in (tab.get_attribute('class') or '').split(), f'{mode} active tab', tab.get_attribute('class'))
        if mode == 'weekly':
            page.locator('#weeklyAuto .weekly-head').wait_for()
        else:
            total(page)

    def radar(self, page):
        self.go(page, mode='candidates')
        self.mode_ready(page, 'candidates')

    def open_journals(self, page):
        page.locator(AI_MENU).click()
        page.locator('#qfJournalSearch').wait_for()

    def basic_layout(self):
        evidence, failures = [], []
        for width, height in ((390, 844), (1280, 800)):
            with ExitStack() as stack:
                page = self.page(stack, width, height)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
                for mode in ('curated', 'weekly', 'candidates', 'library'):
                    start = len(errors)
                    try:
                        if mode == 'curated':
                            self.go(page)
                        else:
                            page.locator('.nav-tab-btn' + attr('data-mode', mode)).click()
                        self.mode_ready(page, mode)
                        actual, client = document_width(page)
                        evidence.append(f'{mode} {actual}/{client}')
                        if actual != client:
                            failures.append(f'{width}px {mode}: scrollWidth/clientWidth={actual}/{client}')
                    except Exception as exc:
                        failures.append(f'{width}px {mode}: {brief_error(exc)}')
                    for msg in errors[start:]:
                        failures.append(f'{width}px {mode}: console/page error {msg[:140]}')
                evidence.append(f'at {width}×{height}')
        require(not failures, '4 rendered modes at each viewport, no overflow or console/page errors',
                '; '.join(failures))
        return 'test_layout_ui + test_mobile_library_ui (layout subset): ' + '; '.join(evidence) + '; 0 errors'

    def journal_count(self):
        with ExitStack() as stack:
            page = self.page(stack)
            self.radar(page)
            self.open_journals(page)
            rows = page.locator(JOURNAL)
            rows.first.wait_for()
            for row in rows.all():
                n = number(row.locator('small:not(.qf-suggested)'))
                if 0 < n <= 50:
                    journal = row.get_attribute('data-qf-pick-journal')
                    row.click()
                    total(page, n)
                    require(row.get_attribute('aria-pressed') == 'true', f'{journal} selected', 'not pressed')
                    return f'{journal}: preview {n}, #listTotal {n}'
            raise SkipCheck('AI journal list has no row with 1–50 papers')

    def reading_links(self):
        feeds = _global(self.site.app, 'FEEDS')['items']
        ids = list(dict.fromkeys(p['id'] for p in feeds if isinstance(p.get('id'), str)
                                and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}', p['id'])))
        require(len(ids) >= 3, '3 distinct public feed paper IDs', len(ids))
        sample = ids[:3]
        with ExitStack() as stack:
            page = self.page(stack, init='''(() => {
                window.smokeMissingToasts = 0;
                const message = '没有找到这篇文献';
                new MutationObserver(records => {
                    for (const record of records) {
                        if (record.target.id !== 'toast') continue;
                        for (const node of record.addedNodes) {
                            if (node.textContent === message) window.smokeMissingToasts++;
                        }
                    }
                }).observe(document, {subtree: true, childList: true});
            })()''')
            for paper in sample:
                self.go(page, paper=paper)
                page.locator(READING + ' #drawerBody' + attr('data-paper-id', paper)).wait_for()
                require(params(page).get('paper') == paper, f'paper={paper}', params(page).get('paper'))
            self.go(page, paper='zzzz')
            page.wait_for_function("() => window.smokeMissingToasts > 0 && !new URLSearchParams(location.search).has('paper')")
            seen = page.evaluate('window.smokeMissingToasts')
            require(seen == 1 and page.locator(READING).count() == 0,
                    'one missing-paper toast and no reading dialog', f'{seen} toast(s), {page.locator(READING).count()} dialogs')
        return ', '.join(sample) + '; zzzz → 「没有找到这篇文献」 once, paper removed'

    def request_ui(self):
        with ExitStack() as stack:
            page = self.page(stack)
            self.go(page, mode='library', q=MISS_DOI)
            page.locator('#openRequestsBtn').click()
            modal = page.locator('#requestsModalBackdrop')
            modal.get_by_text('仅此浏览器保存', exact=True).wait_for()
            modal.locator('#refreshRequestsBtn').wait_for()
            modal.locator('#closeRequestsFootBtn').click()
            miss = page.locator('.empty-state.doi-empty')
            miss.get_by_role('heading', name='未找到站内文献', exact=True).wait_for()
            miss.locator('[data-ft-action="open-form"]').click()
            form = miss.locator('form[data-ft-form]')
            form.locator('input[type=password][name=passphrase]').wait_for()
            form.locator('button[type=submit]').wait_for()
        return '#requestsModalBackdrop 仅此浏览器保存; .doi-empty form[data-ft-form] controls visible; not submitted'

    def no_translate(self):
        with ExitStack() as stack:
            page = self.page(stack)
            self.go(page, mode='library', lane='all', view='cards')
            card_button = page.locator(PAPER_BUTTON).first
            card_button.wait_for()
            require(page.locator('#articlesStream ' + TRANSLATE.replace(', ', ', #articlesStream ')).count() == 0,
                    'no retired translation actions in cards', 'found an ai-translate or tr-check button')
            card_button.click()
            drawer = page.locator('#readerDrawer.open')
            drawer.locator('#drawerBody[data-paper-id]').wait_for()
            require(drawer.locator(TRANSLATE).count() == 0, 'no retired translation actions in drawer',
                    'found an ai-translate or tr-check button')
            drawer.locator('#drawerExpandBtn').click()
            reader = page.locator(READING)
            reader.locator('#drawerBody[data-paper-id]').wait_for()
            require(reader.locator(TRANSLATE).count() == 0, 'no retired translation actions in reading mode',
                    'found an ai-translate or tr-check button')
        return f'cards, drawer and reading mode: 0 matches for {TRANSLATE}'

    def topic_tags(self):
        with ExitStack() as stack:
            page = self.page(stack)
            self.radar(page)
            baseline = total(page)
            page.locator('[data-qf="topic"]').click()
            choices = page.locator(TOPIC)
            choices.first.wait_for()

            def pick(pred):
                for row in choices.all():
                    name = row.get_attribute('data-qf-topic')
                    n = number(row.locator('small'))
                    if pred(name, n):
                        row.click()
                        total(page, n)
                        return name, n
                raise SkipCheck('live radar has no suitable positive topic pair with different totals')

            first, single = pick(lambda name, n: 0 < n < baseline)
            require(params(page).get('tag') == first and 'tags' not in params(page),
                    f'legacy single-tag URL tag={first} without tags', params(page))
            page.get_by_text('单选时无区别。', exact=False).wait_for()
            second, union = pick(lambda name, n: name != first and n > single)
            require(params(page).get('tags') == first + ',' + second, f'tags={first},{second}', params(page))
            switches = page.get_by_role('group', name='文章主题匹配方式')
            switches.wait_for()
            intersect = switches.locator('[data-qf-topic-mode="all"]')
            both = number(intersect.locator('small'))
            intersect.click()
            total(page, both)
            require(params(page).get('tagmode') == 'all' and both <= single < union,
                    'AND URL and AND ≤ single < OR', f'{params(page)}, {both}/{single}/{union}')
            page.locator('[data-qf-topic-all]').click()
            total(page, baseline)
            require(not {'tag', 'tags'} & params(page).keys(), 'zero-tag URL without tag or tags', params(page))
        return f'{first},{second}: {single} single → {union} OR → {both} AND → {baseline} cleared; previews matched'

    def long_titles(self):
        with ExitStack() as stack:
            page = self.page(stack, 390, 844)
            self.go(page, mode='weekly', view='compact')
            self.mode_ready(page, 'weekly')
            weekly = '.weekly-row .title-open'
            page.locator(weekly).first.wait_for()
            board = self.longest_in_rows(page, weekly, '.weekly-row', 'weekly')
            page.locator('#weeklyPaneReadingTab').click()

            items = self.site.readings['items']
            require(items, 'nonempty public reading catalog to exercise titles', '0 items')
            longest = max(items, key=lambda item: len(item.get('titleZh') or item['title']))
            title = page.locator('.deep-reading-item' + attr('data-reading-id', longest['pmcid']))
            page.locator('.deep-reading-status').wait_for()
            history = page.locator('.deep-reading-history')
            if not title.is_visible() and history.count() and history.get_attribute('open') is None:
                history.locator('summary').click()
            more = page.locator('[data-action="more-daily-readings"]')
            while not title.is_visible() and more.is_visible():
                old_count = page.locator('.deep-reading-item').count()
                more.click()
                new_count = page.locator('.deep-reading-item').count()
                require(new_count > old_count, 'reading history advances', f'{old_count} → {new_count}')
            title.wait_for()
            expected = longest.get('titleZh') or longest['title']
            observed = title.locator('.deep-reading-item-title').inner_text()
            require(observed == expected, 'catalog title rendered verbatim', f'title length {len(observed)} vs {len(expected)}')
            reading = self.longest_in_rows(page, '.deep-reading-item-title', '.deep-reading-item',
                                          f'readings {longest["pmcid"]}')
        return f'390px, {board}; {reading}'

    def longest_in_rows(self, page, selector, row_selector, label):
        scroll, client = document_width(page)
        require(scroll == client, f'{label} scrollWidth == clientWidth', f'{scroll}/{client}')
        rows = page.locator(selector + ':visible').evaluate_all('''(nodes, rowSelector) => nodes.map(node => {
            const row = node.closest(rowSelector);
            const rb = row.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(node);
            const lengths = (node.getAttribute('title') || row.getAttribute('title') || node.textContent).split('\\n');
            return {
                n: Math.max(...lengths.map(t => t.length)),
                id: row.dataset.paperId || row.dataset.readingId,
                fits: [...range.getClientRects()].every(r => r.left >= rb.left - 1 && r.right <= rb.right + 1)
            };
        })''', row_selector)
        require(rows, f'{label} visible title rows', '0 rows')
        bad = [row['id'] for row in rows if not row['fits']]
        require(not bad, f'{label} titles fit within their rows', f'overflow in {bad[:5]}')
        longest = max(rows, key=lambda row: row['n'])
        return f'{label} {scroll}/{client}, {len(rows)} rows, longest {longest["id"]} ({longest["n"]} chars)'

    def zero_journals(self):
        with ExitStack() as stack:
            page = self.page(stack)
            self.radar(page)
            self.open_journals(page)
            rows = page.locator(JOURNAL)
            rows.first.wait_for()
            positive, zero = None, 0
            for row in rows.all():
                n = number(row.locator('small:not(.qf-suggested)'))
                name = row.get_attribute('data-qf-pick-journal')
                if n == 0:
                    zero += 1
                    follow = row.locator('..').locator('[data-qf-follow]')
                    require(row.is_disabled() and follow.is_enabled(),
                            'zero-count name disabled and follow enabled', f'{name}: name disabled={row.is_disabled()}, follow enabled={follow.is_enabled()}')
                elif positive is None:
                    positive = name
            require(positive, 'at least one positive AI journal for selected-zero scenario', 'none')
            picked = page.locator(JOURNAL + attr('data-qf-pick-journal', positive))
            picked.click()
            page.locator('#searchToggleBtn').click()
            page.locator('#globalSearch').fill('xinzhi-smoke-no-radar-hit-zzzz')
            page.wait_for_function("() => document.querySelector('#listTotal')?.textContent.trim() === '共 0 篇'")
            if not page.locator('#qfJournalSearch').is_visible():
                self.open_journals(page)
            picked.wait_for()
            require(number(picked.locator('small:not(.qf-suggested)')) == 0 and picked.is_enabled() and
                    picked.get_attribute('aria-pressed') == 'true',
                    'selected zero-count name remains visible, pressed, and enabled',
                    f'{positive}: {picked.inner_text()!r}, enabled={picked.is_enabled()}, pressed={picked.get_attribute("aria-pressed")}')
            picked.click()
            require(picked.get_attribute('aria-pressed') == 'false' and picked.is_disabled(),
                    'removed zero-count journal is unpressed and disabled', f'{positive}: pressed={picked.get_attribute("aria-pressed")}, disabled={picked.is_disabled()}')
        return f'{zero} initial zero rows checked; {positive} remained visible at 0 and was removable'


@dataclass
class Result:
    pr: str
    check: str
    status: str
    evidence: str


CHECKS = (
    ('203', 'DataCite DOI metadata', 'no safe GET'),
    ('205', 'Chromium layout / console', BrowserChecks.basic_layout),
    ('206', 'Radar AI journal count', BrowserChecks.journal_count),
    ('208', 'Reading-mode deep links', BrowserChecks.reading_links),
    ('209', 'Request record and DOI miss form', BrowserChecks.request_ui),
    ('210', 'Retired translation actions absent', BrowserChecks.no_translate),
    ('211', 'Radar multi-topic previews and URL', BrowserChecks.topic_tags),
    ('212', 'Longest weekly and reading titles', BrowserChecks.long_titles),
    ('213', 'Seven-day public reading catalog', PublicSite.reading_catalog),
    ('214', 'Disabled / removable zero-count journals', BrowserChecks.zero_journals),
    ('215', 'Radar notices and data freshness', PublicSite.notice_tags),
    ('assets', 'Homepage and hashed asset caching', PublicSite.assets),
    ('budget', 'First-screen size budget', PublicSite.budget),
    ('secrets', 'Credential patterns in response bodies', PublicSite.secrets),
)
BROWSER_CHECKS = {fn for _, _, fn in CHECKS if callable(fn) and hasattr(BrowserChecks, fn.__name__)}


def brief_error(exc):
    lines = str(exc).splitlines()
    first = lines[0] if lines else type(exc).__name__
    action = next((line.strip(' -') for line in lines[1:] if 'waiting for ' in line), '')
    return f'{first} ({action})' if action else first


def run_case(pr, label, callback):
    try:
        return Result(pr, label, 'PASS', callback())
    except SkipCheck as exc:
        return Result(pr, label, 'SKIP', str(exc))
    except Exception as exc:
        evidence = str(exc) if isinstance(exc, CheckError) else 'expected check to complete; observed ' + brief_error(exc)
        return Result(pr, label, 'FAIL', evidence)


def metadata_unavailable():
    raise SkipCheck('no safe GET invokes DataCite: /api/library only reads stored records; '
                    'metadata backfill, acquisition and machine registration are authenticated write paths')


def browser_unavailable(reason):
    raise SkipCheck(reason)


def chrome_location():
    configured = os.environ.get('CHROMIUM_PATH')
    return configured or shutil.which('chromium') or shutil.which('google-chrome')


def open_browser(stack):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None, 'no browser (Python Playwright missing)'
    driver = stack.enter_context(sync_playwright())
    binary = chrome_location()
    if not binary and not Path(driver.chromium.executable_path).is_file():
        return None, 'no browser (Chromium not installed; set CHROMIUM_PATH)'
    browser = driver.chromium.launch(
        headless=True, executable_path=binary,
        proxy={'server': 'http://127.0.0.1:1', 'bypass': '<-loopback>'},
        args=['--no-sandbox', '--disable-background-networking', '--disable-quic',
              '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'])
    stack.callback(browser.close)
    return browser, ''


def run_checks(http, selected, use_browser):
    results = []
    site = PublicSite(http)
    with ExitStack() as stack:
        checks = None
        skipped = 'no browser (--no-browser)'
        launch_error = None
        if use_browser and any(pr in selected and fn in BROWSER_CHECKS for pr, _, fn in CHECKS):
            try:
                browser, skipped = open_browser(stack)
                if browser:
                    checks = BrowserChecks(browser, site)
            except Exception as exc:
                launch_error = brief_error(exc)

        for pr, label, fn in CHECKS:
            if pr not in selected:
                continue
            if pr == '203':
                callback = metadata_unavailable
            elif fn in BROWSER_CHECKS:
                if launch_error:
                    results.append(Result(pr, label, 'FAIL', 'expected Chromium to launch; observed ' + launch_error))
                    continue
                callback = getattr(checks, fn.__name__) if checks else lambda: browser_unavailable(skipped)
            else:
                callback = getattr(site, fn.__name__)
            results.append(run_case(pr, label, callback))
    return results


def json_path(value):
    local = ROOT / '.local'
    candidate = Path(value).absolute()
    try:
        if local.is_symlink() or not candidate.resolve().is_relative_to(local):
            raise ValueError('--json FILE must be inside the repository .local/ directory')
        if candidate.exists() or candidate.is_symlink():
            raise ValueError('--json refuses to overwrite an existing file')
        candidate.resolve().parent.mkdir(parents=True, exist_ok=True)
        return candidate.resolve().open('x', encoding='utf-8')
    except OSError as exc:
        raise ValueError(f'cannot create --json report: {exc}') from exc


def redact(value):
    for pattern in SECRET_PATTERNS:
        value = pattern.sub('[redacted]', value)
    return value


def render_table(results):
    def cell(value):
        return ' '.join(value.splitlines()).replace('|', r'\|')

    print('| PR | Check | Status | Evidence |')
    print('| --- | --- | --- | --- |')
    for row in results:
        print('| ' + ' | '.join(cell(v) for v in asdict(row).values()) + ' |')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default=DEFAULT_SITE)
    browser_group = parser.add_mutually_exclusive_group()
    browser_group.add_argument('--browser', action='store_true', dest='browser')
    browser_group.add_argument('--no-browser', action='store_false', dest='browser')
    parser.set_defaults(browser=True)
    parser.add_argument('--only', help='comma-separated PR numbers or assets,budget,secrets')
    parser.add_argument('--json', metavar='FILE', help='new file under repo .local/, or - for stdout')
    parser.add_argument('--timeout', type=float, default=12, help='per HTTP operation / browser action, in seconds')
    args = parser.parse_args(argv)
    known = {pr for pr, _, _ in CHECKS}
    selected = {v.strip().lstrip('#') for v in args.only.split(',')} if args.only is not None else known
    if not selected <= known:
        parser.error('unknown check(s): ' + ', '.join(sorted(selected - known)))
    if not 0 < args.timeout <= 120:
        parser.error('--timeout must be >0 and ≤120 seconds')
    with ExitStack() as stack:
        try:
            http = ReadOnlyHTTP(args.base_url, args.timeout)
            dest = stack.enter_context(json_path(args.json)) if args.json and args.json != '-' else sys.stdout
        except ValueError as exc:
            parser.error(str(exc))
        results = run_checks(http, selected, args.browser)
        for row in results:
            row.evidence = redact(row.evidence)
        stats = {'upstream_reads': http.attempts, 'browser_non_get_head_aborted': http.write_aborts,
                 'browser_other_blocked': http.other_blocks}
        if args.json:
            json.dump({'results': [asdict(row) for row in results], 'transport': stats}, dest, ensure_ascii=False, indent=2)
            print(file=dest)
        if args.json != '-':
            render_table(results)
            print(f'\nTransport: {http.attempts}/{REQUEST_LIMIT} upstream GET/HEAD; '
                  f'{http.write_aborts} browser non-GET/HEAD aborted; {http.other_blocks} other requests blocked.')
    return int(any(row.status == 'FAIL' for row in results))


if __name__ == '__main__':
    sys.exit(main())
