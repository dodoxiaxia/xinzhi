import copy
import json
import unittest
from pathlib import Path

import week_precompute as w
from preview_sol_public_overlay import preview
from public_editorial_overlay import load_board,apply_board
from public_precompute_pending import pending_manifest
from build_public import public_weekly_board

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

    def test_catalogue_bound_does_not_expand_weekly_limit_or_skip_source_validation(self):
        rows=[]
        for n in range(35):
            title='Reviewed public title '+str(n);abstract='Public abstract.'
            rows.append({'paperID':'doi:10.1234/catalogue'+str(n),
                         'title':title,'abstract':abstract,
                         'sourceHash':w.text_hash(title,abstract),'category':'心血管'})
        board={'schemaVersion':1,'scope':'public-abstract','items':rows}
        with self.assertRaisesRegex(ValueError,'Invalid weekly board count'):
            public_weekly_board({**board,'items':rows[:31]})
        self.assertEqual(len(public_weekly_board(board,maximum_rows=35)['items']),35)
        with self.assertRaisesRegex(ValueError,'Invalid weekly board count'):
            public_weekly_board(board,maximum_rows=34)
        corrupt=copy.deepcopy(board);corrupt['items'][-1]['sourceHash']='0'*64
        with self.assertRaisesRegex(ValueError,'source hash mismatch'):
            public_weekly_board(corrupt,maximum_rows=35)
        duplicate=copy.deepcopy(board);duplicate['items'][-1]=duplicate['items'][0]
        with self.assertRaisesRegex(ValueError,'identity/category'):
            public_weekly_board(duplicate,maximum_rows=35)


if __name__=='__main__':
    unittest.main()
