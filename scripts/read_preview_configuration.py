"""Existing CI identity; configuration GETs and one read-only GraphQL query only.
Never fetches any pages.dev/custom-domain route, deploys, mutates settings, retries,
reads secret files, or retains env_vars/credential values from API responses.
"""
import datetime,json,os,re,urllib.request,urllib.error
from pathlib import Path
BASE='https://api.cloudflare.com/client/v4'; ACCOUNT=os.environ['CLOUDFLARE_ACCOUNT_ID']; PROJECT='dryz-xinzhi'; DEPLOYMENT='3f577b35-9077-4c4f-be65-e2079d3a5c56'
AUTH={'Authorization':'Bearer '+os.environ['CLOUDFLARE_API_TOKEN'],'Content-Type':'application/json'}
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
client=urllib.request.build_opener(NoRedirect())
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceRun':37675847598,'original403HeadersRetained':False,'original403BodyRetained':False,'previewRouteRequests':0,'deploymentsCreated':0,'configWrites':0,'identityChanged':False,'permissionChanges':False,'requests':[]}
def safe_error(value):
 text=str(value).replace(ACCOUNT,'[account]')
 text=re.sub(r'(?i)(bearer\s+|token[=:]\s*)\S+',r'\1[redacted]',text)
 text=re.sub(r'[A-Za-z0-9_/-]{40,}', '[identifier]',text)
 return text[:250]
def drop_sensitive(pairs):
 # Do not traverse, select or retain environmental variables or secret settings.
 return {k:v for k,v in pairs if k not in {'env_vars','environment_variables','secrets','token','client_secret','clientSecret','service_token','credentials','authentication','private_key'}}
def read(label,path,query=None):
 req=urllib.request.Request(BASE+path,headers=AUTH,data=json.dumps(query).encode() if query else None,method='POST' if query else 'GET')
 info={'resource':label,'method':req.method,'retried':False}
 try:
  with client.open(req,timeout=30) as response:
   info['status']=response.status;info['headers']={k:response.headers[k] for k in ['Content-Type','Server','CF-Ray','CF-Mitigated'] if response.headers.get(k)}
   data=json.load(response,object_pairs_hook=drop_sensitive)
  errors=data.get('errors') or [];info['errors']=[{'code':e.get('code'),'message':safe_error(e.get('message',''))} for e in errors if isinstance(e,dict)]
  report['requests'].append(info)
  return None if errors or data.get('success') is False else data
 except urllib.error.HTTPError as error:
  info['status']=error.code;info['headers']={k:error.headers[k] for k in ['Content-Type','Server','CF-Ray','CF-Mitigated'] if error.headers.get(k)}
  # Parse only standard JSON API error codes/messages; never retain arbitrary body.
  if 'json' in error.headers.get('Content-Type',''):
   try:
    data=json.load(error,object_pairs_hook=drop_sensitive);info['errors']=[{'code':e.get('code'),'message':safe_error(e.get('message',''))} for e in (data.get('errors') or []) if isinstance(e,dict)]
   except (ValueError,TypeError):info['errorBodyParsed']=False
  report['requests'].append(info);return None
 except Exception as error:
  info['errorType']=type(error).__name__;report['requests'].append(info);return None
# No preview-host connection, alternate hostname, forwarded Cookie or service token.
project=read('existing_pages_project','/accounts/'+ACCOUNT+'/pages/projects/'+PROJECT)
if project:
 p=project.get('result') or {};report['project']={k:p.get(k) for k in ['name','subdomain','domains','production_branch']}
 report['project']['accessProtectionPublicFlags']={k:v for k,v in p.items() if 'access' in k.lower() and isinstance(v,(bool,int,str))}
 report['project']['workerModeMetadata']={environment:{k:cfg.get(k) for k in ['usage_model','compatibility_date','fail_open']} for environment,cfg in (p.get('deployment_configs') or {}).items() if isinstance(cfg,dict)}
deployment=read('existing_preview_deployment','/accounts/'+ACCOUNT+'/pages/projects/'+PROJECT+'/deployments/'+DEPLOYMENT)
if deployment:
 p=deployment.get('result') or {};report['deployment']={k:p.get(k) for k in ['id','environment','url','aliases','is_skipped','created_on']}
 report['deployment']['latest_stage']={k:(p.get('latest_stage') or {}).get(k) for k in ['name','status','started_on','ended_on']}
 report['deployment']['trigger']={k:((p.get('deployment_trigger') or {}).get('metadata') or {}).get(k) for k in ['branch','commit_hash']}
apps=read('existing_access_applications','/accounts/'+ACCOUNT+'/access/apps?per_page=100')
if apps:
 records=apps.get('result') or [];related=[]
 for app in records:
  domains=[app.get('domain','')]+(app.get('self_hosted_domains') or [])
  if any(isinstance(d,str) and (PROJECT+'.pages.dev') in d for d in domains):
   related.append({'type':app.get('type'),'domain':app.get('domain'),'selfHostedDomains':[d for d in app.get('self_hosted_domains') or [] if isinstance(d,str)],'hasAud':bool(app.get('aud'))})
 report['accessApps']={'related':related,'listComplete':(apps.get('result_info') or {}).get('total_count',len(records))<=100}
# Settings discovery verifies existing requester capability, without reading other
# projects' traffic or granting/creating Analytics permissions.
query={'query':'query Capability($accountTag: string) { viewer { accounts(filter: {accountTag: $accountTag}) { settings { workersInvocationsAdaptive { enabled availableFields } } } } }','variables':{'accountTag':ACCOUNT}}
cap=read('existing_analytics_capability','/graphql',query)
if cap:
 accounts=((cap.get('data') or {}).get('viewer') or {}).get('accounts') or []
 report['analyticsCapability']=[(a.get('settings') or {}).get('workersInvocationsAdaptive') for a in accounts]
report['liveCpuMemoryMeasured']=False;report['resourceGatePassed']=False;report['performanceProductionHeld']=True
out=Path('.local/preview403-configuration');out.mkdir(parents=True,exist_ok=True);(out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'configurationReadStatuses':[{k:r.get(k) for k in ['resource','status','errorType']} for r in report['requests']],'previewRouteRequests':0,'deploymentsCreated':0,'resourceGatePassed':False}))
