'use strict';
// Real browser, fixture bibliography and local downloads; all network intercepted.
const fs=require('fs'), path=require('path'), assert=require('assert');
const {chromium}=require('playwright');
const {papers,parseRis}=require('./test_citation_export.cjs');
const root=path.resolve(__dirname,'..'), origin='https://citation-export.invalid';
let checks=0;
const same=(a,b,label)=>{assert.deepStrictEqual(a,b,label);checks++;};
const check=(v,label)=>{assert(v,label);checks++;};
async function run(){
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium'});
  const evidence=path.join(root,'.local/citation-export-qa');fs.mkdirSync(evidence,{recursive:true});
  try {
    for(const width of [1280,390,320]){
      const context=await browser.newContext({viewport:{width,height:900},acceptDownloads:true});
      const page=await context.newPage(), errors=[], calls=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(ids=>{
        localStorage.setItem('xinzhi_huddle_ids',JSON.stringify(ids));
        window.__copies=[];
        Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.__copies.push(text)}});
      },papers.map(p=>p.id));
      const data={
        '/data/library.js':'window.LIBRARY='+JSON.stringify({papers}),
        '/data/candidates.js':'window.FEEDS='+JSON.stringify({items:[],updatedAt:'2026-10-07'}),
        '/data/source-health.js':'window.SOURCE_HEALTH={sources:[]}',
        '/data/curated.js':'window.CURATED=[]',
        '/data/quicklooks.js':'window.QUICKLOOKS={items:{}}'
      };
      await page.route('**/*',async route=>{
        const request=route.request(), u=new URL(request.url());
        assert.equal(u.origin,origin,'No external requests'); calls.push(u.pathname);
        if(u.pathname.startsWith('/api/')){assert.equal(request.method(),'GET','No model mutations');await route.fulfill({json:{ok:true,available:false,found:false,canGenerate:false}});return;}
        if(data[u.pathname]){await route.fulfill({body:data[u.pathname],contentType:'application/javascript'});return;}
        const name=u.pathname==='/'?'index.html':u.pathname.slice(1);
        assert(['index.html','app.js','citation-export.js','journal-metrics.js','style.css','icon.png','config/journal-metrics.json'].includes(name),'Expected local asset '+name);
        await route.fulfill({body:fs.readFileSync(path.join(root,name)),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':name.endsWith('.png')?'image/png':'text/html'});
      });
      await page.goto(origin,{waitUntil:'networkidle'});
      await page.locator('#openHuddleBtn').click();
      const panel=page.locator('[data-citation-export]');
      await panel.locator('summary').click();
      same(await panel.locator('input:checked').count(),5,'Default all selected at '+width);
      const requestsBefore=calls.length;
      for(const id of ['en','alias','missing'])await panel.locator(`[data-citation-id="${id}"]`).uncheck();
      same(await panel.locator('input:checked').count(),2,'Subset selected at '+width);
      check((await panel.locator('[role=status]').innerText()).includes('导出 2 条'),'Count shows subset');
      for(const format of ['gb','ama','bibtex']){
        await panel.locator('select').selectOption(format);
        await panel.locator('[data-citation-copy]').click();
        const copy=await page.evaluate(()=>window.__copies.at(-1));
        check(copy.includes(papers[0].title) && copy.includes(papers[3].title),'Copied selected titles');
        check(!copy.includes(papers[1].title) && !copy.includes(papers[4].title),'Omitted unselected titles');
        check(copy.includes('题录核对提示') && copy.includes('卷期/页码'),'Copy has individual warnings');
      }
      const pending=page.waitForEvent('download');await panel.locator('[data-citation-ris]').click();
      const download=await pending;
      check(download.suggestedFilename().startsWith('精选文献引用-')&&download.suggestedFilename().endsWith('.ris'),'Chinese RIS filename');
      const file=path.join(evidence,`subset-${width}.ris`);await download.saveAs(file);
      const downloaded=fs.readFileSync(file), text=new TextDecoder('utf-8',{fatal:true}).decode(downloaded), records=parseRis(text);
      same(records.map(r=>r.TI[0]),[papers[0].title,papers[3].title],'Actual downloaded RIS parsed back');
      same(records[0].AU,papers[0].authors,'Downloaded authors intact');
      same(calls.length,requestsBefore,'Export and selection make no network requests');
      check((await panel.locator('[role=status]').innerText()).includes('已导出 2 条'),'Download announces accurate count');
      // Rerender through existing removal keeps the independent export subset.
      await page.locator('[data-action="remove-huddle"][data-paper-id="missing"]').click();
      await panel.locator('summary').click();
      same(await panel.locator('input:checked').count(),2,'Selection survives modal rerender');
      for(const id of ['cn','no-doi'])await panel.locator(`[data-citation-id="${id}"]`).uncheck();
      check(await panel.locator('[data-citation-ris]').isDisabled(),'Explicit empty subset cannot export');
      check(await panel.locator('[data-citation-copy]').isDisabled(),'Explicit empty subset cannot copy');
      await panel.locator('[data-citation-id="en"]').check();
      await panel.locator('[data-citation-id="alias"]').check();
      check((await panel.locator('[role=status]').innerText()).includes('导出 1 条'),'DOI aliases dedup in actual UI');
      check((await panel.locator('ul').innerText()).includes('重复条目'),'Duplicate notice in actual UI');
      check(await panel.locator('ul').evaluate(el=>!el.querySelector('script')),'Metadata is rendered as text');
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No page overflow at '+width);
      same(errors,[],'No page errors at '+width);
      await page.screenshot({path:path.join(evidence,`panel-${width}.png`),fullPage:false});
      await context.close();
    }
    fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({checks,widths:[1280,390,320],scope:'Offline synthetic bibliography. No production or model calls.'},null,2)+'\n');
    console.log(`${checks} offline citation-export browser assertions passed`);
  } finally {await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
