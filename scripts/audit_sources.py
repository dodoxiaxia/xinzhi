#!/usr/bin/env python3
"""One bounded health audit per scholarly feed. Stop a host on 401/403/429."""
import concurrent.futures,datetime,json,urllib.request,urllib.error,xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit
from collections import defaultdict,Counter
ROOT=Path(__file__).resolve().parents[1]
def audit_host(sources):
 rows=[];blocked=None
 for s in sources:
  row={'id':s['id'],'name':s['name'],'url':s['url'],'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
  if blocked:
   rows.append({**row,'status':'not_checked_host_blocked','reason':blocked});continue
  try:
   req=urllib.request.Request(s['url'],headers={'User-Agent':'XinZhiLearningPilot/0.1 (RSS metadata health check)'})
   with urllib.request.urlopen(req,timeout=12) as r:raw=r.read(3_000_001)
   if len(raw)>3_000_000:raise ValueError('Feed exceeds bounded read size')
   tree=ET.fromstring(raw);kind=tree.tag.split('}')[-1].lower()
   if kind not in ('rss','feed','rdf'):raise ValueError('Response is not RSS/Atom/RDF')
   items=[n for n in tree.iter() if n.tag.split('}')[-1] in ('item','entry')]
   links=0;abstracts=0
   for item in items:
    for n in item:
     local=n.tag.split('}')[-1]
     if local=='link' and (n.get('href') or n.text):links+=1;break
    if any(n.tag.split('}')[-1] in ('description','summary','abstract') and ''.join(n.itertext()).strip() for n in item):abstracts+=1
   rows.append({**row,'status':'ok' if items else 'empty_feed','items':len(items),'itemsWithLinks':links,'itemsWithAbstracts':abstracts})
  except urllib.error.HTTPError as e:
   rows.append({**row,'status':'http_error','code':e.code,'reason':'HTTP '+str(e.code)})
   if e.code in (401,403,429):blocked='same host returned '+str(e.code)+'; remaining URLs not requested'
  except Exception as e:rows.append({**row,'status':'parse_or_network_error','reason':str(e)[:160]})
 return rows
sources=json.loads((ROOT/'data/library.json').read_text())['feeds']
chosen=[s for s in sources if s['enabled'] or s['name']=='OpenAI News']
groups=defaultdict(list)
for s in chosen:groups[urlsplit(s['url']).hostname].append(s)
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for rows in pool.map(audit_host,groups.values()):results.extend(rows)
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'summary':dict(Counter(r['status'] for r in results)),'sources':results,'note':'Empty summary differs from missing article link or a broken feed. Restricted hosts are not bypassed.'}
(ROOT/'data/source-health.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
(ROOT/'data/source-health.js').write_text('window.SOURCE_HEALTH='+json.dumps(report,ensure_ascii=False).replace('</','<\\/')+';')
print(json.dumps({'sources':len(results),'summary':report['summary']},ensure_ascii=False))
