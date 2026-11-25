"""Offline tests for Crossref journal-level incremental fallback."""
import datetime
import io
import json
import socket
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import build_public
import fetch_crossref_fallback as fcf
import merge_candidates
from scope_filter import scope_decision

FIXTURE_PATH = Path(__file__).resolve().parent / 'fixtures/crossref-cvd-1110-1125.json'
NOW = datetime.datetime(2026, 11, 24, 12, 0, tzinfo=datetime.timezone.utc)


def write_min_root(root, sources):
    (root / 'config').mkdir(parents=True, exist_ok=True)
    (root / 'data').mkdir(parents=True, exist_ok=True)
    (root / 'config/crossref_fallback.json').write_text(
        fcf.CONFIG_PATH.read_text(encoding='utf-8'), encoding='utf-8'
    )
    (root / 'data/source-health.json').write_text(
        json.dumps({'checkedAt': NOW.isoformat(), 'sources': sources}, ensure_ascii=False),
        encoding='utf-8',
    )


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        self.guards = [
            patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')),
            patch('socket.create_connection', side_effect=AssertionError('Network forbidden')),
        ]
        for guard in self.guards:
            guard.start()
            self.addCleanup(guard.stop)


class CrossrefFallbackTests(OfflineTestCase):
    def test_real_cvd_fixture_ingests_all_entries_marks_missing_abstract_and_deduplicates_pubmed(self):
        fixture = json.loads(FIXTURE_PATH.read_text(encoding='utf-8'))
        fixture_items = fixture['message']['items']
        fixture_dois = {row['DOI'].lower() for row in fixture_items}
        missing_abs_dois = {row['DOI'].lower() for row in fixture_items if not (row.get('abstract') or '').strip()}
        self.assertTrue(missing_abs_dois)
        self.assertIn('10.1186/s12933-026-03434-3', fixture_dois)
        self.assertIn('10.1186/s12933-026-03451-2', fixture_dois)
        self.assertIn('10.1186/s12933-026-03442-3', fixture_dois)

        sources = [
            {
                'id': '3b5070cccfc6',
                'name': 'Cardiovascular Diabetology',
                'url': 'https://cardiab.biomedcentral.com/articles/most-recent/rss.xml',
                'status': 'not_feed',
            },
            {
                'id': '2748ce902a2a',
                'name': 'Cardiovascular Diabetology',
                'url': 'https://pubmed.ncbi.nlm.nih.gov/rss/search/example/?limit=50',
                'status': 'ok',
            },
            {
                'id': 'annals-healthy',
                'name': 'Annals of Internal Medicine',
                'url': 'https://www.acpjournals.org/action/showFeed?type=etoc&feed=rss&jc=aim',
                'status': 'ok',
            },
        ]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_root(root, sources)
            calls = []

            def fake_fetch(params):
                calls.append(params)
                return fixture

            out = fcf.run(root, now=NOW, fetcher=fake_fetch, sleep=lambda _: None)

            # Only Cardiovascular Diabetology triggered; Annals IM publisher RSS is healthy.
            self.assertEqual(len(calls), 1)
            self.assertIn('issn:1475-2840', calls[0]['filter'])
            self.assertIn('from-pub-date:2026-11-10', calls[0]['filter'])
            self.assertIn('@', calls[0]['mailto'])
            self.assertEqual(calls[0]['cursor'], '*')

            # Every article in the real 11-10..11-25 Crossref fixture must enter crossref.json.
            got_by_doi = {item['doi']: item for item in out['items']}
            self.assertEqual(set(got_by_doi), fixture_dois)

            # Missing-abstract items are kept and explicitly marked with abstractStatus == 'missing'.
            for doi in missing_abs_dois:
                self.assertEqual(got_by_doi[doi]['abstractStatus'], 'missing')
                self.assertEqual(got_by_doi[doi]['summary'], '')
                self.assertEqual(got_by_doi[doi]['abstractSections'], [])

            # Call volume written into source-health.json and preserved by public_health().
            health = json.loads((root / 'data/source-health.json').read_text(encoding='utf-8'))
            self.assertEqual(health['crossrefFetch']['apiCalls'], len(calls))
            self.assertEqual(health['crossrefFetch']['pagesFetched'], 1)
            self.assertEqual(health['crossrefFetch']['itemsFetched'], len(fixture_items))
            self.assertEqual(health['crossrefFetch']['triggeredJournals'], ['Cardiovascular Diabetology'])
            pub_row = next(r for r in health['sources'] if r['id'] == '3b5070cccfc6')
            self.assertEqual(pub_row['crossrefFallback']['apiCalls'], 1)
            self.assertEqual(pub_row['crossrefFallback']['observedItems'], len(fixture_items))

            projected = build_public.public_health(pub_row, {'items': [], 'journals': []}, NOW)
            self.assertEqual(projected['crossrefFallback']['apiCalls'], 1)

            # Merge with PubMed already holding 03434-3: PubMed record wins, no duplicate, new items enter candidates.
            pubmed_03434 = {
                'id': 'pmid-43099999',
                'pmid': '43099999',
                'doi': '10.1186/s12933-026-03434-3',
                'title': 'Diabetes mellitus and 10-year clinical outcomes after percutaneous coronary intervention: a nationwide cohort study',
                'url': 'https://pubmed.ncbi.nlm.nih.gov/43099999/',
                'journal': 'Cardiovascular Diabetology',
                'date': '2026-11-11T00:00:00+00:00',
                'datePrecision': 'day',
                'category': '心血管',
                'summary': 'PubMed structured abstract text.',
                'abstractStatus': 'available',
                'sourceId': 'pubmed-fallback',
            }
            (root / 'data/feeds.json').write_text(json.dumps({'items': []}), encoding='utf-8')
            (root / 'data/pubmed.json').write_text(
                json.dumps({'items': [pubmed_03434], 'fetched': 1, 'totalHits': 1, 'truncated': False, 'journals': ['Cardiovascular Diabetology']}),
                encoding='utf-8',
            )
            (root / 'data/doi-resolve.json').write_text('{}', encoding='utf-8')

            now_dt = datetime.datetime
            class FixedDateTime(datetime.datetime):
                @classmethod
                def now(cls, tz=None):
                    return NOW if tz else NOW.replace(tzinfo=None)

            with (patch.object(merge_candidates, 'ROOT', root),
                  patch.object(merge_candidates.datetime, 'datetime', FixedDateTime),
                  patch('subprocess.run') as mock_sub):
                merge_candidates.main()
                self.assertEqual(mock_sub.call_count, 1)

            merged = json.loads((root / 'data/candidates.json').read_text(encoding='utf-8'))
            merged_dois = [item['doi'] for item in merged['items']]
            self.assertEqual(merged_dois.count('10.1186/s12933-026-03434-3'), 1)
            winner = next(item for item in merged['items'] if item['doi'] == '10.1186/s12933-026-03434-3')
            self.assertEqual(winner['sourceId'], 'pubmed-fallback')
            self.assertEqual(winner['pmid'], '43099999')

            expected_candidate_dois = {
                item['doi'] for item in out['items']
                if scope_decision(item)['action'] != 'exclude'
            }
            self.assertEqual(set(merged_dois), expected_candidate_dois)
            for doi in ('10.1186/s12933-026-03451-2', '10.1186/s12933-026-03442-3'):
                self.assertIn(doi, merged_dois)
                row = next(item for item in merged['items'] if item['doi'] == doi)
                self.assertEqual(row['abstractStatus'], 'missing')

    def test_imprecise_dates_are_blocked_and_date_priority_is_respected(self):
        works = [
            {
                'DOI': '10.1000/month-only',
                'title': ['Clinical trial with month-only date'],
                'published-online': {'date-parts': [[2026, 11]]},
                'published': {'date-parts': [[2026, 11]]},
                'issued': {'date-parts': [[2026]]},
                'indexed': {'date-parts': [[2026, 11, 23]]},
            },
            {
                'DOI': '10.1000/indexed-only',
                'title': ['Clinical trial with indexed date only'],
                'published-print': {'date-parts': [[2026, 11, 23]]},
                'created': {'date-parts': [[2026, 11, 23]]},
                'indexed': {'date-parts': [[2026, 11, 23]]},
            },
            {
                'DOI': '10.1000/priority-online',
                'title': ['Clinical trial with published-online priority'],
                'published-online': {'date-parts': [[2026, 11, 20]]},
                'published': {'date-parts': [[2026, 11, 22]]},
                'issued': {'date-parts': [[2026, 11, 23]]},
            },
            {
                'DOI': '10.1000/fallback-issued',
                'title': ['Clinical trial falling back to issued day'],
                'published-online': {'date-parts': [[2026, 11]]},
                'issued': {'date-parts': [[2026, 11, 19]]},
            },
        ]
        sources = [{
            'id': 'aim',
            'name': 'Annals of Internal Medicine',
            'url': 'https://www.acpjournals.org/action/showFeed?type=etoc&feed=rss&jc=aim',
            'status': 'http_error',
            'httpStatus': 403,
        }]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_root(root, sources)
            out = fcf.run(
                root,
                now=NOW,
                fetcher=lambda params: {'message': {'total-results': len(works), 'items': works}},
                sleep=lambda _: None,
            )
            by_doi = {item['doi']: item for item in out['items']}
            self.assertNotIn('10.1000/month-only', by_doi)
            self.assertNotIn('10.1000/indexed-only', by_doi)
            self.assertEqual(by_doi['10.1000/priority-online']['date'][:10], '2026-11-20')
            self.assertEqual(by_doi['10.1000/priority-online']['dateBasis'], 'Crossref published-online')
            self.assertEqual(by_doi['10.1000/fallback-issued']['date'][:10], '2026-11-19')
            self.assertEqual(by_doi['10.1000/fallback-issued']['dateBasis'], 'Crossref issued')
            aim_rep = next(r for r in out['journalReports'] if r['journal'] == 'Annals of Internal Medicine')
            self.assertEqual(aim_rep['excludedImpreciseDate'], 2)

    def test_non_allowlisted_and_healthy_journals_are_not_called(self):
        sources = [
            {
                'id': 'natmed',
                'name': 'Nature Medicine',
                'url': 'https://www.nature.com/nm.rss',
                'status': 'not_feed',
            },
            {
                'id': 'circ',
                'name': 'Circulation',
                'url': 'https://www.ahajournals.org/action/showFeed?type=axatoc&feed=rss&jc=circ',
                'status': 'filtered_empty',
            },
            {
                'id': 'cvd-pub',
                'name': 'Cardiovascular Diabetology',
                'url': 'https://cardiab.biomedcentral.com/articles/most-recent/rss.xml',
                'status': 'ok',
            },
            {
                'id': 'aim-pub',
                'name': 'Annals of Internal Medicine',
                'url': 'https://www.acpjournals.org/action/showFeed?type=etoc&feed=rss&jc=aim',
                'status': 'filtered_empty',
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_root(root, sources)
            calls = []
            out = fcf.run(
                root,
                now=NOW,
                fetcher=lambda params: calls.append(params) or {'message': {'total-results': 0, 'items': []}},
                sleep=lambda _: None,
            )
            self.assertEqual(calls, [])
            self.assertEqual(out['apiCalls'], 0)
            self.assertEqual(out['journals'], [])
            health = json.loads((root / 'data/source-health.json').read_text(encoding='utf-8'))
            self.assertEqual(health['crossrefFetch']['status'], 'skipped')
            self.assertEqual(health['crossrefFetch']['apiCalls'], 0)

    def test_http_429_and_timeout_degrade_without_failing_and_cap_pages_at_3(self):
        sources = [
            {
                'id': 'cvd',
                'name': 'Cardiovascular Diabetology',
                'url': 'https://cardiab.biomedcentral.com/articles/most-recent/rss.xml',
                'status': 'not_feed',
            },
            {
                'id': 'aim',
                'name': 'Annals of Internal Medicine',
                'url': 'https://www.acpjournals.org/action/showFeed?type=etoc&feed=rss&jc=aim',
                'status': 'http_error',
                'httpStatus': 403,
            },
        ]
        cached_item = {
            'id': 'crossref-cached',
            'doi': '10.1186/s12933-026-03451-2',
            'title': 'Cached paper',
            'journal': 'Cardiovascular Diabetology',
            'date': '2026-11-24T00:00:00+00:00',
            'datePrecision': 'day',
            'category': '心血管',
            'abstractStatus': 'missing',
            'summary': '',
            'url': 'https://doi.org/10.1186/s12933-026-03451-2',
            'sourceId': 'crossref-journal-fallback',
        }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_root(root, sources)
            (root / 'data/crossref.json').write_text(
                json.dumps({'items': [cached_item]}), encoding='utf-8'
            )

            # 1) HTTP 429 on first journal degrades, reuses cache, and skips second journal.
            calls = []
            def raise_429(params):
                calls.append(params)
                raise urllib.error.HTTPError('https://api.crossref.org/works', 429, 'Too Many Requests', {}, io.BytesIO(b''))

            out_429 = fcf.run(root, now=NOW, fetcher=raise_429, sleep=lambda _: None)
            self.assertEqual(len(calls), 1)
            self.assertTrue(out_429['degraded'])
            self.assertEqual([item['doi'] for item in out_429['items']], [cached_item['doi']])
            health = json.loads((root / 'data/source-health.json').read_text(encoding='utf-8'))
            self.assertEqual(health['crossrefFetch']['status'], 'degraded')
            self.assertEqual(health['crossrefFetch']['apiCalls'], 1)
            cvd_fb = next(r for r in health['sources'] if r['id'] == 'cvd')['crossrefFallback']
            self.assertEqual(cvd_fb['errorCategory'], 'crossref_http_429')
            self.assertEqual(cvd_fb['httpStatus'], 429)
            self.assertTrue(cvd_fb['reusedPrevious'])

            # 2) Timeout degrades cleanly without raising.
            def raise_timeout(params):
                raise TimeoutError('timed out')

            out_to = fcf.run(root, now=NOW, fetcher=raise_timeout, sleep=lambda _: None)
            self.assertTrue(out_to['degraded'])
            health_to = json.loads((root / 'data/source-health.json').read_text(encoding='utf-8'))
            aim_fb = next(r for r in health_to['sources'] if r['id'] == 'aim')['crossrefFallback']
            self.assertEqual(aim_fb['errorCategory'], 'crossref_timeout')

            # 3) Pagination hard cap: max 3 pages per journal even if more cursors exist.
            page_calls = []
            def four_pages(params):
                page_calls.append(params['cursor'])
                return {
                    'message': {
                        'total-results': 400,
                        'next-cursor': f'cursor-{len(page_calls)}',
                        'items': [{
                            'DOI': f'10.1000/p{len(page_calls)}',
                            'title': [f'Clinical study {len(page_calls)}'],
                            'published-online': {'date-parts': [[2026, 11, 24]]},
                        }],
                    }
                }

            write_min_root(root, [sources[0]])
            out_pages = fcf.run(root, now=NOW, fetcher=four_pages, sleep=lambda _: None)
            self.assertEqual(page_calls, ['*', 'cursor-1', 'cursor-2'])
            self.assertEqual(out_pages['pagesFetched'], 3)
            self.assertEqual(out_pages['apiCalls'], 3)


    def test_nejm_ai_is_in_crossref_fallback_allowlist_and_triggers_on_rss_failure(self):
        allowlist = {row['journal']: row for row in fcf.load_allowlist(fcf.CONFIG_PATH)}
        self.assertIn('NEJM AI', allowlist)
        self.assertEqual(allowlist['NEJM AI']['issns'], ['2836-9386'])
        self.assertEqual(allowlist['NEJM AI']['category'], 'AI医疗')
        self.assertTrue(allowlist['NEJM AI']['enabled'])

        sources = [{
            'id': 'nejm-ai-pub',
            'name': 'NEJM AI',
            'url': 'https://ai.nejm.org/action/showFeed?jc=ai&type=etoc&feed=rss',
            'status': 'http_error',
            'httpStatus': 403,
        }]
        works = [
            {
                'DOI': '10.1056/AIoa2600590',
                'title': ['Opportunistic Risk Assessment of Major Osteoporotic Fractures from Routine Chest Radiographs'],
                'published-online': {'date-parts': [[2026, 11, 16]]},
                'type': 'journal-article',
            },
            {
                'DOI': '10.1056/AIoa2600136',
                'title': ['Older than 14 days for public feed'],
                'published-print': {'date-parts': [[2026, 10, 22]]},
                'issued': {'date-parts': [[2026, 10, 22]]},
                'type': 'journal-article',
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_root(root, sources)
            calls = []
            out = fcf.run(
                root,
                now=NOW,
                fetcher=lambda params: calls.append(params) or {'message': {'total-results': len(works), 'items': works}},
                sleep=lambda _: None,
            )
            self.assertEqual(len(calls), 1)
            self.assertIn('issn:2836-9386', calls[0]['filter'])
            self.assertEqual(out['journals'], ['NEJM AI'])
            # Public Crossref fallback keeps its 14-day window separate from 45-day task reconciliation.
            self.assertEqual([item['doi'] for item in out['items']], ['10.1056/aioa2600590'])


if __name__ == '__main__':
    unittest.main()
