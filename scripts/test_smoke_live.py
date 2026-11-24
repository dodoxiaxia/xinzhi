#!/usr/bin/env python3
"""Exercise the smoke CLI end to end on a tiny loopback site, never production."""
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
from types import SimpleNamespace
import json
import random
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

import smoke_live as smoke
from public_split import js

APP = 'assets/app.000000000001.js'
CSS = 'assets/style.000000000002.css'
ARCHIVE = 'assets/radar.000000000003.js'
SHARD = 'shards/readings-2026-11.000000000004.js'
PARTS = {part: f'assets/data-{part}.{index:012x}.js'
         for index, part in enumerate(('feeds', 'radar', 'readings', 'library'), 5)}
BROWSER_PRS = ','.join(pr for pr, _, fn in smoke.CHECKS if fn in smoke.BROWSER_CHECKS)
STATIC_CHECKS = '203,204,207,213,215,217,218,221,222,223,224,assets,budget,secrets'

HTML = f'''<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:title" content="Fixture">
<meta property="og:description" content="Description">
<meta property="og:url" content="https://fixture.invalid/">
<meta property="og:image" content="https://fixture.invalid/icon.png">
<meta name="twitter:card" content="summary">
<link rel="stylesheet" href="{CSS}">
<body style="margin:0"><nav id="nav"></nav><div id="main"></div><div id="toast"></div>
<button id="openRequestsBtn">申请记录</button><div id="requestsModalBackdrop" hidden>
<button id="refreshRequestsBtn">刷新</button><button id="closeRequestsFootBtn">关闭</button>DISCLOSURE</div>
<script src="{APP}"></script></body></html>'''

UI = r"""
const query = new URLSearchParams(location.search), ids = FEEDS.items.map(p => p.id);
let mode = query.get('mode') || 'curated', journal = false, tags = [], and = false, zero = false;
const $ = s => document.querySelector(s);
const main = $('#main');
const nav = $('#nav');
function render() {
  nav.innerHTML = ['curated','weekly','candidates','library'].map(m =>
    '<button class="nav-tab-btn ' + (m === mode ? 'active' : '') + '" data-mode="' + m + '">' + m + '</button>').join('');
  const n = tags.length === 2 ? (and ? 1 : 5) : tags[0] === 'A' ? 3 : tags[0] === 'B' ? 3 : 6;
  main.innerHTML = '<div id="listTotal">共 ' + (zero ? 0 : journal ? (broken.includes("206") ? 4 : 3) : n) + ' 篇</div>' +
    '<div id="articlesStream">' + ids.map(id => '<article data-paper-id="' + id +
    '"><button class="title-open" data-action="open-drawer">' +
    (broken.includes("216") ? 'Bad \ufffd title' : 'Clean café 中文 title') +
    '</button><p class="article-gist">Good gist</p></article>').join('') + '</div>';
  if (mode === 'weekly') main.innerHTML += '<div id="weeklyAuto"><div class="weekly-head">榜单</div>' +
    '<div class="weekly-row weekly-auto-item" style="max-width:300px" data-paper-id="p3"><button class="title-open">' +
    (broken.includes("212") ? '<span style="position:relative;left:300px">Title outside row</span>' : 'The longest weekly paper title') +
    '</button></div></div><button id="weeklyPaneReadingTab">全文精读</button>';
  if (mode === 'library') {
    main.innerHTML += '<button id="searchToggleBtn">搜索</button>' +
      '<input id="globalSearch" hidden><div id="activeFiltersBar"></div>';
    if (!document.querySelector('script[data-library]')) {
      const loader = document.createElement('script');
      loader.dataset.library = '';
      loader.src = XINZHI_PARTS.parts.library.src;
      document.head.append(loader);
    }
  }
  if (mode === 'candidates') main.innerHTML += '<button data-qf-jtier-menu="ai">AI期刊</button>' +
    '<button id="searchToggleBtn">搜索</button><input id="globalSearch" hidden><button data-qf="topic">主题</button>' +
    '<div id="qfPop"></div>';
  if (query.has('q')) main.innerHTML += '<div class="empty-state doi-empty"><h3>未找到站内文献</h3>' +
    '<button data-ft-action="open-form">获取全文</button><form data-ft-form hidden>' +
    '<input type="password" name="passphrase"><button type="submit">提交</button></form></div>';
}
function journalMenu() {
  $('#qfPop').innerHTML = '<input id="qfJournalSearch"><div>' +
    '<button data-qf-follow="positive">☆</button><button data-qf-pick-journal="positive" aria-pressed="' + journal + '"' +
    (zero && !journal ? ' disabled' : '') + '><small>' + (zero ? 0 : 3) + '</small></button></div>' +
    '<div><button data-qf-follow="empty">☆</button><button data-qf-pick-journal="empty"' +
    (broken.includes("214") ? '' : ' disabled') + '><small>0</small></button></div>';
}
function topicMenu() {
  const param = new URLSearchParams({mode});
  if (tags.length === 1) param.set('tag', tags[0]);
  if (tags.length === 2 && !broken.includes("211")) param.set('tags', tags.join(','));
  if (and) param.set('tagmode', 'all');
  history.replaceState(null, '', '?' + param);
  $('#qfPop').innerHTML = (tags.length === 1 ? '<p>单选时无区别。</p>' : '') +
    '<div role="group" aria-label="文章主题匹配方式"><button data-qf-topic-mode="all">AND<small>1</small></button></div>' +
    '<button data-qf-topic-all>清空</button>' +
    ['A','B'].map(t => '<button data-qf-topic="' + t + '"><small>' +
      (tags.length === 1 && !tags.includes(t) ? 5 : 3) + '</small></button>').join('');
}
function drawer(id, reading) {
  main.insertAdjacentHTML('beforeend','<div id="readerDrawer" class="open ' + (reading ? 'reading-mode' : '') + '">' +
    '<div id="drawerBody" data-paper-id="' + id + '">Paper</div><button id="drawerExpandBtn">展开</button>' +
    (broken.includes("210") && reading ? '<button data-action="ai-translate">翻译</button>' : '') + '</div>');
}
document.addEventListener('click', e => {
  const d = e.target.closest('button')?.dataset;
  if (!d) return;
  const button = e.target.closest('button');
  if (d.mode) { mode = d.mode; render(); }
  if (d.qfJtierMenu) journalMenu();
  if (d.qfPickJournal) { journal = !journal; render(); journalMenu(); if (zero) $('#globalSearch').hidden = false; }
  if (d.qf === 'topic') topicMenu();
  if (d.qfTopic || d.qfTopicMode || Object.hasOwn(d,'qfTopicAll')) {
    if (d.qfTopic) tags.push(d.qfTopic);
    else if (d.qfTopicMode) and = true;
    else { tags = []; and = false; }
    render(); topicMenu();
  }
  if (button.id === 'searchToggleBtn') $('#globalSearch').hidden = false;
  if (button.id === 'openRequestsBtn') $('#requestsModalBackdrop').hidden = false;
  if (button.id === 'closeRequestsFootBtn') $('#requestsModalBackdrop').hidden = true;
  if (d.ftAction) $('.doi-empty form').hidden = false;
  if (d.action === 'open-drawer') drawer(ids[0], false);
  if (button.id === 'drawerExpandBtn') { $('#readerDrawer').remove(); drawer(ids[0], true); }
  if (button.id === 'weeklyPaneReadingTab') {
    main.insertAdjacentHTML('beforeend','<div class="deep-reading-status">今日已更新</div>' +
      '<button class="deep-reading-item" data-reading-id="PMCfixture"><span class="deep-reading-item-title">最长的公开精读题名</span></button>');
  }
});
document.addEventListener('input', e => {
  if (e.target.id !== 'globalSearch') return;
  if (mode === 'library') {
    const q = e.target.value, url = new URL(location.href);
    url.searchParams.set('q', q);
    const expansions = {房颤消融: '房颤 → atrial fibrillation；消融 → ablation', AF: 'AF → atrial fibrillation'};
    const terms = expansions[q] || (broken.includes('search-english') ? 'ablation → spurious' : '');
    $('#activeFiltersBar').innerHTML = terms && !(broken.includes('219') && q === 'AF')
      ? '<span data-search-expansion>已按 ' + terms + ' 检索</span>' : '';
    $('#listTotal').textContent = '共 ' + (terms && !broken.includes('search-zero') ? 4 : 0) + ' 篇';
    history.replaceState(null, '', url);
    return;
  }
  zero = true;
  $('#listTotal').textContent = '共 0 篇';
  journalMenu();
});
window.XINZHI_PART = () => {};
render();
if (query.has('list')) {
  const shared = atob(query.get('list').slice(3).replace(/-/g, '+').replace(/_/g, '/')).split('\n');
  const visible = broken.includes('220') ? shared.slice(0, 1) : shared;
  main.insertAdjacentHTML('beforeend', '<div id="sharedShortlistBanner"><h2 id="sharedShortlistTitle">' +
    '正在查看分享的清单（' + visible.length + ' 篇）</h2></div><div id="sharedShortlistRows">' +
    visible.map(id => '<div data-paper-id="' + id + '"><button class="title-open">Paper</button></div>').join('') + '</div>');
  if (broken.includes('share-write')) localStorage.setItem('xinzhi_huddle_ids', JSON.stringify(shared));
}
if (query.has('paper')) {
  if (ids.includes(query.get('paper'))) drawer(query.get('paper'), true);
  else {
    $('#toast').textContent = '没有找到这篇文献';
    if (broken.includes("208")) $('#toast').textContent = '没有找到这篇文献';
    query.delete('paper'); history.replaceState(null, '', '/');
  }
}
if (broken.includes("205")) console.error('synthetic console failure');
"""


def fixtures(broken=()):
    broken = set(broken)
    now = max(datetime.now(smoke.BEIJING), smoke.NOTICE_DEPLOYED.astimezone(smoke.BEIJING))
    day = now.date().isoformat()
    today = datetime.now(smoke.BEIJING).date().isoformat()
    timestamp = now.isoformat()
    age = 40 if 'old' in broken else 2 if 'waiting' in broken else None
    radar_stamp = (datetime.now(timezone.utc) - timedelta(hours=age)).isoformat() if age else timestamp
    reading = dict(pmcid='PMCfixture', title='Longest public reading', titleZh='最长的公开精读题名',
                   journal='Fixture Journal', date=day, publishedOn=today,
                   sourceUrl='https://europepmc.org/articles/PMCfixture', scope='public-fulltext-body')
    reading_rows = [reading]
    if 'duplicate' in broken:
        reading_rows.append(dict(reading))
    readings = {'schemaVersion': 1, 'items': reading_rows, 'shards': {'2026-11': SHARD}}
    if '213' in broken:
        readings['wanted'] = []
    paper_rows = [{'id': f'p{i}', 'title': f'Public title {i}', 'tags': []} for i in range(1, 4)]
    if 'shortlist-single' in broken:
        paper_rows = paper_rows[:1]
    elif 'shortlist-empty' in broken:
        paper_rows = []
    feeds = {'updatedAt': timestamp, 'items': paper_rows}
    radar = {'updatedAt': radar_stamp, 'rows': [], 'tag': ['#预防/血脂']}
    archive = {**radar, 'rows': [['123456789', '', day, 0, 0, 0, 0,
                                 [0] if '215' in broken else [], 'Retraction of: Public title']]}
    manifest = {'parts': {name: {'src': path} for name, path in PARTS.items()}}
    first = {'XINZHI_PARTS': manifest, 'RADAR_SRC': ARCHIVE, 'FEEDS': feeds,
             'CONTENT_STATUS': {'builtAt': timestamp}}
    app = '\n;\n'.join([*(js(k, v) for k, v in first.items()),
                         f'const broken={json.dumps(sorted(broken))};', UI])
    css = 'body {color: black}\n'
    if 'budget' in broken:
        css += '/*' + random.Random(0).randbytes(350000).hex() + '*/'
    if 'secrets' in broken:
        css += '/*' + 'AK' + 'IA' + 'A1B2C3D4E5F6G7H8' + '*/'
    html = HTML.replace('DISCLOSURE', '' if '209' in broken else '<small>仅此浏览器保存</small>')
    if 'og-duplicate' in broken:
        html += '<meta property="og:title" content="Duplicate">'
    robots = 'User-agent: *\nSitemap: https://fixture.invalid/sitemap.xml\n'
    if '223' not in broken:
        robots += 'Disallow: /api/\n'
    sitemap_path = '/api/x' if 'sitemap-api' in broken else '/?paper=p1' if 'sitemap-paper' in broken else '/'
    sitemap = ('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
               f'<url><loc>https://fixture.invalid{sitemap_path}</loc></url></urlset>')
    documents = {
        '/robots.txt': (robots, 'text/plain'),
        '/sitemap.xml': (sitemap, 'application/xml'),
        '/demo-reading': ('Demo', 'text/html'),
        '/': (html, 'text/html'),
        '/' + APP: (app, 'application/javascript'),
        '/' + CSS: (css, 'text/css'),
        '/' + ARCHIVE: (js('RADAR_ARCHIVE', archive), 'application/javascript'),
        '/' + SHARD: ('', 'application/javascript'),
    }
    library = {'papers': paper_rows}
    if 'library-text' in broken:
        library['papers'] = [{'title': r'Literal \u1234 residue'}]
    for name, payload in {'feeds': {'items': []}, 'radar': radar, 'readings': readings, 'library': library}.items():
        body = 'window.XINZHI_PART&&window.XINZHI_PART(' + json.dumps(name) + ',' + json.dumps(payload) + ');'
        documents['/' + PARTS[name]] = (body, 'application/javascript')
    return documents, broken


@contextmanager
def serve(broken=(), redirects=None):
    documents, broken = fixtures(broken)
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            calls.append((self.command, self.path, self.headers.get('User-Agent')))
            url = urlsplit(self.path)
            if redirects and url.path in redirects:
                self.send_response(308)
                self.send_header('Location', redirects[url.path])
                self.end_headers()
                return
            if url.path == '/api/library':
                payload = {'ok': True, 'found': False} if 'doi' in parse_qs(url.query) else {'ok': True, 'papers': []}
                body, content_type = json.dumps(payload), 'application/json'
            else:
                body, content_type = documents.get(url.path, ('', 'text/plain'))
            status = 200 if url.path in documents or url.path == '/api/library' else 404
            if smoke.NOT_FOUND.fullmatch(url.path):
                body = '<h1>页面未找到</h1><a href="/">首页</a>'
                if 'unknown-200' in broken:
                    status = 200
            if url.path in smoke.PRIVATE_PATHS:
                if '222' in broken:
                    status = 200
                if 'pdf' in broken:
                    content_type = 'Application/PDF'
            self.send_response(status)
            self.send_header('Content-Type', content_type + '; charset=utf-8')
            if url.path in documents and url.path != '/' and not ('assets' in broken and url.path == '/' + CSS):
                self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body.encode('utf-8'))

        do_HEAD = do_GET
        do_POST = do_GET
        do_PUT = do_GET
        do_DELETE = do_GET

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f'http://127.0.0.1:{server.server_port}', calls
        finally:
            server.shutdown()
            worker.join()


def invoke(base, *args, json_stdout=True):
    output = io.StringIO()
    argv = ['--base-url', base, '--timeout', '1.5', *args]
    with redirect_stdout(output):
        code = smoke.main([*argv, '--json', '-'] if json_stdout else argv)
    return code, json.loads(output.getvalue()) if json_stdout else output.getvalue()


def require_browser(test):
    return unittest.skipUnless(  # verify-allow: suite runs without the optional browser
        browser_is_installed(), 'Chromium/Playwright optional; static and no-browser assertions still run'
    )(test)


def browser_is_installed():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False
    with sync_playwright() as driver:
        return bool(smoke.chrome_location() or smoke.Path(driver.chromium.executable_path).is_file())


class SmokeTests(unittest.TestCase):
    def assert_report(self, data, expected):
        self.assertEqual(set(expected), {row['pr'] for row in data['results']})
        for row in data['results']:
            with self.subTest(pr=row['pr']):
                self.assertEqual(expected[row['pr']], row['status'], row['evidence'])
                self.assertTrue(row['evidence'])
                if row['status'] == 'FAIL':
                    self.assertRegex(row['evidence'], r'expected .*observed')

    def test_static_passing_fixtures(self):
        with serve() as (base, calls):
            code, data = invoke(base, '--no-browser', '--only', STATIC_CHECKS)
        expected = dict.fromkeys(STATIC_CHECKS.split(','), 'PASS')
        for pr, _, check in smoke.CHECKS:
            if pr in expected and isinstance(check, str):
                expected[pr] = 'SKIP'
        try:
            import brotli  # noqa: F401
        except ImportError:
            expected['budget'] = 'SKIP'
        self.assert_report(data, expected)
        self.assertEqual(code, 0)
        self.assertTrue(all(ua == smoke.USER_AGENT and method in smoke.METHODS for method, _, ua in calls))
        self.assertTrue(any(path == '/' + SHARD and method == 'HEAD' for method, path, _ in calls))
        self.assertEqual({method for method, _, _ in calls}, {'GET', 'HEAD'})
        self.assertEqual(smoke.METHODS, {'GET', 'HEAD'})
        self.assertEqual([method for method, path, _ in calls if path in smoke.PRIVATE_PATHS],
                         ['HEAD'] * len(smoke.PRIVATE_PATHS))
        self.assertFalse(any('/api/' in path for _, path, _ in calls))
        self.assertLessEqual(len(calls), smoke.REQUEST_LIMIT)

    def test_static_broken_fixtures(self):
        broken = ('213', '215', 'assets', 'budget', 'secrets')
        with serve(broken) as (base, _):
            code, data = invoke(base, '--no-browser', '--only', ','.join(broken))
        self.assert_report(data, dict.fromkeys(broken, 'FAIL'))
        self.assertEqual(code, 1)
        self.assertNotIn('A1B2C3D4E5F6G7H8', json.dumps(data))

    def test_wait_and_stalled_radar(self):
        floor = datetime.now(timezone.utc) - timedelta(hours=1)
        with patch.object(smoke, 'NOTICE_DEPLOYED', floor):
            for problems, status, age in ((('waiting',), 'WAIT', 2), (('old',), 'FAIL', 40)):
                with self.subTest(status=status), serve(problems) as (base, _):
                    code, data = invoke(base, '--no-browser', '--only', '215,221,224')
                    self.assert_report(data, {'215': status, '221': 'SKIP', '224': 'SKIP'})
                    self.assertEqual(code, int(status == 'FAIL'))
                    evidence = data['results'][0]['evidence']
                    self.assertIn(f'age {age}.0 h', evidence)
                    self.assertIn(f'required ≥ {floor.isoformat()}', evidence)
                    self.assertIn('recent radar updatedAt=', evidence)
                    self.assertEqual('daily refresh stalled' in evidence, status == 'FAIL')
            with serve(('duplicate', 'waiting', '215')) as (base, _):
                code, data = invoke(base, '--no-browser', '--only', '213,215')
                self.assert_report(data, {'213': 'FAIL', '215': 'FAIL'})
                self.assertEqual(code, 1)
                self.assertIn('duplicate ID/DOI', data['results'][0]['evidence'])
                self.assertIn('1/1 machine/unattributed', data['results'][1]['evidence'])

    def test_static_probe_regressions(self):
        for fault, pr in (('223', '223'), ('unknown-200', '223'), ('sitemap-api', '223'),
                          ('sitemap-paper', '223'), ('og-duplicate', '223'), ('222', '222'), ('pdf', '222')):
            with self.subTest(fault=fault), serve((fault,)) as (base, _):
                code, data = invoke(base, '--no-browser', '--only', pr)
                self.assertEqual(code, 1)
                self.assert_report(data, {pr: 'FAIL'})

    @require_browser
    def test_browser_probe_counterexamples(self):
        for fault, pr in (('library-text', '216'), ('search-english', '219'), ('search-zero', '219'),
                          ('share-write', '220')):
            with self.subTest(fault=fault), serve((fault,)) as (base, _):
                code, data = invoke(base, '--only', pr)
                self.assertEqual(code, 1)
                self.assert_report(data, {pr: 'FAIL'})

        for fault, count in (('shortlist-single', 1), ('shortlist-empty', 0)):
            with self.subTest(fault=fault), serve((fault,)) as (base, _):
                code, data = invoke(base, '--only', '220')
                self.assertEqual(code, 0)
                self.assert_report(data, {'220': 'WAIT'})
                evidence = data['results'][0]['evidence']
                self.assertIn(f'{count} distinct public paper IDs', evidence)
                self.assertIn('waiting for curated data refresh', evidence)

    def test_text_artifact_classes(self):
        self.assertEqual(smoke.clean_text(['正常 café', 'ablation/n'], 'fixture'), 2)
        for value in ('\ufffd', '\x00', '\n', '\x85', r'\n', r'\u12'):
            with self.subTest(value=value), self.assertRaises(smoke.CheckError):
                smoke.clean_text([value], 'fixture')

    @require_browser
    def test_navigation_timeout_only_retried_once(self):
        from playwright.sync_api import TimeoutError

        checks = smoke.BrowserChecks(None, smoke.PublicSite(smoke.ReadOnlyHTTP('http://localhost', 2)))
        page = Mock()
        ok = SimpleNamespace(status=200)
        for outcomes, status in (((TimeoutError('fixture timeout'), ok), 'PASS'), ((TimeoutError('fixture timeout'), TimeoutError('fixture timeout')), 'FAIL'),
                                 ((SimpleNamespace(status=503),), 'FAIL')):
            with self.subTest(outcomes=outcomes):
                page.reset_mock()
                checks.navigation.clear()
                page.goto.side_effect = outcomes
                result = smoke.run_case('205', 'navigation', lambda: checks.go(page))
                self.assertEqual(result.status, status)
                self.assertEqual([call.kwargs['timeout'] for call in page.goto.call_args_list],
                                 list(smoke.NAVIGATION_TIMEOUTS[:len(outcomes)]))
                self.assertEqual(len(checks.navigation), 2 if len(outcomes) == 2 else 0)

    @require_browser
    def test_browser_checks_pass_and_fail_on_real_chromium(self):
        browser_prs = BROWSER_PRS.split(',')
        for broken in ((), browser_prs):
            with self.subTest(broken=bool(broken)), serve(broken) as (base, calls):
                code, data = invoke(base, '--browser', '--only', BROWSER_PRS)
                self.assert_report(data, dict.fromkeys(browser_prs, 'FAIL' if broken else 'PASS'))
                self.assertEqual(code, int(bool(broken)))
                self.assertEqual(len(calls), data['transport']['upstream_reads'])
                self.assertTrue(all(method in smoke.METHODS for method, _, _ in calls))
                self.assertLessEqual(len(calls), smoke.REQUEST_LIMIT)
                self.assertEqual(data['transport']['browser_non_get_head_aborted'], 0)

    @require_browser
    def test_context_aborts_non_read_methods_before_network(self):
        with serve() as (base, calls), smoke.ExitStack() as stack:
            http = smoke.ReadOnlyHTTP(base, 2)
            browser, _ = smoke.open_browser(stack)
            checks = smoke.BrowserChecks(browser, smoke.PublicSite(http))
            page = checks.page(stack)
            checks.go(page)
            outcomes = page.evaluate('''() => Promise.all(['POST','PUT','DELETE'].map(method =>
                fetch(location.href,{method}).then(() => 'sent', () => 'blocked')))''')
            self.assertEqual(outcomes, ['blocked'] * 3)
            self.assertEqual(http.write_aborts, 3)
            self.assertFalse(any(method not in smoke.METHODS for method, _, _ in calls))

    def test_http_refuses_write_disallowed_get_and_redirect(self):
        with serve(redirects={'/': '/icon.png'}) as (base, calls):
            http = smoke.ReadOnlyHTTP(base, 2)
            with self.assertRaisesRegex(smoke.CheckError, 'GET or HEAD'):
                http._read(base + '/', 'POST')
            with self.assertRaisesRegex(smoke.CheckError, 'allowlisted'):
                http.get('/api/acquire?doi=10.1234/test-fixture')
            self.assertEqual(http.get('/').status, 308)
            with self.assertRaisesRegex(smoke.CheckError, 'allowlisted'):
                http.get(smoke.PRIVATE_PATHS[0])
        self.assertEqual(calls, [('GET', '/', smoke.USER_AGENT)])

    def test_browser_route_redirect_policy(self):
        start = '/demo-reading.html'
        for method, redirects, paths, blocked in (
            ('GET', {start: '/demo-reading'}, [start, '/demo-reading'], None),
            ('HEAD', {start: '/demo-reading'}, [start, '/demo-reading'], None),
            ('GET', {}, ['/demo-reading'], None),
            ('GET', {start: '/api/acquire?doi=hidden'}, [start], '/api/acquire'),
            ('GET', {start: 'https://other.invalid/demo-reading'}, [start], '/demo-reading'),
            ('GET', {start: '/icon.png', '/icon.png': '/favicon.ico', '/favicon.ico': '/demo-reading'},
             [start, '/icon.png', '/favicon.ico'], '/demo-reading'),
        ):
            with self.subTest(method=method, redirects=redirects), serve(redirects=redirects) as (base, calls):
                http = smoke.ReadOnlyHTTP(base, 2)
                route = Mock(request=SimpleNamespace(method=method, url=base + paths[0]))
                http.browser_route(route)
                self.assertEqual([(m, p) for m, p, _ in calls], [(method, path) for path in paths])
                self.assertEqual(http.redirects_followed, len(paths) - 1)
                self.assertEqual(list(http.blocked_paths), [blocked] if blocked else [])
                if blocked:
                    route.abort.assert_called_once()
                    route.fulfill.assert_not_called()
                else:
                    route.abort.assert_not_called()
                    self.assertEqual(route.fulfill.call_args.kwargs['status'], 200)

    def test_blocked_paths_are_bounded_deduplicated_and_queryless(self):
        http = smoke.ReadOnlyHTTP('http://localhost', 2)
        for index in range(25):
            for query in ('q=first', 'q=second'):
                http.browser_route(Mock(request=SimpleNamespace(
                    method='GET', url=f'{http.base}/blocked-{index}?{query}')))
        self.assertEqual(http.other_blocks, 50)
        self.assertEqual(list(http.blocked_paths), [f'/blocked-{index}' for index in range(20)])
        self.assertEqual(http.attempts, 0)

    def test_shared_budget_caps_requests_and_reuses_responses(self):
        with serve() as (base, calls), patch.object(smoke, 'REQUEST_LIMIT', 2):
            http = smoke.ReadOnlyHTTP(base, 2)
            self.assertIs(http.get('/'), http.get('/'))
            self.assertEqual(http.head('/' + SHARD).status, 200)
            with self.assertRaisesRegex(smoke.CheckError, 'budget exhausted'):
                http.get(APP)
        self.assertEqual([method for method, _, _ in calls], ['GET', 'HEAD'])

    def test_skip_text_is_explicit_and_exit_zero(self):
        with serve() as (base, calls):
            code, table = invoke(base, '--only', '203,205', '--no-browser', json_stdout=False)
        self.assertEqual(code, 0)
        self.assertIn('| 203 | DataCite DOI metadata | SKIP | no safe GET', table)
        self.assertIn('| 205 | Chromium layout / console | SKIP | no browser', table)
        self.assertEqual(calls, [])

    def test_json_uses_exclusive_create_and_repo_local_paths(self):
        local = smoke.ROOT / '.local'
        local.mkdir(exist_ok=True)
        with serve() as (base, calls), tempfile.TemporaryDirectory(dir=local) as directory:
            dest = smoke.Path(directory) / 'report.json'
            args = ('--only', '203', '--no-browser', '--json', str(dest))
            code, _ = invoke(base, *args, json_stdout=False)
            self.assertEqual(code, 0)
            original = dest.read_text()
            self.assertEqual(json.loads(original)['results'][0]['status'], 'SKIP')
            with redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as raised:
                invoke(base, *args, json_stdout=False)
            self.assertEqual(raised.exception.code, 2)
            self.assertIn('refuses to overwrite', err.getvalue())
            self.assertEqual(dest.read_text(), original)
            unsafe = smoke.ROOT / 'smoke-report.json'
            link = smoke.Path(directory) / 'escape.json'
            link.symlink_to(unsafe)
            with redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit):
                invoke(base, '--only', '203', '--json', str(link), json_stdout=False)
            self.assertIn('inside the repository .local/', err.getvalue())
            self.assertEqual(calls, [])


def load_tests(loader, tests, pattern):
    # run_all_tests.sh has a dedicated entry, so unittest discovery need not run it twice.
    return unittest.TestSuite() if pattern is not None else tests


if __name__ == '__main__':
    unittest.main()
