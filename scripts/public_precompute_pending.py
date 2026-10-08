"""Read-only finite public-abstract backlog; never generates or changes caches/ledger."""
import argparse
import json
from pathlib import Path

import week_precompute as w

FIELDS = {'translate':'translation', 'quicklook':'quicklook'}


def aliases(row):
    result = set()
    identity = str(row.get('paperID') or '')
    if identity.startswith(('doi:', 'pmid:')):
        result.add(identity.lower())
    doi = str(row.get('doi') or '').strip().lower()
    pmid = str(row.get('pmid') or '').strip()
    if doi:
        result.add('doi:'+doi)
    if pmid.isdigit():
        result.add('pmid:'+pmid)
    return result


def pending_manifest(board, caches=(), prior_sources=()):
    items = board.get('items', [])
    if len({p['paperID'] for p in items}) != len(items):
        raise ValueError('duplicate_current_identity')
    entries = [e for cache in caches for e in cache.get('entries', {}).values()]
    previous = [p for snapshot in prior_sources for p in snapshot.get('items', [])]
    pending = []
    coverage = {'title':0, 'translate':0, 'quicklook':0}
    for p in items:
        if (w.identity(p) != p['paperID'] or not p.get('abstract')
                or w.text_hash(p['title'], p['abstract']) != p['sourceHash']):
            raise ValueError('invalid_current_public_source')
        missing = []
        values = {}
        for task, field in FIELDS.items():
            value = p.get(field)
            if value:
                try:
                    value = w.validate(task, value, p)
                except ValueError:
                    value = None
            if not value:
                for cache in caches:
                    eligible = {key:e for key,e in cache.get('entries', {}).items()
                                if (not e.get('doi') or str(e['doi']).lower()==p.get('doi','').lower())
                                and (not e.get('pmid') or str(e['pmid'])==str(p.get('pmid','')))}
                    value = w.find({'entries':eligible}, p, task)[0]
                    if value:
                        break
            if value:
                values[task] = value
                coverage[task] += 1
            else:
                missing.append(task)
        title = p.get('titleZh') or next((v['title_zh'] for v in values.values()), '')
        try:
            valid_title = bool(title and w.validate('title', {'title_zh':title}, p))
        except ValueError:
            valid_title = False
        coverage['title'] += int(valid_title)
        if not valid_title:
            missing.insert(0, 'title')
        if not missing:
            continue
        current_aliases = aliases(p)
        related_sources = [old for old in previous if aliases(old) & current_aliases]
        related_entries = [e for e in entries if aliases(e) & current_aliases]
        same_source = [e for e in related_entries if e.get('sourceHash') == p['sourceHash']]
        if any(e.get('paperID') != p['paperID'] for e in same_source):
            reason = 'identity_mapping_review_required'
        elif (related_sources or related_entries) and not any(
                old.get('sourceHash') == p['sourceHash'] for old in related_sources+related_entries):
            reason = 'source_hash_changed'
        elif related_sources or related_entries:
            reason = 'existing_identity_missing_or_invalid_tasks'
        else:
            reason = 'new_identity'
        task_versions = {t:w.version(t, 'sol-session-public-abstract') for t in missing if t!='title'}
        if 'title' in missing:
            task_versions['title'] = 'public-title-only-source-hash-v1'
        pending.append({k:p.get(k) for k in ('paperID','doi','pmid','title','abstract','date',
                                            'sourceHash','abstractSource','abstractSourceUrl')}
                       | {'missingTasks':missing, 'reason':reason,
                          'requiredTaskVersions':task_versions,
                          'queueKey':w.digest({'paperID':p['paperID'],'sourceHash':p['sourceHash'],
                                               'tasks':task_versions}),
                          'allowAutomaticGeneration':False})
    return {'schemaVersion':1, 'scope':'public-abstract', 'window':board['window'],
            'selected':len(items), 'coverage':coverage, 'pendingPapers':len(pending),
            'contentComplete':not pending, 'items':pending,
            'studyMissing':sum(not p.get('study') for p in items),
            'externalModelApiRequests':0, 'runtimeCacheWrites':0, 'ledgerWrites':0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--board', type=Path, required=True)
    parser.add_argument('--cache', type=Path, action='append', default=[])
    parser.add_argument('--prior-sources', type=Path, action='append', default=[])
    args = parser.parse_args()
    read = lambda p:json.loads(p.read_text())
    print(json.dumps(pending_manifest(read(args.board), [read(p) for p in args.cache],
                                     [read(p) for p in args.prior_sources]), ensure_ascii=False))


if __name__ == '__main__':
    main()
