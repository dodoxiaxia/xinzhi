import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rejection_detail import RAW_LIMIT, raw_excerpt


class RejectionDetailTests(unittest.TestCase):
    def test_text_is_bounded(self):
        result = raw_excerpt('x' * (RAW_LIMIT + 4))
        self.assertEqual(result['raw'], 'x' * RAW_LIMIT)
        self.assertEqual(result['rawChars'], RAW_LIMIT + 4)
        self.assertTrue(result['rawTruncated'])

    def test_non_string_serializes_to_text_only(self):
        result = raw_excerpt({'乙': 2, 'a': 1})
        self.assertEqual(result['raw'], '{"a": 1, "乙": 2}')
        self.assertEqual(set(result), {'raw', 'rawChars', 'rawTruncated'})
        self.assertFalse(result['rawTruncated'])

    def test_public_build_sources_do_not_reference_private_diagnostics(self):
        root = Path(__file__).resolve().parents[1]
        forbidden = ('quicklook-rejections', 'week-precompute-ledger', 'taskDetails', 'samples')
        for name in ('build_public.py', 'public_bundle.py', 'release_integrity.py'):
            source = (root / 'scripts' / name).read_text()
            with self.subTest(name=name):
                self.assertFalse(any(term in source for term in forbidden))


if __name__ == '__main__':
    unittest.main()
