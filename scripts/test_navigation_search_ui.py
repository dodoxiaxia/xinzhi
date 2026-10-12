"""Offline full-public-bundle reproduction and regression for special-view search/navigation."""
if __name__ == '__main__':
    import functools, json, os, sys, threading
    from pathlib import Path
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlsplit
    from playwright.sync_api import sync_playwright, expect
    # Usage: test_navigation_search_ui.py [PUBLIC_DIR_OR_ROOT] [--fixed]. With no directory it checks this checkout's
    # built public/ and expects the fixed behavior; evidence goes to .local/.
    positional = [a for a in sys.argv[1:] if not a.startswith('--')]
    repo = Path(__file__).resolve().parents[1]
    root = Path(positional[0]) if positional else repo
    public = root / 'public' if (root / 'public').is_dir() else root
    fixed = '--fixed' in sys.argv or not positional
    out = repo / '.local' / ('qa-' + root.name + '-navigation')
    out.mkdir(parents=True, exist_ok=True)
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(public)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    posts, errors, records = [], [], []
    def route(r):
        if '/api/' in r.request.url:
            if r.request.method == 'POST':
                posts.append(r.request.post_data_json)
                return r.abort()
            return r.fulfill(json={'ok': True, 'found': False, 'canGenerate': True, 'papers': []})
        if not r.request.url.startswith(base): return r.abort()
        return r.continue_()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
            for width in [320, 390, 1440]:
                context = browser.new_context(viewport={'width': width, 'height': 850})
                context.route('**/*', route)
                page = context.new_page(); page.set_default_timeout(15000)
                page.on('pageerror', lambda e: errors.append(str(e)))
                for mode, selector in [('weekly', '.weekly-auto-item'), ('sources', '.source-item')]:
                    page.goto(base + '?mode=' + mode + '&view=compact', wait_until='networkidle')
                    before = page.locator(selector).count()
                    page.locator('#globalSearch').fill('zzzz-no-existing-match-2839')
                    page.wait_for_timeout(300)
                    after = page.locator(selector).count()
                    scope = page.locator('.search-scope:visible').count()
                    if fixed:
                        assert before > 0 and after == 0 and scope > 0, (mode, width, before, after, scope)
                        page.locator('[data-clear="search"]:visible').click()
                        expect(page.locator(selector)).to_have_count(before)
                        expect(page.locator('#globalSearch')).to_have_value('')
                    else:
                        assert after == before and scope == 0, (mode, width, before, after, scope)
                    records.append({'width': width, 'mode': mode, 'before': before, 'noMatchAfter': after, 'visibleScope': scope})
                if fixed:
                    page.goto(base + '?mode=weekly&view=compact&tier=Unrelated', wait_until='networkidle')
                    author = page.evaluate('FEEDS.items.find(p=>p.weeklyPick && p.authors?.length)')
                    page.locator('#globalSearch').fill(author['authors'][0])
                    expect(page.locator('#weeklyAuto .special-search-status')).to_contain_text(author['authors'][0])
                    expect(page.locator('.weekly-auto-item[data-paper-id="' + author['id'] + '"]')).to_be_visible()
                    count = page.locator('.weekly-auto-item').count(); assert 0 < count < 24
                    saved_url = page.url; page.reload(wait_until='networkidle')
                    expect(page.locator('.weekly-auto-item')).to_have_count(count)
                    page.locator('#globalSearch').fill('房颤')
                    expect(page.locator('#weeklyAuto .special-search-status')).to_contain_text('搜索：房颤')
                    count = page.locator('.weekly-auto-item').count(); assert 0 < count < 24
                    assert page.locator('#nextCandidates').inner_text() == ''
                    records.append({'width': width, 'mode': 'weekly-matched-author-chinese-reload', 'matched': count, 'hiddenOtherColumnFiltersIgnored': True})
                    page.locator('#sourceStatusBtn').click(no_wait_after=True)
                    expect(page.locator('#sourcesHealthGrid .search-scope')).to_contain_text('信源状态')
                    expect(page.locator('#globalSearch')).to_have_value('房颤')
                    page.locator('#globalSearch').fill('bmj')
                    expect(page.locator('#sourcesHealthGrid .special-search-status')).to_contain_text('搜索：bmj')
                    matched = page.locator('.source-item').count(); assert 0 < matched < 82
                    page.locator('#globalSearch').fill('返回非订阅内容')
                    expect(page.locator('#sourcesHealthGrid .special-search-status')).to_contain_text('搜索：返回非订阅内容')
                    failed = page.evaluate('SOURCE_HEALTH.sources.filter(s=>s.status==="not_feed").length')
                    expect(page.locator('.source-item')).to_have_count(failed)
                    doi = page.evaluate('FEEDS.items.find(p=>p.doi).doi')
                    page.locator('#globalSearch').fill(doi)
                    expect(page.locator('.doi-search-notice:visible')).to_contain_text('按 DOI 全站检索')
                    assert not page.locator('#sourcesSection').is_visible()
                    page.locator('[data-clear="search"]:visible').click(no_wait_after=True)
                    expect(page.locator('.source-item')).to_have_count(82)
                    records.append({'width': width, 'mode': 'source-name-status-and-doi', 'nameMatches': matched, 'failedMatches': failed, 'doiGlobalPreserved': True})
                if width < 500:
                    page.goto(base + '?mode=candidates&lane=all&view=compact', wait_until='networkidle')
                    page.evaluate('scrollTo(0, 1600)'); page.wait_for_timeout(100)
                    rect = page.locator('.header-nav').bounding_box()
                    visible = bool(rect and rect['y'] >= -1 and rect['y'] + rect['height'] <= 850)
                    controls = {selector: page.locator(selector).bounding_box() for selector in ['#themeToggle', '#openHuddleBtn', '#globalSearch', '#sourceStatusBtn']}
                    if fixed:
                        assert visible, (width, rect)
                        assert all(v and round(v['height']) >= 44 and round(v['width']) >= 44 for v in controls.values()), controls  # subpixel layout: 43.99998 counts as 44
                    else: assert not visible
                    records.append({'width': width, 'mode': 'mobile-scroll', 'navigationVisibleAfterScroll': visible, 'controlSizes': controls})
                    if fixed:
                        page.screenshot(path=str(out / f'mobile-navigation-{width}.png'))
                        # One look remains; legacy ?style= links must still open cleanly.
                        for style in ['a', 'b', 'c', 'd']:
                            for theme in ['light', 'dark']:
                                page.goto(base + f'?mode=candidates&lane=all&view=compact&style={style}&theme={theme}', wait_until='networkidle')
                                page.evaluate('scrollTo(0, 1400)'); page.wait_for_timeout(100)
                                rect = page.locator('.header-nav').bounding_box()
                                assert rect and rect['y'] >= 0
                                assert page.locator('#styleBtn').count() == 0 and page.evaluate('document.documentElement.dataset.style') == 'a'
                                for target in ['#themeToggle', '#openHuddleBtn', '#globalSearch', '#sourceStatusBtn']:
                                    size = page.locator(target).bounding_box(); assert round(size['height']) >= 44 and round(size['width']) >= 44, (style, theme, target, size)
                                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                        records.append({'width': width, 'mode': 'all-mobile-appearances', 'legacyStyleLinks': 4, 'themes': 2, 'minimumTouchSize': 44})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                context.close()
            browser.close()
        assert not errors and not posts, (errors, posts)
        report = {'fixedExpected': fixed, 'scope': 'Offline Chromium, exact public files, all API/external requests intercepted', 'records': records, 'posts': posts, 'pageErrors': errors}
        (out / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False))
    finally: server.shutdown()
