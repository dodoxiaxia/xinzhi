#!/usr/bin/env python3
"""Verify shortlist sharing with the built public bundle on loopback."""
import base64
import functools
import json
import os
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BANNER = '#sharedShortlistBanner'
ROWS = '#sharedShortlistRows .compact-row'
MISSING = '#sharedShortlistMissing'
COPY = '#copyShortlistShareBtn'
MERGE = '#mergeSharedShortlistBtn'
CLOSE = '#closeSharedShortlistBtn'
IDS = 'xinzhi_huddle_ids'
UNKNOWN = 'rss-offline-share-missing'
ARCHIVE_PMID = '98765439'


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def payload(*ids):
    return 'v1.' + base64.urlsafe_b64encode('\n'.join(ids).encode()).decode().rstrip('=')


def params(url):
    return parse_qs(urlsplit(url).query)


def stored_ids(page):
    return page.evaluate('(key) => JSON.parse(localStorage.getItem(key) || "[]")', IDS)


def check_contrast(page):
    pairs = page.locator(f'{BANNER} :is(h2, button, p:not(:empty))').evaluate_all('''elements => {
      function hex(color) {
        const channels = color.match(/^rgb\\((\\d+), (\\d+), (\\d+)\\)$/);
        if (!channels) throw Error('Expected opaque RGB, got ' + color);
        return '#' + channels.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('');
      }
      return elements.map(el => {
        let bg = el;
        while (getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)') bg = bg.parentElement;
        return [el.textContent, hex(getComputedStyle(el).color), hex(getComputedStyle(bg).backgroundColor)];
      });
    }''')
    result = subprocess.run(['node', '-e', r"""
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const source = readFileSync('scripts/test_color_contrast.cjs', 'utf8');
const helpers = ['relativeLuminance', 'contrastRatio', 'assertContrast'].map(name => {
  const match = source.match(new RegExp('^function ' + name + '\\([^]*?\\n}', 'm'));
  assert(match, 'Missing contrast helper ' + name);
  return match[0];
}).join('\n');
const check = new Function('assert', helpers + '\nreturn (fg, bg, label) => { assertContrast(label, fg, bg); return contrastRatio(fg, bg); };')(assert);
const pairs = JSON.parse(readFileSync(0, 'utf8'));
console.log(Math.min(...pairs.map(([label, fg, bg]) => check(fg, bg, label))).toFixed(2));
"""], input=json.dumps(pairs), text=True, capture_output=True, check=True, cwd=ROOT)
    return result.stdout.strip()


def context_at(browser, base, width, height, theme, clipboard=False, intercept=None):
    context = browser.new_context(viewport={'width': width, 'height': height}, color_scheme=theme,
                                  reduced_motion='reduce', has_touch=width == 390, is_mobile=width == 390,
                                  service_workers='block')
    if clipboard:
        context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=base)

    def offline(route):
        if not route.request.url.startswith(base + '/') or route.request.method not in {'GET', 'HEAD'}:
            route.abort()
        elif urlsplit(route.request.url).path.startswith('/api/'):
            route.fulfill(json={'ok': True, 'canGenerate': False, 'papers': []})
        elif not intercept or not intercept(route):
            route.continue_()

    context.route('**/*', offline)
    return context


def check_flow(browser, base, width, height, theme, output):
    desktop = width == 1280
    errors = []
    sender = context_at(browser, base, width, height, theme, clipboard=desktop)
    if not desktop:
        sender.add_init_script("Object.defineProperty(navigator, 'clipboard', {value: undefined})")
    page = sender.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(f'{base}/?mode=library&lane=all&theme={theme}')
    stars = page.locator('#articlesStream [data-action="toggle-huddle"]')
    expect(stars.nth(4)).to_be_visible()
    picks = [2, 0, 1]
    paper_ids = [stars.nth(i).get_attribute('data-paper-id') for i in picks]
    existing = [stars.nth(i).get_attribute('data-paper-id') for i in [3, 0, 4]]
    assert all(paper_ids + existing) and len(set(paper_ids + existing)) == 5
    for index in picks:
        stars.nth(index).click()
    assert stored_ids(page) == paper_ids
    page.locator('#openHuddleBtn').click()
    button = page.locator(COPY)
    size = button.bounding_box()
    assert size['width'] >= 44 and size['height'] >= 44, size
    button.focus()
    expect(button).to_be_focused()
    button.press('Enter')
    if desktop:
        expect(page.locator('#toast')).to_contain_text('已复制分享链接')
        link = page.evaluate('navigator.clipboard.readText()')
    else:
        field = page.locator('#shortlistShareCopyUrl')
        expect(field).to_be_visible()
        expect(field).to_be_focused()
        assert field.evaluate('(el) => el.readOnly && el.selectionStart === 0 && el.selectionEnd === el.value.length')
        link = field.input_value()
    assert set(params(link)) == {'list'} and link.startswith(base + '/') and len(link) < 2000
    sender.close()

    receiver = context_at(browser, base, width, height, theme)
    page = receiver.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    link += f'&mode=library&lane=all&theme={theme}&other=kept'
    page.goto(link)
    assert stored_ids(page) == [], 'opening a share in a new context must not merge it'
    banner = page.locator(BANNER)
    rows = page.locator(ROWS)

    def check_rows():
        expect(banner).to_contain_text('正在查看分享的清单（3 篇）')
        expect(rows).to_have_count(len(paper_ids))
        assert rows.evaluate_all('(els) => els.map(el => el.dataset.paperId)') == paper_ids

    check_rows()
    expect(page.locator('#streamSection')).to_be_hidden()
    expect(page.locator('#sharedShortlistRows [data-action="toggle-huddle"]')).to_have_count(0)
    expect(page.locator('html')).to_have_attribute('data-theme', theme)
    contrast = check_contrast(page)
    if output:
        page.screenshot(path=str(output / f'share-{width}-{theme}-01-received.png'))

    row_title = rows.first.locator('.compact-title')
    row_title.click()
    expect(page.locator('#readerDrawer.open')).to_be_visible()
    page.locator('#drawerExpandBtn').click()
    expect(page.locator('#readerDrawer.open.reading-mode')).to_be_visible()
    assert params(page.url)['paper'] == [paper_ids[0]]
    assert params(page.url)['list'] == params(link)['list']
    if output:
        page.screenshot(path=str(output / f'share-{width}-{theme}-02-reading.png'))
    page.go_back()
    expect(page.locator('#readerDrawer.open:not(.reading-mode)')).to_be_visible()
    page.go_forward()
    expect(page.locator('#readerDrawer.open.reading-mode')).to_be_visible()
    page.go_back()
    page.go_back()
    expect(page.locator('#readerDrawer.open')).to_have_count(0)
    check_rows()
    expect(row_title).to_be_focused()

    # A direct link with both parameters restores the existing reading overlay on boot.
    page.goto(link + '&' + urlencode({'paper': paper_ids[1]}))
    expect(page.locator('#readerDrawer.open.reading-mode')).to_be_visible()
    page.locator('#readingBackBtn').click()
    check_rows()
    assert 'paper' not in params(page.url)

    # Existing entries include an overlap and two distinct papers.
    page.evaluate('([key, value]) => localStorage.setItem(key, JSON.stringify(value))', [IDS, existing])
    page.reload()
    check_rows()
    assert stored_ids(page) == existing
    page.locator(MERGE).click()
    union = existing + [id_ for id_ in paper_ids if id_ not in existing]
    assert stored_ids(page) == union
    expect(page.locator('#toast')).to_contain_text(f'已加入 {len(union) - len(existing)} 篇')
    if output:
        page.screenshot(path=str(output / f'share-{width}-{theme}-03-merged.png'))
    page.locator(MERGE).click()
    assert stored_ids(page) == union

    # Closing uses replace. Back restores the previous mode entry carrying the list.
    page.locator('.nav-tab-btn[data-mode="candidates"]').click()
    assert params(page.url)['list'] == params(link)['list']
    check_rows()
    history_length = page.evaluate('history.length')
    page.locator(CLOSE).click()
    expect(banner).to_be_hidden()
    expect(page.locator('#streamSection')).to_be_visible()
    assert 'list' not in params(page.url) and params(page.url)['mode'] == ['candidates']
    assert params(page.url)['other'] == ['kept'] and page.evaluate('history.length') == history_length
    page.go_back()
    check_rows()
    page.go_forward()
    expect(banner).to_be_hidden()
    assert stored_ids(page) == union

    page.goto(f'{base}/?' + urlencode({
        'list': payload(paper_ids[0], UNKNOWN, '<script id="share-injected">alert(1)</script>', UNKNOWN),
        'theme': theme,
    }))
    expect(rows).to_have_count(1)
    expect(page.locator(f'{MISSING} summary')).to_have_text('1 篇在本站未找到')
    unknown_ids = page.locator('#sharedShortlistMissingIds')
    expect(unknown_ids).to_be_hidden()
    page.locator(f'{MISSING} summary').click()
    expect(unknown_ids).to_have_text(UNKNOWN)
    expect(page.locator('#sharedShortlistNotice')).to_have_text('已忽略无效、重复或超出限制的分享条目。')
    expect(page.locator('#share-injected')).to_have_count(0)
    check_contrast(page)
    assert not errors, errors
    receiver.close()
    print(f'{width}x{height} {theme}: PASS ({"clipboard" if desktop else "manual fallback"}, '
          f'order, reading, merge, history, missing and contrast ≥ {contrast}:1)')


def check_archive(browser, base):
    held = []

    def intercept(route):
        if urlsplit(route.request.url).path != '/offline-shortlist-archive.js':
            return False
        held.append(route)
        return True

    context = context_at(browser, base, 390, 844, 'light', intercept=intercept)
    context.add_init_script('''Object.defineProperty(window, 'RADAR_SRC', {
        get: () => '/offline-shortlist-archive.js', set: () => {}
    });''')
    page = context.new_page()
    page.goto(f'{base}/?list={payload(ARCHIVE_PMID, UNKNOWN)}', wait_until='domcontentloaded')
    expect(page.locator('#sharedShortlistNotice')).to_have_text('正在查找公开题录…')
    expect(page.locator(MISSING)).to_be_hidden()
    expect(page.locator(MERGE)).to_be_disabled()
    # This request only starts after the normal feeds, library and radar shards settle.
    page.wait_for_function("""() => [...document.scripts].some(script =>
        script.src.endsWith('/offline-shortlist-archive.js'))""")
    assert len(held) == 1
    archive = {'rows': [[ARCHIVE_PMID, '', '2026-01-01', 0, 0, 0, 0, [], 'Offline shared radar record']],
               'jn': ['Circulation'], 'pub': ['AHA'], 'tier': ['心血管'], 'design': ['队列研究'], 'tag': []}
    held[0].fulfill(content_type='application/javascript', body=(
        'window.RADAR_ARCHIVE = ' + json.dumps(archive) + '; window.XINZHI_RADAR_READY();'
    ))
    expect(page.locator(ROWS)).to_have_attribute('data-paper-id', f'pmid-{ARCHIVE_PMID}')
    expect(page.locator(f'{MISSING} summary')).to_have_text('1 篇在本站未找到')
    expect(page.locator(MERGE)).to_be_enabled()
    context.close()
    print('deferred archive: PASS (pending while held; one resolved and one missing after load)')


def main():
    output = os.environ.get('SHORTLIST_SHARE_EVIDENCE')
    output = Path(output) if output else None
    if output:
        assert ROOT not in output.resolve().parents and output.resolve() != ROOT
        output.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=ROOT / 'public')
    with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = f'http://127.0.0.1:{server.server_port}'
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                                                     args=['--no-sandbox'], headless=True)
                try:
                    for width, height in [(390, 844), (1280, 800)]:
                        for theme in ['light', 'dark']:
                            check_flow(browser, base, width, height, theme, output)
                    check_archive(browser, base)
                finally:
                    browser.close()
        finally:
            server.shutdown()


if __name__ == '__main__':
    main()
