import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from enrich_metadata import (extract_tags, _is_ai_rct, _legacy_tags, _HEART_FAILURE_TITLE_ONLY_RE, TOPIC_VOCAB, _VALID_TAGS,
                             TOPICAL_TAG_RULES, TAG_RULES, _RCT_TITLE_RE, _conclusion_text)


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
        new_vocab = set(_VALID_TAGS) - {tag for tag, _ in TAG_RULES} - {'#AI-ECG'}
        for sample in samples:
            with self.subTest(sample=sample['id']):
                title, summary = sample['title'], sample.get('summary', '')
                legacy = _legacy_tags(title, summary)[:4]
                legacy_title = set(_legacy_tags(title, ''))
                tags = extract_tags(title, summary)
                self.assertTrue(legacy_title.intersection(legacy).issubset(tags))
                # Title-only advanced heart-failure terms may add this legacy-vocabulary tag.
                title_only_hf = ('#心衰/心肌' not in legacy
                                 and bool(re.search(_HEART_FAILURE_TITLE_ONLY_RE, (title or '').lower())))
                old_result = [tag for tag in tags if tag not in new_vocab
                              and not (title_only_hf and tag == '#心衰/心肌')]
                self.assertTrue(all(tag in legacy for tag in old_result))
                self.assertEqual(old_result, [tag for tag in legacy if tag in old_result])
                if len(legacy) < 4:
                    self.assertEqual(tags[:len(legacy)], legacy)

    def test_title_hit_new_tag_replaces_abstract_only_legacy(self):
        sample = next(s for s in json.loads(SAMPLES.read_text(encoding='utf-8')) if s['id'] == 'r2-b10')
        tags = extract_tags(sample['title'], sample['summary'])
        self.assertEqual(len(tags), 4)
        self.assertIn('#房颤/电生理', tags)
        self.assertIn('#结构性心脏病', tags)

    def test_patterns_never_match_empty(self):
        import re
        for tag, pattern in TOPICAL_TAG_RULES + TAG_RULES:
            with self.subTest(tag=tag):
                self.assertIsNone(re.search(pattern, ''))

    def test_conclusion_text(self):
        self.assertEqual(_conclusion_text('METHODS: Study. CONCLUSIONS: Final result.'), ' Final result.')
        self.assertEqual(_conclusion_text('First sentence. Last sentence.'), 'Last sentence.')

    def test_cap_four_keeps_legacy_first(self):
        text = 'A randomized clinical trial of AI ECG, heart failure, stroke, and hypertension in valve disease with LDL cholesterol'
        title_legacy = set(_legacy_tags(text, ''))
        legacy = _legacy_tags(text)[:4]
        self.assertGreaterEqual(len(legacy), 4)
        self.assertTrue(_is_ai_rct(text))
        tags = extract_tags(text)
        self.assertTrue(set(legacy).issubset(tags))
        self.assertTrue(set(legacy).intersection(title_legacy).issubset(tags))

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
