"""Offline saved-bundle AI brief count and stalled-request browser regression."""
if __name__ == '__main__':
    import functools, json, os, sys, threading
    from pathlib import Path
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
    from playwright.sync_api import sync_playwright, expect
    # Usage: test_brief_feedback_ui.py [PUBLIC_DIR_OR_ROOT] [--fixed]. With no directory it checks this checkout's
    # built public/ and expects the fixed behavior; evidence goes to .local/.
    positional = [a for a in sys.argv[1:] if not a.startswith('--')]
    repo = Path(__file__).resolve().parents[1]
    root = Path(positional[0]) if positional else repo
    public = root / 'public' if (root / 'public').is_dir() else root
    fixed = '--fixed' in sys.argv or not positional; out = repo / '.local' / ('qa-' + root.name + '-brief'); out.mkdir(parents=True, exist_ok=True)
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(public)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'; posts, gets, errors = [], [], []
    controls = {'hold': False}; held = []
    def route(r):
        if '/api/' in r.request.url:
            if r.request.method == 'POST':
                data = r.request.post_data_json; posts.append(data)
                if controls['hold']: held.append(r); return
                items = data['items']; refs = [{'n': i+1, 'key': 'pmid:' + str(x['pmid']) if x['pmid'] else 'doi:' + x['doi'].lower(), 'title': 'Synthetic public abstract', 'journal': 'Fixture'} for i,x in enumerate(items[:2])]
                return r.fulfill(json={'ok': True, 'brief': {'theme': '离线测试主题', 'papers': [{'n': 1, 'point': '离线摘要一'}, {'n': 2, 'point': '离线摘要二'}], 'refs': refs, 'compare': '离线比较', 'questions': ['离线问题'], 'caveat': '仅为合成测试'}, 'cached': False})
            gets.append(r.request.url)
            return r.fulfill(json={'ok': True, 'found': False, 'canGenerate': True, 'papers': []})
        if not r.request.url.startswith(base): return r.abort()
        return r.continue_()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 390, 'height': 950}); context.route('**/*', route)
            page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(base+'?mode=candidates&lane=all&view=compact', wait_until='networkidle')
            button = page.locator('#aiDigest [data-action="ai-brief"]'); expect(button).to_be_visible()
            label = button.inner_text(); button.click(no_wait_after=True)
            expect(page.locator('#aiDigest')).to_contain_text('离线测试主题')
            partial = page.locator('#aiDigest').inner_text()
            if fixed:
                expect(page.locator('#aiDigest')).to_contain_text('实际纳入 2 篇')
                expect(page.locator('#aiDigest')).to_contain_text('6 篇公开摘要未纳入')
            else: assert '实际纳入' not in partial
            controls['hold'] = True
            page.reload(wait_until='networkidle'); page.clock.install()
            page.locator('#aiDigest [data-action="ai-brief"]').click(no_wait_after=True)
            expect(page.locator('#aiDigest')).to_contain_text('正在读取摘要')
            page.clock.fast_forward(45001)
            slow = page.locator('#aiDigest').inner_text()
            if fixed: assert '用时较长' in slow
            page.clock.fast_forward(195001)
            stalled = page.locator('#aiDigest').inner_text()
            if fixed:
                assert '本次等待已到时限' in stalled, stalled  # client deadline is 170 s
                before = len(posts)
                page.locator('#aiDigest [data-action="brief-check"]').click(no_wait_after=True)
                expect(page.locator('#aiDigest')).to_contain_text('尚未查到已保存结果')
                assert len(posts) == before
                assert any('task=brief' in x for x in gets)
            else: assert '正在读取摘要并生成' in stalled
            assert len(posts) == 2 and not errors, (posts, errors)
            if fixed:
                page.evaluate("localStorage.setItem('xinzhi_huddle_ids',JSON.stringify(FEEDS.items.filter(p=>p.pmid||p.doi).slice(0,3).map(p=>p.id)))")
                page.reload(wait_until='networkidle')
                page.locator('#openHuddleBtn').click(no_wait_after=True)
                page.locator('#huddleModalBody [data-action="ai-brief"][data-mode="huddle"]').click(no_wait_after=True)
                expect(page.locator('#huddleModalBody')).to_contain_text('正在读取摘要')
                page.locator('#closeHuddleModalBtn').click(no_wait_after=True)
                page.clock.fast_forward(45001)
                assert not page.locator('#huddleModalBackdrop').evaluate('e=>e.classList.contains("open")')
                page.clock.fast_forward(195001)
                assert not page.locator('#huddleModalBackdrop').evaluate('e=>e.classList.contains("open")')
            for pending in held:
                try: pending.abort()
                except Exception: pass
            context.close(); browser.close()
        report = {'fixedExpected': fixed, 'scope': 'Offline Chromium; synthetic partial/stalled API; no paid calls', 'requestedLabel': label, 'requestedItems': len(posts[0]['items']), 'actualReturnedRefs': 2, 'partialStatus': partial, 'slowStatus': slow, 'stalledStatus': stalled, 'closedModalStaysClosed': fixed, 'posts': len(posts), 'pageErrors': errors}
        (out/'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n'); print(json.dumps(report, ensure_ascii=False))
    finally: server.shutdown()
