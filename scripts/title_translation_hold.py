#!/usr/bin/env python3
"""Hold new papers out of public lists until a qualified Chinese title exists.

Qualified means the original title already contains Han characters, or titleZh
does (after the existing hygiene / source-number checks, which this module
does not relax). Machine titles are still stored by translate_titles.py.

New papers without a qualified Chinese title are never published in English.
Failed or missing translations stay in the queue and are listed in the build
receipt. Papers already in the approved public-library snapshot stay listed
even if the Chinese title is still missing, so existing inventory is not
withdrawn.
"""
import datetime
import json
from pathlib import Path

from source_title_quality import usable_source_title

LEDGER = 'data/title-translation-hold.json'


def has_han(value):
    return any('\u4e00' <= char <= '\u9fff' for char in value or '')


def has_qualified_zh_title(paper):
    if has_han(paper.get('title') or ''):
        return True
    return has_han(paper.get('titleZh') or paper.get('title_zh') or '')


def paper_key(paper):
    if paper.get('pmid'):
        return 'pmid:%s' % paper['pmid']
    if paper.get('doi'):
        return 'doi:%s' % str(paper['doi']).lower()
    from resolve_dois import translation_title_key
    return translation_title_key(paper.get('title')) or ''


def parse_time(value):
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        stamp = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=datetime.timezone.utc)
    return stamp.astimezone(datetime.timezone.utc)


def iso(stamp):
    return stamp.astimezone(datetime.timezone.utc).isoformat()


def earliest_seen(paper, times_by_key=None):
    stamps = [parse_time(paper.get(field)) for field in ('ingestedAt', 'fetchedAt', 'addedAt')]
    key = paper_key(paper)
    if times_by_key and key in times_by_key:
        stamps.append(times_by_key[key])
    stamps = [stamp for stamp in stamps if stamp]
    return min(stamps) if stamps else None


def seen_times(papers):
    out = {}
    for paper in papers:
        key = paper_key(paper)
        stamp = earliest_seen(paper)
        if key and stamp and (key not in out or stamp < out[key]):
            out[key] = stamp
    return out


def missing_reason(paper, reasons=None):
    key = paper_key(paper)
    if reasons and key in reasons:
        return reasons[key]
    ok, reason = usable_source_title(paper)
    if not ok:
        return reason
    if paper.get('titleZh') and not has_han(paper.get('titleZh') or paper.get('title_zh') or ''):
        return 'translation_rejected_no_han'
    return 'translation_missing'


def load_ledger(root):
    path = Path(root) / LEDGER
    if not path.is_file():
        return {'schemaVersion': 2, 'entries': {}}
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {'schemaVersion': 2, 'entries': {}}
    entries = raw.get('entries') if isinstance(raw, dict) else None
    if not isinstance(entries, dict):
        entries = {}
    clean = {}
    for key, row in entries.items():
        if not isinstance(key, str) or not isinstance(row, dict):
            continue
        item = {k: row[k] for k in ('firstMissingAt', 'reason', 'doi', 'title', 'status')
                if k in row and isinstance(row[k], str)}
        if item:
            clean[key] = item
    return {'schemaVersion': 2, 'entries': clean}


def save_ledger(root, ledger):
    path = Path(root) / LEDGER
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {'schemaVersion': 2, 'entries': ledger.get('entries') or {}}
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(path)


def missing_since(paper, ledger, now, times_by_key=None):
    key = paper_key(paper)
    entry = (ledger.get('entries') or {}).get(key) or {}
    return parse_time(entry.get('firstMissingAt')) or earliest_seen(paper, times_by_key) or now


def decision(paper, now, ledger, times_by_key=None, legacy_keys=None):
    if has_qualified_zh_title(paper):
        return 'ready'
    key = paper_key(paper)
    if legacy_keys and key in legacy_keys:
        return 'legacy'
    return 'hold'


def entry_for(paper, now, ledger, times_by_key, status, reasons):
    first = missing_since(paper, ledger, now, times_by_key)
    row = {'firstMissingAt': iso(first), 'status': status, 'reason': missing_reason(paper, reasons)}
    if paper.get('doi'):
        row['doi'] = str(paper['doi'])
    title = (paper.get('title') or '')[:200]
    if title:
        row['title'] = title
    return row


def partition(papers, now, ledger, times_by_key=None, legacy_keys=None, reasons=None):
    """Split papers into visible / held / legacy and return an updated ledger."""
    entries = dict(ledger.get('entries') or {})
    visible, held, legacy = [], [], []
    for paper in papers:
        key = paper_key(paper)
        status = decision(paper, now, {'entries': entries}, times_by_key, legacy_keys)
        if status == 'ready':
            visible.append(paper)
            if key:
                entries.pop(key, None)
            continue
        if key:
            entries[key] = entry_for(paper, now, {'entries': entries}, times_by_key, status, reasons)
        if status == 'hold':
            held.append(paper)
        else:
            legacy.append(paper)
            visible.append(paper)
    return visible, held, legacy, {'schemaVersion': 2, 'entries': entries}


def alert_rows(papers, reasons=None):
    rows = []
    for paper in papers:
        rows.append({
            'key': paper_key(paper),
            'doi': str(paper.get('doi') or ''),
            'id': str(paper.get('id') or ''),
            'reason': missing_reason(paper, reasons),
            'title': (paper.get('title') or '')[:160],
        })
    return rows


def weekly_coverage(items, tasks=('translate', 'study', 'quicklook')):
    fields = {'translate': 'translation', 'study': 'study', 'quicklook': 'quicklook'}
    return {'title': sum(bool(row.get('titleZh')) for row in items),
            **{task: sum(bool(row.get(fields[task])) for row in items) for task in tasks}}
