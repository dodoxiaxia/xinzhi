"""Evidence, identity and public bundle regressions; no publisher requests."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from journal_metrics import load_registry, validate_registry
import build_public
from release_integrity import input_hashes

ROOT = Path(__file__).resolve().parents[1]


class JournalMetricsTests(unittest.TestCase):
    def setUp(self):
        self.registry = load_registry(ROOT)

    def test_verified_numbers_are_evidenced_and_match_the_edition(self):
        verified = [j for j in self.registry['journals'] if j['jif']['status'] == 'verified']
        self.assertEqual(len(verified), 14)
        for row in verified:
            self.assertEqual(row['jif']['year'], 2025)
            self.assertEqual(row['jcr']['releaseYear'], 2026)
            self.assertTrue(row['jif']['sources'])
            self.assertTrue(row['issns'])
        # Public publisher ranks are recorded but do not imply a quartile.
        self.assertFalse(any(c['quartile'] for r in verified for c in r['jcr']['categories']))

    def test_cross_year_and_false_complete_categories_are_rejected(self):
        data = copy.deepcopy(self.registry)
        row = next(r for r in data['journals'] if r['jif']['status'] == 'verified')
        row['jcr']['dataYear'] = 2024
        row['jcr']['releaseYear'] = 2025
        with self.assertRaisesRegex(ValueError, 'mix JIF/JCR years'):
            validate_registry(data)
        data = copy.deepcopy(self.registry)
        row = next(r for r in data['journals'] if r['jcr']['categories'])
        row['jcr']['status'] = 'verified'
        row['jcr']['categoryCoverage'] = 'complete'
        with self.assertRaisesRegex(ValueError, 'all categories/quartiles'):
            validate_registry(data)

    def test_alias_and_issn_collisions_fail_instead_of_selecting_a_journal(self):
        for field, value in [('aliases', [self.registry['journals'][0]['name']]), ('issns', ['2398-6352'])]:
            data = copy.deepcopy(self.registry)
            row = next(r for r in data['journals'] if r['name'] == 'Nature Medicine')
            row[field] = value
            with self.assertRaisesRegex(ValueError, 'Conflicting'):
                validate_registry(data)

    def test_non_journal_and_unproven_numbers_are_rejected(self):
        data = copy.deepcopy(self.registry)
        row = next(r for r in data['journals'] if r['name'] == 'arXiv')
        row['jif'].update(status='verified', value=99, year=2025)
        with self.assertRaisesRegex(ValueError, 'Non-journal'):
            validate_registry(data)
        data = copy.deepcopy(self.registry)
        row = next(r for r in data['journals'] if r['name'] == 'NEJM AI')
        row['jif']['value'] = 0
        with self.assertRaisesRegex(ValueError, 'Unverified JIF'):
            validate_registry(data)

    def test_unknown_private_fields_and_unsigned_evidence_do_not_pass(self):
        data = copy.deepcopy(self.registry)
        data['privateNotes'] = 'synthetic'
        with self.assertRaises(ValueError):
            validate_registry(data)
        data = copy.deepcopy(self.registry)
        data['sources']['nm']['url'] = 'https://example.test/private?token=synthetic'
        with self.assertRaisesRegex(ValueError, 'public HTTPS'):
            validate_registry(data)
        data = copy.deepcopy(self.registry)
        data['sources']['nm']['verifiedAt'] = '2026-10-07T00:00:00'
        with self.assertRaisesRegex(ValueError, 'timezone'):
            validate_registry(data)

    def test_added_registry_input_invalidates_a_release_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            before = input_hashes(root)
            (root/'config').mkdir()
            (root/'config/journal-metrics.json').write_text('{}')
            self.assertNotEqual(input_hashes(root), before)

    def test_existing_per_paper_metric_claims_are_never_trusted(self):
        paper = {'id': 'p', 'journal': 'NEJM AI', 'journalMetrics': {'if': 100, 'quartile': 'Q1'}, 'impactFactor': 100}
        result = build_public.public_paper(paper)
        self.assertNotIn('journalMetrics', result)
        self.assertNotIn('impactFactor', result)


if __name__ == '__main__':
    unittest.main()
