"""Offline official-record regressions for the v2 research-label audit."""
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

import archive_details
import build_public
import fetch_pubmed
from enrich_metadata import classify_study_design
from publication_status import ROOT, annotate_publication, checked_records, status_from_pubmed


class OfficialPublicationRegression(unittest.TestCase):
    def test_verified_audit_examples_and_bidirectional_notice_links(self):
        expected = {'41224473': '已撤稿', '41916660': '撤稿声明',
                    '41224475': '关注声明', '41412600': '撤稿声明',
                    '39043416': '已撤稿', '42104840': '研究方案',
                    '41771068': '研究方案', '40920457': '研究方案',
                    '42418170': '述评观点', '42418194': '述评观点'}
        byid = {r['pmid']: r for r in checked_records(str(ROOT))}
        for pmid, design in expected.items():
            with self.subTest(pmid=pmid):
                paper = dict(byid[pmid], studyDesign='RCT')
                result = build_public.public_paper(paper)
                self.assertEqual(result['studyDesign'], design)
                self.assertEqual(result['title'], paper['title'])
                self.assertEqual(result['doi'], paper['doi'])
                self.assertEqual(result['pubTypes'], paper['pubTypes'])
        original = annotate_publication(byid['41224473'])['publicationStatus']
        self.assertEqual(original['state'], 'retracted')
        self.assertEqual({r['pmid'] for r in original['related']}, {'41916660', '41916658', '41224475'})
        for pmid in ('41916660', '41224475'):
            self.assertEqual(annotate_publication(byid[pmid])['publicationStatus']['related'][0]['pmid'], '41224473')

    def test_identity_conflicts_do_not_spread_verified_status_or_commentary(self):
        record = next(r for r in checked_records(str(ROOT)) if r['pmid'] == '41224473')
        for change in ({'doi': '10.1000/other'}, {'title': 'Another trial'}):
            p = dict(record, pubTypes=[], pubmedRelations=[], studyDesign='RCT', **change)
            p.pop('relations')
            self.assertNotIn('publicationStatus', annotate_publication(p))
        # Exact DOI + title can associate an existing public-library record that has no PMID.
        p = dict(record, pmid='', pubTypes=[])
        self.assertEqual(annotate_publication(p)['studyDesign'], '已撤稿')
        p.update(pmid='99999999')
        self.assertNotIn('publicationStatus', annotate_publication(p))

    def test_unknown_status_objects_and_title_similarity_are_not_evidence(self):
        p = {'title': 'PREVENT-TAHA8 follow-up randomized controlled trial',
             'pmid': '99999999', 'publicationStatus': {'state': 'retracted', 'label': 'unverified allegation'}}
        self.assertNotIn('publicationStatus', build_public.public_paper(p))
        self.assertEqual(build_public.public_paper(p)['studyDesign'], 'RCT')

    def test_forward_concern_is_not_retraction_and_retraction_takes_priority(self):
        p = {'title': 'A randomized controlled trial', 'pmid': '99999999',
             'pubmedRelations': [{'type': 'ExpressionOfConcernIn', 'pmid': '99999998'}]}
        result = build_public.public_paper(p)
        self.assertEqual(result['studyDesign'], '存在关注声明')
        self.assertEqual(result['publicationStatus']['state'], 'concern')
        p['pubmedRelations'].append({'type': 'RetractionIn', 'pmid': '99999997'})
        self.assertEqual(build_public.public_paper(p)['studyDesign'], '已撤稿')

    def test_checked_role_never_hides_a_later_official_status(self):
        paper = dict(next(r for r in checked_records(str(ROOT)) if r['pmid'] == '42104840'))
        paper['pubmedRelations'] = [{'type': 'RetractionIn', 'pmid': '99999997'}]
        result = annotate_publication(paper)
        self.assertEqual(result['studyDesign'], '已撤稿')
        self.assertEqual(result['publicationStatus']['related'][0]['pmid'], '99999997')

    def test_registered_concern_notice_own_retraction_overrides_static_role(self):
        # Hypothetical future metadata only: no claim that PMID 41224475 is
        # currently retracted. Its present verified role remains a concern notice.
        record = next(r for r in checked_records(str(ROOT)) if r['pmid'] == '41224475')
        for update in ({'pubTypes': ['Retracted Publication']},
                       {'pubmedRelations': [{'type': 'RetractionIn', 'pmid': '99999997'}]}):
            with self.subTest(update=update):
                paper = dict(record, **update)
                result = annotate_publication(paper)
                self.assertEqual(result['studyDesign'], '已撤稿')
                self.assertEqual(result['publicationStatus']['state'], 'retracted')
                self.assertIn('41224473', {r['pmid'] for r in result['publicationStatus']['related']})
        self.assertEqual(annotate_publication(record)['publicationStatus']['state'], 'concern_notice')

    def test_correction_notice_own_retraction_overrides_its_target_role(self):
        paper = {'title': 'CORRECTION: A randomized trial', 'pmid': '99999996',
                 'pubTypes': ['Published Erratum'],
                 'pubmedRelations': [{'type': 'ErratumFor', 'pmid': '99999995'}]}
        self.assertEqual(annotate_publication(paper)['studyDesign'], '更正声明')
        for update in ({'pubTypes': ['Published Erratum', 'Retracted Publication']},
                       {'pubmedRelations': paper['pubmedRelations'] + [{'type': 'RetractionIn', 'pmid': '99999997'}]}):
            with self.subTest(update=update):
                result = annotate_publication(dict(paper, **update))
                self.assertEqual(result['studyDesign'], '已撤稿')
                self.assertEqual(result['publicationStatus']['state'], 'retracted')

    def test_retraction_notice_target_never_means_notice_itself_is_retracted(self):
        self.assertEqual(status_from_pubmed(['Retraction Notice'],
            [{'type': 'RetractionOf', 'pmid': '99999995'}]), 'retraction_notice')
        self.assertEqual(status_from_pubmed([], [{'type': 'RetractionOf', 'pmid': '99999995'}]), 'retraction_notice')
        self.assertEqual(status_from_pubmed(['Retraction Notice'],
            [{'type': 'RetractionOf', 'pmid': '99999995'}, {'type': 'RetractionIn', 'pmid': '99999997'}]), 'retracted')

    def test_public_projection_does_not_copy_arbitrary_relation_fields(self):
        p = {'title': 'A randomized controlled trial', 'pmid': '99999999',
             'pubmedRelations': [{'type': 'RetractionIn', 'pmid': '99999998', 'privateNotes': 'secret', 'url': 'https://evil.example/'},
                                 {'type': 'RetractionIn', 'pmid': '0?token=private'}]}
        result = build_public.public_paper(p)
        self.assertNotIn('secret', json.dumps(result))
        self.assertNotIn('evil', json.dumps(result))
        self.assertNotIn('token', json.dumps(result))
        self.assertEqual(result['publicationStatus']['related'][0]['url'], 'https://pubmed.ncbi.nlm.nih.gov/99999998/')

    def test_both_pubmed_ingest_routes_keep_official_relations(self):
        # Minimal structural fixture follows the official PREVENT XML paths.
        raw = b'''<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>99999999</PMID>
          <Article><ArticleTitle>A randomized trial</ArticleTitle><Journal><Title>BMJ</Title></Journal>
          <PublicationTypeList><PublicationType>Retracted Publication</PublicationType></PublicationTypeList></Article>
          <CommentsCorrectionsList><CommentsCorrections RefType="RetractionIn"><PMID>99999998</PMID></CommentsCorrections>
          <CommentsCorrections RefType="CommentIn"><PMID>99999997</PMID></CommentsCorrections></CommentsCorrectionsList>
          </MedlineCitation><PubmedData/></PubmedArticle></PubmedArticleSet>'''
        expected = [{'type': 'RetractionIn', 'pmid': '99999998'}]
        self.assertEqual(fetch_pubmed.parse(ET.fromstring(raw))[0]['pubmedRelations'], expected)
        self.assertEqual(archive_details.parse_efetch(raw)['99999999']['pubmedRelations'], expected)

    def test_compact_radar_preserves_status_sources_and_verified_roles(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); (root / 'data').mkdir(); (root / 'config').mkdir()
            (root / 'config/publication-status.json').write_bytes((ROOT / 'config/publication-status.json').read_bytes())
            records = [dict(r, date='2026-10-01', datePrecision='day') for r in checked_records(str(ROOT))]
            (root / 'data/radar-archive.json').write_text(json.dumps({'rows': records}))
            (root / 'data/archive-full.json').write_text('{}')
            with patch.object(build_public, 'ROOT', root):
                radar = build_public.make_radar([])
            byid = {r[0]: radar['design'][r[6]] for r in radar['rows']}
            self.assertEqual(byid['41224473'], '已撤稿')
            self.assertEqual(byid['42418170'], '述评观点')
            self.assertIn('41916660', {r['pmid'] for r in radar['publicationStatuses']['41224473']['related']})


class ArticleRoleRegression(unittest.TestCase):
    def test_protocol_and_notices_override_randomized_title_types_and_methods(self):
        for title, types, expected in (
            ('Rationale and design of a randomized clinical trial', ['Randomized Controlled Trial'], '研究方案'),
            ('The CONDUCT-AF trial: Rationale and design', [], '研究方案'),
            ('New therapy study', ['Clinical Trial Protocol', 'Randomized Controlled Trial'], '研究方案'),
            ('RETRACTION: A randomized clinical trial', [], '撤稿声明'),
            ('EXPRESSION OF CONCERN: A randomized clinical trial', [], '关注声明'),
            ('CORRECTION: A randomized clinical trial', [], '更正声明'),
            ('A randomized clinical trial—Reply', [], '述评观点'),
            ('Interpreting the randomized clinical trial', [], '研究类型待核验'),
            ('Regarding a randomized clinical trial', [], '研究类型待核验'),
        ):
            with self.subTest(title=title):
                self.assertEqual(classify_study_design(title, 'METHODS: Patients were randomized. RESULTS: Outcomes improved.', types), expected)

    def test_secondary_role_is_distinct_from_primary_rct(self):
        for title in ('Post hoc analysis of a randomized clinical trial', 'Secondary analysis of a randomized clinical trial',
                      'A randomized trial: subgroup analysis', 'A substudy of a randomized trial',
                      'Prespecified analysis of a randomized clinical trial', 'Insights from a randomized clinical trial'):
            with self.subTest(title=title):
                self.assertEqual(classify_study_design(title, '', ['Randomized Controlled Trial']), 'RCT 二次分析')
        self.assertEqual(classify_study_design('Post hoc analysis of a cohort study'), '二次分析')
        self.assertEqual(classify_study_design('Treatment outcomes', 'METHODS: This secondary analysis included patients from a randomized controlled trial. RESULTS: Outcomes improved.'), 'RCT 二次分析')
        self.assertEqual(classify_study_design('A randomized clinical trial', 'BACKGROUND: Prior post hoc analyses informed care. METHODS: Patients were randomized. RESULTS: Outcomes improved.'), 'RCT')
        self.assertEqual(classify_study_design('Insights from clinical practice'), '研究类型待核验')
        self.assertEqual(classify_study_design('A post hoc analysis of a non-randomized controlled trial'), '二次分析')
        self.assertEqual(classify_study_design('A randomized clinical trial', 'METHODS: Patients were randomized. Prespecified subgroup analyses were also planned. RESULTS: The primary outcome improved.'), 'RCT')

    def test_verified_current_post_hoc_methods(self):
        # PMID 42836743, official Methods excerpt, 2026-10-08.
        title = 'Impact of Ganglionated Plexus Ablation on Early Recurrence After Thoracoscopic Atrial Fibrillation Ablation: A Post Hoc Analysis of the AFACT Study.'
        methods = 'METHODS: Using data from the randomized AFACT study, we compared patients with advanced AF who underwent stand-alone thoracoscopic ablation with or without GP ablation.'
        self.assertEqual(classify_study_design(title, methods, ['Journal Article']), 'RCT 二次分析')
        # PMID 42836296, official Methods excerpt, 2026-10-08.
        title = 'Lipid Burden and Efficacy of Preventive PCI of Vulnerable Atherosclerotic Coronary Plaques: Post Hoc Analysis From the PREVENT Trial.'
        methods = 'METHODS: Among patients enrolled in the PREVENT trial, an investigator-initiated, multicenter, open-label, randomized controlled trial, this post hoc analysis included 598 patients.'
        self.assertEqual(classify_study_design(title, methods, ['Journal Article']), 'RCT 二次分析')

    def test_research_letter_needs_own_methods_and_results(self):
        title = 'Effect of therapy: A randomized clinical trial'
        self.assertEqual(classify_study_design(title, '', ['Letter']), '述评观点')
        self.assertEqual(classify_study_design(title, 'METHODS: Patients were randomized. RESULTS: Outcomes improved.', ['Letter']), 'RCT')
        self.assertEqual(classify_study_design('A research letter', 'METHODS: We reviewed previous trials. RESULTS: Findings varied.', ['Letter']), '研究类型待核验')


if __name__ == '__main__':
    unittest.main()
