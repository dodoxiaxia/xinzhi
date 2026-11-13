import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_pubmed  # noqa: E402
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

    def test_parse_feed_drops_out_of_scope_and_records_exclusion(self):
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel>'
            '<title>NEJM</title>'
            '<item><title>Adjuvant nivolumab in resected melanoma: phase 3 randomized trial</title>'
            '<link>https://www.nejm.org/doi/full/10.1056/NEJMoa0000001</link>'
            '<description>Patients with melanoma received adjuvant therapy.</description>'
            '<pubDate>Sat, 10 Oct 2026 06:00:00 -0400</pubDate>'
            '<dc:identifier>doi:10.1056/NEJMoa0000001</dc:identifier></item>'
            '<item><title>Empagliflozin in heart failure with reduced ejection fraction</title>'
            '<link>https://www.nejm.org/doi/full/10.1056/NEJMoa0000002</link>'
            '<description>Randomized controlled trial in patients with heart failure.</description>'
            '<pubDate>Sat, 10 Oct 2026 06:00:00 -0400</pubDate>'
            '<dc:identifier>doi:10.1056/NEJMoa0000002</dc:identifier></item>'
            '</channel></rss>'
        ).encode()
        parsed = refresh_feeds.parse_feed(xml, {'name': 'New England Journal of Medicine', 'id': 'nejm', 'url': 'https://www.nejm.org/rss'})
        self.assertEqual(len(parsed['items']), 1)
        self.assertIn('heart failure', parsed['items'][0]['title'].lower())
        self.assertEqual(parsed['scopeExcludedCount'], 1)
        self.assertEqual(parsed['scopeExcludedReasons'], {'unrelated_to_cv_or_medical_ai': 1})
        self.assertEqual(len(parsed['scopeExcluded']), 1)
        self.assertEqual(parsed['scopeExcluded'][0]['reason'], 'unrelated_to_cv_or_medical_ai')
        self.assertEqual(parsed['scopeExcluded'][0]['doi'], '10.1056/nejmoa0000001')
        self.assertTrue(parsed['scopeExcluded'][0]['detail'])

    def test_pubmed_parse_fetch_filters_out_of_scope_with_mesh_and_records_it(self):
        xml = b'''<PubmedArticleSet>
          <PubmedArticle><MedlineCitation><PMID>11111111</PMID>
            <Article><ArticleTitle>Cardiac fibrosis signaling</ArticleTitle><Journal><Title>Circulation Research</Title></Journal></Article>
            <MeshHeadingList><MeshHeading><DescriptorName>Animals</DescriptorName></MeshHeading><MeshHeading><DescriptorName>Mice</DescriptorName></MeshHeading></MeshHeadingList>
          </MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1161/circres.001</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
          <PubmedArticle><MedlineCitation><PMID>22222222</PMID>
            <Article><ArticleTitle>Catheter ablation for atrial fibrillation</ArticleTitle><Journal><Title>Circulation</Title></Journal></Article>
            <MeshHeadingList><MeshHeading><DescriptorName>Humans</DescriptorName></MeshHeading></MeshHeadingList>
          </MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1161/circ.002</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
        </PubmedArticleSet>'''
        excluded = []
        items = fetch_pubmed.parse_fetch(xml, excluded_out=excluded)
        self.assertEqual([item['pmid'] for item in items], ['22222222'])
        self.assertEqual(len(excluded), 1)
        self.assertEqual(excluded[0]['pmid'], '11111111')
        self.assertEqual(excluded[0]['reason'], 'basic_research')
        self.assertTrue(excluded[0]['detail'])


if __name__ == '__main__':
    unittest.main()
