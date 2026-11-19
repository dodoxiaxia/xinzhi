"""Check the public 404/crawler assets and the history URLs they must not break."""
import contextlib
import datetime
import io
import json
import re
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import patch

import build_public as builder
from package_release import public_payloads
from public_bundle import bundle_text
from release_integrity import validate_release
from test_release_build import synthetic_root

ROOT = Path(__file__).resolve().parents[1]
SITE = 'https://learn.dryz.info'


class HeadMeta(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.in_head = False
        self.tags = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag == 'head':
            self.in_head = True
        if self.in_head and tag == 'meta':
            self.tags.append((dict(attrs), self.get_starttag_text()))

    def handle_endtag(self, tag):
        if tag == 'head':
            self.in_head = False


class PublicSeoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        cls.root = Path(directory.name)
        cls.public = cls.root / 'public'
        synthetic_root(cls.root)
        shutil.copyfile(ROOT / 'index.html', cls.root / 'index.html')
        candidates = cls.root / 'data/candidates.json'
        data = json.loads(candidates.read_text())
        data['items'].append({
            'id': 'fixture-seo-canary',
            'title': 'fixture-seo-canary "><meta name="twitter:card" content="injected">&',
            'date': data['updatedAt'][:10],
        })
        candidates.write_text(json.dumps(data))
        with patch.multiple(builder, ROOT=cls.root, DEST=cls.public), contextlib.redirect_stdout(io.StringIO()):
            builder.main()

    def test_build_and_package_allow_only_published_files(self):
        payloads = public_payloads(self.root)
        manifest = validate_release(self.root, payloads)
        self.assertEqual(set(payloads), {row['path'] for row in manifest['files']})
        self.assertTrue({'404.html', 'robots.txt', 'sitemap.xml'} <= payloads.keys())
        for name in ('404.html', 'robots.txt', 'sitemap.xml'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'exactly the published files'):
                validate_release(self.root, {key: value for key, value in payloads.items() if key != name})
        extra = self.public / 'manifest.webmanifest'
        extra.write_text('{}')
        try:
            with self.assertRaisesRegex(ValueError, 'exactly the published files'):
                public_payloads(self.root)
            with self.assertRaisesRegex(ValueError, 'exactly the published files'):
                validate_release(self.root, {**payloads, extra.name: extra.read_bytes()})
        finally:
            extra.unlink()

    def test_404_is_a_standalone_chinese_page_with_a_home_link(self):
        page = (self.public / '404.html').read_text(encoding='utf-8')
        self.assertIn('<html lang="zh-CN">', page)
        self.assertIn('<h1>404 · 页面未找到</h1>', page)
        self.assertIn('<a href="/">返回心知首页</a>', page)
        self.assertNotIn('<script', page)
        self.assertNotIn('页面未找到', (self.public / 'index.html').read_text(encoding='utf-8'))

    def test_robots_and_sitemap_only_advertise_stable_public_pages(self):
        robots = (self.public / 'robots.txt').read_text(encoding='utf-8')
        self.assertEqual(robots.splitlines(), [
            'User-agent: *', 'Disallow: /api/', f'Sitemap: {SITE}/sitemap.xml',
        ])
        # Check the schema subset we emit: qualified urlset/url/loc/lastmod, in schema order.
        ns = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
        sitemap = ET.parse(self.public / 'sitemap.xml').getroot()
        self.assertEqual(sitemap.tag, ns + 'urlset')
        manifest = json.loads((self.root / 'docs/public-manifest.json').read_text())
        build_date = datetime.datetime.fromisoformat(manifest['createdAt']).date().isoformat()
        urls = []
        for entry in sitemap:
            self.assertEqual(entry.tag, ns + 'url')
            self.assertEqual([child.tag for child in entry], [ns + 'loc', ns + 'lastmod'])
            urls.append(entry[0].text)
            self.assertEqual(entry[1].text, build_date)
        # Exact set and no duplicates: excludes /api/, article IDs, queries, shards, and private paths.
        self.assertEqual(urls, [f'{SITE}/'])

    def test_built_homepage_share_tags_are_static_unique_and_escaped(self):
        html = (self.public / 'index.html').read_text(encoding='utf-8')
        tags = HeadMeta(html).tags
        description, = [attrs['content'] for attrs, _ in tags if attrs.get('name') == 'description']
        title = re.search(r'<title>([^<]+)</title>', html)[1]
        share = []
        for attrs, raw in tags:
            for key in ('name', 'property'):
                if attrs.get(key, '').startswith(('og:', 'twitter:')):
                    self.assertEqual(set(attrs), {key, 'content'})
                    value = re.search(r'\bcontent="([^"]*)"\s*>$', raw)[1]
                    self.assertNotRegex(value, r'[<>]|&(?!amp;|quot;|apos;|lt;|gt;|#\d+;|#x[\da-fA-F]+;)')
                    share.append((key, attrs[key], attrs['content']))
        self.assertCountEqual(share, [
            ('property', 'og:title', title),
            ('property', 'og:description', description),
            ('property', 'og:url', f'{SITE}/'),
            ('property', 'og:type', 'website'),
            ('property', 'og:image', f'{SITE}/icon.png'),
            ('property', 'og:locale', 'zh_CN'),
            ('name', 'twitter:card', 'summary'),
        ])
        self.assertIn('fixture-seo-canary', bundle_text(self.public))
        self.assertNotIn('fixture-seo-canary', html)

    def test_crawler_and_error_cache_rules_do_not_change_existing_routes(self):
        headers = (self.public / '_headers').read_text(encoding='utf-8')
        cache = dict(re.findall(r'^(\S[^\n]*)\n  Cache-Control: ([^\n]+)', headers, flags=re.M))
        revalidate = 'public, max-age=0, must-revalidate'
        immutable = 'public, max-age=31536000, immutable'
        short = 'public, max-age=300, must-revalidate'
        self.assertEqual(cache, {
            '/': revalidate, '/index.html': revalidate, '/demo-reading.html': revalidate,
            '/icon.png': 'public, max-age=86400', '/assets/*': immutable, '/shards/*': immutable,
            '/404': revalidate, '/404.html': revalidate, '/robots.txt': short, '/sitemap.xml': short,
        })
        self.assertIn('/robots.txt\n  Cache-Control: ' + short + '\n  Content-Type: text/plain;', headers)
        self.assertIn('/sitemap.xml\n  Cache-Control: ' + short + '\n  Content-Type: application/xml;', headers)

    def test_history_url_shapes_stay_on_the_built_homepage(self):
        app = ROOT / 'src/app'
        pushes = []
        for file in app.glob('*.js'):
            source = file.read_text()
            arguments = re.findall(r"history\.pushState\([^,]*,\s*'',\s*(.*)\);", source)
            self.assertEqual(source.count('history.pushState('), len(arguments), file.name)
            pushes.extend((file.name, argument) for argument in arguments)
        self.assertCountEqual(pushes, [
            ('04-filters.js', 'location.href'),
            ('09-weekly.js', 'deepReaderUrl(id)'),
            ('10-browse-events.js', 'location.href'),
        ])
        self.assertTrue((self.public / 'index.html').is_file())
        weekly = (app / '09-weekly.js').read_text()
        filters = (app / '04-filters.js').read_text()
        deep_reader = re.search(r'^  function deepReaderUrl\(id\) \{.*?^  }', weekly, re.M | re.S)[0]
        sync_url = re.search(r'^  function syncUrl\(\) \{.*?^  }', filters, re.M | re.S)[0]
        subprocess.run(['node', '-'], input=deep_reader + '\n' + sync_url + r"""
const assert = require('node:assert/strict');
const window = {};
const state = {viewMode: 'cards'};
const selectedJournals = () => [];
const usesLane = () => false;
const defaultRange = () => 'all';
const viewInUrl = false;
const activeDeepReadingId = 'fixture/文 &?';
let replaced;
const history = {state: null, replaceState: (_state, _title, url) => { replaced = url; }};
for (const path of ['/', '/index.html']) {
  for (const [before, after] of [
    ['', '?read=fixture%2F%E6%96%87+%26%3F'],
    ['?mode=weekly#toc', '?mode=weekly&read=fixture%2F%E6%96%87+%26%3F#toc'],
    ['?mode=weekly&read=old#toc', '?mode=weekly&read=fixture%2F%E6%96%87+%26%3F#toc'],
  ]) {
    window.location = new URL(path + before, 'https://learn.dryz.info');
    assert.equal(deepReaderUrl(activeDeepReadingId), path + after);
    assert.equal(deepReaderUrl(''), path + before.replace('&read=old', ''));
  }
  window.location = new URL(path + '?maintainer=1#toc', 'https://learn.dryz.info');
  for (const mode of ['curated', 'weekly', 'candidates', 'library', 'sources']) {
    Object.assign(state, {mode, range: defaultRange(mode), search: 'a/b?'});
    replaced = undefined;
    syncUrl();
    const url = new URL(replaced, window.location);
    assert.equal(url.origin, window.location.origin);
    assert.equal(url.pathname, path);
    assert.equal(url.hash, '#toc');
    assert.equal(url.searchParams.get('mode'), mode === 'curated' ? null : mode);
    assert.equal(url.searchParams.get('q'), state.search);
    assert.equal(url.searchParams.get('read'), mode === 'weekly' ? activeDeepReadingId : null);
    assert.equal(url.searchParams.has('maintainer'), false);
  }
}
""", text=True, check=True)


if __name__ == '__main__':
    unittest.main()
