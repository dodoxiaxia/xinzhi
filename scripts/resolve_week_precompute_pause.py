"""One-off, receipt-bound resolution of the 2026-10-07 weekly precompute pause.

The 2026-10-07 study request was recorded as failed_or_uncertain and paused all
later paid precompute. Its fixed receipt (editorial/week_precompute_receipt_20261007.json)
establishes the outcome: the runtime returned http_502:quote_not_in_abstract,
"study failed evidence validation; no usable result". The outcome is therefore
known, so the row becomes the terminal ``rejected`` status. Reservations,
reconciliation and history are kept; only that row and its pause change.

Applies only to the exact legacy record; anything else is left untouched.
Usage: python3 scripts/resolve_week_precompute_pause.py data/week-precompute-ledger.json
"""
import datetime
import json
import sys
from pathlib import Path

import week_precompute_budget as budget

ROOT = Path(__file__).resolve().parents[1]
RECEIPT = ROOT / 'editorial/week_precompute_receipt_20261007.json'


def resolve(ledger, receipt, when):
    if not budget._known_receipt(receipt):
        raise ValueError('receipt_mismatch')
    daily = ledger.get('days', {}).get(budget._LEGACY_DAY)
    if not isinstance(daily, dict) or daily.get('reservedOutputTokens') != 3800:
        raise ValueError('legacy_day_not_reconciled')
    rows = [r for r in daily.get('requests', []) if r.get('paperID') == budget._LEGACY_PAPER
            and r.get('sourceHash') == budget._LEGACY_HASH and r.get('task') == 'study'
            and r.get('at') == budget._LEGACY_REQUESTS[1][2]]
    if len(rows) != 1:
        raise ValueError('legacy_request_not_found')
    row = rows[0]
    if row['status'] == 'rejected':
        return 'already_resolved'
    if row['status'] != 'failed_or_uncertain' or row.get('reservedOutputTokens') != 3800:
        raise ValueError('legacy_request_changed')
    others = [r for d in ledger['days'].values() for r in d.get('requests', []) if r is not row and r.get('status') in ('started', 'failed_or_uncertain')]
    if others or {ledger.get('paused'), daily.get('paused')} - {budget._LEGACY_ERROR, None}:
        raise ValueError('other_uncertain_work_present')
    resolution = {'at': when, 'from': 'failed_or_uncertain', 'to': 'rejected', 'pause': budget._LEGACY_ERROR,
                  'receipt': RECEIPT.name, 'basis': 'receipt secondPost: study failed evidence validation; no usable result',
                  'authorizedBy': 'site owner, 2026-10-10 maintenance request'}
    row.update(status='rejected', failureCode=budget._LEGACY_ERROR)
    for target in (ledger, daily):
        target.pop('paused', None)
        target.pop('pauseReasons', None)
    daily['pauseResolution'] = resolution
    ledger.setdefault('resolvedPauses', []).append(dict(resolution, day=budget._LEGACY_DAY))
    return 'resolved'


def main():
    path = Path(sys.argv[1])
    ledger = json.loads(path.read_text())
    receipt = json.loads(RECEIPT.read_text())
    status = resolve(ledger, receipt, datetime.datetime.now(datetime.timezone.utc).isoformat())
    path.write_text(json.dumps(ledger, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'status': status}))


if __name__ == '__main__':
    main()
