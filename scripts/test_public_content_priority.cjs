'use strict';
// Execute the reader's actual selection helpers against the reviewed public cases.
// A stale API/KV result must not mask a source-bound public correction.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.resolve(__dirname,'..'),src=fs.readFileSync(path.join(root,'app.js'),'utf8');
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'editorial/v2-content-corrections-20261008/current-public-fixtures.json'),'utf8')).items.filter(f=>f.kind==='quicklook');
const fn=name=>{const m=src.match(new RegExp('  function '+name+'\\([^]*?\\n  }'));assert(m,'Missing reader helper '+name);return m[0]};
let checks=0;
for(const fixture of fixtures){
 const paper=fixture.source,doi=paper.doi,k=paper.pmid?'pmid:'+paper.pmid:'doi:'+doi;
 const c=vm.createContext({window:{PREGENERATED:{},QUICKLOOKS:{[doi]:fixture.after}},LIVE_QL:{[doi]:fixture.before},trKeyOf:()=>k});
 vm.runInContext(['qlKey','preGeneratedOf','quicklookOf'].map(fn).join('\n'),c);
 assert.deepStrictEqual(c.quicklookOf(paper),fixture.after);checks++;
 // Opening the reader and then receiving the old API value must still show the correction.
 c.LIVE_QL[doi]={...fixture.before,one_line:'STALE API CLAIM'};
 assert.deepStrictEqual(c.quicklookOf(paper),fixture.after);checks++;
 c.window.PREGENERATED[k]={quicklook:fixture.after};
 assert.deepStrictEqual(c.quicklookOf(paper),fixture.after);checks++;
 // A malformed embedded response cannot shadow the validated static projection.
 c.window.PREGENERATED[k]={quicklook:{one_line:'Invalid incomplete response'}};
 assert.deepStrictEqual(c.quicklookOf(paper),fixture.after);checks++;
}
assert.equal(fixtures.length,2);
console.log('Public content reader priority: '+checks+' assertions passed; no API requests or cache writes.');
