"""One ordinary GET of the original public preview URL; no redirects or retries."""
import datetime, json, re, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
URL="https://3f577b35.dryz-xinzhi.pages.dev/public-data/3e5ac332ce377ae7a0254e49e987ee1f32455f5d609f135328339c23dda40267/FEEDS.json"
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def redact(text):
    text=re.sub(r"(?i)(token|secret|password|authorization|cookie|api[_-]?key)([\s:=]+)([^\s<>&]+)",r"\1\2[redacted]",text)
    text=re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b","[redacted-jwt]",text)
    text=re.sub(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b","[redacted-ip]",text)
    text=re.sub(r"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}","[redacted-email]",text)
    text=re.sub(r'(https?://[^\s"<>?]+)\?[^\s"<>]*',r"\1?[redacted-query]",text)
    return text[:2048]
allowed={"date","server","content-type","content-length","cache-control","cf-ray","cf-cache-status","cf-mitigated","retry-after","vary","x-request-id","x-correlation-id","x-webcache-source","x-webcache-request-guid","x-envoy-upstream-service-time","x-mitmproxy-blocked-reason","x-proxy-error","x-denied-reason","x-error-code","x-public-data-version"}
report={"requestUrl":URL,"method":"GET","startedAt":now(),"requestAttempts":1,"redirectsFollowed":0,"authenticationAdded":False,"cookiesAdded":False,"customUserAgent":False,"proxyChanges":False,"configWrites":0,"deploymentsCreated":0,"resourceGatePassed":False}
started=time.perf_counter()
try:
    opener=urllib.request.build_opener(NoRedirect())
    request=urllib.request.Request(URL,method="GET")
    try: response=opener.open(request,timeout=25)
    except urllib.error.HTTPError as error: response=error
    with response:
        report["status"]=response.status
        report["headers"]={k.lower():redact(v) for k,v in response.headers.items() if k.lower() in allowed}
        location=response.headers.get("Location")
        if location:
            parts=urllib.parse.urlsplit(location)
            report["redirectLocationWithoutQuery"]=urllib.parse.urlunsplit((parts.scheme,parts.netloc,parts.path,"",""))
        report["responseUrl"]=response.geturl()
        if response.status>=300:
            body=response.read(4096)
            report["errorBodyPrefix"]=redact(body.decode("utf-8",errors="replace"))
            report["retainedRawPrefixBytes"]=len(body)
        else:
            report["bodyRead"]=False
            report["note"]="Successful GET headers only; not a payload integrity or resource test"
    report["stopAfterResponse"]=True
except Exception as error:
    report["transportErrorType"]=type(error).__name__
    report["stopAfterError"]=True
report["endedAt"]=now()
report["wallMs"]=round((time.perf_counter()-started)*1000,2)
out=Path(".local/preview-response-once");out.mkdir(parents=True,exist_ok=True)
(out/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
print("SAFE_RESPONSE_REPORT "+json.dumps(report,ensure_ascii=False))

