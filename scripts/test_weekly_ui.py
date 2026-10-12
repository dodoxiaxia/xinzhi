#!/usr/bin/env python3
"""Offline weekly-board QA. Expanded picks and AI output are test fixtures only."""
import functools
import os
import json
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
NOTICE = '离线布局测试文字，不是文献翻译或研究分析。'


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    out = ROOT / '.local/weekly-v14-qa'
    out.mkdir(parents=True, exist_ok=True)
    source = (ROOT / 'app.js').read_text()
    bundle = (ROOT / 'public/public.js').read_text()
    assert bundle.count(source) == 1
    controls = {'count': 24, 'ready': True}
    calls, checks = [], []
    fixture = r'''
      (() => {
        const count=COUNT, ready=READY;
        const end = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
        const floor=new Date(end+'T00:00:00Z');floor.setUTCDate(floor.getUTCDate()-6);
        const start=floor.toISOString().slice(0,10);
        window.FEEDS.items.forEach(p=>delete p.weeklyPick);
        const selected=window.FEEDS.items.filter(p=>(p.pmid || p.doi) && (!p.datePrecision || p.datePrecision==='day') && p.date?.slice(0,10)>=start && p.date.slice(0,10)<=end).slice(0,count);
        if(selected.length!==count)throw Error('Not enough real recent public titles for fixture');
        window.__weeklyFixtureIds=selected.map(p=>p.id);
        window.PREGENERATED={};window.QUICKLOOKS={};
        selected.forEach((p,i)=>{
          p.weeklyPick=i+1;p.weeklyCategory=['cardio','general','aimed','aitech'][i%4];
          const key=p.pmid?'pmid:'+p.pmid:'doi:'+p.doi.toLowerCase();
          if(!ready)return;
          const quote=p.summary || p.abstractSections?.map(s=>s.text).join(' ') || 'Public abstract test fixture';
          const row={key,pmid:p.pmid,doi:p.doi,title:p.title,journal:p.journal,status:'available',abstract_source:'离线布局测试'};
          ['question','population','design','comparator','endpoints','results'].forEach(f=>row[f]={text:NOTICE,quote:quote.slice(0,80)});
          window.PREGENERATED[key]={
            translation:{abstract_zh:NOTICE},
            quicklook:{one_line:NOTICE,findings:[{text:NOTICE,quote:quote.slice(0,80)}],limits:NOTICE,why_read:NOTICE,design:'离线测试',abstract:quote},
            study:{schemaVersion:1,scope:'public-abstract',papers:[row],checklist:[NOTICE],generatedAt:new Date().toISOString(),caveat:NOTICE}
          };
        });
        const stale={...selected[0],id:'offline-old-date',weeklyPick:count+1,date:'2025-01-02'};
        const imprecise={...selected[0],id:'offline-month-date',weeklyPick:count+2,date:end,datePrecision:'month'};
        window.FEEDS.items.push(stale,imprecise);
      })();
    '''.replace('NOTICE', json.dumps(NOTICE, ensure_ascii=False))
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'

    def check(value, label):
        assert value, label
        checks.append(label)

    def mock(route):
        path = route.request.url
        if path.endswith('/public.js'):
            data = fixture.replace('COUNT', str(controls['count'])).replace('READY', str(controls['ready']).lower())
            return route.fulfill(content_type='application/javascript', body=bundle.replace(source, data + source))
        if '/api/' in path:
            calls.append({'url': path, 'method': route.request.method})
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': True})
        if not path.startswith(base):
            return route.abort('blockedbyclient')
        return route.continue_()

    def overflow(page, label):
        check(page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), label + ': no overflow')

    def reading_panel(page, touch=False):
        reader, close = page.locator('#deepReader'), page.locator('#deepReaderClose')
        if page.locator('#weeklyPaneSwitch').is_visible():
            page.locator('[data-weekly-pane="reading"]').click()
        demo = page.locator('.deep-reading-demo-item')
        activate = demo.tap if touch else demo.click
        for i in range(3):
            activate()
            expect(reader).to_have_class(re.compile(r'\bopen\b'))
            expect(close).to_be_in_viewport()
            close.click()
            expect(reader).not_to_have_class(re.compile(r'\bopen\b'))
            check(demo.evaluate('(e)=>e===document.activeElement'), f'{touch}/{i}: closing returns focus to the list')
        activate()
        page.keyboard.press('Escape')
        expect(reader).not_to_have_class(re.compile(r'\bopen\b'))
        check('read=' not in page.url, 'closing clears the reading link')
        activate()
        # The example reading is fetched on first open; wait for its section list.
        expect(page.locator('#deepReaderToc button').nth(4)).to_be_attached()
        page.locator('#deepReaderBody').evaluate('(e)=>e.scrollTo(0, e.scrollHeight)')
        expect(close).to_be_in_viewport()
        check(page.locator('#deepReaderToc button').count() >= 5, 'demo reading has a section list')
        if touch:
            page.go_back()
            expect(reader).not_to_have_class(re.compile(r'\bopen\b'))
            check('mode=weekly' in page.url, 'back button closes the panel and stays on the board')
        else:
            close.click()
        expect(reader).not_to_have_class(re.compile(r'\bopen\b'))
        page.locator('#sourceStatusBtn').click()
        page.locator('[data-mode="weekly"]').click()
        check(not reader.evaluate("(e)=>e.classList.contains('open')"), 'panel stays closed after a mode round trip')
        daily = page.locator('.deep-reading-item:not(.deep-reading-demo-item)')
        if daily.count() > 1:
            if page.locator('#weeklyPaneSwitch').is_visible():
                page.locator('[data-weekly-pane="reading"]').click()
            daily.first.click()
            expect(page.locator('#deepReaderPos')).to_have_text(re.compile(r'^1 / '))
            page.locator('#deepReaderNext').click()
            expect(page.locator('#deepReaderPos')).to_have_text(re.compile(r'^2 / '))
            check('read=' in page.url, 'open reading is linkable')
            close.click()
            expect(reader).not_to_have_class(re.compile(r'\bopen\b'))
        if page.locator('#weeklyPaneSwitch').is_visible():
            page.locator('[data-weekly-pane="board"]').click()

    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
            context = browser.new_context()
            context.route('**/*', mock)
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            for count in [20, 24, 30]:
                controls['count'] = count
                for width in [1440, 390, 320]:
                    page.set_viewport_size({'width': width, 'height': 1000 if width > 640 else 900})
                    page.goto(base + '?mode=weekly&style=a', wait_until='networkidle')
                    expect(page.locator('.weekly-auto-item')).to_have_count(count)
                    check(page.locator('.weekly-group-title').count() == 4, f'{count}/{width}: four categories')
                    expect(page.locator('.weekly-total')).to_have_text(f'{count} 篇')
                    ids = page.locator('.weekly-auto-item').evaluate_all('(els)=>els.map(e=>e.dataset.paperId)')
                    selected = page.evaluate('window.__weeklyFixtureIds')
                    check(len(set(ids)) == count and set(ids) == set(selected), f'{count}/{width}: exact selected set, no old-date filler')
                    groups = page.locator('.weekly-group')
                    for i in range(4):
                        expect(groups.nth(i).locator('.weekly-auto-item')).to_have_count((count + 3 - i) // 4)
                    cards = groups.first.locator('.weekly-auto-item')
                    a, b = [cards.nth(i).bounding_box() for i in [0, 1]]
                    board, deep = page.locator('#weeklyAuto').bounding_box(), page.locator('.weekly-deep-read').bounding_box()
                    if width > 1000:
                        check(abs(a['y']-b['y'])<1 and b['x']>a['x'], f'{count}/{width}: two left card columns')
                        check(deep['x']>=board['x']+board['width'], f'{count}/{width}: right deep read')
                    else:
                        check(b['y']>a['y'] and abs(a['x']-b['x'])<1, f'{count}/{width}: mobile stacked cards')
                        check(deep is None, f'{count}/{width}: readings sit behind the 全文精读 tab')
                        page.locator('[data-weekly-pane="reading"]').click()
                        check(page.locator('.weekly-deep-read').is_visible() and not page.locator('#weeklyAuto').is_visible(), f'{count}/{width}: tab shows the reading list')
                        page.locator('[data-weekly-pane="board"]').click()
                    overflow(page, f'{count}/{width}')
                    if count == 24 and width in [1440, 390]:
                        page.screenshot(path=str(out/f'categorized-{width}.png'))
            reading_panel(page)
            page.locator('[data-weekly-pane="reading"]').click()
            page.locator('.deep-reading-demo-item').click()
            page.screenshot(path=str(out/'deep-read-open-mobile.png'))
            page.locator('#deepReaderClose').click()
            page.locator('[data-weekly-pane="board"]').click()
            before = len(calls)
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            expect(page.locator('.abstract-translation')).to_contain_text(NOTICE)
            expect(page.locator('.study-box')).to_contain_text(NOTICE)
            expect(page.locator('.ql-line')).to_contain_text(NOTICE)
            check(len(calls) == before, 'Pre-generated reader needs no API lookup or generation')
            check('正在' not in page.locator('#drawerBody').inner_text(), 'Pre-generated reader has no loading placeholder')
            page.screenshot(path=str(out/'precomputed-reader-mobile-fixture.png'))
            page.locator('#drawerCloseBtn').click()
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            check(len(calls) == before, 'Reopening reader does not request again')
            page.locator('#drawerCloseBtn').click()
            controls['ready'] = False
            page.goto(base+'?mode=weekly', wait_until='networkidle')
            before = len(calls)
            page.locator('.weekly-card-actions [data-action="open-drawer"]').first.click()
            expect(page.locator('.abstract-translation')).to_contain_text('尚未预生成')
            check(page.locator('.study-box, .quicklook').count() == 0, 'Missing analysis has no empty study or AI placeholder panel')
            check(page.locator('.abstract-pending').count() == 1, 'Missing translation keeps a full-width original reading column')
            check(len(calls) == before, 'Missing pre-generated results do not trigger automatic calls')
            check(page.locator('[data-action="ai-translate"], [data-action="ai-study"], [data-action="ai-interpret"]').count() == 0, 'Missing weekly results never silently become model-generation controls')
            page.locator('#drawerCloseBtn').click()
            touch = browser.new_context(has_touch=True, is_mobile=True, viewport={'width':390, 'height':900})
            touch.route('**/*', mock)
            mobile = touch.new_page()
            mobile.goto(base+'?mode=weekly', wait_until='networkidle')
            reading_panel(mobile, touch=True)
            overflow(mobile, 'touch reading panel')
            check(not any(c['method'] == 'POST' for c in calls), 'No model POST in weekly browsing')
            check(not errors, 'No page JavaScript errors')
            browser.close()
    finally:
        server.shutdown()
        (out/'results.json').write_text(json.dumps({'assertions':len(checks), 'api_calls':calls, 'page_errors':errors, 'fixture_notice':NOTICE, 'checks':checks}, ensure_ascii=False, indent=2)+'\n')
    print(f'{len(checks)} weekly UI assertions passed; offline fixtures only.')


if __name__ == '__main__':
    main()
