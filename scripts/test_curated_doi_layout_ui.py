#!/usr/bin/env python3
"""Offline browser regression for curated-mode DOI search layout (no empty 260px right rail)."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://curated-doi-layout.invalid'
DOI = '10.1234/curated-doi-layout-test'
TODAY = '2026-11-12'
YESTERDAY = '2026-11-11'

CURATED_PAPERS = [
    {
        'id': 'curated-1',
        'doi': DOI,
        'title': 'Offline curated paper one for DOI layout check',
        'journal': 'Circulation',
        'cleanJournal': 'Circulation',
        'publisher': 'AHA',
        'clinicalTier': '心血管',
        'tags': ['#房颤', '#AI心电'],
        'studyDesign': 'RCT',
        'date': TODAY,
        'datePrecision': 'day',
        'hasDraft': True,
        'draftData': {'title_zh': '离线测试精选文献一', 'summary': '用于验证每日精选桌面端 DOI 检索布局。', 'published': TODAY},
        'url': f'https://doi.org/{DOI}',
    },
    {
        'id': 'curated-2',
        'doi': '10.1234/curated-doi-layout-other',
        'title': 'Offline curated paper two for day rail check',
        'journal': 'NEJM',
        'cleanJournal': 'NEJM',
        'publisher': 'NEJM Group',
        'clinicalTier': '综合医学与其他',
        'tags': ['#心衰'],
        'studyDesign': 'Cohort',
        'date': YESTERDAY,
        'datePrecision': 'day',
        'hasDraft': True,
        'draftData': {'title_zh': '离线测试精选文献二', 'summary': '用于验证日期栏恢复。', 'published': YESTERDAY},
        'url': 'https://doi.org/10.1234/curated-doi-layout-other',
    },
]

DATA_FIXTURES = {
    '/data/library.js': 'window.LIBRARY=' + json.dumps({'papers': CURATED_PAPERS}),
    '/data/candidates.js': 'window.FEEDS=' + json.dumps({'updatedAt': TODAY, 'items': CURATED_PAPERS}),
    '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[]}',
    '/data/curated.js': 'window.CURATED=' + json.dumps(CURATED_PAPERS),
    '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
}

STATIC_FILES = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/style.css': ('style.css', 'text/css; charset=utf-8'),
    '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
    '/citation-export.js': ('citation-export.js', 'application/javascript; charset=utf-8'),
    '/icon.png': ('icon.png', 'image/png'),
}


def browser_path():
    env = os.environ.get('CHROMIUM_PATH')
    if env:
        return env
    return '/usr/bin/chromium' if os.path.exists('/usr/bin/chromium') else '/usr/bin/google-chrome'


def occupies_right_rail(layout, expected_width=260):
    """True when the date rail is a visible column to the right of the article stream."""
    rail, content = layout.get('railBox'), layout.get('contentBox')
    if layout.get('railHidden') or not rail or not content:
        return False
    if rail['width'] <= 1 or rail['height'] <= 1:
        return False
    return abs(rail['width'] - expected_width) <= 1 and rail['x'] >= content['x'] + content['width'] - 1


def is_single_column(layout):
    """DOI search should drop the 260px right rail and let the card fill the main column."""
    return (
        layout.get('hasFullWidthClass')
        and not layout.get('hasCuratedClass')
        and layout.get('layoutCols') == 'none'
        and not occupies_right_rail(layout)
        and abs(layout['contentBox']['width'] - layout['mainBox']['width']) <= 1
        and abs(layout['cardBox']['width'] - layout['contentBox']['width']) <= 1
        and not layout.get('overflow')
    )


def measure_layout(page):
    return page.evaluate('''() => {
        const app = document.querySelector('.app-container');
        const main = document.querySelector('main.main-content');
        const layout = document.querySelector('.stream-reading-layout');
        const content = document.querySelector('.stream-content');
        const rail = document.querySelector('#streamRail');
        const card = document.querySelector('#articlesStream .article-card');
        return {
            hasCuratedClass: app ? app.classList.contains('curated-layout') : false,
            hasFullWidthClass: app ? app.classList.contains('full-width-layout') : false,
            mainBox: main ? main.getBoundingClientRect() : null,
            layoutCols: layout ? getComputedStyle(layout).gridTemplateColumns : null,
            contentBox: content ? content.getBoundingClientRect() : null,
            railHidden: rail ? rail.hidden : null,
            railBox: rail ? rail.getBoundingClientRect() : null,
            cardBox: card ? card.getBoundingClientRect() : null,
            overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
    }''')


def main():
    errors, posts = [], []

    def handle_route(route):
        req = route.request
        parsed = urlsplit(req.url)
        if f'{parsed.scheme}://{parsed.netloc}' != ORIGIN:
            return route.abort()
        if parsed.path.startswith('/api/'):
            if req.method == 'POST':
                posts.append(req.url)
                return route.abort()
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': False, 'papers': []})
        if parsed.path in DATA_FIXTURES:
            return route.fulfill(body=DATA_FIXTURES[parsed.path], content_type='application/javascript; charset=utf-8')
        if parsed.path in STATIC_FILES:
            rel, ctype = STATIC_FILES[parsed.path]
            return route.fulfill(body=(ROOT / rel).read_bytes(), content_type=ctype)
        return route.abort()

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=browser_path(), args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        context.route('**/*', handle_route)
        page = context.new_page()
        page.set_default_timeout(15000)
        page.on('pageerror', lambda e: errors.append(str(e)))

        # 1. Direct URL load into curated DOI search
        page.goto(f'{ORIGIN}/?mode=curated&q={DOI}', wait_until='load')
        expect(page.locator('#articlesStream .article-card')).to_have_count(1)
        curated_doi = measure_layout(page)

        page.goto(f'{ORIGIN}/?mode=library&q={DOI}', wait_until='load')
        expect(page.locator('#articlesStream .article-card')).to_have_count(1)
        library_doi = measure_layout(page)

        assert is_single_column(curated_doi), curated_doi
        assert is_single_column(library_doi), library_doi
        assert abs(curated_doi['mainBox']['width'] - library_doi['mainBox']['width']) <= 1, (curated_doi, library_doi)

        # 2. Normal curated two-column -> type DOI -> clear DOI restores two-column
        page.goto(f'{ORIGIN}/?mode=curated', wait_until='load')
        expect(page.locator('#streamRail')).to_be_visible()
        before = measure_layout(page)
        assert before['hasCuratedClass'] and not before['railHidden'], before
        assert abs(before['railBox']['width'] - 260) <= 1, before
        assert before['railBox']['x'] >= before['contentBox']['x'] + before['contentBox']['width'], before

        page.locator('#searchToggleBtn').click()
        page.locator('#globalSearch').fill(DOI)
        expect(page.locator('#activeFiltersBar .doi-filter-badge')).to_be_visible()
        typed = measure_layout(page)
        assert is_single_column(typed), typed

        page.locator('#activeFiltersBar [data-clear="search"]').click()
        expect(page.locator('#streamRail')).to_be_visible()
        restored = measure_layout(page)
        assert restored['hasCuratedClass'] and not restored['railHidden'], restored
        assert abs(restored['railBox']['width'] - 260) <= 1, restored
        assert restored['railBox']['x'] >= restored['contentBox']['x'] + restored['contentBox']['width'], restored

        assert errors == [], errors
        assert posts == [], posts
        browser.close()

    print('test_curated_doi_layout_ui passed')


if __name__ == '__main__':
    main()
