#!/usr/bin/env python3
"""Bounded identity-checked Europe PMC hydration for the selected public week.

Serial, no retries. First-publication dates replace ambiguous RSS/issue dates; originals
are retained in the private source receipt. Only public titles/abstracts are carried into
the week pipeline. Does not fetch publisher/PDF/private-library material.
"""
import argparse,json,urllib.parse
from pathlib import Path
import week_precompute as w


def fetch(p,transport=w.request):
 doi=p.get('doi');pmid=str(p.get('pmid') or '')
 query='DOI:"'+doi+'"' if doi else 'EXT_ID:'+pmid+' AND SRC:MED'
 result=transport('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=1&query='+urllib.parse.quote(query))
 rows=result.get('resultList',{}).get('result')
 if not isinstance(rows,list):raise w.Halt('source_response_invalid')
 if not rows:return None
 source=rows[0]
 if (doi and str(source.get('doi','')).lower()!=doi.lower()) or (pmid and str(source.get('pmid',''))!=pmid):raise w.Halt('source_identity_mismatch')
 if w.title_key(source)!=w.title_key(p):raise w.Halt('source_title_mismatch')
 abstract=w.clean(source.get('abstractText'));date=source.get('firstPublicationDate')
 if not isinstance(date,str) or not w.re.fullmatch(r'\d{4}-\d{2}-\d{2}',date):return None
 w.dt.date.fromisoformat(date)
 if not 200<=len(abstract)<=6000 or abstract.endswith(('…','...')):return None
 return {**{k:p[k] for k in w.PUBLIC_FIELDS if k in p},'title':source['title'],'date':date,'datePrecision':'day','dateBasis':'Europe PMC firstPublicationDate','summary':abstract,'summary_truncated':False,'abstractSections':[],'publicAbstractVerified':True,'publicationVerified':True,'abstractSource':'Europe PMC','abstractSourceUrl':'https://europepmc.org/article/MED/'+str(source['pmid']) if source.get('pmid') else 'https://doi.org/'+doi,'pmid':str(source.get('pmid') or pmid)}


def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--input',type=Path,default=w.ROOT/'data/candidates.json');ap.add_argument('--output',type=Path,default=w.ROOT/'data/week-source-candidates.json');ap.add_argument('--limit',type=int,default=24);ap.add_argument('--previous-lookups',type=int,default=0)
 a=ap.parse_args()
 if not 0<=a.previous_lookups<=40 or not 0<=a.limit<=40-a.previous_lookups:ap.error('total source requests must stay within existing maximum 40')
 data=w.read(a.input,{'items':[]});rows=data['items'];selected,_=w.select(rows,w.now());receipt={'startedAt':w.stamp(),'sourceRequests':0,'priorRequests':a.previous_lookups,'maximumTotalRequests':40,'verified':[],'unavailable':[],'blocker':None};path=w.ROOT/'.local/week-source-receipt.json'
 try:
  for p in selected[:a.limit]:
   receipt['sourceRequests']+=1;w.atomic(path,receipt)
   value=fetch(p)
   if value:
    # Preserve stable source item id for FEEDS/UI, use DOI/PMID for content cache identity.
    for i,row in enumerate(rows):
     if row.get('id')==p['id']:rows[i]=value;break
    receipt['verified'].append({'paperID':p['paperID'],'publicationDate':value['date'],'priorPublicationDate':p['date'],'sourceHash':w.text_hash(value['title'],value['summary'])})
   else:receipt['unavailable'].append(p['paperID'])
   w.atomic(a.output,{**data,'items':rows});w.atomic(path,receipt)
 except (w.Halt,ValueError) as exc:
  receipt['blocker']=str(exc) if w.re.fullmatch(r'[a-z_0-9:]{1,120}',str(exc)) else 'source_processing_failed';w.atomic(path,receipt);print(json.dumps(receipt));return 1
 print(json.dumps({'sourceRequests':receipt['sourceRequests'],'verified':len(receipt['verified']),'unavailable':len(receipt['unavailable']),'blocker':receipt['blocker']}));return 0

if __name__=='__main__':raise SystemExit(main())
