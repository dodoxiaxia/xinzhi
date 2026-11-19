#!/usr/bin/env python3
"""Offline browser test for quick filter focus and the modal shortlist focus trap."""
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
    from playwright.sync_api import expect, sync_playwright

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
                page.goto(origin + '/?mode=candidates&lane=all')
                toggle = page.locator('#qfScopeBtn')
                pop = page.locator('#qfPop')
                close = pop.locator('[data-qf-close]')

                toggle.click()
                expect(pop).to_have_attribute('aria-modal', 'false')
                expect(toggle).to_have_attribute('aria-expanded', 'true')
                expect(close).to_be_focused()
                expect(pop.locator('[data-qf-ft]')).to_have_count(0)
                page.keyboard.press('Tab')
                check(pop.evaluate('el => el.contains(document.activeElement)'),
                      f'{width}: Tab reaches the next filter')

                page.keyboard.press('Escape')
                expect(pop).to_be_hidden()
                expect(toggle).to_have_attribute('aria-expanded', 'false')
                expect(toggle).to_be_focused()

                toggle.click()
                last = pop.locator('[data-qf-range]').last
                last.focus()
                page.keyboard.press('Tab')
                expect(pop).to_be_hidden()
                expect(toggle).not_to_be_focused()

                toggle.click()
                expect(close).to_be_focused()
                close.click()
                expect(pop).to_be_hidden()
                expect(toggle).to_be_focused()

                # The shortlist is still modal, so Shift+Tab wraps within it.
                page.locator('#openHuddleBtn').click()
                modal = page.locator('#huddleModalBackdrop.open .modal-dialog')
                page.locator('#closeHuddleModalBtn').focus()
                page.keyboard.press('Shift+Tab')
                check(modal.evaluate('el => el.contains(document.activeElement)'),
                      f'{width}: the shortlist keeps keyboard focus')
                page.keyboard.press('Escape')
                expect(modal).to_have_count(0)
                expect(page.locator('#openHuddleBtn')).to_be_focused()

                context.close()
        finally:
            browser.close()

    assert not errors, f'Page errors: {errors}'
    assert not posts, f'Unexpected non-GET requests: {posts}'
    print('Offline quick filter and shortlist keyboard checks passed at 390px and 1280px')


if __name__ == '__main__':
    main()
