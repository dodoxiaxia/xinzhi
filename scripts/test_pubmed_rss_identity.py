import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import refresh_feeds  # noqa: E402

FEED = ('<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel>'
        '<title>atrial fibrillation</title><item><title>Left atrial appendage occlusion versus anticoagulation in atrial fibrillation</title>'
        '<link>https://pubmed.ncbi.nlm.nih.gov/42855979/?utm_source=Other&amp;utm_medium=rss&amp;ff={ff}&amp;v=2.20.1</link>'
        '<description>CONCLUSIONS: Occlusion was associated with lower non-procedure-related bleeding in atrial fibrillation.</description>'
        '<pubDate>Sat, 10 Oct 2026 06:00:00 -0400</pubDate><dc:creator>Ahmed Nazmy</dc:creator><dc:creator>Ann Lee</dc:creator>'
        '<dc:identifier>pmid:42855979</dc:identifier><dc:identifier>doi:10.1111/PACE.70465</dc:identifier></item></channel></rss>')


def parse(ff):
    return refresh_feeds.parse_feed(FEED.format(ff=ff).encode(), {'name': 'atrial fibrillation', 'id': 'x', 'url': 'https://pubmed.ncbi.nlm.nih.gov/rss/search/x/'})['items'][0]


class PubMedRssIdentityTests(unittest.TestCase):
    def test_identifiers_and_authors_are_kept(self):
        item = parse('20261010082450')
        self.assertEqual(item['pmid'], '42855979')
        self.assertEqual(item['doi'], '10.1111/pace.70465')
        self.assertEqual(item['authors'], ['Ahmed Nazmy', 'Ann Lee'])
        self.assertEqual(item['url'], 'https://pubmed.ncbi.nlm.nih.gov/42855979/')

    def test_id_does_not_change_with_per_fetch_tracking(self):
        self.assertEqual(parse('20261010082450')['id'], parse('20261011093000')['id'])

    def test_other_links_are_untouched(self):
        self.assertEqual(refresh_feeds.canonical_pubmed_link('https://www.nature.com/articles/s41591-026-1?x=1'), 'https://www.nature.com/articles/s41591-026-1?x=1')
        self.assertEqual(refresh_feeds.canonical_pubmed_link('https://pubmed.ncbi.nlm.nih.gov/123/?ff=1', '456'), 'https://pubmed.ncbi.nlm.nih.gov/123/?ff=1')


if __name__ == '__main__':
    unittest.main()
