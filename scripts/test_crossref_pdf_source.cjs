// Offline worker regression: verified Crossref publisher PDF links survive stale OA titles.
// All metadata, passphrases, PDF bytes and KV storage are synthetic; no network is used.
const assert = require('assert');
const { harness, doi:fixtureDoi, title:fixtureTitle, pdf:githubPdf, hash, error } = require('./test_doi_library_worker.cjs');

const doi = '10.1093/eurheartj/ehag734';
const title = 'Half-dose rivaroxaban vs antiplatelet therapy for preventing silent cerebral embolic lesions after left atrial appendage occlusion: the HALO-SCE trial';
const staleTitle = 'Half-dose rivaroxaban vs antiplatelet therapy for preventing silent cerebral embolism after left atrial appendage occlusion: the HALO-SCE trial';
const pdfUrl = 'https://academic.oup.com/eurheartj/advance-article-pdf/doi/10.1093/eurheartj/ehag734/70834056/ehag734.pdf';
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\nSynthetic HALO-SCE regression fixture\n'), Buffer.alloc(60 * 1024, 32), Buffer.from('\n%%EOF\n')]);
const key = 'library:paper:' + doi;
const declaredPdf = url => ({ URL:url, 'content-type':'application/pdf' });
const crossref = links => ({ DOI:doi, title:[title], 'container-title':['European Heart Journal'], link:links });
function fixture(options = {}) {
  return harness({ rows:[], crossref:crossref([declaredPdf(pdfUrl), {...declaredPdf(pdfUrl), 'content-version':'am'}]),
    pdfHosts:['academic.oup.com'], pdfResponse:() => new Response(pdf, { headers:{'content-type':'application/pdf'} }),
    unpaywallResponse:() => Response.json({doi, title:staleTitle, is_oa:true, best_oa_location:{url_for_pdf:pdfUrl}}),
    openalexResponse:() => Response.json({doi:'https://doi.org/' + doi, title:staleTitle, open_access:{is_oa:true}, best_oa_location:{is_oa:true,pdf_url:pdfUrl}}),
    ...options });
}
const request = (h, changes = {}) => h.request('/api/acquire', {doi, ...changes});
const publisherCalls = h => h.calls.filter(call => ['academic.oup.com','www.nature.com'].includes(call.url.hostname));
const oaCalls = h => h.calls.filter(call => ['api.unpaywall.org','api.openalex.org'].includes(call.url.hostname));
const pdfWrites = h => h.writes.filter(write => write.key.startsWith('library:pdf:'));
function retained(status) {
  return {version:1, paper:{id:'doi-' + hash(doi).slice(0,16),doi,title,journal:'European Heart Journal',authors:[],
    date:'2026-08-31',datePrecision:'day',dateBasis:'Crossref published-online',ingestedAt:'2026-10-09T02:29:30.606Z',
    metadataStatus:'external_bibliography_checked',fulltextStatus:status}};
}
function privateSourceNotProjected(value) {
  const text = JSON.stringify(value);
  assert(!text.includes(pdfUrl), 'publisher PDF links must remain request-local');
  assert(!text.includes('crossrefPdfSource'));
}

(async () => {
  // A single authorized form POST repairs the observed review state and returns an attachment.
  let h = fixture();
  h.values.set(key, JSON.stringify(retained('review')));
  h.values.set('library:attempt:' + doi, JSON.stringify({status:'review',error:'library_identity',retryAfter:0}));
  const form = await request(h, {method:'GET'});
  assert.equal(form.status,200); assert((await form.text()).includes('&amp;download=1'));
  assert.equal(h.calls.length,0);
  let response = await request(h, {query:'doi=' + encodeURIComponent(doi) + '&download=1', headers:{origin:'https://site.test',accept:'text/html'}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/pdf');
  assert(response.headers.get('content-disposition').startsWith('attachment;'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
  assert.equal(publisherCalls(h).length,1, 'duplicate Crossref links are downloaded once');
  assert.equal(oaCalls(h).length,0, 'stale secondary catalogue titles cannot discard an authoritative success');
  assert.deepEqual(h.calls.map(call => call.url.hostname), ['api.crossref.org','api.github.com','academic.oup.com']);
  let saved = JSON.parse(h.values.get(key));
  assert.equal(saved.paper.fulltextStatus,'available'); assert.equal(saved.paper.title,title);
  assert.equal(saved.pdf.source,'crossref'); assert.equal(saved.pdf.sha256,hash(pdf));
  privateSourceNotProjected(saved);
  const lookup = await (await h.request('/api/library', {method:'GET',doi})).json();
  assert.equal(lookup.status,'available'); privateSourceNotProjected(lookup);
  const callsBefore = h.calls.length;
  response = await request(h, {query:'doi=' + encodeURIComponent(doi) + '&download=1'});
  assert.equal(response.status,200); assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
  assert.equal(h.calls.length,callsBefore, 'cached acquisition never repeats source requests');
  response = await h.request('/api/fulltext',{doi});
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf); assert.equal(h.calls.length,callsBefore);

  // Only explicitly declared PDFs from the same verified metadata response are eligible.
  h = fixture({crossref:crossref([{URL:pdfUrl,'content-type':'unspecified'}, {URL:pdfUrl,'content-type':'text/html'}])});
  assert.equal((await (await request(h)).json()).status,'review');
  assert.equal(publisherCalls(h).length,0); assert.equal(pdfWrites(h).length,0);
  const unsafe = ['http://academic.oup.com/p.pdf','https://academic.oup.com.attacker.example/p.pdf',
    'https://127.0.0.1/p.pdf','https://[::1]/p.pdf','https://user:secret@academic.oup.com/p.pdf',
    'https://academic.oup.com:8443/p.pdf','https://academic.oup.com/p.pdf#secret',
    'https://watermark.silverchair.com/p.pdf'];
  h = fixture({crossref:crossref(unsafe.map(declaredPdf))});
  assert.equal((await (await request(h)).json()).status,'review');
  assert.equal(publisherCalls(h).length,0);
  assert(h.calls.every(call => ['api.crossref.org','api.github.com','api.unpaywall.org','api.openalex.org'].includes(call.url.hostname)));

  // Context is reset before a new lookup, including failed identity checks; a different DOI cannot reuse it.
  h = fixture({crossref:{...crossref([declaredPdf(pdfUrl)]), DOI:'10.1093/eurheartj/other'}});
  await error(await request(h),409,'library_identity'); assert.equal(h.calls.length,1); assert(!h.values.has(key));
  const sourceContext = {signal:new AbortController().signal,crossrefPdfSource:{doi,urls:[pdfUrl]}};
  await assert.rejects(h.context.libraryMetadata(doi,sourceContext),failure => failure.code === 'library_identity');
  assert(!sourceContext.crossrefPdfSource);
  h = fixture();
  const mismatchedContext = {signal:new AbortController().signal,crossrefPdfSource:{doi:'10.1093/eurheartj/other',urls:[pdfUrl]}};
  const unresolved = await h.context.libraryOa({doi,title},mismatchedContext);
  assert.equal(unresolved.review,true); assert.equal(publisherCalls(h).length,0);

  // De-duplicate normalized URLs, cap at three and do not revisit one through a secondary resolver.
  const urls = [pdfUrl, pdfUrl + '?version=2', pdfUrl + '?version=3', pdfUrl + '?version=4'];
  h = fixture({crossref:crossref([declaredPdf(pdfUrl), {...declaredPdf(pdfUrl),'content-type':' APPLICATION/PDF '}, ...urls.slice(1).map(declaredPdf)]),
    pdfResponse:() => new Response('missing',{status:404})});
  const context = {signal:new AbortController().signal};
  const paper = await h.context.libraryMetadata(doi,context);
  assert.deepEqual(context.crossrefPdfSource.urls,urls.slice(0,3)); privateSourceNotProjected(paper);
  await h.context.libraryOa(paper,context);
  assert.equal(publisherCalls(h).length,3); assert(!h.calls.some(call => call.url.href === urls[3]));
  h = fixture({crossref:crossref(urls.map(declaredPdf)),
    pdfResponse:url => url.hostname === 'academic.oup.com' ? new Response('missing',{status:404})
      : new Response(pdf,{headers:{'content-type':'application/pdf'}}),
    unpaywallResponse:() => Response.json({doi,title,is_oa:true,best_oa_location:{url_for_pdf:'https://journals.plos.org/article/fixture.pdf'}})});
  assert.equal((await request(h)).status,200, 'three failed Crossref URLs do not consume the existing OA candidate budget');
  assert.equal(publisherCalls(h).length,3); assert.equal(JSON.parse(h.values.get(key)).pdf.source,'oa');
  h = fixture({pdfResponse:() => new Response('missing',{status:404}),
    unpaywallResponse:() => Response.json({doi,title,is_oa:true,best_oa_location:{url_for_pdf:pdfUrl}}),
    openalexResponse:() => Response.json({doi:'https://doi.org/' + doi,title,open_access:{is_oa:true},best_oa_location:{is_oa:true,pdf_url:pdfUrl}})});
  await request(h); assert.equal(publisherCalls(h).length,1);

  // Existing GitHub success or identity/integrity failure retains priority over the new source.
  const defaultLink = {link:[declaredPdf(pdfUrl)]};
  h = harness({crossref:defaultLink,pdfHosts:['academic.oup.com']});
  assert.equal((await h.request()).status,200);
  assert.equal(JSON.parse(h.values.get('library:paper:' + fixtureDoi)).pdf.source,'github');
  assert.equal(publisherCalls(h).length,0); assert.equal(oaCalls(h).length,0);
  h = harness({crossref:defaultLink,rows:[['Wrong paper',fixtureDoi,'Heart','2026-10-07','publisher','private.pdf',hash(githubPdf)]],pdfHosts:['academic.oup.com']});
  assert.equal((await (await h.request()).json()).status,'review');
  assert.equal(publisherCalls(h).length,0); assert.equal(oaCalls(h).length,0);
  h = harness({crossref:defaultLink,metadata:{type:'file',path:'期刊/试验.pdf',size:githubPdf.length,sha:'f'.repeat(40)},pdfHosts:['academic.oup.com']});
  assert.equal((await (await h.request()).json()).status,'review'); assert.equal(publisherCalls(h).length,0);

  // Read-only inspection, manual archive retry, paused requests and failed authentication do not fetch publishers.
  h = fixture();
  const inspection = await h.request('/api/fulltext-source',{doi});
  assert.equal(inspection.status,200); privateSourceNotProjected(await inspection.json());
  assert.equal(publisherCalls(h).length,0); assert.equal(oaCalls(h).length,0); assert.equal(h.writes.length,0);
  const onlyMetadata = {signal:new AbortController().signal,metadataOnly:true,crossrefPdfSource:{doi,urls:[pdfUrl]}};
  const priorCalls = h.calls.length; await h.context.libraryOa({doi,title},onlyMetadata); assert.equal(h.calls.length,priorCalls);
  h = fixture(); h.values.set(key,JSON.stringify(retained('manual_needed')));
  assert.equal((await (await request(h)).json()).status,'manual_needed');
  assert(h.calls.every(call => call.url.hostname === 'api.github.com'));
  h = fixture(); h.values.set('library:attempt:' + doi,JSON.stringify({status:'pending',error:'library_paused',paused:true,retryAfter:0}));
  await error(await request(h),423,'library_paused'); assert.equal(h.calls.length,0);
  h = fixture(); await error(await request(h,{passphrase:'incorrect'}),403,'pdf_passphrase_invalid'); assert.equal(h.calls.length,0);

  // Publisher login/denial/rate limiting pauses durably and never proceeds to secondary providers.
  for (const failureResponse of [
    () => new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}}),
    () => new Response('denied',{status:401}), () => new Response('denied',{status:403}),
    () => new Response('limited',{status:429,headers:{'retry-after':'120'}})
  ]) {
    h = fixture({pdfResponse:failureResponse}); await error(await request(h),423,'library_paused');
    assert.equal(publisherCalls(h).length,1); assert.equal(oaCalls(h).length,0); assert.equal(pdfWrites(h).length,0);
    assert.equal(JSON.parse(h.values.get('library:attempt:' + doi)).paused,true);
    const prior = h.calls.length; await error(await request(h),423,'library_paused'); assert.equal(h.calls.length,prior);
  }

  // Original redirect allowlist and PDF byte/time limits also apply to authoritative links.
  h = fixture({pdfResponse:() => new Response(null,{status:302,headers:{location:'https://watermark.silverchair.com/private.pdf'}})});
  assert.equal((await (await request(h)).json()).status,'review'); assert.equal(publisherCalls(h).length,1);
  assert(!h.calls.some(call => call.url.hostname === 'watermark.silverchair.com'));
  h = fixture({pdfResponse:url => url.hostname === 'academic.oup.com'
    ? new Response(null,{status:302,headers:{location:'https://www.nature.com/fixture.pdf'}})
    : new Response(pdf,{headers:{'content-type':'application/pdf'}})});
  assert.equal((await request(h)).status,200); assert.equal(publisherCalls(h).length,2);
  for (const failureResponse of [
    () => new Response(githubPdf,{headers:{'content-type':'application/pdf'}}),
    () => new Response(Buffer.concat([Buffer.from('not a PDF'),Buffer.alloc(60*1024)]),{headers:{'content-type':'application/pdf'}}),
    () => new Response(null,{headers:{'content-type':'application/pdf','content-length':String(10*1024*1024+1)}})
  ]) {
    h = fixture({pdfResponse:failureResponse}); assert.equal((await (await request(h)).json()).status,'review'); assert.equal(pdfWrites(h).length,0);
  }
  h = fixture({fastTimers:true,pdfResponse:(_url,init) => new Response(new ReadableStream({start(controller) {
    init.signal.addEventListener('abort',() => controller.error(Error('synthetic stalled publisher body')));
  }}),{headers:{'content-type':'application/pdf'}})});
  await error(await request(h),504,'library_timeout'); assert.equal(pdfWrites(h).length,0);

  console.log('Crossref publisher PDF source tests passed: exact DOI authority, stale-title review recovery, single-POST attachment, cache reuse, source privacy, bounded deduplication, GitHub priority, read-only/manual/pause guards, trusted redirects and byte/time limits.');
})().catch(failure => {console.error(failure);process.exitCode = 1;});
