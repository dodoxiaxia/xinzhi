#!/usr/bin/env python3
"""Offline browser checks; external requests blocked and API calls mocked."""
import functools
import os
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    from playwright.sync_api import expect, sync_playwright
    root = Path(__file__).resolve().parents[1]
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(root/'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks, calls = [], []
    def check(value, label):
        assert value, label
        checks.append(label)
    def mock(route):
        if '/api/' in route.request.url:
            calls.append(route.request.method)
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': False})
        if not route.request.url.startswith(base):
            return route.abort('blockedbyclient')
        return route.continue_()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
            for width in [320, 390, 1440]:
                for reduced in [False, True]:
                    context = browser.new_context(viewport={'width': width, 'height': 900}, reduced_motion='reduce' if reduced else 'no-preference')
                    context.route('**/*', mock)
                    page = context.new_page()
                    page.goto(base+'?mode=weekly', wait_until='networkidle')
                    button = page.get_by_role('button', name='回到页面顶部', exact=True)
                    expect(button).to_be_hidden()
                    page.evaluate("window.scrollTo({top: 900, behavior: 'instant'})")  # html has scroll-behavior: smooth
                    expect(button).to_be_visible()
                    box = button.bounding_box()
                    check(box['width'] >= 44 and box['height'] >= 44, f'{width}/{reduced}: touch target')
                    check(box['x'] >= 0 and box['x']+box['width'] <= width, f'{width}/{reduced}: no overflow')
                    if width < 721:
                        check(box['y']+box['height'] <= 824, f'{width}/{reduced}: bottom controls clearance')
                    original_y = page.evaluate('window.scrollY')
                    page.locator('.weekly-card-actions [data-action="open-drawer"]').first.evaluate('(e)=>e.click()')
                    expect(button).to_be_hidden()
                    page.locator('#drawerCloseBtn').click()
                    expect(button).to_be_visible()
                    check(abs(page.evaluate('window.scrollY')-original_y)<2, f'{width}/{reduced}: drawer preserves list position')
                    # The mobile header scrolls with the page; open without the
                    # test runner first scrolling its off-screen trigger into view.
                    page.locator('#openHuddleBtn').evaluate('(e)=>{e.focus({preventScroll:true});e.click()}')
                    expect(button).to_be_hidden()
                    page.locator('#closeHuddleModalBtn').click()
                    expect(button).to_be_visible()
                    check(abs(page.evaluate('window.scrollY')-original_y)<2, f'{width}/{reduced}: modal preserves list position')
                    # Record actual scroll behavior while exercising the real scroll method.
                    page.evaluate("window.__scrollBehavior=[];const original=window.scrollTo.bind(window);window.scrollTo=(...a)=>{window.__scrollBehavior.push(a[0]?.behavior);return original(...a)}")
                    button.focus()
                    button.press('Enter')
                    page.wait_for_function('window.scrollY < 2')
                    expect(button).to_be_hidden()
                    check(page.locator('#brandLogo').evaluate('(e)=>e===document.activeElement'), f'{width}/{reduced}: keyboard focus restored')
                    check(page.evaluate('window.__scrollBehavior.at(-1)') == ('instant' if reduced else 'smooth'), f'{width}/{reduced}: respects motion preference')
                    page.evaluate("window.scrollTo({top: 900, behavior: 'instant'})")
                    expect(button).to_be_visible()
                    button.click()
                    page.wait_for_function('window.scrollY < 2')
                    expect(button).to_be_hidden()
                    check(True, f'{width}/{reduced}: pointer click works')
                    page.evaluate("window.scrollTo({top: 900, behavior: 'instant'})")
                    expect(button).to_be_visible()
                    button.focus()
                    button.press('Space')
                    page.wait_for_function('window.scrollY < 2')
                    expect(button).to_be_hidden()
                    check(True, f'{width}/{reduced}: Space activation works')
                    context.close()
            check('POST' not in calls, 'No model generation')
            browser.close()
    finally:
        server.shutdown()
    out=root/'.local/back-to-top-qa';out.mkdir(parents=True,exist_ok=True)
    (out/'results.json').write_text(json.dumps({'checks':checks,'count':len(checks),'apiMethods':calls},ensure_ascii=False,indent=2)+'\n')
    print(f'{len(checks)} back-to-top browser checks passed')


if __name__ == '__main__':
    main()
