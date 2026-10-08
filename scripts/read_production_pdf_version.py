"""Read one explicitly authorized non-secret production version; no other values retained."""
import datetime,json,os,re,urllib.request,urllib.error
from pathlib import Path
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
report={"checkedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"target":"production.PDF_GITHUB_COMMIT","readOnly":True,"projectRequests":1,"applicationRequests":0,"configWrites":0,"deploymentsCreated":0,"otherEnvironmentValuesRetained":False}
request=urllib.request.Request("https://api.cloudflare.com/client/v4/accounts/"+os.environ["CLOUDFLARE_ACCOUNT_ID"]+"/pages/projects/dryz-xinzhi",headers={"Authorization":"Bearer "+os.environ["CLOUDFLARE_API_TOKEN"]},method="GET")
try:
 with urllib.request.build_opener(NoRedirect()).open(request,timeout=25) as response:
  report["httpStatus"]=response.status
  data=json.load(response)
  if data.get("success"):
   config=(data.get("result") or {}).get("deployment_configs") or {}
   record=((config.get("production") or {}).get("env_vars") or {}).get("PDF_GITHUB_COMMIT")
   report["configured"]=record is not None
   value=record.get("value") if isinstance(record,dict) else None
   report["nonSecretVersionFormatValid"]=isinstance(value,str) and bool(re.fullmatch(r"[a-fA-F0-9]{40}",value))
   if report["nonSecretVersionFormatValid"]:report["commit"]=value.lower()
   elif record is not None:report["versionValueStatus"]="not-readable-as-an-exact-commit; no value retained"
  else:report["apiSuccess"]=False
except urllib.error.HTTPError as error:report["httpStatus"]=error.code
except Exception as error:report["errorType"]=type(error).__name__
out=Path(".local/pdf-version-read");out.mkdir(parents=True,exist_ok=True)
(out/"report.json").write_text(json.dumps(report,indent=2)+"\n")
print("SAFE_PDF_VERSION_REPORT "+json.dumps(report))

