"""Reconcile one uncertain weekly request without a new model call."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import reconcile_week_precompute_request as rec

REQUEST_ID = '01e400be-2a46-4418-9778-2af3845f5478'
PAPER = 'doi:10.1016/j.jacadv.2026.103352'
SOURCE = 'ffb2c10426a83f92b2890f03ef2b693f74923e436d7a767250da02057746b200'
WHEN = '2026-11-06T01:30:00+00:00'
WHO = '维护者'
WHY = '2026-10-24 10:12 北京时间的检查点写入失败，复用已保存的回答'


def stuck_row():
    return {
        'paperID': PAPER, 'sourceHash': SOURCE, 'tasks': ['translate', 'study', 'quicklook'],
        'status': 'failed_or_uncertain', 'at': '2026-10-24T02:12:58.103872+00:00',
        'requestId': REQUEST_ID, 'failureCode': 'checkpoint_transport_uncertain',
        'reservedAttempts': 1, 'reservedOutputTokens': 5800, 'maxOutputTokens': 5800,
        'providerUsageKnown': True, 'providerFinishReason': 'stop',
        'providerUsage': {'prompt_tokens': 1489, 'completion_tokens': 936, 'total_tokens': 2425,
                          'prompt_tokens_details': {'cached_tokens': 0},
                          'completion_tokens_details': {'reasoning_tokens': 0}},
    }


def stuck_ledger():
    row = stuck_row()
    return {
        'schemaVersion': 1, 'paused': 'checkpoint_transport_uncertain',
        'pauseReasons': ['checkpoint_transport_uncertain'],
        'days': {'2026-10-24': {
            'paused': 'checkpoint_transport_uncertain',
            'pauseReasons': ['checkpoint_transport_uncertain'],
            'reservedAttempts': 1, 'reservedOutputTokens': 5800, 'requests': [row],
        }},
    }


def answers(tasks=('translate', 'study', 'quicklook')):
    return {'schemaVersion': 1, 'entries': {
        task: {'paperID': PAPER, 'sourceHash': SOURCE, 'scope': 'public-abstract', 'task': task,
               'value': {'title_zh': '已保存'}, 'origin': 'configured-precompute'}
        for task in tasks}}


class ReconcileTests(unittest.TestCase):
    def test_october_24_request_is_refused_because_reuse_would_bill_again(self):
        ledger, cache = stuck_ledger(), {'schemaVersion': 1, 'entries': {}}
        before = json.dumps(ledger, sort_keys=True)
        with self.assertRaises(rec.ReconcileRefusal) as caught:
            rec.reconcile(ledger, cache, REQUEST_ID, WHO, WHY, WHEN)
        self.assertEqual(caught.exception.code, 'answer_not_persisted_would_double_bill')
        self.assertEqual(caught.exception.detail['missingTasks'], ['translate', 'study', 'quicklook'])
        self.assertTrue(caught.exception.detail['providerUsageKnown'])
        self.assertEqual(caught.exception.detail['providerFinishReason'], 'stop')
        self.assertEqual(json.dumps(ledger, sort_keys=True), before)
        self.assertEqual(ledger['paused'], 'checkpoint_transport_uncertain')

    def test_partial_cache_is_not_enough_to_reconcile_a_billed_call(self):
        with self.assertRaises(rec.ReconcileRefusal) as caught:
            rec.reconcile(stuck_ledger(), answers(('translate',)), REQUEST_ID, WHO, WHY, WHEN)
        self.assertEqual(caught.exception.code, 'answer_not_persisted_would_double_bill')
        self.assertEqual(caught.exception.detail['missingTasks'], ['study', 'quicklook'])

    def test_unknown_usage_without_an_answer_is_refused_and_not_retried(self):
        ledger = stuck_ledger()
        row = ledger['days']['2026-10-24']['requests'][0]
        row.pop('providerUsage')
        row['providerUsageKnown'] = False
        row.pop('providerFinishReason')
        with self.assertRaises(rec.ReconcileRefusal) as caught:
            rec.reconcile(ledger, {'schemaVersion': 1, 'entries': {}}, REQUEST_ID, WHO, WHY, WHEN)
        self.assertEqual(caught.exception.code, 'answer_not_located')

    def test_saved_answers_are_reused_and_only_this_pause_is_released(self):
        ledger = stuck_ledger()
        ledger['pausedTasks'] = {'translate': 'some_other_pause'}
        updated, report = rec.reconcile(ledger, answers(), REQUEST_ID, WHO, WHY, WHEN)
        self.assertEqual(report['status'], 'reconciled')
        self.assertFalse(report['newProviderCall'])
        self.assertTrue(report['reused'])
        row = updated['days']['2026-10-24']['requests'][0]
        self.assertEqual(row['status'], 'recovered_existing_cache')
        self.assertEqual(row['providerUsage']['total_tokens'], 2425)
        self.assertEqual(row['reservedAttempts'], 1)
        self.assertEqual(row['reservedOutputTokens'], 5800)
        self.assertEqual(row['reconciliation']['who'], WHO)
        self.assertEqual(row['reconciliation']['why'], WHY)
        self.assertEqual(row['reconciliation']['at'], WHEN)
        self.assertFalse(row['reconciliation']['newProviderCall'])
        self.assertNotIn('paused', updated)
        self.assertNotIn('paused', updated['days']['2026-10-24'])
        self.assertEqual(updated['pausedTasks'], {'translate': 'some_other_pause'})
        self.assertTrue(report['pauseKept'])
        self.assertNotIn('ledger.pausedTasks.translate', report['pauseReleased'])
        again_ledger, again = rec.reconcile(updated, answers(), REQUEST_ID, WHO, WHY, WHEN)
        self.assertEqual(again['status'], 'already_reconciled')
        self.assertIs(again_ledger, updated)
        self.assertEqual(len(updated['resolvedPauses']), 1)

    def test_a_different_pause_reason_and_another_uncertain_request_stay(self):
        ledger = stuck_ledger()
        ledger['paused'] = 'other_failure'
        ledger['pauseReasons'] = ['other_failure']
        day = ledger['days']['2026-10-24']
        day['paused'] = 'other_failure'
        day['pauseReasons'] = ['other_failure']
        day['requests'].append({'paperID': 'doi:10.1000/other', 'sourceHash': 'b' * 64, 'task': 'study',
                                 'status': 'started', 'at': '2026-10-24T03:00:00+00:00', 'requestId': 'other',
                                 'reservedAttempts': 1, 'reservedOutputTokens': 5800})
        day['reservedAttempts'] += 1
        day['reservedOutputTokens'] += 5800
        updated, report = rec.reconcile(ledger, answers(), REQUEST_ID, WHO, WHY, WHEN)
        self.assertEqual(updated['paused'], 'other_failure')
        self.assertEqual(updated['days']['2026-10-24']['paused'], 'other_failure')
        self.assertEqual(report['pauseReleased'], [])
        self.assertTrue(report['pauseKept'])
        self.assertEqual(updated['days']['2026-10-24']['requests'][1]['status'], 'started')

    def test_missing_who_or_why_refuses_before_any_change(self):
        ledger = stuck_ledger()
        before = json.dumps(ledger, sort_keys=True)
        with self.assertRaises(rec.ReconcileRefusal) as caught:
            rec.reconcile(ledger, answers(), REQUEST_ID, '  ', WHY, WHEN)
        self.assertEqual(caught.exception.code, 'who_or_why_missing')
        self.assertEqual(json.dumps(ledger, sort_keys=True), before)

    def test_command_dry_run_writes_nothing_and_apply_refuses_this_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger_path = root / 'week-precompute-ledger.json'
            cache_path = root / 'week-precompute-cache.json'
            ledger_path.write_text(json.dumps(stuck_ledger()))
            cache_path.write_text(json.dumps({'schemaVersion': 1, 'entries': {}}))
            before = ledger_path.read_text()
            argv = [sys.executable, 'scripts/reconcile_week_precompute_request.py',
                    '--ledger', str(ledger_path), '--cache', str(cache_path),
                    '--request-id', REQUEST_ID, '--who', WHO, '--why', WHY]
            dry = subprocess.run(argv, cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
            self.assertEqual(dry.returncode, 2, dry.stderr)
            self.assertEqual(json.loads(dry.stdout)['code'], 'answer_not_persisted_would_double_bill')
            self.assertEqual(ledger_path.read_text(), before)
            applied = subprocess.run(argv + ['--apply'], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
            self.assertEqual(applied.returncode, 2, applied.stderr)
            self.assertEqual(ledger_path.read_text(), before)
            self.assertFalse((root / '.week-precompute-ledger.json.tmp').exists())

    def test_apply_writes_once_and_the_second_apply_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger_path = root / 'ledger.json'
            cache_path = root / 'cache.json'
            ledger_path.write_text(json.dumps(stuck_ledger()))
            cache_path.write_text(json.dumps(answers()))
            argv = [sys.executable, str(Path(__file__).resolve().parents[1] / 'scripts/reconcile_week_precompute_request.py'),
                    '--ledger', str(ledger_path), '--cache', str(cache_path),
                    '--request-id', REQUEST_ID, '--who', WHO, '--why', WHY]
            dry = subprocess.run(argv, capture_output=True, text=True)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertEqual(json.loads(dry.stdout)['status'], 'dry_run')
            self.assertEqual(json.loads(ledger_path.read_text())['paused'], 'checkpoint_transport_uncertain')
            applied = subprocess.run(argv + ['--apply'], capture_output=True, text=True)
            self.assertEqual(applied.returncode, 0, applied.stderr)
            saved = json.loads(ledger_path.read_text())
            self.assertEqual(saved['days']['2026-10-24']['requests'][0]['status'], 'recovered_existing_cache')
            self.assertNotIn('paused', saved)
            text = ledger_path.read_text()
            second = subprocess.run(argv + ['--apply'], capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(json.loads(second.stdout)['status'], 'already_reconciled')
            self.assertEqual(ledger_path.read_text(), text)
            self.assertEqual(len(saved['resolvedPauses']), 1)


if __name__ == '__main__':
    unittest.main()
