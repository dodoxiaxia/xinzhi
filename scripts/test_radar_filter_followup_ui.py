#!/usr/bin/env python3
"""Run the radar quick filters against a deterministic, split public bundle."""
import argparse
import functools
import json
import os
import re
import sys
import tempfile
import threading
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
VIEWPORTS = [(390, 844), (1280, 800)]
TIERS = ['generalMedicine', 'cardioClinical', 'basicTranslational', 'review', 'flagship', 'ai', 'other']
NPJ = 'npj Digital Medicine'
BMC = 'BMC Medical Informatics and Decision Making'
PUBLISHER = 'AHA (Circulation)'
KEYWORD = 'radarneedle'
TODAY = date(2026, 11, 19)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def fixture_public(repo, public):
    sys.path.insert(0, str(repo / 'scripts'))
    from public_split import build_assets, js

    recent = []

    def add(journal, publisher, days=2, title='Heart outcomes', abstract='Fixture abstract'):
        key = f'radar-fixture-{len(recent)}'
        recent.append(dict(id=key, journal=journal, publisher=publisher, date=str(TODAY - timedelta(days=days)),
                           datePrecision='day', title=f'{title} ({key})', summary=abstract))

    add(NPJ, 'Springer Nature', title=f'{KEYWORD} Heart outcomes')
    add(BMC, 'Springer Nature', title='AI for medical diagnosis')
    add('Circulation', PUBLISHER, title=f'{KEYWORD} Heart trial')
    add('Circulation', PUBLISHER, title=f'{KEYWORD} Heart imaging', abstract='')
    add('Unlisted Methods Journal', PUBLISHER, title=f'{KEYWORD} AI for medical diagnosis')
    add('Circulation', PUBLISHER, title='Heart prevention')
    add('Circulation', PUBLISHER, 17, title=f'{KEYWORD} Heart 17-day outcomes')
    for journal in ['JAMA', 'Circulation Research', 'Nature Reviews Cardiology', 'Nature']:
        add(journal, 'Fixture publisher')

    rows = []
    for i, (days, journal) in enumerate([(24, 0), (24, 1), (60, 0), (60, 1)]):
        rows.append([str(990001 + i), '', str(TODAY - timedelta(days=days)), journal, journal, 0, 0, [],
                     f'{KEYWORD} Heart archive record {i}'])
    archive = dict(jn=[NPJ, 'Circulation'], pub=['Springer Nature', PUBLISHER], tier=[''], design=[''], tag=[], rows=rows)
    data = dict(FEEDS={'items': recent}, CURATED=[], LIBRARY={'papers': [], 'pdfIds': []},
                CONTENT_STATUS={}, JOURNAL_METRICS={}, SOURCE_HEALTH={})
    files, app_path, style_path = build_assets(
        data, js('RADAR_ARCHIVE', archive) + '\nwindow.XINZHI_RADAR_READY();',
        [(repo / name).read_text() for name in ('journal-metrics.js', 'citation-export.js', 'journal-tiers.js', 'app.js')],
        (repo / 'style.css').read_text(),
    )
    html = (repo / 'index.html').read_text()
    html = re.sub(r'<script src="data/library\.js"></script>.*?<script src="app\.js"></script>',
                  f'<script src="{app_path}"></script>', html, flags=re.S)
    files['index.html'] = html.replace('href="style.css"', f'href="{style_path}"')
    for name, source in files.items():
        path = public / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding='utf-8')
    return next(path for path in files if path.startswith('assets/radar.'))


def attr(name, value):
    return f'[{name}={json.dumps(value, ensure_ascii=False)}]'


def run_viewport(browser, origin, archive_path, width, height, out, baseline):
    mobile = width == 390
    context = browser.new_context(viewport={'width': width, 'height': height}, has_touch=mobile, is_mobile=mobile,
                                  locale='zh-CN', timezone_id='Asia/Shanghai', reduced_motion='reduce', service_workers='block')
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/')
                  and route.request.method == 'GET' else route.abort())
    try:
        page = context.new_page()
        page.clock.set_fixed_time(TODAY.isoformat() + 'T09:00:00+08:00')
        errors, archive_requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        def track_archive(request):
            if request.url == origin + '/' + archive_path:
                archive_requests.append(request.url)

        page.on('request', track_archive)
        pop = page.locator('#qfPop')
        journal_search = pop.locator('#qfJournalSearch')
        close = pop.locator('[data-qf-close]')
        summary_clear = page.locator('[data-qf-clear="all"]')

        def load(query=''):
            page.goto(origin + '/?mode=candidates' + query)
            expect(page.locator('[data-qf-jtier="ai"]')).to_be_visible()

        def shot(label):
            if out:
                page.screenshot(path=out / f'{"before" if baseline else "after"}-{width}-{label}.png', animations='disabled')

        def menu(tier='ai'):
            page.locator(attr('data-qf-jtier-menu', tier)).click()
            expect(journal_search).to_be_visible()

        def journal(name):
            return pop.locator(attr('data-qf-pick-journal', name))

        def journal_count(name):
            return int(journal(name).locator('small:not(.qf-suggested)').inner_text())

        def more():
            page.locator('[data-qf="more"]').click()
            expect(pop.get_by_text('更多筛选', exact=True)).to_be_visible()

        def total():
            return int(re.search(r'共 ([\d,]+) 篇', page.locator('#listTotal').inner_text())[1].replace(',', ''))

        def params():
            return parse_qs(urlsplit(page.url).query)

        # R1: real pointer/touch coordinates in the last pixel of the label and first pixel of the arrow segment.
        load()
        hits = []
        for tier in TIERS:
            main = page.locator(attr('data-qf-jtier', tier))
            main.locator('..').evaluate("el => el.scrollIntoView({block: 'nearest', inline: 'center'})")
            points = main.evaluate('''el => {
                const range = document.createRange();
                range.selectNodeContents(el);
                const text = range.getBoundingClientRect(), arrow = el.nextElementSibling.getBoundingClientRect();
                return [{x: Math.floor(text.right - 1), y: Math.round(text.top + text.height / 2)},
                        {x: Math.ceil(arrow.left + 1), y: Math.round(arrow.top + arrow.height / 2)}];
            }''')
            for point, target in zip(points, ['qfJtier', 'qfJtierMenu']):
                hit = page.evaluate('''({x, y, target}) => document.elementFromPoint(x, y)
                    ?.closest('button')?.dataset[target] || null''', {**point, 'target': target})
                hits.append(hit == tier)
                if not baseline:
                    assert hit == tier, (tier, target, point, hit)
                (page.touchscreen.tap if mobile else page.mouse.click)(**point)
                if not baseline or hit == tier:
                    if target == 'qfJtier':
                        expect(main).to_have_attribute('aria-pressed', 'true')
                        expect(pop).to_be_hidden()
                    else:
                        expect(pop).to_be_visible()
                        expect(main).to_have_attribute('aria-pressed', 'true')
                if target == 'qfJtierMenu' and pop.is_visible():
                    close.click()
            if summary_clear.is_visible():
                summary_clear.click()
        print(f'{width} R1 text/arrow coordinate hits {sum(hits)}/{len(hits)}')

        # R2: a selection can re-render the same panel without losing its scroll position.
        load()
        menu()
        journal(BMC).scroll_into_view_if_needed()
        before = pop.evaluate('el => el.scrollTop')
        assert before > 0, before
        journal(BMC).click()
        expect(journal(BMC)).to_have_attribute('aria-pressed', 'true')
        selected = pop.evaluate('el => el.scrollTop')
        close.click()
        menu()
        reopened = pop.evaluate('el => el.scrollTop')
        if not baseline:
            assert abs(before - selected) <= 1, (before, selected)
            assert reopened == 0, reopened
            expect(journal_search).to_be_in_viewport(ratio=1)
            expect(pop.get_by_text('查看整档', exact=True)).to_be_in_viewport(ratio=1)
        shot('journal-reopen')
        print(f'{width} R2 scroll at selection {before:g} → {selected:g}, reopen {reopened:g}')

        # R3: a 24-day row enters the 30-day view, a 60-day row does not. Both are loaded by the old shard.
        load()
        original_total = total()
        seen_before = len(archive_requests)
        menu()
        initial_npj = journal_count(NPJ)
        close.click()
        more()
        publisher = pop.locator(attr('data-qf-pub', PUBLISHER))
        pub_count = publisher.locator('small')
        initial_pub = int(pub_count.inner_text())
        close.click()
        assert len(archive_requests) == seen_before, 'the archive must load on demand'
        page.locator('#qfScopeBtn').click()
        with page.expect_response(origin + '/' + archive_path) as loaded:
            pop.locator('[data-qf-range="30"]').click()
        assert loaded.value.ok
        page.wait_for_function('window.RADAR_ARCHIVE?.rows.length > 0')
        expect(page.locator('#listTotal')).to_have_text(f'共 {original_total + 3} 篇')
        close.click()
        menu()
        assert journal_count(NPJ) == initial_npj + 1
        close.click()
        more()
        pub_30 = int(pub_count.inner_text())
        close.click()
        page.locator('[data-qf-clear="range"]').click()
        expect(page.locator('#listTotal')).to_have_text(f'共 {original_total} 篇')
        menu()
        assert journal_count(NPJ) == initial_npj == 1, '#206 journal count after archive round-trip'
        close.click()
        more()
        pub_restored = int(pub_count.inner_text())
        shot('archive-publisher')
        publisher.click()
        pub_result = total()
        if not baseline:
            assert (initial_pub, pub_30, pub_restored, pub_result) == (4, 6, 4, 4)
        close.click()
        load(f'&q={KEYWORD}&lane=cardio')
        more()
        pop.locator('[data-qf-reading="abstract"]').click()
        scoped_pub = int(pub_count.inner_text())
        publisher.click()
        scoped_result = total()
        if not baseline:
            assert scoped_pub == scoped_result == 1, (scoped_pub, scoped_result)
            # The selected publisher is omitted when evaluating its alternatives.
            expect(pop.locator(attr('data-qf-pub', 'Springer Nature')).locator('small')).to_have_text('1')
            close.click()
            page.locator('[data-qf-jtier="ai"]').click()
            more()
            expect(pub_count).to_have_text('1')
            publisher.click()
            expect(page.locator('[data-qf-clear="jtier"]')).to_have_count(0)
            expect(page.locator('#listTotal')).to_have_text('共 1 篇')
        print(f'{width} R3 publisher {initial_pub} → 30d {pub_30} → 14d {pub_restored}, selected {pub_result}, '
              f'domain+keyword+abstract {scoped_pub}/{scoped_result}; #206 {NPJ} {initial_npj} → {initial_npj + 1} → {initial_npj}')

        # R4: zero-count journal selection is blocked, independent of following it.
        load()
        menu()
        journal_search.fill('JMIR')
        zero = journal('JMIR')
        expect(zero.locator('..')).to_have_class(re.compile(r'\bis-empty\b'))
        disabled = zero.is_disabled()
        zero_box = zero.bounding_box()
        (page.touchscreen.tap if mobile else page.mouse.click)(x=zero_box['x'] + 16, y=zero_box['y'] + zero_box['height'] / 2)
        pressed = zero.get_attribute('aria-pressed')
        if not baseline:
            assert disabled and pressed == 'false'
            expect(summary_clear).to_be_hidden()
        follow = pop.locator(attr('data-qf-follow', 'JMIR'))
        follow.click()
        expect(follow).to_have_attribute('aria-pressed', 'true')
        follow.click()
        expect(follow).to_have_attribute('aria-pressed', 'false')
        load()
        menu()
        journal(NPJ).click()
        expect(journal(NPJ)).to_have_attribute('aria-pressed', 'true')
        page.locator('#searchToggleBtn').click()
        page.locator('#globalSearch').fill('noradarfixturehit')
        expect(page.locator('#listTotal')).to_have_text('共 0 篇')
        # R6: capture the untouched empty-state proposal context before removing the journal.
        expect(page.locator('#clearAllFiltersBtn')).to_have_text('重置所有条件')
        empty_copy = page.locator('.empty-filter-actions [data-clear="sidebar"]').inner_text()
        menu()
        assert journal_count(NPJ) == 0
        expect(journal(NPJ)).to_be_enabled()
        expect(journal(NPJ)).to_have_attribute('aria-pressed', 'true')
        journal(NPJ).click()
        expect(journal(NPJ)).to_have_attribute('aria-pressed', 'false')
        expect(summary_clear).to_be_hidden()
        print(f'{width} R4 zero disabled={disabled}, after pointer pressed={pressed}; follow and selected-zero removal work')
        print(f'{width} R6 current empty button: {empty_copy}')

        # R5: the recommended name can wrap while the tag and count each stay on one line.
        load()
        menu()
        journal_search.fill(BMC)
        suggested = journal(BMC)
        expect(suggested).to_be_visible()
        lines = suggested.evaluate('''el => {
            const lines = node => { const r = document.createRange(); r.selectNodeContents(node); return r.getClientRects().length; };
            const name = el.querySelector('.qf-jlabel') || el.firstChild;
            return [lines(name), lines(el.querySelector('.qf-suggested')), lines(el.querySelector('small:not(.qf-suggested)'))];
        }''')
        if not baseline:
            assert lines[0] > 1 and lines[1:] == [1, 1], lines
            expect(suggested.locator('.qf-suggested')).to_have_text('建议')
            expect(suggested.locator('small:not(.qf-suggested)')).to_have_text('1')
        shot('suggested-label')
        journal_search.fill(NPJ)
        expect(journal(NPJ).locator('.qf-suggested')).to_have_count(0)
        assert journal_count(NPJ) == 1
        print(f'{width} R5 lines name/label/count: {lines}')

        # R7: the summary action retains the search, while the search's own action clears it.
        load(f'&q={KEYWORD}&range=30')
        page.locator('[data-qf-jtier="ai"]').click()
        expect(page.locator('[data-qf-clear="jtier"]')).to_be_visible()
        expect(page.locator('[data-qf-clear="range"]')).to_be_visible()
        label = summary_clear.inner_text()
        if not baseline:
            assert label == '清除筛选（保留关键词）', label
        shot('clear-filters')
        summary_clear.click()
        expect(summary_clear).to_be_hidden()
        assert params().get('q') == [KEYWORD], params()
        expect(page.locator('#globalSearch')).to_have_value(KEYWORD)
        page.get_by_role('button', name='清除搜索', exact=True).click()
        assert 'q' not in params(), params()
        page.goto(origin + '/?mode=library&lane=all')
        expect(summary_clear).to_have_text('清除')
        print(f'{width} R7 summary label: {label}; keyword retained until 清除搜索')
        assert not errors, errors
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--screenshots', type=Path)
    parser.add_argument('--baseline', action='store_true')
    args = parser.parse_args()
    if args.screenshots:
        if args.screenshots.resolve().is_relative_to(ROOT):
            parser.error('screenshots must be stored outside the repository')
        args.screenshots.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='radar-filter-fixture-') as tmp, sync_playwright() as playwright:
        archive = fixture_public(args.repo, Path(tmp))
        handler = functools.partial(QuietHandler, directory=tmp)
        with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'))
            try:
                for width, height in VIEWPORTS:
                    run_viewport(browser, f'http://127.0.0.1:{server.server_port}', archive,
                                 width, height, args.screenshots, args.baseline)
            finally:
                browser.close()
                server.shutdown()
    print('Radar filter follow-up: both viewports checked')


if __name__ == '__main__':
    main()
