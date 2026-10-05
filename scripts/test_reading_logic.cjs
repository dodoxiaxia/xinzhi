const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(require('path').join(__dirname,'../app.js'),'utf8');
const fn=n=>{const m=src.match(new RegExp('  function '+n+'\\([^]*?\\n  }'));if(!m)throw Error(n);return m[0];};
const cs=n=>src.match(new RegExp('  const '+n+' =[^]*?;'))[0];
const code=[cs('ZH_EN'),cs('zhTerms'),cs('CARDIO_TIERS'),cs('AI_RE'),cs('CARDIO_RE'),cs('_rs'),...['queryMatches','paperText','laneOf','isCrossAI','quicklookOf','hasAbstract','datePrecision','dateLabel','safeSourceUrl','rangeStart','getCuratedList','publishedDate'].map(fn)].join('\n');
const c=vm.createContext({window:{QUICKLOOKS:{}},state:{range:'7'},beijingToday:()=> '2026-09-30',FEEDS:{items:[],updatedAt:'2026-10-01'},LIBRARY:{papers:[]},CURATED:[{id:'keep',doi:'10.1/keep',hasDraft:true,draftData:{published:'2026-09-29'}}]});vm.runInContext(code,c);
// Install the fixture clock after extracted helpers have defined their functions.
c.beijingToday=()=> '2026-09-30';
assert(c.queryMatches('atrial fibrillation ablation','房颤消融'));assert(c.queryMatches('atrial fibrillation ablation','房颤 消融'));assert(!c.queryMatches('atrial fibrillation','房颤消融'));
assert(!c.isCrossAI({title:'Electrocardiographic changes in atrial fibrillation',clinicalTier:'心律失常与电生理',tags:['#AI-ECG']}));assert(c.isCrossAI({title:'Artificial intelligence electrocardiographic age in atrial fibrillation',clinicalTier:'心律失常与电生理'}));
assert.equal(c.laneOf({title:'Deep learning for metal microstructure'}),'aitech');assert.equal(c.laneOf({title:'Deep learning for patient diagnosis'}),'aimed');
assert.equal(c.rangeStart(),'2026-09-24');assert.equal(c.datePrecision({date:'2026-09-01',dateBasis:'Crossref published-print'}),'month');assert.equal(c.datePrecision({date:'2026-09-01',dateBasis:'ArticleDate'}),'day');assert.equal(c.dateLabel({}),'日期待核验');
assert.equal(c.safeSourceUrl({url:'javascript:alert(1)'}),'');assert.equal(c.getCuratedList().length,1);assert.equal(c.publishedDate(c.getCuratedList()[0]),'2026-09-29');
assert.equal(c.laneOf({title:'Total intravenous versus inhalational anesthesia for noncardiac surgery',clinicalTier:'顶级综合与科学'}),'general');
c.FEEDS.items=[{id:'new',doi:'10.1/keep',hasDraft:true,draftData:{published:'2026-10-01'}}];assert.equal(c.publishedDate(c.getCuratedList()[0]),'2026-09-29');
// Reuse the same cache across Beijing midnight and range changes.
c.beijingToday=()=> '2026-10-01';assert.equal(c.rangeStart(),'2026-09-25');
c.state.range='30';assert.equal(c.rangeStart(),'2026-09-02');
c.state.range='all';assert.equal(c.rangeStart(),'');
c.state.range='7';assert.equal(c.rangeStart(),'2026-09-25');
console.log('20 reading regression assertions passed');
