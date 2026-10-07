"""Reference previews remain private, incomplete and separate from official data."""
import copy
import csv
import io
import unittest
from pathlib import Path
from audit_journal_references import audit_snippets
from journal_metrics import load_registry


def snippet(fields, line=4):
    output = io.StringIO()
    csv.writer(output).writerow(fields)
    return {'start_line': line, 'content': output.getvalue().strip()}


class ReferenceAuditTests(unittest.TestCase):
    def setUp(self):
        self.registry = load_registry(Path(__file__).resolve().parents[1])
        self.input = {'scope': 'rendered_preview_only', 'checkedAt': '2026-10-07T00:00:00Z', 'files': []}

    def add_file(self, filename, matches):
        self.input['files'].append({'name': filename, 'library_file_id': 'synthetic-'+filename,
                                   'file_id': 'synthetic-file', 'matches': matches})

    def test_multiple_categories_never_receive_a_repeated_summary_quartile(self):
        before = copy.deepcopy(self.registry)
        self.add_file('reference.xlsx', [snippet(['0', 'npj Digital Medicine', '2398-6352', '2398-6352',
                    'CATEGORY A(SCIE);CATEGORY B(SCIE)', '10', '1.0', 'Q2', '2/8', 'Q3'])])
        report = audit_snippets(self.input, self.registry)
        row = report['records'][0]
        self.assertEqual(row['jcr']['quartileScope'], 'unmapped_multiple_categories')
        self.assertEqual(row['jcr']['categoriesAsProvided'], ['CATEGORY A(SCIE)', 'CATEGORY B(SCIE)'])
        self.assertEqual(row['jcr']['quartileAsProvided'], 'Q2')
        self.assertEqual(row['jif']['year'], 2024)
        self.assertEqual(row['jif']['releaseYear'], 2025)
        self.assertEqual(row['officialComparison']['jifYear'], 2025)
        self.assertFalse(row['publicUse'])
        self.assertEqual(self.registry, before)

    def test_cas_sheet_is_excluded_and_visible_preview_is_not_full_coverage(self):
        self.add_file('reference.xlsx', [snippet(['0', 'Nature Medicine', '1', '是', '是'], line=1007)])
        report = audit_snippets(self.input, self.registry)
        self.assertEqual(report['counts']['CASRowsExcluded'], 1)
        self.assertEqual(report['records'], [])
        self.assertFalse(report['completeWorkbookRead'])
        self.assertIn('预览未命中', report['notice'])

    def test_index_categories_do_not_become_jif_or_jcr_quartiles(self):
        self.add_file('SCIE目录.csv', [snippet(['0', 'Nature Medicine', '1078-8956', '1546-170X',
                    'Publisher', 'Address', 'English', 'Field A | Field B'])])
        row = audit_snippets(self.input, self.registry)['records'][0]
        self.assertIsNone(row['jif']); self.assertIsNone(row['jcr'])
        self.assertEqual(row['indexSnapshotDate'], '2025-05-19')
        self.assertEqual(row['sourceType'], 'user_reference')

    def test_conflicting_name_and_issn_are_not_silently_matched(self):
        self.add_file('SCIE目录.csv', [snippet(['0', 'Nature Medicine', '2398-6352', '',
                    'Publisher', 'Address', 'English', 'Field A'])])
        report = audit_snippets(self.input, self.registry)
        self.assertEqual(report['records'], [])
        self.assertEqual(report['conflicts'][0]['reason'], 'identity_conflict')

    def test_preview_scope_is_mandatory_and_duplicate_snippets_are_deduplicated(self):
        with self.assertRaises(ValueError):
            audit_snippets({'scope': 'full_workbook'}, self.registry)
        row = snippet(['0', 'European Heart Journal', '0195-668X', '1522-9645',
                    'CARDIAC(SCIE)', '10', '1.0', 'Q2', '2/8', 'Q3'])
        self.add_file('reference.xlsx', [row, row])
        self.assertEqual(audit_snippets(self.input, self.registry)['counts']['matchedRecords'], 1)


if __name__ == '__main__':
    unittest.main()
