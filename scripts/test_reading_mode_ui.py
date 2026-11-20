#!/usr/bin/env python3
"""Offline reading mode acceptance. Optionally save screenshots outside the checkout."""
import argparse
import functools
import json
import os
import re
import subprocess
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LIST_QUERY = '?mode=library&lane=all&q=ReadingModeFixture&other=kept'
OPENER = '#articlesStream [data-action="open-drawer"]'
READING = '#readerDrawer.open.reading-mode'
DOWNLOADS = '[data-ft-download], [data-ft-dl-form], [data-ft-action], a[href^="/api/muse/"]'
FIRST, SECOND, THIRD, RSS, LATE = [f'reading-test-{name}' for name in ('first', 'second', 'third', 'rss', 'late')]
ABSTRACT = [
    {'label': label, 'text': text * 5}
    for label, text in (
        ('Background', 'The trial examined whether home monitoring improves the follow-up of adults with cardiovascular disease. '),
        ('Methods', 'Participants were randomly assigned to home monitoring or usual care and followed for twelve months. '),
        ('Results', 'The prespecified outcome was measured from study visits collected by a blinded assessment team. '),
        ('Conclusions', 'The findings support further evaluation of the intervention in community settings. '),
    )
]


def paper(id_, date, title, **fields):
    doi = '10.9999/' + id_
    return {'id': id_, 'doi': doi, 'title': title, 'journal': 'Circulation', 'date': date,
            'abstractSections': ABSTRACT, 'abstractSource': 'PubMed', 'url': 'https://example.invalid/' + id_,
            **fields}


PAPERS = [
    paper(FIRST, '2026-03-12', 'ReadingModeFixture: Home monitoring and cardiovascular outcomes',
          titleZh='家庭监测与心血管结局：多中心随机研究'),
    paper(SECOND, '2026-03-11', 'ReadingModeFixture: Follow-up after a cardiovascular event'),
    paper(THIRD, '2026-03-10', 'ReadingModeFixture: Cardiovascular outcomes registry', abstractSections=[]),
    paper(RSS, '2026-03-09', 'ReadingModeFixture: A note from the journal feed', abstractSections=[],
          summary='Short description from the journal feed.', abstractSource='RSS'),
    paper('reading-test-outside', '2026-03-13', 'The newest paper outside the active search'),
]
LATE_PAPER = paper(LATE, '2026-03-14', 'ReadingModeFixture: New record merged while reading')
WEEKLY_PAPERS = [
    {**source, 'date': '2026-03-14', 'weeklyPick': rank, 'weeklyCategory': category}
    for source, rank, category in zip(PAPERS[:3], [3, 1, 2], ['cardio', 'general', 'cardio'], strict=True)
]


def study():
    fields = {
        key: {'text': text, 'quote': ABSTRACT[index % len(ABSTRACT)]['text'].split('. ')[0] + '.'}
        for index, (key, text) in enumerate([
            ('question', '家庭监测能否改善心血管病患者的随访？'), ('population', '成人心血管病患者'),
            ('design', '随机分组，随访 12 个月'), ('comparator', '常规随访'),
            ('endpoints', '从预定随访评估中收集主要结局'), ('results', '需要进一步评估社区应用'),
        ])
    }
    return {'schemaVersion': 1, 'scope': 'public-abstract', 'checklist': ['在原文确认主要结局与样本量'],
            'generatedAt': '2026-03-15T08:00:00Z', 'caveat': '摘要信息有限',
            'papers': [{'key': 'doi:' + PAPERS[0]['doi'], 'title': PAPERS[0]['title'], 'status': 'available',
                        'abstract_source': 'PubMed', 'source_url': PAPERS[0]['url'], **fields}]}


class StaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def verify_viewport(browser, base, width, height, output):
    mobile = width == 390
    context = browser.new_context(viewport={'width': width, 'height': height},
                                  is_mobile=mobile, has_touch=mobile, reduced_motion='reduce')
    page = context.new_page()
    page.set_default_timeout(5500)
    page_errors, forbidden_requests = [], []
    page.on('pageerror', lambda err: page_errors.append(str(err)))
    held = []
    held_feeds = []
    delay_library = False
    delay_feeds = False
    weekly_fixture = False

    def library_script(route):
        payload = {'papers': PAPERS, 'pdfIds': [FIRST]}
        route.fulfill(content_type='application/javascript',
                      body='window.XINZHI_PART("library", ' + json.dumps(payload) + ');')

    def mock(route):
        url = urlsplit(route.request.url)
        path = url.path
        if path in {'/api/pdf', '/api/fulltext', '/api/acquire'} or route.request.method not in {'GET', 'HEAD'}:
            forbidden_requests.append((route.request.method, path))
            return route.abort()
        if path == '/api/ai' and parse_qs(url.query).get('k') == ['doi:' + PAPERS[0]['doi']] and 'task=study' in url.query:
            return route.fulfill(json={'ok': True, 'found': True, 'canGenerate': False, 'study': study()})
        if path.startswith('/api/'):
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': False,
                                       'pdfSignedLink': True, 'papers': []})
        if url.hostname == 'www.ebi.ac.uk':
            return route.fulfill(json={'resultList': {'result': []}})
        if not route.request.url.startswith(base):
            return route.abort()
        if weekly_fixture and path.startswith('/assets/app.'):
            response = route.fetch()
            feed = json.dumps({'order': {'total': len(WEEKLY_PAPERS), 'at': list(range(len(WEEKLY_PAPERS)))},
                               'items': WEEKLY_PAPERS})
            source, replaced = re.subn(r'^window\.FEEDS=.*;$', lambda _: f'window.FEEDS={feed};',
                                       response.text(), count=1, flags=re.MULTILINE)
            assert replaced == 1
            return route.fulfill(response=response, body=source)
        if weekly_fixture and path.startswith('/assets/data-feeds.'):
            return route.fulfill(content_type='application/javascript', body='window.XINZHI_PART("feeds", {"items":[],"at":[]});')
        if delay_feeds and path.startswith('/assets/data-feeds.'):
            held_feeds.append(route)
            return
        if path.startswith('/assets/data-library.'):
            if delay_library:
                held.append(route)
                return
            return library_script(route)
        if path == '/test-late-library.js':
            return route.fulfill(content_type='application/javascript', body='window.XINZHI_PART("library", '
                                 + json.dumps({'papers': [LATE_PAPER], 'pdfIds': [FIRST]}) + ');')
        return route.continue_()

    def shot(name):
        if output:
            page.screenshot(path=output / f'{width}-{name}.png', animations='disabled')

    def reading_paper(id_):
        return page.locator(f'{READING} #drawerBody[data-paper-id="{id_}"]')

    def open_toc(key):
        toc = page.locator(f'[data-reading-region="{key}"]')
        if mobile and not toc.is_visible():
            page.locator('#readingTocToggle').click()
        toc.click()

    context.route('**/*', mock)
    try:
        # An ordinary drawer opens and closes as before. Establish the form and scroll counterexamples.
        page.goto(base + LIST_QUERY)
        opener = page.locator(f'{OPENER}[data-paper-id="{FIRST}"]').first
        expect(page.locator(OPENER).first).to_have_attribute('data-paper-id', FIRST)
        opener.click()
        expand = page.locator('#drawerExpandBtn')
        body = page.locator('#drawerBody')
        expect(page.locator('#drawerCloseBtn')).to_be_focused()
        expect(page.locator(READING)).to_have_count(0)
        assert 'paper' not in parse_qs(urlsplit(page.url).query)
        expect(page.locator('#drawerBody .study-fields')).to_be_attached()
        shot('drawer')
        page.locator('#drawerCloseBtn').click()
        expect(opener).to_be_focused()
        opener.click()
        page.evaluate('''selector => {
            window.originalFulltextControls = [...document.querySelector('#drawerFulltext').querySelectorAll(selector)];
            document.querySelector('#drawerBody').scrollTop = 160;
        }''', DOWNLOADS)
        preceding_scroll = body.evaluate('(el) => el.scrollTop')
        assert preceding_scroll > 0
        expand.click()
        expect(reading_paper(FIRST)).to_be_visible()
        reading = page.get_by_role('dialog', name='阅读模式')
        expect(reading).to_have_attribute('aria-modal', 'true')
        back = page.get_by_role('button', name='返回阅读面板')
        expect(back).to_be_focused()
        expect(page.locator('#readingToolbar #drawerHuddleToggleBtn')).to_be_visible()
        expect(page.locator('#readingPrevBtn')).to_be_disabled()
        position = page.locator('#readingPosition')
        expect(position).to_have_text(f'第 1 / 共 {len(PAPERS) - 1} 篇')
        assert parse_qs(urlsplit(page.url).query)['paper'] == [FIRST]
        assert body.evaluate('(el) => el.scrollTop') == 0
        assert page.evaluate('''selector => {
            const controls = [...document.querySelector('#drawerFulltext').querySelectorAll(selector)];
            return controls.length > 0 && controls.length === originalFulltextControls.length
                && controls.every((node, index) => node === originalFulltextControls[index]);
        }''', DOWNLOADS)
        assert reading.locator('iframe, embed, object').count() == 0
        shot('full-reading')

        # Keyboard cycle and reduced-motion anchor scrolling, with both bars held in view.
        page.keyboard.press('Shift+Tab')
        expect(page.locator('#drawerExternalLink')).to_be_focused()
        page.keyboard.press('Tab')
        expect(back).to_be_focused()
        if mobile:
            expect(page.locator('#readingTocNav')).to_be_hidden()
        else:
            expect(page.locator('#readingTocNav')).to_be_visible()
            assert body.locator('[data-drawer-region="head"]').bounding_box()['width'] == 760
        page.evaluate('''() => {
            const body = document.querySelector('#drawerBody');
            const native = body.scrollTo.bind(body);
            body.scrollTo = (options) => { window.readingScrollBehavior = options.behavior; native(options); };
        }''')
        open_toc('study')
        assert page.evaluate('window.readingScrollBehavior') == 'instant'
        expect(page.locator('[data-reading-region="study"]')).to_have_attribute('aria-current', 'location')
        assert page.locator('#readingProgress').evaluate('(el) => el.value') > 0
        shot('full-reading-study')
        open_toc('fulltext')
        expect(page.locator('[data-reading-region="fulltext"]')).to_have_attribute('aria-current', 'location')
        shot('full-reading-fulltext')
        assert page.locator('.reading-mode .drawer-footer').bounding_box()['y'] > height - 100
        assert page.locator('#readingBackBtn').bounding_box()['y'] < 35
        shot('bottom-actions')

        page.emulate_media(media='print')
        expect(page.locator('#readingProgress')).to_be_hidden()
        expect(page.locator('.app-header')).to_be_hidden()
        expect(page.locator('.reading-mode .drawer-footer')).to_be_hidden()
        expect(body.locator('[data-drawer-region="fulltext"]')).to_be_visible()
        assert body.evaluate('(el) => getComputedStyle(el).overflowY') == 'visible'
        page.emulate_media(media='screen')

        # Turning pages replaces paper=, leaving only one reading layer in the back stack.
        page.locator('#readingNextBtn').click()
        expect(reading_paper(SECOND)).to_be_visible()
        expect(reading.get_by_text('仅摘要', exact=True)).to_be_visible()
        expect(reading.get_by_text('全文不可得', exact=True)).to_be_attached()
        expect(reading.locator('a[data-ft-download]:visible')).to_have_count(0)
        shot('abstract-only')
        page.locator('#readingNextBtn').click()
        expect(reading_paper(THIRD)).to_be_visible()
        expect(reading.get_by_text('暂无摘要', exact=True)).to_be_visible()
        shot('no-abstract')
        page.locator('#readingNextBtn').click()
        expect(reading_paper(RSS)).to_be_visible()
        expect(page.locator('#readingNextBtn')).to_be_disabled()
        expect(reading.get_by_text('RSS 短讯，非完整公开摘要')).to_be_visible()
        page.locator('#readingPrevBtn').click()
        expect(reading_paper(THIRD)).to_be_visible()
        page.go_back()
        expect(expand).to_be_focused()
        expect(body).to_have_attribute('data-paper-id', FIRST)
        assert abs(body.evaluate('(el) => el.scrollTop') - preceding_scroll) <= 1
        assert 'paper' not in parse_qs(urlsplit(page.url).query)
        page.go_forward()
        expect(reading_paper(THIRD)).to_be_visible()
        page.keyboard.press('Escape')
        expect(expand).to_be_focused()
        page.keyboard.press('Escape')
        expect(opener).to_be_focused()

        # Capture an uninterrupted expand → next → return sequence, using the toolbar.
        opener.click()
        expand.click()
        expect(reading_paper(FIRST)).to_be_visible()
        shot('flow-01-expand')
        page.locator('#readingNextBtn').click()
        expect(reading_paper(SECOND)).to_be_visible()
        shot('flow-02-next')
        back.click()
        expect(expand).to_be_focused()
        expect(body).to_have_attribute('data-paper-id', FIRST)
        shot('flow-03-return')

        # Bootstrap a direct link while the owning shard is intentionally held.
        delay_library = True
        delay_feeds = True
        fragment = '&' + urlencode({'paper': FIRST, 'theme': 'dark'}) + '#source'
        page.goto(base + LIST_QUERY + fragment, wait_until='domcontentloaded')
        page.wait_for_function("window.XINZHI_DATA_STATE?.library === 'loading'")
        assert len(held) == 1 and page.locator(READING).count() == 0
        delay_library = False
        library_script(held.pop())
        expect(reading_paper(FIRST)).to_be_visible()
        expect(page.get_by_role('button', name='返回列表')).to_be_focused()
        expect(page.locator('html[data-theme="dark"]')).to_be_attached()
        expect(reading.locator('.study-fields')).to_be_attached()
        expect(opener).to_have_count(0)
        shot('direct-link')
        shot('dark')

        # The existing merge/render path can change the filtered sequence underneath the reader.
        page.evaluate('''() => {
            const script = document.createElement('script');
            script.src = '/test-late-library.js';
            document.head.append(script);
        }''')
        expect(position).to_have_text(f'第 2 / 共 {len(PAPERS)} 篇')
        page.locator('#readingPrevBtn').click()
        expect(reading_paper(LATE)).to_be_visible()
        expect(reading.locator('iframe, embed, object')).to_have_count(0)
        assert parse_qs(urlsplit(page.url).query)['paper'] == [LATE] and urlsplit(page.url).fragment == 'source'
        # The original list opener can first appear after opening the direct link.
        delay_feeds = False
        held_feeds.pop().continue_()
        expect(opener).to_be_visible()
        page.go_back()
        expect(reading).to_be_hidden()
        expect(opener).to_be_focused()
        assert parse_qs(urlsplit(page.url).query)['other'] == ['kept']
        assert 'paper' not in parse_qs(urlsplit(page.url).query)

        page.goto(base + '?mode=library&lane=all&q=outside&paper=' + FIRST)
        expect(reading_paper(FIRST)).to_be_visible()
        expect(page.locator('#readingNeighbors')).to_be_hidden()
        page.get_by_role('button', name='返回列表').click()
        expect(reading).to_be_hidden()
        expect(page.locator('.nav-tab-btn[data-mode="library"]')).to_be_focused()

        # The board groups papers before displaying them. Its order differs from rank and library order.
        weekly_fixture = True
        page.clock.set_fixed_time(datetime(2026, 3, 15, 8, tzinfo=timezone.utc))
        board = '#weeklyAuto .weekly-auto-item'
        page.goto(base + '?mode=weekly')
        expect(page.locator(board)).to_have_count(len(WEEKLY_PAPERS))
        assert page.locator(board).evaluate_all('(items) => items.map(item => item.dataset.paperId)') == [THIRD, FIRST, SECOND]
        page.locator(f'{board}[data-paper-id="{THIRD}"] [data-action="open-drawer"]').click()
        expand.click()
        expect(position).to_have_text('第 1 / 共 3 篇')
        expect(page.locator('#readingPrevBtn')).to_be_disabled()
        page.locator('#readingNextBtn').click()
        expect(reading_paper(FIRST)).to_be_visible()
        page.locator('#readingNextBtn').click()
        expect(reading_paper(SECOND)).to_be_visible()
        expect(position).to_have_text('第 3 / 共 3 篇')
        expect(page.locator('#readingNextBtn')).to_be_disabled()
        page.locator('#readingPrevBtn').click()
        expect(reading_paper(FIRST)).to_be_visible()

        compact = '?mode=weekly&view=compact&wcat=cardio'
        page.goto(base + compact + '&paper=' + THIRD)
        expect(page.locator(f'li.weekly-row[data-paper-id="{THIRD}"]')).to_be_attached()
        expect(position).to_have_text('第 1 / 共 2 篇')
        page.locator('#readingNextBtn').click()
        expect(reading_paper(FIRST)).to_be_visible()
        expect(page.locator('#readingNextBtn')).to_be_disabled()
        page.goto(base + compact + '&paper=' + SECOND)
        expect(reading_paper(SECOND)).to_be_visible()
        expect(page.locator(f'{board}[data-paper-id="{SECOND}"]')).to_have_count(0)
        expect(page.locator('#readingNeighbors')).to_be_hidden()

        # The weekly read= link keeps its existing layer beneath a paper= link.
        weekly = '?mode=weekly&pane=reading&read=demo-tailored-af'
        page.goto(base + weekly + '&paper=' + FIRST)
        expect(reading_paper(FIRST)).to_be_visible()
        expect(page.get_by_role('button', name='返回列表')).to_be_focused()
        if mobile:
            expect(page.locator('#readingNeighbors')).to_be_hidden()
        else:
            expect(position).to_have_text('第 2 / 共 3 篇')
        page.go_back()
        expect(page.locator('#deepReaderClose')).to_be_focused()
        assert parse_qs(urlsplit(page.url).query)['read'] == ['demo-tailored-af']
        assert 'paper' not in parse_qs(urlsplit(page.url).query)
        page.go_forward()
        expect(reading_paper(FIRST)).to_be_visible()
        expect(page.get_by_role('button', name='返回列表')).to_be_focused()
        assert parse_qs(urlsplit(page.url).query)['read'] == ['demo-tailored-af']

        for bad in ['paper=gone-paper', 'paper=', 'paper=first&paper=second',
                    urlencode({'paper': '<b id="unexpected-url-markup">x</b>'})]:
            page.goto(base + LIST_QUERY + '&' + bad)
            expect(page.locator('#toast')).to_have_text('没有找到这篇文献')
            expect(page.locator('#unexpected-url-markup')).to_have_count(0)
            expect(reading).to_be_hidden()
            expect(opener).to_be_visible()
            assert 'paper' not in parse_qs(urlsplit(page.url).query, keep_blank_values=True)

        if mobile:
            page.close()
            page = context.new_page()
            page.set_default_timeout(5500)
            page.on('pageerror', lambda err: page_errors.append(str(err)))
            page.goto(base + '?mode=candidates&lane=all&range=14&q=ReadingModeFixture&other=kept')
            expect(page.locator('.nav-tab-btn[data-mode="candidates"]')).to_have_class(re.compile(r'\bactive\b'))
            expect(page.locator('#rangeBar select[data-range-select]')).to_have_value('14')
            page.locator('.nav-tab-btn[data-mode="library"]').click()
            expect(page.locator('.nav-tab-btn[data-mode="library"]')).to_have_class(re.compile(r'\bactive\b'))
            expect(page.locator('#rangeBar select[data-range-select]')).to_have_value('all')
            history_opener = page.locator(f'{OPENER}[data-paper-id="{FIRST}"]').first
            expect(history_opener).to_be_visible()
            history_body = page.locator('#drawerBody')
            history_opener.click()
            page.evaluate("document.querySelector('#drawerBody').scrollTop = 160")
            drawer_scroll = history_body.evaluate('(el) => el.scrollTop')
            assert drawer_scroll > 0
            page.locator('#drawerExpandBtn').click()
            expect(reading_paper(FIRST)).to_be_visible()
            history_position = page.locator('#readingPosition')
            expect(history_position).to_have_text(f'第 1 / 共 {len(PAPERS) - 1} 篇')
            page.evaluate("""() => history.replaceState(
                {...history.state, restoreHistoryMarker: 'preserved'}, '', location.href)""")

            page.evaluate('history.go(-3)')
            page.wait_for_function("""() => new URL(location.href).searchParams.get('mode') === 'candidates'
                && !document.querySelector('#readerDrawer.open')""")
            expect(page.locator('.nav-tab-btn[data-mode="candidates"]')).to_have_class(re.compile(r'\bactive\b'))
            expect(page.locator('#rangeBar select[data-range-select]')).to_have_value('14')

            page.evaluate('history.go(3)')
            page.wait_for_function("""() => new URL(location.href).searchParams.get('mode') === 'library'
                && document.querySelector('#readerDrawer.open.reading-mode')""")
            expect(page.locator('.nav-tab-btn[data-mode="library"]')).to_have_class(re.compile(r'\bactive\b'))
            expect(page.locator('#rangeBar select[data-range-select]')).to_have_value('all')
            expect(page.locator('#globalSearch')).to_have_value('ReadingModeFixture')
            expect(page.locator('#readingBackBtn')).to_be_focused()
            expect(history_position).to_have_text(f'第 1 / 共 {len(PAPERS) - 1} 篇')
            params = parse_qs(urlsplit(page.url).query)
            assert params['q'] == ['ReadingModeFixture'] and params['other'] == ['kept']
            assert params['paper'] == [FIRST] and 'range' not in params
            assert page.evaluate("history.state.restoreHistoryMarker") == 'preserved'
            assert page.evaluate('history.state.readingDrawer.top') == drawer_scroll

            page.locator('#readingNextBtn').click()
            expect(reading_paper(SECOND)).to_be_visible()
            expect(history_position).to_have_text(f'第 2 / 共 {len(PAPERS) - 1} 篇')
            page.locator('#readingPrevBtn').click()
            expect(reading_paper(FIRST)).to_be_visible()
            expect(history_position).to_have_text(f'第 1 / 共 {len(PAPERS) - 1} 篇')

            page.go_back()
            expect(page.locator('#readerDrawer.open')).to_be_visible()
            expect(page.locator(READING)).to_have_count(0)
            expect(page.locator('.nav-tab-btn[data-mode="library"]')).to_have_class(re.compile(r'\bactive\b'))
            expect(page.locator('#drawerExpandBtn')).to_be_focused()
            assert 'paper' not in parse_qs(urlsplit(page.url).query)
            assert abs(history_body.evaluate('(el) => el.scrollTop') - drawer_scroll) <= 1
            page.go_forward()
            expect(reading_paper(FIRST)).to_be_visible()
            expect(page.locator('#readingBackBtn')).to_be_focused()
            assert parse_qs(urlsplit(page.url).query)['paper'] == [FIRST]

        assert not forbidden_requests, forbidden_requests
        assert not page_errors, page_errors
        print(f'PASS {width}×{height}: layers, focus, filtered and weekly sequence, history, deferred links, contents, layout and print')
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    subprocess.run(['node', 'scripts/test_reading_mode.cjs', '--public'], cwd=ROOT, check=True)
    if args.evidence:
        args.evidence = args.evidence.resolve()
        if args.evidence.is_relative_to(ROOT):
            parser.error('evidence directory must be outside the checkout')
        args.evidence.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(StaticHandler, directory=ROOT / 'public'))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                                                 args=['--no-sandbox'])
            for width, height in [(1280, 800), (390, 844)]:
                verify_viewport(browser, f'http://127.0.0.1:{server.server_port}/', width, height, args.evidence)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
