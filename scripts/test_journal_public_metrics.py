"""Offline ingestion guards for bounded official public observations."""
import copy
import json
import unittest
from journal_metrics import load_registry
from journal_public_metrics import apply_observations
from test_journal_metrics import ROOT


class PublicMetricsTests(unittest.TestCase):
    def setUp(self):
        self.observations = json.loads((ROOT/'docs/journal-public-observations-batch1-20261007.json').read_text())['observations']
        self.baseline = copy.deepcopy(load_registry(ROOT))
        # Reconstruct unverified inputs offline; tests also work in release
        # archives and shallow checkouts without any historical Git object.
        from enrich_metadata import _journal_key
        names = {_journal_key(o['name']) for o in self.observations}
        for row in self.baseline['journals']:
            if _journal_key(row['name']) not in names:
                continue
            row['issns'] = []; row['identitySources'] = []
            row['jif'] = {'status': 'unverified', 'value': None, 'year': None,
                          'sources': [], 'verifiedAt': None, 'reason': 'synthetic missing metric'}
            row['jcr'] = {'status': 'unverified', 'dataYear': None, 'releaseYear': None,
                          'editionSources': [], 'categories': [],
                          'categoryCoverage': 'unverified', 'reason': 'synthetic missing metric'}

    def test_prior_official_values_and_all_historical_references_are_preserved(self):
        result = apply_observations(self.baseline, self.observations)
        self.assertEqual(result['historicalReferences'], self.baseline['historicalReferences'])
        rows = {r['id']: r for r in result['journals']}
        for row in self.baseline['journals']:
            if row['jif']['status'] == 'verified':
                self.assertEqual(rows[row['id']], row)
        self.assertEqual(result, load_registry(ROOT))

    def test_rank_does_not_generate_a_quartile_and_every_explicit_category_survives(self):
        result = apply_observations(self.baseline, self.observations)
        rows = {r['name']: r for r in result['journals']}
        self.assertIsNone(rows['European Journal of Heart Failure']['jcr']['categories'][0]['quartile'])
        self.assertEqual(rows['European Journal of Heart Failure']['jcr']['categories'][0]['rank'], 16)
        self.assertEqual([(c['name'], c['quartile']) for c in rows['JMIR AI']['jcr']['categories']],
                         [('Health Care Sciences & Services', 'Q1'), ('Medical Informatics', 'Q1')])
        self.assertEqual(rows['JMIR Medical Informatics']['jcr']['categories'][0]['quartile'], 'Q2')

    def test_duplicate_and_unmatched_names_are_rejected(self):
        for obs in ([self.observations[0]] * 2,
                    [{**self.observations[0], 'name': 'not a site journal'}]):
            with self.assertRaises(ValueError):
                apply_observations(self.baseline, obs)

    def test_existing_verified_values_are_not_silently_overwritten(self):
        obs = {**self.observations[0], 'name': 'Nature Medicine', 'value': 999}
        with self.assertRaisesRegex(ValueError, 'Existing verified JIF differs'):
            apply_observations(self.baseline, [obs])

    def test_future_editions_ambiguous_issns_and_private_fields_are_rejected(self):
        for changes in ({'year': 2026}, {'issns': ['0028-4794']}, {'libraryFileId': 'synthetic'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                apply_observations(self.baseline, [{**self.observations[0], **changes}])

    def test_import_is_idempotent(self):
        once = apply_observations(self.baseline, self.observations)
        self.assertEqual(apply_observations(once, self.observations), once)


if __name__ == '__main__':
    unittest.main()
