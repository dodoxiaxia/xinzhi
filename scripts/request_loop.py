#!/usr/bin/env python3
"""Report proposed public-library intake decisions without publishing anything."""

import argparse
from collections import defaultdict
import contextlib
from html import escape
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote, unquote, urlsplit

if __name__ == '__main__':
    sys.dont_write_bytecode = True

from backfill_library_metadata import title_key
from enrich_metadata import enrich_paper
from sync_public_library import normalize_doi, SyncError


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / 'editorial/public_library_snapshot.json'
CLASSIFICATION = ('cleanJournal', 'publisher', 'clinicalTier', 'studyDesign', 'tags')


def doi_key(value):
    if not isinstance(value, str) or len(value) > 500:
        return ''
    value = value.strip()
    if re.match(r'^https?://', value, re.I):
        try:
            url = urlsplit(value)
            if (url.hostname not in ('doi.org', 'dx.doi.org') or url.username or url.password
                    or '?' in value or '#' in value):
                return ''
            value = unquote(url.path[1:], errors='strict')
        except ValueError:
            return ''
    else:
        value = re.sub(r'^doi:\s*', '', value, flags=re.I)
    if not re.fullmatch(r'10\.\d{4,9}/[^\s<>"?#@]+', value, re.ASCII) or not all(
        32 <= ord(c) < 127 for c in value
    ):
        return ''
    try:
        return normalize_doi(value)
    except SyncError:
        return ''


def bibliography_title_key(value):
    return title_key(re.sub(r'^\s*\[[A-Za-z ]+\]\s*', '', value or ''))


def classify(record, doi):
    enriched = enrich_paper({
        **record, 'doi': doi, 'url': 'https://doi.org/' + quote(doi, safe='/'),
    })
    return {key: enriched[key] for key in CLASSIFICATION}


def decide_requests(records, snapshot):
    """Return one recommendation per record; do not mutate either input."""
    by_doi, by_title = defaultdict(list), defaultdict(list)
    for paper in snapshot:
        doi = doi_key(paper.get('doi'))
        title = bibliography_title_key(paper.get('title'))
        if doi:
            by_doi[doi].append((title, paper))
            if title:
                by_title[title].append((doi, paper))

    for row in records:
        if not doi_key(row.get('doi')) or not isinstance(row.get('title'), str) or not bibliography_title_key(row['title']):
            raise ValueError('补录记录需要有效 DOI 和题名')

    decisions = []
    for paper in records:
        doi = doi_key(paper['doi'])
        title = bibliography_title_key(paper['title'])
        result = {'id': paper.get('id'), 'doi': doi, 'title': paper['title']}
        if paper.get('fulltextStatus') != 'available':
            result['decision'] = 'awaiting_fulltext'
        elif by_doi[doi]:
            matched = [row for key, row in by_doi[doi] if key == title]
            result['decision'] = 'already_in_library' if matched else 'identity_conflict'
            result['matchedIds'] = [row.get('id') for row in matched or [row for _, row in by_doi[doi]]]
        else:
            other = by_title[title]
            result['decision'] = 'possible_duplicate' if other else 'ready_to_ingest'
            if other:
                result['matchedIds'] = [row.get('id') for _, row in other]
                result['matchedDois'] = list(dict.fromkeys(other_doi for other_doi, _ in other))
            else:
                result['classification'] = classify(paper, doi)
        decisions.append(result)
    return decisions


def read_papers(path):
    data = json.loads(path.read_text(encoding='utf-8'))
    rows = data.get('papers') if isinstance(data, dict) else data
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError('输入必须是题录数组或含 papers 数组的对象')
    return rows


def markdown(decisions):
    def cell(value):
        return escape(str(value)).replace('\n', ' ').replace('\r', ' ').replace('|', '&#124;')

    lines = ['| DOI | 题名 | 判定 | 匹配 ID | 匹配 DOI | 建议归类 |', '| --- | --- | --- | --- | --- | --- |']
    for row in decisions:
        classification = row.get('classification')
        values = (row['doi'], row['title'], row['decision'], ', '.join(map(str, row.get('matchedIds', []))),
                  ', '.join(row.get('matchedDois', [])), json.dumps(classification, ensure_ascii=False) if classification else '')
        lines.append('| ' + ' | '.join(map(cell, values)) + ' |')
    return '\n'.join(lines) + '\n'


def output_path(path):
    local = ROOT / '.local'
    resolved = path.resolve()
    if local.is_symlink() or not resolved.is_relative_to(local) or resolved == local:
        raise ValueError('--out 必须在仓库的 .local/ 下')
    # Do not overwrite an existing file (including any hard link).
    return resolved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--records', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, default=SNAPSHOT)
    parser.add_argument('--format', choices=('json', 'md'), default='json')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    try:
        target = output_path(args.out) if args.out else None
        with contextlib.redirect_stdout(sys.stderr):
            decisions = decide_requests(read_papers(args.records), read_papers(args.snapshot))
        report = markdown(decisions) if args.format == 'md' else json.dumps(decisions, ensure_ascii=False, indent=2) + '\n'
        if target:
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('x', encoding='utf-8') as out:
                out.write(report)
        else:
            print(report, end='')
    except (ValueError, OSError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
