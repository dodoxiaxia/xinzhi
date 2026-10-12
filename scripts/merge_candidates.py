#!/usr/bin/env python3
"""Merge public RSS and PubMed metadata by DOI, URL, then normalized title."""
import datetime,json,re,unicodedata,xml.etree.ElementTree as ET
from pathlib import Path
from publication_dates import canonical_publication_date
import resolve_dois
ROOT=Path(__file__).resolve().parents[1]
# Same title identity as resolve_dois: RSS titles such as "[Articles] X" must match PubMed's "X".
def titlekey(t):return resolve_dois.title_key(t)
def main():
 feed=json.loads((ROOT/'data/feeds.json').read_text());pub=json.loads((ROOT/'data/pubmed.json').read_text())
 now=datetime.datetime.now(datetime.timezone.utc);seen=set();items=[];excluded=0
 # Feeds without DOIs (Lancet, JACC, BMJ…) get one from Crossref, so titles translate and duplicates merge.
 doi_stats=resolve_dois.fill(feed['items'],ROOT)
 # Prefer PubMed's DOI and structured abstract when the same paper also appears in RSS.
 for source_record in pub['items']+feed['items']:
  p=canonical_publication_date(source_record)
  try:age=(now.date()-datetime.date.fromisoformat(p['date'][:10])).days
  except ValueError:excluded+=1;continue
  if not 0<=age<=14:excluded+=1;continue
  keys={p.get('doi','').lower(),p['url'],titlekey(p['title'])}-{''}
  if keys & seen:continue
  seen.update(keys)
  if p.get('journal') in ('OpenAI News','Nature Machine Intelligence') and not re.search(r'clinical|medical|health|patient|cardiac|cardiovasc',p['title'],re.I):p['category']='AI前沿'
  if p['category']=='待分类':p['category']='综合医学'
  items.append(p)
 feed.update(items=sorted(items,key=lambda p:p['date'],reverse=True),candidateCount=len(items),pubmedFallback={'fetched':pub['fetched'],'totalHits':pub['totalHits'],'truncated':pub['truncated'],'journals':pub['journals'],'excludedOutsideWindowOrImpreciseDate':excluded})
 for name,prefix in [('candidates.json',''),('candidates.js','window.FEEDS=')]:
  (ROOT/'data'/name).write_text(prefix+json.dumps(feed,ensure_ascii=False).replace('</','<\\/')+(';' if prefix else ''))
 health=json.loads((ROOT/'data/source-health.json').read_text())
 opml=ET.Element('opml',version='2.0');ET.SubElement(ET.SubElement(opml,'head'),'title').text='心知已验证 RSS'
 body=ET.SubElement(opml,'body')
 for s in health['sources']:
  if s['status']=='ok':ET.SubElement(body,'outline',text=s['name'],title=s['name'],type='rss',xmlUrl=s['url'])
 ET.indent(opml);ET.ElementTree(opml).write(ROOT/'data/xinzhi-verified.opml',encoding='utf-8',xml_declaration=True)
 print('Merged candidates:',len(items),'PubMed fetched:',pub['fetched'],'RSS export:',len(body),'DOI lookup:',json.dumps(doi_stats))
 import subprocess, sys
 subprocess.run([sys.executable, str(ROOT/'scripts/enrich_metadata.py')], check=True)
if __name__=='__main__':main()
