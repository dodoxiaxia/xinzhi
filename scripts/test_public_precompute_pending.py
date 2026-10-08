import copy
import json
import unittest
from unittest.mock import patch
from pathlib import Path

import week_precompute as w
from public_precompute_pending import pending_manifest

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT/'editorial/sol-public-abstract-20261008b-gap'


class PendingManifest(unittest.TestCase):
    def setUp(self):
        self.sources = json.loads((BASE/'sources.json').read_text())
        self.board = {'items':self.sources['items'], 'window':self.sources['window']}
        self.prior = [json.loads(p.read_text()) for p in ROOT.glob('editorial/sol-public-abstract*/sources.json') if p.parent!=BASE]

    def fixture(self):
        p = copy.deepcopy(self.board['items'][1])
        cache = {'schemaVersion':1, 'entries':{}}
        for task,field in [('translate','translation'), ('quicklook','quicklook')]:
            w.store(cache,p,task,p[field],'fixture-model','2026-10-08','fixture')
            p[field] = None
        return {'items':[p], 'window':self.board['window']},cache

    def test_actual_five_are_new_and_snapshot_inputs_are_unchanged(self):
        original = copy.deepcopy(self.board)
        report = pending_manifest(self.board,prior_sources=self.prior)
        self.assertEqual(report['coverage'], {'title':19,'translate':19,'quicklook':19})
        self.assertEqual(report['pendingPapers'],5)
        self.assertEqual({p['reason'] for p in report['items']},{'new_identity'})
        self.assertFalse(report['contentComplete'])
        self.assertEqual(report['studyMissing'],24)
        self.assertEqual(report['window'],original['window'])
        self.assertEqual(self.board,original)

    def test_current_cache_can_reuse_without_modification_or_generation(self):
        board,cache = self.fixture()
        original = copy.deepcopy(cache)
        report = pending_manifest(board,[cache],self.prior)
        self.assertTrue(report['contentComplete'])
        self.assertEqual(report['pendingPapers'],0)
        self.assertEqual(cache,original)
        self.assertEqual(report['externalModelApiRequests'],0)

    def test_changed_hash_remains_pending_even_when_old_quotes_still_match(self):
        board,cache = self.fixture()
        p = board['items'][0];p['abstract'] += ' Updated source.'
        p['sourceHash'] = w.text_hash(p['title'],p['abstract'])
        report = pending_manifest(board,[cache],self.prior)
        self.assertEqual(report['items'][0]['reason'],'source_hash_changed')
        self.assertEqual(report['items'][0]['missingTasks'],['translate','quicklook'])

    def test_alias_only_match_is_diagnosed_without_remapping_cache(self):
        board,cache = self.fixture();original=copy.deepcopy(cache)
        for e in cache['entries'].values():
            e['paperID'] = 'pmid:'+board['items'][0]['pmid']
        original = copy.deepcopy(cache)
        report = pending_manifest(board,[cache],self.prior)
        self.assertEqual(report['items'][0]['reason'],'identity_mapping_review_required')
        self.assertEqual(cache,original)

    def test_wrong_identity_metadata_and_invalid_original_hash_do_not_mark_complete(self):
        board,cache = self.fixture()
        for e in cache['entries'].values():
            e['doi'] = '10.1001/wrong'
        self.assertFalse(pending_manifest(board,[cache],self.prior)['contentComplete'])
        board['items'][0]['sourceHash']='wrong'
        with self.assertRaisesRegex(ValueError,'invalid_current_public_source'):
            pending_manifest(board,[cache],self.prior)

    def test_queue_snapshot_changes_when_required_task_version_changes(self):
        report = pending_manifest(self.board,prior_sources=self.prior)
        with patch.object(w,'PROMPT_VERSION','changed-contract'):
            changed = pending_manifest(self.board,prior_sources=self.prior)
        self.assertNotEqual(report['items'][0]['queueKey'],changed['items'][0]['queueKey'])


if __name__=='__main__':
    unittest.main()
