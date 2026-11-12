#!/usr/bin/env python3
"""Phone layout of the library: no sideways scrolling, every filter visible, 44px targets (offline, API mocked)."""
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    from playwright.sync_api import expect, sync_playwright
    root = Path(__file__).resolve().parents[1]
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(root / 'public')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks = []
    def check(value, label):
        assert value, label
        checks.append(label)
    def mock(route):
        if '/api/' in route.request.url:
            return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': False})
        if not route.request.url.startswith(base):
            return route.abort('blockedbyclient')
        return route.continue_()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
            for width in [360, 390, 1280]:
                phone = width < 721
                context = browser.new_context(viewport={'width': width, 'height': 844})
                context.route('**/*', mock)
                page = context.new_page()
                page.goto(base + '?mode=library', wait_until='networkidle')
                label = f'{width}'
                check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), label + ': no horizontal scroll')
                ft = page.locator('#ftBar select[data-ft-select]')
                check(ft.locator('option').count() == 6, label + ': six full-text filters (all, readable, verifying, queued, failed, not requested)')
                row = [page.locator(sel).bounding_box() for sel in ['#searchToggleBtn', '#laneBar .lane-select', '#ftBar select', '#filterToggleBtn']]
                check(all(b and b['x'] >= -1 and b['x'] + b['width'] <= width + 1 for b in row), label + ': filter row stays inside the screen')
                check(max(b['y'] for b in row) - min(b['y'] for b in row) < 8, label + ': search, filters and 筛选 share one row')
                check(page.locator('#toolRow >> text=更多').count() == 0, label + ': no 更多 in the filter row')
                nav = page.locator('.header-nav').bounding_box()
                check(page.locator('header.app-header').bounding_box()['height'] <= nav['height'] + 4, label + ': header holds only the four sections')
                check(page.locator('.brand-logo, .header-actions, header .search-wrapper').count() == 0, label + ': no logo, search or actions in the header')
                check(page.locator('#appFooter #sourceStatusBtn').count() == 1 and page.locator('#appFooter #themeToggle').count() == 1 and page.locator('#appFooter #openHuddleBtn').count() == 1, label + ': footer holds shortlist, theme and source status')
                check(page.locator('#searchPanel').is_hidden(), label + ': search starts closed')
                page.locator('#searchToggleBtn').click()
                search_box, row_box = page.locator('#searchPanel').bounding_box(), page.locator('#toolRow').bounding_box()
                check(search_box['y'] + search_box['height'] <= row_box['y'] + 1, label + ': search opens above the filter row')
                page.locator('#searchToggleBtn').click()
                check(page.locator('#listTotal').is_visible(), label + ': total sits in the list head')
                cards = page.locator('.article-card')
                check(cards.count() >= 3 and all((cards.nth(i).bounding_box()['y'] + cards.nth(i).bounding_box()['height']) <= 844 for i in range(3)) if phone else True, label + ': three full cards fit the first screen')
                check(page.locator('.article-card .btn-primary').count() <= cards.count(), label + ': at most one solid button per card')
                check(page.evaluate("[...document.querySelectorAll('.article-card')].every(c=>c.querySelectorAll('.btn-primary').length<=1)"), label + ': each card has one solid button at most')
                check(not any(ch.isdigit() for ch in page.locator('#laneBar .lane-select').inner_text() + ft.inner_text()), label + ': dropdown names carry no counts')
                check(page.evaluate("[...document.querySelectorAll('#laneBar .lane-select, #ftBar select')].every(s=>{const c=document.createElement('canvas').getContext('2d');const cs=getComputedStyle(s);c.font=cs.fontSize+' '+cs.fontFamily;const w=c.measureText(s.options[s.selectedIndex].text).width;return w+parseFloat(cs.paddingLeft)+parseFloat(cs.paddingRight)<=s.clientWidth})"), label + ': selected dropdown text is not truncated')
                lane = page.locator('#laneBar .lane-select')
                lane.select_option('all')
                check('lane=all' in page.url, label + ': lane select updates the URL state')
                ft.select_option('none')
                check('ft=none' in page.url, label + ': 未申请 filter is reachable')
                check(page.locator('#activeFiltersBar .filter-badge-active').count() == 0, label + ': chips list only what the filter row cannot show (lane and full-text are on the row)')
                check(''.join(page.locator('#filterToggleBtn').inner_text().split()) == '筛选·2', label + ': 筛选 · N counts the two non-default conditions')
                page.locator('#filterToggleBtn').click()
                sheet = page.locator('#appSidebar')
                check(sheet.is_visible() and sheet.get_attribute('role') == 'dialog', label + ': filter panel opens as a dialog')
                box = sheet.bounding_box()
                check((box['y'] + box['height'] >= 843 and box['x'] <= 1 and box['width'] >= width - 2) if phone else (box['x'] + box['width'] >= width - 1 and box['x'] > width / 2), label + (': bottom sheet on phone' if phone else ': right-hand drawer on desktop'))
                head = page.locator('#appSidebar .sheet-head')
                check(head.locator('#panelResetBtn').inner_text() == '重置' and head.locator('b').inner_text() == '筛选' and head.locator('#sheetClose').is_visible(), label + ': head has 重置, title and close')
                check(page.locator('#panelBody > .panel-group > h3').all_inner_texts() == ['领域', '全文状态', '发表时间', '期刊', '文章类型'], label + ': five groups in the agreed order')
                check(page.locator('#panelBody .panel-opt').count() >= 15 and page.evaluate("[...document.querySelectorAll('#panelBody .panel-opt')].every(b => b.tagName === 'BUTTON' && b.hasAttribute('aria-pressed') && b.getBoundingClientRect().height >= 43.5)"), label + ': options are buttons with aria-pressed and 44px targets')
                check(page.locator('#panelBody select').count() == 0 and page.locator('#appSidebar #sortSelector, #appSidebar #viewCompactBtn, #appSidebar #minorNote, #appFooter #sortSelector').count() == 0, label + ': no dropdowns, sort or notes in the panel')
                check(page.locator('#appSidebar .filter-count, #appSidebar .sidebar-reset-btn, #appSidebar .filter-item-btn').count() == 0, label + ': panel chips show no numbers and no per-group reset (only the head 重置)')
                check(page.locator('#pgFt .panel-sub').inner_text() == '可读内容' and page.locator('#pgJournal .panel-sub').all_inner_texts() == ['我的期刊', '信源分组', '出版方'], label + ': 可读内容 and the 期刊 sub-groups are labelled')
                order = page.evaluate("[...document.querySelectorAll('#panelBody > .panel-group, #panelBody > .panel-more')].map(e => e.id || e.className)")
                check(order == ['pgLane', 'pgFt', 'pgRange', 'pgJournal', 'pgType', 'panel-more'], label + ': 文章类型 comes after 期刊 and before the folded 更多条件')
                check(not page.locator('.panel-more').evaluate('e => e.open') and page.evaluate("[...document.querySelectorAll('.panel-more .panel-sub')].map(e => e.textContent)") == ['研究设计', '主题标签'], label + ': 研究设计 and 主题标签 sit in the folded 更多条件')
                check(page.evaluate("document.querySelector('#panelBody').scrollWidth <= document.querySelector('#panelBody').clientWidth + 1"), label + ': panel options wrap, no horizontal scroll')
                check(page.evaluate("[...document.querySelectorAll('.nav-tab-btn .badge')].every(b => getComputedStyle(b).display === 'none')"), label + ': no grey counts after the four section names')
                check(page.locator('[data-panel="lane"][data-value="all"]').get_attribute('aria-pressed') == 'true' and page.locator('[data-panel="ft"][data-value="none"]').get_attribute('aria-pressed') == 'true', label + ': panel shares state with the filter-row dropdowns')
                check(page.locator('[data-panel="type"][data-value="orig"]').get_attribute('aria-pressed') == 'true', label + ': hidden 更正和来信 is the default-selected type')
                page.locator('[data-panel="range"][data-value="365"]').click()
                shown = int(page.locator('#listTotal').inner_text().split()[1])
                check(page.locator('#panelApplyBtn').inner_text() == (f'查看 {shown} 篇' if shown else '无结果，清除条件') and page.locator('#appSidebar.open').count() == 1, label + ': picking applies at once, button shows N and panel stays open')
                check(page.locator('#activeFiltersBar .filter-badge-active').count() == 1 and ''.join(page.locator('#filterToggleBtn').inner_text().split()) == '筛选·3', label + ': new condition adds a chip and counts')
                page.keyboard.press('Escape')
                check(page.locator('#appSidebar.open').count() == 0, label + ': Esc closes the panel')
                page.locator('#filterToggleBtn').click()
                page.mouse.click(5, 5)
                check(page.locator('#appSidebar.open').count() == 0, label + ': scrim click closes the panel')
                page.locator('#filterToggleBtn').click()
                page.locator('#panelResetBtn').click()
                check(page.locator('#activeFiltersBar .filter-badge-active').count() == 0 and ''.join(page.locator('#filterToggleBtn').inner_text().split()) == '筛选', label + ': reset returns to defaults with no chips')
                page.locator('[data-panel="type"][data-value="minor"]').click()
                page.evaluate("(() => { const i = document.querySelector('#globalSearch'); i.value = 'zzzqqqxx'; i.dispatchEvent(new Event('input', { bubbles: true })); })()")
                page.wait_for_timeout(700)
                check(page.locator('#panelApplyBtn').inner_text() == '无结果，清除条件', label + ': N=0 turns the button into 无结果，清除条件')
                page.locator('#panelResetBtn').click()
                check(page.evaluate("document.querySelector('#globalSearch').value") == 'zzzqqqxx' and page.locator('[data-panel="type"][data-value="orig"]').get_attribute('aria-pressed') == 'true', label + ': 重置 clears conditions but keeps the search keyword')
                page.evaluate("(() => { const i = document.querySelector('#globalSearch'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()")
                page.wait_for_timeout(700)
                check(page.locator('#panelApplyBtn').inner_text().startswith('查看 '), label + ': button is 查看 N 篇 again once results exist')
                page.locator('#panelApplyBtn').click()
                check(page.locator('#appSidebar.open').count() == 0, label + ': 查看 N 篇 closes the panel')
                if width >= 380:
                    lh = page.evaluate("(() => { const r = s => document.querySelector(s).getBoundingClientRect(); const t = r('#listTotal'), so = r('#sortSelector'), v = r('#viewCompactBtn'); return [t.y, so.y, v.y, v.x + v.width, innerWidth]; })()")
                    check(max(lh[:3]) - min(lh[:3]) < 14 and lh[3] <= lh[4] + 1, label + ': total, sort and view share one row inside the screen')
                else:
                    check(page.locator('#appFooter #viewCompactBtn').count() == 1 and page.locator('.list-head #viewCompactBtn').count() == 0, label + ': too narrow for the view toggle in the list head: only sort stays, view moves to the footer')
                ft.select_option('')
                if phone:
                    page.locator('[data-action="open-drawer"]').first.click()
                    foot = page.locator('#readerDrawer .drawer-footer').bounding_box()
                    check(foot['height'] <= 130, label + f': drawer footer stays compact ({foot["height"]:.0f}px)')
                    check(page.evaluate("parseFloat(getComputedStyle(document.querySelector('#drawerBody')).paddingBottom) >= 24"), label + ': drawer body keeps bottom spacing')
                    check(page.evaluate("(() => { const d = document.querySelector('#drawerBody'); const f = document.querySelector('.drawer-footer').getBoundingClientRect().height; return parseFloat(getComputedStyle(d).paddingBottom) >= f - 1; })()"), label + ': drawer body bottom padding covers the fixed footer height')
                context.close()
            browser.close()
        print('mobile library checks passed:', len(checks))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
