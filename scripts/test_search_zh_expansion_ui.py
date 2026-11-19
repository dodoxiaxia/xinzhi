#!/usr/bin/env python3
"""Verify search expansion with the same offline public bundle in Chromium and Node."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
from pathlib import Path
import subprocess
from threading import Thread
from urllib.parse import urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[1]
AF_NOTE = '已按 AF → atrial fibrillation 检索'
ZH_NOTE = '已按 房颤 → atrial fibrillation / AF；消融 → ablation 检索'
NO_MATCH = 'AF xinzhi-search-no-match-4bfg4'
ENGLISH = 'electrophysiology'
VIEWPORTS = ((390, 844), (1280, 800))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def check_viewport(browser, origin, width, height, counts, evidence):
    from playwright.sync_api import expect

    context = browser.new_context(
        viewport={'width': width, 'height': height},
        is_mobile=width == 390, has_touch=width == 390,
        service_workers='block', locale='zh-CN', timezone_id='Asia/Shanghai',
    )
    writes, errors = [], []

    def respond(route):
        request = route.request
        url = urlsplit(request.url)
        if request.method not in ('GET', 'HEAD'):
            writes.append(request.url)
            return route.abort()
        if f'{url.scheme}://{url.netloc}' != origin:
            return route.abort()
        if url.path.startswith('/api/'):
            return route.fulfill(json={'ok': True, 'papers': [], 'items': [], 'more': False})
        return route.continue_()

    context.route('**/*', respond)
    page = context.new_page()
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    results = {}
    try:
        note = page.locator('[data-search-expansion]')
        scope = page.locator('#activeFiltersBar .search-scope')
        total = page.locator('#listTotal')
        search = page.locator('#globalSearch')
        for mode, expected in counts.items():
            page.goto(f'{origin}/?mode={mode}&lane=all&range=all&minor=1&day=all')
            page.locator('#searchToggleBtn').click()
            expect(search).to_be_visible()
            expect(total).to_have_text(re.compile(r'^共 \d+ 篇$'))
            expect(note).to_have_count(0)
            mode_results = {}
            for query, message in (('房颤消融', ZH_NOTE), ('AF', AF_NOTE), (NO_MATCH, AF_NOTE), (ENGLISH, '')):
                search.fill(query)
                expect(total).to_have_text(f'共 {expected[query]} 篇')
                expect(scope).to_have_count(1)
                if message:
                    expect(note).to_have_count(1)
                    expect(note).to_have_text(message)
                    expect(note).to_be_visible()
                else:
                    expect(note).to_have_count(0)
                if query == NO_MATCH:
                    assert expected[query] == 0
                    expect(page.locator('#articlesStream .empty-state h3')).to_have_text('没有找到匹配的文献')
                elif message:
                    assert expected[query] > 0, (mode, query, expected)
                if evidence and mode == 'library' and query in ('房颤消融', NO_MATCH):
                    name = 'expanded' if query == '房颤消融' else 'empty'
                    page.screenshot(path=evidence / f'{width}-{name}.png', animations='disabled')
                mode_results[query] = int(total.inner_text().split()[1])
            results[mode] = mode_results

        for mode, label in (('candidates', '清除筛选'), ('library', '清空左侧筛选')):
            params = urlencode({'mode': mode, 'lane': 'all', 'range': 'all', 'pub': 'AHA (Circulation)', 'q': NO_MATCH})
            page.goto(f'{origin}/?{params}')
            clear = page.locator('#articlesStream .empty-state [data-clear="sidebar"]')
            expect(clear).to_have_text(label)
            expect(clear).to_be_visible()
            expect(total).to_have_text('共 0 篇')
            expect(note).to_have_text(AF_NOTE)
            if evidence and mode == 'candidates':
                page.screenshot(path=evidence / f'{width}-radar-clear.png', animations='disabled')
            clear.click()
            expect(clear).to_have_count(0)
            expect(search).to_have_value(NO_MATCH)
            results[f'{mode}_clear'] = label
        assert not errors, errors
        assert not writes, writes
        return results
    finally:
        context.close()


def main():
    from playwright.sync_api import sync_playwright

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public', type=Path, default=ROOT / 'public')
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    if args.evidence:
        args.evidence.mkdir(parents=True, exist_ok=True)
    counts = json.loads(subprocess.check_output(
        ['node', 'scripts/test_search_zh_expansion.cjs', '--ui-counts', str(args.public.resolve())],
        cwd=ROOT, text=True,
    ))
    handler = functools.partial(QuietHandler, directory=str(args.public.resolve()))
    with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
        Thread(target=server.serve_forever, daemon=True).start()
        origin = f'http://127.0.0.1:{server.server_port}'
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium',
                    args=['--no-sandbox'],
                )
                try:
                    for width, height in VIEWPORTS:
                        results = check_viewport(browser, origin, width, height, counts, args.evidence)
                        print(json.dumps({'viewport': f'{width}x{height}', 'passed': True, **results}, ensure_ascii=False))
                finally:
                    browser.close()
        finally:
            server.shutdown()


if __name__ == '__main__':
    main()
