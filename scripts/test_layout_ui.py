#!/usr/bin/env python3
"""Offline browser QA for the public layout; every API/model response is mocked.

Run after scripts/build_public.py. Requires Python Playwright and Chromium.
Screenshots/results go to ignored .local/layout-qa; no production writes.
"""
import argparse
import functools
import os
import hashlib
import json
import shutil
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', default=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'))
    parser.add_argument('--output', default=str(ROOT / '.local/layout-qa'))
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    if not (ROOT / 'public/index.html').is_file():
        parser.error('Build public first: python3 scripts/build_public.py')
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks, errors, posts, records = [], [], [], []
    abstract_available = False

    def check(value, label):
        assert value, label
        checks.append(label)

    # icon.png is the user's logo (originally a 1024px PNG wrapped in icon.svg) scaled to 192px.
    logo_bytes = (ROOT / 'public/icon.png').read_bytes()
    check(logo_bytes.startswith(b'\x89PNG\r\n\x1a\n') and len(logo_bytes) < 65536, 'Public icon is a small PNG file')
    check(hashlib.sha256(logo_bytes).hexdigest() == 'c6dc7553ea87b3040cd2f4da1704bcad4ef9367b0d738bf42fa5b9fc66368fa4', 'Public icon is the scaled user logo')

    def mock(route):
        request = route.request
        url = urlsplit(request.url)
        if url.path.startswith('/api/'):
            if request.method == 'POST':
                posts.append(request.post_data_json)
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': True})
        if url.hostname == 'www.ebi.ac.uk':
            if not abstract_available:
                return route.abort('failed')
            return route.fulfill(json={'resultList': {'result': [
                {'abstractText': 'Offline abstract fixture only, used to verify interrupted reading recovery.'}
            ]}})
        if url.hostname != '127.0.0.1':
            return route.abort('blockedbyclient')
        return route.continue_()

    def overflow(page, label):
        geometry = page.evaluate('''() => ({width: innerWidth, document: document.documentElement.scrollWidth,
          drawer: document.querySelector('.reader-drawer.open') ? [document.querySelector('#drawerBody').scrollWidth, document.querySelector('#drawerBody').clientWidth] : null})''')
        check(geometry['document'] <= geometry['width'] + 1, label + ': no page overflow')
        if geometry['drawer']:
            check(geometry['drawer'][0] <= geometry['drawer'][1] + 1, label + ': no reader overflow')

    def expected_weekly(page):
        return page.evaluate('''() => {
          const end = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'}).format(new Date());
          const start = new Date(end+'T00:00:00Z'); start.setUTCDate(start.getUTCDate()-6);
          return window.FEEDS.items.filter(p=>p.weeklyPick && (!p.datePrecision || p.datePrecision==='day')
            && p.date?.slice(0,10)>=start.toISOString().slice(0,10) && p.date.slice(0,10)<=end).length;
        }''')

    def open_weekly(page, width=1440):
        page.set_viewport_size({'width': width, 'height': 1000 if width > 640 else 900})
        page.goto(base + '?mode=weekly&style=a', wait_until='load')
        expect(page.locator('.weekly-auto-item')).to_have_count(expected_weekly(page))

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**({'executable_path': args.browser} if args.browser else {}), args=['--no-sandbox'])
            context = browser.new_context()
            context.route('**/*', mock)
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            for style in ['a', 'b', 'c', 'd']:
                for width in [1440, 1024, 768, 390, 320]:
                    page.set_viewport_size({'width': width, 'height': 1000 if width > 640 else 900})
                    for mode in ['weekly', 'sources']:
                        label = f'{style}/{width}/{mode}'
                        page.goto(base + f'?mode={mode}&view=compact&style={style}', wait_until='load')
                        expect(page.locator('#weeklySection' if mode == 'weekly' else '#sourcesSection')).to_be_visible()
                        check(page.locator('#brandLogo, .brand-logo').count() == 0, label + ': header carries no logo')
                        overflow(page, label)
                        check(page.locator('#contentStatus').count() == 0, label + ': no top timestamp strip')
                        check(page.locator('#appFooter #sourceStatusBtn').count() == 1, label + ': source status entry lives in the footer')
                        if mode == 'weekly':
                            expect(page.locator('.weekly-auto-item')).to_have_count(expected_weekly(page))
                            cards = page.locator('.weekly-group').filter(has=page.locator('.weekly-auto-item')).first.locator('.weekly-auto-item')
                            first, second = [cards.nth(i).bounding_box() for i in [0, 1]]
                            board, deep = page.locator('#weeklyAuto').bounding_box(), page.locator('.weekly-deep-read').bounding_box()
                            if width > 1000:
                                # view=compact now applies to the weekly board: one row per paper.
                                check(abs(first['x'] - second['x']) < 2 and second['y'] > first['y'] and page.locator('.weekly-list').count() > 0, label + ': list view rows')
                                check(deep['x'] >= board['x'] + board['width'] and board['width'] > deep['width'] * 2, label + ': narrow right deep read')
                                check(board['width'] + deep['width'] > width * .9, label + ': weekly board uses available page width')
                            elif width <= 640:
                                check(abs(first['x'] - second['x']) < 2 and second['y'] > first['y'], label + ': stacked mobile rows')
                            check(page.locator('#weeklySection').get_by_text('尚未发布', exact=False).count() == 0, label + ': no unpublished placeholder')
                            if width == 320:
                                page.locator('[data-weekly-pane="reading"]').click()
                                page.locator('.deep-reading-demo-item').click()
                                expect(page.locator('#deepReaderClose')).to_be_in_viewport()
                                overflow(page, label + '/open reading panel')
                                page.locator('#deepReaderClose').click()
                                page.locator('[data-weekly-pane="board"]').click()
                        else:
                            data = page.evaluate('window.SOURCE_HEALTH')
                            count = len(data['sources'])
                            expect(page.locator('.source-item')).to_have_count(count)
                            successful = sum(s.get('status') in ['ok', 'empty_feed', 'filtered_empty'] for s in data['sources'])
                            check(page.locator('.sources-summary strong').all_text_contents() == [str(count), str(successful), str(count-successful)], label + ': real health counts')
                            cached = sum(bool(s.get('cachedItems')) for s in data['sources'])
                            expect(page.locator('.source-cache-note')).to_have_count(cached)
                            check(page.locator('.source-item-foot').count() == count, label + ': per-source check dates retained')
                        records.append({'style': style, 'width': width, 'mode': mode, 'overflow': False})
                        if style == 'a' and width in [1440, 390]:
                            page.screenshot(path=str(out / f'{mode}-{"desktop" if width == 1440 else "mobile"}.png'))
                print(f'Layout checks passed: style {style}', flush=True)

            for style in ['a', 'b', 'c', 'd']:
                for width in [1440, 1024, 768, 390, 320]:
                    label = f'curated/{style}/{width}'
                    page.set_viewport_size({'width': width, 'height': 1000 if width > 640 else 900})
                    page.goto(base + f'?mode=curated&view=cards&style={style}', wait_until='load')
                    expect(page.locator('#streamRail')).to_be_visible()
                    expect(page.locator('#modeNote')).to_be_hidden()
                    check(page.get_by_text('带“摘要核对”标记的是', exact=False).count() == 0, label + ': green-box paragraph removed')
                    check(page.locator('#streamRail #curatedDayBar').count() == 1, label + ': day filters are in the rail')
                    days = page.locator('#curatedDayBar [data-day]')
                    if days.count() > 2:
                        latest = page.locator('#articlesStream .day-heading').all_text_contents()
                        check(len(latest) == 1, label + ': opens on the newest day only')
                        days.nth(1).click()
                        check(page.locator('#articlesStream .day-heading').count() == 1 and 'day=' in page.url, label + ': a day chip shows that day and is linkable')
                        page.locator('#curatedDayBar [data-day="all"]').click()
                        check(page.locator('#articlesStream .day-heading').count() > 1, label + ': 全部 shows every day')
                        page.locator('#curatedDayBar [data-day]').first.click()
                    body, rail = page.locator('.stream-content').bounding_box(), page.locator('#streamRail').bounding_box()
                    if width > 1000:
                        check(rail['x'] >= body['x'] + body['width'] and body['width'] > rail['width'] * 2, label + ': wide reading column and right tools')
                    else:
                        check(body['y'] >= rail['y'] + rail['height'], label + ': tools and text stack')
                    cards = page.locator('#articlesStream .article-card')
                    if cards.count() > 1:
                        a, b = [cards.nth(i).bounding_box() for i in [0, 1]]
                        check(abs(a['x'] - b['x']) < 1 and b['y'] > a['y'], label + ': long abstracts remain one column')
                    topic_menu = page.locator('#qfChipRow [data-qf="topic"]')
                    topic_menu.press('Enter')
                    pop = page.locator('#qfPop')
                    expect(pop).to_be_visible()
                    topic = pop.locator('[data-qf-topic]:not(.is-empty)').first
                    expect(topic).to_be_visible()
                    topic.press('Enter')
                    expect(topic).to_have_attribute('aria-pressed', 'true')
                    pop.locator('[data-qf-close]').click()
                    active_topic = page.locator('[data-qf-clear="tag"]')
                    expect(active_topic).to_be_visible()
                    active_topic.click()
                    expect(active_topic).to_have_count(0)
                    overflow(page, label)
                    if style == 'a' and width in [1440, 390]:
                        page.screenshot(path=str(out / f'curated-{"desktop" if width == 1440 else "mobile"}.png'))
                    page.locator('[data-mode="candidates"]').click()
                    expect(page.locator('#streamRail')).to_be_hidden()
                    expect(page.locator('#qfScopeBtn')).to_be_visible()
                    expect(page.locator('#modeNote')).to_be_hidden()
                    page.locator('[data-mode="curated"]').click()
                    expect(page.locator('#streamRail #curatedDayBar')).to_be_visible()
                    expect(topic_menu).to_have_count(1)
                    records.append({'style': style, 'width': width, 'mode': 'curated', 'overflow': False})
                print(f'Curated reading-column checks passed: style {style}', flush=True)

            check(len(posts) == 0, 'Opening/navigating pages never generates paid content')
            for width in [1440, 320, 375, 390]:
                for mode in ['curated', 'candidates', 'library']:
                    page.set_viewport_size({'width': width, 'height': 900})
                    page.goto(base + f'?mode={mode}&style=a', wait_until='load')
                    overflow(page, f'header/{mode}/{width}')
                    if width < 721:
                        check(page.locator('.header-nav .nav-tab-btn').evaluate_all('nodes=>nodes.length===4 && nodes.every(e=>{const r=e.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth+1})'), f'{mode}/{width}: all four navigation entries fit without clipping')
                    page.locator('#sourceStatusBtn').click()
                    expect(page.locator('#sourcesSection')).to_be_visible()
                    expect(page.locator('#sourceStatusBtn')).to_have_attribute('aria-pressed', 'true')
                    page.locator(f'.nav-tab-btn[data-mode="{mode}"]').click()
                    check(page.locator('.nav-tab-btn.active').get_attribute('data-mode') == mode, f'{mode}/{width}: switching back returns to view')
            print('Header and mode-return checks passed', flush=True)

            open_weekly(page)
            page.locator('.weekly-auto-item .card-side-actions [data-action="toggle-huddle"]').nth(0).click()
            expect(page.locator('.weekly-auto-item .card-side-actions [data-action="toggle-huddle"]').nth(0)).to_have_attribute('aria-pressed', 'true')
            page.locator('.weekly-auto-item .card-side-actions [data-action="toggle-huddle"]').nth(1).click()
            expect(page.locator('#huddleCounter')).to_have_text('2')
            page.locator('#openHuddleBtn').click()
            expect(page.locator('[aria-label="精选证据对照"]')).to_be_visible()
            check(page.locator('[data-action="compare-select"]').count() == 2, 'v13.6 explicit comparison selection preserved')
            page.locator('#closeHuddleModalBtn').click()
            check(len(posts) == 0, 'Morning-list changes only read caches, never generate')
            check(bool(page.evaluate('window.CONTENT_STATUS.radarUpdatedAt')), 'Content timestamps remain in source data')

            open_weekly(page)
            page.wait_for_function("XINZHI_DATA_STATE.pregenerated === 'loaded'")
            paper_id = page.evaluate("""() => [...document.querySelectorAll('.weekly-auto-item')].map(el => el.dataset.paperId)
              .find(id => { const paper = FEEDS.items.find(p => p.id === id);
                const key = paper.pmid ? 'pmid:' + paper.pmid : 'doi:' + paper.doi.toLowerCase();
                return Boolean(window.PREGENERATED[key]?.translation?.abstract_zh); })""")
            check(bool(paper_id), 'Weekly fixture includes a cached bilingual abstract')
            paper = page.evaluate('id => FEEDS.items.find(p => p.id === id)', paper_id)
            original = paper.get('summary') or paper['abstractSections'][0]['text']
            page.locator(f'.weekly-auto-item[data-paper-id="{paper_id}"] .title-open').click()
            chinese = page.locator('[data-abs-panel="zh"]')
            english = page.locator('[data-abs-panel="en"]')
            for width in (1440, 390):
                page.set_viewport_size({'width': width, 'height': 900})
                before_tabs = page.url
                page.locator('[data-abs-tab="en"]').press('Enter')
                expect(english).to_contain_text(original[:60])
                expect(chinese).to_be_hidden()
                expect(page.locator('[data-abs-tab="en"]')).to_have_attribute('aria-selected', 'true')
                page.locator('[data-abs-tab="zh"]').click()
                expect(chinese.locator('p').first).not_to_be_empty()
                expect(english).to_be_hidden()
                check(page.url == before_tabs, 'Switching abstract language preserves the reader URL')
                check(page.locator('.reading-tips').count() == 0, 'Reader omits generic template advice')
                overflow(page, f'bilingual-reader/{width}')
                page.locator('.abstract-reader').scroll_into_view_if_needed()
                page.screenshot(path=str(out / f'reader-{width}.png'))
            page.locator('#drawerCloseBtn').click()

            page.goto(base + '?mode=library&lane=all', wait_until='networkidle')
            read_button = page.locator('#articlesStream .title-open').first
            read_button.click()
            abstract = page.locator('.abstract-reader .structured-abstract')
            expect(abstract).to_contain_text('获取公开摘要失败')
            expect(page.locator('.abs-tabs')).to_have_count(0)
            page.locator('#drawerCloseBtn').click()
            abstract_available = True
            read_button.click()
            expect(abstract).to_contain_text('Offline abstract fixture only')
            expect(page.locator('.abs-tabs')).to_have_count(0)
            check(not posts, 'Reading, retrying public abstracts and switching language never generate model requests')
            check(not errors, 'No browser JavaScript errors')
            browser.close()
    finally:
        server.shutdown()
        result = {'passed_assertions': len(checks), 'layouts': records, 'page_errors': errors, 'mocked_posts': len(posts), 'fixture_notice': 'All API requests mocked; weekly abstract content comes from checked-in fixtures.'}
        (out / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f'{len(checks)} browser assertions passed; {len(records)} layouts; screenshots: {out}')


if __name__ == '__main__':
    main()
