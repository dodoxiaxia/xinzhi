"""Offline aliases and source-group regressions from actual watched journals."""
import unittest

from enrich_metadata import clean_journal_name, classify_clinical_tier, classify_publisher


class JournalMetadataTests(unittest.TestCase):
    def test_actual_pubmed_names_and_feed_aliases_converge(self):
        cases = [
            ('Journal of the American Heart Association', 'JAHA', 'Journal of the American Heart Association', 'AHA (Circulation)'),
            ('European heart journal', 'EHJ: Current Issue', 'European Heart Journal', 'Oxford (OUP / ESC)'),
            ('The New England journal of medicine', 'NEJM', 'New England Journal of Medicine', 'MMS (NEJM)'),
            ('Journal of cardiovascular electrophysiology', 'JCE', 'Journal of Cardiovascular Electrophysiology', 'Wiley'),
            ('Heart (British Cardiac Society)', 'Heart Online First', 'Heart', 'BMJ Group'),
            ('JACC. Clinical electrophysiology', 'JACC: CE', 'JACC: Clinical Electrophysiology', 'Elsevier / ACC / HRS'),
            ('European heart journal. Digital health', 'EHJ-Digital Health', 'European Heart Journal - Digital Health', 'Oxford (OUP / ESC)'),
            ('NPJ digital medicine', 'npj Digital Medicine', 'npj Digital Medicine', 'Nature Portfolio'),
        ]
        for full, alias, canonical, publisher in cases:
            with self.subTest(journal=full):
                for name in (full, full.upper(), alias, alias.lower()):
                    self.assertEqual(clean_journal_name(name), canonical)
                    self.assertEqual(classify_publisher(name, 'https://doi.org/10.1234/test'), publisher)

    def test_source_groups_are_stable_across_aliases(self):
        cases = [
            ('European heart journal', 'EHJ: Current Issue', '心血管旗舰顶刊'),
            ('JACC. Clinical electrophysiology', 'JACC: CE', '心律失常与电生理'),
            ('Hypertension (Dallas, Tex. : 1979)', 'Hypertension', '脑血管与高血压'),
            ('Circulation. Cardiovascular interventions', 'Circ: Cardiovascular Interventions', '冠脉介入与结构'),
            ('European heart journal. Cardiovascular Imaging', 'European Heart Journal - Cardiovascular Imaging', '心血管影像与表型'),
        ]
        for full, alias, expected in cases:
            with self.subTest(journal=full):
                self.assertEqual(classify_clinical_tier(full), expected)
                self.assertEqual(classify_clinical_tier(alias), expected)

    def test_heart_failure_and_brain_do_not_match_ai_substrings(self):
        self.assertEqual(classify_clinical_tier('Nature Medicine', 'Polypill for heart failure with reduced ejection fraction: the POLY-HF randomized trial'), '心血管综合与其他')
        self.assertEqual(classify_clinical_tier('Nature medicine', 'Blood proteomics of menopause map to brain aging and dementia risk.'), '顶级综合与科学')
        self.assertEqual(classify_clinical_tier('Nature Medicine', 'Artificial intelligence in clinical care'), 'AI医疗与数字医学')

    def test_general_ai_sources_require_explicit_medical_cues(self):
        self.assertEqual(classify_clinical_tier('Nature Machine Intelligence', 'A large-scale randomized study of large language model feedback in peer review'), '前沿大模型与科技')
        self.assertEqual(classify_clinical_tier('Nature Machine Intelligence', 'Deep learning for cardiac diagnosis'), 'AI医疗与数字医学')
        self.assertEqual(classify_clinical_tier('Communications Medicine', 'Treatment of a disease'), '顶级综合与科学')
        self.assertEqual(classify_clinical_tier('npj Health Systems', 'Hospital systems and care'), '综合医学与其他')

    def test_ambiguous_journal_substrings_do_not_imply_cardiology_or_publisher(self):
        self.assertEqual(classify_clinical_tier('Breast Cancer Research', 'Tumor response'), '综合医学与其他')
        self.assertEqual(classify_clinical_tier('Unknown', 'Total intravenous anesthesia for noncardiac surgery'), '综合医学与其他')
        self.assertEqual(classify_publisher('Arabian Journal for Science and Engineering'), '其他学术刊物')
        self.assertEqual(classify_publisher('Unknown', 'https://pubmed.ncbi.nlm.nih.gov/12345/'), '其他学术刊物')
        self.assertEqual(classify_publisher('Unknown', 'https://evil.test/?url=https://ahajournals.org'), '其他学术刊物')

    def test_collection_names_remain_source_labels(self):
        self.assertEqual(clean_journal_name('atrial fibrillation'), 'PubMed: 房颤专病追踪')
        self.assertEqual(classify_publisher('atrial fibrillation'), 'PubMed 专题追踪')


if __name__ == '__main__':
    unittest.main()
