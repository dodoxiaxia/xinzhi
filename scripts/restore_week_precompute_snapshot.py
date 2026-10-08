#!/usr/bin/env python3
"""Offline handoff import of a finite public snapshot. Dry-run by default.

Preserves current candidates/caches and all paid reservations/pauses. Independent
requests are added, identical requests are counted once. Incomplete accounting
fails before any file write; aggregate maxima cannot prove request overlap.
"""
import argparse
import copy
import datetime as dt
import re
import week_precompute as w
import week_precompute_cache as cache_contract
import week_precompute_budget as budget_contract


def _counter(value, name):
    if type(value) is not int or value < 0:
        raise ValueError('ledger_invalid_' + name)
    return value


def request_identity(request):
    """Stable fallback for historical records without a generated request ID."""
    if not isinstance(request, dict):
        raise ValueError('ledger_invalid_request')
    required = ('paperID', 'sourceHash', 'at')
    if any(not isinstance(request.get(k), str) or not request[k] for k in required):
        raise ValueError('ledger_missing_request_identity')
    if not re.fullmatch('[a-f0-9]{64}', request['sourceHash']):
        raise ValueError('ledger_invalid_source_hash')
    try:
        at = dt.datetime.fromisoformat(request['at'].replace('Z', '+00:00'))
        if at.tzinfo is None:
            raise ValueError()
    except ValueError:
        raise ValueError('ledger_invalid_request_time') from None
    if request.get('task') in cache_contract.TASKS:
        tasks = [request['task']]
    else:
        tasks = request.get('tasks')
        if (not isinstance(tasks, list) or not tasks
                or any(not isinstance(t, str) or t not in cache_contract.TASKS for t in tasks)
                or len(set(tasks)) != len(tasks)):
            raise ValueError('ledger_invalid_request_tasks')
        tasks = sorted(tasks)
    identity = {k: request[k] for k in required}
    identity['tasks'] = tasks
    if 'requestId' in request:
        if not isinstance(request['requestId'], str) or not re.fullmatch('[A-Za-z0-9:_-]{1,128}', request['requestId']):
            raise ValueError('ledger_invalid_request_id')
        return 'id:' + request['requestId'], identity
    return 'legacy:' + cache_contract.digest(identity), identity


def _requests(daily):
    if not isinstance(daily, dict) or not isinstance(daily.get('requests', []), list):
        raise ValueError('ledger_invalid_day')
    records = {}
    for source in daily.get('requests', []):
        request = copy.deepcopy(source)
        key, identity = request_identity(request)
        attempts = _counter(request.get('reservedAttempts'), 'attempts')
        output = request.get('reservedOutputTokens')
        # Prior configured calls have an explicit per-call output ceiling.
        if output is None and request.get('tasks') and 'maxOutputTokens' in request:
            output = request['maxOutputTokens']
        if output is None:
            raise ValueError('ledger_unaccountable_output_tokens')
        output = _counter(output, 'output_tokens')
        request['reservedOutputTokens'] = output
        record = (request, identity, attempts, output)
        if key in records:
            records[key] = _merge_request(records[key], record)
        else:
            records[key] = record
    attempts = _counter(daily.get('reservedAttempts', 0), 'attempts')
    output = daily.get('reservedOutputTokens')
    if output is None:
        if records or attempts:
            raise ValueError('ledger_unaccountable_output_tokens')
        output = 0
    output = _counter(output, 'output_tokens')
    if attempts != sum(r[2] for r in records.values()) or output != sum(r[3] for r in records.values()):
        raise ValueError('ledger_unattributed_reservation')
    return records


def _merge_request(old, new):
    if old[1:] != new[1:]:
        raise ValueError('ledger_request_identity_conflict')
    request = copy.deepcopy(old[0])
    for key, value in new[0].items():
        request.setdefault(key, copy.deepcopy(value))
    # An import never resolves uncertain paid work or overwrites a failure.
    uncertain = {'started', 'failed_or_uncertain'}
    if new[0].get('status') in uncertain:
        request['status'] = new[0]['status']
    return request, old[1], old[2], old[3]


def _preserve_pauses(target, incoming):
    reasons = []
    for source in (target, incoming):
        values = [source.get('paused')] + source.get('pauseReasons', [])
        for value in values:
            if value and value not in reasons:
                reasons.append(value)
    if reasons:
        target['paused'] = target.get('paused') or incoming.get('paused') or reasons[0]
        target['pauseReasons'] = reasons


def merge_ledger(existing, imported):
    """Pure union of fully accounted requests; reject ambiguous legacy totals."""
    result = copy.deepcopy(existing)
    for ledger in (result, imported):
        if not isinstance(ledger, dict) or not isinstance(ledger.get('days', {}), dict):
            raise ValueError('ledger_invalid_snapshot')
        for daily in ledger.get('days', {}).values():
            _requests(daily)
    result.setdefault('schemaVersion', 1)
    days = result.setdefault('days', {})
    for day, incoming in imported.get('days', {}).items():
        current = days.setdefault(day, {'requests': [], 'reservedAttempts': 0, 'reservedOutputTokens': 0})
        records = _requests(current)
        for key, record in _requests(incoming).items():
            records[key] = _merge_request(records[key], record) if key in records else record
        for key, value in incoming.items():
            current.setdefault(key, copy.deepcopy(value))
        current['requests'] = [r[0] for r in records.values()]
        current['reservedAttempts'] = sum(r[2] for r in records.values())
        current['reservedOutputTokens'] = sum(r[3] for r in records.values())
        _preserve_pauses(current, incoming)
    _preserve_pauses(result, imported)
    return result


def reconcile_known_receipt(existing, receipt):
    """Repair only the exact retained trial identities against its fixed receipt.

    The old local summary counted two POSTs instead of four reserved provider
    attempts. No usage or allowance is inferred. Unknown calls fail closed;
    all pauses, metadata and uncertain statuses remain. Pure, no file writes.
    """
    result = copy.deepcopy(existing)
    day = '2026-10-07'
    daily = result.get('days', {}).get(day)
    if daily is None:
        return result
    try:
        _requests(daily)
        accounted = True
    except ValueError:
        accounted = False
    if accounted and daily.get('reservedAttempts') != 2:
        return result
    if not budget_contract._known_receipt(receipt):
        raise ValueError('ledger_known_receipt_required')
    known = receipt.get('ledgerSnapshot', {}).get('days', {}).get(day)
    if not isinstance(known, dict):
        raise ValueError('ledger_known_receipt_required')
    confirmed = _requests(known)
    if known.get('reservedAttempts') != 4 or known.get('reservedOutputTokens') != 3800 or len(confirmed) != 2:
        raise ValueError('ledger_known_receipt_required')
    for row, (task, status, at, tokens) in zip(known['requests'], budget_contract._LEGACY_REQUESTS):
        expected = {'paperID': budget_contract._LEGACY_PAPER,
                    'sourceHash': budget_contract._LEGACY_HASH, 'task': task,
                    'status': status, 'at': at, 'reservedAttempts': 2,
                    'reservedOutputTokens': tokens}
        if any(type(row.get(k)) is not type(v) or row[k] != v for k, v in expected.items()):
            raise ValueError('ledger_known_receipt_required')
    rows = daily.get('requests')
    if accounted and {request_identity(row)[0] for row in rows} != set(confirmed):
        return result
    if (not isinstance(rows, list) or len(rows) != 2
            or type(daily.get('reservedAttempts')) is not int
            or daily['reservedAttempts'] not in (2, 4)):
        raise ValueError('ledger_receipt_does_not_cover_local_history')
    seen = set()
    for row in rows:
        key, identity = request_identity(row)
        expected = confirmed.get(key)
        if expected is None or expected[1] != identity or key in seen:
            raise ValueError('ledger_receipt_does_not_cover_local_history')
        seen.add(key)
        if row.get('status') not in (expected[0]['status'], 'started'):
            raise ValueError('ledger_receipt_status_mismatch')
        for field, allowed in (('reservedAttempts', (None, 1, 2)),
                               ('reservedOutputTokens', (None, expected[3]))):
            value = row.get(field)
            if value is not None and (type(value) is not int or value not in allowed):
                raise ValueError('ledger_receipt_reservation_mismatch')
        row['reservedAttempts'] = expected[2]
        row['reservedOutputTokens'] = expected[3]
    if daily.get('reservedOutputTokens') not in (None, 3800):
        raise ValueError('ledger_receipt_reservation_mismatch')
    daily['receiptReconciliation'] = {
        'receipt': 'week_precompute_receipt_20261007.json',
        'receiptRecordedAt': receipt['recordedAt'],
        'previousReservedAttempts': daily['reservedAttempts'],
        'reservedProviderAttempts': 4, 'reservedOutputTokens': 3800,
        'actualBillingUsageKnown': False, 'pausePreserved': True}
    daily['reservedAttempts'] = 4
    daily['reservedOutputTokens'] = 3800
    _preserve_pauses(result, receipt['ledgerSnapshot'])
    _preserve_pauses(daily, known)
    _requests(daily)
    return result


def source_overlay(current, source):
    fields = {k: source[k] for k in w.PUBLIC_FIELDS if k in source}
    if current.get('dateBasis') == '期刊官网 published-online（已复核）':
        for key in ('date', 'dateBasis', 'datePrecision'):
            fields.pop(key, None)
    return fields


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()
    source = w.read(w.ROOT / 'editorial/week_precompute_sources_20261007.json', {})
    receipt = w.read(w.ROOT / 'editorial/week_precompute_receipt_20261007.json', {})
    if source.get('schemaVersion') != 1 or not source.get('publicOnly'):
        raise ValueError('invalid_public_snapshot')
    # The receipt must carry the actual request records and both reservations.
    # Older aggregate-only receipts cannot establish overlap with local calls.
    imported_ledger = receipt.get('ledgerSnapshot')
    if not isinstance(imported_ledger, dict) or not imported_ledger.get('days'):
        raise ValueError('receipt_requires_accounted_request_snapshot')
    if not imported_ledger.get('paused'):
        raise ValueError('receipt_must_preserve_failed_batch_pause')
    existing = w.read(w.ROOT / 'data/week-precompute-ledger.json',
                      {'schemaVersion': 1, 'days': {}})
    ledger = merge_ledger(reconcile_known_receipt(existing, receipt), imported_ledger)
    candidates = w.read(w.ROOT / 'data/candidates.json', {'items': []})
    byid = {p['id']: p for p in candidates['items']}
    matched = 0
    public_papers = {}
    for p in source['items']:
        old = byid.get(p['id'])
        if not old:
            continue
        if not (w.aliases(old) & w.aliases(p)):
            raise ValueError('snapshot_identity_mismatch')
        old.update(source_overlay(old, p))
        matched += 1
        info = w.public_abstract(p)
        if info:
            public = dict(p, paperID=w.identity(p), **info)
            public['sourceHash'] = w.text_hash(public['title'], public['abstract'])
            public_papers[public['paperID']] = public
    cache = w.read(w.ROOT / 'data/week-precompute-cache.json', {'schemaVersion': 1, 'entries': {}})
    imported = w.read(w.ROOT / 'editorial/week_precompute_cache_20261007.json', {'entries': {}})
    cached_tasks = 0
    for key, entry in imported.get('entries', {}).items():
        paper = public_papers.get(entry.get('paperID'))
        if not paper:
            continue
        value, metadata = cache_contract.find({'entries': {key: entry}}, paper, entry.get('task'),
            w.validate, namespace=w.PROMPT_VERSION, configured_prompt=w.COMBINED_PROMPT)
        if value is None:
            raise ValueError('snapshot_cache_validation_failed')
        if key in cache['entries'] and cache['entries'][key] != entry:
            raise ValueError('snapshot_cache_key_conflict')
        cache['entries'][key] = copy.deepcopy(entry)
        cached_tasks += 1
    if args.apply:
        w.atomic(w.ROOT / 'data/candidates.json', candidates)
        w.atomic(w.ROOT / 'data/week-precompute-cache.json', cache)
        w.atomic(w.ROOT / 'data/week-precompute-ledger.json', ledger)
    print(w.json.dumps({'applied': args.apply, 'matchedSourcePapers': matched,
        'snapshotPapers': len(source['items']), 'cachedTasks': cached_tasks,
        'paidWorkPaused': bool(ledger.get('paused')), 'modelCalls': 0}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
