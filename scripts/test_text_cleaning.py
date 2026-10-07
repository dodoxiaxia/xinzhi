"""Offline regressions for preserving scientific comparisons through metadata ingestion."""
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

import archive_details
from build_data import clean
import fetch_archive
import fetch_pubmed
import generate_quicklooks as quicklooks


COMPARISONS = 'minimal lumen area <4.0 mm2 and maxLCBI4mm >315; P<0.001'


class TextCleaningTests(unittest.TestCase):
    def test_clinical_comparisons_survive_literal_and_encoded_input(self):
        for source in (COMPARISONS,
                       COMPARISONS.replace('<', '&lt;').replace('>', '&gt;'),
                       COMPARISONS.replace('<', '&#60;').replace('>', '&#x3e;')):
            with self.subTest(source=source):
                self.assertEqual(clean(source), COMPARISONS)
                self.assertEqual(quicklooks.clean_abstract(source), COMPARISONS)

    def test_inline_digits_and_paragraph_boundaries_survive(self):
        source = '<p>Area &lt;4 mm<sup>2</sup>.</p><p>Index &gt;315; P&lt;0.001.</p>'
        self.assertEqual(clean(source), 'Area <4 mm2. Index >315; P<0.001.')

    def test_literal_comparisons_inside_actual_markup_survive(self):
        self.assertEqual(clean('<p>Value <5 and comparator >6</p>'),
                         'Value <5 and comparator >6')

    def test_namespaced_markup_and_quoted_attributes_are_removed(self):
        source = '<jats:p title="threshold >315">Area <italic>&lt;4</italic> mm<sup>2</sup>.</jats:p><!--note--><jats:p>Next.</jats:p>'
        self.assertEqual(clean(source), 'Area <4 mm2. Next.')

    def test_decoded_entities_are_not_reparsed_as_markup(self):
        self.assertEqual(clean('<p>Literal &lt;sup&gt;2&lt;/sup&gt; and &lt;5 &gt;6.</p>'),
                         'Literal <sup>2</sup> and <5 >6.')
        self.assertEqual(clean('&amp;lt;4 and &amp;gt;315'), '&lt;4 and &gt;315')

    def test_pubmed_xml_ingestion_preserves_comparisons_in_sections_and_summary(self):
        xml = '''<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>12345678</PMID>
          <Article><ArticleTitle>A comparison study</ArticleTitle><Abstract>
          <AbstractText Label="METHODS">minimal lumen area &lt;4.0 mm<sup>2</sup> and maxLCBI4mm &gt;315; P&lt;0.001</AbstractText>
          </Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>'''
        row = fetch_pubmed.parse(ET.fromstring(xml))[0]
        self.assertEqual(row['abstractSections'][0]['text'], COMPARISONS)
        self.assertEqual(row['summary'], 'METHODS: ' + COMPARISONS)
        self.assertEqual(archive_details.parse_efetch(xml)['12345678']['a'][0]['t'], COMPARISONS)

    def test_quicklook_reuse_and_evidence_validation_preserve_numeric_source(self):
        abstract = ('Methods: ' + COMPARISONS + '. ' +
                    'Investigators collected longitudinal observations and examined clinical outcomes. ' * 3)
        paper = {'pmid': '12345678', 'sourceId': 'pubmed-journal-fallback',
                 'summary_truncated': False, 'abstractSections': [{'label': '', 'text': abstract}]}
        actual = quicklooks.local_abstract(paper)['abstract']
        self.assertEqual(actual, abstract.strip())
        output = {'title_zh': '比较研究', 'one_line': '研究定义阈值，未判断临床获益。',
                  'design': '面积<4.0 mm2，指标>315。', 'limits': '摘要未提供', 'why_read': '核对阈值',
                  'findings': [{'text': '面积阈值为4.0。', 'quote': 'minimal lumen area <4.0 mm2'},
                               {'text': '指标阈值为315。', 'quote': 'maxLCBI4mm >315'}]}
        self.assertEqual(quicklooks.validate(output, actual)['design'], output['design'])
        output['findings'][0]['text'] = '面积阈值为99。'
        with self.assertRaisesRegex(quicklooks.QuicklookError, 'numbers_not_in_abstract'):
            quicklooks.validate(output, actual)

    def test_alternate_abstract_sources_share_the_safe_cleaner(self):
        source = '<p>' + COMPARISONS + '.</p><p>' + 'Additional public abstract text. ' * 8 + '</p>'
        expected = clean(source)
        with patch.object(archive_details, 'get', return_value={
                'resultList': {'result': [{'abstractText': source}]}}):
            self.assertEqual(archive_details.epmc_abs('10.1000/offline'), expected)
        with patch.object(archive_details, 'get', return_value={'message': {'abstract': source}}):
            self.assertEqual(archive_details.crossref_abs('10.1000/offline'), expected)

    def test_archive_titles_preserve_comparisons_and_existing_period_rule(self):
        self.assertEqual(fetch_archive.clean_title('<i>' + COMPARISONS + '.</i>'), COMPARISONS)
        self.assertEqual(fetch_archive.clean_title('A title..'), 'A title..')


if __name__ == '__main__':
    unittest.main()
