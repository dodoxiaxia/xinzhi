'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('workers/cron-dispatch/index.js','utf8');
const pending='https://learn.dryz.info/api/fulltext-pending';
const base='https://api.github.com/repos/dodoxiaxia/xinzhi/actions/workflows/fulltext.yml';
async function harness(options={}) {
 const calls=[],logs=[];let work;
 const env=options.missing?{}:{GH_TOKEN:'synthetic-dispatch-secret'};
 const fetch=async(url,init)=>{
  calls.push({url,init});assert.equal(init.redirect,'error');assert(init.signal);
  if(url===pending){assert(!init.headers.Authorization);assert.equal(init.method,'GET');return options.queueResponse?options.queueResponse():Response.json({ok:true,pending:options.pending!==false});}
  assert.equal(new URL(url).hostname,'api.github.com');assert.equal(init.headers.Authorization,'Bearer synthetic-dispatch-secret');
  if(url===base+'/runs?branch=main&per_page=5')return options.runsResponse?options.runsResponse():Response.json({workflow_runs:options.active?[{status:'in_progress'}]:[]});
  assert.equal(url,base+'/dispatches');assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(init.body),{ref:'main'});
  return new Response(null,{status:options.dispatchStatus||204});
 };
 const context=vm.createContext({fetch,URL,Response,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,console:{log:(...parts)=>logs.push(parts.join(' '))}});
 vm.runInContext(source.replace('export default {','globalThis.worker = {'),context);
 await context.worker.scheduled({},env,{waitUntil:promise=>{work=promise;}});await work;
 return {calls,logs,context,env};
}
(async()=>{
 let h=await harness({pending:false});assert.equal(h.calls.length,1);assert(h.logs.join('').includes('queue_empty'));
 h=await harness({active:true});assert.equal(h.calls.length,2);assert(h.logs.join('').includes('workflow_active'));
 h=await harness();assert.equal(h.calls.length,3);assert(h.logs.join('').includes('dispatched'));
 const count=h.calls.length;const ready=await h.context.worker.fetch(new Request('https://dispatch.test'),h.env);
 assert.equal(ready.status,200);assert.equal(ready.headers.get('cache-control'),'no-store');const text=await ready.text();assert.equal(JSON.parse(text).configured,true);assert(!text.includes('synthetic-dispatch-secret'));assert.equal(h.calls.length,count);
 assert.equal((await h.context.worker.fetch(new Request('https://dispatch.test',{method:'POST'}),h.env)).status,405);assert.equal(h.calls.length,count,'public endpoint cannot dispatch');
 h=await harness({missing:true});assert.equal(h.calls.length,1);assert(h.logs.join('').includes('dispatch_not_configured'));assert.equal((await h.context.worker.fetch(new Request('https://dispatch.test'),h.env)).status,503);
 for(const queueResponse of [()=>Response.json({ok:true}),()=>new Response('<html>old website</html>'),()=>Response.json({ok:false},{status:503}),()=>new Response('x'.repeat(262145)),()=>{throw Error('secret upstream details');}]){
  h=await harness({queueResponse});assert.equal(h.calls.length,1);assert(!h.logs.join('').includes('secret upstream details'));
 }
 h=await harness({runsResponse:()=>Response.json({workflow_runs:[]},{status:403})});assert.equal(h.calls.length,2);assert(h.logs.join('').includes('workflow_unavailable'));
 h=await harness({dispatchStatus:403});assert.equal(h.calls.length,3);assert(h.logs.join('').includes('dispatch_failed'));assert(!h.logs.join('').includes('synthetic-dispatch-secret'));
 console.log('Fulltext dispatcher passed: empty/active queues skip runners, eligible queues dispatch once, fixed repository and scoped headers, protected readiness, bounded response and safe failures.');
})().catch(error=>{console.error(error);process.exitCode=1;});
