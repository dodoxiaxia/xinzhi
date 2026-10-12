"""The committed single-file app.js and edge/_worker.js must equal their joined src parts."""
import tempfile
import unittest
from pathlib import Path

import build_sources as bs

ROOT = Path(__file__).resolve().parents[1]


class BuildSourcesTests(unittest.TestCase):
    def test_committed_bundles_match_their_parts(self):
        self.assertEqual(bs.stale(ROOT), [], 'run python3 scripts/build_sources.py')

    def test_parts_keep_one_iife_and_one_worker_export(self):
        app = bs.joined(ROOT, 'app.js')
        self.assertTrue(app.startswith('/**') and "'use strict';\n\n(function () {" in app)
        self.assertEqual(bs.joined(ROOT, 'edge/_worker.js').count('\nexport default {'), 1)
        self.assertGreaterEqual(len(bs.parts(ROOT, 'src/app')), 10)

    def test_stale_bundle_is_reported_and_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for target, folder in bs.BUNDLES.items():
                (root / folder).mkdir(parents=True)
                (root / folder / '00-a.js').write_text('// a\n')
                (root / folder / '01-b.js').write_text('// b\n')
                (root / target).write_text('// old\n')
            self.assertEqual(sorted(bs.stale(root)), sorted(bs.BUNDLES))
            with self.assertRaisesRegex(ValueError, 'out of date'):
                bs.require_fresh(root)
            bs.write(root)
            self.assertEqual(bs.stale(root), [])
            self.assertEqual((root / 'app.js').read_text(), '// a\n// b\n')


if __name__ == '__main__':
    unittest.main()
