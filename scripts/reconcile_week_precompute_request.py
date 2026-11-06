#!/usr/bin/env python3
"""Reconcile one uncertain weekly-precompute request by reusing a saved answer.

Dry-run by default. ``--apply`` rewrites the local ledger file and does not call
the model, GitHub, or any network. The request is marked recovered only when
every task on it already has a public-abstract cache entry for the same paper
and source hash. That entry is reused; nothing is generated again.

The command refuses when an answer cannot be located. If provider usage or a
completed finish reason shows the call was already billed, the refusal says so:
a new model call would bill the same paper twice. Reservations and recorded
usage are never changed. A pause flag is removed only after a successful reuse,
only when its reason is this request's failure code, and only when no other
uncertain request still covers that task. Any other pause is left in place.

A maintainer applies this to a restored state checkout, inspects the dry-run,
and commits the ledger only if the command reports reconciled. This tool does
not push.
"""
from __future__ import annotations

import argparse
import copy
import datetime
import json
import os
import sys
from pathlib import Path

TASKS = ('translate', 'study', 'quicklook')
UNCERTAIN = {'started', 'failed_or_uncertain'}
RECOVERED = 'recovered_existing_cache'


class ReconcileRefusal(ValueError):
    def __init__(self, code, **detail):
        self.code = code
        self.detail = {key: value for key, value in detail.items() if value is not None}
        super().__init__(code)


def _tasks(row):
    tasks = row.get('tasks')
    task = row.get('task')
    if isinstance(tasks, list) and tasks and all(isinstance(item, str) and item in TASKS for item in tasks):
        return list(dict.fromkeys(tasks))
    if isinstance(task, str) and task in TASKS:
        return [task]
    raise ReconcileRefusal('request_tasks_unknown')


def _find_request(ledger, request_id):
    if not isinstance(ledger, dict) or not isinstance(ledger.get('days'), dict):
        raise ReconcileRefusal('ledger_invalid')
    if not isinstance(request_id, str) or not request_id.strip():
        raise ReconcileRefusal('request_id_missing')
    found = []
    for day, daily in ledger['days'].items():
        if not isinstance(daily, dict) or not isinstance(daily.get('requests'), list):
            raise ReconcileRefusal('ledger_invalid')
        for row in daily['requests']:
            if isinstance(row, dict) and row.get('requestId') == request_id:
                found.append((day, daily, row))
    if not found:
        raise ReconcileRefusal('request_not_found')
    if len(found) != 1:
        raise ReconcileRefusal('request_ambiguous', count=len(found))
    return found[0]


def _cache_entries(cache):
    if not isinstance(cache, dict) or not isinstance(cache.get('entries'), dict):
        raise ReconcileRefusal('cache_invalid')
    return cache['entries']


def _matching_answers(cache, paper_id, source_hash, tasks):
    found = {}
    for entry in _cache_entries(cache).values():
        if not isinstance(entry, dict):
            continue
        if (entry.get('paperID') != paper_id or entry.get('sourceHash') != source_hash
                or entry.get('scope') != 'public-abstract' or entry.get('task') not in tasks):
            continue
        value = entry.get('value')
        if not isinstance(value, dict) or not value:
            continue
        task = entry['task']
        previous = found.get(task)
        if previous is not None and previous.get('value') != value:
            raise ReconcileRefusal('cache_conflict', task=task)
        found.setdefault(task, entry)
    return found


def _already_billed(row):
    if row.get('providerUsageKnown') is True:
        return True
    usage = row.get('providerUsage')
    if isinstance(usage, dict) and any(
            type(usage.get(key)) is int and usage[key] > 0
            for key in ('prompt_tokens', 'completion_tokens', 'total_tokens')):
        return True
    return row.get('providerFinishReason') in ('stop', 'length')


def _other_uncertain_tasks(ledger, row):
    covered = set()
    for daily in ledger['days'].values():
        for other in daily.get('requests', []):
            if other is row or not isinstance(other, dict) or other.get('status') not in UNCERTAIN:
                continue
            try:
                covered.update(_tasks(other))
            except ReconcileRefusal:
                covered.update(TASKS)
    return covered


def _release_global(scope, reason, still_blocked):
    if still_blocked or not reason:
        return []
    released = []
    if scope.get('paused') == reason:
        scope.pop('paused', None)
        released.append('paused')
    reasons = scope.get('pauseReasons')
    if isinstance(reasons, list) and reason in reasons:
        kept = [item for item in reasons if item != reason]
        if kept:
            scope['pauseReasons'] = kept
        else:
            scope.pop('pauseReasons', None)
        released.append('pauseReasons')
    return released


def _release_tasks(scope, tasks, reason, still_blocked):
    paused = scope.get('pausedTasks')
    if not isinstance(paused, dict) or not reason:
        return []
    released = []
    for task in tasks:
        if task in still_blocked or paused.get(task) != reason:
            continue
        paused.pop(task, None)
        released.append(task)
    if not paused:
        scope.pop('pausedTasks', None)
    return released


def reconcile(ledger, cache, request_id, who, why, when):
    """Return ``(updated_ledger, report)``. The inputs are not mutated.

    ``updated_ledger`` is the original object when the request was already
    reconciled. A refusal raises ``ReconcileRefusal`` and changes nothing.
    """
    if not isinstance(who, str) or not who.strip() or not isinstance(why, str) or not why.strip():
        raise ReconcileRefusal('who_or_why_missing')
    if len(who.strip()) > 200 or len(why.strip()) > 500 or any(ch in who + why for ch in '\r\n'):
        raise ReconcileRefusal('who_or_why_missing')
    if not isinstance(when, str) or not when.strip():
        raise ReconcileRefusal('when_missing')
    day, daily, row = _find_request(ledger, request_id)
    tasks = _tasks(row)
    paper_id, source_hash = row.get('paperID'), row.get('sourceHash')
    if not isinstance(paper_id, str) or not paper_id or not isinstance(source_hash, str):
        raise ReconcileRefusal('request_identity_incomplete')
    answers = _matching_answers(cache, paper_id, source_hash, tasks)
    missing = [task for task in tasks if task not in answers]
    status = row.get('status')
    if status == RECOVERED and not missing:
        return ledger, {
            'status': 'already_reconciled', 'requestId': request_id, 'day': day,
            'paperID': paper_id, 'tasks': tasks, 'reused': True, 'newProviderCall': False,
            'wrote': False,
        }
    if status not in UNCERTAIN:
        raise ReconcileRefusal('request_not_uncertain', status=status if isinstance(status, str) else '')
    if missing:
        code = 'answer_not_persisted_would_double_bill' if _already_billed(row) else 'answer_not_located'
        raise ReconcileRefusal(
            code, day=day, paperID=paper_id, missingTasks=missing,
            providerUsageKnown=row.get('providerUsageKnown') is True,
            providerFinishReason=row.get('providerFinishReason') if isinstance(row.get('providerFinishReason'), str) else '',
            reservedAttempts=row.get('reservedAttempts'), reservedOutputTokens=row.get('reservedOutputTokens'))
    updated = copy.deepcopy(ledger)
    _, updated_daily, updated_row = _find_request(updated, request_id)
    reason = updated_row.get('failureCode') if isinstance(updated_row.get('failureCode'), str) else ''
    still_blocked = _other_uncertain_tasks(updated, updated_row)
    record = {
        'at': when, 'who': who.strip(), 'why': why.strip(), 'requestId': request_id,
        'from': status, 'to': RECOVERED, 'reusedTasks': tasks, 'newProviderCall': False,
        'providerCallRepeated': False,
    }
    updated_row['status'] = RECOVERED
    updated_row['reconciliation'] = record
    released = []
    for scope, label in ((updated, 'ledger'), (updated_daily, 'day')):
        for field in _release_global(scope, reason, still_blocked):
            released.append(label + '.' + field)
        for task in _release_tasks(scope, tasks, reason, still_blocked):
            released.append(label + '.pausedTasks.' + task)
    updated.setdefault('resolvedPauses', []).append(dict(record, day=day, pauseReleased=released))
    kept = bool(updated.get('paused') or updated_daily.get('paused') or updated.get('pausedTasks') or updated_daily.get('pausedTasks')
                or updated.get('pauseReasons') or updated_daily.get('pauseReasons'))
    return updated, {
        'status': 'reconciled', 'requestId': request_id, 'day': day, 'paperID': paper_id,
        'tasks': tasks, 'reused': True, 'newProviderCall': False, 'pauseReleased': released,
        'pauseKept': kept, 'who': who.strip(), 'why': why.strip(), 'at': when, 'wrote': False,
    }


def _write_ledger(path, ledger):
    text = json.dumps(ledger, ensure_ascii=False, indent=1) + '\n'
    tmp = path.with_name('.' + path.name + '.tmp')
    try:
        tmp.write_text(text)
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--request-id', required=True)
    parser.add_argument('--who', required=True)
    parser.add_argument('--why', required=True)
    parser.add_argument('--apply', action='store_true', help='write the local ledger; still does not push or call a model')
    args = parser.parse_args(argv)
    ledger = json.loads(args.ledger.read_text())
    cache = json.loads(args.cache.read_text())
    when = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        updated, report = reconcile(ledger, cache, args.request_id, args.who, args.why, when)
    except ReconcileRefusal as exc:
        print(json.dumps({'status': 'refused', 'code': exc.code, 'requestId': args.request_id, **exc.detail}, ensure_ascii=False))
        return 2
    if report['status'] == 'reconciled' and not args.apply:
        report['status'] = 'dry_run'
    elif report['status'] == 'reconciled' and args.apply:
        _write_ledger(args.ledger, updated)
        report['wrote'] = True
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
