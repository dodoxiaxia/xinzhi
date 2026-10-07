'use strict';
// Offline browser test: all documents, assets, data and API requests are intercepted.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const assets = process.env.XINZHI_TEST_ASSET_ROOT || root;
const origin = 'https://boot-url.invalid';
const date = new Date().toISOString().slice(0, 10);
const paper = { id: 'fixture', pmid: '1', title: 'Offline atrial fibrillation public title', date, datePrecision: 'day', journal: 'Circulation', cleanJournal: 'Circulation', publisher: 'AHA', clinicalTier: '心血管', tags: [], studyDesign: 'RCT', summary: 'Offline public abstract.', url: 'https://pubmed.ncbi.nlm.nih.gov/1/', autoPick: { d: date, r: 1 } };
const scripts = {
  '/data/library.js': 'window.LIBRARY=' + JSON.stringify({ papers: [paper] }),
  '/data/candidates.js': 'window.FEEDS=' + JSON.stringify({ updatedAt: date, items: [paper] }),
  '/data/source-health.js': 'window.SOURCE_HEALTH={sources:[]}',
  '/data/curated.js': 'window.CURATED=[]',
  '/data/quicklooks.js': 'window.QUICKLOOKS={items:{}}'
};
let checks = 0;
const eq = (actual, expected, label) => { assert.deepStrictEqual(actual, expected, label); checks++; };
const colors = { light: { a: '#eef2f7', b: '#ffffff', c: '#f0f2f4', d: '#f5f2ea' }, dark: { a: '#0e1520', b: '#121212', c: '#121517', d: '#14120f' } };
const accent = { light: { a:'#1b4f9c', b:'#d13a1f', c:'#0b8f7e', d:'#9b2335' }, dark:{ a:'#78aeff', b:'#ff6b4d', c:'#40cdb7', d:'#e0707a' } };
const rgb = hex => 'rgb(' + hex.slice(1).match(/../g).map(x => parseInt(x,16)).join(', ') + ')';
async function snapshot(page) {
  return page.evaluate(() => ({ style:document.documentElement.dataset.style, theme:document.documentElement.dataset.theme,
    scheme:document.documentElement.style.colorScheme, background:document.documentElement.style.backgroundColor,
    body:document.body && getComputedStyle(document.body).backgroundColor,
    accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    bar:document.querySelector('meta[name="theme-color"]').content }));
}
async function run() {
  const browser = await chromium.launch({ headless:true, executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const evidence = [];
  try {
    async function scenario(name, url, stored, expected, options={}) {
      const context = await browser.newContext({ colorScheme:options.system || 'light' });
      const page = await context.newPage(), errors=[], requests=[];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({stored, blocked}) => {
        if (blocked) Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError')}});
        else for (const [key,value] of Object.entries(stored)) localStorage.setItem(key,value);
      }, {stored, blocked:!!options.blocked});
      let releaseCss, releaseApp;
      const cssGate = new Promise(resolve => releaseCss=resolve), appGate = new Promise(resolve => releaseApp=resolve);
      let hold=true;
      await page.route('**/*', async route => {
        const req=route.request(), u=new URL(req.url()); requests.push({url:u.href,method:req.method()});
        assert.strictEqual(u.origin,origin,'No external requests');
        if (u.pathname.startsWith('/api/')) { assert.strictEqual(req.method(),'GET','No model mutations'); await route.fulfill({json:{ok:true,found:false,canGenerate:false}}); return; }
        if (u.pathname==='/style.css') { if(hold) await cssGate; await route.fulfill({body:fs.readFileSync(path.join(assets,'style.css')),contentType:'text/css'}); return; }
        if (u.pathname==='/app.js') { if(hold) await appGate; await route.fulfill({body:fs.readFileSync(path.join(root,'app.js')),contentType:'application/javascript'}); return; }
        if (scripts[u.pathname]) { await route.fulfill({body:scripts[u.pathname],contentType:'application/javascript'}); return; }
        if (u.pathname==='/icon.svg') { await route.fulfill({body:'<svg xmlns="http://www.w3.org/2000/svg"/>',contentType:'image/svg+xml'}); return; }
        if (u.pathname==='/' || u.pathname==='/index.html') { await route.fulfill({body:fs.readFileSync(path.join(root,'index.html')),contentType:'text/html'}); return; }
        throw Error('Unexpected offline request '+u.href);
      });
      await page.goto(origin+url,{waitUntil:'commit'});
      await page.waitForFunction(() => !!window.XINZHI_BOOT);
      const beforeCss=await snapshot(page);
      eq([beforeCss.style,beforeCss.theme,beforeCss.scheme,beforeCss.background],[expected.style,expected.theme,expected.theme,rgb(colors[expected.theme][expected.style])],name+' appearance before CSS');
      releaseCss();
      await page.waitForFunction(() => !!document.getElementById('themeToggle') && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
      const beforeApp=await snapshot(page);
      eq(beforeApp.accent,accent[expected.theme][expected.style],name+' pre-app accent');
      eq(beforeApp.body,rgb(colors[expected.theme][expected.style]),name+' pre-app body background');
      releaseApp(); hold=false;
      await page.waitForLoadState('load');
      await page.waitForFunction(() => document.getElementById('styleBtnLabel').textContent !== '风格');
      const after=await snapshot(page);
      eq(after,beforeApp,name+' no appearance change at app initialization');
      eq(new URL(page.url()).searchParams.get('view'),expected.viewParam || null,name+' URL view');
      eq(await page.locator('#viewCompactBtn').evaluate(el=>el.classList.contains('active')),expected.view==='compact',name+' selected view');
      const initializedUrl = page.url();
      if(name.startsWith('bare ')) eq(initializedUrl, origin+'/', name+' leaves entire bare address unchanged');
      if(options.params) {
        for(const [key,value] of Object.entries(options.params)) eq(new URL(page.url()).searchParams.get(key),value,name+' keeps '+key);
        eq(new URL(page.url()).hash,options.hash || '',name+' keeps hash');
      }
      if(options.drawer) eq(await page.locator('#readerDrawer').evaluate(el=>el.classList.contains('open')),true,name+' drawer deep link');
      if(options.toggle) {
        await page.click('#viewCardsBtn');
        eq(new URL(page.url()).searchParams.get('view'),'cards',name+' explicit cards toggle survives local compact');
      }
      await page.reload({waitUntil:'load'});
      eq(new URL(page.url()).searchParams.get('view'),options.toggle?'cards':expected.viewParam || null,name+' stable reload URL');
      eq(await page.locator('#viewCompactBtn').evaluate(el=>el.classList.contains('active')),options.toggle?false:expected.view==='compact',name+' stable reload view');
      if(options.toggleAppearance) {
        await page.click('#themeToggle');
        await page.click('#styleBtn');
        await page.click('[data-s="d"]');
        const changed=await snapshot(page), t=expected.theme==='light'?'dark':'light';
        eq([changed.theme,changed.style,changed.scheme,changed.background,changed.body],[t,'d',t,rgb(colors[t].d),rgb(colors[t].d)],name+' appearance toggles keep root canvas consistent');
      }
      eq(errors,[],name+' no page errors');
      eq(requests.every(r=>['GET','HEAD'].includes(r.method)),true,name+' all requests read-only and intercepted');
      evidence.push({name,beforeCss,beforeApp,after,initializedUrl,url:page.url(),requests:requests.length});
      await context.close();
    }
    for (const theme of ['light','dark']) for (const style of ['a','b','c','d'])
      await scenario('appearance '+style+' '+theme,'/?style='+style+'&theme='+theme,{}, {style,theme,view:'cards'},{params:{style,theme}});
    await scenario('bare default','/',{}, {style:'a',theme:'light',view:'cards'}, {toggleAppearance:true});
    await scenario('bare saved compact','/',{'xinzhi_view_mode':'compact','xz-style':'c','xinzhi_theme':'dark'},{style:'c',theme:'dark',view:'compact'},{toggle:true});
    await scenario('explicit cards overrides compact','/?view=cards',{'xinzhi_view_mode':'compact'},{style:'a',theme:'light',view:'cards',viewParam:'cards'});
    await scenario('explicit compact overrides cards','/?view=compact',{'xinzhi_view_mode':'cards'},{style:'a',theme:'light',view:'compact',viewParam:'compact'});
    await scenario('query appearance wins','/?style=b&theme=dark',{'xz-style':'c','xinzhi_theme':'light'},{style:'b',theme:'dark',view:'cards'});
    await scenario('invalid query uses valid saved','/?style=invalid&theme=invalid&view=invalid',{'xz-style':'d','xinzhi_theme':'dark','xinzhi_view_mode':'compact'},{style:'d',theme:'dark',view:'compact'});
    await scenario('invalid saved uses system','/',{'xz-style':'invalid','xinzhi_theme':'invalid','xinzhi_view_mode':'invalid'},{style:'a',theme:'dark',view:'cards'},{system:'dark'});
    await scenario('storage refused query','/?style=c&theme=dark&view=cards',{}, {style:'c',theme:'dark',view:'cards',viewParam:'cards'},{blocked:true,toggleAppearance:true});
    await scenario('storage refused system','/',{}, {style:'a',theme:'dark',view:'cards'},{blocked:true,system:'dark'});
    await scenario('filter hash and drawer','/?mode=candidates&q=Offline&range=365&reading=abstract&drawer=first#paper',{'xinzhi_view_mode':'compact'}, {style:'a',theme:'light',view:'compact',viewParam:'compact'},{params:{mode:'candidates',q:'Offline',range:'365',reading:'abstract',drawer:'first'},hash:'#paper',drawer:true});
    await scenario('invalid mode preserves hash','/?mode=invalid#keep',{}, {style:'a',theme:'light',view:'cards'},{params:{mode:null},hash:'#keep'});
    await scenario('sources mode bare saved view','/?mode=sources#health',{'xinzhi_view_mode':'compact'}, {style:'a',theme:'light',view:'compact'},{params:{mode:'sources'},hash:'#health'});
    console.log(JSON.stringify({passed:true,scenarios:evidence.length,checks,evidence},null,2));
  } finally { await browser.close(); }
}
run().catch(error=>{console.error(error);process.exitCode=1});
