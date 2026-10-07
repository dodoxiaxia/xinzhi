"""Real first-batch overlay validation and fail-closed mutation regressions."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from preview_sol_public_overlay import preview, output_target
import week_precompute as w

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'editorial/sol-public-abstract-20261007'


class OverlayContract(unittest.TestCase):
    def setUp(self):
        self.sources = json.loads((BASE / 'sources.json').read_text())
        self.overlay = json.loads((BASE / 'batch-01-cache.json').read_text())

    def test_real_first_three_pass_existing_validators_without_mutation(self):
        original = copy.deepcopy(self.overlay)
        board = preview(self.sources, self.overlay)
        self.assertEqual((board['coverage']['translate'], board['coverage']['quicklook']), (3, 3))
        self.assertEqual(board['coverage']['study'], 0)
        self.assertEqual(self.overlay, original)
        self.assertTrue(all(p['allowAutomaticGeneration'] is False for p in board['items']))

    def test_changed_original_source_fails(self):
        self.sources['items'][0]['abstract'] += ' altered'
        with self.assertRaisesRegex(ValueError, 'source_identity_or_hash'):
            preview(self.sources, self.overlay)

    def test_rehashed_source_rejects_old_overlay(self):
        p = self.sources['items'][0]
        p['abstract'] += ' altered'
        p['sourceHash'] = w.text_hash(p['title'], p['abstract'])
        with self.assertRaisesRegex(ValueError, 'source_not_current'):
            preview(self.sources, self.overlay)

    def test_overlay_has_priority_without_mutating_runtime_cache(self):
        runtime = copy.deepcopy(self.overlay)
        for entry in runtime['entries'].values():
            if entry['task'] == 'translate':
                entry['value']['abstract_zh'] += '（运行时副本）'
        original = copy.deepcopy(runtime)
        board = preview(self.sources, self.overlay, runtime)
        translated = next(p['translation']['abstract_zh'] for p in board['items'] if p['translation'])
        self.assertNotIn('运行时副本', translated)
        self.assertEqual(runtime, original)

    def test_output_rejects_input_collision_ledger_and_outgoing_symlink(self):
        target = BASE / 'test-board.json'
        self.assertEqual(output_target(target, []), target.resolve())
        for output, inputs in [(target, [target]), (BASE / 'sources.json', []),
                               (ROOT / '.local/week-precompute-ledger.json', [])]:
            with self.assertRaisesRegex(ValueError, 'separate_dedicated'):
                output_target(output, inputs)
        with tempfile.TemporaryDirectory(dir=BASE) as directory:
            link = Path(directory) / 'out-board.json'
            link.symlink_to(ROOT / 'data/weekly-board.json')
            with self.assertRaisesRegex(ValueError, 'separate_dedicated'):
                output_target(link, [])

    def test_mismatched_doi_and_pmid_fail(self):
        for field in ('doi', 'pmid'):
            changed = copy.deepcopy(self.overlay)
            next(iter(changed['entries'].values()))[field] = 'wrong'
            with self.assertRaisesRegex(ValueError, 'doi_pmid'):
                preview(self.sources, changed)

    def test_unsupported_number_fails_existing_translation_validator(self):
        entry = next(e for e in self.overlay['entries'].values() if e['task'] == 'translate')
        entry['value']['abstract_zh'] += ' 99999999'
        with self.assertRaisesRegex(ValueError, 'existing_validation'):
            preview(self.sources, self.overlay)

    def test_nonliteral_quote_fails_existing_validator(self):
        entry = next(e for e in self.overlay['entries'].values() if e['task'] == 'quicklook')
        entry['value']['findings'][0]['quote'] = 'This quotation is not present in the public abstract.'
        with self.assertRaisesRegex(ValueError, 'existing_validation'):
            preview(self.sources, self.overlay)

    def test_forged_api_provenance_or_usage_fails(self):
        for field, value in [('origin', 'configured-precompute'),
                             ('modelVersion', 'glm-5.3-flash'),
                             ('providerUsage', {'total_tokens': 0})]:
            changed = copy.deepcopy(self.overlay)
            next(iter(changed['entries'].values()))[field] = value
            with self.assertRaisesRegex(ValueError, 'provenance'):
                preview(self.sources, changed)


if __name__ == '__main__':
    unittest.main()
