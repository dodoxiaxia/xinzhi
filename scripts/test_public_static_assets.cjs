'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const c=vm.createContext({URL,Request,Response,Headers});vm.runInContext(fs.readFileSync('edge/public-static-assets.js','utf8'),c);const handler=vm.runInContext('publicStaticData',c);
let checks=0;const eq=(a,b,label)=>{assert.deepStrictEqual(a,b,label);checks++};
(async()=>{
 for(const name of ['feeds','recent_radar','radar'])for(const method of ['GET','HEAD']){
  let calls=0;
  const env=new Proxy({ASSETS:{fetch:async request=>{calls++;eq(new URL(request.url).pathname,'/public-data/'+name+'.'+'a'.repeat(64)+'.json');eq(request.method,method);eq([...request.headers],[['if-none-match','"known"']]);const response=new Response(method==='HEAD'?null:'not parsed on server 🙂',{headers:{'content-type':'application/json','etag':'"known"'}});response.text=response.json=response.arrayBuffer=()=>{throw Error('Must never parse or read body')};return response;}}},{get(t,k){eq(k,'ASSETS','No private binding access');return t[k]}});
  const response=await handler(new Request('https://fixture.invalid/public-data/'+name+'.'+'a'.repeat(64)+'.json',{method,headers:{cookie:'private-cookie',authorization:'Bearer private',range:'bytes=0-1','if-none-match':'"known"'}}),env);
  eq(calls,1,'one exact static asset read');eq(response.status,200);eq(response.headers.get('cache-control'),'public, max-age=31536000, immutable');eq(await response.text(),method==='HEAD'?'':'not parsed on server 🙂');
 }
 for(const path of ['/public-data/private.pdf','/public-data/radar.json','/public-data/feeds.'+'A'.repeat(64)+'.json']){const r=await handler(new Request('https://fixture.invalid'+path),{});eq(r.status,404);eq(r.headers.get('cache-control'),'no-store')}
 eq((await handler(new Request('https://fixture.invalid/public-data/feeds.'+'a'.repeat(64)+'.json',{method:'POST'}),{})).status,405);
 for(const [status,type,expected]of [[200,'text/html',404],[404,'text/html',404],[503,'text/html',503],[304,'',304]]){
  const env={ASSETS:{fetch:async()=>new Response(status===304?null:'Missing asset SPA shell',{status,headers:{'content-type':type}})}};
  const r=await handler(new Request('https://fixture.invalid/public-data/feeds.'+'a'.repeat(64)+'.json'),env);eq(r.status,expected);eq(r.headers.get('cache-control'),expected===304?'public, max-age=31536000, immutable':'no-store');
 }
 console.log(JSON.stringify({passed:true,checks,modelCalls:0,networkCalls:0,bodyParsingOrScanning:false}));
})().catch(e=>{console.error(e);process.exitCode=1});
