"""Real rolling-board gap and source-bound supplemental overlay regressions."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import week_precompute as w
from preview_sol_public_overlay import preview, output_target
from public_editorial_overlay import apply_board, load_board

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'editorial/sol-public-abstract-20261008-gap'


class GapOverlay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = json.loads((BASE / 'sources.json').read_text())
        cls.cache = json.loads((BASE / 'gap-cache.json').read_text())
        cls.saved = load_board(ROOT)

    def current(self):
        return {'schemaVersion': 1, 'window': copy.deepcopy(self.sources['window']),
                'items': copy.deepcopy(self.sources['items'])}

    def test_current_fixed_six_sources_are_public_exact_and_in_original_window(self):
        missing = [p for p in self.sources['items'] if not p['translation'] or not p['quicklook']]
        self.assertEqual([p['rank'] for p in missing], [15, 16, 21, 22, 23, 24])
        self.assertEqual(self.sources['window']['start'], '2026-10-02')
        self.assertEqual(self.sources['window']['end'], '2026-10-08')
        for p in missing:
            self.assertEqual(w.identity(p), p['paperID'])
            self.assertEqual(w.text_hash(p['title'], p['abstract']), p['sourceHash'])
            self.assertEqual(p['abstractSource'], 'PubMed')
            self.assertTrue(p['abstractSourceUrl'].startswith('https://pubmed.ncbi.nlm.nih.gov/'))
            self.assertGreater(len(p['abstract']), 200)
            self.assertLessEqual(self.sources['window']['start'], p['date'])
            self.assertLessEqual(p['date'], self.sources['window']['end'])

    def test_real_gap_content_completes_current_24_without_reselection(self):
        self.assertEqual(len(self.cache['entries']), 12)
        current = self.current()
        original = copy.deepcopy(current)
        result = apply_board(current, self.saved)
        self.assertEqual(result['coverage'], {'title':24, 'translate':24, 'study':0, 'quicklook':24})
        self.assertEqual(result['window'], original['window'])
        self.assertEqual([p['paperID'] for p in result['items']], [p['paperID'] for p in original['items']])
        self.assertEqual(current, original)
        self.assertTrue(all(p['allowAutomaticGeneration'] is False for p in result['items']))

    def test_rehashed_changed_source_does_not_receive_old_gap(self):
        current = self.current()
        p = current['items'][14]
        p['abstract'] += ' changed'
        p['sourceHash'] = w.text_hash(p['title'], p['abstract'])
        result = apply_board(current, self.saved)
        self.assertIsNone(result['items'][14]['translation'])
        self.assertIsNone(result['items'][14]['quicklook'])
        self.assertEqual(result['coverage']['translate'], 23)
        with self.assertRaisesRegex(ValueError, 'source_not_current'):
            preview({**self.sources, 'items':current['items']}, self.cache)

    def test_incomplete_supplement_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / BASE.relative_to(ROOT)
            target.mkdir(parents=True)
            (target / 'sources.json').write_text((BASE / 'sources.json').read_text())
            with self.assertRaisesRegex(ValueError, 'incomplete_public_editorial'):
                load_board(directory)

    def test_gap_output_remains_separate_from_inputs_and_production(self):
        target = BASE / 'gap-board.json'
        self.assertEqual(output_target(target, []), target.resolve())
        for output, inputs in [(target, [target]), (BASE/'gap-cache.json', []),
                               (ROOT/'data/weekly-board.json', [])]:
            with self.assertRaisesRegex(ValueError, 'separate_dedicated'):
                output_target(output, inputs)

    def test_loader_preserves_runtime_files_and_primary_corrected_content(self):
        files = [ROOT/'edge/_worker.js', ROOT/'data/week-precompute-cache.json',
                 ROOT/'data/week-precompute-ledger.json',
                 ROOT/'editorial/sol-public-abstract-20261007/corrected-cache.json']
        before = {p:hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}
        load_board(ROOT)
        self.assertEqual(before, {p:hashlib.sha256(p.read_bytes()).hexdigest() for p in before})
        conduct = next(p for p in self.saved['items'] if p['doi']=='10.1093/eurheartj/ehag699')
        self.assertIn('组间绝对差为0.4个百分点', conduct['translation']['abstract_zh'])


if __name__ == '__main__':
    unittest.main()
