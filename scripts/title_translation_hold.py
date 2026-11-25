#!/usr/bin/env python3
"""Hold new papers out of public lists until a qualified Chinese title exists.

Qualified means the original title already contains Han characters, or titleZh
does (after the existing hygiene / source-number checks, which this module
does not relax). Machine titles are still stored by translate_titles.py.

Fallback: if a paper has been missing a qualified title for HOLD_HOURS, it
is published with the English title and counted as a fallback so the daily
receipt can surface it. Waiting forever would hide literature after a
persistent model or validator rejection. 24 hours covers one full daily
translate run plus the timed fast batches; newer papers still appear the
same day once a timed run writes a usable title.
"""
import datetime
import json
from pathlib import Path

HOLD_HOURS = 24
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
    from resolve_dois import title_cache_key
    return title_cache_key(paper.get('title')) or ''


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


def load_ledger(root):
    path = Path(root) / LEDGER
    if not path.is_file():
        return {'schemaVersion': 1, 'holdHours': HOLD_HOURS, 'entries': {}}
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {'schemaVersion': 1, 'holdHours': HOLD_HOURS, 'entries': {}}
    entries = raw.get('entries') if isinstance(raw, dict) else None
    if not isinstance(entries, dict):
        entries = {}
    clean = {}
    for key, row in entries.items():
        if not isinstance(key, str) or not isinstance(row, dict):
            continue
        if parse_time(row.get('firstMissingAt')):
            clean[key] = {k: row[k] for k in ('firstMissingAt', 'fallbackAt') if k in row and isinstance(row[k], str)}
    return {'schemaVersion': 1, 'holdHours': HOLD_HOURS, 'entries': clean}


def save_ledger(root, ledger):
    path = Path(root) / LEDGER
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {'schemaVersion': 1, 'holdHours': HOLD_HOURS, 'entries': ledger.get('entries') or {}}
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(path)


def missing_since(paper, ledger, now, times_by_key=None, legacy_keys=None):
    key = paper_key(paper)
    entry = (ledger.get('entries') or {}).get(key) or {}
    stamp = parse_time(entry.get('firstMissingAt')) or earliest_seen(paper, times_by_key)
    if stamp:
        return stamp
    if legacy_keys and key in legacy_keys:
        return now - datetime.timedelta(hours=HOLD_HOURS)
    return now


def decision(paper, now, ledger, times_by_key=None, legacy_keys=None):
    if has_qualified_zh_title(paper):
        return 'ready'
    age = now - missing_since(paper, ledger, now, times_by_key, legacy_keys)
    return 'hold' if age < datetime.timedelta(hours=HOLD_HOURS) else 'fallback'


def partition(papers, now, ledger, times_by_key=None, legacy_keys=None):
    """Split papers into visible / held / fallback and return an updated ledger."""
    entries = dict(ledger.get('entries') or {})
    visible, held, fallback = [], [], []
    for paper in papers:
        key = paper_key(paper)
        status = decision(paper, now, {'entries': entries}, times_by_key, legacy_keys)
        if status == 'ready':
            visible.append(paper)
            if key:
                entries.pop(key, None)
            continue
        first = missing_since(paper, {'entries': entries}, now, times_by_key, legacy_keys)
        if key:
            row = {'firstMissingAt': iso(first)}
            if status == 'fallback':
                row['fallbackAt'] = iso(now)
            entries[key] = row
        if status == 'hold':
            held.append(paper)
        else:
            fallback.append(paper)
            visible.append(paper)
    return visible, held, fallback, {'schemaVersion': 1, 'holdHours': HOLD_HOURS, 'entries': entries}


def weekly_coverage(items, tasks=('translate', 'study', 'quicklook')):
    fields = {'translate': 'translation', 'study': 'study', 'quicklook': 'quicklook'}
    return {'title': sum(bool(row.get('titleZh')) for row in items),
            **{task: sum(bool(row.get(fields[task])) for row in items) for task in tasks}}
