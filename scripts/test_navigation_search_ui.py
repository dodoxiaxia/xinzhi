"""Offline full-public-bundle reproduction and regression for special-view search/navigation."""
def sfill(page, text):
    """Open the search panel when it is closed, then type."""
    if not page.locator('#searchPanel').is_visible():
        page.locator('#searchToggleBtn').click()
    page.locator('#globalSearch').fill(text)
    page.wait_for_timeout(450)


if __name__ == '__main__':
    import functools, json, os, re, sys, threading
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
            for width in [320, 390, 884, 1280, 1440]:
                context = browser.new_context(viewport={'width': width, 'height': 850})
                context.route('**/*', route)
                page = context.new_page(); page.set_default_timeout(15000)
                page.on('pageerror', lambda e: errors.append(str(e)))
                for mode, selector in [('weekly', '.weekly-auto-item'), ('sources', '.source-item')]:
                    page.goto(base + '?mode=' + mode + '&view=compact', wait_until='networkidle')
                    before = page.locator(selector).count()
                    sfill(page, 'zzzz-no-existing-match-2839')
                    page.wait_for_timeout(300)
                    after = page.locator(selector).count()
                    scope = page.locator('.search-scope:visible').count()
                    if fixed:
                        assert before > 0 and after == 0 and scope > 0, (mode, width, before, after, scope)
                        page.locator('#searchPanel [data-clear="search"]').click()
                        expect(page.locator(selector)).to_have_count(before)
                        expect(page.locator('#globalSearch')).to_have_value('')
                    else:
                        assert after == before and scope == 0, (mode, width, before, after, scope)
                    records.append({'width': width, 'mode': mode, 'before': before, 'noMatchAfter': after, 'visibleScope': scope})
                if fixed:
                    page.goto(base + '?mode=weekly&view=compact&lane=core&range=365&ft=none', wait_until='networkidle')
                    board_ids = page.locator('.weekly-auto-item').evaluate_all('(cards) => cards.map(card => card.dataset.paperId)')
                    author = page.evaluate('ids => FEEDS.items.find(p => ids.includes(p.id) && p.authors?.length)', board_ids)
                    assert author, 'The browser fixture needs an author on a paper in the current board'
                    sfill(page, author['authors'][0])
                    expect(page.locator('#weeklyAuto .special-search-status')).to_contain_text(author['authors'][0])
                    expect(page.locator('.weekly-auto-item[data-paper-id="' + author['id'] + '"]')).to_be_visible()
                    expect(page.locator('.weekly-auto-item')).to_have_count(1)
                    page.reload(wait_until='networkidle')
                    expect(page.locator('.weekly-auto-item')).to_have_count(1)
                    sfill(page, '房颤')
                    expect(page.locator('#weeklyAuto .special-search-status')).to_contain_text('搜索：房颤')
                    count = page.locator('.weekly-auto-item').count(); assert 0 < count < len(board_ids)
                    assert page.locator('#nextCandidates').inner_text() == ''
                    records.append({'width': width, 'mode': 'weekly-matched-author-chinese-reload', 'matched': count, 'hiddenOtherColumnFiltersIgnored': True})
                    page.locator('#sourceStatusBtn').click(no_wait_after=True)
                    expect(page.locator('#sourcesHealthGrid .search-scope')).to_contain_text('信源状态')
                    expect(page.locator('#globalSearch')).to_have_value('房颤')
                    source_count = page.evaluate('SOURCE_HEALTH.sources.length')
                    sfill(page, 'bmj')
                    expect(page.locator('#sourcesHealthGrid .special-search-status')).to_contain_text('搜索：bmj')
                    matched = page.locator('.source-item').count(); assert 0 < matched < source_count
                    sfill(page, '返回非订阅内容')
                    expect(page.locator('#sourcesHealthGrid .special-search-status')).to_contain_text('搜索：返回非订阅内容')
                    failed = page.evaluate('SOURCE_HEALTH.sources.filter(s=>s.status==="not_feed").length')
                    expect(page.locator('.source-item')).to_have_count(failed)
                    doi = page.evaluate('FEEDS.items.find(p=>p.doi).doi')
                    sfill(page, doi)
                    expect(page.locator('#activeFiltersBar .doi-filter-badge:visible')).to_be_visible()
                    assert not page.locator('#sourcesSection').is_visible()
                    page.locator('#searchPanel [data-clear="search"]').click(no_wait_after=True)
                    expect(page.locator('.source-item')).to_have_count(source_count)
                    records.append({'width': width, 'mode': 'source-name-status-and-doi', 'nameMatches': matched, 'failedMatches': failed, 'doiGlobalPreserved': True})
                if width < 500:
                    page.goto(base + '?mode=candidates&lane=all&view=compact', wait_until='networkidle')
                    page.evaluate('scrollTo(0, 1600)'); page.wait_for_timeout(100)
                    rect = page.locator('.header-nav').bounding_box()
                    visible = bool(rect and rect['y'] >= -1 and rect['y'] + rect['height'] <= 850)
                    controls = {selector: page.locator(selector).bounding_box() for selector in ['#themeToggle', '#openHuddleBtn', '#searchToggleBtn']}
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
                                for target in ['#themeToggle', '#openHuddleBtn', '#searchToggleBtn']:
                                    size = page.locator(target).bounding_box(); assert round(size['height']) >= 44 and round(size['width']) >= 44, (style, theme, target, size)
                                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                        records.append({'width': width, 'mode': 'all-mobile-appearances', 'legacyStyleLinks': 4, 'themes': 2, 'minimumTouchSize': 44})
                if width in [390, 884, 1280, 1440]:
                    page.goto(base + '?mode=library&lane=all&range=all&view=cards', wait_until='networkidle')
                    page.wait_for_function('window.LIBRARY && Array.isArray(LIBRARY.papers)')
                    page_len = page.locator('#articlesStream [data-action="open-drawer"][data-paper-id]').count()
                    assert page_len > 0, 'The local public library fixture needs at least one first-page record'
                    page.locator('[data-qf-jtier="cardioClinical"]').click()
                    page.locator('[data-qf-jtier="cardioClinical"]').click()
                    clinical = page.locator('#articlesStream [data-action="open-drawer"][data-paper-id]')
                    expect(clinical.first).to_be_visible()
                    page.evaluate('''pageLen => {
                        const buttons = [...document.querySelectorAll('#articlesStream [data-action="open-drawer"][data-paper-id]')];
                        const sourceIds = new Set(buttons.map(button => button.dataset.paperId));
                        const source = LIBRARY.papers.filter(paper => sourceIds.has(paper.id));
                        if (!source.length) throw new Error('The clinical archive fixture needs a source record');
                        let serial = 0;
                        const copies = Array.from({length: pageLen * 4 + 1}, (_, index) => {
                            const paper = source[index % source.length];
                            serial += 1;
                            return {
                                ...paper,
                                id: `history-pagination-fixture-${serial}`,
                                doi: `10.9999/history-pagination-fixture-${serial}`,
                                title: `HistoryRestorationFixture ${serial}`,
                            };
                        });
                        LIBRARY.papers.push(...copies);
                        return copies.length;
                    }''', page_len)
                    copy_count = page_len * 4 + 1
                    page.locator('[data-qf-jtier="cardioClinical"]').click()
                    page.locator('[data-qf-jtier="cardioClinical"]').click()
                    first_batch = page.locator('#articlesStream [data-action="open-drawer"][data-paper-id]').evaluate_all('(buttons) => buttons.map(button => button.dataset.paperId)')
                    assert len(first_batch) == page_len, (page_len, first_batch)
                    previous_ids = first_batch
                    for _ in range(2):
                        expect(page.locator('#loadMoreBtn')).to_be_visible()
                        page.locator('#loadMoreBtn').click()
                        ids = page.locator('#articlesStream [data-action="open-drawer"][data-paper-id]').evaluate_all('(buttons) => buttons.map(button => button.dataset.paperId)')
                        assert len(ids) == len(previous_ids) + page_len, (page_len, len(previous_ids), len(ids))
                        previous_ids = ids
                    expected_ids = ids
                    last_opener = page.locator(f'#articlesStream [data-action="open-drawer"][data-paper-id="{expected_ids[-1]}"]')
                    last_opener.scroll_into_view_if_needed()
                    page.mouse.move(width / 2, 740)
                    page.mouse.wheel(0, 10000)
                    page.wait_for_function('''() => Math.abs(window.scrollY - (document.documentElement.scrollHeight - innerHeight)) <= 1''')
                    saved_scroll = page.evaluate('''() => ({top: window.scrollY, height: document.documentElement.scrollHeight,
                        clientHeight: document.documentElement.clientHeight})''')
                    page.evaluate('''document.querySelector('.nav-tab-btn[data-mode="candidates"]').click()''')
                    expect(page.locator('.nav-tab-btn[data-mode="candidates"]')).to_have_class(re.compile(r'\bactive\b'))
                    page.go_back()
                    page.wait_for_function('''document.querySelector('.nav-tab-btn[data-mode="library"].active')''')
                    page.evaluate('''() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))''')
                    restored_ids = page.locator('#articlesStream [data-action="open-drawer"][data-paper-id]').evaluate_all('(buttons) => buttons.map(button => button.dataset.paperId)')
                    restored_scroll = page.evaluate('''() => ({top: window.scrollY, height: document.documentElement.scrollHeight,
                        clientHeight: document.documentElement.clientHeight, page: history.state?.page})''')
                    assert restored_ids == expected_ids, {'expected': expected_ids, 'restored': restored_ids}
                    assert restored_ids[-1] == expected_ids[-1]
                    assert abs(restored_scroll['top'] - saved_scroll['top']) <= 1, {'saved': saved_scroll, 'restored': restored_scroll}
                    if width == 1280:
                        page.evaluate('''() => {
                            window.__historyScrollUserTarget = Math.min(120, document.documentElement.scrollHeight - innerHeight);
                            window.__historyScrollCalls = [];
                            window.__historyScrollNativeTo = window.scrollTo.bind(window);
                            window.scrollTo = (...args) => {
                                const target = typeof args[0] === 'object' ? args[0].top : args[1];
                                window.__historyScrollCalls.push(target);
                                return window.__historyScrollNativeTo(...args);
                            };
                            window.__historyWheelSeen = false;
                            window.addEventListener('wheel', () => { window.__historyWheelSeen = true; }, {once: true});
                            window.addEventListener('popstate', () => {
                                window.scrollTo({top: window.__historyScrollUserTarget, behavior: 'instant'});
                                window.__historyScrollCallIndex = window.__historyScrollCalls.length;
                                document.body.dispatchEvent(new WheelEvent('wheel', {deltaY: 1, bubbles: true, cancelable: true}));
                            }, {once: true});
                        }''')
                        page.go_forward()
                        expect(page.locator('.nav-tab-btn[data-mode="candidates"]')).to_have_class(re.compile(r'\bactive\b'))
                        user_scroll = page.evaluate('window.__historyScrollUserTarget')
                        page.evaluate('''() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))''')
                        pending_scroll = page.evaluate('''() => {
                            const result = {
                                top: window.scrollY,
                                calls: window.__historyScrollCalls.slice(window.__historyScrollCallIndex),
                                wheelSeen: window.__historyWheelSeen,
                            };
                            window.scrollTo = window.__historyScrollNativeTo;
                            return result;
                        }''')
                        assert user_scroll > 0 and pending_scroll['top'] > 0 and pending_scroll['wheelSeen'] and 0 not in pending_scroll['calls'], {
                            'userScroll': user_scroll, 'afterPendingRestore': pending_scroll
                        }
                        page.go_back()
                        expect(page.locator('.nav-tab-btn[data-mode="library"]')).to_have_class(re.compile(r'\bactive\b'))
                        page.evaluate('''() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))''')
                        restored_scroll = page.evaluate('''() => ({top: window.scrollY})''')
                        assert abs(restored_scroll['top'] - saved_scroll['top']) <= 1, {
                            'saved': saved_scroll['top'], 'restored': restored_scroll['top']
                        }
                    sfill(page, 'HistoryRestorationFixture')
                    fresh_ids = page.locator('#articlesStream [data-action="open-drawer"][data-paper-id]').evaluate_all('(buttons) => buttons.map(button => button.dataset.paperId)')
                    expect(page.locator('#loadMoreBtn')).to_be_visible()
                    assert len(fresh_ids) == page_len, {'pageSize': page_len, 'freshFilterCount': len(fresh_ids)}
                    if width == 1280:
                        page.evaluate('''() => {
                            history.replaceState({...history.state, overlay: 'drawer', deepReader: 'stale', readingDrawer: {id: 'stale'}}, '', location.href);
                            document.querySelector('.nav-tab-btn[data-mode="candidates"]').click();
                        }''')
                        new_nav_state = page.evaluate('history.state')
                        assert set(new_nav_state) == {'page', 'scrollY', 'journalTierLegacy'}, new_nav_state
                    records.append({'width': width, 'mode': 'clinical-archive-history-page', 'pageSize': page_len,
                                    'loadedIds': expected_ids, 'restoredIds': restored_ids, 'lastId': restored_ids[-1],
                                    'savedScroll': saved_scroll['top'], 'restoredScroll': restored_scroll['top'],
                                    'freshFilterCount': len(fresh_ids), 'fixtureCopies': copy_count})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                context.close()
            browser.close()
        assert not errors and not posts, (errors, posts)
        report = {'fixedExpected': fixed, 'scope': 'Offline Chromium, exact public files, all API/external requests intercepted', 'records': records, 'posts': posts, 'pageErrors': errors}
        (out / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False))
    finally: server.shutdown()
