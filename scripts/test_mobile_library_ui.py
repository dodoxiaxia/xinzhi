#!/usr/bin/env python3
"""Phone layout of the library: no sideways scrolling, every filter visible, 44px targets (offline, API mocked)."""
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


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
        if '/api/' in route.request.url:
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': False})
        if not route.request.url.startswith(base):
            return route.abort('blockedbyclient')
        return route.continue_()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
            for width in [360, 390, 1280]:
                phone = width < 721
                context = browser.new_context(viewport={'width': width, 'height': 844})
                context.route('**/*', mock)
                page = context.new_page()
                page.goto(base + '?mode=library', wait_until='networkidle')
                label = f'{width}'
                check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), label + ': no horizontal scroll')
                scope = page.locator('#qfScopeBtn')
                pop = page.locator('#qfPop')
                close = pop.locator('[data-qf-close]')
                expect(page.locator('#appFooter #sourceStatusBtn, #appFooter #themeToggle, #appFooter #openHuddleBtn')).to_have_count(3)
                expect(page.locator('#searchPanel')).to_be_hidden()
                page.locator('#searchToggleBtn').click()
                expect(page.locator('#searchPanel')).to_be_visible()
                page.locator('#searchToggleBtn').click()
                expect(page.locator('#listTotal')).to_be_visible()

                scope.click()
                expect(pop).to_be_visible()
                box = pop.bounding_box()
                check(box['x'] >= -1 and box['x'] + box['width'] <= width + 1, label + ': filter dialog fits')
                if phone:
                    check(box['y'] + box['height'] >= 843, label + ': filters open as a bottom sheet')
                    check(pop.locator('[data-qf-ft]').first.bounding_box()['height'] >= 40,
                          label + ': a full-text option has a touch-sized target')
                expect(pop.locator('[data-qf-ft]')).to_have_count(6)
                expect(pop.locator('[data-qf-minor]')).to_have_count(0)
                pop.locator('[data-qf-lane="all"]').click()
                pop.locator('[data-qf-ft="none"]').click()
                expect(pop.locator('[data-qf-lane="all"]')).to_have_attribute('aria-pressed', 'true')
                expect(pop.locator('[data-qf-ft="none"]')).to_have_attribute('aria-pressed', 'true')
                check('lane=all' in page.url and 'ft=none' in page.url, label + ': picker syncs both conditions')
                page.keyboard.press('Escape')
                expect(pop).to_be_hidden()

                page.locator('[data-qf="more"]').click()
                expect(pop.locator('[data-qf-ft]')).to_have_count(0)
                expect(pop.locator('[data-qf-minor="0"]')).to_have_attribute('aria-pressed', 'true')
                pop.locator('[data-qf-minor="1"]').click()
                expect(pop.locator('[data-qf-minor="1"]')).to_have_attribute('aria-pressed', 'true')
                check('minor=1' in page.url and 'ft=none' in page.url, label + ': more filters retain full-text state')
                close.click()
                expect(pop).to_be_hidden()
                page.locator('[data-qf-clear="all"]').click()
                check(not any(key in page.url for key in ('lane=', 'ft=', 'minor=')), label + ': clear restores default conditions')
                if phone:
                    page.locator('#articlesStream .title-open').first.click()
                    foot = page.locator('#readerDrawer .drawer-footer').bounding_box()
                    check(foot['height'] <= 130, label + f': drawer footer stays compact ({foot["height"]:.0f}px)')
                    check(page.evaluate("parseFloat(getComputedStyle(document.querySelector('#drawerBody')).paddingBottom) >= 24"), label + ': drawer body keeps bottom spacing')
                    check(page.evaluate("(() => { const d = document.querySelector('#drawerBody'); const f = document.querySelector('.drawer-footer').getBoundingClientRect().height; return parseFloat(getComputedStyle(d).paddingBottom) >= f - 1; })()"), label + ': drawer body bottom padding covers the fixed footer height')
                context.close()
            browser.close()
        print('mobile library checks passed:', len(checks))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
