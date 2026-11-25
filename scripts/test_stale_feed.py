"""Offline tests for stale_feed detection when publisher RSS stalls >14d behind PubMed/Crossref."""
import contextlib
import datetime
import io
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import build_public
import merge_candidates
from source_fallbacks import detect_stale_feeds

NOW = datetime.datetime(2026, 11, 24, 12, 0, tzinfo=datetime.timezone.utc)


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        self.guards = [
            patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')),
            patch('socket.create_connection', side_effect=AssertionError('Network forbidden')),
        ]
        for guard in self.guards:
            guard.start()
            self.addCleanup(guard.stop)


class StaleFeedTests(OfflineTestCase):
    def test_circulation_axatoc_stalled_with_fresh_pubmed_is_marked_stale_feed(self):
        health = {
            'checkedAt': NOW.isoformat(),
            'sources': [
                {
                    'id': 'ac328fb71433',
                    'name': 'Circulation',
                    'url': 'https://www.ahajournals.org/action/showFeed?type=axatoc&feed=rss&jc=circ',
                    'status': 'filtered_empty',
                    'latestPublishedAt': '2026-11-03T10:00:08+00:00',
                    'rawItems': 53,
                    'eligibleItems': 0,
                },
                {
                    'id': '32842866a59f',
                    'name': 'Circulation Research',
                    'url': 'https://www.ahajournals.org/action/showFeed?type=etoc&feed=rss&jc=res',
                    'status': 'ok',
                    'latestPublishedAt': '2026-11-20T10:00:02+00:00',
                    'rawItems': 29,
                    'eligibleItems': 3,
                },
                {
                    'id': '61f098db86f8',
                    'name': 'Circulation: CQO',
                    'url': 'https://www.ahajournals.org/action/showFeed?type=etoc&feed=rss&jc=circoutcomes',
                    'status': 'filtered_empty',
                    'latestPublishedAt': '2025-12-16T07:00:01+00:00',
                    'rawItems': 13,
                    'eligibleItems': 0,
                },
            ],
        }
        pubmed = {
            'items': [
                {
                    'pmid': '43071800',
                    'journal': 'Circulation',
                    'date': '2026-11-23T00:00:00+00:00',
                    'datePrecision': 'day',
                },
                {
                    'pmid': '43071001',
                    'journal': 'Circulation Research',
                    'date': '2026-11-23T00:00:00+00:00',
                    'datePrecision': 'day',
                },
                {
                    'pmid': '42000001',
                    'journal': 'Circulation Cardiovascular Quality and Outcomes',
                    'date': '2026-10-01T00:00:00+00:00',
                    'datePrecision': 'day',
                },
            ],
        }

        marked = detect_stale_feeds(health, pubmed, {'items': []}, now=NOW)
        self.assertEqual(marked, 1)

        by_id = {row['id']: row for row in health['sources']}
        # 1) Circulation axatoc stopped on 11-03 while PubMed has 11-23 -> stale_feed
        circ = by_id['ac328fb71433']
        self.assertEqual(circ['status'], 'stale_feed')
        self.assertEqual(circ['staleFeed'], {
            'latestItemDate': '2026-11-03',
            'alternativeSource': 'PubMed',
            'alternativeLatestDate': '2026-11-23',
            'ageDays': 21,
        })
        self.assertEqual(health['summary']['stale_feed'], 1)

        projected = build_public.public_health(circ, pubmed, NOW)
        self.assertEqual(projected['status'], 'stale_feed')
        self.assertEqual(projected['staleFeed'], circ['staleFeed'])

        # 2) Fresh RSS (11-20) is NOT marked stale_feed even though PubMed has 11-23
        res = by_id['32842866a59f']
        self.assertEqual(res['status'], 'ok')
        self.assertNotIn('staleFeed', res)

        # 3) Stale RSS (2025-12-16) with NO <=14d articles in PubMed or Crossref is NOT marked stale_feed
        cqo = by_id['61f098db86f8']
        self.assertEqual(cqo['status'], 'filtered_empty')
        self.assertNotIn('staleFeed', cqo)

    def test_crossref_serves_as_alternative_and_merge_does_not_disable_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            library = {
                'feeds': [{
                    'id': 'ac328fb71433',
                    'name': 'Circulation',
                    'url': 'https://www.ahajournals.org/action/showFeed?type=axatoc&feed=rss&jc=circ',
                    'enabled': True,
                }]
            }
            (root / 'data/library.json').write_text(json.dumps(library), encoding='utf-8')
            (root / 'data/feeds.json').write_text(json.dumps({'items': []}), encoding='utf-8')
            (root / 'data/pubmed.json').write_text(
                json.dumps({'items': [], 'fetched': 0, 'totalHits': 0, 'truncated': False, 'journals': ['Circulation']}),
                encoding='utf-8',
            )
            (root / 'data/crossref.json').write_text(
                json.dumps({
                    'fetched': 1,
                    'apiCalls': 1,
                    'pagesFetched': 1,
                    'journals': ['Circulation'],
                    'items': [{
                        'id': 'cr-1',
                        'doi': '10.1161/circulationaha.126.000001',
                        'title': 'Randomized trial of anticoagulation in atrial fibrillation',
                        'url': 'https://doi.org/10.1161/circulationaha.126.000001',
                        'journal': 'Circulation',
                        'date': '2026-11-22T00:00:00+00:00',
                        'datePrecision': 'day',
                        'category': '心血管',
                        'summary': '',
                        'abstractStatus': 'missing',
                        'sourceId': 'crossref-journal-fallback',
                    }],
                }),
                encoding='utf-8',
            )
            (root / 'data/source-health.json').write_text(
                json.dumps({
                    'checkedAt': NOW.isoformat(),
                    'sources': [{
                        'id': 'ac328fb71433',
                        'name': 'Circulation',
                        'url': 'https://www.ahajournals.org/action/showFeed?type=axatoc&feed=rss&jc=circ',
                        'status': 'filtered_empty',
                        'latestPublishedAt': '2026-11-03T10:00:08+00:00',
                    }],
                }),
                encoding='utf-8',
            )

            class FixedDateTime(datetime.datetime):
                @classmethod
                def now(cls, tz=None):
                    return NOW if tz else NOW.replace(tzinfo=None)

            with (patch.object(merge_candidates, 'ROOT', root),
                  patch.object(merge_candidates.datetime, 'datetime', FixedDateTime),
                  patch('subprocess.run'),
                  contextlib.redirect_stdout(io.StringIO())):
                merge_candidates.main()

            updated_health = json.loads((root / 'data/source-health.json').read_text(encoding='utf-8'))
            circ = updated_health['sources'][0]
            self.assertEqual(circ['status'], 'stale_feed')
            self.assertEqual(circ['staleFeed']['alternativeSource'], 'Crossref')
            self.assertEqual(circ['staleFeed']['alternativeLatestDate'], '2026-11-22')
            self.assertEqual(circ['staleFeed']['latestItemDate'], '2026-11-03')

            # Never automatically disable the source in data/library.json.
            updated_library = json.loads((root / 'data/library.json').read_text(encoding='utf-8'))
            self.assertTrue(updated_library['feeds'][0]['enabled'])


if __name__ == '__main__':
    unittest.main()
