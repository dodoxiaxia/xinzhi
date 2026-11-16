import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from enrich_metadata import extract_tags


SAMPLES = Path(__file__).resolve().parent / 'testdata' / 'extract_tags_regression_samples.json'
REQUIRED_IDS = {'S05', 'S07', 'S14', 'S23'}


class ExtractTagsRegressionTests(unittest.TestCase):
    def test_regression_samples(self):
        samples = json.loads(SAMPLES.read_text(encoding='utf-8'))
        self.assertTrue(REQUIRED_IDS.issubset({s['id'] for s in samples}))
        for sample in samples:
            with self.subTest(sample=sample['id']):
                tags = extract_tags(sample['title'], sample.get('summary', ''))
                for tag in sample.get('must_have', []):
                    self.assertIn(tag, tags)
                for tag in sample.get('must_not_have', []):
                    self.assertNotIn(tag, tags)


if __name__ == '__main__':
    unittest.main()
