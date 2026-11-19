// ==== edge/src/01b-library-metadata.js · DOI metadata backfill for supplemental catalogue records ====
// Keep retrospective metadata separate from the full-text record. KV has no compare-and-swap,
// and an upload/verification must be able to write its PDF and status independently.
const LIBRARY_BIBLIOGRAPHY_PREFIX = 'library:bibliography:';

function libraryBibliographyFields(paper) {
  return {journal:paper.journal,date:paper.date,datePrecision:paper.datePrecision,dateBasis:paper.dateBasis};
}
function libraryBibliographyPatch(paper, source) {
  return {...(!paper.journal && source.journal ? {journal:source.journal} : {}),
    ...(!paper.date && source.date ? {date:source.date,datePrecision:source.datePrecision,dateBasis:source.dateBasis} : {})};
}
async function libraryReadBibliography(kv, paper) {
  if (!paper || (paper.journal && paper.date)) return paper;
  const overlay = await libraryGet(kv, LIBRARY_BIBLIOGRAPHY_PREFIX + paper.doi);
  return overlay?.version === 1 && overlay.title === paper.title ? {...paper,...libraryBibliographyPatch(paper, overlay)} : paper;
}
async function libraryPublicPaper(env, key, doi) {
  const paper = libraryPaper(await libraryGetDisplay(env, key), doi);
  try { return await libraryReadBibliography(env.QL_KV, paper); }
  catch { return paper; }
}
function libraryBibliographyTitle(title) {
  return title.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]/gu, '');
}

async function handleLibraryMetadataBackfill(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).search) libraryFail('machine_bad_request', 405);
    await machineAuthorize(request, env, 'metadata-backfill');
    const input = await fulltextReadJson(request, 1024, 'machine_bad_request');
    const doi = libraryDoi(input.doi);
    if (!doi || doi !== input.doi || Object.keys(input).some(key => !['doi','apply'].includes(key))
        || (Object.hasOwn(input, 'apply') && typeof input.apply !== 'boolean')) libraryFail('machine_bad_request', 400);
    const key = LIBRARY_PREFIX + doi;
    const current = await libraryReadBibliography(env.QL_KV, libraryPaper(await libraryGet(env.QL_KV, key), doi));
    const result = (status, fields = {}) => json({ok:true,doi,result:status,...fields});
    if (!current) return result('not_in_catalog');
    if (current.journal && current.date) return result('unchanged');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    let metadata;
    try { metadata = await libraryMetadata(doi, {signal:controller.signal}); }
    catch (error) {
      if (error.code === 'library_metadata_unavailable') return result('not_in_crossref'); // Keep the legacy result code for callers.
      if (error.code === 'library_identity') return result('identity_mismatch');
      throw error;
    } finally { clearTimeout(timer); }
    // Re-read after the external request. Match the authoritative DOI plus the current title, which can change
    // during the lookup. The title binding is checked again on every catalogue read.
    const base = libraryPaper(await libraryGet(env.QL_KV, key), doi);
    const latest = await libraryReadBibliography(env.QL_KV, base);
    if (!latest) return result('not_in_catalog');
    if (latest.journal && latest.date) return result('unchanged');
    const title = libraryBibliographyTitle(metadata.title);
    if (title.length < 5 || title !== libraryBibliographyTitle(latest.title)) return result('identity_mismatch');
    const change = libraryBibliographyPatch(latest, metadata);
    if (!Object.keys(change).length) return result('source_incomplete');
    const enriched = {...latest,...change};
    if (input.apply === true) {
      // Persist metadata only, and keep authoritative fields on the original record ahead of the overlay.
      await libraryPut(env.QL_KV, LIBRARY_BIBLIOGRAPHY_PREFIX + doi, JSON.stringify({version:1,title:latest.title,...libraryBibliographyPatch(base, enriched)}));
      libraryCatalogCache.clear();
    }
    return result(input.apply === true ? 'updated' : 'would_update', {before:libraryBibliographyFields(latest), after:libraryBibliographyFields(enriched)});
  } catch (error) { return machineError(error); }
}
