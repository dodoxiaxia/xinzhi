"""Isolated CSS regressions using production renderers, with no state or network.

Run: python3 scripts/test_weekly_layout_ui.py
XINZHI_LAYOUT_CSS can select a saved baseline stylesheet for reproduction.
"""
import json
import os
from pathlib import Path
import re
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def renderer(path, name):
    source = (ROOT / path).read_text()
    match = re.search(r'  function ' + name + r'\([^\n]*\) \{.*?\n  }', source, re.S)
    if not match:
        raise AssertionError(f'Production renderer missing: {name}')
    return match.group(0)


def main():
    class WeeklyLayoutTest(unittest.TestCase):
        @classmethod
        def setUpClass(cls):
            cls.pw = sync_playwright().start()
            cls.browser = cls.pw.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                headless=True, args=['--no-sandbox'])
            cls.css = Path(os.environ.get('XINZHI_LAYOUT_CSS', ROOT / 'style.css')).read_text()
            cls.renderers = '\n'.join(renderer(path, name) for path, names in [
                ('src/app/09-weekly.js', ['weeklyRow', 'weeklyCard', 'dailyReadingItem']),
                ('src/app/05-list.js', ['renderArticleCard', 'renderCompactRow']),
                ('src/app/01-state-helpers.js', ['cardSideActionsHtml'])
            ] for name in names)
            cls.metrics = []

        @classmethod
        def tearDownClass(cls):
            cls.browser.close()
            cls.pw.stop()
            if os.environ.get('XINZHI_LAYOUT_RESULTS'):
                Path(os.environ['XINZHI_LAYOUT_RESULTS']).write_text(
                    json.dumps(cls.metrics, ensure_ascii=False, indent=2) + '\n')

        def fixture(self, page, mode, view, theme):
            page.route('**/*', lambda route: route.abort())
            page.set_content(f'<html data-style="a" data-theme="{theme}"><head></head><body></body></html>')
            page.add_style_tag(content=self.css)
            page.evaluate('''(renderers) => {
              const esc = s => String(s || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
              const state = {huddle: [], search: ''};
              // renderArticleCard 只用 foldSearch 做检索高亮；折叠规则由 test_search_fold.cjs 覆盖，这里只测布局。
              const foldSearch = v => String(v == null ? '' : v).toLowerCase();
              const quicklookOf = () => null, publicationStatusHtml = () => '',
                designBadgeHtml = () => '', journalMetricBadge = () => '',
                doiStatusBlock = () => '', getPublisherClass = () => 'pub-other',
                cardJournalName = p => p.journal, dateLabel = () => '2026-01-02',
                cardTakeaway = () => '离线布局测试：用于核对标题与操作区的相对位置。',
                officialArticleUrl = () => '#source', huddleStarSvg = () => '☆',
                pdfDownloadLink = () => '<span class="ft-status ft-compact"><button class="btn-sm" type="button">获取全文</button></span>';
              let activeDeepReadingId = '';
              window.renderFixture = (mode, view) => {
                const p = {id:'offline-layout', weeklyPick:1, title:'Deterministic layout fixture for cardiovascular research and clinical outcomes',
                  titleZh:'蛋白质组学与缺血性卒中风险：前瞻性研究的临床结果及其意义', journal:'Clinical Research Journal', date:'2026-01-02'};
                eval(renderers + `\nwindow.fixtureRow = mode === 'weekly' ? (view === 'compact' ? weeklyRow(p, p.date, '') : weeklyCard(p, p.date, '')) : (view === 'compact' ? renderCompactRow(p) : renderArticleCard(p));
                  window.fixtureReading = dailyReadingItem({...p,pmcid:'offline-reading',topic:'离线布局测试',titleZh:'用于布局核验的全文精读标题'});`);
                const board = view === 'compact' ? '<ul class="weekly-list">'+window.fixtureRow+'</ul>' : window.fixtureRow;
                document.body.innerHTML = mode === 'weekly' ?
                  '<div class="app-container full-width-layout weekly-layout"><main class="main-content"><section class="weekly-container" data-pane="board"><div class="weekly-board-pane"><div id="weeklyAuto">'+board+'</div></div><aside class="weekly-deep-read"><h3 class="next-title">全文精读</h3><div id="dailyDeepRead"><h4 class="deep-reading-batch">最新批次</h4><div class="deep-reading-list">'+window.fixtureReading.repeat(8)+'</div><details class="deep-reading-history" open><summary>往期精读</summary><div class="deep-reading-list">'+window.fixtureReading+'</div></details></div></aside></section></main></div>' :
                  '<div class="app-container"><main class="main-content"><div class="'+(view === 'compact' ? 'articles-compact-list' : 'articles-stream')+'">'+window.fixtureRow+'</div></main></div>';
                window.activated = [];
                document.addEventListener('click', e => {const c=e.target.closest('button,a'); if(c) window.activated.push(c.textContent);});
              };
            }''', self.renderers)
            page.evaluate('([mode,view]) => renderFixture(mode,view)', [mode, view])

        def test_geometry(self):
            for width in (1440, 1280, 884, 390):
                for theme in ('light', 'dark'):
                    for mode in ('weekly', 'candidates', 'library'):
                        for view in ('compact', 'detailed'):
                            with self.subTest(width=width, theme=theme, mode=mode, view=view):
                                page = self.browser.new_page(viewport={'width': width, 'height': 900}, device_scale_factor=1)
                                try:
                                    self.fixture(page, mode, view, theme)
                                    m = page.evaluate('''() => {
                                      const rect = e => {const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
                                      const title=document.querySelector('.title-open'), actions=document.querySelector('.card-side-actions');
                                      const row=actions.closest('article,li,.compact-row');
                                      return {title:rect(title),main:rect(title.closest('.weekly-row-main,.weekly-card-body,.card-main,.compact-main')),actions:rect(actions),row:rect(row),
                                        titleRects:(()=>{const range=document.createRange();range.selectNodeContents(title);return [...range.getClientRects()].map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom}));})(),
                                        controls:[...actions.querySelectorAll('button,a')].map(e=>({...rect(e),fits:e.scrollWidth<=e.clientWidth+1})),
                                        pageWidth:document.documentElement.scrollWidth};
                                    }''')
                                    self.metrics.append(dict(width=width,theme=theme,mode=mode,view=view,geometry=m))
                                    self.assertLessEqual(m['pageWidth'], width)
                                    for text in m['titleRects']:
                                        self.assertGreaterEqual(text['left'], m['main']['x']-1)
                                        self.assertLessEqual(text['right'], m['main']['right']+1)
                                        self.assertGreaterEqual(text['top'], m['main']['y']-1)
                                        self.assertLessEqual(text['bottom'], m['main']['bottom']+1)
                                    self.assertGreater(m['main']['width'], m['row']['width'] * .45)
                                    if mode == 'weekly' and view == 'detailed':
                                        self.assertAlmostEqual(m['main']['right'], m['row']['right'], delta=1)
                                        self.assertGreaterEqual(m['actions']['y'], m['main']['bottom'])
                                    elif width > 600:
                                        self.assertLessEqual(m['main']['right'], m['actions']['x']+1)
                                    elif width <= 600 and view == 'compact':
                                        self.assertGreaterEqual(m['actions']['y'], m['main']['bottom'])
                                    for c in m['controls']:
                                        self.assertTrue(c['fits'])
                                        self.assertGreater(c['height'], 23)
                                        self.assertGreaterEqual(c['x'], m['row']['x']-1)
                                        self.assertLessEqual(c['right'], m['row']['right']+1)
                                    # Native focus, Tab order and Enter/Space activation survive CSS changes.
                                    title = page.locator('.title-open')
                                    title.focus()
                                    page.keyboard.press('Enter')
                                    page.keyboard.press('Tab')
                                    self.assertTrue(page.locator('.card-star').evaluate('(e)=>e===document.activeElement'))
                                    page.keyboard.press('Space')
                                    page.keyboard.press('Tab')
                                    self.assertTrue(page.locator('.card-source').evaluate('(e)=>e===document.activeElement'))
                                    page.keyboard.press('Tab')
                                    self.assertTrue(page.locator('.ft-status button').evaluate('(e)=>e===document.activeElement'))
                                    page.keyboard.press('Enter')
                                    self.assertEqual(len(page.evaluate('activated')), 3)
                                    if mode == 'weekly':
                                        # Narrow layouts expose this same index through the existing reading pane.
                                        if width <= 1000:
                                            page.locator('.weekly-container').evaluate("e=>e.dataset.pane='reading'")
                                        rail = page.locator('.weekly-deep-read')
                                        r = rail.evaluate('''e => {
                                          const b=e.getBoundingClientRect();
                                          return {client:e.clientWidth,scroll:e.scrollWidth,left:b.left+e.clientLeft,right:b.left+e.clientLeft+e.clientWidth,
                                            overflow:getComputedStyle(e).overflowX,items:[...e.querySelectorAll('.deep-reading-item, .deep-reading-item > *')].map(c=>{const r=c.getBoundingClientRect(); return {left:r.left,right:r.right};})};
                                        }''')
                                        self.metrics[-1]['rail'] = r
                                        self.assertEqual(r['scroll'], r['client'])
                                        self.assertNotIn(r['overflow'], ('hidden', 'clip'))
                                        for item in r['items']:
                                            self.assertGreaterEqual(item['left'], r['left']-1)
                                            self.assertLessEqual(item['right'], r['right']+1)
                                        reading = page.locator('.deep-reading-item').first
                                        reading.focus()
                                        self.assertTrue(reading.evaluate('(e)=>e===document.activeElement'))
                                        before = len(page.evaluate('activated'))
                                        page.keyboard.press('Enter')
                                        self.assertEqual(len(page.evaluate('activated')), before+1)
                                finally:
                                    page.close()

    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(WeeklyLayoutTest))
    raise SystemExit(not result.wasSuccessful())


if __name__ == '__main__':
    main()
