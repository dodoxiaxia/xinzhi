#!/usr/bin/env python3
"""Refresh config/pdf_index_keys.json from the private AI- literature index.

Run by a maintainer whose `gh` login can read dodoxiaxia/AI- (the build itself has no
access to that repository and gets no new secret). Only hashed DOI and title keys are
written, so the public repository learns no titles, paths or checksums.

  python3 scripts/refresh_pdf_index_keys.py                 # fetch the index through gh
  python3 scripts/refresh_pdf_index_keys.py --csv index.csv # use a local copy of the CSV

Run it whenever PDFs were added to the AI- index; papers whose file is newer than the
snapshot get no download button until it is refreshed (the build prints a reminder after
14 days). The change is a normal PR and, once merged, goes live with the next build.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import pdf_identity as identity

REPOSITORY = 'dodoxiaxia/AI-'
INDEX_PATH = '文献索引/文献索引.csv'


def fetch_index():
    result = subprocess.run(['gh', 'api', '-H', 'Accept: application/vnd.github.raw+json',
                             'repos/' + REPOSITORY + '/contents/' + INDEX_PATH],
                            capture_output=True, timeout=120)
    if result.returncode != 0 or not result.stdout:
        raise SystemExit('gh could not read the literature index; check the gh login (no details are printed)')
    return result.stdout


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--csv', help='read this CSV instead of calling gh')
    parser.add_argument('--out', default=str(identity.ROOT / identity.KEYS_PATH))
    args = parser.parse_args(argv)
    data = Path(args.csv).read_bytes() if args.csv else fetch_index()
    snapshot = identity.build_snapshot(identity.read_index_csv(data))
    Path(args.out).write_text(json.dumps(snapshot, separators=(',', ':')) + '\n', encoding='utf-8')
    usable = sum(1 for row in snapshot['rows'] if row[2])
    print('rows', snapshot['rowCount'], 'usable', usable, 'generatedOn', snapshot['generatedOn'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
