// ==== edge/src/04c-machine-reconcile-done.js · Close queued tasks whose full text is already stored (dry run by default) ====
// POST /api/machine/reconcile-done, fallback role only. The ledger key library:muse-job:<doi> can stay 'queued' after the paper
// got its full text through another path (a direct upload, an import, a replaced task). The claim and failed-claim paths already
// heal such a record, but only for the tasks they happen to read from the candidate index. This scan walks the job KEYS instead,
// so a task missing from the index is found too.
//   Request body (all optional): {"cursor":"<from the previous reply>","limit":1..100,"apply":true}
//   - Without "apply": nothing is written. The reply lists every queued task with its evidence and whether it would be closed.
//   - Writing needs BOTH "apply":true in the body AND the variable MACHINE_RECONCILE_DONE_ENABLED = 'true' (off by default).
//   - A task is closed only on the evidence the existing self-heal already trusts: the paper record says 'available' and its stored
//     PDF object is read back and verified, or the record holds a verified PDF object, or it says localAvailable. Weaker hints
//     (a candidate or Drive record, a sha256 on the task) are reported as 'weak' and never closed.
//   - Closing = the existing terminal state 'available' (public state 'done'), plus an audit field reconciledDone
//     {at, by, previousState, evidence[], pdfSha256?}; the queue key is deleted and the candidate index is corrected, both through
//     the same musePut/museDelete calls the existing heal uses. The task id and createdAt do not change.
//   - Also reported, never changed: indexMissing = queued tasks that are not in library:machine-index:v1 (the claim path and the
//     6-hour sweep read that index; POST /api/machine/requeue {"reindex":true} rebuilds it).
const RECONCILE_DONE_SWITCH = 'MACHINE_RECONCILE_DONE_ENABLED';
const RECONCILE_DONE_LIMIT_DEFAULT = 50, RECONCILE_DONE_LIMIT_MAX = 100;

// Evidence for one queued task. strong = the existing self-heal criteria, verified; weak = report only.
async function machineReconcileEvidence(env, job) {
  const strong = [], weak = [];
  let pdfSha256 = '';
  const record = await libraryGet(env.QL_KV, LIBRARY_PREFIX + job.doi);
  let paper = null;
  try { paper = libraryPaper(record, job.doi); } catch { paper = null; }
  if (paper) {
    const hasPdfObject = !!(record && record.pdf && typeof record.pdf === 'object' && !Array.isArray(record.pdf));
    if (paper.fulltextStatus === 'available' || hasPdfObject) {
      try {
        await libraryStoredPdf(env.QL_KV, record);
        strong.push(paper.fulltextStatus === 'available' ? 'paper_available' : 'paper_pdf_object', 'pdf_blob_verified');
        pdfSha256 = record.pdf.sha256;
      } catch { weak.push(paper.fulltextStatus === 'available' ? 'paper_available_blob_unverified' : 'paper_pdf_object_blob_unverified'); }
    } else if (machineHasStoredFulltext(record, paper)) strong.push('paper_local_available');
  }
  if (typeof job.sha256 === 'string' && /^[a-f0-9]{64}$/.test(job.sha256)) {
    weak.push('task_has_sha256');
    if (await libraryGet(env.QL_KV, 'library:muse-candidate:' + job.sha256)) weak.push('candidate_stored');
    if (await libraryGet(env.QL_KV, DRIVE_PENDING_PREFIX + job.sha256) || await libraryGet(env.QL_KV, DRIVE_ARCHIVE_PREFIX + job.sha256)) weak.push('drive_record');
  }
  return {strong, weak, pdfSha256};
}

async function machineReconcileDone(env, caller, input) {
  const enabled = env[RECONCILE_DONE_SWITCH] === 'true';
  const apply = input.apply === true;
  if (apply && !enabled) libraryFail('machine_reconcile_disabled', 403);
  const limit = Object.hasOwn(input, 'limit') ? input.limit : RECONCILE_DONE_LIMIT_DEFAULT;
  const listing = await machineListKeys(env, MUSE_JOB_PREFIX, input.cursor || '', limit);
  const indexDoc = await museIndexRead(env);
  const changes = [];
  const out = {scanned:0, queued:0, withEvidence:0, closed:0, indexMissing:[], candidates:[], skipped:[]};
  for (const entry of listing.keys) {
    if (typeof entry.name !== 'string' || !entry.name.startsWith(MUSE_JOB_PREFIX)) continue;
    const doi = entry.name.slice(MUSE_JOB_PREFIX.length);
    const job = museRecord(await libraryGet(env.QL_KV, entry.name), doi);
    out.scanned++;
    if (!job || job.state !== 'queued') continue;
    out.queued++;
    if (!indexDoc || !indexDoc.entries[doi]) out.indexMissing.push(doi);
    const evidence = await machineReconcileEvidence(env, job);
    if (!evidence.strong.length && !evidence.weak.length) continue;
    out.withEvidence++;
    const item = {doi, jobId8:job.id.slice(0, 8), createdAt:new Date(job.createdAt).toISOString(), evidence:[...evidence.strong, ...evidence.weak],
      wouldClose:evidence.strong.length > 0, closed:false};
    if (apply && item.wouldClose) {
      // KV is not atomic: read the record again right before writing and give up if anything moved.
      const fresh = museRecord(await libraryGet(env.QL_KV, entry.name), doi);
      if (!fresh || fresh.state !== 'queued' || fresh.id !== job.id || fresh.updatedAt !== job.updatedAt) { out.skipped.push({doi, reason:'changed_during_scan'}); }
      else {
        const next = {...fresh, state:'available', updatedAt:Date.now(),
          reconciledDone:{at:Date.now(), by:caller.id, previousState:'queued', evidence:evidence.strong, ...(evidence.pdfSha256 ? {pdfSha256:evidence.pdfSha256} : {})}};
        await musePut(env, next, {indexChanges:changes});
        if (fresh.queueKey) await museDelete(env, fresh.queueKey);
        item.closed = true;
        out.closed++;
      }
    }
    out.candidates.push(item);
  }
  if (changes.length) { try { await museIndexApply(env, changes); } catch { /* the next claim corrects the index from the records */ } }
  const more = !listing.list_complete && typeof listing.cursor === 'string' && !!listing.cursor;
  return {ok:true, mode:apply ? 'apply' : 'dry-run', applyEnabled:enabled, ...out, indexReady:!!(indexDoc && indexDoc.ready), done:!more, ...(more ? {cursor:listing.cursor} : {})};
}

async function handleMachineReconcileDone(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    // 'abandon' is held by the fallback role only: the role that may already close tasks by hand.
    const caller = await machineAuthorize(request, env, 'abandon');
    const input = await fulltextReadJson(request, 2048, 'machine_bad_request');
    if (Object.keys(input).some(key => !['cursor','limit','apply'].includes(key))) libraryFail('machine_bad_request', 400);
    if (Object.hasOwn(input, 'apply') && typeof input.apply !== 'boolean') libraryFail('machine_bad_request', 400);
    if (Object.hasOwn(input, 'cursor') && (typeof input.cursor !== 'string' || input.cursor.length > 2000)) libraryFail('machine_bad_request', 400);
    if (Object.hasOwn(input, 'limit') && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > RECONCILE_DONE_LIMIT_MAX)) libraryFail('machine_bad_request', 400);
    return json(await machineReconcileDone(env, caller, input), 200, {'cache-control':'no-store'});
  } catch (error) { return machineError(error); }
}
