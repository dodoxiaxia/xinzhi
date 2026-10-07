import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sync_public_library as sync
import build_public


def row(**updates):
    value = {'题名': 'A clinical trial', 'DOI': '10.1234/trial', '期刊': 'Heart',
             '实际出版日期': '2026-09-17', '日期来源': 'Crossref published-online',
             '当前路径': 'private/trial.pdf', 'SHA256': 'a' * 64,
             '原始路径': '/Users/private-account/papers/trial.pdf', '私人备注': 'do not publish',
             '日期置信度': 'private annotation', '元数据已核验': '是'}
    return {**value, **updates}


def tree_entry(oid='b' * 40):
    return {'mode': '100644', 'kind': 'blob', 'oid': oid, 'size': 50000}


class SyncTests(unittest.TestCase):
    def stage(self, rows=None, previous=None, tree=None, lfs=None):
        return sync.stage_library(rows or [row()], previous or {'papers': [], 'feeds': []},
                                  {'sourceCommit': 'c' * 40}, tree or {}, lfs or set(),
                                  generated_at='2026-10-07T00:00:00Z')

    def test_only_whitelisted_fields_escape_and_no_ingestion_date_is_invented(self):
        data, report = self.stage()
        paper = data['papers'][0]
        self.assertEqual(set(paper), sync.PUBLIC_FIELDS)
        self.assertIsNone(paper['ingestedAt'])
        self.assertEqual(paper['metadataStatus'], 'index_record_only')
        self.assertEqual(paper['fulltextStatus'], 'not_verified')
        self.assertFalse(paper['localAvailable'])
        self.assertNotIn('是', paper['basis'])
        encoded = json.dumps(data, ensure_ascii=False)
        for private in ('private-account', 'do not publish', 'private/trial.pdf', 'a' * 64,
                        'private annotation', '原始路径', 'SHA256', 'sourceCommit'):
            self.assertNotIn(private, encoded)
        self.assertEqual(report['ingestedAtKnown'], 0)

    def test_duplicate_doi_variants_preserve_existing_public_id(self):
        previous = {'papers': [{'id': 'stable-id', 'doi': '10.1234/trial',
                                'title': 'A clinical trial', 'journal': 'Heart'}]}
        data, report = self.stage([row(DOI='HTTPS://DX.DOI.ORG/10.1234/TRIAL'), row(DOI='doi: 10.1234/trial')], previous)
        self.assertEqual(len(data['papers']), 1)
        self.assertEqual(data['papers'][0]['id'], 'stable-id')
        self.assertEqual(report['sourceRows'], 2)
        self.assertEqual(report['removed'], 0)

    def test_fallback_private_hash_deduplicates_but_does_not_define_public_id(self):
        data, _ = self.stage([row(DOI=''), row(DOI='')])
        changed, _ = self.stage([row(DOI='', SHA256='b' * 64)])
        self.assertEqual(len(data['papers']), 1)
        self.assertEqual(data['papers'][0]['id'], changed['papers'][0]['id'])

    def test_invalid_hash_is_not_a_dedup_identifier(self):
        data, report = self.stage([row(DOI='', SHA256='Volume 12'), row(DOI='', SHA256='Volume 12', 题名='A different paper')])
        self.assertEqual(len(data['papers']), 2)
        self.assertEqual(report['sourceChecksumCounts'], {'invalid': 2})

    def test_same_title_legacy_records_match_existing_ids_by_private_hash_without_exporting_it(self):
        import hashlib
        ids = [hashlib.sha256((c * 64).encode()).hexdigest()[:16] for c in ('a', 'b')]
        previous = {'papers': [{'id': identifier, 'title': 'A clinical trial', 'journal': 'Heart', 'doi': ''}
                               for identifier in ids]}
        data, report = self.stage([row(DOI=''), row(DOI='', SHA256='b' * 64)], previous)
        self.assertEqual({p['id'] for p in data['papers']}, set(ids))
        self.assertEqual(report['matchedExisting'], 2)
        self.assertNotIn('a' * 64, json.dumps(data))

    def test_pmid_dedup_and_url_without_doi(self):
        data, _ = self.stage([row(DOI='', PMID='42836296', SHA256=''), row(DOI='', PMID='42836296', SHA256='b' * 64)])
        self.assertEqual(len(data['papers']), 1)
        self.assertEqual(data['papers'][0]['url'], 'https://pubmed.ncbi.nlm.nih.gov/42836296/')

    def test_shared_pmid_joins_doi_and_pmid_only_rows(self):
        data, _ = self.stage([row(PMID='1'), row(PMID='1', DOI='')])
        self.assertEqual(len(data['papers']), 1)
        self.assertEqual(data['papers'][0]['doi'], '10.1234/trial')

    def test_disagreeing_baseline_doi_and_pmid_identity_blocks(self):
        previous = {'papers': [{'id': 'one', 'title': 'A clinical trial', 'journal': 'Heart', 'doi': '10.1234/trial'},
                               {'id': 'two', 'title': 'Another paper', 'journal': 'Heart', 'pmid': '1'}]}
        with self.assertRaisesRegex(sync.SyncError, 'previous_library_identity_conflict'):
            self.stage([row(PMID='1')], previous)

    def test_conflicting_doi_for_same_pmid_blocks(self):
        with self.assertRaisesRegex(sync.SyncError, 'duplicate_identity_conflict'):
            self.stage([row(PMID='1'), row(PMID='1', DOI='10.1234/different')])

    def test_unknown_date_and_private_freeform_date_basis_do_not_escape(self):
        for date, basis in [('2026-09-99', 'Crossref'), ('2026-09-17', 'private note'), ('2026', '无可核验月份'), ('', 'Crossref')]:
            data, _ = self.stage([row(实际出版日期=date, 日期来源=basis)])
            self.assertEqual(data['papers'][0]['date'], '')
            self.assertEqual(data['papers'][0]['datePrecision'], 'unknown')
        data, _ = self.stage([row(日期来源='用户备注+PDF刊期(2026年9月)+/Users/private/source')])
        self.assertEqual(data['papers'][0]['date'], '2026-09')
        self.assertNotIn('用户备注', data['papers'][0]['dateBasis'])
        self.assertNotIn('/Users/', data['papers'][0]['dateBasis'])

    def test_date_precision_is_conservative(self):
        self.assertEqual(sync.publication_date('2026-09-01', 'Crossref published-print')[:2], ('2026-09', 'month'))
        self.assertEqual(sync.publication_date('2026-09-01', 'Crossref published-online')[:2], ('2026-09-01', 'day'))
        self.assertEqual(sync.publication_date('2026', 'Crossref')[:2], ('2026', 'year'))
        self.assertEqual(sync.publication_date('2026-09', 'Crossref')[:2], ('2026-09', 'month'))

    def test_missing_lfs_case_alias_and_blob_are_distinct_and_never_available(self):
        rows = [row(当前路径='private/missing.pdf'),
                row(当前路径='private/pointer.pdf', DOI='10.1234/lfs'),
                row(当前路径='private/CASE.pdf', DOI='10.1234/case'),
                row(当前路径='private/normal.pdf', DOI='10.1234/normal')]
        tree = {'private/pointer.pdf': tree_entry('e' * 40),
                'private/case.pdf': tree_entry(), 'private/normal.pdf': tree_entry()}
        data, report = self.stage(rows, tree=tree, lfs={'e' * 40})
        self.assertEqual(report['pdfAudit']['rowStorageCounts'], {
            'git_blob_unverified': 1, 'lfs_pointer_unverified': 1,
            'missing_in_pinned_tree': 1, 'path_case_or_unicode_mismatch': 1})
        self.assertTrue(all(not p['localAvailable'] for p in data['papers']))
        self.assertEqual(report['pdfAudit']['normalPdfBodiesRead'], 0)
        self.assertNotIn('private/', json.dumps(report))

    def test_metadata_conflicts_are_reported_deterministically(self):
        rows = [row(), row(实际出版日期='2026-09-18')]
        first, report = self.stage(rows)
        second, _ = self.stage(list(reversed(rows)))
        self.assertEqual(first, second)
        self.assertEqual(len(report['sourceMetadataConflicts']), 1)

    def test_no_silent_deletion_of_previous_public_records(self):
        previous = {'papers': [{'id': 'lost', 'title': 'Unrelated', 'journal': 'Other', 'doi': '10.1234/lost'}]}
        with self.assertRaisesRegex(sync.SyncError, 'previous_public_records_unmatched'):
            self.stage(previous=previous)

    def test_title_match_keeps_public_id_and_reports_corrected_doi(self):
        previous = {'papers': [{'id': 'stable', 'title': 'A clinical trial', 'journal': 'Heart', 'doi': '10.1234/old'}]}
        data, report = self.stage(previous=previous)
        self.assertEqual(data['papers'][0]['id'], 'stable')
        self.assertEqual(report['identifierCorrections'], [{'id': 'stable', 'oldDoi': '10.1234/old', 'newDoi': '10.1234/trial'}])

    def test_suspicious_bibliographic_values_fail_without_echo(self):
        for title in ('/Users/private/file.pdf', 'person@example.test', 'api_key=secret', 'private/book.pdf'):
            with self.subTest(title=title), self.assertRaisesRegex(sync.SyncError, '^private_text_in_bibliographic_field$'):
                self.stage([row(题名=title)])
        with self.assertRaisesRegex(sync.SyncError, 'blank_public_title'):
            self.stage([row(题名='')])

    def test_invalid_identifier_and_path_fail_safely(self):
        for update, code in [({'DOI': 'https://account.test/token'}, 'invalid_doi'),
                             ({'PMID': 'account'}, 'invalid_pmid'),
                             ({'当前路径': '../../outside.pdf'}, 'invalid_index_path')]:
            with self.assertRaisesRegex(sync.SyncError, code):
                self.stage([row(**update)])

    def test_private_feeds_and_unknown_fields_are_not_copied(self):
        previous = {'papers': [], 'feeds': [{'id': '1', 'name': 'Journal', 'url': 'https://journal.example/rss',
                                            'enabled': True, 'privateNotes': 'secret'}]}
        data, _ = self.stage(previous=previous)
        self.assertNotIn('privateNotes', data['feeds'][0])
        previous['feeds'][0]['url'] = 'https://user:password@journal.example/rss'
        with self.assertRaises(sync.SyncError):
            self.stage(previous=previous)

    def test_staged_output_is_byte_identical_on_repeated_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, report = self.stage()
            sync.write_candidate(data, report, root)
            dest = root / '.local/public-library-sync'
            before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in dest.iterdir()}
            data['generatedAt'] = '2099-01-01T00:00:00Z'
            sync.write_candidate(data, report, root)
            after = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in dest.iterdir()}
            self.assertEqual(before, after)
            self.assertFalse((root / 'public').exists())
            self.assertFalse((root / 'data').exists())

    def test_round_trip_does_not_add_duplicate_papers_or_change_ids(self):
        first, _ = self.stage()
        second, report = self.stage(previous=first)
        self.assertEqual(first, second)
        self.assertEqual(report['added'], 0)

    def test_output_symlink_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private = root / '.local/public-library-sync'
            private.mkdir(parents=True)
            victim = root / 'victim'
            victim.write_text('unchanged')
            (private / 'library.json').symlink_to(victim)
            data, report = self.stage()
            with self.assertRaises(sync.SyncError):
                sync.write_candidate(data, report, root)
            self.assertEqual(victim.read_text(), 'unchanged')

    def test_public_build_projection_preserves_explicit_unknown_statuses(self):
        data, _ = self.stage()
        paper = build_public.public_paper(data['papers'][0])
        self.assertIsNone(paper['ingestedAt'])
        self.assertEqual(paper['fulltextStatus'], 'not_verified')
        build_public.validate_public(json.dumps(paper))

    def test_cli_access_failure_returns_fixed_code_and_creates_no_candidate(self):
        with patch.object(sync, 'load_source', side_effect=sync.SyncError('source_read_failed')), \
             patch.object(Path, 'read_text', return_value='{"papers": []}'), \
             patch.object(sync, 'write_candidate') as write, \
             contextlib.redirect_stderr(io.StringIO()) as stderr:
            status = sync.main(['--source', '/unreadable/private', '--source-commit', 'a' * 40])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(stderr.getvalue()), {'error': 'source_read_failed'})
        write.assert_not_called()


class PinnedSourceTest(unittest.TestCase):
    def test_git_source_is_pinned_and_only_pointer_sized_pdf_blobs_are_read(self):
        calls = []
        index = ('题名,DOI,期刊,实际出版日期,日期来源,当前路径,SHA256\n'
                 'A,10.1234/a,Heart,2026-09-17,Crossref,private/a.pdf,\n').encode()
        commit, normal, pointer = 'a' * 40, 'b' * 40, 'c' * 40
        def fake(source, args, limit=32 * 1024 * 1024):
            calls.append(args)
            if args == ['rev-parse', '--verify', commit + '^{commit}']:
                return (commit + '\n').encode()
            if args == ['show', commit + ':' + sync.INDEX_PATH]:
                return index
            if args == ['ls-tree', '-rlz', '--full-tree', commit]:
                return (f'100644 blob {normal} 100000\tprivate/a.pdf\0'
                        f'100644 blob {pointer} 130\tprivate/lfs.pdf\0').encode()
            if args == ['cat-file', 'blob', pointer]:
                return b'version https://git-lfs.github.com/spec/v1\noid sha256:synthetic\nsize 100000\n'
            if args == ['rev-parse', commit + ':' + sync.INDEX_PATH]:
                return b'dddddddddddddddddddddddddddddddddddddddd\n'
            self.fail('Unexpected source operation')
        with patch.object(sync, 'git_read', side_effect=fake):
            rows, tree, lfs, provenance = sync.load_source(Path('/read-only-source'), commit)
        self.assertEqual(len(rows), 1)
        self.assertEqual(lfs, {pointer})
        self.assertNotIn(['cat-file', 'blob', normal], calls)
        self.assertEqual(provenance['sourceCommit'], commit)


if __name__ == '__main__':
    unittest.main()
