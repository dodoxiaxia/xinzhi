"""The 2026-10-24 request can be closed without a second model call."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import give_up_week_precompute_request as give
import week_precompute as w
import week_precompute_checkpoint as checkpoint
from test_week_precompute import CLOCK, model_structure, paper, ql, tr

WHEN = '2026-11-12T03:10:00+00:00'


def stuck_ledger():
    return {
        'schemaVersion': 1, 'paused': 'checkpoint_transport_uncertain',
        'pauseReasons': ['checkpoint_transport_uncertain'],
        'days': {'2026-10-24': {
            'paused': 'checkpoint_transport_uncertain',
            'pauseReasons': ['checkpoint_transport_uncertain'],
            'reservedAttempts': 2, 'reservedOutputTokens': 11600,
            'requests': [
                {'paperID': 'doi:10.1161/strokeaha.126.056198', 'sourceHash': 'a' * 64,
                 'tasks': ['translate', 'study', 'quicklook'], 'status': 'validated',
                 'at': '2026-10-24T02:11:38.787268+00:00', 'requestId': '138795a8-6391-4772-98b5-d3aa69176990',
                 'reservedAttempts': 1, 'reservedOutputTokens': 5800},
                {'paperID': give.PAPER_ID, 'sourceHash': give.SOURCE_HASH,
                 'tasks': ['translate', 'study', 'quicklook'], 'status': 'failed_or_uncertain',
                 'at': give.AT, 'requestId': give.REQUEST_ID, 'failureCode': give.FAILURE,
                 'reservedAttempts': 1, 'reservedOutputTokens': 5800, 'maxOutputTokens': 5800,
                 'providerUsageKnown': True, 'providerFinishReason': 'stop',
                 'providerUsage': {'prompt_tokens': 1489, 'completion_tokens': 936, 'total_tokens': 2425,
                                   'prompt_tokens_details': {'cached_tokens': 0},
                                   'completion_tokens_details': {'reasoning_tokens': 0}}},
            ],
        }},
    }


class GiveUpTests(unittest.TestCase):
    def test_owner_decision_closes_the_request_and_keeps_the_charge(self):
        ledger = stuck_ledger()
        before_usage = copy.deepcopy(ledger['days']['2026-10-24']['requests'][1]['providerUsage'])
        updated, report = give.give_up(ledger, WHEN)
        self.assertEqual(ledger['paused'], 'checkpoint_transport_uncertain')
        row = updated['days']['2026-10-24']['requests'][1]
        self.assertEqual(row['status'], 'abandoned')
        self.assertEqual(row['providerUsage'], before_usage)
        self.assertEqual(row['reservedAttempts'], 1)
        self.assertEqual(row['reservedOutputTokens'], 5800)
        self.assertEqual(row['failureCode'], 'checkpoint_transport_uncertain')
        self.assertFalse(row['disposition']['newProviderCall'])
        self.assertFalse(row['disposition']['providerCallRepeated'])
        self.assertEqual(row['disposition']['who'], 'site owner')
        self.assertNotIn('paused', updated)
        self.assertNotIn('paused', updated['days']['2026-10-24'])
        self.assertNotIn('pauseReasons', updated)
        self.assertEqual(updated['days']['2026-10-24']['reservedAttempts'], 2)
        self.assertEqual(updated['days']['2026-10-24']['reservedOutputTokens'], 11600)
        self.assertEqual(updated['days']['2026-10-24']['requests'][0]['status'], 'validated')
        self.assertEqual(report['status'], 'abandoned')
        self.assertEqual(report['newProviderCall'], False)
        checkpoint._requests(updated)
        again, second = give.give_up(updated, '2026-11-12T04:00:00+00:00')
        self.assertIs(again, updated)
        self.assertEqual(second['status'], 'already_given_up')
        self.assertEqual(len(updated['resolvedPauses']), 1)

    def test_changed_usage_or_another_uncertain_request_is_refused(self):
        changed = stuck_ledger()
        changed['days']['2026-10-24']['requests'][1]['providerUsage']['total_tokens'] = 2426
        before = json.dumps(changed, sort_keys=True)
        with self.assertRaises(give.GiveUpRefusal) as caught:
            give.give_up(changed, WHEN)
        self.assertEqual(caught.exception.code, 'request_identity_mismatch')
        self.assertEqual(json.dumps(changed, sort_keys=True), before)
        extra = stuck_ledger()
        extra['days']['2026-10-25'] = {'reservedAttempts': 1, 'reservedOutputTokens': 5800, 'requests': [
            {'paperID': 'doi:10.1000/other', 'sourceHash': 'b' * 64, 'task': 'study', 'status': 'started',
             'at': '2026-10-25T00:00:00+00:00', 'requestId': 'other', 'reservedAttempts': 1,
             'reservedOutputTokens': 5800}]}
        with self.assertRaises(give.GiveUpRefusal) as caught:
            give.give_up(extra, WHEN)
        self.assertEqual(caught.exception.code, 'other_uncertain_work_present')
        self.assertEqual(extra['paused'], 'checkpoint_transport_uncertain')

    def test_cli_dry_run_writes_nothing_and_apply_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'week-precompute-ledger.json'
            path.write_text(json.dumps(stuck_ledger()))
            before = path.read_bytes()
            self.assertEqual(give.main(['--ledger', str(path)]), 0)
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse((directory and Path(directory) / '.week-precompute-ledger.json.tmp').exists())
            self.assertEqual(give.main(['--ledger', str(path), '--apply']), 0)
            written = json.loads(path.read_text())
            self.assertEqual(written['days']['2026-10-24']['requests'][1]['status'], 'abandoned')
            saved = path.read_bytes()
            self.assertEqual(give.main(['--ledger', str(path), '--apply']), 0)
            self.assertEqual(path.read_bytes(), saved)
            path.write_text(json.dumps(stuck_ledger()).replace('2425', '1'))
            self.assertEqual(give.main(['--ledger', str(path), '--apply']), 2)
            self.assertEqual(json.loads(path.read_text())['paused'], 'checkpoint_transport_uncertain')

    def test_abandoned_paper_is_not_sent_and_another_paper_still_can_be(self):
        second = paper(2)
        second['title'] = 'A randomized blood pressure trial'
        selected, _window = w.select([paper(1), second], CLOCK)
        self.assertEqual(len(selected), 2)
        closed, other = selected
        ledger = {'schemaVersion': 1, 'days': {'2026-10-24': {
            'reservedAttempts': 1, 'reservedOutputTokens': 5800, 'requests': [{
                'paperID': closed['paperID'], 'sourceHash': closed['sourceHash'],
                'tasks': ['translate', 'study', 'quicklook'], 'status': 'abandoned',
                'at': give.AT, 'requestId': give.REQUEST_ID, 'failureCode': give.FAILURE,
                'reservedAttempts': 1, 'reservedOutputTokens': 5800,
                'providerUsageKnown': True, 'providerFinishReason': 'stop',
                'providerUsage': dict(give.USAGE),
            }],
        }}}
        seen = []

        def model(public):
            seen.append(public['title'])
            return {'translate': tr(), 'study': model_structure(), 'quicklook': ql()}

        # Actions sets GITHUB_ACTIONS and refuses a paid call that has no checkpoint.
        # Clear it here so this case reaches the abandoned-task skip. The clock is fixed
        # so the day bucket does not follow the runner's date, and both calls use only
        # the ledger object above plus temp files.
        with tempfile.TemporaryDirectory() as directory, patch.dict(w.os.environ, {
                'GITHUB_ACTIONS': '', 'XINZHI_LLM_ENDPOINT': 'https://model.fixture/api',
                'XINZHI_LLM_MODEL': 'existing', 'XINZHI_LLM_API_KEY': 'fixture-secret'}), \
                patch.object(w, 'now', lambda: CLOCK):
            report = w.configured_batch(selected, {'entries': {}}, Path(directory) / 'cache', ledger,
                                        Path(directory) / 'ledger', 8, model)
            self.assertFalse(report.get('stopped'))
            self.assertIsNone(report.get('blocker'))
            self.assertEqual(seen, [other['title']])
            self.assertEqual(report['paidRequests'], 1)

            def transport(url, payload=None):
                if payload is not None:
                    self.fail('abandoned task was sent')
                return {'found': False}
            runtime = w.acquire_runtime([closed], {'entries': {}}, Path(directory) / 'runtime-cache', ledger,
                                        Path(directory) / 'runtime-ledger', 8, True, transport)
        self.assertFalse(runtime.get('stopped'))
        self.assertIsNone(runtime.get('blocker'))
        self.assertEqual(runtime['paidRequests'], 0)


if __name__ == '__main__':
    unittest.main()
