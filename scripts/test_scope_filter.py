import ast
import contextlib
import datetime
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import enrich_metadata  # noqa: E402
import merge_candidates  # noqa: E402
from scope_filter import load_scope_keep_dois, normalize_scope_doi, scope_decision  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
KEEPS_JSON_PATH = ROOT / 'config' / 'public_library_scope_keeps.json'
KEEPS_JS_PATH = ROOT / 'edge' / 'src' / '01b-scope-keeps.js'
FIXTURES_PATH = Path(__file__).resolve().parent / 'fixtures' / 'scope_filter_cases.json'
GOLD_PATH = Path(__file__).resolve().parent / 'fixtures' / 'scope_filter_sample_gold.json'

# The JAMA "Supplemental Online Content" record already hidden in PR #123 is not in must_keep.

def _apply_intake_ai_frontier(paper):
    out = dict(paper)
    if out.get('journal') in ('OpenAI News', 'Nature Machine Intelligence') and not re.search(
        r'clinical|medical|health|patient|cardiac|cardiovasc', out.get('title', ''), re.I
    ):
        out['category'] = 'AI前沿'
    return out


class ScopeFilterFixtureTests(unittest.TestCase):
    def test_shared_fixtures(self):
        cases = json.loads(FIXTURES_PATH.read_text(encoding='utf-8'))
        self.assertGreaterEqual(len(cases), 25)
        for case in cases:
            with self.subTest(id=case['id']):
                got = scope_decision(case['paper'])
                self.assertEqual(set(got.keys()), {'action', 'reason', 'detail'})
                self.assertEqual(got['action'], case['action'], case.get('note', ''))
                self.assertEqual(got['reason'], case['reason'], case.get('note', ''))
                self.assertIsInstance(got['detail'], str)
                if case['action'] in ('exclude', 'uncertain'):
                    self.assertTrue(got['detail'].strip(), case.get('note', ''))


class ScopeFilterFieldPriorityTests(unittest.TestCase):
    def test_missing_or_empty_paper_is_conservatively_kept(self):
        for paper in (None, {}, {'title': ''}, {'title': 'Unknown study', 'journal': ''}):
            with self.subTest(paper=paper):
                got = scope_decision(paper)
                self.assertEqual(got['action'], 'keep')
                self.assertIsNone(got['reason'])

    def test_ai_frontier_category_keeps_even_with_oncology_title(self):
        paper = {
            'title': 'Evaluation of oncology chemotherapy regimens',
            'journal': 'Nature Machine Intelligence',
            'category': 'AI前沿',
        }
        got = scope_decision(paper)
        self.assertEqual(got['action'], 'keep')
        self.assertIsNone(got['reason'])

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

        non_cv_both = {
            'title': 'Translational signaling in patients and mice',
            'journal': 'Science Translational Medicine',
            'meshTerms': [{'name': 'Humans'}, {'term': 'Mice'}],
        }
        self.assertNotEqual(scope_decision(non_cv_both)['action'], 'exclude')

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
        tnf_got = scope_decision(tnf)
        self.assertEqual(tnf_got['action'], 'uncertain')
        self.assertEqual(tnf_got['reason'], 'uncertain_scope')

        # In vitro fertilization must not trigger basic_research exclude
        ivf = {
            'title': 'Pregnancy outcomes after in vitro fertilization in women with congenital heart disease',
            'journal': 'Heart',
        }
        self.assertEqual(scope_decision(ivf)['action'], 'keep')

        # Mechanism/pathway/signaling/in vivo/translational alone stay keep for CV
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


class ScopeFilterGoldCalibrationTests(unittest.TestCase):
    def test_gold_must_keep_zero_false_excludes_and_report_hide_recall(self):
        gold = json.loads(GOLD_PATH.read_text(encoding='utf-8'))
        must_keep = gold['must_keep']
        hide89 = gold['hide89']
        hide91_extra = gold['hide91_extra']

        false_excludes = []
        for item in must_keep:
            dec = scope_decision(_apply_intake_ai_frontier(item))
            if dec['action'] == 'exclude':
                false_excludes.append((item['id'], item.get('journal', ''), item.get('title', ''), dec))

        self.assertEqual(false_excludes, [], f'Unexpected false excludes on must_keep: {false_excludes[:5]}')

        hide89_excluded = sum(1 for item in hide89 if scope_decision(_apply_intake_ai_frontier(item))['action'] == 'exclude')
        hide91_decisions = {
            item['id']: scope_decision(_apply_intake_ai_frontier(item))
            for item in hide91_extra
        }
        self.assertEqual(hide91_decisions['92c33d10a3cfd92f']['action'], 'exclude')
        self.assertEqual(hide91_decisions['92c33d10a3cfd92f']['reason'], 'not_article')
        self.assertNotEqual(hide91_decisions['0fe528d72fd56af2']['action'], 'keep')
        print(
            f"[scope_filter gold] must_keep={len(must_keep)}, false_excludes=0, "
            f"hide89_recall={hide89_excluded}/{len(hide89)}, "
            f"hide91_extra={{'0fe528d72fd56af2': {hide91_decisions['0fe528d72fd56af2']['action']}, "
            f"'92c33d10a3cfd92f': {hide91_decisions['92c33d10a3cfd92f']['action']}/{hide91_decisions['92c33d10a3cfd92f']['reason']}}}"
        )


class ScopeFilterIntakeWireUpTests(unittest.TestCase):
    def test_merge_candidates_filters_out_of_scope_keeps_uncertain_and_records_count_only(self):
        today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / 'data/feeds.json').write_text(json.dumps({
                'items': [
                    {'id': 'rss-1', 'title': 'Mouse model of atrial fibrosis', 'url': 'https://example.org/1', 'doi': '10.1000/mouse', 'journal': 'Heart', 'date': today, 'category': '心血管', 'summary': 'Induced in C57BL/6 mice.'},
                    {'id': 'rss-2', 'title': 'Catheter ablation for atrial fibrillation', 'url': 'https://example.org/2', 'doi': '10.1000/af', 'journal': 'Heart', 'date': today, 'category': '心血管', 'summary': 'Randomized trial in 300 patients.'},
                    {'id': 'rss-3', 'title': 'Clinical perspectives on modern healthcare delivery', 'url': 'https://example.org/3', 'doi': '10.1000/unc', 'journal': 'JAMA', 'date': today, 'category': '综合医学', 'summary': ''},
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
            self.assertEqual([item['id'] for item in merged['items']], ['rss-2', 'rss-3'])
            self.assertEqual(merged['pubmedFallback']['excludedOutOfScope'], 2)
            self.assertNotIn('excludedScope', merged)
            self.assertIn('Merge excluded', out.getvalue())

    def test_enrich_metadata_drops_newly_excluded_keeps_uncertain_and_library(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / 'editorial').mkdir()
            (root / 'data/candidates.json').write_text(json.dumps({
                'items': [
                    {'id': 'c1', 'title': 'Adjuvant chemotherapy for early breast cancer', 'journal': 'JAMA Oncology', 'doi': '10.1000/onc'},
                    {'id': 'c2', 'title': 'Randomized trial of SGLT2 inhibition in heart failure', 'journal': 'NEJM', 'doi': '10.1000/hf'},
                    {'id': 'c3', 'title': 'Clinical perspectives on modern healthcare delivery', 'journal': 'JAMA', 'doi': '10.1000/unc'},
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
            self.assertEqual([item['id'] for item in cand['items']], ['c2', 'c3'])
            self.assertEqual(cand['candidateCount'], 2)
            self.assertEqual(len(lib['papers']), 1)
            self.assertIn('Enrich dropped', out.getvalue())


class ScopeForceKeepTests(unittest.TestCase):
    def _parse_js_keep_dois(self, text):
        node = shutil.which('node')
        if node:
            script = text + '\nconsole.log(JSON.stringify([...SCOPE_FORCE_KEEP_DOIS]));'
            out = subprocess.run([node, '-e', script], capture_output=True, text=True, check=True).stdout
            return json.loads(out)
        match = re.search(r'const\s+SCOPE_FORCE_KEEP_DOIS\s*=\s*new\s+Set\(\s*(\[[\s\S]*?\])\s*\)\s*;', text)
        self.assertIsNotNone(match, 'SCOPE_FORCE_KEEP_DOIS not found')
        return ast.literal_eval(match.group(1))

    def test_json_and_js_force_keep_dois_match(self):
        cfg = json.loads(KEEPS_JSON_PATH.read_text(encoding='utf-8'))
        self.assertEqual(cfg.get('schemaVersion'), 1)
        self.assertIsInstance(cfg.get('dois'), list)
        json_dois = {normalize_scope_doi(d) for d in cfg['dois'] if normalize_scope_doi(d)}
        self.assertEqual(json_dois, set(load_scope_keep_dois(KEEPS_JSON_PATH)))

        js_raw = self._parse_js_keep_dois(KEEPS_JS_PATH.read_text(encoding='utf-8'))
        js_dois = {normalize_scope_doi(d) for d in js_raw if normalize_scope_doi(d)}
        self.assertEqual(js_dois, json_dois)

    def test_missing_keeps_file_acts_as_empty_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / 'missing_scope_keeps.json'
            self.assertEqual(load_scope_keep_dois(missing), frozenset())
            uncertain = {'title': 'Clinical perspectives on modern healthcare delivery', 'journal': 'JAMA', 'doi': '10.1000/unc'}
            got = scope_decision(uncertain, keeps_path=missing)
            self.assertEqual(got['action'], 'uncertain')
            self.assertEqual(got['reason'], 'uncertain_scope')

    def test_force_keep_overrides_uncertain_and_exclude_including_not_article(self):
        # Manual force-keep by DOI takes precedence over all automated rules (uncertain, basic_research, oncology, not_article).
        uncertain_paper = {
            'title': 'Clinical perspectives on modern healthcare delivery',
            'journal': 'JAMA',
            'doi': 'https://doi.org/10.1000/Unc-Keep',
        }
        excluded_paper = {
            'title': 'Adjuvant chemotherapy in triple-negative breast cancer',
            'journal': 'JAMA Oncology',
            'doi': 'doi:10.1000/Onc-Keep',
        }
        not_article_paper = {
            'title': 'Table of Contents',
            'journal': 'NEJM',
            'doi': '10.1000/Toc-Keep',
        }
        self.assertEqual(scope_decision(uncertain_paper, keep_dois=set())['action'], 'uncertain')
        self.assertEqual(scope_decision(excluded_paper, keep_dois=set())['action'], 'exclude')
        self.assertEqual(scope_decision(not_article_paper, keep_dois=set())['reason'], 'not_article')

        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / 'keeps.json'
            cfg_path.write_text(json.dumps({
                'schemaVersion': 1,
                'reviewedOn': '2026-11-13',
                'decision': 'Manual force-keep test fixture.',
                'dois': ['10.1000/unc-keep', 'https://doi.org/10.1000/ONC-KEEP', '10.1000/toc-keep'],
            }), encoding='utf-8')
            for paper in (uncertain_paper, excluded_paper, not_article_paper):
                with self.subTest(doi=paper['doi']):
                    got = scope_decision(paper, keeps_path=cfg_path)
                    self.assertEqual(got['action'], 'keep')
                    self.assertEqual(got['reason'], 'forced_keep')
                    self.assertTrue(got['detail'])


if __name__ == '__main__':
    unittest.main()
