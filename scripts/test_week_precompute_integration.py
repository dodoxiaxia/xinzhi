"""End-to-end offline regressions for usage, failure checkpoints and receipt repair."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import restore_week_precompute_snapshot as restore
import week_precompute as w
import week_precompute_ci as ci
from week_precompute_checkpoint import CheckpointError, GitHubStateCheckpoint
from week_precompute_usage import ModelReply, safe_usage
from test_week_precompute import CLOCK, paper, tr, ql, model_structure
from test_week_precompute_ci import ENV
from test_week_precompute_checkpoint import GitFixture, ledger, cache, reserve, LEDGER_PATH

USAGE = {'prompt_tokens': 1200, 'completion_tokens': 700, 'total_tokens': 1900,
         'prompt_tokens_details': {'cached_tokens': 100}}


class RunnerIntegration(unittest.TestCase):
    def setUp(self):
        self.paper = w.select([paper()], CLOCK)[0][0]

    def run_case(self, callback):
        remote = GitFixture(ledger(), cache())
        l, c = ledger(), cache()
        with tempfile.TemporaryDirectory() as d, patch.dict(w.os.environ, ENV):
            root = Path(d)
            checkpoint = ci.initialize_checkpoint(root, l, c, remote)
            report = w.configured_batch([self.paper], c, root/'cache', l,
                root/'ledger', 8, callback, checkpoint)
            return remote, l, c, report

    def test_actual_usage_survives_validated_result_and_restart(self):
        response = ModelReply({'translate': tr(), 'study': model_structure(),
                              'quicklook': ql()}, USAGE, 'stop')
        remote, l, c, report = self.run_case(lambda _: response)
        self.assertFalse(report['stopped'])
        saved = next(iter(remote.contents(LEDGER_PATH)['days'].values()))
        self.assertEqual(saved['requests'][0]['providerUsage'], USAGE)
        self.assertEqual(saved['requests'][0]['status'], 'validated')
        self.assertEqual(saved['reservedOutputTokens'], 5800)
        again = GitHubStateCheckpoint('example/site', remote, restore.merge_ledger)
        self.assertEqual(again.restore(ledger(), cache()).ledger, remote.contents(LEDGER_PATH))

    def test_invalid_evidence_persists_usage_failure_and_valid_siblings(self):
        response = ModelReply({'translate': tr(), 'study': {}, 'quicklook': ql()}, USAGE, 'stop')
        remote, l, c, report = self.run_case(lambda _: response)
        saved = next(iter(remote.contents(LEDGER_PATH)['days'].values()))
        row = saved['requests'][0]
        self.assertFalse(report['stopped'])
        self.assertEqual(row['providerUsage'], USAGE)
        self.assertTrue(row['providerUsageKnown'])
        self.assertEqual(row['status'], 'rejected')
        self.assertEqual(row['failureCode'], 'evidence_validation_failed')
        self.assertNotIn('paused', saved)
        self.assertEqual(len(c['entries']), 2)
        # A known rejection is accounted, so a later paid call for other work may proceed.
        again = GitHubStateCheckpoint('example/site', remote, restore.merge_ledger)
        restored = again.restore(ledger(), cache())
        reserve(restored.ledger, 'another-call')
        self.assertEqual(again.run_reserved(restored.ledger, restored.cache, 'another-call', lambda: 'paid once'), 'paid once')

    def test_truncated_response_preserves_reported_usage_and_stops(self):
        envelope = {'usage': USAGE, 'choices': [{'finish_reason': 'length',
                                              'message': {'content': '{'}}]}
        def model(_):
            return w.parse_configured_response(envelope)
        remote, l, c, report = self.run_case(model)
        row = next(iter(remote.contents(LEDGER_PATH)['days'].values()))['requests'][0]
        self.assertEqual(report['blocker'], 'model_output_truncated')
        self.assertEqual(row['providerUsage'], USAGE)
        self.assertEqual(row['providerFinishReason'], 'length')
        self.assertEqual(len(c['entries']), 0)

    def test_no_usage_is_explicitly_unknown_not_zero(self):
        remote, l, c, report = self.run_case(lambda _: {'translate': tr(),
            'study': model_structure(), 'quicklook': ql()})
        row = next(iter(remote.contents(LEDGER_PATH)['days'].values()))['requests'][0]
        self.assertFalse(row['providerUsageKnown'])
        self.assertNotIn('providerUsage', row)

    def test_usage_cannot_disappear_from_later_checkpoint(self):
        remote, l, c, report = self.run_case(lambda _: ModelReply(
            {'translate': tr(), 'study': model_structure(), 'quicklook': ql()}, USAGE))
        backend = GitHubStateCheckpoint('example/site', remote, restore.merge_ledger)
        snapshot = backend.restore(ledger(), cache())
        del next(iter(snapshot.ledger['days'].values()))['requests'][0]['providerUsage']
        with self.assertRaisesRegex(CheckpointError, 'usage_cannot_change'):
            backend.save(snapshot.ledger, snapshot.cache)

    def test_pause_reasons_alone_block_model_dispatch(self):
        l = ledger(); l['pauseReasons'] = ['provider_http_403']
        remote = GitFixture(l, cache())
        backend = GitHubStateCheckpoint('example/site', remote, restore.merge_ledger)
        snapshot = backend.restore(l, cache()); reserve(snapshot.ledger)
        with self.assertRaisesRegex(CheckpointError, 'paid_work_paused'):
            backend.run_reserved(snapshot.ledger, snapshot.cache, 'request-1',
                                 lambda: self.fail('pause must remain'))

    def test_usage_does_not_include_credentials_or_convert_to_dollars(self):
        self.assertEqual(safe_usage(dict(USAGE, api_key='fixture', cost='$9',
                                        output_tokens=True)), USAGE)

    def test_verified_publisher_date_remains_eligible_for_weekly_selection(self):
        p = paper(); p['dateBasis'] = '期刊官网 published-online（已复核）'
        selected, window = w.select([p], CLOCK)
        self.assertEqual(len(selected), 1)

    def test_old_public_snapshot_does_not_revert_verified_publisher_date(self):
        current = {'date': '2026-10-05', 'datePrecision': 'day',
                   'dateBasis': '期刊官网 published-online（已复核）', 'summary': 'old'}
        source = {'date': '2026-10-01', 'datePrecision': 'day',
                  'dateBasis': 'ArticleDate', 'summary': 'current public abstract'}
        current.update(restore.source_overlay(current, source))
        self.assertEqual(current['date'], '2026-10-05')
        self.assertEqual(current['dateBasis'], '期刊官网 published-online（已复核）')
        self.assertEqual(current['summary'], source['summary'])


class KnownReceiptRepair(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        self.receipt = json.loads((root/'editorial/week_precompute_receipt_20261007.json').read_text())
        self.old = copy.deepcopy(self.receipt['ledgerSnapshot'])
        daily = self.old['days']['2026-10-07']
        daily['reservedAttempts'] = 2
        daily.pop('reservedOutputTokens')
        for row in daily['requests']:
            row.pop('reservedOutputTokens'); row['reservedAttempts'] = 1

    def test_exact_two_post_history_repaired_to_four_attempts_without_unlocking(self):
        before = copy.deepcopy(self.old)
        repaired = restore.reconcile_known_receipt(self.old, self.receipt)
        merged = restore.merge_ledger(repaired, self.receipt['ledgerSnapshot'])
        day = merged['days']['2026-10-07']
        self.assertEqual((day['reservedAttempts'], day['reservedOutputTokens']), (4, 3800))
        self.assertEqual(day['requests'][1]['status'], 'failed_or_uncertain')
        self.assertEqual(merged['paused'], before['paused'])
        self.assertEqual(self.old, before)
        self.assertEqual(restore.reconcile_known_receipt(merged, self.receipt), merged)

    def test_unknown_request_or_unknown_extra_cost_is_never_reconstructed(self):
        for mutation in ('identity', 'aggregate', 'extra'):
            old = copy.deepcopy(self.old)
            day = old['days']['2026-10-07']
            if mutation == 'identity': day['requests'][0]['sourceHash'] = '0'*64
            elif mutation == 'aggregate': day['reservedAttempts'] = 3
            else: day['requests'].append(copy.deepcopy(day['requests'][0]))
            before = copy.deepcopy(old)
            with self.assertRaises(ValueError): restore.reconcile_known_receipt(old, self.receipt)
            self.assertEqual(old, before)

    def test_usage_and_unrelated_accounted_days_are_preserved(self):
        old = copy.deepcopy(self.old)
        old['days']['2026-10-07']['requests'][1]['providerUsage'] = USAGE
        old['days']['2026-10-06'] = {'reservedAttempts': 0, 'reservedOutputTokens': 0, 'requests': []}
        repaired = restore.reconcile_known_receipt(old, self.receipt)
        self.assertEqual(repaired['days']['2026-10-07']['requests'][1]['providerUsage'], USAGE)
        self.assertEqual(repaired['days']['2026-10-06'], old['days']['2026-10-06'])

    def test_tampered_receipt_and_missing_request_records_fail_closed(self):
        receipt = copy.deepcopy(self.receipt)
        receipt['ledgerSnapshot']['days']['2026-10-07']['requests'][0]['paperID'] = 'doi:10.1001/other'
        with self.assertRaises(ValueError): restore.reconcile_known_receipt(self.old, receipt)
        old = copy.deepcopy(self.old); old['days']['2026-10-07']['requests'] = []
        with self.assertRaises(ValueError): restore.reconcile_known_receipt(old, self.receipt)


if __name__ == '__main__':
    unittest.main()
