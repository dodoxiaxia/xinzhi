"""Public-source terminology, semantic boundaries and cache isolation regressions."""
import copy
import contextlib
import hashlib
import io
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import week_precompute as w
import build_public as build
from public_content_corrections import (load_corrections, corrected_title,
                                        corrected_title_map, corrected_quicklook,
                                        corrected_quicklook_map)

ROOT = Path(__file__).resolve().parents[1]
DIR = ROOT / 'editorial/v2-content-corrections-20261008'


class SourceBoundCorrections(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = load_corrections(ROOT)
        cls.fixtures = json.loads((DIR / 'current-public-fixtures.json').read_text())['items']
        cls.titles = [f for f in cls.fixtures if f['kind'] == 'title']
        cls.quicklooks = [f for f in cls.fixtures if f['kind'] == 'quicklook']

    def test_all_twenty_titles_match_official_public_identities(self):
        official = {s['pmid']: s for s in json.loads((DIR / 'official-public-sources.json').read_text())['sources']}
        self.assertEqual(len({f['paper']['pmid'] for f in self.titles}), 20)
        for f in self.titles:
            p = f['paper']; o = official[p['pmid']]
            self.assertEqual(p['doi'], o['doi'])
            self.assertIn(p['title'], (o['title'], o['title'].removesuffix('.')))
            self.assertEqual(corrected_title(p, f['before'], self.registry), f['after'])
            self.assertEqual(corrected_title(p, f['after'], self.registry), f['after'])
            w.validate('title', {'title_zh': f['after']}, {'title': p['title'], 'abstract': ''})

    def test_title_identity_hash_and_prior_wording_are_required(self):
        for f in self.titles:
            for field in ('doi', 'pmid', 'title'):
                p = {**f['paper'], field: f['paper'][field] + 'changed'}
                self.assertEqual(corrected_title(p, f['before'], self.registry), f['before'])
            self.assertEqual(corrected_title(f['paper'], '另一个未经本次核对的译名', self.registry),
                             '另一个未经本次核对的译名')

    def test_conflicting_shared_alias_cannot_inherit_another_title_correction(self):
        f = self.titles[0]; good = f['paper']
        for bad in ({**good, 'pmid':'1', 'title':'Changed public source title'},
                    {**good, 'doi':'10.1234/other', 'title':'Changed public source title'}):
            for rows in ([good, bad], [bad, good]):
                translations = {'doi:' + good['doi']:f['before'], 'pmid:' + good['pmid']:f['before']}
                out = corrected_title_map(rows, translations, self.registry)
                shared = 'doi:' + good['doi'] if bad['doi'] == good['doi'] else 'pmid:' + good['pmid']
                self.assertEqual(out[shared], f['before'])
                self.assertEqual(corrected_title(good, out[shared], self.registry), f['after'])
                self.assertEqual(corrected_title(bad, out[shared], self.registry), f['before'])

    def test_existing_nine_terms_and_one_journal_name_remain_unchanged(self):
        audit = json.loads((DIR / 'terminology-audit.json').read_text())['items']
        retained = [p for p in audit if p['status'] != 'terminology_inconsistent']
        self.assertEqual(len(retained), 10)
        for p in retained:
            self.assertEqual(corrected_title(p, p['before'], self.registry), p['before'])

    def test_two_quicklooks_keep_numbers_and_literal_source_quotes(self):
        for f in self.quicklooks:
            before = copy.deepcopy(f['before'])
            out = corrected_quicklook(f['source']['doi'], before, self.registry, source=f['source'])
            self.assertEqual(before, f['before'])
            for field in ('one_line', 'design', 'why_read', 'limits', 'findings'):
                self.assertEqual(out[field], f['after'][field])
            self.assertEqual(out['abstract'], before['abstract'])
            self.assertEqual(out['generatedAt'], before['generatedAt'])
            self.assertEqual(out['model'], before['model'])
            self.assertEqual(out['contentCorrection']['origin'], 'codex-editorial-correction')
            self.assertIn('no full-text or medical review', out['contentCorrection']['reviewScope'])
            self.assertEqual(out['contentCorrection']['sourceHash'], f['source']['sourceHash'])
            w.validate('quicklook', out, f['source'])
            for finding in out['findings']:
                self.assertIn(finding['quote'], f['source']['abstract'])
            self.assertEqual(corrected_quicklook(f['source']['doi'], out, self.registry, source=f['source']), out)

    def test_eno_source_quote_must_cover_its_own_si_eno_number(self):
        f = next(f for f in self.quicklooks if f['source']['pmid'] == '42826207')
        with self.assertRaises(ValueError):
            w.validate('quicklook', f['before'], f['source'])
        self.assertIn('siENO1', f['after']['findings'][2]['quote'])
        self.assertEqual(f['after']['findings'][2]['text'], f['before']['findings'][2]['text'])

    def test_regression_overclaims_in_every_free_field_are_withheld(self):
        for f in self.quicklooks:
            claim = '已证实小鼠模型安全有效。' if f['source']['pmid'] == '42826207' else '这是临床防治框架。'
            for field in ('one_line', 'why_read', 'limits', 'design'):
                value = {**copy.deepcopy(f['after']), field: claim}
                original = copy.deepcopy(value)
                self.assertIsNone(corrected_quicklook(f['source']['doi'], value, self.registry, source=f['source']))
                self.assertEqual(value, original)

    def test_changed_source_or_wrong_identity_is_never_marked_corrected(self):
        for f in self.quicklooks:
            for field in ('title', 'abstract', 'doi', 'pmid'):
                p = {**f['source'], field: f['source'][field] + 'changed'}
                out = corrected_quicklook(f['source']['doi'], f['before'], self.registry, source=p)
                self.assertIsNone(out)
            changed = {**f['before'], 'abstract': f['before']['abstract'] + 'changed'}
            self.assertIsNone(corrected_quicklook(f['source']['doi'], changed, self.registry))

    def test_historical_public_cache_binding_does_not_require_today_feed(self):
        f = next(f for f in self.quicklooks if f['source']['pmid'] == '42826207')
        out = corrected_quicklook(f['source']['doi'], f['before'], self.registry)
        self.assertEqual(out['one_line'], f['after']['one_line'])
        self.assertEqual(out['contentCorrection']['sourceHash'], w.text_hash(f['source']['title'], f['before']['abstract']))
        other = {**f['before'], 'pmid': '1'}
        self.assertIsNone(corrected_quicklook(f['source']['doi'], other, self.registry))

    def test_public_lookup_and_cache_files_are_immutable(self):
        rows = [f['paper'] for f in self.titles]
        translations = {'pmid:' + f['paper']['pmid']: f['before'] for f in self.titles}
        prior = copy.deepcopy(translations)
        out = corrected_title_map(rows, translations, self.registry)
        self.assertEqual(translations, prior)
        self.assertEqual(len(out), len(translations))
        for f in self.titles:
            self.assertEqual(out['pmid:' + f['paper']['pmid']], f['after'])
        items = {f['source']['doi']: f['before'] for f in self.quicklooks}
        previous = copy.deepcopy(items)
        result = corrected_quicklook_map(items, {}, self.registry)
        self.assertEqual(items, previous)
        self.assertEqual(len(result), 2)
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'shared-quicklooks.json'; p.write_text(json.dumps(items))
            digest = hashlib.sha256(p.read_bytes()).hexdigest()
            corrected_quicklook_map(json.loads(p.read_text()), {}, self.registry)
            self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(), digest)

    def test_public_radar_projection_uses_bound_title_correction(self):
        f = next(f for f in self.titles if f['paper']['pmid'] == '42480259')
        row = {**f['paper'], 'date': '2026-07-21', 'datePrecision': 'day', 'journal': 'JACC Adv'}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'data').mkdir()
            (root / 'data/radar-archive.json').write_text(json.dumps({'rows': [row]}))
            (root / 'data/archive-full.json').write_text('{}')  # Synthetic fixture; no private input.
            with patch.object(build, 'ROOT', root):
                radar = build.make_radar([], {'pmid:42480259': f['before']}, self.registry)
            self.assertEqual(radar['zh']['42480259'], f['after'])

    def test_public_board_projection_corrects_quicklooks_and_marks_missing(self):
        f = self.quicklooks[0]; p = f['source']
        row = {**p, 'id': 'pmid-' + p['pmid'], 'rank': 1, 'category': '心血管', 'date': '2026-10-05',
               'abstractSource': 'PubMed', 'abstractSourceUrl': 'https://pubmed.ncbi.nlm.nih.gov/' + p['pmid'] + '/',
               'titleZh': f['before']['title_zh'], 'quicklook': f['before']}
        board = {'schemaVersion': 1, 'scope': 'public-abstract', 'items': [row]}
        safe = build.public_weekly_board(board, self.registry)
        self.assertEqual(safe['items'][0]['quicklook']['one_line'], f['after']['one_line'])
        self.assertFalse(safe['items'][0]['allowAutomaticGeneration'])
        prepared = build.pregenerated_map(safe)
        self.assertEqual(prepared[p['paperID']]['quicklook']['contentCorrection']['sourceHash'], p['sourceHash'])
        row['quicklook'] = {**f['after'], 'limits': '已证实小鼠模型安全有效。'}
        safe = build.public_weekly_board(board, self.registry)
        self.assertIsNone(safe['items'][0]['quicklook'])
        self.assertEqual(safe['coverage']['quicklook'], 0)
        self.assertIn('quicklook', safe['items'][0]['missingTasks'])

    def test_board_keeps_original_allowlist_for_unrelated_quicklooks(self):
        from public_editorial_overlay import load_board
        board = load_board(ROOT, include_supplements=False)
        row = board['items'][0]
        row['quicklook']['abstract'] = 'Unexpected extra cache text, never part of this public contract.'
        row['quicklook']['privateNotes'] = 'do not export'
        safe = build.public_weekly_board(board, self.registry)
        q = safe['items'][0]['quicklook']
        self.assertNotIn('abstract', q)
        self.assertNotIn('privateNotes', q)

    def test_numeric_and_quote_failures_are_withheld_without_retry_or_cache_write(self):
        for f in self.quicklooks:
            for problem in ('number', 'quote'):
                item = copy.deepcopy(f['after'])
                if problem == 'number':item['one_line'] = '样本量为987654321。'
                else:item['findings'][0]['quote'] = 'This invented quote is not in the source abstract.'
                self.assertIsNone(corrected_quicklook(f['source']['doi'], item, self.registry, source=f['source']))

    def test_correction_provenance_does_not_export_private_fields(self):
        f = self.quicklooks[0]
        item = corrected_quicklook(f['source']['doi'], f['before'], self.registry, source=f['source'])
        item['contentCorrection']['privateNotes'] = 'do not export'
        item['contentCorrection']['api_key'] = 'do not export'
        out = build.public_quicklook(item)
        self.assertNotIn('privateNotes', out['contentCorrection'])
        self.assertNotIn('api_key', out['contentCorrection'])

    def test_complete_offline_public_build_preserves_shared_inputs_and_pins_registry(self):
        from test_release_build import synthetic_root
        from package_release import public_payloads
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); synthetic_root(root)
            shutil.copyfile(ROOT / 'editorial/public_content_corrections.json', root / 'editorial/public_content_corrections.json')
            shutil.copyfile(ROOT / 'scripts/public_content_corrections.py', root / 'scripts/public_content_corrections.py')
            f = next(f for f in self.quicklooks if f['source']['pmid'] == '42832625')
            source = f['source']
            candidate = {k:source[k] for k in ('title', 'doi', 'pmid')}
            candidate.update(id='pmid-' + source['pmid'], summary=source['abstract'],
                             abstractSections=[{'label':'', 'text':source['abstract']}],
                             summary_truncated=False, basis='PubMed 官方结构化元数据',
                             date='2026-10-07', datePrecision='day', dateBasis='ArticleDate', journal='Circulation')
            candidate_data=json.loads((root / 'data/candidates.json').read_text())
            candidate_data['items']=[candidate]
            (root / 'data/candidates.json').write_text(json.dumps(candidate_data))
            radar_rows = [{**f['paper'], 'date':'2026-07-21', 'datePrecision':'day', 'journal':'Synthetic journal'} for f in self.titles]
            (root / 'data/radar-archive.json').write_text(json.dumps({'rows':radar_rows}))
            (root / 'data/archive-full.json').write_text('{}')
            tr = {'pmid:' + f['paper']['pmid']: f['before'] for f in self.titles}
            caches = {'items': {f['source']['doi']:f['before'] for f in self.quicklooks}}
            (root / 'data/translations.json').write_text(json.dumps(tr))
            (root / 'data/quicklooks.json').write_text(json.dumps(caches))
            untouched = {name:(root / name).read_bytes() for name in ('data/translations.json','data/quicklooks.json')}
            with patch.object(build, 'ROOT', root), patch.object(build, 'DEST', root / 'public'), contextlib.redirect_stdout(io.StringIO()):
                build.main()
            text = (root / 'public/public.js').read_text()
            def payload(name):
                m = re.search(r'window\.' + name + r'=', text)
                return json.JSONDecoder().raw_decode(text[m.end():])[0]
            qls = payload('QUICKLOOKS'); radar = payload('RADAR')
            self.assertEqual(len(qls), 2)
            for f in self.quicklooks:
                self.assertEqual(qls[f['source']['doi']]['why_read'], f['after']['why_read'])
                self.assertEqual(qls[f['source']['doi']]['contentCorrection']['sourceHash'], f['source']['sourceHash'])
            self.assertIn('射血分数改善型心力衰竭', radar['zh']['42480259'])
            self.assertIn('safiglipron', radar['zh']['42811187'])
            self.assertNotIn('safigliptron', text)
            self.assertNotIn('防治框架', text)
            for name, old in untouched.items():self.assertEqual((root / name).read_bytes(), old)
            manifest = json.loads((root / 'docs/public-manifest.json').read_text())
            self.assertEqual(manifest['buildProvenance']['inputs']['editorial/public_content_corrections.json'],
                             hashlib.sha256((root / 'editorial/public_content_corrections.json').read_bytes()).hexdigest())
            public_payloads(root)
            registry = root / 'editorial/public_content_corrections.json'
            registry.write_bytes(registry.read_bytes() + b' ')
            with self.assertRaisesRegex(ValueError, 'provenance'):public_payloads(root)


if __name__ == '__main__':
    unittest.main()
