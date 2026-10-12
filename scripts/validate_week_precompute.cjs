// Mechanical checks shared with the production Worker; never fetches or calls a model.
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../edge/_worker.js'),'utf8').replace('export default {','globalThis.worker = {');
const ctx=vm.createContext({URL,Response,Request,TextEncoder,AbortController,setTimeout,clearTimeout,crypto:require('crypto').webcrypto});
vm.runInContext(source,ctx);
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{input+=s; if(input.length>1000000)process.exit(2);});
process.stdin.on('end',()=>{
 try {
  ctx.input=JSON.parse(input);
  const result=vm.runInContext(`(() => {
    const {task,value,title,abstract}=input;
    if(task==='translate')return checkTr(value,{title,abstract});
    if(task==='title'){if(!value || typeof value.title_zh!=='string' || !hasCJK(value.title_zh) || value.title_zh.length>400)throw Error('invalid_title');translationNumbersOk(value.title_zh,title);return {title_zh:value.title_zh.trim()};}
    if(task==='study')return checkStudy({papers:[{id:'1',...value}]},[{n:1,title,abstract}]).get('1');
    if(task==='study_evidence')return resolveStudyEvidence({papers:[{id:'1',...value}]},[{n:1,title,abstract}]).get('1');
    if(task==='study_evidence_repair'){
      // Mechanical repair only; the result must pass the unchanged Worker check below.
      // Per field: keep it if it passes; else cite another snippet of this abstract that
      // passes every check; else keep only the sentences that pass with the cited snippet;
      // else mark the field unknown. At least three substantive fields must remain.
      const arts=[{n:1,title,abstract}], unknown={text:STUDY_UNKNOWN,quote_id:''};
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_study_shape');
      const ids=studyEvidence(arts[0]).map(span=>span.id);
      const alone=(field,item)=>{const probe={};for(const f of STUDY_FIELDS)probe[f]=f===field?item:unknown;
        try{resolveStudyEvidence({papers:[{id:'1',...probe}]},arts);return true;}catch{return false;}};
      const repaired={};let substantive=0;
      for(const field of STUDY_FIELDS){
        const item=value[field];
        if(!item||typeof item!=='object'||typeof item.text!=='string'||typeof item.quote_id!=='string')throw Error('invalid_study_field');
        let fixed=null;
        if(alone(field,item))fixed={text:item.text,quote_id:item.quote_id};
        if(!fixed&&item.text.trim()!==STUDY_UNKNOWN){
          const id=ids.find(id=>alone(field,{text:item.text,quote_id:id}));
          if(id)fixed={text:item.text,quote_id:id};
        }
        if(!fixed&&item.text.trim()!==STUDY_UNKNOWN&&ids.includes(item.quote_id)){
          const kept=item.text.split(/(?<=[。；;！？])/).filter(part=>part.trim()&&alone(field,{text:part.trim(),quote_id:item.quote_id})).join('').trim();
          if(kept.length>=8&&alone(field,{text:kept,quote_id:item.quote_id}))fixed={text:kept,quote_id:item.quote_id};
        }
        repaired[field]=fixed||unknown;
        if(repaired[field].text.trim()!==STUDY_UNKNOWN)substantive++;
      }
      if(substantive<3)throw Error('study_repair_insufficient');
      return resolveStudyEvidence({papers:[{id:'1',...repaired}]},arts).get('1');
    }
    if(task==='study_evidence_catalog')return studyEvidence({n:1,title,abstract});
    if(task==='quicklook') {
      const checked=validate(value,abstract);
      translationNumbersOk(checked.title_zh,title);
      for(const finding of checked.findings)numbersOk(finding.text,finding.quote);
      return checked;
    }
    if(task==='quicklook_repair'){
      // Removal-only: drop findings whose quote is not verbatim or whose numbers are not in
      // their own quote, while at least two remain; then the unchanged quicklook check runs.
      if(!value||typeof value!=='object'||!Array.isArray(value.findings))throw Error('invalid_quicklook_shape');
      const kept=value.findings.filter(f=>{try{if(!f||typeof f.text!=='string'||typeof f.quote!=='string'||f.quote.length<12||!abstract.includes(f.quote))return false;numbersOk(f.text,f.quote);return true;}catch{return false;}});
      if(kept.length<2||kept.length===value.findings.length)throw Error('quicklook_repair_insufficient');
      const checked=validate({...value,findings:kept.slice(0,4)},abstract);
      translationNumbersOk(checked.title_zh,title);
      for(const finding of checked.findings)numbersOk(finding.text,finding.quote);
      return checked;
    }
    throw Error('invalid_task');
  })()`,ctx);
  process.stdout.write(JSON.stringify({ok:true,value:result}));
 } catch (error) {
  // The Worker's fixed failure code (e.g. quote_not_in_abstract, numbers_not_in_abstract:12.5) says which check
  // rejected the output; only short code-shaped strings are passed on, never model or abstract text.
  const code=String(error&&error.message||'').slice(0,80);
  process.stdout.write(JSON.stringify({ok:false,error:'evidence_validation_failed',code:/^[A-Za-z0-9_:.,%-]+$/.test(code)?code:'unrecognized'}));process.exitCode=1;}
});
