import contextlib
import datetime
import io
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_pubmed  # noqa: E402
import merge_candidates  # noqa: E402
import refresh_feeds  # noqa: E402
from test_release_build import synthetic_root  # noqa: E402

CVD_FIXTURE = Path(__file__).resolve().parent / 'fixtures/pubmed-rss-cardiovasc-diabetol-03344.rss'
CVD_SOURCE = {
    'id': '2748ce902a2a',
    'name': 'Cardiovascular Diabetology',
    'url': 'https://pubmed.ncbi.nlm.nih.gov/rss/search/example/?limit=50',
    'enabled': True,
}

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


class PubMedPublicationDatePriorityTests(unittest.TestCase):
    def setUp(self):
        self.guards = [
            patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')),
            patch('socket.create_connection', side_effect=AssertionError('Network forbidden')),
        ]
        for guard in self.guards:
            guard.start()
            self.addCleanup(guard.stop)

    def test_03344_uses_citation_first_pub_date_and_is_excluded_while_nov23_qualifies(self):
        now = datetime.datetime(2026, 11, 24, 22, 8, 43, tzinfo=datetime.timezone.utc)
        checked_at = now.isoformat()
        raw = CVD_FIXTURE.read_bytes()
        parsed = refresh_feeds.parse_feed(raw, CVD_SOURCE, checked_at=checked_at)
        by_doi = {item['doi']: item for item in parsed['items']}

        old_item = by_doi['10.1186/s12933-026-03344-4']
        self.assertEqual(old_item['date'], '2026-08-28T00:00:00+00:00')
        self.assertEqual(old_item['datePrecision'], 'day')
        self.assertEqual(old_item['entrezDate'], '2026-11-23T06:00:00-05:00')
        self.assertEqual(refresh_feeds.eligible(old_item, now), (False, 'olderThan14Days'))

        fresh_item = by_doi['10.1000/synthetic-cvd-nov23']
        self.assertEqual(fresh_item['date'], '2026-11-23T00:00:00+00:00')
        self.assertEqual(fresh_item['datePrecision'], 'day')
        self.assertEqual(refresh_feeds.eligible(fresh_item, now), (True, None))

        details = {k: v for k, v in parsed.items() if k not in ('items', 'scopeExcluded')}
        report = refresh_feeds._report(
            CVD_SOURCE, ok=True, status='ok', items=len(parsed['items']),
            startedAt=checked_at, checkedAt=checked_at, httpStatus=200, attempted=True,
            responseUrl=CVD_SOURCE['url'], responseContentType='application/rss+xml',
            **details,
        )
        feed_doc, health = refresh_feeds.build_results([CVD_SOURCE], [(report, parsed['items'])], now=now)
        self.assertEqual([it['doi'] for it in feed_doc['items']], ['10.1000/synthetic-cvd-nov23'])
        self.assertEqual(health['sources'][0]['latestPublishedAt'], '2026-11-23T00:00:00+00:00')

        class Clock(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                base = cls(2026, 11, 24, 22, 8, 43, tzinfo=datetime.timezone.utc)
                return base.replace(tzinfo=None) if tz is None else base.astimezone(tz)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            synthetic_root(root)
            (root / 'data' / 'feeds.json').write_text(json.dumps(feed_doc, ensure_ascii=False), encoding='utf-8')
            (root / 'data' / 'source-health.json').write_text(json.dumps(health, ensure_ascii=False), encoding='utf-8')
            (root / 'data' / 'pubmed.json').write_text(json.dumps({
                'items': [], 'fetched': 0, 'totalHits': 0, 'truncated': False, 'journals': [],
            }), encoding='utf-8')
            with patch.object(merge_candidates, 'ROOT', root),                     patch.object(merge_candidates.datetime, 'datetime', Clock),                     patch.dict(os.environ, {**os.environ, 'XINZHI_DOI_LOOKUP': '0'}, clear=False),                     patch('subprocess.run') as run,                     contextlib.redirect_stdout(io.StringIO()):
                merge_candidates.main()
            run.assert_called_once()
            candidates = json.loads((root / 'data' / 'candidates.json').read_text(encoding='utf-8'))
            cand_dois = [it['doi'] for it in candidates['items']]
            self.assertNotIn('10.1186/s12933-026-03344-4', cand_dois)
            self.assertEqual(cand_dois, ['10.1000/synthetic-cvd-nov23'])

    def test_pubmed_rss_epub_beats_issue_and_pubdate_is_last_fallback(self):
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel>'
            '<item><title>Heart failure AI cohort with Epub date</title>'
            '<link>https://pubmed.ncbi.nlm.nih.gov/88800001/</link>'
            '<description>Cohort study in heart failure.</description>'
            '<content:encoded>&lt;div&gt;&lt;p&gt;&lt;b&gt;Eur Heart J&lt;/b&gt;. 2026 Nov 16;47(42):100-110. doi: 10.1000/epub.1. Epub 2026 Aug 28.&lt;/p&gt;&lt;/div&gt;</content:encoded>'
            '<pubDate>Mon, 23 Nov 2026 06:00:00 -0500</pubDate>'
            '<dc:identifier>pmid:88800001</dc:identifier><dc:identifier>doi:10.1000/epub.1</dc:identifier></item>'
            '<item><title>Heart failure cohort with month-only citation</title>'
            '<link>https://pubmed.ncbi.nlm.nih.gov/88800002/</link>'
            '<description>Cohort study in heart failure.</description>'
            '<content:encoded>&lt;div&gt;&lt;p&gt;&lt;b&gt;Eur Heart J&lt;/b&gt;. 2026 Nov;47(42):200-210. doi: 10.1000/month.2.&lt;/p&gt;&lt;/div&gt;</content:encoded>'
            '<pubDate>Mon, 23 Nov 2026 06:00:00 -0500</pubDate>'
            '<dc:identifier>pmid:88800002</dc:identifier><dc:identifier>doi:10.1000/month.2</dc:identifier></item>'
            '</channel></rss>'
        ).encode()
        items = {it['doi']: it for it in refresh_feeds.parse_feed(xml, CVD_SOURCE)['items']}
        self.assertEqual(items['10.1000/epub.1']['date'], '2026-08-28T00:00:00+00:00')
        self.assertEqual(items['10.1000/month.2']['date'], '2026-11-23T06:00:00-05:00')

    def test_fetch_pubmed_prefers_articledate_then_full_journal_pubdate_then_entrez(self):
        xml = '''<PubmedArticleSet>
          <PubmedArticle><MedlineCitation><PMID>1</PMID>
            <Article><ArticleTitle>Heart failure trial one</ArticleTitle>
              <Journal><Title>Cardiovascular Diabetology</Title>
                <JournalIssue><PubDate><Year>2026</Year><Month>Nov</Month><Day>15</Day></PubDate></JournalIssue>
              </Journal>
              <ArticleDate DateType="Electronic"><Year>2026</Year><Month>08</Month><Day>28</Day></ArticleDate>
            </Article></MedlineCitation>
            <PubmedData><History><PubMedPubDate PubStatus="entrez"><Year>2026</Year><Month>11</Month><Day>23</Day></PubMedPubDate></History>
              <ArticleIdList><ArticleId IdType="doi">10.1000/a1</ArticleId></ArticleIdList></PubmedData>
          </PubmedArticle>
          <PubmedArticle><MedlineCitation><PMID>2</PMID>
            <Article><ArticleTitle>Heart failure trial two</ArticleTitle>
              <Journal><Title>Cardiovascular Diabetology</Title>
                <JournalIssue><PubDate><Year>2026</Year><Month>Aug</Month><Day>28</Day></PubDate></JournalIssue>
              </Journal>
            </Article></MedlineCitation>
            <PubmedData><History><PubMedPubDate PubStatus="entrez"><Year>2026</Year><Month>11</Month><Day>23</Day></PubMedPubDate></History>
              <ArticleIdList><ArticleId IdType="doi">10.1000/a2</ArticleId></ArticleIdList></PubmedData>
          </PubmedArticle>
          <PubmedArticle><MedlineCitation><PMID>3</PMID>
            <Article><ArticleTitle>Heart failure trial three</ArticleTitle>
              <Journal><Title>Cardiovascular Diabetology</Title>
                <JournalIssue><PubDate><Year>2026</Year><Month>Nov</Month></PubDate></JournalIssue>
              </Journal>
            </Article></MedlineCitation>
            <PubmedData><History><PubMedPubDate PubStatus="entrez"><Year>2026</Year><Month>11</Month><Day>23</Day></PubMedPubDate></History>
              <ArticleIdList><ArticleId IdType="doi">10.1000/a3</ArticleId></ArticleIdList></PubmedData>
          </PubmedArticle>
        </PubmedArticleSet>'''
        parsed = {it['doi']: it for it in fetch_pubmed.parse(ET.fromstring(xml))}
        self.assertEqual((parsed['10.1000/a1']['date'], parsed['10.1000/a1']['dateBasis']), ('2026-08-28', 'ArticleDate'))
        self.assertEqual((parsed['10.1000/a2']['date'], parsed['10.1000/a2']['dateBasis']), ('2026-08-28', 'JournalIssue PubDate'))
        self.assertEqual((parsed['10.1000/a3']['date'], parsed['10.1000/a3']['datePrecision']), ('2026-11-23', 'day'))
        self.assertIn('entrez', parsed['10.1000/a3']['dateBasis'])


if __name__ == '__main__':
    unittest.main()
