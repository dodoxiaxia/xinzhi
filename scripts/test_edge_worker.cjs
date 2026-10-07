// Offline runtime boundary tests: all fetches are fixture responses.
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../edge/_worker.js'),'utf8').replace('export default {','globalThis.worker = {');
const fixture={title_zh:'研究题名',one_line:'摘要结果',design:'研究设计',limits:'摘要未提供',why_read:'理解证据范围',findings:[{text:'结果一',quote:'A matching abstract sentence'},{text:'结果二',quote:'Another matching abstract sentence'}]};
const abstract='A matching abstract sentence. Another matching abstract sentence. ';
const c=vm.createContext({URL,Response,Request,TextEncoder,crypto:require('crypto').webcrypto,fetch:async()=>{throw Error('unexpected network')},console});
vm.runInContext(source,c);
(async()=>{
 assert.equal(c.validate(fixture,abstract).one_line,'摘要结果');
 for(const field of ['one_line','design','why_read'])assert.throws(()=>c.validate({...fixture,[field]:'中'.repeat(61)},abstract),/invalid_field/);
 assert.throws(()=>c.validate({...fixture,findings:[...fixture.findings.slice(0,1),{text:'伪引文',quote:'This sentence does not occur'}]},abstract),/quote_not_in_abstract/);
 assert.equal(c.safeModelError(Error('response included synthetic-secret-text')),'provider_or_output_error');
 for(const code of ['model_http_401','model_http_403','model_http_429','model_http_500'])assert.equal(c.retryableModelError(Error(code)),false);
 assert.equal(c.retryableModelError(Error('quote_not_in_abstract')),true);
 let requests=[];
 c.fetch=async(url,opts)=>{requests.push(String(url));return String(url).includes('europepmc') ? Response.json({resultList:{result:[]}}) : new Response('<PubmedArticle><PMID>123</PMID></PubmedArticle>');};
 const m=await c.resolveMeta({type:'pmid',id:'123'},'10.1234/unrelated','999');
 assert.equal(m.doi,'');assert.equal(m.abstract,'');assert.equal(requests.length,2);assert(!requests.some(u=>u.includes('unrelated')));
 requests=[];c.fetch=async(url,opts)=>{requests.push(String(url));return Response.json({resultList:{result:[]}});};
 const d=await c.resolveMeta({type:'doi',id:'10.1234/target'},'', '999');assert.equal(d.pmid,'');assert(!requests.some(u=>u.includes('id=999')));
 const missing=await c.worker.fetch(new Request('https://site.test/api/ql?k=pmid:123'),{});assert.equal(missing.status,503);
 let calls=0;c.fetch=async(url,opts)=>{calls++;assert.equal(opts.redirect,'error');return Response.json({error:'fixture'}, {status:401});};
 const env={LLM_ENDPOINT:'https://model.test/api',LLM_MODEL:'fixture',LLM_API_KEY:'synthetic'};
 await assert.rejects(()=>c.withRetry(env,'system','user',x=>x),/model_http_401/);assert.equal(calls,1);
 let staticCalls=0;const res=await c.worker.fetch(new Request('https://site.test/'),{ASSETS:{fetch:()=>{staticCalls++;return new Response('fixture')}}});assert.equal(staticCalls,1);assert.equal(await res.text(),'fixture');
 console.log('Edge offline boundaries passed: identity, evidence, provider retry, redirect, missing config, static assets.');
})().catch(e=>{console.error(e);process.exitCode=1;});
