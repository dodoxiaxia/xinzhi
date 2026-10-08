"""Standalone saved-public-bundle Chromium QA; no provider or external calls."""
if __name__ == '__main__':
    import functools, json, sys, threading
    from pathlib import Path
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
    from playwright.sync_api import sync_playwright, expect

    root = Path(sys.argv[1])
    public = root / 'public' if (root / 'public').is_dir() else root
    output = root.parent / ('qa-' + root.name + '-gap')
    output.mkdir(exist_ok=True)
    dois = ['10.1038/s41591-026-04704-z', '10.1038/s41591-026-04673-3',
            '10.1093/europace/euag272', '10.1111/jce.70522',
            '10.1111/jce.70525', '10.1111/jce.70526']
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(public)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    posts, errors, records = [], [], []
    def route(r):
        if '/api/' in r.request.url:
            if r.request.method == 'POST':
                posts.append(r.request.url)
                return r.abort()
            return r.fulfill(json={'ok': True, 'found': False, 'canGenerate': False, 'papers': []})
        if not r.request.url.startswith(base):
            return r.abort()
        return r.continue_()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            for width in [320, 390, 1280]:
                context = browser.new_context(viewport={'width': width, 'height': 950})
                context.route('**/*', route)
                page = context.new_page()
                page.set_default_timeout(20000)
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base + '?mode=weekly&view=compact', wait_until='networkidle')
                coverage = page.evaluate('WEEKLY_BOARD.coverage')
                assert coverage == {'title': 24, 'translate': 24, 'study': 0, 'quicklook': 24}, coverage
                for doi in dois:
                    paper = page.evaluate('(doi)=>WEEKLY_BOARD.items.find(p=>p.doi===doi)', doi)
                    assert paper and paper['translation'] and paper['quicklook']
                    assert paper['allowAutomaticGeneration'] is False
                    page.locator(f'[data-action="open-drawer"][data-paper-id="{paper["id"]}"]:visible').first.click(no_wait_after=True)
                    expect(page.locator('.reader-drawer.open')).to_be_visible()
                    body = page.locator('#drawerBody')
                    translated = body.locator('.abstract-translation .tr-box p:not(.translation-note)').all_text_contents()
                    assert translated == [part for part in paper['translation']['abstract_zh'].splitlines() if part], doi
                    expect(body).to_contain_text(paper['quicklook']['findings'][0]['text'])
                    expect(body).to_contain_text('Sol 会话依据公开摘要整理译文')
                    expect(body).to_contain_text('Sol 会话根据公开摘要整理')
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                    page.locator('#drawerCloseBtn').click(no_wait_after=True)
                records.append({'width': width, 'coverage': coverage, 'sixGapReadersPassed': True, 'noOverflow': True})
                context.close()
            browser.close()
        assert not posts and not errors, (posts, errors)
        report = {'scope': 'Offline Chromium against exact public files, external requests intercepted',
                  'records': records, 'posts': posts, 'pageErrors': errors}
        (output / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False))
    finally:
        server.shutdown()
