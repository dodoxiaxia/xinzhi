"""Exact existing Pages deployment metadata only; no application route probes."""
import os,json,datetime,urllib.request,urllib.error
from pathlib import Path
ACCOUNT=os.environ['CLOUDFLARE_ACCOUNT_ID'];TOKEN=os.environ['CLOUDFLARE_API_TOKEN'];BASE='https://api.cloudflare.com/client/v4';PROJECT='dryz-xinzhi';PREVIEW='3f577b35-9077-4c4f-be65-e2079d3a5c56'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
client=urllib.request.build_opener(NoRedirect())
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'previewRouteRequests':0,'accessApiRequests':0,'metricsApiRequests':0,'deploymentsCreated':0,'configWrites':0,'resourceGatePassed':False,'requests':[]}
def discard_private(pairs):
 return {k:v for k,v in pairs if k not in {'env_vars','environment_variables','secrets','token','client_secret','clientSecret','credentials','authentication','private_key','web_analytics_token'}}
def read(label,path):
 req=urllib.request.Request(BASE+path,headers={'Authorization':'Bearer '+TOKEN},method='GET');entry={'resource':label,'retried':False}
 try:
  with client.open(req,timeout=25) as response:entry['status']=response.status;data=json.load(response,object_pairs_hook=discard_private)
  report['requests'].append(entry);return data.get('result') if data.get('success') else None
 except urllib.error.HTTPError as error:entry['status']=error.code;report['requests'].append(entry);return None
 except Exception as error:entry['errorType']=type(error).__name__;report['requests'].append(entry);return None

def summarize_deployment(data):
 if not isinstance(data,dict):return None
 result={k:data.get(k) for k in ['id','environment','url','aliases','is_skipped','created_on']}
 result['usesFunctionsFieldPresent']='uses_functions' in data;result['uses_functions']=data.get('uses_functions')
 result['latestStage']={k:(data.get('latest_stage') or {}).get(k) for k in ['name','status','ended_on']}
 result['triggerMetadata']={k:((data.get('deployment_trigger') or {}).get('metadata') or {}).get(k) for k in ['branch','commit_hash','commit_dirty']}
 result['publicFunctionRelatedFlags']={k:v for k,v in data.items() if any(t in k.lower() for t in ['function','route','worker']) and isinstance(v,(bool,str,int))}
 return result
project=read('current_pages_project','/accounts/'+ACCOUNT+'/pages/projects/'+PROJECT)
if project:
 report['project']={k:project.get(k) for k in ['name','subdomain','domains','production_branch']}
 configs={}
 for environment in ['preview','production']:
  cfg=(project.get('deployment_configs') or {}).get(environment) or {}
  safe={k:cfg.get(k) for k in ['compatibility_date','compatibility_flags','usage_model','fail_open','limits','placement','always_use_latest_compatibility_date']}
  # Binding names/types only; no namespace IDs, service URLs or secret values.
  for kind in ['kv_namespaces','services','r2_buckets','d1_databases','durable_object_namespaces','ai_bindings','analytics_engine_datasets']:
   safe[kind+'BindingNames']=sorted((cfg.get(kind) or {}).keys())
  configs[environment]=safe
 report['deploymentConfiguration']=configs;report['previewProductionConfigurationDifferences']={k:{e:c.get(k) for e,c in configs.items()} for k in configs['preview'] if configs['preview'].get(k)!=configs['production'].get(k)}
 report['canonicalProductionDeployment']=summarize_deployment(project.get('canonical_deployment'))
 preview=read('exact_existing_preview_deployment','/accounts/'+ACCOUNT+'/pages/projects/'+PROJECT+'/deployments/'+PREVIEW)
 report['exactPreviewDeployment']=summarize_deployment(preview)
 production=(project.get('canonical_deployment') or {}).get('id')
 if production:report['exactCanonicalProductionDeployment']=summarize_deployment(read('exact_existing_production_deployment','/accounts/'+ACCOUNT+'/pages/projects/'+PROJECT+'/deployments/'+production))
out=Path('.local/preview-functions-metadata');out.mkdir(parents=True,exist_ok=True);(out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'requests':report['requests'],'previewUsesFunctions':(report.get('exactPreviewDeployment') or {}).get('uses_functions'),'productionUsesFunctions':(report.get('exactCanonicalProductionDeployment') or {}).get('uses_functions'),'previewRouteRequests':0,'resourceGatePassed':False}))
