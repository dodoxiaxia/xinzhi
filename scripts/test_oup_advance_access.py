"""Offline checks for the OUP Advance Access feeds added for three ESC journals."""
import hashlib
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import refresh_feeds as feeds


# Addresses confirmed live on 2026-11-24 (HTTP 200, dated items within 14 days).
OUP_ADVANCE_ACCESS = (
    {
        'name': 'Cardiovascular Research',
        'url': 'https://academic.oup.com/rss/site_5369/advanceAccess_3230.xml',
    },
    {
        'name': 'EHJ - Cardiovascular Pharmacotherapy',
        'url': 'https://academic.oup.com/rss/site_5377/advanceAccess_3238.xml',
    },
    {
        'name': 'European Heart Journal - Cardiovascular Imaging',
        'url': 'https://academic.oup.com/rss/site_5376/advanceAccess_3237.xml',
    },
)


class OupAdvanceAccessFeedTests(unittest.TestCase):
    def setUp(self):
        guards = [
            patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')),
            patch('socket.create_connection', side_effect=AssertionError('Network forbidden')),
        ]
        for guard in guards:
            guard.start()
            self.addCleanup(guard.stop)

    def _rows(self):
        return json.loads(feeds.EXTRA_FEEDS_PATH.read_text(encoding='utf-8'))

    def test_extra_feeds_declares_each_advance_access_url_once(self):
        rows = self._rows()
        urls = [row['url'] for row in rows]
        self.assertEqual(len(urls), len(set(urls)))

        for expected in OUP_ADVANCE_ACCESS:
            matches = [row for row in rows if row.get('url') == expected['url']]
            self.assertEqual(len(matches), 1, expected['url'])
            row = matches[0]
            self.assertEqual(row['name'], expected['name'])
            self.assertTrue(row['url'].startswith('https://'))
            self.assertIs(row['enabled'], True)
            self.assertFalse(feeds.has_credentials(row['url']))
            self.assertEqual(row['category'], '心血管')
            self.assertIn(row['category'], feeds.EXTRA_FALLBACK_CATEGORIES)
            self.assertEqual(row['sourceType'], '出版商/学术平台')
            self.assertEqual(row['route'], 'publisher')
            self.assertNotIn('fallbackCategory', row)
            self.assertIn('advanceAccess_', row['url'])
            self.assertEqual(feeds.source_id(row['url']), hashlib.sha256(row['url'].encode('utf-8')).hexdigest()[:12])

    def test_extra_sources_selects_advance_access_and_deduplicates_by_url(self):
        selected = feeds.extra_sources()
        selected_urls = {entry['url'] for entry in selected}
        for expected in OUP_ADVANCE_ACCESS:
            matches = [entry for entry in selected if entry['url'] == expected['url']]
            self.assertEqual(len(matches), 1, expected['url'])
            self.assertEqual(matches[0]['name'], expected['name'])
            self.assertEqual(matches[0]['origin'], 'config/extra_feeds.json')
            self.assertIs(matches[0]['enabled'], True)
            self.assertEqual(matches[0]['category'], '心血管')

        known = {expected['url'] for expected in OUP_ADVANCE_ACCESS}
        deduped = feeds.extra_sources(known_urls=known)
        deduped_urls = {entry['url'] for entry in deduped}
        self.assertTrue(known.isdisjoint(deduped_urls))
        self.assertEqual(len(deduped), len(selected) - len(known))

    def test_select_sources_includes_advance_access_only_when_all_sources(self):
        catalogue = {
            'id': 'a',
            'name': 'Heart Online First',
            'url': 'https://example.org/rss',
            'enabled': True,
        }
        library = {'feeds': [catalogue]}
        default = feeds.select_sources(library)
        default_urls = {row['url'] for row in default}
        for expected in OUP_ADVANCE_ACCESS:
            self.assertNotIn(expected['url'], default_urls)

        all_run = feeds.select_sources(library, all_sources=True)
        all_urls = {row['url'] for row in all_run}
        for expected in OUP_ADVANCE_ACCESS:
            matches = [row for row in all_run if row['url'] == expected['url']]
            self.assertEqual(len(matches), 1, expected['url'])
            self.assertEqual(matches[0]['name'], expected['name'])
            self.assertEqual(matches[0]['origin'], 'config/extra_feeds.json')
        self.assertGreater(len(all_run), len(default))
        self.assertTrue({expected['url'] for expected in OUP_ADVANCE_ACCESS}.issubset(all_urls))


if __name__ == '__main__':
    unittest.main()
