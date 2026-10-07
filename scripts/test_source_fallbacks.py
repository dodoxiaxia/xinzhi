"""Offline source health: distinguish observed fallback from configured coverage."""
import datetime
import unittest
import xml.etree.ElementTree as ET

import build_public
import fetch_pubmed
from source_fallbacks import ADDITIONAL_JOURNALS, coverage, journal_query

NOW = datetime.datetime(2026, 10, 7, 8, tzinfo=datetime.timezone.utc)


def snapshot(items=(), journals=(), **extra):
    return {'updatedAt': '2026-10-07T07:22:34+00:00', 'items': list(items),
            'journals': list(journals), 'truncated': True, **extra}


def source(name):
    return {'id': 'test', 'name': name, 'url': 'https://example.org/rss', 'status': 'not_feed'}


class SourceFallbackTests(unittest.TestCase):
    def test_actual_pubmed_titles_match_feed_aliases(self):
        for label, canonical, raw in (
            ('NPJ Digital Medicine', 'npj Digital Medicine', 'NPJ digital medicine'),
            ('Circ Heart Failure', 'Circulation Heart Failure', 'Circulation. Heart failure'),
            ('JACC: CE', 'JACC: Clinical Electrophysiology', 'JACC. Clinical electrophysiology'),
            ('EHJ: Current Issue', 'European Heart Journal', 'European heart journal'),
            ('JAHA', 'Journal of the American Heart Association', 'Journal of the American Heart Association'),
            ('Heart Online First', 'Heart', 'Heart (British Cardiac Society)'),
            ('Progress in Cardio Dis', 'Progress in Cardiovascular Diseases', 'Progress in cardiovascular diseases'),
        ):
            with self.subTest(label=label):
                out = coverage(source(label), snapshot([{'pmid': '1', 'journal': raw, 'date': '2026-10-06'}], [canonical]), NOW)
                self.assertTrue(out['configured'])
                self.assertEqual((out['observedItems'], out['eligibleItems']), (1, 1))

    def test_similar_journal_is_not_false_fallback(self):
        out = coverage(source('Nature Medicine'), snapshot([{'pmid': '1', 'journal': 'npj Digital Medicine'}], ['Nature Medicine']), NOW)
        self.assertEqual(out['status'], 'no_records_observed')
        self.assertEqual(out['observedItems'], 0)
        self.assertTrue(out['queryTruncated'])

    def test_code_configuration_does_not_claim_old_snapshot_coverage(self):
        self.assertIn('Nature Reviews Cardiology', fetch_pubmed.JOURNALS)
        out = coverage(source('Nature Reviews Cardiology'), snapshot(journals=['Nature Medicine']), NOW)
        self.assertFalse(out['configured'])
        self.assertEqual(out['status'], 'not_configured')

    def test_truncated_zero_never_claims_no_new_articles(self):
        out = coverage(source('Nature Reviews Cardiology'), snapshot(journals=['Nature Reviews Cardiology']), NOW)
        self.assertEqual(out['status'], 'no_records_observed')
        self.assertTrue(out['queryTruncated'])

    def test_count_unique_pmids_and_valid_beijing_calendar_dates(self):
        dates = ['2026-09-23', '2026-09-24', '2026-10-07', '2026-10-08', '2026-10', '2026-02-30', '']
        rows = [{'pmid': str(i), 'journal': 'Nature Medicine', 'date': d} for i, d in enumerate(dates)]
        rows.append(dict(rows[1]))
        out = coverage(source('Nature Medicine'), snapshot(rows, ['Nature Medicine']), NOW)
        self.assertEqual((out['observedItems'], out['eligibleItems']), (7, 2))
        midnight = NOW.replace(hour=16)
        out = coverage(source('Nature Medicine'), snapshot(rows, ['Nature Medicine']), midnight)
        self.assertEqual(out['eligibleItems'], 2)  # Sep 25..Oct 8 in Shanghai

    def test_missing_naive_future_and_old_snapshots_are_stale(self):
        for stamp in (None, 'invalid/private/path', '2026-10-07T07:00:00', '2026-10-07T09:00:00Z', '2026-10-07T01:59:59Z'):
            with self.subTest(stamp=stamp):
                out = coverage(source('Nature Medicine'), snapshot(updatedAt=stamp), NOW)
                self.assertTrue(out['stale'])
                if stamp is None or stamp.startswith(('invalid', '2026-10-07T07')):
                    self.assertIsNone(out['checkedAt'])
        self.assertFalse(coverage(source('Nature Medicine'), snapshot(updatedAt='2026-10-07T02:00:00Z'), NOW)['stale'])

    def test_observed_records_can_remain_when_not_configured(self):
        out = coverage(source('Nature Medicine'), snapshot([{'id': '1', 'journal': 'Nature medicine', 'date': '2026-10-07'}]), NOW)
        self.assertFalse(out['configured'])
        self.assertEqual(out['status'], 'records_observed')

    def test_backup_queries_are_bounded_to_watched_journals_and_topics(self):
        self.assertEqual(len(ADDITIONAL_JOURNALS), 8)
        self.assertEqual(len(fetch_pubmed.JOURNALS), len(set(fetch_pubmed.JOURNALS)))
        self.assertEqual(journal_query('Nature Reviews Cardiology'), '"Nature Reviews Cardiology"[Journal]')
        query = journal_query('Nature Communications')
        self.assertIn('"Nature Communications"[Journal] AND ', query)
        self.assertIn('"cardiovascular"[Title/Abstract]', query)
        self.assertIn('"large language model"[Title/Abstract]', query)
        out = coverage(source('Nature Communications'), snapshot(journals=['Nature Communications']), NOW)
        self.assertEqual(out['queryScope'], 'cardiovascular_or_ai')

    def test_pubmed_iso_abbreviation_retained_for_journal_matching(self):
        root = ET.fromstring('<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>Cardiac care</ArticleTitle><Journal><Title>Unknown full name</Title><ISOAbbreviation>Heart Rhythm</ISOAbbreviation></Journal></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>')
        row = fetch_pubmed.parse(root)[0]
        self.assertEqual(row['journalAbbreviation'], 'Heart Rhythm')
        out = coverage(source('Heart Rhythm'), snapshot([row], ['Heart Rhythm']), NOW)
        self.assertEqual(out['observedItems'], 1)

    def test_public_health_preserves_failure_and_strips_new_private_fields(self):
        raw = {**source('Nature Medicine'), 'responseUrl': 'https://user:password@example.org/page?code=private-secret',
               'excludedItems': {'undated': 2, 'future': True, 'olderThan14Days': -1, 'privateNote': 'secret'},
               'privateHtml': 'secret', 'pubmedFallback': {'privateNote': 'secret'}}
        out = build_public.public_health(raw, snapshot([{'pmid': '1', 'journal': 'Nature Medicine', 'date': '2026-10-07'}], ['Nature Medicine']), NOW)
        self.assertEqual(out['status'], 'not_feed')
        self.assertEqual(out['excludedItems'], {'undated': 2})
        self.assertNotIn('privateHtml', out)
        self.assertNotIn('privateNote', out['pubmedFallback'])
        self.assertNotIn('password', out['responseUrl'])
        self.assertNotIn('private-secret', out['responseUrl'])
        self.assertEqual(out['pubmedFallback']['eligibleItems'], 1)


if __name__ == '__main__':
    unittest.main()
