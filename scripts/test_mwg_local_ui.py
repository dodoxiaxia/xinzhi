#!/usr/bin/env python3
"""Offline regression for local journal filtering and reading navigation fixes.

Uses synthetic public bibliographic fixtures, never runtime state or model APIs.
XINZHI_TEST_ASSET_ROOT can point at an earlier source checkout for reproduction.
"""
import json
import os
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
ASSETS = Path(os.environ.get('XINZHI_TEST_ASSET_ROOT', ROOT))
ORIGIN = 'https://local-regression.invalid'


def main():
    from playwright.sync_api import sync_playwright, expect
    paper = dict(id='fixture', title='Offline journal fixture', date='2026-11-15',
                 datePrecision='day', journal='Circulation', cleanJournal='Circulation',
                 publisher='AHA', clinicalTier='心血管', tags=[], studyDesign='RCT',
                 summary='Synthetic public abstract.', url=ORIGIN + '/paper')
    payloads = {
        '/data/library.js': 'window.LIBRARY=' + json.dumps({'papers': [paper]}),
        '/data/candidates.js': 'window.FEEDS=' + json.dumps({'items': [paper]}),
        '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[]}',
        '/data/curated.js': 'window.CURATED=[]',
        '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}',
    }
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])

        class Regression(unittest.TestCase):
            def setUp(self):
                self.context = browser.new_context(viewport={'width': 1280, 'height': 900})
                self.page = self.context.new_page()
                self.page.set_default_timeout(4000)
                self.errors = []
                self.page.on('pageerror', lambda error: self.errors.append(str(error)))
                self.context.route('**/*', self.route)

            def route(self, route):
                url = route.request.url
                if not url.startswith(ORIGIN + '/'):
                    return route.abort()
                path = url[len(ORIGIN):].split('?')[0]
                if path.startswith('/api/'):
                    self.assertEqual(route.request.method, 'GET')
                    return route.fulfill(json={'ok': True, 'found': False, 'canGenerate': False})
                if path in payloads:
                    return route.fulfill(body=payloads[path], content_type='application/javascript')
                file = ASSETS / ('index.html' if path == '/' else path.lstrip('/'))
                if not file.is_file():
                    file = ROOT / path.lstrip('/')
                if file.is_file():
                    return route.fulfill(path=str(file))
                return route.fulfill(status=404, body='offline fixture: absent')

            def tearDown(self):
                self.context.close()

            def load(self, query=''):
                self.page.goto(ORIGIN + '/?mode=library&lane=all' + query)
                expect(self.page.locator('[data-qf="more"]')).to_be_visible()

            def test_dark_search(self):
                self.load('&theme=dark')
                self.page.locator('[data-qf-jtier-menu]').first.click()
                colors = self.page.locator('#qfJournalSearch').evaluate('''el => {
                  const s=getComputedStyle(el), p=getComputedStyle(el,'::placeholder');
                  const probe=document.createElement('span'); el.parentNode.append(probe);
                  probe.style.color='var(--text-muted)';
                  const muted=getComputedStyle(probe).color; probe.remove();
                  return {text:s.color,bg:s.backgroundColor,placeholder:p.color,muted};
                }''')
                print('computed dark journal search:', colors)
                self.assertNotEqual(colors['bg'], 'rgb(255, 255, 255)')
                self.assertNotEqual(colors['bg'], colors['text'])
                self.assertEqual(colors['placeholder'], colors['muted'])
                self.assertFalse(self.errors, self.errors)

            def test_keyboard(self):
                for width in (1280, 390, 320):
                    with self.subTest(width=width):
                        self.page.set_viewport_size({'width': width, 'height': 900})
                        self.load()
                        trigger = self.page.locator('[data-qf="more"]')
                        pop = self.page.locator('#qfPop')
                        backdrop = self.page.locator('#qfBackdrop')
                        trigger.click()
                        expect(pop).to_be_visible()
                        trigger.click()
                        expect(pop).to_be_hidden()
                        expect(backdrop).to_be_hidden()
                        expect(trigger).to_be_focused()
                        trigger.focus()
                        trigger.press('Enter')
                        expect(pop).to_have_attribute('aria-modal', 'false')
                        expect(pop.locator('[data-qf-close]')).to_be_focused()
                        # First boundary leaves in reverse, without a wrapping trap.
                        self.page.keyboard.press('Shift+Tab')
                        expect(pop).to_be_hidden()
                        self.assertFalse(self.page.evaluate("document.activeElement.closest('#qfPop') !== null"))
                        trigger.focus()
                        trigger.press('Space')
                        expect(pop.locator('[data-qf-close]')).to_be_focused()
                        self.page.keyboard.press('Escape')
                        expect(trigger).to_be_focused()
                        trigger.press('Enter')
                        pop.locator('[data-qf-close]').click()
                        expect(trigger).to_be_focused()
                        # Forward boundary must also let readers continue out.
                        trigger.press('Enter')
                        pop.locator('button, input').last.focus()
                        self.page.keyboard.press('Tab')
                        expect(pop).to_be_hidden()
                        self.assertFalse(self.page.evaluate("document.activeElement.closest('#qfPop') !== null"))
                        journal = self.page.locator('[data-qf-jtier-menu]').first
                        journal.focus()
                        journal.press('Enter')
                        expect(self.page.locator('#qfJournalSearch')).to_be_focused()
                        self.page.locator('#qfJournalSearch').fill('Circulation')
                        expect(self.page.locator('#qfJournalSearch')).to_be_focused()
                        follow = pop.locator('[data-qf-follow]').first
                        if follow.count():
                            follow.focus()
                            follow.press('Enter')
                            expect(pop.locator('[data-qf-follow]').first).to_be_focused()
                        # Changing a selection rebuilds panel and trigger DOM.
                        option = pop.locator('[data-qf-jtier-all]')
                        option.focus()
                        option.press('Enter')
                        expect(pop.locator('[data-qf-jtier-all]')).to_be_focused()
                        self.page.keyboard.press('Escape')
                        expect(self.page.locator('[data-qf-jtier-menu]').first).to_be_focused()
                        # Clicking outside (non-control) dismisses without pulling focus back to the trigger.
                        trigger.click()
                        expect(pop).to_be_visible()
                        outside = self.page.evaluate('''() => {
                          const pop = document.querySelector('#qfPop');
                          const pr = pop.getBoundingClientRect();
                          const vw = window.innerWidth, vh = window.innerHeight;
                          const inView = (x, y) => x >= 1 && x <= vw - 1 && y >= 1 && y <= vh - 1;
                          const inPop = (x, y) => x >= pr.left && x <= pr.right && y >= pr.top && y <= pr.bottom;
                          const tryPoint = (label, x, y) => {
                            if (!inView(x, y) || inPop(x, y)) return null;
                            const hit = document.elementFromPoint(x, y);
                            if (!hit || pop.contains(hit)) return null;
                            if (hit.closest('#quickBar')) return null;
                            if (hit.closest('button, a, input, select, textarea, summary, [tabindex]')) return null;
                            return { label, x, y };
                          };
                          const candidates = [];
                          const addBox = (label, sel) => {
                            const el = document.querySelector(sel);
                            if (!el) return;
                            const r = el.getBoundingClientRect();
                            if (r.width <= 0 || r.height <= 0) return;
                            candidates.push([label + ':center', r.left + r.width / 2, r.top + r.height / 2]);
                            candidates.push([label + ':right', r.right - 8, r.top + Math.min(r.height / 2, 12)]);
                            candidates.push([label + ':left', r.left + 4, r.top + Math.min(r.height / 2, 12)]);
                          };
                          addBox('listTotal', '#listTotal');
                          addBox('qfSummary', '#qfSummary');
                          addBox('toolBar', '#toolBar');
                          addBox('header', '.header-container');
                          for (const [label, x, y] of candidates) {
                            const found = tryPoint(label, x, y);
                            if (found) return found;
                          }
                          return null;
                        }''')
                        self.assertIsNotNone(outside, f'expected an exposed non-control outside point at width={width}')
                        self.page.mouse.click(outside['x'], outside['y'])
                        expect(pop).to_be_hidden()
                        expect(backdrop).to_be_hidden()
                        expect(trigger).not_to_be_focused()
                        # Clicking a separate exposed control must retain its focus and apply its effect.
                        trigger.click()
                        expect(pop).to_be_visible()
                        control_sel = self.page.evaluate('''() => {
                          const pop = document.querySelector('#qfPop');
                          const pr = pop.getBoundingClientRect();
                          const vw = window.innerWidth, vh = window.innerHeight;
                          const visibleAndExposed = sel => {
                            const el = document.querySelector(sel);
                            if (!el || el.hidden || el.disabled) return false;
                            const r = el.getBoundingClientRect();
                            if (r.width <= 0 || r.height <= 0) return false;
                            if (r.right > pr.left && r.left < pr.right && r.bottom > pr.top && r.top < pr.bottom) return false;
                            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                            if (cx < 1 || cx > vw - 1 || cy < 1 || cy > vh - 1) return false;
                            const hit = document.elementFromPoint(cx, cy);
                            return !!(hit && !pop.contains(hit) && (hit === el || el.contains(hit)));
                          };
                          for (const sel of ['#viewCompactBtn', '.nav-tab-btn[data-mode="candidates"]']) {
                            if (visibleAndExposed(sel)) return sel;
                          }
                          return null;
                        }''')
                        self.assertIsNotNone(control_sel, f'expected an exposed separate control at width={width}')
                        control = self.page.locator(control_sel)
                        control.click()
                        expect(pop).to_be_hidden()
                        expect(backdrop).to_be_hidden()
                        expect(control).to_be_focused()
                        expect(control).to_have_class(re.compile(r'\bactive\b'))
                        if control_sel == '#viewCompactBtn':
                            expect(self.page.locator('#articlesStream')).to_have_class(re.compile(r'\barticles-compact-list\b'))
                        else:
                            expect(self.page).to_have_url(re.compile(r'mode=candidates'))
                        self.assertFalse(self.errors, self.errors)

            def test_url_compatibility(self):
                cases = [
                    ('100%25', ['100%']), ('bad%ZZ', ['bad%ZZ']),
                    ('%E0%A4%A', ['�%A']),
                    ('Nature%2520Medicine,Circulation', ['Nature Medicine', 'Circulation']),
                    ('%20Circulation%20,Circulation,,Nature%20Medicine', ['Circulation', 'Nature Medicine']),
                ]
                for encoded, expected in cases:
                    with self.subTest(encoded=encoded):
                        self.load('&journals=' + encoded)
                        self.assertFalse(self.errors, self.errors)
                        labels = self.page.locator('[data-qf-clear="journal"]').all_text_contents()
                        self.assertEqual([s.strip().removesuffix(' ×') for s in labels], expected)
                        self.page.reload()
                        self.assertFalse(self.errors, self.errors)
                self.load('&journal=Legacy&journals=Circulation,Legacy')
                self.assertEqual(self.page.locator('[data-qf-clear="journal"]').count(), 2)
                self.page.evaluate("history.pushState({}, '', '?mode=library&lane=all&journals=100%25'); dispatchEvent(new PopStateEvent('popstate'))")
                expect(self.page.locator('[data-qf-clear="journal"]')).to_contain_text('100%')
                self.assertFalse(self.errors, self.errors)

            def test_toc_motion(self):
                self.load()
                # Exercise the delegated event with a synthetic reading section.
                self.page.evaluate('''() => {
                  document.querySelector('#deepReaderBody').innerHTML = '<button data-toc-target="fixture-section">Section</button><h2 id="fixture-section">Fixture section</h2>';
                  document.querySelector('#deepReaderBody').scrollTo = options => window.__scrollOptions=options;
                }''')
                for motion, expected in [('reduce', 'instant'), ('no-preference', 'smooth')]:
                    self.page.emulate_media(reduced_motion=motion)
                    self.page.locator('[data-toc-target]').dispatch_event('click')
                    self.assertEqual(self.page.evaluate('window.__scrollOptions.behavior'), expected)
                self.assertFalse(self.errors, self.errors)

        suite = unittest.defaultTestLoader.loadTestsFromTestCase(Regression)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        browser.close()
        return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
