'use strict';
// Offline: first-page identity check for machine uploads, the guarded replace path and the claim reason. Synthetic PDFs only.
// Needs DecompressionStream (Node 18+, same API as Workers). Hooked in at the end of test_muse_fulltext.cjs so CI runs it.
const assert = require('assert'), crypto = require('crypto'), fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib');
const {setup, token} = require('./test_fulltext_auth_helpers.cjs');
const {hash, error} = require('./test_doi_library_worker.cjs');
const {withMd5} = require('./webcrypto_md5_shim.cjs');
const fixtures = require('./machine_identity_fixtures.cjs'), encrypted = require('./machine_identity_encrypted_fixtures.cjs');
const base = 'https://learn.dryz.info', reviewUrl = base + '/api/muse/review';
const museKey = 'synthetic_muse_key_0123456789_abcdef', dsh = 'synthetic_downloader_token_0123456789ab', fallback = 'synthetic_fallback_token_0123456789abcd', reader = 'synthetic_reader_token_0123456789abcdef';
const tokens = JSON.stringify([{id:'dsh',role:'downloader',token:dsh},{id:'fallback',role:'fallback',token:fallback},{id:'ddx',role:'reader',token:reader}]);
const {flate, objstm, custom} = fixtures.samples;
function run(h, code) { return vm.runInContext(code, h.context); }
async function create() {
  const h = await setup();
  h.context.DecompressionStream = DecompressionStream;
  h.context.crypto = withMd5(h.context.crypto);
  Object.assign(h.env, {MUSE_FULLTEXT_ENABLED:'true', MUSE_FULLTEXT_KEY:museKey, MACHINE_TOKENS:tokens});
  return h;
}
const identity = (h, bytes, doi, title, options) => run(h, 'machineIdentity')(new Uint8Array(bytes), doi, title, options);
function latin(bytes) { return bytes.toString('latin1'); }
function mutate(bytes, from, to) { const text = latin(bytes); assert(text.includes(from), from); return Buffer.from(text.replace(from, to), 'latin1'); }
function seedPaper(h, doi, title, status = 'manual_needed', pdf = null) {
  const paper = {id:'doi-' + hash(doi).slice(0, 16), doi, title, journal:'Heart', authors:['Jane Doe'], date:'2026-10-07', datePrecision:'day', dateBasis:'Crossref published-online', ingestedAt:'2026-10-07T04:00:00.000Z', metadataStatus:'external_bibliography_checked', fulltextStatus:status};
  const record = {version:1, paper};
  if (pdf) { record.pdf = {key:'library:pdf:' + hash(pdf), sha256:hash(pdf), size:pdf.length, source:'machine'}; h.values.set(record.pdf.key, pdf); }
  h.values.set('library:paper:' + doi, JSON.stringify(record));
}
function putJob(h, doi, state, extra = {}) {
  const id = crypto.randomUUID(), createdAt = Date.now() - 60000;
  const job = {version:1, id, doi, state, createdAt, updatedAt:createdAt, queueKey:'library:muse-queue:' + String(createdAt).padStart(13, '0') + ':' + id, ...extra};
  if (['running', 'uploading', 'verifying'].includes(state)) Object.assign(job, {leaseId:extra.leaseId || crypto.randomUUID(), leaseUntil:extra.leaseUntil || createdAt + 3600000, acquisitionStartedAt:createdAt});
  h.values.set('library:muse-job:' + doi, JSON.stringify(job));
  if (state === 'queued') h.values.set(job.queueKey, JSON.stringify({doi, id}));
  return job;
}
const stored = (h, key) => { const value = h.values.get(key); return value === undefined ? undefined : JSON.parse(value); };
function upload(h, bytes, doi, secret = dsh, headers = {}) {
  return h.context.worker.fetch(new Request(base + '/api/machine/upload', {method:'PUT', headers:{authorization:'Bearer ' + secret, 'content-type':'application/pdf', 'x-machine-doi':doi, ...headers}, body:bytes}), h.env);
}
function post(h, route, secret, body) {
  return h.context.worker.fetch(new Request(base + route, {method:'POST', headers:{authorization:'Bearer ' + secret, 'content-type':'application/json'}, body:JSON.stringify(body)}), h.env);
}
// Tasks seeded straight into KV bypass the code that keeps the candidate index current; rebuild it from the keys.
async function reindex(h) {
  for (let n = 0; n < 20; n++) { const body = await (await post(h, '/api/machine/requeue', dsh, {reindex:true})).json(); if (body.reindex.ready) return; }
  throw new Error('index did not become ready');
}
async function review(h, body) {
  const auth = await token(h, reviewUrl, 'muse-review.yml');
  return h.context.worker.fetch(new Request(reviewUrl, {method:'POST', headers:{authorization:'Bearer ' + auth, 'content-type':'application/json'}, body:JSON.stringify(body)}), h.env);
}
async function verifyNext(h, doi, result, reason) {
  // Earlier uploads in this run are still waiting for the verifier; only this DOI is of interest here.
  for (const [key, value] of [...h.values]) if (key.startsWith('library:muse-review:') && JSON.parse(value).doi !== doi) h.values.delete(key);
  const claimed = (await (await review(h, {action:'claim'})).json()).task;
  assert.equal(claimed && claimed.doi, doi);
  const body = {action:'complete', taskId:claimed.taskId, doi:claimed.doi, leaseId:claimed.leaseId, sha256:claimed.sha256, bytes:claimed.bytes, result, pages:3, method:'dual_parser_all_pages_title_doi', ...(reason ? {reason} : {})};
  const response = await review(h, body);
  assert.equal(response.status, 200);
  return claimed;
}
(async () => {
  const files = fixtures.files();
  // The committed fixtures are exactly what the generator writes (nothing hand-edited, nothing from a publisher).
  for (const [name, bytes] of Object.entries(files)) {
    const committed = fs.readFileSync(path.join(fixtures.directory, name));
    assert(committed.equals(bytes), name + ' differs from the generator');
    assert(committed.length >= 51200 && committed.length < 60000);
    assert(/%%EOF\s*$/.test(latin(committed.subarray(-64))));
  }
  const h = await create();
  const cases = [['flate-eol-before-endstream.pdf', flate], ['objstm-xref-stream.pdf', objstm], ['custom-encoding-tounicode.pdf', custom]];
  for (const [name, sample] of cases) {
    const verdict = await identity(h, files[name], sample.doi, sample.title);
    assert.equal(verdict.verdict, 'ok', name);
    assert.equal(verdict.level, 'full', name);
    // Wrong paper: right file, other DOI / other title / both wrong never passes.
    const wrongDoi = await identity(h, files[name], '10.9999/synthetic.other', sample.title);
    assert.equal(wrongDoi.verdict, 'mismatch'); assert.equal(wrongDoi.reason, 'doi_not_found');
    const wrongTitle = await identity(h, files[name], sample.doi, 'Synthetic unrelated study of imaginary tides and moons');
    assert.equal(wrongTitle.verdict, 'mismatch'); assert.equal(wrongTitle.reason, 'title_not_found');
    const both = await identity(h, files[name], '10.9999/synthetic.other', 'Synthetic unrelated study of imaginary tides and moons');
    assert.equal(both.verdict, 'mismatch'); assert.equal(both.reason, 'identity_mismatch');
  }
  // Lancet-family RSS section labels ("[Articles] ", "[Comment] ") are not printed on page 1: first-page identity drops
  // the bracketed prefix as a fallback (titlePrefix='section_label_dropped'), and registration still strips it. Synthetic text only.
  for (const [label, printed] of [['[Articles] ', 'ClinicalAge, a framework for synthetic biological age estimation'], ['[Comment] ', 'A novel ageing biomarker in synthetic cohorts']]) {
    const labelDoi = '10.9999/synthetic.label', pdf = fixtures.flateEol({doi:labelDoi, title:printed});
    const kept = await identity(h, pdf, labelDoi, label + printed);
    assert.equal(kept.verdict, 'ok'); assert.equal(kept.level, 'full'); assert.equal(kept.checks.title, 'page'); assert.equal(kept.checks.titlePrefix, 'section_label_dropped');
    const registered = run(h, 'machineRegisterItem')({doi:labelDoi, title:label + printed, source:'rss-2026-11-17-am', section:'MAIN'});
    assert.equal(registered.title, printed);
    const fixed = await identity(h, pdf, labelDoi, registered.title);
    assert.equal(fixed.verdict, 'ok'); assert.equal(fixed.level, 'full'); assert(!('titlePrefix' in fixed.checks));
  }
  // Japanese subtitles: page 1 and Crossref print "Title\u3000\u2015 Subtitle \u2015", the RSS feed (and so the library title) "Title: Subtitle".
  // Titles modelled on Circulation Reports cr-26-0249 / cr-26-0254; the PDFs are synthetic (no publisher file).
  const normalize = run(h, 'machineNormalize');
  for (const [n, rss, printed] of [
    ['0249', 'Early Direct Oral Anticoagulant Initiation After Intracranial Hemorrhage Among Japanese Patients With Nonvalvular Atrial Fibrillation: SAFE-ICH Registry 12-Month Outcomes',
      'Early Direct Oral Anticoagulant Initiation After Intracranial Hemorrhage Among Japanese Patients With Nonvalvular Atrial Fibrillation\u3000\u2015 SAFE-ICH Registry 12-Month Outcomes \u2015'],
    ['0254', 'Association of Mean Left Atrial Pressure With Clinical Characteristics and Outcomes in Patients Undergoing Catheter Ablation for Atrial Fibrillation: Subanalysis of the Shinshu Catheter Ablation (Shinshu-AB) Registry',
      'Association of Mean Left Atrial Pressure With Clinical Characteristics and Outcomes in Patients Undergoing Catheter Ablation for Atrial Fibrillation\u3000\u2015 Subanalysis of the Shinshu Catheter Ablation (Shinshu-AB) Registry \u2015']]) {
    assert.equal(normalize(rss), normalize(printed), n);
    const dashDoi = '10.9999/synthetic.dash-' + n, pdf = fixtures.customEncoding({doi:dashDoi, title:printed});
    for (const expected of [rss, printed]) {
      const verdict = await identity(h, pdf, dashDoi, expected);
      assert.equal(verdict.verdict, 'ok', n + ' ' + expected); assert.equal(verdict.level, 'full'); assert.equal(verdict.checks.title, 'page');
    }
    // Dropping the dashes does not loosen anything else: a different subtitle still misses.
    const other = await identity(h, pdf, dashDoi, rss.replace(/: .*/, ': Synthetic Different Registry Outcomes'));
    assert.equal(other.verdict, 'mismatch'); assert.equal(other.checks.title, '');
  }
  // En dash, em dash and horizontal bar all drop like the ASCII hyphen; other non-ASCII text is kept.
  assert.equal(normalize('12\u2013Month \u2014 Outcomes \u2015'), normalize('12-Month Outcomes'));
  assert.equal(normalize('Synthetic \u5fc3\u623f\u98a4\u52a8 title'), 'synthetic\u5fc3\u623f\u98a4\u52a8title');
  // "fl" ligature mis-mapped to U+00DF by the font (shape of MDPI jcm15218528): page 1 says "Inßammation". Synthetic PDFs only.
  {
    const ligDoi = '10.9999/synthetic.ligature', title = 'Systemic Inflammation and New-Onset Atrial Fibrillation in Synthetic Cohorts';
    for (const pdf of [fixtures.flateEol({doi:ligDoi, title:title.replace('fl', '\u00df')}), fixtures.customEncoding({doi:ligDoi, title:title.replace('fl', '\u00df')})]) {
      const passed = await identity(h, pdf, ligDoi, title);
      assert.equal(passed.verdict, 'ok'); assert.equal(passed.level, 'full'); assert.equal(passed.checks.title, 'page'); assert.equal(passed.checks.titleGlyph, 'eszett_as_fl');
      // The rest of the title must still match exactly: one other word changed fails.
      const elsewhere = await identity(h, pdf, ligDoi, title.replace('Atrial', 'Ventricular'));
      assert.equal(elsewhere.verdict, 'mismatch'); assert.equal(elsewhere.checks.title, '');
      // Only "fl" is recovered: an expected "ff" or "fi" spelling is not.
      for (const other of ['ff', 'fi']) assert.equal((await identity(h, pdf, ligDoi, title.replace('fl', other))).verdict, 'mismatch', other);
    }
    // An expected title with "fl" and a page that differs elsewhere (and has no "ß") fails.
    const plain = fixtures.flateEol({doi:ligDoi, title:'Systemic Inflammation and New-Onset Ventricular Arrhythmia in Synthetic Cohorts'});
    const differs = await identity(h, plain, ligDoi, title);
    assert.equal(differs.verdict, 'mismatch'); assert(!('titleGlyph' in differs.checks));
    // A genuine German "ß" still matches its own page normally, without the fallback.
    const germanDoi = '10.9999/synthetic.german', german = 'Große Studie zur Herzinsuffizienz in synthetischen Kohorten';
    const germanPdf = fixtures.flateEol({doi:germanDoi, title:german});
    const own = await identity(h, germanPdf, germanDoi, german);
    assert.equal(own.verdict, 'ok'); assert.equal(own.level, 'full'); assert(!('titleGlyph' in own.checks));
    // ...and is not passed against a page with different text, with or without the "ß" read as "fl".
    const otherPdf = fixtures.flateEol({doi:germanDoi, title:'Große Analyse zur Vorhofflimmern in synthetischen Kohorten'});
    for (const expected of [german, german.replace('\u00df', 'fl')]) assert.equal((await identity(h, otherPdf, germanDoi, expected)).verdict, 'mismatch', expected);
  }
  // Variants of each structure.
  for (const eol of ['\r\n', '\n', '\r', ' \n']) assert.equal((await identity(h, fixtures.flateEol({...flate, eol}), flate.doi, flate.title)).verdict, 'ok', JSON.stringify(eol));
  assert.equal((await identity(h, fixtures.flateEol({...flate, lengthWrong:true}), flate.doi, flate.title)).verdict, 'ok');
  assert.equal((await identity(h, fixtures.objStm({...objstm, predictor:true}), objstm.doi, objstm.title)).verdict, 'ok');
  // Custom encoding without a ToUnicode map: title from XMP / Info only when the page text cannot be read; DOI must still be on the page.
  const xmpOnly = fixtures.customEncoding({...custom, toUnicode:false, xmpTitle:custom.title});
  const viaXmp = await identity(h, xmpOnly, custom.doi, custom.title);
  assert.equal(viaXmp.verdict, 'ok'); assert.equal(viaXmp.level, 'metadata_title'); assert.equal(viaXmp.checks.title, 'metadata');
  const viaInfo = await identity(h, fixtures.customEncoding({...custom, toUnicode:false, infoTitle:custom.title}), custom.doi, custom.title);
  assert.equal(viaInfo.level, 'metadata_title');
  const doiOnly = await identity(h, fixtures.customEncoding({...custom, toUnicode:false}), custom.doi, custom.title);
  assert.equal(doiOnly.verdict, 'ok'); assert.equal(doiOnly.level, 'doi_only');
  const otherXmp = await identity(h, fixtures.customEncoding({...custom, toUnicode:false, xmpTitle:'Synthetic unrelated study of imaginary tides and moons'}), custom.doi, custom.title);
  assert.equal(otherXmp.level, 'doi_only'); // metadata that disagrees adds nothing; the dual-parser still decides
  assert.equal((await identity(h, fixtures.customEncoding({...custom, toUnicode:false}), '10.9999/synthetic.other', custom.title)).verdict, 'mismatch');
  assert.equal((await identity(h, fixtures.customEncoding({...custom, toUnicode:false, xmpTitle:custom.title}), '10.9999/synthetic.other', custom.title)).reason, 'doi_not_found');
  // Simple font + ToUnicode with a 2-byte codespace around 1-byte entries (title with an "ff" ligature glyph): decoded one byte at a time.
  const {wide} = fixtures.samples, wideBytes = fixtures.simpleFontWideCodespace(wide);
  const wideVerdict = await identity(h, wideBytes, wide.doi, wide.title);
  assert.equal(wideVerdict.verdict, 'ok'); assert.equal(wideVerdict.level, 'full'); assert.equal(wideVerdict.checks.title, 'page');
  const wideWrong = await identity(h, wideBytes, wide.doi, 'Synthetic unrelated study of imaginary tides and moons');
  assert.equal(wideWrong.verdict, 'mismatch'); assert.equal(wideWrong.reason, 'title_not_found'); // still no free pass for another title
  assert.equal((await identity(h, wideBytes, '10.9999/synthetic.other', wide.title)).reason, 'doi_not_found');
  assert.equal((await identity(h, wideBytes, '10.9999/synthetic.other', 'Synthetic unrelated study of imaginary tides and moons')).reason, 'identity_mismatch');
  // A Type0 font keeps the width its codespace declares (the custom-encoding sample above is 2-byte Identity-H):
  // the font decoder does not decode 1-byte entries, so identity only passes via the octal ligature fallback (no titleGlyph on Type1 above).
  const wideType0 = mutate(wideBytes, '/Subtype /Type1 /BaseFont /ABCDEF+SyntheticHeadline', '/Subtype /Type0 /BaseFont /ABCDEF+SyntheticHeadline');
  const wideType0Verdict = await identity(h, wideType0, wide.doi, wide.title);
  assert.equal(wideType0Verdict.verdict, 'ok'); assert.equal(wideType0Verdict.checks.titleGlyph, 'ligature_lost');
  assert(!('titleGlyph' in wideVerdict.checks));
  const wideType0Content = await pageContent(wideType0);
  assert(!run(h, 'machineNormalize')(run(h, 'machineDecodeFontText')(wideType0Content.joined, wideType0Content.fonts)).includes(run(h, 'machineNormalize')(wide.title)));
  // One TJ array cut between two /Contents streams ("]" ends the first, "TJ" starts the second): the headline's second line was dropped.
  const {split} = fixtures.samples, splitTitle = split.title.replace(' | ', ' '), splitBytes = fixtures.splitOperatorAcrossStreams(split);
  const splitVerdict = await identity(h, splitBytes, split.doi, splitTitle);
  assert.equal(splitVerdict.verdict, 'ok'); assert.equal(splitVerdict.level, 'full'); assert.equal(splitVerdict.checks.title, 'page');
  const splitWrong = await identity(h, splitBytes, split.doi, 'Synthetic unrelated study of imaginary tides and moons');
  assert.equal(splitWrong.verdict, 'mismatch'); assert.equal(splitWrong.reason, 'title_not_found'); // no free pass for another title
  assert.equal((await identity(h, splitBytes, '10.9999/synthetic.other', splitTitle)).reason, 'doi_not_found'); // DOI still has to be on the page
  assert.equal((await identity(h, splitBytes, split.doi, splitTitle + ' and more words that the page does not have')).reason, 'title_not_found');
  // Marked-content dictionaries with a /BBox array must not swallow the following Tj / TJ strings.
  // The title and DOI are Type0 glyph ids, so only the font decoder can recover them (not machinePdfStrings).
  // A copy of the pre-fix walker (it advanced over "<<" / ">>" by two characters and left array mode on
  // after "]") is kept here to prove the BDC+Tj fixture used to drop the text.
  function legacyDecodeFontText(content, fonts) {
    let out = '', font = null, name = '', last = null, array = null;
    const length = content.length, delimiters = /[\s()<>\[\]{}\/%]/;
    const escapes = {n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'};
    const hexBytes = run(h, 'machineHexBytes'), mapCodes = run(h, 'machineMapCodes');
    for (let at = 0; at < length;) {
      const char = content[at];
      if (char === '(') {
        let text = '', depth = 1;
        for (at++; at < length && depth; at++) {
          const c = content[at];
          if (c === '\\') {
            const next = content[at + 1] || '';
            if (/[0-7]/.test(next)) { let digits = ''; while (digits.length < 3 && /[0-7]/.test(content[at + 1] || '')) { digits += content[at + 1]; at++; } text += String.fromCharCode(parseInt(digits, 8) & 255); }
            else if (next === '\r' || next === '\n') { if (next === '\r' && content[at + 2] === '\n') at++; at++; }
            else { text += escapes[next] !== undefined ? escapes[next] : next; at++; }
            continue;
          }
          if (c === '(') depth++;
          else if (c === ')') { depth--; if (!depth) break; }
          text += c;
        }
        at++;
        if (array) array.push(text); else last = text;
      } else if (char === '<' && content[at + 1] === '<') at += 2;
      else if (char === '>' && content[at + 1] === '>') at += 2;
      else if (char === '<') {
        const end = content.indexOf('>', at);
        const text = hexBytes(content.slice(at + 1, end < 0 ? length : end));
        at = end < 0 ? length : end + 1;
        if (array) array.push(text); else last = text;
      } else if (char === '[') { array = []; at++; }
      else if (char === ']') at++;
      else if (char === '%') { while (at < length && content[at] !== '\n' && content[at] !== '\r') at++; }
      else if (char === '/') {
        let end = at + 1;
        while (end < length && !delimiters.test(content[end])) end++;
        name = content.slice(at + 1, end);
        at = end;
      } else if (/\s|[{}>)]/.test(char)) at++;
      else {
        let end = at;
        while (end < length && !delimiters.test(content[end])) end++;
        if (end === at) end++;
        const token = content.slice(at, end);
        at = end;
        if (array && /^-?[\d.]+$/.test(token)) { if (Number(token) < -200) array.push(null); continue; }
        if (token === 'Tf') font = fonts.get(name) || null;
        else if (token === 'Tj' || token === "'" || token === '"') { if (last !== null) out += mapCodes(font, last); last = null; }
        else if (token === 'TJ') {
          for (const part of array || []) out += part === null ? ' ' : mapCodes(font, part);
          array = null; last = null;
        } else if (['Td', 'TD', 'T*', 'Tm'].includes(token)) out += ' ';
        else if (token === 'ET') out += '\n';
        else if (token === 'BI') { const stop = content.indexOf('EI', at); at = stop < 0 ? length : stop + 2; }
      }
    }
    return out;
  }
  async function pageContent(bytes) {
    const ctx = run(h, 'machinePdfContext')(new Uint8Array(bytes));
    const first = await run(h, 'machineFirstPageObject')(ctx);
    const ids = await run(h, 'machineContentIds')(ctx, first.body);
    const fonts = await run(h, 'machinePageFonts')(ctx, first.body);
    let joined = '';
    for (const id of ids) { const content = await run(h, 'machineContentText')(ctx, id); if (content) joined += content + '\n'; }
    return {joined, fonts};
  }
  async function assertMarked(name, bytes, sample, {legacyMustDrop}) {
    const {joined, fonts} = await pageContent(bytes);
    const legacy = legacyDecodeFontText(joined, fonts);
    const decoded = run(h, 'machineDecodeFontText')(joined, fonts);
    const normalize = run(h, 'machineNormalize');
    if (legacyMustDrop) {
      assert.equal(normalize(legacy).includes(normalize(sample.title)), false, name + ' pre-fix walker must not read the title');
      assert.equal(run(h, 'machineDoiPresent')(legacy, sample.doi), false, name + ' pre-fix walker must not read the DOI');
    } else {
      assert(normalize(legacy).includes(normalize(sample.title)), name + ' pre-fix walker must still read the TJ title');
      assert(run(h, 'machineDoiPresent')(legacy, sample.doi), name + ' pre-fix walker must still read the TJ DOI');
    }
    assert(normalize(decoded).includes(normalize(sample.title)), name + ' decoder must read the title');
    assert(run(h, 'machineDoiPresent')(decoded, sample.doi), name + ' decoder must read the DOI');
    const page = await run(h, 'machineFirstPage')(new Uint8Array(bytes));
    assert.equal(page.readable, true, name);
    const verdict = await identity(h, bytes, sample.doi, sample.title);
    assert.equal(verdict.verdict, 'ok', name);
    assert.equal(verdict.level, 'full', name);
    assert.equal(verdict.checks.title, 'page', name);
    assert.equal((await identity(h, bytes, sample.doi, 'Synthetic unrelated study of imaginary tides and moons')).reason, 'title_not_found');
    assert.equal((await identity(h, bytes, '10.9999/synthetic.other', sample.title)).reason, 'doi_not_found');
  }
  const {bdcTj, bdcTJ, nested} = fixtures.samples;
  await assertMarked('bdc-bbox-tj', fixtures.bdcBBoxTj(bdcTj), bdcTj, {legacyMustDrop:true});
  await assertMarked('bdc-bbox-TJ', fixtures.bdcBBoxTJ(bdcTJ), bdcTJ, {legacyMustDrop:false});
  await assertMarked('nested-dict-tj', fixtures.nestedDictTj(nested), nested, {legacyMustDrop:true});
  // Readable page text with a different title is never rescued by metadata.
  const readableWrong = fixtures.flateEol({...flate});
  assert.equal((await identity(h, readableWrong, flate.doi, 'Synthetic unrelated study of imaginary tides and moons')).reason, 'title_not_found');
  // Internal reason codes instead of a silent empty result.
  const brokenFlate = mutate(files['flate-eol-before-endstream.pdf'], 'stream\n', 'stream\nxxxxxxxx');
  assert.equal((await identity(h, brokenFlate, flate.doi, flate.title)).reason, 'inflate_failed');
  const unsupportedObjstm = mutate(files['objstm-xref-stream.pdf'], '/Type /ObjStm /N 3', '/Type /ObjStm /N 3 /Filter /LZWDecode /X');
  assert.equal((await identity(h, unsupportedObjstm, objstm.doi, objstm.title)).reason, 'objstm_unsupported');
  assert.equal((await identity(h, mutate(files['flate-eol-before-endstream.pdf'], '/Filter /FlateDecode', '/Filter /LZWDecode'), flate.doi, flate.title)).reason, 'filter_unsupported');
  const noPages = mutate(files['flate-eol-before-endstream.pdf'], '/Type /Pages', '/Type /Nope ');
  assert.equal((await identity(h, Buffer.from(latin(noPages).replace(/\/Root 1 0 R/, '/Root 99 0 R').replace('/Kids [3 0 R]', ''), 'latin1'), flate.doi, flate.title)).reason, 'page_tree_not_found');
  const noContents = mutate(files['flate-eol-before-endstream.pdf'], '/Contents 4 0 R', '/Contents 44 0 R');
  assert.equal((await identity(h, noContents, flate.doi, flate.title)).reason, 'contents_not_found');
  assert.equal((await identity(h, files['flate-eol-before-endstream.pdf'], flate.doi, 'Hi')).reason, 'title_too_short');
  assert.equal((await identity(h, files['flate-eol-before-endstream.pdf'], 'not a doi', flate.title)).reason, 'doi_invalid');

  // Encrypted PDFs (fixtures written by qpdf from invented samples). Standard handler, empty user password: decrypt,
  // then unpack the encrypted /ObjStm that holds the page tree. Before decryption existed these all failed as
  // objstm_unsupported, which named the symptom rather than the cause.
  const md5 = async value => Buffer.from(await run(h, 'machineMd5')(new Uint8Array(Buffer.from(value, 'latin1')))).toString('hex');
  for (const value of ['', 'a', 'abc', 'message digest', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)]) assert.equal(await md5(value), crypto.createHash('md5').update(value, 'latin1').digest('hex'), 'md5 ' + value.length);
  const encFile = name => fs.readFileSync(path.join(encrypted.directory, name));
  const {crypt, info: encInfo} = encrypted.samples;
  for (const name of ['encrypted-aesv2-r4-objstm.pdf', 'encrypted-rc4-r2-objstm.pdf', 'encrypted-rc4-r3-objstm.pdf', 'encrypted-aesv3-r5-objstm.pdf', 'encrypted-aesv3-r6-objstm.pdf']) {
    const bytes = encFile(name);
    assert(/\/Encrypt\s+\d+\s+0\s+R/.test(latin(bytes)) && /\/Type\s*\/ObjStm/.test(latin(bytes)) && bytes.length < 8192, name);
    const verdict = await identity(h, bytes, crypt.doi, crypt.title);
    assert.deepEqual({verdict:verdict.verdict, level:verdict.level, checks:verdict.checks}, {verdict:'ok', level:'full', checks:{doi:'page', title:'page', readable:true}}, name);
    assert.equal((await identity(h, bytes, crypt.doi, 'Synthetic unrelated study of imaginary tides and moons')).reason, 'title_not_found', name);
  }
  // Info /Title is an encrypted string outside any object stream: decrypted per object, it still rescues an unreadable page.
  const infoVerdict = await identity(h, encFile('encrypted-aesv2-info-title.pdf'), encInfo.doi, encInfo.title);
  assert.equal(infoVerdict.level, 'metadata_title'); assert.equal(infoVerdict.checks.title, 'metadata');
  // A file that needs a password to open is never guessed at; other handlers and methods say so instead of blaming /ObjStm.
  const userPassword = await identity(h, encFile('encrypted-user-password.pdf'), crypt.doi, crypt.title);
  assert.deepEqual({verdict:userPassword.verdict, reason:userPassword.reason, checks:userPassword.checks}, {verdict:'mismatch', reason:'encrypted_pdf', checks:{doi:'', title:'', readable:false}});
  const aesv2 = encFile('encrypted-aesv2-r4-objstm.pdf');
  assert.equal((await identity(h, mutate(aesv2, '/Filter /Standard', '/Filter /Synthetx'), crypt.doi, crypt.title)).reason, 'encryption_unsupported');
  assert.equal((await identity(h, mutate(aesv2, '/CFM /AESV2', '/CFM /AESV9'), crypt.doi, crypt.title)).reason, 'encryption_unsupported');
  assert.equal((await identity(h, mutate(aesv2, '/R 4', '/R 7'), crypt.doi, crypt.title)).reason, 'encryption_unsupported');
  // Losing the trailer /ID changes the derived key: the empty password no longer verifies.
  assert.equal((await identity(h, Buffer.from(latin(aesv2).replace(/\/ID\s*\[/g, '/XD ['), 'latin1'), crypt.doi, crypt.title)).reason, 'encrypted_pdf');
  // Unencrypted files never enter the decryptor.
  for (const name of ['flate-eol-before-endstream.pdf', 'objstm-xref-stream.pdf', 'custom-encoding-tounicode.pdf']) {
    const page = await run(h, 'machineFirstPage')(new Uint8Array(files[name]));
    assert(!page.notes.has('encrypted_pdf') && !page.notes.has('encryption_unsupported'), name);
  }
  // /Encrypt counts only in a trailer or cross-reference stream dictionary, not as bytes inside some stream.
  const encryptInStream = mutate(files['flate-eol-before-endstream.pdf'], '5 0 obj\n', '9 0 obj\n<< /Length 15 >>\nstream\n/Encrypt 5 0 R\nendstream\nendobj\n5 0 obj\n');
  assert.equal((await identity(h, encryptInStream, flate.doi, flate.title)).level, 'full');
  // Object-stream detection reads only the object's own dictionary. A short object written just before an /ObjStm used
  // to be taken for one (a fixed 400-byte window ran past its endobj), which left a false objstm_unsupported note.
  const shortBefore = mutate(files['objstm-xref-stream.pdf'], '5 0 obj\n', '9 0 obj\n7\nendobj\n5 0 obj\n');
  const shortPage = await run(h, 'machineFirstPage')(new Uint8Array(shortBefore));
  assert(!shortPage.notes.has('objstm_unsupported'), [...shortPage.notes].join(','));
  assert.equal((await identity(h, shortBefore, objstm.doi, objstm.title)).verdict, 'ok');

  // Upload endpoint: 202 for each structure, 409 with a reason code (and nothing else from the PDF) for a wrong paper.
  for (const [name, sample] of cases) {
    seedPaper(h, sample.doi, sample.title);
    const accepted = await upload(h, files[name], sample.doi);
    assert.equal(accepted.status, 202, name);
    const body = await accepted.json();
    assert.equal(body.task.state, 'uploaded-awaiting-verification'); assert.equal(body.task.identity, 'full'); assert.notEqual(body.task.state, 'done');
    assert.equal(stored(h, 'library:muse-job:' + sample.doi).identityLevel, 'full');
  }
  seedPaper(h, '10.9999/synthetic.wrong', 'Synthetic paper whose title the uploaded file does not carry');
  const wrong = await upload(h, files['flate-eol-before-endstream.pdf'], '10.9999/synthetic.wrong');
  assert.equal(wrong.status, 409);
  const wrongBody = await wrong.json();
  assert.deepEqual(Object.keys(wrongBody).sort(), ['checks', 'error', 'ok', 'reason']);
  assert.equal(wrongBody.error, 'machine_identity_mismatch'); assert.equal(wrongBody.reason, 'identity_mismatch');
  assert(!h.values.has('library:muse-job:10.9999/synthetic.wrong'));
  // Policy change approved by Donald: page 1 printing another DOI with matching title now enters manual review (202 title_mismatched_doi);
  // a different title on the same PDF still returns 409, and a subsequent valid upload (different sha256) replaces the held file.
  seedPaper(h, custom.doi + '.b', 'Synthetic unrelated study of imaginary tides and moons');
  assert.equal((await upload(h, files['custom-encoding-tounicode.pdf'], custom.doi + '.b')).status, 409);
  seedPaper(h, custom.doi + '.b', custom.title);
  const weakDoi = custom.doi + '.b';
  const heldWeak = await upload(h, files['custom-encoding-tounicode.pdf'], weakDoi);
  assert.equal(heldWeak.status, 202);
  const heldWeakBody = await heldWeak.json();
  assert.equal(heldWeakBody.task.identity, 'title_mismatched_doi');
  assert.equal(heldWeakBody.task.state, 'uploaded-awaiting-manual-review');
  const unreadable = fixtures.customEncoding({doi:weakDoi, title:custom.title, toUnicode:false});
  seedPaper(h, weakDoi, custom.title);
  const weak = await upload(h, unreadable, weakDoi);
  assert.equal(weak.status, 202);
  const weakBody = await weak.json();
  assert.equal(weakBody.task.identity, 'doi_only'); assert.equal(weakBody.task.state, 'uploaded-awaiting-verification');
  assert.equal(stored(h, 'library:muse-job:' + weakDoi).state, 'verifying'); assert.equal(stored(h, 'library:paper:' + weakDoi).paper.fulltextStatus, 'manual_needed');

  // A claimed task no longer shows the failure that made it claimable; list and claim agree.
  const failedDoi = '10.9999/synthetic.failed';
  seedPaper(h, failedDoi, 'Synthetic paper queued then reported failed by an agent');
  putJob(h, failedDoi, 'failed', {reason:'agent_failed'}); await reindex(h);
  const listed = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=failed-awaiting-fallback', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(listed.tasks.find(task => task.doi === failedDoi).reason, 'agent_failed');
  const picked = await (await post(h, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json();
  assert.equal(picked.task.doi, failedDoi); assert.equal(picked.task.state, 'downloading'); assert.equal(picked.task.reason, '');
  const claimedJob = stored(h, 'library:muse-job:' + failedDoi);
  assert.equal(claimedJob.state, 'running'); assert.equal(claimedJob.reason, undefined); assert.equal(claimedJob.previousReason, 'agent_failed');
  const downloading = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=downloading', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(downloading.tasks.find(task => task.doi === failedDoi).reason, '');
  const queuedDoi = '10.9999/synthetic.queued';
  seedPaper(h, queuedDoi, 'Synthetic paper waiting for download');
  putJob(h, queuedDoi, 'queued', {reason:'agent_failed'}); await reindex(h);
  const queuedList = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=to-download', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(queuedList.tasks.find(task => task.doi === queuedDoi).reason, '');
  const expiredDoi = '10.9999/synthetic.expired';
  seedPaper(h, expiredDoi, 'Synthetic paper whose lease ran out');
  putJob(h, expiredDoi, 'running', {leaseUntil:Date.now() - 1000}); await reindex(h);
  const expiredFirst = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=to-download', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(expiredFirst.tasks.find(task => task.doi === expiredDoi).state, 'to-download');
  assert.equal(expiredFirst.tasks.find(task => task.doi === expiredDoi).reason, '');
  const expiredFailedFirst = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=failed-awaiting-fallback', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(expiredFailedFirst.tasks.find(task => task.doi === expiredDoi), undefined);
  putJob(h, expiredDoi, 'running', {leaseUntil:Date.now() - 1000,softFailCount:1,lastSoftFailReason:'lease_expired'}); await reindex(h);
  const expiredList = await (await h.context.worker.fetch(new Request(base + '/api/machine/tasks?state=failed-awaiting-fallback', {headers:{authorization:'Bearer ' + reader}}), h.env)).json();
  assert.equal(expiredList.tasks.find(task => task.doi === expiredDoi).reason, 'lease_expired');

  // Guarded replace of an already verified original.
  const rd = '10.9999/synthetic.replace', day = new h.context.Date().toISOString().slice(0, 10);
  const original = fixtures.flateEol({doi:rd, title:flate.title});
  const copy = fixtures.flateEol({doi:rd, title:flate.title, eol:'\r\n'});
  const third = fixtures.flateEol({doi:rd, title:flate.title, eol:'\r'});
  assert.notEqual(hash(original), hash(copy));
  let spent = 0;
  const rate = secret => stored(h, 'library:machine-rate:upload:' + secret + ':' + day);
  seedPaper(h, rd, flate.title, 'available', original);
  const oldJob = putJob(h, rd, 'available', {sha256:hash(original), bytes:original.length, source:'dsh', caller:'dsh', verification:{method:'dual_parser_all_pages_title_doi', pages:1, sha256:hash(original), bytes:original.length}});
  await error(await upload(h, copy, rd), 409, 'machine_done');
  await error(await upload(h, copy, rd, reader, {'x-machine-replace':'1'}), 403, 'machine_forbidden');
  await error(await upload(h, copy, rd, museKey, {'x-machine-replace':'1'}), 403, 'machine_forbidden');
  await error(await upload(h, copy, rd, dsh, {'x-machine-replace':'yes'}), 400, 'machine_bad_request');
  await error(await upload(h, original, rd, dsh, {'x-machine-replace':'1'}), 409, 'machine_replace_same');
  const wrongPaper = fixtures.flateEol({doi:'10.9999/synthetic.other', title:flate.title});
  const mismatched = await upload(h, wrongPaper, rd, dsh, {'x-machine-replace':'1'});
  assert.equal(mismatched.status, 409); assert.equal((await mismatched.json()).reason, 'doi_not_found');
  assert.equal(stored(h, 'library:paper:' + rd).pdf.sha256, hash(original)); spent = rate('dsh'); assert(spent >= 1);
  // Another caller holds a live lease: refused.
  putJob(h, rd, 'running', {claimant:'fallback'});
  await error(await upload(h, copy, rd, dsh, {'x-machine-replace':'1'}), 409, 'machine_busy');
  h.values.set('library:muse-job:' + rd, JSON.stringify(oldJob));
  const replaced = await upload(h, copy, rd, dsh, {'x-machine-replace':'1'});
  assert.equal(replaced.status, 202);
  const replacedBody = await replaced.json();
  assert.equal(replacedBody.task.state, 'uploaded-awaiting-verification');
  assert.equal(replacedBody.task.replace.by, 'dsh'); assert.equal(replacedBody.task.replace.oldSha256, hash(original)); assert.equal(replacedBody.task.replace.newSha256, hash(copy));
  assert(Date.parse(replacedBody.task.replace.at) > 0);
  assert.equal(rate('dsh'), spent + 1); // counts toward the daily upload quota
  assert.equal(stored(h, 'library:paper:' + rd).pdf.sha256, hash(original)); // the old original stays downloadable until verification passes
  const verifying = stored(h, 'library:muse-job:' + rd);
  assert.equal(verifying.state, 'verifying'); assert.equal(verifying.replace.previous.state, 'available');
  assert.equal(verifying.supersededFrom.taskId, oldJob.id);
  assert.equal(verifying.supersededFrom.previousState, 'available');
  const replacedArchive = stored(h, 'library:muse-superseded:' + rd + ':' + oldJob.id);
  assert.equal(replacedArchive.state, 'available');
  assert.equal(replacedArchive.sha256, hash(original));
  assert.equal(replacedArchive.supersededBy, verifying.id);
  assert.equal((await upload(h, copy, rd, dsh, {'x-machine-replace':'1'})).status, 200);
  assert.equal(rate('dsh'), spent + 1);
  await error(await upload(h, third, rd, dsh, {'x-machine-replace':'1'}), 409, 'machine_conflict');
  // Verification rejects the replacement: the original stays, the task is available again and keeps the refusal.
  await verifyNext(h, rd, 'rejected', 'identity_mismatch');
  assert.equal(stored(h, 'library:paper:' + rd).pdf.sha256, hash(original));
  const restored = stored(h, 'library:muse-job:' + rd);
  assert.equal(restored.state, 'available'); assert.equal(restored.replaceRejected.newSha256, hash(copy)); assert.equal(restored.replaceRejected.by, 'dsh');
  // Second attempt passes the dual-parser verification and overwrites.
  assert.equal((await upload(h, copy, rd, fallback, {'x-machine-replace':'1'})).status, 202);
  await verifyNext(h, rd, 'verified');
  const record = stored(h, 'library:paper:' + rd);
  assert.equal(record.pdf.sha256, hash(copy)); assert.equal(record.pdf.replacedSha256, hash(original)); assert.equal(record.paper.fulltextStatus, 'available');
  assert(h.values.has('library:pdf:' + hash(original)) && h.values.has('library:pdf:' + hash(copy)));
  assert(h.values.has(run(h, 'DRIVE_PENDING_PREFIX') + hash(copy))); // the new original is queued for the Drive archive
  const finished = stored(h, 'library:muse-job:' + rd);
  assert.equal(finished.state, 'available'); assert.equal(finished.replace, undefined);
  assert.equal(finished.replacedFrom.by, 'fallback'); assert.equal(finished.replacedFrom.oldSha256, hash(original)); assert.equal(finished.replacedFrom.newSha256, hash(copy));
  assert.equal(rate('fallback'), 1);
  const served = await h.context.worker.fetch(new Request(base + '/api/library?doi=' + encodeURIComponent(rd)), h.env);
  assert.equal((await served.json()).status, 'available');
  // Nothing to replace: a paper that is not done yet.
  const pendingDoi = '10.9999/synthetic.pending';
  seedPaper(h, pendingDoi, flate.title);
  await error(await upload(h, fixtures.flateEol({doi:pendingDoi, title:flate.title}), pendingDoi, dsh, {'x-machine-replace':'1'}), 409, 'machine_replace_unneeded');
  const protocol = await (await h.context.worker.fetch(new Request(base + '/api/machine/protocol'), h.env)).json();
  assert.equal(protocol.replace.header, 'X-Machine-Replace'); assert(protocol.identityReasons.includes('inflate_failed'));

  // Relaxed first-page identity checks (synthetic PDFs built in memory; >=52 KiB so upload() accepts them).
  function synthPdf({doiLine = '', titleLine, rawTitle = false}) {
    const esc = text => String(text).replace(/[\\()]/g, ch => '\\' + ch);
    const line1 = doiLine ? '(' + esc(doiLine) + ') Tj 0 -24 Td ' : '';
    const line2 = '(' + (rawTitle ? titleLine : esc(titleLine)) + ') Tj';
    const content = zlib.deflateSync(Buffer.from('BT 1 0 0 1 72 720 Tm /F1 12 Tf ' + line1 + line2 + ' ET\n', 'latin1'));
    const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const objs = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
      null,
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
    ];
    for (let i = 0; i < objs.length; i++) {
      if (objs[i]) chunks.push(Buffer.from(objs[i], 'latin1'));
      else chunks.push(Buffer.from('4 0 obj\n<< /Filter /FlateDecode /Length ' + content.length + ' >>\nstream\n', 'latin1'), content, Buffer.from('\nendstream\nendobj\n', 'latin1'));
    }
    const size = chunks.reduce((n, b) => n + b.length, 0);
    if (size < 52000) chunks.push(Buffer.from('% ' + 'filler '.repeat(Math.ceil((52000 - size) / 7)).slice(0, 52000 - size - 3) + '\n', 'latin1'));
    chunks.push(Buffer.from('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n', 'latin1'));
    return Buffer.concat(chunks);
  }

  // 1) Punctuation normalization: Unicode hyphens/dashes (U+2010/U+2011/U+2212/U+FE58) and curly apostrophe vs ASCII.
  {
    const jahaDoi = '10.9999/synthetic.jaha', asciiTitle = 'Edge-to-Edge Synthetic Repair in Cohort Patients';
    for (const dash of ['\u2010', '\u2011', '\u2212', '\ufe58']) {
      const uniTitle = 'Edge' + dash + 'to' + dash + 'Edge Synthetic Repair in Cohort Patients';
      const uniPdf = fixtures.customEncoding({doi:jahaDoi, title:uniTitle});
      const asciiPdf = fixtures.customEncoding({doi:jahaDoi, title:asciiTitle});
      const a = await identity(h, uniPdf, jahaDoi, asciiTitle);
      assert.equal(a.verdict, 'ok'); assert.equal(a.level, 'full');
      const b = await identity(h, asciiPdf, jahaDoi, uniTitle);
      assert.equal(b.verdict, 'ok'); assert.equal(b.level, 'full');
    }
    const quoteDoi = '10.9999/synthetic.quote', curly = 'Synthetic Biomarkers in Alzheimer\u2019s Disease Progression', straight = "Synthetic Biomarkers in Alzheimer's Disease Progression";
    assert.equal((await identity(h, fixtures.customEncoding({doi:quoteDoi, title:curly}), quoteDoi, straight)).level, 'full');
    assert.equal((await identity(h, fixtures.customEncoding({doi:quoteDoi, title:straight}), quoteDoi, curly)).level, 'full');
    const diffLetters = await identity(h, fixtures.customEncoding({doi:jahaDoi, title:'Edge\u2010to\u2010Edge Synthetic Repair in Cohort Patients'}), jahaDoi, 'Edge-to-Side Synthetic Repair in Cohort Patients');
    assert.equal(diffLetters.verdict, 'mismatch'); assert.equal(diffLetters.reason, 'title_not_found');
  }

  // 2) Ligature loss fallback: dropped ("Articial"), PDF octal escape ("Bene\014t" -> "014") and "\u00fe" ("þ").
  {
    const ligDoi = '10.9999/synthetic.ligloss';
    const artTitle = 'Artificial Intelligence Diagnostics in Synthetic Cardiology';
    const artPdf = fixtures.flateEol({doi:ligDoi, title:'Articial Intelligence Diagnostics in Synthetic Cardiology'});
    const artRes = await identity(h, artPdf, ligDoi, artTitle);
    assert.equal(artRes.verdict, 'ok'); assert.equal(artRes.level, 'full'); assert.equal(artRes.checks.titleGlyph, 'ligature_lost');
    assert.equal((await identity(h, artPdf, ligDoi, artTitle.replace('Cardiology', 'Neurology'))).verdict, 'mismatch');

    const benTitle = 'Benefit of Synthetic Statin Therapy in Older Adults';
    const benOctalPdf = synthPdf({doiLine:'doi:' + ligDoi, titleLine:'Bene\\014t of Synthetic Statin Therapy in Older Adults', rawTitle:true});
    const firstPage = await run(h, 'machineFirstPage')(new Uint8Array(benOctalPdf));
    assert(firstPage.text.includes('Bene014t'), 'machinePdfStrings must read PDF octal escape \\014 as 014');
    const octRes = await identity(h, benOctalPdf, ligDoi, benTitle);
    assert.equal(octRes.verdict, 'ok'); assert.equal(octRes.level, 'full'); assert.equal(octRes.checks.titleGlyph, 'ligature_lost');

    const benThornPdf = fixtures.flateEol({doi:ligDoi, title:'Bene\u00fet of Synthetic Statin Therapy in Older Adults'});
    const thornRes = await identity(h, benThornPdf, ligDoi, benTitle);
    assert.equal(thornRes.verdict, 'ok'); assert.equal(thornRes.level, 'full'); assert.equal(thornRes.checks.titleGlyph, 'ligature_lost');

    const shortPdf = fixtures.flateEol({doi:ligDoi, title:'Articial t in Synthetic Journal'});
    const shortRes = await identity(h, shortPdf, ligDoi, 'Artificial Fit');
    assert.equal(shortRes.verdict, 'mismatch'); assert.equal(shortRes.reason, 'title_not_found');
  }

  // 3) RSS section label prefix: "[Articles] X" matches page printing X; "[Comment] Y" still mismatches.
  {
    const secDoi = '10.9999/synthetic.sec';
    const secX = 'Detecting Synthetic Arrhythmia Across Ambulatory Cohorts';
    const secPdf = fixtures.flateEol({doi:secDoi, title:secX});
    const secOk = await identity(h, secPdf, secDoi, '[Articles] ' + secX);
    assert.equal(secOk.verdict, 'ok'); assert.equal(secOk.level, 'full'); assert.equal(secOk.checks.titlePrefix, 'section_label_dropped');
    const secBad = await identity(h, secPdf, secDoi, '[Comment] Unrelated Synthetic Biomarker Study');
    assert.equal(secBad.verdict, 'mismatch'); assert.equal(secBad.reason, 'title_not_found');
  }

  // 3b) Crossref inline markup in the stored title ("<i>CYP2C19</i>", "P2Y<sub>12</sub>", shapes of NEJMoa2111749 / bmj-2024-082561):
  // the page prints only the text inside the tags. Stripping the tags adds no other tolerance.
  {
    const markupDoi = '10.9999/synthetic.markup';
    for (const [stored, printed] of [
      ['Ticagrelor versus Clopidogrel in\n  <i>CYP2C19</i>\n  Loss-of-Function Carriers with Synthetic Stroke', 'Ticagrelor versus Clopidogrel in CYP2C19 Loss-of-Function Carriers with Synthetic Stroke'],
      ['P2Y<sub>12</sub> inhibitor or aspirin after synthetic coronary intervention', 'P2Y12 inhibitor or aspirin after synthetic coronary intervention']]) {
      const markupPdf = fixtures.flateEol({doi:markupDoi, title:printed});
      const passed = await identity(h, markupPdf, markupDoi, stored);
      assert.equal(passed.verdict, 'ok', stored); assert.equal(passed.level, 'full'); assert.equal(passed.checks.title, 'page');
      const otherWords = await identity(h, markupPdf, markupDoi, stored.replace('aspirin', 'warfarin').replace('Ticagrelor', 'Prasugrel'));
      assert.equal(otherWords.verdict, 'mismatch'); assert.equal(otherWords.reason, 'title_not_found');
    }
  }

  // 4) Title-only when page 1 and metadata carry no DOI (machine uploads only; OA path stays strict).
  const noDoi = '10.9999/synthetic.nodoi', noDoiTitle = 'Synthetic Multicenter Trial Without Printed Identifier';
  const noDoiPdf = synthPdf({doiLine:'Synthetic Journal of Imaginary Medicine', titleLine:noDoiTitle});
  {
    const okTitleOnly = await identity(h, noDoiPdf, noDoi, noDoiTitle, {allowTitleOnly:true});
    assert.equal(okTitleOnly.verdict, 'ok'); assert.equal(okTitleOnly.level, 'title_only'); assert.equal(okTitleOnly.checks.doi, ''); assert.equal(okTitleOnly.checks.doiAbsent, true);
    const oaStrict = await identity(h, noDoiPdf, noDoi, noDoiTitle);
    assert.equal(oaStrict.verdict, 'mismatch'); assert.equal(oaStrict.reason, 'doi_not_found');
  }

  // 5) NEJM counter-example: page 1 carries another article's DOI ("10.1056/NEJMp2611160") + title "What the Robot Still Can’t Do".
  const nejmPdf = fixtures.customEncoding({doi:'10.1056/NEJMp2611160', title:'What the Robot Still Can\u2019t Do'});
  {
    const nejmMismatch = await identity(h, nejmPdf, '10.1056/NEJMp2606894', 'What the Robot Still Can\u2019t Do', {allowTitleOnly:true});
    assert.equal(nejmMismatch.verdict, 'mismatch'); assert.equal(nejmMismatch.reason, 'doi_not_found');
  }

  // 6) Wrong papers and short titles are still refused.
  {
    const wrongOtherDoi = await identity(h, nejmPdf, '10.1056/NEJMp2606894', 'Synthetic Unrelated Study of Imaginary Cohorts', {allowTitleOnly:true});
    assert.equal(wrongOtherDoi.verdict, 'mismatch'); assert.equal(wrongOtherDoi.reason, 'identity_mismatch');
    const wrongNoDoi = await identity(h, noDoiPdf, noDoi, 'Synthetic Unrelated Study of Imaginary Cohorts', {allowTitleOnly:true});
    assert.equal(wrongNoDoi.verdict, 'mismatch'); assert.equal(wrongNoDoi.reason, 'identity_mismatch');
    const shortTitle = 'Synthetic Short', shortNoDoiPdf = synthPdf({doiLine:'Synthetic Journal of Imaginary Medicine', titleLine:shortTitle});
    const shortNoDoi = await identity(h, shortNoDoiPdf, '10.9999/synthetic.shortnodoi', shortTitle, {allowTitleOnly:true});
    assert.equal(shortNoDoi.verdict, 'mismatch'); assert.equal(shortNoDoi.reason, 'doi_not_found');
  }

  // 7) Upload endpoint: 202 with identity 'title_only' when page 1 has no DOI;
  //    under Donald's approved policy change, page 1 printing another DOI with matching title enters manual review (202 title_mismatched_doi),
  //    while a different title still returns 409 machine_identity_mismatch.
  {
    seedPaper(h, noDoi, noDoiTitle);
    const upOk = await upload(h, noDoiPdf, noDoi);
    assert.equal(upOk.status, 202);
    const upBody = await upOk.json();
    assert.equal(upBody.task.identity, 'title_only');
    assert.equal(stored(h, 'library:muse-job:' + noDoi).identityLevel, 'title_only');

    seedPaper(h, '10.1056/nejmp2606894', 'Synthetic Unrelated Study of Imaginary Cohorts');
    await error(await upload(h, nejmPdf, '10.1056/NEJMp2606894'), 409, 'machine_identity_mismatch');
    seedPaper(h, '10.1056/nejmp2606894', 'What the Robot Still Can\u2019t Do');
    const heldNejm = await upload(h, nejmPdf, '10.1056/NEJMp2606894');
    assert.equal(heldNejm.status, 202);
    const heldNejmBody = await heldNejm.json();
    assert.equal(heldNejmBody.task.identity, 'title_mismatched_doi');
    assert.equal(heldNejmBody.task.state, 'uploaded-awaiting-manual-review');
  }

  // 8) Later-page DOI scan & foreign-DOI manual-review hold (machine uploads only; OA path remains strict).
  {
    const nejmTitle = 'What the Robot Still Can\u2019t Do';
    const prevDoi = '10.1056/NEJMp2611160', targetDoi = '10.1056/NEJMp2606894', thirdDoi = '10.1056/NEJMp9999999';
    const allOpts = {allowTitleOnly:true, scanAllPages:true, holdForeignDoi:true};
    const scanOnlyOpts = {allowTitleOnly:true, scanAllPages:true};

    // a) 3-page PDF: page 1 prints previous article's DOI + title, page 3 footer prints claimed DOI.
    const pdfA = fixtures.multiPage({pages:[
      {literal:'DOI: ' + prevDoi, unicode:nejmTitle},
      'Synthetic body text on page two without any identifier',
      'Footer DOI: ' + targetDoi
    ]});
    const resA = await identity(h, pdfA, targetDoi, nejmTitle, allOpts);
    assert.equal(resA.verdict, 'ok');
    assert.equal(resA.level, 'doi_later_page');
    assert.equal(resA.checks.doi, 'later_page');
    assert.equal(resA.checks.doiPage, 3);
    assert(!resA.hold);
    const oaA = await identity(h, pdfA, targetDoi, nejmTitle);
    assert.equal(oaA.verdict, 'mismatch');
    assert.equal(oaA.reason, 'doi_not_found');

    // b) 3-page PDF: page 1 prints foreign DOI + title, page 3 prints another foreign DOI (claimed DOI absent everywhere).
    const pdfB = fixtures.multiPage({pages:[
      {literal:'DOI: ' + prevDoi, unicode:nejmTitle},
      'Synthetic body text on page two without any identifier',
      'Footer DOI: ' + thirdDoi
    ]});
    const resB = await identity(h, pdfB, targetDoi, nejmTitle, allOpts);
    assert.equal(resB.verdict, 'ok');
    assert.equal(resB.level, 'title_mismatched_doi');
    assert.equal(resB.hold, true);
    assert.equal(resB.checks.foreignDoi, true);
    const scanOnlyB = await identity(h, pdfB, targetDoi, nejmTitle, scanOnlyOpts);
    assert.equal(scanOnlyB.verdict, 'mismatch');
    assert.equal(scanOnlyB.reason, 'doi_not_found');

    // c) Claiming page 1's own DOI keeps level 'full'.
    const resC = await identity(h, pdfA, prevDoi, nejmTitle, allOpts);
    assert.equal(resC.verdict, 'ok');
    assert.equal(resC.level, 'full');
    assert.equal((await identity(h, pdfA, prevDoi, nejmTitle)).level, 'full');

    // d) Different title + foreign DOI on page 1 + no claimed DOI on later pages -> mismatch identity_mismatch.
    const resD = await identity(h, pdfB, targetDoi, 'Synthetic Unrelated Study of Imaginary Cohorts', allOpts);
    assert.equal(resD.verdict, 'mismatch');
    assert.equal(resD.reason, 'identity_mismatch');

    // e) No DOI on page 1: page 2 has claimed DOI -> doi_later_page (stronger than title_only); no DOI anywhere -> title_only.
    const noDoiTwoPagesHit = fixtures.multiPage({pages:[
      'Synthetic Journal of Imaginary Medicine. ' + nejmTitle,
      'Page two footer DOI: ' + targetDoi
    ]});
    const resE1 = await identity(h, noDoiTwoPagesHit, targetDoi, nejmTitle, allOpts);
    assert.equal(resE1.verdict, 'ok');
    assert.equal(resE1.level, 'doi_later_page');
    assert.equal(resE1.checks.doiPage, 2);
    const noDoiTwoPagesMiss = fixtures.multiPage({pages:[
      'Synthetic Journal of Imaginary Medicine. ' + nejmTitle,
      'Page two body text without identifier'
    ]});
    const resE2 = await identity(h, noDoiTwoPagesMiss, targetDoi, nejmTitle, allOpts);
    assert.equal(resE2.verdict, 'ok');
    assert.equal(resE2.level, 'title_only');
    assert.equal(resE2.checks.doiAbsent, true);

    // f) Page limit (MACHINE_MAX_PAGES = 200): DOI on page 201 is not scanned; DOI on page 200 passes as doi_later_page.
    const pages201Miss = ['Synthetic Journal of Imaginary Medicine. ' + nejmTitle];
    for (let p = 2; p <= 200; p++) pages201Miss.push('Page ' + p);
    pages201Miss.push('DOI: ' + targetDoi);
    const pdf201 = fixtures.multiPage({pages:pages201Miss});
    const res201 = await identity(h, pdf201, targetDoi, nejmTitle, allOpts);
    assert.equal(res201.verdict, 'ok');
    assert.equal(res201.level, 'title_only');
    const ctx201 = run(h, 'machinePdfContext')(new Uint8Array(pdf201));
    assert.deepEqual(await run(h, 'machineFindDoiOnLaterPages')(ctx201, targetDoi), {page:0, truncated:true, citedPages:0});

    const pages200Hit = ['DOI: ' + prevDoi + ' ' + nejmTitle];
    for (let p = 2; p <= 199; p++) pages200Hit.push('Page ' + p);
    pages200Hit.push('DOI: ' + targetDoi);
    const pdf200Hit = fixtures.multiPage({pages:pages200Hit});
    const res200Hit = await identity(h, pdf200Hit, targetDoi, nejmTitle, allOpts);
    assert.equal(res200Hit.verdict, 'ok');
    assert.equal(res200Hit.level, 'doi_later_page');
    assert.equal(res200Hit.checks.doiPage, 200);

    const pages200Miss = ['DOI: ' + prevDoi + ' ' + nejmTitle];
    for (let p = 2; p <= 200; p++) pages200Miss.push('Page ' + p);
    const pdf200Miss = fixtures.multiPage({pages:pages200Miss});
    const ctx200Miss = run(h, 'machinePdfContext')(new Uint8Array(pdf200Miss));
    assert.deepEqual(await run(h, 'machineFindDoiOnLaterPages')(ctx200Miss, targetDoi), {page:0, citedPages:0});

    // Nested /Pages tree + indirect /Kids array + cycle protection (Set) in machinePageBodies, and 64 MiB inflate budget.
    const nestedTreePdf = Buffer.from([
      '%PDF-1.7\n',
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Count 3 /Kids 10 0 R >>\nendobj\n',
      '10 0 obj\n[3 0 R 4 0 R]\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 20 0 R >>\nendobj\n',
      '4 0 obj\n<< /Type /Pages /Parent 2 0 R /Count 2 /Kids [2 0 R 5 0 R 6 0 R] >>\nendobj\n',
      '5 0 obj\n<< /Type /Page /Parent 4 0 R /Contents 21 0 R >>\nendobj\n',
      '6 0 obj\n<< /Type /Page /Parent 4 0 R /Contents 22 0 R >>\nendobj\n',
      '20 0 obj\n<< /Length 12 >>\nstream\n(p1) Tj\n\nendstream\nendobj\n',
      '21 0 obj\n<< /Length 12 >>\nstream\n(p2) Tj\n\nendstream\nendobj\n',
      '22 0 obj\n<< /Length 12 >>\nstream\n(p3) Tj\n\nendstream\nendobj\n',
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n'
    ].join(''), 'latin1');
    const nestedCtx = run(h, 'machinePdfContext')(new Uint8Array(nestedTreePdf));
    const nestedBodies = await run(h, 'machinePageBodies')(nestedCtx, 10);
    assert.equal(nestedBodies.length, 3);
    assert(nestedBodies[0].includes('20 0 R') && nestedBodies[1].includes('21 0 R') && nestedBodies[2].includes('22 0 R'));

    const bigBlank = zlib.deflateSync(Buffer.alloc(14 * 1024 * 1024, 0x20));
    const budgetParts = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Count 7 /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R 8 0 R 9 0 R] >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 13 0 R >>\nendobj\n',
      '4 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 14 0 R >>\nendobj\n',
      '5 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 14 0 R >>\nendobj\n',
      '6 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 14 0 R >>\nendobj\n',
      '7 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 14 0 R >>\nendobj\n',
      '8 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 14 0 R >>\nendobj\n',
      '9 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 15 0 R >>\nendobj\n'
    ];
    const p1Small = zlib.deflateSync(Buffer.from('BT (Synthetic Title) Tj ET\n', 'latin1'));
    const p7Hit = zlib.deflateSync(Buffer.from('BT (' + targetDoi + ') Tj ET\n', 'latin1'));
    const budgetPdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n' + budgetParts.join(''), 'latin1'),
      Buffer.from('13 0 obj\n<< /Filter /FlateDecode /Length ' + p1Small.length + ' >>\nstream\n', 'latin1'), p1Small, Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from('14 0 obj\n<< /Filter /FlateDecode /Length ' + bigBlank.length + ' >>\nstream\n', 'latin1'), bigBlank, Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from('15 0 obj\n<< /Filter /FlateDecode /Length ' + p7Hit.length + ' >>\nstream\n', 'latin1'), p7Hit, Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1')
    ]);
    const budgetCtx = run(h, 'machinePdfContext')(new Uint8Array(budgetPdf));
    assert.deepEqual(await run(h, 'machineFindDoiOnLaterPages')(budgetCtx, targetDoi), {page:0, truncated:true, citedPages:0});

    // g) Upload endpoint layer: held manual-review task vs doi_later_page task.
    const hg = await create();
    const holdDoiLower = targetDoi.toLowerCase();
    seedPaper(hg, holdDoiLower, nejmTitle);
    const heldUp = await upload(hg, pdfB, targetDoi);
    assert.equal(heldUp.status, 202);
    const heldBody = await heldUp.json();
    assert.equal(heldBody.task.identity, 'title_mismatched_doi');
    assert.equal(heldBody.task.state, 'uploaded-awaiting-manual-review');
    assert.equal(heldBody.task.claimable, false);
    const heldJob = stored(hg, 'library:muse-job:' + holdDoiLower);
    assert.equal(heldJob.state, 'review');
    assert.equal(heldJob.verificationReason, 'identity_hold');
    assert.equal(heldJob.reason, 'identity_hold');
    assert.equal(heldJob.identityLevel, 'title_mismatched_doi');
    assert.equal(heldJob.hold, undefined);
    assert.equal(heldJob.leaseId, undefined);
    assert.equal(heldJob.leaseUntil, undefined);
    assert(![...hg.values.keys()].some(key => key.startsWith('library:muse-review:')));
    assert.notEqual(stored(hg, 'library:paper:' + holdDoiLower).paper.fulltextStatus, 'available');

    // Same PDF re-uploaded -> 200 idempotent, no duplicate task or quota consumption.
    const heldReplay = await upload(hg, pdfB, targetDoi);
    assert.equal(heldReplay.status, 200);
    const heldReplayBody = await heldReplay.json();
    assert.equal(heldReplayBody.idempotent, true);
    assert.equal(heldReplayBody.task.taskId, heldBody.task.taskId);
    assert.equal(heldReplayBody.task.state, 'uploaded-awaiting-manual-review');
    assert.equal(heldReplayBody.task.identity, 'title_mismatched_doi');

    // /api/library?doi= never treats a held task as available, and /api/acquire HTML shows the identity_hold headline.
    const libLookup = await (await hg.context.worker.fetch(new Request(base + '/api/library?doi=' + encodeURIComponent(holdDoiLower)), hg.env)).json();
    assert.notEqual(libLookup.status, 'available');
    assert.equal(libLookup.job.state, 'review');
    assert.equal(libLookup.job.reason, 'identity_hold');
    const acquireHtml = await (await hg.context.worker.fetch(new Request(base + '/api/acquire?doi=' + encodeURIComponent(holdDoiLower), {headers:{accept:'text/html'}}), hg.env)).text();
    assert(acquireHtml.includes('已收到 PDF，首页印的是另一篇的 DOI，等待人工核对，核对前不公开。'));

    // muse-review claim, machine claim, and requeue never pick up the held job; protocol and task lists reflect the new state.
    assert.equal((await (await review(hg, {action:'claim'})).json()).task, null);
    assert.equal((await (await post(hg, '/api/machine/claim', fallback, {state:'failed-awaiting-fallback'})).json()).task, null);
    assert.equal((await (await post(hg, '/api/machine/claim', dsh, {state:'to-download'})).json()).task, null);
    assert.equal((await (await post(hg, '/api/machine/requeue', dsh, {dryRun:false, limit:20})).json()).requeued.length, 0);
    const fallbackListed = await (await hg.context.worker.fetch(new Request(base + '/api/machine/tasks?state=failed-awaiting-fallback', {headers:{authorization:'Bearer ' + reader}}), hg.env)).json();
    assert(!fallbackListed.tasks.some(task => task.doi === holdDoiLower));
    const manualReviewListed = await (await hg.context.worker.fetch(new Request(base + '/api/machine/tasks?state=uploaded-awaiting-manual-review', {headers:{authorization:'Bearer ' + reader}}), hg.env)).json();
    assert(manualReviewListed.tasks.some(task => task.doi === holdDoiLower && task.state === 'uploaded-awaiting-manual-review' && task.claimable === false));
    const protoCheck = await (await hg.context.worker.fetch(new Request(base + '/api/machine/protocol'), hg.env)).json();
    assert(protoCheck.states.includes('uploaded-awaiting-manual-review'));
    assert(String(protoCheck.stateMapNote || '').includes('uploaded-awaiting-manual-review'));

    // Uploading a different valid PDF (pdfA) supersedes the held task into verifying (doi_later_page).
    const replaceHeld = await upload(hg, pdfA, targetDoi);
    assert.equal(replaceHeld.status, 202);
    const replaceHeldBody = await replaceHeld.json();
    assert.equal(replaceHeldBody.task.identity, 'doi_later_page');
    assert.equal(replaceHeldBody.task.state, 'uploaded-awaiting-verification');
    assert.equal(stored(hg, 'library:muse-job:' + holdDoiLower).supersededFrom.reason, 'identity_hold');

    // Fresh upload of pdfA -> 202, identity 'doi_later_page', state 'uploaded-awaiting-verification'.
    const ha = await create();
    seedPaper(ha, holdDoiLower, nejmTitle);
    const laterUp = await upload(ha, pdfA, targetDoi);
    assert.equal(laterUp.status, 202);
    const laterUpBody = await laterUp.json();
    assert.equal(laterUpBody.task.identity, 'doi_later_page');
    assert.equal(laterUpBody.task.state, 'uploaded-awaiting-verification');
    const laterJob = stored(ha, 'library:muse-job:' + holdDoiLower);
    assert.equal(laterJob.state, 'verifying');
    assert(ha.values.has('library:muse-review:' + laterJob.id));

    // h) Reference/listing pages on later pages (>= 2 other DOIs alongside the claimed DOI) must not count as doi_later_page.
    const refDois = ['10.9999/synthetic.ref1', '10.9999/synthetic.ref2', '10.9999/synthetic.ref3'];
    assert.deepEqual(
      run(h, 'machineDoiTokens')('See 10.1056/NEJMp2606894., <https://doi.org/10.1056/NEJMp2606894>; (10.9999/synthetic.ref1), [10.9999/SYNTHETIC.REF1] and "10.9999/synthetic.ref2".'),
      ['10.1056/nejmp2606894', '10.9999/synthetic.ref1', '10.9999/synthetic.ref2']
    );

    // 8a) Page 1 foreign DOI + title, page 3 references cite claimed DOI + 3 other DOIs -> title_mismatched_doi (hold).
    const citedForeignPdf = fixtures.multiPage({pages:[
      {literal:'DOI: ' + prevDoi, unicode:nejmTitle},
      'Synthetic body text on page two without identifiers',
      'References: ' + refDois[0] + '; ' + targetDoi + '. ' + refDois[1] + ', ' + refDois[2] + '.'
    ]});
    const citedForeignRes = await identity(h, citedForeignPdf, targetDoi, nejmTitle, allOpts);
    assert.equal(citedForeignRes.verdict, 'ok');
    assert.equal(citedForeignRes.level, 'title_mismatched_doi');
    assert.equal(citedForeignRes.hold, true);
    assert.equal(citedForeignRes.checks.foreignDoi, true);
    assert.equal(citedForeignRes.checks.citedPages, 1);
    const citedScanOnly = await identity(h, citedForeignPdf, targetDoi, nejmTitle, scanOnlyOpts);
    assert.equal(citedScanOnly.verdict, 'mismatch');
    assert.equal(citedScanOnly.reason, 'doi_not_found');
    assert.equal(citedScanOnly.checks.citedPages, 1);
    assert.deepEqual(await run(h, 'machineFindDoiOnLaterPages')(run(h, 'machinePdfContext')(new Uint8Array(citedForeignPdf)), targetDoi), {page:0, citedPages:1});
    const hc = await create();
    seedPaper(hc, holdDoiLower, nejmTitle);
    const citedHoldUp = await upload(hc, citedForeignPdf, targetDoi);
    assert.equal(citedHoldUp.status, 202);
    const citedHoldBody = await citedHoldUp.json();
    assert.equal(citedHoldBody.task.identity, 'title_mismatched_doi');
    assert.equal(citedHoldBody.task.state, 'uploaded-awaiting-manual-review');

    // 8b) Same reference page on page 3, but page 1 carries no DOI -> title_only.
    const citedNoDoiPdf = fixtures.multiPage({pages:[
      'Synthetic Journal of Imaginary Medicine. ' + nejmTitle,
      'Synthetic body text on page two without identifiers',
      'References: ' + refDois[0] + '; ' + targetDoi + '. ' + refDois[1] + ', ' + refDois[2] + '.'
    ]});
    const citedNoDoiRes = await identity(h, citedNoDoiPdf, targetDoi, nejmTitle, allOpts);
    assert.equal(citedNoDoiRes.verdict, 'ok');
    assert.equal(citedNoDoiRes.level, 'title_only');
    assert.equal(citedNoDoiRes.checks.doiAbsent, true);
    assert.equal(citedNoDoiRes.checks.citedPages, 1);
    assert(!citedNoDoiRes.hold);

    // 8c) Page 2 reference/listing page (claimed DOI + 3 others), page 3 footer has only claimed DOI -> doi_later_page on page 3.
    const citedThenFooterPdf = fixtures.multiPage({pages:[
      {literal:'DOI: ' + prevDoi, unicode:nejmTitle},
      'Related articles: ' + refDois[0] + ', ' + refDois[1] + ', ' + targetDoi + ', ' + refDois[2],
      'Footer DOI: ' + targetDoi
    ]});
    const citedThenFooterRes = await identity(h, citedThenFooterPdf, targetDoi, nejmTitle, allOpts);
    assert.equal(citedThenFooterRes.verdict, 'ok');
    assert.equal(citedThenFooterRes.level, 'doi_later_page');
    assert.equal(citedThenFooterRes.checks.doi, 'later_page');
    assert.equal(citedThenFooterRes.checks.doiPage, 3);
    assert.equal(citedThenFooterRes.checks.citedPages, 1);
    assert(!citedThenFooterRes.hold);

    // 8d) Hit page has claimed DOI + 1 other DOI (positive boundary) -> doi_later_page; +2 other DOIs -> skipped.
    const oneOtherPdf = fixtures.multiPage({pages:[
      {literal:'DOI: ' + prevDoi, unicode:nejmTitle},
      'See companion ' + thirdDoi + ' | Footer DOI: ' + targetDoi
    ]});
    const oneOtherRes = await identity(h, oneOtherPdf, targetDoi, nejmTitle, allOpts);
    assert.equal(oneOtherRes.verdict, 'ok');
    assert.equal(oneOtherRes.level, 'doi_later_page');
    assert.equal(oneOtherRes.checks.doi, 'later_page');
    assert.equal(oneOtherRes.checks.doiPage, 2);
    assert(!('citedPages' in oneOtherRes.checks));

    const twoOtherPdf = fixtures.multiPage({pages:[
      {literal:'DOI: ' + prevDoi, unicode:nejmTitle},
      'See ' + refDois[0] + ', ' + refDois[1] + ' and ' + targetDoi
    ]});
    const twoOtherRes = await identity(h, twoOtherPdf, targetDoi, nejmTitle, allOpts);
    assert.equal(twoOtherRes.verdict, 'ok');
    assert.equal(twoOtherRes.level, 'title_mismatched_doi');
    assert.equal(twoOtherRes.hold, true);
    assert.equal(twoOtherRes.checks.citedPages, 1);

    // 8e) Line-wrap truncation: prefix fragment ("10.1056/NEJMp26") + full claimed DOI + 1 other DOI -> still doi_later_page.
    const prefixAndFullPdf = fixtures.multiPage({pages:[
      {literal:'DOI: ' + prevDoi, unicode:nejmTitle},
      'Wrapped 10.1056/NEJMp26 06894 | Footer DOI: ' + targetDoi + ' | Companion: ' + thirdDoi
    ]});
    const prefixAndFullRes = await identity(h, prefixAndFullPdf, targetDoi, nejmTitle, allOpts);
    assert.equal(prefixAndFullRes.verdict, 'ok');
    assert.equal(prefixAndFullRes.level, 'doi_later_page');
    assert.equal(prefixAndFullRes.checks.doiPage, 2);
    assert(!('citedPages' in prefixAndFullRes.checks));

    // Also when a line break splits the claimed DOI itself with a trailing dot before the break ("10.1001/jama.2022.\n24331").
    const jamaTarget = '10.1001/jama.2022.24331';
    const wrappedDotPdf = fixtures.multiPage({pages:[
      {literal:'DOI: ' + prevDoi, unicode:nejmTitle},
      'Footer 10.1001/jama.2022.\n24331 | Companion: ' + thirdDoi
    ]});
    const wrappedDotRes = await identity(h, wrappedDotPdf, jamaTarget, nejmTitle, allOpts);
    assert.equal(wrappedDotRes.verdict, 'ok');
    assert.equal(wrappedDotRes.level, 'doi_later_page');
    assert.equal(wrappedDotRes.checks.doiPage, 2);
    assert(!('citedPages' in wrappedDotRes.checks));
  }

  // 8) Title-variant fallback (whole-word versus/vs./v. and trademark marks ™/®), colon spacing, and normal-match precedence.
  {
    const titleVariant = run(h, 'machineTitleVariant');

    // 8a) versus / vs / vs. / v. whole-word fallback.
    const vsDoi = '10.9999/synthetic.versus';
    const vsPageTitle = 'Efficacy of Synthetic Flecainide vs Amiodarone for Cardioversion in Cohorts';
    const vsPdf = fixtures.customEncoding({doi:vsDoi, title:vsPageTitle});
    for (const word of ['Versus', 'v.']) {
      const res = await identity(h, vsPdf, vsDoi, 'Efficacy of Synthetic Flecainide ' + word + ' Amiodarone for Cardioversion in Cohorts');
      assert.equal(res.verdict, 'ok', word);
      assert.equal(res.level, 'full', word);
      assert.equal(res.checks.titleVariant, 'versus_or_mark', word);
    }
    // "vs." already equals "vs" under machineNormalize, so it passes via normal comparison without titleVariant.
    const vsDotRes = await identity(h, vsPdf, vsDoi, 'Efficacy of Synthetic Flecainide vs. Amiodarone for Cardioversion in Cohorts');
    assert.equal(vsDotRes.verdict, 'ok');
    assert.equal(vsDotRes.level, 'full');
    assert(!('titleVariant' in vsDotRes.checks));
    const revPdf = fixtures.customEncoding({doi:vsDoi, title:'Efficacy of Synthetic Flecainide Versus Amiodarone for Cardioversion in Cohorts'});
    for (const word of ['vs', 'vs.']) {
      const revRes = await identity(h, revPdf, vsDoi, 'Efficacy of Synthetic Flecainide ' + word + ' Amiodarone for Cardioversion in Cohorts');
      assert.equal(revRes.verdict, 'ok', 'rev ' + word);
      assert.equal(revRes.level, 'full', 'rev ' + word);
      assert.equal(revRes.checks.titleVariant, 'versus_or_mark', 'rev ' + word);
    }

    // Counter-examples: non-whole-word substrings and different drugs still mismatch.
    const canvsPdf = fixtures.customEncoding({doi:vsDoi, title:'Synthetic Canvs Imaging Study in Atrial Cohorts'});
    const canvsBad = await identity(h, canvsPdf, vsDoi, 'Synthetic Canvas Imaging Study in Atrial Cohorts');
    assert.equal(canvsBad.verdict, 'mismatch');
    assert.equal(canvsBad.reason, 'title_not_found');
    const dronedarone = await identity(h, vsPdf, vsDoi, 'Efficacy of Synthetic Flecainide Versus Dronedarone for Cardioversion in Cohorts');
    assert.equal(dronedarone.verdict, 'mismatch');
    assert.equal(dronedarone.reason, 'title_not_found');
    assert.equal(titleVariant('Conversus Universal Advisor'), normalize('Conversus Universal Advisor'));

    // Section-label stripping combined with titleVariant keeps both checks fields.
    const prefixVs = await identity(h, vsPdf, vsDoi, '[Articles] Efficacy of Synthetic Flecainide Versus Amiodarone for Cardioversion in Cohorts');
    assert.equal(prefixVs.verdict, 'ok');
    assert.equal(prefixVs.level, 'full');
    assert.equal(prefixVs.checks.titlePrefix, 'section_label_dropped');
    assert.equal(prefixVs.checks.titleVariant, 'versus_or_mark');

    // 8b) Trademark marks ™ (U+2122) / ® (U+00AE).
    const markDoi = '10.9999/synthetic.trademark';
    const cadPage = 'CAD-RADS 2.0 \u2013 2022 Synthetic Coronary Artery Disease Reporting and Data System';
    const cadPdf = fixtures.customEncoding({doi:markDoi, title:cadPage});
    const cadOk = await identity(h, cadPdf, markDoi, 'CAD-RADS\u2122 2.0 \u2013 2022 Synthetic Coronary Artery Disease Reporting and Data System');
    assert.equal(cadOk.verdict, 'ok');
    assert.equal(cadOk.level, 'full');
    assert.equal(cadOk.checks.titleVariant, 'versus_or_mark');
    const regPdf = fixtures.customEncoding({doi:markDoi, title:'SyntheticValve Transcatheter Repair in Elderly Cohorts'});
    const regOk = await identity(h, regPdf, markDoi, 'SyntheticValve\u00ae Transcatheter Repair in Elderly Cohorts');
    assert.equal(regOk.verdict, 'ok');
    assert.equal(regOk.level, 'full');
    assert.equal(regOk.checks.titleVariant, 'versus_or_mark');
    const cadBad = await identity(h, cadPdf, markDoi, 'CAD-RADS\u2122 3.0 \u2013 2022 Synthetic Coronary Artery Disease Reporting and Data System');
    assert.equal(cadBad.verdict, 'mismatch');
    assert.equal(cadBad.reason, 'title_not_found');
    assert.notEqual(titleVariant('CAD-RADS\u2122 2.0'), titleVariant('CAD-RADS 3.0'));

    // 8c) Punctuation spacing (no code added; machineNormalize strips spaces and ASCII punctuation).
    assert.equal(normalize('Atrial Fibrillation Revisited:Early Entrenchment'), normalize('Atrial Fibrillation Revisited: Early Entrenchment'));
    const colonDoi = '10.9999/synthetic.colonspace';
    const colonPdf = fixtures.customEncoding({doi:colonDoi, title:'Synthetic Fibrillation Begets Fibrillation Revisited: Early Entrenchment of Episodes'});
    const colonOk = await identity(h, colonPdf, colonDoi, 'Synthetic Fibrillation Begets Fibrillation Revisited:Early Entrenchment of Episodes');
    assert.equal(colonOk.verdict, 'ok');
    assert.equal(colonOk.level, 'full');
    assert(!('titleVariant' in colonOk.checks));
    const colonBad = await identity(h, colonPdf, colonDoi, 'Synthetic Fibrillation Begets Fibrillation Revisited:Late Entrenchment of Episodes');
    assert.equal(colonBad.verdict, 'mismatch');
    assert.equal(colonBad.reason, 'title_not_found');

    // 8d) Normal match does not trigger the titleVariant fallback.
    const normalVerdict = await identity(h, files['flate-eol-before-endstream.pdf'], flate.doi, flate.title);
    assert.equal(normalVerdict.verdict, 'ok');
    assert.equal(normalVerdict.level, 'full');
    assert(!('titleVariant' in normalVerdict.checks));
  }

  // 9) Narrow titleVariant fallbacks after versus_or_mark.
  {
    const esc = text => String(text).replace(/[\\()]/g, ch => '\\' + ch);

    // 9a) c1_control_dropped: U+0096 between digits, plus versus/™ reuse and section-label stripping; one letter off still fails.
    const c1Doi = '10.9999/synthetic.c1ctrl';
    const c1Title = 'CAD-SYNTH\u2122 2.0 \u2013 2022 Synthetic Coronary Scoring in Multicenter Cohorts';
    const c1PageText = 'CAD-SYNTH 2.0\u00962022 Synthetic Coronary Scoring in Multicenter Cohorts';
    for (const c1Pdf of [fixtures.flateEol({doi:c1Doi, title:c1PageText}), fixtures.customEncoding({doi:c1Doi, title:c1PageText})]) {
      const ok = await identity(h, c1Pdf, c1Doi, c1Title);
      assert.equal(ok.verdict, 'ok');
      assert.equal(ok.level, 'full');
      assert.equal(ok.checks.titleVariant, 'c1_control_dropped');
      const withPrefix = await identity(h, c1Pdf, c1Doi, '[Articles] ' + c1Title);
      assert.equal(withPrefix.verdict, 'ok');
      assert.equal(withPrefix.checks.titlePrefix, 'section_label_dropped');
      assert.equal(withPrefix.checks.titleVariant, 'c1_control_dropped');
      const oneLetterOff = await identity(h, c1Pdf, c1Doi, c1Title.replace('Cohorts', 'Cohortx'));
      assert.equal(oneLetterOff.verdict, 'mismatch');
      assert.equal(oneLetterOff.reason, 'title_not_found');
    }

    // 9b) line_number_inserted: only when the claimed DOI is already confirmed on the page; >=40 chars; 1-2 digits only at original
    //     word-space gaps; <=2 insertions; strictly increasing; and each inserted number is itself a member of a chain of >=5
    //     consecutive integers (each <=40 tokens after the previous), i.e. the line-number evidence sits at the title.
    const lnDoi = '10.9999/synthetic.linenum';
    const lnTitle = 'Beta-blocker therapy and angina burden after myocardial infarction in synthetic cohorts';
    assert(normalize(lnTitle).length >= 40);
    const lnPdf = (pageTitle, trailing, withDoi = true) => fixtures.multiPage({pages:[{rawContent:'BT /F1 10 Tf 1 0 0 1 72 720 Tm ' + (withDoi ? '(doi:' + esc(lnDoi) + ') Tj ' : '') + '(' + esc(pageTitle) + ') Tj ' + trailing.map(n => '(' + n + ') Tj (margin text) Tj ').join('') + 'ET\n'}]});
    const oneLn = await identity(h, lnPdf('Beta-blocker therapy and angina 4 burden after myocardial infarction in synthetic cohorts', [5, 6, 7, 8]), lnDoi, lnTitle);
    assert.equal(oneLn.verdict, 'ok');
    assert.equal(oneLn.level, 'full');
    assert.equal(oneLn.checks.titleVariant, 'line_number_inserted');

    const twoLn = await identity(h, lnPdf('Beta-blocker therapy 2 and angina burden after 3 myocardial infarction in synthetic cohorts', [4, 5, 6]), lnDoi, lnTitle);
    assert.equal(twoLn.verdict, 'ok');
    assert.equal(twoLn.level, 'full');
    assert.equal(twoLn.checks.titleVariant, 'line_number_inserted');

    // Stray integers between the chain members (affiliation superscripts) do not break the chain.
    const strayLn = await identity(h, lnPdf('Beta-blocker therapy and angina 4 burden after myocardial infarction in synthetic cohorts', [1, 5, 1, 6, 2, 7, 8]), lnDoi, lnTitle);
    assert.equal(strayLn.verdict, 'ok');
    assert.equal(strayLn.checks.titleVariant, 'line_number_inserted');

    const lnCombo = await identity(
      h,
      lnPdf('Beta-blocker therapy vs 2 angina 2.0\u00962022 burden after 3 myocardial infarction in synthetic cohorts', [4, 5, 6]),
      lnDoi,
      '[Articles] Beta-blocker therapy versus angina 2.0 \u2013 2022 burden after myocardial infarction in synthetic cohorts'
    );
    assert.equal(lnCombo.verdict, 'ok');
    assert.equal(lnCombo.checks.titlePrefix, 'section_label_dropped');
    assert.equal(lnCombo.checks.titleVariant, 'line_number_inserted');

    // Negative cases: inside word, inside hyphenated word, 3 insertions, non-increasing, <40 chars, chain too short or not through
    // the inserted number, no evidence, /MCID-only numbers, extra word.
    const lnNegatives = [
      ['mid-word', lnPdf('Beta-blocker therapy and angina bur2den after myocardial infarction in synthetic cohorts', [3, 4, 5, 6]), lnTitle],
      ['mid-hyphen', lnPdf('Beta-2blocker therapy and angina burden after myocardial infarction in synthetic cohorts', [3, 4, 5, 6]), lnTitle],
      ['three-inserts', lnPdf('Beta-blocker therapy 2 and angina 3 burden after 4 myocardial infarction in synthetic cohorts', [5, 6, 7]), lnTitle],
      ['equal-inserts', lnPdf('Beta-blocker therapy 3 and angina burden after 3 myocardial infarction in synthetic cohorts', [4, 5, 6]), lnTitle],
      ['decreasing-inserts', lnPdf('Beta-blocker therapy 5 and angina burden after 2 myocardial infarction in synthetic cohorts', [3, 4, 5, 6]), lnTitle],
      ['short-title', lnPdf('Synthetic short 2 trial in cohorts', [3, 4, 5, 6]), 'Synthetic short trial in cohorts'],
      ['short-chain', lnPdf('Beta-blocker therapy and angina 2 burden after myocardial infarction in synthetic cohorts', [3, 4, 5]), lnTitle],
      ['chain-elsewhere', lnPdf('Beta-blocker therapy and angina 37 burden after myocardial infarction in synthetic cohorts', [1, 2, 3, 4, 5, 6, 7, 8]), lnTitle],
      ['no-evidence', fixtures.flateEol({doi:lnDoi, title:'Beta-blocker therapy and angina 2 burden after myocardial infarction in synthetic cohorts'}), lnTitle],
      ['extra-word', lnPdf('Beta-blocker therapy extra and angina burden after myocardial infarction in synthetic cohorts', [3, 4, 5, 6]), lnTitle]
    ];
    for (const [label, pdf, title] of lnNegatives) {
      const res = await identity(h, pdf, lnDoi, title);
      assert.equal(res.verdict, 'mismatch', label);
      assert.equal(res.reason, 'title_not_found', label);
    }
    const mcidOnlyPdf = fixtures.multiPage({pages:[{rawContent:'/P <</MCID 1 >>BDC BT /F1 10 Tf (doi:' + esc(lnDoi) + ') Tj ET EMC /P <</MCID 2 >>BDC BT (Beta-blocker therapy) Tj ET EMC /P <</MCID 3 >>BDC BT (and angina 4 burden) Tj ET EMC /P <</MCID 4 >>BDC BT (after myocardial infarction in synthetic cohorts) Tj ET EMC /P <</MCID 5 >>BDC BT (x) Tj ET EMC /P <</MCID 6 >>BDC BT (y) Tj ET EMC\n'}]});
    const mcidRes = await identity(h, mcidOnlyPdf, lnDoi, lnTitle);
    assert.equal(mcidRes.verdict, 'mismatch', 'mcid-only');
    assert.equal(mcidRes.reason, 'title_not_found', 'mcid-only');

    // Without the claimed DOI on the page the insertion rule never applies: a sequel ("SPRINT 2") must not pass as title_only or hold,
    // even with a perfect number chain around it.
    const seqTitle = 'Results of the SPRINT Trial on intensive blood pressure control in synthetic cohorts';
    const seqPageTitle = 'Results of the SPRINT 2 Trial on intensive blood pressure control in synthetic cohorts';
    const seqOptions = {allowTitleOnly:true, scanAllPages:true, holdForeignDoi:true};
    const seqNoDoi = await identity(h, lnPdf(seqPageTitle, [3, 4, 5, 6], false), lnDoi, seqTitle, seqOptions);
    assert.equal(seqNoDoi.verdict, 'mismatch', 'sequel without doi');
    assert(!('level' in seqNoDoi), 'sequel without doi must not get any level (title_only included)');
    const seqForeign = fixtures.multiPage({pages:[{rawContent:'BT /F1 10 Tf 1 0 0 1 72 720 Tm (doi:10.1000/other.paper) Tj (' + esc(seqPageTitle) + ') Tj (3) Tj (4) Tj (5) Tj (6) Tj ET\n'}]});
    const seqForeignRes = await identity(h, seqForeign, lnDoi, seqTitle, seqOptions);
    assert.equal(seqForeignRes.verdict, 'mismatch', 'sequel with foreign doi');
    // Even with the DOI confirmed, an extra number with no number chain through it is rejected.
    const seqNoChain = await identity(h, lnPdf(seqPageTitle, []), lnDoi, seqTitle, seqOptions);
    assert.equal(seqNoChain.verdict, 'mismatch', 'sequel without chain');

    // 9c) proof_marker_inserted: only when the claimed DOI is confirmed; page shows proof-stage evidence ("_proof" / "Journal Pre-proof");
    //     the shown text has a query list (>=3 distinct Q-numbers incl. the inserted ones); >=40 chars; q\d{1,2} only at original
    //     word-space gaps; <=2 insertions. q123 / mid-word / 3 inserts / <40 / x2 / no proof evidence / no query list all fail.
    const pmDoi = '10.9999/synthetic.proofmark';
    const pmTitle = 'Synthetic atrial fibrillation entrenchment revisited:Early timing of AF cohorts';
    assert(normalize(pmTitle).length >= 40);
    const pmPdf = (pageTitle, {doi = true, proof = true, queries = ['Q 1', 'Q 2', 'Q 12']} = {}) => fixtures.multiPage({pages:[{rawContent:'BT /F1 10 Tf 1 0 0 1 72 720 Tm ' + (doi ? '(doi:' + esc(pmDoi) + ') Tj ' : '') + queries.map(q => '(' + q + ') Tj ').join('') + (proof ? '(FLA 5.7.0 DTD HRTHM12284 _proof) Tj ' : '(FLA 5.7.0 DTD HRTHM12284) Tj ') + '(' + esc(pageTitle) + ') Tj ET\n'}]});
    for (const pageTitle of [
      'Synthetic atrial fibrillation entrenchment revisited: Early timing of AF Q2 cohorts',
      'Synthetic atrial fibrillation entrenchment revisited: Early timing of AF Q 2 cohorts',
      'Synthetic Q1 atrial fibrillation entrenchment revisited: Early timing of AF Q12 cohorts'
    ]) {
      const ok = await identity(h, pmPdf(pageTitle), pmDoi, pmTitle);
      assert.equal(ok.verdict, 'ok', pageTitle);
      assert.equal(ok.level, 'full', pageTitle);
      assert.equal(ok.checks.titleVariant, 'proof_marker_inserted', pageTitle);
    }
    const pmCombo = await identity(
      h,
      pmPdf('Synthetic atrial fibrillation vs 2.0\u00962022 entrenchment revisited: Early timing of AF Q2 cohorts'),
      pmDoi,
      '[Articles] Synthetic atrial fibrillation versus 2.0 \u2013 2022 entrenchment revisited:Early timing of AF cohorts'
    );
    assert.equal(pmCombo.verdict, 'ok');
    assert.equal(pmCombo.checks.titlePrefix, 'section_label_dropped');
    assert.equal(pmCombo.checks.titleVariant, 'proof_marker_inserted');

    const pmNegatives = [
      ['q123', pmPdf('Synthetic atrial fibrillation entrenchment revisited: Early timing of AF Q123 cohorts', {queries:['Q 1', 'Q 123']}), pmTitle],
      ['mid-word', pmPdf('Synthetic atrial fibrillation entrenchment revisited: Early timing of AF cohq2orts'), pmTitle],
      ['three-inserts', pmPdf('Synthetic Q1 atrial fibrillation Q2 entrenchment revisited: Early timing Q3 of AF cohorts', {queries:['Q 1', 'Q 2', 'Q 3']}), pmTitle],
      ['short-title', pmPdf('Synthetic atrial Q2 timing of cohorts'), 'Synthetic atrial timing of cohorts'],
      ['non-q-marker', pmPdf('Synthetic atrial fibrillation entrenchment revisited: Early timing of AF x2 cohorts'), pmTitle],
      ['no-proof-evidence', pmPdf('Synthetic atrial fibrillation entrenchment revisited: Early timing of AF Q2 cohorts', {proof:false}), pmTitle],
      ['no-query-list', pmPdf('Synthetic atrial fibrillation entrenchment revisited: Early timing of AF Q2 cohorts', {queries:[]}), pmTitle],
      ['short-query-list', pmPdf('Synthetic atrial fibrillation entrenchment revisited: Early timing of AF Q2 cohorts', {queries:['Q 1']}), pmTitle],
      ['no-doi', pmPdf('Synthetic atrial fibrillation entrenchment revisited: Early timing of AF Q2 cohorts', {doi:false}), pmTitle]
    ];
    for (const [label, pdf, title] of pmNegatives) {
      const res = await identity(h, pdf, pmDoi, title, {allowTitleOnly:true, scanAllPages:true, holdForeignDoi:true});
      assert.equal(res.verdict, 'mismatch', label);
      assert(!('level' in res), label);
    }
    // Coenzyme Q10 counter-example: the page title carries "Q10" the registered title lacks; without the DOI (or without a proof stage)
    // it must neither pass nor become title_only.
    const coTitle = 'Coenzyme supplementation and cardiovascular outcomes in synthetic heart failure cohorts';
    const coPage = 'Coenzyme Q10 supplementation and cardiovascular outcomes in synthetic heart failure cohorts';
    const coOptions = {allowTitleOnly:true, scanAllPages:true, holdForeignDoi:true};
    for (const [label, pdf] of [
      ['coq10 no doi', pmPdf(coPage, {doi:false, queries:['Q 10']})],
      ['coq10 doi no proof', pmPdf(coPage, {proof:false, queries:['Q 10']})],
      ['coq10 doi, proof, no query list', pmPdf(coPage, {queries:[]})],
    ]) {
      const res = await identity(h, pdf, pmDoi, coTitle, coOptions);
      assert.equal(res.verdict, 'mismatch', label);
      assert(!('level' in res), label);
    }

    // 9d) Normal-match and versus_or_mark precedence: exact matches never get titleVariant, even with line numbers or Q2 elsewhere on page.
    const exactRes = await identity(h, lnPdf(lnTitle + ' Q2 appendix', [1, 2, 3, 4, 5, 6]), lnDoi, lnTitle);
    assert.equal(exactRes.verdict, 'ok');
    assert.equal(exactRes.level, 'full');
    assert(!('titleVariant' in exactRes.checks));

    const vsRes = await identity(h, lnPdf('Beta-blocker therapy vs placebo after myocardial infarction in synthetic cohorts', [1, 2, 3, 4, 5, 6]), lnDoi, 'Beta-blocker therapy versus placebo after myocardial infarction in synthetic cohorts');
    assert.equal(vsRes.verdict, 'ok');
    assert.equal(vsRes.level, 'full');
    assert.equal(vsRes.checks.titleVariant, 'versus_or_mark');

    // 9e) title_only accepts only the exact (normal, section-label-stripped) title match: no variant fallback, so a page with no DOI at all
    //     cannot be passed by a loosened comparison.
    const toDoi = '10.9999/synthetic.titleonly';
    const toOptions = {allowTitleOnly:true, scanAllPages:true, holdForeignDoi:true};
    const toExact = await identity(h, fixtures.flateEol({doi:'', title:'Beta-blocker therapy versus placebo after myocardial infarction in synthetic cohorts'}), toDoi, 'Beta-blocker therapy versus placebo after myocardial infarction in synthetic cohorts', toOptions);
    assert.equal(toExact.verdict, 'ok');
    assert.equal(toExact.level, 'title_only');
    for (const [label, pageTitle, title] of [
      ['versus', 'Beta-blocker therapy vs placebo after myocardial infarction in synthetic cohorts', 'Beta-blocker therapy versus placebo after myocardial infarction in synthetic cohorts'],
      ['trademark', 'SyntheticValve Transcatheter Repair in Elderly Cohorts', 'SyntheticValve\u00ae Transcatheter Repair in Elderly Cohorts'],
      ['c1', 'CAD-SYNTH 2.0\u00962022 Synthetic Coronary Scoring in Multicenter Cohorts', 'CAD-SYNTH\u2122 2.0 \u2013 2022 Synthetic Coronary Scoring in Multicenter Cohorts']
    ]) {
      const res = await identity(h, fixtures.flateEol({doi:'', title:pageTitle}), toDoi, title, toOptions);
      assert.equal(res.verdict, 'mismatch', label);
      assert(!('level' in res), label);
    }
  }

  // t18 A/C/D: embedded Type 1C fonts with custom codes and glyph names, without ToUnicode.
  {
    const doi = '10.9999/synthetic.t18-layout';
    const title = 'Synthetic guidelines for ventricular rhythm in imaginary cohorts';
    const options = {allowTitleOnly:true, scanAllPages:true, holdForeignDoi:true};
    const showLines = (encode, lines) => lines.map((text, index) =>
      'BT /F2 10 Tf 1 0 0 1 36 ' + (750 - index * 16) + ' Tm ' + encode(text) + ' Tj ET\n').join('');
    const header = 'BT /F1 10 Tf 1 0 0 1 36 750 Tm ';
    const layout = (lines, printed = doi, cffOptions) => fixtures.type1cTextPages(encode => [[
      header + '(Synthetic co-publication notice for this imaginary journal) Tj 0 -14 Td '
        + '(doi:' + printed + ') Tj 0 -14 Td (doi:10.9999/synthetic.copublished) Tj ET\n'
        + 'BT /F2 14 Tf 1 0 0 1 36 680 Tm ' + encode(lines[0]) + ' Tj ET\n',
      'BT 1 0 0 1 36 660 Tm [' + encode(lines[1]) + '] ',
      'TJ ET\n'
    ]], cffOptions);
    const a = ['Synthetic guidelines for ventricular', 'rhythm in imaginary cohorts'];
    const resultA = await identity(h, layout(a), doi, title, options);
    assert.equal(resultA.level, 'full', 't18 A: custom CFF glyphs in Tj/TJ across Contents streams');
    assert.equal(resultA.checks.titleExtraction, 'text_operators');
    assert.equal((await identity(h, layout([a[0], 'rhythm in imaginary controls']), doi, title, options)).verdict, 'mismatch');
    assert.equal((await identity(h, layout(a, '10.9999/synthetic.foreign'), doi, title, options)).verdict, 'mismatch');
    assert.equal((await identity(h, layout(a, doi, {encodingFormat:1, charsetFormat:2, supplement:true}), doi, title, options)).level,
      'full', 'CFF range encoding and charset formats, with a supplementary code');
    assert.equal((await identity(h, layout(a, doi, {charsetFormat:1}), doi, title, options)).level, 'full', 'CFF format 1 charset');
    for (const [label, damage] of [
      ['truncated INDEX', cff => cff.subarray(0, cff.length - 1)],
      ['oversized INDEX count', cff => { cff.writeUInt16BE(65535, 4); return cff; }],
      ['oversized inflated font', cff => Buffer.concat([cff, Buffer.alloc(256 * 1024)])]
    ]) {
      const result = await identity(h, layout(a, doi, {damage}), doi, title, options);
      assert.equal(result.reason, 'title_not_found', label);
      assert(!result.checks.titleExtraction, label);
    }
    // A PDF encoding overrides the embedded encoding at the affected code.
    const override = glyphs => '/Encoding << /BaseEncoding /WinAnsiEncoding /Differences ['
      + [...glyphs.values()].map(glyph => glyph.code + ' /' + (glyph.name === 'S.fixture' ? glyphs.get('g').name : glyph.name)).join(' ') + '] >>';
    const changed = layout(a, doi, {encodingOverride:override});
    assert.equal((await identity(h, changed, doi, title, options)).verdict, 'mismatch', 'PDF Differences changes the glyph');
    assert.equal((await identity(h, changed, doi, 'g' + title.slice(1), options)).level, 'full', 'PDF Differences takes precedence');
    const simpleFont = run(h, 'machineFontWithoutUnicode');
    const decodeSimple = async encoding => (await simpleFont({}, '<< /Subtype /TrueType /BaseFont /SyntheticTrueType '
      + '/FontDescriptor << /Flags 32 >> /Encoding ' + encoding + ' >>', {})).map;
    const winAnsi = await decodeSimple('/WinAnsiEncoding');
    assert.equal(winAnsi.get(0x96), '\u2013', 'WinAnsi dash is a glyph, not C1 control');
    assert.equal(winAnsi.get(0xe9), 'é');
    const macRoman = await decodeSimple('/MacRomanEncoding');
    assert.equal(macRoman.get(0x8e), 'é');
    const differences = await decodeSimple('<< /BaseEncoding /MacRomanEncoding /Differences [142 /u1D400 /uni00660069] >>');
    assert.equal(differences.get(0x8e), '𝐀');
    assert.equal(differences.get(0x8f), 'fi');
    const parseCff = run(h, 'machineCffFont');
    const standardCff = parseCff(fixtures.cffFont([], 0, 0, 96));
    assert.equal(standardCff.encoding[65], 'A', 'predefined ISOAdobe charset and Standard encoding');
    for (const charset of [1, 2]) {
      const expertCff = parseCff(fixtures.cffFont([], charset, 1, 60));
      assert.equal(expertCff.encoding[87], 'fi', 'predefined Expert encoding and ligature charset');
      assert.equal(expertCff.encoding[0], '.notdef', 'unassigned Expert code');
    }

    const spotlight = 'Synthetic commands for pacing in an imaginary registry';
    const front = header + '(4207) Tj 0 -14 Td (CardioPulse) Tj 0 -14 Td (doi:' + doi + ') Tj '
      + '0 -14 Td (Global Spotlights) Tj 0 -14 Td (Synthetic authors and affiliations) Tj ET\n';
    const lateHeading = fixtures.type1cTextPages(encode => [[front + showLines(encode, [spotlight])]]);
    const resultC = await identity(h, lateHeading, doi, spotlight, options);
    assert.equal(resultC.level, 'full', 't18 C: late heading uses the embedded CFF encoding');
    assert.equal(resultC.checks.titleExtraction, 'text_operators');
    const inComment = fixtures.type1cTextPages(encode => [[front + '% ' + showLines(encode, [spotlight])]]);
    assert.equal((await identity(h, inComment, doi, spotlight, options)).verdict, 'mismatch', 'comment is not shown');
    const newsFront = header + '(Medical News in Brief) Tj 0 -14 Td (A Synthetic Sleep Report) Tj '
      + '0 -14 Td (doi:' + doi + ') Tj ET\n';
    const newsHeading = fixtures.type1cTextPages(encode => [[newsFront + showLines(encode, [spotlight])]]);
    assert.equal((await identity(h, newsHeading, doi, spotlight, options)).verdict, 'mismatch', 'news with unrelated DOI and late heading');

    const hex = '<' + Buffer.from(spotlight).toString('hex') + '>';
    const standardOnly = fixtures.standardTextPages([[front + header + hex + ' Tj ET\n']]);
    assert.equal((await identity(h, standardOnly, doi, spotlight, options)).reason, 'title_not_found', 'standard hex alone does not qualify');
    const cover = (encode, coverTitle = title, link = 'https://hdl.handle.net/1/synthetic') => showLines(encode, [
      'Utrecht University Repository', 'Title', coverTitle, 'Authors', 'Synthetic Author',
      'Published in', 'Synthetic Journal', 'Publication Date', '2024', 'Link', link, 'Citation', 'Synthetic citation'
    ]);
    const article = (encode, paperTitle = title, printed = doi) => showLines(encode, [paperTitle, 'doi:' + printed]);
    const covered = fixtures.type1cTextPages(encode => [[cover(encode)], [article(encode)]]);
    const resultD = await identity(h, covered, doi, title, options);
    assert.equal(resultD.level, 'full', 't18 D: both matches on physical page 2');
    assert.deepEqual({...resultD.checks}, {doi:'page', title:'page', readable:true, coverPage:'repository', doiPage:2});
    seedPaper(h, doi, title);
    const uploaded = await upload(h, covered, doi);
    assert.equal(uploaded.status, 202);
    const {task} = await uploaded.json();
    assert.equal(task.state, 'uploaded-awaiting-verification');
    assert.equal(task.identity, 'full');
    for (const [label, draw] of [
      ['wrong cover title', encode => [[cover(encode, title.replace('rhythm', 'pacing'))], [article(encode)]]],
      ['wrong article DOI', encode => [[cover(encode)], [article(encode, title, '10.9999/synthetic.foreign')]]],
      ['longer foreign DOI', encode => [[cover(encode)], [article(encode, title, doi + '.other')]]],
      ['wrong article title', encode => [[cover(encode)], [article(encode, title.replace('rhythm', 'pacing'))]]],
      ['title and DOI on different pages', encode => [[cover(encode)], [showLines(encode, [title])], [showLines(encode, ['doi:' + doi])]]],
      ['actual page 2 is blank', encode => [[cover(encode)], [], [article(encode)]]]
    ]) {
      const res = await identity(h, fixtures.type1cTextPages(draw), doi, title, options);
      assert.equal(res.verdict, 'mismatch', label);
      assert.equal(res.checks.coverPage, 'repository', label);
      assert(!res.hold, label);
    }
    const unrelatedPreface = fixtures.type1cTextPages(encode => [[cover(encode, title, 'https://example.org/elsewhere')], [article(encode)]]);
    const unrecognized = await identity(h, unrelatedPreface, doi, title, options);
    assert.equal(unrecognized.verdict, 'mismatch');
    assert(!('coverPage' in unrecognized.checks));
  }

  // t18 B: allow the narrow Crossref differences only with the claimed DOI.
  {
    const doi = '10.9999/synthetic.t18-consensus', other = '10.9999/synthetic.foreign';
    const options = {allowTitleOnly:true, scanAllPages:true, holdForeignDoi:true};
    const title = 'European Rhythm Association/Pacific Rhythm Society consensus on atrial fibrillation in synthetic cohorts';
    const abbreviated = title.replace('Association', 'Association (ERA)').replace('Society', 'Society (PRS)').replace('fibrillation', '\ufb01brillation');
    for (const printed of [doi, '', other]) {
      const cff = fixtures.type1cTextPages(encode => [[
        'BT /F1 10 Tf 1 0 0 1 36 750 Tm (doi:' + printed + ') Tj /F2 10 Tf 0 -30 Td ' + encode(abbreviated) + ' Tj ET\n'
      ]]);
      const result = await identity(h, cff, doi, '2024 ' + title, options);
      assert.equal(result.verdict, printed === doi ? 'ok' : 'mismatch');
      if (printed === doi) assert.equal(result.checks.titleVariant, 'year_prefix_dropped+acronym_inserted');
    }
    const pdf = (printed, value = doi, infoTitle = '') => fixtures.customEncoding({doi:value, title:printed, infoTitle});
    for (const [registered, printed, expected] of [
      ['2024 ' + title, title, 'year_prefix_dropped'],
      [title, abbreviated, 'acronym_inserted'],
      ['2024 ' + title, abbreviated, 'year_prefix_dropped+acronym_inserted']
    ]) {
      const result = await identity(h, pdf(printed), doi, registered, options);
      assert.equal(result.level, 'full', expected);
      assert.equal(result.checks.titleVariant, expected);
    }
    const meta = await identity(h, pdf(abbreviated, '', 'DOI ' + doi), doi, '2024 ' + title, options);
    assert.equal(meta.level, 'metadata_doi');
    assert.equal(meta.checks.titleVariant, 'year_prefix_dropped+acronym_inserted');
    const xmp = fixtures.customEncoding({doi:'', title:abbreviated, xmpTitle:'DOI ' + doi});
    assert.equal((await identity(h, xmp, doi, title, options)).level, 'metadata_doi');
    const newsVariant = fixtures.multiPage({pages:[{literal:'Medical News in Brief DOI ' + doi, unicode:abbreviated}]});
    assert.equal((await identity(h, newsVariant, doi, title, options)).verdict, 'mismatch', 'news must not use catalogue variants');
    for (const [label, printed, registered, printedDoi, metadata] of [
      ['year omitted and a word changed', title.replace('atrial', 'ventricular'), '2024 ' + title],
      ['different year', '2023 ' + abbreviated, '2024 ' + title],
      ['too many letters', abbreviated.replace('ERA', 'TOOLONGXY'), title],
      ['lowercase acronym', abbreviated.replace('ERA', 'Era'), title],
      ['acronym outside parentheses', abbreviated.replace('(ERA)', '[ERA]'), title],
      ['acronyms without claimed DOI', abbreviated, title, ''],
      ['acronyms with foreign DOI', abbreviated, title, other],
      ['acronyms with longer foreign DOI', abbreviated, title, doi + '.other'],
      ['different word with metadata DOI', abbreviated.replace('atrial', 'ventricular'), title, '', doi]
    ]) {
      const result = await identity(h, pdf(printed, printedDoi, metadata), doi, registered, options);
      assert.equal(result.verdict, 'mismatch', label);
      assert(!('titleVariant' in result.checks), label);
      assert(!result.hold, label);
    }
    for (const printedDoi of [other, doi]) {
      const news = fixtures.multiPage({pages:['Medical News in Brief. Synthetic Sleep Supports Recovery. doi:' + printedDoi
        + ' A synthetic item on nutrition. Another report on blood pressure.']});
      const resultE = await identity(h, news, doi, 'Synthetic Testosterone Trial and Cardiovascular Events', options);
      assert.equal(resultE.verdict, 'mismatch', 't18 E: the registered item is absent');
      assert.equal(resultE.reason, printedDoi === doi ? 'title_not_found' : 'identity_mismatch');
    }
  }
  console.log('Machine identity: tolerant inflate, object streams, ToUnicode, metadata fallback, reason codes, guarded replace and claim reason passed');
  console.log('t18: Type 1C encodings, bounded malformed fonts, DOI-gated variants and repository page 2 passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
