import copy
import json
import unittest
from pathlib import Path

import week_precompute_budget as budget


def fresh(**updates):
    return dict(reservedAttempts=0, reservedOutputTokens=0, requests=[], **updates)


def legacy():
    paper = "doi:10.1001/jamanetworkopen.2026.37545"
    source = "2195a1591c9db6cf0be4b6eea1d16869a073a28cbc017898b16fdc21d6231f8c"
    return {"schemaVersion": 1, "paused": "http_502:quote_not_in_abstract", "days": {
        "2026-10-07": {"reservedAttempts": 4, "paused": "http_502:quote_not_in_abstract", "requests": [
            {"paperID": paper, "sourceHash": source, "task": "translate", "status": "recovered_existing_cache", "at": "2026-10-07T09:29:06.645375+00:00", "reservedAttempts": 2},
            {"paperID": paper, "sourceHash": source, "task": "study", "status": "failed_or_uncertain", "at": "2026-10-07T09:33:25.428137+00:00", "reservedAttempts": 2},
        ]}}}


class RuntimeBudgetTests(unittest.TestCase):
    def rejected_unchanged(self, daily, code, task="study", **limits):
        before = copy.deepcopy(daily)
        with self.assertRaises(budget.BudgetError) as caught:
            budget.reserve_runtime(daily, task, **limits)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(daily, before)

    def test_exact_task_retry_maxima_and_return_value_are_independent(self):
        for task, expected in [("translate", 9000), ("study", 3800), ("quicklook", 3600)]:
            self.assertEqual(budget.runtime_task_budget(task), {"reservedAttempts": 2, "reservedOutputTokens": expected})
        changed = budget.runtime_task_budget("study")
        changed["reservedOutputTokens"] = 0
        self.assertEqual(budget.runtime_task_budget("study")["reservedOutputTokens"], 3800)

    def test_exact_double_boundary_succeeds_and_only_changes_counters(self):
        daily = {"reservedAttempts": 6, "reservedOutputTokens": 5800, "requests": [], "extra": "preserved"}
        result = budget.reserve_runtime(daily, "study")
        self.assertEqual(result, {"reservedAttempts": 2, "reservedOutputTokens": 3800})
        self.assertEqual(daily, {"reservedAttempts": 8, "reservedOutputTokens": 9600, "requests": [], "extra": "preserved"})

    def test_attempt_rejection_never_reserves_output(self):
        self.rejected_unchanged({"reservedAttempts": 7, "reservedOutputTokens": 0, "requests": []}, "existing_daily_attempt_budget_exhausted")

    def test_output_rejection_never_reserves_attempts(self):
        self.rejected_unchanged({"reservedAttempts": 0, "reservedOutputTokens": budget.MAX_OUTPUT_TOKENS - 3799, "requests": []}, "existing_daily_output_token_budget_exhausted")

    def test_reduced_limits_and_no_expansion(self):
        self.rejected_unchanged(fresh(), "existing_daily_attempt_budget_exhausted", attempt_limit=1)
        self.rejected_unchanged(fresh(), "existing_daily_output_token_budget_exhausted", output_limit=3799)
        for value in (-1, 9, True, 8.0, "8"):
            self.rejected_unchanged(fresh(), "invalid_attempt_limit", attempt_limit=value)
        for value in (-1, budget.MAX_OUTPUT_TOKENS + 1, False, float(budget.MAX_OUTPUT_TOKENS), str(budget.MAX_OUTPUT_TOKENS)):
            self.rejected_unchanged(fresh(), "invalid_output_limit", output_limit=value)

    def test_unknown_tasks_and_bad_daily_shape_fail_closed(self):
        for task in ("compare", "", None, [], {}):
            self.rejected_unchanged(fresh(), "unknown_runtime_task", task)
        for daily in (None, [], "bad"):
            self.rejected_unchanged(daily, "invalid_daily_ledger")

    def test_missing_or_corrupt_counters_are_not_zero(self):
        self.rejected_unchanged({"reservedAttempts": 0, "requests": []}, "output_budget_unreconciled")
        for value in (None, -1, "0", True, 0.0):
            daily = fresh(); daily["reservedAttempts"] = value
            self.rejected_unchanged(daily, "invalid_attempt_accounting")
            daily = fresh(); daily["reservedOutputTokens"] = value
            self.rejected_unchanged(daily, "invalid_output_accounting")

    def test_pause_and_uncertain_requests_are_not_resumed(self):
        self.rejected_unchanged(fresh(paused="http_429"), "paid_work_paused")
        for status in ("started", "failed_or_uncertain"):
            daily = fresh(); daily["requests"] = [{"status": status}]
            self.rejected_unchanged(daily, "uncertain_prior_attempt")
        for requests in (None, {}, [None], [{}], [{"status": ""}]):
            daily = fresh(); daily["requests"] = requests
            self.rejected_unchanged(daily, "invalid_request_accounting")

    def test_request_details_cannot_exceed_totals_or_have_unknown_cost(self):
        row = {"status": "validated", "reservedAttempts": 2, "reservedOutputTokens": 3800}
        for attempts, output in [(1, 3800), (2, 3799)]:
            daily = {"reservedAttempts": attempts, "reservedOutputTokens": output, "requests": [row]}
            self.rejected_unchanged(daily, "inconsistent_budget_accounting")
        for key, value in [("reservedAttempts", None), ("reservedAttempts", True), ("reservedOutputTokens", "3800")]:
            damaged = dict(row); damaged[key] = value
            daily = {"reservedAttempts": 2, "reservedOutputTokens": 3800, "requests": [damaged]}
            self.rejected_unchanged(daily, "invalid_request_accounting")

    def test_accounted_validated_request_allows_only_remaining_budget(self):
        row = {"status": "validated", "reservedAttempts": 2, "reservedOutputTokens": 3800}
        # The summary may be more conservative than the retained rows; leave 3599 after a study.
        start = budget.MAX_OUTPUT_TOKENS - 3800 - 3599
        daily = {"reservedAttempts": 2, "reservedOutputTokens": start, "requests": [row]}
        budget.reserve_runtime(daily, "study")
        self.assertEqual((daily["reservedAttempts"], daily["reservedOutputTokens"]), (4, start + 3800))
        self.rejected_unchanged(daily, "existing_daily_output_token_budget_exhausted", "quicklook")

    def test_cache_lookup_and_budget_inspection_do_not_precharge(self):
        daily = fresh(); before = copy.deepcopy(daily)
        cached = {"title_zh": "已生成", "abstract_zh": "已保存译文"}
        # This is the documented caller order: cache hit returns before reservation.
        result = cached if cached else budget.reserve_runtime(daily, "translate")
        self.assertIs(result, cached)
        budget.runtime_task_budget("translate")
        self.assertEqual(daily, before)


class ConfiguredBudgetTests(unittest.TestCase):
    def rejected_unchanged(self, daily, code, **options):
        before = copy.deepcopy(daily)
        with self.assertRaises(budget.BudgetError) as caught:
            budget.reserve_configured(daily, **options)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(daily, before)

    def test_default_call_reserves_one_attempt_and_5800_output(self):
        daily = fresh()
        reservation = budget.reserve_configured(daily)
        self.assertEqual(reservation, {"reservedAttempts": 1, "reservedOutputTokens": 5800})
        self.assertEqual(daily, {"reservedAttempts": 1, "reservedOutputTokens": 5800, "requests": []})

    def test_daily_ceiling_allows_six_full_calls_then_stops(self):
        daily = fresh()
        for _ in range(6):
            reservation = budget.reserve_configured(daily)
            self.assertEqual(reservation, {"reservedAttempts": 1, "reservedOutputTokens": 5800})
            daily["requests"].append({"status": "validated", **reservation})
        self.assertEqual((daily["reservedAttempts"], daily["reservedOutputTokens"]), (6, 34800))
        self.rejected_unchanged(daily, "existing_daily_output_token_budget_exhausted")

    def test_last_call_uses_only_remaining_balance(self):
        daily = {"reservedAttempts": 5, "reservedOutputTokens": budget.MAX_OUTPUT_TOKENS - 3800, "requests": []}
        self.assertEqual(budget.reserve_configured(daily), {"reservedAttempts": 1, "reservedOutputTokens": 3800})

    def test_custom_small_request_and_exact_attempt_boundary(self):
        daily = {"reservedAttempts": 7, "reservedOutputTokens": budget.MAX_OUTPUT_TOKENS - 1, "requests": []}
        self.assertEqual(budget.reserve_configured(daily, requested_output=1), {"reservedAttempts": 1, "reservedOutputTokens": 1})
        self.assertEqual((daily["reservedAttempts"], daily["reservedOutputTokens"]), (8, budget.MAX_OUTPUT_TOKENS))
        daily = fresh()
        self.assertEqual(budget.reserve_configured(daily, requested_output=1200)["reservedOutputTokens"], 1200)

    def test_attempt_exhaustion_changes_neither_counter(self):
        daily = {"reservedAttempts": 8, "reservedOutputTokens": 0, "requests": []}
        self.rejected_unchanged(daily, "existing_daily_attempt_budget_exhausted")
        self.rejected_unchanged(fresh(), "existing_daily_attempt_budget_exhausted", attempt_limit=0)

    def test_bad_requested_output_and_expanded_limits_are_rejected(self):
        for value in (None, 0, -1, 5801, True, 5800.0, "5800"):
            self.rejected_unchanged(fresh(), "invalid_requested_output", requested_output=value)
        self.rejected_unchanged(fresh(), "invalid_attempt_limit", attempt_limit=9)
        self.rejected_unchanged(fresh(), "invalid_output_limit", output_limit=budget.MAX_OUTPUT_TOKENS + 1)

    def test_reduced_output_limit_is_respected_and_zero_is_exhausted(self):
        daily = fresh()
        self.assertEqual(budget.reserve_configured(daily, output_limit=1000)["reservedOutputTokens"], 1000)
        self.rejected_unchanged(fresh(), "existing_daily_output_token_budget_exhausted", output_limit=0)

    def test_same_missing_history_bad_formats_and_totals_fail_closed(self):
        cases = [
            (None, "invalid_daily_ledger"),
            ({"reservedAttempts": 0, "requests": []}, "output_budget_unreconciled"),
            ({"reservedAttempts": True, "reservedOutputTokens": 0, "requests": []}, "invalid_attempt_accounting"),
            ({"reservedAttempts": 0, "reservedOutputTokens": "0", "requests": []}, "invalid_output_accounting"),
            ({"reservedAttempts": 0, "reservedOutputTokens": 0, "requests": None}, "invalid_request_accounting"),
            ({"reservedAttempts": 2, "reservedOutputTokens": 3800, "requests": [{"status": "validated", "reservedAttempts": 2}]}, "invalid_request_accounting"),
            ({"reservedAttempts": 1, "reservedOutputTokens": 3800, "requests": [{"status": "validated", "reservedAttempts": 2, "reservedOutputTokens": 3800}]}, "inconsistent_budget_accounting"),
            ({"reservedAttempts": 2, "reservedOutputTokens": 3799, "requests": [{"status": "validated", "reservedAttempts": 2, "reservedOutputTokens": 3800}]}, "inconsistent_budget_accounting"),
        ]
        for daily, code in cases:
            with self.subTest(code=code):
                self.rejected_unchanged(daily, code)

    def test_same_pause_and_uncertain_requests_block_direct_calls(self):
        self.rejected_unchanged(fresh(paused="provider_auth"), "paid_work_paused")
        for status in ("started", "failed_or_uncertain"):
            daily = fresh(); daily["requests"] = [{"status": status}]
            self.rejected_unchanged(daily, "uncertain_prior_attempt")


class LegacyMigrationTests(unittest.TestCase):
    def setUp(self):
        # Only the tracked finite public verification receipt, never runtime config.
        path = Path(__file__).resolve().parents[1] / "editorial/week_precompute_receipt_20261007.json"
        self.receipt = json.loads(path.read_text())

    def rejected_unchanged(self, ledger, receipt=None):
        before = copy.deepcopy(ledger)
        with self.assertRaises(budget.BudgetError) as caught:
            budget.migrate_known_legacy_output_budget(ledger, self.receipt if receipt is None else receipt)
        self.assertEqual(caught.exception.code, "legacy_output_budget_unreconciled")
        self.assertEqual(ledger, before)

    def test_known_failure_migration_is_idempotent_and_retains_pauses(self):
        ledger = legacy()
        result = budget.migrate_known_legacy_output_budget(ledger, self.receipt)
        daily = ledger["days"]["2026-10-07"]
        self.assertEqual(result["status"], "migrated")
        self.assertEqual(daily["reservedAttempts"], 4)
        self.assertEqual(daily["reservedOutputTokens"], 3800)
        self.assertEqual([r["reservedOutputTokens"] for r in daily["requests"]], [0, 3800])
        self.assertEqual(daily["paused"], ledger["paused"])
        snapshot = copy.deepcopy(ledger)
        self.assertEqual(budget.migrate_known_legacy_output_budget(ledger, self.receipt)["status"], "already_migrated")
        self.assertEqual(ledger, snapshot)
        with self.assertRaisesRegex(budget.BudgetError, "paid_work_paused"):
            budget.reserve_runtime(daily, "study")

    def test_unproven_cache_hit_or_wrong_receipt_is_rejected(self):
        for key, value in [("firstPost", "unknown"), ("totalRuntimePostRequests", 3), ("reservedProviderAttempts", True), ("newStudyResults", 1)]:
            receipt = copy.deepcopy(self.receipt)
            receipt["actualVerification"][key] = value
            self.rejected_unchanged(legacy(), receipt)
        self.rejected_unchanged(legacy(), {})

    def test_wrong_request_source_identity_time_and_attempts_are_rejected(self):
        for key, value in [("paperID", "doi:10.1234/other"), ("sourceHash", "0" * 64), ("task", "quicklook"), ("at", "2026-10-07T10:00:00Z"), ("reservedAttempts", True), ("status", "validated")]:
            ledger = legacy(); ledger["days"]["2026-10-07"]["requests"][1][key] = value
            self.rejected_unchanged(ledger)

    def test_extra_or_unreconciled_history_is_not_silently_merged(self):
        ledger = legacy(); ledger["days"]["2026-10-07"]["requests"].append({"status": "validated"})
        self.rejected_unchanged(ledger)
        ledger = legacy(); ledger["days"]["2026-10-07"]["reservedAttempts"] = 6
        self.rejected_unchanged(ledger)
        ledger = legacy(); ledger["days"]["2026-10-06"] = {"reservedAttempts": 2, "requests": []}
        self.rejected_unchanged(ledger)

    def test_existing_aggregate_cannot_be_overwritten_or_assumed_reconciled(self):
        for value in (0, 3800, 9600, None, "3800", True):
            ledger = legacy(); ledger["days"]["2026-10-07"]["reservedOutputTokens"] = value
            self.rejected_unchanged(ledger)
        ledger = legacy(); ledger["days"]["2026-10-07"]["requests"][0]["reservedOutputTokens"] = 9000
        self.rejected_unchanged(ledger)


if __name__ == "__main__":
    unittest.main()
