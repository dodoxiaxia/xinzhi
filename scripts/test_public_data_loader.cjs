'use strict';
// Real Chromium, fully intercepted fixtures: schema rejection is exercised only
// after content type, byte length, SHA, envelope version and role all match.
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const { chromium } = require('playwright');
const loader = fs.readFileSync(path.join(__dirname, '..', 'public-data-loader.js'), 'utf8');
const version = 'a'.repeat(64), clone = x => JSON.parse(JSON.stringify(x));
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x==='object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])) : x;
const feeds = {items:[{id:'one',title:'A public trial',date:'2026-10-07',tags:['heart'],abstractSections:[{label:'Methods',text:'Original abstract'}]}]};
const radar = {v:1,jn:['Journal'],pub:['Publisher'],tier:['Tier'],design:['RCT'],tag:['heart'],rows:[['3','','2026-10-06',0,0,0,0,[0],'Archived title']],abs:{'3':[['','Original abstract']]},zh:{'3':'中文'},dateBases:{'3':'source'}};
let checks = 0;
const eq = (a, b, label) => { assert.deepStrictEqual(a, b, label); checks++; };
const ok = (value, label) => { assert.ok(value, label); checks++; };
function release(values) {
  const files = [], bodies = new Map();
  for (const [name, data] of Object.entries(values)) {
    const body = Buffer.from(JSON.stringify({schemaVersion:2,version,name,data}));
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const row = {name,path:`public-data/${name.toLowerCase()}.${sha256}.json`,sha256,bytes:body.length,contentHash:crypto.createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex')};
    files.push(row); bodies.set('/' + row.path, body);
  }
  const manifest = {schemaVersion:2,version,files};
  const boot = {schemaVersion:2,version,data:{FEEDS:{items:[]}},deferred:files.map(x=>x.name),assets:manifest.files,counts:{}};
  return {manifest, boot, bodies};
}
const good = () => release({FEEDS:clone(feeds),RECENT_RADAR:clone(radar),RADAR:clone(radar)});
const failures = [
  ['RADAR','null_row',x=>{x.rows=[null]}],
  ['RADAR','short_row',x=>{x.rows[0].pop()}],
  ['RADAR','dictionary',x=>{x.jn=[null]}],
  ['RADAR','index',x=>{x.rows[0][3]=x.jn.length}],
  ['RADAR','boolean_index',x=>{x.rows[0][3]=true}],
  ['RADAR','tags',x=>{x.rows[0][7]=[99]}],
  ['RADAR','abstract',x=>{x.abs={'3':[null]}}],
  ['RADAR','translation',x=>{x.zh={'3':[]}}],
  ['RADAR','date_basis',x=>{x.dateBases={'3':[]}}],
  ['FEEDS','null_paper',x=>{x.items=[null]}],
  ['FEEDS','title',x=>{x.items[0].title=[]}],
  ['FEEDS','tags',x=>{x.items[0].tags=[null]}],
  ['FEEDS','abstract',x=>{x.items[0].abstractSections=[null]}],
  ['FEEDS','metrics',x=>{x.items[0].quantitativeMetrics=[]}]
];
(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true});
  try {
    async function open(initial, rejectOnce = '', holdFeeds = false) {
      const context = await browser.newContext(), page = await context.newPage(), errors = [], requests = [];
      let current = initial, releaseFeeds;
      const feedGate = new Promise(resolve=>releaseFeeds=resolve);
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',async route=>{
        const u = new URL(route.request().url());
        eq(u.origin,'https://static.invalid','all requests stay in intercepted fixture origin');
        eq(route.request().method(),'GET','read-only fixture request'); requests.push(u.pathname);
        if (u.pathname === '/') return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><main class="main-content"></main><script>window.PUBLIC_DATA_BOOT=${JSON.stringify(current.boot)};</script><script>${loader}</script><script>
          window.adoptions=[]; window.loaderErrors=[];const NativeError=window.Error;window.Error=class extends NativeError{constructor(message){super(message);window.loaderErrors.push(message)}}; window.rejectOnce=${JSON.stringify(rejectOnce)};
          window.testState={mode:'candidates',range:'365'};
          PublicData.bind(data=>{if(window.rejectOnce && data[window.rejectOnce]){window.rejectOnce='';throw new Error('adopt failed')}
            window.adoptions.push(Object.keys(data));Object.assign(window,data)},()=>PublicData.ready(window.testState));
          PublicData.ready(window.testState);
        </script>`});
        if (holdFeeds && u.pathname.startsWith('/public-data/feeds.')) await feedGate;
        const body = current.bodies.get(u.pathname);
        ok(body, 'request must reference a manifest-declared hash asset');
        return route.fulfill({contentType:'application/json',body});
      });
      await page.goto('https://static.invalid/');
      return {page, requests, errors, releaseFeeds, restore:async()=>{current=good();await page.reload()}, close:async()=>{eq(errors,[],'no browser exceptions');await context.close()}};
    }
    for (const [name, label, mutate] of failures) {
      const values = {FEEDS:clone(feeds),RECENT_RADAR:clone(radar),RADAR:clone(radar)}; mutate(values[name]);
      const bad = release(values), row = bad.manifest.files.find(x=>x.name===name);
      eq(bad.boot.assets,bad.manifest.files,'bootstrap matches manifest '+label);
      eq(crypto.createHash('sha256').update(bad.bodies.get('/'+row.path)).digest('hex'),row.sha256,'corrupt nested payload has correctly bound SHA '+label);
      const s = await open(bad, '', name==='RADAR');
      await s.page.waitForFunction(n=>PublicData.debug()[n]==='error',name);
      // Prove FEEDS adoption happens after the bad RADAR entered error.
      s.releaseFeeds();
      const other = name==='FEEDS'?'RADAR':'FEEDS';
      await s.page.waitForFunction(n=>PublicData.debug()[n]==='ready',other);
      eq(await s.page.evaluate(n=>window.adoptions.some(keys=>keys.includes(n)),name),false,'invalid nested data never applied '+label);
      const message=await s.page.locator('#publicDataStatus').textContent();
      ok(message.includes('重试'),'schema failure reached after hash validation '+label);
      ok((await s.page.evaluate(()=>window.loaderErrors)).includes(name==='FEEDS'?'Invalid current data':'Invalid archive data'),'exact nested schema error '+label);
      await s.page.evaluate(()=>{window.testState.range='14';PublicData.ready(window.testState)});
      await s.page.waitForFunction(()=>PublicData.debug().RECENT_RADAR==='ready');
      eq(await s.page.evaluate(n=>window.adoptions.some(keys=>keys.includes(n)),name),false,'later role never replays invalid data '+label);
      eq(s.requests.filter(x=>x.startsWith('/public-data/'+name.toLowerCase()+'.')).length,1,'switching columns does not automatically retry invalid role '+label);
      await s.page.evaluate(()=>{window.testState.range='365';PublicData.ready(window.testState)});
      await s.page.locator('#publicDataStatus button').click();
      await s.page.waitForFunction(n=>PublicData.debug()[n]==='error',name);
      eq(s.requests.filter(x=>x.startsWith('/public-data/'+name.toLowerCase()+'.')).length,2,'manual retry explicitly refetches invalid role '+label);
      eq(await s.page.evaluate(n=>window.adoptions.some(keys=>keys.includes(n)),name),false,'retry still rejects hash-valid invalid nested data '+label);
      await s.restore();
      await s.page.waitForFunction(()=>PublicData.debug().FEEDS==='ready'&&PublicData.debug().RADAR==='ready');
      eq(await s.page.evaluate(()=>[FEEDS.items.length,RADAR.rows.length]),[1,1],'corrected manifest/bootstrap reload restores data '+label);
      eq(s.requests.includes('/public.js'),false,'no classic fallback '+label);
      await s.close();
    }
    const s = await open(good(),'FEEDS');
    await s.page.waitForFunction(()=>PublicData.debug().FEEDS==='error'&&PublicData.debug().RADAR==='ready');
    eq(await s.page.evaluate(()=>window.adoptions),[['RADAR']],'failed adoption value never replayed by later archive load');
    await s.page.locator('#publicDataStatus button').click();
    await s.page.waitForFunction(()=>PublicData.debug().FEEDS==='ready'&&PublicData.debug().RADAR==='ready');
    eq(await s.page.evaluate(()=>window.adoptions),[['RADAR'],['RADAR','FEEDS']],'manual retry restores failed feeds and preserves ready archive');
    eq(s.requests.filter(x=>x.startsWith('/public-data/feeds.')).length,2,'only failed role refetched');
    eq(s.requests.filter(x=>x.startsWith('/public-data/radar.')).length,1,'ready role not refetched');
    await s.close();
    console.log(JSON.stringify({passed:true,checks,nestedCases:failures.length,offline:true,modelCalls:0}));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
