#!/usr/bin/env python3
"""Read-only GitHub literature index and single-PDF access through existing gh login.

All data stays in .local/github-library; this module never imports into public/data,
publishes, sends model input, reads tokens, changes permissions or logs gh stderr.
sync pins the CSV to one commit. search is local. fetch requires a cached paper ID.
"""
import argparse
import base64
import csv
import datetime
import hashlib
import io
import json
import os
import re
import selectors
import subprocess
import sys
import time
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPO = 'dodoxiaxia/AI-'
INDEX_PATH = '文献索引/文献索引.csv'
MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_API_JSON_BYTES = 6 * 1024 * 1024
GH_TIMEOUT_SECONDS = 60
REQUIRED_COLUMNS = ('题名', 'DOI', '期刊', '实际出版日期', '日期来源', '当前路径', 'SHA256')
PAPER_FIELDS = ('id', 'title', 'doi', 'journal', 'date', 'date_basis', 'repo_path', 'pdf_sha256', 'pdf_sha256_status')
CHECKSUM_STATES = ('valid', 'missing', 'invalid')
PDF_RECEIPT_FIELDS = ('paper_id', 'repository', 'commit', 'repo_path', 'index_fingerprint',
                      'blob_sha', 'content_sha256', 'bytes', 'cache_file', 'fetched_at', 'index_sha_verified')
SYNONYMS = {
    '房颤': ('atrial fibrillation',),
    '心衰': ('heart failure',),
    '心电': ('ecg', 'electrocard'),
    '人工智能': ('artificial intelligence', 'ai'),
    '消融': ('ablation',),
}


class LibraryError(ValueError):
    """Fixed diagnostic codes; never include GitHub response or credential text."""

    def __init__(self, code, detail):
        super().__init__(detail)
        self.code, self.detail = code, detail


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _repo_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', value):
        raise LibraryError('invalid_repository', 'Use an owner/repository name')
    return value


def _relative_path(value, pdf=False):
    if (not isinstance(value, str) or not value or value != value.strip()
            or '\\' in value or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise LibraryError('invalid_repo_path', 'Index paths must be safe relative POSIX paths')
    path = PurePosixPath(value)
    if (path.is_absolute() or any(part in ('', '.', '..') for part in value.split('/'))
            or ':' in path.parts[0]):
        raise LibraryError('invalid_repo_path', 'Index paths must be safe relative POSIX paths')
    if pdf and path.suffix.casefold() != '.pdf':
        raise LibraryError('invalid_pdf_path', 'Indexed file must have a PDF extension')
    return value


def _hex(value, length, code):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{%d}' % length, value):
        raise LibraryError(code, 'Invalid content fingerprint in metadata')
    return value.lower()


def _git_blob_sha(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode('ascii') + b'\0' + data).hexdigest()


def _private_root(root, create=False):
    project = Path(root).expanduser().resolve()
    path = project
    for name in ('.local', 'github-library'):
        path = path / name
        if path.is_symlink():
            raise LibraryError('unsafe_cache_path', 'Private cache must not use symlinks')
        if create:
            path.mkdir(exist_ok=True, mode=0o700)
            # Do not change permissions of an existing shared .local directory.
            if name == 'github-library':
                os.chmod(path, 0o700)
        elif path.exists() and not path.is_dir():
            raise LibraryError('unsafe_cache_path', 'Private cache directory is invalid')
    return path


def _cache_file(private, relative, create_parent=False):
    _relative_path(relative)
    path = private
    parts = PurePosixPath(relative).parts
    for index, name in enumerate(parts):
        path = path / name
        if path.is_symlink():
            raise LibraryError('unsafe_cache_path', 'Private cache must not use symlinks')
        if index < len(parts) - 1:
            if create_parent:
                path.mkdir(exist_ok=True, mode=0o700)
                os.chmod(path, 0o700)
            elif path.exists() and not path.is_dir():
                raise LibraryError('unsafe_cache_path', 'Private cache directory is invalid')
    return path


def _read_private(path, limit):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, 'rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise LibraryError('cache_too_large', 'Private cache exceeds its size limit')
    return data


def _atomic_write(path, data):
    if path.is_symlink():
        raise LibraryError('unsafe_cache_path', 'Private cache must not use symlinks')
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex + '.tmp')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            fd = None
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if fd is not None:
            os.close(fd)
        if temporary.exists():
            temporary.unlink()


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8')


def _gh_bytes(endpoint, max_bytes):
    """Bound stdout while invoking a GET only. Never request or display a token."""
    if not isinstance(endpoint, str) or not endpoint.startswith('repos/'):
        raise LibraryError('invalid_endpoint', 'GitHub reads must target a repository endpoint')
    command = ['gh', 'api', '--method', 'GET', '--hostname', 'github.com',
               endpoint, '-H', 'Accept: application/vnd.github+json']
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        raise LibraryError('gh_unavailable', 'Existing gh CLI is unavailable') from None
    selector = selectors.DefaultSelector()
    output = bytearray()
    deadline = time.monotonic() + GH_TIMEOUT_SECONDS
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LibraryError('github_timeout', 'GitHub read timed out; previous snapshot preserved')
            if not selector.select(min(remaining, 1)):
                continue
            chunk = os.read(process.stdout.fileno(), min(65536, max_bytes + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > max_bytes:
                raise LibraryError('github_response_too_large', 'GitHub response exceeds its size limit')
        try:
            status = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise LibraryError('github_timeout', 'GitHub read timed out; previous snapshot preserved') from None
        if status:
            raise LibraryError('github_read_failed', 'GitHub read failed; check existing repository access')
        return bytes(output)
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()


def _gh_json(endpoint, max_bytes=MAX_API_JSON_BYTES):
    try:
        result = json.loads(_gh_bytes(endpoint, max_bytes))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise LibraryError('github_invalid_json', 'GitHub returned invalid metadata') from None
    if not isinstance(result, dict):
        raise LibraryError('github_invalid_metadata', 'GitHub metadata must be an object')
    return result


def _content_endpoint(repo, path, commit):
    return 'repos/' + _repo_name(repo) + '/contents/' + quote(_relative_path(path), safe='/') + '?ref=' + commit


def _repository_file(repo, path, commit, max_bytes):
    endpoint = _content_endpoint(repo, path, commit)
    metadata = _gh_json(endpoint)
    if metadata.get('type') != 'file' or metadata.get('path') != path:
        raise LibraryError('github_file_mismatch', 'GitHub did not return the requested file')
    size = metadata.get('size')
    if type(size) is not int or not 0 < size <= max_bytes:
        raise LibraryError('repository_file_size', 'Repository file is empty or exceeds its size limit')
    blob = _hex(metadata.get('sha'), 40, 'invalid_blob_sha')
    content_metadata = metadata
    if metadata.get('encoding') == 'none':
        # The commit-pinned Contents record binds path -> blob. Blob SHA is an
        # immutable content address, so this second GET stays on that commit's
        # file even if the branch moves. JSON/base64 avoids gh binary filters.
        content_metadata = _gh_json('repos/' + repo + '/git/blobs/' + blob,
                                    max_bytes=(max_bytes * 3) // 2 + 4096)
        if _hex(content_metadata.get('sha'), 40, 'invalid_blob_sha') != blob:
            raise LibraryError('repository_blob_mismatch', 'GitHub blob does not match the pinned file')
        if type(content_metadata.get('size')) is not int or content_metadata['size'] != size:
            raise LibraryError('repository_size_mismatch', 'GitHub blob size does not match the pinned file')
    if content_metadata.get('encoding') != 'base64' or not isinstance(content_metadata.get('content'), str):
        raise LibraryError('github_invalid_base64', 'GitHub did not return base64 file content')
    try:
        data = base64.b64decode(''.join(content_metadata['content'].split()), validate=True)
    except (ValueError, UnicodeEncodeError):
        raise LibraryError('github_invalid_base64', 'GitHub returned invalid file content') from None
    if len(data) != size or len(data) > max_bytes:
        raise LibraryError('repository_size_mismatch', 'Downloaded content does not match repository metadata')
    if _git_blob_sha(data) != blob:
        raise LibraryError('repository_blob_mismatch', 'Downloaded content does not match the pinned blob')
    return data, blob


def normalize_index(raw_csv, repo):
    """Use the confirmed CSV schema; preserve unknown values and date precision."""
    repo = _repo_name(repo)
    if len(raw_csv) > MAX_INDEX_BYTES:
        raise LibraryError('index_too_large', 'Literature CSV exceeds its size limit')
    try:
        text = raw_csv.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise LibraryError('index_encoding', 'Literature CSV must use UTF-8') from None
    reader = csv.DictReader(io.StringIO(text, newline=''))
    headers = reader.fieldnames
    if not headers or len(headers) != len(set(headers)) or any(name not in headers for name in REQUIRED_COLUMNS):
        raise LibraryError('index_schema', 'Literature CSV is missing or duplicates required columns')
    papers, paths, source_rows = [], {}, 0
    try:
        for row in reader:
            if all(not (value or '').strip() for key, value in row.items() if key is not None) and None not in row:
                continue
            source_rows += 1
            if None in row or any(row.get(name) is None for name in REQUIRED_COLUMNS):
                raise LibraryError('index_row_shape', 'Literature CSV contains an incomplete or oversized row')
            path = _relative_path(row['当前路径'], pdf=True)
            original_checksum = row['SHA256'].strip()
            checksum_status = ('missing' if not original_checksum else
                               'valid' if re.fullmatch(r'[0-9a-fA-F]{64}', original_checksum) else 'invalid')
            checksum = original_checksum.lower() if checksum_status == 'valid' else ''
            doi = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', row['DOI'].strip(), flags=re.I).lower()
            paper = {
                'id': 'gh-' + hashlib.sha256((repo.casefold() + '\0' + path).encode()).hexdigest()[:24],
                'title': row['题名'].strip(), 'doi': doi, 'journal': row['期刊'].strip(),
                'date': row['实际出版日期'].strip(), 'date_basis': row['日期来源'].strip(),
                'repo_path': path, 'pdf_sha256': checksum, 'pdf_sha256_status': checksum_status,
            }
            if path in paths:
                if paths[path] != paper:
                    raise LibraryError('index_duplicate_path', 'Literature CSV has conflicting entries for one path')
                continue
            paths[path] = paper
            papers.append(paper)
    except csv.Error:
        raise LibraryError('index_csv_invalid', 'Literature CSV cannot be parsed') from None
    if not papers:
        raise LibraryError('index_empty', 'Literature CSV has no indexed PDFs')
    return papers, source_rows


def checksum_counts(papers):
    return {state: sum(paper.get('pdf_sha256_status') == state for paper in papers) for state in CHECKSUM_STATES}


def sync_snapshot(root=ROOT, repo=DEFAULT_REPO):
    repo = _repo_name(repo)
    _private_root(root)
    metadata = _gh_json('repos/' + repo)
    if metadata.get('private') is not True or str(metadata.get('full_name', '')).casefold() != repo.casefold():
        raise LibraryError('repository_mismatch', 'Expected the authorized private repository')
    branch = metadata.get('default_branch')
    if not isinstance(branch, str) or not branch or any(ord(c) < 32 for c in branch):
        raise LibraryError('default_branch_missing', 'Repository default branch is unavailable')
    reference = _gh_json('repos/' + repo + '/git/ref/heads/' + quote(branch, safe=''))
    obj = reference.get('object')
    if not isinstance(obj, dict) or obj.get('type') != 'commit':
        raise LibraryError('head_not_commit', 'Default branch HEAD is not a commit')
    commit = _hex(obj.get('sha'), 40, 'invalid_commit')
    raw_csv, blob = _repository_file(repo, INDEX_PATH, commit, MAX_INDEX_BYTES)
    papers, source_rows = normalize_index(raw_csv, repo)
    fingerprint = hashlib.sha256(raw_csv).hexdigest()
    stem = commit + '-' + blob
    snapshot = {
        'schema_version': 1, 'private_only': True,
        'repository': {'full_name': metadata['full_name'], 'default_branch': branch, 'visibility': 'private'},
        'snapshot': {'commit': commit, 'index_path': INDEX_PATH, 'index_blob': blob,
                     'fingerprint': fingerprint, 'indexed_at': _now(),
                     'raw_csv_file': 'snapshots/' + stem + '.csv'},
        'source_rows': source_rows, 'checksum_counts': checksum_counts(papers), 'papers': papers,
    }
    private = _private_root(root, create=True)
    raw_path = _cache_file(private, snapshot['snapshot']['raw_csv_file'], create_parent=True)
    history_path = _cache_file(private, 'snapshots/' + stem + '.json', create_parent=True)
    current_path = _cache_file(private, 'index.json')
    # index.json is the single commit point. Earlier failures leave the old index
    # and its immutable CSV usable; extra unreferenced history files are harmless.
    _atomic_write(raw_path, raw_csv)
    _atomic_write(history_path, _json_bytes(snapshot))
    _atomic_write(current_path, _json_bytes(snapshot))
    return snapshot


def _validate_snapshot(snapshot):
    if (not isinstance(snapshot, dict) or snapshot.get('schema_version') != 1
            or snapshot.get('private_only') is not True):
        raise LibraryError('snapshot_schema', 'Private snapshot schema is invalid')
    repository, provenance, papers = snapshot.get('repository'), snapshot.get('snapshot'), snapshot.get('papers')
    if (not isinstance(repository, dict) or repository.get('visibility') != 'private'
            or not isinstance(repository.get('default_branch'), str) or not repository['default_branch']
            or not isinstance(provenance, dict) or not isinstance(papers, list)):
        raise LibraryError('snapshot_schema', 'Private snapshot metadata is invalid')
    _repo_name(repository.get('full_name'))
    _hex(provenance.get('commit'), 40, 'invalid_commit')
    _hex(provenance.get('index_blob'), 40, 'invalid_blob_sha')
    _hex(provenance.get('fingerprint'), 64, 'invalid_index_fingerprint')
    if provenance.get('index_path') != INDEX_PATH or not isinstance(provenance.get('indexed_at'), str):
        raise LibraryError('snapshot_schema', 'Private snapshot provenance is invalid')
    if type(snapshot.get('source_rows')) is not int or snapshot['source_rows'] < len(papers) or not papers:
        raise LibraryError('snapshot_schema', 'Private snapshot row count is invalid')
    expected_raw = 'snapshots/' + provenance['commit'] + '-' + provenance['index_blob'] + '.csv'
    if provenance.get('raw_csv_file') != expected_raw:
        raise LibraryError('snapshot_schema', 'Private snapshot CSV location is invalid')
    seen = set()
    for paper in papers:
        if not isinstance(paper, dict) or any(not isinstance(paper.get(field), str) for field in PAPER_FIELDS):
            raise LibraryError('snapshot_schema', 'Private snapshot paper schema is invalid')
        if not re.fullmatch(r'gh-[0-9a-f]{24}', paper['id']) or paper['id'] in seen:
            raise LibraryError('snapshot_schema', 'Private snapshot paper IDs are invalid')
        seen.add(paper['id'])
        _relative_path(paper['repo_path'], pdf=True)
        if paper['pdf_sha256_status'] not in CHECKSUM_STATES:
            raise LibraryError('snapshot_schema', 'Private snapshot checksum status is invalid')
        if paper['pdf_sha256_status'] == 'valid':
            _hex(paper['pdf_sha256'], 64, 'index_pdf_sha')
        elif paper['pdf_sha256']:
            raise LibraryError('snapshot_schema', 'Unusable checksum must not be treated as a valid SHA256')
    if 'checksum_counts' in snapshot and snapshot['checksum_counts'] != checksum_counts(papers):
        raise LibraryError('snapshot_schema', 'Private snapshot checksum counts are inconsistent')
    return snapshot


def load_snapshot(root=ROOT):
    """Read the current verified private snapshot; absent cache returns None."""
    private = _private_root(root)
    path = _cache_file(private, 'index.json')
    if not path.exists():
        return None
    try:
        snapshot = _validate_snapshot(json.loads(_read_private(path, MAX_INDEX_BYTES * 3)))
        raw = _read_private(_cache_file(private, snapshot['snapshot']['raw_csv_file']), MAX_INDEX_BYTES)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise LibraryError('snapshot_unreadable', 'Private snapshot is unreadable or incomplete') from None
    if (hashlib.sha256(raw).hexdigest() != snapshot['snapshot']['fingerprint']
            or _git_blob_sha(raw) != snapshot['snapshot']['index_blob']):
        raise LibraryError('snapshot_fingerprint_mismatch', 'Private CSV fingerprint does not match its snapshot')
    papers, source_rows = normalize_index(raw, snapshot['repository']['full_name'])
    if papers != snapshot['papers'] or source_rows != snapshot['source_rows']:
        raise LibraryError('snapshot_index_mismatch', 'Private paper metadata does not match the original CSV')
    return snapshot


def search_snapshot(snapshot, q, limit=20):
    """Local metadata search only; returns the nine safe normalized paper fields."""
    if type(limit) is not int or not 1 <= limit <= 100:
        raise LibraryError('invalid_search_limit', 'Search limit must be between 1 and 100')
    if not isinstance(q, str) or len(q) > 500:
        raise LibraryError('invalid_query', 'Search query must be a string of at most 500 characters')
    if snapshot is None:
        return []
    _validate_snapshot(snapshot)
    query = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', q.strip(), flags=re.I).casefold()
    tokens = query.split()
    # Adjacent known Chinese concepts, e.g. 房颤消融, retain AND semantics.
    terms = []
    for token in tokens:
        rest = token
        while rest:
            known = next((word for word in SYNONYMS if rest.startswith(word)), None)
            if known:
                terms.append((known,) + SYNONYMS[known])
                rest = rest[len(known):]
            else:
                next_at = min((rest.find(word) for word in SYNONYMS if rest.find(word) > 0), default=len(rest))
                terms.append((rest[:next_at],))
                rest = rest[next_at:]
    matches = []
    for paper in snapshot['papers']:
        text = ' '.join(paper[field] for field in ('title', 'doi', 'journal')).casefold()
        def term_matches(term):
            return bool(re.search(r'\bai\b', text)) if term == 'ai' else term in text
        if all(any(term_matches(term) for term in alternatives) for alternatives in terms):
            score = 0 if query and paper['doi'].casefold() == query else 1
            matches.append((score, paper['title'].casefold(), paper['id'], paper))
    matches.sort(key=lambda match: match[:3])
    return [{field: paper[field] for field in PAPER_FIELDS} for *_, paper in matches[:limit]]


def _verify_pdf(data, expected_sha=''):
    if not 0 < len(data) <= MAX_PDF_BYTES:
        raise LibraryError('pdf_size', 'PDF is empty or exceeds its size limit')
    if data.startswith(b'version https://git-lfs.github.com/spec/v1'):
        raise LibraryError('pdf_lfs_pointer', 'Indexed content is a Git LFS pointer, not a PDF')
    if not data.startswith(b'%PDF-'):
        raise LibraryError('pdf_magic', 'Indexed content is not a PDF')
    checksum = hashlib.sha256(data).hexdigest()
    if expected_sha and checksum != expected_sha:
        raise LibraryError('pdf_sha_mismatch', 'PDF does not match the index SHA256')
    return checksum


def fetch_pdf(root, paper_id):
    """Fetch one indexed paper, pinned to the loaded snapshot commit; no batching."""
    snapshot = load_snapshot(root)
    if snapshot is None:
        raise LibraryError('snapshot_missing', 'Sync the private index before fetching a PDF')
    selected = [paper for paper in snapshot['papers'] if paper['id'] == paper_id]
    if len(selected) != 1:
        raise LibraryError('paper_not_found', 'Select one paper ID from the cached private index')
    paper, provenance = selected[0], snapshot['snapshot']
    if paper['pdf_sha256_status'] == 'invalid':
        raise LibraryError('index_pdf_sha_invalid', 'This paper has an invalid index checksum; verify the source index before fetching')
    repo, commit = snapshot['repository']['full_name'], provenance['commit']
    private = _private_root(root, create=True)
    stem = paper['id'] + '-' + commit
    relative = 'pdf-cache/' + stem + '.pdf'
    path = _cache_file(private, relative, create_parent=True)
    receipt_path = _cache_file(private, 'pdf-cache/' + stem + '.json')
    if path.exists() and receipt_path.exists():
        try:
            receipt = json.loads(_read_private(receipt_path, 100_000))
            data = _read_private(path, MAX_PDF_BYTES)
            checksum = _verify_pdf(data, paper['pdf_sha256'])
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            raise LibraryError('pdf_cache_invalid', 'Cached PDF or receipt is unreadable') from None
        if (not isinstance(receipt, dict) or receipt.get('commit') != commit
                or receipt.get('repository') != repo or receipt.get('repo_path') != paper['repo_path']
                or receipt.get('paper_id') != paper_id or receipt.get('content_sha256') != checksum
                or not isinstance(receipt.get('blob_sha'), str)
                or re.fullmatch(r'[0-9a-fA-F]{40}', receipt['blob_sha']) is None
                or receipt['blob_sha'].lower() != _git_blob_sha(data)
                or receipt.get('index_fingerprint') != provenance['fingerprint']
                or receipt.get('index_sha_verified') is not (paper['pdf_sha256_status'] == 'valid')
                or receipt.get('bytes') != len(data) or receipt.get('cache_file') != relative):
            raise LibraryError('pdf_cache_invalid', 'Cached PDF does not match its provenance')
        if any(field not in receipt for field in PDF_RECEIPT_FIELDS):
            raise LibraryError('pdf_cache_invalid', 'Cached PDF provenance is incomplete')
        return {**{field: receipt[field] for field in PDF_RECEIPT_FIELDS}, 'cache_hit': True}
    data, blob = _repository_file(repo, paper['repo_path'], commit, MAX_PDF_BYTES)
    checksum = _verify_pdf(data, paper['pdf_sha256'])
    receipt = {
        'paper_id': paper_id, 'repository': repo, 'commit': commit, 'repo_path': paper['repo_path'],
        'index_fingerprint': provenance['fingerprint'], 'blob_sha': blob,
        'content_sha256': checksum, 'bytes': len(data), 'cache_file': relative, 'fetched_at': _now(),
        'index_sha_verified': paper['pdf_sha256_status'] == 'valid',
    }
    _atomic_write(path, data)
    _atomic_write(receipt_path, _json_bytes(receipt))
    return {**receipt, 'cache_hit': False}


def read_verified_pdf(root, receipt):
    """Read one fetched PDF again before serving it, without exposing a cache path."""
    if not isinstance(receipt, dict) or any(field not in receipt for field in PDF_RECEIPT_FIELDS):
        raise LibraryError('pdf_cache_invalid', 'PDF provenance is incomplete')
    paper_id = receipt.get('paper_id')
    if not isinstance(paper_id, str) or not re.fullmatch(r'gh-[0-9a-f]{24}', paper_id):
        raise LibraryError('pdf_cache_invalid', 'PDF provenance is invalid')
    commit = _hex(receipt.get('commit'), 40, 'pdf_cache_invalid')
    _repo_name(receipt.get('repository'))
    _relative_path(receipt.get('repo_path'), pdf=True)
    _hex(receipt.get('index_fingerprint'), 64, 'pdf_cache_invalid')
    checksum = _hex(receipt.get('content_sha256'), 64, 'pdf_cache_invalid')
    blob = _hex(receipt.get('blob_sha'), 40, 'pdf_cache_invalid')
    relative = 'pdf-cache/' + paper_id + '-' + commit + '.pdf'
    if receipt.get('cache_file') != relative or type(receipt.get('bytes')) is not int:
        raise LibraryError('pdf_cache_invalid', 'PDF cache location is invalid')
    try:
        data = _read_private(_cache_file(_private_root(root), relative), MAX_PDF_BYTES)
    except OSError:
        raise LibraryError('pdf_cache_invalid', 'PDF cache is unreadable') from None
    _verify_pdf(data, checksum)
    if len(data) != receipt['bytes'] or _git_blob_sha(data) != blob:
        raise LibraryError('pdf_cache_invalid', 'PDF cache does not match its provenance')
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help='project root; cache always stays under .local')
    commands = parser.add_subparsers(dest='command', required=True)
    sync = commands.add_parser('sync', help='read the authorized private index through existing gh login')
    sync.add_argument('--repo', default=DEFAULT_REPO)
    search = commands.add_parser('search', help='search cached metadata without network')
    search.add_argument('query', nargs='?', default='')
    search.add_argument('--limit', type=int, default=20)
    fetch = commands.add_parser('fetch', help='fetch exactly one PDF by cached paper ID')
    fetch.add_argument('paper_id')
    args = parser.parse_args(argv)
    try:
        if args.command == 'sync':
            snapshot = sync_snapshot(args.root, args.repo)
            output = {'private_only': True, 'repository': snapshot['repository'],
                      'snapshot': snapshot['snapshot'], 'source_rows': snapshot['source_rows'],
                      'papers': len(snapshot['papers']), 'checksum_counts': snapshot['checksum_counts']}
        elif args.command == 'search':
            snapshot = load_snapshot(args.root)
            output = {'available': snapshot is not None, 'items': search_snapshot(snapshot, args.query, args.limit)}
        else:
            output = fetch_pdf(args.root, args.paper_id)
        print(json.dumps(output, ensure_ascii=False))
        return 0
    except LibraryError as error:
        print(json.dumps({'error': error.code, 'detail': error.detail}, ensure_ascii=False), file=sys.stderr)
        return 1
    except OSError:
        print(json.dumps({'error': 'private_io_failed', 'detail': 'Private cache read or write failed'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
