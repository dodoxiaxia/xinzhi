"""Offline tests for priority-journal reconciliation and automated download task planning."""
import datetime
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import merge_candidates
import pdf_identity
import reconcile_priority_journal_tasks as rpjt

NOW = datetime.datetime(2026, 11, 24, 18, 0, tzinfo=datetime.timezone.utc)


def write_fixture_root(root, *, config_data=None, public_papers=None, private_rows=None,
                       pubmed_items=None, feed_items=None, tasks=None):
    for rel in ('config', 'data', 'editorial'):
        (root / rel).mkdir(parents=True, exist_ok=True)
    if config_data is None:
        (root / 'config/priority_journal_tasks.json').write_text(
            rpjt.CONFIG_PATH.read_text(encoding='utf-8'), encoding='utf-8'
        )
    else:
        (root / 'config/priority_journal_tasks.json').write_text(
            json.dumps(config_data, ensure_ascii=False, indent=2), encoding='utf-8'
        )
    (root / 'editorial/public_library_snapshot.json').write_text(
        json.dumps({'papers': public_papers or []}, ensure_ascii=False), encoding='utf-8'
    )
    (root / 'config/pdf_index_keys.json').write_text(
        json.dumps(pdf_identity.build_snapshot(private_rows or [], today=NOW.date()), ensure_ascii=False),
        encoding='utf-8',
    )
    if pubmed_items is not None:
        (root / 'data/pubmed.json').write_text(
            json.dumps({'items': pubmed_items, 'fetched': len(pubmed_items), 'totalHits': len(pubmed_items),
                        'truncated': False, 'journals': ['NEJM AI']}, ensure_ascii=False),
            encoding='utf-8',
        )
    if feed_items is not None:
        (root / 'data/feeds.json').write_text(
            json.dumps({'items': feed_items}, ensure_ascii=False), encoding='utf-8'
        )
    if tasks is not None:
        tasks_path = root / 'tasks.json'
        tasks_path.write_text(json.dumps({'tasks': tasks}, ensure_ascii=False), encoding='utf-8')
        return tasks_path
    return None


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        self.guards = [
            patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')),
            patch('socket.create_connection', side_effect=AssertionError('Network forbidden')),
        ]
        for guard in self.guards:
            guard.start()
            self.addCleanup(guard.stop)


class PriorityJournalTaskTests(OfflineTestCase):
    def test_config_enforces_45_day_minimum_and_cap_bounds(self):
        cfg = rpjt.load_config(rpjt.CONFIG_PATH)
        self.assertGreaterEqual(cfg['reconcileWindowDays'], 45)
        self.assertLessEqual(cfg['dailyCap'], 20)
        self.assertEqual(cfg['defaultAllowedTypes'], ['research', 'review'])
        nejm = next(j for j in cfg['journals'] if j['journal'] == 'NEJM AI')
        self.assertEqual(nejm['issns'], ['2836-9386'])
        self.assertTrue(nejm['enabled'])
        self.assertGreaterEqual(nejm['reconcileWindowDays'], 45)

        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / 'bad.json'
            raw = json.loads(rpjt.CONFIG_PATH.read_text(encoding='utf-8'))
            raw['reconcileWindowDays'] = 14
            bad.write_text(json.dumps(raw), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '45'):
                rpjt.load_config(bad)

            raw = json.loads(rpjt.CONFIG_PATH.read_text(encoding='utf-8'))
            raw['dailyCap'] = 25
            bad.write_text(json.dumps(raw), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'dailyCap'):
                rpjt.load_config(bad)

    def test_45_day_window_is_separate_from_14_day_public_feed_window(self):
        works = [
            {
                'DOI': '10.1056/AIoa2600112',
                'title': ['Recent randomized evaluation within 14 days'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 16]]},
            },
            {
                'DOI': '10.1056/AIoa2600537',
                'title': ['Older research paper at day 33 within 45-day window'],
                'type': 'journal-article',
                'published-print': {'date-parts': [[2026, 10, 22]]},
                'issued': {'date-parts': [[2026, 10, 22]]},
            },
            {
                'DOI': '10.1056/AIoa2500999',
                'title': ['Expired paper at day 60 outside 45-day window'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 9, 25]]},
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture_root(root)
            (root / 'data/feeds.json').write_text(json.dumps({'items': [
                {
                    'id': 'rss-1',
                    'title': 'Recent randomized evaluation within 14 days',
                    'url': 'https://ai.nejm.org/doi/full/10.1056/AIoa2600112',
                    'doi': '10.1056/AIoa2600112',
                    'journal': 'NEJM AI',
                    'date': '2026-11-16T00:00:00+00:00',
                    'datePrecision': 'day',
                    'category': 'AI医疗',
                },
                {
                    'id': 'rss-2',
                    'title': 'Older research paper at day 33 within 45-day window',
                    'url': 'https://ai.nejm.org/doi/full/10.1056/AIoa2600537',
                    'doi': '10.1056/AIoa2600537',
                    'journal': 'NEJM AI',
                    'date': '2026-10-22T00:00:00+00:00',
                    'datePrecision': 'day',
                    'category': 'AI医疗',
                },
            ]}), encoding='utf-8')
            (root / 'data/pubmed.json').write_text(
                json.dumps({'items': [], 'fetched': 0, 'totalHits': 0, 'truncated': False, 'journals': []}),
                encoding='utf-8',
            )
            (root / 'data/source-health.json').write_text(json.dumps({'sources': []}), encoding='utf-8')
            (root / 'data/doi-resolve.json').write_text('{}', encoding='utf-8')

            class FixedDateTime(datetime.datetime):
                @classmethod
                def now(cls, tz=None):
                    return NOW if tz else NOW.replace(tzinfo=None)

            with (patch.object(merge_candidates, 'ROOT', root),
                  patch.object(merge_candidates.datetime, 'datetime', FixedDateTime),
                  patch('subprocess.run')):
                merge_candidates.main()
            public_merged = json.loads((root / 'data/candidates.json').read_text(encoding='utf-8'))
            self.assertEqual([row['doi'] for row in public_merged['items']], ['10.1056/AIoa2600112'])

            calls = []
            report = rpjt.reconcile(
                root,
                now=NOW,
                crossref_fetcher=lambda params: calls.append(params) or {'message': {'items': works}},
                sleep=lambda _: None,
            )
            self.assertIn('from-pub-date:2026-10-10', calls[0]['filter'])
            selected_dois = {item['doi'] for item in report['registerItems']}
            self.assertEqual(selected_dois, {'10.1056/aioa2600112', '10.1056/aioa2600537'})

    def test_idempotency_across_tasks_public_library_and_private_index(self):
        works = [
            {
                'DOI': '10.1056/AIoa2600136',
                'title': ['Already in private AI- index'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 16]]},
            },
            {
                'DOI': '10.1056/AIoa2600258',
                'title': ['Already in public site library'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 15]]},
            },
            {
                'DOI': '10.1056/AIoa2600537',
                'title': ['Already has a download task'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 14]]},
            },
            {
                'DOI': '10.1056/AIoa2600590',
                'title': ['Brand new original article needing download task'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 16]]},
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tasks_file = write_fixture_root(
                root,
                public_papers=[{'doi': 'https://doi.org/10.1056/AIoa2600258', 'title': 'Already in public site library'}],
                private_rows=[{
                    '题名': 'Already in private AI- index',
                    'DOI': '10.1056/AIoa2600136',
                    '当前路径': 'nejm/2026/a.pdf',
                    'SHA256': 'a' * 64,
                }],
                tasks=[{'doi': '10.1056/aioa2600537', 'state': 'to-download'}],
            )
            report = rpjt.reconcile(
                root,
                now=NOW,
                tasks_file=tasks_file,
                crossref_fetcher=lambda params: {'message': {'items': works}},
                sleep=lambda _: None,
            )
            self.assertEqual([item['doi'] for item in report['registerItems']], ['10.1056/aioa2600590'])
            self.assertEqual(report['summary']['skippedPrivateIndex'], 1)
            self.assertEqual(report['summary']['skippedPublicLibrary'], 1)
            self.assertEqual(report['summary']['skippedExistingTask'], 1)

    def test_type_filtering_and_per_journal_allowlist_and_rss_bad_doi_skip(self):
        works = [
            {
                'DOI': '10.1056/AIoa2600590',
                'title': ['Original Research: Clinical AI Validation'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 16]]},
            },
            {
                'DOI': '10.1056/AIra2600064',
                'title': ['A Meta-Research Review of Statistical Practices'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 16]]},
            },
            {
                'DOI': '10.1056/AIltr2601100',
                'title': ['Preserving Clinical Judgment in AI-Assisted Diagnosis'],
                'type': 'journal-article',
                'published-print': {'date-parts': [[2026, 10, 22]]},
            },
            {
                'DOI': '10.1056/AIe2601363',
                'title': ['Design is Everything'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 6]]},
            },
            {
                'DOI': '10.1056/AIcs2600997',
                'title': ['AI-Assisted Molecular Review Refines SMO Inhibitor Candidacy'],
                'type': 'journal-article',
                'published-print': {'date-parts': [[2026, 10, 22]]},
            },
            {
                'DOI': '10.1056/AIoa2609991',
                'title': ['Correction: Clinical AI Validation'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 18]]},
            },
            {
                'DOI': '10.1056/AIoa2609992',
                'title': ['Retraction of: Prior AI Study'],
                'type': 'retraction',
                'published-online': {'date-parts': [[2026, 11, 18]]},
            },
            {
                'DOI': '10.1056/AIoa2609993',
                'title': ['[Correspondence] Response to AI Study'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 18]]},
            },
        ]
        feed_items = [
            {
                'id': 'bad-at',
                'title': 'How We Do It: Framework Entry With Composite Issue DOI',
                'url': 'https://ai.nejm.org/doi/full/10.1056/AI-S2601250%4010.1056/ai_2026.3.issue-11',
                'doi': '10.1056/AI-S2601250%4010.1056/ai_2026.3.issue-11',
                'journal': 'NEJM AI',
                'date': '2026-10-22T00:00:00+00:00',
            },
            {
                'id': 'rss-only-research',
                'title': 'RSS-Only Research Paper Not Yet In Crossref',
                'url': 'https://ai.nejm.org/doi/full/10.1056/AIoa2608888',
                'doi': '10.1056/AIoa2608888',
                'journal': 'NEJM AI',
                'date': '2026-11-20T00:00:00+00:00',
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture_root(root, feed_items=feed_items)
            report = rpjt.reconcile(
                root,
                now=NOW,
                crossref_fetcher=lambda params: {'message': {'items': works}},
                sleep=lambda _: None,
            )
            got = {item['doi'] for item in report['registerItems']}
            self.assertEqual(got, {'10.1056/aioa2600590', '10.1056/aira2600064', '10.1056/aioa2608888'})
            self.assertGreaterEqual(report['summary']['invalidDoiOrTitle'], 1)

            # Per-journal override: allow case_study in addition to research & review.
            cfg = json.loads(rpjt.CONFIG_PATH.read_text(encoding='utf-8'))
            cfg['journals'][0]['allowedTypes'] = ['research', 'review', 'case_study']
            (root / 'config/priority_journal_tasks.json').write_text(json.dumps(cfg), encoding='utf-8')
            report_override = rpjt.reconcile(
                root,
                now=NOW,
                crossref_fetcher=lambda params: {'message': {'items': works}},
                sleep=lambda _: None,
            )
            got_override = {item['doi'] for item in report_override['registerItems']}
            self.assertIn('10.1056/aics2600997', got_override)

    def test_aix2601439_pubmed_erratum_tag_alone_does_not_exclude(self):
        works = [
            {
                'DOI': '10.1056/AIx2601439',
                'title': ['FDA-Authorized AI/ML Tool for Sepsis Prediction: Development and Validation'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 19]]},
            },
            {
                'DOI': '10.1056/AIoa2609001',
                'title': ['Real Erratum Identified By Crossref Update-To'],
                'type': 'journal-article',
                'update-to': [{'type': 'correction', 'DOI': '10.1056/AIoa2400001'}],
                'published-online': {'date-parts': [[2026, 11, 19]]},
            },
        ]
        pubmed_items = [
            {
                'doi': '10.1056/AIx2601439',
                'pmid': '43055642',
                'title': 'FDA-Authorized AI/ML Tool for Sepsis Prediction: Development and Validation.',
                'pubTypes': ['Journal Article', 'Published Erratum'],
                'pubmedRelations': [{'type': 'ErratumFor', 'pmid': '42932770'}],
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture_root(root, pubmed_items=pubmed_items)
            report = rpjt.reconcile(
                root,
                now=NOW,
                crossref_fetcher=lambda params: {'message': {'items': works}},
                sleep=lambda _: None,
            )
            self.assertEqual([item['doi'] for item in report['registerItems']], ['10.1056/aix2601439'])
            self.assertEqual(report['summary']['pubmedNoticeIgnoredCount'], 1)
            decision = next(d for d in report['decisions'] if d['doi'] == '10.1056/aix2601439')
            self.assertEqual(decision['articleType'], 'research')
            self.assertTrue(decision['pubmedNoticeIgnored'])
            self.assertEqual(decision['action'], 'selected')

    def test_daily_cap_and_cumulative_state_and_register_mode(self):
        works = [
            {
                'DOI': f'10.1056/AIoa260{i:04d}',
                'title': [f'Clinical AI Study Number {i:02d}'],
                'type': 'journal-article',
                'published-online': {'date-parts': [[2026, 11, 1 + (i % 20)]]},
            }
            for i in range(1, 26)
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture_root(root)
            tok_path = root / 'fake.token'
            tok_path.write_text('test_placeholder_machine_token_value_for_unit_test_12345\n', encoding='utf-8')
            os.chmod(tok_path, 0o600)

            submitted_batches = []

            def fake_register(token, items):
                submitted_batches.append(items)
                # Register first 15, skip none
                return 200, {
                    'ok': True,
                    'results': [{'doi': row['doi'], 'result': 'registered'} for row in items],
                }, 1, None

            with patch.dict(os.environ, {'XINZHI_MACHINE_TOKEN_FILE': str(tok_path)}):
                first = rpjt.reconcile(
                    root,
                    now=NOW,
                    daily_cap_override=15,
                    tasks_file=write_fixture_root(root, tasks=[]),
                    crossref_fetcher=lambda params: {'message': {'items': works}},
                    sleep=lambda _: None,
                    register=True,
                    register_fn=fake_register,
                )
                self.assertEqual(len(first['registerItems']), 15)
                self.assertEqual(first['summary']['cappedCount'], 10)
                self.assertEqual(first['summary']['registeredCount'], 15)
                # Newest dates (Nov 20 down to Nov 13/...) prioritized first.
                self.assertEqual(first['decisions'][0]['date'], '2026-11-20')

                # Second run the same day with cap=20 only has 5 remaining daily slots!
                second = rpjt.reconcile(
                    root,
                    now=NOW,
                    daily_cap_override=20,
                    tasks_file=root / 'tasks.json',
                    crossref_fetcher=lambda params: {'message': {'items': works}},
                    sleep=lambda _: None,
                    register=True,
                    register_fn=fake_register,
                )
                self.assertEqual(second['alreadySubmittedToday'], 15)
                self.assertEqual(second['remainingDailyCap'], 5)
                self.assertEqual(len(second['registerItems']), 5)
                self.assertEqual(second['summary']['registeredCount'], 5)

                # Third run the same day: daily cap exhausted (20/20).
                third = rpjt.reconcile(
                    root,
                    now=NOW,
                    daily_cap_override=20,
                    tasks_file=root / 'tasks.json',
                    crossref_fetcher=lambda params: {'message': {'items': works}},
                    sleep=lambda _: None,
                    register=True,
                    register_fn=fake_register,
                )
                self.assertEqual(third['remainingDailyCap'], 0)
                self.assertEqual(third['registerItems'], [])
                self.assertEqual(len(submitted_batches), 2)

    def test_crossref_error_degrades_gracefully_without_failing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture_root(root)
            report = rpjt.reconcile(
                root,
                now=NOW,
                crossref_fetcher=lambda params: (_ for _ in ()).throw(TimeoutError('crossref timeout')),
                sleep=lambda _: None,
            )
            self.assertTrue(report['summary']['degraded'])
            self.assertEqual(report['registerItems'], [])


    def test_live_rss_parser_and_malformed_issue_doi_handling(self):
        rss_xml = b'''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>NEJM AI</title>
    <item>
      <title>How We Do It: Composite Issue Link</title>
      <link>https://ai.nejm.org/doi/full/10.1056/AI-S2601250%4010.1056/ai_2026.3.issue-11?af=R</link>
      <dc:date>2026-10-22T04:00:00Z</dc:date>
    </item>
    <item>
      <title>RSS Only Original Research Article</title>
      <link>https://ai.nejm.org/doi/full/10.1056/AIoa2607777?af=R</link>
      <dc:date>2026-11-22T04:00:00Z</dc:date>
    </item>
  </channel>
</rss>'''
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture_root(root)
            report = rpjt.reconcile(
                root,
                now=NOW,
                crossref_fetcher=lambda params: {'message': {'items': []}},
                rss_fetcher=lambda url: (rss_xml, url),
                fetch_rss=True,
                sleep=lambda _: None,
            )
            self.assertFalse(report['summary']['degraded'])
            self.assertEqual([row['doi'] for row in report['registerItems']], ['10.1056/aioa2607777'])


if __name__ == '__main__':
    unittest.main()
