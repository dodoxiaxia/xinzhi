import datetime
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fast_refresh_gate as gate  # noqa: E402

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 10, 11, 6, 7, tzinfo=UTC)  # 14:07 Beijing
DONE = {'day': '2026-10-11'}


def last(minutes_ago, status='success'):
    return {'status': status, 'startedAt': (NOW - datetime.timedelta(minutes=minutes_ago)).isoformat()}


class FastRefreshGateTests(unittest.TestCase):
    def test_two_hourly_dispatch_runs_every_four_hours(self):
        self.assertEqual(gate.decide(last(120), DONE, NOW)[0], False)
        self.assertEqual(gate.decide(last(240), DONE, NOW)[0], True)
        self.assertEqual(gate.decide(last(30), DONE, NOW)[0], False)  # GitHub cron right after a dispatch

    def test_three_hour_gap_runs(self):
        self.assertTrue(gate.decide(last(180), DONE, NOW)[0])

    def test_missing_full_refresh_is_never_skipped(self):
        self.assertEqual(gate.decide(last(20), {'day': '2026-10-10'}, NOW), (True, 'full_refresh_due'))

    def test_before_the_full_refresh_hour_only_the_interval_counts(self):
        early = datetime.datetime(2026, 10, 10, 19, 7, tzinfo=UTC)  # 03:07 Beijing
        self.assertFalse(gate.decide({'status': 'success', 'startedAt': (early - datetime.timedelta(minutes=60)).isoformat()},
                                     {'day': '2026-10-10'}, early)[0])

    def test_failures_and_unreadable_reports_fail_open(self):
        self.assertTrue(gate.decide(last(20, 'failed'), DONE, NOW)[0])
        self.assertTrue(gate.decide({}, DONE, NOW)[0])
        self.assertTrue(gate.decide({'status': 'success', 'startedAt': 'garbage'}, DONE, NOW)[0])
        self.assertTrue(gate.decide({'status': 'success', 'startedAt': '2026-10-11T06:00:00'}, DONE, NOW)[0])
        self.assertTrue(gate.decide(last(-30), DONE, NOW)[0])  # clock skew: a future start never blocks

    def test_push_deploys_do_not_postpone_timed_runs(self):
        push = last(37)  # a code merge deployed 37 minutes ago
        self.assertTrue(gate.decide(push, DONE, NOW, timed={'startedAt': (NOW - datetime.timedelta(minutes=240)).isoformat()})[0])
        self.assertFalse(gate.decide(push, DONE, NOW, timed={'startedAt': (NOW - datetime.timedelta(minutes=120)).isoformat()})[0])
        self.assertFalse(gate.decide(push, DONE, NOW, timed={})[0])  # no marker yet: previous behaviour

    def test_main_prints_step_outputs(self):
        import io, contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            gate.main(['gate', '/nonexistent/last.json', '/nonexistent/marker.json'])
        self.assertIn('run=true', out.getvalue())


if __name__ == '__main__':
    unittest.main()
