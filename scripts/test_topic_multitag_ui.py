#!/usr/bin/env python3
"""Exercise the real public bundle with an offline library topic fixture."""
import argparse
import functools
import json
import os
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
AF, AI, HF = '#房颤/电生理', '#AI-ECG', '#心衰/心肌'
RARE, EXTRA = '#先心病', '#测试额外主题'


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def paper(key, topics, journal='Circulation'):
    return {
        'id': 'topic-' + key, 'title': 'Topic filter fixture ' + key,
        'doi': '10.9999/topic-' + key, 'journal': journal, 'cleanJournal': journal,
        'clinicalTier': '心血管旗舰顶刊', 'studyDesign': 'RCT',
        'date': '2026-10-14', 'datePrecision': 'day', 'tags': topics,
        'url': 'https://example.invalid/' + key,
    }


PAPERS = [
    paper('both', [AF, AI, HF, EXTRA]),
    paper('af', [AF]),
    paper('ai', [AI], 'The BMJ'),
    paper('both-general', [AF, AI], 'The BMJ'),
    paper('none', []),
]


def params(page):
    return {key: values[0] for key, values in parse_qs(urlsplit(page.url).query).items()}


def exercise(page, base, width, evidence):
    pop = page.locator('#qfPop')
    trigger = page.locator('[data-qf="topic"]')
    cards = page.locator('#articlesStream article[data-paper-id]')
    total = page.locator('#listTotal')
    summary = page.locator('#qfSummary')
    tier = page.locator('[data-qf-jtier="cardioClinical"]')
    topic = lambda name: pop.locator(f'[data-qf-topic="{name}"]')
    mode = lambda name: pop.locator(f'[data-qf-topic-mode="{name}"]')
    clear_pop = pop.locator('[data-qf-close]')
    base_page = base + '?mode=library&lane=all&view=cards&theme=light'
    checks = 0

    def shot(name):
        if evidence:
            page.evaluate('window.scrollTo(0, 0)')
            pop.evaluate('el => el.scrollTop = 0')
            page.screenshot(path=str(evidence / f'{width}-{name}.png'), animations='disabled')

    def expected(*keys):
        expect(cards).to_have_count(len(keys))
        assert sorted(cards.evaluate_all('rows => rows.map(row => row.dataset.paperId)')) == sorted('topic-' + key for key in keys)
        expect(total).to_contain_text(re.compile(rf'\b{len(keys)}\s*篇'))

    def click_count(option):
        nonlocal checks
        prediction = int(option.locator('small').inner_text())
        option.click()
        expect(cards).to_have_count(prediction)
        expect(total).to_contain_text(re.compile(rf'\b{prediction}\s*篇'))
        checks += 1

    page.goto(base_page)
    expected('both', 'af', 'ai', 'both-general', 'none')
    expect(cards.filter(has_text='fixture none').locator('.topic-badge')).to_have_count(0)
    rich_card = page.locator('[data-paper-id="topic-both"]')
    expect(rich_card.locator('.topic-badge')).to_have_count(3)
    expect(rich_card.locator('.topic-badge-more')).to_have_text('+1')
    shot('badges')
    trigger.click()
    expect(pop.get_by_role('heading', name='临床亚专科 已选 0')).to_be_visible()
    expect(pop.get_by_role('heading', name='检查与手段 已选 0')).to_be_visible()
    expect(pop.get_by_role('heading', name='AI 与数字医学 已选 0')).to_be_visible()
    expect(pop.get_by_role('heading', name='其他 已选 0')).to_be_visible()
    expect(topic(EXTRA)).to_be_attached()
    if width == 390:
        assert pop.bounding_box()['height'] <= 844 * 1.5
        assert pop.bounding_box()['y'] + pop.bounding_box()['height'] <= total.bounding_box()['y']
        assert total.bounding_box()['y'] < cards.first.bounding_box()['y']
    click_count(topic(AF))
    expect(pop.locator('.qf-hint')).to_contain_text('单选时无区别')
    click_count(topic(AI))
    expected('both', 'af', 'ai', 'both-general')
    expect(summary).to_contain_text('文章主题（任一）')
    expect(pop.get_by_role('heading', name='临床亚专科 已选 1')).to_be_visible()
    shot('or')
    click_count(mode('all'))
    expected('both', 'both-general')
    expect(summary).to_contain_text('文章主题（同时包含）')
    assert params(page)['tagmode'] == 'all'
    shot('and')
    expect(topic(RARE)).to_have_class(re.compile('is-empty'))
    click_count(topic(RARE))
    expected()
    expect(page.locator('.empty-state')).to_be_visible()
    shot('empty')
    click_count(topic(RARE))
    clear_pop.click()

    tier_count = int(tier.inner_text().split('·')[-1].strip())
    tier.click()
    expected('both')
    assert cards.count() == tier_count
    assert params(page)['tags'].split(',') == [AF, AI]
    assert params(page)['jtier'] == 'cardioClinical'
    shot('tier-summary')
    url = page.url
    page.reload()
    expected('both')
    assert params(page)['tagmode'] == 'all'
    shared = page.context.new_page()
    try:
        shared.goto(url)
        expect(shared.locator('#articlesStream article[data-paper-id="topic-both"]')).to_be_visible()
        expect(shared.locator('#qfSummary')).to_contain_text('文章主题（同时包含）')
    finally:
        shared.close()
    radar_tab = page.locator('button[data-mode="candidates"]')
    radar_tab.click()
    expect(radar_tab).to_have_class(re.compile('active'))
    page.go_back()
    expected('both')
    assert params(page)['tagmode'] == 'all'

    summary.locator(f'[data-qf-clear-value="{AI}"]').click()
    expected('both', 'af')
    assert params(page)['tag'] == AF and params(page)['jtier'] == 'cardioClinical'
    rich_card.locator(f'.topic-badge[data-filter-tag="{AI}"]').click()
    expected('both')
    assert params(page)['tags'].split(',') == [AF, AI] and params(page)['jtier'] == 'cardioClinical'
    expect(rich_card.locator(f'.topic-badge[data-filter-tag="{AI}"]')).to_have_attribute('aria-pressed', 'true')
    trigger.click()
    uncategorized = pop.locator('[data-qf-topic-unclassified]')
    click_count(uncategorized)
    expected('none')
    expect(mode('any')).to_be_disabled()
    expect(mode('all')).to_be_disabled()
    assert 'tagmode' not in params(page)
    click_count(uncategorized)
    expected('both', 'af', 'none')
    click_count(topic(AF))
    click_count(mode('all'))
    clear_pop.click()
    summary.locator('[data-qf-clear="all"]').click()
    expected('both', 'af', 'ai', 'both-general', 'none')
    assert not {'tagmode', 'tag', 'tags', 'jtier'} & params(page).keys()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

    page.goto(base_page.replace('theme=light', 'theme=dark'))
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    expected('both', 'af', 'ai', 'both-general', 'none')
    trigger.click()
    click_count(topic(AF))
    click_count(topic(AI))
    click_count(mode('all'))
    shot('dark')
    print(f'{width}px: {checks} option counts match rendered results. Tier, tags, badge, history, URL, overflow and dark mode verified.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    if args.evidence:
        args.evidence.mkdir(parents=True, exist_ok=True)
    public = ROOT / 'public'
    assert (public / 'index.html').is_file(), 'Build public/ before running the browser test'
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(public)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    fixture = json.dumps({'papers': PAPERS, 'pdfIds': []}, ensure_ascii=False)

    def route(request):
        url = request.request.url
        if not url.startswith(base):
            return request.abort()
        if '/api/' in url:
            return request.fulfill(json={'ok': True, 'papers': [], 'jobs': [], 'found': False})
        if '/assets/data-library.' in url:
            return request.fulfill(content_type='application/javascript; charset=utf-8',
                                   body='window.XINZHI_PART("library",' + fixture + ');')
        return request.continue_()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
            for width, height in [(1280, 800), (390, 844)]:
                context = browser.new_context(viewport={'width': width, 'height': height},
                                              has_touch=width == 390, reduced_motion='reduce')
                context.route('**/*', route)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                try:
                    exercise(page, base, width, args.evidence)
                    assert not errors, errors
                finally:
                    context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
