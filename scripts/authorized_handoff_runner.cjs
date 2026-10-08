'use strict';
// Uses the existing main workflow OIDC. Writes one private task/status artifact, never a credential or PDF.
const {call}=require('./fulltext_queue_runner.cjs');
async function runAuthorized(env=process.env,http=fetch,write,log=console.log){
  if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||!['authorized_claim','authorized_update'].includes(env.HANDOFF_ACTION))throw Error('manual_dispatch_required');
  const raw=env.HANDOFF_REQUEST_JSON||'{}';if(raw.length>1000)throw Error('invalid_handoff_input');
  let input;try{input=JSON.parse(raw);}catch{throw Error('invalid_handoff_input');}
  const fields=env.HANDOFF_ACTION==='authorized_claim'?['doi']:['doi','id','claim_id','state','ledger_key','owner_request_id','reason','receipt_commit','owner','request_version','idempotency_key','batch_id'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))throw Error('invalid_handoff_input');
  const response=await call({action:env.HANDOFF_ACTION,...input},env,http);
  if(!Object.hasOwn(response,'handoff'))throw Error('invalid_handoff_result');
  if(response.handoff && (response.handoff.execution_state!=='hold'||response.handoff.ready_to_execute!==false||response.handoff.hold_reason!=='exclusion_unverified'
    || (env.HANDOFF_ACTION==='authorized_claim'?response.handoff.executor_claimed:response.handoff.executorClaimed)!==false))throw Error('invalid_handoff_execution_permission');
  await write({version:1,action:env.HANDOFF_ACTION,handoff:response.handoff});
  log(JSON.stringify({received:!!response.handoff,state:env.HANDOFF_ACTION==='authorized_claim'?(response.handoff?'claimed':'none'):response.handoff?.state||'none'}));
  return response.handoff;
}
module.exports={runAuthorized};
if(require.main===module)runAuthorized(process.env,fetch,async result=>require('node:fs').writeFileSync('authorized-handoff.json',JSON.stringify(result,null,2),{mode:0o600})).catch(error=>{console.error(JSON.stringify({error:error.code || 'authorized_handoff_unavailable',...(error.status?{status:error.status}:{})}));process.exitCode=1;});
