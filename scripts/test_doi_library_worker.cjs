// Synthetic offline fixtures only. Never calls real GitHub, metadata/OA APIs or a model.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const {webcrypto,createHash}=require('crypto');
const source=fs.readFileSync(path.join(__dirname,'../edge/_worker.js'),'utf8');
const doi='10.1000/exact',title='Exact cardiovascular trial',commit='a'.repeat(40),file='期刊/试验.pdf';
const pdf=Buffer.from('%PDF-1.7\nSynthetic DOI fixture\n%%EOF\n');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const baseEnv={PDF_DOWNLOAD_ENABLED:'true',PDF_DOWNLOAD_PASSPHRASE:'synthetic-passphrase',GITHUB_LIBRARY_TOKEN:'synthetic-private-token',PDF_GITHUB_COMMIT:commit,FULLTEXT_ASYNC_ENABLED:'false'};
const key='library:paper:'+doi;
function csv(rows){const cell=s=>/[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;return [['题名','DOI','期刊','实际出版日期','日期来源','当前路径','SHA256'],...rows].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';}
const row=[title,doi,'Heart','2026-10-07','publisher',file,hash(pdf)];
function crossref(changes={}){return {message:{DOI:doi,title:[title],'container-title':['Heart'],author:[{given:'Jane',family:'Doe'}],'published-online':{'date-parts':[[2026,10,7]]},...changes}};}
function harness(options={}){
 const values=new Map(),writes=[],calls=[],reads=[],lists=[];let recordReads=0;const fixturePdf=options.pdfBytes||pdf;
 const kv={
  get:async(k,type)=>{reads.push({key:k,type});if(k===key&&options.onRecordRead){const result=await options.onRecordRead(++recordReads,values);if(result!==undefined)return result;}
   if(options.getError)throw Error('synthetic private storage failure');
   const value=values.get(k);if(value===undefined)return null;
   if(type==='json')return typeof value==='string'?JSON.parse(value):value;
   if(type==='arrayBuffer')return Buffer.isBuffer(value)?value.buffer.slice(value.byteOffset,value.byteOffset+value.length):value;
   return value;},
  put:async(k,value,opts)=>{writes.push({key:k,value,opts});if(options.putError&&options.putError(k)){const error=Error('synthetic storage write error');if(options.rateError)error.status=429;throw error;}values.set(k,typeof value==='string'?value:Buffer.from(value));},
  delete:async k=>{if(options.beforeDelete)options.beforeDelete(k,values);values.delete(k);},
  list:async opts=>{lists.push(opts);if(options.listError)throw Error('synthetic list failure');const keys=[...values.keys()].filter(k=>k.startsWith(opts.prefix)).sort();const offset=Number(opts.cursor||0),slice=keys.slice(offset,offset+opts.limit);return {keys:slice.map(name=>({name})),list_complete:offset+slice.length>=keys.length,...(offset+slice.length<keys.length?{cursor:String(offset+slice.length)}:{})};}
 };
 const fetch=async(url,init)=>{const u=new URL(url);calls.push({url:u,init});
  if(u.hostname==='github.com'){assert.equal(init.redirect,'manual');if(init.method==='GET'){assert.equal(u.pathname,'/dodoxiaxia/AI-.git/info/lfs/objects/'+hash(fixturePdf));assert.equal(init.headers.authorization,'RemoteAuth synthetic-download-token');return options.githubObject?options.githubObject(u,init):new Response(null,{status:302,headers:{location:'https://github-cloud.s3.amazonaws.com/alambic/media/'+hash(fixturePdf)}});}assert.equal(init.method,'POST');assert.equal(u.pathname,'/dodoxiaxia/AI-.git/info/lfs/objects/batch');assert.equal(init.headers.authorization,'Basic '+btoa('x-access-token:'+baseEnv.GITHUB_LIBRARY_TOKEN));assert.equal(JSON.parse(init.body).operation,'download');return options.lfsBatch?options.lfsBatch(u,init):Response.json({objects:[{oid:hash(fixturePdf),size:fixturePdf.length,actions:{download:{href:options.lfsUrl||'https://github-cloud.s3.amazonaws.com/alambic/media/'+hash(fixturePdf)}}}]});}
  if(u.hostname.startsWith('github-cloud.s3.')||u.hostname==='s3.us-west-2.amazonaws.com'){assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert(!init.headers.authorization);return options.lfsObject?options.lfsObject(u,init):new Response(fixturePdf);}
  assert.equal(init.method,'GET');assert(!u.href.includes(baseEnv.PDF_DOWNLOAD_PASSPHRASE));assert(!JSON.stringify(init.headers).includes(baseEnv.PDF_DOWNLOAD_PASSPHRASE));assert(!init.body);
  if(u.hostname==='token.actions.githubusercontent.com'){assert.equal(init.redirect,'manual');assert(!init.headers.authorization);return options.jwksResponse ? options.jwksResponse() : Response.json({keys:options.jwks||[]});}
  assert.equal(init.redirect,'manual');
  if(u.hostname==='api.crossref.org'){assert(!init.headers.authorization);return options.crossrefResponse?options.crossrefResponse(u,init):Response.json(crossref(options.crossref||{}));}
  if(u.hostname==='api.unpaywall.org'){assert(!init.headers.authorization);return options.unpaywallResponse?options.unpaywallResponse(u,init):Response.json(options.oa?{doi,title,is_oa:true,best_oa_location:{url_for_pdf:options.oaUrl||'https://journals.plos.org/article/fixture.pdf'}}:{doi,title,is_oa:false});}
  if(u.hostname==='api.openalex.org'){assert(!init.headers.authorization);if(options.openalexResponse)return options.openalexResponse(u,init);return Response.json(options.openalex||{doi:'https://doi.org/'+doi,title,open_access:{is_oa:false},locations:[]});}
  if(u.hostname==='api.github.com'){assert.equal(init.headers.authorization,'Bearer synthetic-private-token');const decoded=decodeURIComponent(u.pathname);if(decoded.endsWith('/commits/main'))return Response.json({sha:options.commit||commit});
   if(decoded.endsWith('/contents/文献索引/文献索引.csv')&&options.indexes){assert(Object.hasOwn(options.indexes,u.searchParams.get('ref')));return new Response(csv(options.indexes[u.searchParams.get('ref')]));}
   assert.equal(u.searchParams.get('ref'),options.commit||commit);
   if(decoded.endsWith('/contents/文献索引/文献索引.csv'))return new Response(csv(options.rows||[row]));
   if(decoded.endsWith('/contents/文献索引/按需全文增量.json'))return options.delta?Response.json(options.delta):new Response('missing',{status:404});
   assert(decoded.endsWith('/contents/'+file));if(init.headers.accept==='application/vnd.github+json')return Response.json(options.metadata||{type:'file',path:file,size:(options.pointer||fixturePdf).length,sha:blob(options.pointer||fixturePdf)});
   return options.githubPdfResponse?options.githubPdfResponse(u,init):new Response(options.pointer||fixturePdf,{headers:{'content-type':'application/pdf'}});}
  assert(u.hostname==='journals.plos.org'||u.hostname==='www.nature.com'||u.hostname==='raw.githubusercontent.com'||(options.pdfHosts||[]).includes(u.hostname),'unexpected external host '+u.hostname);assert(!init.headers.authorization);
  return options.pdfResponse?options.pdfResponse(u,init):new Response(pdf,{headers:{'content-type':'application/pdf'}});
 };
 const timers=options.fastTimers?(callback,ms)=>setTimeout(callback,Math.min(ms,15)):setTimeout;
 const ClockDate=options.clock?class extends Date {constructor(...args){super(...(args.length?args:[options.clock.now]));}static now(){return options.clock.now;}}:Date;
 const context=vm.createContext({URL,URLSearchParams,Response,Request,TextEncoder,TextDecoder,Uint8Array,AbortController,setTimeout:timers,clearTimeout,crypto:webcrypto,fetch,console,Date:ClockDate,atob,btoa});
 const policy=options.policy||{};
 vm.runInContext(source.replace('const PDF_LIBRARY = {};','const PDF_LIBRARY = '+JSON.stringify(options.registry||{})+';').replace('const DOI_ADJUDICATIONS = {};','const DOI_ADJUDICATIONS = '+JSON.stringify(policy)+';').replace('const FULLTEXT_OIDC_BUILD_KEYS = {};','const FULLTEXT_OIDC_BUILD_KEYS = '+JSON.stringify(options.buildKeys||{})+';').replace('export default {','globalThis.worker = {'),context);
 const env={...baseEnv,QL_KV:kv};
 const request=(route='/api/acquire',config={})=>{const query=config.query===undefined?'doi='+encodeURIComponent(config.doi||doi):config.query;const headers={'content-type':'application/x-www-form-urlencoded',...(config.headers||{})};const method=config.method||'POST';return context.worker.fetch(new Request('https://site.test'+route+(query?'?'+query:''),{method,headers,...(method==='POST'?{body:config.body===undefined?new URLSearchParams({passphrase:config.passphrase===undefined?baseEnv.PDF_DOWNLOAD_PASSPHRASE:config.passphrase}).toString():config.body}:{})}),{...env,...(config.env||{})});};
 return {context,values,writes,calls,reads,lists,env,request,kv};
}
async function error(response,status,code){assert.equal(response.status,status);const text=await response.text();assert(!text.includes(baseEnv.GITHUB_LIBRARY_TOKEN));assert(!text.includes(baseEnv.PDF_DOWNLOAD_PASSPHRASE));assert(!text.includes(file));const body=JSON.parse(text);assert.equal(body.ok,false);assert.equal(body.error,code);assert.equal(response.headers.get('cache-control'),'no-store');}
function record(fulltextStatus='available',changes={}){const paper={id:'doi-'+hash(doi).slice(0,16),doi,title,journal:'Heart',authors:['Jane Doe'],date:'2026-10-07',datePrecision:'day',dateBasis:'Crossref published-online',ingestedAt:'2026-10-07T04:00:00Z',metadataStatus:'external_bibliography_checked',fulltextStatus,...changes};return {version:1,paper,...(fulltextStatus==='available'?{pdf:{key:'library:pdf:'+hash(pdf),sha256:hash(pdf),size:pdf.length,source:'oa'}}:{})};}
function seed(h,rec=record()){h.values.set(key,JSON.stringify(rec));h.values.set('library:pdf:'+hash(pdf),pdf);}
function passiveHtml(html){
 assert(!/<script\b/i.test(html),'retry pages never run automatic acquisition scripts');
 assert(!/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html),'retry pages never automatically refresh');
 assert(!/\bon(?:load|click|submit)\s*=/i.test(html),'retry requires explicit form submission');
 assert(!html.includes(baseEnv.PDF_DOWNLOAD_PASSPHRASE));
 assert(!html.includes(baseEnv.GITHUB_LIBRARY_TOKEN));
}
module.exports={harness,doi,title,pdf,hash,record,seed,error};
if(require.main===module)(async()=>{
 let h=harness();
 for(const route of ['/api/acquire','/api/fulltext']){const res=await h.request(route,{method:'GET',env:{QL_KV:undefined,GITHUB_LIBRARY_TOKEN:undefined,PDF_DOWNLOAD_ENABLED:undefined}});assert.equal(res.status,200);assert.equal(res.headers.get('referrer-policy'),'same-origin');const html=await res.text();assert(html.includes('method="post"'));assert(html.includes('autocomplete="current-password"'));assert(!html.includes(baseEnv.PDF_DOWNLOAD_PASSPHRASE));}
 assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
 const missing=await h.request('/api/library',{method:'GET'});assert.deepEqual(await missing.json(),{ok:true,found:false,paused:false});assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
 for(const phrase of ['','wrong',baseEnv.PDF_DOWNLOAD_PASSPHRASE+'x']){h=harness();await error(await h.request('/api/acquire',{passphrase:phrase}),403,'pdf_passphrase_invalid');assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);assert.equal(h.reads.length,0);}
 for(const body of ['passphrase=x&passphrase=y','passphrase=x&doi='+doi,'password=x']){h=harness();await error(await h.request('/api/acquire',{body}),400,'pdf_bad_form');assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);}
 h=harness();await error(await h.request('/api/acquire',{body:'passphrase='+('x'.repeat(2048))}),413,'pdf_body_too_large');
 for(const headers of [{origin:'null'},{origin:'https://attacker.example'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'}]){h=harness();await error(await h.request('/api/acquire',{headers}),403,'pdf_origin');assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);}
 for(const query of ['doi='+doi+'&passphrase=wrong','doi='+doi+'&doi='+doi,'doi=10.1000/test%3Fsecret','doi=not-a-doi']){h=harness();await error(await h.request('/api/acquire',{query}),400,'library_bad_doi');assert.equal(h.calls.length,0);}
 h=harness();await error(await h.request('/api/acquire',{env:{QL_KV:undefined}}),503,'library_not_configured');
 h=harness();await error(await h.request('/api/acquire',{env:{PDF_DOWNLOAD_ENABLED:undefined}}),503,'library_disabled');
 h=harness();await error(await h.request('/api/acquire',{env:{GITHUB_LIBRARY_TOKEN:undefined}}),503,'library_not_configured');assert.equal(h.calls.length,0);assert(h.writes.every(w=>w.key.startsWith('library:diagnostic:')));

 h=harness();const acquired=await h.request('/api/acquire',{doi:'HTTPS://DX.DOI.ORG/10.1000/EXACT'});assert.equal(acquired.status,200);const success=await acquired.json();assert.equal(success.paper.id,'doi-'+hash(doi).slice(0,16));assert.equal(success.paper.fulltextStatus,'available');assert.equal(success.paper.metadataStatus,'external_bibliography_checked');assert.equal(success.paper.authors[0],'Jane Doe');assert(success.downloadUrl.startsWith('/api/fulltext?doi='));
 assert(h.calls[0].url.hostname==='api.crossref.org');assert.equal(h.calls.filter(c=>c.url.hostname==='api.github.com').length,3);
 const binWrite=h.writes.findIndex(w=>w.key.startsWith('library:pdf:')),paperWrite=h.writes.findIndex(w=>w.key===key);assert(binWrite>=0&&paperWrite>binWrite);assert.equal(typeof h.writes[binWrite].value,'object');assert(h.writes.every(w=>w.key.startsWith('library:')));
 const stored=JSON.parse(h.values.get(key));assert.equal(stored.pdf.key,'library:pdf:'+hash(pdf));assert.equal(stored.pdf.source,'github');
 const before=h.calls.length,writesBefore=h.writes.length;const repeat=await h.request('/api/acquire');assert.equal(repeat.status,200);assert.equal((await repeat.json()).cached,true);assert.equal(h.calls.length,before);assert.equal(h.writes.length,writesBefore);
 const exact=await h.request('/api/library',{method:'GET',doi:'doi: 10.1000/EXACT'});assert.equal((await exact.json()).paper.doi,doi);assert.equal(h.calls.length,before);
 const download=await h.request('/api/fulltext');assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/pdf');assert(download.headers.get('content-disposition').startsWith('attachment;'));assert.deepEqual(Buffer.from(await download.arrayBuffer()),pdf);assert.equal(h.calls.length,before);
 await error(await h.request('/api/fulltext',{passphrase:'wrong'}),403,'pdf_passphrase_invalid');
 h.values.set(stored.pdf.key,Buffer.from('%PDF-1.7\nChanged bytes\n%%EOF\n'));await error(await h.request('/api/fulltext'),502,'library_integrity');
 h.values.delete(stored.pdf.key);await error(await h.request('/api/fulltext'),503,'library_sync_pending');await error(await h.request('/api/acquire'),503,'library_sync_pending');assert.equal(h.calls.length,before);

 h=harness({rows:[],oa:true});assert.equal((await h.request()).status,200);assert.equal(JSON.parse(h.values.get(key)).pdf.source,'oa');assert(h.calls.some(c=>c.url.hostname==='journals.plos.org'));
 h=harness({rows:[],oa:false});const pending=await h.request();assert.equal(pending.status,202);assert.equal((await pending.json()).status,'manual_needed');assert(!JSON.parse(h.values.get(key)).pdf);assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));assert.equal((await (await h.request()).json()).status,'manual_needed');
 h=harness({crossref:{DOI:'10.1000/other'}});await error(await h.request(),409,'library_identity');assert.equal(h.calls.length,1);assert(!h.values.has(key));const bad=await h.request('/api/library',{method:'GET'});assert.equal((await bad.json()).status,'review');
 h=harness({crossrefResponse:()=>new Response('not found',{status:404}),policy:{sourceCommit:commit,decisions:{[doi]:{action:'hold',acceptedTitles:[],metadata:null}}}});await error(await h.request(),404,'library_metadata_unavailable');assert.equal(h.calls.length,1);assert(!h.values.has(key));
 h=harness({policy:{sourceCommit:commit,decisions:{[doi]:{action:'hold',acceptedTitles:[],metadata:null}}},oa:true});assert.equal((await h.request()).status,200);assert(!h.calls.some(c=>c.url.hostname==='api.github.com'));
 h=harness({rows:[[...row.slice(0,1),'10.1000/other',...row.slice(2)]]});assert.equal((await h.request()).status,202);
 for(const rows of [[row,row],[[ 'Wrong title',...row.slice(1)]],[[...row.slice(0,6),'invalid-sha']]]){h=harness({rows});const res=await h.request();assert.equal(res.status,202);assert.equal((await res.json()).status,'review');assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));}
 h=harness({rows:[['Accepted variant',...row.slice(1)]],policy:{sourceCommit:commit,decisions:{[doi]:{action:'official',acceptedTitles:['Accepted variant'],metadata:{title}}}}});assert.equal((await h.request()).status,200);
 h=harness({rows:[['Accepted variant',...row.slice(1)]],commit:'b'.repeat(40),policy:{sourceCommit:commit,decisions:{[doi]:{action:'official',acceptedTitles:['Accepted variant'],metadata:{title}}}}});const changed=await h.request('/api/acquire',{env:{PDF_GITHUB_COMMIT:'b'.repeat(40)}});assert.equal((await changed.json()).status,'review');
 h=harness({rows:[],unpaywallResponse:()=>Response.json({doi:'10.1000/other',title,is_oa:true,best_oa_location:{url_for_pdf:'https://journals.plos.org/article/fixture.pdf'}})});const wrongOa=await h.request();assert.equal((await wrongOa.json()).status,'review');assert(!h.calls.some(c=>c.url.hostname==='journals.plos.org'));
 for(const oaUrl of ['https://127.0.0.1/file.pdf','https://2130706433/file.pdf','https://[::1]/file.pdf','http://journals.plos.org/file.pdf','https://journals.plos.org.attacker.example/file.pdf','https://user:secret@journals.plos.org/file.pdf','https://journals.plos.org:8443/file.pdf']){h=harness({rows:[],oa:true,oaUrl});assert.equal((await (await h.request()).json()).status,'review');assert(!h.calls.some(c=>!['api.crossref.org','api.github.com','api.unpaywall.org','api.openalex.org'].includes(c.url.hostname)));}
 h=harness({rows:[],oa:true,pdfResponse:()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/secret.pdf'}})});assert.equal((await (await h.request()).json()).status,'review');assert.equal(h.calls.filter(c=>c.url.hostname==='journals.plos.org').length,1);
 h=harness({rows:[],oa:true,pdfResponse:()=>new Response(null,{status:302,headers:{location:'https://www.nature.com/article/file.pdf'}})});assert.equal((await (await h.request()).json()).status,'review','bounded repeated redirects never download');
 for(const pdfResponse of [()=>new Response('<html>error</html>',{headers:{'content-type':'application/pdf'}}),()=>new Response('%PDF-1.7 missing end',{headers:{'content-type':'application/pdf'}}),()=>new Response(null,{headers:{'content-type':'application/pdf','content-length':String(10*1024*1024+1)}})]){h=harness({rows:[],oa:true,pdfResponse});assert.equal((await (await h.request()).json()).status,'review');assert(!h.writes.some(w=>w.key.startsWith('library:pdf:')));}
 h=harness({rows:[],oa:true,fastTimers:true,pdfResponse:(_u,init)=>new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(Error('fixture body timeout')));}}),{headers:{'content-type':'application/pdf'}})});await error(await h.request(),504,'library_timeout');assert(!h.values.has(key));assert(JSON.parse(h.values.get('library:attempt:'+doi)).retryAfter>Date.now());

 for(const putError of [k=>k.startsWith('library:pdf:'),k=>k===key]){h=harness({putError});await error(await h.request(),503,'library_storage');assert(!h.values.has(key));}
 h=harness({putError:k=>k.startsWith('library:cap:'),rateError:true});await error(await h.request(),429,'library_retry_later');assert.equal(h.calls.length,0);
 h=harness({onRecordRead:(n,values)=>{if(n===2){const ready=record();values.set(key,JSON.stringify(ready));values.set(ready.pdf.key,pdf);return ready;}} ,rows:[],oa:false});const raced=await h.request();assert.equal(raced.status,200);assert.equal((await raced.json()).status,'available');assert(!h.writes.some(w=>w.key===key));
 h=harness();h.values.set('library:lock:'+doi,JSON.stringify({owner:'other-owner',until:Date.now()+60000}));await error(await h.request(),409,'library_busy');assert.equal(h.calls.length,0);
 h=harness({crossrefResponse:()=>{h.values.set('library:lock:'+doi,JSON.stringify({owner:'another-owner',until:Date.now()+60000}));return Response.json(crossref());}});assert.equal((await h.request()).status,200);assert.equal(JSON.parse(h.values.get('library:lock:'+doi)).owner,'another-owner');
 h=harness();const today=new Date().toISOString().slice(0,10);h.values.set('library:cap:'+today,'30');await error(await h.request(),429,'library_limit');assert.equal(h.calls.length,0);

 // Genuine temporary failure retains its deadline; no-source/manual cases have separate tests.
 const fixedNow=Date.parse('2026-10-07T04:05:06.000Z'),clock={now:fixedNow};
 const attemptKey='library:attempt:'+doi;
 h=harness({rows:[],clock,unpaywallResponse:()=>new Response('temporary',{status:503,headers:{'retry-after':'120'}})});
 const temporary=await h.request();await error(temporary,502,'library_upstream');
 const deadline=JSON.parse(h.values.get(attemptKey)).retryAfter;assert.equal(deadline,fixedNow+120000);
 const callsAtFailure=h.calls.length,writesAtFailure=h.writes.length;clock.now+=65000;
 const early=await h.request();await error(early,429,'library_retry_later');assert.equal(early.headers.get('retry-after'),'55');
 assert.equal(h.calls.length,callsAtFailure);assert.equal(h.writes.length,writesAtFailure);assert.equal(JSON.parse(h.values.get(attemptKey)).retryAfter,deadline);
 const publicRetry=await (await h.request('/api/library',{method:'GET'})).json();assert.equal(publicRetry.status,'pending');assert.equal(publicRetry.retryAfter,deadline);
 const formResponse=await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}});assert.equal(formResponse.headers.get('retry-after'),'55');assert((await formResponse.text()).includes('55 秒后手动重试'));
 h=harness({rows:[[ 'Wrong title',...row.slice(1)]],clock:{now:fixedNow}});const reviewResponse=await h.request('/api/acquire',{headers:{accept:'text/html'}}),reviewHtml=await reviewResponse.text();assert.equal(reviewResponse.status,202);assert(reviewHtml.includes('等待不代表核验会自动完成'));assert(!reviewHtml.includes('后手动重试'));assert.equal(reviewResponse.headers.get('retry-after'),null);passiveHtml(reviewHtml);
 h=harness({clock:{now:fixedNow}});h.values.set('library:lock:'+doi,JSON.stringify({owner:'other-owner',until:fixedNow+41000}));
 const busy=await h.request(),busyBody=await busy.clone().json();await error(busy,409,'library_busy');assert.equal(busyBody.retryAfter,fixedNow+41000);assert.equal(busyBody.retryAfterSeconds,41);assert.equal(busy.headers.get('retry-after'),'41');assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
 h=harness({clock:{now:fixedNow}});h.values.set('library:cap:2026-10-07','30');
 const capped=await h.request(),cappedBody=await capped.clone().json();await error(capped,429,'library_limit');assert.equal(cappedBody.retryAfter,Date.parse('2026-10-08T00:00:00.000Z'));assert.equal(cappedBody.retryAfterSeconds,71694);assert.equal(capped.headers.get('retry-after'),'71694');assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
 const cappedHtml=await (await h.request('/api/acquire',{headers:{accept:'text/html'}})).text();assert(cappedHtml.includes('额度重置后可再试'));assert(cappedHtml.includes('北京时间 2026-10-08 08:00:00 起'));passiveHtml(cappedHtml);
 h=harness({clock:{now:fixedNow},putError:k=>k.startsWith('library:cap:'),rateError:true});const kvLimited=await h.request(),kvLimitedBody=await kvLimited.clone().json();await error(kvLimited,429,'library_retry_later');assert.equal(kvLimitedBody.retryAfter,fixedNow+60000);assert.equal(kvLimited.headers.get('retry-after'),'60');assert.equal(h.calls.length,0);
 h=harness({clock:{now:fixedNow}});seed(h);h.values.delete('library:pdf:'+hash(pdf));
 for(const route of ['/api/fulltext','/api/acquire']){
  const syncing=await h.request(route),syncBody=await syncing.clone().json();await error(syncing,503,'library_sync_pending');assert.equal(syncBody.retryAfter,fixedNow+60000);assert.equal(syncBody.retryAfterSeconds,60);assert.equal(syncing.headers.get('retry-after'),'60');
  const syncHtml=await (await h.request(route,{headers:{accept:'text/html'}})).text();assert(syncHtml.includes('1 分钟后手动重试'));assert(syncHtml.includes('北京时间 2026-10-07 12:06:06 起'));assert(syncHtml.includes('href="'+route+'?doi=10.1000%2Fexact"'));passiveHtml(syncHtml);
 }
 assert.equal(h.calls.length,0);assert.equal(h.writes.length,0,'checking storage synchronization must not trigger acquisition');
 h=harness({clock:{now:fixedNow}});seed(h);h.values.set(attemptKey,JSON.stringify({status:'pending',retryAfter:fixedNow+300000}));
 const readyLookup=await (await h.request('/api/library',{method:'GET'})).json();assert.equal(readyLookup.found,true);assert.equal(readyLookup.status,'available');assert(!Object.hasOwn(readyLookup,'retryAfter'));assert(!Object.hasOwn(readyLookup,'retryAfterSeconds'));
 const readyForm=await h.request('/api/acquire',{method:'GET',headers:{accept:'text/html'}}),readyFormHtml=await readyForm.text();assert.equal(readyForm.status,200);assert.equal(readyForm.headers.get('retry-after'),null);assert(!readyFormHtml.includes('后手动重试'));assert(!readyFormHtml.includes('北京时间'));passiveHtml(readyFormHtml);
 assert.equal(h.calls.length,0);assert.equal(h.writes.length,0,'an observed successful record supersedes a stale failed-attempt deadline');

 h=harness();seed(h,record('available',{hash:'secret',doctorApproved:true,hasDraft:true,draftData:{secret:'private'},repo_path:file}));let listing=await h.request('/api/library',{method:'GET',query:''});assert.equal(listing.status,200);const listed=await listing.json();assert.equal(listed.papers.length,1);assert(!JSON.stringify(listed).includes(file));for(const field of ['hash','doctorApproved','hasDraft','draftData','repo_path','pdf','sha256','key'])assert(!Object.hasOwn(listed.papers[0],field));assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
 await h.request('/api/library',{method:'GET',query:''});assert.equal(h.lists.length,1,'public short cache reduces list operations');
 h=harness();seed(h,record('available',{doi:'10.1000/other'}));assert.equal((await (await h.request('/api/library',{method:'GET'})).json()).found,false);assert.equal((await (await h.request('/api/library',{method:'GET',query:''})).json()).papers.length,0);await error(await h.request('/api/fulltext'),404,'library_not_found');const repaired=await h.request();assert.equal(repaired.status,200);assert.equal((await repaired.json()).paper.doi,doi);assert.equal(JSON.parse(h.values.get(key)).paper.doi,doi);
 h=harness({onRecordRead:(n,values)=>{if(n===3){const ready=record();values.set(key,JSON.stringify(ready));values.set(ready.pdf.key,pdf);return ready;}}});assert.equal((await h.request()).status,200);assert(!h.writes.some(w=>w.key===key),'last ready recheck prevents replacing observed concurrent success');
 h=harness();seed(h,record('available',{title:'/Users/private/paper.pdf'}));assert.equal((await (await h.request('/api/library',{method:'GET'})).json()).found,false);
 h=harness();for(let i=0;i<21;i++){const d='10.1000/p'+i,rec=record('pending',{doi:d,id:'doi-'+hash(d).slice(0,16)});h.values.set('library:paper:'+d,JSON.stringify(rec));}const page1=await (await h.request('/api/library',{method:'GET',query:''})).json();assert.equal(page1.papers.length,20);assert(page1.cursor);const page2=await (await h.request('/api/library',{method:'GET',query:'cursor='+page1.cursor})).json();assert.equal(page2.papers.length,1);await error(await h.request('/api/library',{method:'GET',query:'limit=21'}),400,'library_bad_doi');
 h=harness({listError:true});await error(await h.request('/api/library',{method:'GET',query:''}),503,'library_storage');
 console.log('DOI library offline tests passed: read-only GET, password, DOI identity, GitHub/OA links, safe URLs, body limits/timeouts, KV binaries/soft guards, durable records, downloads, public projection and persisted manual retry deadlines.');
})().catch(error=>{console.error(error);process.exitCode=1;});
