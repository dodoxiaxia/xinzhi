import contextlib
import datetime
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import enrich_metadata  # noqa: E402
import merge_candidates  # noqa: E402
from scope_filter import scope_decision  # noqa: E402

FIXTURES_PATH = Path(__file__).resolve().parent / 'fixtures' / 'scope_filter_cases.json'


class ScopeFilterFixtureTests(unittest.TestCase):
    def test_shared_fixtures(self):
        cases = json.loads(FIXTURES_PATH.read_text(encoding='utf-8'))
        self.assertGreaterEqual(len(cases), 13)
        for case in cases:
            with self.subTest(id=case['id']):
                got = scope_decision(case['paper'])
                self.assertEqual(set(got.keys()), {'action', 'reason', 'detail'})
                self.assertEqual(got['action'], case['action'], case.get('note', ''))
                self.assertEqual(got['reason'], case['reason'], case.get('note', ''))
                self.assertIsInstance(got['detail'], str)
                if case['action'] == 'exclude':
                    self.assertTrue(got['detail'].strip())


class ScopeFilterFieldPriorityTests(unittest.TestCase):
    def test_missing_or_empty_paper_is_conservatively_kept(self):
        for paper in (None, {}, {'title': ''}, {'title': 'Unknown study', 'journal': ''}):
            with self.subTest(paper=paper):
                got = scope_decision(paper)
                self.assertEqual(got['action'], 'keep')
                self.assertIsNone(got['reason'])

    def test_ai_frontier_category_alone_is_not_medical_ai(self):
        paper = {
            'title': 'Evaluation of oncology chemotherapy regimens',
            'journal': 'Nature Machine Intelligence',
            'category': 'AI前沿',
        }
        got = scope_decision(paper)
        self.assertEqual(got['action'], 'exclude')
        self.assertEqual(got['reason'], 'unrelated_to_cv_or_medical_ai')

    def test_ai_medical_category_keeps_cancer_paper(self):
        paper = {
            'title': 'Clinical imaging workflow for oncology triage',
            'journal': 'Nature Medicine',
            'category': 'AI医疗',
        }
        self.assertEqual(scope_decision(paper)['action'], 'keep')

    def test_mesh_object_formats_and_humans_precedence(self):
        animal_only = {
            'title': 'Cardiac hypertrophy signaling',
            'journal': 'Circulation',
            'meshTerms': [{'name': 'Animals'}, {'term': 'Mice, Inbred C57BL'}],
        }
        self.assertEqual(scope_decision(animal_only)['action'], 'exclude')
        self.assertEqual(scope_decision(animal_only)['reason'], 'basic_research')

        both = {
            'title': 'Cardiac hypertrophy signaling',
            'journal': 'Circulation',
            'meshTerms': [{'name': 'Humans'}, {'term': 'Mice'}],
        }
        self.assertEqual(scope_decision(both)['action'], 'keep')

    def test_false_positive_guards(self):
        # 100 mL must not look like ML (machine learning)
        ml_vol = {
            'title': 'Adjuvant chemotherapy (100 mL infusion) in metastatic colon cancer',
            'journal': 'JAMA Oncology',
        }
        self.assertEqual(scope_decision(ml_vol)['action'], 'exclude')
        self.assertEqual(scope_decision(ml_vol)['reason'], 'unrelated_to_cv_or_medical_ai')

        # Tumor necrosis factor in general medicine must not trigger oncology exclude
        tnf = {
            'title': 'Tumor necrosis factor inhibition in severe rheumatoid arthritis',
            'journal': 'New England Journal of Medicine',
        }
        self.assertEqual(scope_decision(tnf)['action'], 'keep')

        # In vitro fertilization must not trigger basic_research exclude
        ivf = {
            'title': 'Pregnancy outcomes after in vitro fertilization in women with congenital heart disease',
            'journal': 'Heart',
        }
        self.assertEqual(scope_decision(ivf)['action'], 'keep')

        # Mechanism/pathway/signaling/in vivo/translational alone stay keep
        vague = {
            'title': 'In vivo translational signaling pathways in human myocardial remodeling',
            'journal': 'European Heart Journal',
        }
        self.assertEqual(scope_decision(vague)['action'], 'keep')

    def test_abstract_basic_cue_does_not_override_clinical_rct_title(self):
        rct = {
            'title': 'Randomized controlled trial of drug X in patients with heart failure',
            'journal': 'New England Journal of Medicine',
            'summary': 'Background: Prior in vitro experiments in mice showed benefit. Methods: We randomized 500 patients.',
            'studyDesign': 'RCT',
        }
        self.assertEqual(scope_decision(rct)['action'], 'keep')


class ScopeFilterIntakeWireUpTests(unittest.TestCase):
    def test_merge_candidates_filters_out_of_scope_and_records_count_only(self):
        today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / 'data/feeds.json').write_text(json.dumps({
                'items': [
                    {'id': 'rss-1', 'title': 'Mouse model of atrial fibrosis', 'url': 'https://example.org/1', 'doi': '10.1000/mouse', 'journal': 'Heart', 'date': today, 'category': '心血管', 'summary': 'Induced in C57BL/6 mice.'},
                    {'id': 'rss-2', 'title': 'Catheter ablation for atrial fibrillation', 'url': 'https://example.org/2', 'doi': '10.1000/af', 'journal': 'Heart', 'date': today, 'category': '心血管', 'summary': 'Randomized trial in 300 patients.'},
                ]
            }), encoding='utf-8')
            (root / 'data/pubmed.json').write_text(json.dumps({
                'fetched': 1, 'totalHits': 1, 'truncated': False, 'journals': ['JAMA Oncology'],
                'items': [
                    {'id': 'pmid-1', 'title': 'Adjuvant chemotherapy in triple-negative breast cancer', 'url': 'https://doi.org/10.1000/onc', 'doi': '10.1000/onc', 'journal': 'JAMA Oncology', 'date': today, 'category': '综合医学', 'summary': 'Phase 3 breast cancer trial.'},
                ]
            }), encoding='utf-8')
            (root / 'data/source-health.json').write_text(json.dumps({'sources': []}), encoding='utf-8')
            out = io.StringIO()
            with patch.object(merge_candidates, 'ROOT', root), \
                    patch.object(merge_candidates.resolve_dois, 'fill', return_value={'lookedUp': 0, 'filled': 0}), \
                    patch('subprocess.run'), contextlib.redirect_stdout(out):
                merge_candidates.main()
            merged = json.loads((root / 'data/candidates.json').read_text(encoding='utf-8'))
            self.assertEqual([item['id'] for item in merged['items']], ['rss-2'])
            self.assertEqual(merged['pubmedFallback']['excludedOutOfScope'], 2)
            self.assertNotIn('excludedScope', merged)
            self.assertIn('Merge excluded', out.getvalue())

    def test_enrich_metadata_drops_newly_excluded_candidates_and_keeps_library(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / 'editorial').mkdir()
            (root / 'data/candidates.json').write_text(json.dumps({
                'items': [
                    {'id': 'c1', 'title': 'Adjuvant chemotherapy for early breast cancer', 'journal': 'JAMA Oncology', 'doi': '10.1000/onc'},
                    {'id': 'c2', 'title': 'Randomized trial of SGLT2 inhibition in heart failure', 'journal': 'NEJM', 'doi': '10.1000/hf'},
                ]
            }), encoding='utf-8')
            (root / 'data/library.json').write_text(json.dumps({
                'stats': {'papers': 1},
                'papers': [
                    {'id': 'lib1', 'title': 'Preserved approved library entry', 'journal': 'JAMA Oncology', 'doi': '10.1000/lib1'},
                ]
            }), encoding='utf-8')
            out = io.StringIO()
            with patch.object(enrich_metadata, 'ROOT', root), contextlib.redirect_stdout(out):
                enrich_metadata.main()
            cand = json.loads((root / 'data/candidates.json').read_text(encoding='utf-8'))
            lib = json.loads((root / 'data/library.json').read_text(encoding='utf-8'))
            self.assertEqual([item['id'] for item in cand['items']], ['c2'])
            self.assertEqual(cand['candidateCount'], 1)
            self.assertEqual(len(lib['papers']), 1)
            self.assertIn('Enrich dropped', out.getvalue())


if __name__ == '__main__':
    unittest.main()
