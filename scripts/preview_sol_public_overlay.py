#!/usr/bin/env python3
"""Validate a finite public editorial overlay and preview the existing board schema.

Offline only. Never reads model configuration, dispatches generation, or writes
runtime cache/ledger. An optional output must stay in editorial/ or .local/.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

import week_precompute as w

ORIGIN = 'sol-session-public-abstract'
MODEL = 'sol-session-model-unobserved'


def preview(sources, overlay, runtime_cache=None):
    if sources.get('schemaVersion') != 1 or sources.get('publicOnly') is not True:
        raise ValueError('public_source_snapshot_required')
    selected = copy.deepcopy(sources.get('items', []))
    if len(selected) != 24 or len({p['paperID'] for p in selected}) != 24:
        raise ValueError('fixed_24_identity_snapshot_required')
    byid = {p['paperID']: p for p in selected}
    for p in selected:
        if w.identity(p) != p['paperID'] or w.text_hash(p['title'], p['abstract']) != p['sourceHash']:
            raise ValueError('source_identity_or_hash_mismatch')
        p['weeklyCategory'] = p.get('weeklyCategory') or p.get('category')
        if p['weeklyCategory'] not in w.CATEGORIES:
            raise ValueError('source_category_mismatch')
    if overlay.get('schemaVersion') != 1 or not isinstance(overlay.get('entries'), dict):
        raise ValueError('existing_cache_schema_required')
    tasks = set()
    accepted = {}
    for key, entry in overlay['entries'].items():
        p = byid.get(entry.get('paperID'))
        if not p or entry.get('sourceHash') != p['sourceHash']:
            raise ValueError('overlay_source_not_current')
        if entry.get('doi') != p['doi'] or str(entry.get('pmid')) != str(p['pmid']):
            raise ValueError('overlay_doi_pmid_mismatch')
        task = entry.get('task')
        if task not in ('translate', 'quicklook'):
            raise ValueError('overlay_task_out_of_scope')
        if (entry.get('origin') != ORIGIN or entry.get('modelVersion') != MODEL
                or entry.get('scope') != 'public-abstract'
                or entry.get('generationVersionKnown') is not False
                or entry.get('generationPromptVersion') != 'unobserved'
                or entry.get('reviewStatus') != 'machine-validated-unreviewed'
                or entry.get('providerUsage') is not None):
            raise ValueError('editorial_provenance_not_honest')
        if key != w.cache_key(p, task, MODEL, ORIGIN):
            raise ValueError('overlay_cache_key_mismatch')
        identity = (p['paperID'], task)
        if identity in tasks:
            raise ValueError('duplicate_overlay_task')
        tasks.add(identity)
        if not w.find({'entries': {key: entry}}, p, task)[0]:
            raise ValueError('overlay_existing_validation_failed')
        accepted[key] = copy.deepcopy(entry)
    # Explicit overlay priority in memory; original files are never changed.
    entries = dict(accepted)
    for key, entry in (runtime_cache or {}).get('entries', {}).items():
        entries.setdefault(key, copy.deepcopy(entry))
    report = {'mode': 'offline-editorial-overlay', 'paidRequests': 0,
              'reservedModelAttempts': 0, 'automaticGeneration': False,
              'editorialEntriesValidated': len(accepted),
              'providerUsageKnown': False,
              'origin': ORIGIN, 'modelVersion': MODEL}
    title_cache = {p['paperID']: p['titleZh'] for p in selected if p.get('titleZh')}
    result = w.board(selected, sources['window'], {'entries': entries}, report,
                     title_cache=title_cache)
    assert all(p['allowAutomaticGeneration'] is False for p in result['items'])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', required=True, type=Path)
    parser.add_argument('--overlay', required=True, type=Path)
    parser.add_argument('--runtime-cache', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    read = lambda p: json.loads(p.read_text())
    result = preview(read(args.sources), read(args.overlay),
                     read(args.runtime_cache) if args.runtime_cache else None)
    if args.output:
        target = args.output.resolve()
        allowed = [(w.ROOT / name).resolve() for name in ('editorial', '.local')]
        if not any(target.is_relative_to(root) for root in allowed):
            raise ValueError('preview_output_must_stay_in_editorial_or_local')
        w.atomic(target, result)
    print(json.dumps({'coverage': result['coverage'], 'run': result['run'],
                      'selected': len(result['items']), 'outputWritten': bool(args.output)},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
