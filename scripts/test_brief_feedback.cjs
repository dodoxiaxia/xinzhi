'use strict';
// Actual frontend functions and Worker routes; synthetic fetch/KV only.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const start=src.indexOf('  function briefItems('),end=src.indexOf('  // ---- Public-abstract study services:',start);
const helper=n=>src.match(new RegExp('  function '+n+'\\([^]*?\\n  }'))[0];
const extra=['aiRequest','aiRun','recordTask','aiTaskStatus','aiWaitingMessage'].map(helper).join('\n');
const doiFn=src.match(/  function exactDoi\([^]*?\n  }/)[0];
let reply, calls=[], ticks=new Map(),serial=0,renders=0;
const node={};
const c=vm.createContext({URL,AbortController,console,Set,Map,JSON,Promise,
 setTimeout:(fn,ms)=>{const id=++serial;ticks.set(id,{fn,ms});return id;},clearTimeout:id=>ticks.delete(id),
 fetch:(url,options)=>{calls.push({url,options});return reply(url,options);},
 state:{mode:'candidates',search:''},$ :()=>node,showToast:()=>{},esc:s=>String(s).replaceAll('<','&lt;'),aiErrorMessage:j=>j.detail==='request_timeout'?'模型服务响应超时，请稍后重试。':'离线错误'});
vm.runInContext('const BRIEFS={};let AI_AVAIL=true;\n'+doiFn+'\n'+extra+'\n'+src.slice(start,end)+'\nObject.assign(globalThis,{BRIEFS,briefItems,briefKey,aiBrief,briefHtml,briefLookup,renderDigestBar});',c);
const papers=Array.from({length:10},(_,i)=>({pmid:String(i+1001),doi:'10.1000/p'+i,title:'Paper '+i}));
const items=c.briefItems(papers),key=c.briefKey('digest',items),rerender=()=>{renders++;};
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));};
const brief={theme:'测试',compare:'比较',caveat:'公开摘要',refs:[{n:1,title:'一'},{n:2,title:'二'}],papers:[{n:1,point:'要点一'},{n:2,point:'要点二'}],questions:['问题']};
const json=x=>Promise.resolve({ok:true,json:async()=>x});
const reset=()=>{for(const k of Object.keys(c.BRIEFS))delete c.BRIEFS[k];calls=[];ticks.clear();};
(async()=>{
 assert.equal(items.length,8);
 const duplicated=[papers[0],{...papers[0],pmid:'2000'},...papers.slice(1)];
 assert.equal(c.briefItems(duplicated).length,8);assert.equal(c.briefItems(duplicated)[1].pmid,'1002');
 assert.equal(c.briefItems([{pmid:'not-valid'},{doi:'javascript:alert(1)'}]).length,0);
 reply=()=>json({ok:true,brief});
 c.aiBrief('digest',papers,rerender);assert.equal(c.BRIEFS[key].state,'loading');
 c.aiBrief('digest',papers,rerender);assert.equal(calls.length,1,'Duplicate click never submits a second model call');
 await flush();assert.equal(c.BRIEFS[key].state,'done');
 const html=c.briefHtml('digest',papers);assert(html.includes('请求 8 篇 · 实际纳入 2 篇'));assert(html.includes('6 篇公开摘要未纳入'));assert.equal(ticks.size,0);
 reset();reply=()=>json({ok:true,brief:{...brief,papers:[{n:1,point:'不完整'}]}});
 c.aiBrief('digest',papers,rerender);await flush();assert.equal(c.BRIEFS[key].state,'error');assert(c.briefHtml('digest',papers).includes('结果不完整'));
 reset();reply=(_url,opts)=>new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('synthetic abort'))));
 c.aiBrief('digest',papers,rerender);
 [...ticks.values()].find(t=>t.ms===45000).fn();assert(c.briefHtml('digest',papers).includes('用时较长'));
 [...ticks.values()].find(t=>t.ms===170000).fn();await flush();assert.equal(c.BRIEFS[key].state,'waiting');
 assert(c.briefHtml('digest',papers).includes('本次等待已到时限'));assert(!c.briefHtml('digest',papers).includes('data-action="ai-brief"'));assert.equal(calls.length,1);
 reply=()=>json({ok:true,found:false});c.briefLookup('digest',papers,rerender);await flush();
 assert.equal(calls.length,2);assert.equal(calls[1].options.method,undefined);assert(calls[1].url.startsWith('/api/ai?task=brief'));assert(c.briefHtml('digest',papers).includes('尚未查到已保存结果'));
 reply=()=>json({ok:true,found:true,brief});c.briefLookup('digest',papers,rerender);await flush();assert.equal(c.BRIEFS[key].state,'done');
 assert.equal(calls.filter(x=>x.options.method==='POST').length,1,'Cache recovery never sends another paid POST');
 reset();reply=()=>Promise.reject(Error('synthetic network disconnect'));c.aiBrief('digest',papers,rerender);await flush();assert(c.briefHtml('digest',papers).includes('网络中断'));assert(c.briefHtml('digest',papers).includes('data-action="brief-check"'));
 reset();reply=()=>json({ok:false,error:'model_failed',detail:'request_timeout'});c.aiBrief('digest',papers,rerender);await flush();assert.equal(c.BRIEFS[key].state,'error');assert(c.briefHtml('digest',papers).includes('模型服务响应超时'));
 reset();reply=()=>Promise.resolve({ok:true,json:()=>Promise.reject(Error('body lost'))});c.aiBrief('digest',papers,rerender);await flush();assert.equal(c.BRIEFS[key].state,'waiting');c.aiBrief('digest',papers,rerender);assert.equal(calls.length,1);
 reply=()=>json({ok:true,found:false,taskStatus:'failed',task:{status:'failed',error:'model_failed',detail:'request_timeout'}});c.briefLookup('digest',papers,rerender);await flush();assert.equal(c.BRIEFS[key].state,'error');assert.equal(calls.filter(x=>x.options.method==='POST').length,1);
 reset();c.BRIEFS[key]={state:'waiting'};reply=()=>Promise.resolve({ok:true,json:()=>new Promise(()=>{})});c.briefLookup('digest',papers,rerender);await flush();[...ticks.values()].find(t=>t.ms===15000).fn();await flush();assert.equal(c.BRIEFS[key].checking,false);assert.equal(c.BRIEFS[key].state,'waiting');assert.equal(ticks.size,0);
 // GET recovery reads the exact legacy cache key, with zero writes/provider calls.
 const worker=fs.readFileSync(path.join(__dirname,'../edge/_worker.js'),'utf8').replace('export default {','globalThis.worker={');
 const stores=new Map(),reads=[],writes=[];let network=0;
 const wc=vm.createContext({URL,URLSearchParams,Request,Response,TextEncoder,AbortController,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto,fetch:async()=>{network++;throw Error('unexpected network')},console});vm.runInContext(worker,wc);
 const env={QL_KV:{get:async(k,type)=>{reads.push(k);return stores.get(k)||null;},put:async k=>writes.push(k),delete:async k=>writes.push(k)}};
 const keys=['pmid:1002','pmid:1001'];const cacheKey='br:digest:'+await wc.sha([...keys].sort().join('|'));stores.set(cacheKey,brief);
 const url='https://site.test/api/ai?task=brief&mode=digest&keys='+encodeURIComponent(JSON.stringify(keys));
 const got=await wc.worker.fetch(new Request(url),env);assert.equal(got.status,200);assert.equal((await got.json()).found,true);assert(reads.includes(cacheKey));assert.equal(writes.length,0);assert.equal(network,0);
 const missing=await wc.worker.fetch(new Request(url.replace('digest','huddle')),env);assert.equal((await missing.json()).found,false);assert.equal(writes.length,0);assert.equal(network,0);
 for(const bad of [['pmid:1001'],['pmid:1001','pmid:1001'],['private:/file','pmid:1001'],Array(9).fill('pmid:1001')]){const r=await wc.worker.fetch(new Request('https://site.test/api/ai?task=brief&mode=digest&keys='+encodeURIComponent(JSON.stringify(bad))),env);assert.equal(r.status,400);}
 const badMode=await wc.worker.fetch(new Request(url.replace('mode=digest','mode=other')),env);assert.equal(badMode.status,400);assert.equal(network,0);assert.equal(writes.length,0);
 console.log('Brief feedback regression passed: unique8 cap, truthful partial count, invalid result, duplicate click, slow/deadline/network states, read-only cache recovery and no provider/KV writes on GET.');
})().catch(e=>{console.error(e);process.exitCode=1;});
