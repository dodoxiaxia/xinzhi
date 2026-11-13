#!/usr/bin/env python3
"""Offline browser checks for the list action column and the removed machine-content labels.

Covers 每日精选, 近7天榜 (cards and rows), 文献雷达 and 文献库 (detail and list view) and the reader drawer.
External requests are blocked and API calls are mocked."""
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BANNED = ['未经人工核对', '未经医生终审', '未经人工审核', '未经人工医学终审', '以英文原文为准', '机器翻译，', '机器翻译 ·', 'AI 速览 ·', 'AI 全文精读 ·', 'AI 综述前']
BANNED_SELECTORS = ['.content-label:not(#deepReaderLabel)', '.ql-flag', '.ft-badge-none', '.translation-note']


def main():
    from playwright.sync_api import sync_playwright
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

    def no_labels(page, scope, label):
        text = page.locator(scope).first.text_content() or ''
        for phrase in BANNED:
            check(phrase not in text, f'{label}: no「{phrase}」')
        for selector in BANNED_SELECTORS:
            check(page.locator(f'{scope} {selector}').count() == 0, f'{label}: no {selector}')
        check(not page.locator('#aiDigest').is_visible(), f'{label}: AI digest entry hidden')

    def box(locator):
        return locator.bounding_box()

    def same_right_column(page, container, parts, label, width):
        """All named parts live inside one container, stack vertically and share a right edge."""
        boxes = []
        for name, selector in parts:
            item = container.locator(selector).first
            check(item.count() == 1 or container.locator(selector).count() >= 1, f'{label}: {name} is inside the right-hand container')
            b = box(item)
            check(b is not None, f'{label}: {name} is visible')
            boxes.append((name, b))
        rights = [b['x'] + b['width'] for _, b in boxes]
        check(max(rights) - min(rights) <= 3, f'{label}: right edges aligned ({[round(r) for r in rights]})')
        ys = [b['y'] for _, b in boxes]
        check(all(ys[i] < ys[i + 1] for i in range(len(ys) - 1)), f'{label}: stacked top to bottom')
        check(max(rights) <= width + 1, f'{label}: inside the viewport')

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
        for width, height in ((1280, 900), (390, 844)):
            context = browser.new_context(viewport={'width': width, 'height': height})
            context.route('**/*', mock)
            page = context.new_page()
            tag = f'{width}px'

            def open_mode(mode, compact=False):
                page.goto(base + f'?mode={mode}', wait_until='networkidle')
                page.wait_for_timeout(600)
                if mode != 'weekly':
                    page.locator('#viewCompactBtn' if compact else '#viewCardsBtn').click()
                else:
                    page.locator(f'[data-weekly-view="{"compact" if compact else "cards"}"]').click()
                page.wait_for_timeout(300)
                check(page.evaluate('document.documentElement.scrollWidth') <= width + 1, f'{tag} {mode} compact={compact}: no horizontal overflow')

            # --- 每日精选 / 文献雷达 / 文献库：详细视图 ---
            for mode, scope in (('curated', '#articlesStream'), ('candidates', '#articlesStream'), ('library', '#articlesStream')):
                open_mode(mode)
                no_labels(page, scope, f'{tag} {mode} detail')
                cards = page.locator('.article-card')
                check(cards.count() > 0, f'{tag} {mode} detail: has cards')
                found = 0
                for i in range(min(cards.count(), 20)):
                    side = cards.nth(i).locator('.card-side-actions')
                    if side.locator('[data-ft-action="open-form"]').count() and side.locator('.card-star').count() and side.locator('a:has-text("官网原文")').count():
                        same_right_column(page, side, [('获取全文', '[data-ft-action="open-form"]'), ('精选', '.card-star'), ('官网原文', 'a:has-text("官网原文")')], f'{tag} {mode} detail card {i}', width)
                        found += 1
                        break
                if mode == 'candidates':
                    check(found == 1, f'{tag} {mode} detail: a card with all three buttons exists')

            # --- 文献雷达 / 文献库 / 每日精选：列表（紧凑）视图 ---
            for mode in ('candidates', 'library', 'curated'):
                open_mode(mode, compact=True)
                no_labels(page, '#articlesStream', f'{tag} {mode} list view')
                rows = page.locator('.compact-row')
                check(rows.count() > 0, f'{tag} {mode} list view: has rows')
                found = 0
                for i in range(min(rows.count(), 25)):
                    acts = rows.nth(i).locator('.compact-actions')
                    if acts.locator('[data-ft-action="open-form"]').count() and acts.locator('.card-star').count() and acts.locator('a:has-text("官网原文")').count():
                        same_right_column(page, acts, [('获取全文', '[data-ft-action="open-form"]'), ('精选', '.card-star'), ('官网原文', 'a:has-text("官网原文")')], f'{tag} {mode} list row {i}', width)
                        main_box = box(rows.nth(i).locator('.compact-main'))
                        acts_box = box(acts)
                        check(acts_box['x'] >= main_box['x'] + main_box['width'] - 2, f'{tag} {mode} list row {i}: actions sit to the right of the title block')
                        found += 1
                        break
                if mode == 'candidates':
                    check(found == 1, f'{tag} {mode} list view: a row with all three buttons exists')

            # --- 近 7 天榜：卡片和行 ---
            open_mode('weekly')
            no_labels(page, '#weeklySection', f'{tag} weekly cards')
            page.wait_for_timeout(200)
            no_labels(page, '#dailyDeepRead', f'{tag} weekly deep reading column')
            cards = page.locator('.weekly-auto-item')
            check(cards.count() > 0, f'{tag} weekly: has cards')
            actions = cards.first.locator('.weekly-card-actions')
            check(actions.count() == 1, f'{tag} weekly card: has one action container')
            same_right_column(page, actions, [('阅读摘要', '[data-action="open-drawer"]'), ('精选', '[data-action="toggle-huddle"]')], f'{tag} weekly card', width)
            body_box, acts_box = box(cards.first.locator('.weekly-card-body')), box(actions)
            check(acts_box['x'] >= body_box['x'] + body_box['width'] - 2, f'{tag} weekly card: actions sit to the right of the text')
            open_mode('weekly', compact=True)
            no_labels(page, '#weeklySection', f'{tag} weekly rows')
            row_actions = page.locator('.weekly-row').first.locator('.weekly-row-actions')
            check(row_actions.count() == 1 and row_actions.locator('[data-action="toggle-huddle"]').count() == 1, f'{tag} weekly row: 精选 is in the right-hand container')
            r_box, m_box = box(row_actions), box(page.locator('.weekly-row').first.locator('.weekly-row-main'))
            check(r_box['x'] >= m_box['x'] + m_box['width'] - 2, f'{tag} weekly row: container sits to the right of the text')

            # --- 阅读器 ---
            open_mode('candidates')
            page.locator('.article-card .title-open').first.click()
            page.wait_for_timeout(800)
            text = page.locator('#readerDrawer').text_content() or ''
            for phrase in BANNED:
                check(phrase not in text, f'{tag} reader: no「{phrase}」')
            for selector in BANNED_SELECTORS:
                check(page.locator('#readerDrawer ' + selector).count() == 0, f'{tag} reader: no {selector}')
            titles = page.locator('.drawer-section-title').all_inner_texts()
            check(not any(t.strip().startswith('AI 速览') for t in titles), f'{tag} reader: no section titled「AI 速览」')
            context.close()
        browser.close()
    print(f'list actions column / label removal: {len(checks)} checks passed')


if __name__ == '__main__':
    main()
