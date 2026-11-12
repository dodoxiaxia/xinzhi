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
                chips = page.locator('#ftBar .lane-chip')
                check(chips.count() == 6, label + ': six full-text filters (all, readable, verifying, queued, failed, not requested)')
                boxes = [chips.nth(i).bounding_box() for i in range(chips.count())]
                check(all(b and b['x'] >= 0 and b['x'] + b['width'] <= width + 1 for b in boxes), label + ': every full-text filter is inside the screen')
                if phone:
                    check(all(b['height'] >= 43.5 for b in boxes), label + ': full-text filters are 44px tall')
                    expect(page.locator('#laneBar .lane-select')).to_be_visible()
                    expect(page.locator('#rangeBar .range-select')).to_be_visible()
                    check(page.locator('#laneBar .lane-chip').first.is_hidden(), label + ': lane chips replaced by the select')
                    check(page.locator('header.app-header').bounding_box()['height'] < 125, label + ': header is at most two rows')
                    check(page.locator('#appFooter #sourceStatusBtn').count() == 1, label + ': source status lives in the footer')
                    # The select drives the same state as the chips.
                    page.locator('#laneBar .lane-select').select_option('all')
                    expect(page.locator('#laneBar .lane-select')).to_have_value('all')
                    check('lane=all' in page.url, label + ': lane select updates the URL state')
                    page.locator('#ftBar .lane-chip').nth(5).click()
                    check('ft=none' in page.url or page.locator('#ftBar .lane-chip.active').inner_text().startswith('未申请'), label + ': 未申请 filter is reachable')
                    page.locator('#filterToggleBtn').click()
                    check(page.evaluate("getComputedStyle(document.body, '::after').backgroundColor").endswith('0.78)'), label + ': filter sheet scrim is dense')
                    page.locator('#sheetClose').click()
                    page.locator('#ftBar .lane-chip').first.click()
                    page.locator('[data-action="open-drawer"]').first.click()
                    foot = page.locator('#readerDrawer .drawer-footer').bounding_box()
                    check(foot['height'] <= 130, label + f': drawer footer stays compact ({foot["height"]:.0f}px)')
                    check(page.evaluate("parseFloat(getComputedStyle(document.querySelector('#drawerBody')).paddingBottom) >= 24"), label + ': drawer body keeps bottom spacing')
                else:
                    expect(page.locator('#laneBar .lane-select')).to_be_hidden()
                    expect(page.locator('#sourceStatusBtn')).to_be_visible()
                context.close()
            browser.close()
        print('mobile library checks passed:', len(checks))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
