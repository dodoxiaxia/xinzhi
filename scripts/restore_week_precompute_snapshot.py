#!/usr/bin/env python3
"""Offline handoff import of the finite public source/cache snapshot. Dry-run by default.

Preserves current candidates and caches; only merges matching existing public paper IDs.
Restores the real failed-batch pause so integration cannot silently retry paid work.
"""
import argparse,copy
import week_precompute as w


def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--apply',action='store_true');a=ap.parse_args()
 source=w.read(w.ROOT/'editorial/week_precompute_sources_20261007.json',{})
 receipt=w.read(w.ROOT/'editorial/week_precompute_receipt_20261007.json',{})
 if source.get('schemaVersion')!=1 or not source.get('publicOnly'):raise ValueError('invalid_public_snapshot')
 candidates=w.read(w.ROOT/'data/candidates.json',{'items':[]});byid={p['id']:p for p in candidates['items']}
 matched=0
 for p in source['items']:
  old=byid.get(p['id'])
  if not old:continue
  if not (w.aliases(old)&w.aliases(p)):raise ValueError('snapshot_identity_mismatch')
  old.update({k:p[k] for k in w.PUBLIC_FIELDS if k in p});matched+=1
 cache=w.read(w.ROOT/'data/week-precompute-cache.json',{'schemaVersion':1,'entries':{}})
 imported=w.read(w.ROOT/'editorial/week_precompute_cache_20261007.json',{'entries':{}})
 cache['entries'].update(imported['entries'])
 ledger=w.read(w.ROOT/'data/week-precompute-ledger.json',{'schemaVersion':1,'days':{}})
 # Never import a fabricated success or erase existing attempt reservations.
 ledger['paused']=receipt['blocker']
 day='2026-10-07';daily=ledger['days'].setdefault(day,{'reservedAttempts':0,'requests':[]})
 daily['reservedAttempts']=max(daily.get('reservedAttempts',0),receipt['actualVerification']['reservedProviderAttempts'])
 daily['paused']=receipt['blocker']
 if a.apply:
  w.atomic(w.ROOT/'data/candidates.json',candidates);w.atomic(w.ROOT/'data/week-precompute-cache.json',cache);w.atomic(w.ROOT/'data/week-precompute-ledger.json',ledger)
 print(w.json.dumps({'applied':a.apply,'matchedSourcePapers':matched,'snapshotPapers':len(source['items']),'cachedTasks':len(imported['entries']),'paidWorkPaused':True,'modelCalls':0}));return 0

if __name__=='__main__':raise SystemExit(main())
