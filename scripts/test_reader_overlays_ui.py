#!/usr/bin/env python3
"""Offline browser checks for the reader drawer, the shortlist and the Back button.

Covers: drawer regions survive async updates, the shortlist keeps papers that are not
loaded, Back closes panels and returns to the previous tab, Esc closes one layer at a
time, and the removed Hamburg links stay absent even in maintainer mode. Run after build_public.py.
"""
import functools
import json
import os
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    from playwright.sync_api import sync_playwright
    root = Path(__file__).resolve().parents[1]

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(root / 'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks = []
    translations = []

    def check(value, label):
        assert value, label
        checks.append(label)

    def mock(route):
        url = route.request.url
        if '/api/ai?task=translate' in url and not translations:
            translations.append(route)
            return
        if '/api/' in url:
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': False})
        if not url.startswith(base):
            return route.abort('blockedbyclient')
        if '/assets/data-library.' in url:
            # The checked-in public library contains metadata only.
            asset = route.fetch()
            return route.fulfill(response=asset, body=asset.text() + '''
                window.LIBRARY.papers.forEach(p => {
                    if (!p.summary) p.summary = "Fictional abstract for an offline reader regression.";
                });
            ''')
        return route.continue_()

    executable = os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium'
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=executable, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 390, 'height': 860})
            context.route('**/*', mock)
            page = context.new_page()

            # Hamburg links: removed from the reader drawer footer.
            page.goto(base + '?mode=library&lane=all', wait_until='networkidle')
            page.locator('#articlesStream [data-action="open-drawer"]').first.click()
            page.locator('#readerDrawer.open').wait_for()
            check(page.locator('#drawerInstitutionLoginLink').count() == 0, 'Hamburg login removed from drawer footer')
            check(page.locator('#drawerInstitutionLink').count() == 0, 'Hamburg DOI link removed from drawer footer')

            # Drawer regions: the late translation replaces only its own region.
            page.locator('[data-drawer-region="study"]').wait_for()
            page.wait_for_function(
                "() => !/正在检查|正在获取摘要/.test(document.querySelector('[data-drawer-region=\"study\"]')?.textContent || '')"
            )
            page.evaluate("""() => {
                const study = document.querySelector('[data-drawer-region="study"]');
                study.firstElementChild.dataset.marker = 'kept';
                const details = document.createElement('details');
                details.innerHTML = '<summary>reader note</summary><p>x</p>';
                details.open = true;
                study.appendChild(details);
            }""")
            assert len(translations) == 1, 'Translation lookup is held until after the reader interaction'
            translations[0].fulfill(json={'ok': True, 'found': True, 'tr': {
                'abstract_zh': '延迟返回的中文译文。', 'title_zh': '延迟标题',
            }})
            page.locator('[data-abs-panel="zh"]').get_by_text('延迟返回的中文译文。').wait_for()
            check(page.locator('[data-drawer-region="study"] [data-marker="kept"]').count() == 1, 'unchanged drawer region is not rebuilt')
            check(page.locator('[data-drawer-region="study"] details[open]').count() == 1, 'open details survive an async update')

            # Back closes the drawer and stays on the site.
            page.go_back()
            page.wait_for_timeout(200)
            check(page.locator('#readerDrawer.open').count() == 0, 'Back closes the reader drawer')
            check(page.url.startswith(base), 'Back with the drawer open does not leave the site')
            check('mode=library' in page.url, 'Back with the drawer open keeps the current tab')

            # Closing by button leaves no extra history entry behind.
            page.locator('#articlesStream [data-action="open-drawer"]').first.click()
            page.locator('#readerDrawer.open').wait_for()
            page.locator('#drawerCloseBtn').click()
            page.wait_for_timeout(200)
            check(page.locator('#readerDrawer.open').count() == 0, 'close button closes the drawer')
            check(page.evaluate('(history.state || {}).overlay') is None, 'close button walks back over its history entry')

            # Esc closes the topmost layer only.
            page.locator('#articlesStream [data-action="open-drawer"]').first.click()
            page.locator('#readerDrawer.open').wait_for()
            page.evaluate("document.getElementById('openHuddleBtn').click()")
            page.locator('#huddleModalBackdrop.open').wait_for()
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            check(page.locator('#huddleModalBackdrop.open').count() == 0, 'Esc closes the shortlist first')
            check(page.locator('#readerDrawer.open').count() == 1, 'Esc leaves the reader open under the shortlist')
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            check(page.locator('#readerDrawer.open').count() == 0, 'second Esc closes the reader')

            # Back after a tab switch returns to the previous tab.
            page.locator('.nav-tab-btn[data-mode="candidates"]').click()
            check('mode=candidates' in page.url, 'tab switch updates the URL')
            page.go_back()
            page.wait_for_timeout(200)
            check(page.locator('.nav-tab-btn[data-mode="library"]').get_attribute('class').split().count('active') == 1, 'Back returns to the previous tab')

            # Maintainer mode sets the cookie, while Hamburg links remain absent from the drawer footer.
            page.goto(base + '?mode=library&lane=all&maintainer=1', wait_until='networkidle')
            check('maintainer' not in page.url, 'maintainer switch is removed from the address bar')
            page.locator('#articlesStream [data-action="open-drawer"]').first.click()
            page.locator('#readerDrawer.open').wait_for()
            check(page.locator('#drawerInstitutionLoginLink').count() == 0, 'maintainer does not see removed Hamburg login in drawer footer')
            check(page.locator('#drawerInstitutionLink').count() == 0, 'maintainer does not see removed Hamburg DOI link in drawer footer')
            check(any(c['name'] == 'xz_maintainer' and c['value'] == '1' for c in context.cookies()), 'maintainer mode sets the cookie server pages read')
            page.goto(base + '?mode=library&lane=all&maintainer=0', wait_until='networkidle')
            page.locator('#articlesStream [data-action="open-drawer"]').first.click()
            page.locator('#readerDrawer.open').wait_for()
            check(page.locator('#drawerInstitutionLoginLink').count() == 0, 'Hamburg login stays absent after maintainer=0')
            check(not any(c['name'] == 'xz_maintainer' for c in context.cookies()), 'maintainer=0 clears the cookie')

            # Shortlist: papers that are not loaded keep their saved record; unknown IDs stay removable.
            page.evaluate("""() => {
                localStorage.setItem('xinzhi_huddle_ids', JSON.stringify(['pmid-999999991', 'gone-paper']));
                localStorage.setItem('xinzhi_huddle_snap', JSON.stringify({'pmid-999999991': {title: 'Saved shortlist record', titleZh: '已保存的清单记录', journal: 'Fixture Journal', date: '2025-01-02', doi: '10.1234/saved', pmid: '999999991', url: 'https://doi.org/10.1234/saved', studyDesign: 'RCT'}}));
            }""")
            page.goto(base, wait_until='networkidle')
            check(page.locator('#huddleCounter').inner_text() == '2', 'counter counts every saved ID')
            page.locator('#openHuddleBtn').click()
            page.locator('#huddleModalBackdrop.open').wait_for()
            check(page.get_by_text('已保存的清单记录').is_visible(), 'unloaded paper shows from its saved record')
            check(page.locator('.huddle-item-missing').count() == 1, 'unknown ID is listed instead of silently dropped')
            check(page.locator('#huddleModalBody .huddle-item').count() == 2, 'shortlist rows match the counter')
            page.locator('.huddle-item-missing [data-action="remove-huddle"]').click()
            check(page.locator('#huddleCounter').inner_text() == '1', 'unknown ID can be removed')
            page.go_back()
            page.wait_for_timeout(200)
            check(page.locator('#huddleModalBackdrop.open').count() == 0, 'Back closes the shortlist')

            # Adding a loaded paper stores its record for later visits.
            page.locator('#articlesStream [data-action="toggle-huddle"]').first.click()
            stored = json.loads(page.evaluate("localStorage.getItem('xinzhi_huddle_snap')"))
            check(len(stored) == 2 and all(v.get('title') for v in stored.values()), 'new shortlist entries save a record')
            browser.close()
    finally:
        server.shutdown()
    print(f'Reader overlay UI checks passed: {len(checks)}')


if __name__ == '__main__':
    main()
