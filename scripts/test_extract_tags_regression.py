import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from enrich_metadata import extract_tags, _is_ai_rct, _legacy_tags, TOPIC_VOCAB, _VALID_TAGS


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

    def test_legacy_tags_are_prefix(self):
        samples = json.loads(SAMPLES.read_text(encoding='utf-8'))
        for sample in samples:
            with self.subTest(sample=sample['id']):
                title, summary = sample['title'], sample.get('summary', '')
                legacy = _legacy_tags(title, summary)
                tags = extract_tags(title, summary)
                self.assertEqual(tags, list(dict.fromkeys(legacy + [t for t in tags if t not in legacy]))[:4])
                self.assertEqual(tags[:min(4, len(legacy))], legacy[:4])

    def test_cap_four_keeps_legacy_first(self):
        text = 'A randomized clinical trial of AI ECG, heart failure, stroke, and hypertension in valve disease with LDL cholesterol'
        legacy = _legacy_tags(text)
        self.assertGreaterEqual(len(legacy), 4)
        self.assertTrue(_is_ai_rct(text))
        self.assertEqual(extract_tags(text), legacy[:4])

    def test_frontend_vocab_matches_backend(self):
        import re
        source = (Path(__file__).resolve().parents[1] / 'src/app/01-state-helpers.js').read_text(encoding='utf-8')
        block = re.search(r'const TOPIC_TAGS = \[(.*?)\];', source, re.S)
        self.assertIsNotNone(block)
        self.assertEqual(re.findall(r"'([^']*)'", block.group(1)), list(TOPIC_VOCAB))
        self.assertEqual(set(TOPIC_VOCAB), _VALID_TAGS)

    def test_public_payload_hides_tag_origin(self):
        import ast
        root = Path(__file__).resolve().parents[1]
        tree = ast.parse((root / 'scripts/build_public.py').read_text(encoding='utf-8'))
        fields = None
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'PAPER_FIELDS' for t in node.targets):
                fields = ast.literal_eval(node.value)
                break
        self.assertIsNotNone(fields)
        self.assertNotIn('tagOrigin', fields)
        for path in [*sorted((root / 'src/app').glob('*.js')), root / 'index.html', root / 'style.css']:
            text = path.read_text(encoding='utf-8')
            self.assertNotIn('机器标注', text, str(path))
            self.assertNotIn('tagOrigin', text, str(path))


if __name__ == '__main__':
    unittest.main()
