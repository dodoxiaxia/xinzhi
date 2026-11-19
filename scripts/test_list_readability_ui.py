"""Offline title, issue month, category contrast and example URL regressions."""
import functools
import json
import os
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

PUBLIC = Path(__file__).resolve().parents[1] / 'public'
TITLE = 'Cardiovascular outcomes after hospital discharge and longitudinal follow-up ' * 6
# Beijing has crossed into January while the viewer in Los Angeles is still in December.
DATES = [('2027-02-03', 'day'), ('2027-02-01', 'month'),
         ('2027-01-01', 'month'), ('2026-12-01', 'month')]
PAPERS = [dict(id=f'issue-{i}', doi=f'10.9999/issue-{i}', title=TITLE.strip() if i == 1 else f'Issue research {i}',
               titleZh={1: '心血管随访研究', 2: '短标题'}.get(i, ''), journal='Circulation',
               date=date, datePrecision=precision) for i, (date, precision) in enumerate(DATES)]


class Static(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


# Composite translucent theme backgrounds and the span's actual opacity before
# converting sRGB to relative luminance. Disabled controls are exempt.
CONTRAST = """span => {
  const ctx = document.createElement('canvas').getContext('2d');
  const rgb = () => [...ctx.getImageData(0,0,1,1).data].slice(0,3);
  const ancestors = [];
  for (let e=span; e; e=e.parentElement) ancestors.unshift(e);
  ctx.fillStyle='white'; ctx.fillRect(0,0,1,1);
  for (const e of ancestors) {
    ctx.fillStyle=getComputedStyle(e).backgroundColor; ctx.fillRect(0,0,1,1);
  }
  const luminance = values => values.map(v=>v/255)
    .map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
    .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const bg=luminance(rgb());
  ctx.globalAlpha=Number(getComputedStyle(span).opacity);
  ctx.fillStyle=getComputedStyle(span).color; ctx.fillRect(0,0,1,1);
  const fg=luminance(rgb());
  return (Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05);
}"""


def check(browser, base, width, height):
    page = browser.new_page(viewport={'width': width, 'height': height}, has_touch=True,
                            timezone_id='America/Los_Angeles', reduced_motion='reduce')
    page.clock.set_fixed_time(datetime(2026, 12, 31, 18, tzinfo=timezone.utc))
    canonical = True
    responses = []

    def route_request(route):
        path = urlsplit(route.request.url).path
        if not route.request.url.startswith(base) or route.request.method != 'GET':
            return route.abort()
        if path.startswith('/api/'):
            return route.fulfill(json={'found': False, 'papers': []})
        if path.startswith('/assets/data-library.'):
            payload = json.dumps({'papers': PAPERS, 'pdfIds': []})
            return route.fulfill(content_type='application/javascript',
                                 body=f'window.XINZHI_PART("library",{payload});')
        if canonical and path == '/demo-reading':
            return route.fulfill(path=PUBLIC / 'demo-reading.html', content_type='text/html')
        return route.continue_()

    page.route('**/*', route_request)
    page.on('response', lambda r: responses.append((urlsplit(r.url).path, r.status))
            if '/demo-reading' in r.url else None)
    for view in ['cards', 'compact']:
        page.goto(base)
        page.evaluate("v=>localStorage.setItem('xinzhi_view_mode',v)", view)
        page.goto(base + '?mode=library&lane=all')
        row_type = '.compact-row' if view == 'compact' else '.article-card'
        row = page.locator(f'{row_type}[data-paper-id="issue-1"]')
        expect(row).to_be_visible()
        heads = page.locator('#articlesStream .day-heading')
        labels = heads.evaluate_all('hs => hs.map(h => h.firstChild.textContent.trim())')
        assert labels == [
            '2027-02-03', '即将出版 · 2027-02 刊期', '2027-01 · 刊期（日未核验）', '2026-12 · 刊期（日未核验）'], labels
        subtitle = row.locator('.article-title-en')
        plain = page.locator(f'{row_type}[data-paper-id="issue-0"]')
        expect(plain.locator('.article-title-en')).to_have_count(0)
        plain_height = plain.bounding_box()['height']
        short = page.locator(f'{row_type}[data-paper-id="issue-2"] .article-title-en')
        expect(short).to_have_text('Issue research 2')
        expect(short.get_by_role('button')).to_have_count(0)
        if width == 390:
            expect(subtitle).to_be_hidden()
        else:
            expect(subtitle).to_be_visible()
            toggle = subtitle.get_by_role('button')
            expect(toggle).to_be_visible()
            assert subtitle.evaluate("""e=>getComputedStyle(e).textOverflow!=='ellipsis' &&
                e.scrollWidth<=e.clientWidth+1 && e.firstChild.scrollHeight>e.firstChild.clientHeight+1""")
            for method in ['keyboard', 'touch']:
                if method == 'keyboard':
                    toggle.press('Enter')
                else:
                    toggle.tap()
                expect(toggle).to_have_attribute('aria-expanded', 'true')
                expect(subtitle.locator('span')).to_have_text(TITLE.strip())
                assert subtitle.locator('span').evaluate('e=>e.scrollHeight<=e.clientHeight+1')
                toggle.press('Enter')
                expect(toggle).to_have_attribute('aria-expanded', 'false')
        assert plain.bounding_box()['height'] == plain_height
    # Use the fixture's current board rather than the issue-boundary clock.
    page.close()
    page = browser.new_page(viewport={'width': width, 'height': height})
    page.route('**/*', route_request)
    page.on('response', lambda r: responses.append((urlsplit(r.url).path, r.status))
            if '/demo-reading' in r.url else None)
    for canonical in [True, False]:
        responses.clear()
        page.goto(base + '?mode=weekly', wait_until='networkidle')
        assert responses == ([('/demo-reading', 200)] if canonical else
                             [('/demo-reading', 404), ('/demo-reading.html', 200)]), responses
    for theme in ['light', 'dark']:
        page.locator('html').evaluate('(e,t)=>e.dataset.theme=t', theme)
        for pressed in ['true', 'false']:
            spans = page.locator(f'.weekly-category-nav button:enabled[aria-pressed="{pressed}"] span')
            expect(spans.first).to_be_attached()
            ratios = [span.evaluate(CONTRAST) for span in spans.all()]
            assert min(ratios) >= 4.5, (width, theme, pressed, ratios)
    page.close()
    print(f'{width}x{height} passed')


if __name__ == '__main__':
    handler = functools.partial(Static, directory=PUBLIC)
    with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server, sync_playwright() as pw:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                                     args=['--no-sandbox'])
        for size in [(390, 844), (884, 900), (1280, 800)]:
            check(browser, f'http://127.0.0.1:{server.server_port}/', *size)
        browser.close()
