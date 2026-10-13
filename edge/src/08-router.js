// ==== edge/src/08-router.js · Request router (export default) ====
export default {
  async fetch(request, env) {
    const response = await routeRequest(request, env);
    return new URL(request.url).pathname.startsWith('/api/') ? hideInstitutionLinks(request, response) : response;
  }
};

async function routeRequest(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/library') return handleLibrary(request, env);
    if (url.pathname === '/api/fulltext-worker') return handleFulltextWorker(request, env);
    if (url.pathname === '/api/fulltext-import') return handleFulltextImport(request, env);
    if (url.pathname === '/api/muse/protocol') return handleMuseProtocol(request, env);
    if (url.pathname === '/api/muse/request') return handleMuseRequest(request, env);
    if (url.pathname === '/api/muse/retry') return handleMuseRetry(request, env);
    if (url.pathname === '/api/muse/claim') return handleMuseClaim(request, env);
    if (url.pathname === '/api/muse/receipt') return handleMuseReceipt(request, env);
    if (url.pathname === '/api/muse/upload') return handleMuseUpload(request, env);
    if (url.pathname === '/api/muse/reader-upload') return handleMuseReaderUpload(request, env);
    if (url.pathname === '/api/muse/review') return handleMuseReview(request, env);
    if (url.pathname === '/api/drive-archive') return handleDriveArchive(request, env);
    if (url.pathname === '/api/fulltext-pending') return handleFulltextPending(request, env);
    if (url.pathname === '/api/grok-fulltext-receipt') return handleGrokReceipt(request, env);
    if (url.pathname === '/api/acquire') return env.MUSE_FULLTEXT_ENABLED === 'true' ? handleMuseRequest(request, env) : handleAcquire(request, env);
    if (url.pathname === '/api/acquire/retry') return env.MUSE_FULLTEXT_ENABLED === 'true' ? handleMuseRequest(request, env) : handleAcquire(request, env);
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
