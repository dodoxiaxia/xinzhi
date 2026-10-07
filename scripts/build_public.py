# -*- coding: utf-8 -*-
#!/usr/bin/env python3
"""Reproducible, allowlisted public build. No credentials, PDFs or private paths."""
import datetime, hashlib, json, re, shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'public'
PUBLIC = {'index.html','public.js','style.css','icon.svg','_headers','_worker.js'}
PAPER_FIELDS = {'id','title','doi','url','journal','cleanJournal','date','dateBasis','dateConfidence','datePrecision','basis','publisher','clinicalTier','studyDesign','tags','authors','affiliations','pmid','pubTypes','summary','abstractSections','localAvailable','quantitativeMetrics','titleZh'}
DRAFT_FIELDS = {'title_zh','summary','limitations','learning_question','study_type','evidence_basis','reviewer','source_checked','source_url','source_date','attribution','published','fulltext_status'}
QL_FIELDS = {'title_zh','one_line','design','findings','limits','why_read','abstract','pmid','generatedAt','source_url','abstract_source','abstractSource','abstractSourceUrl'}
SOURCE_FIELDS = {'id','name','url','checkedAt','status','items','itemsWithLinks','itemsWithAbstracts','rawItems','classifiedItems','eligibleItems','parser','feedType','rootKind','doctypeKind','httpStatus','cachedItems','lastSuccessfulAt','lastSuccessfulAtBasis','lastCachedFetchAt','error'}
RELEASE = 'v13.5.2'

def load(name): return json.loads((ROOT/name).read_text(encoding='utf-8'))
def js(name,data): return 'window.'+name+'='+json.dumps(data,ensure_ascii=False,separators=(',',':'))+';'
def safe_url(v):
    return v if isinstance(v,str) and re.match(r'^https?://',v,re.I) else ''
def pdf_library_registry(papers):
    """Only published IDs, DOIs and titles go into the server's download allowlist."""
    registry={}
    for paper in papers:
        paper_id=str(paper.get('id') or '')
        doi=re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)','',str(paper.get('doi') or '').strip(),flags=re.I).lower()
        title=str(paper.get('title') or '').strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',paper_id) or paper_id in ('__proto__','constructor','prototype'):
            continue
        if doi and not re.fullmatch(r'10\.\d{4,9}/[^\s\x00-\x1f\x7f]+',doi):
            continue
        if not doi and not title:continue
        identity={'doi':doi,'title':title}
        if paper_id in registry and registry[paper_id]!=identity:
            raise ValueError('Conflicting PDF library identity')
        registry[paper_id]=identity
    return registry
def public_paper(p):
    out={k:v for k,v in p.items() if k in PAPER_FIELDS}
    out['url']=safe_url(out.get('url',''))
    out['abstractSections']=[{k:v for k,v in s.items() if k in {'label','text'}} for s in out.get('abstractSections',[]) if isinstance(s,dict)]
    out['quantitativeMetrics']={k:v for k,v in out.get('quantitativeMetrics',{}).items() if k in {'sampleSize','followUp','trialId','effectSizes'}}
    d=p.get('draftData') or {}
    out['hasDraft']=bool(p.get('hasDraft') and d.get('source_checked') is True and d.get('published') is not False)
    if out['hasDraft']:out['draftData']={k:v for k,v in d.items() if k in DRAFT_FIELDS}
    return out

def public_quicklook(item):
    out={k:v for k,v in item.items() if k in QL_FIELDS}
    for field in ('source_url','abstractSourceUrl'):
        if field in out:out[field]=safe_url(out[field])
    out['findings']=[{k:v for k,v in x.items() if k in {'text','quote'}} for x in out.get('findings',[]) if isinstance(x,dict)]
    return out

def make_archive(candidates,library):
    """Keep checked articles readable after they leave the rolling radar."""
    path=ROOT/'data/curated-archive.json'
    previous=load('data/curated-archive.json').get('papers',[]) if path.exists() else []
    pool={str(p.get('doi') or p.get('id')).lower():p for p in previous+library+candidates}
    editorial=load('editorial/source_checked_drafts.json')
    # A latest-edition-only replacement must not silently erase historical guides.
    checked_keys={str(d.get('doi') or d.get('id') or '').lower() for d in editorial['articles'] if d.get('source_checked') is True}
    old_keys={str(p.get('doi') or p.get('id') or '').lower() for p in previous if p.get('hasDraft') and (p.get('draftData') or {}).get('source_checked') is True}
    if old_keys-checked_keys:raise ValueError('Existing checked guides missing from editorial; explicit withdrawal required: '+','.join(sorted(old_keys-checked_keys)))
    archive=[]
    for draft in editorial['articles']:
        if draft.get('source_checked') is not True or draft.get('published') is False:continue
        key=str(draft.get('doi') or draft.get('id') or '').lower()
        if not key or key not in pool:raise ValueError('Checked article has no archived metadata: '+key)
        p=dict(pool[key]);d=dict(draft)
        from enrich_metadata import clean_journal_name, classify_publisher, classify_clinical_tier, classify_study_design, extract_tags
        p.update(cleanJournal=clean_journal_name(p.get('journal')), publisher=classify_publisher(p.get('journal'),p.get('url')), clinicalTier=classify_clinical_tier(p.get('journal'),p.get('title','')), studyDesign=classify_study_design(p.get('title',''),p.get('summary',''),p.get('pubTypes',())), tags=extract_tags(p.get('title',''),p.get('summary','')))
        old=next((x for x in previous if str(x.get('doi') or x.get('id')).lower()==key),{})
        d['published']=draft.get('published') or (old.get('draftData') or {}).get('published') or editorial.get('prepared_on') or draft.get('source_date')
        p.update(hasDraft=True,draftData=d);archive.append(public_paper(p))
    return archive

def content_status(candidates, health, archive, quicklooks, built_at):
    """Reader-facing dates describe evidence scope, never imply medical review."""
    def latest(values):
        return max((v for v in values if isinstance(v,str) and v),default=None)
    return {'release':RELEASE,'builtAt':built_at,'radarUpdatedAt':candidates.get('updatedAt'),
            'healthCheckedAt':health.get('checkedAt'),
            'guideLatestPublishedAt':latest((p.get('draftData') or {}).get('published') for p in archive),
            'quicklookLatestAt':latest(q.get('generatedAt') for q in quicklooks.values()),
            'guideCount':len(archive),'quicklookCount':len(quicklooks)}

def _titlekey(t): return re.sub(r'[^a-z0-9]','',(t or '').lower())

_RADAR_JOURNAL_FIX={'Lancet (London, England)':'The Lancet','BMJ (Clinical research ed.)':'The BMJ'}

ABS_DAYS=30  # public bundle carries abstracts for the newest N days only; older ones load on demand

def make_radar(candidates,tz=None):
    tz=tz or {}
    """Compact 365-day PubMed title archive (radar 30/90/365-day views). Day-precision rows only."""
    path=ROOT/'data/radar-archive.json'
    if not path.exists():return None
    from enrich_metadata import clean_journal_name, classify_publisher, classify_clinical_tier, classify_study_design, extract_tags
    a=load('data/radar-archive.json')
    # Do not publish a metadata-only rebuild over an existing abstract archive.
    full_path=ROOT/'data/archive-full.json'
    if not full_path.is_file():raise ValueError('Full abstract cache missing; restore state before building the public archive')
    full=json.loads(full_path.read_text())
    abs_days=ABS_DAYS
    floor=(datetime.date.today()-datetime.timedelta(days=abs_days)).isoformat()
    absmap={}
    have=set()
    for p in candidates:
        if p.get('doi'):have.add(str(p['doi']).lower())
        if p.get('pmid'):have.add('pmid:'+str(p['pmid']))
        have.add(_titlekey(p.get('title')))
    pools={k:{} for k in ('jn','pub','tier','design','tag')}
    def idx(kind,val):
        d=pools[kind];return d.setdefault(val,len(d))
    rows=[];seen=set()
    for r in a.get('rows',[]):
        if r.get('datePrecision')!='day':continue
        keys={r.get('doi') or '','pmid:'+r['pmid'],_titlekey(r['title'])}-{''}
        if keys&have or keys&seen:continue
        seen|=keys
        j=r.get('journal','');url='https://doi.org/'+r['doi'] if r.get('doi') else ''
        cj=_RADAR_JOURNAL_FIX.get(clean_journal_name(j),clean_journal_name(j))
        f=full.get(str(r['pmid']),{})
        atext=' '.join(x.get('t','') for x in f.get('a',[]))
        pts=tuple(r.get('pubTypes',()))+tuple(f.get('pt',()))
        if f.get('a') and r['date']>=floor:
            absmap[str(r['pmid'])]=[[x.get('l',''),x.get('t','')] for x in f['a']]
        rows.append([r['pmid'],r.get('doi',''),r['date'],idx('jn',cj),idx('pub',classify_publisher(j,url)),
                     idx('tier',classify_clinical_tier(j,r['title'])),idx('design',classify_study_design(r['title'],atext,pts)),
                     [idx('tag',t) for t in extract_tags(r['title'],atext)],r['title']])
    if not rows:return None
    lists={k:[v for v,_ in sorted(d.items(),key=lambda kv:kv[1])] for k,d in pools.items()}
    return {'v':1,'updatedAt':a.get('updatedAt'),'windowDays':a.get('windowDays'),'source':a.get('source'),**lists,'abs':absmap,'zh':{str(r[0]):tz['pmid:%s'%r[0]] for r in rows if 'pmid:%s'%r[0] in tz},'rows':rows}

def validate_public(text):
    forbidden=(r'/Users/',r'/home/',r'(?i)[A-Z]:\\(?:Users|Documents)\\',r'(?i)"(?:api_key|admin_token|password|client_secret)"\s*:',r'\.local/')
    for pattern in forbidden:
        if re.search(pattern,text):raise ValueError('Public build contains a private field or path')

def main():
    DEST.mkdir(exist_ok=True)
    extra={p.name for p in DEST.iterdir()}-PUBLIC
    if extra:raise ValueError('Unexpected public files: '+','.join(sorted(extra)))
    c=load('data/candidates.json');l=load('data/library.json');h=load('data/source-health.json')
    archive=make_archive(c['items'],l['papers'])
    library={'generatedAt':l.get('generatedAt'),'papers':[public_paper(p) for p in l['papers']]}
    candidates={'updatedAt':c.get('updatedAt'),'windowDays':c.get('windowDays',14),'items':[public_paper(p) for p in c['items']]}
    health={'checkedAt':h.get('checkedAt'),'sources':[{k:v for k,v in s.items() if k in SOURCE_FIELDS} for s in h['sources']]}
    tz=json.loads((ROOT/'data/translations.json').read_text()) if (ROOT/'data/translations.json').exists() else {}
    def zhkey(q):return tz.get('pmid:%s'%q.get('pmid')) or tz.get('doi:%s'%str(q.get('doi') or '').lower())
    for q in candidates['items']+library['papers']:
        z=zhkey(q)
        if z:q['titleZh']=z
    mp=ROOT/'data/media.json'
    if mp.exists():
        mm=json.loads(mp.read_text()).get('matches',{});nm=0
        for q in candidates['items']+library['papers']:
            m=mm.get(q.get('id'))
            if m:q['media']=[{'s':x['s'],'t':x['t'],'u':x['u'],'w':x.get('w',1)} for x in m][:4];nm+=1
        print('papers with media coverage:',nm)
    pk=ROOT/'data/picks.json'
    if pk.exists():
        picks=json.loads(pk.read_text());byid={q.get('id'):q for q in candidates['items']}
        for d,ids in picks.get('daily',{}).items():
            for i,x in enumerate(ids):
                if x in byid:byid[x]['autoPick']={'d':d,'r':i+1}
        for i,x in enumerate(picks.get('weekly',[])):
            if x in byid:byid[x]['weeklyPick']=i+1;byid[x]['weeklyAt']=picks.get('updatedAt')
        print('auto picks:',sum(1 for q in candidates['items'] if q.get('autoPick')),'weekly:',len(picks.get('weekly',[])))
    fullp=ROOT/'data/archive-full.json'
    if fullp.exists():
        full=json.loads(fullp.read_text());bydoi={str(v.get('d','')).lower():v for v in full.values() if v.get('d')}
        filled=0
        for q in candidates['items']:
            if q.get('summary') or q.get('abstractSections'):continue
            v=full.get(str(q.get('pmid') or ''))or bydoi.get(str(q.get('doi') or '').lower())
            if v and v.get('a'):
                q['abstractSections']=[{'label':x.get('l',''),'text':x.get('t','')} for x in v['a']];filled+=1
        print('candidates filled from private store:',filled)
    radar=make_radar(c['items'],tz)
    ql=load('data/quicklooks.json').get('items',{}) if (ROOT/'data/quicklooks.json').exists() else {}
    ql={k:public_quicklook(val) for k,val in ql.items()}
    public_index=re.sub(r'<script src="data/library\.js"></script>.*?<script src="app\.js"></script>','<script src="public.js"></script>',(ROOT/'index.html').read_text(),flags=re.DOTALL)
    if 'data/library.js' in public_index or 'public.js' not in public_index:raise ValueError('Script bundling failed')
    built_at=datetime.datetime.now(datetime.timezone.utc).isoformat()
    status=content_status(candidates,health,archive,ql,built_at)
    bundle='\n;\n'.join([js('LIBRARY',library),js('FEEDS',candidates),js('SOURCE_HEALTH',health),js('CURATED',archive),js('QUICKLOOKS',ql),js('CONTENT_STATUS',status)]+([js('RADAR',radar)] if radar else [])+[(ROOT/'app.js').read_text()])
    headers="/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://www.ebi.ac.uk; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\n"
    worker=(ROOT/'edge/_worker.js').read_text()
    placeholder='const PDF_LIBRARY = {};'
    if worker.count(placeholder)!=1:raise ValueError('PDF download allowlist placeholder missing')
    worker=worker.replace(placeholder,'const PDF_LIBRARY = '+json.dumps(pdf_library_registry(library['papers']),ensure_ascii=False,separators=(',',':'))+';')
    files={'index.html':public_index,'public.js':bundle,'style.css':(ROOT/'style.css').read_text(),'icon.svg':(ROOT/'icon.svg').read_text(),'_headers':headers,'_worker.js':worker}
    for value in files.values():validate_public(value)
    for name,value in files.items():(DEST/name).write_text(value,encoding='utf-8')
    # Local generated assets use the same sanitized archive/quicklooks as the public build.
    (ROOT/'data/curated-archive.json').write_text(json.dumps({'papers':archive},ensure_ascii=False,indent=2))
    (ROOT/'data/curated.js').write_text(js('CURATED',archive))
    (ROOT/'data/quicklooks.js').write_text(js('QUICKLOOKS',ql))
    manifest=[{'path':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(DEST.iterdir())]
    assert {p['path'] for p in manifest}==PUBLIC
    meta={'release':RELEASE,'createdAt':built_at,'files':manifest,'contentStatus':status,'counts':{'radar':len(c['items']),'library':len(l['papers']),'checked_guides':len(archive),'ai_quicklooks_unchecked':len(ql),'radar_archive_titles':len(radar['rows']) if radar else 0,'titles_zh':len(tz)},'excludes':['PDFs','local paths','private notes','database','credentials'],'deployed':False}
    (ROOT/'docs/public-manifest.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2))
    print(json.dumps({'built':len(manifest),'release':meta['release'],'counts':meta['counts']},ensure_ascii=False))
if __name__=='__main__':main()
