"""A reviewable overlay preserves the integrator's registry and existing facts."""
import copy
import json
import unittest
from journal_metrics import load_registry
from journal_public_metrics import apply_observations, apply_identity_observations
from test_journal_metrics import ROOT


class PublicBatch6Tests(unittest.TestCase):
    def setUp(self):
        self.before = load_registry(ROOT)
        self.batch = json.loads((ROOT/'docs/journal-public-observations-batch6-20261007.json').read_text())

    def pending(self):
        return apply_identity_observations(
            apply_observations(self.before, self.batch['observations']),
            self.batch['identityObservations'])

    def test_all_existing_official_journals_and_history_are_preserved(self):
        pending = self.pending(); rows = {r['id']: r for r in pending['journals']}
        self.assertEqual(pending['historicalReferences'], self.before['historicalReferences'])
        for row in self.before['journals']:
            if row['jif']['status'] == 'verified':
                self.assertEqual(rows[row['id']], row)
        self.assertEqual(self.before, load_registry(ROOT))

    def test_jif_is_distinct_from_five_year_if_and_jcr_rank_never_becomes_q(self):
        rows = {r['name']: r for r in self.pending()['journals']}
        self.assertEqual(rows['Science']['jif']['value'], 47.3)
        self.assertEqual(rows['Science Advances']['jif']['value'], 13.9)
        self.assertEqual(rows['Postgraduate Medical Journal']['jif']['value'], 3.6)
        category = rows['Postgraduate Medical Journal']['jcr']['categories'][0]
        self.assertEqual((category['rank'], category['total'], category['quartile']), (64, 336, None))
        self.assertEqual(rows['Journal of Thoracic Disease']['jcr']['categories'], [])
        self.assertEqual(rows['Journal of Thoracic Disease']['jif']['year'], 2025)

    def test_primary_publisher_identity_does_not_promote_unverified_metrics(self):
        rows = {r['name']: r for r in self.pending()['journals']}
        hr = rows['Heart Rhythm']
        self.assertIn('1547-5271', hr['issns'])
        self.assertIn('HeartRhythm', hr['aliases'])
        self.assertEqual(hr['jif']['status'], 'unverified')
        self.assertIn('Circulation: Population Health and Outcomes',
                      rows['Circulation: Cardiovascular Quality and Outcomes']['aliases'])

    def test_alias_conflict_issn_conflict_and_private_identity_fields_fail(self):
        original = self.batch['identityObservations'][0]
        for changes in ({'aliases': ['Nature Medicine']}, {'issns': ['2398-6352']},
                        {'privateFileId': 'synthetic'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                apply_identity_observations(self.before, [{**original, **changes}])

    def test_identity_and_metrics_overlay_is_idempotent(self):
        once = self.pending()
        self.assertEqual(apply_identity_observations(
            apply_observations(once, self.batch['observations']),
            self.batch['identityObservations']), once)


if __name__ == '__main__':
    unittest.main()
