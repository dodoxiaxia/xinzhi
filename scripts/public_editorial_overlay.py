"""Source-bound public editorial output, separate from the runtime model cache.

Never calls a provider or changes model configuration, ledger or cache files.
Current selections and source text remain authoritative as the week rolls over.
"""
import copy
import json
from pathlib import Path

import week_precompute as w
from preview_sol_public_overlay import preview

DIRECTORY = 'editorial/sol-public-abstract-20261007'


def load_board(root):
    base = Path(root) / DIRECTORY
    paths = [base / 'sources.json', base / 'corrected-cache.json']
    if not any(p.exists() for p in paths):
        return None
    if not all(p.is_file() and not p.is_symlink() for p in paths):
        raise ValueError('incomplete_public_editorial_overlay')
    return preview(*(json.loads(p.read_text()) for p in paths))


def matches(current, editorial):
    return (w.identity(current) == editorial['paperID']
            and str(current.get('doi') or '').lower() == editorial['doi']
            and str(current.get('pmid') or '') == editorial['pmid']
            and w.text_hash(current['title'], current['abstract']) == editorial['sourceHash'])


def apply_board(current, editorial):
    if not current or not editorial:
        return current
    result = copy.deepcopy(current)
    byid = {p['paperID']: p for p in editorial['items']}
    for row in result['items']:
        saved = byid.get(row['paperID'])
        if not saved or not matches(row, saved):
            continue
        for task, field in [('translate', 'translation'), ('quicklook', 'quicklook')]:
            if saved.get(field):
                row[field] = copy.deepcopy(saved[field])
                row.setdefault('generationMeta', {})[task] = copy.deepcopy(saved['generationMeta'][task])
        row['titleZh'] = saved['titleZh'] or row.get('titleZh', '')
        row['missingTasks'] = [t for t, f in [('translate', 'translation'), ('study', 'study'), ('quicklook', 'quicklook')] if not row.get(f)]
        row['precomputeStatus'] = 'ready' if not row['missingTasks'] else 'partial'
    result['coverage'] = {'title': sum(bool(p.get('titleZh')) for p in result['items']),
                          **{t: sum(bool(p.get(f)) for p in result['items']) for t, f in [('translate', 'translation'), ('study', 'study'), ('quicklook', 'quicklook')]}}
    return result


def current_catalog(rows, editorial):
    """Include off-week output only while its current public source still matches."""
    if not editorial:
        return None
    byid = {p['paperID']: p for p in editorial['items']}
    accepted = {}
    for raw in rows:
        saved = byid.get(w.identity(raw))
        if not saved:
            continue
        abstract = w.public_abstract(raw)
        if abstract and matches({**raw, **abstract}, saved):
            accepted[saved['paperID']] = copy.deepcopy(saved)
    result = copy.deepcopy(editorial)
    result['items'] = list(accepted.values())
    return result
