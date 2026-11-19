#!/usr/bin/env python3
"""Offline browser checks for the list action column and the removed machine-content labels.

Covers 每日精选, 近7天榜 (cards and rows), 文献雷达 and 文献库 (detail and list view) and the reader drawer.
External requests are blocked and API calls are mocked."""
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

BANNED = ['未经人工核对', '未经医生终审', '未经人工审核', '未经人工医学终审', '以英文原文为准', '机器翻译，', '机器翻译 ·', 'AI 速览 ·', 'AI 全文精读 ·', 'AI 综述前']
BANNED_SELECTORS = [
    '.content-label:not(#deepReaderLabel)',  # positive control: detector_sees
    '.ql-flag',  # positive control: detector_sees
    '.ft-badge-none',  # positive control: detector_sees
    '.translation-note',  # positive control: detector_sees
]


def detector_sees(page, scope, selector):
    target = page.locator(f'{scope} {selector}')
    assert target.count() == 0, f'{scope}: unexpected {selector} before positive control'
    node = page.locator(scope).evaluate_handle('''(parent, name) => {
      const probe = document.createElement('span');
      probe.id = 'hygiene-probe';
      probe.className = name;
      return parent.appendChild(probe);
    }''', selector.removeprefix('.').split(':', 1)[0])
    try:
        assert target.count() == 1, f'{scope}: positive control missed {selector}'
    finally:
        node.evaluate('e => e.remove()')
    assert target.count() == 0, f'{scope}: positive control did not clear {selector}'


def phrases_in(page, scope):
    text = page.locator(scope).first.text_content() or ''
    return {phrase for phrase in BANNED if phrase in text}


def has_legacy_quicklook_title(page):
    return any(t.strip().startswith('AI 速览') for t in page.locator('.drawer-section-title').all_inner_texts())


def main():
    from playwright.sync_api import expect, sync_playwright
    root = Path(__file__).resolve().parents[1]

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(root / 'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks = []

    def check(value, label):
        assert value, label
        checks.append(label)

    def mock(route):
        if not route.request.url.startswith(base):
            return route.abort('blockedbyclient')
        query = parse_qs(urlsplit(route.request.url).query)
        if query.get('task') == ['study'] and query.get('k', [''])[0].startswith('doi:10.9999/browser-fixture-'):
            return route.fulfill(json={'ok': True, 'found': True, 'canGenerate': False, 'study': {
                'schemaVersion': 1, 'scope': 'public-abstract', 'checklist': [],
                'caveat': 'Offline reader study evidence limit.',
                'papers': [{'key': query['k'][0], 'status': 'available'}],
            }})
        if '/api/' in route.request.url:
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': False})
        return route.continue_()

    def no_banned_content(page, scope, label):
        present = phrases_in(page, scope)
        for phrase in BANNED:
            check(phrase not in present, f'{label}: no「{phrase}」')
        for selector in BANNED_SELECTORS:
            check(page.locator(f'{scope} {selector}').count() == 0, f'{label}: no {selector}')

    def no_labels(page, scope, label):
        no_banned_content(page, scope, label)
        check(not page.locator('#aiDigest').is_visible(), f'{label}: AI digest entry hidden')

    def box(locator):
        return locator.bounding_box()

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
        for width, height in ((1280, 900), (390, 844)):
            context = browser.new_context(viewport={'width': width, 'height': height})
            context.route('**/*', mock)
            page = context.new_page()
            tag = f'{width}px'

            # The sources page leaves the real list scope empty for detector probes.
            page.goto(base + '?mode=sources', wait_until='domcontentloaded')
            scope = '#articlesStream'
            for selector in BANNED_SELECTORS:
                detector_sees(page, scope, selector)
            probe = page.locator(scope).evaluate_handle(
                '(parent) => parent.appendChild(document.createElement("span"))')
            try:
                for phrase in BANNED:
                    probe.evaluate('(node, text) => { node.textContent = text; }', phrase)
                    check(phrases_in(page, scope) == {phrase}, f'{tag}: positive control sees「{phrase}」')
            finally:
                probe.evaluate('e => e.remove()')
            check(not phrases_in(page, scope), f'{tag}: phrase probes leave no banned text')

            def open_mode(mode, compact=False):
                view = 'compact' if compact else 'cards'
                page.goto(base + f'?mode={mode}&view={view}', wait_until='networkidle')
                check(page.evaluate('document.documentElement.scrollWidth') <= width + 1,
                      f'{tag} {mode} {view}: no horizontal overflow')

            for mode in ('curated', 'candidates', 'library', 'weekly'):
                for compact in (False, True):
                    open_mode(mode, compact)
                    scope = '#weeklySection' if mode == 'weekly' else '#articlesStream'
                    label = f'{tag} {mode} {"compact" if compact else "detailed"}'
                    no_labels(page, scope, label)
                    row_class = ('.weekly-row' if compact else '.weekly-auto-item') if mode == 'weekly' else ('.compact-row' if compact else '.article-card')
                    cards = page.locator(scope + ' ' + row_class)
                    check(cards.count() > 0, f'{label}: has papers')
                    actions = cards.first.locator('.card-side-actions')
                    check(actions.locator('.card-star').is_visible(), f'{label}: shortlist button is visible')
                    action_box = box(actions)
                    check(action_box['x'] + action_box['width'] <= width + 1, f'{label}: actions stay in viewport')
                    if compact:
                        main = cards.first.locator('.weekly-row-main' if mode == 'weekly' else '.compact-main')
                        main_box = box(main)
                        if width <= 600:
                            check(action_box['y'] >= main_box['y'] + main_box['height'],
                                  f'{label}: narrow compact actions stay below the text')
                        else:
                            check(action_box['x'] >= main_box['x'] + main_box['width'] - 2,
                                  f'{label}: wide compact actions stay to the right of the text')
                    elif mode == 'weekly':
                        body_box = box(cards.first.locator('.weekly-card-body'))
                        check(action_box['y'] >= body_box['y'] + body_box['height'],
                              f'{label}: detailed weekly actions follow the reading column')

                    if mode == 'candidates':
                        sample = cards.filter(has=page.locator('.card-source')).filter(
                            has=page.locator('[data-ft-action="open-form"]')).first
                        sample_actions = sample.locator('.card-side-actions')
                        check(sample_actions.locator('.card-source').is_visible(),
                              f'{label}: official link appears in the action group')
                        check(sample_actions.locator('[data-ft-action="open-form"]').is_visible(),
                              f'{label}: request button appears in the same group')
            no_labels(page, '#dailyDeepRead', f'{tag} weekly deep reading column')

            # --- 阅读器 ---
            page.goto(base + '?mode=candidates&q=10.1001/jamanetworkopen.2026.37545', wait_until='networkidle')
            page.locator('.article-card .title-open').first.click()
            expect(page.locator('.study-box .study-boundary').last).to_contain_text('未阅读全文')
            no_banned_content(page, '#readerDrawer', f'{tag} reader')
            check(not has_legacy_quicklook_title(page), f'{tag} reader: no section titled「AI 速览」')
            title_probe = page.locator('#readerDrawer').evaluate_handle('''parent => {
              const title = document.createElement('div');
              title.className = 'drawer-section-title';
              title.textContent = 'AI 速览';
              return parent.appendChild(title);
            }''')
            try:
                check(has_legacy_quicklook_title(page), f'{tag} reader: positive control sees legacy title')
            finally:
                title_probe.evaluate('e => e.remove()')
            check(not has_legacy_quicklook_title(page), f'{tag} reader: title probe removed')
            page.locator('#drawerCloseBtn').click()
            page.goto(base + '?mode=candidates&lane=all&q=10.9999/browser-fixture-0', wait_until='networkidle')
            page.locator('#articlesStream .title-open').first.click()
            expect(page.locator('.study-box .study-boundary').last).to_have_text('Offline reader study evidence limit.')
            context.close()
        browser.close()
    print(f'list actions column / label removal: {len(checks)} checks passed')


if __name__ == '__main__':
    main()
