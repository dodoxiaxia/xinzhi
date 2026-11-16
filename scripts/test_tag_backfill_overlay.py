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
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.temp.cleanup)

    def write_overlay(self, items):
        self.overlay_path.write_text(json.dumps({'items': items}), encoding='utf-8')

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

    def test_regex_wins_over_machine_overlay(self):
        self.write_overlay([{'id': 'paper-1', 'tags': ['#影像'],
                            'tagOrigin': 'machine_reviewed'}])
        p = self.paper(title='Atrial fibrillation')
        self.assertEqual(enrich.enrich_paper(p)['tags'], ['#房颤/电生理'])

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
        self.overlay_path.unlink()
        self.assertEqual(enrich.enrich_paper(self.paper())['tags'], [])


if __name__ == '__main__':
    unittest.main()
