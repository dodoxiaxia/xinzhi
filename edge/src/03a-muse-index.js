// ==== edge/src/03a-muse-index.js · Candidate index for the machine download queue ====
// One small KV key lists the tasks a machine caller can still act on (queued, running, uploading,
// verifying, failed, login_required, review). Claim, requeue and the per-state task list read this key
// instead of listing every library:muse-job: key. The index is only a candidate list: the task record
// stays the source of truth, a caller always re-reads the record before acting, and an entry that
// disagrees with its record is corrected on the spot ("the record wins").
// Done (available) and confirmed-abandoned tasks are not in the index; their records keep no TTL, so the
// audit trail stays in KV, but no claim path touches them.
const MACHINE_INDEX_KEY = 'library:machine-index:v1';
// Records of non-terminal tasks expire after 7 days (see musePut); an entry older than that has no record.
const MACHINE_INDEX_ENTRY_MAX_AGE_MS = 604800000 + 3600000;
// One backfill request spends at most about this many KV operations (list pages plus record reads)
// before it saves its progress; the platform allows 1000 KV operations per request.
const MACHINE_INDEX_CHUNK_OPS = 400;
// A claim may consider at most this many usable (non-skipped) candidates. Skipped entries — paused,
// stale index, already available, review, a soft-retried expiry, and other unusable records — do not
// count toward this number. A separate scan cap bounds how many task records one request may read.
const MACHINE_CLAIM_EXAMINE_MAX = 20;
const MACHINE_CLAIM_SCAN_MAX = 80;
const MACHINE_CLAIM_SCAN_LIMIT_RETRY_SECONDS = 15;
const MACHINE_REQUEUE_EXAMINE_MAX = 150;
const MACHINE_EMPTY_CLAIM_RETRY_SECONDS = 300;
const MACHINE_INDEX_BUILDING_RETRY_SECONDS = 60;
const MACHINE_INDEX_STATES = ['queued','running','uploading','verifying','failed','login_required','review'];
const MACHINE_INDEXED_PUBLIC_STATES = ['to-download','downloading','uploaded-awaiting-verification','failed-awaiting-fallback'];

// Index entry for one task record, or null when the task is no longer a machine candidate.
// i: task id, s: state, c: createdAt, u: updatedAt, e: when the task counts as expired (0 = never), w: when the entry was written.
function museIndexEntry(job) {
  if (!job || !MACHINE_INDEX_STATES.includes(job.state)) return null;
  let expires = 0;
  if (job.state === 'queued') expires = job.createdAt + MUSE_QUEUE_MS;
  else if (job.state === 'running' || job.state === 'uploading') expires = Math.min(job.leaseUntil, (job.acquisitionStartedAt || job.createdAt) + 86400000);
  return {i:job.id,s:job.state,c:job.createdAt,u:job.updatedAt,e:Number.isSafeInteger(expires) ? expires : 0,w:Date.now()};
}
function museIndexSame(a, b) {
  return !!a && !!b && a.i === b.i && a.s === b.s && a.c === b.c && a.u === b.u && a.e === b.e;
}
function museIndexValid(entry) {
  return !!entry && typeof entry === 'object' && MUSE_UUID.test(entry.i || '') && MACHINE_INDEX_STATES.includes(entry.s)
    && [entry.c,entry.u,entry.e,entry.w].every(n => Number.isSafeInteger(n) && n >= 0);
}
function museIndexFresh() {
  return {version:1,ready:false,building:{cursor:''},entries:{}};
}
// Returns a well-formed document or null. A malformed document is treated as missing and rebuilt.
function museIndexNormalize(value) {
  if (!value || value.version !== 1 || typeof value.ready !== 'boolean' || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return null;
  const doc = {version:1,ready:value.ready,entries:{}};
  if (!value.ready) doc.building = {cursor:value.building && typeof value.building.cursor === 'string' ? value.building.cursor : ''};
  if (Number.isSafeInteger(value.builtAt)) doc.builtAt = value.builtAt;
  for (const [doi, entry] of Object.entries(value.entries)) if (libraryDoi(doi) === doi && museIndexValid(entry)) doc.entries[doi] = entry;
  return doc;
}
function museIndexPrune(doc) {
  const limit = Date.now() - MACHINE_INDEX_ENTRY_MAX_AGE_MS;
  let removed = false;
  for (const [doi, entry] of Object.entries(doc.entries)) if (entry.w < limit) { delete doc.entries[doi]; removed = true; }
  return removed;
}
async function museIndexRead(env) {
  return museIndexNormalize(await libraryGet(env.QL_KV, MACHINE_INDEX_KEY));
}
async function museIndexWrite(env, doc) {
  await libraryPut(env.QL_KV, MACHINE_INDEX_KEY, JSON.stringify(doc));
}
// Apply a batch of {doi, entry|null} changes in one read and at most one write. Later changes for a DOI win.
async function museIndexApply(env, changes) {
  if (!changes.length) return;
  const existing = await museIndexRead(env);
  const doc = existing || museIndexFresh();
  let dirty = !existing;
  for (const change of changes) {
    const old = doc.entries[change.doi];
    if (!change.entry) { if (old) { delete doc.entries[change.doi]; dirty = true; } continue; }
    if (!museIndexSame(old, change.entry)) { doc.entries[change.doi] = change.entry; dirty = true; }
  }
  if (museIndexPrune(doc)) dirty = true;
  // A missing index is only created when there is something to record; the backfill covers the rest.
  if (!existing && !Object.keys(doc.entries).length) return;
  if (dirty) await museIndexWrite(env, doc);
}
// Scan one op-bounded slice of the job keys into the index and save the progress. The slice length is bounded by
// the KV operation budget, not by the table size, so a large ledger is backfilled over several requests.
async function museIndexBackfillChunk(env, current) {
  let cursor = current && !current.ready && current.building ? current.building.cursor : '';
  const found = [];
  let ops = 0, complete = false;
  while (ops < MACHINE_INDEX_CHUNK_OPS) {
    const listing = await machineListKeys(env, MUSE_JOB_PREFIX, cursor, 100);
    ops++;
    for (const entry of listing.keys) {
      if (typeof entry.name !== 'string' || !entry.name.startsWith(MUSE_JOB_PREFIX)) continue;
      const doi = entry.name.slice(MUSE_JOB_PREFIX.length);
      const job = museRecord(await libraryGet(env.QL_KV, entry.name), doi);
      ops++;
      const item = museIndexEntry(job);
      if (item) found.push({doi,entry:item});
    }
    if (listing.list_complete || typeof listing.cursor !== 'string' || !listing.cursor) { complete = true; break; }
    cursor = listing.cursor;
  }
  // Merge into the latest copy: other requests may have written entries while this slice was scanning.
  const latest = await museIndexRead(env) || museIndexFresh();
  if (latest.ready && (!current || !current.ready)) return latest;
  for (const item of found) {
    const old = latest.entries[item.doi];
    if (!old || old.u <= item.entry.u) latest.entries[item.doi] = item.entry;
  }
  museIndexPrune(latest);
  if (complete) { latest.ready = true; delete latest.building; latest.builtAt = Date.now(); }
  else { latest.ready = false; latest.building = {cursor}; }
  await museIndexWrite(env, latest);
  return latest;
}
// The index for this request. A missing or unfinished index advances the one-time backfill by one slice.
async function museIndexOpen(env) {
  const doc = await museIndexRead(env);
  if (doc && doc.ready) { museIndexPrune(doc); return doc; }
  return museIndexBackfillChunk(env, doc);
}
// Operator escape hatch: forget the entries and scan the job keys again, so the result is exactly what the records say.
// Claims return no task (with a short Retry-After) until the scan has finished, which takes a few requests.
async function museIndexRestart(env) {
  const doc = await museIndexRead(env);
  if (doc && doc.ready) {
    const next = museIndexFresh();
    await museIndexWrite(env, next);
    return museIndexBackfillChunk(env, next);
  }
  return museIndexBackfillChunk(env, doc);
}
function museIndexOrder(a, b) {
  return a[1].c - b[1].c || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}
// Entries a downloader may claim: waiting tasks, plus claimed tasks whose lease or 24 hours ran out (claim marks them failed).
function museIndexQueuedCandidates(doc, now) {
  return Object.entries(doc.entries).filter(([, e]) => e.s === 'queued' || (['running','uploading'].includes(e.s) && e.e <= now)).sort(museIndexOrder);
}
// Entries a fallback caller may claim: stopped tasks, plus tasks that are expired right now. review is never claimable.
function museIndexFailedCandidates(doc, now) {
  return Object.entries(doc.entries).filter(([, e]) => ['failed','login_required'].includes(e.s) || (['queued','running','uploading'].includes(e.s) && e.e <= now)).sort(museIndexOrder);
}
// Same set a requeue can act on (see machineRequeueCandidate): stopped tasks and expired ones.
const museIndexRequeueCandidates = museIndexFailedCandidates;
// Entries that machinePublicState would report as the given public state, judged from the index alone.
function museIndexPublicCandidates(doc, publicState, now) {
  const expired = e => e.e > 0 && e.e <= now;
  const keep = {
    'to-download':e => (e.s === 'queued' && !expired(e)) || (['running','uploading'].includes(e.s) && expired(e)),
    'downloading':e => ['running','uploading'].includes(e.s) && !expired(e),
    'uploaded-awaiting-verification':e => e.s === 'verifying',
    'failed-awaiting-fallback':e => ['failed','login_required','review'].includes(e.s) || (['queued','running','uploading'].includes(e.s) && expired(e))
  }[publicState];
  return Object.entries(doc.entries).filter(([, e]) => keep(e)).sort(museIndexOrder);
}
