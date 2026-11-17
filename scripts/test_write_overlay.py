#!/usr/bin/env python3
"""Tests for overlay write rules. Counts are taken from the input fixture, not from live state."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import write_overlay


def _row(sid, confidence, tags, abstain=False, paper_id=None, doi=None):
    return {
        'sid': sid,
        'id': paper_id or f'id-{sid}',
        'doi': doi or f'10.0000/{sid}',
        'pmid': '',
        'modelTags': tags,
        'abstain': abstain,
        'confidence': confidence,
        'inputHash': f'hash-{sid}',
    }


class LowConfidenceSkipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        repo = Path(__file__).resolve().parent.parent
        cls.vocab = write_overlay.load_vocab(repo)
        cls.tag = next(iter(sorted(cls.vocab)))

    def test_low_confidence_is_treated_as_abstention(self):
        tags = [self.tag]
        self.assertTrue(write_overlay.is_abstention(_row('L1', 'low', tags)))
        self.assertTrue(write_overlay.is_abstention(_row('L2', 'LOW', tags)))
        self.assertTrue(write_overlay.is_abstention(_row('L3', 'Low', tags)))
        self.assertTrue(write_overlay.is_abstention(_row('A1', 'high', tags, abstain=True)))
        self.assertTrue(write_overlay.is_abstention(_row('E1', 'high', [])))
        self.assertTrue(write_overlay.is_abstention(_row('E2', 'medium', None)))

    def test_high_and_medium_confidence_are_not_abstentions(self):
        tags = [self.tag]
        self.assertFalse(write_overlay.is_abstention(_row('H1', 'high', tags)))
        self.assertFalse(write_overlay.is_abstention(_row('M1', 'medium', tags)))
        self.assertFalse(write_overlay.is_abstention(_row('U1', '', tags)))
        self.assertFalse(write_overlay.is_abstention(_row('U2', None, tags)))

    def test_collect_writes_skips_low_and_keeps_high_medium(self):
        tags = [self.tag]
        rows = [
            _row('H1', 'high', tags),
            _row('M1', 'medium', tags),
            _row('L1', 'low', tags),
            _row('A1', 'high', tags, abstain=True),
        ]
        result = write_overlay.collect_writes(
            rows, existing=[], vocab=self.vocab, batch_id='test-batch', fields=['title']
        )
        written_sids = [item['sampleId'] for item in result['additions']]
        self.assertEqual(written_sids, ['H1', 'M1'])
        self.assertEqual(result['written'], 2)
        # low + explicit abstain
        self.assertEqual(result['abstained'], 2)
        self.assertEqual(result['skipped'], 0)
        self.assertNotIn('L1', written_sids)
        for item in result['additions']:
            self.assertEqual(item['tagOrigin'], 'machine_reviewed')
            self.assertEqual(item['tags'], tags)

    def test_dry_run_cli_skips_low_and_writes_high_medium(self):
        tags = [self.tag]
        rows = [
            _row('H1', 'high', tags),
            _row('M1', 'medium', tags),
            _row('L1', 'low', tags),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            overlay = tmp_path / 'overlay.json'
            overlay.write_text(
                json.dumps({'items': []}, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            model_output = tmp_path / 'model-output.jsonl'
            model_output.write_text(
                ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows),
                encoding='utf-8',
            )
            import io
            from contextlib import redirect_stdout
            buf = io.StringIO()
            with redirect_stdout(buf):
                write_overlay.main([
                    '--batch', '3',
                    '--model-output', str(model_output),
                    '--overlay', str(overlay),
                    '--batch-id', 'test-batch-dry',
                    '--input-fields', 'title',
                    '--state-commit', '0' * 40,
                    '--dry-run',
                ])
            summary = json.loads(buf.getvalue())
            self.assertEqual(summary['written'], 2)
            self.assertEqual(summary['abstained'], 1)
            self.assertEqual(summary['skipped'], 0)
            # dry-run must not modify the overlay file
            self.assertEqual(json.loads(overlay.read_text(encoding='utf-8')), {'items': []})


if __name__ == '__main__':
    unittest.main()
