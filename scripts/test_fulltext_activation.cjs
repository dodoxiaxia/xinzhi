'use strict';
// Exercise real Worker routes with synthetic sources/KV only; no network or credentials.
const assert = require('node:assert/strict');
const {harness, doi} = require('./test_doi_library_worker.cjs');
const id = '00000000-0000-4000-8000-000000000001';
function queued(h) {
  const now = Date.now(), queueKey = 'library:queue:' + String(now).padStart(13, '0') + ':' + id;
  const job = {version:1,id,doi,state:'queued',createdAt:now,updatedAt:now,nextAttemptAt:now,attempts:0,queueKey};
  h.values.set('library:job:' + doi, JSON.stringify(job));
  h.values.set(queueKey, JSON.stringify({id,doi}));
  return job;
}
(async () => {
  for (const flag of [undefined, '', 'false', 'TRUE', true, 1]) {
    const h = harness();
    if (flag === undefined) delete h.env.FULLTEXT_ASYNC_ENABLED;
    else h.env.FULLTEXT_ASYNC_ENABLED = flag;
    const job = queued(h), saved = [...h.values];
    const pending = await h.request('/api/fulltext-pending', {method:'GET',query:''});
    assert.deepEqual(await pending.json(), {ok:true,pending:false});
    assert.equal(h.reads.length, 0); assert.equal(h.lists.length, 0);
    const denied = await h.request('/api/fulltext-worker', {query:'',body:JSON.stringify({action:'claim'})});
    assert.equal(denied.status, 503); assert.equal((await denied.json()).error, 'job_disabled');
    assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
    const lookup = await h.request('/api/library', {method:'GET'});
    assert.equal(Object.hasOwn(await lookup.json(), 'job'), false);
    const form = await h.request('/api/acquire', {method:'GET',headers:{accept:'text/html'}});
    assert((await form.text()).includes('<form method="post"'));
    const wrong = await h.request('/api/acquire', {passphrase:'wrong'});
    assert.equal(wrong.status, 403); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
    assert.deepEqual([...h.values], saved, 'disabled routes preserve dormant jobs');
    const result = await h.request();
    assert.equal(result.status, 200);
    assert.equal((await result.json()).paper.fulltextStatus, 'available');
    assert(h.calls.some(c => c.url.hostname === 'api.crossref.org'));
    assert(h.calls.some(c => c.url.hostname === 'api.github.com'));
    assert(!h.writes.some(w => /^library:(?:job|queue):/.test(w.key)));
    assert.equal(h.values.get('library:job:' + doi), JSON.stringify(job));
    assert(!h.reads.some(r => r.key.startsWith('library:job:')));
  }
  const h = harness(); h.env.FULLTEXT_ASYNC_ENABLED = 'true'; queued(h);
  assert.equal((await (await h.request('/api/library', {method:'GET'})).json()).job.state, 'queued');
  assert.deepEqual(await (await h.request('/api/fulltext-pending', {method:'GET',query:''})).json(), {ok:true,pending:true});
  assert.equal((await h.request()).status, 202, 'explicit activation retains enqueue/dedup');
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
  console.log('Fulltext activation: six disabled configurations preserve jobs/passwords and use immediate verified acquisition; explicit activation retains queue behavior.');
})().catch(error => {console.error(error); process.exitCode = 1;});
