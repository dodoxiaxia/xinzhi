# -*- coding: utf-8 -*-
#!/usr/bin/env python3
"""Reproducible, allowlisted public build. No credentials, PDFs or private paths."""
import datetime, hashlib, json, re, shutil
from pathlib import Path
from apply_public_library import require_snapshot
from release_integrity import input_hashes, ordinary_file, provenance, replace_unchanged_input
from editorial_review import article_key, publication_date
from sync_public_library import load_adjudications
from publication_dates import DATE_CORRECTIONS, canonical_publication_date
from journal_metrics import public_registry
from public_library_quality import QUALITY_FIELDS, project_public_library
ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'public'
PUBLIC = {'index.html','public.js','style.css','icon.svg','_headers','_worker.js'}
PAPER_FIELDS = {'id','title','doi','url','journal','cleanJournal','date','dateBasis','dateConfidence','datePrecision','basis','publisher','clinicalTier','studyDesign','tags','authors','affiliations','pmid','pubTypes','summary','abstractSections','localAvailable','quantitativeMetrics','titleZh','ingestedAt','metadataStatus','fulltextStatus'}
PAPER_FIELDS |= QUALITY_FIELDS
DRAFT_FIELDS = {'title_zh','summary','limitations','learning_question','study_type','evidence_basis','source_checked','source_url','source_date','attribution','published','fulltext_status'}
QL_FIELDS = {'title_zh','one_line','design','findings','limits','why_read','abstract','pmid','generatedAt','source_url','abstract_source','abstractSource','abstractSourceUrl'}
SOURCE_FIELDS = {'id','name','url','checkedAt','status','items','itemsWithLinks','itemsWithAbstracts','rawItems','classifiedItems','eligibleItems','parser','feedType','rootKind','doctypeKind','httpStatus','cachedItems','lastSuccessfulAt','lastSuccessfulAtBasis','lastCachedFetchAt','error','responseUrl','responseContentType','failureReason','blockedReason','excludedItems','latestPublishedAt'}
RELEASE = 'v14.2.15'

def load(name): return json.loads((ROOT/name).read_text(encoding='utf-8'))
def js(name,data): return 'window.'+name+'='+json.dumps(data,ensure_ascii=False,separators=(',',':'))+';'
def safe_url(v):
    return v if isinstance(v,str) and re.match(r'^https?://',v,re.I) else ''
def legacy_guides():
    # The frozen publication registry is required even when state history is absent.
    try:
        registry=load('editorial/legacy_published_guides.json')
        if not isinstance(registry,dict) or type(registry.get('schema_version')) is not int or registry['schema_version']!=1:
            raise ValueError('Unsupported registry schema')
        guides=registry.get('guides')
        if not isinstance(guides,dict) or not guides:raise ValueError('Empty or invalid registry')
        for key,row in guides.items():
            if not isinstance(key,str) or not key or key!=key.strip().lower() or not isinstance(row,dict):
                raise ValueError('Invalid registered identity')
            digest,date=row.get('content_sha256'),row.get('published_on')
            if not isinstance(digest,str) or not re.fullmatch(r'[a-f0-9]{64}',digest):
                raise ValueError('Invalid registered content hash')
            if not isinstance(date,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date):
                raise ValueError('Invalid registered publication date')
            datetime.date.fromisoformat(date)
        return guides
    except (OSError,ValueError,TypeError,KeyError) as exc:
        raise ValueError('Legacy publication registry is missing or invalid; hold public build') from exc
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
def doi_adjudication_registry():
    """Project reviewed public identities; keep source evidence and private data out."""
    path=ordinary_file(ROOT,'config/public_library_adjudications.json')
    policy=json.loads(path.read_text(encoding='utf-8'))
    source_commit=policy.get('sourceCommit') if isinstance(policy,dict) else None
    if not isinstance(source_commit,str) or not re.fullmatch(r'[0-9a-f]{40}',source_commit):
        raise ValueError('DOI adjudication source commit is invalid')
    decisions,_=load_adjudications(path,source_commit)
    return {'sourceCommit':source_commit,'decisions':{
        doi:{key:row[key] for key in ('action','acceptedTitles','metadata')}
        for doi,row in decisions.items()
    }}
def public_paper(p,editorial_drafts=None):
    from abstract_quality import normalize_paper
    p=normalize_paper(p)
    out={k:v for k,v in p.items() if k in PAPER_FIELDS}
    if p.get('abstractStatus') in {'structured','available','missing','unverified','non_abstract_metadata'}:out['abstractStatus']=p['abstractStatus']
    if p.get('abstractSource') in {'Crossref','PubMed','RSS','Europe PMC'}:
        out['abstractSource']=p['abstractSource']
        out['abstractSourceUrl']=safe_url(p.get('abstractSourceUrl'))
    if p.get('nonAbstractMetadata'):
        out['nonAbstractMetadata']=[{'kind':row['kind'],'text':row['text'][:12000]} for row in p['nonAbstractMetadata']
                                   if isinstance(row,dict) and row.get('kind') in {'funding','funding-group','award-group','contrib-group','permissions'} and isinstance(row.get('text'),str)]
    out['url']=safe_url(out.get('url',''))
    out['abstractSections']=[{k:v for k,v in s.items() if k in {'label','text'}} for s in out.get('abstractSections',[]) if isinstance(s,dict)]
    out['quantitativeMetrics']={k:v for k,v in out.get('quantitativeMetrics',{}).items() if k in {'sampleSize','followUp','trialId','effectSizes'}}
    # Main editorial decisions override stale draftData in every state cache.
    d=(editorial_drafts.get(article_key(p),{}) if editorial_drafts is not None else p.get('draftData')) or {}
    date=publication_date(d,article_key(p),legacy_guides()) if (d if editorial_drafts is not None else p.get('hasDraft')) else None
    if date and d.get('content_kind')=='weekly':
        raise ValueError('Weekly handoff requires the dedicated issue renderer')
    out['hasDraft']=bool(date)
    if date:out['draftData']={**{k:v for k,v in d.items() if k in DRAFT_FIELDS},'published':date}
    return out

def public_quicklook(item):
    out={k:v for k,v in item.items() if k in QL_FIELDS}
    for field in ('source_url','abstractSourceUrl'):
        if field in out:out[field]=safe_url(out[field])
    out['findings']=[{k:v for k,v in x.items() if k in {'text','quote'}} for x in out.get('findings',[]) if isinstance(x,dict)]
    return out

def public_weekly_board(raw, *, maximum_rows=30):
    """Finite, validated public-abstract contract. Never emit private cache/ledger fields."""
    from week_precompute import validate, text_hash, TASKS, CATEGORIES, CAVEAT
    if not raw:return None
    if raw.get('schemaVersion')!=1 or raw.get('scope')!='public-abstract':
        raise ValueError('Invalid weekly board schema')
    rows=raw.get('items')
    if type(maximum_rows) is not int or maximum_rows < 0:raise ValueError('Invalid public content bound')
    if not isinstance(rows,list) or len(rows)>maximum_rows:raise ValueError('Invalid weekly board count')
    safe=[];seen=set()
    for row in rows:
        allowed={'id','paperID','doi','pmid','rank','category','date','title','sourceHash','abstract','abstractSource','abstractSourceUrl','titleZh','precomputeStatus','missingTasks','allowAutomaticGeneration'}
        out={k:v for k,v in row.items() if k in allowed}
        if out.get('paperID') in seen or out.get('category') not in CATEGORIES:raise ValueError('Invalid weekly board identity/category')
        seen.add(out.get('paperID'))
        if text_hash(out['title'],out['abstract'])!=out['sourceHash']:raise ValueError('Weekly board source hash mismatch')
        out['abstractSourceUrl']=safe_url(out.get('abstractSourceUrl'))
        out['allowAutomaticGeneration']=False
        p={'title':out['title'],'abstract':out['abstract']}
        if out.get('titleZh'):out['titleZh']=validate('title',{'title_zh':out['titleZh']},p)['title_zh']
        out['translation']=validate('translate',row['translation'],p) if row.get('translation') else None
        out['quicklook']=public_quicklook(validate('quicklook',row['quicklook'],p)) if row.get('quicklook') else None
        study=row.get('study')
        if study:
            if study.get('scope')!='public-abstract' or study.get('task')!='study' or len(study.get('papers',[]))!=1:raise ValueError('Invalid weekly study')
            paper=study['papers'][0]
            fields=validate('study',{f:paper.get(f) for f in ('question','population','design','comparator','endpoints','results')},p)
            # Preserve the existing study renderer's exact shape, sanitize provenance.
            single={k:paper[k] for k in ('n','key','title','doi','pmid','journal','status','sourceFingerprint','generatedAt','model','abstract_source') if k in paper}
            single.update(fields,source_url=safe_url(paper.get('source_url','')))
            out['study']={k:study[k] for k in ('task','schemaVersion','scope','missingKeys','checklist','generatedAt','model','generatedBy') if k in study}
            out['study'].update(papers=[single],caveat=CAVEAT)
        else:out['study']=None
        # Compute coverage states; do not trust an unvalidated ready flag.
        present={'translate':bool(out['translation']),'quicklook':bool(out['quicklook']),'study':bool(out['study'])}
        out['missingTasks']=[t for t in TASKS if not present[t]]
        out['precomputeStatus']='ready' if all(present.values()) else 'partial' if any(present.values()) else 'pending'
        out['generationMeta']={t:{k:v for k,v in m.items() if k in {'modelVersion','generatedAt','promptVersion','origin','validatorVersion','validatedWith','generationPromptVersion','generationVersionKnown','legacyLocalValidationVersion'}} for t,m in row.get('generationMeta',{}).items() if t in TASKS and isinstance(m,dict)}
        safe.append(out)
    window={k:v for k,v in raw.get('window',{}).items() if k in {'start','end','timezone','days','target','eligible','selected','eligibleByCategory','excluded','shortfallReason'}}
    categories=[{k:v for k,v in c.items() if k in {'key','count','eligible','reason'}} for c in raw.get('categories',[]) if isinstance(c,dict)]
    return {'schemaVersion':1,'scope':'public-abstract','generatedAt':raw.get('generatedAt'),'caveat':CAVEAT,'window':window,'categories':categories,'items':safe,'coverage':{'title':sum(bool(r.get('titleZh')) for r in safe),**{t:sum(bool(r[{'translate':'translation','study':'study','quicklook':'quicklook'}[t]]) for r in safe) for t in TASKS}}}

def pregenerated_map(weekly):
    result={}
    for row in (weekly or {}).get('items',[]):
        meta={k:row.get(k) for k in ('paperID','sourceHash','precomputeStatus','missingTasks','allowAutomaticGeneration','abstractSource','abstractSourceUrl','generationMeta')}
        entry={'translation':row.get('translation'),'quicklook':row.get('quicklook'),'study':row.get('study'),'meta':meta}
        keys=[]
        if row.get('pmid'):keys.append('pmid:'+str(row['pmid']))
        if row.get('doi'):keys.append('doi:'+str(row['doi']).lower())
        for key in keys:
            if key in result and result[key]!=entry:raise ValueError('Conflicting precomputed paper alias')
            result[key]=entry
    return result

def public_health(source, pubmed, now):
    from refresh_feeds import safe_url as sanitized_url
    from source_fallbacks import coverage
    out={k:v for k,v in source.items() if k in SOURCE_FIELDS}
    if 'responseUrl' in out:out['responseUrl']=sanitized_url(safe_url(out['responseUrl']))
    if 'excludedItems' in out:
        out['excludedItems']={k:v for k,v in out['excludedItems'].items()
                              if k in {'undated','future','olderThan14Days','unclassifiedOrInvalid'} and type(v) is int and v>=0}
    out['pubmedFallback']=coverage(source,pubmed,now)
    return out

def make_archive(candidates,library):
    """Keep checked articles readable after they leave the rolling radar."""
    path=ROOT/'data/curated-archive.json'
    previous=load('data/curated-archive.json').get('papers',[]) if path.exists() else []
    pool={str(p.get('doi') or p.get('id')).lower():p for p in previous+library+candidates}
    editorial=load('editorial/source_checked_drafts.json')
    keys=[article_key(d) for d in editorial['articles']]
    if len(keys)!=len(set(keys)):raise ValueError('Duplicate editorial article identity')
    # A latest-edition-only replacement must not silently erase historical guides.
    checked_keys={str(d.get('doi') or d.get('id') or '').lower() for d in editorial['articles'] if d.get('source_checked') is True}
    old_keys={str(p.get('doi') or p.get('id') or '').lower() for p in previous if p.get('hasDraft') and (p.get('draftData') or {}).get('source_checked') is True}
    if old_keys-checked_keys:raise ValueError('Existing checked guides missing from editorial; explicit withdrawal required: '+','.join(sorted(old_keys-checked_keys)))
    archive=[]
    for draft in editorial['articles']:
        key=article_key(draft)
        date=publication_date(draft,key,legacy_guides())
        if not date:
            # Hold the last production build when a pending revision replaces
            # published history. Only an explicit withdrawal may remove it.
            if key in old_keys and draft.get('published') is not False and (draft.get('review') or {}).get('state')!='withdrawn':
                raise ValueError('Pending revision cannot replace published history: '+key)
            continue
        if not key or key not in pool:raise ValueError('Checked article has no archived metadata: '+key)
        p=dict(pool[key]);d=dict(draft)
        from enrich_metadata import clean_journal_name, classify_publisher, classify_clinical_tier, classify_study_design, extract_tags
        p.update(cleanJournal=clean_journal_name(p.get('journal')), publisher=classify_publisher(p.get('journal'),p.get('url')), clinicalTier=classify_clinical_tier(p.get('journal'),p.get('title','')), studyDesign=classify_study_design(p.get('title',''),p.get('summary',''),p.get('pubTypes',())), tags=extract_tags(p.get('title',''),p.get('summary','')))
        d['published']=date
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
    rows=[];seen=set();date_bases={}
    for source_record in a.get('rows',[]):
        r=canonical_publication_date(source_record)
        if r.get('datePrecision')!='day':continue
        keys={r.get('doi') or '','pmid:'+r['pmid'],_titlekey(r['title'])}-{''}
        if keys&have or keys&seen:continue
        seen|=keys
        if str(r.get('doi') or '').strip().lower() in DATE_CORRECTIONS:
            date_bases[str(r['pmid'])]=r['dateBasis']
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
    return {'v':1,'updatedAt':a.get('updatedAt'),'windowDays':a.get('windowDays'),'source':a.get('source'),**lists,'abs':absmap,'zh':{str(r[0]):tz['pmid:%s'%r[0]] for r in rows if 'pmid:%s'%r[0] in tz},'rows':rows,
            **({'dateBases':date_bases} if date_bases else {})}

def validate_public(text):
    forbidden=(r'/Users/',r'/home/',r'(?i)[A-Z]:\\(?:Users|Documents)\\',r'(?i)"(?:api_key|admin_token|password|client_secret)"\s*:',r'\.local/')
    for pattern in forbidden:
        if re.search(pattern,text):raise ValueError('Public build contains a private field or path')

def main():
    build_before = provenance(ROOT)
    inputs_before = build_before['inputs']
    legacy_guides()  # Required publication registry, even when article lists are empty.
    DEST.mkdir(exist_ok=True)
    extra={p.name for p in DEST.iterdir()}-PUBLIC
    if extra:raise ValueError('Unexpected public files: '+','.join(sorted(extra)))
    c=load('data/candidates.json');l=load('data/library.json');h=load('data/source-health.json')
    require_snapshot(l, ROOT)
    # Old state may predate the reviewed publisher correction. Correct before
    # archive selection and public ordering without changing approved library rows.
    c['items']=sorted((canonical_publication_date(p) for p in c['items']),
                      key=lambda p:p.get('date') or '',reverse=True)
    archive=make_archive(c['items'],l['papers'])
    editorial_drafts={article_key(d):d for d in load('editorial/source_checked_drafts.json')['articles']}
    library={'generatedAt':l.get('generatedAt'),'papers':[public_paper(p,editorial_drafts) for p in l['papers']]}
    library['papers'],library_quality=project_public_library(library['papers'])
    candidates={'updatedAt':c.get('updatedAt'),'windowDays':c.get('windowDays',14),'items':[public_paper(p,editorial_drafts) for p in c['items']]}
    pubmed=load('data/pubmed.json') if (ROOT/'data/pubmed.json').is_file() else {}
    now=datetime.datetime.now(datetime.timezone.utc)
    health={'checkedAt':h.get('checkedAt'),'sources':[public_health(s,pubmed,now) for s in h['sources']]}
    tz=json.loads((ROOT/'data/translations.json').read_text()) if (ROOT/'data/translations.json').exists() else {}
    from week_precompute import editorial_title
    editorial_titles=load('editorial/public_title_translations.json') if (ROOT/'editorial/public_title_translations.json').exists() else {'entries':{}}
    def zhkey(q):return tz.get('pmid:%s'%q.get('pmid')) or tz.get('doi:%s'%str(q.get('doi') or '').lower())
    for q in candidates['items']+library['papers']:
        z=zhkey(q) or ('' if q.get('titleZh') else editorial_title(q,editorial_titles))
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
        from abstract_quality import readable_abstract
        picks=json.loads(pk.read_text());byid={q.get('id'):q for q in candidates['items']}
        for d,ids in picks.get('daily',{}).items():
            for i,x in enumerate(ids):
                if x in byid and readable_abstract(byid[x]):byid[x]['autoPick']={'d':d,'r':i+1}
        for i,x in enumerate(picks.get('weekly',[])):
            if x in byid and readable_abstract(byid[x]):byid[x]['weeklyPick']=i+1;byid[x]['weeklyAt']=picks.get('updatedAt');byid[x]['weeklyCategory']={'心血管':'cardio','综合医学':'general','AI医疗':'aimed','AI前沿':'aitech'}.get(picks.get('weeklyCategories',{}).get(x))
        print('auto picks:',sum(1 for q in candidates['items'] if q.get('autoPick')),'weekly:',len(picks.get('weekly',[])))
    fullp=ROOT/'data/archive-full.json'
    if fullp.exists():
        full=json.loads(fullp.read_text());bydoi={str(v.get('d','')).lower():v for v in full.values() if v.get('d')}
        filled=0
        for q in candidates['items']:
            if q.get('abstractStatus') in {'non_abstract_metadata','unverified'}:continue
            if q.get('summary') or q.get('abstractSections'):continue
            v=full.get(str(q.get('pmid') or ''))or bydoi.get(str(q.get('doi') or '').lower())
            if v and v.get('a'):
                q['abstractSections']=[{'label':x.get('l',''),'text':x.get('t','')} for x in v['a']];filled+=1
        print('candidates filled from private store:',filled)
    from public_editorial_overlay import apply_board, current_catalog, load_board
    editorial_overlay=load_board(ROOT)
    weekly_raw=load('data/weekly-board.json') if (ROOT/'data/weekly-board.json').exists() else None
    weekly=public_weekly_board(apply_board(weekly_raw,editorial_overlay))
    # The strict rolling board remains capped at 30. The off-week catalogue
    # is bounded by the exact reviewed registry already loaded and source-matched.
    editorial_catalog=public_weekly_board(current_catalog(c['items'],editorial_overlay),
                                        maximum_rows=len(editorial_overlay['items']) if editorial_overlay else 0)
    prepared=pregenerated_map(editorial_catalog)
    prepared.update(pregenerated_map(weekly))
    if weekly:
        byid={q['id']:q for q in candidates['items']}
        for q in candidates['items']:
            for field in ('weeklyPick','weeklyAt','weeklyCategory'):q.pop(field,None)
        for row in weekly['items']:
            if row['id'] not in byid:raise ValueError('Weekly board paper missing from current candidates')
            q=byid[row['id']]
            q.update(title=row['title'],doi=row.get('doi',''),pmid=row.get('pmid',''),weeklyPick=row['rank'],weeklyAt=weekly['generatedAt'],weeklyCategory={'心血管':'cardio','综合医学':'general','AI医疗':'aimed','AI前沿':'aitech'}[row['category']],date=row['date'],datePrecision='day',dateBasis='Europe PMC firstPublicationDate' if row['abstractSource']=='Europe PMC' else q.get('dateBasis'),summary=row['abstract'],abstractSections=[])
            if row['titleZh']:q['titleZh']=row['titleZh']
            else:q.pop('titleZh',None)  # Do not revive a legacy title rejected by the board's source checks.
    radar=make_radar(c['items'],tz)
    ql=load('data/quicklooks.json').get('items',{}) if (ROOT/'data/quicklooks.json').exists() else {}
    ql={k:public_quicklook(val) for k,val in ql.items()}
    if weekly:
        from week_precompute import validate as validate_week_task
        for row in weekly['items']:
            key=row.get('doi') or 'pmid-'+str(row.get('pmid'))
            if key in ql:
                try:validate_week_task('quicklook',ql[key],row)
                except ValueError:ql.pop(key)  # Preserve original cache; hide stale evidence from this board.
    public_index=re.sub(r'<script src="data/library\.js"></script>.*?<script src="app\.js"></script>','<script src="public.js"></script>',(ROOT/'index.html').read_text(),flags=re.DOTALL)
    if 'data/library.js' in public_index or 'public.js' not in public_index:raise ValueError('Script bundling failed')
    built_at=datetime.datetime.now(datetime.timezone.utc).isoformat()
    status=content_status(candidates,health,archive,ql,built_at)
    metrics=public_registry(ROOT)
    bundle='\n;\n'.join([js('LIBRARY',library),js('FEEDS',candidates),js('SOURCE_HEALTH',health),js('CURATED',archive),js('QUICKLOOKS',ql),js('CONTENT_STATUS',status),js('JOURNAL_METRICS',metrics)]+([js('WEEKLY_BOARD',weekly)] if weekly else [])+([js('PREGENERATED',prepared)] if prepared else [])+([js('RADAR',radar)] if radar else [])+[(ROOT/'journal-metrics.js').read_text(),(ROOT/'citation-export.js').read_text(),(ROOT/'app.js').read_text()])
    headers="/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://www.ebi.ac.uk; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\n"
    worker=(ROOT/'edge/_worker.js').read_text()
    placeholder='const PDF_LIBRARY = {};'
    if worker.count(placeholder)!=1:raise ValueError('PDF download allowlist placeholder missing')
    # A public DOI correction is not evidence for rebinding a private PDF.
    pdf_papers=[p for p in library['papers'] if p['id'] not in library_quality['pdfBindingHoldIds']]
    worker=worker.replace(placeholder,'const PDF_LIBRARY = '+json.dumps(pdf_library_registry(pdf_papers),ensure_ascii=False,separators=(',',':'))+';')
    doi_placeholder='const DOI_ADJUDICATIONS = {};'
    if worker.count(doi_placeholder)!=1:raise ValueError('DOI adjudication placeholder missing')
    worker=worker.replace(doi_placeholder,'const DOI_ADJUDICATIONS = '+json.dumps(doi_adjudication_registry(),ensure_ascii=False,separators=(',',':'))+';')
    files={'index.html':public_index,'public.js':bundle,'style.css':(ROOT/'style.css').read_text(),'icon.svg':(ROOT/'icon.svg').read_text(),'_headers':headers,'_worker.js':worker}
    for value in files.values():validate_public(value)
    payloads={name:value.encode('utf-8') for name,value in files.items()}
    if input_hashes(ROOT) != inputs_before:raise ValueError('Build inputs changed during construction; rebuild public')
    for name,value in payloads.items():(DEST/name).write_bytes(value)
    # Local generated assets use the same sanitized archive/quicklooks as the public build.
    archive_text=json.dumps({'papers':archive},ensure_ascii=False,indent=2)
    replace_unchanged_input(ROOT,'data/curated-archive.json',archive_text.encode('utf-8'),inputs_before['data/curated-archive.json'])
    (ROOT/'data/curated.js').write_text(js('CURATED',archive))
    (ROOT/'data/quicklooks.js').write_text(js('QUICKLOOKS',ql))
    # The receipt describes the bytes we constructed and validated, never replacements.
    manifest=[{'path':name,'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()} for name,content in sorted(payloads.items())]
    assert {p['path'] for p in manifest}==PUBLIC
    meta={'release':RELEASE,'createdAt':built_at,'files':manifest,'contentStatus':status,'counts':{'radar':len(c['items']),'library':len(library['papers']),'checked_guides':len(archive),'ai_quicklooks_unchecked':len(ql),'radar_archive_titles':len(radar['rows']) if radar else 0,'titles_zh':len(tz),'weekly_board':len(weekly['items']) if weekly else 0,'weekly_precomputed':weekly['coverage'] if weekly else {}},'excludes':['PDFs','local paths','private notes','database','credentials'],'deployed':False}
    # curated-archive is both input and sanitized output; record its final bytes.
    build_after=provenance(ROOT)
    expected_inputs=dict(inputs_before)
    expected_inputs['data/curated-archive.json']=hashlib.sha256(archive_text.encode('utf-8')).hexdigest()
    if build_after['inputs']!=expected_inputs or build_after['codeSha']!=build_before['codeSha']:
        raise ValueError('Build inputs or checkout changed before completion; rebuild public')
    if {p.name for p in DEST.iterdir()}!=PUBLIC:
        raise ValueError('Public outputs changed before completion; rebuild public')
    for name,content in payloads.items():
        if ordinary_file(ROOT,'public/'+name).read_bytes()!=content:
            raise ValueError('Public output changed before completion: '+name)
    meta['buildProvenance']=build_after
    # Local audit only; the six-file public allowlist does not include this report.
    (ROOT/'docs/public-library-quality-audit.json').write_text(json.dumps(library_quality,ensure_ascii=False,indent=2)+'\n')
    (ROOT/'docs/public-manifest.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2))
    print(json.dumps({'built':len(manifest),'release':meta['release'],'counts':meta['counts']},ensure_ascii=False))
if __name__=='__main__':main()
