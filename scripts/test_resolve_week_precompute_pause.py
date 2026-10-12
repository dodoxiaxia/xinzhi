"""The receipt-bound 2026-10-07 pause resolution changes only that known record."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import resolve_week_precompute_pause as resolver
import week_precompute as w
from test_week_precompute import CLOCK, paper, tr, ql

LEGACY = json.loads('''{"schemaVersion": 1, "days": {"2026-10-07": {"requests": [{"paperID": "doi:10.1001/jamanetworkopen.2026.37545", "sourceHash": "2195a1591c9db6cf0be4b6eea1d16869a073a28cbc017898b16fdc21d6231f8c", "task": "translate", "status": "recovered_existing_cache", "at": "2026-10-07T09:29:06.645375+00:00", "reservedAttempts": 2, "reservedOutputTokens": 0}, {"paperID": "doi:10.1001/jamanetworkopen.2026.37545", "sourceHash": "2195a1591c9db6cf0be4b6eea1d16869a073a28cbc017898b16fdc21d6231f8c", "task": "study", "status": "failed_or_uncertain", "at": "2026-10-07T09:33:25.428137+00:00", "reservedAttempts": 2, "reservedOutputTokens": 3800}], "reservedAttempts": 4, "reservedOutputTokens": 3800, "resolution": {"at": "2026-10-07T09:33:11.205793+00:00", "reason": "deployed_worker_16_hex_fingerprint_compatibility_fixed; independently validated existing cached translation", "newProviderCallVerified": false}, "paused": "http_502:quote_not_in_abstract", "outputBudgetReconciliation": {"version": 1, "receipt": "week_precompute_receipt_20261007.json", "receiptRecordedAt": "2026-10-07T09:42:16.210268+00:00", "basis": "confirmed_translation_cache_hit_and_bounded_failed_study", "reservedOutputTokens": 3800, "actualBillingUsageKnown": false}, "pauseReasons": ["http_502:quote_not_in_abstract"]}}, "paused": "http_502:quote_not_in_abstract", "pauseReasons": ["http_502:quote_not_in_abstract"]}''')
RECEIPT = json.loads(resolver.RECEIPT.read_text())


class ResolvePauseTests(unittest.TestCase):
    def test_known_record_becomes_rejected_and_history_is_kept(self):
        ledger = copy.deepcopy(LEGACY)
        self.assertEqual(resolver.resolve(ledger, RECEIPT, 'now'), 'resolved')
        day = ledger['days']['2026-10-07']
        self.assertNotIn('paused', ledger)
        self.assertNotIn('paused', day)
        self.assertEqual(day['requests'][1]['status'], 'rejected')
        self.assertEqual((day['reservedAttempts'], day['reservedOutputTokens']), (4, 3800))
        self.assertEqual(day['outputBudgetReconciliation'], LEGACY['days']['2026-10-07']['outputBudgetReconciliation'])
        self.assertEqual(ledger['resolvedPauses'][0]['receipt'], 'week_precompute_receipt_20261007.json')
        self.assertEqual(resolver.resolve(ledger, RECEIPT, 'later'), 'already_resolved')

    def test_other_uncertain_work_or_changed_receipt_refuses(self):
        ledger = copy.deepcopy(LEGACY)
        ledger['days']['2026-10-08'] = {'reservedAttempts': 1, 'reservedOutputTokens': 10, 'requests': [
            {'paperID': 'doi:x', 'sourceHash': 'a' * 64, 'task': 'study', 'status': 'started', 'at': 't',
             'reservedAttempts': 1, 'reservedOutputTokens': 10}]}
        with self.assertRaises(ValueError):
            resolver.resolve(ledger, RECEIPT, 'now')
        with self.assertRaises(ValueError):
            resolver.resolve(copy.deepcopy(LEGACY), dict(RECEIPT, status='complete'), 'now')

    def test_resolved_ledger_no_longer_blocks_paid_batch(self):
        ledger = copy.deepcopy(LEGACY)
        resolver.resolve(ledger, RECEIPT, 'now')
        p = w.select([paper()], CLOCK)[0][0]
        with tempfile.TemporaryDirectory() as d, patch.dict(w.os.environ, {'GITHUB_ACTIONS': '', 'XINZHI_LLM_ENDPOINT': 'https://model.fixture/api',
                'XINZHI_LLM_MODEL': 'existing', 'XINZHI_LLM_API_KEY': 'fixture-secret'}):
            report = w.configured_batch([p], {'entries': {}}, Path(d) / 'cache', ledger, Path(d) / 'ledger', 8,
                                        lambda public: {'translate': tr(), 'study': {'wrong': 1}, 'quicklook': ql()})
        self.assertNotEqual(report['blocker'], 'http_502:quote_not_in_abstract')
        self.assertEqual(report['paidRequests'], 2)  # the call, then one retry told why study failed


if __name__ == '__main__':
    unittest.main()
