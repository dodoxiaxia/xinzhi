"""Offline regressions for designs that change clinical evidence interpretation."""
import unittest

from enrich_metadata import classify_study_design, extract_quantitative_metrics


class StudyDesignTests(unittest.TestCase):
    def test_actual_cardiovascular_metadata(self):
        # Fixed excerpts from the 2026-09-30 candidates snapshot. Keeping the
        # PMID makes each regression traceable after the rolling feed expires.
        cases = [
            ('pmid-42786657',
             'Clinical Outcomes of Left Atrial Appendage Occlusion During Cardiac Surgery in Patients Without Atrial Fibrillation: A Systematic Review and Meta-Analysis.',
             'METHODS: We searched PubMed, Web of Science, EMBASE, and the Cochrane Library for randomized controlled trials and observational studies comparing surgical left atrial appendage occlusion (LAAO) versus no LAAO in patients with sinus rhythm undergoing cardiac surgery.',
             ['Journal Article'], 'Meta/综述'),
            ('pmid-42804572',
             'From Hippocrates to Biologics, The Evolving History of Pericarditis: A Review.',
             'Randomized trials established colchicine as a cornerstone therapy for both acute and recurrent pericarditis.',
             ['Journal Article', 'Review', 'Historical Article'], '叙述综述'),
            ('pmid-42757907',
             'Outcome-Guided Immunosuppressive Therapy and Clinical Events in Patients With Cardiac Sarcoidosis: An Observational Registry.',
             'Because treatment was not randomized, these associations cannot establish causality.',
             ['Journal Article'], '队列研究'),
        ]
        for paper_id, title, summary, pub_types, design in cases:
            with self.subTest(paper_id=paper_id):
                self.assertEqual(classify_study_design(title, summary, pub_types), design)

    def test_review_title_overrides_randomized_studies_in_abstract(self):
        self.assertEqual(classify_study_design('A systematic review and meta-analysis of randomised controlled trials'), 'Meta/综述')
        self.assertEqual(classify_study_design('Cardiovascular care: a review', 'Randomized trials improved care.'), '叙述综述')

    def test_observational_design_and_negation(self):
        self.assertEqual(classify_study_design('An observational registry', 'Treatment was not randomized.'), '队列研究')
        self.assertEqual(classify_study_design('Non-randomized controlled trial of treatment'), '研究类型待核验')
        self.assertEqual(classify_study_design('Phase 2 single-arm trial'), '研究类型待核验')

    def test_direct_allocation_evidence(self):
        self.assertEqual(classify_study_design('An open-label randomized controlled trial'), 'RCT')
        self.assertEqual(classify_study_design('Treatment of disease', 'BACKGROUND: Earlier randomized trials were inconclusive. METHODS: Patients were randomly assigned to therapy or placebo. RESULTS: Outcomes improved.'), 'RCT')
        self.assertEqual(classify_study_design('Treatment of disease', '', ['Journal Article', 'Randomized Controlled Trial']), 'RCT')

    def test_mentions_and_synthesis_are_not_allocation(self):
        self.assertEqual(classify_study_design('Treatment of disease', 'Earlier randomized controlled trials and guidelines were reviewed.'), '研究类型待核验')
        self.assertEqual(classify_study_design('Treatment of disease', 'METHODS: We searched databases for randomized controlled trials. RESULTS: Five studies were included.'), '研究类型待核验')
        self.assertEqual(classify_study_design('Experimental treatment', 'METHODS: Mice were randomly assigned to treatment or control.'), '研究类型待核验')
        self.assertEqual(classify_study_design('A large-scale randomized study of large language model feedback in peer review'), '研究类型待核验')

    def test_unknown_is_explicit_and_ai_does_not_prove_validation(self):
        for title in ('Untitled', 'AI for patient care', 'Deep learning for ECG', 'Electronic health record outcomes', 'A phase 2 study', ''):
            with self.subTest(title=title):
                self.assertEqual(classify_study_design(title), '研究类型待核验')
        self.assertEqual(classify_study_design('External validation of a prediction model'), '方法/模型验证')

    def test_protocol_and_commentary(self):
        self.assertEqual(classify_study_design('Protocol for a randomized controlled trial'), '研究方案')
        self.assertEqual(classify_study_design('[Comment] Findings from a randomized controlled trial'), '述评观点')

    def test_cross_sectional_design_remains_distinct(self):
        self.assertEqual(classify_study_design('A cross-sectional analysis of EHR data'), '横断面研究')


class AdditionalRegression(unittest.TestCase):
    def test_interpreting_guidelines_is_not_a_guideline(self):
        self.assertEqual(classify_study_design('Large language models standardize the interpretation of complex oncology guidelines for brain metastases'), '研究类型待核验')
    def test_registry_randomized_conflict_is_conservative(self):
        self.assertEqual(classify_study_design('A registry-based randomized trial of care'), '研究类型待核验')


class OctoberStudyMetadataRegression(unittest.TestCase):
    def test_case_control_title_and_methods_remain_distinct_from_cohort(self):
        title = 'Computed Tomography-Based Periaortic Adipose Tissue Imaging Phenotypes in Type B Aortic Dissection: A Retrospective Case-Control Study.'
        methods = ('METHODS: This retrospective case-control study included 100 patients with TBAD '
                   'and 50 normal controls frequency matched by age and sex. RESULTS: Associations were observed.')
        for heading, abstract in ((title, ''), ('Periaortic imaging phenotypes', methods),
                                  ('A retrospective case–control study', '')):
            with self.subTest(title=heading):
                self.assertEqual(classify_study_design(heading, abstract), '病例对照研究')

    def test_case_control_and_randomized_title_conflict_remains_unknown(self):
        self.assertEqual(classify_study_design('A case-control randomized controlled trial of care'), '研究类型待核验')

    def test_actual_ckm_jama_design_section_identifies_cohort(self):
        # DOI 10.1001/jamacardio.2026.4215; fixed public NCBI excerpt.
        summary = ('IMPORTANCE: The impact on outcomes remains poorly characterized. '
                   'OBJECTIVE: To evaluate the prevalence of CKM multimorbidity. '
                   'DESIGN, SETTING, AND PARTICIPANTS: This was a retrospective cohort study of patients '
                   'hospitalized for HF at US hospitals participating in the Get With The Guidelines-Heart Failure registry. '
                   'EXPOSURES: Presence of additional CKM conditions. RESULTS: Associations were observed.')
        self.assertEqual(classify_study_design('Cardiovascular-Kidney-Metabolic Overlap in Patients Hospitalized for Heart Failure.', summary), '队列研究')

    def test_prior_design_in_background_is_not_this_jama_study(self):
        summary = ('IMPORTANCE: Previous retrospective cohort studies and randomized clinical trials informed care. '
                   'DESIGN, SETTING, AND PARTICIPANTS: This study evaluated the treatment mechanism. '
                   'RESULTS: The background cohort provided context. CONCLUSIONS AND RELEVANCE: More work is needed.')
        self.assertEqual(classify_study_design('Treatment mechanisms', summary), '研究类型待核验')

    def test_integer_thousands_separators_preserve_entire_patient_count(self):
        for token in ('725 205', '725,205', '725\u00a0205', '725\u202f205', '1 725 205', '1,725,205'):
            with self.subTest(token=token):
                actual = extract_quantitative_metrics('', 'Among ' + token + ' patients, outcomes were assessed.')
                expected = 'n = 1,725,205' if token.startswith('1') else 'n = 725,205'
                self.assertEqual(actual['sampleSize'], expected)

    def test_actual_ckm_count_is_main_cohort_and_not_final_group_or_sum(self):
        summary = ('RESULTS: This study included 725 205 patients hospitalized for HF between 2019 and 2025 '
                   'and 123 271 Medicare beneficiaries hospitalized for HF between 2019 and 2023. '
                   'Among 725 205 patients hospitalized for HF, 521 739 had overlapping CKM conditions.')
        self.assertEqual(extract_quantitative_metrics('', summary)['sampleSize'], 'n = 725,205')

    def test_actual_swedegraft_randomized_count_is_not_mitt_or_calendar_year(self):
        # DOI 10.1001/jamacardio.2026.4222; do not derive a total or silently switch denominators.
        summary = ('The study was conducted between April 20, 2018, and June 3, 2020. '
                   'RESULTS: A total of 902 patients were randomized; 900 were included in the modified intention-to-treat population. '
                   'Among 900 patients, 454 were assigned to no-touch harvesting and 446 to conventional harvesting.')
        self.assertEqual(extract_quantitative_metrics('', summary)['sampleSize'], 'n = 902')

    def test_decimal_scientific_and_range_suffixes_are_not_patient_counts(self):
        for value in ('72.5', '725.205', '1.205', '.205', '1e3', '10-50', '-100'):
            with self.subTest(value=value):
                self.assertNotIn('sampleSize', extract_quantitative_metrics('', value + ' patients were described.'))

    def test_malformed_grouping_is_not_truncated_to_its_final_segment(self):
        for token in ('725 20', '725,20', '1234 567', '1,23,456'):
            with self.subTest(token=token):
                self.assertNotIn('sampleSize', extract_quantitative_metrics('', token + ' patients were described.'))

    def test_calendar_context_excluded_but_real_four_digit_counts_preserved(self):
        for text in ('In 2020 patients were screened.', 'During 2019 patients were evaluated.',
                     'Between 2019 and 2025 patients were screened.', '2019–2025 patients were screened.'):
            with self.subTest(text=text):
                self.assertNotIn('sampleSize', extract_quantitative_metrics('', text))
        self.assertEqual(extract_quantitative_metrics('', 'Among 2,020 patients, outcomes were evaluated.')['sampleSize'], 'n = 2,020')
        self.assertEqual(extract_quantitative_metrics('', 'A total of 2025 patients were enrolled.')['sampleSize'], 'n = 2,025')

    def test_existing_followup_and_registration_metadata_preserved(self):
        values = extract_quantitative_metrics('', 'Among 725 205 patients, follow-up was 7 years. ClinicalTrials.gov: NCT03501303.')
        self.assertEqual(values['followUp'], '7 years')
        self.assertEqual(values['trialId'], 'NCT03501303')

if __name__ == '__main__':
    unittest.main()
