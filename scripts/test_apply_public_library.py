import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import apply_public_library as app


def paper(identifier='approved', **updates):
    return {**{'id': identifier, 'title': 'A clinical trial', 'doi': '10.1234/trial',
               'pmid': '', 'url': 'https://doi.org/10.1234/trial', 'journal': 'Heart',
               'date': '2026-09-17', 'dateBasis': 'Crossref published-online（索引记录，未复核）',
               'datePrecision': 'day', 'ingestedAt': None, 'metadataStatus': 'index_record_only',
               'fulltextStatus': 'not_verified', 'basis': '仅公共题录 · 原索引元数据未独立复核 · 未读全文',
               'localAvailable': False, 'category': '心血管'}, **updates}


def library(papers):
    return {'generatedAt': '2026-10-07T00:00:00Z', 'papers': papers, 'feeds': [],
            'stats': {'papers': len(papers), 'journalLabels': 1, 'feedCount': 0, 'enabledFeeds': 0}}


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        # All writes stay within this patch checkout even for the real-data test.
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'editorial').mkdir()
        (self.root / 'data').mkdir()
        self.snapshot = library([paper()])
        self.stage_snapshot(self.snapshot, ['approved'])

    def stage_snapshot(self, snapshot, previous_ids):
        raw = (json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n').encode()
        (self.root / app.SNAPSHOT).write_bytes(raw)
        ids = sorted(previous_ids)
        manifest = {'schemaVersion': 1, 'snapshotSha256': hashlib.sha256(raw).hexdigest(),
                    'snapshotCount': len(snapshot['papers']), 'previousCount': len(ids),
                    'previousIds': ids,
                    'previousIdsSha256': hashlib.sha256(('\n'.join(ids) + '\n').encode()).hexdigest()}
        (self.root / app.MANIFEST).write_text(json.dumps(manifest))

    def stage_state(self, state):
        (self.root / 'data/library.json').write_text(json.dumps(state, ensure_ascii=False))
        (self.root / 'data/library.js').write_text('window.LIBRARY=' + json.dumps(state, ensure_ascii=False) + ';')

    def read_state(self):
        return json.loads((self.root / 'data/library.json').read_text())

    def file_state(self):
        return {name: ((self.root / 'data' / name).read_bytes(),
                       (self.root / 'data' / name).stat().st_mtime_ns)
                for name in ('library.json', 'library.js')}

    def test_snapshot_corrects_primary_fields_and_removes_stale_private_metadata(self):
        old = paper(doi='10.1234/wrong', date='2025', datePrecision='year', localAvailable=True)
        old.update(summary='Stale interpretation', cleanJournal='Old journal', copies=2,
                   metadataVerifiedInIndex=True, sourceCommit='not-public')
        self.stage_state(library([old]))
        self.assertTrue(app.apply_snapshot(self.root, '2026-10-07T12:00:00Z'))
        state = self.read_state()
        self.assertEqual(state['papers'], self.snapshot['papers'])
        self.assertEqual(state['generatedAt'], '2026-10-07T12:00:00Z')
        self.assertIsNone(state['papers'][0]['ingestedAt'])
        self.assertEqual(set((self.root / 'data').iterdir()),
                         {self.root / 'data/library.json', self.root / 'data/library.js'})
        app.require_snapshot(state, self.root)

    def test_unchanged_identity_preserves_public_derived_fields_but_resets_availability(self):
        old = paper(localAvailable=True, date='2025', datePrecision='year')
        old.update(summary='Public abstract', cleanJournal='Heart', dateConfidence='stale',
                   quantitativeMetrics={'sampleSize': 200, 'privatePath': 'discarded'})
        self.stage_state(library([old]))
        app.apply_snapshot(self.root)
        out = self.read_state()['papers'][0]
        self.assertEqual(out['summary'], 'Public abstract')
        self.assertEqual(out['quantitativeMetrics'], {'sampleSize': 200})
        self.assertNotIn('dateConfidence', out)
        self.assertFalse(out['localAvailable'])
        self.assertEqual({k: out[k] for k in app.PUBLIC_FIELDS}, paper())

    def test_future_record_survives_and_repeat_preserves_bytes_and_mtime(self):
        future = paper('future', title='A future public paper', doi='10.1234/future',
                       url='https://doi.org/10.1234/future', date='2026-10-08')
        self.stage_state(library([paper(localAvailable=True), future]))
        app.apply_snapshot(self.root, '2026-10-07T12:00:00Z')
        self.assertEqual(len(self.read_state()['papers']), 2)
        self.assertIn(future, self.read_state()['papers'])
        before = self.file_state()
        self.assertFalse(app.apply_snapshot(self.root, '2030-01-01T00:00:00Z'))
        self.assertEqual(self.file_state(), before)

    def test_already_correct_noncanonical_json_format_does_not_churn(self):
        self.stage_state(self.snapshot)
        before = self.file_state()
        self.assertFalse(app.apply_snapshot(self.root))
        self.assertEqual(self.file_state(), before)

    def test_missing_or_stale_js_is_repaired(self):
        self.stage_state(self.snapshot)
        (self.root / 'data/library.js').unlink()
        self.assertTrue(app.apply_snapshot(self.root))
        self.assertFalse(app.apply_snapshot(self.root))

    def test_duplicate_id_holds_without_writing(self):
        self.stage_state(library([paper(), paper()]))
        before = self.file_state()
        with self.assertRaisesRegex(app.SnapshotError, 'duplicate_id'):
            app.apply_snapshot(self.root)
        self.assertEqual(self.file_state(), before)
        with self.assertRaisesRegex(app.SnapshotError, 'duplicate_id'):
            app.require_snapshot(library([paper(), paper()]), self.root)

    def test_hash_tampering_or_missing_snapshot_holds_without_writing(self):
        self.stage_state(library([paper(localAvailable=True)]))
        before = self.file_state()
        (self.root / app.SNAPSHOT).write_bytes((self.root / app.SNAPSHOT).read_bytes() + b' ')
        with self.assertRaisesRegex(app.SnapshotError, 'snapshot_hash_mismatch'):
            app.apply_snapshot(self.root)
        self.assertEqual(self.file_state(), before)
        (self.root / app.SNAPSHOT).unlink()
        with self.assertRaisesRegex(app.SnapshotError, 'required_file_missing'):
            app.require_snapshot(self.snapshot, self.root)

    def test_manifest_counts_and_original_ids_are_required(self):
        for key, value in [('snapshotCount', 2), ('previousCount', 2),
                           ('previousIdsSha256', '0' * 64)]:
            self.stage_snapshot(self.snapshot, ['approved'])
            path = self.root / app.MANIFEST
            manifest = json.loads(path.read_text())
            manifest[key] = value
            path.write_text(json.dumps(manifest))
            with self.subTest(key=key), self.assertRaises(app.SnapshotError):
                app.load_snapshot(self.root)
        self.stage_snapshot(self.snapshot, ['lost-original-id'])
        with self.assertRaisesRegex(app.SnapshotError, 'previous_ids_missing'):
            app.load_snapshot(self.root)

    def test_old_id_rollback_or_primary_field_changes_hold_public_build(self):
        with self.assertRaisesRegex(app.SnapshotError, 'approved_id_missing'):
            app.require_snapshot(library([paper('replacement')]), self.root)
        for key, value in [('doi', '10.1234/old'), ('date', '2025-09-17'),
                           ('title', 'Old title'), ('localAvailable', True), ('pmid', '123')]:
            with self.subTest(key=key), self.assertRaisesRegex(app.SnapshotError, 'primary_fields_changed'):
                app.require_snapshot(library([paper(**{key: value})]), self.root)

    def test_reviewed_snapshot_cannot_claim_pdf_access_or_invent_dates(self):
        for key, value in [('localAvailable', True), ('fulltextStatus', 'verified'),
                           ('date', '2026-02-30'), ('datePrecision', 'month'),
                           ('ingestedAt', '2026-10-07T00:00:00Z')]:
            self.stage_snapshot(library([paper(**{key: value})]), ['approved'])
            with self.subTest(key=key), self.assertRaises(app.SnapshotError):
                app.load_snapshot(self.root)

    def test_private_future_text_does_not_escape(self):
        future = paper('future', title='/Users/private/example', doi='10.1234/future')
        self.stage_state(library([paper(), future]))
        before = self.file_state()
        with self.assertRaises(app.SyncError):
            app.apply_snapshot(self.root)
        self.assertEqual(self.file_state(), before)

    def test_both_files_are_prepared_before_either_replacement(self):
        self.stage_state(library([paper(localAvailable=True)]))
        before = self.file_state()
        with patch.object(app.os, 'fsync', side_effect=[None, OSError('fixture disk failure')]):
            with self.assertRaises(OSError):
                app.apply_snapshot(self.root)
        self.assertEqual(self.file_state(), before)
        self.assertEqual(len(list((self.root / 'data').iterdir())), 2)

    def test_real_public_1219_to_1268_and_repeat_and_future(self):
        repository = Path(app.__file__).resolve().parents[1]
        snapshot_path = Path(os.environ['PUBLIC_LIBRARY_SNAPSHOT_TEST']) if os.environ.get('PUBLIC_LIBRARY_SNAPSHOT_TEST') else repository / app.SNAPSHOT
        if not snapshot_path.exists():
            self.skipTest('approved repository snapshot not installed in isolated test checkout')
        snapshot_raw = snapshot_path.read_bytes()
        snapshot = json.loads(snapshot_raw)
        if os.environ.get('PUBLIC_LIBRARY_PREVIOUS_TEST'):
            previous = json.loads(Path(os.environ['PUBLIC_LIBRARY_PREVIOUS_TEST']).read_bytes())
        else:
            # CI needs only the checked-in approved snapshot and manifest. All
            # historical IDs come from that reviewed public manifest, with stale
            # availability deliberately set to reproduce a restored legacy state.
            app.load_snapshot(repository)
            manifest = json.loads((repository / app.MANIFEST).read_bytes())
            old_ids = set(manifest['previousIds'])
            previous = copy.deepcopy(snapshot)
            previous['papers'] = [dict(p, localAvailable=True) for p in previous['papers'] if p['id'] in old_ids]
            previous['generatedAt'] = '2026-09-29T00:00:00Z'
        self.assertEqual(len(previous['papers']), 1219)
        self.assertEqual(len(snapshot['papers']), 1268)
        old_ids = sorted(p['id'] for p in previous['papers'])
        self.stage_snapshot(snapshot, old_ids)
        # Use the exact reviewed bytes for the integration hash test.
        (self.root / app.SNAPSHOT).write_bytes(snapshot_raw)
        manifest_path = self.root / app.MANIFEST
        manifest = json.loads(manifest_path.read_text())
        manifest['snapshotSha256'] = hashlib.sha256(snapshot_raw).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        self.stage_state(previous)
        self.assertTrue(app.apply_snapshot(self.root, '2026-10-07T12:00:00Z'))
        state = self.read_state()
        self.assertEqual(len(state['papers']), 1268)
        self.assertTrue(set(old_ids) <= {p['id'] for p in state['papers']})
        self.assertTrue(all(p['localAvailable'] is False for p in state['papers']))
        self.assertTrue(all(p['ingestedAt'] is None for p in state['papers']))
        app.require_snapshot(state, self.root)
        before = self.file_state()
        self.assertFalse(app.apply_snapshot(self.root))
        self.assertEqual(self.file_state(), before)
        future = paper('future', doi='10.1234/future', url='https://doi.org/10.1234/future')
        state['papers'].append(future)
        self.stage_state(state)
        app.apply_snapshot(self.root)
        self.assertEqual(len(self.read_state()['papers']), 1269)
        app.require_snapshot(self.read_state(), self.root)
        with self.assertRaises(app.SnapshotError):
            app.require_snapshot(previous, self.root)


if __name__ == '__main__':
    unittest.main()
