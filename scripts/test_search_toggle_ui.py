#!/usr/bin/env python3
"""Offline browser test for search toggle collapse & focus return (item 8)."""
import os
from pathlib import Path
from urllib.parse import urlsplit


def build_routes(root: Path, origin: str, posts: list):
    today = '2026-11-12'
    papers = [
        {
            'id': 'p1',
            'pmid': '10001',
            'doi': '10.1000/afib1',
            'title': 'Atrial fibrillation screening trial',
            'date': today,
            'datePrecision': 'day',
            'journal': 'Circulation',
            'cleanJournal': 'Circulation',
            'publisher': 'AHA',
            'clinicalTier': '心血管',
            'tags': ['房颤'],
            'studyDesign': 'RCT',
            'summary': 'Offline abstract for search toggle test.',
            'url': 'https://pubmed.ncbi.nlm.nih.gov/10001/',
            'autoPick': {'d': today, 'r': 1},
        }
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


def main():
    from playwright.sync_api import sync_playwright

    root = Path(__file__).resolve().parents[1]
    origin = 'https://search-toggle.invalid'
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
                page.goto(origin + '/?mode=library&lane=all', wait_until='networkidle')

                btn = page.locator('#searchToggleBtn')
                panel = page.locator('#searchPanel')
                inp = page.locator('#globalSearch')

                # 1. Starts closed
                check(panel.is_hidden(), f'{width}: search panel starts hidden')
                check(btn.get_attribute('aria-expanded') == 'false', f'{width}: aria-expanded starts false')

                # 2. First click expands panel and focuses #globalSearch
                btn.click()
                check(panel.is_visible(), f'{width}: first click opens search panel')
                check(btn.get_attribute('aria-expanded') == 'true', f'{width}: aria-expanded true when open')
                check(btn.evaluate('el => el.classList.contains("active")'), f'{width}: toggle active when open')
                check(page.evaluate('document.activeElement?.id === "globalSearch"'), f'{width}: first click focuses input')

                # 3. Second click with empty input collapses panel and returns focus to #searchToggleBtn
                btn.click()
                page.wait_for_timeout(80)
                check(panel.is_hidden(), f'{width}: second click on empty input collapses search panel')
                check(btn.get_attribute('aria-expanded') == 'false', f'{width}: aria-expanded false after collapse')
                check(not btn.evaluate('el => el.classList.contains("active")'), f'{width}: toggle inactive after collapse')
                check(page.evaluate('document.activeElement?.id === "searchToggleBtn"'), f'{width}: focus returned to searchToggleBtn')

                # 4. Re-open, enter text, click toggle -> stays open & focuses #globalSearch
                btn.click()
                check(panel.is_visible(), f'{width}: third click reopens search panel')
                inp.fill('afib')
                page.wait_for_timeout(250)
                btn.click()
                check(panel.is_visible(), f'{width}: click with non-empty input keeps panel open')
                check(inp.input_value() == 'afib', f'{width}: input value preserved')
                check(page.evaluate('document.activeElement?.id === "globalSearch"'), f'{width}: input keeps focus when non-empty')

                # 5. Blur input while non-empty, then click toggle -> focuses #globalSearch without collapsing
                page.locator('#viewCompactBtn').focus()
                check(panel.is_visible(), f'{width}: blur with non-empty input keeps panel open')
                btn.click()
                check(panel.is_visible(), f'{width}: click after blur with non-empty input keeps panel open')
                check(page.evaluate('document.activeElement?.id === "globalSearch"'), f'{width}: click after blur focuses input')

                # 6. Clear input back to empty, then click toggle -> collapses and returns focus
                inp.fill('')
                page.wait_for_timeout(250)
                btn.click()
                page.wait_for_timeout(80)
                check(panel.is_hidden(), f'{width}: click after clearing input collapses panel')
                check(page.evaluate('document.activeElement?.id === "searchToggleBtn"'), f'{width}: focus returned after clearing and clicking')

                context.close()
        finally:
            browser.close()

    assert not errors, f'Page errors: {errors}'
    assert not posts, f'Unexpected non-GET requests: {posts}'
    print(f'{len(checks)} offline search-toggle assertions passed')


if __name__ == '__main__':
    main()
