"""Read-only acceptance for a finite reviewed public gap; no generation/cache writes."""
import argparse
import copy
import json
from pathlib import Path

import week_precompute as w
from build_public import public_weekly_board
from preview_sol_public_overlay import preview_supplement
from public_editorial_overlay import apply_board, matches
from public_precompute_pending import pending_manifest


def verify(board, sources, cache):
    before = public_weekly_board(copy.deepcopy(board))
    supplement = preview_supplement(sources, cache)
    byid = {p['paperID']: p for p in before['items']}
    pending_before = pending_manifest(before)
    queued = {p['paperID']: p for p in pending_before['items']}
    affected = {p['paperID'] for p in supplement['items']}
    for p in supplement['items']:
        current = byid.get(p['paperID'])
        if not current or not matches(current, p):
            raise ValueError('gap_source_no_longer_current')
        item = queued.get(p['paperID'])
        if not item:
            raise ValueError('gap_is_not_pending')
        for task, field in (('translate', 'translation'), ('quicklook', 'quicklook')):
            if p.get(field) and task not in item['missingTasks']:
                raise ValueError('gap_would_replace_completed_task')
            if not p.get(field) and task in item['missingTasks']:
                raise ValueError('gap_result_missing')
    after = public_weekly_board(apply_board(before, supplement))
    pending_after = pending_manifest(after)
    preserved = []
    for p in after['items']:
        old = byid[p['paperID']]
        if p['paperID'] not in affected:
            if p != old:
                raise ValueError('unrelated_paper_changed')
            preserved.append({'paperID':p['paperID'], 'sourceHash':p['sourceHash'],
                              'unchangedRowSHA256':w.digest(p)})
    if (before['window'] != after['window'] or
            [(p['paperID'],p['sourceHash'],p['rank'],p['date']) for p in before['items']] !=
            [(p['paperID'],p['sourceHash'],p['rank'],p['date']) for p in after['items']]):
        raise ValueError('gap_changed_selection_or_source')
    return {'schemaVersion':1, 'scope':'public-abstract', 'selected':len(after['items']),
            'window':after['window'], 'coverageBefore':before['coverage'],
            'coverageAfter':after['coverage'], 'pendingBefore':pending_before['pendingPapers'],
            'pendingAfter':pending_after['pendingPapers'], 'contentComplete':pending_after['contentComplete'],
            'studyMissing':pending_after['studyMissing'], 'newPapers':len(affected),
            'newEntries':len(cache['entries']), 'existingPapersReused':len(preserved),
            'unchangedPapers':preserved, 'selectionSourceWindowUnchanged':True,
            'externalModelApiRequests':0, 'runtimeCacheWrites':0, 'ledgerWrites':0,
            'verification':'offline public projection only; not a live model/API check'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('board', 'sources', 'overlay'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    read = lambda p:json.loads(p.read_text())
    print(json.dumps(verify(read(args.board), read(args.sources), read(args.overlay)), ensure_ascii=False))


if __name__ == '__main__':
    main()
