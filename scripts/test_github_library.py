"""Synthetic GitHub fixtures only: no network, model, login or real credentials."""
import base64
import contextlib
import csv
import hashlib
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import github_library as library

REPO = 'dodoxiaxia/AI-'
COMMIT = 'a' * 40
PDF = b'%PDF-1.7\nsynthetic test content\n%%EOF\n'
PDF_SHA = hashlib.sha256(PDF).hexdigest()


def csv_bytes(rows=None, headers=None):
    headers = headers or list(library.REQUIRED_COLUMNS) + ['原始路径', '文件名']
    rows = rows if rows is not None else [{
        '题名': 'Artificial intelligence ECG in atrial fibrillation ablation',
        'DOI': 'https://doi.org/10.1038/example', '期刊': 'Nature Medicine',
        '实际出版日期': '2026-09', '日期来源': '正式刊期',
        '当前路径': '心血管文献/nature系列/Nature Medicine/9月/test.pdf', 'SHA256': PDF_SHA,
        '原始路径': '/Users/private-original-library/test.pdf', '文件名': 'test.pdf',
    }, {
        '题名': 'Heart failure risk stratification', 'DOI': '', '期刊': 'Circulation',
        '实际出版日期': '', '日期来源': '', '当前路径': 'aha系列/Circulation/heart.pdf', 'SHA256': '',
        '原始路径': '/Users/private-original-library/heart.pdf', '文件名': 'heart.pdf',
    }]
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=headers)
    writer.writeheader()
    writer.writerows(rows)
    return ('\ufeff' + stream.getvalue()).encode('utf-8')


def file_metadata(path, content, encoding='base64'):
    return {
        'type': 'file', 'path': path, 'size': len(content), 'sha': library._git_blob_sha(content),
        'encoding': encoding,
        'content': base64.b64encode(content).decode('ascii') if encoding == 'base64' else '',
        # This URL must never be followed by the implementation.
        'download_url': 'https://untrusted.test/arbitrary-download',
    }


class FakeGitHub:
    def __init__(self, index=None, pdf=PDF):
        self.index = index if index is not None else csv_bytes()
        self.pdf = pdf
        self.calls = []
        self.limits = {}

    def metadata(self, endpoint, max_bytes=library.MAX_API_JSON_BYTES):
        self.calls.append(endpoint)
        self.limits[endpoint] = max_bytes
        if endpoint == 'repos/' + REPO:
            return {'private': True, 'full_name': REPO, 'default_branch': 'main'}
        if endpoint == 'repos/' + REPO + '/git/ref/heads/main':
            return {'object': {'type': 'commit', 'sha': COMMIT}}
        expected_index = library._content_endpoint(REPO, library.INDEX_PATH, COMMIT)
        if endpoint == expected_index:
            return file_metadata(library.INDEX_PATH, self.index)
        if endpoint.startswith('repos/' + REPO + '/contents/') and endpoint.endswith('?ref=' + COMMIT):
            from urllib.parse import unquote
            path = unquote(endpoint.split('/contents/', 1)[1].split('?ref=', 1)[0])
            return file_metadata(path, self.pdf, encoding='none')
        if endpoint == 'repos/' + REPO + '/git/blobs/' + library._git_blob_sha(self.pdf):
            return {'sha': library._git_blob_sha(self.pdf), 'size': len(self.pdf),
                    'encoding': 'base64', 'content': base64.b64encode(self.pdf).decode('ascii')}
        raise AssertionError('Unexpected endpoint: ' + endpoint)


class Errors:
    def assert_code(self, code, function, *args):
        with self.assertRaises(library.LibraryError) as caught:
            function(*args)
        self.assertEqual(caught.exception.code, code)


class PrivateLibrary(Errors, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.private = self.root / '.local/github-library'
        self.fake = FakeGitHub()
        self.meta_patch = patch.object(library, '_gh_json', side_effect=self.fake.metadata)
        self.raw_patch = patch.object(library, '_gh_bytes', side_effect=AssertionError('Unexpected real GitHub transport'))
        self.meta_mock = self.meta_patch.start()
        self.raw_mock = self.raw_patch.start()

    def tearDown(self):
        self.raw_patch.stop()
        self.meta_patch.stop()
        self.temp.cleanup()

    def sync(self):
        return library.sync_snapshot(self.root, REPO)

    def test_sync_pins_commit_preserves_dates_and_private_permissions(self):
        snapshot = self.sync()
        self.assertEqual(library.load_snapshot(self.root), snapshot)
        self.assertEqual(snapshot['source_rows'], 2)
        self.assertEqual(snapshot['snapshot']['commit'], COMMIT)
        self.assertEqual(snapshot['papers'][0]['date'], '2026-09')
        self.assertEqual(snapshot['papers'][0]['date_basis'], '正式刊期')
        self.assertEqual(snapshot['papers'][1]['date'], '')
        self.assertEqual(snapshot['checksum_counts'], {'valid': 1, 'missing': 1, 'invalid': 0})
        self.assertEqual(snapshot['papers'][0]['doi'], '10.1038/example')
        self.assertEqual(set(snapshot['papers'][0]), set(library.PAPER_FIELDS))
        self.assertNotIn('/Users/', json.dumps(snapshot))
        self.assertEqual(self.fake.calls.count('repos/' + REPO + '/git/ref/heads/main'), 1)
        self.assertTrue(self.fake.calls[-1].endswith('?ref=' + COMMIT))
        self.assertFalse(self.raw_mock.called)
        raw_path = self.private / snapshot['snapshot']['raw_csv_file']
        self.assertEqual(raw_path.read_bytes(), self.fake.index)
        for directory in (self.private, self.private / 'snapshots'):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        for path in self.private.rglob('*'):
            if path.is_file():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        for name in ('public', 'data', 'editorial', 'service'):
            self.assertFalse((self.root / name).exists())

    def test_failed_api_or_schema_preserves_current_snapshot(self):
        original = self.sync()
        old = (self.private / 'index.json').read_bytes()
        with patch.object(library, '_gh_json', side_effect=library.LibraryError('github_read_failed', 'Synthetic failure')):
            self.assert_code('github_read_failed', self.sync)
        self.fake.index = b'unknown,heading\nvalue,other\n'
        self.assert_code('index_schema', self.sync)
        self.assertEqual((self.private / 'index.json').read_bytes(), old)
        self.assertEqual(library.load_snapshot(self.root), original)

    def test_atomic_commit_failure_keeps_original_snapshot_usable(self):
        original = self.sync()
        old = (self.private / 'index.json').read_bytes()
        original_writer = library._atomic_write
        def fail_current(path, data):
            if path.name == 'index.json':
                raise OSError('Synthetic disk failure')
            return original_writer(path, data)
        # A new index blob stages separate history files before the commit point.
        self.fake.index = self.fake.index.replace(b'Circulation', b'Journal')
        with patch.object(library, '_atomic_write', side_effect=fail_current):
            with self.assertRaises(OSError):
                self.sync()
        self.assertEqual((self.private / 'index.json').read_bytes(), old)
        self.assertEqual(library.load_snapshot(self.root), original)
        self.assertEqual(list(self.private.rglob('*.tmp')), [])

    def test_load_missing_and_search_never_invoke_github(self):
        self.assertIsNone(library.load_snapshot(self.root))
        self.assertEqual(library.search_snapshot(None, '房颤'), [])
        self.assertFalse(self.meta_mock.called)
        self.assertFalse(self.raw_mock.called)
        self.sync()
        self.meta_mock.reset_mock()
        self.raw_mock.reset_mock()
        snapshot = library.load_snapshot(self.root)
        for query in ('10.1038/example', 'https://doi.org/10.1038/EXAMPLE', 'atrial fibrillation',
                      'Nature Medicine', '房颤消融', '心电 人工智能'):
            with self.subTest(query=query):
                results = library.search_snapshot(snapshot, query)
                self.assertEqual(len(results), 1)
                self.assertEqual(results[0]['doi'], '10.1038/example')
                self.assertEqual(set(results[0]), set(library.PAPER_FIELDS))
        self.assertEqual(library.search_snapshot(snapshot, '心衰')[0]['journal'], 'Circulation')
        self.assertFalse(self.meta_mock.called)
        self.assertFalse(self.raw_mock.called)

    def test_tampered_raw_csv_rejected(self):
        snapshot = self.sync()
        raw_path = self.private / snapshot['snapshot']['raw_csv_file']
        raw_path.write_bytes(self.fake.index + b'changed')
        self.assert_code('snapshot_fingerprint_mismatch', library.load_snapshot, self.root)

    def test_json_only_metadata_path_doi_or_sha_change_rejected(self):
        snapshot = self.sync()
        path = self.private / 'index.json'
        for field, value in (('doi', '10.1/invented'), ('repo_path', 'other/secret.pdf'),
                             ('pdf_sha256', 'b' * 64)):
            with self.subTest(field=field):
                edited = json.loads(json.dumps(snapshot))
                edited['papers'][0][field] = value
                path.write_text(json.dumps(edited))
                self.assert_code('snapshot_index_mismatch', library.load_snapshot, self.root)

    def test_symlink_paths_rejected_without_network(self):
        target = self.root / 'outside'
        target.mkdir()
        (self.root / '.local').symlink_to(target, target_is_directory=True)
        self.assert_code('unsafe_cache_path', library.load_snapshot, self.root)
        self.assert_code('unsafe_cache_path', self.sync)
        self.assertFalse(self.meta_mock.called)

    def test_index_symlink_is_rejected(self):
        self.sync()
        path = self.private / 'index.json'
        outside = self.root / 'outside.json'
        outside.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(outside)
        self.assert_code('unsafe_cache_path', library.load_snapshot, self.root)

    def test_fetch_single_pdf_pinned_and_cached_with_provenance(self):
        snapshot = self.sync()
        paper = snapshot['papers'][0]
        receipt = library.fetch_pdf(self.root, paper['id'])
        self.assertFalse(receipt['cache_hit'])
        self.assertEqual(receipt['commit'], COMMIT)
        self.assertEqual(receipt['repo_path'], paper['repo_path'])
        self.assertEqual(receipt['content_sha256'], PDF_SHA)
        self.assertTrue(receipt['index_sha_verified'])
        self.assertEqual(receipt['index_fingerprint'], snapshot['snapshot']['fingerprint'])
        self.assertEqual((self.private / receipt['cache_file']).read_bytes(), PDF)
        self.assertEqual(stat.S_IMODE((self.private / receipt['cache_file']).stat().st_mode), 0o600)
        blob_endpoint = 'repos/' + REPO + '/git/blobs/' + library._git_blob_sha(PDF)
        self.assertEqual(self.fake.calls.count(blob_endpoint), 1)
        self.assertEqual(self.fake.limits[blob_endpoint], (library.MAX_PDF_BYTES * 3) // 2 + 4096)
        self.assertFalse(any('untrusted.test' in endpoint for endpoint in self.fake.calls))
        self.assertFalse(self.raw_mock.called)
        self.meta_mock.reset_mock()
        self.raw_mock.reset_mock()
        cached = library.fetch_pdf(self.root, paper['id'])
        self.assertTrue(cached['cache_hit'])
        self.assertFalse(self.meta_mock.called)
        self.assertFalse(self.raw_mock.called)

    def test_invalid_index_sha_keeps_metadata_but_blocks_only_its_pdf(self):
        self.fake.index = self.fake.index.replace(PDF_SHA.encode(), b'Volume 3 No. 9 | September 2026')
        snapshot = self.sync()
        self.assertEqual(snapshot['checksum_counts'], {'valid': 0, 'missing': 1, 'invalid': 1})
        self.assertEqual(snapshot['papers'][0]['pdf_sha256'], '')
        self.assertEqual(snapshot['papers'][0]['pdf_sha256_status'], 'invalid')
        self.assertEqual(library.load_snapshot(self.root), snapshot)
        self.assertEqual((self.private / snapshot['snapshot']['raw_csv_file']).read_bytes(), self.fake.index)
        result = library.search_snapshot(snapshot, '房颤')[0]
        self.assertEqual(result['pdf_sha256_status'], 'invalid')
        self.meta_mock.reset_mock()
        self.assert_code('index_pdf_sha_invalid', library.fetch_pdf, self.root, result['id'])
        self.assertFalse(self.meta_mock.called)
        self.assertFalse(self.raw_mock.called)
        # Another indexed entry with a genuinely missing hash is usable, with
        # Git blob integrity recorded and no claim of matching an index SHA.
        receipt = library.fetch_pdf(self.root, snapshot['papers'][1]['id'])
        self.assertFalse(receipt['index_sha_verified'])
        self.assertEqual(receipt['content_sha256'], PDF_SHA)

    def test_missing_or_unknown_id_never_downloads(self):
        self.assert_code('snapshot_missing', library.fetch_pdf, self.root, 'unknown')
        self.sync()
        self.meta_mock.reset_mock()
        self.assert_code('paper_not_found', library.fetch_pdf, self.root, '../arbitrary.pdf')
        self.assertFalse(self.meta_mock.called)
        self.assertFalse(self.raw_mock.called)

    def test_pdf_lfs_html_and_index_checksum_fail_before_cache_write(self):
        snapshot = self.sync()
        paper = snapshot['papers'][0]
        for content, code in (
            (b'version https://git-lfs.github.com/spec/v1\noid sha256:dummy\nsize 123', 'pdf_lfs_pointer'),
            (b'<html>not a PDF</html>', 'pdf_magic'),
            (b'%PDF-1.7\ndifferent content', 'pdf_sha_mismatch'),
        ):
            with self.subTest(code=code):
                self.fake.pdf = content
                self.assert_code(code, library.fetch_pdf, self.root, paper['id'])
                self.assertEqual(list((self.private / 'pdf-cache').glob('*.pdf')), [])

    def test_cached_pdf_tampering_does_not_trigger_redownload(self):
        snapshot = self.sync()
        receipt = library.fetch_pdf(self.root, snapshot['papers'][0]['id'])
        (self.private / receipt['cache_file']).write_bytes(b'%PDF-1.7\ncorrupted')
        self.raw_mock.reset_mock()
        self.assert_code('pdf_sha_mismatch', library.fetch_pdf, self.root, snapshot['papers'][0]['id'])
        self.assertFalse(self.raw_mock.called)

    def test_cached_blob_receipt_is_verified_for_valid_and_missing_index_sha(self):
        snapshot = self.sync()
        for paper in snapshot['papers']:
            receipt = library.fetch_pdf(self.root, paper['id'])
            receipt_path = (self.private / receipt['cache_file']).with_suffix('.json')
            original = json.loads(receipt_path.read_text())
            for blob_sha in ('not-a-git-blob-sha', 'b' * 40):
                with self.subTest(status=paper['pdf_sha256_status'], blob_sha=blob_sha):
                    receipt_path.write_text(json.dumps({**original, 'blob_sha': blob_sha}))
                    self.meta_mock.reset_mock()
                    self.raw_mock.reset_mock()
                    self.assert_code('pdf_cache_invalid', library.fetch_pdf, self.root, paper['id'])
                    self.assertFalse(self.meta_mock.called)
                    self.assertFalse(self.raw_mock.called)
            receipt_path.write_text(json.dumps({**original, 'private_unknown_field': 'not-for-output'}))
            result = library.fetch_pdf(self.root, paper['id'])
            self.assertNotIn('private_unknown_field', result)


class IndexBoundaries(Errors, unittest.TestCase):
    def test_unknown_required_schema_stops_and_invalid_hash_is_explicit(self):
        self.assert_code('index_schema', library.normalize_index, b'title,path\nA,x.pdf\n', REPO)
        rows = [{'题名': 'A', 'DOI': '', '期刊': '', '实际出版日期': '', '日期来源': '',
                 '当前路径': 'x.pdf', 'SHA256': 'not-a-hash'}]
        papers, _rows = library.normalize_index(csv_bytes(rows), REPO)
        self.assertEqual(papers[0]['pdf_sha256_status'], 'invalid')
        self.assertEqual(papers[0]['pdf_sha256'], '')

    def test_relative_pdf_path_boundaries(self):
        for path in ('/absolute.pdf', '../outside.pdf', 'a/../outside.pdf', 'a\\test.pdf',
                     'https://example.test/a.pdf', 'a//test.pdf', './test.pdf', 'a/\ntest.pdf'):
            with self.subTest(path=path):
                self.assert_code('invalid_repo_path', library._relative_path, path, True)
        self.assert_code('invalid_pdf_path', library._relative_path, 'a/file.txt', True)
        self.assertEqual(library._relative_path('nature系列/文章.PDF', True), 'nature系列/文章.PDF')

    def test_duplicate_paths_conflict_but_identical_rows_deduplicate(self):
        row = {'题名': 'A', 'DOI': '', '期刊': '', '实际出版日期': '2026', '日期来源': '年份',
               '当前路径': 'a.pdf', 'SHA256': ''}
        papers, source_rows = library.normalize_index(csv_bytes([row, row]), REPO)
        self.assertEqual((len(papers), source_rows, papers[0]['date']), (1, 2, '2026'))
        other = {**row, '题名': 'different'}
        self.assert_code('index_duplicate_path', library.normalize_index, csv_bytes([row, other]), REPO)

    def test_repository_size_and_blob_mismatch_rejected(self):
        metadata = file_metadata('a.pdf', PDF, encoding='none')
        with patch.object(library, '_gh_json', return_value={**metadata, 'size': library.MAX_PDF_BYTES + 1}), patch.object(library, '_gh_bytes') as raw:
            self.assert_code('repository_file_size', library._repository_file, REPO, 'a.pdf', COMMIT, library.MAX_PDF_BYTES)
            raw.assert_not_called()
        blob = {'sha': 'b' * 40, 'size': len(PDF), 'encoding': 'base64',
                'content': base64.b64encode(PDF).decode('ascii')}
        with patch.object(library, '_gh_json', side_effect=[metadata, blob]):
            self.assert_code('repository_blob_mismatch', library._repository_file, REPO, 'a.pdf', COMMIT, library.MAX_PDF_BYTES)
        blob = {**blob, 'sha': metadata['sha'], 'content': base64.b64encode(PDF[:-1]).decode('ascii')}
        with patch.object(library, '_gh_json', side_effect=[metadata, blob]):
            self.assert_code('repository_size_mismatch', library._repository_file, REPO, 'a.pdf', COMMIT, library.MAX_PDF_BYTES)

    def test_blob_response_shape_base64_and_advertised_size_are_strict(self):
        metadata = file_metadata('a.pdf', PDF, encoding='none')
        blob = {'sha': metadata['sha'], 'size': len(PDF), 'encoding': 'base64',
                'content': base64.b64encode(PDF).decode('ascii')}
        for changes, code in (({'size': len(PDF) + 1}, 'repository_size_mismatch'),
                              ({'encoding': 'none'}, 'github_invalid_base64'),
                              ({'content': '%%%notbase64'}, 'github_invalid_base64')):
            with self.subTest(code=code):
                with patch.object(library, '_gh_json', side_effect=[metadata, {**blob, **changes}]):
                    self.assert_code(code, library._repository_file, REPO, 'a.pdf', COMMIT, library.MAX_PDF_BYTES)

    def test_json_transport_is_get_only_piped_bounded_and_never_raw(self):
        payload = b'{"sha":"synthetic"}'
        process = MagicMock()
        process.wait.return_value = 0
        process.poll.return_value = 0
        process.stdout.fileno.return_value = 7
        selector = MagicMock()
        selector.select.return_value = [object()]
        endpoint = 'repos/' + REPO + '/git/blobs/' + 'a' * 40
        with patch.object(library.subprocess, 'Popen', return_value=process) as popen, patch.object(library.selectors, 'DefaultSelector', return_value=selector), patch.object(library.os, 'read', side_effect=[payload, b'']), contextlib.redirect_stdout(io.StringIO()) as stdout:
            result = library._gh_bytes(endpoint, 100)
        self.assertEqual(result, payload)
        self.assertEqual(stdout.getvalue(), '')
        command = popen.call_args.args[0]
        self.assertEqual(command[command.index('--method') + 1], 'GET')
        self.assertIn('Accept: application/vnd.github+json', command)
        self.assertNotIn('--allow-escape-sequences', command)
        self.assertFalse(any('raw' in argument for argument in command))
        self.assertEqual(popen.call_args.kwargs['stdout'], library.subprocess.PIPE)
        self.assertEqual(popen.call_args.kwargs['stderr'], library.subprocess.DEVNULL)
        process.stdout.close.assert_called_once()

    def test_search_limits_and_query_length_are_bounded(self):
        for limit in (0, 101, True):
            self.assert_code('invalid_search_limit', library.search_snapshot, None, '', limit)
        self.assert_code('invalid_query', library.search_snapshot, None, 'x' * 501)

    def test_cli_failure_never_prints_raw_provider_text(self):
        with patch.object(library, 'sync_snapshot', side_effect=library.LibraryError('github_read_failed', 'GitHub read failed')), contextlib.redirect_stderr(io.StringIO()) as err, contextlib.redirect_stdout(io.StringIO()) as out:
            result = library.main(['sync'])
        self.assertEqual(result, 1)
        self.assertEqual(out.getvalue(), '')
        self.assertEqual(json.loads(err.getvalue())['error'], 'github_read_failed')


if __name__ == '__main__':
    unittest.main()
