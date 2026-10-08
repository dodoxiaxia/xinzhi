import copy
import json
import unittest
import tempfile
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

    def test_real_store_old_doi_shared_pmid_and_hash_is_mapping_conflict(self):
        old = copy.deepcopy(self.board['items'][1])
        current = copy.deepcopy(old)
        current['doi'] += '-corrected'
        current['paperID'] = w.identity(current)
        current.update(titleZh='', translation=None, quicklook=None)
        board = {'items':[current], 'window':self.board['window']}
        cache = {'entries':{}}
        w.store(cache,old,'translate',old['translation'],'fixture-model','2026-10-08','configured-precompute')
        entry = next(iter(cache['entries'].values()))
        self.assertNotIn('pmid',entry);self.assertNotIn('doi',entry)
        prior = [{'items':[old]}]
        before = copy.deepcopy((board,cache,prior))
        report = pending_manifest(board,[cache],prior)
        self.assertEqual(report['items'][0]['reason'],'identity_mapping_review_required')
        self.assertEqual(report['pendingPapers'],1)
        self.assertEqual((board,cache,prior),before)

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


class PendingPipelineBridge(unittest.TestCase):
    def root(self, directory, board):
        root=Path(directory);(root/'data').mkdir()
        (root/'data/weekly-board.json').write_text(json.dumps(board))
        (root/'data/week-precompute-cache.json').write_text('{"entries":{}}')
        (root/'data/week-precompute-ledger.json').write_text('{"paused":"keep_existing_pause"}')
        return root

    def test_complete_core_and_missing_study_persist_without_cache_ledger_writes(self):
        from ci_daily import record_precompute_pending
        board=json.loads((BASE/'gap-board.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            root=self.root(directory,board)
            before={name:(root/'data'/name).read_bytes() for name in ('weekly-board.json','week-precompute-cache.json','week-precompute-ledger.json')}
            status=record_precompute_pending(root)
            self.assertEqual(status['status'],'complete');self.assertTrue(status['contentComplete'])
            self.assertEqual(status['coverage'],{'title':24,'translate':24,'quicklook':24})
            self.assertEqual(status['studyMissing'],24);self.assertEqual(status['pendingPapers'],0)
            self.assertEqual(status['externalModelApiRequests'],0)
            self.assertEqual(json.loads((root/'data/public-precompute-pending.json').read_text())['window'],board['window'])
            self.assertEqual(before,{name:(root/'data'/name).read_bytes() for name in before})

    def test_new_core_gaps_create_finite_queue(self):
        from ci_daily import record_precompute_pending
        source=json.loads((BASE/'sources.json').read_text());board={'items':source['items'],'window':source['window']}
        with tempfile.TemporaryDirectory() as directory:
            root=self.root(directory,board);status=record_precompute_pending(root)
            self.assertEqual(status['pendingPapers'],5);self.assertFalse(status['contentComplete'])
            self.assertEqual(status['reasonCounts'],{'new_identity':5})
            queue=json.loads((root/'data/public-precompute-pending.json').read_text())
            self.assertTrue(all(not item['allowAutomaticGeneration'] for item in queue['items']))

    def test_invalid_source_keeps_old_queue_and_never_writes_false_complete(self):
        from ci_daily import record_precompute_pending
        board=json.loads((BASE/'gap-board.json').read_text());board['items'][0]['sourceHash']='wrong'
        with tempfile.TemporaryDirectory() as directory:
            root=self.root(directory,board);target=root/'data/public-precompute-pending.json';target.write_text('previous queue')
            with self.assertRaisesRegex(ValueError,'invalid_current_public_source'):record_precompute_pending(root)
            self.assertEqual(target.read_text(),'previous queue')


if __name__=='__main__':
    unittest.main()
