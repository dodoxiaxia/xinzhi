"""Offline, fail-closed reservations for public-abstract model generation.

This module performs no I/O. Read shared caches before calling reserve_runtime;
a cache hit needs no reservation. On a miss, the caller must append its ``started``
request and durably save the returned reservation before making the POST. These
in-memory counters are not a distributed or provider billing cap.
"""

import os

MAX_CONFIGURED_OUTPUT_TOKENS = 5800
DEFAULT_DAILY_CALLS = 150
HARD_DAILY_CALLS = 400


def _daily_calls():
    """Owner decision 2026-10-12: the provider plan has ample headroom, so the daily ceiling
    is a runaway guard, not a spending cap. Repository variable XINZHI_WEEK_MAX_CALLS may
    lower or raise it (1..400); anything unparsable keeps the default."""
    raw = os.environ.get("XINZHI_WEEK_MAX_CALLS", "")
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_DAILY_CALLS
    return value if 1 <= value <= HARD_DAILY_CALLS else DEFAULT_DAILY_CALLS


MAX_ATTEMPTS = _daily_calls()
# Every configured call reserves its full 5800-token output cap; real replies use ~1000-1500.
MAX_OUTPUT_TOKENS = MAX_ATTEMPTS * MAX_CONFIGURED_OUTPUT_TOKENS
_OUTPUT_BY_TASK = {"translate": 9000, "study": 3800, "quicklook": 3600}
_LEGACY_DAY = "2026-10-07"
_LEGACY_PAPER = "doi:10.1001/jamanetworkopen.2026.37545"
_LEGACY_HASH = "2195a1591c9db6cf0be4b6eea1d16869a073a28cbc017898b16fdc21d6231f8c"
_LEGACY_ERROR = "http_502:quote_not_in_abstract"
_LEGACY_REQUESTS = (
    ("translate", "recovered_existing_cache", "2026-10-07T09:29:06.645375+00:00", 0),
    ("study", "failed_or_uncertain", "2026-10-07T09:33:25.428137+00:00", 3800),
)
_RECONCILIATION = {
    "version": 1,
    "receipt": "week_precompute_receipt_20261007.json",
    "receiptRecordedAt": "2026-10-07T09:42:16.210268+00:00",
    "basis": "confirmed_translation_cache_hit_and_bounded_failed_study",
    "reservedOutputTokens": 3800,
    "actualBillingUsageKnown": False,
}


class BudgetError(ValueError):
    """A fixed safe code, without source text, configuration, or credentials."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _integer(value):
    return type(value) is int and value >= 0


def runtime_task_budget(task):
    """Return first-attempt plus one bounded retry maximums, without charging."""
    if not isinstance(task, str) or task not in _OUTPUT_BY_TASK:
        raise BudgetError("unknown_runtime_task")
    return {"reservedAttempts": 2, "reservedOutputTokens": _OUTPUT_BY_TASK[task]}


def _validate_daily(daily, attempt_limit, output_limit):
    """Shared preflight: no mutation or assumptions about missing history."""
    if not _integer(attempt_limit) or attempt_limit > MAX_ATTEMPTS:
        raise BudgetError("invalid_attempt_limit")
    if not _integer(output_limit) or output_limit > MAX_OUTPUT_TOKENS:
        raise BudgetError("invalid_output_limit")
    if type(daily) is not dict:
        raise BudgetError("invalid_daily_ledger")
    if not _integer(daily.get("reservedAttempts")):
        raise BudgetError("invalid_attempt_accounting")
    if "reservedOutputTokens" not in daily:
        raise BudgetError("output_budget_unreconciled")
    if not _integer(daily["reservedOutputTokens"]):
        raise BudgetError("invalid_output_accounting")
    requests = daily.get("requests")
    if type(requests) is not list or any(type(row) is not dict or not isinstance(row.get("status"), str) or not row["status"] for row in requests):
        raise BudgetError("invalid_request_accounting")
    if daily.get("paused"):
        raise BudgetError("paid_work_paused")
    if any(row["status"] in ("started", "failed_or_uncertain") for row in requests):
        raise BudgetError("uncertain_prior_attempt")
    if any(not _integer(row.get("reservedAttempts")) or not _integer(row.get("reservedOutputTokens")) for row in requests):
        raise BudgetError("invalid_request_accounting")
    # A summary may be more conservative than retained request details, but it
    # must never claim less consumption than those details already establish.
    if sum(row["reservedAttempts"] for row in requests) > daily["reservedAttempts"] or sum(row["reservedOutputTokens"] for row in requests) > daily["reservedOutputTokens"]:
        raise BudgetError("inconsistent_budget_accounting")


def _apply_reservation(daily, budget, attempt_limit, output_limit):
    attempts = daily["reservedAttempts"] + budget["reservedAttempts"]
    output = daily["reservedOutputTokens"] + budget["reservedOutputTokens"]
    if attempts > attempt_limit:
        raise BudgetError("existing_daily_attempt_budget_exhausted")
    if output > output_limit:
        raise BudgetError("existing_daily_output_token_budget_exhausted")
    daily.update(reservedAttempts=attempts, reservedOutputTokens=output)
    return budget


def reserve_runtime(daily, task, attempt_limit=MAX_ATTEMPTS, output_limit=MAX_OUTPUT_TOKENS):
    """Preflight both budgets, then mutate both counters together or neither.

    Fresh days must explicitly initialize both counters to zero and requests to
    an empty list. Missing old output accounting is never assumed to mean zero.
    Pauses and uncertain requests must be explicitly reconciled by the caller;
    this function never clears a pause, resolves a request, or refunds a call.
    """
    reservation = runtime_task_budget(task)
    _validate_daily(daily, attempt_limit, output_limit)
    return _apply_reservation(daily, reservation, attempt_limit, output_limit)


def reserve_configured(daily, requested_output=MAX_CONFIGURED_OUTPUT_TOKENS,
                       attempt_limit=MAX_ATTEMPTS, output_limit=MAX_OUTPUT_TOKENS):
    """Reserve one direct call and its output cap, reduced to known balance.

    The caller must use the returned reservedOutputTokens as max_tokens and
    persist a started request before dispatch. A smaller remaining cap is not
    evidence that a complete response will fit; truncation remains a failure.
    """
    if not _integer(requested_output) or not 1 <= requested_output <= MAX_CONFIGURED_OUTPUT_TOKENS:
        raise BudgetError("invalid_requested_output")
    _validate_daily(daily, attempt_limit, output_limit)
    remaining = output_limit - daily["reservedOutputTokens"]
    if remaining <= 0:
        raise BudgetError("existing_daily_output_token_budget_exhausted")
    reservation = {"reservedAttempts": 1, "reservedOutputTokens": min(requested_output, remaining)}
    return _apply_reservation(daily, reservation, attempt_limit, output_limit)


def _known_receipt(receipt):
    if type(receipt) is not dict:
        return False
    expected = {
        "recordedAt": _RECONCILIATION["receiptRecordedAt"],
        "baseMainSha": "03e2c7c98b2ba80583962df2e6da29d110e67c99",
        "sourceStateSha": "652e67852f87ffdacab1582f8e5723cab32ab3b9",
        "status": "paused", "blocker": _LEGACY_ERROR,
        "wholeBatchComplete": False,
    }
    if any(type(receipt.get(k)) is not type(v) or receipt.get(k) != v for k, v in expected.items()):
        return False
    actual = receipt.get("actualVerification")
    if type(actual) is not dict:
        return False
    expected_actual = {
        "totalRuntimePostRequests": 2,
        "firstPost": "existing_shared_translation_cache_hit_2026-10-07T09:08:13.124Z; no new generation verified",
        "secondPost": "study failed evidence validation; no usable result",
        "reservedProviderAttempts": 4,
        "actualNewProviderAttempts": "at most 2 for second POST including worker bounded retry; exact billing usage is not observable",
        "newTranslationResults": 0, "reusedSharedTranslationResults": 1,
        "newStudyResults": 0, "newQuicklookResults": 0,
    }
    return all(type(actual.get(k)) is type(v) and actual.get(k) == v for k, v in expected_actual.items())


def migrate_known_legacy_output_budget(ledger, receipt):
    """Reconcile only the exact two-request 2026-10-07 public batch, once.

    Translation was a proven shared-cache hit; the failed study may have consumed
    1600 + 2200 output tokens. Retain all four attempt reservations and both pause
    fields. Every other missing-output history is unaccounted and must fail.
    A mismatch makes no changes. This does not authorize or resume generation.
    """
    def fail():
        raise BudgetError("legacy_output_budget_unreconciled")

    if type(ledger) is not dict or type(ledger.get("schemaVersion")) is not int or ledger["schemaVersion"] != 1:
        fail()
    days = ledger.get("days")
    if type(days) is not dict or _LEGACY_DAY not in days or not _known_receipt(receipt):
        fail()
    for day, other in days.items():
        if day != _LEGACY_DAY and (type(other) is not dict or not _integer(other.get("reservedOutputTokens"))):
            fail()
    daily = days[_LEGACY_DAY]
    if type(daily) is not dict or type(daily.get("reservedAttempts")) is not int or daily["reservedAttempts"] != 4:
        fail()
    if ledger.get("paused") != _LEGACY_ERROR or daily.get("paused") != _LEGACY_ERROR:
        fail()
    requests = daily.get("requests")
    if type(requests) is not list or len(requests) != 2:
        fail()
    for row, (task, status, at, tokens) in zip(requests, _LEGACY_REQUESTS):
        expected = {"paperID": _LEGACY_PAPER, "sourceHash": _LEGACY_HASH, "task": task,
                    "status": status, "at": at, "reservedAttempts": 2}
        if type(row) is not dict or any(type(row.get(k)) is not type(v) or row.get(k) != v for k, v in expected.items()):
            fail()
        if "reservedOutputTokens" in row and (type(row["reservedOutputTokens"]) is not int or row["reservedOutputTokens"] != tokens):
            fail()
    if "reservedOutputTokens" in daily:
        if type(daily["reservedOutputTokens"]) is not int or daily["reservedOutputTokens"] != 3800 or daily.get("outputBudgetReconciliation") != _RECONCILIATION:
            fail()
        if any(row.get("reservedOutputTokens") != spec[3] for row, spec in zip(requests, _LEGACY_REQUESTS)):
            fail()
        return {"status": "already_migrated", "day": _LEGACY_DAY, "reservedOutputTokens": 3800}
    if "outputBudgetReconciliation" in daily:
        fail()
    for row, spec in zip(requests, _LEGACY_REQUESTS):
        row["reservedOutputTokens"] = spec[3]
    daily["reservedOutputTokens"] = 3800
    daily["outputBudgetReconciliation"] = dict(_RECONCILIATION)
    return {"status": "migrated", "day": _LEGACY_DAY, "reservedOutputTokens": 3800}
