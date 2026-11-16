import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scripts import enrich_metadata as enrich
from scripts import build_public
from scripts import apply_public_library
from scripts import sync_public_library


class TagBackfillOverlayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.overlay_path = Path(self.temp.name) / 'tag_backfill_overlay.json'
        self.patch = patch.object(enrich, 'TAG_BACKFILL_OVERLAY', self.overlay_path)
        self.patch.start()
        enrich.clear_tag_overlay_cache()
        self.addCleanup(self.patch.stop)
        self.addCleanup(enrich.clear_tag_overlay_cache)
        self.addCleanup(self.temp.cleanup)

    def write_overlay(self, items):
        self.overlay_path.write_text(json.dumps({'items': items}), encoding='utf-8')
        enrich.clear_tag_overlay_cache()

    def remove_overlay(self):
        self.overlay_path.unlink(missing_ok=True)
        enrich.clear_tag_overlay_cache()

    def paper(self, **values):
        return {'id': 'paper-1', 'doi': '10.1234/example', 'title': 'Neutral title',
                'summary': '', 'journal': '', **values}

    def test_missing_or_empty_overlay_keeps_regex_behavior(self):
        title = 'Atrial fibrillation and heart failure'
        expected = enrich.extract_tags(title, '')
        p = self.paper(title=title)
        self.assertEqual(enrich.enrich_paper(p)['tags'], expected)
        self.write_overlay([])
        self.assertEqual(enrich.enrich_paper(self.paper(title=title))['tags'], expected)

    def test_reviewed_machine_overlay_survives_repeated_enrichment(self):
        self.write_overlay([{'doi': '10.1234/EXAMPLE', 'tags': ['#影像'],
                            'tagOrigin': 'machine_agreed'}])
        p = self.paper()
        self.assertEqual(enrich.enrich_paper(p)['tags'], ['#影像'])
        self.assertEqual(enrich.enrich_paper(p)['tags'], ['#影像'])

    def test_machine_reviewed_wins_over_regex(self):
        self.write_overlay([{'id': 'paper-1', 'tags': ['#影像'],
                            'tagOrigin': 'machine_reviewed'}])
        p = self.paper(title='Atrial fibrillation')
        self.assertEqual(enrich.extract_tags(p['title'], ''), ['#房颤/电生理'])
        self.assertEqual(enrich.enrich_paper(p)['tags'], ['#影像'])

    def test_reviewed_overlay_survives_s11_coronary_regex(self):
        title = 'Coronary stent outcomes'
        self.assertEqual(enrich.extract_tags(title, ''), ['#冠脉介入'])
        for origin in ('machine_reviewed', 'human'):
            with self.subTest(origin=origin):
                self.write_overlay([{'id': 'paper-1', 'tags': ['#高血压/血管'], 'tagOrigin': origin}])
                p = self.paper(title=title)
                self.assertEqual(enrich.enrich_paper(p)['tags'], ['#高血压/血管'])

    def test_reviewed_overlay_survives_s05_missing_regex_tag(self):
        title = 'Atrial fibrillation echocardiography'
        expected = ['#影像', '#房颤/电生理', '#冠脉介入']
        regex_tags = enrich.extract_tags(title, '')
        self.assertEqual(set(regex_tags), {'#影像', '#房颤/电生理'})
        self.assertNotIn('#冠脉介入', regex_tags)
        for origin in ('machine_reviewed', 'human'):
            with self.subTest(origin=origin):
                self.write_overlay([{'id': 'paper-1', 'tags': expected, 'tagOrigin': origin}])
                p = self.paper(title=title)
                self.assertEqual(enrich.enrich_paper(p)['tags'], expected)

    def test_machine_agreed_reconciliation_logs_only_disagreement(self):
        self.write_overlay([{'id': 'paper-1', 'tags': ['#影像'], 'tagOrigin': 'machine_agreed'}])
        with patch('builtins.print'):
            p = self.paper(title='Atrial fibrillation')
            self.assertEqual(enrich.enrich_paper(p)['tags'], ['#影像'])
        self.assertEqual(len(enrich.TAG_OVERLAY_RECONCILE_LOG), 1)
        self.assertEqual(enrich.TAG_OVERLAY_RECONCILE_LOG[0]['id'], 'paper-1')
        self.write_overlay([{'id': 'paper-1', 'tags': ['#房颤/电生理'], 'tagOrigin': 'machine_agreed'}])
        with patch('builtins.print'):
            p = self.paper(title='Atrial fibrillation')
            self.assertEqual(enrich.enrich_paper(p)['tags'], ['#房颤/电生理'])
        self.assertEqual(enrich.TAG_OVERLAY_RECONCILE_LOG, [])

    def test_shared_tag_resolution_matches_enrichment_and_radar_inputs(self):
        source = Path(build_public.__file__).read_text(encoding='utf-8')
        self.assertIn('resolve_topic_tags', source)
        self.assertNotIn('tags=extract_tags(', source)
        self.assertNotIn("extract_tags(r['title']", source)
        for overlay in (None, [{'doi': '10.1234/example', 'tags': ['#影像'], 'tagOrigin': 'machine_reviewed'}]):
            with self.subTest(overlay=overlay):
                self.write_overlay(overlay or [])
                p = self.paper(title='Atrial fibrillation echocardiography', summary='coronary stent study')
                list_tags = enrich.enrich_paper(dict(p))['tags']
                archive_tags = enrich.resolve_topic_tags(dict(p), title=p.get('title', ''), summary=p.get('summary', ''))
                radar_row = {'pmid': 999001, 'doi': p.get('doi'), 'title': p['title']}
                radar_tags = enrich.resolve_topic_tags(
                    dict(radar_row, doi=radar_row.get('doi'), id='pmid:' + str(radar_row.get('pmid'))),
                    title=radar_row['title'], summary=p['summary'])
                self.assertEqual(list_tags, archive_tags)
                self.assertEqual(list_tags, radar_tags)

    def test_human_tags_win_from_overlay_or_internal_marker(self):
        self.write_overlay([
            {'doi': '10.1234/example', 'tags': ['#影像'], 'tagOrigin': 'human'},
            {'id': 'paper-1', 'tags': ['#心衰/心肌'], 'tagOrigin': 'machine_agreed'},
        ])
        p = self.paper(title='Atrial fibrillation')
        self.assertEqual(enrich.enrich_paper(p)['tags'], ['#影像'])
        self.write_overlay([])
        p = self.paper(title='Atrial fibrillation', tags=['#心电'], tagOrigin='human')
        self.assertEqual(enrich.enrich_paper(p)['tags'], ['#心电'])

    def test_public_projections_exclude_internal_origin(self):
        self.assertNotIn('tagOrigin', build_public.PAPER_FIELDS)
        self.assertNotIn('tagOrigin', apply_public_library.DERIVED_FIELDS)
        self.assertNotIn('tagOrigin', sync_public_library.PUBLIC_FIELDS)
        raw = {'id': 'paper-1', 'title': 'Title', 'tags': ['#影像'], 'tagOrigin': 'human'}
        projected = {key: value for key, value in raw.items() if key in build_public.PAPER_FIELDS}
        self.assertNotIn('tagOrigin', projected)
        derived = apply_public_library._derived(raw)
        self.assertNotIn('tagOrigin', derived)

    def test_invalid_overlay_tags_are_ignored_without_error(self):
        self.write_overlay([{'id': 'paper-1', 'tags': ['#not-a-topic'],
                            'tagOrigin': 'machine_reviewed'}])
        self.assertEqual(enrich.enrich_paper(self.paper())['tags'], [])
        self.remove_overlay()
        self.assertEqual(enrich.enrich_paper(self.paper())['tags'], [])

    def test_highest_origin_wins_across_doi_and_id_keys(self):
        self.write_overlay([
            {'doi': '10.1234/example', 'tags': ['#影像'], 'tagOrigin': 'machine_agreed'},
            {'id': 'paper-1', 'tags': ['#心电'], 'tagOrigin': 'machine_reviewed'},
        ])
        self.assertEqual(enrich.enrich_paper(self.paper())['tags'], ['#心电'])

    def test_duplicate_key_higher_origin_wins_even_when_it_appears_first(self):
        self.write_overlay([
            {'id': 'paper-1', 'tags': ['#影像'], 'tagOrigin': 'human'},
            {'id': 'paper-1', 'tags': ['#心电'], 'tagOrigin': 'machine_agreed'},
        ])
        self.assertEqual(enrich.enrich_paper(self.paper())['tags'], ['#影像'])

    def test_duplicate_key_later_higher_origin_replaces_lower(self):
        self.write_overlay([
            {'id': 'paper-1', 'tags': ['#影像'], 'tagOrigin': 'machine_agreed'},
            {'id': 'paper-1', 'tags': ['#心电'], 'tagOrigin': 'machine_reviewed'},
        ])
        self.assertEqual(enrich.enrich_paper(self.paper())['tags'], ['#心电'])

    def test_doi_id_same_origin_tie_uses_first_overlay_row(self):
        self.write_overlay([
            {'doi': '10.1234/example', 'tags': ['#影像'], 'tagOrigin': 'machine_reviewed'},
            {'id': 'paper-1', 'tags': ['#心电'], 'tagOrigin': 'machine_reviewed'},
        ])
        self.assertEqual(enrich.enrich_paper(self.paper())['tags'], ['#影像'])


if __name__ == '__main__':
    unittest.main()
