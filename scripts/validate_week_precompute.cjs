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
    if(task==='study_evidence_catalog')return studyEvidence({n:1,title,abstract});
    if(task==='quicklook') {
      const checked=validate(value,abstract);
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
