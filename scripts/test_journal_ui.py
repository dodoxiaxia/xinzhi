#!/usr/bin/env python3
"""Public-bundle journal/weekly integration QA; all remote requests are blocked or mocked."""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    out = ROOT / '.local/weekly-v14-qa/journal'
    out.mkdir(parents=True, exist_ok=True)
    checks, calls, errors = [], [], []
    controls = {'compare': None}
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'

    def check(value, label):
        assert value, label
        checks.append(label)

    def mock(route):
        if '/api/' in route.request.url:
            calls.append({'path': urlsplit(route.request.url).path, 'method': route.request.method})
            if parse_qs(urlsplit(route.request.url).query).get('task') == ['compare'] and controls['compare']:
                return route.fulfill(json={'ok': True, 'found': True, 'canGenerate': False, 'compare': controls['compare']})
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': False})
        if not route.request.url.startswith(base):
            return route.abort('blockedbyclient')
        return route.continue_()

    def overflow(page, label):
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), label + ': no page overflow')
        check(page.evaluate("[...document.querySelectorAll('.journal-metrics-badge')].filter(e=>e.getClientRects().length).every(e=>e.scrollWidth<=e.clientWidth+1)"), label + ': metric tokens wrap')
        check(page.locator('button details.journal-metrics-details, a details.journal-metrics-details').count() == 0, label + ': no nested interactive details')

    def badge_text(locator):
        return locator.evaluate("e => [...e.children].map(x=>x.textContent).join(' · ')")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            for width in [1440, 390, 320]:
                context = browser.new_context(viewport={'width': width, 'height': 950})
                context.route('**/*', mock)
                context.add_init_script("Object.defineProperty(navigator, 'clipboard', {value:{writeText:async text=>{window.__copied=text;}}});")
                page = context.new_page()
                page.set_default_timeout(5000)
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base + '?mode=weekly&style=a', wait_until='networkidle')
                rows = page.evaluate('window.WEEKLY_BOARD.items')
                expect(page.locator('.weekly-auto-item')).to_have_count(len(rows))
                check(20 <= len(rows) <= 30, f'{width}: actual board contains 20–30 source-selected papers')
                for group in page.locator('.weekly-group').all():
                    check(group.locator('.weekly-auto-item .journal-metrics-badge').count() == group.locator('.weekly-auto-item').count(), f'{width}: all classified picks include metrics')
                check(page.locator('[data-journal-metrics="Nature Medicine"] .journal-metrics-badge').count() == 3, f'{width}: static journal references populated')
                summary = page.locator('.weekly-demo > summary')
                summary.click()
                native = page.locator('.weekly-demo > [data-journal-metrics-details] .journal-metrics-details > summary')
                native.focus()
                native.press('Enter')
                expect(native.locator('..')).to_have_attribute('open', '')
                overflow(page, f'{width}/expanded deep-read metrics')
                summary.click()
                page.screenshot(path=str(out / f'weekly-real-{width}.png'))

                ready_id = page.evaluate("() => window.FEEDS.items.find(p=>p.weeklyPick && window.PREGENERATED[p.pmid?'pmid:'+p.pmid:'doi:'+p.doi.toLowerCase()]?.translation?.abstract_zh)?.id")
                check(bool(ready_id), f'{width}: actual cached translation available')
                before = len(calls)
                page.locator(f'.weekly-card-actions [data-action="open-drawer"][data-paper-id="{ready_id}"]').click()
                cached = page.evaluate("id=>{const p=window.FEEDS.items.find(p=>p.id===id);return window.PREGENERATED[p.pmid?'pmid:'+p.pmid:'doi:'+p.doi.toLowerCase()].translation.abstract_zh}", ready_id)
                expect(page.locator('.abstract-translation')).to_contain_text(cached)
                expected = page.evaluate('id=>window.JournalMetrics.compactText(window.FEEDS.items.find(p=>p.id===id))', ready_id)
                check(badge_text(page.locator('#drawerJournalBadges .journal-metrics-badge')) == expected, f'{width}: reader uses registry value/year/status')
                page.locator('#drawerBody .journal-metrics-details > summary').first.click()
                expect(page.locator('#drawerBody .journal-metrics-details').first).to_contain_text('单篇')
                overflow(page, f'{width}/reader')
                check(len(calls) == before, f'{width}: actual weekly translation needs no API call')
                page.screenshot(path=str(out / f'reader-real-{width}.png'))
                check(page.locator('.copy-cite-btn').evaluate_all("es=>es.every(e=>!e.dataset.cite.includes('期刊指标')&&!e.dataset.cite.includes('JCR 2024'))"), f'{width}: standard citations stay free of metric annotations')
                page.locator('.abstract-reader').scroll_into_view_if_needed()
                page.screenshot(path=str(out / f'abstract-real-{width}.png'))
                page.locator('#drawerHuddleToggleBtn').click()
                page.locator('#drawerCloseBtn').click()
                second = page.locator(f'.weekly-auto-item:not([data-paper-id="{ready_id}"]) [data-action="toggle-huddle"]').first
                second_id = second.get_attribute('data-paper-id')
                second.click()
                controls['compare'] = page.evaluate("ids=>({schemaVersion:1,scope:'public-abstract',papers:ids.map(id=>{const p=window.FEEDS.items.find(p=>p.id===id);return {title:p.title,journal:p.cleanJournal||p.journal,key:p.pmid?'pmid:'+p.pmid:'doi:'+p.doi.toLowerCase(),status:'unavailable',reason:'no_abstract'}}),checklist:[],generatedBy:'metadata-only',caveat:'离线对照界面测试，未运行模型。'})", [ready_id, second_id])
                page.locator('#openHuddleBtn').click()
                expect(page.locator('.huddle-item .journal-metrics-badge')).to_have_count(2)
                page.locator('#copyHuddleSummaryBtn').click()
                check('期刊指标：' + expected in page.evaluate('window.__copied'), f'{width}: huddle copy includes metric note')
                with page.expect_download() as downloaded:
                    page.locator('#exportHuddleMdBtn').click()
                markdown = out / f'huddle-{width}.md'
                downloaded.value.save_as(markdown)
                check('**期刊指标**：' + expected in markdown.read_text(), f'{width}: Markdown has separate metric note')
                page.locator('[data-action="compare-select"]').nth(0).check()
                page.locator('[data-action="compare-select"]').nth(1).check()
                expect(page.locator('.study-table th .journal-metrics-badge')).to_have_count(2)
                expect(page.locator('.study-table')).to_contain_text('摘要来源')
                page.locator('.study-table .journal-metrics-details > summary').first.click()
                check(badge_text(page.locator('.study-table th .journal-metrics-badge').first) == expected, f'{width}: comparison header uses same registry')
                page.locator('[data-action="study-copy"][data-task="compare"]').click()
                check('期刊指标：' + expected in page.evaluate('window.__copied'), f'{width}: comparison copy includes metric note')
                overflow(page, f'{width}/huddle')
                page.locator('#closeHuddleModalBtn').click()

                page.goto(base + '?mode=candidates&style=a&range=all', wait_until='networkidle')
                expect(page.locator('#articlesStream .article-card').first).to_be_visible()
                check(page.locator('#articlesStream .article-card .journal-metrics-badge').count() == page.locator('#articlesStream .article-card').count(), f'{width}: detailed cards include metrics')
                if width <= 1000:
                    page.locator('#filterToggleBtn').click()
                page.locator('.accordion-header').first.click()
                detail = page.locator('.accordion-group.open .journal-metrics-details > summary').first
                detail.focus()
                detail.press('Enter')
                expect(detail.locator('..')).to_have_attribute('open', '')
                overflow(page, f'{width}/sidebar')
                if width <= 1000:
                    page.locator('#sheetClose').click()
                journal = page.locator('#articlesStream .article-card .journal-badge').first.inner_text()
                option_node = page.locator('#journalSelect option').filter(has_text=journal).first
                option = option_node.inner_text()
                journal = option_node.get_attribute('value')
                compact = page.evaluate('j=>window.JournalMetrics.compactText(j)', journal)
                check(compact in option, f'{width}: option uses pure-text metrics')
                page.locator('#journalSelect').select_option(journal)
                expect(page.locator('.filter-badge-active .journal-metrics-badge')).to_be_visible()
                page.locator('#favoriteJournalBtn').click()
                expect(page.locator('#favoriteJournalBtn')).to_have_attribute('aria-pressed', 'true')
                check(page.locator('#journalSelect option:checked').get_attribute('value') == journal, f'{width}: canonical journal filter retained after favorite')
                page.locator('#viewCompactBtn').click()
                expect(page.locator('#articlesStream .compact-row').first).to_be_visible()
                check(page.locator('#articlesStream .compact-row .journal-metrics-badge').count() == page.locator('#articlesStream .compact-row').count(), f'{width}: compact rows include metrics')
                page.locator('#sortSelector').select_option('journal-date')
                expect(page.locator('.day-heading .journal-metrics-badge').first).to_be_visible()
                overflow(page, f'{width}/filters-compact-group')
                page.goto(base + '?mode=library&style=a&view=cards&range=all&reading=guide', wait_until='networkidle')
                share = page.locator('[data-action="share-wechat"]').first
                expected_share = badge_text(share.locator('xpath=ancestor::article').locator('.journal-metrics-badge').first)
                share.click()
                check('期刊指标：' + expected_share in page.evaluate('window.__copied'), f'{width}: article share has separate metric note')
                page.locator('#sourceStatusBtn').click()
                check(page.locator('.source-item .journal-metrics-badge').count() == page.locator('.source-item').count(), f'{width}: every source has explicit metric status')
                page.locator('.source-item .journal-metrics-details > summary').first.click()
                overflow(page, f'{width}/source')
                page.screenshot(path=str(out / f'sources-{width}.png'))
                context.close()
            check(not any(c['method'] == 'POST' for c in calls), 'No model POST during integration QA')
            check(not errors, 'No browser JavaScript errors')
            browser.close()
    finally:
        server.shutdown()
        (out / 'results.json').write_text(json.dumps({'assertions': len(checks), 'checks': checks, 'api_calls': calls, 'page_errors': errors, 'data_notice': 'Unmodified source-selected board and the one actually cached translation; no invented translations or model generation.'}, ensure_ascii=False, indent=2) + '\n')
    print(f'{len(checks)} journal/real-weekly UI integration assertions passed.')


if __name__ == '__main__':
    main()
