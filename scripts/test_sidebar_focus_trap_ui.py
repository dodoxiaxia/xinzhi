#!/usr/bin/env python3
"""Offline browser test for #appSidebar.open Tab focus trap & focus restoration (item 10)."""
import os
from pathlib import Path
from urllib.parse import urlsplit


def build_routes(root: Path, origin: str, posts: list):
    today = '2026-11-12'
    papers = [
        {
            'id': 'p1',
            'pmid': '10001',
            'doi': '10.1000/trap1',
            'title': 'Offline focus trap test paper one',
            'date': today,
            'datePrecision': 'day',
            'journal': 'Circulation',
            'cleanJournal': 'Circulation',
            'publisher': 'AHA',
            'clinicalTier': '心血管',
            'tags': ['房颤', '随访'],
            'studyDesign': 'RCT',
            'summary': 'Offline abstract 1.',
            'url': 'https://pubmed.ncbi.nlm.nih.gov/10001/',
            'autoPick': {'d': today, 'r': 1},
        },
        {
            'id': 'p2',
            'pmid': '10002',
            'doi': '10.1000/trap2',
            'title': 'Offline focus trap test paper two',
            'date': today,
            'datePrecision': 'day',
            'journal': 'Lancet',
            'cleanJournal': 'Lancet',
            'publisher': 'Elsevier',
            'clinicalTier': '综合医学',
            'tags': ['心衰'],
            'studyDesign': '队列研究',
            'summary': 'Offline abstract 2.',
            'url': 'https://pubmed.ncbi.nlm.nih.gov/10002/',
            'autoPick': {'d': today, 'r': 2},
        },
    ]
    scripts = {
        '/data/library.js': 'window.LIBRARY=' + __import__('json').dumps({'papers': papers}),
        '/data/candidates.js': 'window.FEEDS=' + __import__('json').dumps({'updatedAt': today, 'items': papers}),
        '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[]}',
        '/data/curated.js': 'window.CURATED=[]',
        '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
    }
    assets = {
        '/': ('index.html', 'text/html'),
        '/index.html': ('index.html', 'text/html'),
        '/app.js': ('app.js', 'application/javascript'),
        '/citation-export.js': ('citation-export.js', 'application/javascript'),
        '/journal-metrics.js': ('journal-metrics.js', 'application/javascript'),
        '/journal-tiers.js': ('journal-tiers.js', 'application/javascript'),
        '/config/journal-metrics.json': ('config/journal-metrics.json', 'application/json'),
        '/style.css': ('style.css', 'text/css'),
        '/icon.png': ('icon.png', 'image/png'),
    }

    def route(r):
        req = r.request
        u = urlsplit(req.url)
        if f'{u.scheme}://{u.netloc}' != origin:
            return r.abort('blockedbyclient')
        if u.path.startswith('/api/'):
            if req.method != 'GET':
                posts.append({'url': req.url, 'method': req.method})
                return r.abort('blockedbyclient')
            return r.fulfill(json={'ok': True, 'found': False, 'canGenerate': False, 'papers': []})
        if u.path in scripts:
            return r.fulfill(body=scripts[u.path], content_type='application/javascript')
        if u.path in assets:
            rel, ctype = assets[u.path]
            return r.fulfill(body=(root / rel).read_bytes(), content_type=ctype)
        return r.abort('blockedbyclient')

    return route


VISIBLE_FOCUSABLES_JS = """(rootSel) => {
  const root = document.querySelector(rootSel);
  if (!root) return [];
  return [...root.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])')]
    .filter(x => !x.disabled && !x.hidden && !x.closest('[hidden],[inert]') && x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden' && (!x.checkVisibility || x.checkVisibility({ checkVisibilityCSS: true })))
    .map((x, idx) => ({
      idx,
      id: x.id || '',
      tag: x.tagName,
      text: (x.textContent || '').trim().slice(0, 30),
    }));
}"""


def main():
    from playwright.sync_api import sync_playwright

    root = Path(__file__).resolve().parents[1]
    origin = 'https://sidebar-focus.invalid'
    executable = os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium'
    errors, posts, checks = [], [], []

    def check(cond, label):
        assert cond, label
        checks.append(label)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])
        try:
            for width in (1280, 390):
                context = browser.new_context(viewport={'width': width, 'height': 850})
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(f'{width}: {e}'))
                page.route('**/*', build_routes(root, origin, posts))
                # Use candidates mode so #pgFt is hidden and #favoriteJournalBtn is disabled, verifying skipped elements.
                page.goto(origin + '/?mode=candidates&lane=all', wait_until='networkidle')

                toggle = page.locator('#filterToggleBtn')
                sidebar = page.locator('#appSidebar')

                toggle.click()
                page.locator('#appSidebar.open').wait_for()
                check(page.evaluate('document.querySelector("#appSidebar").contains(document.activeElement)'), f'{width}: opening sidebar moves focus inside')

                items = page.evaluate(VISIBLE_FOCUSABLES_JS, '#appSidebar.open')
                check(len(items) >= 4, f'{width}: sidebar has visible focusables ({len(items)})')
                check(items[0]['id'] == 'panelResetBtn', f'{width}: first focusable is panelResetBtn')
                check(items[-1]['id'] == 'panelApplyBtn', f'{width}: last focusable is panelApplyBtn')
                check(all(x['id'] != 'favoriteJournalBtn' for x in items), f'{width}: disabled favoriteJournalBtn excluded')
                check(page.evaluate('!document.querySelector("#pgFt").hidden === false && ![...document.querySelectorAll("#pgFt button")].some(b => getComputedStyle(b).visibility !== "hidden" && b.getClientRects().length)'), f'{width}: hidden #pgFt buttons excluded')

                # 1. At last element, Tab wraps to first
                page.locator('#panelApplyBtn').focus()
                page.keyboard.press('Tab')
                check(page.evaluate('document.activeElement?.id === "panelResetBtn"'), f'{width}: Tab at last wraps to first')

                # 2. At first element, Shift+Tab wraps to last
                page.keyboard.press('Shift+Tab')
                check(page.evaluate('document.activeElement?.id === "panelApplyBtn"'), f'{width}: Shift+Tab at first wraps to last')

                # 3. Full forward cycle never escapes #appSidebar
                page.locator('#panelResetBtn').focus()
                for step in range(len(items) + 1):
                    page.keyboard.press('Tab')
                    check(page.evaluate('document.querySelector("#appSidebar").contains(document.activeElement)'), f'{width}: Tab step {step} stays inside sidebar')
                # After len(items) tabs from first -> wrapped back to second? Wait: len(items)-1 reaches last, len(items) wraps to first, len(items)+1 reaches second (#sheetClose).
                check(page.evaluate('document.activeElement?.id === "sheetClose"'), f'{width}: full cycle wrapped cleanly through first to second')

                # 4. If focus somehow sits outside sidebar while open, Tab pulls it back in
                page.evaluate('document.activeElement?.blur()')
                page.keyboard.press('Tab')
                check(page.evaluate('document.activeElement?.id === "panelResetBtn"'), f'{width}: Tab from outside moves focus to first inside sidebar')

                # 5. Expanding <details class="panel-more"> includes newly visible controls, still wrapping at panelApplyBtn
                page.locator('.panel-more > summary').click()
                expanded_items = page.evaluate(VISIBLE_FOCUSABLES_JS, '#appSidebar.open')
                check(len(expanded_items) > len(items), f'{width}: expanding 更多条件 exposes more focusables')
                page.locator('#panelApplyBtn').focus()
                page.keyboard.press('Tab')
                check(page.evaluate('document.activeElement?.id === "panelResetBtn"'), f'{width}: Tab wraps after expanding 更多条件')

                # 6. Nested modal (#huddleModalBackdrop.open over #appSidebar.open): only topmost is constrained
                page.evaluate("document.getElementById('openHuddleBtn').click()")
                page.locator('#huddleModalBackdrop.open').wait_for()
                huddle_items = page.evaluate(VISIBLE_FOCUSABLES_JS, '#huddleModalBackdrop.open .modal-dialog')
                check(len(huddle_items) >= 1, f'{width}: shortlist modal has focusable(s)')
                page.locator('#closeHuddleModalBtn').focus()
                page.keyboard.press('Shift+Tab')
                check(page.evaluate('document.querySelector("#huddleModalBackdrop .modal-dialog").contains(document.activeElement)'), f'{width}: nested shortlist traps Shift+Tab without dropping into sidebar')
                page.keyboard.press('Escape')
                page.wait_for_timeout(100)
                check(page.locator('#huddleModalBackdrop.open').count() == 0 and page.locator('#appSidebar.open').count() == 1, f'{width}: Esc closes topmost shortlist and keeps sidebar open')

                # 7. Closing sidebar restores focus to #filterToggleBtn (via Esc and via #sheetClose)
                page.locator('#panelResetBtn').focus()
                page.keyboard.press('Escape')
                page.wait_for_timeout(100)
                check(not sidebar.evaluate('el => el.classList.contains("open")'), f'{width}: Esc closes sidebar')
                check(toggle.get_attribute('aria-expanded') == 'false', f'{width}: aria-expanded false on close')
                check(page.evaluate('document.activeElement?.id === "filterToggleBtn"'), f'{width}: Esc restores focus to filterToggleBtn')

                toggle.click()
                page.locator('#appSidebar.open').wait_for()
                page.locator('#sheetClose').click()
                page.wait_for_timeout(100)
                check(not sidebar.evaluate('el => el.classList.contains("open")'), f'{width}: close button closes sidebar')
                check(page.evaluate('document.activeElement?.id === "filterToggleBtn"'), f'{width}: close button restores focus to filterToggleBtn')

                context.close()
        finally:
            browser.close()

    assert not errors, f'Page errors: {errors}'
    assert not posts, f'Unexpected non-GET requests: {posts}'
    print(f'{len(checks)} offline sidebar focus-trap assertions passed')


if __name__ == '__main__':
    main()
