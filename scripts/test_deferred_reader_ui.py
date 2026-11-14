#!/usr/bin/env python3
"""Offline Playwright checks for deferred part loading, badges, sources mode, and early-open reader."""
import functools
import json
import os
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ASSET_PART_RE = re.compile(r'^/assets/data-([a-z]+)\.[0-9a-f]{12}\.js$')


def premature_ai_calls(calls):
    """Return sanitized descriptions for disallowed /api/ql or /api/ai calls."""
    bad = []
    for call in calls:
        parsed = urlparse(call['url'])
        if not (parsed.path.startswith('/api/ql') or parsed.path.startswith('/api/ai')):
            continue
        query = parse_qs(parsed.query, keep_blank_values=True)
        # Normal page boot checks AI availability with GET /api/ai?task=status.
        if call['method'] == 'GET' and parsed.path == '/api/ai' and query == {'task': ['status']}:
            continue
        task = ','.join(query.get('task', [])) or '-'
        bad.append(f"{call['method']} {parsed.path} task={task}")
    return bad


class ControlledHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, gate=None, **kwargs):
        self.gate = gate
        super().__init__(*args, **kwargs)

    def log_message(self, *args):
        pass

    def do_GET(self):
        clean_path = self.path.split('?', 1)[0]
        match = ASSET_PART_RE.match(clean_path)
        if match and self.gate is not None:
            part = match.group(1)
            if part in self.gate['fail']:
                self.send_error(500, 'Simulated deferred part error')
                return
            if part in self.gate['hold']:
                self.gate['event'].wait(timeout=15)
                if part in self.gate['fail']:
                    self.send_error(500, 'Simulated deferred part error')
                    return
        super().do_GET()


def main():
    out = ROOT / '.local/deferred-reader-qa'
    out.mkdir(parents=True, exist_ok=True)

    index_html = (ROOT / 'public' / 'index.html').read_text(encoding='utf-8')
    assert '加载中</span>' in index_html, 'index.html should render literal 加载中 in header badges'
    for badge_id in ('curatedCountBadge', 'candCountBadge', 'libCountBadge'):
        assert f'id="{badge_id}"' in index_html
        snippet = index_html.split(f'id="{badge_id}"', 1)[1].split('</span>', 1)[0]
        assert '加载中' in snippet and '…' not in snippet, f'{badge_id} static markup must use 加载中, not …'

    gate = {'hold': set(), 'fail': set(), 'event': threading.Event()}
    gate['event'].set()
    handler = functools.partial(ControlledHandler, directory=str(ROOT / 'public'), gate=gate)
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'

    checks = []
    api_calls = []
    post_calls = []
    errors = []

    def check(cond, label):
        assert cond, label
        checks.append(label)

    def route_handler(route):
        url = route.request.url
        if '/api/' in url:
            api_calls.append({'url': url, 'method': route.request.method})
            if route.request.method == 'POST':
                post_calls.append(url)
            if '/api/ql?' in url:
                return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': True})
            if '/api/ai?' in url:
                return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': True, 'pdfSignedLink': True})
            return route.fulfill(json={'ok': False, 'error': 'offline_test'})
        if 'ebi.ac.uk' in url or not url.startswith(base):
            return route.abort('blockedbyclient')
        return route.continue_()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium',
                args=['--no-sandbox'],
            )
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            context.route('**/*', route_handler)
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))

            # 1. Badges show literal '加载中' while deferred parts are pending, with no overflow across 390/884/1440.
            gate['event'].clear()
            gate['hold'] = {'feeds', 'radar', 'library'}
            gate['fail'] = set()
            page.goto(base, wait_until='domcontentloaded')
            page.wait_for_function('() => /^\\d+$/.test((document.querySelector("#curatedCountBadge")?.textContent || "").trim())')
            expect(page.locator('#candCountBadge')).to_have_text('加载中')
            expect(page.locator('#libCountBadge')).to_have_text('加载中')
            for width, height in ((1440, 900), (884, 900), (390, 844)):
                page.set_viewport_size({'width': width, 'height': height})
                check(page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), f'loading badges width {width}: no overflow')

            gate['hold'] = set()
            gate['event'].set()
            page.wait_for_function('() => window.XINZHI_DATA_READY === true')
            expect(page.locator('#candCountBadge')).to_have_text(re.compile(r'^\d+$'))
            expect(page.locator('#libCountBadge')).to_have_text(re.compile(r'^\d+$'))
            for width, height in ((1440, 900), (884, 900), (390, 844)):
                page.set_viewport_size({'width': width, 'height': height})
                check(page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), f'loaded badges width {width}: no overflow')

            # 2. Sources mode renders '加载中' while health is pending and offers retry on failure instead of 0 counts.
            page.set_viewport_size({'width': 1280, 'height': 800})
            gate['event'].clear()
            gate['hold'] = {'health'}
            gate['fail'] = set()
            page.goto(base + '?mode=sources', wait_until='domcontentloaded')
            expect(page.locator('#sourcesHealthGrid .data-loading-note')).to_contain_text('加载中')
            expect(page.locator('#sourcesHealthMeta')).to_contain_text('加载中')
            check(page.locator('#sourcesHealthSummary .source-filter').count() == 0, 'sources loading hides 0-count summary tiles')
            gate['hold'] = set()
            gate['event'].set()
            expect(page.locator('#sourcesHealthGrid .source-item').first).to_be_visible()
            check(page.locator('#sourcesHealthSummary .source-filter').count() > 0, 'sources loaded shows real summary tiles')

            gate['fail'] = {'health'}
            page.goto(base + '?mode=sources', wait_until='domcontentloaded')
            retry_health = page.locator('#sourcesHealthGrid [data-action="retry-part"][data-part="health"]')
            expect(retry_health).to_be_visible()
            check(page.locator('#sourcesHealthSummary .source-filter').count() == 0, 'sources error hides 0-count summary tiles')
            gate['fail'] = set()
            retry_health.click()
            expect(page.locator('#sourcesHealthGrid .source-item').first).to_be_visible()
            check('加载中' not in page.locator('#sourcesHealthMeta').inner_text(), 'sources retry restores report metadata')

            # 3. Baseline capture of loaded candidates reader drawer, then early-open convergence & scroll/input preservation.
            page.set_viewport_size({'width': 1280, 'height': 380})
            page.goto(base + '?mode=candidates', wait_until='networkidle')
            page.wait_for_function('() => window.XINZHI_DATA_READY === true')

            def wait_drawer_settled():
                page.wait_for_load_state('networkidle')
                page.wait_for_function(
                    '() => !/加载中|正在读取|正在检查|正在从 Europe PMC/.test(document.querySelector("#drawerBody")?.innerText || "")'
                )

            non_ql_btn = page.locator('#articlesStream .article-card:not(:has(.gist-ai)) [data-action="open-drawer"]').first
            first_btn = non_ql_btn if non_ql_btn.count() > 0 else page.locator('#articlesStream [data-action="open-drawer"]').first
            expect(first_btn).to_be_visible()
            target_paper_id = first_btn.get_attribute('data-paper-id')
            first_btn.click()
            expect(page.locator('#readerDrawer')).to_have_class(re.compile(r'\bopen\b'))
            wait_drawer_settled()

            def snapshot_drawer():
                return page.evaluate('''() => {
                    const pick = sel => document.querySelector(sel)?.innerText?.trim() || '';
                    return {
                        title: pick('#drawerBody .drawer-title-en'),
                        quicklook: pick('#drawerBody [data-drawer-region="ai"]'),
                        abstract: pick('#drawerBody [data-drawer-region="abstract"]'),
                        study: pick('#drawerBody [data-drawer-region="study"]'),
                    };
                }''')

            baseline = snapshot_drawer()
            check(bool(baseline['title']), 'baseline candidates drawer loaded title')

            # Hold quicklooks & pregenerated, open the same paper early before they arrive.
            api_calls.clear()
            gate['event'].clear()
            gate['hold'] = {'quicklooks', 'pregenerated'}
            gate['fail'] = set()
            page.goto(base + '?mode=candidates', wait_until='domcontentloaded')
            early_btn = page.locator(f'#articlesStream [data-action="open-drawer"][data-paper-id="{target_paper_id}"]')
            expect(early_btn).to_be_visible()
            early_btn.click()
            expect(page.locator('#readerDrawer')).to_have_class(re.compile(r'\bopen\b'))
            expect(page.locator('#drawerBody')).to_contain_text('加载中')
            page.wait_for_timeout(100)
            premature_ai = premature_ai_calls(api_calls)
            check(
                len(premature_ai) == 0,
                'early-open drawer suppresses premature /api/ql and /api/ai calls'
                + (f': {premature_ai}' if premature_ai else ''),
            )

            def open_applicable_passphrase(secret):
                pdf_link = page.locator('#drawerPdfLink')
                pdf_form = page.locator('#drawerPdfForm')
                if pdf_link.is_visible():
                    pdf_link.click()
                    expect(pdf_form).to_be_visible()
                    inp = pdf_form.locator('input[name="passphrase"]')
                    expect(inp).to_be_visible()
                    inp.fill(secret)
                    return inp, 'pdf'
                check(not pdf_form.is_visible(), 'hidden #drawerPdfLink keeps #drawerPdfForm hidden')
                open_form_btn = page.locator('#drawerFulltext [data-ft-action="open-form"]').first
                if open_form_btn.count() > 0 and open_form_btn.is_visible():
                    open_form_btn.click()
                    ft_form = page.locator('#drawerFulltext form[data-ft-form]').first
                    expect(ft_form).to_be_visible()
                    inp = ft_form.locator('input[name="passphrase"]')
                    expect(inp).to_be_visible()
                    inp.fill(secret)
                    return inp, 'fulltext'
                return None, ''

            early_pass_input, early_pass_kind = open_applicable_passphrase('early-secret')
            scrolled = page.evaluate('''() => {
                const body = document.getElementById('drawerBody');
                body.scrollTop = 100;
                return body.scrollTop;
            }''')
            check(scrolled > 0, 'drawer body scrolled before deferred parts finish')

            gate['hold'] = set()
            gate['event'].set()
            page.wait_for_function('() => window.XINZHI_DATA_READY === true')
            wait_drawer_settled()
            after_scroll = page.evaluate('() => document.getElementById("drawerBody")?.scrollTop || 0')
            check(after_scroll == scrolled, f'drawer scroll preserved after deferred merge ({after_scroll} == {scrolled})')
            if early_pass_input is not None:
                check(
                    early_pass_input.is_visible() and early_pass_input.input_value() == 'early-secret',
                    f'drawer {early_pass_kind} passphrase input preserved after deferred merge',
                )
            converged = snapshot_drawer()
            check(converged == baseline, 'early-open drawer converges to exact baseline content')

            # 4. Failed quicklooks/pregenerated -> retry inside drawer preserves scroll + applicable input & succeeds.
            api_calls.clear()
            gate['hold'] = set()
            gate['fail'] = {'quicklooks', 'pregenerated'}
            page.goto(base + '?mode=candidates', wait_until='domcontentloaded')
            page.wait_for_function('() => window.XINZHI_DATA_STATE?.quicklooks === "error" && window.XINZHI_DATA_STATE?.pregenerated === "error"')
            retry_target = page.locator(f'#articlesStream [data-action="open-drawer"][data-paper-id="{target_paper_id}"]')
            expect(retry_target).to_be_visible()
            retry_target.click()
            expect(page.locator('#readerDrawer')).to_have_class(re.compile(r'\bopen\b'))
            drawer_retry = page.locator('#readerDrawer [data-action="retry-part"]').first
            expect(drawer_retry).to_be_visible()
            premature_on_err = premature_ai_calls(api_calls)
            check(
                len(premature_on_err) == 0,
                'failed deferred parts do not trigger /api/ql or /api/ai calls'
                + (f': {premature_on_err}' if premature_on_err else ''),
            )

            retry_pass_input, retry_pass_kind = open_applicable_passphrase('retry-secret')
            err_scrolled = page.evaluate('''() => {
                const body = document.getElementById('drawerBody');
                body.scrollTop = 90;
                return body.scrollTop;
            }''')
            check(err_scrolled > 0, 'drawer body scrolled before clicking retry-part')
            gate['fail'] = set()
            drawer_retry.click()
            page.wait_for_function('() => window.XINZHI_DATA_READY === true')
            wait_drawer_settled()
            after_retry_scroll = page.evaluate('() => document.getElementById("drawerBody")?.scrollTop || 0')
            check(after_retry_scroll == err_scrolled, f'drawer scroll preserved on retry ({after_retry_scroll} == {err_scrolled})')
            if retry_pass_input is not None:
                check(
                    retry_pass_input.is_visible() and retry_pass_input.input_value() == 'retry-secret',
                    f'drawer {retry_pass_kind} passphrase preserved on retry',
                )
            check(snapshot_drawer() == baseline, 'retry-part converges drawer to baseline content')

            # 5. Downloadable library paper with visible #drawerPdfForm preserves passphrase + scroll across deferred merge/retry.
            page.goto(base + '?mode=library', wait_until='networkidle')
            page.wait_for_function('() => window.XINZHI_DATA_READY === true')
            lib_paper_id = page.evaluate('''() => {
                const pdfIds = new Set((window.LIBRARY?.pdfIds || []).map(String));
                const cards = [...document.querySelectorAll('#articlesStream .article-card')];
                const pick = cards.find(c => !c.querySelector('.gist-ai') && pdfIds.has(String(c.querySelector('[data-action="open-drawer"]')?.dataset.paperId || '')))
                    || cards.find(c => pdfIds.has(String(c.querySelector('[data-action="open-drawer"]')?.dataset.paperId || '')));
                return pick?.querySelector('[data-action="open-drawer"]')?.dataset.paperId || '';
            }''')
            check(bool(lib_paper_id), 'library page rendered a downloadable paper dynamically')
            lib_base_btn = page.locator(f'#articlesStream [data-action="open-drawer"][data-paper-id="{lib_paper_id}"]').first
            expect(lib_base_btn).to_be_visible()
            lib_base_btn.click()
            expect(page.locator('#readerDrawer')).to_have_class(re.compile(r'\bopen\b'))
            wait_drawer_settled()
            lib_baseline = snapshot_drawer()
            check(bool(lib_baseline['title']), 'baseline downloadable library drawer loaded title')

            api_calls.clear()
            gate['event'].clear()
            gate['hold'] = {'quicklooks', 'pregenerated'}
            gate['fail'] = set()
            page.goto(base + '?mode=library', wait_until='domcontentloaded')
            page.wait_for_function('() => window.XINZHI_DATA_STATE?.library === "loaded"')
            lib_early_btn = page.locator(f'#articlesStream [data-action="open-drawer"][data-paper-id="{lib_paper_id}"]').first
            expect(lib_early_btn).to_be_visible()
            lib_early_btn.click()
            expect(page.locator('#readerDrawer')).to_have_class(re.compile(r'\bopen\b'))
            page.wait_for_timeout(100)
            lib_premature_ai = premature_ai_calls(api_calls)
            check(
                len(lib_premature_ai) == 0,
                'early-open library drawer suppresses premature /api/ql and /api/ai calls'
                + (f': {lib_premature_ai}' if lib_premature_ai else ''),
            )
            expect(page.locator('#drawerPdfLink')).to_be_visible()
            lib_early_pass, lib_early_kind = open_applicable_passphrase('early-secret')
            check(lib_early_kind == 'pdf' and lib_early_pass is not None, 'downloadable library drawer opened #drawerPdfForm')
            lib_scrolled = page.evaluate('''() => {
                const body = document.getElementById('drawerBody');
                body.scrollTop = 100;
                return body.scrollTop;
            }''')
            check(lib_scrolled > 0, 'library drawer body scrolled before deferred parts finish')

            gate['hold'] = set()
            gate['event'].set()
            page.wait_for_function('() => window.XINZHI_DATA_READY === true')
            wait_drawer_settled()
            lib_after_scroll = page.evaluate('() => document.getElementById("drawerBody")?.scrollTop || 0')
            check(lib_after_scroll == lib_scrolled, f'library drawer scroll preserved after deferred merge ({lib_after_scroll} == {lib_scrolled})')
            check(
                page.locator('#drawerPdfForm').is_visible() and lib_early_pass.input_value() == 'early-secret',
                'library #drawerPdfForm passphrase preserved after deferred merge',
            )
            check(snapshot_drawer() == lib_baseline, 'early-open library drawer converges to exact baseline content')

            api_calls.clear()
            gate['hold'] = set()
            gate['fail'] = {'quicklooks', 'pregenerated'}
            page.goto(base + '?mode=library', wait_until='domcontentloaded')
            page.wait_for_function(
                '() => window.XINZHI_DATA_STATE?.library === "loaded" && window.XINZHI_DATA_STATE?.quicklooks === "error" && window.XINZHI_DATA_STATE?.pregenerated === "error"'
            )
            lib_retry_btn = page.locator(f'#articlesStream [data-action="open-drawer"][data-paper-id="{lib_paper_id}"]').first
            expect(lib_retry_btn).to_be_visible()
            lib_retry_btn.click()
            expect(page.locator('#readerDrawer')).to_have_class(re.compile(r'\bopen\b'))
            lib_err_premature_ai = premature_ai_calls(api_calls)
            check(
                len(lib_err_premature_ai) == 0,
                'failed library drawer suppresses premature /api/ql and /api/ai calls'
                + (f': {lib_err_premature_ai}' if lib_err_premature_ai else ''),
            )
            expect(page.locator('#drawerPdfLink')).to_be_visible()
            lib_retry_pass, lib_retry_kind = open_applicable_passphrase('retry-secret')
            check(lib_retry_kind == 'pdf' and lib_retry_pass is not None, 'failed library drawer opened #drawerPdfForm')
            lib_err_scrolled = page.evaluate('''() => {
                const body = document.getElementById('drawerBody');
                body.scrollTop = 90;
                return body.scrollTop;
            }''')
            check(lib_err_scrolled > 0, 'library drawer body scrolled before retry')
            lib_drawer_retry = page.locator('#readerDrawer [data-action="retry-part"]').first
            gate['fail'] = set()
            if lib_drawer_retry.count() > 0 and lib_drawer_retry.is_visible():
                lib_drawer_retry.click()
                page.wait_for_function('() => window.XINZHI_DATA_READY === true')
                wait_drawer_settled()
                lib_after_retry_scroll = page.evaluate('() => document.getElementById("drawerBody")?.scrollTop || 0')
                check(lib_after_retry_scroll == lib_err_scrolled, f'library drawer scroll preserved on retry ({lib_after_retry_scroll} == {lib_err_scrolled})')
                check(
                    page.locator('#drawerPdfForm').is_visible() and lib_retry_pass.input_value() == 'retry-secret',
                    'library #drawerPdfForm passphrase preserved on retry',
                )
                check(snapshot_drawer() == lib_baseline, 'library retry-part converges drawer to baseline content')

            check(len(post_calls) == 0, f'no paid POST calls emitted: {post_calls}' if post_calls else 'no paid POST calls emitted')
            check(not errors, f'no page JavaScript errors: {errors}')
            browser.close()
    finally:
        gate['fail'] = set()
        gate['hold'] = set()
        gate['event'].set()
        server.shutdown()
        (out / 'results.json').write_text(json.dumps({
            'assertions': len(checks),
            'checks': checks,
            'api_calls': api_calls,
            'page_errors': errors,
        }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'{len(checks)} deferred reader UI assertions passed; offline fixtures only.')


if __name__ == '__main__':
    main()
