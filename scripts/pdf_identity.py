#!/usr/bin/env python3
"""Which public papers can really be downloaded: the build-time twin of edge handlePdf's matching.

The Worker (edge/src/00-header-pdf.js) finds a paper's file by exact DOI, or by exact
title when the paper has no DOI, and refuses unless exactly one row of the private
AI- index matches. This module applies the same rules to a *hashed* snapshot of that
index (config/pdf_index_keys.json), so the build only offers a download button when
the Worker can succeed. The repository is public: the snapshot holds
SHA-256 prefixes of normalised DOIs and titles, never titles, paths or checksums.

DOI and title normalisation and the column-prefix list are read from the Worker source
so the two sides cannot drift apart; scripts/test_public_build.py cross-checks them with node.
"""
import csv
import datetime
import hashlib
import io
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEYS_PATH = 'config/pdf_index_keys.json'
WORKER_SOURCE = 'edge/src/00-header-pdf.js'
# JavaScript WhiteSpace + LineTerminator, i.e. what String.prototype.trim and /\s/u treat as space.
_WS = '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]'
_LEADING_TRAILING = re.compile('^' + _WS + '+|' + _WS + '+$')
_RUN = re.compile(_WS + '+')
_DOI_PREFIX = re.compile(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', re.I)
_DOI = re.compile(r'10\.\d{4,9}/[^\s\x00-\x1f\x7f]{1,200}')
REQUIRED_COLUMNS = ('题名', 'DOI', '当前路径', 'SHA256')
STALE_AFTER_DAYS = 14


def _worker_constant(name, root=ROOT):
    text = (Path(root) / WORKER_SOURCE).read_text(encoding='utf-8')
    match = re.search(r'^const ' + name + r' = (.+);$', text, re.M)
    if not match:
        raise ValueError('Worker constant missing: ' + name)
    return json.loads(match.group(1))


CASE_FOLD = _worker_constant('PDF_CASE_FOLD')
COLUMN_PREFIXES = tuple(_worker_constant('PDF_COLUMN_PREFIXES'))
if not COLUMN_PREFIXES or any(p != p.upper() or not p.strip() for p in COLUMN_PREFIXES):
    raise ValueError('Column prefixes must be a short explicit list of uppercase labels')


def pdf_doi(value):
    doi = _DOI_PREFIX.sub('', str(value or '').strip()).lower()
    return doi if _DOI.fullmatch(doi) else ''


def pdf_title(value):
    text = _RUN.sub(' ', _LEADING_TRAILING.sub('', str(value or ''))).lower()
    return ''.join(CASE_FOLD.get(char, char) for char in text)


def title_key(value):
    """Exact folded title, after dropping one known uppercase column label plus a space."""
    raw = _RUN.sub(' ', _LEADING_TRAILING.sub('', str(value or '')))
    for prefix in COLUMN_PREFIXES:
        if raw.startswith(prefix + ' ') and len(raw) > len(prefix) + 1:
            return pdf_title(raw[len(prefix) + 1:])
    return pdf_title(raw)


def key_hash(kind, value):
    return hashlib.sha256((kind + ':' + value).encode('utf-8')).hexdigest()[:24] if value else ''


def safe_path(value):
    """Mirror of the Worker's pdfSafePath."""
    return (isinstance(value, str) and bool(value) and value == _LEADING_TRAILING.sub('', value) and len(value) <= 1024
            and not re.search(r'[\\\x00-\x1f\x7f]', value) and not value.startswith('/')
            and all(part not in ('', '.', '..') for part in value.split('/')) and ':' not in value.split('/')[0]
            and value.lower().endswith('.pdf'))


def usable_row(row):
    """After a unique match the Worker still needs a safe PDF path and a SHA-256 in the index row."""
    return safe_path(row.get('当前路径')) and bool(re.fullmatch(r'[a-f0-9]{64}', str(row.get('SHA256') or '').strip().lower()))


def file_key(row):
    """Hash of the row's SHA-256 when the row is usable, else ''. Rows with equal keys are one file."""
    return key_hash('file', str(row.get('SHA256') or '').strip().lower()) if usable_row(row) else ''


def keys_from_index_rows(rows):
    """[[doi_hash, title_hash, file_key], ...] sorted; duplicate rows are kept so ambiguity stays visible."""
    return sorted([key_hash('doi', pdf_doi(r.get('DOI'))), key_hash('title', title_key(r.get('题名'))), file_key(r)]
                  for r in rows)


def read_index_csv(data):
    text = data.decode('utf-8-sig') if isinstance(data, bytes) else data
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or any(name not in reader.fieldnames for name in REQUIRED_COLUMNS):
        raise ValueError('Index CSV lacks required columns')
    return list(reader)


def build_snapshot(rows, today=None):
    return {'schema': 2, 'generatedOn': (today or datetime.date.today()).isoformat(), 'rowCount': len(rows),
            'rows': keys_from_index_rows(rows)}


def load_snapshot(root=ROOT):
    path = Path(root) / KEYS_PATH
    if path.is_symlink() or not path.is_file():
        raise ValueError('PDF index key snapshot is missing; hold public build')
    data = json.loads(path.read_text(encoding='utf-8'))
    ok = (isinstance(data, dict) and data.get('schema') == 2 and isinstance(data.get('rows'), list)
          and data.get('rowCount') == len(data['rows'])
          and isinstance(data.get('generatedOn'), str)
          and all(isinstance(r, list) and len(r) == 3 and isinstance(r[0], str) and isinstance(r[1], str) and isinstance(r[2], str)
                  and all(re.fullmatch(r'(?:[0-9a-f]{24})?', cell) for cell in r)
                  for r in data['rows']))
    if not ok:
        raise ValueError('PDF index key snapshot is invalid; hold public build')
    datetime.date.fromisoformat(data['generatedOn'])
    return data


def snapshot_age_days(snapshot, today=None):
    return ((today or datetime.date.today()) - datetime.date.fromisoformat(snapshot['generatedOn'])).days


def downloadable_ids(papers, snapshot, hold_ids=()):
    index = {}
    for row in snapshot['rows']:
        for column in (0, 1):
            if row[column]:
                index.setdefault((column, row[column]), []).append(row)
    ids = []
    for paper in papers:
        paper_id = paper.get('id')
        if not isinstance(paper_id, str) or paper_id in hold_ids:
            continue
        doi_raw = str(paper.get('doi') or '').strip()
        doi = pdf_doi(doi_raw)
        title = title_key(paper.get('title'))
        if (doi_raw and not doi) or (not doi and not title):
            continue
        matches = index.get((0, key_hash('doi', doi))) if doi else index.get((1, key_hash('title', title)))
        # One usable row, or several rows that all carry the same file key (same SHA-256), as in the Worker.
        if matches and matches[0][2] and all(row[2] == matches[0][2] for row in matches):
            ids.append(paper_id)
    return sorted(set(ids))
