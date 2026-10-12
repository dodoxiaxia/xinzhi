'use strict';
// Offline execution of real app badge, relation, share, and archive helpers.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const fn = n => src.match(new RegExp('  function ' + n + '\\([^]*?\\n  }'))[0];
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const c = vm.createContext({esc, safeSourceUrl: p => p.url || '', journalMetricText: () => '', normalizePaper() {}});
vm.runInContext(['getDesignClass','prioritizedDesign','designBadgeHtml','publicationStatusHtml','publicationStatusText','generateWeChatShareText'].map(fn).join('\n'), c);
let checks = 0;
const check = (v, message) => { assert(v, message); checks++; };
const original = {id:'pmid-41224473',pmid:'41224473',title:'PREVENT-TAHA8',studyDesign:'已撤稿',hasDraft:true,draftData:{source_checked:true,study_type:'RCT'},publicationStatus:{state:'retracted',label:'已撤稿',sourceUrl:'https://pubmed.ncbi.nlm.nih.gov/41224473/',related:[{pmid:'41916660',label:'撤稿声明',url:'https://pubmed.ncbi.nlm.nih.gov/41916660/'},{pmid:'41224475',label:'关注声明',url:'https://pubmed.ncbi.nlm.nih.gov/41224475/'}]}};
const badge = c.designBadgeHtml(original);
check(badge.includes('已撤稿'), 'Official status is visible');
check(!badge.includes('RCT'), 'A stale checked draft cannot restore an RCT badge');
check(!badge.includes('自动标注'), 'Official status is distinct from a heuristic');
const html = c.publicationStatusHtml(original);
for (const pmid of ['41224473','41916660','41224475']) check(html.includes('https://pubmed.ncbi.nlm.nih.gov/'+pmid+'/'), 'Official back-link '+pmid);
check(html.includes('role="note"'), 'Status is accessible to assistive readers');
check(!c.publicationStatusHtml({}), 'Unknown original has no allegation');
check(!c.publicationStatusHtml({publicationStatus:{label:'<unsafe>',sourceUrl:'javascript:alert(1)',related:[{pmid:'1',label:'unsafe',url:'https://evil.example/'}]}}).includes('href='), 'Unsafe links are never rendered');
check(c.publicationStatusHtml({publicationStatus:{label:'<unsafe>',related:[]}}).includes('&lt;unsafe&gt;'), 'Status text is escaped');
for (const design of ['研究方案','述评观点','RCT 二次分析','二次分析']) {
  const p = {studyDesign:design,hasDraft:true,draftData:{study_type:'RCT',source_checked:true}};
  check(c.designBadgeHtml(p).includes(design), 'Specialized article role overrides stale RCT: '+design);
  check(!c.designBadgeHtml(p).includes('design-checked'), 'Conflicting stale draft does not imply verified role');
  check(c.prioritizedDesign(p) === design, 'AI quicklook design uses the same priority');
}
check(c.generateWeChatShareText(original).includes('出版状态：已撤稿'), 'Copied paper includes current official status');
check(c.generateWeChatShareText(original).includes('https://pubmed.ncbi.nlm.nih.gov/41916660/'), 'Copied paper retains official notice source');
const start = src.indexOf('  function expandRadar('), end = src.indexOf('  CURATED.forEach(normalizePaper);', start);
c.window = {RADAR:{rows:[['41224473','10.1136/bmj-2024-083382','2025-10-29',0,0,0,0,[],'PREVENT-TAHA8']],jn:['BMJ'],pub:['BMJ'],tier:['Cardiology'],design:['已撤稿'],tag:[],publicationStatuses:{'41224473':original.publicationStatus}}};
c.FEEDS = {items:[]}; vm.runInContext(src.slice(start,end), c);
check(c.FEEDS.items[0].publicationStatus.state === 'retracted', 'Compact archive expansion retains status');
check(c.publicationStatusHtml(c.FEEDS.items[0]).includes('41916660'), 'Compact archive retains notice link');
// Explicit integration points: the source-backed banner must precede content.
for (const name of ['renderArticleCard','renderCompactRow','openReaderDrawer','openHuddleModal','weeklyCard','weeklyRow']) {
  check(fn(name).includes('publicationStatusHtml('), 'Status is displayed in '+name);
}
check(fn('openReaderDrawer').includes('prioritizedDesign(paper) || ql.design'), 'Cached AI design cannot override publication role');
check(fn('exportHuddleMarkdown').includes('publicationStatusText(p)'), 'Markdown exports retain status');
check(fn('copyHuddleSummary').includes('publicationStatusText(p)'), 'Copied shortlist retains status');
console.log('publication status UI: '+checks+' assertions passed');
