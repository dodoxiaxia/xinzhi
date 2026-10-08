'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../edge/_worker.js'),'utf8');
function harness(fetcher) {
 const ticks=new Map();let serial=0,calls=0;
 const c=vm.createContext({URL,Request,Response,Headers,TextEncoder,TextDecoder,AbortController,crypto:crypto.webcrypto,setTimeout:f=>{const id=++serial;ticks.set(id,f);return id;},clearTimeout:id=>ticks.delete(id),fetch:(...args)=>{calls++;return fetcher(...args);}});
 vm.runInContext(source.replace('export default {','globalThis.worker={'),c);
 return {c,ticks,calls:()=>calls};
}
const flush=()=>new Promise(r=>setImmediate(r)),pending=()=>new Promise(()=>{});
const read=h=>h.c.pdfLfsRead('https://github-cloud.s3.amazonaws.com/synthetic',{method:'GET'},1000,{}).then(value=>({value}),e=>({code:e.code,status:e.status}));
(async()=>{
 let h=harness(pending),work=read(h);[...h.ticks.values()][0]();assert.equal((await work).code,'pdf_timeout');assert.equal(h.ticks.size,0);
 let cancelled=0;h=harness(async()=>({ok:true,headers:new Headers(),body:{getReader:()=>({read:pending,cancel:()=>{cancelled++;return pending();}})}}));work=read(h);await flush();[...h.ticks.values()][0]();assert.equal((await work).code,'pdf_timeout');assert.equal(cancelled,1);assert.equal(h.ticks.size,0);
 const parent=new AbortController();cancelled=0;h=harness(async()=>({ok:true,headers:new Headers(),body:{getReader:()=>({read:pending,cancel:()=>{cancelled++;return pending();}})}}));work=h.c.pdfLfsRead('https://github-cloud.s3.amazonaws.com/synthetic',{method:'GET'},1000,{signal:parent.signal}).catch(e=>e.code);await flush();parent.abort();assert.equal(await work,'pdf_timeout');assert.equal(cancelled,1);assert.equal(h.ticks.size,0);
 parent.abort();h=harness(pending);assert.equal(await h.c.pdfLfsRead('https://github-cloud.s3.amazonaws.com/synthetic',{},1000,{signal:parent.signal}).catch(e=>e.code),'pdf_timeout');assert.equal(h.calls(),0);
 h=harness(async()=>({ok:false,status:403,headers:new Headers(),body:{cancel:pending}}));assert.equal(await h.c.pdfLfsRead('https://github.com/synthetic',{},1000,{pauseOnDenied:true}).catch(e=>e.code),'library_paused');assert.equal(h.ticks.size,0);
 let n=0;h=harness(async()=>({ok:true,headers:new Headers(),body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(1001)}),cancel:()=>{n++;return pending();}})}}));assert.equal((await read(h)).code,'pdf_too_large');assert(n>=1);assert.equal(h.ticks.size,0);
 console.log('LFS deadline passed: stalled headers/body, ignored abort/cancel, parent cancellation, pre-abort zero fetch, denied response and byte bound; synthetic only.');
})().catch(e=>{console.error(e);process.exitCode=1;});
