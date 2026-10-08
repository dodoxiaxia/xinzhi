"""Offline consumer regressions. Provider and GitHub transport are always fixtures."""
import copy
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import week_precompute as w
import week_precompute_ci as ci
from week_precompute_consumer import plan
from test_week_precompute import CLOCK, paper, tr, ql, model_structure
from test_week_precompute_ci import ENV
from test_week_precompute_checkpoint import GitFixture, LEDGER_PATH, CACHE_PATH


class ConsumerTests(unittest.TestCase):
    def fixture(self, count=24, core=21):
        raw = [dict(paper(n), title='A randomized cardiac trial '+chr(64+n))
               for n in range(1, count+1)]
        selected, window = w.select(raw, CLOCK)
        cache = {'entries': {}}
        board = w.board(selected, window, cache, {})
        for row in board['items'][:core]:
            row.update(titleZh=tr()['title_zh'], translation=tr(), quicklook=ql(),
                       missingTasks=['study'], precomputeStatus='partial')
        return raw, selected, board, cache

    def run_batch(self, selected, tasks, cache, ledger, callback):
        with tempfile.TemporaryDirectory() as d, patch.dict(w.os.environ, ENV | {'GITHUB_ACTIONS': 'false'}):
            root = Path(d)
            return w.configured_batch(selected, cache, root/'cache', ledger,
                                      root/'ledger', 8, callback, tasks_by_paper=tasks)

    def test_three_new_core_gaps_precede_twenty_one_study_only_gaps(self):
        _, selected, board, cache = self.fixture()
        before = copy.deepcopy(board)
        targets, tasks, info = plan(selected, board, cache, [{'items':selected[:21]}])
        self.assertEqual([p['paperID'] for p in targets], [p['paperID'] for p in selected[21:]])
        self.assertEqual(set(info['reasons'].values()), {'new_identity'})
        self.assertTrue(all(t == list(w.TASKS) for t in tasks.values()))
        self.assertEqual(info['maxModelAttempts'], 3)
        self.assertEqual(board, before)

    def test_study_only_followup_never_requests_completed_translation_or_quicklook(self):
        _, selected, board, cache = self.fixture(core=24)
        targets, tasks, info = plan(selected, board, cache)
        calls = []
        report = self.run_batch(targets, tasks, cache, {'days':{}},
                                lambda public: calls.append(public) or {'study':model_structure()})
        self.assertEqual(report['paidRequests'], 2)
        self.assertTrue(all(call['missingTasks'] == ['study'] for call in calls))
        self.assertEqual(set(info['reasons'].values()), {'study_only'})

    def test_existing_daily_ceiling_stops_third_call_without_retry(self):
        _, selected, board, cache = self.fixture(core=21)
        targets, tasks, _ = plan(selected, board, cache)
        ledger = {'days':{}}
        callback = lambda _: {'translate':tr(), 'study':model_structure(), 'quicklook':ql()}
        report = self.run_batch(targets, tasks, cache, ledger, callback)
        self.assertEqual(report['paidRequests'], 2)
        self.assertEqual(report['blocker'], 'existing_daily_output_token_budget_exhausted')
        daily = next(iter(ledger['days'].values()))
        self.assertEqual([r['maxOutputTokens'] for r in daily['requests']], [5800,3800])
        self.assertEqual(daily['reservedOutputTokens'], 9600)
        again = self.run_batch(targets, tasks, cache, ledger, lambda _: self.fail('no budget, no call'))
        self.assertEqual(again['paidRequests'], 0)

    def test_hash_change_is_new_work_and_mapping_conflict_is_not_dispatched(self):
        _, selected, board, cache = self.fixture(count=2,core=0)
        old = copy.deepcopy(selected[0]);old['sourceHash']='f'*64
        targets, tasks, info = plan(selected, board, cache, [{'items':[old]}])
        self.assertEqual(info['reasons'][selected[0]['paperID']], 'source_hash_changed')
        cache['entries']['collision'] = dict(selected[0],paperID='pmid:'+selected[0]['pmid'])
        targets, _, info = plan(selected, board, cache)
        self.assertEqual([p['paperID'] for p in targets], [selected[1]['paperID']])
        self.assertEqual(info['blocked'][0]['reason'], 'identity_mapping_review_required')

    def test_stale_board_and_expanded_paper_limit_fail_closed(self):
        _, selected, board, cache = self.fixture(count=1,core=0)
        board['items'][0]['abstract'] += ' changed'
        board['items'][0]['sourceHash'] = w.text_hash(board['items'][0]['title'],board['items'][0]['abstract'])
        with self.assertRaisesRegex(ValueError, 'consumer_selection_mismatch'):plan(selected,board,cache)
        with self.assertRaisesRegex(ValueError, 'consumer_paper_limit'):plan(selected,board,cache,paper_limit=4)

    def test_complete_cache_skips_model_and_checkpoint_initialization_in_real_entrypoint(self):
        raw, selected, _, cache = self.fixture(count=1,core=0)
        for task, value in [('translate',tr()),('study',w.validate('study_evidence',model_structure(),selected[0])),('quicklook',ql())]:
            w.store(cache,selected[0],task,value,'existing',CLOCK.isoformat(),'configured-precompute')
        scripts=w.ROOT/'scripts'
        with tempfile.TemporaryDirectory() as d, patch.object(w,'ROOT',Path(d)), patch.object(w,'now',return_value=CLOCK), patch.dict(w.os.environ,ENV), patch('week_precompute_ci.initialize_checkpoint',side_effect=AssertionError('no checkpoint for empty plan')), patch.object(w,'configured_batch',side_effect=AssertionError('no model for empty plan')):
            root=Path(d);w.atomic(root/'data/candidates.json',{'items':raw})
            (root/'scripts').symlink_to(scripts,target_is_directory=True)
            w.atomic(root/'data/week-precompute-cache.json',cache)
            ledger={'days':{},'paused':'preserve_historical_pause'}
            w.atomic(root/'data/week-precompute-ledger.json',ledger)
            with contextlib.redirect_stdout(io.StringIO()):code=w.main(['--run','--pending-only'])
            self.assertEqual(code,0)
            self.assertEqual(w.read(root/'data/week-precompute-ledger.json',{}),ledger)
            self.assertEqual(w.read(root/'data/weekly-board.json',{})['coverage']['study'],1)

    def test_real_entrypoint_checkpoints_partial_result_and_restart_never_charges_again(self):
        raw, _, _, cache=self.fixture(count=1,core=0)
        remote=GitFixture({'schemaVersion':1,'days':{}},cache)
        initialize=ci.initialize_checkpoint;scripts=w.ROOT/'scripts'
        bad=ql();bad['findings'][0]['text']='治疗组999例发生事件'
        envelope={'choices':[{'finish_reason':'stop','message':{'content':json.dumps({'translate':tr(),'study':model_structure(),'quicklook':bad})}}]}
        with tempfile.TemporaryDirectory() as d, patch.object(w,'ROOT',Path(d)), patch.object(w,'now',return_value=CLOCK), patch.dict(w.os.environ,ENV), patch.object(ci,'initialize_checkpoint',side_effect=lambda root,l,c:initialize(root,l,c,remote)), patch.object(w.urllib.request,'build_opener') as opener:
            root=Path(d);(root/'scripts').symlink_to(scripts,target_is_directory=True)
            w.atomic(root/'data/candidates.json',{'items':raw})
            opener.return_value.open.return_value=io.BytesIO(json.dumps(envelope).encode())
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(w.main(['--run','--pending-only']),1)
                self.assertEqual(w.main(['--run','--pending-only']),1)
            self.assertEqual(opener.return_value.open.call_count,1)
            self.assertEqual(len(remote.contents(CACHE_PATH)['entries']),2)
            saved=remote.contents(LEDGER_PATH)
            self.assertEqual(saved['paused'],'evidence_validation_failed')
            self.assertEqual(next(iter(saved['days'].values()))['requests'][0]['status'],'failed_or_uncertain')
            board=w.read(root/'data/weekly-board.json',{})
            self.assertEqual(board['coverage'],{'title':1,'translate':1,'study':1,'quicklook':0})
            self.assertEqual(board['run']['paidRequests'],0)

    def test_provider_auth_rate_errors_stop_once_and_preserve_pause(self):
        _, selected, board, cache = self.fixture(count=3,core=0)
        targets,tasks,_=plan(selected,board,cache)
        for code in ('provider_http_403','provider_http_429'):
            with self.subTest(code=code):
                ledger={'days':{}}
                def fail(_):raise w.Halt(code)
                report=self.run_batch(targets,tasks,copy.deepcopy(cache),ledger,fail)
                self.assertEqual(report['paidRequests'],1);self.assertEqual(report['blocker'],code)
                again=self.run_batch(targets,tasks,cache,ledger,lambda _:self.fail('paused'))
                self.assertEqual(again['paidRequests'],0)

    def test_invalid_quote_keeps_valid_translation_and_study_without_retry(self):
        _, selected, board, cache=self.fixture(count=1,core=0)
        targets,tasks,_=plan(selected,board,cache);ledger={'days':{}}
        bad=ql();bad['findings'][0]['quote']='Invented result with 999 participants.'
        report=self.run_batch(targets,tasks,cache,ledger,lambda _: {'translate':tr(),'study':model_structure(),'quicklook':bad})
        self.assertEqual(report['blocker'],'evidence_validation_failed')
        self.assertTrue(w.find(cache,selected[0],'translate')[0])
        self.assertTrue(w.find(cache,selected[0],'study')[0])
        self.assertFalse(w.find(cache,selected[0],'quicklook')[0])
        self.assertEqual(self.run_batch(targets,tasks,cache,ledger,lambda _:self.fail('paused'))['paidRequests'],0)


if __name__=='__main__':unittest.main()
