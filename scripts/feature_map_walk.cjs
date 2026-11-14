'use strict';
const {bundleText, appFile} = require('./public_bundle.cjs');
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.resolve(__dirname, '..');
function loadMap(file = path.join(ROOT, 'docs/feature-map.json')) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
async function startServer(directory = path.join(ROOT, 'public')) {
  const root = path.resolve(directory), cache = new Map();
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch { res.writeHead(400).end(); return; }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const send = (error, body) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', ({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.xml':'application/xml'})[path.extname(file)] || 'application/octet-stream');
      res.end(body);
    };
    if (cache.has(file)) send(null, cache.get(file));
    else fs.readFile(file, (error, body) => { if (!error) cache.set(file, body); send(error, body); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
async function runSteps(page, steps = []) {
  for (const step of steps) {
    if (step.goto) await page.goto(new URL(step.goto, page.url()).href, {waitUntil:'load'});
    else if (step.click) await page.locator(step.click).first().click();
    else if (step.fill) await page.locator(step.fill[0]).first().fill(step.fill[1]);
    else if (step.wait) await page.locator(step.wait).first().waitFor({state:'visible'});
    else if (step.hover) await page.locator(step.hover).first().hover();
    else if (step.press) await page.locator(step.press[0]).first().press(step.press[1]);
    else if (step.select) await page.locator(step.select[0]).first().selectOption(step.select[1]);
    else throw new Error('Unknown setup step: ' + JSON.stringify(step));
  }
}
function missing(section, item, viewport) {
  return `feature map selector not found: ${section}/${item.id} ${item.selector} (${viewport}) -> the UI changed: update docs/feature-map.json (and run node scripts/feature_map_md.cjs), see docs/feature-map.md`;
}
async function walk(options = {}) {
  const map = options.map || loadMap(), directory = options.public || path.join(ROOT, 'public');
  if (!fs.existsSync(path.join(directory, 'index.html'))) { console.log('SKIP: public/ not built (python3 scripts/build_public.py)'); return {results:[], failed:0, skippedPublic:true}; }
  const source = bundleText(directory);
  const snapshotTime = source.match(/"builtAt":"([^"]+)"/)?.[1] || fs.statSync(path.join(directory, appFile(directory))).mtime.toISOString();
  const {chromium} = require('playwright');
  const host = await startServer(directory);
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH || '/usr/bin/google-chrome', args:['--no-sandbox']});
    const names = !options.viewport || options.viewport === 'all' ? Object.keys(map.viewports) : [options.viewport];
    for (const viewport of names) {
      if (!map.viewports[viewport]) throw Error('Unknown viewport: ' + viewport);
      const context = await browser.newContext({viewport:map.viewports[viewport], reducedMotion:'reduce', locale:'zh-CN', timezoneId:'Asia/Shanghai', colorScheme:'light', serviceWorkers:'block'});
      await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      const page = await context.newPage(); page.setDefaultTimeout(3000);
      await page.clock.setFixedTime(new Date(snapshotTime));
      await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
      const sections = [...map.sections, {id:'global', url:'/?mode=curated', ...map.global}].filter(s => !options.section || s.id === options.section);
      if (!sections.length) throw Error('Unknown section: ' + options.section);
      for (const section of sections) {
        const groups = new Map();
        for (const item of [...section.entries, ...section.states.map(s => ({...s, isState:true}))]) {
          if (item.skip || (item.viewports && !item.viewports.includes(viewport))) {
            const reason = item.skip || '此视口不要求显示';
            results.push({viewport, section:section.id, id:item.id, status:'skipped', reason});
            if (item.skip) console.log(`SKIP ${section.id}/${item.id}: ${reason}`);
            continue;
          }
          const key = JSON.stringify(item.setup || []);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(item);
        }
        for (const [key, items] of groups) {
          let setupError;
          try {
            await context.clearCookies();
            await page.goto(host.origin + section.url, {waitUntil:'load'});
            await runSteps(page, JSON.parse(key));
          } catch (e) { setupError = e.message; }
          for (const item of items) {
            try {
              if (setupError) throw Error('Setup failed: ' + setupError);
              const element = page.locator(item.selector).first();
              try { await element.waitFor({state:'attached'}); } catch { throw Error(missing(section.id, item, viewport)); }
              if (item.expect !== 'attached') await element.waitFor({state:'visible'});
              if (item.expect?.startsWith('text:')) {
                const expected = item.expect.slice(5);
                await page.waitForFunction(({selector,expected}) => document.querySelector(selector)?.textContent.includes(expected), {selector:item.selector,expected});
              }
              results.push({viewport, section:section.id, id:item.id, status:'ok'});
            } catch (e) {
              const message = e.message.includes('feature map selector not found:') ? e.message : `${missing(section.id,item,viewport)}\n${e.message}`;
              console.error(message); results.push({viewport,section:section.id,id:item.id,status:'failed',message});
            }
          }
        }
      }
      await context.close();
    }
  } finally { if (browser) await browser.close(); await host.close(); }
  const summary = Object.keys(map.viewports).filter(v => results.some(r => r.viewport === v)).map(viewport => ({viewport,...Object.fromEntries(['ok','failed','skipped'].map(s => [s,results.filter(r => r.viewport === viewport && r.status === s).length]))}));
  console.table(summary);
  return {summary, results, failed:results.filter(r => r.status === 'failed').length};
}
module.exports = {loadMap,startServer,walk,runSteps};
if (require.main === module) (async () => {
  const options = {};
  for (let i=2; i<process.argv.length; i++) { const arg=process.argv[i]; if (!['--viewport','--section','--public','--json'].includes(arg) || !process.argv[i+1]) throw Error('Usage: feature_map_walk.cjs [--viewport mobile|tablet|desktop|all] [--section id] [--public DIR] [--json out.json]'); options[arg.slice(2)] = process.argv[++i]; }
  const result = await walk(options);
  if (options.json) fs.writeFileSync(options.json, JSON.stringify(result,null,2)+'\n');
  if (result.failed) process.exitCode=1;
})().catch(e => {console.error(e); process.exitCode=1;});
