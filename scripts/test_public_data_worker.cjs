'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const version='a'.repeat(64), other='b'.repeat(64), calls=[];
const data={FEEDS:{items:[{id:'a',title:'公开原摘要🙂',summary:'Do not execute window.FEEDS=evil; or leak unrelated sections.'}]},RADAR:{v:1,rows:[['1','10.1/a','2026-10-06',0,0,0,0,[],'A heart paper🙂']],jn:['J'],pub:['P'],tier:['T'],design:['RCT'],tag:[],abs:{1:[['结果','Full public abstract🙂']]}}};
data.RECENT_RADAR=data.RADAR;
const bundle='window.PUBLIC_DATA_VERSION="'+version+'";\n;\nwindow.LIBRARY='+JSON.stringify({papers:[{id:'full-library',title:'Unrelated retained identity'}]})+';\n;\n'+Object.entries(data).map(([n,v])=>'window.'+n+'='+JSON.stringify(v)+';').join('\n;\n')+'\n;\nthrow Error("Never execute data as JavaScript");';
const source=fs.readFileSync(path.join(__dirname,'../edge/public-data.js'),'utf8').replace("const PUBLIC_DATA_VERSION = '';",'const PUBLIC_DATA_VERSION = "'+version+'";');
const context=vm.createContext({URL,Request,Response,ReadableStream,TextEncoder,Uint8Array,Set});vm.runInContext(source,context);
const handler=vm.runInContext('handlePublicData',context);let checks=0;
const eq=(a,b)=>{assert.deepStrictEqual(a,b);checks++};
function environment(text=bundle, chunk=7, status=200) {
 let cancelled=false, drained=false;
 const env=new Proxy({ASSETS:{fetch:async request=>{
  calls.push(request);const bytes=new TextEncoder().encode(text);let offset=0;
  const stream=new ReadableStream({pull(c){if(offset===bytes.length){drained=true;c.close();return}c.enqueue(bytes.slice(offset,offset+chunk));offset=Math.min(bytes.length,offset+chunk)},cancel(){cancelled=true}});
  return new Response(stream,{status});
 }}},{get(target,key){assert.equal(key,'ASSETS','No credential/KV/model binding read');return target[key]}});
 return {env,cancelled:()=>cancelled || drained};
}
(async()=>{
 for(const chunk of [1,2,3,4,7,19,97,65536])for(const name of ['FEEDS','RECENT_RADAR','RADAR']){
  const fixture=environment(bundle,chunk);const request=new Request('https://fixture.invalid/public-data/'+version+'/'+name+'.json',{headers:{cookie:'secret-cookie',authorization:'Bearer private',range:'bytes=0-1'}});
  const response=await handler(request,fixture.env);eq(response.status,200);eq(await response.json(),data[name]);eq(response.headers.get('x-public-data-version'),version);eq(response.headers.get('cache-control'),'no-store');eq(fixture.cancelled(),true);
  const actual=calls.at(-1);eq(new URL(actual.url).pathname,'/public.js');eq([...actual.headers],[]);eq(actual.method,'GET');
 }
 for(const [url,method,status] of [['/public-data/'+other+'/FEEDS.json','GET',409],['/public-data/'+version+'/PRIVATE.json','GET',404],['/public-data/'+version+'/FEEDS.json','POST',405],['/public-data/'+version+'/FEEDS.json?path=/private.pdf','GET',200]]){
  const before=calls.length,response=await handler(new Request('https://fixture.invalid'+url,{method}),environment().env);eq(response.status,status);if(status!==200)eq(calls.length,before);else eq(await response.json(),data.FEEDS);
 }
 const wrong=await handler(new Request('https://fixture.invalid/public-data/'+version+'/FEEDS.json'),environment(bundle.replace(version,other)).env);eq(wrong.status,409);
 const missing=await handler(new Request('https://fixture.invalid/public-data/'+version+'/RADAR.json'),environment(bundle.split('\n;\nwindow.RADAR=')[0]).env);eq(missing.status,503);
 const truncated=await handler(new Request('https://fixture.invalid/public-data/'+version+'/RADAR.json'),environment(bundle.slice(0,bundle.indexOf('\n;\nwindow.RECENT_RADAR='))).env);await assert.rejects(()=>truncated.text());checks++;
 const head=await handler(new Request('https://fixture.invalid/public-data/'+version+'/FEEDS.json',{method:'HEAD'}),environment().env);eq(head.status,200);eq(await head.text(),'');
 const denial=environment('unavailable',7,503),denied=await handler(new Request('https://fixture.invalid/public-data/'+version+'/FEEDS.json'),denial.env);eq(denied.status,503);eq(denial.cancelled(),true);
 // Genuine cancellation/abort and upstream failures: assert no subsequent reads.
 function controlled(text, {chunk=8, abortAt=0, aborter=null, errorAt=0}={}) {
  const bytes=new TextEncoder().encode(text);let offset=0,reads=0,cancelled=0;
  const reader={async read(){reads++;if(abortAt===reads)aborter.abort();if(errorAt===reads)throw Error('ASSETS stream failure');await new Promise(r=>setTimeout(r,1));if(cancelled||offset===bytes.length)return {done:true};const value=bytes.slice(offset,offset+chunk);offset+=value.length;return {value,done:false}},async cancel(){cancelled++}};
  return {env:{ASSETS:{fetch:async()=>({ok:true,body:{getReader:()=>reader}})}},reads:()=>reads,cancelled:()=>cancelled};
 }
 const longBundle=bundle.replace('Unrelated retained identity','x'.repeat(10000)).replace('Full public abstract🙂','y'.repeat(10000));
 const aborter=new AbortController(),before=controlled(longBundle,{abortAt:3,aborter});
 const stopped=await handler(new Request('https://fixture.invalid/public-data/'+version+'/RADAR.json',{signal:aborter.signal}),before.env);
 eq(stopped.status,503);eq(before.cancelled()>0,true);const beforeReads=before.reads();await new Promise(r=>setTimeout(r,5));eq(before.reads(),beforeReads);
 for(const mode of ['cancel','abort']){
  const controller=new AbortController(),fixture=controlled(longBundle,{chunk:128}),response=await handler(new Request('https://fixture.invalid/public-data/'+version+'/RADAR.json',{signal:controller.signal}),fixture.env),body=response.body.getReader();
  await body.read();
  if(mode==='cancel')await body.cancel('reader closed');
  else {controller.abort();await assert.rejects(()=>body.read());checks++;}
  await new Promise(r=>setTimeout(r,5));eq(fixture.cancelled()>0,true);const count=fixture.reads();await new Promise(r=>setTimeout(r,5));eq(fixture.reads(),count);
 }
 const badBefore=controlled(longBundle,{errorAt:3});eq((await handler(new Request('https://fixture.invalid/public-data/'+version+'/RADAR.json'),badBefore.env)).status,503);eq(badBefore.cancelled()>0,true);
 const segmentFirst='window.PUBLIC_DATA_VERSION="'+version+'";\n;\nwindow.RADAR='+JSON.stringify({...data.RADAR,abs:{1:[['', 'x'.repeat(10000)]]}})+';\n;\n';
 const badDuring=controlled(segmentFirst,{chunk:128,errorAt:4}),badResponse=await handler(new Request('https://fixture.invalid/public-data/'+version+'/RADAR.json'),badDuring.env);await assert.rejects(()=>badResponse.text());checks++;eq(badDuring.cancelled()>0,true);
 console.log(JSON.stringify({passed:true,checks,scope:'byte-stream boundary, Unicode, version, method, credential isolation',networkCalls:0,modelCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1});
