#!/usr/bin/env python3
"""Offline tests for config/nejm_ai_in_medicine.json and scripts/ai_column.py."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import ai_column
import build_public
import enrich_metadata


class AiColumnTests(unittest.TestCase):
    def setUp(self):
        ai_column.clear_cache()
        self.addCleanup(ai_column.clear_cache)

    def _committed_items(self):
        payload = json.loads(ai_column.REGISTRY_PATH.read_text(encoding='utf-8'))
        return payload.get('items', [])

    def test_committed_registry_is_clean_normalized_and_nonempty(self):
        self.assertEqual(ai_column.registry_problems(), [])
        items = self._committed_items()
        self.assertTrue(len(items) > 0)
        dois = [row.get('doi') for row in items]
        for raw_doi in dois:
            self.assertIsInstance(raw_doi, str)
            self.assertEqual(raw_doi, ai_column.normalize_doi(raw_doi))
            self.assertTrue(raw_doi)
        self.assertEqual(len(dois), len(set(dois)))
        registry = ai_column.load_registry()
        self.assertEqual(set(registry.keys()), set(dois))

    def test_classify_clinical_tier_uses_registry_and_normalizes_doi(self):
        items = self._committed_items()
        self.assertTrue(len(items) > 0)
        neutral = '中性题名 A Neutral Perspective'
        for row in items:
            doi = row['doi']
            self.assertEqual(
                enrich_metadata.classify_clinical_tier('The New England journal of medicine', neutral, doi),
                ai_column.AI_TIER,
            )
            self.assertEqual(
                enrich_metadata.classify_clinical_tier('The New England journal of medicine', neutral),
                '顶级综合与科学',
            )
            self.assertEqual(
                enrich_metadata.classify_clinical_tier('NEJM', neutral, doi.upper()),
                ai_column.AI_TIER,
            )
            self.assertEqual(
                enrich_metadata.classify_clinical_tier('NEJM', neutral, 'https://doi.org/' + doi.upper()),
                ai_column.AI_TIER,
            )

    def test_unlisted_nejm_doi_and_non_nejm_doi_patterns(self):
        self.assertEqual(
            enrich_metadata.classify_clinical_tier('NEJM', 'A Neutral Perspective', '10.1056/nejmoa9999999'),
            '顶级综合与科学',
        )
        for bad in ('10.1001/jama.2026.1', '10.1161/circulationaha.126.000001', '10.1056/other123', 'not-a-doi', ''):
            self.assertEqual(ai_column.normalize_doi(bad), '')

    def test_enrich_paper_end_to_end(self):
        first = self._committed_items()[0]
        paper = {
            'id': 'nejm-ai-col-1',
            'journal': 'NEJM',
            'doi': first['doi'],
            'title': first['title'],
            'summary': '',
        }
        enriched = enrich_metadata.enrich_paper(paper)
        self.assertEqual(enriched['clinicalTier'], ai_column.AI_TIER)

    def test_make_radar_includes_ai_tier_for_registered_doi(self):
        first = self._committed_items()[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            row = {
                'pmid': '43037244',
                'doi': first['doi'],
                'journal': 'The New England journal of medicine',
                'date': '2026-11-14',
                'datePrecision': 'day',
                'title': first['title'],
            }
            (root / 'data/radar-archive.json').write_text(json.dumps({'rows': [row]}), encoding='utf-8')
            (root / 'data/archive-full.json').write_text('{}', encoding='utf-8')
            with patch.object(build_public, 'ROOT', root):
                radar = build_public.make_radar([])
        self.assertIsNotNone(radar)
        self.assertIn(ai_column.AI_TIER, radar['tier'])
        tier_idx = radar['rows'][0][5]
        self.assertEqual(radar['tier'][tier_idx], ai_column.AI_TIER)

    def test_load_registry_fault_tolerance(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)

            missing = tmp / 'missing.json'
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(ai_column.load_registry(missing), {})
            self.assertTrue(stderr.getvalue().strip())

            bad_json = tmp / 'bad.json'
            bad_json.write_text('{not valid json', encoding='utf-8')
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(ai_column.load_registry(bad_json), {})
            self.assertTrue(stderr.getvalue().strip())

            mixed = tmp / 'mixed.json'
            mixed.write_text(json.dumps({
                'schemaVersion': 1,
                'items': [
                    'not-a-dict',
                    {'doi': '10.1001/jama.1', 'title': 'Wrong prefix'},
                    {'doi': '10.1056/NEJMp2600001', 'title': 'Good row 1'},
                    {'doi': '10.1056/nejmp2600001', 'title': 'Duplicate row'},
                    {'doi': '10.1056/nejmoa2600002', 'title': 'Good row 2'},
                ],
            }), encoding='utf-8')
            loaded = ai_column.load_registry(mixed)
            self.assertEqual(set(loaded.keys()), {'10.1056/nejmp2600001', '10.1056/nejmoa2600002'})
            self.assertEqual(loaded['10.1056/nejmp2600001']['title'], 'Good row 1')
            self.assertEqual(len(ai_column.registry_problems(mixed)), 3)

    def test_add_dois_appends_valid_and_preserves_existing_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            reg = Path(directory) / 'registry.json'
            original_row = {
                'doi': '10.1056/nejmp2606894',
                'title': 'What the Robot Still Can’t Do',
                'addedOn': '2026-11-19',
                'evidence': 'original evidence',
                'extraNote': 'preserve me',
            }
            reg.write_text(json.dumps({
                'schemaVersion': 1,
                'column': 'NEJM AI in Medicine',
                'items': [original_row],
            }, ensure_ascii=False, indent=2), encoding='utf-8')

            def fake_fetch(doi):
                return {
                    'DOI': doi.upper(),
                    'container-title': ['New England Journal of Medicine'],
                    'title': [f'<i>Title</i> for {doi}'],
                }

            sleep_calls = []
            added, skipped, failed = ai_column.add_dois(
                [
                    '10.1056/nejmp2606894',
                    '10.1056/NEJMoa2600011',
                    'https://doi.org/10.1056/nejmp2600012',
                ],
                path=reg,
                fetch=fake_fetch,
                sleep=lambda sec: sleep_calls.append(sec),
                interval=0.5,
            )
            self.assertEqual(failed, [])
            self.assertEqual(skipped, ['10.1056/nejmp2606894'])
            self.assertEqual([r['doi'] for r in added], ['10.1056/nejmoa2600011', '10.1056/nejmp2600012'])
            self.assertEqual(added[0]['title'], 'Title for 10.1056/nejmoa2600011')
            # sleep is called only between new Crossref fetches (new DOI count - 1)
            self.assertEqual(len(sleep_calls), len(added) - 1)
            self.assertEqual(sleep_calls, [0.5])

            saved = json.loads(reg.read_text(encoding='utf-8'))
            self.assertEqual(saved['items'][0], original_row)
            self.assertEqual(len(saved['items']), 3)

    def test_add_dois_failures_do_not_modify_file(self):
        with tempfile.TemporaryDirectory() as directory:
            reg = Path(directory) / 'registry.json'
            initial_bytes = json.dumps({
                'schemaVersion': 1,
                'items': [{'doi': '10.1056/nejmp2606894', 'title': 'Existing'}],
            }, ensure_ascii=False, indent=2).encode('utf-8')
            reg.write_bytes(initial_bytes)

            def failing_fetch(_doi):
                raise urllib.error.URLError('offline')

            added, skipped, failed = ai_column.add_dois(
                ['10.1056/nejmoa2600099'],
                path=reg,
                fetch=failing_fetch,
                sleep=lambda _sec: None,
            )
            self.assertEqual(added, [])
            self.assertEqual(skipped, [])
            self.assertEqual(len(failed), 1)
            self.assertEqual(reg.read_bytes(), initial_bytes)

            def non_nejm_fetch(doi):
                return {
                    'DOI': doi,
                    'container-title': ['NEJM AI'],
                    'title': ['Some NEJM AI article'],
                }

            added2, skipped2, failed2 = ai_column.add_dois(
                ['10.1056/nejmoa2600098'],
                path=reg,
                fetch=non_nejm_fetch,
                sleep=lambda _sec: None,
            )
            self.assertEqual(added2, [])
            self.assertEqual(skipped2, [])
            self.assertEqual(len(failed2), 1)
            self.assertEqual(reg.read_bytes(), initial_bytes)

    def test_dois_from_html_deduplicates_and_preserves_order(self):
        sample = """
        <a href="https://doi.org/10.1056/NEJMp2606894">First</a>
        <span>10.1001/jama.2026.12345</span>
        <a href="/doi/full/10.1056/nejmoa2501234">Second</a>
        <a href="/doi/pdf/10.1056/nejmp2606894">Dup First</a>
        <span>10.1056/other999</span>
        <span>10.1056/NEJMRA2409876</span>
        """
        self.assertEqual(
            ai_column.dois_from_html(sample),
            ['10.1056/nejmp2606894', '10.1056/nejmoa2501234', '10.1056/nejmra2409876'],
        )


if __name__ == '__main__':
    unittest.main()
