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
        self.assertTrue(report['requiresPublicMetadataReview'])

    def test_no_silent_deletion_of_previous_public_records(self):
        previous = {'papers': [{'id': 'lost', 'title': 'Unrelated', 'journal': 'Other', 'doi': '10.1234/lost'}]}
        with self.assertRaisesRegex(sync.SyncError, 'previous_public_records_unmatched'):
            self.stage(previous=previous)

    def test_title_match_keeps_public_id_and_reports_corrected_doi(self):
        previous = {'papers': [{'id': 'stable', 'title': 'A clinical trial', 'journal': 'Heart', 'doi': '10.1234/old'}]}
        data, report = self.stage(previous=previous)
        self.assertEqual(data['papers'][0]['id'], 'stable')
        self.assertEqual(report['identifierCorrections'], [{'id': 'stable', 'oldDoi': '10.1234/old', 'newDoi': '10.1234/trial'}])

    def test_title_only_doi_correction_requires_review_even_for_final_source(self):
        previous = {'papers': [{'id': 'stable', 'title': 'A clinical trial', 'journal': 'Heart', 'doi': '10.1234/old'}]}
        data, report = sync.stage_library([row()], previous, {}, {}, set(), source_final=True)
        self.assertEqual(data['papers'][0]['id'], 'stable')
        self.assertEqual(report['identifierCorrections'], [{'id': 'stable', 'oldDoi': '10.1234/old', 'newDoi': '10.1234/trial'}])
        self.assertFalse(report['requiresFinalSourceRevalidation'])
        self.assertTrue(report['requiresPublicMetadataReview'])
        self.assertFalse(report['published'])

    def test_title_migration_requires_review_without_a_doi_correction(self):
        old = row(题名='Old public title')
        final = row(题名='Corrected public title')
        previous = {'papers': [{'id': 'stable', 'title': old['题名'], 'journal': 'Heart', 'doi': old['DOI']}]}
        migrations, evidence = sync.source_identity_migrations([old], [final], previous['papers'])
        data, report = sync.stage_library([final], previous, {}, {}, set(), source_final=True,
                                         identity_migrations=migrations, migration_evidence=evidence)
        self.assertEqual(data['papers'][0]['id'], 'stable')
        self.assertEqual(report['identifierCorrections'], [])
        self.assertTrue(report['sourceIdentityMigrations'])
        self.assertTrue(report['requiresPublicMetadataReview'])
        self.assertFalse(report['published'])

    def test_same_title_new_doi_never_steals_existing_id_when_original_doi_remains(self):
        previous = {'papers': [{'id': 'stable', 'title': 'A clinical trial', 'journal': 'Heart', 'doi': '10.1234/z-original'}]}
        data, report = self.stage([row(DOI='10.1234/a-addition'), row(DOI='10.1234/z-original')], previous)
        papers = {p['doi']: p for p in data['papers']}
        self.assertEqual(len(papers), 2)
        self.assertEqual(papers['10.1234/z-original']['id'], 'stable')
        self.assertNotEqual(papers['10.1234/a-addition']['id'], 'stable')
        self.assertEqual(report['sameTitleDistinctIdentifiers'], [
            {'dois': ['10.1234/a-addition', '10.1234/z-original'], 'pmids': []}])

    def test_confirmed_final_source_does_not_upgrade_publication_or_fulltext_status(self):
        data, report = sync.stage_library([row()], {'papers': []}, {'sourceCommit': 'c' * 40}, {}, set(), source_final=True)
        self.assertTrue(report['sourceIsFinal'])
        self.assertFalse(report['requiresFinalSourceRevalidation'])
        self.assertFalse(report['published'])
        self.assertFalse(data['papers'][0]['localAvailable'])
        self.assertEqual(data['papers'][0]['fulltextStatus'], 'not_verified')

    def test_owner_confirmed_identity_correction_retains_id_via_private_checksum_continuity(self):
        old = row(DOI='10.1234/wrong', 题名='Wrong source title')
        final = row(DOI='10.1234/correct', 题名='Correct source title')
        previous = {'papers': [{'id': 'stable', 'title': old['题名'], 'journal': 'Heart', 'doi': old['DOI']}]}
        migrations, evidence = sync.source_identity_migrations([old], [final], previous['papers'])
        data, report = sync.stage_library([final], previous, {}, {}, set(), source_final=True,
                                         identity_migrations=migrations, migration_evidence=evidence)
        self.assertEqual(data['papers'][0]['id'], 'stable')
        self.assertEqual(data['papers'][0]['title'], final['题名'])
        self.assertEqual(data['papers'][0]['doi'], final['DOI'])
        self.assertNotIn('a' * 64, json.dumps(report))
        with self.assertRaisesRegex(sync.SyncError, 'source_migrations_require_final_confirmation'):
            sync.stage_library([final], previous, {}, {}, set(), identity_migrations=migrations)

    def test_missing_or_ambiguous_private_checksum_cannot_establish_identity_migration(self):
        previous = [{'id': 'stable', 'title': 'Wrong', 'journal': 'Heart', 'doi': '10.1234/wrong'}]
        for checksum in ('', 'bad'):
            migrations, _ = sync.source_identity_migrations([row(DOI='10.1234/wrong', SHA256=checksum)],
                                                          [row(DOI='10.1234/correct', SHA256=checksum)], previous)
            self.assertEqual(migrations, {})
        migrations, _ = sync.source_identity_migrations([row(DOI='10.1234/wrong')],
                                                       [row(DOI='10.1234/one'), row(DOI='10.1234/two')], previous)
        self.assertEqual(migrations, {})

    def test_corrected_private_pdf_binding_does_not_move_a_still_present_public_doi_id(self):
        old = row(DOI='10.1234/original', 题名='Original public article')
        finals = [row(DOI='10.1234/corrected', 题名='Corrected PDF title'),
                  row(DOI='10.1234/original', 题名='Original public article', SHA256='b' * 64)]
        previous = {'papers': [{'id': 'stable', 'title': old['题名'], 'journal': 'Heart', 'doi': old['DOI']}]}
        migrations, evidence = sync.source_identity_migrations([old], finals, previous['papers'])
        self.assertEqual(migrations, {})
        data, _ = sync.stage_library(finals, previous, {}, {}, set(), source_final=True,
                                     identity_migrations=migrations, migration_evidence=evidence)
        by_doi = {p['doi']: p for p in data['papers']}
        self.assertEqual(by_doi['10.1234/original']['id'], 'stable')
        self.assertNotEqual(by_doi['10.1234/corrected']['id'], 'stable')

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


class AdjudicationTests(unittest.TestCase):
    def policy(self, **updates):
        item = {'doi': '10.1234/trial', 'action': 'official',
                'acceptedTitles': ['A clinical trial'],
                'metadata': {'title': 'A clinical trial', 'journal': 'Official Journal',
                             'pmid': '123', 'date': '2026-09-11', 'datePrecision': 'day',
                             'dateBasis': '官方题录 published-online（已复核）'},
                'reason': 'official_bibliography_only',
                'evidence': [{'url': 'https://publisher.example/article', 'finding': 'canonical_bibliography'}]}
        item.update(updates)
        return {'version': 1, 'sourceCommit': 'c' * 40, 'checkedAt': '2026-10-07', 'decisions': [item]}

    def load(self, policy=None, commit='c' * 40):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'review.json'
            path.write_text(json.dumps(policy or self.policy()))
            return sync.load_adjudications(path, commit)

    def stage(self, rows, previous=None, decisions=None):
        return sync.stage_library(rows, previous or {'papers': []}, {'sourceCommit': 'c' * 40}, {}, set(),
                                  generated_at='2026-10-07T00:00:00Z', adjudications=decisions)

    def test_unresolved_conflict_preserves_old_public_bibliography_and_unknown_date(self):
        old = {'id': 'stable', 'title': 'Original public title', 'journal': 'Original Journal',
               'doi': '10.1234/trial', 'date': '2026-08-01', 'dateBasis': 'unsupported private annotation',
               'localAvailable': True, 'privateNotes': 'do not publish'}
        rows = [row(), row(题名='A conflicting title', 期刊='Different Journal')]
        first, report = self.stage(rows, {'papers': [old]})
        second, _ = self.stage(list(reversed(rows)), {'papers': [old]})
        self.assertEqual(first, second)
        paper = first['papers'][0]
        self.assertEqual((paper['id'], paper['title'], paper['journal']),
                         ('stable', 'Original public title', 'Original Journal'))
        self.assertEqual(paper['date'], '')
        self.assertEqual(paper['metadataStatus'], 'hold_bibliography_review')
        self.assertFalse(paper['localAvailable'])
        self.assertEqual(report['sourceMetadataConflicts'][0]['status'], 'hold_previous_public_record')
        self.assertEqual(report['heldSourceRows'], 2)
        self.assertNotIn('privateNotes', json.dumps(first))
        round_trip, _ = self.stage(rows, first)
        self.assertEqual(first, round_trip)

    def test_unresolved_new_conflict_is_held_without_choosing_or_adding_either_title(self):
        data, report = self.stage([row(), row(题名='Another incompatible title')])
        self.assertEqual(data['papers'], [])
        self.assertEqual(report['added'], 0)
        self.assertEqual(report['sourceMetadataConflicts'][0]['status'], 'hold_new_record')
        self.assertTrue(report['requiresPublicMetadataReview'])

    def test_official_metadata_corrects_public_doi_record_and_holds_unrelated_source_row(self):
        decisions, _ = self.load()
        old = {'papers': [{'id': 'stable', 'title': 'A conflicting title', 'doi': '10.1234/trial',
                           'journal': 'Wrong Journal'}]}
        rows = [row(), row(题名='A conflicting title', 期刊='Wrong Journal')]
        data, report = self.stage(rows, old, decisions)
        paper = data['papers'][0]
        self.assertEqual((paper['id'], paper['title'], paper['journal'], paper['date'], paper['pmid']),
                         ('stable', 'A clinical trial', 'Official Journal', '2026-09-11', '123'))
        self.assertEqual(paper['metadataStatus'], 'official_bibliography_checked')
        self.assertEqual(paper['fulltextStatus'], 'not_verified')
        self.assertIsNone(paper['ingestedAt'])
        self.assertFalse(paper['localAvailable'])
        self.assertEqual(report['heldSourceRows'], 1)
        self.assertEqual(report['sourceMetadataConflicts'][0]['heldSourceRows'], [
            {'row': 2, 'title': 'A conflicting title', 'journal': 'Wrong Journal',
             'status': 'hold_wrong_identifier_binding'}])
        for private in ('private/trial.pdf', '/Users/', 'do not publish', 'a' * 64):
            self.assertNotIn(private, json.dumps(data) + json.dumps(report))
        round_trip, _ = self.stage(rows, data, decisions)
        self.assertEqual(data, round_trip)

    def test_fully_resolved_variants_need_no_new_review_or_fulltext_claim(self):
        decisions, _ = self.load()
        rows = [row(), row(期刊='Journal abbreviation', 实际出版日期='2026-09-01')]
        data, report = self.stage(rows, decisions=decisions)
        self.assertEqual(len(data['papers']), 1)
        self.assertFalse(report['requiresPublicMetadataReview'])
        self.assertEqual(report['heldSourceRows'], 0)
        self.assertFalse(data['papers'][0]['localAvailable'])

    def test_policy_cannot_create_a_doi_record_from_an_unmatched_source_title(self):
        decisions, _ = self.load()
        with self.assertRaisesRegex(sync.SyncError, 'adjudication_no_matching_source_record'):
            self.stage([row(题名='Not the reviewed article')], decisions=decisions)

    def test_stale_source_policy_is_refused(self):
        with self.assertRaisesRegex(sync.SyncError, 'adjudication_source_commit_mismatch'):
            self.load(commit='d' * 40)

    def test_policy_rejects_unknown_private_fields_in_metadata_or_evidence(self):
        for location in ('metadata', 'evidence'):
            policy = self.policy()
            target = policy['decisions'][0]['metadata'] if location == 'metadata' else policy['decisions'][0]['evidence'][0]
            target['privateNotes'] = 'do not publish'
            with self.subTest(location=location), self.assertRaises(sync.SyncError):
                self.load(policy)

    def test_policy_rejects_private_values_credentials_and_unsupported_dates(self):
        for update in ({'title': '/Users/private/book.pdf'}, {'date': '2026-09-99'},
                       {'datePrecision': 'month'}, {'dateBasis': 'private observation'}):
            policy = self.policy()
            policy['decisions'][0]['metadata'].update(update)
            with self.subTest(update=update), self.assertRaises(sync.SyncError):
                self.load(policy)
        policy = self.policy()
        policy['decisions'][0]['evidence'][0]['url'] = 'https://publisher.example/article?token=private'
        with self.assertRaises(sync.SyncError):
            self.load(policy)

    def test_policy_rejects_private_path_hidden_in_html_attribute(self):
        policy = self.policy()
        policy['decisions'][0]['metadata']['title'] = '<span data-source="private/trial.pdf">A clinical trial</span>'
        with self.assertRaisesRegex(sync.SyncError, '^private_text_in_bibliographic_field$'):
            self.load(policy)

    def test_official_pmid_must_not_conflict_with_index_pmid(self):
        decisions, _ = self.load()
        with self.assertRaisesRegex(sync.SyncError, 'duplicate_identity_conflict'):
            self.stage([row(PMID='456')], decisions=decisions)

    def test_explicit_hold_preserves_old_fragment_without_guessing_replacement_identifier(self):
        policy = self.policy(action='hold', acceptedTitles=[], metadata=None)
        decisions, _ = self.load(policy)
        old = {'papers': [{'id': 'stable', 'title': 'A clinical trial', 'journal': 'Heart', 'doi': '10.1234/trial'}]}
        data, report = self.stage([row(), row(题名='A different fragment')], old, decisions)
        self.assertEqual(data['papers'][0]['id'], 'stable')
        self.assertEqual(data['papers'][0]['doi'], '10.1234/trial')
        self.assertEqual(data['papers'][0]['metadataStatus'], 'hold_bibliography_review')
        self.assertTrue(report['requiresPublicMetadataReview'])

    def test_repository_policy_is_source_pinned_and_contains_only_eight_public_decisions(self):
        decisions, provenance = sync.load_adjudications(sync.ADJUDICATION_PATH,
                                                       'fed03f8d789429fc84c94cefcb4b636d75ec9ee3')
        self.assertEqual(len(decisions), 8)
        self.assertEqual(sum(d['action'] == 'official' for d in decisions.values()), 7)
        self.assertEqual(decisions['10.1016/j.landig']['action'], 'hold')
        self.assertEqual(decisions['10.1093/ehjdh/ztag141']['metadata']['date'], '2026-09-11')
        self.assertEqual(decisions['10.1038/s41591-026-04297-7']['metadata']['date'], '2026-02-23')
        self.assertEqual(provenance['adjudicationCheckedAt'], '2026-10-07')


if __name__ == '__main__':
    unittest.main()
