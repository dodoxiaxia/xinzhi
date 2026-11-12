"""Beijing calendar date is the PubMed publication-date upper bound."""
import datetime
import inspect
import unittest

import fetch_archive
import fetch_pubmed
from publication_window import beijing_date, publication_bounds

UTC = datetime.timezone.utc


class PublicationWindowTests(unittest.TestCase):
    def test_upper_bound_is_the_beijing_date_across_midnight(self):
        # 2026-11-11 23:30 UTC is 2026-11-12 07:30 in Beijing. A UTC upper bound would be Nov 11.
        now = datetime.datetime(2026, 11, 11, 23, 30, tzinfo=UTC)
        start, end = publication_bounds(now, 30)
        self.assertEqual(beijing_date(now).isoformat(), '2026-11-12')
        self.assertEqual(end, '2026/11/12')
        self.assertEqual(start, '2026/10/13')
        self.assertNotEqual(end, now.strftime('%Y/%m/%d'))

    def test_same_calendar_day_keeps_a_utc_afternoon_on_that_beijing_date(self):
        now = datetime.datetime(2026, 11, 12, 6, 0, tzinfo=UTC)  # 14:00 Beijing
        self.assertEqual(publication_bounds(now, 7), ('2026/11/05', '2026/11/12'))

    def test_naive_clock_is_rejected(self):
        with self.assertRaises(ValueError):
            publication_bounds(datetime.datetime(2026, 11, 12, 0, 0), 1)

    def test_fetch_scripts_ask_for_the_beijing_upper_bound(self):
        self.assertIn('publication_bounds', inspect.getsource(fetch_pubmed.main))
        self.assertIn('publication_bounds', inspect.getsource(fetch_archive.main))
        self.assertNotIn("now.strftime('%Y/%m/%d')", inspect.getsource(fetch_pubmed.main))
        self.assertNotIn('timezone.utc).date()', inspect.getsource(fetch_archive.main))


if __name__ == '__main__':
    unittest.main()
