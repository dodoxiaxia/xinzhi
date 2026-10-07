"""Small approved public-only snapshot for offline build fixture roots."""
import hashlib
import json

from apply_public_library import MANIFEST, SNAPSHOT


def write_public_library_fixture(root):
    identifier = 'fixture-approved-paper'
    paper = {'id': identifier, 'title': 'Synthetic clinical trial',
             'doi': '10.1234/synthetic', 'pmid': '', 'journal': 'Heart',
             'url': 'https://doi.org/10.1234/synthetic', 'date': '2026-09-17',
             'dateBasis': 'Crossref published-online（索引记录，未复核）',
             'datePrecision': 'day', 'ingestedAt': None,
             'metadataStatus': 'index_record_only', 'fulltextStatus': 'not_verified',
             'basis': '仅公共题录 · 原索引元数据未独立复核 · 未读全文',
             'localAvailable': False, 'category': '心血管'}
    library = {'generatedAt': '2026-10-07T00:00:00Z', 'papers': [paper], 'feeds': [],
               'stats': {'papers': 1, 'journalLabels': 1, 'feedCount': 0, 'enabledFeeds': 0}}
    raw = (json.dumps(library, ensure_ascii=False, indent=2) + '\n').encode()
    (root / SNAPSHOT).write_bytes(raw)
    manifest = {'schemaVersion': 1, 'snapshotSha256': hashlib.sha256(raw).hexdigest(),
                'snapshotCount': 1, 'previousCount': 1, 'previousIds': [identifier],
                'previousIdsSha256': hashlib.sha256((identifier + '\n').encode()).hexdigest()}
    (root / MANIFEST).write_text(json.dumps(manifest))
    (root / 'data/library.json').write_bytes(raw)
    return library
