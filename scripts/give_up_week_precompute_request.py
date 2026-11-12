#!/usr/bin/env python3
"""Close the 2026-10-24 weekly precompute request without another model call.

That request finished at the provider (finish_reason stop, usage recorded) and
the checkpoint write then failed. The answer was not stored. Marking it
recovered would invent an answer, and calling the model again would bill the
same paper twice. The site owner decided to give the item up: the row becomes
the terminal status ``abandoned``, the recorded usage stays, and those three
tasks are not sent again.

The matching pause is cleared only when it is exactly this failure and no other
uncertain request remains. Any other pause, usage figure, or request is left
untouched. Dry-run is the default. ``--apply`` rewrites the local ledger only.
This command does not push, does not call a model, and does not change the cache.

The ledger is stored on the state branch (``data/`` is not part of this
repository). Run it on a restored state checkout. After ``--apply`` prints
``abandoned``, commit that ledger onto the state branch. This tool does not
push.

Usage:
  python3 scripts/give_up_week_precompute_request.py --ledger data/week-precompute-ledger.json
  python3 scripts/give_up_week_precompute_request.py --ledger data/week-precompute-ledger.json --apply
"""
from __future__ import annotations

import argparse
import copy
import datetime
import json
import os
import sys
from pathlib import Path

REQUEST_ID = '01e400be-2a46-4418-9778-2af3845f5478'
DAY = '2026-10-24'
PAPER_ID = 'doi:10.1016/j.jacadv.2026.103352'
SOURCE_HASH = 'ffb2c10426a83f92b2890f03ef2b693f74923e436d7a767250da02057746b200'
FAILURE = 'checkpoint_transport_uncertain'
TASKS = ['translate', 'study', 'quicklook']
AT = '2026-10-24T02:12:58.103872+00:00'
USAGE = {'prompt_tokens': 1489, 'completion_tokens': 936, 'total_tokens': 2425}
WHO = 'site owner'
WHY = '放弃这项 2026-10-24 的预生成，不再重跑。已记录的用量保留，不再次调用模型。'
UNCERTAIN = {'started', 'failed_or_uncertain'}


class GiveUpRefusal(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _usage_matches(row):
    usage = row.get('providerUsage')
    if not isinstance(usage, dict):
        return False
    return all(usage.get(key) == value for key, value in USAGE.items())


def _identity_matches(row):
    return (row.get('paperID') == PAPER_ID and row.get('sourceHash') == SOURCE_HASH
            and row.get('tasks') == TASKS and row.get('at') == AT
            and row.get('failureCode') == FAILURE and row.get('reservedAttempts') == 1
            and row.get('reservedOutputTokens') == 5800 and row.get('providerUsageKnown') is True
            and row.get('providerFinishReason') == 'stop' and _usage_matches(row))


def _find(ledger):
    if not isinstance(ledger, dict) or not isinstance(ledger.get('days'), dict):
        raise GiveUpRefusal('ledger_invalid')
    daily = ledger['days'].get(DAY)
    if not isinstance(daily, dict) or not isinstance(daily.get('requests'), list):
        raise GiveUpRefusal('request_not_found')
    found = [row for row in daily['requests'] if isinstance(row, dict) and row.get('requestId') == REQUEST_ID]
    if len(found) != 1:
        raise GiveUpRefusal('request_not_found' if not found else 'request_ambiguous')
    for day, other_day in ledger['days'].items():
        if not isinstance(other_day, dict):
            continue
        for row in other_day.get('requests') or []:
            if isinstance(row, dict) and row.get('requestId') == REQUEST_ID and day != DAY:
                raise GiveUpRefusal('request_ambiguous')
    row = found[0]
    if not _identity_matches(row):
        raise GiveUpRefusal('request_identity_mismatch')
    return daily, row


def _other_uncertain(ledger, row):
    for daily in ledger['days'].values():
        if not isinstance(daily, dict):
            continue
        for other in daily.get('requests') or []:
            if other is row or not isinstance(other, dict):
                continue
            if other.get('status') in UNCERTAIN:
                return True
    return False


def _pause_is_only_this(scope):
    if not isinstance(scope, dict):
        return False
    if scope.get('pausedTasks'):
        return False
    paused = scope.get('paused')
    if paused not in (None, FAILURE):
        return False
    reasons = scope.get('pauseReasons')
    if reasons is None:
        return True
    return isinstance(reasons, list) and set(reasons) <= {FAILURE}


def _clear_pause(scope):
    released = []
    if scope.get('paused') == FAILURE:
        scope.pop('paused', None)
        released.append('paused')
    reasons = scope.get('pauseReasons')
    if isinstance(reasons, list) and FAILURE in reasons:
        kept = [item for item in reasons if item != FAILURE]
        if kept:
            scope['pauseReasons'] = kept
        else:
            scope.pop('pauseReasons', None)
        released.append('pauseReasons')
    return released


def give_up(ledger, when):
    """Return ``(updated_ledger, report)``. The input ledger is not mutated.

    ``updated_ledger`` is the original object when this request was already
    abandoned. A refusal raises ``GiveUpRefusal`` and changes nothing.
    """
    if not isinstance(when, str) or not when.strip():
        raise GiveUpRefusal('when_missing')
    daily, row = _find(ledger)
    if row.get('status') == 'abandoned':
        return ledger, {
            'status': 'already_given_up', 'requestId': REQUEST_ID, 'day': DAY,
            'paperID': PAPER_ID, 'to': 'abandoned', 'newProviderCall': False,
            'providerCallRepeated': False, 'wrote': False,
        }
    if row.get('status') != 'failed_or_uncertain':
        raise GiveUpRefusal('request_not_uncertain')
    if _other_uncertain(ledger, row):
        raise GiveUpRefusal('other_uncertain_work_present')
    if not _pause_is_only_this(ledger) or not _pause_is_only_this(daily):
        raise GiveUpRefusal('pause_not_this_failure')
    updated = copy.deepcopy(ledger)
    updated_daily, updated_row = _find(updated)
    record = {
        'at': when, 'who': WHO, 'why': WHY, 'requestId': REQUEST_ID,
        'from': 'failed_or_uncertain', 'to': 'abandoned', 'newProviderCall': False,
        'providerCallRepeated': False,
        'basis': 'owner decision: give up this item; the billed answer was not stored',
    }
    updated_row['status'] = 'abandoned'
    updated_row['disposition'] = record
    released = []
    for scope, label in ((updated, 'ledger'), (updated_daily, 'day')):
        for field in _clear_pause(scope):
            released.append(label + '.' + field)
    updated.setdefault('resolvedPauses', []).append(dict(record, day=DAY, pauseReleased=released))
    return updated, {
        'status': 'abandoned', 'requestId': REQUEST_ID, 'day': DAY, 'paperID': PAPER_ID,
        'tasks': TASKS, 'newProviderCall': False, 'providerCallRepeated': False,
        'pauseReleased': released, 'who': WHO, 'why': WHY, 'at': when, 'wrote': False,
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
    parser.add_argument('--apply', action='store_true', help='write the local ledger; still does not push or call a model')
    args = parser.parse_args(argv)
    ledger = json.loads(args.ledger.read_text())
    when = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        updated, report = give_up(ledger, when)
    except GiveUpRefusal as exc:
        print(json.dumps({'status': 'refused', 'code': exc.code, 'requestId': REQUEST_ID}, ensure_ascii=False))
        return 2
    if report['status'] == 'abandoned' and not args.apply:
        report['status'] = 'dry_run'
    elif report['status'] == 'abandoned' and args.apply:
        _write_ledger(args.ledger, updated)
        report['wrote'] = True
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
