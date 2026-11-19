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
  seedPaper(h, custom.doi + '.b', custom.title);
  const weakDoi = custom.doi + '.b';
  assert.equal((await upload(h, files['custom-encoding-tounicode.pdf'], weakDoi)).status, 409);
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

  // 7) Upload endpoint: 202 with identity 'title_only' when page 1 has no DOI; 409 machine_identity_mismatch when page 1 prints another DOI.
  {
    seedPaper(h, noDoi, noDoiTitle);
    const upOk = await upload(h, noDoiPdf, noDoi);
    assert.equal(upOk.status, 202);
    const upBody = await upOk.json();
    assert.equal(upBody.task.identity, 'title_only');
    assert.equal(stored(h, 'library:muse-job:' + noDoi).identityLevel, 'title_only');

    seedPaper(h, '10.1056/nejmp2606894', 'What the Robot Still Can\u2019t Do');
    await error(await upload(h, nejmPdf, '10.1056/NEJMp2606894'), 409, 'machine_identity_mismatch');
  }

  console.log('Machine identity: tolerant inflate, object streams, ToUnicode, metadata fallback, reason codes, guarded replace and claim reason passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
