"""Decide whether a timed fast refresh should run (owner choice 2026-10-11: every 3-4 hours).

The external dispatcher fires every 2 hours; GitHub cron is a fallback. A timed fast run is
skipped when the last successful refresh started less than the minimum interval ago, unless
today's paid full refresh is still missing (ci_daily would upgrade that run to catch it up).
Any unreadable input fails open: the run goes ahead. Prints GitHub step outputs.
"""
import datetime
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ci_daily import FULL_EARLIEST_HOUR  # noqa: E402

BEIJING = datetime.timezone(datetime.timedelta(hours=8))
DEFAULT_MINUTES = 170  # with the 2-hourly dispatcher this gives a 4-hour cadence


def read(path):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def decide(last, marker, now, minutes=DEFAULT_MINUTES):
    bj = now.astimezone(BEIJING)
    if bj.hour >= FULL_EARLIEST_HOUR and marker.get('day') != bj.date().isoformat():
        return True, 'full_refresh_due'
    if last.get('status') != 'success':
        return True, 'last_refresh_not_successful'
    try:
        started = datetime.datetime.fromisoformat(str(last.get('startedAt')))
        if started.tzinfo is None:
            raise ValueError
    except ValueError:
        return True, 'last_refresh_time_unknown'
    age = (now - started).total_seconds() / 60
    if 0 <= age < minutes:
        return False, 'recent_refresh_%dmin' % age
    return True, 'interval_elapsed'


def main(argv):
    try:
        minutes = int(os.environ.get('XINZHI_FAST_MIN_INTERVAL_MINUTES') or DEFAULT_MINUTES)
    except ValueError:
        minutes = DEFAULT_MINUTES
    run, reason = decide(read(argv[1]), read(argv[2]), datetime.datetime.now(datetime.timezone.utc), minutes)
    print('run=' + ('true' if run else 'false'))
    print('reason=' + reason)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
