"""Pure, inactive policy draft for one reviewed historical content rejection.

No file, environment, network, model, budget mutation or approval inference.
Existing runner/budget/checkpoint gates do NOT import this module. A proposal
alone never permits work. Production wiring and a scoped user approval are
separate prerequisites; all existing reservations and failure statuses remain.
"""
import copy
import hashlib
import json
import re

import week_precompute_budget as budget

DAY = budget._LEGACY_DAY
ERROR = budget._LEGACY_ERROR
SCOPE = 'resume_other_new_identities_only_no_retry_of_rejected_study'


class IsolationError(ValueError):
    pass


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _legacy_row(ledger, receipt):
    if not budget._known_receipt(receipt):
        raise IsolationError('isolation_receipt_mismatch')
    if type(ledger) is not dict or ledger.get('schemaVersion') != 1:
        raise IsolationError('isolation_ledger_mismatch')
    days = ledger.get('days')
    if type(days) is not dict:
        raise IsolationError('isolation_ledger_mismatch')
    daily = days.get(DAY)
    if (type(daily) is not dict or ledger.get('paused') != ERROR
            or daily.get('paused') != ERROR
            or type(daily.get('reservedAttempts')) is not int
            or type(daily.get('reservedOutputTokens')) is not int
            or daily.get('reservedAttempts') != 4
            or daily.get('reservedOutputTokens') != 3800):
        raise IsolationError('isolation_history_mismatch')
    rows = daily.get('requests')
    if type(rows) is not list or len(rows) != 2:
        raise IsolationError('isolation_history_mismatch')
    for row, (task, status, at, tokens) in zip(rows, budget._LEGACY_REQUESTS):
        expected = {'paperID': budget._LEGACY_PAPER, 'sourceHash': budget._LEGACY_HASH,
                    'task': task, 'status': status, 'at': at,
                    'reservedAttempts': 2, 'reservedOutputTokens': tokens}
        if (type(row) is not dict or 'requestId' in row
                or any(type(row.get(k)) is not type(v) or row.get(k) != v
                       for k, v in expected.items())):
            raise IsolationError('isolation_request_mismatch')
    return rows[1]


def legacy_proposal(ledger, receipt):
    """Return an UNAPPROVED record, bound to the exact retained study request.

    Caller must retain the original ledger untouched. Evidence establishes a
    content rejection; it does not establish exact provider calls or billing.
    """
    row = _legacy_row(ledger, receipt)
    identity = {k: row[k] for k in ('paperID', 'sourceHash', 'at')}
    identity['tasks'] = ['study']
    return {'schemaVersion': 1, 'kind': 'reviewed_historical_content_rejection',
            'day': DAY, 'requestKey': 'legacy:' + _digest(identity),
            'request': copy.deepcopy({k: row[k] for k in
                ('paperID', 'sourceHash', 'task', 'at', 'status',
                 'reservedAttempts', 'reservedOutputTokens')}),
            'failureCode': ERROR, 'billingUsageKnown': False,
            'rawModelOutputRecovered': False, 'diagnosticRequestBound': False,
            'receiptSha256': _digest(receipt),
            'workerCommit': receipt['baseMainSha'],
            'scope': SCOPE, 'approval': None}


def reviewed_record(ledger, receipt, record):
    """Validate an explicit record; never construct/infer an approval.

    Approval references are privileged audit metadata, not authentication.
    They must be installed only by the authorized integrator after the actual
    user response. This pure draft does not install or trust a public request.
    """
    expected = legacy_proposal(ledger, receipt)
    if type(record) is not dict or set(record) != set(expected):
        raise IsolationError('isolation_record_mismatch')
    approval = record.get('approval')
    if (type(approval) is not dict or set(approval) != {'approved', 'reference', 'scope'}
            or approval.get('approved') is not True or approval.get('scope') != SCOPE
            or not isinstance(approval.get('reference'), str)
            or not re.fullmatch(r'[A-Za-z0-9:_-]{1,128}', approval['reference'])):
        raise IsolationError('isolation_explicit_approval_required')
    compared = copy.deepcopy(record)
    compared['approval'] = None
    if _digest(compared) != _digest(expected):
        raise IsolationError('isolation_record_mismatch')
    return copy.deepcopy(record)


def effective_blockers(ledger, receipt, record=None):
    """Preview gates without changing/removing any pause or uncertainty.

    No approved record => every original gate remains. The reviewed legacy
    request alone is exempt from global blocking; its study remains quarantined.
    Other request failures/pauses (even identical codes) never inherit exemption.
    """
    from week_precompute_checkpoint import _requests, CheckpointError
    try:
        _requests(ledger)
    except (CheckpointError, TypeError, AttributeError):
        raise IsolationError('isolation_invalid_ledger') from None
    approved = reviewed_record(ledger, receipt, record) if record is not None else None
    blockers = []
    allowed_global = approved is not None
    values = [(None, ledger)] + list(ledger.get('days', {}).items())
    for day, value in values:
        reasons = [value.get('paused')] + value.get('pauseReasons', [])
        for reason in reasons:
            if reason and not (allowed_global and day in (None, DAY) and reason == ERROR):
                blockers.append({'day': day, 'reason': 'paid_work_paused', 'code': reason})
        for row in value.get('requests', []):
            if row.get('status') not in ('started', 'failed_or_uncertain'):
                continue
            scoped = (approved is not None and day == DAY
                      and all(row.get(k) == v for k, v in approved['request'].items()))
            if not scoped:
                blockers.append({'day': day, 'reason': 'uncertain_prior_attempt',
                                 'paperID': row.get('paperID')})
    quarantine = [] if approved is None else [{k: approved['request'][k]
                                              for k in ('paperID', 'sourceHash', 'task')}]
    return {'blockers': blockers, 'quarantine': quarantine,
            'productionPolicyActivated': False, 'budgetChanged': False,
            'billingUsageKnown': False}


def classify_configured_failure(code, response_received=False, finish_reason=None):
    """A draft boundary: only explicit post-response evidence rejection isolates.

    A plain HTTP status, message string, generic ValueError or billing unknown
    never proves a response was received. Configured runner must checkpoint
    response receipt and per-task outcomes before future integration uses this.
    """
    if (code == 'evidence_validation_failed' and response_received is True
            and finish_reason == 'stop'):
        return 'content_rejected_no_automatic_retry'
    return 'global_pause_preserve_uncertainty'
