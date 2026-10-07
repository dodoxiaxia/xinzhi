'use strict';
// Pure offline contracts: execute the actual weekly helpers and renderer only.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const code=src.slice(src.indexOf('  // Weekly board dates are publication days'),src.indexOf('  function renderNextCandidates()'));
assert(code.includes('function weeklyPublicationDate') && code.includes('function renderWeeklyAuto'));
const now=Date.parse('2026-10-07T02:00:00Z');
class FixedDate extends Date { static now(){return now;} }
let node={innerHTML:''};
const ctx=vm.createContext({Date:FixedDate,Intl,$:()=>node,FEEDS:{items:[]},state:{huddle:[]},
 esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 contentDate:value=>value,quicklookOf:()=>null,getPublisherClass:()=>'',getDesignClass:()=>'',hasAbstract:()=>true,
 journalMetricBadge:()=>'',preGeneratedOf:()=>null,validTranslation:tr=>!!tr?.abstract_zh,LIVE_TR:{},trKeyOf:()=>''});
const designStart=src.indexOf('  // Study design badge class');
const designEnd=src.indexOf('  //',designStart+5);
vm.runInContext(src.slice(designStart,designEnd),ctx);
vm.runInContext(code,ctx);
let checks=0;const eq=(a,b,label)=>{assert.deepStrictEqual(a,b,label);checks++;};
const plain=x=>JSON.parse(JSON.stringify(x));
const paper=(date,extra={})=>({id:date,title:date,date,weeklyPick:1,weeklyCategory:'cardio',...extra});
for(const date of ['','2026','2026-10','2026-2-01','2026-02-29','2026-02-30','2026-04-31','2026-00-01','2026-13-01','2026-10-00','0000-01-01','2026-10-07junk','2026-10-01T24:00:00Z','2026-10-01T01:60:00Z','2026-10-01T01:00:60Z','2026-10-01T01:00:00','2026-10-01T01:00:00+99:00','2026-10-01T01:00:00+08:99'])
 eq(ctx.weeklyPublicationDate(paper(date),now),'','reject invalid '+date);
for(const precision of ['month','year','unknown','timestamp'])
 eq(ctx.weeklyPublicationDate(paper('2026-10-07',{datePrecision:precision}),now),'','reject non-day '+precision);
eq(ctx.weeklyPublicationDate(paper('2026-10-07'),now),'2026-10-07','legacy full date accepted');
eq(ctx.weeklyPublicationDate(paper('2026-10-07',{datePrecision:'day'}),now),'2026-10-07','explicit day accepted');
eq(ctx.weeklyPublicationDate(paper('2026-10-01',{dateBasis:'published-print'}),now),'','known month issue not promoted');
eq(ctx.weeklyPublicationDate(paper('2024-02-29'),now),'2024-02-29','valid leap day');
eq(ctx.weeklyPublicationDate(paper('1900-02-29'),now),'','non-leap century');
eq(ctx.weeklyPublicationDate(paper('2000-02-29'),now),'2000-02-29','leap century');
for(const [value,date] of [['2026-09-30T16:00:00Z','2026-10-01'],['2026-09-30T15:59:59Z','2026-09-30'],['2026-10-06T16:00:00Z','2026-10-07'],['2026-10-01T00:00:00+08:00','2026-10-01'],['2026-10-01T00:00:00+0800','2026-10-01'],['2026-10-01T00:00-05:00','2026-10-01'],['2026-10-01T00:00:00.123+08:00','2026-10-01']])
 eq(ctx.weeklyPublicationDate(paper(value),now),date,'normalize timezone '+value);
eq(ctx.weeklyPublicationDate(paper('2026-10-07T03:00:00Z'),now),'','exclude future timestamp even same Beijing day');
eq(ctx.weeklyPublicationDate(paper('2026-10-07T16:00:00Z'),now),'','exclude future Beijing day');
const inputs=Object.freeze([
 Object.freeze(paper('2026-09-30',{weeklyPick:1})),Object.freeze(paper('2026-10-01',{weeklyPick:3})),
 Object.freeze(paper('2026-10-07',{weeklyPick:2})),Object.freeze(paper('2026-10-08',{weeklyPick:4})),
 Object.freeze(paper('2026-09-30T16:00:00Z',{weeklyPick:5})),Object.freeze(paper('2026-09-30T15:59:59Z',{weeklyPick:6})),
 Object.freeze(paper('2026-10-06',{weeklyPick:0})),Object.freeze(paper('2026-10',{datePrecision:'month',weeklyPick:7}))]);
const before=JSON.stringify(inputs),win=ctx.weeklyPublicationWindow(inputs,now);
eq([win.start,win.end],['2026-10-01','2026-10-07'],'inclusive Beijing seven-day window');
eq(plain(win.entries).map(x=>[x.paper.weeklyPick,x.date]),[[2,'2026-10-07'],[3,'2026-10-01'],[5,'2026-10-01']],'filter and retain rank ordering');
eq(JSON.stringify(inputs),before,'source feed/archive records never changed');
eq(ctx.weeklyPublicationWindow([],Date.parse('2026-10-06T15:59:59Z')).end,'2026-10-06','before Beijing midnight');
eq(ctx.weeklyPublicationWindow([],Date.parse('2026-10-06T16:00:00Z')).end,'2026-10-07','at Beijing midnight');
const feb=ctx.weeklyPublicationWindow([paper('2024-02-29'),paper('2024-02-30')],Date.parse('2024-03-02T02:00:00Z'));
eq(plain(feb.entries).map(x=>x.date),['2024-02-29'],'February overflow not normalized into March');
function render(items,updatedAt){ctx.FEEDS={items,updatedAt};node.innerHTML='';ctx.renderWeeklyAuto();return node.innerHTML;}
let html=render([paper('2026-09-30')],'2026-10-07T01:00:00Z');
eq(html.includes('近7天暂无入榜条目'),true,'empty board remains visible');
eq(html.includes('尚未发布'),false,'no fulltext placeholder');
eq(html.includes('来源更新于'),true,'fallback is labelled source freshness');
eq(html.includes('更新已超过 6 小时'),false,'fresh source update');
html=render([paper('2026-09-30T16:00:00Z',{weeklyAt:'2026-10-06T00:00:00Z'})],'2026-10-07T01:00:00Z');
eq(ctx.designBadgeHtml({studyDesign:'RCT'}).includes('design-unverified'),true,'automatic study type has distinct unverified styling');
eq(ctx.designBadgeHtml({studyDesign:'RCT'}).includes('design-rct'),false,'unverified RCT is never a checked solid badge');
eq(ctx.designBadgeHtml({studyDesign:'RCT',hasDraft:true,draftData:{source_checked:true}}).includes('design-checked'),true,'source-checked design remains distinct');
eq(html.includes('<span class="date-badge">2026-10-01</span>'),true,'display normalized publication date');
eq(html.includes('榜单更新于 2026-10-06T00:00:00Z'),true,'pick metadata wins over fresher source');
eq(html.includes('更新已超过 6 小时，时效待确认'),true,'six-hour stale board warning');
eq(html.includes('阅读原摘要'),true,'original reader button preserved');
eq(html.includes('阅读摘要 · 中英对照'),false,'missing translation is not advertised as bilingual');
eq(html.includes('加入精选清单'),true,'saved selection button preserved with updated visible name');
eq(html.includes('weekly-prep-note'),false,'no per-card missing AI placeholder');
eq(html.includes('中文摘要 0/1'),true,'missing translation coverage is still transparently reported once');
html=render([paper('2026-10-07',{weeklyAt:'2026-10-06T20:00:00Z'})]);
eq(html.includes('更新已超过 6 小时'),false,'exact six hours remains within threshold');
html=render([paper('2026-10-07',{weeklyAt:'2026-10-06T19:59:59Z'})]);
eq(html.includes('更新已超过 6 小时'),true,'one second beyond six-hour threshold');
for(const value of [undefined,'bad','2026-02-30T00:00:00Z','2026-10-08T00:00:00Z','2026-10-07']) {
 html=render([],value);eq(html.includes('更新时间暂无有效记录，时效待确认'),true,'missing/invalid/future/day-only update '+value);
}
eq(render([paper('2026-10-07',{weeklyPick:2,weeklyAt:'2026-10-07T00:00:00Z'}),paper('2026-10-01',{weeklyPick:1,weeklyAt:'2026-10-07T01:00:00Z'})]).includes('榜单更新于 2026-10-07T01:00:00Z'),true,'latest valid pick metadata');
console.log(JSON.stringify({passed:true,checks,networkCalls:0,scope:'weekly helpers and renderer only'}));
