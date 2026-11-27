"""Offline regressions for the scoped Nature Communications PubMed search feed."""
import hashlib
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
import refresh_feeds as feeds


NCOMMS_NAME = 'Nature Communications'
FIXTURE_PATH = feeds.ROOT / 'scripts/fixtures/pubmed-rss-ncomms-scoped.rss'
TARGET_DOI = '10.1038/s41467-026-78520-x'
CATALOGUE = {'id': 'a', 'name': 'Heart Online First', 'url': 'https://example.org/rss', 'enabled': True}


def pubmed_ncomms_row():
    rows = json.loads(feeds.EXTRA_FEEDS_PATH.read_text(encoding='utf-8'))
    matches = [row for row in rows if row.get('name') == NCOMMS_NAME and row.get('route') == 'pubmed']
    if len(matches) != 1:
        raise AssertionError('expected exactly one Nature Communications PubMed feed in extra_feeds.json')
    return matches[0]

class NcommsPubmedFeedTests(unittest.TestCase):
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

    def _url(self):
        return self._row()['url']

    def _row(self):
        return pubmed_ncomms_row()

    def test_extra_feeds_declares_scoped_pubmed_entry_once(self):
        rows = self._rows()
        urls = [row['url'] for row in rows]
        self.assertEqual(len(urls), len(set(urls)))

        row = self._row()
        self.assertEqual(row['name'], NCOMMS_NAME)
        self.assertTrue(row['url'].startswith('https://pubmed.ncbi.nlm.nih.gov/rss/search/'))
        self.assertTrue(row['url'].endswith('?limit=50'))
        self.assertIs(row['enabled'], True)
        self.assertFalse(feeds.has_credentials(row['url']))
        self.assertEqual(row['category'], '综合医学')
        self.assertEqual(row['fallbackCategory'], '综合医学')
        self.assertIn(row['category'], feeds.EXTRA_FALLBACK_CATEGORIES)
        self.assertIn(row['fallbackCategory'], feeds.EXTRA_FALLBACK_CATEGORIES)
        self.assertEqual(row['sourceType'], '出版商/学术平台')
        self.assertEqual(row['route'], 'pubmed')
        self.assertIn('8 条', row['note'])
        self.assertIn('PubMed', row['note'])
        self.assertEqual(feeds.source_id(row['url']), hashlib.sha256(row['url'].encode('utf-8')).hexdigest()[:12])
        self.assertRegex(feeds.source_id(row['url']), r'^[0-9a-f]{12}$')

    def test_extra_sources_selects_and_deduplicates_by_url(self):
        selected = feeds.extra_sources()
        matches = [source for source in selected if source['url'] == self._url()]
        self.assertEqual(len(matches), 1)
        source = matches[0]
        self.assertEqual(source['name'], NCOMMS_NAME)
        self.assertEqual(source['id'], feeds.source_id(self._url()))
        self.assertIs(source['enabled'], True)
        self.assertEqual(source['category'], '综合医学')
        self.assertEqual(source['fallbackCategory'], '综合医学')
        self.assertEqual(source['origin'], 'config/extra_feeds.json')

        deduped = feeds.extra_sources(known_urls={self._url()})
        self.assertNotIn(self._url(), {entry['url'] for entry in deduped})
        self.assertEqual(len(deduped), len(selected) - 1)

    def test_select_sources_includes_feed_only_when_all_sources(self):
        library = {'feeds': [CATALOGUE]}
        default = feeds.select_sources(library)
        self.assertEqual([row['name'] for row in default], [CATALOGUE['name']])
        self.assertNotIn(self._url(), {row['url'] for row in default})

        all_run = feeds.select_sources(library, all_sources=True)
        matches = [row for row in all_run if row['url'] == self._url()]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]['name'], NCOMMS_NAME)
        self.assertEqual(matches[0]['origin'], 'config/extra_feeds.json')
        self.assertGreater(len(all_run), len(default))

    def test_fixture_keeps_cv_and_target_doi_and_excludes_unrelated(self):
        source = next(entry for entry in feeds.extra_sources() if entry['url'] == self._url())
        raw = FIXTURE_PATH.read_bytes()
        root = ET.fromstring(raw)
        xml_items = [el for el in root.find('channel') if feeds.local(el.tag) == 'item']
        self.assertEqual(len(xml_items), 3)

        parsed = feeds.parse_feed(raw, source, checked_at='2026-11-27T00:00:00+00:00')
        self.assertEqual(parsed['rawItems'], 3)
        self.assertEqual(parsed['scopeExcludedCount'], 1)
        self.assertEqual(parsed['scopeExcludedReasons'], {'unrelated_to_cv_or_medical_ai': 1})
        self.assertEqual(len(parsed['items']) + parsed['scopeExcludedCount'], parsed['rawItems'])

        by_doi = {item['doi']: item for item in parsed['items']}
        self.assertEqual(set(by_doi), {'10.1038/s41467-026-79283-1', TARGET_DOI})

        hypertension = by_doi['10.1038/s41467-026-79283-1']
        self.assertEqual(hypertension['category'], '心血管')
        self.assertEqual(hypertension['journal'], NCOMMS_NAME)
        self.assertEqual(hypertension['pmid'], '43064729')
        self.assertTrue(hypertension['url'].startswith('https://pubmed.ncbi.nlm.nih.gov/43064729'))

        # Fixture identity only: 99900001 is not a live PMID. The live article was
        # not in PubMed at the time this feed was added.
        target = by_doi[TARGET_DOI]
        self.assertEqual(target['journal'], NCOMMS_NAME)
        self.assertIn('clinical diagnostics', target['title'].lower())
        self.assertEqual(target['category'], '综合医学')
        self.assertTrue(target['url'].startswith('https://'))

        excluded = parsed['scopeExcluded']
        self.assertEqual(len(excluded), 1)
        self.assertEqual(excluded[0]['reason'], 'unrelated_to_cv_or_medical_ai')
        self.assertEqual(excluded[0]['doi'], '10.1038/s41467-026-00000-0')
        self.assertIn('melanoma', excluded[0]['title'].lower())


if __name__ == '__main__':
    unittest.main()
