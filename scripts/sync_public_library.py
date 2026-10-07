#!/usr/bin/env python3
"""Stage public bibliographic metadata from an explicitly pinned, read-only Git source.

No network, credentials, PDF downloads, source writes or publication. The CLI writes
only below this project's ignored .local/public-library-sync directory. Normal PDF
blobs are never read; only <=1 KiB blobs are inspected for an LFS pointer signature.
"""
import argparse
import collections
import csv
import datetime
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlsplit

from build_data import clean, classify

ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = '文献索引/文献索引.csv'
REQUIRED = {'题名', 'DOI', '期刊', '实际出版日期', '日期来源', '当前路径', 'SHA256'}
PUBLIC_FIELDS = {'id', 'title', 'doi', 'pmid', 'url', 'journal', 'date', 'dateBasis',
                 'datePrecision', 'ingestedAt', 'metadataStatus', 'fulltextStatus',
                 'basis', 'localAvailable', 'category'}
FEED_FIELDS = {'id', 'name', 'url', 'originalUrl', 'category', 'sourceType', 'enabled'}
PRIVATE_TEXT = re.compile(
    r'(?i)/(?:Users|home|workspace|tmp)/|[a-z]:\\|file://|\.local/|'
    r'\b(?:api[_-]?key|admin[_-]?token|client[_-]?secret|password)\b|'
    r'\b(?:bearer|ghp_|github_pat_)|[\w.+-]+@[\w.-]+\.[a-z]{2,}|'
    r'(?:\S+/)+\S+\.pdf\b|当前路径|原始路径|私人备注')
MAX_INDEX_BYTES = 16 * 1024 * 1024


class SyncError(ValueError):
    """Only fixed codes may leave this module; never include private input text."""


def public_text(value):
    if not isinstance(value, str):
        raise SyncError('invalid_public_text')
    value = clean(value)
    if len(value) > 4000 or PRIVATE_TEXT.search(value):
        raise SyncError('private_text_in_bibliographic_field')
    return value


def normalize_doi(value):
    value = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', value.strip(), flags=re.I).lower()
    if value and (not re.fullmatch(r'10\.\d{4,9}/[^\s<>?#@]+', value)
                  or not value.isascii() or PRIVATE_TEXT.search(value)):
        raise SyncError('invalid_doi')
    return value


def normalize_pmid(value):
    value = value.strip()
    if value and not re.fullmatch(r'[1-9][0-9]{0,9}', value):
        raise SyncError('invalid_pmid')
    return value


def title_key(title, journal):
    return '\0'.join(re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', v).casefold()).strip()
                     for v in (title, journal))


def publication_date(value, basis):
    """Keep source precision; convert free-form provenance to fixed public labels."""
    value = value.strip()
    precision = {4: 'year', 7: 'month', 10: 'day'}.get(len(value))
    if not precision or not re.fullmatch(r'\d{4}(?:-\d{2})?(?:-\d{2})?', value):
        return '', 'unknown', '发表日期未知'
    try:
        datetime.date.fromisoformat(value + ('-01-01' if precision == 'year' else '-01' if precision == 'month' else ''))
    except ValueError:
        return '', 'unknown', '发表日期未知'
    if basis.startswith('Crossref'):
        label = next((v for v in ('published-online', 'published-print', 'published') if v in basis), '')
        label = 'Crossref' + (' ' + label if label else '') + '（索引记录，未复核）'
        if precision == 'day' and value.endswith('-01') and 'published-print' in basis:
            value, precision = value[:7], 'month'
    elif 'PDF' in basis:
        label = 'PDF 出版信息（索引记录，未复核）'
        if '刊期' in basis and precision == 'day':
            value, precision = value[:7], 'month'
    elif basis.startswith('NEJM AI 官网'):
        label = '期刊官网（索引记录，未复核）'
        if '正式期号' in basis and precision == 'day':
            value, precision = value[:7], 'month'
    else:
        return '', 'unknown', '发表日期未知'
    return value, precision, label


def git_read(source, args, limit=32 * 1024 * 1024):
    env = dict(os.environ, GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0')
    try:
        result = subprocess.run(['git', '-C', str(source), *args], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=60, env=env)
    except (OSError, subprocess.TimeoutExpired):
        raise SyncError('source_read_failed') from None
    if result.returncode or len(result.stdout) > limit:
        raise SyncError('source_read_failed')
    return result.stdout


def load_source(source, commit):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise SyncError('explicit_source_commit_required')
    if git_read(source, ['rev-parse', '--verify', commit + '^{commit}']).decode().strip() != commit:
        raise SyncError('source_commit_mismatch')
    raw = git_read(source, ['show', commit + ':' + INDEX_PATH], MAX_INDEX_BYTES)
    try:
        reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig'), newline=''))
        if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames) or not REQUIRED <= set(reader.fieldnames):
            raise SyncError('index_schema')
        rows = list(reader)
    except (UnicodeDecodeError, csv.Error):
        raise SyncError('index_schema') from None
    if not rows or any(None in row or any(row.get(k) is None for k in REQUIRED) for row in rows):
        raise SyncError('index_row_shape')
    tree = {}
    try:
        for entry in git_read(source, ['ls-tree', '-rlz', '--full-tree', commit]).split(b'\0'):
            if entry:
                meta, path = entry.split(b'\t', 1)
                mode, kind, oid, size = meta.decode('ascii').split()
                tree[path.decode('utf-8')] = {'mode': mode, 'kind': kind, 'oid': oid,
                                            'size': int(size) if size != '-' else None}
    except (ValueError, UnicodeDecodeError):
        raise SyncError('source_tree_invalid') from None
    lfs = set()
    for path, entry in tree.items():
        if (path.lower().endswith('.pdf') and entry['kind'] == 'blob'
                and entry['mode'] in ('100644', '100755') and entry['size'] <= 1024):
            # Inspect tiny Git pointer objects only; never read normal PDF bodies.
            data = git_read(source, ['cat-file', 'blob', entry['oid']], 1024)
            if data.startswith(b'version https://git-lfs.github.com/spec/v1\n'):
                lfs.add(entry['oid'])
    provenance = {'sourceCommit': commit, 'indexSha256': hashlib.sha256(raw).hexdigest(),
                  'indexBlob': git_read(source, ['rev-parse', commit + ':' + INDEX_PATH]).decode().strip()}
    return rows, tree, lfs, provenance


def pdf_audit(rows, tree, lfs):
    aliases = collections.defaultdict(list)
    for path, entry in tree.items():
        aliases[unicodedata.normalize('NFC', path).casefold()].append(entry)
    counts = collections.Counter()
    exceptions = []
    for number, row in enumerate(rows, 1):
        path = row['当前路径']
        if (not path or not path.lower().endswith('.pdf') or path.startswith('/') or '\\' in path or ':' in path.split('/')[0]
                or any(p in ('', '.', '..') for p in path.split('/'))):
            raise SyncError('invalid_index_path')
        entry = tree.get(path)
        matches = aliases.get(unicodedata.normalize('NFC', path).casefold(), [])
        if entry:
            status = ('unsupported_entry_unverified' if entry['mode'] not in ('100644', '100755') or entry['kind'] != 'blob'
                      else 'lfs_pointer_unverified' if entry['oid'] in lfs else 'git_blob_unverified')
        else:
            status = 'path_case_or_unicode_mismatch' if matches else 'missing_in_pinned_tree'
            exceptions.append({'row': number, 'doi': normalize_doi(row['DOI']), 'status': status,
                               'aliasEntries': len(matches),
                               'aliasStorage': ['lfs_pointer_unverified' if e['oid'] in lfs else 'git_blob_unverified'
                                                for e in matches]})
        counts[status] += 1
    return {'rowStorageCounts': dict(sorted(counts.items())), 'exactPathExceptions': exceptions,
            'lfsPointerBlobsInTree': len(lfs), 'normalPdfBodiesRead': 0,
            'scope': '固定提交中的路径和 Git/LFS 元数据；不证明全文完整、身份一致或任何读者可访问'}


def public_feed(feed):
    out = {}
    for key in sorted(FEED_FIELDS):
        if key not in feed:
            continue
        value = feed[key]
        if key == 'enabled':
            if type(value) is not bool:
                raise SyncError('invalid_feed')
        else:
            value = public_text(value)
            if key in ('url', 'originalUrl'):
                parts = urlsplit(value)
                secret_query = any(re.search(r'(?i)token|secret|password|credential|signature|^key$|^auth$', k)
                                   for k, _ in parse_qsl(parts.query))
                if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or secret_query:
                    raise SyncError('invalid_feed')
        out[key] = value
    return out


def source_identity_migrations(previous_rows, final_rows, previous_public):
    """Carry an already public ID through owner-confirmed source corrections.

    Only an unchanged, valid private index checksum can establish continuity.
    The checksum remains in memory; returned evidence contains public metadata.
    """
    final_by_sha = collections.defaultdict(list)
    final_dois = {normalize_doi(row['DOI']) for row in final_rows if row['DOI'].strip()}
    for row in final_rows:
        checksum = row['SHA256'].strip().lower()
        if re.fullmatch(r'[0-9a-f]{64}', checksum):
            final_by_sha[checksum].append(row)
    old_by_doi = {normalize_doi(p['doi']): p for p in previous_public if p.get('doi')}
    old_by_title = collections.defaultdict(list)
    for paper in previous_public:
        old_by_title[title_key(paper.get('title', ''), paper.get('journal', ''))].append(paper)
    migrations, evidence = {}, {}
    for old in previous_rows:
        targets = final_by_sha.get(old['SHA256'].strip().lower(), [])
        identities = {}
        for row in targets:
            doi = normalize_doi(row['DOI'])
            pmid = normalize_pmid(row.get('PMID', row.get('pmid', '')))
            key = 'doi:' + doi if doi else 'pmid:' + pmid if pmid else 'sha:' + row['SHA256'].strip().lower()
            identities[key] = row
        if len(identities) != 1:
            continue  # Ambiguous continuity must not silently select a target.
        key, target = next(iter(identities.items()))
        old_doi, new_doi = normalize_doi(old['DOI']), normalize_doi(target['DOI'])
        if old_doi and old_doi != new_doi and old_doi in final_dois:
            # The public article identified by this DOI still exists. Keep its
            # public ID there; a corrected private PDF binding cannot steal it.
            continue
        old_title, new_title = public_text(old['题名']), public_text(target['题名'])
        if old_doi == new_doi and old_title == new_title and old['期刊'] == target['期刊']:
            continue
        paper = old_by_doi.get(old_doi) if old_doi else None
        candidates = old_by_title.get(title_key(old_title, public_text(old['期刊'])), [])
        paper = paper or (candidates[0] if len(candidates) == 1 else None)
        if paper is None:
            continue
        if key in migrations and migrations[key] != paper['id']:
            raise SyncError('source_migration_identity_conflict')
        migrations[key] = paper['id']
        evidence[paper['id']] = {'id': paper['id'], 'oldDoi': normalize_doi(paper.get('doi', '')),
                                 'newDoi': new_doi, 'oldTitle': public_text(paper.get('title', '')),
                                 'newTitle': new_title, 'basis': 'unchanged_indexed_pdf_sha256'}
    return migrations, [evidence[key] for key in sorted(evidence)]


def stage_library(rows, previous, provenance, tree, lfs, generated_at=None, source_final=False,
                  identity_migrations=None, migration_evidence=None):
    """Strict row whitelist, DOI/PMID dedup, stable public IDs and no silent deletion."""
    if not isinstance(previous, dict) or not isinstance(previous.get('papers'), list):
        raise SyncError('previous_library_required')
    if type(source_final) is not bool:
        raise SyncError('invalid_source_final_status')
    identity_migrations = identity_migrations or {}
    if identity_migrations and not source_final:
        raise SyncError('source_migrations_require_final_confirmation')
    old = previous['papers']
    identities, titles, old_ids = {}, collections.defaultdict(list), {}
    for paper in old:
        if not isinstance(paper, dict):
            raise SyncError('previous_library_schema')
        if not isinstance(paper.get('id'), str) or paper['id'] in old_ids:
            raise SyncError('previous_library_duplicate_identity')
        old_ids[paper['id']] = paper
        for key in (('doi:' + normalize_doi(paper['doi'])) if paper.get('doi') else '',
                    ('pmid:' + normalize_pmid(str(paper['pmid']))) if paper.get('pmid') else ''):
            if key:
                if key in identities:
                    raise SyncError('previous_library_duplicate_identity')
                identities[key] = paper
        titles[title_key(paper.get('title', ''), paper.get('journal', ''))].append(paper)
    groups = collections.defaultdict(list)
    doi_by_pmid = {}
    for row in rows:
        doi, pmid = normalize_doi(row['DOI']), normalize_pmid(row.get('PMID', row.get('pmid', '')))
        if doi and pmid:
            if pmid in doi_by_pmid and doi_by_pmid[pmid] != doi:
                raise SyncError('duplicate_identity_conflict')
            doi_by_pmid[pmid] = doi
    checksum_counts = collections.Counter()
    for row in rows:
        title, journal = public_text(row['题名']), public_text(row['期刊'])
        if not title:
            raise SyncError('blank_public_title')  # Never substitute a private filename.
        doi = normalize_doi(row['DOI'])
        pmid = normalize_pmid(row.get('PMID', row.get('pmid', '')))
        doi = doi or doi_by_pmid.get(pmid, '')
        checksum = row['SHA256'].strip().lower()
        valid_sha = bool(re.fullmatch(r'[0-9a-f]{64}', checksum))
        checksum_counts['valid' if valid_sha else 'invalid' if checksum else 'missing'] += 1
        key = ('doi:' + doi if doi else 'pmid:' + pmid if pmid else 'sha:' + checksum if valid_sha
               else 'title:' + title_key(title, journal))
        date, precision, basis = publication_date(row['实际出版日期'], row['日期来源'])
        groups[key].append({'title': title, 'journal': journal, 'doi': doi, 'pmid': pmid,
                            'date': date, 'datePrecision': precision, 'dateBasis': basis})
    papers, matched_ids, used_ids = [], set(), set()
    metadata_conflicts, corrections, pmids = [], [], {}
    source_dois = {p['doi'] for copies in groups.values() for p in copies if p['doi']}
    source_pmids = {p['pmid'] for copies in groups.values() for p in copies if p['pmid']}
    public_title_identities = collections.defaultdict(set)
    for copies in groups.values():
        for p in copies:
            if p['doi'] or p['pmid']:
                public_title_identities[title_key(p['title'], p['journal'])].add((p['doi'], p['pmid']))
    for key, copies in sorted(groups.items()):
        if len({p['pmid'] for p in copies if p['pmid']}) > 1:
            raise SyncError('duplicate_identity_conflict')
        # Input order must not decide which bibliographic record survives.
        record = dict(sorted(copies, key=lambda p: (not bool(p['date']), not bool(p['pmid']), json.dumps(p, sort_keys=True)))[0])
        if len({json.dumps(p, sort_keys=True) for p in copies}) > 1:
            metadata_conflicts.append({'doi': record['doi'], 'copies': len(copies), 'status': 'source_records_differ'})
        match = identities.get('doi:' + record['doi']) if record['doi'] else None
        migrated_id = identity_migrations.get(key)
        if migrated_id:
            if migrated_id not in old_ids or (match and match['id'] != migrated_id):
                raise SyncError('source_migration_identity_conflict')
            match = old_ids[migrated_id]
        pmid_match = identities.get('pmid:' + record['pmid']) if record['pmid'] else None
        if match and pmid_match and match['id'] != pmid_match['id']:
            raise SyncError('previous_library_identity_conflict')
        match = match or pmid_match
        if match is None and key.startswith('sha:'):
            # Legacy public IDs hashed the source checksum. Use that relationship
            # only to retain an ID already published; never emit a new private hash.
            match = old_ids.get(hashlib.sha256(key[4:].encode()).hexdigest()[:16])
        fallback = titles.get(title_key(record['title'], record['journal']), [])
        if match is None and len(fallback) == 1:
            candidate = fallback[0]
            old_doi = normalize_doi(candidate.get('doi', ''))
            old_pmid = normalize_pmid(str(candidate.get('pmid') or ''))
            # A same-title addition with another strong identity must not steal
            # the ID of an existing article that remains in the final source.
            doi_claimed = old_doi and old_doi != record['doi'] and old_doi in source_dois
            pmid_claimed = old_pmid and old_pmid != record['pmid'] and old_pmid in source_pmids
            if not doi_claimed and not pmid_claimed:
                match = candidate
        public_key = ('doi:' + record['doi'] if record['doi'] else 'pmid:' + record['pmid'] if record['pmid']
                      else 'title:' + title_key(record['title'], record['journal']))
        identifier = match.get('id') if match else hashlib.sha256(public_key.encode()).hexdigest()[:16]
        if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', identifier) or identifier in used_ids:
            raise SyncError('ambiguous_public_identity')
        used_ids.add(identifier)
        if record['pmid']:
            if record['pmid'] in pmids:
                raise SyncError('duplicate_identity_conflict')
            pmids[record['pmid']] = identifier
        if match:
            matched_ids.add(match['id'])
            before = normalize_doi(match.get('doi', ''))
            if before != record['doi']:
                corrections.append({'id': identifier, 'oldDoi': before, 'newDoi': record['doi']})
        record.update(id=identifier, url='https://doi.org/' + quote(record['doi'], safe='/():;') if record['doi'] else
                      'https://pubmed.ncbi.nlm.nih.gov/' + record['pmid'] + '/' if record['pmid'] else '',
                      ingestedAt=None, metadataStatus='index_record_only', fulltextStatus='not_verified',
                      basis='仅公共题录 · 原索引元数据未独立复核 · 未读全文', localAvailable=False,
                      category=classify(record['title'], record['journal']))
        if set(record) != PUBLIC_FIELDS:
            raise SyncError('public_field_allowlist')
        papers.append(record)
    if any(p.get('id') not in matched_ids for p in old):
        raise SyncError('previous_public_records_unmatched')
    papers.sort(key=lambda p: (p['date'], p['id']), reverse=True)
    generated_at = generated_at or datetime.datetime.now(datetime.timezone.utc).isoformat()
    if papers == old:
        generated_at = previous.get('generatedAt') or generated_at
    feeds = [public_feed(f) for f in previous.get('feeds', [])]
    data = {'generatedAt': generated_at, 'papers': papers, 'feeds': feeds,
            'stats': {'papers': len(papers), 'journalLabels': len({p['journal'] for p in papers}),
                      'feedCount': len(feeds), 'enabledFeeds': sum(f.get('enabled') is True for f in feeds)}}
    report = {**provenance, 'sourceRows': len(rows), 'sourceChecksumCounts': dict(checksum_counts),
              'publicPapersBefore': len(old), 'publicPapersAfter': len(papers), 'matchedExisting': len(matched_ids),
              'added': len(papers) - len(matched_ids), 'removed': 0, 'identifierCorrections': corrections,
              'sourceMetadataConflicts': metadata_conflicts, 'pdfAudit': pdf_audit(rows, tree, lfs),
              'sourceIdentityMigrations': migration_evidence or [],
              'requiresPublicMetadataReview': bool(metadata_conflicts),
              'sameTitleDistinctIdentifiers': [
                  {'dois': sorted({doi for doi, _ in identities if doi}),
                   'pmids': sorted({pmid for _, pmid in identities if pmid})}
                  for _, identities in sorted(public_title_identities.items()) if len(identities) > 1],
              'ingestedAtKnown': 0, 'publicFulltextAvailable': 0, 'published': False,
              'sourceIsFinal': source_final, 'requiresFinalSourceRevalidation': not source_final}
    return data, report


def write_candidate(data, report, root=ROOT):
    """Fixed private destination; publication and state integration belong to caller."""
    dest = Path(root)
    for part in ('.local', 'public-library-sync'):
        dest = dest / part
        if dest.is_symlink():
            raise SyncError('unsafe_candidate_directory')
        dest.mkdir(exist_ok=True)
    current = dest / 'library.json'
    if current.is_symlink():
        raise SyncError('unsafe_candidate_file')
    if current.exists():
        try:
            existing = json.loads(current.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            raise SyncError('candidate_unreadable') from None
        if ({k: v for k, v in existing.items() if k != 'generatedAt'}
                == {k: v for k, v in data.items() if k != 'generatedAt'}):
            data = {**data, 'generatedAt': existing['generatedAt']}
    payloads = {'library.json': json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + '\n',
                'library.js': 'window.LIBRARY=' + json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).replace('</', '<\\/') + ';\n',
                'audit.json': json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + '\n'}
    for name, text in payloads.items():
        path = dest / name
        if path.is_symlink():
            raise SyncError('unsafe_candidate_file')
        # Do not churn timestamps or rewrite byte-identical staged data.
        if path.exists() and path.read_text(encoding='utf-8') == text:
            continue
        temporary = dest / ('.' + name + '.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                stream.write(text)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--previous-library', type=Path, default=ROOT / 'data/library.json')
    parser.add_argument('--source-final', action='store_true', help='Source SHA explicitly confirmed final by its owner; does not authorize publication')
    parser.add_argument('--previous-source-commit', help='Explicit old source SHA for index-identity continuity; requires --source-final')
    args = parser.parse_args(argv)
    try:
        previous = json.loads(args.previous_library.read_text(encoding='utf-8'))
        rows, tree, lfs, provenance = load_source(args.source, args.source_commit)
        migrations, evidence = {}, []
        if args.previous_source_commit:
            if not args.source_final:
                raise SyncError('source_migrations_require_final_confirmation')
            old_rows, _, _, _ = load_source(args.source, args.previous_source_commit)
            migrations, evidence = source_identity_migrations(old_rows, rows, previous['papers'])
            provenance['previousSourceCommit'] = args.previous_source_commit
        data, report = stage_library(rows, previous, provenance, tree, lfs, source_final=args.source_final,
                                     identity_migrations=migrations, migration_evidence=evidence)
        write_candidate(data, report)
    except SyncError as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 1
    except (OSError, UnicodeDecodeError, ValueError, KeyError, TypeError):
        print(json.dumps({'error': 'local_input_or_output_failed'}), file=sys.stderr)
        return 1
    print(json.dumps({key: report[key] for key in ('sourceCommit', 'sourceRows', 'publicPapersBefore', 'publicPapersAfter', 'added', 'removed', 'published')}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
