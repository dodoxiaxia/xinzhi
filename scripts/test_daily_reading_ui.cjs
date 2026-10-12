'use strict';
// Exercise the actual reading helpers; fixtures do not call the network or models.
const fs=require('fs'), path=require('path'), vm=require('vm'), assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const start=src.indexOf('  let deepReadingHistoryLimit = 12;'), end=src.indexOf('  function renderWeeklyHeader() {',start);
assert(start>=0&&end>start);
const node={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
const ctx=vm.createContext({window:{},$:(selector)=>selector==='#dailyDeepRead'?node:null,beijingToday:()=> '2026-10-09',contentDate:()=> '10/9 05:17',
esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
vm.runInContext(src.slice(start,end),ctx);
const p=(n,day)=>({pmcid:'PMC'+n,title:'Original title',titleZh:'中文精读题名',journal:'Journal',date:'2026-10-07',publishedOn:day,generatedAt:day+'T01:00:00Z',scope:'public-fulltext-body',humanReviewed:false,
sections:Object.fromEntries(['question','design','findings','limitations','practice'].map(k=>[k,{text:'离线测试内容。',evidence:[{quote:'Original evidence quote.',section:'Methods',paragraph:'p1'}]}]))});
ctx.window.DEEP_READINGS={items:[p(1,'2026-10-09'),p(2,'2026-10-08'),p(3,'2026-10-10'),{...p(4,'2026-10-09'),scope:'public-abstract'}],status:{day:'2026-10-09',reason:'model_unavailable'},updatedAt:'2026-10-09T01:17:00Z'};
const groups=ctx.dailyReadingGroups(ctx.window.DEEP_READINGS);
assert.equal(groups.todayCount,1);assert.equal(groups.latest.length,1);assert.equal(groups.history.length,1);
ctx.renderDailyDeepRead();
assert(node.innerHTML.includes('今日已更新 <b>1</b> 篇'));assert(node.innerHTML.includes('往期精读 · 1 篇'));assert(node.innerHTML.includes('暂时不可用'));
assert(!node.innerHTML.includes('data-deep-reading="PMC3"'));assert(!node.innerHTML.includes('data-deep-reading="PMC4"'));
assert(node.innerHTML.includes('AI 全文精读 · 未经人工审核'));assert(node.innerHTML.includes('data-action="open-deep-reading" data-reading-id="PMC1"'));
// The rail lists readings only; the text, evidence and source links render in the reading panel.
assert(!node.innerHTML.includes('deep-reading-section'));
assert.deepEqual(ctx.dailyReadingList(ctx.window.DEEP_READINGS).map(p=>p.pmcid),['PMC1','PMC2']);
const body=ctx.deepReadingBody(p(1,'2026-10-09'));assert(body.includes('基于开放全文正文'));assert(body.includes('查看原文证据 · 1 处'));
for(const key of ['question','design','findings','limitations','practice'])assert(body.includes('id="dr-'+key+'" data-toc='));
assert(ctx.deepReadingLinks(p(1,'2026-10-09')).includes('https://europepmc.org/articles/PMC1'));
const bad={...p(5,'2026-10-09'),titleZh:'<img src=x onerror=alert(1)>',journal:'<script>bad</script>',sections:{findings:{text:'<svg onload=bad()>',evidence:[]}}};
const rendered=ctx.dailyReadingItem(bad)+ctx.deepReadingBody(bad);assert(!rendered.includes('<img'));assert(!rendered.includes('<script>bad'));assert(!rendered.includes('<svg'));
ctx.window.DEEP_READINGS={items:[]};ctx.renderDailyDeepRead();assert(node.innerHTML.includes('尚未完成'));
ctx.window.DEEP_READINGS={items:[p(1,'2026-10-08')]};ctx.renderDailyDeepRead();assert(node.innerHTML.includes('最新批次 · 2026-10-08'));assert(node.innerHTML.includes('今日已更新 <b>0</b> 篇'));
console.log('daily full-text reading UI contracts passed');
