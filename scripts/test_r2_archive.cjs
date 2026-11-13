'use strict';
// Offline: R2 backup of stored PDFs. The site writes pdf/sha256/<sha256>.pdf to the PDF_ARCHIVE binding only when the
// binding exists AND the KV switch cfg:r2_archive_enabled is '1'; head first, never overwrite; metadata is sha256 and size only;
// R2 is never read for downloads. Every place that stores PDF bytes is driven: open-access/GitHub acquire (librarySave),
// reader upload and machine upload (both verified through the review run, then librarySave) and a verified machine replace
// (machineReplacePdf). Hooked in at the end of test_muse_reader_upload.cjs, so CI runs it from there.
const assert = require('assert'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const {setup, token} = require('./test_fulltext_auth_helpers.cjs');
const fixtures = require('./machine_identity_fixtures.cjs');
const {doi: libDoi, pdf: libPdf, hash, error: _error} = require('./test_doi_library_worker.cjs');
const base = 'https://learn.dryz.info', reviewUrl = base + '/api/muse/review', SWITCH = 'cfg:r2_archive_enabled';
const museKey = 'synthetic_muse_key_0123456789_abcdef', dsh = 'synthetic_downloader_token_0123456789ab';
const tokens = JSON.stringify([{id:'dsh', role:'downloader', token:dsh}]);
const readerPdf = Buffer.from('%PDF-1.7\nSynthetic reader copy\n' + 'x'.repeat(52000) + '\n%%EOF\n');
const keyOf = sha => 'pdf/sha256/' + sha + '.pdf';

async function create(options = {}) {
  const h = await setup(options.setup || {});
  h.context.DecompressionStream = DecompressionStream;
  Object.assign(h.env, {MACHINE_TOKENS:tokens, ...(options.muse === false ? {} : {MUSE_FULLTEXT_ENABLED:'true', MUSE_FULLTEXT_KEY:museKey})});
  h.r2 = {heads:[], puts:[], objects:new Map(), gate:null};
  for (const sha of options.existing || []) h.r2.objects.set(keyOf(sha), {});
  h.waits = [];
  h.warnings = [];
  h.context.console = {...console, warn: message => h.warnings.push(String(message))};
  if (options.binding !== false) h.env.PDF_ARCHIVE = {
    head: async key => { h.r2.heads.push(key); if (options.throwOn === 'head') throw new Error('synthetic r2 head failure'); if (h.r2.gate) await h.r2.gate; return h.r2.objects.get(key) || null; },
    put: async (key, value, opts) => { if (options.throwOn === 'put') throw new Error('synthetic r2 put failure'); h.r2.puts.push({key, bytes:Buffer.from(value), opts}); h.r2.objects.set(key, {}); },
    get: async () => { throw new Error('R2 must never be read in this phase'); },
    list: async () => { throw new Error('R2 must never be listed in this phase'); },
    delete: async () => { throw new Error('R2 must never be deleted from'); }
  };
  if (options.on) h.values.set(SWITCH, '1');
  if (options.switchValue !== undefined) h.values.set(SWITCH, options.switchValue);
  const original = h.context.worker.fetch.bind(h.context.worker);
  h.context.worker.fetch = (request, env) => original(request, env, {waitUntil: promise => h.waits.push(promise)});
  h.trace = [];
  h.flush = () => Promise.all(h.waits.splice(0));
  return h;
}
// Every response a scenario sees is reduced to a status (and the library status field) so runs can be compared byte for byte.
async function seen(h, response) { h.trace.push(response.status); return response; }
const stored = (h, key) => JSON.parse(h.values.get(key));
function seedPaper(h, doi, title, status, pdf = null) {
  const paper = {id:'doi-' + hash(doi).slice(0, 16), doi, title, journal:'Synthetic', authors:['Jane Doe'], date:'2026-10-07', datePrecision:'day', dateBasis:'Crossref published-online', ingestedAt:'2026-10-07T04:00:00.000Z', metadataStatus:'external_bibliography_checked', fulltextStatus:status};
  const record = {version:1, paper};
  if (pdf) { record.pdf = {key:'library:pdf:' + hash(pdf), sha256:hash(pdf), size:pdf.length, source:'machine'}; h.values.set(record.pdf.key, pdf); }
  h.values.set('library:paper:' + doi, JSON.stringify(record));
}
function putJob(h, doi, state, extra = {}) {
  const id = crypto.randomUUID(), createdAt = Date.now() - 60000;
  h.values.set('library:muse-job:' + doi, JSON.stringify({version:1, id, doi, state, createdAt, updatedAt:createdAt, queueKey:'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id, ...extra}));
}
const send = (h, method, route, headers, body) => h.context.worker.fetch(new Request(base + route, {method, headers, ...(body === undefined ? {} : {body})}), h.env).then(r => seen(h, r));
const machineUpload = (h, bytes, doi, headers = {}) => send(h, 'PUT', '/api/machine/upload', {authorization:'Bearer ' + dsh, 'content-type':'application/pdf', 'x-machine-doi':doi, ...headers}, bytes);
async function review(h, body) {
  const auth = await token(h, reviewUrl, 'muse-review.yml');
  return send(h, 'POST', '/api/muse/review', {authorization:'Bearer ' + auth, 'content-type':'application/json'}, JSON.stringify(body));
}
async function verifyNext(h, doi) {
  for (const [key, value] of [...h.values]) if (key.startsWith('library:muse-review:') && JSON.parse(value).doi !== doi) h.values.delete(key);
  const task = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(task && task.doi, doi);
  const done = await review(h, {action:'complete', taskId:task.taskId, doi:task.doi, leaseId:task.leaseId, sha256:task.sha256, bytes:task.bytes, result:'verified', pages:3, method:'dual_parser_all_pages_title_doi'});
  assert.equal(done.status, 200);
}

// Each scenario stores PDF bytes through one site path and returns the sha256 values that must be archived.
const scenarios = {
  // librarySave from an open-access/GitHub fetch (acquire).
  async acquire(h) {
    const response = await h.context.worker.fetch(new Request('https://site.test/api/acquire?doi=' + encodeURIComponent(libDoi), {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({passphrase:h.env.PDF_DOWNLOAD_PASSPHRASE}).toString()}), h.env);
    h.trace.push(response.status); assert.equal(response.status, 200); await response.json();
    return [hash(libPdf)];
  },
  // Reader upload: quarantined first, stored as library:pdf only after the verifier passes (librarySave).
  async reader(h) {
    const data = new FormData(); data.append('pdf', new Blob([readerPdf], {type:'application/pdf'}), 'paper.pdf'); data.append('passphrase', 'synthetic-passphrase');
    assert.equal((await send(h, 'POST', '/api/muse/reader-upload?doi=' + encodeURIComponent(libDoi), {accept:'application/json'}, data)).status, 202);
    assert.equal(h.r2.heads.length + h.r2.puts.length, 0, 'an unverified upload is never archived');
    await verifyNext(h, libDoi);
    return [hash(readerPdf)];
  },
  // Machine upload: same quarantine and verifier, then librarySave.
  async machine(h) {
    const d = '10.9999/synthetic.r2.machine', copy = fixtures.flateEol({doi:d, title:fixtures.samples.flate.title});
    seedPaper(h, d, fixtures.samples.flate.title, 'manual_needed');
    assert.equal((await machineUpload(h, copy, d)).status, 202);
    assert.equal(h.r2.heads.length + h.r2.puts.length, 0, 'an unverified upload is never archived');
    await verifyNext(h, d);
    return [hash(copy)];
  },
  // Verified machine replace of an available original: machineReplacePdf. Only the replacement is queued.
  async replace(h) {
    const d = '10.9999/synthetic.r2.replace', title = fixtures.samples.flate.title;
    const original = fixtures.flateEol({doi:d, title}), copy = fixtures.flateEol({doi:d, title, eol:'\r\n'});
    seedPaper(h, d, title, 'available', original);
    putJob(h, d, 'available', {sha256:hash(original), bytes:original.length, source:'dsh', caller:'dsh', verification:{method:'dual_parser_all_pages_title_doi', pages:1, sha256:hash(original), bytes:original.length}});
    assert.equal((await machineUpload(h, copy, d, {'x-machine-replace':'1'})).status, 202);
    await verifyNext(h, d);
    assert.equal(stored(h, 'library:paper:' + d).pdf.sha256, hash(copy));
    return [hash(copy)];
  }
};
async function run(name, options) {
  const h = await create({...options, muse:name !== 'acquire'});
  const shas = await scenarios[name](h);
  await h.flush();
  const library = await h.context.worker.fetch(new Request(base + '/api/library?doi=' + encodeURIComponent(name === 'acquire' || name === 'reader' ? libDoi : '10.9999/synthetic.r2.' + name)), h.env);
  h.trace.push(library.status, (await library.json()).status);
  await h.flush();
  return {h, shas};
}

(async () => {
  const reference = {};
  // 1. No PDF_ARCHIVE binding: nothing is called, the switch is not even read, the flow behaves normally.
  for (const name of Object.keys(scenarios)) {
    const {h, shas} = await run(name, {binding:false, on:true});
    reference[name] = {trace:h.trace, shas};
    assert(!h.reads.some(r => r.key === SWITCH), name + ': no binding means the switch is never read');
    assert.equal(h.trace.at(-1), 'available', name + ': the paper is stored as before');
  }

  // 2. Binding present, switch missing or not exactly '1', or unreadable: no R2 call, same behaviour.
  for (const name of Object.keys(scenarios)) {
    for (const value of [undefined, '0', 'true', '', ' 1']) {
      const {h} = await run(name, {switchValue:value});
      assert.deepEqual(h.trace, reference[name].trace, name + ' switch ' + JSON.stringify(value));
      assert.equal(h.r2.heads.length + h.r2.puts.length, 0, name + ' switch ' + JSON.stringify(value) + ' makes no R2 call');
    }
    const h = await create({on:true, muse:name !== 'acquire'});
    h.env.QL_KV = {...h.env.QL_KV, get: async (key, type) => { if (key === SWITCH) throw new Error('synthetic kv failure'); return h.kv.get(key, type); }};
    await scenarios[name](h); await h.flush();
    assert.equal(h.r2.heads.length + h.r2.puts.length, 0, name + ': a failing switch read means off');
    assert.deepEqual(h.trace.slice(0, reference[name].trace.length - 2), reference[name].trace.slice(0, -2));
  }

  // 3. Switch on: exactly one head and one put per stored PDF, key from the sha256, metadata is sha256 and size only.
  for (const name of Object.keys(scenarios)) {
    const {h, shas} = await run(name, {on:true});
    assert.deepEqual(h.trace, reference[name].trace, name + ': responses are identical with the archive on');
    assert.deepEqual(shas, reference[name].shas);
    assert.deepEqual(h.r2.heads, shas.map(keyOf), name + ': exactly one head');
    assert.equal(h.r2.puts.length, shas.length, name + ': exactly one put');
    const [put] = h.r2.puts, bytes = put.bytes;
    assert.equal(put.key, keyOf(shas[0])); assert.equal(hash(bytes), shas[0], 'the stored bytes are exactly the PDF');
    assert.deepEqual(put.opts, {sha256:shas[0], httpMetadata:{contentType:'application/pdf'}, customMetadata:{sha256:shas[0], size:String(bytes.length)}});
    assert.match(put.key, /^pdf\/sha256\/[a-f0-9]{64}\.pdf$/);
    const text = JSON.stringify([put.key, put.opts]);
    for (const secret of [dsh, museKey, 'synthetic-passphrase', libDoi, '10.9999', 'doi', 'Authorization']) assert(!text.includes(secret), 'no sensitive content in the key or metadata: ' + secret);
  }

  // 3b. The write runs after the response: a head that has not answered yet does not delay it, and nothing is written meanwhile.
  { const h = await create({on:true, muse:false}); let release; h.r2.gate = new Promise(resolve => { release = resolve; });
    await scenarios.acquire(h);
    assert.equal(h.r2.puts.length, 0, 'the response came back while R2 head was still pending'); assert(h.waits.length >= 1, 'work handed to waitUntil');
    release(); await h.flush(); assert.equal(h.r2.puts.length, 1); }

  // 4. Object already there: head only, no put.
  for (const name of Object.keys(scenarios)) {
    const {h, shas} = await run(name, {on:true, existing:[reference[name].shas[0]]});
    assert.deepEqual(h.trace, reference[name].trace);
    assert.equal(h.r2.heads.length, 1); assert.equal(h.r2.puts.length, 0, name + ': an existing object is kept, never overwritten');
  }

  // 5. R2 throwing on head or on put: responses unchanged, nothing escapes. No ctx at all: also unchanged.
  for (const name of Object.keys(scenarios)) for (const throwOn of ['head', 'put']) {
    const {h} = await run(name, {on:true, throwOn});
    assert.deepEqual(h.trace, reference[name].trace, name + ' R2 ' + throwOn + ' failure changes nothing');
    assert.deepEqual(h.warnings, ['pdf archive: ' + throwOn + ' failed'], 'only a fixed message is logged: no key, DOI or error text');
  }
  { const h = await create({on:true, muse:false}); const original = h.context.worker.fetch;
    h.context.worker.fetch = (request, env) => original(request, env, {waitUntil() { throw new Error('synthetic waitUntil failure'); }});
    await scenarios.acquire(h); assert.deepEqual(h.trace, reference.acquire.trace.slice(0, h.trace.length)); }

  // 6. The switch is cached for 60 s per isolate: a second PDF inside the window reads KV once; after expiry it re-reads and stops.
  { const clock = {now:Date.parse('2026-11-13T04:00:00Z')}; const h = await create({on:true, muse:false, setup:{clock}});
    await scenarios.acquire(h); await h.flush();
    assert.equal(h.r2.puts.length, 1);
    h.values.delete(SWITCH); h.values.delete('library:paper:' + libDoi);
    await scenarios.acquire(h); await h.flush(); assert.equal(h.r2.puts.length, 1, 'cached on, the object already exists, so head only');
    assert.equal(h.reads.filter(r => r.key === SWITCH).length, 1, 'one KV read inside the window');
    clock.now += 61000; h.values.delete('library:paper:' + libDoi); h.r2.objects.clear();
    await scenarios.acquire(h); await h.flush(); assert.equal(h.r2.puts.length, 1, 'off after the cache expires');
    assert.equal(h.reads.filter(r => r.key === SWITCH).length, 2); }

  // 7. R2 is never read, listed or deleted by the site in this phase (the mock throws if it is) and downloads still come from KV.
  { const {h} = await run('acquire', {on:true}); const download = await h.context.worker.fetch(new Request('https://site.test/api/fulltext?doi=' + encodeURIComponent(libDoi), {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({passphrase:h.env.PDF_DOWNLOAD_PASSPHRASE}).toString()}), h.env);
    assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), libPdf); }
  const source = fs.readFileSync(path.join(__dirname, '../edge/src/07b-pdf-archive.js'), 'utf8');
  assert(!/PDF_ARCHIVE\.(get|list|delete|createMultipartUpload)\b/.test(source), 'no read, list or delete call on the binding');
  console.log('R2 archive checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
