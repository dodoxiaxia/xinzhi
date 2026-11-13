#!/usr/bin/env python3
"""Read-only SHA-256 check for the planned R2 backfill of stored PDFs.

This tool only reads local files and prints a report. It has no write path to R2 (no network access, no
Cloudflare client, no subprocess) and never modifies, moves or deletes anything it reads. Writing to R2 is
a separate, later step that is reported to the owner first and only happens after the bucket and the
PDF_ARCHIVE binding are confirmed.

Inputs
  --dir DIR         folder that holds the PDFs to check (searched recursively; the originals as the
                    site stores them, for example a copy of the Drive archive)
  --expected FILE   optional, sha256sum format: "<64 hex>  <path relative to DIR>" per line; '#' comments
                    and blank lines are ignored. Without it the report only lists the computed digests.
  --r2-keys FILE    optional, one object key per line (a listing somebody else produced). Files whose key
                    pdf/sha256/<sha256>.pdf is already listed are reported as already_in_r2.
  --json            print the report as JSON instead of text.

Report categories (per file)
  ok                digest equals the expected value (or no expected value was given)
  mismatch          digest differs from the expected value
  not_pdf           does not start with %PDF- (never archived)
  already_in_r2     key is in the --r2-keys listing (nothing to do)
  to_archive        valid and not yet in the listing: what a later write step would upload
Also reported: expected entries whose file is missing, and files with no expected entry.

Exit status: 0 when there is no mismatch, missing file or non-PDF; 1 otherwise; 2 on bad arguments.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

KEY_PREFIX = 'pdf/sha256/'
HEX = re.compile(r'^[a-f0-9]{64}$')
CHUNK = 1024 * 1024


def r2_key(sha256):
    return KEY_PREFIX + sha256 + '.pdf'


def digest(path):
    """SHA-256 hex, size and whether the file starts with the PDF header. Opens the file read-only."""
    h = hashlib.sha256()
    size = 0
    head = b''
    with open(path, 'rb') as stream:
        while True:
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            if not head:
                head = chunk[:5]
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size, head == b'%PDF-'


def read_expected(path):
    expected = {}
    for number, line in enumerate(Path(path).read_text(encoding='utf-8').splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.match(r'^([A-Fa-f0-9]{64})\s+\*?(.+)$', line)
        if not match:
            raise ValueError('expected file line %d is not "<sha256>  <path>"' % number)
        name = match.group(2).strip().replace('\\', '/')
        if name in expected:
            raise ValueError('expected file lists %s twice' % name)
        expected[name] = match.group(1).lower()
    return expected


def read_keys(path):
    return {line.strip() for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip() and not line.startswith('#')}


def check(directory, expected=None, listed=None):
    root = Path(directory)
    if not root.is_dir():
        raise ValueError('not a directory: %s' % directory)
    files = sorted(p for p in root.rglob('*') if p.is_file())
    rows, seen = [], set()
    for path in files:
        name = path.relative_to(root).as_posix()
        seen.add(name)
        sha256, size, is_pdf = digest(path)
        row = {'file': name, 'sha256': sha256, 'size': size, 'key': r2_key(sha256)}
        if not is_pdf:
            row['status'] = 'not_pdf'
        elif expected is not None and name not in expected:
            row['status'] = 'unexpected'
        elif expected is not None and expected[name] != sha256:
            row['status'] = 'mismatch'
            row['expected'] = expected[name]
        elif listed is not None and row['key'] in listed:
            row['status'] = 'already_in_r2'
        else:
            row['status'] = 'to_archive' if listed is not None else 'ok'
        rows.append(row)
    missing = sorted(name for name in (expected or {}) if name not in seen)
    counts = {}
    for row in rows:
        counts[row['status']] = counts.get(row['status'], 0) + 1
    counts['missing_file'] = len(missing)
    return {'files': rows, 'missing': missing, 'counts': counts,
            'failed': any(counts.get(k) for k in ('mismatch', 'missing_file', 'not_pdf'))}


def render(report):
    lines = []
    for row in report['files']:
        extra = ' (expected %s)' % row['expected'] if 'expected' in row else ''
        lines.append('%-13s %s  %d bytes  %s%s' % (row['status'], row['sha256'], row['size'], row['file'], extra))
    for name in report['missing']:
        lines.append('%-13s %s' % ('missing_file', name))
    lines.append('summary: ' + ', '.join('%s=%d' % (k, v) for k, v in sorted(report['counts'].items())))
    lines.append('read-only: nothing was written to R2 or to the checked folder')
    return '\n'.join(lines)


def main(argv=None, out=None):
    out = out or sys.stdout
    parser = argparse.ArgumentParser(description='Read-only SHA-256 check for the planned R2 backfill.')
    parser.add_argument('--dir', required=True)
    parser.add_argument('--expected')
    parser.add_argument('--r2-keys')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    try:
        expected = read_expected(args.expected) if args.expected else None
        listed = read_keys(args.r2_keys) if args.r2_keys else None
        report = check(args.dir, expected, listed)
    except (OSError, ValueError) as error:
        print('error: %s' % error, file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else render(report), file=out)
    return 1 if report['failed'] else 0


if __name__ == '__main__':
    sys.exit(main())
