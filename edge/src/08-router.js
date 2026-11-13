// ==== edge/src/08-router.js · Request router (export default) ====
export default {
  async fetch(request, env, ctx) {
    pdfArchiveBind(env);
    const shadow = d1ShadowBind(env);
    env = shadow.env;
    const startedAt = Date.now();
    let response;
    try {
      response = await routeRequest(request, env, ctx);
      if (new URL(request.url).pathname.startsWith('/api/')) response = await hideInstitutionLinks(request, response);
    } catch (error) {
      metricsRecord(request, env, ctx, null, startedAt, true);
      throw error;
    } finally {
      pdfArchiveFlush(env, ctx);
      shadow.flush(ctx);
    }
    metricsRecord(request, env, ctx, response, startedAt, false);
    return response;
  }
};

async function routeRequest(request, env, ctx) {
    const url = new URL(request.url);
    museReviewInstant = museReviewConfigured(env);
    if (url.pathname === '/api/library') return handleLibrary(request, env);
    if (url.pathname === '/api/fulltext-worker') return handleFulltextWorker(request, env);
    if (url.pathname === '/api/fulltext-import') return handleFulltextImport(request, env);
    if (url.pathname === '/api/muse/protocol') return handleMuseProtocol(request, env);
    if (url.pathname === '/api/muse/request') return handleMuseRequest(request, env, ctx);
    if (url.pathname === '/api/muse/retry') return handleMuseRetry(request, env, ctx);
    if (url.pathname === '/api/muse/claim') return handleMuseClaim(request, env);
    if (url.pathname === '/api/muse/receipt') return handleMuseReceipt(request, env);
    if (url.pathname === '/api/muse/upload') return handleMuseUpload(request, env);
    if (url.pathname === '/api/muse/reader-upload') return handleMuseReaderUpload(request, env);
    if (url.pathname === '/api/muse/review') return handleMuseReview(request, env);
    if (url.pathname === '/api/machine/protocol') return handleMachineProtocol(request, env);
    if (url.pathname === '/api/machine/upload') return handleMachineUpload(request, env);
    if (url.pathname === '/api/machine/status') return handleMachineStatus(request, env);
    if (url.pathname === '/api/machine/tasks') return handleMachineTasks(request, env);
    if (url.pathname === '/api/machine/abandoned') return handleMachineAbandoned(request, env);
    if (url.pathname === '/api/machine/claim') return handleMachineClaim(request, env);
    if (url.pathname === '/api/machine/renew') return handleMachineRenew(request, env);
    if (url.pathname === '/api/machine/return') return handleMachineReturn(request, env);
    if (url.pathname === '/api/machine/requeue') return handleMachineRequeue(request, env);
    if (url.pathname === '/api/machine/register') return handleMachineRegister(request, env);
    if (url.pathname === '/api/drive-archive') return handleDriveArchive(request, env);
    if (url.pathname === '/api/fulltext-pending') return handleFulltextPending(request, env);
    if (url.pathname === '/api/grok-fulltext-receipt') return handleGrokReceipt(request, env);
    if (url.pathname === '/api/acquire') return env.MUSE_FULLTEXT_ENABLED === 'true' ? handleMuseRequest(request, env, ctx) : handleAcquire(request, env);
    if (url.pathname === '/api/acquire/retry') return env.MUSE_FULLTEXT_ENABLED === 'true' ? handleMuseRequest(request, env, ctx) : handleAcquire(request, env);
    if (url.pathname === '/api/fulltext') return handleFulltext(request, env);
    if (url.pathname === '/api/fulltext-source') return handleFulltextSource(request, env);
    if (url.pathname === '/api/pdf') return handlePdf(request, env);
    if (url.pathname === '/api/ql') {
      try { return await handle(request, env); } catch (e) { return json({ ok: false, error: 'server' }, 500); }
    }
    if (url.pathname === '/api/ai') {
      try { return await handleAI(request, env); } catch (e) { return json({ ok: false, error: 'server' }, 500); }
    }
    return env.ASSETS.fetch(request);
}
