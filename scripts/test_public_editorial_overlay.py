"""Current-source, rolling-week and runtime isolation regressions."""
import copy
import json
import unittest
from pathlib import Path

import week_precompute as w
from public_editorial_overlay import load_board, apply_board, current_catalog
from build_public import public_weekly_board, pregenerated_map

ROOT = Path(__file__).resolve().parents[1]


class CurrentEditorial(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.saved = load_board(ROOT)

    def test_full_correction_passes_original_validators_and_provenance(self):
        safe = public_weekly_board(self.saved)
        self.assertEqual(safe['coverage'], {'title':24,'translate':24,'study':0,'quicklook':24})
        conduct = next(p for p in safe['items'] if p['doi']=='10.1093/eurheartj/ehag699')
        self.assertIn('组间绝对差为0.4个百分点', conduct['translation']['abstract_zh'])
        self.assertIn('-3.1至3.8个百分点', conduct['quicklook']['findings'][0]['text'])
        self.assertIn('不能据此确证硬临床结局等效', conduct['quicklook']['limits'])
        for p in safe['items']:
            for m in p['generationMeta'].values():
                self.assertEqual(m['origin'], 'sol-session-public-abstract')
                self.assertFalse(m['generationVersionKnown'])
                self.assertNotIn('glm',m['modelVersion'])

    def test_rollover_preserves_selection_and_runtime_study(self):
        current = copy.deepcopy(self.saved)
        current['items'] = current['items'][6:]
        current['window']['start'] = '2026-10-02'
        before = copy.deepcopy(current)
        current['items'][0]['study'] = {'unchanged':True}
        result = apply_board(current, self.saved)
        self.assertEqual(result['window'],before['window'])
        self.assertEqual([p['paperID'] for p in result['items']],[p['paperID'] for p in before['items']])
        self.assertEqual(result['items'][0]['study'], {'unchanged':True})
        self.assertEqual(result['coverage']['translate'],18)
        self.assertEqual(result['coverage']['quicklook'],18)

    def test_changed_source_doi_or_pmid_never_attaches_old_content(self):
        for field in ('title','abstract','doi','pmid'):
            current = copy.deepcopy(self.saved)
            row = current['items'][0]
            row[field] += ' altered'
            row['translation']=None;row['quicklook']=None
            original = copy.deepcopy(current)
            result = apply_board(current,self.saved)
            self.assertIsNone(result['items'][0]['translation'])
            self.assertIsNone(result['items'][0]['quicklook'])
            self.assertEqual(current,original)

    def test_catalog_requires_complete_current_public_abstract(self):
        saved = self.saved['items'][0]
        current = {**saved,'summary':saved['abstract'],'summary_truncated':False,'publicAbstractVerified':True,'abstractSource':'Europe PMC'}
        result=current_catalog([current],self.saved)
        self.assertEqual(len(result['items']),1)
        keys=pregenerated_map(public_weekly_board(result))
        self.assertIn(saved['paperID'],keys)
        self.assertIn('pmid:'+saved['pmid'],keys)
        for changed in ({**current,'summary':current['summary']+' changed'}, {**current,'pmid':'wrong'}, {**current,'summary_truncated':True,'abstractSections':[]}):
            self.assertFalse(current_catalog([changed],self.saved)['items'])

    def test_editorial_loading_does_not_touch_runtime_files_or_online_worker(self):
        files=[ROOT/'edge/_worker.js',ROOT/'data/week-precompute-cache.json',ROOT/'data/week-precompute-ledger.json']
        before={p:p.read_bytes() for p in files if p.is_file()}
        load_board(ROOT)
        self.assertEqual(before,{p:p.read_bytes() for p in before})


if __name__=='__main__':
    unittest.main()
