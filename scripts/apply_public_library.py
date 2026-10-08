#!/usr/bin/env python3
"""Apply the reviewed public snapshot after state restore, before daily work.

No source checkout, CSV, audit, PDF or network is read. Public snapshot bytes are
pinned by a checked-in manifest. Both output files are prepared before replacement;
each replacement is atomic, but the pair is not a cross-file transaction. A failed
run must HOLD the pipeline; rerunning repairs a partially replaced pair.
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path

from sync_public_library import (PUBLIC_FIELDS, SyncError, normalize_doi,
                                 normalize_pmid, public_feed, public_text,
                                 publication_date, OFFICIAL_DATE_BASES)

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = 'editorial/public_library_snapshot.json'
MANIFEST = 'editorial/public_library_snapshot_manifest.json'
DERIVED_FIELDS = {'cleanJournal', 'publisher', 'clinicalTier', 'studyDesign', 'tags',
                  'authors', 'affiliations', 'pubTypes', 'summary', 'abstractSections',
                  'quantitativeMetrics', 'titleZh'}
DATE_BASES = OFFICIAL_DATE_BASES | {
    'Crossref（索引记录，未复核）', 'Crossref published（索引记录，未复核）',
    'Crossref published-online（索引记录，未复核）',
    'Crossref published-print（索引记录，未复核）',
    'PDF 出版信息（索引记录，未复核）', '期刊官网（索引记录，未复核）'}


class SnapshotError(ValueError):
    """Fixed public diagnostic codes only; never echo input content."""


def _hold(code):
    raise SnapshotError('public_library_snapshot_hold:' + code)


def _read(root, name, limit):
    path = Path(root)
    for part in Path(name).parts:
        path = path / part
        if path.is_symlink():
            _hold('unsafe_path')
    try:
        with path.open('rb') as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            _hold('input_too_large')
        return raw
    except OSError:
        _hold('required_file_missing_or_unreadable')


def _json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                _hold('duplicate_json_key')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: _hold('invalid_json'))
    except (ValueError, UnicodeDecodeError):
        _hold('invalid_json')


def _ids(papers):
    if not isinstance(papers, list):
        _hold('papers_schema')
    by_id = {}
    for paper in papers:
        identifier = paper.get('id') if isinstance(paper, dict) else None
        if (not isinstance(identifier, str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', identifier)
                or identifier in {'__proto__', 'constructor', 'prototype'}):
            _hold('invalid_id')
        if identifier in by_id:
            _hold('duplicate_id')
        by_id[identifier] = paper
    return by_id


def _timestamp(value):
    if not isinstance(value, str) or 'T' not in value:
        _hold('invalid_timestamp')
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            _hold('invalid_timestamp')
    except ValueError:
        _hold('invalid_timestamp')


def _primary(paper, exact=False):
    if (not PUBLIC_FIELDS <= paper.keys()
            or (exact and set(paper) != PUBLIC_FIELDS)):
        _hold('primary_field_schema')
    for key in PUBLIC_FIELDS - {'ingestedAt', 'localAvailable'}:
        if public_text(paper[key]) != paper[key]:
            _hold('noncanonical_public_text')
    if not paper['title']:
        _hold('blank_title')
    if normalize_doi(paper['doi']) != paper['doi'] or normalize_pmid(paper['pmid']) != paper['pmid']:
        _hold('noncanonical_identifier')
    if paper['url']:
        public_feed({'url': paper['url']})
    if paper['dateBasis'] not in DATE_BASES:
        _hold('unsupported_date_basis')
    basis = paper['dateBasis']
    if basis in OFFICIAL_DATE_BASES - {'发表日期未知'}:
        basis = 'Crossref published-online'
    elif basis == '期刊官网（索引记录，未复核）':
        basis = 'NEJM AI 官网 Recently Published'
    date, precision, _ = publication_date(paper['date'], basis)
    if (date, precision) != (paper['date'], paper['datePrecision']):
        _hold('invalid_date_precision')
    if paper['localAvailable'] is not False or paper['fulltextStatus'] != 'not_verified':
        _hold('unverified_fulltext_claim')
    if paper['ingestedAt'] is not None:
        _timestamp(paper['ingestedAt'])
    if paper['metadataStatus'] not in {'index_record_only', 'official_bibliography_checked', 'hold_bibliography_review'}:
        _hold('invalid_metadata_status')


def _safe_value(value):
    if isinstance(value, str):
        public_text(value)
    elif value is None or isinstance(value, bool):
        pass
    elif isinstance(value, (int, float)):
        if not math.isfinite(value):
            _hold('invalid_derived_value')
    elif isinstance(value, list):
        for item in value:
            _safe_value(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            public_text(key)
            _safe_value(item)
    else:
        _hold('invalid_derived_value')


def _derived(paper):
    out = {key: value for key, value in paper.items() if key in DERIVED_FIELDS}
    if 'abstractSections' in out:
        if not isinstance(out['abstractSections'], list):
            _hold('invalid_derived_value')
        out['abstractSections'] = [{k: v for k, v in section.items() if k in {'label', 'text'}}
                                  for section in out['abstractSections'] if isinstance(section, dict)]
    if 'quantitativeMetrics' in out:
        if not isinstance(out['quantitativeMetrics'], dict):
            _hold('invalid_derived_value')
        out['quantitativeMetrics'] = {k: v for k, v in out['quantitativeMetrics'].items()
                                      if k in {'sampleSize', 'followUp', 'trialId', 'effectSizes'}}
    _safe_value(out)
    return out


def load_snapshot(root=ROOT):
    manifest = _json(_read(root, MANIFEST, 256 * 1024))
    fields = {'schemaVersion', 'snapshotSha256', 'snapshotCount', 'previousCount',
              'previousIds', 'previousIdsSha256'}
    if (not isinstance(manifest, dict) or set(manifest) != fields
            or type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1
            or type(manifest['snapshotCount']) is not int or manifest['snapshotCount'] <= 0
            or type(manifest['previousCount']) is not int or manifest['previousCount'] <= 0):
        _hold('manifest_schema')
    for key in ('snapshotSha256', 'previousIdsSha256'):
        if not isinstance(manifest[key], str) or not re.fullmatch(r'[a-f0-9]{64}', manifest[key]):
            _hold('manifest_schema')
    old = manifest['previousIds']
    if (not isinstance(old, list) or any(not isinstance(v, str) for v in old)
            or old != sorted(set(old)) or len(old) != manifest['previousCount']):
        _hold('previous_ids_schema')
    if hashlib.sha256(('\n'.join(old) + '\n').encode()).hexdigest() != manifest['previousIdsSha256']:
        _hold('previous_ids_hash_mismatch')
    raw = _read(root, SNAPSHOT, 32 * 1024 * 1024)
    if hashlib.sha256(raw).hexdigest() != manifest['snapshotSha256']:
        _hold('snapshot_hash_mismatch')
    snapshot = _json(raw)
    if not isinstance(snapshot, dict) or set(snapshot) != {'generatedAt', 'papers', 'feeds', 'stats'}:
        _hold('snapshot_schema')
    approved = _ids(snapshot['papers'])
    if len(approved) != manifest['snapshotCount']:
        _hold('snapshot_count_mismatch')
    if not set(old) <= approved.keys():
        _hold('previous_ids_missing_from_snapshot')
    _timestamp(snapshot['generatedAt'])
    if not isinstance(snapshot['feeds'], list) or not isinstance(snapshot['stats'], dict):
        _hold('snapshot_schema')
    for feed in snapshot['feeds']:
        if not isinstance(feed, dict) or public_feed(feed) != feed:
            _hold('snapshot_feed_schema')
    for paper in approved.values():
        _primary(paper, exact=True)
        if paper['ingestedAt'] is not None:
            _hold('snapshot_ingestion_date_invented')
    return snapshot


def require_snapshot(library, root=ROOT):
    """HOLD a public build if state has silently reverted approved bibliography."""
    snapshot = load_snapshot(root)
    if not isinstance(library, dict):
        _hold('library_schema')
    current = _ids(library.get('papers'))
    for approved in snapshot['papers']:
        paper = current.get(approved['id'])
        if paper is None:
            _hold('approved_id_missing')
        if any(key not in paper or paper[key] != approved[key] for key in PUBLIC_FIELDS):
            _hold('approved_primary_fields_changed')
    for paper in current.values():
        _primary(paper)
    return library


def merge_snapshot(library, snapshot, generated_at=None):
    if not isinstance(library, dict):
        _hold('library_schema')
    current = _ids(library.get('papers'))
    approved = _ids(snapshot['papers'])
    papers = []
    for identifier, paper in approved.items():
        previous = current.get(identifier, {})
        same_identity = all((previous.get(k) or '') == (paper[k] or '')
                            for k in ('doi', 'pmid', 'title', 'journal'))
        papers.append({**(_derived(previous) if same_identity else {}), **paper})
    for identifier, paper in current.items():
        if identifier not in approved:
            _primary(paper)
            papers.append({**_derived(paper), **{k: paper[k] for k in PUBLIC_FIELDS}})
    papers.sort(key=lambda p: (p['date'], p['id']), reverse=True)
    feeds = library.get('feeds', snapshot['feeds'])
    if not isinstance(feeds, list) or any(not isinstance(f, dict) for f in feeds):
        _hold('feed_schema')
    feeds = [public_feed(feed) for feed in feeds]
    merged = {'papers': papers, 'feeds': feeds,
              'stats': {'papers': len(papers), 'journalLabels': len({p['journal'] for p in papers}),
                        'feedCount': len(feeds), 'enabledFeeds': sum(f.get('enabled') is True for f in feeds)}}
    if isinstance(library.get('enrichedAt'), str):
        _timestamp(library['enrichedAt'])
        merged['enrichedAt'] = library['enrichedAt']
    unchanged = {k: v for k, v in library.items() if k != 'generatedAt'} == merged
    merged['generatedAt'] = (library.get('generatedAt') if unchanged else None) or generated_at or datetime.datetime.now(datetime.timezone.utc).isoformat()
    _timestamp(merged['generatedAt'])
    return merged


def _write_pair(root, data):
    directory = Path(root) / 'data'
    if directory.is_symlink() or not directory.is_dir():
        _hold('unsafe_data_directory')
    payloads = {
        'library.json': (json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode(),
        'library.js': ('window.LIBRARY=' + json.dumps(data, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':')).replace('</', '<\\/') + ';\n').encode()}
    prepared = []
    try:
        for name, raw in payloads.items():
            target = directory / name
            if target.is_symlink():
                _hold('unsafe_output_file')
            if target.exists() and target.read_bytes() == raw:
                continue
            fd, name = tempfile.mkstemp(prefix='.' + target.name + '-', suffix='.tmp', dir=directory)
            temp = Path(name)
            prepared.append((temp, target))
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
        for temp, target in prepared:
            os.replace(temp, target)
    finally:
        for temp, _ in prepared:
            temp.unlink(missing_ok=True)
    return bool(prepared)


def apply_snapshot(root=ROOT, generated_at=None):
    snapshot = load_snapshot(root)
    library = _json(_read(root, 'data/library.json', 32 * 1024 * 1024))
    merged = merge_snapshot(library, snapshot, generated_at)
    require_snapshot(merged, root)
    # Preserve an already correct library's exact JSON formatting and mtime. JS is
    # checked semantically too; a missing or stale browser file is repaired below.
    js_raw = _read(root, 'data/library.js', 32 * 1024 * 1024) if (Path(root) / 'data/library.js').exists() else b''
    if merged == library and js_raw.startswith(b'window.LIBRARY=') and js_raw.rstrip().endswith(b';'):
        try:
            if _json(js_raw[len(b'window.LIBRARY='):].rstrip()[:-1].replace(b'<\\/', b'</')) == merged:
                return False
        except SnapshotError:
            pass
    return _write_pair(root, merged)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args(argv)
    try:
        changed = apply_snapshot(args.root)
    except (SnapshotError, SyncError) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({'error': 'public_library_snapshot_hold:local_input_or_output_failed'}), file=sys.stderr)
        return 1
    print(json.dumps({'publicLibrarySnapshotApplied': True, 'changed': changed}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
