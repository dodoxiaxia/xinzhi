// REVIEW PROTOTYPE ONLY. Not imported by the website and not an HTTP endpoint.
// The caller must authenticate before invoking any method. No publisher or archive writes.
// One migrated canonical ledger; website jobs are fields on its existing DOI records.
export const LEDGER_KEY = 'ledger/current.json';
const fail = code => { throw new Error(code); };
const clone = value => structuredClone(value);
export function canonicalDoi(value) {
  if (typeof value !== 'string' || value.length > 500) fail('bad_doi');
  let doi = value.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  try { doi = decodeURIComponent(doi).toLowerCase().replace(/[.,;:]+$/, ''); } catch { fail('bad_doi'); }
  while (doi.endsWith(')') && doi.split(')').length > doi.split('(').length) doi = doi.slice(0, -1);
  if (!/^10\.\d{4,9}\/[\x21-\x7e]{1,200}$/.test(doi) || /[%<>?#@\\]/.test(doi) || doi.split('/').some(p => p === '.' || p === '..')) fail('bad_doi');
  return doi;
}
async function jobId(doi) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(doi));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function projection(job) {
  return { id:job.id, status:job.status, submittedAt:job.submittedAt, archiveComplete:false };
}
export class CanonicalLedger {
  constructor(bucket, ownerEpoch, now = () => Date.now()) {
    this.bucket = bucket; this.ownerEpoch = ownerEpoch; this.now = now;
  }
  async mutate(change) {
    // CAS retries redo only pure ledger mutation. Never retry an external write here.
    for (let attempt = 0; attempt < 32; attempt++) {
      const object = await this.bucket.get(LEDGER_KEY);
      if (!object || object.size > 8 * 1024 * 1024) fail('ledger_unavailable');
      const state = await object.json(), control = state.cloudControl;
      if (state.version !== 1 || !state.items || Array.isArray(state.items) || !control ||
          !this.ownerEpoch || control.ownerEpoch !== this.ownerEpoch || control.enabled !== true) fail('owner_cutover_required');
      const result = change(state);
      if (!result.changed) return result.value;
      control.revision = (control.revision || 0) + 1;
      const value = JSON.stringify(state);
      if (new TextEncoder().encode(value).length > 8 * 1024 * 1024) fail('ledger_capacity');
      const saved = await this.bucket.put(LEDGER_KEY, value, { onlyIf:{etagMatches:object.etag}, httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'} });
      if (saved) return result.value;
    }
    fail('ledger_contended');
  }
  async submit(value, actorHash) {
    const doi = canonicalDoi(value), id = await jobId(doi), now = this.now();
    if (!/^[a-f0-9]{64}$/.test(actorHash || '')) fail('actor_required');
    return this.mutate(state => {
      const existing = state.items[doi]?.website;
      if (existing) return {changed:false,value:{...projection(existing),created:false}};
      const day = new Date(now).toISOString().slice(0, 10), control = state.cloudControl;
      if (!control.quota || control.quota.day !== day) control.quota = {day,total:0,actors:{}};
      const quota = control.quota;
      if (quota.total >= 30 || (quota.actors[actorHash] || 0) >= 20) fail('daily_limit');
      const job = {id,doi,status:'submitted',submittedAt:now,epoch:control.ownerEpoch,outbox:'pending',owner:null};
      // Existing 815-item fields/receipts remain intact; imported receipts stay historical.
      if (!state.items[doi]) state.items[doi] = {doi};
      state.items[doi].website = job;
      quota.total++; quota.actors[actorHash] = (quota.actors[actorHash] || 0) + 1;
      return {changed:true,value:{...projection(job),created:true}};
    });
  }
  async claimNext(run) {
    if (!/^\d+:\d+$/.test(run)) fail('invalid_run');
    return this.mutate(state => {
      const control = state.cloudControl;
      // Never expire a live/stuck claim by time alone: old side effects could still run.
      if (control.active) return {changed:false,value:{claimed:false,reason:'executor_occupied'}};
      const job = Object.values(state.items).map(item => item.website).find(job => job && job.epoch === control.ownerEpoch && job.status === 'submitted');
      if (!job) return {changed:false,value:{claimed:false,reason:'empty'}};
      job.status = 'executing'; job.owner = run; job.claimedAt = this.now();
      control.active = {id:job.id,run};
      return {changed:true,value:{claimed:true,job:clone(job)}};
    });
  }
  async noteDispatch(id, outcome) {
    return this.mutate(state => {
      const job = Object.values(state.items).map(item => item.website).find(job => job?.id === id);
      if (!job) fail('job_missing');
      // Dispatch success is just a wake-up acknowledgement, never execution or completion.
      if (job.status !== 'submitted') return {changed:false,value:projection(job)};
      job.outbox = outcome.accepted ? 'accepted' : 'pending';
      job.dispatchStatus = outcome.status;
      if (outcome.runId) job.dispatchRunId = outcome.runId;
      return {changed:true,value:projection(job)};
    });
  }
}
export async function dispatchWakeup(token, send = fetch) {
  if (typeof token !== 'string' || !token.trim()) fail('dispatch_not_configured');
  let response;
  try {
    response = await send('https://api.github.com/repos/dodoxiaxia/xinzhi/actions/workflows/archive-doi.yml/dispatches', {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
      headers:{authorization:'Bearer ' + token,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'xinzhi-doi-archive','x-github-api-version':'2026-03-10'},
      body:JSON.stringify({ref:'main',inputs:{mode:'drain'}})
    });
  } catch { return {accepted:false,status:'unknown'}; }
  if (response.status === 204) return {accepted:true,status:204};
  if (response.status === 200) {
    let data; try { data = await response.json(); } catch { return {accepted:true,status:200}; }
    const runId = String(data.workflow_run_id || '');
    return {accepted:true,status:200,...(/^\d+$/.test(runId) ? {runId} : {})};
  }
  // No response-body logging and no automatic retry of denied/rate-limited dispatches.
  if (response.body) await response.body.cancel();
  return {accepted:false,status:response.status};
}
export function archiveStatus(manifest, receipts) {
  const validManifest = manifest && /^[a-f0-9]{64}$/.test(manifest.sha256 || '') && /^[a-f0-9]{64}$/.test(manifest.indexSha256 || '') &&
    typeof manifest.generation === 'string' && manifest.generation.length > 0 && Number.isInteger(manifest.bytes) && manifest.bytes >= 51200 && manifest.strictVerified === true;
  const sides = Object.fromEntries(['github','drive','mac'].map(side => {
    const proof = receipts?.[side];
    const verified = validManifest && proof && proof.generation === manifest.generation && proof.sha256 === manifest.sha256 && proof.bytes === manifest.bytes &&
      proof.indexSha256 === manifest.indexSha256 && proof.currentReadback === true && proof.side === side && typeof proof.objectVersion === 'string' && proof.objectVersion.length > 0;
    return [side,verified ? 'verified' : 'pending'];
  }));
  return {status:Object.values(sides).every(s => s === 'verified') ? 'complete' : 'sync_pending',sides};
}
