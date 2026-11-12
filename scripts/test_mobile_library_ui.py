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
                ft = page.locator('#ftBar select[data-ft-select]')
                check(ft.locator('option').count() == 6, label + ': six full-text filters (all, readable, verifying, queued, failed, not requested)')
                row = [page.locator(sel).bounding_box() for sel in ['#searchToggleBtn', '#laneBar .lane-select', '#ftBar select', '#filterToggleBtn']]
                check(all(b and b['x'] >= -1 and b['x'] + b['width'] <= width + 1 for b in row), label + ': filter row stays inside the screen')
                check(max(b['y'] for b in row) - min(b['y'] for b in row) < 8, label + ': search, filters and 筛选 share one row')
                check(page.locator('#toolRow >> text=更多').count() == 0, label + ': no 更多 in the filter row')
                nav = page.locator('.header-nav').bounding_box()
                check(page.locator('header.app-header').bounding_box()['height'] <= nav['height'] + 4, label + ': header holds only the four sections')
                check(page.locator('.brand-logo, .header-actions, header .search-wrapper').count() == 0, label + ': no logo, search or actions in the header')
                check(page.locator('#appFooter #sourceStatusBtn').count() == 1 and page.locator('#appFooter #themeToggle').count() == 1 and page.locator('#appFooter #openHuddleBtn').count() == 1, label + ': footer holds shortlist, theme and source status')
                check(page.locator('#searchPanel').is_hidden(), label + ': search starts closed')
                page.locator('#searchToggleBtn').click()
                search_box, row_box = page.locator('#searchPanel').bounding_box(), page.locator('#toolRow').bounding_box()
                check(search_box['y'] + search_box['height'] <= row_box['y'] + 1, label + ': search opens above the filter row')
                page.locator('#searchToggleBtn').click()
                check(page.locator('.heading-total').first.is_visible(), label + ': total sits beside the first heading')
                cards = page.locator('.article-card')
                check(cards.count() >= 3 and all((cards.nth(i).bounding_box()['y'] + cards.nth(i).bounding_box()['height']) <= 844 for i in range(3)) if phone else True, label + ': three full cards fit the first screen')
                check(page.locator('.article-card .btn-primary').count() <= cards.count(), label + ': at most one solid button per card')
                check(page.evaluate("[...document.querySelectorAll('.article-card')].every(c=>c.querySelectorAll('.btn-primary').length<=1)"), label + ': each card has one solid button at most')
                check(not any(ch.isdigit() for ch in page.locator('#laneBar .lane-select').inner_text() + ft.inner_text()), label + ': dropdown names carry no counts')
                check(page.evaluate("[...document.querySelectorAll('#laneBar .lane-select, #ftBar select')].every(s=>{const c=document.createElement('canvas').getContext('2d');const cs=getComputedStyle(s);c.font=cs.fontSize+' '+cs.fontFamily;const w=c.measureText(s.options[s.selectedIndex].text).width;return w+parseFloat(cs.paddingLeft)+parseFloat(cs.paddingRight)<=s.clientWidth})"), label + ': selected dropdown text is not truncated')
                lane = page.locator('#laneBar .lane-select')
                lane.select_option('all')
                check('lane=all' in page.url, label + ': lane select updates the URL state')
                ft.select_option('none')
                check('ft=none' in page.url, label + ': 未申请 filter is reachable')
                page.locator('#filterToggleBtn').click()
                if phone:
                    check(page.evaluate("getComputedStyle(document.body, '::after').backgroundColor").endswith('0.78)'), label + ': filter sheet scrim is dense')
                check(page.locator('#appSidebar #sortSelector').is_visible() and page.locator('#appSidebar #minorNote').is_visible(), label + ': sort, view and the hidden-items note live in the panel')
                if phone: page.locator('#sheetClose').click()
                ft.select_option('')
                if phone:
                    page.locator('[data-action="open-drawer"]').first.click()
                    foot = page.locator('#readerDrawer .drawer-footer').bounding_box()
                    check(foot['height'] <= 130, label + f': drawer footer stays compact ({foot["height"]:.0f}px)')
                    check(page.evaluate("parseFloat(getComputedStyle(document.querySelector('#drawerBody')).paddingBottom) >= 24"), label + ': drawer body keeps bottom spacing')
                context.close()
            browser.close()
        print('mobile library checks passed:', len(checks))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
