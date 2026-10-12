#!/usr/bin/env python3
"""Offline browser QA for the public layout; every API/model response is mocked.

Run after scripts/build_public.py. Requires Python Playwright and Chromium.
Screenshots/results go to ignored .local/layout-qa; no production writes.
"""
import argparse
import functools
import base64
import hashlib
import json
import shutil
import threading
import xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ZH = '离线界面测试译文：此文字仅验证中英布局，不是这篇文献的翻译。'


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', default=shutil.which('chromium'))
    parser.add_argument('--output', default=str(ROOT / '.local/layout-qa'))
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    if not (ROOT / 'public/public.js').is_file():
        parser.error('Build public first: python3 scripts/build_public.py')
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks, errors, posts, records = [], [], [], []
    controls = {'lookup': 'absent', 'post': 'success', 'abstract': 'empty'}

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
        query = parse_qs(url.query)
        task = query.get('task', [''])[0]
        if url.path.startswith('/api/'):
            if request.method == 'POST':
                payload = request.post_data_json
                posts.append(payload)
                if controls['post'] == 'abort':
                    return route.abort('failed')
                if controls['post'] == 'bad_json':
                    return route.fulfill(content_type='application/json', body='{broken')
                if controls['post'] == 'provider_error':
                    return route.fulfill(json={'ok': False, 'error': 'model_failed', 'detail': 'fetch_connection'})
                if controls['post'] == 'empty':
                    return route.fulfill(json={'ok': True, 'tr': {'abstract_zh': '', 'title_zh': ''}})
                return route.fulfill(json={'ok': True, 'tr': {'abstract_zh': FIXTURE_ZH, 'title_zh': ''}})
            if task == 'translate':
                if controls['lookup'] == 'abort':
                    return route.abort('failed')
                if controls['lookup'] == 'cached':
                    return route.fulfill(json={'ok': True, 'found': True, 'tr': {'abstract_zh': FIXTURE_ZH, 'title_zh': ''}})
                return route.fulfill(json={'ok': True, 'found': False})
            if url.path == '/api/ql':
                return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': controls['lookup'] not in ['off', 'cached']})
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': True})
        if url.hostname == 'www.ebi.ac.uk':
            if controls['abstract'] == 'abort':
                return route.abort('failed')
            rows = [{'abstractText': 'Offline abstract fixture only, used to verify interrupted reading recovery.', 'pmid': '1001'}] if controls['abstract'] == 'success' else []
            return route.fulfill(json={'resultList': {'result': rows}})
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

    def open_weekly(page, width=1440, legacy_reader=False):
        page.set_viewport_size({'width': width, 'height': 1000 if width > 640 else 900})
        page.goto(base + '?mode=weekly&style=a', wait_until='load')
        expect(page.locator('.weekly-auto-item')).to_have_count(expected_weekly(page))
        if legacy_reader:
            page.evaluate('''() => {
              const ids=[...document.querySelectorAll('.weekly-auto-item')].slice(0,2).map(e=>e.dataset.paperId);
              window.FEEDS.items.filter(p=>ids.includes(p.id)).forEach(p=>{p._testWeeklyPick=p.weeklyPick;delete p.weeklyPick;});
              window.PREGENERATED={}; // Exercise on-demand requests separately from actual embedded caches.
            }''')

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**({'executable_path': args.browser} if args.browser else {}), args=['--no-sandbox'])
            context = browser.new_context()
            context.route('**/*', mock)
            context.add_init_script('''(() => {
              const nativeFetch = window.fetch;
              window.fetch = (url, options) => {
                const result = nativeFetch(url, options);
                if (options?.method === 'POST' && JSON.parse(options.body || '{}').task === 'translate' && window.__translationDelay)
                  return result.then(r => new Promise(resolve => setTimeout(() => resolve(r), window.__translationDelay)));
                return result;
              };
            })()''')
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            for style in ['a', 'b', 'c', 'd']:
                for width in [1440, 1024, 768, 390, 320]:
                    page.set_viewport_size({'width': width, 'height': 1000 if width > 640 else 900})
                    for mode in ['weekly', 'sources']:
                        label = f'{style}/{width}/{mode}'
                        page.goto(base + f'?mode={mode}&view=compact&style={style}', wait_until='load')
                        expect(page.locator('#weeklySection' if mode == 'weekly' else '#sourcesSection')).to_be_visible()
                        logo = page.locator('#brandLogo .brand-image')
                        expect(logo).to_be_visible()
                        check(logo.evaluate('(i) => i.complete && i.naturalWidth > 0'), label + ': logo loaded')
                        size = logo.bounding_box()
                        check(abs(size['width'] - size['height']) < 1 and size['width'] == 44, label + ': square logo ratio retained')
                        check(page.locator('#brandLogo .brand-text, #brandLogo .logo-title').count() == 0, label + ': adjacent brand text removed')
                        expect(page.locator('#brandLogo')).to_have_attribute('aria-label', '心知 AIHOT-Med 首页')
                        overflow(page, label)
                        check(page.locator('#contentStatus').count() == 0, label + ': no top timestamp strip')
                        huddle, source = page.locator('#openHuddleBtn').bounding_box(), page.locator('#sourceStatusBtn').bounding_box()
                        check(source['x'] >= huddle['x'] + huddle['width'] - 1, label + ': source entry right of huddle')
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
                    check(page.locator('#streamRail #homeIntro').count() == 1 and page.locator('#streamRail #laneBar').count() == 1, label + ': both red-box blocks moved together')
                    body, rail = page.locator('.stream-content').bounding_box(), page.locator('#streamRail').bounding_box()
                    if width > 1000:
                        check(rail['x'] >= body['x'] + body['width'] and body['width'] > rail['width'] * 2, label + ': wide reading column and right tools')
                    else:
                        check(body['y'] >= rail['y'] + rail['height'], label + ': tools and text stack')
                    cards = page.locator('#articlesStream .article-card')
                    if cards.count() > 1:
                        a, b = [cards.nth(i).bounding_box() for i in [0, 1]]
                        check(abs(a['x'] - b['x']) < 1 and b['y'] > a['y'], label + ': long abstracts remain one column')
                    topic = page.locator('#laneBar [data-filter-tag]').first
                    if topic.count():
                        topic.focus()
                        topic.press('Enter')
                        expect(page.locator('#laneBar [data-filter-tag].active')).to_be_visible()
                        expect(page.locator('[data-clear="tag"]')).to_be_visible()
                        page.locator('[data-clear="tag"]').click()
                    overflow(page, label)
                    if style == 'a' and width in [1440, 390]:
                        page.screenshot(path=str(out / f'curated-{"desktop" if width == 1440 else "mobile"}.png'))
                    page.locator('[data-mode="candidates"]').click()
                    expect(page.locator('#streamRail')).to_be_hidden()
                    check(page.locator('#streamLaneSlot #laneBar').count() == 1, label + ': radar classification restored to main area')
                    expect(page.locator('#modeNote')).to_be_visible()
                    page.locator('[data-mode="curated"]').click()
                    expect(page.locator('#streamRail #laneBar')).to_be_visible()
                    check(page.locator('#laneBar').count() == 1, label + ': return without duplicate filters')
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
                        check(page.locator('#openHuddleBtn').bounding_box()['width'] < 90, f'{mode}/{width}: selected list does not consume a full header row')
                    page.locator('#sourceStatusBtn').click()
                    expect(page.locator('#sourcesSection')).to_be_visible()
                    expect(page.locator('#sourceStatusBtn')).to_have_attribute('aria-pressed', 'true')
                    page.locator(f'.nav-tab-btn[data-mode="{mode}"]').click()
                    check(page.locator('.nav-tab-btn.active').get_attribute('data-mode') == mode, f'{mode}/{width}: switching back returns to view')
            print('Header and mode-return checks passed', flush=True)

            open_weekly(page)
            page.locator('.weekly-card-actions [data-action="toggle-huddle"]').nth(0).click()
            expect(page.locator('.weekly-card-actions [data-action="toggle-huddle"]').nth(0)).to_have_text('已入精选 ✓')
            page.locator('.weekly-card-actions [data-action="toggle-huddle"]').nth(1).click()
            expect(page.locator('#huddleCounter')).to_have_text('2')
            page.locator('#openHuddleBtn').click()
            expect(page.locator('[aria-label="精选证据对照"]')).to_be_visible()
            check(page.locator('[data-action="compare-select"]').count() == 2, 'v13.6 explicit comparison selection preserved')
            page.locator('#closeHuddleModalBtn').click()
            check(len(posts) == 0, 'Morning-list changes only read caches, never generate')
            check(bool(page.evaluate('window.CONTENT_STATUS.radarUpdatedAt')), 'Content timestamps remain in source data')

            open_weekly(page, legacy_reader=True)
            paper_id = page.locator('.weekly-card-actions [data-action="open-drawer"]').first.get_attribute('data-paper-id')
            original = page.evaluate('(id) => { const p = window.FEEDS.items.find(p => p.id === id); return p.abstractSections?.map(s => s.text).join(" ") || p.summary; }', paper_id)
            read_button = page.locator('.weekly-card-actions [data-action="open-drawer"]').first
            read_button.click()
            expect(page.locator('[data-action="ai-translate"]')).to_be_visible()
            expect(page.locator('.abstract-translation-status')).to_have_text('译文未生成')
            check(original[:60] in page.locator('.abstract-original').inner_text(), 'English original remains readable')
            check(page.locator('.reading-tips').count() == 0 and '阅读这类研究要看什么' not in page.locator('#drawerBody').inner_text(), 'Generic template advice removed while real abstract remains readable')
            check(page.locator('[aria-label="研究结构与全文核对"]').count() == 1, 'v13.6 study feature preserved')
            page.evaluate('window.__translationDelay = 500')
            page.evaluate('''id => { const b = document.createElement('button'); b.dataset.action='ai-translate'; b.dataset.paperId=id; document.body.append(b); b.click(); b.click(); b.remove(); }''', paper_id)
            expect(page.locator('.abstract-translation')).to_contain_text('正在翻译摘要')
            expect(page.locator('.abstract-translation')).to_contain_text(FIXTURE_ZH)
            expect(page.locator('.abstract-translation-status')).to_have_text('中英对照')
            check(len(posts) == 1, 'Rapid repeated clicks produce one translation request')
            check(set(posts[0]) == {'task', 'pmid', 'doi'}, 'Translation API still sends identifiers only')
            en, zh = page.locator('.abstract-original').bounding_box(), page.locator('.abstract-translation').bounding_box()
            check(zh['x'] >= en['x'] + en['width'], 'Desktop English and Chinese use two columns')
            check('未经人工核对' in page.locator('.abstract-translation').inner_text(), 'Translation disclaimer retained')
            page.locator('.abstract-reader').scroll_into_view_if_needed()
            page.screenshot(path=str(out / 'reader-desktop-fixture.png'))
            page.set_viewport_size({'width': 390, 'height': 900})
            en, zh = page.locator('.abstract-original').bounding_box(), page.locator('.abstract-translation').bounding_box()
            check(zh['y'] > en['y'], 'Mobile translation stacks below English')
            before_jump_posts = len(posts)
            page.locator('[data-action="abstract-jump"][data-column="translation"]').click()
            check(page.locator('.abstract-translation .abstract-column-title').evaluate('(e)=>e===document.activeElement'), 'Mobile Chinese jump moves keyboard focus to reading position')
            page.locator('[data-action="abstract-jump"][data-column="original"]').click()
            check(page.locator('.abstract-original .abstract-column-title').evaluate('(e)=>e===document.activeElement'), 'Mobile English jump returns to original without changing URL')
            check(len(posts) == before_jump_posts, 'Reading navigation never generates another translation')
            overflow(page, 'translated-reader/mobile')
            check(page.locator('.reading-tips').count() == 0, 'Mobile reader also removes generic template advice')
            page.locator('.abstract-reader').scroll_into_view_if_needed()
            page.screenshot(path=str(out / 'reader-mobile-fixture.png'))
            page.locator('#drawerCloseBtn').click()
            read_button.click()
            expect(page.locator('.abstract-translation')).to_contain_text(FIXTURE_ZH)
            check(len(posts) == 1, 'Reopening completed reader does not generate again')

            for outcome in ['abort', 'provider_error', 'bad_json', 'empty']:
                controls['post'] = outcome
                open_weekly(page, legacy_reader=True)
                page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
                page.locator('[data-action="ai-translate"]').click()
                expect(page.locator('[data-action="ai-translate"]')).to_have_text('重试翻译')
                check(FIXTURE_ZH not in page.locator('.abstract-translation').inner_text(), outcome + ': no invented translation')
                check(original[:60] in page.locator('.abstract-original').inner_text(), outcome + ': original retained after failure')
                if outcome == 'abort':
                    expect(page.locator('.translation-error')).to_contain_text('网络中断')
                    page.screenshot(path=str(out / 'reader-interrupted.png'))
                controls['post'] = 'success'
                page.locator('[data-action="ai-translate"]').click()
                expect(page.locator('.abstract-translation')).to_contain_text(FIXTURE_ZH)

            controls['lookup'] = 'abort'
            open_weekly(page, legacy_reader=True)
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            expect(page.locator('[data-action="tr-check"]')).to_be_visible()
            controls['lookup'] = 'absent'
            page.locator('[data-action="tr-check"]').click()
            expect(page.locator('[data-action="ai-translate"]')).to_be_visible()
            check(True, 'Interrupted cache lookup can be retried')

            controls['lookup'] = 'cached'
            before = len(posts)
            open_weekly(page, legacy_reader=True)
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            expect(page.locator('.abstract-translation')).to_contain_text(FIXTURE_ZH)
            check(page.locator('[data-action="ai-translate"]').count() == 0 and len(posts) == before, 'Saved translation readable when generation is disabled')
            controls['lookup'] = 'off'
            open_weekly(page, legacy_reader=True)
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            expect(page.locator('.abstract-translation')).to_contain_text('翻译服务暂不可用')
            check(page.locator('[data-action="ai-translate"]').count() == 0, 'Unavailable translation shows a concise state')

            controls['lookup'] = 'absent'
            open_weekly(page, legacy_reader=True)
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            expect(page.locator('[data-action="ai-translate"]')).to_be_visible()
            page.evaluate('window.__translationDelay = 1200')
            page.locator('[data-action="ai-translate"]').click()
            expect(page.locator('.abstract-translation')).to_contain_text('正在翻译摘要')
            page.locator('#drawerCloseBtn').click()
            second_read = page.locator('.weekly-card-actions [data-action="open-drawer"]').nth(1)
            second_id = second_read.get_attribute('data-paper-id')
            second_title = page.evaluate('(id) => window.FEEDS.items.find(p => p.id === id).title', second_id)
            second_read.click()
            expect(page.locator('.drawer-title-en')).to_have_text(second_title)
            page.wait_for_timeout(1400)
            expect(page.locator('.drawer-title-en')).to_have_text(second_title)
            check(FIXTURE_ZH not in page.locator('.abstract-translation').inner_text(), 'Late translation never takes over another paper')
            page.locator('#drawerCloseBtn').click()
            page.evaluate('''() => window.FEEDS.items.filter(p=>p._testWeeklyPick).forEach(p=>p.weeklyPick=p._testWeeklyPick)''')
            page.locator('#sourceStatusBtn').click()
            page.locator('[data-mode="weekly"]').click()
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            expect(page.locator('.abstract-translation')).to_contain_text(FIXTURE_ZH)
            check(True, 'Returning to the original paper retains completed translation')

            open_weekly(page, legacy_reader=True)
            controls['abstract'] = 'abort'
            page.evaluate('''id => { const p = window.FEEDS.items.find(p => p.id === id); p.summary=''; p.abstractSections=[]; }''', paper_id)
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            expect(page.locator('.abstract-original')).to_contain_text('获取公开摘要失败')
            check(page.locator('.abstract-translation').count() == 0, 'Failed abstract fetch never presents an invented bilingual body')
            page.locator('#drawerCloseBtn').click()
            controls['abstract'] = 'success'
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            expect(page.locator('.abstract-original')).to_contain_text('Offline abstract fixture only')
            check(True, 'Closing and reopening retries an interrupted public abstract fetch')
            check(not errors, 'No browser JavaScript errors')
            browser.close()
    finally:
        server.shutdown()
        result = {'passed_assertions': len(checks), 'layouts': records, 'page_errors': errors, 'mocked_translation_posts': len(posts), 'fixture_notice': 'All API requests mocked; translation screenshots contain explicit offline test text, not a real paper translation.'}
        (out / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f'{len(checks)} browser assertions passed; {len(records)} layouts; screenshots: {out}')


if __name__ == '__main__':
    main()
