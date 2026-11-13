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

const errors=vm.createContext({});vm.runInContext([cs('AI_ERR'),cs('AI_MODEL_ERR'),fn('aiErrorMessage')].join('\n'),errors);
assert(errors.aiErrorMessage({error:'model_failed',detail:'provider_auth'},'translate').includes('认证'));
assert(errors.aiErrorMessage({error:'model_failed',detail:'provider_rate_limit'},'translate').includes('限流'));
assert(errors.aiErrorMessage({error:'model_failed',detail:'output_truncated'},'translate').includes('未完整'));
assert(errors.aiErrorMessage({error:'model_failed',detail:'unsupported_numbers'},'translate').startsWith('译文'));
assert(!errors.aiErrorMessage({error:'model_failed'},'translate').includes('引句'));
assert(!errors.aiErrorMessage({error:'model_failed',detail:'untrusted-private-text'},'translate').includes('untrusted'));
console.log('6 API error message regression assertions passed');

const downloads=vm.createContext({PDF_LIBRARY_IDS:new Set(['known-id']),encodeURIComponent});
vm.runInContext(fn('pdfDownloadUrl'),downloads);
assert.equal(downloads.pdfDownloadUrl({id:'known-id',doi:'10.1234/known'}),'/api/pdf?id=known-id');
assert.equal(downloads.pdfDownloadUrl({id:'radar-id',doi:'10.1234/known'}),'');
assert.equal(downloads.pdfDownloadUrl({id:'known-id',doi:'',title:'Exact title'}),'/api/pdf?id=known-id');
assert.equal(downloads.pdfDownloadUrl(null),'');
const idsLine=fs.readFileSync(require('path').join(__dirname,'../src/app/00-core-data.js'),'utf8').split('\n').filter((line,i,all)=>line.includes('const PDF_LIBRARY_IDS = ')).join('\n');
assert(idsLine.startsWith('  const PDF_LIBRARY_IDS = new Set('));
const idsFor=LIBRARY=>{const context=vm.createContext({LIBRARY});vm.runInContext(idsLine.replace('const PDF_LIBRARY_IDS','var PDF_LIBRARY_IDS'),context);return [...context.PDF_LIBRARY_IDS].sort();};
const libraryPapers=[{id:'a',doi:'10.1/a'},{id:'b',title:'Only title'},{id:'c'}];
assert.deepEqual(idsFor({papers:libraryPapers,pdfIds:['a']}),['a'],'the build list decides which papers get a download button');
assert.deepEqual(idsFor({papers:libraryPapers,pdfIds:[]}),[],'an empty build list means no buttons');
assert.deepEqual(idsFor({papers:libraryPapers}),['a','b'],'local preview data without the list keeps the old rule');
console.log('3 build-listed PDF button assertions passed');
console.log('4 private PDF link scope assertions passed');

// 「摘要可能不完整」判定：保守，只在只有结论段时成立。
const incomplete=vm.createContext({});vm.runInContext(fn('abstractMayBeIncomplete'),incomplete);
const longText='x'.repeat(601);
const incompleteCases=[
  ['只有 Conclusions 段',{abstractSections:[{label:'Conclusions',text:'These findings support X.'}]},true],
  ['只有 CONCLUSION 段（大小写、冒号）',{abstractSections:[{label:'CONCLUSION:',text:'Y.'}]},true],
  ['两个结论类分段',{abstractSections:[{label:'Conclusion',text:'A.'},{label:'结论',text:'B.'}]},true],
  ['结构化摘要完整',{abstractSections:[{label:'Background',text:'a'},{label:'Methods',text:'b'},{label:'Results',text:'c'},{label:'Conclusions',text:'d'}]},false],
  ['有结论也有方法',{abstractSections:[{label:'Methods',text:'b'},{label:'Conclusions',text:'d'}]},false],
  ['只有 Results 段',{abstractSections:[{label:'Results',text:'c'}]},false],
  ['单段无标题且以 Conclusions: 开头且很短',{abstractSections:[{label:'',text:'CONCLUSIONS: In this trial, drug X reduced events.'}]},true],
  ['单段无标题、结论句型开头',{abstractSections:[{label:'',text:'These findings support community-based care.'}]},true],
  ['单段无标题但不是结论开头',{abstractSections:[{label:'',text:'We enrolled 400 adults and measured blood pressure.'}]},false],
  ['单段无标题、结论开头但超过 600 字',{abstractSections:[{label:'',text:'Conclusions: '+longText}]},false],
  ['多段无标题不判',{abstractSections:[{label:'',text:'Conclusion: a.'},{label:'',text:'b.'}]},false],
  ['summary 以 CONCLUSION: 开头',{summary:'CONCLUSION: Community pharmacies have a critical role.'},true],
  ['summary 以 In conclusion, 开头',{summary:'In conclusion, the trial was neutral.'},true],
  ['summary 普通摘要',{summary:'Background: AF is common. Methods: cohort. Results: higher risk. Conclusions: monitor.'},false],
  ['summary 句中含 conclusion 不判',{summary:'The authors reached no firm conclusion: results were mixed.'},false],
  ['summary 结论开头但超过 600 字',{summary:'Conclusions: '+longText},false],
  ['没有摘要',{},false],
  ['空分段',{abstractSections:[{label:'Conclusions',text:'  '}]},false],
  ['空对象/空值',null,false]
];
for(const [name,paper,expected] of incompleteCases)assert.strictEqual(incomplete.abstractMayBeIncomplete(paper),expected,name);
console.log(incompleteCases.length+' incomplete-abstract rule assertions passed');

// Existing deployment gate also verifies browsing/filter transitions offline.
require('./test_faceted_filters.cjs');
