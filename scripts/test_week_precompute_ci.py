"""Offline adapter and actual runner integration; Git/provider calls are fixtures."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import week_precompute as w
import week_precompute_ci as ci
from test_week_precompute import CLOCK, paper, tr, ql, model_structure
from test_week_precompute_checkpoint import GitFixture, ledger, cache, LEDGER_PATH, CACHE_PATH

ENV={'GITHUB_ACTIONS':'true','XINZHI_PRECOMPUTE_STATE_CHECKPOINT':'1',
 'GITHUB_REPOSITORY':'example/site','XINZHI_LLM_ENDPOINT':'https://model.fixture/api',
 'XINZHI_LLM_MODEL':'existing','XINZHI_LLM_API_KEY':'fixture-secret'}


class CiIntegration(unittest.TestCase):
 def setUp(self):self.paper=w.select([paper()],CLOCK)[0][0]

 def test_default_off_performs_no_network_or_config_lookup(self):
  with patch.dict(w.os.environ,{'GITHUB_ACTIONS':'true','XINZHI_PRECOMPUTE_STATE_CHECKPOINT':''}):
   self.assertIsNone(ci.initialize_checkpoint(Path('/unused'),ledger(),cache(),lambda *a:self.fail('no I/O')))

 def test_real_runner_persists_reservation_before_dispatch_and_result_after_validation(self):
  remote=GitFixture(ledger(),cache());l=ledger();c=cache();calls=[]
  with tempfile.TemporaryDirectory() as d,patch.dict(w.os.environ,ENV):
   root=Path(d);checkpoint=ci.initialize_checkpoint(root,l,c,remote)
   def model(public):
    calls.append(public)
    saved=remote.contents(LEDGER_PATH);daily=next(iter(saved['days'].values()))
    self.assertEqual(daily['requests'][-1]['status'],'started')
    self.assertEqual(daily['reservedOutputTokens'],5800)
    self.assertEqual((root/'.local/week-checkpoint-head').read_text().strip(),remote.head)
    return {'translate':tr(),'study':model_structure(),'quicklook':ql()}
   result=w.configured_batch([self.paper],c,root/'cache',l,root/'ledger',8,model,checkpoint)
   self.assertEqual(len(calls),1);self.assertFalse(result['stopped']);self.assertEqual(result['paidRequests'],1)
   self.assertEqual(len(remote.contents(CACHE_PATH)['entries']),3)
   self.assertEqual(next(iter(remote.contents(LEDGER_PATH)['days'].values()))['requests'][0]['status'],'validated')
   self.assertEqual((root/'.local/week-checkpoint-head').read_text().strip(),remote.head)

 def test_reservation_checkpoint_failure_dispatches_zero_models(self):
  remote=GitFixture(ledger(),cache());l=ledger();c=cache()
  with tempfile.TemporaryDirectory() as d,patch.dict(w.os.environ,ENV):
   root=Path(d);checkpoint=ci.initialize_checkpoint(root,l,c,remote)
   remote.fail=('POST','/git/blobs',403)
   result=w.configured_batch([self.paper],c,root/'cache',l,root/'ledger',8,lambda *a:self.fail('model must not run'),checkpoint)
   self.assertTrue(result['stopped']);self.assertEqual(result['paidRequests'],0)
   self.assertEqual(result['blocker'],'checkpoint_access_or_rate_limit')

 def test_result_checkpoint_failure_stops_siblings_and_survives_restart(self):
  remote=GitFixture(ledger(),cache());l=ledger();c=cache();calls=[]
  with tempfile.TemporaryDirectory() as d,patch.dict(w.os.environ,ENV):
   root=Path(d);checkpoint=ci.initialize_checkpoint(root,l,c,remote)
   def model(public):
    calls.append(public);remote.fail=('POST','/git/blobs',429)
    return {'translate':tr(),'study':model_structure(),'quicklook':ql()}
   result=w.configured_batch([self.paper],c,root/'cache',l,root/'ledger',8,model,checkpoint)
   self.assertEqual(result['blocker'],'checkpoint_rate_limited');self.assertEqual(result['paidRequests'],1)
   self.assertEqual(result['generatedTasks'],0);self.assertEqual(len(c['entries']),0)
   self.assertEqual(next(iter(remote.contents(LEDGER_PATH)['days'].values()))['requests'][0]['status'],'started')
   remote.fail=None
   restored_l=ledger();restored_c=cache()
   second=ci.initialize_checkpoint(root,restored_l,restored_c,remote)
   stopped=w.configured_batch([self.paper],restored_c,root/'cache2',restored_l,root/'ledger2',8,lambda *a:self.fail('no repeated charge'),second)
   self.assertTrue(stopped['stopped']);self.assertEqual(stopped['paidRequests'],0)

 def test_existing_pauses_are_never_cleared_by_ci_restore(self):
  paused=ledger();paused['paused']='http_502:quote_not_in_abstract'
  remote=GitFixture(paused,cache());l=ledger();c=cache()
  with tempfile.TemporaryDirectory() as d,patch.dict(w.os.environ,ENV):
   root=Path(d);checkpoint=ci.initialize_checkpoint(root,l,c,remote)
   self.assertEqual(l['paused'],paused['paused'])
   result=w.configured_batch([self.paper],c,root/'cache',l,root/'ledger',8,lambda *a:self.fail('pause must hold'),checkpoint)
   self.assertEqual(result['paidRequests'],0);self.assertEqual(result['blocker'],paused['paused'])


if __name__=='__main__':unittest.main()
