#!/usr/bin/env python3
"""Real public-bundle browsing QA; APIs are mocked and never call a model."""
import functools
import os
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

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

    def params(page):
        return {key: values[0] for key, values in parse_qs(urlsplit(page.url).query).items()}

    def open_picker(page, tier):
        page.locator(f'[data-qf-jtier-menu="{tier}"]').click()
        return page.locator('#qfPop')

    def choice(pop, attribute, name):
        return pop.locator(f'[{attribute}={json.dumps(name, ensure_ascii=False)}]')

    def fits(page, label):
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),
              label + ': no horizontal page overflow')

    journal_a, journal_b, design = 'Circulation', 'The BMJ', 'RCT'
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
            for width in (1440, 390, 320):
                context = browser.new_context(viewport={'width': width, 'height': 950}, has_touch=width < 500)
                context.route('**/*', route)
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                url = base + '?mode=candidates&lane=all&view=cards'
                page.goto(url, wait_until='networkidle')
                pool = page.evaluate("FEEDS.items.filter(p => p.id.startsWith('browser-fixture-'))")
                # Derive the expected sets from the browser build fixture used by both revisions.
                journal = lambda p: p.get('cleanJournal') or p.get('journal')
                expected = sorted(p['id'] for p in pool if journal(p) == journal_a and p.get('studyDesign') == design)
                check(bool(expected), 'Fixture has a positive intersection')
                check(not any(journal(p) == journal_b and p.get('studyDesign') == design for p in pool),
                      'Fixture has a negative intersection')

                pop = open_picker(page, 'cardioClinical')
                before = page.url
                expect(pop.locator('#qfJournalSearch')).to_be_visible()
                check(page.url == before, f'{width}: opening the tier picker does not select a tier')
                choice(pop, 'data-qf-pick-journal', journal_a).click()
                pop.locator('[data-qf-close]').click()

                page.locator('[data-qf="more"]').click()
                design_option = choice(pop, 'data-qf-design', design)
                design_option.click()
                page.locator('[data-qf="more"]').click()
                expect(design_option).to_have_attribute('aria-pressed', 'true')
                pop.locator('[data-qf-close]').click()
                rendered = page.locator('#articlesStream article[data-paper-id]')
                expect(rendered).to_have_count(len(expected))
                check(sorted(rendered.evaluate_all('cards => cards.map(card => card.dataset.paperId)')) == expected,
                      f'{width}: journal and design intersect')
                page.reload(wait_until='networkidle')
                expect(rendered).to_have_count(len(expected))

                pop = open_picker(page, 'generalMedicine')
                choice(pop, 'data-qf-pick-journal', journal_b).click()
                expect(choice(pop, 'data-qf-pick-journal', journal_b)).to_have_attribute('aria-pressed', 'true')
                pop.locator('[data-qf-close]').click()
                check(params(page).get('design') == design, f'{width}: replacing a journal retains the design')
                expect(rendered).to_have_count(0)
                expect(page.locator('#articlesStream .empty-state')).to_be_visible()
                fits(page, f'{width}/empty')
                page.screenshot(path=str(out / f'filters-{width}.png'))

                page.locator('[data-qf="more"]').click()
                reset = choice(pop, 'data-qf-design', '')
                if width < 500:
                    check(reset.bounding_box()['height'] >= 40, f'{width}: touch-sized design option')
                    reset.tap()
                else:
                    reset.press('Enter')
                page.locator('[data-qf="more"]').click()
                expect(reset).to_have_attribute('aria-pressed', 'true')
                check(params(page).get('journal') == journal_b and 'design' not in params(page),
                      f'{width}: clearing the design preserves the selected journal')
                expect(rendered.first).to_be_visible()
                pop.locator('[data-qf-close]').click()
                fits(page, f'{width}/results')
                context.close()
            browser.close()

        check(not errors, 'No browser script errors: ' + '; '.join(errors))
        check(all(call['method'] == 'GET' for call in api_calls), 'QA made no model-generation or acquisition requests')
        report = {'assertions': len(checks), 'checks': checks, 'errors': errors, 'apiCalls': api_calls, 'publicFixture': {'journalA': journal_a, 'journalB': journal_b, 'design': design, 'combined': len(expected)}}
        (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'facetedBrowserAssertions': len(checks), 'errors': errors, 'fixture': report['publicFixture']}, ensure_ascii=False))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
