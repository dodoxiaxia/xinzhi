'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {setup} = require('./test_fulltext_auth_helpers.cjs');
const base = 'https://site.test', doi = '10.1000/read-path', key = 'library:paper:' + doi;
const record = title => JSON.stringify({version:1,paper:{id:'doi-0123456789abcdef',doi,title,journal:'Synthetic',authors:[],date:'2026',datePrecision:'year',dateBasis:'test',ingestedAt:'2026-01-01T00:00:00Z',metadataStatus:'external_bibliography_checked',fulltextStatus:'pending'}});
async function make(options = {}) {
  const h = await setup();
  h.values.set(key, record('KV title'));
  h.context.console = {...console,warn:(...args)=>h.warnings.push(args.map(String).join(' '))};
  h.warnings=[];
  h.d1={prepares:[], rows:new Map(), throwPrepare:false, throwFirst:false};
  if(options.binding !== false) h.env.LIBRARY_DB={prepare(sql){h.d1.prepares.push(sql);if(h.d1.throwPrepare)throw Error('private detail');return {bind(bound){return {first:async()=>{if(h.d1.throwFirst)throw Error('private detail');return h.d1.rows.get(bound)||null;}};}};}};
  if(options.switchValue !== undefined) h.values.set('cfg:d1_read_enabled',options.switchValue);
  if(options.switchError){const get=h.kv.get.bind(h.kv);h.kv.get=async(k,type)=>{if(k==='cfg:d1_read_enabled')throw Error('private detail');return get(k,type);};}
  const response=async route=>h.context.worker.fetch(new Request(base+route),h.env);
  return {h,response};
}
async function body(response){return response.json();}
(async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../edge/src/07f-d1-read.js'),'utf8');
  assert(!/\b(?:INSERT|UPDATE|DELETE|DROP|batch)\b/i.test(source));
  assert(/SELECT value, deleted, expires_at FROM kv_mirror WHERE key = \?1/.test(source));
  for(const options of [{},{switchValue:'0'},{switchValue:'true'},{switchValue:''},{switchValue:' 1 '},{switchError:true}]){
    const a=await make(options), b=await make({binding:false});
    const [ar,br]=await Promise.all([a.response('/api/library?doi='+encodeURIComponent(doi)),b.response('/api/library?doi='+encodeURIComponent(doi))]);
    assert.deepEqual(Buffer.from(await ar.arrayBuffer()),Buffer.from(await br.arrayBuffer()));
    const al=await a.response('/api/library?limit=5'), bl=await b.response('/api/library?limit=5');
    assert.deepEqual(Buffer.from(await al.arrayBuffer()),Buffer.from(await bl.arrayBuffer()));
    assert.equal(a.h.d1.prepares.length,0);
  }
  {
    const {h,response}=await make({binding:false});await response('/api/library?doi='+encodeURIComponent(doi));
    assert(!h.reads.some(r=>r.key==='cfg:d1_read_enabled'));
  }
  {
    const {h,response}=await make({switchValue:'1'});h.d1.rows.set(key,{value:record('D1 title'),deleted:0,expires_at:null});
    const json=await body(await response('/api/library?doi='+encodeURIComponent(doi)));
    assert.equal(json.paper.title,'D1 title');assert.equal(h.d1.prepares.length,1);
  }
  for(const row of [null,{value:record('ignored'),deleted:1,expires_at:null},{value:null,deleted:0,expires_at:null},{value:'{',deleted:0,expires_at:null},{value:record('ignored'),deleted:0,expires_at:1}]){
    const {h,response}=await make({switchValue:'1'});if(row)h.d1.rows.set(key,row);
    const json=await body(await response('/api/library?doi='+encodeURIComponent(doi)));
    if(row&&row.deleted===1)assert.equal(json.found,false);else assert.equal(json.paper.title,'KV title');
  }
  for(const failure of ['throwPrepare','throwFirst']){
    const {h,response}=await make({switchValue:'1'});h.d1[failure]=true;
    const json=await body(await response('/api/library?doi='+encodeURIComponent(doi)));
    assert.equal(json.paper.title,'KV title');assert.deepEqual(h.warnings,['d1 read: fallback to kv']);
  }
  {
    const {h,response}=await make({switchValue:'1'});h.d1.rows.set(key,{value:record('D1 title'),deleted:0,expires_at:null});
    await body(await response('/api/library?limit=5'));
    assert.equal(h.d1.prepares.length,1);
    const before=h.d1.prepares.length;await h.context.libraryGetDisplay(h.env,'library:job:other');
    assert.equal(h.d1.prepares.length,before);
  }
  {
    const {h,response}=await make({switchValue:'1'});h.d1.rows.set(key,{value:null,deleted:1,expires_at:null});
    const json=await body(await response('/api/library?limit=5'));
    assert(!json.papers.some(paper=>paper.doi===doi),'deleted D1 row must hide the KV record from the list');
  }
  {
    const {h,response}=await make({switchValue:'1'});
    const json=await body(await response('/api/library?limit=5'));
    assert(json.papers.some(paper=>paper.doi===doi),'missing D1 row must leave the KV record in the list');
  }
  {
    const {h,response}=await make({switchValue:'0'});await response('/api/library?doi='+encodeURIComponent(doi));
    h.values.set('cfg:d1_read_enabled','1');await response('/api/library?doi='+encodeURIComponent(doi));
    assert.equal(h.d1.prepares.length,0,'switch cache is isolated and observes its 60 second window');
    require('vm').runInContext('d1ReadSwitch={on:false,at:-Infinity}',h.context);await response('/api/library?doi='+encodeURIComponent(doi));
    assert.equal(h.d1.prepares.length,1);
  }
  console.log('D1 read checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
