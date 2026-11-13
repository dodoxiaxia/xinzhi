#!/usr/bin/env python3
"""Real public-bundle browsing QA; APIs are mocked and never call a model."""
import functools
import os
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    from playwright.sync_api import expect, sync_playwright

    out = ROOT / '.local/faceted-filters-qa'
    out.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks, errors, api_calls = [], [], []

    def check(value, label):
        assert value, label
        checks.append(label)

    def route(request):
        if '/api/' in request.request.url:
            api_calls.append({'method': request.request.method, 'path': urlsplit(request.request.url).path})
            return request.fulfill(json={'ok': True, 'items': [], 'found': False, 'canGenerate': False})
        if not request.request.url.startswith(base):
            return request.abort('blockedbyclient')
        return request.continue_()

    def count(page):
        return int(page.locator('.heading-total').first.inner_text().split()[1])

    def locator(page, attribute, value, scope=''):
        return page.locator(scope + '[' + attribute + '=' + json.dumps(value, ensure_ascii=False) + ']')

    def params(page):
        return {key: values[0] for key, values in parse_qs(urlsplit(page.url).query).items()}

    def navigate(page, **conditions):
        query = {'mode': 'library', 'lane': 'all', 'range': 'all', 'style': 'a', **conditions}
        page.goto(base + '?' + urlencode(query), wait_until='networkidle')

    def pick_journal(page, journal):
        # The publisher/journal tree under 更多条件 is the only journal control.
        open_panel(page)
        expand = locator(page, 'data-pub-expand', publisher[journal])
        if expand.get_attribute('aria-expanded') != 'true':
            expand.click()
        locator(page, 'data-filter-journal', journal).click()

    def open_panel(page):
        if not page.locator('#appSidebar.open').count():
            page.locator('#filterToggleBtn').click()
        expect(page.locator('#appSidebar')).to_be_visible()
        page.evaluate("document.querySelector('.panel-more').open = true")

    def close_panel(page):
        if page.locator('#appSidebar.open').count():
            page.keyboard.press('Escape')
        expect(page.locator('#appSidebar')).not_to_be_visible()

    def fits(page, label):
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), label + ': no horizontal page overflow')
        check(page.locator('#activeFiltersBar').evaluate('e => e.scrollWidth <= e.clientWidth + 1'), label + ': condition bar fits')

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])

            def new_context(width):
                context = browser.new_context(viewport={'width': width, 'height': 950}, is_mobile=width < 500, has_touch=width < 500)
                context.route('**/*', route)
                context.add_init_script("""(() => {
                  const NativeDate = Date, fixed = NativeDate.parse('2026-10-09T03:10:00Z');
                  window.Date = class extends NativeDate {
                    constructor(...args) { super(...(args.length ? args : [fixed])); }
                    static now() { return fixed; }
                  };
                })();""")
                page = context.new_page()
                page.set_default_timeout(10000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                return context, page

            context, page = new_context(1440)
            navigate(page)
            pool = page.evaluate('window.LIBRARY.papers.filter(p => !p.minor)')
            journal_name = lambda paper: paper.get('cleanJournal') or paper.get('journal') or ''
            journals = sorted({journal_name(paper) for paper in pool if journal_name(paper)})
            publisher = {journal_name(paper): paper.get('publisher') or '其他学术刊物' for paper in pool}
            choice = None
            for design in ['RCT', '队列研究', 'Meta/综述', '方法/模型验证', '研究类型待核验']:
                positive = [journal for journal in journals if any(journal_name(paper) == journal and paper.get('studyDesign') == design for paper in pool)]
                negative = [journal for journal in journals if not any(journal_name(paper) == journal and paper.get('studyDesign') == design for paper in pool)]
                choice = next(((a, b, design) for a in positive for b in negative if publisher[a] != publisher[b]), None)
                if choice:
                    break
            assert choice, 'Public data needs two publisher families with an incompatible design combination'
            journal_a, journal_b, design = choice
            source_count = lambda journal: sum(journal_name(paper) == journal for paper in pool)
            design_count = sum(paper.get('studyDesign') == design for paper in pool)
            combined_count = sum(journal_name(paper) == journal_a and paper.get('studyDesign') == design for paper in pool)
            check(count(page) == len(pool), 'Initial count matches actual public library')
            expect(page.locator('#appSidebar')).not_to_be_visible()
            check(''.join(page.locator('#filterToggleBtn').inner_text().split()) == '筛选·1', 'Only the explicit all-fields lane counts as a non-default condition')
            open_panel(page)

            before = page.url
            locator(page, 'data-pub-expand', publisher[journal_a]).click()
            check(page.url == before and count(page) == len(pool), 'Expanding a publisher changes neither URL nor results')
            expect(locator(page, 'data-pub-expand', publisher[journal_a])).to_have_attribute('aria-expanded', 'true')
            locator(page, 'data-filter-publisher', publisher[journal_a]).click()
            check(count(page) == sum(publisher.get(journal_name(paper)) == publisher[journal_a] for paper in pool), 'Publisher name selects its family')
            locator(page, 'data-filter-journal', journal_a).click()
            check(count(page) == source_count(journal_a), 'Journal selection narrows the publisher family')
            locator(page, 'data-filter-journal', journal_a).click()
            check(count(page) == len(pool) and not params(page).get('journal') and not params(page).get('pub'), 'Clicking the selected journal toggles it off')
            locator(page, 'data-filter-journal', journal_a).click()
            check(count(page) == source_count(journal_a), 'Re-clicking the journal selects it again')
            locator(page, 'data-filter-design', design).click()
            check(count(page) == combined_count, 'Journal and design use intersection on real papers')
            fits(page, 'desktop combination')
            page.screenshot(path=str(out / 'desktop-combination.png'))

            check(''.join(page.locator('#filterToggleBtn').inner_text().split()) == '筛选·3', 'The filter button counts the active conditions')
            pick_journal(page, journal_b)
            check(params(page).get('pub') == publisher[journal_b] and params(page).get('design') == design, 'Another journal replaces the source family and retains design')
            check(count(page) == 0, 'Incompatible combination stays empty until an explicit action')
            expect(locator(page, 'data-filter-journal', journal_b)).to_have_attribute('aria-pressed', 'true')
            check(locator(page, 'data-filter-journal', journal_a).count() == 1, 'Other journals remain available when a combination is empty')
            check('is-empty' in (locator(page, 'data-filter-journal', journal_b).get_attribute('class') or '') and not page.locator('#appSidebar .filter-count').count(), 'Zero-result journal stays selectable, is dimmed, and no chip shows a number')
            page.screenshot(path=str(out / 'desktop-empty.png'))
            close_panel(page)
            locator(page, 'data-browse-only', 'design', '#articlesStream ').click()
            check(count(page) == design_count and not params(page).get('journal') and not params(page).get('pub'), 'Empty-state action replaces the source with the selected design')

            pick_journal(page, journal_a)
            close_panel(page)
            locator(page, 'data-clear', 'journal', '#activeFiltersBar ').click()
            check(count(page) == design_count and not params(page).get('pub'), 'Removing a journal chip also removes its hidden parent')
            pick_journal(page, journal_a)
            locator(page, 'data-filter-design', '', '#designFilterList ').click()
            check(count(page) == source_count(journal_a) and params(page).get('journal') == journal_a, 'Group reset preserves the other dimensions')

            navigate(page, journal=journal_a, pub=publisher[journal_b], design=design)
            check(params(page).get('pub') == publisher[journal_a] and count(page) == combined_count, 'Legacy conflicting URL is normalized to the journal parent')
            page.reload(wait_until='networkidle')
            check(count(page) == combined_count, 'Refreshing a shared URL restores the same combination')
            open_panel(page)
            expect(locator(page, 'data-filter-journal', journal_a)).to_have_attribute('aria-pressed', 'true')
            chip = locator(page, 'data-filter-design', '', '#designFilterList ')
            chip.focus()
            chip.press('Enter')
            check(count(page) == source_count(journal_a), 'Keyboard activation of the all-designs chip keeps the journal')
            check(page.evaluate('document.activeElement.hasAttribute("data-filter-design")'), 'Keyboard focus survives the filter redraw')

            navigate(page, journal=journal_a, design=design, q='__faceted_missing_keyword__', range='30', reading='abstract', favorites='1')
            before = params(page)
            open_panel(page)
            locator(page, 'data-filter-design', '', '#designFilterList ').click()
            check(all(params(page).get(key) == before.get(key) for key in ['q', 'range', 'lane', 'reading', 'favorites']), 'Changing a facet chip preserves all base conditions in the real URL')
            locator(page, 'data-filter-design', design, '#designFilterList ').click()
            check(params(page).get('design') == design, 'Re-selecting the design keeps it as the sidebar condition')
            close_panel(page)
            locator(page, 'data-clear', 'design', '#activeFiltersBar ').click()
            locator(page, 'data-clear', 'journal', '#activeFiltersBar ').click()
            after = params(page)
            check(all(after.get(key) == before.get(key) for key in ['q', 'range', 'lane', 'reading', 'favorites']), 'Clear sidebar preserves all base conditions')
            check(not any(after.get(key) for key in ['pub', 'journal', 'design', 'tier', 'tag']), 'Clear sidebar removes exactly the left-side conditions')
            check(page.locator('#globalSearch').input_value() == before['q'], 'Search input still displays the retained keyword')
            page.locator('#clearAllFiltersBtn').click()
            check(not any(params(page).get(key) for key in ['q', 'reading', 'favorites', 'design', 'journal']), 'Explicit global reset restores the default controls')
            context.close()

            for width, style in [(390, 'a'), (320, 'a'), (1440, 'b'), (320, 'b'), (1440, 'c'), (320, 'c')]:
                context, page = new_context(width)
                navigate(page, journal=journal_a, design=design, style=style)
                check(count(page) == combined_count, f'{width}/{style}: shared combination matches')
                fits(page, f'{width}/{style}')
                if width < 500:
                    open_panel(page)
                    only = locator(page, 'data-filter-design', '', '#designFilterList ')
                    only.scroll_into_view_if_needed()
                    check(only.bounding_box()['height'] >= 40, f'{width}/{style}: design chip is a touch-sized target')
                    check(page.locator('#appSidebar').evaluate('e => e.scrollWidth <= e.clientWidth + 1'), f'{width}/{style}: filter sheet fits')
                    if width == 390:
                        page.screenshot(path=str(out / 'mobile-filter-sheet.png'))
                    only.tap()
                    check(count(page) == source_count(journal_a) and params(page).get('journal') == journal_a and not params(page).get('design'), f'{width}/{style}: touching the all-designs chip clears only the design')
                    page.locator('#sheetClose').click()
                    expect(page.locator('#appSidebar')).not_to_be_visible()
                fits(page, f'{width}/{style}/after browse')
                page.screenshot(path=str(out / f'filters-{width}-{style}.png'))
                context.close()
            browser.close()

        check(not errors, 'No browser script errors: ' + '; '.join(errors))
        check(all(call['method'] == 'GET' for call in api_calls), 'QA made no model-generation or acquisition requests')
        report = {'assertions': len(checks), 'checks': checks, 'errors': errors, 'apiCalls': api_calls, 'publicFixture': {'journalA': journal_a, 'journalB': journal_b, 'design': design, 'combined': combined_count, 'designTotal': design_count}}
        (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'facetedBrowserAssertions': len(checks), 'errors': errors, 'fixture': report['publicFixture']}, ensure_ascii=False))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
