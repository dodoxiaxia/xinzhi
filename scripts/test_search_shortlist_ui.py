#!/usr/bin/env python3
"""Real Chromium regression using the built public data, with all APIs mocked GET-only.

Run scripts/build_public.py first. Evidence stays in ignored .local; no model calls.
"""
import argparse
import functools
import os
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[1]
BUTTONS = ['clearHuddleBtn', 'copyHuddleSummaryBtn', 'exportHuddleMdBtn']


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    # Keep unittest discovery independent of optional browser dependencies.
    from playwright.sync_api import expect, sync_playwright
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default=str(ROOT / '.local/search-shortlist-qa'))
    args = parser.parse_args()
    expect.set_options(timeout=15000)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks, errors, requests, records = [], [], [], []

    def check(value, label):
        assert value, label
        checks.append(label)

    def count(page):
        return int(page.locator('#activeFiltersBar .results-meta b').inner_text())

    def no_overflow(page, label):
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), label + ': page fits viewport')
        check(page.locator('#huddleModalBackdrop .modal-dialog').evaluate('(e)=>e.scrollWidth <= e.clientWidth + 1'), label + ': dialog fits viewport')

    def empty_actions(page, label):
        expect(page.locator('#huddleEmptyHelp')).to_be_visible()
        expect(page.locator('#huddleEmptyHelp')).to_have_attribute('role', 'status')
        check('添加文献后' in page.locator('#huddleEmptyHelp').inner_text(), label + ': visible reason')
        for button_id in BUTTONS:
            button = page.locator('#' + button_id)
            expect(button).to_be_disabled()
            expect(button).to_have_attribute('aria-describedby', 'huddleEmptyHelp')
            check(button.evaluate('(e)=>{e.focus(); return document.activeElement !== e}'), label + ': disabled button cannot take focus ' + button_id)
        # Keyboard traversal must not land on any disabled action.
        page.locator('#closeHuddleModalBtn').focus()
        for _ in range(4):
            page.keyboard.press('Tab')
            check(page.evaluate('(ids)=>!ids.includes(document.activeElement.id)', BUTTONS), label + ': Tab skips actions')
            check(page.evaluate('document.activeElement.id === "closeHuddleModalBtn"'), label + ': focus stays in empty dialog')
        page.keyboard.press('Shift+Tab')
        check(page.evaluate('document.activeElement.id === "closeHuddleModalBtn"'), label + ': reverse Tab stays in empty dialog')

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium')
            for width in [1440, 390, 320]:
                context = browser.new_context(viewport={'width': width, 'height': 900}, is_mobile=width < 500, has_touch=width < 500)
                context.add_init_script('Object.defineProperty(navigator, "clipboard", {value: {writeText: async text => {window.__copiedSummary = text}}})')
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))

                def route(r):
                    req = r.request
                    if req.url.startswith('https://www.ebi.ac.uk/europepmc/webservices/rest/search?'):
                        check(req.method == 'GET', 'Public abstract lookup is intercepted without a network call')
                        requests.append({'path': 'mocked-europe-pmc-search', 'method': req.method})
                        return r.fulfill(json={'resultList': {'result': []}})
                    check(req.url.startswith(base), 'Only local public assets and APIs are requested')
                    if urlsplit(req.url).path.startswith('/api/'):
                        requests.append({'path': urlsplit(req.url).path, 'method': req.method})
                        check(req.method == 'GET', 'No model or mutation request')
                        return r.fulfill(json={'ok': True, 'found': False, 'papers': [], 'canGenerate': False})
                    r.continue_()

                page.route('**/*', route)
                for mode in ['curated', 'candidates', 'library']:
                    label = f'{mode}/{width}'
                    page.goto(base + f'?mode={mode}&lane=all', wait_until='load')
                    baseline = count(page)
                    check(baseline > 0, label + ': public data loaded')
                    first_before = page.locator('.article-title').first.inner_text()
                    search = page.locator('#globalSearch')
                    search.fill('AI-ECG')
                    expect(page.locator('[data-clear="search"]')).to_be_visible()
                    matched = count(page)
                    check(0 < matched < baseline, label + ': AI-ECG reduces results')
                    scope = {'curated': '每日精选', 'candidates': '文献雷达', 'library': '文献库'}[mode]
                    expect(page.locator('.search-scope')).to_contain_text('检索范围：' + scope)
                    expect(page.locator('.search-scope')).to_contain_text('切换栏目保留关键词')
                    check(page.locator('.article-title').first.inner_text() != first_before, label + ': rendered list changes')
                    check(parse_qs(urlsplit(page.url).query)['q'] == ['AI-ECG'], label + ': query reflected in URL')
                    no_overflow(page, label + '/search')
                    page.screenshot(path=str(out / f'search-{mode}-{width}.png'))
                    records.append({'width': width, 'mode': mode, 'baseline': baseline, 'AI-ECG': matched})
                    page.locator('[data-clear="search"]').click()
                    expect(search).to_have_value('')
                    check(count(page) == baseline, label + ': removing query restores results')
                    search.fill('zzzz-no-match')
                    expect(page.locator('#clearAllFiltersBtn')).to_be_visible()
                    check(count(page) == 0, label + ': no match empty state')
                    page.locator('#clearAllFiltersBtn').click()
                    expect(search).to_have_value('')
                    check('q' not in parse_qs(urlsplit(page.url).query), label + ': reset removes query from URL')
                    check(count(page) > 0, label + ': reset restores results')
                    if mode != 'curated':
                        tier = page.locator('[data-filter-tier]:not([data-filter-tier=""])').first
                        if not tier.is_visible():  # 更多筛选 starts collapsed on every width
                            page.locator('#filterToggleBtn').click()
                        tier_name = tier.get_attribute('data-filter-tier')
                        tier.click()
                        if width < 500:
                            page.locator('#sheetClose').click()
                        check(parse_qs(urlsplit(page.url).query)['tier'] == [tier_name], label + ': filter is applied')
                        filtered_count = count(page)
                        page.reload(wait_until='load')
                        check(count(page) == filtered_count, label + ': URL filter survives reload')
                        page.locator('[data-clear="tier"]').click()
                        check('tier' not in parse_qs(urlsplit(page.url).query), label + ': filter chip clears URL')
                    search.fill('AI-ECG')
                    expect(page.locator('[data-clear="search"]')).to_be_visible()
                    saved_url, saved_count = page.url, count(page)
                    page.goto(base + '?mode=sources', wait_until='load')
                    page.go_back(wait_until='load')
                    # Chromium may restore the page from the back/forward cache, which go_back() does not wait for.
                    page.wait_for_url(saved_url)
                    check(page.url == saved_url and count(page) == saved_count, label + ': browser Back restores query')
                    expect(page.locator('#globalSearch')).to_have_value('AI-ECG')
                    # In-page tab switches add one history entry each; Back returns to the previous tab with its query.
                    sources_tab = page.locator('[data-mode="sources"]')
                    if sources_tab.is_visible():
                        sources_tab.click()
                    else:
                        sources_tab.evaluate('(e)=>e.click()')
                    expect(page.locator('#sourcesSection')).to_be_visible()
                    check(parse_qs(urlsplit(page.url).query).get('mode') == ['sources'], label + ': tab switch reflected in URL')
                    page.go_back()
                    page.wait_for_url(saved_url)
                    expect(page.locator('#activeFiltersBar .results-meta b')).to_have_text(str(saved_count))
                    check(page.url == saved_url, label + ': browser Back after tab switch restores previous tab and query')
                    expect(page.locator('#globalSearch')).to_have_value('AI-ECG')
                    next_mode = {'curated': 'candidates', 'candidates': 'library', 'library': 'curated'}[mode]
                    page.locator(f'[data-mode="{next_mode}"]').click()
                    expect(page.locator('#globalSearch')).to_have_value('AI-ECG')
                    check(parse_qs(urlsplit(page.url).query)['q'] == ['AI-ECG'], label + ': mode switch preserves query')
                    # The (hidden) sources section keeps its own scope line once visited.
                    expect(page.locator('#streamSection .search-scope')).to_contain_text({'curated': '每日精选', 'candidates': '文献雷达', 'library': '文献库'}[next_mode])

                composite = {'mode': 'library', 'lane': 'all', 'journal': 'No matching journal', 'design': 'RCT', 'range': '30'}
                page.goto(base + '?' + urlencode(composite), wait_until='load')
                check(count(page) == 0, f'{width}: composite filters stay at zero without widening')
                for kind in ['journal', 'design', 'range']:
                    expect(page.locator(f'[data-clear="{kind}"]')).to_be_visible()
                expect(page.locator('#clearAllFiltersBtn')).to_be_visible()
                page.locator('#clearAllFiltersBtn').click()
                check(count(page) > 0, f'{width}: one click resets composite zero-result filters')
                params = parse_qs(urlsplit(page.url).query)
                check(all(k not in params for k in ['journal', 'design', 'range']), f'{width}: composite filter URL cleared')
                page.goto(base + '?mode=library&lane=all&view=compact', wait_until='load')
                expect(page.locator('#articlesStream')).to_have_class('articles-compact-list')
                check(page.locator('.compact-row').count() > 0, f'{width}: existing compact view works')

                # A saved compact preference must be made explicit in a shared search URL.
                page.evaluate('localStorage.setItem("xinzhi_view_mode", "compact")')
                page.goto(base + '?q=房颤&design=RCT', wait_until='load')
                expect(page.locator('.search-scope')).to_contain_text('检索范围：每日精选')
                shared_url, shared_count = page.url, count(page)
                params = parse_qs(urlsplit(shared_url).query)
                check(params['view'] == ['compact'] and params['q'] == ['房颤'] and params['design'] == ['RCT'], f'{width}: share URL keeps saved view, query and filters')
                fresh_context = browser.new_context(viewport={'width': width, 'height': 900})
                fresh = fresh_context.new_page()
                fresh.on('pageerror', lambda error: errors.append(str(error)))
                fresh.route('**/*', route)
                fresh.goto(shared_url, wait_until='load')
                check(count(fresh) == shared_count, f'{width}: shared query reproduces count without prior storage')
                expect(fresh.locator('#articlesStream')).to_have_class('articles-compact-list')
                expect(fresh.locator('.search-scope')).to_contain_text('检索范围：每日精选')
                fresh_context.close()

                page.goto(base + '?mode=candidates&lane=all&view=cards', wait_until='load')
                author_paper = page.evaluate('''() => {
                    const visible = window.FEEDS.items.filter(p=>!p.minor && p.authors?.length && p.doi && p.datePrecision==='day');
                    visible.sort((a,b)=>b.date.localeCompare(a.date));
                    const p = visible[0];
                    return {id:p.id, author:p.authors[0], doi:p.doi};
                }''')
                page.locator('#globalSearch').fill(author_paper['author'])
                expect(page.locator('[data-clear="search"]')).to_be_visible()
                check(count(page) > 0, f'{width}: public author search returns results')
                check(page.locator('#articlesStream [data-paper-id="' + author_paper['id'] + '"]').count() > 0, f'{width}: author search renders the matching public paper')
                expect(page.locator('.search-scope')).to_contain_text('检索范围：文献雷达')
                doi = author_paper['doi']
                page.goto(base + '?' + urlencode({'mode': 'curated', 'q': doi, 'journal': 'No matching journal', 'view': 'compact'}), wait_until='load')
                expect(page.locator('.doi-search-notice')).to_contain_text('按 DOI 全站检索')
                check(count(page) > 0, f'{width}: exact DOI keeps its existing explicit global scope')
                check(parse_qs(urlsplit(page.url).query)['q'] == [doi], f'{width}: DOI query survives URL synchronization')

                # Shortcuts remain available on the page, but never steal editable/modal focus.
                page.goto(base + '?mode=library&lane=all&view=cards&q=AI-ECG', wait_until='load')
                page.locator('#globalSearch').evaluate('(e)=>e.blur()')
                page.keyboard.press('/')
                check(page.evaluate('document.activeElement.id === "globalSearch"'), f'{width}: slash still focuses search from the page')
                for tag in ['input', 'textarea', 'select', 'div']:
                    page.evaluate('tag=>{const e=document.createElement(tag);e.id="editingFixture";if(tag==="div")e.contentEditable="true";document.body.append(e);e.focus()}', tag)
                    page.keyboard.press('/')
                    check(page.evaluate('document.activeElement.id === "editingFixture"'), f'{width}: slash preserves ' + tag + ' editing focus')
                    page.locator('#editingFixture').evaluate('(e)=>e.remove()')
                before_url = page.url
                page.locator('#openHuddleBtn').click()
                page.keyboard.press('/')
                page.keyboard.type('x')
                check(page.evaluate('document.activeElement.id === "closeHuddleModalBtn"'), f'{width}: slash cannot leave the selected-list modal')
                check(page.url == before_url, f'{width}: modal typing cannot mutate background query')
                page.locator('#closeHuddleModalBtn').click()
                page.locator('#articlesStream [data-action="open-drawer"]').first.click()
                focus_before = page.evaluate('document.activeElement.id')
                page.keyboard.press('/')
                check(page.evaluate('document.activeElement.id') == focus_before, f'{width}: slash cannot leave the reader modal')
                check(page.url == before_url, f'{width}: reader slash leaves search unchanged')
                page.locator('#drawerCloseBtn').click()

                page.goto(base + '?mode=library&lane=all', wait_until='load')
                total = int(page.locator('#libCountBadge').inner_text())
                hidden = page.evaluate('window.LIBRARY.papers.filter(p=>p.minor).length')
                check(count(page) == total - hidden and hidden > 0, f'{width}: count difference is minor filter')
                expect(page.locator('.results-meta')).to_contain_text('默认隐藏更正 / 来信')
                expect(page.locator('#libCountBadge')).to_have_attribute('title', '已收录题录总数，含更正 / 来信；列表按当前筛选计数')
                if not page.locator('[data-minor]').is_visible():  # lives in 更多筛选
                    page.locator('#filterToggleBtn').click()
                page.locator('[data-minor]').click()
                if page.locator('#sheetClose').is_visible():
                    page.locator('#sheetClose').click()
                check(count(page) == total, f'{width}: including minor equals total badge')
                check('默认隐藏' not in page.locator('.results-meta').inner_text(), f'{width}: explanation follows toggle')
                page.locator('#openHuddleBtn').click()
                empty_actions(page, f'initial/{width}')
                no_overflow(page, f'empty/{width}')
                page.screenshot(path=str(out / f'empty-{width}.png'))
                page.locator('#closeHuddleModalBtn').click()
                add = page.locator('#articlesStream [data-action="toggle-huddle"]').first
                paper_id = add.get_attribute('data-paper-id')
                add.click()
                expect(page.locator('#huddleCounter')).to_have_text('1')
                page.reload(wait_until='load')
                expect(page.locator('#huddleCounter')).to_have_text('1')
                page.locator('#openHuddleBtn').click()
                for button_id in BUTTONS:
                    expect(page.locator('#' + button_id)).to_be_enabled()
                    check(page.locator('#' + button_id).get_attribute('aria-describedby') is None, f'{width}: nonempty action has no stale empty description')
                page.locator('#copyHuddleSummaryBtn').click()
                check(bool(page.evaluate('window.__copiedSummary?.includes("心知文献情报")')), f'{width}: nonempty copy works without clipboard permissions')
                with page.expect_download() as download:
                    page.locator('#exportHuddleMdBtn').click()
                check(download.value.suggested_filename.endswith('.md'), f'{width}: nonempty export works')
                page.locator('[data-action="remove-huddle"]').click()
                empty_actions(page, f'last removal/{width}')
                page.locator('#closeHuddleModalBtn').click()
                page.locator(f'#articlesStream [data-action="toggle-huddle"][data-paper-id="{paper_id}"]').click()
                page.locator('#openHuddleBtn').click()
                page.locator('#clearHuddleBtn').click()
                empty_actions(page, f'clear/{width}')
                check(page.evaluate('localStorage.getItem("xinzhi_huddle_ids")') == '[]', f'{width}: clearing persists')
                page.reload(wait_until='load')
                page.locator('#openHuddleBtn').click()
                empty_actions(page, f'reload/{width}')
                page.locator('#closeHuddleModalBtn').click()
                page.evaluate('localStorage.setItem("xinzhi_huddle_ids", JSON.stringify(["missing-public-id"]))')
                page.reload(wait_until='load')
                page.locator('#openHuddleBtn').click()
                # An unresolved saved ID stays listed (it may be an older radar paper) and can be removed.
                missing = page.locator('.huddle-item-missing')
                expect(missing).to_have_count(1)
                expect(missing).to_contain_text('missing-public-id')
                expect(page.locator('#clearHuddleBtn')).to_be_enabled()
                for button_id in ['copyHuddleSummaryBtn', 'exportHuddleMdBtn']:
                    expect(page.locator('#' + button_id)).to_be_disabled()
                missing.locator('[data-action="remove-huddle"]').click()
                empty_actions(page, f'unresolved saved ID/{width}')
                context.close()
                print(f'Real browser search/count/shortlist passed at {width}px', flush=True)
            browser.close()
        check(not errors, 'No browser JavaScript errors')
        (out / 'results.json').write_text(json.dumps({'checks': len(checks), 'records': records, 'requests': requests, 'errors': errors, 'modelCalls': 0}, ensure_ascii=False, indent=2))
        print(f'{len(checks)} checks passed; 0 model calls; evidence: {out}')
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
