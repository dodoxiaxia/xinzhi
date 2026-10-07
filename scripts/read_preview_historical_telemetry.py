"""Read existing historical metrics; no Pages route, Access request, deploy or retry."""
import json,os,urllib.request,urllib.error,datetime
from pathlib import Path
ACCOUNT=os.environ['CLOUDFLARE_ACCOUNT_ID'];TOKEN=os.environ['CLOUDFLARE_API_TOKEN']
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'previewRouteRequests':0,'accessApiRequests':0,'originalWindow':['2026-10-07T19:38:15Z','2026-10-07T19:38:30Z'],'resourceGatePassed':False,'queries':[]}
def query(label,text,variables=None):
 req=urllib.request.Request('https://api.cloudflare.com/client/v4/graphql',data=json.dumps({'query':text,'variables':variables or {}}).encode(),headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'},method='POST')
 try:
  with urllib.request.urlopen(req,timeout=30) as r:obj=json.load(r);status=r.status
  errors=[{'message':str(e.get('message','')).replace(ACCOUNT,'[account]').replace(TOKEN,'[redacted]')[:300]} for e in obj.get('errors') or []]
  report['queries'].append({'label':label,'httpStatus':status,'errors':errors});return None if errors else obj.get('data')
 except urllib.error.HTTPError as e:report['queries'].append({'label':label,'httpStatus':e.code});return None
 except Exception as e:report['queries'].append({'label':label,'errorType':type(e).__name__});return None
# Introspect only the known account metrics field and its filter type.
identity=query('account_schema_typename','query TypeName($accountTag:string){viewer{accounts(filter:{accountTag:$accountTag}){__typename}}}',{'accountTag':ACCOUNT})
accounts=(identity or {}).get('viewer',{}).get('accounts') or []
account_type=(accounts[0].get('__typename') if accounts else None)
schema=query('account_metrics_schema','{ __type(name:'+json.dumps(account_type)+') { fields { name args { name type { kind name ofType { kind name ofType {kind name} } } } } } }') if account_type else None
field=None
if schema:
 field=next((x for x in (schema.get('__type') or {}).get('fields') or [] if x['name']=='workersInvocationsAdaptive'),None)
 filter_arg=next((a for a in (field or {}).get('args') or [] if a['name']=='filter'),None)
 typeinfo=(filter_arg or {}).get('type') or {};typename=typeinfo.get('name') or (typeinfo.get('ofType') or {}).get('name')
 if typename:
  filters=query('metrics_filter_schema','{ __type(name:'+json.dumps(typename)+'){ inputFields {name} } }')
  names=[x['name'] for x in (filters or {}).get('__type',{}).get('inputFields') or []]
  report['supportedRelevantFilters']=[n for n in names if any(k in n.lower() for k in ['script','preview','environment','datetime'])]
  # Original 15-second window only. Restrict to Pages worker names when the
  # supported generated schema offers a prefix filter; never query user content.
  constraints=['datetime_geq:"2026-10-07T19:38:15Z"','datetime_leq:"2026-10-07T19:38:30Z"']
  if 'scriptName_like' in names:constraints.append('scriptName_like:"pages-worker--%"')
  text='query Historic($accountTag:string){viewer{accounts(filter:{accountTag:$accountTag}){workersInvocationsAdaptive(limit:30,filter:{'+','.join(constraints)+'}){dimensions{datetime scriptName scriptVersion environmentName isPreview previewSlug status}sum{requests errors}max{cpuTime memoryUsageBytes wallTime}quantiles{cpuTimeP50 cpuTimeP99 memoryUsageBytesP50 memoryUsageBytesP99}}}}}'
  result=query('original_preview_time_window',text,{'accountTag':ACCOUNT})
  if result:
   rows=[r for a in result.get('viewer',{}).get('accounts') or [] for r in a.get('workersInvocationsAdaptive') or []]
   report['historicalRowCount']=len(rows);report['windowCompleteWithinLimit']=len(rows)<30
   # Only project/preview-correlated records are retained. Unrelated account
   # Worker names and metadata are discarded and never printed or stored.
   relevant=[r for r in rows if any(k in json.dumps(r.get('dimensions') or {}) for k in ['dryz-xinzhi','3f577b35','lazy-v143-review'])]
   report['projectOrPreviewCorrelatedRows']=relevant;report['uncorrelatedRowsDiscarded']=len(rows)-len(relevant)
   report['historicalCpuMemoryReadPermissionVerified']=True
out=Path('.local/preview403-historical-telemetry');out.mkdir(parents=True,exist_ok=True);(out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:report.get(k) for k in ['previewRouteRequests','accessApiRequests','historicalRowCount','historicalCpuMemoryReadPermissionVerified','resourceGatePassed']}))
