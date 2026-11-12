'use strict';
// Offline: an open-access PDF is checked against the expected DOI and title before it enters the Muse quarantine.
// A wrong paper (the Lancet Digital Health case: the OA catalogue pointed at a medRxiv preprint of another title and DOI)
// drops that source, records its URL and reason on the task and sends the task to the download queue, not to review.
// Synthetic PDFs only. Hooked in at the end of test_muse_reader_upload.cjs so CI runs it.
const assert = require('assert');
const {setup} = require('./test_fulltext_auth_helpers.cjs');
const {doi, title, hash} = require('./test_doi_library_worker.cjs');
const fixtures = require('./machine_identity_fixtures.cjs');
const base = 'https://learn.dryz.info', museKey = 'synthetic_muse_key_0123456789_abcdef', fallbackToken = 'synthetic_fallback_token_0123456789abcd';
const right = fixtures.flateEol({doi, title});
const preprint = fixtures.flateEol({doi:'10.9999/synthetic.preprint', title:'Synthetic preprint of the same work under another title'});
const sameDoiOtherTitle = fixtures.flateEol({doi, title:'Synthetic unrelated article that merely cites this DOI'});
const pdf = bytes => new Response(bytes, {headers:{'content-type':'application/pdf'}});
async function create(options = {}) {
  const h = await setup(options);
  h.context.DecompressionStream = DecompressionStream;
  Object.assign(h.env, {MUSE_FULLTEXT_ENABLED:'true', MUSE_FULLTEXT_KEY:museKey, MACHINE_TOKENS:JSON.stringify([{id:'fallback', role:'fallback', token:fallbackToken}])});
  return h;
}
const job = h => JSON.parse(h.values.get('library:muse-job:' + doi));
const claimMuse = h => h.context.worker.fetch(new Request(base + '/api/muse/claim', {method:'POST', headers:{authorization:'Bearer ' + museKey, 'content-type':'application/json'}, body:'{}'}), h.env);
const hasCandidate = h => [...h.values.keys()].some(k => k.startsWith('library:muse-candidate:') || k.startsWith('library:muse-review:'));
(async () => {
  // Passing case: the OA file is the right paper, so it is stored for verification as before.
  let h = await create({oa:true, pdfResponse:() => pdf(right)});
  assert.equal((await h.request()).status, 202);
  assert.equal(job(h).state, 'verifying'); assert.equal(job(h).source, 'open_access'); assert(!job(h).oaRejected);
  assert(h.values.has('library:muse-candidate:' + hash(right)));

  // Wrong paper (a preprint with another DOI and title): the source is dropped and the task waits in the download queue.
  h = await create({oa:true, oaUrl:'https://journals.plos.org/article/preprint.pdf', pdfResponse:() => pdf(preprint)});
  const wrong = await h.request(); assert.equal(wrong.status, 202);
  assert.equal((await wrong.json()).job.stage, 'queued');
  let stored = job(h); assert.equal(stored.state, 'queued'); assert(!stored.source);
  assert.equal(stored.oaRejected.length, 1);
  assert.equal(stored.oaRejected[0].source, 'https://journals.plos.org/article/preprint.pdf');
  assert.equal(stored.oaRejected[0].reason, 'identity_mismatch');
  assert(!hasCandidate(h), 'the wrong file never reaches the quarantine or the verifier');
  assert.notEqual(h.values.get('library:paper:' + doi) && JSON.parse(h.values.get('library:paper:' + doi)).paper.fulltextStatus, 'review', 'the paper is not sent to review');
  // The download queue can still pick it up, and a downloader or fallback sees why the OA path failed.
  assert.equal((await (await claimMuse(h)).json()).task.doi, doi);

  // A file carrying only this DOI (another title) is also refused.
  h = await create({oa:true, pdfResponse:() => pdf(sameDoiOtherTitle)});
  assert.equal((await (await h.request()).json()).job.stage, 'queued');
  assert.equal(job(h).oaRejected[0].reason, 'title_not_found'); assert(!hasCandidate(h));

  // First candidate is the wrong paper, the second is right: the right one is used, nothing is recorded as rejected on the job.
  h = await create({oa:true, unpaywallResponse:() => Response.json({doi, title, is_oa:true, best_oa_location:{url_for_pdf:'https://journals.plos.org/article/preprint.pdf'},
    oa_locations:[{url_for_pdf:'https://journals.plos.org/article/preprint.pdf'}, {url_for_pdf:'https://www.nature.com/article/final.pdf'}]}),
    pdfResponse:url => pdf(url.pathname.endsWith('final.pdf') ? right : preprint)});
  assert.equal((await h.request()).status, 202);
  assert.equal(job(h).state, 'verifying'); assert.equal(job(h).source, 'open_access'); assert(h.values.has('library:muse-candidate:' + hash(right))); assert(hasCandidate(h));
  assert(!h.values.has('library:muse-candidate:' + hash(preprint)));

  // The retry button takes the same path: a wrong OA file leaves a fresh queued task with the rejection recorded.
  const clock = {now:Date.now()}; let blocked = true;
  h = await create({clock, oa:true, pdfResponse:() => blocked ? new Response('blocked', {status:403}) : pdf(preprint)});
  assert.equal((await h.request()).status, 202); assert.equal(job(h).state, 'queued');
  clock.now += 6 * 86400000 + 1000;
  assert.equal((await (await claimMuse(h)).json()).task, null); assert.equal(job(h).state, 'failed');
  blocked = false;
  const retried = await h.request('/api/muse/retry'); assert.equal(retried.status, 202);
  assert.equal((await retried.json()).job.stage, 'queued');
  stored = job(h); assert.equal(stored.state, 'queued'); assert.equal(stored.oaRejected[0].reason, 'identity_mismatch'); assert(!hasCandidate(h));

  // A claim by the fallback bot never takes a task whose PDF failed verification.
  h = await create();
  const id = require('crypto').randomUUID(), createdAt = Date.now() - 60000;
  const review = {version:1, id, doi, state:'review', createdAt, updatedAt:createdAt, queueKey:'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id, verificationReason:'identity_mismatch', reason:'identity_mismatch', source:'open_access', sha256:hash(preprint), bytes:preprint.length, candidateKey:'library:muse-candidate:' + hash(preprint)};
  h.values.set('library:muse-job:' + doi, JSON.stringify(review));
  const before = h.values.get('library:muse-job:' + doi);
  const claim = await h.context.worker.fetch(new Request(base + '/api/machine/claim', {method:'POST', headers:{authorization:'Bearer ' + fallbackToken, 'content-type':'application/json'}, body:JSON.stringify({state:'failed-awaiting-fallback'})}), h.env);
  assert.equal(claim.status, 200); assert.equal((await claim.json()).task, null);
  assert.equal(h.values.get('library:muse-job:' + doi), before);
  console.log('Open-access identity guard: wrong paper dropped to the queue with source and reason, right paper kept, review tasks not claimed passed');
})().catch(error => {console.error(error);process.exitCode = 1;});
