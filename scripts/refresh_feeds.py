#!/usr/bin/env python3
"""Fetch a bounded public RSS pilot; does not fetch articles, PDFs, or call models."""
import argparse,concurrent.futures,datetime,email.utils,hashlib,json,re,urllib.request,xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit,unquote
from build_data import clean,classify
ROOT=Path(__file__).resolve().parents[1]
PILOT=['BMJ Digital Health & AI current issue','Heart Online First','Nature Medicine','NPJ Digital Medicine','Nature Reviews Cardiology','JAMA Cardiology Online First','EHJ- Digital Health Advance Access','JACC','Circulation','The Lancet Digital Health','EHJ: Advance Access','JAMA Network Open New Online']
def text(el,key):
 for n in el:
  if n.tag.split('}')[-1]==key: return ''.join(n.itertext()).strip()
 return ''
def dateval(raw):
 try: d=email.utils.parsedate_to_datetime(raw)
 except (ValueError,TypeError):
  try:d=datetime.datetime.fromisoformat(raw.replace('Z','+00:00'))
  except (ValueError,TypeError):return ''
 if d.tzinfo is None:d=d.replace(tzinfo=datetime.timezone.utc)
 return d.isoformat()
def extract_doi(link,entry):
 for n in entry:
  if n.tag.split('}')[-1].lower()=='doi':
   value=''.join(n.itertext()).strip().lower()
   return re.sub(r'^https?://(?:dx\.)?doi\.org/','',value)
 u=urlsplit(link);path=unquote(u.path)
 if u.hostname in ('doi.org','dx.doi.org'):return path.lstrip('/').lower()
 if u.hostname in ('nature.com','www.nature.com') and path.startswith('/articles/'):
  slug=path.split('/')[2]
  return '10.1038/'+slug.lower() if re.fullmatch(r'[a-z0-9-]+',slug) else ''
 m=re.search(r'10\.\d{4,9}/[^\s<>"?]+',path)
 value=m.group(0).rstrip('.,') if m else ''
 if u.hostname=='academic.oup.com':value=re.sub(r'/\d+$','',value)
 return value.lower()
def lenient_root(raw):
 """Feeds with a stray '<' or '&' (e.g. 'P<0.05' in a title) fail strict XML. Rebuild items field by field."""
 t=raw.decode('utf-8','ignore');t=re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]','',t)
 root=ET.Element('rss');ch=ET.SubElement(root,'channel')
 for m in re.finditer(r'<(item|entry)[ >].*?</\1>',t,re.S):
  blk=m.group(0);it=ET.SubElement(ch,'item')
  for tag in ('title','link','pubDate','date','published','updated','description','summary'):
   f=re.search(r'<%s(?:\s[^>]*)?>(.*?)</%s>'%(tag,tag),blk,re.S)
   if f:
    v=f.group(1).strip();c=re.match(r'<!\[CDATA\[(.*?)\]\]>$',v,re.S);v=c.group(1) if c else v
    ET.SubElement(it,tag).text=re.sub(r'<[^>]+>',' ',v).replace('&amp;','&').replace('&lt;','<').replace('&gt;','>').replace('&quot;','"').replace('&#39;',"'") if tag in('title','description','summary') else v
  if not it.find('link') is not None:
   a=re.search(r'<link[^>]*href="([^"]+)"',blk)
   if a:ET.SubElement(it,'link').text=a.group(1)
 return root
def parse(raw,source):
 try:root=ET.fromstring(raw)
 except ET.ParseError:root=lenient_root(raw)
 out=[]
 for e in root.iter():
  if e.tag.split('}')[-1] not in ('item','entry'):continue
  title=clean(text(e,'title'));link=text(e,'link')
  if not link:
   for n in e:
    if n.tag.split('}')[-1]=='link' and n.get('rel','alternate')=='alternate':link=n.get('href','');break
  if urlsplit(link).scheme not in ('http','https') or not title:continue
  cat=classify(title,source['name'])
  if cat=='待分类':continue
  desc=clean(text(e,'description') or text(e,'summary'))
  doi=extract_doi(link,e)
  out.append({'id':'rss-'+hashlib.sha256(link.encode()).hexdigest()[:16],'title':title,'url':link,'doi':doi, 'journal':source['name'],'date':dateval(text(e,'pubDate') or text(e,'date') or text(e,'published') or text(e,'updated')),'category':cat,'basis':'RSS 元数据 · 待编辑核验','summary':desc[:12000],'summary_truncated':len(desc)>12000,'sourceId':source['id'],'fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 return out
def fetch(s):
 try:
  req=urllib.request.Request(s['url'],headers={'User-Agent':'XinZhiLearningPilot/0.1 (RSS metadata only)'})
  with urllib.request.urlopen(req,timeout=15) as r:
   raw=r.read(3_000_001)
   if len(raw)>3_000_000:raise ValueError('Feed exceeds 3 MB limit')
  items=parse(raw,s)
  return {'source':s['name'],'url':s['url'],'ok':True,'items':len(items)},items
 except Exception as e:return {'source':s['name'],'url':s['url'],'ok':False,'error':str(e)[:200]},[]
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--all',action='store_true',help='Fetch all academic and explicitly enabled AI sources');args=parser.parse_args()
 data=json.loads((ROOT/'data/library.json').read_text());sources=[f for f in data['feeds'] if (f['enabled'] or f['name']=='OpenAI News') if args.all or f['name'] in PILOT]
 health_path=ROOT/'data/source-health.json'
 if args.all and health_path.exists():
  health=json.loads(health_path.read_text());blocked={h['id'] for h in health['sources'] if h['status'] not in ('ok','parse_or_network_error')}  # 解析错误的源交给宽松解析器
  sources=[f for f in sources if f['id'] not in blocked]
 reports=[];allitems={}
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
  for report,items in pool.map(fetch,sources):
   reports.append(report)
   for p in items:allitems.setdefault(p['doi'].lower() or p['url'],p)
 now=datetime.datetime.now(datetime.timezone.utc);eligible=[];undated=0;future=0;old=0
 for p in allitems.values():
  if not p['date']:undated+=1;continue
  age=(now-datetime.datetime.fromisoformat(p['date'])).total_seconds()/86400
  if age < -1:future+=1;continue
  if age>14:old+=1;continue
  eligible.append(p)
 result={'updatedAt':now.isoformat(),'windowDays':14,'reports':reports,'candidateCount':len(eligible),'excluded':{'undated':undated,'future':future,'olderThan14Days':old},'items':sorted(eligible,key=lambda p:p['date'],reverse=True),'allFetchedCount':len(allitems)}
 (ROOT/'data/feeds.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 (ROOT/'data/feeds.js').write_text('window.FEEDS='+json.dumps(result,ensure_ascii=False).replace('</','<\\/')+';')
 print(json.dumps({k:v for k,v in result.items() if k!='items'},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
