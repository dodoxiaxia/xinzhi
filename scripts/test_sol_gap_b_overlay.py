import copy
import json
import unittest
from pathlib import Path

import week_precompute as w
from preview_sol_public_overlay import preview
from public_editorial_overlay import load_board,apply_board
from public_precompute_pending import pending_manifest

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'editorial/sol-public-abstract-20261008b-gap'


class GapBOverlay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources=json.loads((BASE/'sources.json').read_text())
        cls.cache=json.loads((BASE/'gap-cache.json').read_text())
        cls.saved=load_board(ROOT)

    def current(self):
        return {'items':copy.deepcopy(self.sources['items']),'window':copy.deepcopy(self.sources['window'])}

    def test_five_actual_results_complete_fixed_24_without_reselection(self):
        self.assertEqual(len(self.cache['entries']),10)
        current=self.current();original=copy.deepcopy(current)
        result=apply_board(current,self.saved)
        self.assertEqual(result['coverage'],{'title':24,'translate':24,'study':0,'quicklook':24})
        self.assertEqual(result['window'],original['window'])
        self.assertEqual([(p['paperID'],p['sourceHash'],p['date']) for p in result['items']],
                         [(p['paperID'],p['sourceHash'],p['date']) for p in original['items']])
        self.assertEqual(current,original)
        self.assertTrue(all(p['allowAutomaticGeneration'] is False for p in result['items']))

    def test_changed_source_is_rejected_instead_of_reusing_old_content(self):
        current=self.current();p=current['items'][0]
        p['abstract']+=' Updated source.';p['sourceHash']=w.text_hash(p['title'],p['abstract'])
        result=apply_board(current,self.saved)
        self.assertEqual(result['coverage']['translate'],23)
        self.assertIsNone(result['items'][0]['translation'])
        with self.assertRaisesRegex(ValueError,'source_not_current'):
            preview({**self.sources,'items':current['items']},self.cache)

    def test_backlog_is_empty_only_after_actual_content_is_present(self):
        before=pending_manifest(self.current())
        self.assertEqual(before['pendingPapers'],5)
        after=pending_manifest(apply_board(self.current(),self.saved))
        self.assertTrue(after['contentComplete'])
        self.assertEqual(after['pendingPapers'],0)
        self.assertEqual(after['studyMissing'],24)


if __name__=='__main__':
    unittest.main()
