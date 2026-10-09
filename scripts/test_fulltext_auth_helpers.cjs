'use strict';
const vm = require('vm'),{webcrypto} = require('crypto');
const {harness} = require('./test_doi_library_worker.cjs');
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
let pair,jwk;
async function setup(options = {}) {
  if (!pair) {
    pair = await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
    jwk = {...await webcrypto.subtle.exportKey('jwk',pair.publicKey),kid:'import-test-key',alg:'RS256',use:'sig'};
  }
  const fetchedAt = Date.now() - 1000;
  return harness({...options,jwks:[jwk],...(options.cachedKeys ? {buildKeys:{keys:[jwk],fetchedAt,expiresAt:fetchedAt+86400000}} : {})});
}
async function token(h, audience, workflow, changes = {}) {
  const now = Math.floor(vm.runInContext('Date.now()',h.context) / 1000);
  const claims = {iss:'https://token.actions.githubusercontent.com',aud:audience,repository:'dodoxiaxia/xinzhi',repository_id:'1397425558',
    sub:'repo:dodoxiaxia/xinzhi:ref:refs/heads/main',ref:'refs/heads/main',workflow_ref:'dodoxiaxia/xinzhi/.github/workflows/' + workflow + '@refs/heads/main',runner_environment:'github-hosted',
    event_name:'push',run_id:'1234',iat:now,nbf:now-1,exp:now+300,...changes};
  const value = b64({alg:'RS256',kid:jwk.kid}) + '.' + b64(claims);
  return value + '.' + Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,Buffer.from(value))).toString('base64url');
}
module.exports = {setup,token};
