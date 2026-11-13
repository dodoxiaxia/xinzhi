'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('workers/cron-dispatch/index.js','utf8');
const toml=fs.readFileSync('workers/cron-dispatch/wrangler.toml','utf8');
const base='https://api.github.com/repos/dodoxiaxia/xinzhi/actions/workflows/daily.yml';
async function harness(options={}) {
 const calls=[],logs=[];let work;
 const env=options.missing?{}:{GH_TOKEN:'synthetic-dispatch-secret'};
 const fetch=async(url,init)=>{
  calls.push({url,init});assert.equal(init.redirect,'error');assert(init.signal);
  assert.equal(new URL(url).hostname,'api.github.com');
  assert.equal(init.headers.Authorization,'Bearer synthetic-dispatch-secret');
  assert.equal(url,base+'/dispatches');assert.equal(init.method,'POST');
  assert.deepEqual(JSON.parse(init.body),{ref:'main',inputs:{mode:'fast'}});
  if (options.throwResponse) throw new Error('secret upstream details');
  return new Response(options.body===undefined?null:options.body,{status:options.dispatchStatus||204});
 };
 const context=vm.createContext({fetch,URL,Response,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,console:{log:(...parts)=>logs.push(parts.join(' '))}});
 vm.runInContext(source.replace('export default {','globalThis.worker = {'),context);
 await context.worker.scheduled({},env,{waitUntil:promise=>{work=promise;}});await work;
 return {calls,logs,context,env};
}
(async()=>{
 assert(toml.includes('crons = ["7 */2 * * *"]'));
 assert(!toml.includes('*/5'));
 assert(!source.includes('fulltext.yml'));
 assert(!source.includes('fulltext-pending'));
 assert(source.includes("const WORKFLOW = 'daily.yml';"));
 assert(source.includes("{ ref:'main', inputs:{ mode:'fast' } }"));
 assert(!source.includes("source:'external'"));
 let h=await harness();assert.equal(h.calls.length,1);assert(h.logs.join('').includes('dispatched'));
 const count=h.calls.length;const ready=await h.context.worker.fetch(new Request('https://dispatch.test'),h.env);
 assert.equal(ready.status,200);assert.equal(ready.headers.get('cache-control'),'no-store');const text=await ready.text();
 const body=JSON.parse(text);assert.equal(body.configured,true);assert.equal(body.service,'fulltext-dispatch');assert.equal(body.version,'v14.2');
 assert(!text.includes('synthetic-dispatch-secret'));assert.equal(h.calls.length,count);
 assert.equal((await h.context.worker.fetch(new Request('https://dispatch.test',{method:'POST'}),h.env)).status,405);assert.equal(h.calls.length,count,'public endpoint cannot dispatch');
 h=await harness({missing:true});assert.equal(h.calls.length,0);assert(h.logs.join('').includes('dispatch_not_configured'));assert.equal((await h.context.worker.fetch(new Request('https://dispatch.test'),h.env)).status,503);
 h=await harness({dispatchStatus:403,body:'x'.repeat(262145)});assert.equal(h.calls.length,1);assert(h.logs.join('').includes('dispatch_failed'));assert(!h.logs.join('').includes('synthetic-dispatch-secret'));
 h=await harness({throwResponse:true});assert.equal(h.calls.length,1);assert(h.logs.join('').includes('dispatch_unavailable'));assert(!h.logs.join('').includes('secret upstream details'));
 console.log('Daily dispatcher passed: every-2-hour source dispatches daily.yml with mode=fast, does not call fulltext-pending, and keeps the token off the public endpoint.');
})().catch(error=>{console.error(error);process.exitCode=1;});
