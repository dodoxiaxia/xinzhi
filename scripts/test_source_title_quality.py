#!/usr/bin/env python3
import unittest
import source_title_quality as q


class SourceTitleQualityTests(unittest.TestCase):
    def test_journal_name_as_title_is_unusable(self):
        ok, reason = q.usable_source_title({'title': 'JAMA', 'journal': 'JAMA Current Issue', 'cleanJournal': 'JAMA',
                                            'doi': '10.1001/jama.2025.16112'})
        self.assertFalse(ok)
        self.assertEqual(reason, 'unusable_title_equals_journal')

    def test_section_heading_is_unusable(self):
        ok, reason = q.usable_source_title({'title': 'Invited Commentary LESS IS MORE',
                                            'journal': 'JAMA Internal Medicine'})
        self.assertFalse(ok)
        self.assertEqual(reason, 'unusable_section_heading')

    def test_normal_research_title_is_usable(self):
        ok, reason = q.usable_source_title({
            'title': 'Epicardial adipose tissue imaging as a cardiometabolic biomarker in diabetes: from pathophysiology to clinical translation',
            'journal': 'Cardiovascular Diabetology', 'doi': '10.1186/s12933-026-03403-w'})
        self.assertTrue(ok)
        self.assertEqual(reason, '')

    def test_openai_headlines_are_usable(self):
        self.assertTrue(q.usable_source_title({'title': 'The Silent Consensus', 'journal': 'OpenAI News'})[0])
        self.assertTrue(q.usable_source_title({'title': 'See PR scans in action', 'journal': 'OpenAI News'})[0])

    def test_crossref_repair_replaces_journal_name_when_official_title_is_usable(self):
        paper = {'title': 'JAMA', 'journal': 'JAMA', 'doi': '10.1001/jama.2026.14789'}
        repair = q.repair_title_from_work(paper, {'title': ['The Need to Avoid a Regulatory Gray Zone in Digital Wellness'],
                                                  'DOI': '10.1001/jama.2026.14789'})
        self.assertEqual(repair['title'], 'The Need to Avoid a Regulatory Gray Zone in Digital Wellness')
        self.assertEqual(repair['doi'], '10.1001/jama.2026.14789')
        self.assertEqual(repair['source'], 'crossref')

    def test_crossref_repair_does_not_invent_a_title_when_official_record_is_also_the_journal_name(self):
        paper = {'title': 'JAMA', 'journal': 'JAMA', 'doi': '10.1001/jama.2025.16112'}
        self.assertIsNone(q.repair_title_from_work(paper, {'title': ['JAMA'], 'DOI': '10.1001/jama.2025.16112'}))


if __name__ == '__main__':
    unittest.main()
