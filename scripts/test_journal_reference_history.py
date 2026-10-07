"""Historical user Q must never acquire current/official metric authority."""
import copy
import unittest
from journal_metrics import load_registry, validate_registry
from journal_reference_history import historical_subset, SOURCE_ID
from test_journal_metrics import ROOT


class ReferenceHistoryTests(unittest.TestCase):
    def setUp(self):
        self.registry = load_registry(ROOT)
        self.history = self.registry['historicalReferences'][0]

    def test_exactly_the_bounded_50_single_category_references_are_separate(self):
        self.assertEqual(len(self.registry['historicalReferences']), 50)
        for h in self.registry['historicalReferences']:
            self.assertEqual((h['dataYear'], h['releaseYear']), (2024, 2025))
            self.assertEqual(h['status'], 'historical_reference_unverified')
            self.assertEqual(h['categoryCoverage'], 'reference_single_category')
            self.assertEqual(h['sources'], [SOURCE_ID])
        ehj = next(j for j in self.registry['journals'] if j['name'] == 'European Heart Journal')
        self.assertEqual((ehj['jif']['year'], ehj['jif']['value']), (2025, 45.6))
        self.assertEqual(ehj['jcr']['dataYear'], 2025)
        self.assertIsNone(ehj['jcr']['categories'][0]['quartile'])
        # These matched multi-category rows had one unmapped Q and stay excluded.
        multi_names = {'Nature Medicine', 'Nature Machine Intelligence', 'npj Digital Medicine'}
        multi_ids = {j['id'] for j in self.registry['journals'] if j['name'] in multi_names}
        self.assertTrue(multi_ids.isdisjoint({h['journalId'] for h in self.registry['historicalReferences']}))

    def test_user_source_cannot_verify_any_official_metric_or_identity(self):
        for field in ('jif', 'identity', 'edition', 'category'):
            data = copy.deepcopy(self.registry)
            row = next(j for j in data['journals'] if j['name'] == 'European Heart Journal')
            if field == 'jif':
                row['jif']['sources'] = [SOURCE_ID]
            elif field == 'identity':
                row['identitySources'] = [SOURCE_ID]
            elif field == 'edition':
                row['jcr']['editionSources'] = [SOURCE_ID]
            else:
                row['jcr']['categories'][0]['sources'] = [SOURCE_ID]
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'cannot verify official'):
                validate_registry(data)

    def test_historical_years_status_coverage_and_identity_cannot_be_promoted(self):
        bad_fields = [('dataYear', 2025), ('releaseYear', 2026), ('status', 'verified'),
                      ('categoryCoverage', 'complete'), ('category', 'Medicine; Biology'),
                      ('quartile', 'Q0'), ('journalId', 'not-a-site-journal')]
        for field, value in bad_fields:
            data = copy.deepcopy(self.registry)
            data['historicalReferences'][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_registry(data)
        data = copy.deepcopy(self.registry)
        data['historicalReferences'][0]['journalId'] = next(j['id'] for j in data['journals'] if j['name'] == 'arXiv')
        with self.assertRaisesRegex(ValueError, 'existing journal identity'):
            validate_registry(data)

    def test_duplicates_private_fields_or_source_links_cannot_enter_public_data(self):
        for change in ('duplicate', 'libraryFileId', 'url', 'sourceYear', 'officialSource'):
            data = copy.deepcopy(self.registry)
            if change == 'duplicate':
                data['historicalReferences'].append(copy.deepcopy(self.history))
            elif change == 'libraryFileId':
                data['historicalReferences'][0]['libraryFileId'] = 'synthetic-private-id'
            elif change == 'url':
                data['sources'][SOURCE_ID]['url'] = 'https://example.test/private.xlsx'
            elif change == 'sourceYear':
                data['sources'][SOURCE_ID]['dataYear'] = 2025
                data['sources'][SOURCE_ID]['releaseYear'] = 2026
            else:
                data['historicalReferences'][0]['sources'] = ['nm']
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_registry(data)

    def report(self):
        h = self.history
        return {'scope': 'rendered_preview_only', 'sourceType': 'user_reference', 'conflicts': [],
                'checkedAt': h['checkedAt'], 'records': [
                    {'journalId': h['journalId'], 'sourceType': 'user_reference', 'scope': 'matched_visible_preview',
                     'verifiedAt': h['checkedAt'], 'libraryFileId': 'synthetic-private', 'fileId': 'synthetic-private',
                     'jif': {'year': 2024, 'releaseYear': 2025, 'value': 99, 'status': 'user_reference_unverified'},
                     'jcr': {'categoriesAsProvided': [h['category']], 'quartileAsProvided': h['quartile'],
                             'status': 'user_reference_unverified', 'quartileScope': 'single_category_reference_only'}}]}

    def test_extraction_omits_old_jif_private_provenance_and_unmapped_multicategory_q(self):
        report = self.report()
        multi = copy.deepcopy(report['records'][0])
        multi['jcr'].update(categoriesAsProvided=['Medicine', 'Biology'], quartileScope='unmapped_multiple_categories')
        report['records'].extend([multi, {'jif': None, 'jcr': None}])
        result = historical_subset(report, self.registry)
        self.assertEqual(len(result['historicalReferences']), 1)
        self.assertEqual(set(result['historicalReferences'][0]), set(self.history))
        self.assertIsNone(result['sources'][SOURCE_ID]['url'])
        self.assertNotIn('jif', result['historicalReferences'][0])
        self.assertNotIn('libraryFileId', result['historicalReferences'][0])

    def test_extraction_requires_explicit_bounded_year_and_single_category_semantics(self):
        for change in ('scope', 'year', 'categories', 'conflict', 'duplicate'):
            report = self.report()
            if change == 'scope':
                report['scope'] = 'complete_workbook'
            elif change == 'year':
                report['records'][0]['jif']['year'] = 2025
            elif change == 'categories':
                report['records'][0]['jcr']['categoriesAsProvided'].append('Biology')
            elif change == 'conflict':
                report['conflicts'] = ['identity conflict']
            else:
                report['records'].append(copy.deepcopy(report['records'][0]))
            with self.subTest(change=change), self.assertRaises(ValueError):
                historical_subset(report, self.registry)

    def test_original_schema_without_history_remains_valid(self):
        data = copy.deepcopy(self.registry)
        del data['historicalReferences']
        del data['sources'][SOURCE_ID]
        validate_registry(data)


if __name__ == '__main__':
    unittest.main()
