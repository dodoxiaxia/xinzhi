#!/usr/bin/env python3
"""Audit decoded public bundle payloads and data/*.json without executing JS."""
import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from public_bundle import app_file
from public_split import tier1_data_statements
from release_integrity import is_reading_shard
from text_hygiene import artifact_counts

ROOT = Path(__file__).resolve().parents[1]
JSON = json.JSONDecoder()
ID = re.compile(r'^(?:\d+|PMC\d+|(?:pmid[-:]|rss-)[\w-]+|(?:doi:)?10\.\d{4,9}/\S+|title:[0-9a-f]+)$', re.I)
INLINE = {
    'title', 'titleZh', 'title_zh', 'name', 'label', 'journal', 'cleanJournal',
    'journalAbbreviation', 'author', 'authors', 'leadAuthor', 'lastAuthor', 'one_line',
}
PROSE = INLINE | {
    'abstract', 'abstract_zh', 'summary', 'description', 'snippet', 'text', 'quote', 'section',
    'design', 'findings', 'limits', 'limitations', 'why_read', 'whySelected', 'learning_question',
    'study_type', 'evidence_basis', 'attribution', 'affiliations', 'meshTerms', 'keywords',
    'tags', 'pubTypes', 'publisher', 'category', 'clinicalTier', 'studyDesign', 'topic',
    'aliases', 'basis', 'dateBasis', 'reason', 'detail', 'error', 'failureReason', 'checklist',
    'caveat', 'question', 'population', 'endpoints', 'results', 'practice', 'comparator',
    'highlights', 'takeaway', 'body', 'note', 'message',
}
DATA_WRITER = {
    'feeds': 'refresh_feeds.py', 'pubmed': 'fetch_pubmed.py',
    'radar-archive': 'fetch_archive.py', 'archive-full': 'archive_details.py',
    'translations': 'translate_titles.py', 'quicklooks': 'generate_quicklooks.py',
    'deep-readings': 'daily_fulltext.py', 'weekly-board': 'week_precompute.py',
    'week-precompute-cache': 'week_precompute.py', 'weekly-precompute-cache': 'week_precompute.py',
    'source-health': 'refresh_feeds.py', 'media': 'media_signals.py',
}
PUBLIC_WRITER = {
    'board': 'week_precompute.py', 'pregenerated': 'week_precompute.py',
    'quicklooks': 'generate_quicklooks.py', 'readings': 'daily_fulltext.py',
    'health': 'refresh_feeds.py', 'journal_metrics': 'journal_public_metrics.py',
}


def payload_at(text, marker):
    if marker not in text:
        raise ValueError(f'Public payload marker missing: {marker}')
    return JSON.raw_decode(text.split(marker, 1)[1])[0]


def public_payloads(root):
    def read(path):
        if Path(path).is_absolute() or '..' in Path(path).parts or (root / path).is_symlink():
            raise ValueError(f'Invalid public asset path: {path}')
        return (root / path).read_text(encoding='utf-8')

    app = read(app_file(root))
    header = {}
    for statement in tier1_data_statements(app):
        assignment, value = statement.split('=', 1)
        header[assignment.removeprefix('window.')] = JSON.raw_decode(value)[0]
    manifest = header.pop('XINZHI_PARTS')
    radar_path = header.pop('RADAR_SRC')
    for name, value in header.items():
        yield name.lower().replace('source_health', 'health'), value
    for name, part in manifest['parts'].items():
        marker = 'window.XINZHI_PART(' + json.dumps(name) + ','
        value = payload_at(read(part['src']), marker)
        yield name, value
        if name == 'readings':
            for month, shard in value['shards'].items():
                if not is_reading_shard(shard):
                    raise ValueError(f'Invalid reading shard: {shard}')
                yield name, payload_at(read(shard), 'window.XINZHI_READING_SHARDS[' + json.dumps(month) + ']=')
    yield 'radar', payload_at(read(radar_path), 'window.RADAR_ARCHIVE=')


def source_script(corpus, surface, field, record):
    """Attribute by writer of the value when provenance or the payload schema identifies it."""
    if corpus == 'data' and surface in DATA_WRITER:
        return DATA_WRITER[surface]
    if corpus == 'public' and surface in PUBLIC_WRITER:
        return PUBLIC_WRITER[surface]
    if field.startswith('draftData.'):
        return 'editorial/source_checked_drafts.json'
    if field.startswith('media.') or field == 'mediaTitle':
        return 'media_signals.py'
    if field in {'title', 'titleZh', 'summary'} and record.get('weeklyPick'):
        return 'week_precompute.py'
    if field == 'titleZh':
        return 'unknown (translation cache or editorial title)'
    if field in {'journal', 'cleanJournal', 'title'} and surface == 'library':
        return 'editorial/public_library_snapshot.json'
    if field == 'cleanJournal':
        return 'enrich_metadata.py'
    if field.startswith(('summary', 'abstractSections')) and record.get('abstractSource') in {'Crossref', 'Europe PMC', 'OpenAlex'}:
        return 'archive_details.py (source attribution)'
    if record.get('sourceId') == 'pubmed-journal-fallback' or str(record.get('basis', '')).startswith('PubMed'):
        return 'fetch_pubmed.py'
    if str(record.get('id', '')).startswith('rss-') or str(record.get('basis', '')).startswith('RSS'):
        return 'refresh_feeds.py'
    return 'unknown'


def walk(value, *, surface, path=(), item_id='', record=None, leaf=''):
    """Yield field, identifier and value, collapsing dynamic map keys and list indices."""
    if record is None:
        record = {}
    if isinstance(value, dict):
        local_id = next((str(value[k]) for k in ('id', 'paperID', 'pmid', 'pmcid', 'doi', 'key')
                         if isinstance(value.get(k), (str, int)) and value[k]), '')
        if local_id:
            item_id, record = local_id, value
        for key, child in value.items():
            if ID.fullmatch(key) or (surface == 'archive-full' and not path):
                yield from walk(child, surface=surface, path=path, item_id=key, record=record, leaf=leaf)
            else:
                yield from walk(child, surface=surface, path=path + (key,), item_id=item_id, record=record, leaf=key)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child, surface=surface, path=path, item_id=item_id, record=record, leaf=leaf)
    elif isinstance(value, str):
        if leaf in PROSE:
            yield '.'.join(path), item_id, value, leaf in INLINE, record
        elif surface == 'translations' and not path:
            yield 'titleZh', item_id, value, True, record
        elif surface == 'archive-full' and leaf in {'l', 't', 'au', 'af', 'm', 'k', 'pt'}:
            yield '.'.join(path), item_id, value, leaf in {'l', 'au'}, record
        elif leaf in {'s', 't'} and 'media' in path[:-1]:
            yield '.'.join(path), item_id, value, True, record


def radar_fields(value):
    if value is None:
        return
    for row in value.get('rows', []):
        yield 'title', str(row[0]), row[8], True, 'fetch_archive.py'
    for key, title in value.get('zh', {}).items():
        yield 'titleZh', key, title, True, 'translate_titles.py'
    for key, sections in value.get('abs', {}).items():
        for label, text in sections:
            yield 'abstractSections.label', key, label, True, 'archive_details.py'
            yield 'abstractSections.text', key, text, False, 'archive_details.py'
    for field in ('jn', 'pub', 'tier', 'design', 'tag'):
        for index, text in enumerate(value.get(field, [])):
            yield field, f'{field}[{index}]', text, True, 'build_public.py (radar labels)'


def audit(public_dir=None, data_dir=None, references=None):
    references = references or {}
    totals = Counter(artifact_counts(''))
    groups = defaultdict(lambda: {'count': 0, 'example_ids': []})
    scanned = Counter()
    compared = Counter()

    def collect(corpus, surface, fields):
        for field, item_id, value, single_line, script in fields:
            scanned[corpus] += 1
            reference = references.get(item_id, {}).get(field)
            if reference is not None:
                compared[corpus] += 1
            for artifact, count in artifact_counts(value, single_line=single_line, reference=reference).items():
                if count:
                    totals[artifact] += count
                    row = groups[corpus, artifact, field, script]
                    row['count'] += count
                    example = item_id or f'{surface}:{field}'
                    if example not in row['example_ids'] and len(row['example_ids']) < 5:
                        row['example_ids'].append(example)

    def collect_payload(corpus, surface, value):
        fields = radar_fields(value) if corpus == 'public' and surface == 'radar' else (
            (field, item_id, text, inline, source_script(corpus, surface, field, record))
            for field, item_id, text, inline, record in walk(value, surface=surface)
        )
        collect(corpus, surface, fields)

    if public_dir is not None:
        for surface, payload in public_payloads(public_dir):
            collect_payload('public', surface, payload)
    if data_dir is not None:
        for path in sorted(data_dir.glob('*.json')):
            collect_payload('data', path.stem, json.loads(path.read_text(encoding='utf-8')))
    return {
        'strings_scanned': dict(scanned),
        'dash_reference_comparisons': dict(compared),
        'totals': dict(totals),
        'groups': [
            dict(corpus=corpus, artifact=artifact, field=field, source=source, **row)
            for (corpus, artifact, field, source), row in sorted(groups.items())
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-dir', type=Path)
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--dash-reference', type=Path, help='JSON mapping record ID to field name to trusted source text')
    parser.add_argument('--check', action='store_true', help='exit 1 when any artifacts are found')
    args = parser.parse_args()
    public_dir, data_dir = args.public_dir, args.data_dir
    if public_dir is None and data_dir is None:
        public_dir, data_dir = ROOT / 'public', ROOT / 'data'
    for directory in (public_dir, data_dir):
        if directory is not None and not directory.is_dir():
            parser.error(f'input directory missing: {directory}')
    references = json.loads(args.dash_reference.read_text(encoding='utf-8')) if args.dash_reference else None
    report = audit(public_dir, data_dir, references)
    print(json.dumps(report, indent=2, ensure_ascii=True))
    return int(args.check and any(report['totals'].values()))


if __name__ == '__main__':
    sys.exit(main())
