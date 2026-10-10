import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import refresh_feeds  # noqa: E402

ITEM = ('<item><title><![CDATA[{title}]]></title><description><![CDATA[<p>Publication date: {date}</p>'
        '<p><b>Source:</b> JACC</p><p>Author(s): Olga Toleva, Ann Lee</p>]]></description>'
        '<link>https://www.sciencedirect.com/science/article/pii/S07351097{n}?dgcid=rss_sd_all</link></item>')


def feed(*dates):
    items = ''.join(ITEM.format(title='Coronary vasospasm trial lessons %d' % n, date=d, n=n) for n, d in enumerate(dates))
    return ('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>ScienceDirect Publication: JACC</title>'
            + items + '</channel></rss>').encode()


class ScienceDirectDateTests(unittest.TestCase):
    def parse(self, *dates):
        return refresh_feeds.parse_feed(feed(*dates), {'name': 'JACC', 'id': 'x', 'url': 'https://rss.sciencedirect.com/x'})['items']

    def test_available_online_day_becomes_the_date_and_citation_is_not_an_abstract(self):
        item = self.parse('Available online 7 October 2026')[0]
        self.assertEqual(item['date'], '2026-10-07T00:00:00+00:00')
        self.assertEqual(item['datePrecision'], 'day')
        self.assertIn('Available online', item['dateBasis'])
        self.assertEqual(item['summary'], '')
        self.assertEqual(item['abstractStatus'], 'non_abstract_metadata')
        self.assertEqual(item['authors'], ['Olga Toleva', 'Ann Lee'])

    def test_full_issue_day_is_labelled_as_issue_date(self):
        item = self.parse('1 November 2026')[0]
        self.assertEqual(item['date'], '2026-11-01T00:00:00+00:00')
        self.assertIn('刊期', item['dateBasis'])

    def test_month_only_issue_date_stays_undated(self):
        item = self.parse('October 2026')[0]
        self.assertEqual(item['date'], '')
        self.assertEqual(item['summary'], '')

    def test_ordinary_description_is_untouched(self):
        self.assertIsNone(refresh_feeds.sciencedirect_metadata('Background: a real abstract about atrial fibrillation.'))


if __name__ == '__main__':
    unittest.main()
