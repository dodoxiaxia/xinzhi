'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const {execFileSync} = require('child_process');
const {loadMap, startServer, runSteps} = require('./feature_map_walk.cjs');
const ROOT = path.resolve(__dirname, '..');
const map = loadMap();
const sections = [...map.sections, {id:'global', title:'全局', url:'/?mode=curated', ...map.global}];
const items = sections.flatMap(s => [...s.entries, ...s.states]);
const selector = id => { const item = items.find(i => i.id === id); if (!item) throw Error(`未知地图条目 ${id}: docs/feature-map.json`); return item.selector; };
const click = id => ({click:selector(id)}), wait = id => ({wait:selector(id)});
const library = {goto:'/?mode=library&lane=all'};
const interactions = [
  {id:'reader', title:'打开阅读面板', viewport:'mobile', steps:[library, click('curated-read'), wait('reader-open'), {shot:'reader'}]},
  {id:'tabs', title:'切换五个栏目', viewport:'mobile', steps:[{goto:'/?mode=curated'}, ...map.sections.slice(1).flatMap(s => [click(s.id==='sources' ? 'source-status-btn' : `nav-${s.id}`), {wait:s.entries[0].selector}])]},
  {id:'filters', title:'展开与关闭更多筛选', viewport:'mobile', steps:[library, click('curated-more'), wait('more-close'), {shot:'expanded'}, click('more-close')]},
  {id:'chips', title:'手机快捷条水平滑动', viewport:'mobile', steps:[library, wait('curated-chip-row'), {shot:'before'}, {shot:'swipe'}, {shot:'after'}]},
  {id:'search', title:'输入并清除搜索', viewport:'mobile', steps:[library, click('search-toggle-btn'), {fill:[selector('globalsearch'),'房颤']}, wait('clear-search'), {shot:'typed'}, click('clear-search')]},
  {id:'theme', title:'切换深浅色', viewport:'mobile', steps:[{goto:'/?mode=curated&theme=light'}, click('theme-toggle'), {shot:'dark'}, click('theme-toggle')]},
  {id:'shortlist', title:'加入并打开精选清单', viewport:'mobile', steps:[library, click('curated-star'), {click:'#openHuddleBtn'}, wait('shortlist-item')]},
  {id:'doi-empty', title:'DOI 搜索空状态', viewport:'mobile', steps:[{goto:'/?mode=library&q=10.9999/feature-map-unlisted'}, wait('request-fulltext')]}
];
function parse(argv) {
  const options = {};
  for (let i=0;i<argv.length;i++) {
    const key = argv[i];
    if (['--frames-only','--no-video','--self-test','--dry-run'].includes(key)) options[key.slice(2)] = true;
    else if (['--out','--public','--branch','--sections','--viewports','--interactions'].includes(key) && argv[i+1] && !argv[i+1].startsWith('--')) options[key.slice(2)] = argv[++i];
    else throw Error(`未知参数或缺少参数值: ${key}`);
  }
  return options;
}
function canonical(file) {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  return path.join(canonical(path.dirname(absolute)), path.basename(absolute));
}
function outputDirectory(file) {
  const resolved = canonical(file), root = canonical(ROOT);
  const relative = path.relative(root, resolved);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('输出目录必须在仓库外；请使用 /workspace/ui-evidence/<branch>');
  return resolved;
}
function pick(value, available) {
  const selected = !value || value === 'all' ? available : value.split(',');
  for (const name of selected) if (!available.includes(name)) throw Error(`未知选项: ${name}`);
  return [...new Set(selected)];
}
function validate(definitions) {
  const known = new Set(items.map(i => i.selector));
  for (const item of items) for (const step of item.setup || []) for (const key of ['click','fill','wait','hover','press','select']) if (step[key]) known.add(Array.isArray(step[key]) ? step[key][0] : step[key]);
  for (const flow of definitions) {
    assert(map.viewports[flow.viewport]);
    for (const step of flow.steps) {
      assert.equal(Object.keys(step).length, 1);
      const key = Object.keys(step)[0];
      assert(['goto','click','fill','wait','shot'].includes(key));
      if (['click','fill','wait'].includes(key)) assert(known.has(key === 'fill' ? step[key][0] : step[key]), `${flow.id}: 选择器需见 docs/feature-map.json`);
      if (key === 'goto') assert(step.goto.startsWith('/?mode='));
      if (key === 'shot') assert(/^[a-z-]+$/.test(step.shot));
    }
  }
}
const safe = value => String(value).replace(/[a-f0-9]{32,}/gi, '[省略]').replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
async function swipe(page) {
  const target = page.locator(selector('curated-chip-row')).first();
  await target.scrollIntoViewIfNeeded();
  const before = await page.evaluate(s => ({scrollY:window.scrollY, scrollLeft:document.querySelector(s).scrollLeft}), selector('curated-chip-row'));
  const box = await target.boundingBox();
  if (!box) throw Error('快捷条不可见');
  const client = await page.context().newCDPSession(page);
  try {
    const x = Math.min(box.x + box.width - 15, 375), y = box.y + box.height / 2;
    await client.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{x,y}]});
    for (let n=1;n<=8;n++) await client.send('Input.dispatchTouchEvent', {type:'touchMove', touchPoints:[{x:x-n*25,y}]});
    await client.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
    await page.waitForTimeout(200);
  } finally { await client.detach(); }
  const after = await page.evaluate(s => ({scrollY:window.scrollY, scrollLeft:document.querySelector(s).scrollLeft}), selector('curated-chip-row'));
  assert(after.scrollLeft > before.scrollLeft, '水平滑动未移动快捷条');
  assert(Math.abs(after.scrollY-before.scrollY) <= 2, '水平滑动改变了页面纵向位置');
  return {before,after};
}
async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const branch = options.branch || execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
  const out = outputDirectory(options.out || path.join('/workspace/ui-evidence',branch.replace(/[/\\]/g,'-')));
  const directory = path.resolve(options.public || path.join(ROOT,'public'));
  let selectedSections = pick(options.sections,sections.map(s=>s.id));
  let viewports = pick(options.viewports,Object.keys(map.viewports));
  let selectedFlows = pick(options.interactions,interactions.map(i=>i.id));
  if (options['self-test']) { selectedSections = [selectedSections[0]]; viewports = [viewports[0]]; selectedFlows = []; }
  const flows = interactions.filter(i=>selectedFlows.includes(i.id) && viewports.includes(i.viewport));
  validate(interactions);
  if (options['dry-run']) { console.log(`定义校验通过：${interactions.length} 项交互；${selectedSections.length} 个栏目；${viewports.join(', ')}；输出目录已验证`); return; }
  if (!fs.existsSync(path.join(directory,'public.js'))) { console.log('SKIP: public/ not built (python3 scripts/build_public.py)'); return; }
  fs.mkdirSync(out,{recursive:true});
  const started = Date.now();
  const builtTime = fs.statSync(path.join(directory,'public.js')).mtime.toISOString();
  const evidence = {branch:safe(branch), head:execFileSync('git',['rev-parse','--short=7','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim().slice(0,7), utc:new Date().toISOString(), viewports:Object.fromEntries(viewports.map(v=>[v,map.viewports[v]])), public:directory,builtTime,screenshots:[],interactions:[]};
  const host = await startServer(directory);
  let browser, deadline;
  const shot = async (page,file,fullPage=false) => { fs.mkdirSync(path.dirname(path.join(out,file)),{recursive:true}); await page.screenshot({path:path.join(out,file),fullPage, animations:'disabled',timeout:8000}); return file; };
  async function context(video, viewport) {
    const ctx = await browser.newContext({viewport:map.viewports[viewport],isMobile:viewport==='mobile',hasTouch:viewport==='mobile',reducedMotion:'reduce',locale:'zh-CN',timezoneId:'Asia/Shanghai',colorScheme:'light',serviceWorkers:'block', ...(video ? {recordVideo:{dir:path.join(out,'video'),size:map.viewports[viewport]}} : {})});
    await ctx.route('**/*', r=>new URL(r.request().url()).hostname==='127.0.0.1' ? r.continue() : r.abort());
    return ctx;
  }
  try {
    browser = await require('playwright').chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/usr/bin/google-chrome',args:['--no-sandbox']});
    deadline = setTimeout(() => { evidence.error='运行超过 225 秒限制'; browser.close().catch(()=>{}); }, 225000);
    for (const viewport of viewports) for (const section of sections.filter(s=>selectedSections.includes(s.id))) {
      const states = section.states.filter(s=>!s.skip && (!s.viewports || s.viewports.includes(viewport)));
      const chosen = states.some(s=>s.screenshot===true) ? states.filter(s=>s.screenshot===true) : states.slice(0,3);
      for (const state of [{id:'main',setup:[]},...chosen]) {
        const result = {viewport,section:section.id,state:state.id,status:'ok',files:[]};
        let ctx;
        try {
          ctx = await context(false,viewport); const page = await ctx.newPage(); page.setDefaultTimeout(2500); page.setDefaultNavigationTimeout(10000);
          await page.goto(host.origin+section.url); await runSteps(page,state.setup);
          if (state.selector) {
            await page.locator(state.selector).first().waitFor({state:state.expect==='attached' || state.expect?.startsWith('text:') ? 'attached':'visible'});
            if (state.expect?.startsWith('text:')) assert((await page.locator(state.selector).first().textContent()).includes(state.expect.slice(5)));
          }
          result.files.push(await shot(page,`${viewport}/${section.id}-${state.id}.png`));
          if (state.id==='main' && section.id!=='global') result.files.push(await shot(page,`${viewport}/${section.id}-main-fullPage.png`,true));
        } catch(e) { result.status='failed'; result.message=safe(e.message)+'；请检查 docs/feature-map.json'; }
        finally { if(ctx) await ctx.close(); }
        evidence.screenshots.push(result);
      }
    }
    for (const flow of flows) {
      const result = {...flow,status:'ok',frames:[]};
      let ctx, page, video, complete=false;
      let recording = !options['frames-only'] && !options['no-video'];
      try {
        try { ctx = await context(recording,flow.viewport); page=await ctx.newPage(); }
        catch(e) { if(ctx) await ctx.close(); if(!recording) throw e; recording=false; result.videoFallback='录像不可用，保存完整帧序列'; ctx=await context(false,flow.viewport); page=await ctx.newPage(); }
        page.setDefaultTimeout(2500); page.setDefaultNavigationTimeout(10000);
        video=page.video(); await page.goto(host.origin+'/?mode=curated');
        for (let n=0;n<flow.steps.length;n++) {
          const step=flow.steps[n];
          if (step.shot==='swipe') result.scroll=await swipe(page);
          else if (!step.shot) await runSteps(page,[step]);
          result.frames.push(await shot(page,`frames/${flow.id}/${String(n+1).padStart(2,'0')}-${step.shot || Object.keys(step)[0]}.png`));
        }
        complete=true;
      } catch(e) { result.status='failed'; result.message=safe(e.message)+'；请检查 docs/feature-map.json'; }
      finally {
        if(ctx) await ctx.close();
        if(video) {
          try { const file=await video.path(); const target=`video/${flow.id}.webm`; fs.renameSync(file,path.join(out,target)); result.video=target; }
          catch { result.videoFallback='录像保存失败，保留完整帧序列'; }
        }
        if(result.video && complete && !options['frames-only']) {
          for(const file of result.frames.slice(0,-1)) fs.unlinkSync(path.join(out,file));
          result.frames=result.frames.slice(-1);
        }
      }
      evidence.interactions.push(result);
    }
  } catch(e) { evidence.error=safe(e.message); }
  finally { clearTimeout(deadline); if(browser) await browser.close(); await host.close(); }
  evidence.seconds=Number(((Date.now()-started)/1000).toFixed(2));
  evidence.failed=Boolean(evidence.error || [...evidence.screenshots,...evidence.interactions].some(r=>r.status==='failed'));
  fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  const link = f=>`[${f}](${f})`;
  const lines=['# 界面验证产物','',`分支：${safe(branch)}；HEAD：${evidence.head}；UTC：${evidence.utc}`,`视口：${viewports.map(v=>`${v} ${map.viewports[v].width}×${map.viewports[v].height}`).join('、')}`,`公开目录：${safe(directory)}；构建文件时间：${builtTime}；耗时：${evidence.seconds} 秒`,'','| 视口 / 栏目 / 状态 | 截图 | 结果 |','| --- | --- | --- |',...evidence.screenshots.map(r=>`| ${r.viewport}/${r.section}/${r.state} | ${r.files.map(link).join('、')} | ${r.status} ${r.message || ''} |`),'','| 交互 | 视频 / 帧 | 步骤 | 结果 |','| --- | --- | --- | --- |',...evidence.interactions.map(r=>`| ${r.title} | ${[r.video,...r.frames].filter(Boolean).map(link).join('、')} | ${safe(JSON.stringify(r.steps))} | ${r.status} ${r.message || ''} ${r.videoFallback || ''} ${r.scroll ? safe(JSON.stringify(r.scroll)):''} |`),'',evidence.error || '', '将输出目录路径和 INDEX.md 路径粘贴到 PR 模板的「界面验证产物」部分。不要提交这些文件。',''];
  fs.writeFileSync(path.join(out,'INDEX.md'),lines.join('\n'));
  if(options['self-test']) {
    assert(!evidence.failed,'自检步骤失败');
    for(const file of ['INDEX.md','evidence.json',...evidence.screenshots.flatMap(r=>r.files)]) assert(fs.statSync(path.join(out,file)).size>0);
    assert(evidence.screenshots.length>0); console.log('自检通过');
  }
  console.log(`产物：${out}/INDEX.md；耗时 ${evidence.seconds} 秒`);
  if(evidence.failed) process.exitCode=1;
}
module.exports={main,interactions,validate,outputDirectory};
if(require.main===module) main().catch(e=>{ console.error(safe(e.message)); process.exitCode=1; });
