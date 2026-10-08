'use strict';
// Uses the actual manifest-governed assets and static ASSETS passthrough. All HTTP
// assets and read-only API responses are intercepted; no models or external sites.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'), pub=path.join(root,'public');
const baseline=process.env.XINZHI_BASELINE_PUBLIC;
const out=process.env.XINZHI_DATA_QA_OUTPUT||path.join(root,'.local/public-data-qa');fs.mkdirSync(out,{recursive:true});
const context=vm.createContext({URL,Request,Response,Headers,ReadableStream,TextEncoder,Uint8Array,Set});
vm.runInContext(fs.readFileSync(path.join(pub,'_worker.js'),'utf8').replace('export default {','globalThis.worker = {'),context);
const handler=vm.runInContext('publicStaticData',context),version=JSON.parse(fs.readFileSync(path.join(pub,'public-data-manifest.json'),'utf8')).version;
const bundle=fs.readFileSync(path.join(pub,'public.js'));
const env={ASSETS:{fetch:async request=>{
 const filename=new URL(request.url).pathname.slice(1);
 if(!fs.existsSync(path.join(pub,filename)))return new Response('SPA shell',{headers:{'content-type':'text/html'}});
 return new Response(request.method==='HEAD'?null:fs.readFileSync(path.join(pub,filename)),{headers:{'content-type':'application/json'}});
}}};
const isRole=(r,name)=>r.path.startsWith('/public-data/'+name.toLowerCase()+'.');
const parsed={};for(const chunk of bundle.toString().split('\n;\n'))if(/^window\.[A-Z_]+=/.test(chunk)){const [prefix,...rest]=chunk.split('=');parsed[prefix.slice(7)]=JSON.parse(rest.join('=').slice(0,-1));}
const oldRow=parsed.RADAR.rows.find(r=>r[2]<'2026-09-20'),oldId='pmid-'+oldRow[0];
let checks=0,records=[];const eq=(a,b,label)=>{assert.deepStrictEqual(a,b,label);checks++};const ok=(x,label)=>{assert.ok(x,label);checks++};
async function visible(page){return page.evaluate(()=>({
 badges:['candCountBadge','libCountBadge','curatedCountBadge'].map(id=>document.getElementById(id).textContent),
 text:[...document.querySelectorAll('#articlesStream,#weeklySection,#sourcesSection,#activeFiltersBar,#publisherAccordion,#tierFilterList,#tagsCloud')].filter(e=>e.getClientRects().length).map(e=>e.textContent),
 query:location.search,hash:location.hash,drawer:document.getElementById('readerDrawer').classList.contains('open'),
 drawerText:document.getElementById('readerDrawer').classList.contains('open')?document.getElementById('drawerBody').textContent:''
}));}
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true});
 try {
  async function open(kind,url,options={}){
   const ctx=await browser.newContext({viewport:{width:options.width||1440,height:950}}),page=await ctx.newPage();page.setDefaultTimeout(15000);
   const controls={failure:null,hold:null,offline:false,...options.controls},errors=[],requests=[];
   if(options.stored)await page.addInitScript(values=>{for(const [key,value]of Object.entries(values))localStorage.setItem(key,value)},options.stored);
   if(options.fastTimeout)await page.addInitScript(()=>{const original=window.setTimeout;window.setTimeout=(fn,ms,...args)=>original(fn,ms===20000?1000:ms,...args)});
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url());if(u.origin==='https://www.ebi.ac.uk'){eq(req.method(),'GET','existing public abstract read intercepted');return route.fulfill({json:{resultList:{result:[]}}})}eq(u.origin,'https://data.invalid','loader/static same-origin only');ok(['GET','HEAD'].includes(req.method()),'no model or mutating request');
    requests.push({path:u.pathname,method:req.method()});
    if(controls.offline)return route.abort('internetdisconnected');
    if(u.pathname==='/api/library'&&options.supplemental)return route.fulfill({json:{ok:true,found:true,paper:options.supplemental,papers:[options.supplemental]}});
    if(u.pathname.startsWith('/api/'))return route.fulfill({json:{ok:true,found:false,canGenerate:false,papers:[]}});
    if(u.pathname.startsWith('/public-data/')){
     if(controls.hold)await controls.hold;
     if(controls.failure==='timeout'){await new Promise(resolve=>setTimeout(resolve,1600));try{return await route.abort('timedout')}catch{return}}

     if(controls.failure==='status')return route.fulfill({status:503,json:{error:'data_unavailable'}});
     if(controls.failure==='version')return route.fulfill({status:409,json:{error:'data_version_changed'}});
     if(controls.failure==='malformed')return route.fulfill({contentType:'application/json',body:'{"broken":'});
     if(controls.failure==='shape')return route.fulfill({json:{items:'wrong',rows:'wrong'}});
     if(controls.failure==='missing')return route.fulfill({status:404,json:{error:'data_not_found'}});
     if(controls.failure==='spa')return route.fulfill({contentType:'text/html',body:'SPA fallback'});
     if(controls.failure==='offline')return route.abort('internetdisconnected');
     if(controls.static)return route.fulfill({contentType:'application/json',body:fs.readFileSync(path.join(pub,u.pathname.slice(1)))});
     const response=await handler(new Request(u.href),env);
     return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    }
    const filename=u.pathname==='/'?'index.html':u.pathname.slice(1),dir=kind==='baseline'||(options.oldHtml&&filename==='index.html')?baseline:pub;
    return route.fulfill({body:filename==='index.html'&&options.oldBoot?fs.readFileSync(path.join(dir,filename)).toString().replace('"version":"'+version+'"','"version":"'+'a'.repeat(64)+'"'):fs.readFileSync(path.join(dir,filename)),contentType:filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.svg')?'image/svg+xml':'text/html'});
   });
   await page.goto('https://data.invalid'+url,{waitUntil:'load'});
   return {page,ctx,controls,errors,requests,close:async()=>{eq(errors,[],'no browser script errors');await ctx.close()}};
  }
  async function ready(s){await s.page.waitForFunction(()=>!document.getElementById('publicDataStatus')||document.getElementById('publicDataStatus').hidden);}
  async function parity(url,width=1440){
   const fresh=await open('candidate',url,{width});await ready(fresh);
   if(baseline){const old=await open('baseline',url,{width});await old.page.waitForLoadState('networkidle');eq(await visible(fresh.page),await visible(old.page),'classic/public lazy parity '+url);await old.close();}
   ok(await fresh.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no page overflow');
   records.push({type:'parity',url,width,requests:fresh.requests});console.log('Public parity passed:',width,url);await fresh.close();
  }
  for(const width of [1440,390])for(const mode of ['curated','weekly','library','candidates','sources'])await parity('/?mode='+mode,width);
  for(const url of ['/?mode=candidates&range=365&lane=all','/?mode=candidates&range=30&minor=1&view=compact','/?mode=candidates&q=atrial&range=365&reading=abstract&drawer=first#keep','/?mode=library&q='+encodeURIComponent(parsed.LIBRARY.papers[0].doi)+'&drawer=first#doi','/?mode=invalid&view=compact','/?mode=weekly&theme=dark&style=c'])await parity(url);
  // Bare home and the prepared weekly board use zero deferred/classic data requests.
  const home=await open('candidate','/');await ready(home);eq(home.requests.filter(r=>r.path.includes('/public-data/')||r.path==='/public.js'),[],'home does not load or parse annual data');eq(await home.page.evaluate(()=>window.FEEDS.items.length),parsed.FEEDS.items.filter(p=>p.autoPick||p.weeklyPick||p.hasDraft).length,'home selected rows only');
  eq(await home.page.locator('#libCountBadge').textContent(),String(parsed.LIBRARY.papers.length),'complete library count');
  await home.page.locator('[data-mode="weekly"]').click();eq(await home.page.locator('.weekly-auto-item').count(),parsed.WEEKLY_BOARD.items.length,'all 24 weekly papers available immediately');
  const translated=parsed.WEEKLY_BOARD.items.find(r=>r.translation);
  if(translated){const before=home.requests.length;await home.page.locator('.weekly-auto-item[data-paper-id="'+translated.id+'"] [data-action="open-drawer"]').first().click();await home.page.waitForSelector('.abstract-translation');ok((await home.page.locator('.abstract-translation').textContent()).replace(/\s/g,'').includes(translated.translation.abstract_zh.replace(/\s/g,'')),'prepared translation is present');eq(home.requests.length,before,'prepared reading makes no requests');await home.page.locator('#drawerCloseBtn').click();}
  // Weak network: one in-flight request per data name, switching back remains usable.
  let release;const hold=new Promise(resolve=>release=resolve);home.controls.hold=hold;
  await home.page.locator('[data-mode="candidates"]').click();await home.page.waitForSelector('#publicDataStatus:not([hidden])');
  await home.page.locator('[data-mode="curated"]').click();ok(await home.page.locator('#articlesStream [data-action="open-drawer"]').count(),'home works during pending load');
  await home.page.locator('[data-mode="candidates"]').click();release();home.controls.hold=null;await ready(home);
  eq(home.requests.filter(r=>isRole(r,'FEEDS')).length,1,'current-feed fetch deduplicated');eq(home.requests.filter(r=>isRole(r,'RECENT_RADAR')).length,1,'recent archive fetch deduplicated');eq(home.requests.filter(r=>isRole(r,'RADAR')).length,0,'14-day view never downloads annual archive');
  await home.page.locator('[data-range="365"]').click();await ready(home);eq(await home.page.evaluate(()=>window.RADAR.rows.length),parsed.RADAR.rows.length,'annual range includes all archived rows');
  const fetchCount=home.requests.filter(r=>r.path.startsWith('/public-data/')).length;
  home.controls.offline=true;await home.page.locator('[data-mode="weekly"]').click();await home.page.locator('[data-mode="candidates"]').click();await ready(home);eq(home.requests.filter(r=>r.path.startsWith('/public-data/')).length,fetchCount,'loaded columns work offline from memory');await home.close();
  for(const failure of ['status','malformed','shape','timeout','version','missing','spa','offline']){
   console.log('Failure regression:',failure);
   const s=await open('candidate','/?mode=candidates&range=365',{controls:{failure},fastTimeout:failure==='timeout'});
   await s.page.waitForFunction(()=>Object.values(window.PublicData.debug()).some(x=>x==='error'));
   const message=await s.page.locator('#publicDataStatus').textContent();ok(message.includes(['status','timeout','offline'].includes(failure)?'重试':'版本已更新'),'visible honest failure state '+failure);
   eq(s.requests.filter(r=>r.path==='/public.js').length,0,'failure never downloads full fallback automatically');
   await s.page.locator('[data-mode="curated"]').click();ok(await s.page.locator('#articlesStream [data-action="open-drawer"]').count(),'failure keeps curated content');
   if(['status','timeout','offline'].includes(failure)){s.controls.failure=null;await s.page.locator('[data-mode="candidates"]').click();await s.page.locator('[data-range="365"]').click();await s.page.locator('#publicDataStatus button').click();await ready(s);eq(await s.page.evaluate(()=>window.RADAR.rows.length),parsed.RADAR.rows.length,'manual retry restores complete archive');}
   records.push({type:'failure',failure,requests:s.requests});await s.close();
  }
  const local=await open('candidate','/?mode=candidates&range=365',{controls:{static:true}});await ready(local);eq(local.requests.filter(r=>r.path==='/public.js').length,0,'plain static server needs no classic fallback');eq(await local.page.evaluate(()=>window.RADAR.rows.length),parsed.RADAR.rows.length,'plain static server preserves annual data');await local.close();
  if(baseline){const legacy=await open('candidate','/?mode=candidates&range=365&lane=all',{oldHtml:true});await legacy.page.waitForLoadState('networkidle');const old=await open('baseline','/?mode=candidates&range=365&lane=all');await old.page.waitForLoadState('networkidle');eq(await visible(legacy.page),await visible(old.page),'cached classic HTML with current classic script preserves all data and URLs');eq(legacy.requests.filter(r=>r.path.startsWith('/public-data/')).length,0,'classic HTML needs no new shard requests');await old.close();await legacy.close();}
  const mixed=await open('candidate','/?mode=candidates&range=365',{oldBoot:true});await mixed.page.waitForFunction(()=>Object.values(window.PublicData.debug()).some(x=>x==='error'));ok((await mixed.page.locator('#publicDataStatus').textContent()).includes('版本已更新'),'cached HTML rejects a different envelope version');eq(mixed.requests.filter(r=>r.path==='/public.js').length,0,'mixed version never fetches unversioned classic data');await mixed.page.locator('[data-mode="curated"]').click();ok(await mixed.page.locator('#articlesStream [data-action="open-drawer"]').count(),'cached HTML preserves embedded core while awaiting reload');await mixed.close();
  const huddle=await open('candidate','/',{stored:{xinzhi_huddle_ids:JSON.stringify([oldId])}});await huddle.page.locator('#openHuddleBtn').click();await huddle.page.waitForSelector('#huddleModalBackdrop.open');ok((await huddle.page.locator('#huddleModalBody').textContent()).includes(oldRow[8]),'saved annual paper restored by ID');await huddle.close();
  // A public API record learned before full feeds arrive must be reconciled
  // against static DOI identities without discarding its checked official title.
  const latePaper=parsed.FEEDS.items.find(p=>p.doi&&!p.autoPick&&!p.weeklyPick&&!p.hasDraft&&!parsed.LIBRARY.papers.some(l=>l.doi===p.doi));
  if(latePaper)for(const matches of [true,false]){
   const supplemental={id:'doi-ffffffffffffffff',doi:latePaper.doi,title:matches?latePaper.title:'Different official title for this DOI',date:latePaper.date,fulltextStatus:'available'};
   const s=await open('candidate','/?mode=library',{supplemental});
   await s.page.waitForFunction(doi=>window.LIBRARY.papers.some(p=>p.doi===doi),latePaper.doi);
   await s.page.locator('[data-mode="candidates"]').click();await ready(s);
   const entries=await s.page.evaluate(doi=>window.LIBRARY.papers.filter(p=>p.doi===doi).map(p=>({id:p.id,title:p.title,hasDraft:!!p.hasDraft})),latePaper.doi);
   eq(entries.length,1,'supplemental replay leaves one library entry');
   eq(entries[0].id,matches?latePaper.id:supplemental.id,'static identity reconciliation');
   eq(entries[0].title,supplemental.title,'official supplemental title preserved');
   if(!matches)eq(entries[0].hasDraft,false,'conflicting title cannot inherit a guide');
   await s.close();
  }
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,offline:true,version,modelCalls:0,records},null,2));console.log(JSON.stringify({passed:true,checks,offline:true,scenarios:records.length,output:out}));
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
