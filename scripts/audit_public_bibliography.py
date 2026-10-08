#!/usr/bin/env python3
"""Offline suspect inventory of the public library and dynamic feed only.

Heuristic flags are review candidates, not established bibliographic errors.
No DOI resolution, model, private index or PDF access is performed here.
"""
import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

from public_library_quality import DOI_REVIEW
from sync_public_library import public_text

ROOT = Path(__file__).resolve().parents[1]
FIELDS = ('id', 'title', 'journal', 'doi', 'pmid', 'url', 'date')


def query_title(title):
    """Compatibility normalization is a retrieval key, not a new source title."""
    return unicodedata.normalize('NFKC', title)


def candidate_flags(record):
    doi, title = str(record.get('doi') or '').lower(), record.get('title') or ''
    flags = []
    if re.search(r'n{5,}', doi):
        flags.append('doi_template_placeholder')
    if re.fullmatch(r'10\.\d{4,9}/(?:j\.[a-z]+\.\d{4}|[a-z0-9._-]+-)', doi):
        flags.append('doi_truncated_shape')
    if re.search(r'/\d{6,}$', doi):
        flags.append('doi_appended_resource_id')
    if any(value in title for value in ('查看所有期刊', 'AMA Ed Hub', 'JN Learning >')):
        flags.append('title_navigation_or_learning_path')
    if re.search(r'^\s*\d*\s*(?:Title:|Authors?:)|第\s*\d+\s*卷.*第\s*\d+\s*期', title):
        flags.append('title_header_or_author_text')
    if re.match(r'^(?:Invited Commentary|AI IN MEDICINE|AI AND CLINICAL CARE|LESS IS MORE)\b', title):
        flags.append('title_section_prefix')
    if query_title(title) != title:
        flags.append('nfkc_query_variant')
    return flags


def scan(datasets):
    suspects = []
    for dataset, rows in datasets.items():
        if dataset not in {'LIBRARY', 'FEEDS'} or not isinstance(rows, list):
            raise ValueError('invalid_public_dataset')
        for record in rows:
            if not isinstance(record, dict):
                raise ValueError('invalid_public_record')
            safe = {key: str(record.get(key) or '') for key in FIELDS}
            for value in safe.values():
                public_text(value)
            flags = candidate_flags(record)
            decision = DOI_REVIEW.get(record.get('id')) if dataset == 'LIBRARY' else None
            if not flags and decision is None:
                continue
            # Original public strings are retained; unknown/private fields never
            # enter the inventory, and suspicious strings abort with a fixed code.
            row = {'dataset': dataset, **safe, 'queryTitle': query_title(safe['title']),
                   'flags': flags, 'status': 'unresolved'}
            if decision:
                original = decision['original']
                approved = ((decision['title'], decision['doi'], original[2])
                            if decision['action'] == 'correct' else (original[0], '', original[2]))
                identity = (safe['title'], safe['doi'].lower(), safe['journal'])
                if identity in {original, approved} and not safe['pmid']:
                    row.update(status=decision['status'], reviewAction=decision['action'],
                               reason=decision['reason'])
                else:
                    row.update(reviewAction='hold', reason='reviewed_identity_changed_requires_revalidation')
            suspects.append(row)
    statuses = ('verified', 'falsepositive', 'unresolved')
    return {'schemaVersion': 1, 'scope': 'public_library_and_dynamic_metadata',
            'datasetCounts': {key: len(rows) for key, rows in datasets.items()},
            'denominator': sum(map(len, datasets.values())), 'suspectCount': len(suspects),
            'countsByHeuristic': {flag: sum(flag in row['flags'] for row in suspects)
                                 for flag in sorted({flag for row in suspects for flag in row['flags']})},
            'reviewCounts': {status: sum(row['status'] == status for row in suspects) for status in statuses},
            'prefixBasedErrors': 0, 'remoteRequests': 0, 'privatePdfBodiesRead': 0,
            'suspects': suspects}


def read_public_bundle(path):
    raw = path.read_bytes()
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError('public_bundle_too_large')
    text, datasets = raw.decode('utf-8'), {}
    for key, field in (('LIBRARY', 'papers'), ('FEEDS', 'items')):
        data, _ = json.JSONDecoder().raw_decode(text.split('window.' + key + '=', 1)[1])
        datasets[key] = data[field]
    return datasets, hashlib.sha256(raw).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, default=ROOT / 'public/public.js')
    args = parser.parse_args(argv)
    try:
        datasets, digest = read_public_bundle(args.bundle)
        report = {**scan(datasets), 'publicBundleSha256': digest}
        dest = ROOT / '.local/public-library-quality-v2'
        for path in (ROOT / '.local', dest):
            if path.is_symlink():
                raise ValueError('unsafe_audit_directory')
            path.mkdir(exist_ok=True)
        target = dest / 'suspects.json'
        if target.is_symlink():
            raise ValueError('unsafe_audit_file')
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        print(json.dumps({'error': 'public_bibliography_audit_hold'}), file=sys.stderr)
        return 1
    print(json.dumps({key: report[key] for key in ('datasetCounts', 'denominator', 'suspectCount',
                                                 'reviewCounts', 'remoteRequests')}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
