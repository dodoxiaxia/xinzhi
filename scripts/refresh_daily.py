#!/usr/bin/env python3
"""Refresh candidates and local editorial queue. Publishing is a separate reviewed step."""
import datetime,json,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
steps=[['scripts/refresh_feeds.py','--all'],['scripts/fetch_pubmed.py'],['scripts/merge_candidates.py'],['service/import_data.py','--file',str(ROOT/'data/candidates.json')]]
optional=[['scripts/fetch_archive.py','--incremental'],['scripts/archive_details.py','--fill'],['scripts/translate_titles.py','--run','--limit','20']]  # 365-day radar titles; a failure here must not block the daily refresh
report={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'steps':[],'publicSiteChanged':False}
for step in steps:
 result=subprocess.run([sys.executable,*step],cwd=ROOT,capture_output=True,text=True)
 report['steps'].append({'script':step[0],'exitCode':result.returncode,'output':result.stdout[-1200:],'error':result.stderr[-1200:]})
 if result.returncode:break
for step in optional:
 result=subprocess.run([sys.executable,*step],cwd=ROOT,capture_output=True,text=True)
 report['steps'].append({'script':step[0],'exitCode':result.returncode,'optional':True,'output':result.stdout[-600:],'error':result.stderr[-600:]})
required=[x for x in report['steps'] if not x.get('optional')]
report['ok']=len(required)==len(steps) and all(x['exitCode']==0 for x in required)
report['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
(ROOT/'docs/last-refresh.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'ok':report['ok'],'publicSiteChanged':False,'report':'docs/last-refresh.json'},ensure_ascii=False))
sys.exit(0 if report['ok'] else 1)
