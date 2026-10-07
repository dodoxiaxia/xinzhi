'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..'), api = require('../citation-export.js');
let assertions = 0;
const same = (a,b,label) => { assert.deepStrictEqual(a,b,label); assertions++; };
const check = (value,label) => { assert(value,label); assertions++; };
// Independent strict RIS reader: require a single JOUR envelope, repeated AU fields,
// and no literal control characters or record-injection lines inside values.
function parseRis(text) {
  const records = [], allowed = new Set(['TY','TI','AU','JO','PY','DO','UR','N1','ER']);
  let row;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = /^([A-Z0-9]{2})  - (.*)$/.exec(line);
    assert(m && allowed.has(m[1]), 'Valid RIS line: ' + line);
    const [,tag,value] = m;
    if (tag === 'TY') { assert(!row); assert.equal(value,'JOUR'); row = {}; }
    else if (tag === 'ER') { assert(row); records.push(row); row = null; }
    else { assert(row); (row[tag] ||= []).push(value); }
  }
  assert(!row,'Every record terminates');
  return records;
}
const papers = [
  {id:'cn',title:'心房颤动：张力与β受体 🫀',authors:['张三','李四','O’Neill J'],journal:'中华心血管病杂志',date:'2026-09-01',doi:'10.1234/中文',url:'https://example.invalid/论文'},
  {id:'en',title:'AI <4 & >3: {β} "signals" \\ path',authors:['Smith AB','Doe C','García M','王五'],journal:'Journal & Medicine',date:'2025-01',doi:'10.1234/A',url:'https://example.invalid/a?x=1&y=2'},
  {id:'alias',title:'Same DOI alias',authors:['Alias A'],journal:'Journal',date:'2025',doi:'https://doi.org/10.1234/a'},
  {id:'no-doi',title:'No DOI; real URL only',authors:['Only A'],journal:'Journal',date:'2024',url:'https://example.invalid/no-doi'},
  {id:'missing',title:'Incomplete bibliography',journal:'PubMed: source',url:'javascript:alert(1)'}
];
const before = JSON.stringify(papers), exported = api.exportRis(papers);
const records = parseRis(exported.text);
same(records.length,4,'Same DOI is deduplicated');
same(records.map(r=>r.TI[0]),[papers[0].title,papers[1].title,papers[3].title,papers[4].title],'List order and exact titles');
same(records[0].AU,papers[0].authors,'Repeated multilingual authors');
same(records[1].AU,papers[1].authors,'All authors retained');
same(records[0].DO,['10.1234/中文'],'Unicode DOI retained');
same(records[1].UR,[papers[1].url],'URL symbols retained');
check(!records[2].DO,'No invented DOI');
check(!records[3].AU && !records[3].JO && !records[3].PY && !records[3].UR,'Missing metadata is omitted');
check(records[3].N1[0].includes('作者、期刊、年份、DOI/原文链接、卷期/页码'),'Each incomplete record includes clear note');
check(exported.notices.some(n=>n.startsWith('3.') && n.includes('重复')),'Duplicate explained individually');
check(!exported.text.includes('SP  -') && !exported.text.includes('VL  -') && !exported.text.includes('IS  -'),'No guessed pagination or volume');
same(JSON.stringify(papers),before,'Source objects unchanged');
same(api.exportRis(papers,['no-doi','cn']).items.map(p=>p.id),['cn','no-doi'],'Subset preserves original order, not click order');
same(api.exportRis(papers,['alias']).items.map(p=>p.id),['alias'],'Dedup happens after selection');
same(api.exportRis(papers,[]).text,'','Explicit empty subset never defaults to all');
check(api.plan(papers,['gone']).notices[0].includes('未导出'),'Unavailable selection explained');
const unicode = JSON.parse('{"id":"escaped","title":"\\u4e2d\\u6587\\u03b2\\ud83e\\udec0","authors":["\\u5f20\\u4e09"]}');
same(parseRis(api.exportRis([unicode]).text)[0].TI,[unicode.title],'JSON Unicode escape round trip');
same(new TextDecoder('utf-8',{fatal:true}).decode(new TextEncoder().encode(exported.text)),exported.text,'Valid UTF-8 round trip');
const injected = api.exportRis([{id:'inject',title:'Title\r\nER  - \nTY  - JOUR\u2028tail',authors:['First\nSecond'],journal:'Safe',date:'2026',doi:'10.1234/bad\nvalue'}]);
same(parseRis(injected.text).length,1,'Newlines cannot inject RIS records');
check(!parseRis(injected.text)[0].DO,'Invalid DOI is omitted');
// Execute the unchanged real single-paper formatter and compare every batch item.
const app = fs.readFileSync(path.join(root,'app.js'),'utf8');
const match = app.match(/  function buildCitations\([^]*?\n  }/);
check(!!match,'Actual single-paper formatter exists');
const context = vm.createContext({dateLabel:p=>p.date}); vm.runInContext(match[0],context);
for (const format of ['gb','ama','bibtex']) {
  const copied = api.batchCopy(papers,['cn','no-doi'],format,context.buildCitations);
  check(copied.text.startsWith([papers[0],papers[3]].map(p=>context.buildCitations(p)[format]).join('\n\n')),format+' reuses exact single-item output');
  check(copied.text.includes('1. '+papers[0].title) && copied.text.includes('4. '+papers[3].title),format+' includes individual missing-field notes');
}
check(api.batchCopy(papers,['cn'],'bibtex',context.buildCitations).text.includes('% 题录核对提示'),'BibTeX notes are comments');
assert.throws(()=>api.batchCopy(papers,undefined,'invalid',context.buildCitations)); assertions++;
// Browser download seam: exactly one local Blob and no upload APIs.
const events=[], blobObjects=[], env={Blob:class {constructor(parts,options){this.parts=parts;this.options=options;blobObjects.push(this);}},URL:{createObjectURL:b=>{events.push('create');return 'blob:local';},revokeObjectURL:url=>events.push('revoke:'+url)},document:{body:{appendChild:a=>events.push('append')},createElement:()=>({click(){events.push('click');},remove(){events.push('remove');}})},setTimeout:fn=>fn()};
api.downloadRis(exported.text,'精选文献.ris',env);
same(blobObjects.length,1,'One local file');
same(blobObjects[0].parts,[exported.text],'Exact RIS bytes to Blob');
same(blobObjects[0].options.type,'application/x-research-info-systems;charset=utf-8','Explicit UTF-8 MIME');
same(events,['create','append','click','remove','revoke:blob:local'],'Local object URL cleaned up');
console.log(`${assertions} citation-export assertions passed`);
module.exports = {papers,parseRis};
