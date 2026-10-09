'use strict';
// Run the actual Worker in workerd. All outbound requests go to a local synthetic service.
const assert = require('assert');
const fs = require('fs/promises'),path = require('path'),os = require('os'),net = require('net');
const {spawn} = require('child_process'),{webcrypto,createHash} = require('crypto');
const doi = '10.1000/exact',title = 'Exact cardiovascular trial',commit = 'a'.repeat(40);
const digest = (algorithm,bytes) => createHash(algorithm).update(bytes).digest('hex');
const base64url = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'xinzhi-workerd-'));
  let child;
  try {
    const pair = await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
    const jwk = {...await webcrypto.subtle.exportKey('jwk',pair.publicKey),kid:'workerd-test-key',alg:'RS256',use:'sig'};
    const pdf = Buffer.from('%PDF-1.7\nSynthetic worker fixture\n%%EOF\n'),sha256 = digest('sha256',pdf);
    const pointer = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + sha256 + '\nsize ' + pdf.length + '\n');
    const blob = digest('sha1',Buffer.concat([Buffer.from('blob ' + pointer.length + '\0'),pointer]));
    const fixture = {jwk,doi,title,sha256,pdf:pdf.toString('base64'),pointer:pointer.toString(),blob,
      csv:'题名,DOI,期刊,实际出版日期,日期来源,当前路径,SHA256\r\n' + [title,doi,'Heart','2026-10-07','publisher','期刊/试验.pdf',sha256].join(',') + '\r\n'};
    await fs.copyFile(path.join(__dirname,'../edge/_worker.js'),path.join(directory,'site.mjs'));
    await fs.writeFile(path.join(directory,'wrapper.mjs'),`
import site from './site.mjs';
let writes = 0;
const values = new Map();
const kv = {
  async get(key,type) {const value = values.get(key); if (value === undefined) return null; return type === 'json' ? JSON.parse(value) : value;},
  async put(key,value) {writes++; values.set(key,value);},
  async delete(key) {values.delete(key);},
  async list({prefix}) {return {keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true};}
};
export default {async fetch(request,env) {
  const url = new URL(request.url);
  if (url.pathname === '/__test/health') return Response.json({ok:true});
  if (url.pathname === '/__test/reset') {values.clear(); writes=0; return env.FIXTURE.fetch('https://fixture.test/reset' + url.search);}
  if (url.pathname === '/__test/stats') {const response = await env.FIXTURE.fetch('https://fixture.test/stats'); return Response.json({...await response.json(),writes});}
  return site.fetch(request,{QL_KV:kv,PDF_DOWNLOAD_ENABLED:'true',PDF_DOWNLOAD_PASSPHRASE:'synthetic-passphrase',GITHUB_LIBRARY_TOKEN:'synthetic-private-token'});
}};
`);
    await fs.writeFile(path.join(directory,'upstream.mjs'),`
const fixture = ${JSON.stringify(fixture)};
let mode = 'normal',calls = [];
const redirected = () => new Response(null,{status:302,headers:{location:'https://attacker.invalid/private'}});
export default {async fetch(request) {
  const url = new URL(request.url);
  if (url.hostname === 'fixture.test' && url.pathname === '/reset') {mode = url.searchParams.get('mode'); calls = []; return Response.json({ok:true});}
  if (url.hostname === 'fixture.test' && url.pathname === '/stats') return Response.json({calls});
  calls.push({host:url.hostname,method:request.method});
  if (url.hostname === 'token.actions.githubusercontent.com') {
    if (request.headers.has('authorization')) throw Error('issuer credential leak');
    return mode === 'jwks_redirect' ? redirected() : Response.json({keys:[fixture.jwk]});
  }
  if (url.hostname === 'api.crossref.org') return Response.json({message:{DOI:fixture.doi,title:[fixture.title],'container-title':['Heart'],'published-online':{'date-parts':[[2026,10,7]]}}});
  if (url.hostname === 'api.github.com') {
    if (request.headers.get('authorization') !== 'Bearer synthetic-private-token') throw Error('wrong API auth');
    if (url.searchParams.get('ref') !== '${commit}') throw Error('wrong commit');
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.endsWith('/contents/文献索引/文献索引.csv')) return new Response(fixture.csv);
    if (decoded.endsWith('/contents/期刊/试验.pdf')) return request.headers.get('accept') === 'application/vnd.github+json'
      ? Response.json({type:'file',path:'期刊/试验.pdf',size:fixture.pointer.length,sha:fixture.blob}) : new Response(fixture.pointer);
  }
  if (url.hostname === 'github.com') {
    if (request.method === 'GET') {
      if (url.pathname !== '/dodoxiaxia/AI-.git/info/lfs/objects/' + fixture.sha256 || request.headers.get('authorization') !== 'RemoteAuth synthetic-download-token') throw Error('wrong delegated object scope');
      return mode === 'github_redirect' ? redirected() : new Response(null,{status:302,headers:{location:'https://github-cloud.s3.amazonaws.com/synthetic'}});
    }
    if (request.method !== 'POST' || request.headers.get('authorization') !== 'Basic ' + btoa('x-access-token:synthetic-private-token')) throw Error('wrong LFS auth');
    if (mode === 'batch_redirect') return redirected();
    if (/^batch_(401|403|429)$/.test(mode)) return new Response('synthetic denied',{status:Number(mode.slice(6))});
    const download = mode.startsWith('github_') ? {href:'https://github.com/dodoxiaxia/AI-.git/info/lfs/objects/' + fixture.sha256,header:{Authorization:'RemoteAuth synthetic-download-token'}}
      : {href:mode === 'regional' ? 'https://github-cloud.s3.dualstack.us-west-2.amazonaws.com/synthetic' : 'https://github-cloud.s3.amazonaws.com/synthetic'};
    return Response.json({objects:[{oid:fixture.sha256,size:atob(fixture.pdf).length,actions:{download}}]});
  }
  if (['github-cloud.s3.amazonaws.com','github-cloud.s3.dualstack.us-west-2.amazonaws.com'].includes(url.hostname)) {
    if (request.headers.has('authorization')) throw Error('object credential leak');
    if (mode === 'object_redirect') return redirected();
    return new Response(Uint8Array.from(atob(fixture.pdf),c=>c.charCodeAt(0)));
  }
  throw Error('unexpected outbound request');
}};
`);
    const port = await new Promise((resolve,reject) => {
      const server = net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',() => {const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});
    });
    await fs.writeFile(path.join(directory,'config.capnp'),`
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "wrapper.mjs", esModule = embed "wrapper.mjs"),(name = "site.mjs", esModule = embed "site.mjs")],
      compatibilityDate = "2026-10-09",globalOutbound = "upstream",
      bindings = [(name = "FIXTURE",service = "upstream")]
    )),
    (name = "upstream", worker = (modules = [(name = "upstream.mjs", esModule = embed "upstream.mjs")],compatibilityDate = "2026-10-09"))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]
);
`);
    child = spawn('workerd',['serve',path.join(directory,'config.capnp')],{stdio:['ignore','pipe','pipe']});
    child.on('error',() => {});
    let logs='';for (const stream of [child.stdout,child.stderr]) stream.on('data',data=>{logs=(logs+data).slice(-8192);});
    const origin = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let n=0;n<50;n++) {
      if (child.exitCode !== null) throw Error('workerd exited during startup');
      try {if ((await fetch(origin+'/__test/health',{signal:AbortSignal.timeout(1000)})).ok) {ready=true;break;}}catch{}
      await delay(100);
    }
    assert(ready,'workerd failed to start');
    const now = Math.floor(Date.now()/1000);
    const claims = {iss:'https://token.actions.githubusercontent.com',aud:'https://learn.dryz.info/api/fulltext-import',repository:'dodoxiaxia/xinzhi',repository_id:'1397425558',
      sub:'repo:dodoxiaxia@214921265/xinzhi@1397425558:ref:refs/heads/main',ref:'refs/heads/main',workflow_ref:'dodoxiaxia/xinzhi/.github/workflows/fulltext-import.yml@refs/heads/main',runner_environment:'github-hosted',
      event_name:'push',run_id:'1234',iat:now,nbf:now-1,exp:now+300};
    const unsigned = base64url({alg:'RS256',kid:jwk.kid})+'.'+base64url(claims);
    const token = unsigned+'.'+Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,Buffer.from(unsigned))).toString('base64url');
    const modes = [['jwks_redirect',503],['normal',200],['github_object',200],['regional',200],['github_redirect',502],['batch_redirect',502],['object_redirect',502],['batch_401',423],['batch_403',423],['batch_429',423]];
    for (const [mode,expected] of modes) {
      assert((await fetch(origin+'/__test/reset?mode='+mode)).ok);
      const response = await fetch(origin+'/api/fulltext-import',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({doi,githubCommit:commit,sha256}),signal:AbortSignal.timeout(10000)});
      const body = await response.json(),stats = await (await fetch(origin+'/__test/stats')).json();
      assert.equal(response.status,expected,'runtime mode: '+mode);
      assert(!stats.calls.some(x=>x.host==='attacker.invalid'),'redirect followed');
      if (expected === 200) {assert.equal(body.status,'available');assert.equal(body.source.sha256,sha256);assert.equal(body.source.bytes,pdf.length);assert.equal(body.archive.complete,false);assert(stats.writes>0);}
      else {assert.equal(stats.writes,0,'failure wrote PDF or record');if (mode.endsWith('redirect') && mode!=='jwks_redirect') assert.equal(body.diagnostic.reason,'redirect');}
      if (mode==='batch_redirect' || /^batch_(401|403|429)$/.test(mode)) assert(!stats.calls.some(x=>x.host==='github-cloud.s3.amazonaws.com'));
    }
    console.log('workerd compatibility passed: real Worker OIDC and LFS/cache readback, 3xx rejection, 401/403/429 stop; synthetic sources, zero external requests.');
  } finally {
    if(child) {child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2000)]);}
    await fs.rm(directory,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
