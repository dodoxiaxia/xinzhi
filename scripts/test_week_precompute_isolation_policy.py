"""Synthetic policy previews only: no activation, I/O, provider or GitHub writes."""
import copy
import json
import unittest
from pathlib import Path

import week_precompute_budget as budget
import week_precompute_isolation_policy as policy
from test_week_precompute_budget import legacy


class IsolationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.receipt = json.loads((Path(__file__).resolve().parents[1] /
            'editorial/week_precompute_receipt_20261007.json').read_text())
        self.ledger = legacy()
        budget.migrate_known_legacy_output_budget(self.ledger, self.receipt)

    def approved_fixture(self):
        record = policy.legacy_proposal(self.ledger, self.receipt)
        record['approval'] = {'approved': True, 'reference': 'fixture_only_not_production',
                              'scope': policy.SCOPE}
        return record

    def test_proposal_preserves_every_original_field_and_cannot_resume(self):
        before = copy.deepcopy(self.ledger)
        proposal = policy.legacy_proposal(self.ledger, self.receipt)
        self.assertEqual(self.ledger, before)
        self.assertIsNone(proposal['approval'])
        self.assertFalse(proposal['billingUsageKnown'])
        self.assertFalse(proposal['diagnosticRequestBound'])
        self.assertEqual(proposal['request']['reservedOutputTokens'], 3800)
        self.assertTrue(policy.effective_blockers(self.ledger, self.receipt)['blockers'])
        with self.assertRaisesRegex(policy.IsolationError, 'explicit_approval'):
            policy.reviewed_record(self.ledger, self.receipt, proposal)

    def test_scoped_fixture_quarantines_study_without_refund_or_status_change(self):
        before = copy.deepcopy(self.ledger)
        result = policy.effective_blockers(self.ledger, self.receipt, self.approved_fixture())
        self.assertEqual(result['blockers'], [])
        self.assertEqual(result['quarantine'], [{'paperID': budget._LEGACY_PAPER,
            'sourceHash': budget._LEGACY_HASH, 'task': 'study'}])
        self.assertFalse(result['productionPolicyActivated'])
        self.assertFalse(result['budgetChanged'])
        self.assertEqual(self.ledger, before)

    def test_tampered_identity_time_reservations_receipt_or_approval_fail(self):
        for key, value in [('paperID', 'doi:10.1000/other'), ('sourceHash', 'a'*64),
                           ('task', 'translate'), ('at', '2026-10-08T00:00:00Z'),
                           ('status', 'validated'), ('reservedAttempts', 1),
                           ('reservedOutputTokens', 0), ('reservedAttempts', 2.0)]:
            with self.subTest(key=key):
                record = self.approved_fixture();record['request'][key] = value
                with self.assertRaises(policy.IsolationError):
                    policy.reviewed_record(self.ledger, self.receipt, record)
        for key, value in [('billingUsageKnown', True), ('diagnosticRequestBound', True),
                           ('failureCode', 'provider_http_429'), ('receiptSha256', '0'*64)]:
            record = self.approved_fixture();record[key] = value
            with self.assertRaises(policy.IsolationError):
                policy.reviewed_record(self.ledger, self.receipt, record)
        for approval in [None, {}, {'approved': True},
            {'approved': True, 'reference': 'fixture', 'scope': 'resume_everything'}]:
            record = self.approved_fixture();record['approval'] = approval
            with self.assertRaises(policy.IsolationError):
                policy.reviewed_record(self.ledger, self.receipt, record)

    def test_other_day_or_request_does_not_inherit_known_legacy_exemption(self):
        record = self.approved_fixture()
        for reason in [policy.ERROR, 'provider_http_403', 'provider_http_429',
                       'provider_transport_error', 'checkpoint_confirmation_uncertain']:
            ledger = copy.deepcopy(self.ledger)
            ledger['days']['2026-10-08'] = {'paused': reason,
                'reservedAttempts': 1, 'reservedOutputTokens': 5800, 'requests': [
                {'requestId': 'fixture-other-request', 'paperID': 'doi:10.1000/new',
                 'sourceHash': 'a'*64, 'task': 'study', 'at': '2026-10-08T00:00:00Z',
                 'status': 'failed_or_uncertain', 'reservedAttempts': 1,
                 'reservedOutputTokens': 5800}]}
            result = policy.effective_blockers(ledger, self.receipt, record)
            self.assertTrue(result['blockers'])
            self.assertTrue(any(x.get('code') == reason for x in result['blockers']))

    def test_extra_historical_request_and_original_corruption_fail_closed(self):
        for mutation in ['extra', 'reservation', 'status', 'global_auth']:
            ledger = copy.deepcopy(self.ledger)
            if mutation == 'extra':ledger['days'][policy.DAY]['requests'].append({})
            if mutation == 'reservation':ledger['days'][policy.DAY]['reservedAttempts'] = 3
            if mutation == 'status':ledger['days'][policy.DAY]['requests'][1]['status'] = 'started'
            if mutation == 'global_auth':ledger['paused'] = 'provider_http_403'
            with self.assertRaises(policy.IsolationError):
                policy.legacy_proposal(ledger, self.receipt)

    def test_classifier_never_treats_transport_auth_or_unproven_message_as_content(self):
        self.assertEqual(policy.classify_configured_failure('evidence_validation_failed', True, 'stop'),
                         'content_rejected_no_automatic_retry')
        for code in ['provider_http_401', 'provider_http_403', 'provider_http_429',
                     'provider_transport_error', 'checkpoint_transport_failed',
                     'model_output_invalid', 'processing_failed']:
            self.assertEqual(policy.classify_configured_failure(code, True, 'stop'),
                             'global_pause_preserve_uncertainty')
        for received, finish in [(False, 'stop'), (True, 'length'), (True, None), (1, 'stop')]:
            self.assertEqual(policy.classify_configured_failure('evidence_validation_failed', received, finish),
                             'global_pause_preserve_uncertainty')

    def test_existing_gates_remain_active_and_daily_budget_cannot_expand(self):
        from week_precompute_checkpoint import GitHubStateCheckpoint, CheckpointError
        from restore_week_precompute_snapshot import merge_ledger
        from test_week_precompute_checkpoint import GitFixture, reserve
        cache = {'schemaVersion': 1, 'entries': {}}
        remote = GitFixture(self.ledger, cache)
        checkpoint = GitHubStateCheckpoint('example/site', remote, merge_ledger)
        snapshot = checkpoint.restore(self.ledger, cache)
        reserve(snapshot.ledger)
        with self.assertRaisesRegex(CheckpointError, 'paid_work_paused'):
            checkpoint.run_reserved(snapshot.ledger, snapshot.cache, 'request-1',
                                    lambda: self.fail('No live/fixture model dispatch'))
        with self.assertRaisesRegex(budget.BudgetError, 'invalid_output_limit'):
            budget.reserve_configured({'reservedAttempts': 0, 'reservedOutputTokens': 0,
                                      'requests': []}, output_limit=17400)

    def test_malformed_preview_ledger_fails_closed(self):
        for ledger in [None, {}, {'schemaVersion': 1, 'days': {'2026-10-08': {}}}]:
            with self.assertRaises(policy.IsolationError):
                policy.effective_blockers(ledger, self.receipt)


if __name__ == '__main__':
    unittest.main()
