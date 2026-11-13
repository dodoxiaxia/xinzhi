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
// Skipped entries — paused, stale index, already available, review, a first lease-expiry soft retry,
// and other unusable records — do not consume a claim slot; the request keeps scanning until it finds
// a claimable task or hits the scan cap below. MACHINE_CLAIM_SCAN_MAX is how many task records one
// claim request may read, so a long run of skips cannot blow the KV read budget.
const MACHINE_CLAIM_SCAN_MAX = 80;
const MACHINE_CLAIM_SCAN_LIMIT_RETRY_SECONDS = 60;
const MACHINE_REQUEUE_EXAMINE_MAX = 150;
const MACHINE_EMPTY_CLAIM_RETRY_SECONDS = 300;
const MACHINE_INDEX_BUILDING_RETRY_SECONDS = 60;
const MACHINE_INDEX_STATES = ['queued','running','uploading','verifying','failed','login_required','review'];
const MACHINE_INDEXED_PUBLIC_STATES = ['to-download','downloading','uploaded-awaiting-verification','failed-awaiting-fallback'];

// Index entry for one task record, or null when the task is no longer a machine candidate.
// i: task id, s: state, c: createdAt, u: updatedAt, e: when the task counts as expired (0 = never), w: when the entry was written.
function museIndexEntry(job) {
  if (!job || !libraryDoi(job.doi) || !MACHINE_INDEX_STATES.includes(job.state)) return null;
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
// Apply, then read the index back and apply again what is still missing: a concurrent writer that read the document before
// this write may have saved its own copy over it. Applying is idempotent, so a repeat is harmless. Returns how many entries
// are still missing after the last round (0 = every entry is in the stored index). Cost: one read per round, plus the apply.
async function museIndexApplyVerified(env, changes, rounds = 3) {
  let pending = changes;
  for (let round = 0; round < rounds && pending.length; round++) {
    await museIndexApply(env, pending);
    const stored = await museIndexRead(env);
    pending = pending.filter(change => change.entry && !(stored && stored.entries[change.doi]));
  }
  return pending.length;
}
// One op-bounded slice of a full comparison between the job records and the index (run by the hourly verification job through
// POST /api/muse/review {"action":"index-audit"}, no machine token needed). Unlike a reindex it never empties the index, so claims
// keep working. Counts: candidates = records in a state the index is meant to hold; missing = candidate record without an entry;
// stale = entry that disagrees with its record; extra = entry whose record is no candidate. With repair on, all three are
// corrected (the record wins). The caller passes the returned cursor back until done is true.
const MACHINE_INDEX_AUDIT_OPS = 300;
async function museIndexAuditChunk(env, cursor, repair) {
  const doc = await museIndexRead(env);
  if (!doc || !doc.ready) {
    const next = await museIndexBackfillChunk(env, doc);
    return {ready:false,done:true,cursor:'',repair,scanned:0,candidates:0,missing:0,stale:0,extra:0,repaired:0,indexed:Object.keys(next.entries).length};
  }
  const changes = [];
  let ops = 0, scanned = 0, candidates = 0, missing = 0, stale = 0, extra = 0, done = false;
  while (ops < MACHINE_INDEX_AUDIT_OPS) {
    const listing = await machineListKeys(env, MUSE_JOB_PREFIX, cursor, 100);
    ops++;
    for (const listed of listing.keys) {
      if (typeof listed.name !== 'string' || !listed.name.startsWith(MUSE_JOB_PREFIX)) continue;
      const doi = listed.name.slice(MUSE_JOB_PREFIX.length);
      const job = museRecord(await libraryGet(env.QL_KV, listed.name), doi);
      ops++; scanned++;
      const entry = museIndexEntry(job), old = doc.entries[doi];
      if (entry) {
        candidates++;
        if (!old) { missing++; changes.push({doi,entry}); }
        else if (!museIndexSame(old, entry)) { stale++; changes.push({doi,entry}); }
      } else if (old) { extra++; changes.push({doi,entry:null}); }
    }
    if (listing.list_complete || typeof listing.cursor !== 'string' || !listing.cursor) { done = true; cursor = ''; break; }
    cursor = listing.cursor;
  }
  let repaired = 0;
  if (repair && changes.length) { await museIndexApplyVerified(env, changes); repaired = changes.length; }
  return {ready:true,done,cursor,repair,scanned,candidates,missing,stale,extra,repaired,indexed:Object.keys(doc.entries).length};
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
// Self-healing: the queue pointers (library:muse-queue:<createdAt>:<task id>) list the waiting tasks by task id with a single
// KV list operation, so a waiting task whose id is not in the index is found without scanning every job record. A batch that was
// cut off before its index write (client timeout), a lost concurrent update or a replayed registration all leave exactly that gap.
// At most MACHINE_INDEX_HEAL_MAX tasks are put back per run and a run happens at most every MACHINE_INDEX_HEAL_INTERVAL_MS per
// isolate, so the worst case is 1 list + 2 reads per task healed + 2 index reads and 1 index write (about 84 operations). Only
// waiting and verifying tasks have a pointer; the other states are still covered by the reindex escape hatch.
// MACHINE_INDEX_SELF_HEAL=off turns it off.
const MACHINE_INDEX_HEAL_INTERVAL_MS = 60000;
const MACHINE_INDEX_HEAL_MAX = 40;
const MACHINE_INDEX_HEAL_SEEN_MAX = 2000;
const MACHINE_INDEX_POINTER_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
let museIndexHealAt = 0;
// Pointers already judged not to need an entry (stale pointer, task replaced, record gone), so they are not re-read every run.
const museIndexHealSeen = new Map();
async function museIndexHeal(env, doc) {
  const healed = [];
  try {
    if (env.MACHINE_INDEX_SELF_HEAL === 'off') return 0;
    const now = Date.now();
    if (now - museIndexHealAt >= 0 && now - museIndexHealAt < MACHINE_INDEX_HEAL_INTERVAL_MS) return 0;
    museIndexHealAt = now;
    if (museIndexHealSeen.size > MACHINE_INDEX_HEAL_SEEN_MAX) museIndexHealSeen.clear();
    const known = new Set(Object.values(doc.entries).map(entry => entry.i));
    const listing = await machineListKeys(env, MUSE_QUEUE_PREFIX, '', 1000);
    let examined = 0;
    for (const listed of listing.keys) {
      if (examined >= MACHINE_INDEX_HEAL_MAX) break;
      const match = typeof listed.name === 'string' && listed.name.startsWith(MUSE_QUEUE_PREFIX) ? MACHINE_INDEX_POINTER_ID.exec(listed.name) : null;
      if (!match || known.has(match[1]) || museIndexHealSeen.has(match[1])) continue;
      examined++;
      const id = match[1];
      museIndexHealSeen.set(id, now);
      const pointer = await libraryGet(env.QL_KV, listed.name);
      const doi = pointer && typeof pointer.doi === 'string' ? libraryDoi(pointer.doi) : '';
      if (!doi || pointer.id !== id || doc.entries[doi]) continue;
      const job = museRecord(await libraryGet(env.QL_KV, MUSE_JOB_PREFIX + doi), doi);
      const entry = job && job.id === id ? museIndexEntry(job) : null;
      if (!entry) continue;
      doc.entries[doi] = entry;
      healed.push({doi,entry});
      museIndexHealSeen.delete(id);
    }
    // museIndexApply merges into the latest stored copy, so entries written by other requests meanwhile are kept.
    if (healed.length) await museIndexApplyVerified(env, healed);
  } catch { /* healing is best effort; the next run tries again */ }
  return healed.length;
}
// The index for this request. A missing or unfinished index advances the one-time backfill by one slice.
async function museIndexOpen(env) {
  const doc = await museIndexRead(env);
  if (doc && doc.ready) { museIndexPrune(doc); await museIndexHeal(env, doc); return doc; }
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
