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

    def test_machine_overlays_append_only_new_vocabulary(self):
        title = 'Transcatheter aortic valve replacement imaging'
        for origin in ('machine_agreed', 'machine_reviewed'):
            with self.subTest(origin=origin):
                self.write_overlay([{'id': 'paper-1', 'tags': ['#影像'], 'tagOrigin': origin}])
                self.assertEqual(enrich.resolve_topic_tags(self.paper(title=title), title, ''),
                                 ['#影像', '#结构性心脏病'])
        self.write_overlay([{'id': 'paper-1', 'tags': ['#影像', '#心电', '#心衰/心肌', '#冠脉介入'], 'tagOrigin': 'machine_agreed'}])
        self.assertEqual(enrich.resolve_topic_tags(self.paper(title=title), title, ''),
                         ['#影像', '#心电', '#心衰/心肌', '#冠脉介入'])
        self.write_overlay([{'id': 'paper-1', 'tags': ['#影像'], 'tagOrigin': 'machine_reviewed'}])
        self.assertEqual(enrich.resolve_topic_tags(self.paper(title='Coronary stent outcomes'), 'Coronary stent outcomes', ''), ['#影像'])

    def test_human_overlay_and_paper_tags_are_returned_unchanged(self):
        self.write_overlay([{'id': 'paper-1', 'tags': ['#影像'], 'tagOrigin': 'human'}])
        self.assertEqual(enrich.resolve_topic_tags(self.paper(title='Transcatheter aortic valve replacement', tags=['#心电']),
                                                   'Transcatheter aortic valve replacement', ''), ['#影像'])
        self.remove_overlay()
        tags = ['#心电', '#影像']
        self.assertIs(enrich.resolve_topic_tags(self.paper(title='Transcatheter aortic valve replacement', tags=tags, tagOrigin='human'),
                                                 'Transcatheter aortic valve replacement', ''), tags)

    def test_machine_agreed_reconciliation_ignores_appended_new_tag_only(self):
        self.write_overlay([{'id': 'paper-1', 'tags': ['#房颤/电生理'], 'tagOrigin': 'machine_agreed'}])
        title = 'Atrial fibrillation with transcatheter aortic valve replacement'
        with patch('builtins.print') as output:
            result = enrich.resolve_topic_tags(self.paper(title=title), title, '')
        self.assertEqual(result, ['#房颤/电生理', '#结构性心脏病'])
        self.assertEqual(enrich.TAG_OVERLAY_RECONCILE_LOG, [])
        self.assertFalse(output.called)

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


VOCAB_TAGS = {
    '#房颤/电生理', '#卒中/抗凝', '#大模型/NLP', '#AI-ECG', '#心电', '#穿戴/远程监测',
    '#影像', '#心衰/心肌', '#高血压/血管', '#冠脉介入',
}
VOCAB_TAGS = set(enrich.TOPIC_VOCAB)
SPECIFIC_TAGS = {
    '#房颤/电生理', '#卒中/抗凝', '#大模型/NLP', '#AI-ECG', '#心电', '#穿戴/远程监测',
}
BROAD_TAGS = {'#影像', '#心衰/心肌', '#高血压/血管', '#冠脉介入'}


class CommittedOverlayFileTests(unittest.TestCase):
    """Read the committed overlay and derive expected tags from that same file.

    Counts are observed from the file under test, not hardcoded state inventory.
    """

    @classmethod
    def setUpClass(cls):
        cls.overlay_path = Path(enrich.TAG_BACKFILL_OVERLAY)
        cls.raw = json.loads(cls.overlay_path.read_text(encoding='utf-8'))
        cls.items = cls.raw.get('items') or []

    def setUp(self):
        enrich.clear_tag_overlay_cache()
        self.addCleanup(enrich.clear_tag_overlay_cache)

    def test_committed_overlay_rows_are_well_formed(self):
        self.assertTrue(self.overlay_path.is_file())
        self.assertIsInstance(self.items, list)
        self.assertGreater(len(self.items), 0)
        self.assertEqual(self.raw.get('tagOrigin'), 'machine_agreed')
        ids, dois = [], []
        for row in self.items:
            self.assertIsInstance(row, dict)
            tags = row.get('tags')
            self.assertIsInstance(tags, list)
            self.assertTrue(tags)
            self.assertLessEqual(len(tags), 4)
            self.assertEqual(len(tags), len(set(tags)))
            self.assertTrue(all(tag in VOCAB_TAGS for tag in tags))
            self.assertIn(row.get('tagOrigin'), {'machine_agreed', 'machine_reviewed', 'human'})
            self.assertTrue(isinstance(row.get('id'), str) and row['id'].strip())
            self.assertTrue(isinstance(row.get('doi', ''), str))
            self.assertTrue(row.get('doi', '').strip() or row.get('id', '').strip())
            self.assertTrue(isinstance(row.get('inputHash'), str) and row['inputHash'].strip())
            self.assertTrue(row.get('batchId') or row.get('addedBatchId'))
            self.assertTrue(row.get('model') or row.get('addedModel'))
            ids.append(row['id'].strip())
            if row['doi'].strip():
                dois.append(row['doi'].lower().strip())
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(dois), len(set(dois)))

    def test_added_tags_are_merged_not_overwritten(self):
        for row in self.items:
            added = row.get('addedTags')
            if not added:
                continue
            self.assertIsInstance(added, list)
            self.assertTrue(added)
            self.assertTrue(all(tag in BROAD_TAGS for tag in added))
            self.assertTrue(all(tag in row['tags'] for tag in added))
            kept = [tag for tag in row['tags'] if tag not in added]
            # Existing specific tags stay in the same row; added broad tags do not replace them.
            self.assertTrue(kept)
            self.assertTrue(all(tag in SPECIFIC_TAGS for tag in kept))
            self.assertTrue(row.get('addedBatchId'))
            self.assertTrue(row.get('addedInputHash'))
            self.assertEqual(row.get('addedModel'), 'gemini-4-hydrogen-high')

    def test_batch2_rows_are_complete_unique_and_machine_reviewed(self):
        batch_id = self.raw.get('batch2BatchId')
        self.assertTrue(batch_id)
        rows = [row for row in self.items if row.get('batchId') == batch_id]
        self.assertTrue(rows)
        ids, dois = set(), set()
        for row in rows:
            for field in ('id', 'doi', 'pmid', 'inputHash', 'sampleId', 'model', 'batchId'):
                self.assertIn(field, row)
            self.assertEqual(row['tagOrigin'], 'machine_reviewed')
            self.assertEqual(row['model'], 'gemini-4-hydrogen-high')
            self.assertEqual(row['batchId'], batch_id)
            self.assertEqual(row['inputFields'], ['title', 'abstract'])
            self.assertTrue(row['tags'])
            self.assertLessEqual(len(row['tags']), 4)
            self.assertEqual(len(row['tags']), len(set(row['tags'])))
            self.assertTrue(set(row['tags']) <= VOCAB_TAGS)
            self.assertNotIn(row['id'], ids)
            if row['doi'].strip():
                self.assertNotIn(row['doi'].lower(), dois)
            ids.add(row['id'])
            if row['doi'].strip():
                dois.add(row['doi'].lower())
            title = 'Coronary stent outcomes'
            self.assertEqual(enrich.extract_tags(title, ''), ['#冠脉介入'])
            with patch('builtins.print'):
                resolved = enrich.resolve_topic_tags(
                    {'id': row['id'], 'doi': row['doi'], 'title': title, 'summary': ''},
                    title=title, summary='')
            self.assertTrue(set(row['tags']) <= set(resolved))
        previous = [row for row in self.items if row.get('batchId') != batch_id]
        self.assertTrue(all(row in self.items for row in previous))

    def test_batch3_rows_are_complete_unique_and_machine_reviewed(self):
        batch_id = self.raw.get('batch3BatchId')
        self.assertTrue(batch_id)
        rows = [row for row in self.items if row.get('batchId') == batch_id]
        self.assertTrue(rows)
        ids, dois = set(), set()
        for row in rows:
            for field in ('id', 'doi', 'pmid', 'inputHash', 'sampleId', 'model', 'batchId'):
                self.assertIn(field, row)
            self.assertEqual(row['tagOrigin'], 'machine_reviewed')
            self.assertEqual(row['model'], 'gemini-4-hydrogen-high')
            self.assertEqual(row['batchId'], batch_id)
            self.assertEqual(row['inputFields'], ['title'])
            self.assertTrue(row['tags'])
            self.assertLessEqual(len(row['tags']), 4)
            self.assertEqual(len(row['tags']), len(set(row['tags'])))
            self.assertTrue(set(row['tags']) <= VOCAB_TAGS)
            self.assertNotIn(row['id'], ids)
            if row['doi'].strip():
                self.assertNotIn(row['doi'].lower(), dois)
            ids.add(row['id'])
            if row['doi'].strip():
                dois.add(row['doi'].lower())
            title = 'Coronary stent outcomes'
            self.assertEqual(enrich.extract_tags(title, ''), ['#冠脉介入'])
            with patch('builtins.print'):
                resolved = enrich.resolve_topic_tags(
                    {'id': row['id'], 'doi': row['doi'], 'title': title, 'summary': ''},
                    title=title, summary='')
            self.assertTrue(set(row['tags']) <= set(resolved))
        previous = [row for row in self.items if row.get('batchId') != batch_id]
        self.assertTrue(all(row in self.items for row in previous))

    def test_backfill_batches_do_not_share_ids_or_dois(self):
        seen_ids, seen_dois = {}, {}
        for row in self.items:
            batch = row.get('batchId')
            ident = row['id'].strip()
            self.assertNotIn(ident, seen_ids, f'{ident} in {batch} and {seen_ids.get(ident)}')
            seen_ids[ident] = batch
            doi = row.get('doi', '').lower().strip()
            if doi:
                self.assertNotIn(doi, seen_dois, f'{doi} in {batch} and {seen_dois.get(doi)}')
                seen_dois[doi] = batch

    def test_resolve_topic_tags_returns_overlay_tags_for_every_committed_row(self):
        regex_title = 'Coronary stent outcomes'
        regex_tags = enrich.extract_tags(regex_title, '')
        self.assertEqual(regex_tags, ['#冠脉介入'])
        expected_by_doi = {row['doi'].lower().strip(): list(row['tags']) for row in self.items if row.get('doi', '').strip()}
        expected_by_id = {row['id'].strip(): list(row['tags']) for row in self.items}
        with patch('builtins.print'):
            for row in self.items:
                if row.get('doi', '').strip():
                    by_doi = enrich.resolve_topic_tags(
                        {'doi': row['doi'], 'title': regex_title, 'summary': ''},
                        title=regex_title, summary='')
                by_id = enrich.resolve_topic_tags(
                    {'id': row['id'], 'title': regex_title, 'summary': ''},
                    title=regex_title, summary='')
                if row.get('doi', '').strip():
                    self.assertTrue(set(expected_by_doi[row['doi'].lower().strip()]) <= set(by_doi))
                self.assertTrue(set(expected_by_id[row['id'].strip()]) <= set(by_id))
                self.assertTrue(all(tag in VOCAB_TAGS for tag in (by_doi if row.get('doi', '').strip() else by_id)))

    def test_unknown_paper_keeps_regex_and_priority_order_is_unchanged(self):
        title = 'Atrial fibrillation and heart failure'
        expected_regex = enrich.extract_tags(title, '')
        self.assertTrue(expected_regex)
        unknown = {'id': 'not-in-overlay', 'doi': '10.0/not-in-overlay', 'title': title, 'summary': ''}
        self.assertEqual(enrich.resolve_topic_tags(unknown, title=title, summary=''), expected_regex)
        source = Path(enrich.__file__).read_text(encoding='utf-8')
        self.assertIn("human > machine_reviewed > machine_agreed", source)
        self.assertIn("priority = {'machine_agreed': 0, 'machine_reviewed': 1, 'human': 2}", source)



if __name__ == '__main__':
    unittest.main()
