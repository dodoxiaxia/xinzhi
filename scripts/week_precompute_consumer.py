"""Finite CI planning from the current public board, after validated cache/overlay reuse.

No provider, checkpoint or file writes here. Core gaps precede study-only gaps;
the existing configured runner owns reservations, evidence validation and failures.
"""
import week_precompute as w
from public_precompute_pending import aliases, pending_manifest


def plan(selected, board, cache, prior_sources=(), paper_limit=3):
    if type(paper_limit) is not int or not 1 <= paper_limit <= 3:
        raise ValueError('consumer_paper_limit_must_be_1_to_3')
    prior_sources = tuple(prior_sources)
    pending = pending_manifest(board, [cache], prior_sources)
    current = {p['paperID']: p for p in selected}
    rows = {p['paperID']: p for p in board['items']}
    if len(current) != len(selected) or set(current) != set(rows):
        raise ValueError('consumer_selection_mismatch')
    for identity, row in rows.items():
        p = current[identity]
        if (p['sourceHash'] != row['sourceHash'] or p['title'] != row['title']
                or p['abstract'] != row['abstract'] or aliases(p) != aliases(row)):
            raise ValueError('consumer_selection_mismatch')
    gaps = {p['paperID']: p for p in pending['items']}
    ordered = [p['paperID'] for p in pending['items']]
    ordered += [p['paperID'] for p in board['items'] if p['paperID'] not in gaps]
    targets, tasks, blocked, reasons = [], {}, [], {}
    entries = list(cache.get('entries', {}).values())
    entries += [old for snapshot in prior_sources for old in snapshot.get('items', [])]
    for identity in ordered:
        row, p = rows[identity], current[identity]
        gap = gaps.get(identity)
        reason = gap['reason'] if gap else 'study_only'
        # Source snapshots retain PMID/DOI aliases omitted by the real cache
        # store. Check both, including when only study remains after reuse.
        conflict = any(e.get('sourceHash') == p['sourceHash']
                       and e.get('paperID') != identity and aliases(e) & aliases(p)
                       for e in entries)
        if reason == 'identity_mapping_review_required' or conflict:
            blocked.append({'paperID': identity, 'reason': 'identity_mapping_review_required'})
            continue
        missing = [t for t in w.TASKS if t in row.get('missingTasks', [])]
        if gap and 'title' in gap['missingTasks'] and 'translate' not in missing:
            missing.insert(0, 'translate')
        if not missing or len(targets) >= paper_limit:
            continue
        targets.append(p)
        tasks[identity] = missing
        reasons[identity] = reason
    return targets, tasks, {
        'maxPapers': paper_limit, 'selectedPaperIDs': [p['paperID'] for p in targets],
        'tasksByPaper': tasks, 'reasons': reasons, 'blocked': blocked,
        'corePendingPapers': pending['pendingPapers'], 'studyMissing': pending['studyMissing'],
        'maxModelAttempts': len(targets), 'dailyAttemptCeiling': w.MAX_ATTEMPTS,
        'dailyOutputTokenCeiling': w.MAX_DAILY_OUTPUT_TOKENS,
        'perRequestOutputTokenCeiling': 5800,
    }
