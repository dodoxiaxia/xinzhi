"""One preview deployment; public GET/HEAD probes only, no production or model writes."""
import concurrent.futures, hashlib, json, os, re, subprocess, time, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
out = ROOT / '.local/lazy-preview'; out.mkdir(parents=True, exist_ok=True)
report = {'productionChanged': False, 'modelCalls': 0, 'stateWrites': 0, 'probes': [], 'resourceGatePassed': False}
try:
    log = (out/'deploy.txt').read_text()
    urls = re.findall(r'https://[a-f0-9]+\.dryz-xinzhi\.pages\.dev', log)
    if not urls: raise ValueError('Preview URL not present in deployment result')
    base = urls[-1]; report['previewUrl'] = base
    # Existing deployment credentials are consumed normally, never printed or saved.
    api = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/pages/projects/dryz-xinzhi/deployments'
    req = urllib.request.Request(api, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']})
    with urllib.request.urlopen(req, timeout=30) as response: deployments = json.load(response)
    matching = [d for d in deployments.get('result', []) if d.get('url') == base and d.get('environment') == 'preview']
    if len(matching) != 1: raise ValueError('Cannot identify isolated preview deployment')
    deployment = matching[0]['id']; report['deploymentId'] = deployment
    source = (ROOT/'public/public.js').read_text(); version = re.match(r'window.PUBLIC_DATA_VERSION="([a-f0-9]{64})";', source).group(1)
    report['version'] = version
    expected = {}
    for name in ['FEEDS','RECENT_RADAR','RADAR']:
        start = source.index('window.' + name + '=') + len('window.' + name + '=')
        value, length = json.JSONDecoder().raw_decode(source[start:]); expected[name] = source[start:start+length].encode()
    # Only this isolated preview is tailed. Sanitize before retaining any evidence.
    raw = out/'tail.tmp'
    with raw.open('w') as stdout:
        tail = subprocess.Popen(['npx','--yes','wrangler@3','pages','deployment','tail',deployment,'--project-name','dryz-xinzhi','--format','json'], stdout=stdout, stderr=subprocess.DEVNULL)
        try:
            time.sleep(8)
            def probe(name, method, phase):
                begin = time.perf_counter(); request = urllib.request.Request(base+'/public-data/'+version+'/'+name+'.json', method=method)
                with urllib.request.urlopen(request, timeout=30) as response:
                    ttfb = (time.perf_counter()-begin)*1000; body = response.read(); status = response.status
                    actual_version = response.headers.get('x-public-data-version')
                if status != 200 or actual_version != version: raise ValueError('Preview response/version mismatch')
                if method == 'GET' and body != expected[name]: raise ValueError('Preview data differs from exact reviewed public assignment')
                if method == 'HEAD' and body: raise ValueError('HEAD returned a body')
                return {'name':name,'method':method,'phase':phase,'status':status,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'ttfbMs':round(ttfb,2),'wallMs':round((time.perf_counter()-begin)*1000,2)}
            for name in expected:
                for method in ['GET','HEAD']: report['probes'].append(probe(name,method,'first-request'))
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                futures = [pool.submit(probe,name,method,'concurrent-six') for name in expected for method in ['GET','HEAD']]
                report['probes'].extend(f.result() for f in futures)
            time.sleep(5)
        finally:
            tail.terminate()
            try: tail.wait(timeout=5)
            except subprocess.TimeoutExpired: tail.kill(); tail.wait()
    traces = []; text = raw.read_text(); decoder = json.JSONDecoder(); pos = 0
    while pos < len(text):
        start = text.find('{',pos)
        if start < 0: break
        try: obj, length = decoder.raw_decode(text[start:]); pos = start+length
        except ValueError: pos = start+1; continue
        request = obj.get('event',{}).get('request',{})
        if request.get('url','').startswith(base+'/public-data/'):
            traces.append({k:obj.get(k) for k in ['outcome','cpuTime','wallTime','peakMemoryBytes']})
    raw.unlink(missing_ok=True)
    report['traces'] = traces; report['httpGatePassed'] = len(report['probes']) == 12
    report['cpuMeasured'] = bool(traces) and all(isinstance(t.get('cpuTime'),(int,float)) for t in traces)
    report['memoryMeasured'] = bool(traces) and all(isinstance(t.get('peakMemoryBytes'),(int,float)) for t in traces)
    report['resourceGatePassed'] = report['cpuMeasured'] and report['memoryMeasured'] and all(t['outcome']=='ok' and t['cpuTime']<=10 and t['peakMemoryBytes']<128*1024*1024 for t in traces)
    if not report['resourceGatePassed']: report['remainingBlocker'] = 'Actual CPU/memory measurements unavailable or outside conservative existing-platform limits; production lazy-data release remains held.'
except Exception as error:
    # Error strings can contain account identifiers; retain only type and HTTP status.
    report['error'] = {'type': type(error).__name__, 'httpStatus': getattr(error,'code',None)}
finally:
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'previewUrl':report.get('previewUrl'),'httpGatePassed':report.get('httpGatePassed',False),'resourceGatePassed':report['resourceGatePassed'],'requests':len(report['probes']),'modelCalls':0,'productionChanged':False}))
