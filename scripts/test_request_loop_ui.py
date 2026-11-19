#!/usr/bin/env python3
"""Offline request-loop browser assertions and optional screenshot evidence."""

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
from urllib.parse import parse_qs, quote, urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
KEY = 'xz_browser_requests_v1'
FIXTURE = json.loads((ROOT / 'scripts/fixtures/request-loop-cases.json').read_text(encoding='utf-8'))
CASES = {case['paper']['doi'].lower(): case for case in FIXTURE['cases'] if 'browser' in case}
PREFIX = '10.9999/request-loop-'


def record(doi, case, **overrides):
    return {
        'doi': doi, 'title': case['paper']['title'], 'status': case['browser']['status'],
        'requestedAt': '2026-10-21T04:00:00Z', 'paperId': case['paper']['id'],
        **overrides,
    }


class Offline:
    def __init__(self, browser, base, width, seeds, *, defer_library=False):
        self.base = base
        self.context = browser.new_context(viewport={'width': width, 'height': 900},
                                           is_mobile=width == 390, has_touch=width == 390)
        self.page = self.context.new_page()
        self.context.add_init_script(f"""
          if (!sessionStorage.xzTestInitialized) {{
            localStorage.setItem({json.dumps(KEY)}, {json.dumps(json.dumps(seeds))});
            sessionStorage.xzTestInitialized = '1';
          }}
        """)
        self.context.route('**/*', self.route)
        self.requests = []
        self.writes = []
        self.acquired = False
        self.defer_library = defer_library
        self.library_route = None

    def route(self, route):
        req = route.request
        url = urlsplit(req.url)
        if not req.url.startswith(self.base):
            return route.fulfill(status=404)
        if url.path.startswith('/api/'):
            if req.method != 'GET':
                self.writes.append((req.method, url.path))
                return route.fulfill(status=405, json={'ok': False})
            if url.path != '/api/library':
                return route.fulfill(status=404, json={'ok': False})
            doi = parse_qs(url.query).get('doi', [''])[0]
            if not doi:
                return route.fulfill(json={'ok': True, 'papers': [], 'jobs': [], 'cursor': ''})
            self.requests.append(doi)
            case = CASES.get(doi)
            if case is None:
                return route.fulfill(json={'ok': True, 'found': False})
            data = case['browser']
            if data.get('error'):
                return route.fulfill(status=503, json={'ok': False})
            job = data.get('job')
            if data.get('initial') and not self.acquired:
                job = data['initial']
            paper = {**case['paper'], 'doi': doi}
            if job and job['stage'] == 'verifying':
                paper['fulltextStatus'] = 'pending'
            if job:
                job = {'id': '00000000-0000-4000-8000-000000000001', 'doi': doi, **job}
            found = data.get('found', True)
            return route.fulfill(json={'ok': True, 'found': found, 'paper': paper if found else None, 'job': job})
        if '/assets/data-library.' in url.path:
            if self.defer_library:
                self.library_route = route
                return
            return self.fulfill_library(route)
        return route.continue_()

    def fulfill_library(self, route):
        payload = {'papers': FIXTURE['snapshot'], 'pdfIds': FIXTURE['pdfIds']}
        return route.fulfill(content_type='application/javascript', body=f'window.XINZHI_PART("library", {json.dumps(payload)});')

    def go(self, query=''):
        self.page.goto(self.base + '?mode=library&lane=all' + query, wait_until='domcontentloaded')

    def modal(self):
        self.page.locator('#openRequestsBtn').click()
        expect(self.page.locator('#requestsModalBackdrop')).to_be_visible()

    def row(self, name):
        return self.page.locator(f'[data-req-doi="{PREFIX}{name}"]')

    def saved(self):
        return self.page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)

    def close(self):
        assert not self.writes, self.writes
        self.context.close()


def check_rows(browser, base, width, evidence):
    seeds = [record(doi, case) for doi, case in CASES.items()]
    error = next(row for row in seeds if row['doi'] == PREFIX + 'network-error')
    error['unexpected'] = 'legacy field'
    for variant in (PREFIX + 'aliases', f'https://dx.doi.org/{PREFIX}aliases'):
        seeds.append(record(variant, CASES[PREFIX + 'aliases']))
    ui = Offline(browser, base, width, seeds, defer_library=True)
    page = ui.page
    ui.go()
    ui.modal()
    initial = ui.row('ingested')
    expect(initial.locator('.req-status-badge')).to_have_text('核验中')
    expect(page.locator('#refreshRequestsBtn')).to_be_enabled()
    if evidence:
        initial.evaluate("(node) => node.scrollIntoView({block: 'center'})")
        page.screenshot(path=evidence / f'{width}-01-verifying.png')
    ui.acquired = True
    initial.locator('[data-action="refresh-request-doi"]').click()
    expect(initial.locator('.req-status-badge')).to_have_text('已取得全文，待归类入库')
    assert ui.library_route is not None, 'Deferred library shard was not requested'
    if evidence:
        page.screenshot(path=evidence / f'{width}-02-acquired.png')
    ui.fulfill_library(ui.library_route)
    expect(initial.locator('.req-status-badge')).to_have_text('已入库')
    for label in ('期刊档：心血管综合与其他', '出版方：AHA (Circulation)',
                  '研究设计：随机试验（题录标记）', '主题标签：#房颤/电生理'):
        expect(initial.locator('.req-classification')).to_contain_text(label)
    expect(page.locator('#refreshRequestsBtn')).to_be_enabled()
    page.locator('#refreshRequestsBtn').click()
    expect(ui.row('rejected').locator('.req-status-badge')).to_have_text('人工核验未通过，可重新提交')
    expect(page.locator('#refreshRequestsBtn')).to_be_enabled()
    saved = {row['doi']: row for row in ui.saved()}
    for doi, case in CASES.items():
        data = case['browser']
        row = page.locator(f'[data-req-doi="{doi}"]')
        expect(row.locator('.req-status-badge')).to_have_text(data['label'])
        if data.get('hint'):
            expect(row.locator('.req-possible-duplicate')).to_contain_text(data['hint'])
            assert saved[doi]['paperId'] == case['paper']['id'], 'Other DOI must keep its own ID'
        if data.get('stage'):
            assert saved[doi]['libraryState'] == data['stage'], saved[doi]
            if data['stage'] != 'identity_conflict':
                assert saved[doi]['paperId'] == case['match']
            else:
                assert saved[doi]['paperId'] == case['paper']['id']
        assert saved[doi]['requestedAt'] == error['requestedAt']
    assert saved[PREFIX + 'network-error']['status'] == 'queued'
    assert saved[PREFIX + 'network-error']['lastCheckedAt'] == ''
    assert 'unexpected' not in saved[PREFIX + 'network-error']
    assert 'reason' not in saved[PREFIX + 'unknown']
    expect(ui.row('aliases')).to_have_count(1)
    expect(ui.row('aliases').locator('.req-classification')).to_contain_text('主题标签：未分类')
    expect(ui.row('aliases').locator('a[data-ft-download]')).to_have_attribute(
        'href', '/api/fulltext?doi=' + quote(PREFIX + 'aliases', safe=''))
    expect(ui.row('unclassified').locator('.req-classification')).to_have_count(0)

    modal = page.locator('#requestsModalBackdrop.open')
    box = modal.locator('.modal-dialog').bounding_box()
    assert box and box['x'] >= 0 and box['width'] + box['x'] <= width + 1
    assert modal.locator('#requestsModalBody').evaluate('(node) => node.scrollWidth <= node.clientWidth + 1')
    if evidence:
        for name in ('ingested', 'existing', 'pending', 'verifying', 'hold', 'failed', 'conflict', 'rejected'):
            ui.row(name).evaluate("(node) => node.scrollIntoView({block: 'center'})")
            page.screenshot(path=evidence / f'{width}-03-{name}.png')
    initial.locator('[data-action="open-request-paper"]').click()
    expect(page.locator('#readerDrawer.open')).to_be_visible()
    expect(page.locator('#drawerBody')).to_have_attribute('data-paper-id', 'static-request-ingested')
    ui.close()
    print(f'PASS {width}px: all states, late snapshot, static ID and reader, duplicates, legacy storage, API failure, modal bounds')


def check_cards(browser, base, width, evidence):
    ui = Offline(browser, base, width, [])
    page = ui.page
    ui.go('&q=' + quote(PREFIX + 'existing'))
    stream = page.locator('#articlesStream')
    expect(stream.locator('.ft-badge-ready')).to_have_text('库里已有')
    expect(stream.locator('form[data-ft-form]')).to_have_count(0)
    expect(stream.locator('[data-ft-action="open-form"]')).to_have_count(0)
    expect(stream.locator('a[data-ft-download]')).to_have_attribute('href', '/api/pdf?id=static-request-existing')
    if evidence:
        page.screenshot(path=evidence / f'{width}-04-existing-pdf-card.png')
    ui.go('&q=' + quote('Fictional catalogue record'))
    badge = stream.locator('.ft-badge-ready')
    expect(badge).to_have_text('可下载')
    expect(badge).to_have_attribute('title', '全文已核验，可以下载。下一步：点「下载 PDF」获取已核验的全文')
    if evidence:
        page.screenshot(path=evidence / f'{width}-05-normal-library-pdf-card.png')
    ui.go('&q=' + quote(PREFIX + 'no-pdf'))
    expect(stream.get_by_role('button', name='获取全文')).to_be_visible()
    expect(stream.locator('form[data-ft-form]')).to_have_count(1)
    expect(stream.locator('a[data-ft-download]')).to_have_count(0)
    stale = stream.locator('form[data-ft-form]').evaluate('(form) => form.outerHTML')
    ui.go('&q=' + quote(PREFIX + 'existing'))
    expect(stream.locator('.ft-badge-ready')).to_have_text('库里已有')
    stream.locator('.ft-status').evaluate("""(status, html) => {
      status.insertAdjacentHTML('beforeend', html);
      const form = status.querySelector('form[data-ft-form]');
      form.dataset.doi = status.dataset.ftDoi;
      form.hidden = false;
      form.elements.passphrase.value = 'synthetic-test-value';
      form.requestSubmit();
    }""", stale)
    expect(stream.locator('form[data-ft-form] .ft-error')).to_have_text('库里已有，可直接下载')
    expect(stream.locator('form[data-ft-form] input')).to_have_value('')
    ui.go('&q=' + quote(PREFIX + 'unclassified'))
    expect(stream.locator('.ft-badge-ready')).to_have_text('已取得全文，待归类入库')
    ui.close()
    print(f'PASS {width}px: DOI-only existing badge, normal PDF card, stale submit guard, no-PDF and unclassified cards')


def check_startup_and_quota(browser, base):
    existing = record(PREFIX + 'existing', CASES[PREFIX + 'existing'], status='available', libraryState='already_in_library')
    available = record(PREFIX + 'later', CASES[PREFIX + 'later'])
    recovered = record(PREFIX + 'recovered', CASES[PREFIX + 'recovered'])
    recent = [{**available, 'doi': PREFIX + f'cap-{idx}'} for idx in range(12)]
    ui = Offline(browser, base, 1280, [existing, available, recovered, *recent])
    ui.go()
    ui.page.wait_for_function("""(key) => JSON.parse(localStorage.getItem(key)).some(
      r => r.doi.endsWith('cap-7') && r.lastCheckedAt)""", arg=KEY)
    assert ui.requests == [available['doi'], recovered['doi'], *(row['doi'] for row in recent[:8])], ui.requests
    saved = next(row for row in ui.saved() if row['doi'] == recovered['doi'])
    assert (saved['status'], saved['libraryState'], saved['paperId']) == (
        'available', 'ingested', 'static-request-recovered'), saved
    ui.go('&q=' + quote(recovered['doi']))
    stream = ui.page.locator('#articlesStream')
    download = '/api/fulltext?doi=' + quote(recovered['doi'], safe='')
    expect(stream.get_by_text('Fictional rhythm-control cohort', exact=True)).to_be_visible()
    expect(stream.locator('.ft-badge-ready')).to_have_text('可下载')
    expect(stream.locator('a[data-ft-download]')).to_have_attribute('href', download)
    expect(stream.get_by_text('Fictional rhythm control cohort', exact=True)).to_have_count(0)
    ui.modal()
    expect(ui.row('recovered').locator('.req-status-badge')).to_have_text('已入库')
    expect(ui.row('recovered').locator('a[data-ft-download]')).to_have_attribute('href', download)
    ui.close()
    print('PASS startup: serial cap of 10 includes manual_needed recovery and uncatalogued available')
    print('PASS shared title match: inner hyphen resolves to the same static list card and request download')

    bulky = [record(PREFIX + f'quota-{idx}', CASES[PREFIX + 'failed'], status='failed',
                    title='甲' * 300, journal='乙' * 120, note='丙' * 160) for idx in range(200)]
    ui = Offline(browser, base, 1280, bulky)
    ui.go()
    ui.modal()
    ui.row('quota-0').locator('[data-action="refresh-request-doi"]').click()
    ui.page.wait_for_function("(key) => localStorage.getItem(key).length <= 60000", arg=KEY)
    saved = ui.saved()
    assert 1 < len(saved) < len(bulky)
    assert [r['doi'] for r in saved] == [r['doi'] for r in bulky[:len(saved)]]
    ui.close()
    print('PASS storage cap: above-budget records are trimmed from the tail')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    evidence = args.evidence.resolve() if args.evidence else None
    if evidence:
        if evidence.is_relative_to(ROOT):
            parser.error('--evidence must be outside the repository')
        evidence.mkdir(parents=True, exist_ok=True)
        # Offline screenshots use installed fonts while the synthetic library shard is held.
        os.environ['PW_TEST_SCREENSHOT_NO_FONTS_READY'] = '1'
    if not (ROOT / 'public/index.html').is_file():
        parser.error('build the offline public/ fixture before running the browser test')

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT / 'public')) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{server.server_port}/'
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
                for width in (1280, 390):
                    check_rows(browser, base, width, evidence)
                    check_cards(browser, base, width, evidence)
                check_startup_and_quota(browser, base)
                browser.close()
        finally:
            server.shutdown()


if __name__ == '__main__':
    main()
