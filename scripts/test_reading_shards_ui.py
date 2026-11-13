#!/usr/bin/env python3
"""Open a reading from its month shard, and keep search on the first script.

The fixture is synthetic. It does not use production data or call a model.
"""
import json
import os
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

import build_public as builder

ROOT = Path(__file__).resolve().parents[1]


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def reading(pmcid, day, title, body):
    return {
        'pmcid': pmcid, 'publishedOn': day, 'date': day, 'title': title, 'titleZh': title,
        'journal': 'Heart', 'doi': '10.1000/' + pmcid.lower(), 'pmid': '1',
        'humanReviewed': False, 'scope': 'public-fulltext-body',
        'sourceUrl': 'https://europepmc.org/articles/' + pmcid,
        'sections': {
            'question': {'text': body, 'evidence': []},
            'design': {'text': body, 'evidence': []},
        },
    }


def write_fixture(dest):
    for name in ('index.html', 'style.css', 'app.js', 'citation-export.js', 'journal-tiers.js'):
        shutil.copyfile(ROOT / name, dest / name)
    (dest / 'data').mkdir()
    paper = {
        'id': 'paper-af', 'title': 'Atrial fibrillation ablation outcomes', 'doi': '10.1000/af.1',
        'date': '2026-11-10', 'datePrecision': 'day', 'journal': 'Test Heart Journal',
        'cleanJournal': 'Test Heart Journal', 'publisher': '其他学术刊物',
        'summary': 'Pulsed field ablation reduced recurrence.', 'tags': [],
        'studyDesign': '随机对照', 'url': 'https://doi.org/10.1000/af.1',
        'clinicalTier': '心血管综合与其他',
    }
    (dest / 'data/library.js').write_text('window.LIBRARY=' + json.dumps({'papers': []}, ensure_ascii=False) + ';')
    (dest / 'data/candidates.js').write_text('window.FEEDS=' + json.dumps({'items': [paper]}, ensure_ascii=False) + ';')
    (dest / 'data/source-health.js').write_text('window.SOURCE_HEALTH={"sources":[]};')
    (dest / 'data/curated.js').write_text('window.CURATED=[];')
    (dest / 'data/quicklooks.js').write_text('window.QUICKLOOKS={};')
    index, shards = builder.split_deep_readings({
        'schemaVersion': 1, 'status': {'day': '2026-11-12', 'target': 12, 'completed': 1, 'state': 'complete', 'reason': ''},
        'items': [
            reading('PMC111', '2026-11-12', '十一月题名', '十一月正文只在分片里'),
            reading('PMC222', '2026-10-03', '十月题名', '十月正文只在分片里'),
        ],
    })
    (dest / 'data/readings.js').write_text('window.DEEP_READINGS=' + json.dumps(index, ensure_ascii=False) + ';')
    for name, content in shards.items():
        path = dest / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    html = (dest / 'index.html').read_text()
    needle = '<script src="app.js"></script>'
    if needle not in html:
        raise SystemExit('index.html has no app.js script')
    (dest / 'index.html').write_text(html.replace(needle, '<script src="data/readings.js"></script>\n  ' + needle, 1))
    blob = json.dumps(index, ensure_ascii=False)
    if '十一月正文只在分片里' in blob or '十月正文只在分片里' in blob:
        raise SystemExit('reading index still contains section text')
    return index


def main():
    with tempfile.TemporaryDirectory() as directory:
        dest = Path(directory)
        write_fixture(dest)
        server = ThreadingHTTPServer(('127.0.0.1', 0), lambda *args, **kwargs: Quiet(*args, directory=str(dest), **kwargs))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = 'http://127.0.0.1:%s/' % server.server_port
        errors = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium', args=['--no-sandbox'])
            page = browser.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            requested = []
            page.on('request', lambda request: requested.append(request.url))

            page.goto(base + '?mode=candidates&q=ablation', wait_until='networkidle')
            expect(page.locator('.article-title, .compact-title').first).to_contain_text('Atrial fibrillation ablation')
            if any('/shards/' in url for url in requested):
                raise SystemExit('search requested a reading shard: ' + ', '.join(requested))

            requested.clear()
            page.goto(base + '?mode=weekly&read=PMC111', wait_until='networkidle')
            expect(page.locator('#deepReaderTitle')).to_have_text('十一月题名')
            expect(page.locator('#deepReaderBody')).to_contain_text('十一月正文只在分片里')
            november = [url for url in requested if '/shards/readings-2026-11.' in url]
            october = [url for url in requested if '/shards/readings-2026-10.' in url]
            if len(november) != 1 or october:
                raise SystemExit('deep link loaded the wrong month: ' + ', '.join(requested))
            expect(page.locator('.deep-reading-item').filter(has_text='十月题名')).to_have_count(1)

            page.locator('#deepReaderNext').click()
            expect(page.locator('#deepReaderBody')).to_contain_text('十月正文只在分片里')
            expect(page.locator('#deepReaderPos')).to_have_text('2 / 2')
            if not any('/shards/readings-2026-10.' in url for url in requested):
                raise SystemExit('next reading did not load the October shard')
            if errors:
                raise SystemExit('page errors: ' + '; '.join(errors))
            browser.close()
        server.shutdown()
    print('reading shard loading ok')


if __name__ == '__main__':
    main()
