#!/usr/bin/env python3
"""Read-only library import. Never copy PDFs or change the source index."""
import argparse,csv,datetime,hashlib,json,re,xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit
ROOT=Path(__file__).resolve().parents[1]
class _PlainText(HTMLParser):
 """Strip actual markup without consuming clinical comparisons such as <4 and >315."""
 _blocks={'p','div','br','hr','li','ul','ol','section','sec','abstract','title',
          'h1','h2','h3','h4','h5','h6','table','tr','td','th'}
 def __init__(self):
  super().__init__(convert_charrefs=True)
  self.parts=[]
 def handle_data(self,text): self.parts.append(text)
 def _boundary(self,tag):
  if tag.rsplit(':',1)[-1] in self._blocks: self.parts.append(' ')
 def handle_starttag(self,tag,attrs): self._boundary(tag)
 def handle_endtag(self,tag): self._boundary(tag)

def clean(s):
 # Parse markup before decoding entities. Decoded < or > must remain text,
 # rather than being reparsed as tags; inline superscript digits stay adjacent.
 parser=_PlainText()
 parser.feed(s or '')
 parser.close()
 return re.sub(r'\s+',' ',''.join(parser.parts)).strip()
def classify(t,j=''):
 title=t.lower();journal=j.lower();s=title+' '+journal
 ai=bool(re.search(r'artificial intelligence|machine learning|deep learning|language model|\bllm\b|neural network|transformer|ai-enabled|ai-assisted|ai-based|machine intelligence|openai',s))
 medical=bool(re.search(r'clinical|medical|medicine|health|patient|diagnos|therap|hospital|surgery|drug',s))
 digital_health=bool(re.search(r'digital (medicine|health)|medical informatics|jamia',journal))
 cv=bool(re.search(r'\b(?:cardiac|cardiovascular|cardiology|cardiomyopathy|coronary|atrial|ventricular|electrocardiogram|hypertension|stroke)\b|heart failure|heart transplant',title) or re.search(r'cardiol|cardiovasc|heart|circulation|jacc|europace|stroke|hypertension|\bjce\b|\bijc\b|\bjaha\b',journal))
 if cv:return '交叉研究' if ai else '心血管'
 if digital_health or (ai and medical):return 'AI医疗'
 if ai:return 'AI前沿'
 if re.search(r'nejm|n engl j med|jama|\bbmj\b|lancet|nature medicine|clinicalmedicine|communications medicine|medical|medicine|diabetology',journal):return '综合医学'
 return '待分类'

def build(library,opml):
 rows=list(csv.DictReader((library/'文献索引/文献索引.csv').open(encoding='utf-8-sig')))
 papers={}; missing=[]
 for r in rows:
  title=clean(r['题名']); doi=r['DOI'].strip().lower().removeprefix('https://doi.org/')
  if not title: title=clean(r['文件名'])
  key=doi or r.get('SHA256') or title.lower()
  exists=(library/r['当前路径']).is_file()
  if not exists: missing.append({'title':title,'path':r['当前路径'],'doi':doi})
  if key in papers:
   papers[key]['copies']+=1; papers[key]['localAvailable']|=exists; continue
  papers[key]={'id':hashlib.sha256(key.encode()).hexdigest()[:16],'title':title,'doi':doi,'url':'https://doi.org/'+doi if doi else '', 'journal':clean(r['期刊']),'date':r['实际出版日期'],'dateBasis':r.get('日期来源',''), 'dateConfidence':r.get('日期置信度',''),'category':classify(title,r['期刊']),'metadataVerifiedInIndex':r['元数据已核验']=='是','basis':'仅索引元数据 · 未读全文','localAvailable':exists,'copies':1}
 feeds=[]; seen=set()
 for n in ET.parse(opml).iter('outline'):
  url=n.get('xmlUrl')
  if not url: continue
  parts=urlsplit(url)
  if parts.hostname in ('www.nature.com','nature.com'): url=urlunsplit((parts.scheme,parts.netloc,parts.path,'',''))
  if url in seen: continue
  seen.add(url)
  name=clean(n.get('text') or n.get('title'));host=urlsplit(url).hostname or ''
  official=any(host==d or host.endswith('.'+d) for d in ['bmj.com','nature.com','jamanetwork.com','academic.oup.com','ahajournals.org','sciencedirect.com','nejm.org','thelancet.com','wiley.com','biomedcentral.com','pubmed.ncbi.nlm.nih.gov','internationaljournalofcardiology.com','pnas.org','science.org'])
  feeds.append({'id':hashlib.sha256(url.encode()).hexdigest()[:12],'name':name,'url':url,'originalUrl':n.get('xmlUrl'),'category':classify(name),'sourceType':'出版商/学术平台' if official else '聚合或其他来源','enabled':official})
 data={'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stats':{'indexRows':len(rows),'papers':len(papers),'journalLabels':len(set(r['期刊'] for r in rows)),'missingPaths':len(missing),'feedCount':len(feeds),'enabledFeeds':sum(f['enabled'] for f in feeds)},'papers':sorted(papers.values(),key=lambda p:p['date'],reverse=True),'feeds':feeds}
 (ROOT/'data/library.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
 (ROOT/'data/quality.json').write_text(json.dumps({'missingPaths':missing,'note':'仅核对路径存在性；未逐份检查 PDF 或重新核验 DOI。去重优先 DOI，其次索引 SHA256。'},ensure_ascii=False,indent=2))
 # browser data contains metadata only; no original file paths or PDF contents
 (ROOT/'data/library.js').write_text('window.LIBRARY='+json.dumps(data,ensure_ascii=False).replace('</','<\\/')+';')
 print(json.dumps(data['stats'],ensure_ascii=False))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--library',type=Path,required=True);p.add_argument('--opml',type=Path,required=True);a=p.parse_args();build(a.library,a.opml)
