// ==== edge/src/04a-machine-pdf.js · First-page identity check for machine uploads ====
// A deliberately small PDF reader that only needs Workers APIs (DecompressionStream, TextDecoder, crypto.subtle).
// It is a gate in front of the independent GitHub dual-parser verification, never a replacement for it.
// Every way it can fail to read a page leaves a short internal reason code (no PDF content) so a 409
// says why: encrypted_pdf, encryption_unsupported, inflate_failed, objstm_unsupported, page_tree_not_found,
// contents_not_found, filter_unsupported, page_text_empty, doi_not_found, title_not_found, identity_mismatch, title_too_short.
// Encryption: only the Standard security handler with an empty user password (publisher "permissions only" files that
// any viewer opens without asking) is decrypted: RC4 (V1/V2, R2/R3), AESV2 (V4, R4) and AESV3 (V5, R5/R6). A file that
// needs a password to open is encrypted_pdf; any other handler, method or a key that does not verify is
// encryption_unsupported. RC4 is plain JS (no Web Crypto RC4); MD5, SHA-2 and AES use crypto.subtle.
const MACHINE_INFLATE_MAX = 16 * 1024 * 1024;
const MACHINE_MAX_PAGES = 200;
const MACHINE_SCAN_INFLATE_BUDGET = 64 * 1024 * 1024;
// Reference or listing pages cite >= 2 other DOIs alongside the claimed DOI; genuine headers/footers carry at most 1.
const MACHINE_LATER_PAGE_MAX_OTHER_DOIS = 1;
const MACHINE_READABLE_MIN_LETTERS = 20;
const MACHINE_READABLE_MIN_RATIO = 0.5;
const MACHINE_ENCRYPTION_REASONS = ['encrypted_pdf', 'encryption_unsupported'];
const MACHINE_PDF_PADDING = new Uint8Array([0x28,0xbf,0x4e,0x5e,0x4e,0x75,0x8a,0x41,0x64,0x00,0x4e,0x56,0xff,0xfa,0x01,0x08,0x2e,0x2e,0x00,0xb6,0xd0,0x68,0x3e,0x80,0x2f,0x0c,0xa9,0xfe,0x64,0x53,0x69,0x7a]);
// Punctuation normalization: non-ASCII dashes/hyphens (Wiley/JAHA/Crossref register U+2010 "\u2010" while first pages read an
// ASCII hyphen; Japanese journals print "Title\u3000\u2015 Subtitle \u2015" for RSS "Title: Subtitle") and curly quotes /
// apostrophes (publisher pages use "\u2019" where catalogues store "'") are dropped like ASCII punctuation. Both sides pass
// through the same function, so only punctuation is stripped and letters/digits must still match verbatim.
const MACHINE_NORMALIZE_PUNCT = new Set([
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2043, 0x2212, 0x2E3A, 0x2E3B, 0xFE58, 0xFE63, 0xFF0D,
  0x2018, 0x2019, 0x201A, 0x201B, 0x201C, 0x201D, 0x201E, 0x201F,
  0x2032, 0x2033, 0x2034, 0x2035, 0x2036, 0x2037,
  0x02BC, 0x00AB, 0x00BB
]);
const MACHINE_IDENTITY_SECTION_LABEL = /^\s*\[[A-Za-z][A-Za-z ./-]{0,39}\]\s*/;
// Crossref titles keep JATS/HTML inline markup ("<i>CYP2C19</i>", "P2Y<sub>12</sub>"); the page prints only the text inside.
const MACHINE_TITLE_MARKUP = /<\/?(?:i|b|em|strong|sub|sup|sc|scp|u|italic|bold)\b[^<>]{0,80}>/gi;
const MACHINE_TITLE_MARKS = /[\u2122\u00ae]/g;
const MACHINE_TITLE_VERSUS = /(?<![\p{L}\p{N}])(?:versus|vs\.?|v\.)(?![\p{L}\p{N}])/giu;
const MACHINE_TITLE_C1_CONTROLS = /[\u0080-\u009f]/g;
const MACHINE_VARIANT_INSERT_MIN_LEN = 40;
const MACHINE_VARIANT_MAX_INSERTS = 2;
// Line-number evidence for accepted manuscripts: a chain of >= 5 consecutive positive integers (1..999) as standalone whitespace
// tokens (ignoring PDF marked-content /MCID ids), each at most 40 tokens after the previous. The text extractor keeps no coordinates, so "left margin"
// cannot be tested; instead the inserted number must itself be a member of such a run (see machineLineNumberMembers).
const MACHINE_LINE_NUMBER_MIN_RUN = 5;
const MACHINE_LINE_NUMBER_MAX_GAP = 40;
const MACHINE_PROOF_MIN_QUERIES = 3;
function machineNormalize(value) {
  const stripped = String(value || '').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '');
  let out = '';
  for (const char of stripped) {
    const code = char.codePointAt(0);
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code > 127 && !MACHINE_NORMALIZE_PUNCT.has(code))) out += char;
  }
  return out;
}
// Fallback spelling variants: Heart Rhythm stores "Versus" where page 1 prints "vs"; JACC Imaging stores "CAD-RADS™" where page 1
// has no ™ (NFKD would turn it into the letters "tm"). Both sides go through this function: whole-word versus/vs/vs./v. become
// "vs" and the two trademark signs are dropped; nothing else changes.
function machineTitleVariant(value) {
  return machineNormalize(String(value || '').replace(MACHINE_TITLE_MARKS, '').replace(MACHINE_TITLE_VERSUS, ' vs '));
}
// WinAnsi byte 0x96 (en dash) that some PDFs leave undecoded shows up as U+0096; C1 controls never occur in real titles.
function machineTitleVariantNoC1(value) {
  return machineTitleVariant(value).replace(MACHINE_TITLE_C1_CONTROLS, '');
}
// Token indexes (in page.text.split(/\s+/)) that belong to a chain of >= 5 integers counting up by one, each at most 40 tokens after
// the previous one. Other integers in between (affiliation superscripts, page sizes) are skipped. The inserted line number of a title
// must be one of these tokens, so the evidence sits at the title rather than anywhere on the page.
function machineLineNumberMembers(tokens) {
  const ints = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!/^[1-9]\d{0,2}$/.test(tokens[i])) continue;
    if (i > 0 && /\/MCID$/.test(tokens[i - 1])) continue;
    ints.push({index:i, value:Number(tokens[i])});
  }
  const members = new Set();
  for (let start = 0; start < ints.length; start++) {
    const chain = [start];
    let last = ints[start];
    for (let j = start + 1; j < ints.length && ints[j].index - last.index <= MACHINE_LINE_NUMBER_MAX_GAP; j++) {
      if (ints[j].value !== last.value + 1) continue;
      chain.push(j);
      last = ints[j];
    }
    if (chain.length >= MACHINE_LINE_NUMBER_MIN_RUN) for (const k of chain) members.add(ints[k].index);
  }
  return members;
}
// Normalizes page text token by token so a position in the normalized string maps back to its token.
function machineTokenizedPage(text) {
  const tokens = String(text || '').split(/\s+/);
  const spans = [];
  let norm = '';
  for (const token of tokens) {
    const piece = machineTitleVariantNoC1(token);
    spans.push({start:norm.length, end:norm.length + piece.length, piece});
    norm += piece;
  }
  return {tokens, spans, norm};
}
function machineMatchWordsWithInsertions(pageText, words, markerLengths, isMarker, validateMarkers) {
  if (words.length < 2) return false;
  const suffixes = new Array(words.length + 1);
  suffixes[words.length] = '';
  for (let k = words.length - 1; k >= 0; k--) suffixes[k] = words[k] + suffixes[k + 1];
  if (suffixes[0].length < MACHINE_VARIANT_INSERT_MIN_LEN) return false;
  const maxMarkerLen = markerLengths[markerLengths.length - 1];
  const anchors = [];
  if (words.length === 2) {
    const pick = words[0].length >= words[1].length ? 0 : 1;
    anchors.push({text:words[pick], prefixLen:pick ? words[0].length : 0, maxShift:pick ? maxMarkerLen : 0});
  } else {
    const total = suffixes[0].length;
    let a = 1, lenA = words[0].length;
    while (a + 2 < words.length && lenA < total / 3) { lenA += words[a].length; a++; }
    let b = a + 1, lenB = words[a].length;
    while (b + 1 < words.length && lenA + lenB < (total * 2) / 3) { lenB += words[b].length; b++; }
    // Partitioning words into 3 contiguous slices guarantees at least one slice contains no gap insertions (at most 2 total).
    anchors.push(
      {text:words.slice(0, a).join(''), prefixLen:0, maxShift:0},
      {text:words.slice(a, b).join(''), prefixLen:lenA, maxShift:Math.min(a, MACHINE_VARIANT_MAX_INSERTS) * maxMarkerLen},
      {text:words.slice(b).join(''), prefixLen:lenA + lenB, maxShift:Math.min(b, MACHINE_VARIANT_MAX_INSERTS) * maxMarkerLen}
    );
    anchors.sort((x, y) => y.text.length - x.text.length);
  }
  const seenStarts = new Set();
  const matchAtStart = start => {
    if (start < 0 || seenStarts.has(start)) return false;
    seenStarts.add(start);
    let pos0 = start;
    for (let i = 0; i < words.length - 1; i++) {
      if (!pageText.startsWith(words[i], pos0)) return false;
      pos0 += words[i].length;
      for (const len1 of markerLengths) {
        const m1 = pageText.slice(pos0, pos0 + len1);
        if (m1.length !== len1 || !isMarker(m1)) continue;
        const pos1 = pos0 + len1;
        if (pageText.startsWith(suffixes[i + 1], pos1) && validateMarkers([{text:m1, at:pos0}])) return true;
        let pos2 = pos1;
        for (let j = i + 1; j < words.length - 1; j++) {
          if (!pageText.startsWith(words[j], pos2)) break;
          pos2 += words[j].length;
          for (const len2 of markerLengths) {
            const m2 = pageText.slice(pos2, pos2 + len2);
            if (m2.length !== len2 || !isMarker(m2)) continue;
            if (validateMarkers([{text:m1, at:pos0}, {text:m2, at:pos2}]) && pageText.startsWith(suffixes[j + 1], pos2 + len2)) return true;
          }
        }
      }
    }
    return false;
  };
  for (const anchor of anchors) {
    let from = 0;
    while (from <= pageText.length - anchor.text.length) {
      const at = pageText.indexOf(anchor.text, from);
      if (at < 0) break;
      for (let shift = 0; shift <= anchor.maxShift; shift++) {
        if (matchAtStart(at - anchor.prefixLen - shift)) return true;
      }
      from = at + 1;
    }
  }
  return false;
}
function machineLatin1(bytes) {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  }
  return out;
}
function machineBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 255;
  return bytes;
}
function machineConcat(...parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function machineBytesEqual(a, b, length = Math.min(a.length, b.length)) {
  if (a.length < length || b.length < length) return false;
  let diff = 0;
  for (let i = 0; i < length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
// MD5 through Web Crypto: Workers support it in crypto.subtle.digest as a non-standard algorithm for legacy formats
// (https://developers.cloudflare.com/workers/runtime-apis/web-crypto/, footnote 3). Here it only derives PDF keys.
async function machineMd5(data) {
  return new Uint8Array(await crypto.subtle.digest('MD5', data));
}
function machineRc4(key, data) {
  const s = new Uint8Array(256), out = new Uint8Array(data.length);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
async function machineSha(alg, data) {
  return new Uint8Array(await crypto.subtle.digest(alg, data));
}
async function machineAesCbcDecrypt(keyOrRaw, data, raw = false) {
  if (data.length < 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16), ct = data.subarray(16);
  if (!ct.length) return new Uint8Array(0);
  if (ct.length % 16 !== 0) return null;
  try {
    const key = keyOrRaw instanceof Uint8Array ? await crypto.subtle.importKey('raw', keyOrRaw, {name:'AES-CBC'}, false, raw ? ['encrypt', 'decrypt'] : ['decrypt']) : keyOrRaw;
    if (!raw) return new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC', iv}, key, ct));
    const last = ct.subarray(ct.length - 16);
    const pad = new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC', iv:last}, key, new Uint8Array(0)));
    const plain = new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC', iv}, key, machineConcat(ct, pad)));
    return plain.subarray(0, ct.length);
  } catch { return null; }
}
// ISO 32000-2 Algorithm 2.B key derivation for R=6 with empty user password.
async function machineAlg2b(salt) {
  const algs = ['SHA-256', 'SHA-384', 'SHA-512'];
  let k = await machineSha('SHA-256', salt), lastByte = 0;
  for (let round = 0; round < 64 || lastByte > round - 32; round++) {
    const k1 = new Uint8Array(k.length * 64);
    for (let n = 0; n < 64; n++) k1.set(k, n * k.length);
    const key = await crypto.subtle.importKey('raw', k.subarray(0, 16), {name:'AES-CBC'}, false, ['encrypt']);
    const eFull = new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC', iv:k.subarray(16, 32)}, key, k1));
    const e = eFull.subarray(0, k1.length);
    let mod3 = 0;
    for (let i = 0; i < 16; i++) mod3 = (mod3 + e[i]) % 3;
    lastByte = e[e.length - 1];
    k = await machineSha(algs[mod3], e);
  }
  return k.subarray(0, 32);
}
// Text of every literal string in a decoded content stream (escape handling is intentionally lossy).
function machinePdfStrings(content) {
  let out = '';
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '(') continue;
    let text = '', depth = 1;
    for (index++; index < content.length && depth; index++) {
      const char = content[index];
      if (char === '\\') { text += content[index + 1] || ''; index++; continue; }
      if (char === '(') { depth++; text += '('; continue; }
      if (char === ')') { depth--; if (depth) text += ')'; continue; }
      text += char;
    }
    index--;
    out += text + '\n';
  }
  return out;
}
// Inflate and keep whatever was produced before an error. Bytes after the end of the zlib stream (an EOL before
// "endstream", padding) make DecompressionStream throw after all output was delivered; that is tolerated.
async function machineInflateOnce(bytes, limit) {
  const chunks = [];
  let size = 0, error = '';
  try {
    const stream = new DecompressionStream('deflate');
    const writer = stream.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = stream.readable.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) { pdfCancel(reader); return {bytes:new Uint8Array(0), error:'too_large'}; }
      chunks.push(item.value);
    }
  } catch (caught) { error = String(caught && (caught.code || caught.name) || 'inflate_error'); }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk.subarray(0, Math.max(0, out.length - offset)), offset); offset += chunk.byteLength; }
  return {bytes:out, error};
}
async function machineInflate(raw, notes, strictLimit) {
  if (typeof DecompressionStream !== 'function') { notes.add('inflate_failed'); return null; }
  const first = await machineInflateOnce(raw, strictLimit ?? MACHINE_INFLATE_MAX);
  if (!first.error) return first.bytes;
  if (strictLimit === undefined && first.error !== 'too_large' && first.bytes.length) { notes.add('inflate_tolerated'); return first.bytes; }
  notes.add('inflate_failed');
  return null;
}
function machinePngPredictor(data, columns, colors, bits) {
  const row = Math.ceil(columns * colors * bits / 8), bpp = Math.max(1, Math.ceil(colors * bits / 8));
  const step = row + 1, rows = Math.floor(data.length / step), out = new Uint8Array(rows * row);
  for (let r = 0; r < rows; r++) {
    const type = data[r * step], src = r * step + 1, dst = r * row;
    for (let i = 0; i < row; i++) {
      const left = i >= bpp ? out[dst + i - bpp] : 0, up = r ? out[dst - row + i] : 0, upLeft = r && i >= bpp ? out[dst - row + i - bpp] : 0;
      let value = data[src + i];
      if (type === 1) value += left;
      else if (type === 2) value += up;
      else if (type === 3) value += (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[dst + i] = value & 255;
    }
  }
  return out;
}
// Tolerant object scan (the way pdf.js repairs a damaged xref): the last "N G obj" wins, objects inside /ObjStm are
// found when an id is missing at top level. Root comes from the last trailer or xref-stream dictionary.
function machinePdfContext(bytes) {
  const text = machineLatin1(bytes), index = new Map(), gens = new Map(), pattern = /(?<![0-9])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let match;
  while ((match = pattern.exec(text))) {
    const id = Number(match[1]);
    index.set(id, match.index + match[0].length);
    gens.set(id, Number(match[2]));
  }
  return {text, index, gens, packed:null, enc:undefined, cache:new Map(), notes:new Set()};
}
function machineTopBody(ctx, id) {
  const start = ctx.index.get(Number(id));
  if (start === undefined) return null;
  const end = ctx.text.indexOf('endobj', start);
  return ctx.text.slice(start, end < 0 ? ctx.text.length : end);
}
function machineDictValue(text, key) {
  const match = new RegExp('/' + key + '(?![A-Za-z0-9_])\\s*<<').exec(text);
  if (!match) return '';
  const start = match.index + match[0].length - 2;
  let depth = 0;
  for (let at = start; at < text.length - 1; at++) {
    if (text[at] === '<' && text[at + 1] === '<') { depth++; at++; }
    else if (text[at] === '>' && text[at + 1] === '>') { depth--; at++; if (!depth) return text.slice(start + 2, at - 1); }
  }
  return '';
}
function machineRefValue(text, key) {
  const match = new RegExp('/' + key + '(?![A-Za-z0-9_])\\s+(\\d+)\\s+\\d+\\s+R').exec(text);
  return match ? match[1] : '';
}
function machineIntValue(text, key) {
  const match = new RegExp('/' + key + '(?![A-Za-z0-9_])\\s+(\\d+)(?!\\s+\\d+\\s+R)').exec(text);
  return match ? Number(match[1]) : null;
}
function machineRefList(text) { return [...text.matchAll(/(\d+)\s+\d+\s+R/g)].map(match => match[1]); }
// Support Standard Security Handler (R=2..6) with empty user password (permission-encrypted PDFs).
// Trailer dictionaries and cross-reference stream dictionaries only (where /Encrypt and /ID live), so that bytes inside
// an uncompressed stream of an unencrypted file are never taken for an encryption entry.
function machineTrailerText(ctx) {
  let out = '';
  for (const match of ctx.text.matchAll(/(?<![A-Za-z])trailer\b/g)) {
    const end = ctx.text.indexOf('startxref', match.index);
    out += ctx.text.slice(match.index, end < 0 ? Math.min(ctx.text.length, match.index + 4096) : end) + '\n';
  }
  for (const [id] of ctx.index) {
    const body = machineTopBody(ctx, id), streamAt = body.indexOf('stream');
    if (streamAt >= 0 && /\/Type\s*\/XRef\b/.test(body.slice(0, streamAt))) out += body.slice(0, streamAt) + '\n';
  }
  return out;
}
async function machineEncryption(ctx) {
  if (ctx.enc !== undefined) return ctx.enc;
  ctx.enc = null;
  const reject = reason => { ctx.notes.add(reason); return (ctx.enc = {unsupported:true, reason}); };
  try { return await machineEncryptionSetup(ctx, reject); } catch { return reject('encryption_unsupported'); }
}
// Standard security handler, empty user password: the file key (ISO 32000-2 Algorithms 2, 2.A, 2.B) checked against /U.
async function machineEncryptionSetup(ctx, reject) {
  // The encryption dictionary is an indirect object (usual) or written inline in the trailer; never inside an /ObjStm.
  const trailer = machineTrailerText(ctx);
  const encs = [...trailer.matchAll(/\/Encrypt\s+(\d+)\s+\d+\s+R/g)], inline = /\/Encrypt\s*<</.test(trailer);
  if (!encs.length && !inline) return null;
  const dict = encs.length ? machineTopBody(ctx, encs[encs.length - 1][1]) : machineDictValue(trailer.slice(trailer.lastIndexOf('/Encrypt')), 'Encrypt');
  if (!dict) return reject('encryption_unsupported');
  const cf = machineDictValue(dict, 'CF'), topDict = cf ? dict.replace(cf, '') : dict;
  const filter = /\/Filter\s*\/([A-Za-z0-9_.-]+)/.exec(topDict);
  if (!filter || filter[1] !== 'Standard') return reject('encryption_unsupported');
  const v = machineIntValue(topDict, 'V'), r = machineIntValue(topDict, 'R');
  const pMatch = /\/P(?![A-Za-z0-9_])\s+(-?\d+)/.exec(topDict), p = pMatch ? Number(pMatch[1]) : 0;
  const o = machinePdfStringBytes(topDict, 'O'), u = machinePdfStringBytes(topDict, 'U');
  const meta = !/\/EncryptMetadata\s+false\b/.test(topDict);
  const ids = [...trailer.matchAll(/\/ID\s*\[\s*([(<])/g)];
  const id0 = ids.length ? machinePdfTokenBytes(trailer, ids[ids.length - 1].index + ids[ids.length - 1][0].length, ids[ids.length - 1][1]) : new Uint8Array(0);
  // fail(): the file is encrypted in a way this reader does not do. locked(): the empty user password does not open
  // it, so it needs a password (never guessed).
  const fail = () => reject('encryption_unsupported'), locked = () => reject('encrypted_pdf');
  if (!o || !u) return fail();
  if (v === 5 && (r === 5 || r === 6)) {
    const ue = machinePdfStringBytes(topDict, 'UE');
    if (u.length < 48 || !ue || ue.length < 32 || typeof crypto?.subtle?.decrypt !== 'function') return fail();
    let fileKey = null;
    if (r === 5) {
      if (!machineBytesEqual(await machineSha('SHA-256', u.subarray(32, 40)), u, 32)) return locked();
      fileKey = await machineAesCbcDecrypt(await machineSha('SHA-256', u.subarray(40, 48)), machineConcat(new Uint8Array(16), ue.subarray(0, 32)), true);
    } else {
      if (!machineBytesEqual(await machineAlg2b(u.subarray(32, 40)), u, 32)) return locked();
      fileKey = await machineAesCbcDecrypt(await machineAlg2b(u.subarray(40, 48)), machineConcat(new Uint8Array(16), ue.subarray(0, 32)), true);
    }
    if (!fileKey || fileKey.length !== 32) return fail();
    const cfm = name => {
      if (name === 'Identity') return null;
      const entry = name && cf ? machineDictValue(cf, name) : '';
      const m = /\/CFM\s*\/([A-Za-z0-9]+)/.exec(entry);
      return !m || m[1] === 'AESV3' ? 'AESV3' : m[1] === 'None' ? null : 'unsupported';
    };
    const stm = cfm((/\/StmF\s*\/([A-Za-z0-9_.-]+)/.exec(topDict) || [])[1] || 'StdCF');
    const str = cfm((/\/StrF\s*\/([A-Za-z0-9_.-]+)/.exec(topDict) || [])[1] || 'StdCF');
    if (stm === 'unsupported' || str === 'unsupported') return fail();
    const aesKey = await crypto.subtle.importKey('raw', fileKey, {name:'AES-CBC'}, false, ['decrypt']);
    return (ctx.enc = {v, r, fileKey, aesKey, stm, str, meta});
  }
  if (![1, 2, 4].includes(v) || ![2, 3, 4].includes(r)) return fail();
  let stm = 'RC4', str = 'RC4', cfLen = 0;
  if (v === 4) {
    const resolveCf = name => {
      if (!name || name === 'Identity') return null;
      const entry = machineDictValue(cf, name), m = /\/CFM\s*\/([A-Za-z0-9]+)/.exec(entry);
      const len = machineIntValue(entry, 'Length');
      if (len) cfLen = Math.max(cfLen, len);
      if (!m || m[1] === 'None') return null;
      if (m[1] === 'V2') return 'RC4';
      if (m[1] === 'AESV2') return 'AESV2';
      return 'unsupported';
    };
    stm = resolveCf((/\/StmF\s*\/([A-Za-z0-9_.-]+)/.exec(topDict) || [])[1] || 'Identity');
    str = resolveCf((/\/StrF\s*\/([A-Za-z0-9_.-]+)/.exec(topDict) || [])[1] || 'Identity');
    if (stm === 'unsupported' || str === 'unsupported') return fail();
  }
  const rawLen = machineIntValue(topDict, 'Length') || (cfLen ? (cfLen <= 32 ? cfLen * 8 : cfLen) : (v === 4 ? 128 : 40));
  const keyLen = v === 1 ? 5 : Math.min(16, Math.max(5, rawLen >> 3));
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, p | 0, true);
  const seed = machineConcat(MACHINE_PDF_PADDING, o.subarray(0, 32), pBytes, id0, r >= 4 && !meta ? new Uint8Array([255,255,255,255]) : new Uint8Array(0));
  let hash = await machineMd5(seed);
  if (r >= 3) for (let i = 0; i < 50; i++) hash = await machineMd5(hash.subarray(0, keyLen));
  const fileKey = hash.subarray(0, keyLen);
  let valid = false;
  if (r === 2) valid = machineBytesEqual(machineRc4(fileKey, MACHINE_PDF_PADDING), u, 32);
  else {
    let test = await machineMd5(machineConcat(MACHINE_PDF_PADDING, id0));
    const roundKey = new Uint8Array(keyLen);
    for (let i = 0; i < 20; i++) {
      for (let k = 0; k < keyLen; k++) roundKey[k] = fileKey[k] ^ i;
      test = machineRc4(roundKey, test);
    }
    valid = machineBytesEqual(test, u, 16);
  }
  if (!valid) return locked();
  return (ctx.enc = {v, r, keyLen, fileKey, stm, str, meta});
}
async function machineDecryptData(ctx, enc, id, data, method) {
  if (!enc || enc.unsupported || !method || !data.length) return data;
  try { return await machineDecryptObject(ctx, enc, id, data, method); } catch { return null; }
}
async function machineDecryptObject(ctx, enc, id, data, method) {
  if (method === 'AESV3') return await machineAesCbcDecrypt(enc.aesKey, data);
  const gen = ctx.gens.get(id) || 0;
  const suffix = new Uint8Array(method === 'AESV2' ? 9 : 5);
  suffix[0] = id & 255; suffix[1] = (id >> 8) & 255; suffix[2] = (id >> 16) & 255;
  suffix[3] = gen & 255; suffix[4] = (gen >> 8) & 255;
  if (method === 'AESV2') suffix.set([0x73, 0x41, 0x6c, 0x54], 5);
  const objKey = (await machineMd5(machineConcat(enc.fileKey, suffix))).subarray(0, Math.min(enc.keyLen + 5, 16));
  if (method === 'RC4') return machineRc4(objKey, data);
  if (method === 'AESV2') {
    if (typeof crypto?.subtle?.decrypt !== 'function') return null;
    return await machineAesCbcDecrypt(objKey, data);
  }
  return null;
}
async function machineStreamParts(ctx, body, requireEnd = false) {
  const marker = /(?<!end)stream(?:\r\n|\n|\r)/.exec(body);
  if (!marker) return null;
  const dict = body.slice(0, marker.index), start = marker.index + marker[0].length;
  if (requireEnd && /\bendobj\b/.test(dict)) return null;
  let length = machineIntValue(dict, 'Length');
  if (length === null) {
    const ref = machineRefValue(dict, 'Length'), lengthBody = ref && machineTopBody(ctx, ref);
    const parsed = lengthBody && /^\s*(\d+)\s*$/.exec(lengthBody.replace(/^[\s\S]*?obj/, ''));
    length = parsed ? Number(parsed[1]) : null;
  }
  let end = -1;
  // Honour /Length when "endstream" really follows it; otherwise stop at endstream and drop one EOL.
  if (length !== null && start + length <= body.length && /^(?:\r\n|\n|\r| )*endstream/.test(body.slice(start + length, start + length + 12))) end = start + length;
  if (end < 0) {
    end = body.indexOf('endstream', start);
    if (requireEnd && end < 0) return null;
    if (end < 0) end = body.length;
    if (body.startsWith('\r\n', end - 2)) end -= 2;
    else if (body[end - 1] === '\n' || body[end - 1] === '\r') end -= 1;
  }
  return {dict, raw:body.slice(start, end)};
}
function machineFilters(dict) {
  const array = /\/Filter\s*\[([^\]]*)\]/.exec(dict), single = /\/Filter\s*\/([A-Za-z0-9]+)/.exec(dict);
  return array ? [...array[1].matchAll(/\/([A-Za-z0-9]+)/g)].map(match => match[1]) : single ? [single[1]] : [];
}
// Decoded bytes of a stream object body, or null (with a reason in ctx.notes).
async function machineStreamBytes(ctx, body, id = null, strictLimit) {
  const parts = await machineStreamParts(ctx, body, strictLimit !== undefined);
  if (!parts) return null;
  const filters = machineFilters(parts.dict), predictor = machineIntValue(parts.dict, 'Predictor');
  if (strictLimit !== undefined && (parts.raw.length > strictLimit || filters.length > 1 || predictor > 1)) return null;
  // Speculative font decoding must not change the existing failure reason.
  const notes = strictLimit === undefined ? ctx.notes : new Set();
  let bytes = machineBytes(parts.raw);
  const enc = await machineEncryption(ctx);
  if (enc) {
    if (enc.unsupported) { notes.add(enc.reason); return null; }
    // Cross-reference streams are never encrypted; XMP is left in clear text when /EncryptMetadata is false.
    const clear = /\/Type\s*\/XRef\b/.test(parts.dict) || (enc.meta === false && /\/Type\s*\/Metadata\b/.test(parts.dict));
    if (enc.stm && !clear) {
      if (id === null || id === undefined) { notes.add('encryption_unsupported'); return null; }
      bytes = await machineDecryptData(ctx, enc, Number(id), bytes, enc.stm);
      if (!bytes) { notes.add('encryption_unsupported'); return null; }
    }
  }
  for (const filter of filters) {
    if (filter !== 'FlateDecode' && filter !== 'Fl') { notes.add('filter_unsupported'); return null; }
    bytes = await machineInflate(bytes, notes, strictLimit);
    if (!bytes) return null;
    if (predictor >= 10) bytes = machinePngPredictor(bytes, machineIntValue(parts.dict, 'Columns') || 1, machineIntValue(parts.dict, 'Colors') || 1, machineIntValue(parts.dict, 'BitsPerComponent') || 8);
    else if (predictor > 1) { notes.add('filter_unsupported'); return null; }
  }
  return bytes;
}
async function machinePackedObjects(ctx) {
  if (ctx.packed) return ctx.packed;
  ctx.packed = new Map();
  const enc = await machineEncryption(ctx);
  for (const [id] of ctx.index) {
    const body = machineTopBody(ctx, id), streamAt = body.indexOf('stream');
    if (streamAt < 0 || !/\/Type\s*\/ObjStm\b/.test(body.slice(0, streamAt))) continue;
    const parts = await machineStreamParts(ctx, body);
    const count = parts && machineIntValue(parts.dict, 'N'), first = parts && machineIntValue(parts.dict, 'First');
    const bytes = parts && count !== null && first !== null ? await machineStreamBytes(ctx, body, id) : null;
    if (!bytes) { if (!(enc && enc.unsupported)) ctx.notes.add('objstm_unsupported'); continue; }
    const text = machineLatin1(bytes), header = text.slice(0, first).split(/\s+/).filter(Boolean).map(Number);
    for (let n = 0; n < count && 2 * n + 1 < header.length; n++) {
      const objectId = header[2 * n], from = first + header[2 * n + 1];
      const to = 2 * n + 3 < header.length ? first + header[2 * n + 3] : text.length;
      if (Number.isInteger(objectId) && !ctx.packed.has(objectId)) ctx.packed.set(objectId, text.slice(from, to));
    }
  }
  return ctx.packed;
}
// Object body text. Top-level objects win over packed ones; object streams are inflated on the first miss.
async function machineObjectBody(ctx, id) {
  const top = machineTopBody(ctx, id);
  if (top !== null) return top;
  const packed = await machinePackedObjects(ctx);
  return packed.has(Number(id)) ? packed.get(Number(id)) : null;
}
async function machineBody(ctx, id) { return id ? await machineObjectBody(ctx, id) : null; }
async function machineFirstPageObject(ctx) {
  const roots = [...ctx.text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  const rootId = roots.length ? roots[roots.length - 1][1] : '';
  let node = null;
  if (rootId) {
    const catalog = await machineBody(ctx, rootId);
    const pagesId = catalog && machineRefValue(catalog, 'Pages');
    node = await machineBody(ctx, pagesId);
    for (let depth = 0; node && depth < 32; depth++) {
      let kids = /\/Kids\s*\[([^\]]*)\]/.exec(node);
      if (!kids && machineRefValue(node, 'Kids')) {
        const listed = await machineBody(ctx, machineRefValue(node, 'Kids'));
        kids = listed && /\[([^\]]*)\]/.exec(listed);
      }
      if (!kids) break;
      let next = null;
      for (const id of machineRefList(kids[1])) { next = await machineBody(ctx, id); if (next) break; }
      node = next;
    }
  }
  if (node && /\/Contents(?![A-Za-z0-9_])/.test(node)) return {body:node, via:'root'};
  // Legacy shortcut for files without a usable trailer: first /Type /Pages node, first kid.
  const pages = /\/Type\s*\/Pages\b[\s\S]*?\/Kids\s*\[([^\]]*)\]/.exec(ctx.text);
  const kid = pages && /(\d+)\s+\d+\s+R/.exec(pages[1]);
  const legacy = kid ? await machineBody(ctx, kid[1]) : null;
  if (legacy) return {body:legacy, via:'legacy'};
  ctx.notes.add(node ? 'contents_not_found' : 'page_tree_not_found');
  return null;
}
async function machinePageInherited(ctx, page, key) {
  let body = page;
  for (let depth = 0; body && depth < 12; depth++) {
    const direct = machineDictValue(body, key);
    if (direct) return direct;
    const ref = machineRefValue(body, key);
    if (ref) return await machineBody(ctx, ref) || '';
    body = await machineBody(ctx, machineRefValue(body, 'Parent'));
  }
  return '';
}
async function machineContentIds(ctx, page) {
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(page);
  if (array) return machineRefList(array[1]);
  const id = machineRefValue(page, 'Contents');
  if (!id) return [];
  const body = await machineBody(ctx, id);
  return body && /^\s*(?:\d+\s+\d+\s+obj\s*)?\[/.test(body) && !/stream/.test(body) ? machineRefList(body) : [id];
}
function machineHexBytes(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let n = 0; n < clean.length; n += 2) out += String.fromCharCode(parseInt(clean.slice(n, n + 2).padEnd(2, '0'), 16));
  return out;
}
function machineUtf16(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  if (clean.length <= 2) return String.fromCharCode(parseInt(clean || '0', 16));
  for (let n = 0; n + 3 < clean.length; n += 4) out += String.fromCharCode(parseInt(clean.slice(n, n + 4), 16));
  return out;
}
// ToUnicode CMap -> {width, map}. Only bfchar/bfrange are needed for text extraction.
function machineParseCmap(text, type0) {
  const map = new Map();
  let width = 0;
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const range of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) width = Math.max(width, Math.ceil(range[1].length / 2));
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) { if (map.size < 70000) map.set(parseInt(pair[1], 16), machineUtf16(pair[2])); }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g)) {
      const low = parseInt(range[1], 16), high = Math.min(parseInt(range[2], 16), low + 65535);
      if (range[4] !== undefined) {
        const list = [...range[4].matchAll(/<([0-9A-Fa-f]*)>/g)];
        for (let code = low; code <= high && code - low < list.length && map.size < 70000; code++) map.set(code, machineUtf16(list[code - low][1]));
      } else {
        const base = machineUtf16(range[3] || ''), last = base.charCodeAt(base.length - 1);
        for (let code = low; code <= high && map.size < 70000; code++) map.set(code, base.slice(0, -1) + String.fromCharCode(last + code - low));
      }
    }
  }
  // Only a Type0 (composite) font reads codes as wide as its codespace. A simple font (Type1/TrueType/Type3) always shows one byte
  // per glyph, even when its ToUnicode CMap declares a 2-byte <0000> <FFFF> codespace around 1-byte entries (some InDesign exports
  // do): reading such a string in pairs maps nothing and silently drops the whole run, e.g. a title set in a ligature-bearing font.
  return {width:type0 ? (width || 2) : 1, map};
}
// CFF 1 predefined data from Adobe Technical Note #5176, Appendices A–C.
const MACHINE_CFF_NAMES = `
  .notdef space exclam quotedbl numbersign dollar percent ampersand quoteright
  parenleft parenright asterisk plus comma hyphen period slash zero
  one two three four five six seven eight nine
  colon semicolon less equal greater question at A B
  C D E F G H I J K
  L M N O P Q R S T
  U V W X Y Z bracketleft backslash bracketright
  asciicircum underscore quoteleft a b c d e f
  g h i j k l m n o
  p q r s t u v w x
  y z braceleft bar braceright asciitilde exclamdown cent sterling
  fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft
  guilsinglright fi fl endash dagger daggerdbl periodcentered paragraph bullet
  quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand questiondown grave acute
  circumflex tilde macron breve dotaccent dieresis ring cedilla hungarumlaut
  ogonek caron emdash AE ordfeminine Lslash Oslash OE ordmasculine
  ae dotlessi lslash oslash oe germandbls onesuperior logicalnot mu
  trademark Eth onehalf plusminus Thorn onequarter divide brokenbar degree
  thorn threequarters twosuperior registered minus eth multiply threesuperior copyright
  Aacute Acircumflex Adieresis Agrave Aring Atilde Ccedilla Eacute Ecircumflex
  Edieresis Egrave Iacute Icircumflex Idieresis Igrave Ntilde Oacute Ocircumflex
  Odieresis Ograve Otilde Scaron Uacute Ucircumflex Udieresis Ugrave Yacute
  Ydieresis Zcaron aacute acircumflex adieresis agrave aring atilde ccedilla
  eacute ecircumflex edieresis egrave iacute icircumflex idieresis igrave ntilde
  oacute ocircumflex odieresis ograve otilde scaron uacute ucircumflex udieresis
  ugrave yacute ydieresis zcaron exclamsmall Hungarumlautsmall dollaroldstyle dollarsuperior ampersandsmall
  Acutesmall parenleftsuperior parenrightsuperior twodotenleader onedotenleader zerooldstyle oneoldstyle twooldstyle threeoldstyle
  fouroldstyle fiveoldstyle sixoldstyle sevenoldstyle eightoldstyle nineoldstyle commasuperior threequartersemdash periodsuperior
  questionsmall asuperior bsuperior centsuperior dsuperior esuperior isuperior lsuperior msuperior
  nsuperior osuperior rsuperior ssuperior tsuperior ff ffi ffl parenleftinferior
  parenrightinferior Circumflexsmall hyphensuperior Gravesmall Asmall Bsmall Csmall Dsmall Esmall
  Fsmall Gsmall Hsmall Ismall Jsmall Ksmall Lsmall Msmall Nsmall
  Osmall Psmall Qsmall Rsmall Ssmall Tsmall Usmall Vsmall Wsmall
  Xsmall Ysmall Zsmall colonmonetary onefitted rupiah Tildesmall exclamdownsmall centoldstyle
  Lslashsmall Scaronsmall Zcaronsmall Dieresissmall Brevesmall Caronsmall Dotaccentsmall Macronsmall figuredash
  hypheninferior Ogoneksmall Ringsmall Cedillasmall questiondownsmall oneeighth threeeighths fiveeighths seveneighths
  onethird twothirds zerosuperior foursuperior fivesuperior sixsuperior sevensuperior eightsuperior ninesuperior
  zeroinferior oneinferior twoinferior threeinferior fourinferior fiveinferior sixinferior seveninferior eightinferior
  nineinferior centinferior dollarinferior periodinferior commainferior Agravesmall Aacutesmall Acircumflexsmall Atildesmall
  Adieresissmall Aringsmall AEsmall Ccedillasmall Egravesmall Eacutesmall Ecircumflexsmall Edieresissmall Igravesmall
  Iacutesmall Icircumflexsmall Idieresissmall Ethsmall Ntildesmall Ogravesmall Oacutesmall Ocircumflexsmall Otildesmall
  Odieresissmall OEsmall Oslashsmall Ugravesmall Uacutesmall Ucircumflexsmall Udieresissmall Yacutesmall Thornsmall
  Ydieresissmall 001.000 001.001 001.002 001.003 Black Bold Book Light
  Medium Regular Roman Semibold
`.trim().split(/\s+/);
const MACHINE_CFF_CHARSET_EXPERT = `
  0 1 229 230 231 232 233 234 235 236 237 238 13 14 15 99
  239 240 241 242 243 244 245 246 247 248 27 28 249 250 251 252
  253 254 255 256 257 258 259 260 261 262 263 264 265 266 109 110
  267 268 269 270 271 272 273 274 275 276 277 278 279 280 281 282
  283 284 285 286 287 288 289 290 291 292 293 294 295 296 297 298
  299 300 301 302 303 304 305 306 307 308 309 310 311 312 313 314
  315 316 317 318 158 155 163 319 320 321 322 323 324 325 326 150
  164 169 327 328 329 330 331 332 333 334 335 336 337 338 339 340
  341 342 343 344 345 346 347 348 349 350 351 352 353 354 355 356
  357 358 359 360 361 362 363 364 365 366 367 368 369 370 371 372
  373 374 375 376 377 378
`.trim().split(/\s+/).map(Number);
const MACHINE_CFF_CHARSET_EXPERT_SUBSET = `
  0 1 231 232 235 236 237 238 13 14 15 99 239 240 241 242
  243 244 245 246 247 248 27 28 249 250 251 253 254 255 256 257
  258 259 260 261 262 263 264 265 266 109 110 267 268 269 270 272
  300 301 302 305 314 315 158 155 163 320 321 322 323 324 325 326
  150 164 169 327 328 329 330 331 332 333 334 335 336 337 338 339
  340 341 342 343 344 345 346
`.trim().split(/\s+/).map(Number);
const MACHINE_CFF_ENCODING_STANDARD = `
  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16
  17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32
  33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48
  49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64
  65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80
  81 82 83 84 85 86 87 88 89 90 91 92 93 94 95 0
  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  0 96 97 98 99 100 101 102 103 104 105 106 107 108 109 110
  0 111 112 113 114 0 115 116 117 118 119 120 121 122 0 123
  0 124 125 126 127 128 129 130 131 0 132 133 0 134 135 136
  137 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  0 138 0 139 0 0 0 0 140 141 142 143 0 0 0 0
  0 144 0 0 0 145 0 0 146 147 148 149 0 0 0 0
`.trim().split(/\s+/).map(Number);
const MACHINE_CFF_ENCODING_EXPERT = `
  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  1 229 230 0 231 232 233 234 235 236 237 238 13 14 15 99
  239 240 241 242 243 244 245 246 247 248 27 28 249 250 251 252
  0 253 254 255 256 257 0 0 0 258 0 0 259 260 261 262
  0 0 263 264 265 0 266 109 110 267 268 269 0 270 271 272
  273 274 275 276 277 278 279 280 281 282 283 284 285 286 287 288
  289 290 291 292 293 294 295 296 297 298 299 300 301 302 303 0
  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  0 304 305 306 0 0 307 308 309 310 311 0 312 0 0 312
  0 0 314 315 0 0 316 317 318 0 0 0 158 155 163 319
  320 321 322 323 324 325 0 0 326 150 164 169 327 328 329 330
  331 332 333 334 335 336 337 338 339 340 341 342 343 344 345 346
  347 348 349 350 351 352 353 354 355 356 357 358 359 360 361 362
  363 364 365 366 367 368 369 370 371 372 373 374 375 376 377 378
`.trim().split(/\s+/).map(Number);
// PDF 32000 Latin simple-font encodings (one glyph name per byte, from code 32).
const MACHINE_ENCODING_WINANSI = `
  space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft
  parenright asterisk plus comma hyphen period slash zero one
  two three four five six seven eight nine colon
  semicolon less equal greater question at A B C
  D E F G H I J K L
  M N O P Q R S T U
  V W X Y Z bracketleft backslash bracketright asciicircum
  underscore grave a b c d e f g
  h i j k l m n o p
  q r s t u v w x y
  z braceleft bar braceright asciitilde bullet Euro bullet quotesinglbase
  florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft
  OE bullet Zcaron bullet bullet quoteleft quoteright quotedblleft quotedblright
  bullet endash emdash tilde trademark scaron guilsinglright oe bullet
  zcaron Ydieresis space exclamdown cent sterling currency yen brokenbar
  section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron
  degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla
  onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute
  Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex
  Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute
  Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis
  Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring
  ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex
  idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide
  oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis
`.trim().split(/\s+/);
const MACHINE_ENCODING_MACROMAN = `
  space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft
  parenright asterisk plus comma hyphen period slash zero one
  two three four five six seven eight nine colon
  semicolon less equal greater question at A B C
  D E F G H I J K L
  M N O P Q R S T U
  V W X Y Z bracketleft backslash bracketright asciicircum
  underscore grave a b c d e f g
  h i j k l m n o p
  q r s t u v w x y
  z braceleft bar braceright asciitilde - Adieresis Aring Ccedilla
  Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde
  aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex
  idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave
  ucircumflex udieresis dagger degree cent sterling section bullet paragraph
  germandbls registered copyright trademark acute dieresis notequal AE Oslash
  infinity plusminus lessequal greaterequal yen mu partialdiff summation product
  pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown
  logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis space
  Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright
  quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft
  guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex
  Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute
  Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde
  macron breve dotaccent ring cedilla hungarumlaut ogonek caron
`.trim().split(/\s+/);
const MACHINE_ENCODING_MACEXPERT = `
  space exclamsmall Hungarumlautsmall centoldstyle dollaroldstyle dollarsuperior ampersandsmall Acutesmall parenleftsuperior
  parenrightsuperior twodotenleader onedotenleader comma hyphen period fraction zerooldstyle oneoldstyle
  twooldstyle threeoldstyle fouroldstyle fiveoldstyle sixoldstyle sevenoldstyle eightoldstyle nineoldstyle colon
  semicolon - threequartersemdash - questionsmall - - - -
  Ethsmall - - onequarter onehalf threequarters oneeighth threeeighths fiveeighths
  seveneighths onethird twothirds - - - - - -
  ff fi fl ffi ffl parenleftinferior - parenrightinferior Circumflexsmall
  hypheninferior Gravesmall Asmall Bsmall Csmall Dsmall Esmall Fsmall Gsmall
  Hsmall Ismall Jsmall Ksmall Lsmall Msmall Nsmall Osmall Psmall
  Qsmall Rsmall Ssmall Tsmall Usmall Vsmall Wsmall Xsmall Ysmall
  Zsmall colonmonetary onefitted rupiah Tildesmall - - asuperior centsuperior
  - - - - Aacutesmall Agravesmall Acircumflexsmall Adieresissmall Atildesmall
  Aringsmall Ccedillasmall Eacutesmall Egravesmall Ecircumflexsmall Edieresissmall Iacutesmall Igravesmall Icircumflexsmall
  Idieresissmall Ntildesmall Oacutesmall Ogravesmall Ocircumflexsmall Odieresissmall Otildesmall Uacutesmall Ugravesmall
  Ucircumflexsmall Udieresissmall - eightsuperior fourinferior threeinferior sixinferior eightinferior seveninferior
  Scaronsmall - centinferior twoinferior - Dieresissmall - Caronsmall osuperior
  fiveinferior - commainferior periodinferior Yacutesmall - dollarinferior - -
  Thornsmall - nineinferior zeroinferior Zcaronsmall AEsmall Oslashsmall questiondownsmall oneinferior
  Lslashsmall - - - - - - Cedillasmall -
  - - - - OEsmall figuredash hyphensuperior - -
  - - exclamdownsmall - Ydieresissmall - onesuperior twosuperior threesuperior
  foursuperior fivesuperior sixsuperior sevensuperior ninesuperior zerosuperior - esuperior rsuperior
  tsuperior - - isuperior ssuperior dsuperior - - -
  - - lsuperior Ogoneksmall Brevesmall Macronsmall bsuperior nsuperior msuperior
  commasuperior periodsuperior Dotaccentsmall Ringsmall - - - -
`.trim().split(/\s+/);
// Adobe Glyph List subset for Latin letters, punctuation, digits and ligatures.
const MACHINE_LATIN_GLYPH_UNICODE = `
  AE:c6 AEacute:1fc Aacute:c1 Abreve:102 Acircumflex:c2 Adieresis:c4 Agrave:c0 Amacron:100
  Aogonek:104 Aring:c5 Aringacute:1fa Atilde:c3 Cacute:106 Ccaron:10c Ccedilla:c7 Ccircumflex:108
  Cdotaccent:10a Dcaron:10e Dcroat:110 Delta:2206 Eacute:c9 Ebreve:114 Ecaron:11a Ecircumflex:ca
  Edieresis:cb Edotaccent:116 Egrave:c8 Emacron:112 Eng:14a Eogonek:118 Eth:d0 Euro:20ac
  Gbreve:11e Gcaron:1e6 Gcircumflex:11c Gdotaccent:120 Hbar:126 Hcircumflex:124 IJ:132 Iacute:cd
  Ibreve:12c Icircumflex:ce Idieresis:cf Idotaccent:130 Igrave:cc Imacron:12a Iogonek:12e Itilde:128
  Jcircumflex:134 Lacute:139 Lcaron:13d Ldot:13f Lslash:141 Nacute:143 Ncaron:147 Ntilde:d1
  OE:152 Oacute:d3 Obreve:14e Ocircumflex:d4 Odieresis:d6 Ograve:d2 Ohorn:1a0 Ohungarumlaut:150
  Omacron:14c Omega:2126 Oslash:d8 Oslashacute:1fe Otilde:d5 Racute:154 Rcaron:158 Sacute:15a
  Scaron:160 Scedilla:15e Scircumflex:15c Tbar:166 Tcaron:164 Thorn:de Uacute:da Ubreve:16c
  Ucircumflex:db Udieresis:dc Ugrave:d9 Uhorn:1af Uhungarumlaut:170 Umacron:16a Uogonek:172 Uring:16e
  Utilde:168 Wacute:1e82 Wcircumflex:174 Wdieresis:1e84 Wgrave:1e80 Yacute:dd Ycircumflex:176 Ydieresis:178
  Ygrave:1ef2 Zacute:179 Zcaron:17d Zdotaccent:17b aacute:e1 abreve:103 acircumflex:e2 acute:b4
  adieresis:e4 ae:e6 aeacute:1fd agrave:e0 amacron:101 ampersand:26 aogonek:105 approxequal:2248
  aring:e5 aringacute:1fb asciicircum:5e asciitilde:7e asterisk:2a at:40 atilde:e3 backslash:5c
  bar:7c braceleft:7b braceright:7d bracketleft:5b bracketright:5d breve:2d8 brokenbar:a6 bullet:2022
  cacute:107 caron:2c7 ccaron:10d ccedilla:e7 ccircumflex:109 cdotaccent:10b cedilla:b8 cent:a2
  circumflex:2c6 colon:3a colonmonetary:20a1 comma:2c copyright:a9 currency:a4 dagger:2020 daggerdbl:2021
  dcaron:10f dcroat:111 degree:b0 dieresis:a8 divide:f7 dollar:24 dotaccent:2d9 dotlessi:131
  eacute:e9 ebreve:115 ecaron:11b ecircumflex:ea edieresis:eb edotaccent:117 egrave:e8 eight:38
  eightinferior:2088 eightsuperior:2078 ellipsis:2026 emacron:113 emdash:2014 endash:2013 eng:14b eogonek:119
  equal:3d eth:f0 exclam:21 exclamdown:a1 figuredash:2012 five:35 fiveeighths:215d fiveinferior:2085
  fivesuperior:2075 florin:192 four:34 fourinferior:2084 foursuperior:2074 fraction:2044 gbreve:11f gcaron:1e7
  gcircumflex:11d gdotaccent:121 germandbls:df grave:60 greater:3e greaterequal:2265 guillemotleft:ab guillemotright:bb
  guilsinglleft:2039 guilsinglright:203a hbar:127 hcircumflex:125 hungarumlaut:2dd hyphen:2d iacute:ed ibreve:12d
  icircumflex:ee idieresis:ef igrave:ec ij:133 imacron:12b infinity:221e integral:222b iogonek:12f
  itilde:129 jcircumflex:135 kgreenlandic:138 lacute:13a lcaron:13e ldot:140 less:3c lessequal:2264
  logicalnot:ac longs:17f lozenge:25ca lslash:142 macron:af minus:2212 mu:b5 multiply:d7
  nacute:144 napostrophe:149 ncaron:148 nine:39 nineinferior:2089 ninesuperior:2079 notequal:2260 nsuperior:207f
  ntilde:f1 numbersign:23 oacute:f3 obreve:14f ocircumflex:f4 odieresis:f6 oe:153 ogonek:2db
  ograve:f2 ohorn:1a1 ohungarumlaut:151 omacron:14d one:31 onedotenleader:2024 oneeighth:215b onehalf:bd
  oneinferior:2081 onequarter:bc onesuperior:b9 onethird:2153 ordfeminine:aa ordmasculine:ba oslash:f8 oslashacute:1ff
  otilde:f5 paragraph:b6 parenleft:28 parenleftinferior:208d parenleftsuperior:207d parenright:29 parenrightinferior:208e parenrightsuperior:207e
  partialdiff:2202 percent:25 period:2e periodcentered:b7 perthousand:2030 pi:3c0 plus:2b plusminus:b1
  product:220f question:3f questiondown:bf quotedbl:22 quotedblbase:201e quotedblleft:201c quotedblright:201d quoteleft:2018
  quoteright:2019 quotesinglbase:201a quotesingle:27 racute:155 radical:221a rcaron:159 registered:ae ring:2da
  sacute:15b scaron:161 scedilla:15f scircumflex:15d section:a7 semicolon:3b seven:37 seveneighths:215e
  seveninferior:2087 sevensuperior:2077 six:36 sixinferior:2086 sixsuperior:2076 slash:2f space:20 sterling:a3
  summation:2211 tbar:167 tcaron:165 thorn:fe three:33 threeeighths:215c threeinferior:2083 threequarters:be
  threesuperior:b3 tilde:2dc trademark:2122 two:32 twodotenleader:2025 twoinferior:2082 twosuperior:b2 twothirds:2154
  uacute:fa ubreve:16d ucircumflex:fb udieresis:fc ugrave:f9 uhorn:1b0 uhungarumlaut:171 umacron:16b
  underscore:5f uogonek:173 uring:16f utilde:169 wacute:1e83 wcircumflex:175 wdieresis:1e85 wgrave:1e81
  yacute:fd ycircumflex:177 ydieresis:ff yen:a5 ygrave:1ef3 zacute:17a zcaron:17e zdotaccent:17c
  zero:30 zeroinferior:2080 zerosuperior:2070
`.trim().split(/\s+/).reduce((map, entry) => {
  const [name, point] = entry.split(':');
  return map.set(name, String.fromCodePoint(parseInt(point, 16)));
}, new Map());

const MACHINE_CFF_FONT_BYTES = 256 * 1024;
const MACHINE_CFF_PAGE_BYTES = 1024 * 1024;
const MACHINE_CFF_PAGE_FONTS = 24;
const MACHINE_CFF_INDEX_LIMIT = 4096;
const MACHINE_SIMPLE_FONT_PAGE_LIMIT = 64;
const MACHINE_PDF_SIMPLE_ENCODINGS = new Map([
  ['StandardEncoding', MACHINE_CFF_ENCODING_STANDARD.map(sid => MACHINE_CFF_NAMES[sid])],
  ['WinAnsiEncoding', MACHINE_ENCODING_WINANSI], ['MacRomanEncoding', MACHINE_ENCODING_MACROMAN],
  ['MacExpertEncoding', MACHINE_ENCODING_MACEXPERT]
]);
function machineCffUint(bytes, offset, width) {
  let value = 0;
  for (let at = offset; at < offset + width; at++) value = value * 256 + bytes[at];
  return value;
}
function machineCffIndex(bytes, at, limit = MACHINE_CFF_INDEX_LIMIT) {
  if (at + 2 > bytes.length) return null;
  const count = machineCffUint(bytes, at, 2);
  if (!count) return {count, end:at + 2};
  const width = bytes[at + 2], data = at + 3 + (count + 1) * width;
  if (count > limit || !(width >= 1 && width <= 4) || data > bytes.length) return null;
  const offsets = [];
  for (let index = 0; index <= count; index++) {
    const offset = machineCffUint(bytes, at + 3 + index * width, width) - 1;
    if (offset < 0 || data + offset > bytes.length
      || (index ? offset < offsets[index - 1] : offset !== 0)) return null;
    offsets.push(offset);
  }
  return {count, data, offsets, end:data + offsets[count]};
}
function machineCffDict(bytes) {
  if (!bytes.length || bytes.length > 4096) return null;
  const values = {charset:0, encoding:0, charStrings:0};
  const operands = [];
  for (let at = 0; at < bytes.length;) {
    const b = bytes[at++];
    let value;
    if (b <= 21) {
      const operator = b === 12 ? 1200 + bytes[at++] : b;
      if (at > bytes.length || operator === 1230) return null; // CID-keyed fonts have no simple glyph names.
      const key = b === 15 ? 'charset' : b === 16 ? 'encoding' : b === 17 ? 'charStrings' : '';
      if (key) {
        if (operands.length !== 1 || !Number.isInteger(operands[0]) || operands[0] < 0) return null;
        values[key] = operands[0];
      }
      operands.length = 0;
      continue;
    }
    if (b >= 32 && b <= 246) value = b - 139;
    else if (b >= 247 && b <= 254 && at < bytes.length) {
      value = ((b - 247) % 4 * 256 + bytes[at++] + 108) * (b < 251 ? 1 : -1);
    } else if ((b === 28 || b === 29) && at + (b === 28 ? 2 : 4) <= bytes.length) {
      const width = b === 28 ? 2 : 4;
      value = machineCffUint(bytes, at, width);
      const sign = 2 ** (8 * width - 1);
      if (value >= sign) value -= sign * 2;
      at += width;
    } else if (b === 30) {
      // Real numbers are legal for other DICT operators. They cannot be used as offsets.
      let end = false;
      while (at < bytes.length && !end) {
        const packed = bytes[at++];
        end = (packed >> 4) === 15 || (packed & 15) === 15;
      }
      if (!end) return null;
      value = null;
    } else {
      return null;
    }
    if (operands.length === 48) return null;
    operands.push(value);
  }
  return operands.length ? null : values;
}
function machineCffCharset(bytes, at, glyphs, firstData) {
  if (at < 3) {
    const predefined = at === 1 ? MACHINE_CFF_CHARSET_EXPERT : MACHINE_CFF_CHARSET_EXPERT_SUBSET;
    if (at === 0) return glyphs <= 229 ? Array.from({length:glyphs}, (_, sid) => sid) : null;
    return glyphs <= predefined.length ? predefined.slice(0, glyphs) : null;
  }
  if (at < firstData || at >= bytes.length) return null;
  const format = bytes[at++], charset = [0];
  if (format > 2) return null;
  while (charset.length < glyphs) {
    const size = 2 + format;
    if (at + size > bytes.length) return null;
    const first = machineCffUint(bytes, at, 2);
    const left = format ? machineCffUint(bytes, at + 2, format) : 0;
    if (!first || first + left > 65535 || charset.length + left >= glyphs) return null;
    for (let sid = first; sid <= first + left; sid++) charset.push(sid);
    at += size;
  }
  return new Set(charset).size === glyphs ? charset : null;
}
function machineCffEncoding(bytes, at, charset, firstData) {
  const sids = new Set(charset);
  if (at < 2) {
    const predefined = at === 0 ? MACHINE_CFF_ENCODING_STANDARD : MACHINE_CFF_ENCODING_EXPERT;
    return predefined.map(sid => sids.has(sid) ? sid : 0);
  }
  if (at < firstData || at + 2 > bytes.length) return null;
  const format = bytes[at++], ranges = bytes[at++], width = (format & 127) + 1, codes = new Array(256).fill(0);
  if (width > 2 || at + ranges * width > bytes.length) return null;
  let glyph = 1;
  for (let range = 0; range < ranges; range++) {
    const first = bytes[at++], last = first + (width === 2 ? bytes[at++] : 0);
    if (last > 255 || glyph + last - first >= charset.length) return null;
    for (let code = first; code <= last; code++) {
      if (codes[code]) return null;
      codes[code] = charset[glyph++];
    }
  }
  if (format & 128) {
    const supplements = bytes[at++];
    if (supplements === undefined || at + supplements * 3 > bytes.length) return null;
    for (let index = 0; index < supplements; index++) {
      const code = bytes[at++], sid = machineCffUint(bytes, at, 2);
      if (!sid || !sids.has(sid) || codes[code]) return null;
      codes[code] = sid;
      at += 2;
    }
  }
  return codes;
}
function machineCffFont(bytes) {
  if (bytes[0] !== 1 || !(bytes[2] >= 4 && bytes[2] <= bytes.length) || !(bytes[3] >= 1 && bytes[3] <= 4)) return null;
  const names = machineCffIndex(bytes, bytes[2], 1);
  const top = names?.count && machineCffIndex(bytes, names.end, 1);
  const strings = top?.count && machineCffIndex(bytes, top.end);
  const subrs = strings && machineCffIndex(bytes, strings.end);
  if (!subrs) return null;
  const dict = machineCffDict(bytes.subarray(top.data, top.end));
  const chars = dict && dict.charStrings >= subrs.end && machineCffIndex(bytes, dict.charStrings);
  if (!chars?.count) return null;
  const charset = machineCffCharset(bytes, dict.charset, chars.count, subrs.end);
  const codes = charset && machineCffEncoding(bytes, dict.encoding, charset, subrs.end);
  if (!codes) return null;
  const glyphNames = new Map();
  for (const sid of charset) {
    if (sid < MACHINE_CFF_NAMES.length) {
      glyphNames.set(sid, MACHINE_CFF_NAMES[sid]);
      continue;
    }
    const index = sid - MACHINE_CFF_NAMES.length;
    if (index >= strings.count) return null;
    const [start, end] = [strings.offsets[index], strings.offsets[index + 1]];
    if (end === start || end - start > 127) return null;
    const name = machineLatin1(bytes.subarray(strings.data + start, strings.data + end));
    if (!/^[!-~]+$/.test(name)) return null;
    glyphNames.set(sid, name);
  }
  return {names:new Set(glyphNames.values()), encoding:codes.map(sid => glyphNames.get(sid))};
}
function machineGlyphUnicode(glyph) {
  const name = glyph?.split('.', 1)[0];
  if (!name) return '';
  if (/^[A-Za-z]$/.test(name)) return name;
  if (/^(?:ff|fi|fl|ffi|ffl)$/.test(name)) return name;
  if (/^f_(?:f_[il]|[fil])$/.test(name)) return name.replace(/_/g, '');
  if (MACHINE_LATIN_GLYPH_UNICODE.has(name)) return MACHINE_LATIN_GLYPH_UNICODE.get(name);
  const hex = /^uni(?:[0-9A-F]{4}){1,4}$/.test(name) ? name.slice(3).match(/.{4}/g)
    : /^u[0-9A-F]{4,6}$/.test(name) ? [name.slice(1)] : [];
  const points = hex.map(value => parseInt(value, 16));
  if (points.some(point => point < 32 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))) return '';
  return String.fromCodePoint(...points);
}
function machineSimpleCodeMap(cff, baseName, differences, standard = false) {
  const base = MACHINE_PDF_SIMPLE_ENCODINGS.get(baseName);
  const map = new Map();
  if (baseName && !base) return map;
  for (let code = 0; code < 256; code++) {
    const name = differences.get(code) ?? (base ? base[code - (base.length === 256 ? 0 : 32)] : cff?.encoding[code]);
    const text = name ? (!cff || cff.names.has(name) ? machineGlyphUnicode(name) : '')
      : !base && !cff && standard && code >= 32 && code <= 126 ? String.fromCharCode(code) : '';
    if (text) map.set(code, text);
  }
  return map;
}
async function machineSimpleFontEncoding(ctx, body) {
  const reference = machineRefValue(body, 'Encoding');
  const source = reference ? await machineBody(ctx, reference) : machineDictValue(body, 'Encoding');
  if (source === null || source === undefined) return null;
  if (source.length > 8192) return null;
  const encoding = source.replace(/%[^\r\n]*/g, '');
  const inputName = reference ? /^\s*\/([^\s/<>\[\]()]+)/.exec(encoding)
    : /\/Encoding\s*\/([^\s/<>\[\]()]+)/.exec(body);
  const base = inputName?.[1] || /\/BaseEncoding\s*\/([^\s/<>\[\]()]+)/.exec(encoding)?.[1] || '';
  const rawDifferences = /\/Differences\s*\[([^\]]*)\]/.exec(encoding)?.[1];
  if (rawDifferences === undefined && /\/Differences\b/.test(encoding)) return null;
  const differences = new Map();
  let code = -1;
  for (const token of (rawDifferences || '').match(/\/[^\s/[\]()<>%{}]+|[0-9]+|\S/g) || []) {
    if (token.startsWith('/') && code >= 0 && code <= 255) {
      differences.set(code++, token.slice(1).replace(/#([0-9a-f]{2})/gi, (_, byte) => String.fromCharCode(parseInt(byte, 16))));
    } else if (/^[0-9]{1,3}$/.test(token) && Number(token) <= 255) {
      code = Number(token);
    } else {
      return null;
    }
  }
  return {base, differences};
}
async function machineFontWithoutUnicode(ctx, body, budget) {
  if (body.length > 8192) return null;
  const subtype = /\/Subtype\s*\/(Type1|TrueType)\b/.exec(body)?.[1];
  if (!subtype) return null;
  const descriptorId = machineRefValue(body, 'FontDescriptor');
  const descriptor = (descriptorId ? await machineBody(ctx, descriptorId) : machineDictValue(body, 'FontDescriptor')) || '';
  if (descriptor.length > 8192) return null;
  const file = machineRefValue(descriptor, 'FontFile3');
  let cff = null;
  if (file) {
    if (subtype !== 'Type1' || !budget.bytes || budget.fonts >= MACHINE_CFF_PAGE_FONTS) return null;
    budget.fonts++;
    const limit = Math.min(MACHINE_CFF_FONT_BYTES, budget.bytes);
    const start = ctx.index.get(Number(file));
    if (start === undefined) return null; // PDF stream objects are never inside object streams.
    const stream = ctx.text.slice(start, start + limit + 8192);
    if (!/\/Subtype\s*\/Type1C\b/.test(stream.slice(0, 8192).split(/\bstream\b/, 1)[0])) return null;
    const bytes = await machineStreamBytes(ctx, stream, file, limit);
    budget.bytes -= bytes?.length ?? limit;
    cff = bytes && machineCffFont(bytes);
    if (!cff) return null;
  }
  const flags = machineIntValue(descriptor, 'Flags') || 0;
  if (!cff && (flags & 4)) return null; // An explicitly symbolic simple font needs its own glyph mapping.
  const encoding = await machineSimpleFontEncoding(ctx, body);
  if (!encoding) return null;
  const standard = !descriptor && subtype === 'Type1'
    && /\/BaseFont\s*\/(?:Helvetica(?:-BoldOblique|-Oblique|-Bold)?|Times-(?:Roman|BoldItalic|Italic|Bold)|Courier(?:-BoldOblique|-Oblique|-Bold)?)(?=[\s/>])/.test(body);
  if (!cff && !standard && !encoding.base && !encoding.differences.size) return null;
  const map = machineSimpleCodeMap(cff, encoding.base, encoding.differences, standard);
  const recovered = !!cff || (!standard && !!encoding.base) || encoding.differences.size > 0;
  return map.size ? {width:1, map, strictOnly:true, recovered} : null;
}

async function machinePageFonts(ctx, page, withFallbackFonts) {
  const fonts = new Map();
  const resources = await machinePageInherited(ctx, page, 'Resources');
  let table = machineDictValue(resources, 'Font');
  if (!table && machineRefValue(resources, 'Font')) table = await machineBody(ctx, machineRefValue(resources, 'Font')) || '';
  const budget = {bytes:MACHINE_CFF_PAGE_BYTES, fonts:0};
  const fallback = new Map();
  for (const entry of table.matchAll(/\/([^\s/\[\]<>()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const body = await machineBody(ctx, entry[2]), unicodeId = body && machineRefValue(body, 'ToUnicode');
    if (unicodeId) {
      const stream = await machineBody(ctx, unicodeId), bytes = stream && await machineStreamBytes(ctx, stream, unicodeId);
      if (bytes) fonts.set(entry[1], machineParseCmap(machineLatin1(bytes), /\/Subtype\s*\/Type0\b/.test(body)));
    } else if (withFallbackFonts && body) {
      if (!fallback.has(entry[2]) && fallback.size >= MACHINE_SIMPLE_FONT_PAGE_LIMIT) continue;
      if (!fallback.has(entry[2])) fallback.set(entry[2], await machineFontWithoutUnicode(ctx, body, budget));
      const font = fallback.get(entry[2]);
      if (font) fonts.set(entry[1], font);
    }
  }
  return fonts;
}
function machineMapCodes(font, bytes, shownOnly) {
  if (!font) return shownOnly && bytes ? '\ufffd' : bytes;
  if (!shownOnly && font.strictOnly) return bytes;
  let out = '';
  for (let at = 0; at + font.width <= bytes.length; at += font.width) {
    let code = 0;
    for (let n = 0; n < font.width; n++) code = code * 256 + bytes.charCodeAt(at + n);
    out += font.map.get(code) || (shownOnly ? '\ufffd' : '');
  }
  if (shownOnly && bytes.length % font.width) out += '\ufffd';
  return out;
}
// Walks the operators of a content stream and decodes Tj / TJ / ' / " strings through the current font's map.
// Marked-content dictionaries (<<...>> after BDC/BMC, including nested ones) are skipped whole so a /BBox array
// inside the dictionary cannot leave the walker in TJ-array mode. "]" closes that mode; the closed array is kept
// only for a TJ that follows it (including when "]" ends one /Contents stream and "TJ" starts the next).
function machineDecodeFontText(content, fonts, evidence = null) {
  const shownOnly = evidence !== null;
  if (shownOnly ? !fonts.size : ![...fonts.values()].some(font => !font.strictOnly)) return '';
  let out = '', font = null, name = '', last = null, array = null, pending = null, inText = false;
  const savedFonts = [];
  const length = content.length, delimiters = /[\s()<>\[\]{}\/%]/;
  const escapes = {n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'};
  const show = text => {
    if (!shownOnly || inText) {
      if (shownOnly && font?.recovered && text) evidence.recovered = true;
      out += machineMapCodes(font, text, shownOnly);
    }
  };
  const skipLiteral = start => {
    let depth = 0;
    for (let i = start; i < length; i++) {
      if (content[i] === '\\') { i++; continue; }
      if (content[i] === '(') depth++;
      else if (content[i] === ')') { depth--; if (!depth) return i + 1; }
    }
    return length;
  };
  const skipDict = start => {
    let depth = 0, i = start;
    while (i < length) {
      if (content[i] === '<' && content[i + 1] === '<') { depth++; i += 2; continue; }
      if (content[i] === '>' && content[i + 1] === '>') { depth--; i += 2; if (!depth) return i; continue; }
      if (content[i] === '(') { i = skipLiteral(i); continue; }
      if (content[i] === '<' && content[i + 1] !== '<') {
        const end = content.indexOf('>', i + 1);
        i = end < 0 ? length : end + 1;
        continue;
      }
      if (content[i] === '%') {
        while (i < length && content[i] !== '\n' && content[i] !== '\r') i++;
        continue;
      }
      i++;
    }
    return length;
  };
  for (let at = 0; at < length;) {
    const char = content[at];
    if (char === '<' && content[at + 1] === '<') { at = skipDict(at); continue; }
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
    } else if (char === '<') {
      const end = content.indexOf('>', at);
      const text = machineHexBytes(content.slice(at + 1, end < 0 ? length : end));
      at = end < 0 ? length : end + 1;
      if (array) array.push(text); else last = text;
    } else if (char === '[') { array = []; pending = null; last = null; at++; }
    else if (char === ']') { pending = array; array = null; at++; }
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
      if (token === 'Tf') { font = fonts.get(name) || null; pending = null; if (shownOnly) last = null; }
      else if (token === 'Tj' || token === "'" || token === '"') { if (last !== null) show(last); last = null; pending = null; }
      else if (token === 'TJ') {
        for (const part of array || pending || []) { if (part === null) out += ' '; else show(part); }
        array = null; pending = null; last = null;
      } else if (['Td', 'TD', 'T*', 'Tm'].includes(token)) { out += ' '; pending = null; if (shownOnly) last = null; }
      else if (shownOnly && token === 'BT') { inText = true; pending = null; last = null; }
      else if (token === 'ET') { out += '\n'; pending = null; inText = false; if (shownOnly) last = null; }
      else if (shownOnly && token === 'q') {
        if (savedFonts.length >= 64) return '';
        savedFonts.push(font); pending = null; last = null;
      }
      else if (shownOnly && token === 'Q') { font = savedFonts.pop() || null; pending = null; last = null; }
      else if (shownOnly && token === 'Do') { out += '\ufffd'; pending = null; last = null; }
      else if (token === 'BI') { const stop = content.indexOf('EI', at); at = stop < 0 ? length : stop + 2; pending = null; }
      else { pending = null; if (shownOnly) last = null; }
    }
  }
  return out;
}
function machinePdfTokenBytes(text, at, opener) {
  if (opener === '<') {
    const end = text.indexOf('>', at);
    return machineBytes(machineHexBytes(text.slice(at, end < 0 ? text.length : end)));
  }
  const escapes = {n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'};
  let value = '', depth = 1;
  for (; at < text.length && depth; at++) {
    const c = text[at];
    if (c === '\\') {
      const next = text[at + 1] || '';
      if (/[0-7]/.test(next)) { let digits = ''; while (digits.length < 3 && /[0-7]/.test(text[at + 1] || '')) { digits += text[at + 1]; at++; } value += String.fromCharCode(parseInt(digits, 8) & 255); }
      else if (next === '\r' || next === '\n') { if (next === '\r' && text[at + 2] === '\n') at++; at++; }
      else { value += escapes[next] !== undefined ? escapes[next] : next; at++; }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (!depth) break; }
    value += c;
  }
  return machineBytes(value);
}
function machinePdfStringBytes(text, key) {
  const match = new RegExp('/' + key + '(?![A-Za-z0-9_])\\s*([(<])').exec(text);
  return match ? machinePdfTokenBytes(text, match.index + match[0].length, match[1]) : null;
}
function machineDecodePdfString(bytes) {
  if (!bytes || !bytes.length) return '';
  const value = machineLatin1(bytes);
  if (value.startsWith('\xfe\xff')) { let out = ''; for (let n = 2; n + 1 < value.length; n += 2) out += String.fromCharCode(value.charCodeAt(n) * 256 + value.charCodeAt(n + 1)); return out; }
  if (value.startsWith('\xef\xbb\xbf')) { try { return new TextDecoder().decode(bytes.subarray(3)); } catch { return value; } }
  return value;
}
function machinePdfStringValue(text, key) {
  return machineDecodePdfString(machinePdfStringBytes(text, key));
}
function machineXmlText(value) {
  return value.replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) => {
    const lower = code.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const point = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return Number.isInteger(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : ' ';
  });
}
// Info dictionary and XMP packet: titles to compare, plus text that may carry the DOI.
async function machineMetadata(ctx) {
  const titles = [];
  let text = '';
  const enc = await machineEncryption(ctx);
  const infos = [...ctx.text.matchAll(/\/Info\s+(\d+)\s+\d+\s+R/g)], infoId = infos.length ? infos[infos.length - 1][1] : '';
  const infoTop = infoId ? machineTopBody(ctx, infoId) !== null : false, infoBody = infoId ? await machineBody(ctx, infoId) : null;
  if (infoBody && !(infoTop && enc && enc.unsupported)) {
    const readInfo = async key => {
      const raw = machinePdfStringBytes(infoBody, key);
      if (!raw) return '';
      const plain = infoTop && enc && enc.str ? await machineDecryptData(ctx, enc, Number(infoId), raw, enc.str) : raw;
      return plain ? machineDecodePdfString(plain) : '';
    };
    const title = await readInfo('Title');
    if (title) titles.push(title);
    for (const key of ['Subject', 'Keywords', 'Title', 'Author', 'doi', 'DOI']) text += await readInfo(key) + '\n';
  }
  const roots = [...ctx.text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)], catalog = roots.length ? await machineBody(ctx, roots[roots.length - 1][1]) : null;
  const xmpId = catalog && machineRefValue(catalog, 'Metadata'), xmpBody = xmpId && await machineBody(ctx, xmpId);
  const xmpBytes = xmpBody && await machineStreamBytes(ctx, xmpBody, xmpId);
  if (xmpBytes) {
    let xmp = ''; try { xmp = new TextDecoder().decode(xmpBytes.length > 400000 ? xmpBytes.subarray(0, 400000) : xmpBytes); } catch { xmp = machineLatin1(xmpBytes); }
    const block = /<dc:title\b[\s\S]*?<\/dc:title>/i.exec(xmp);
    if (block) for (const item of block[0].matchAll(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/gi)) titles.push(machineXmlText(item[1]).trim());
    text += machineXmlText(xmp) + '\n';
  }
  return {titles:titles.filter(Boolean), text};
}
async function machineContentText(ctx, id) {
  const body = await machineBody(ctx, id);
  if (!body) return null;
  const bytes = await machineStreamBytes(ctx, body, id);
  return bytes ? machineLatin1(bytes) : null;
}
// What the first page says. `strings` is the readable part (used to judge whether text could be read at all).
async function machineFirstPage(bytes) {
  const ctx = machinePdfContext(bytes), notes = ctx.notes;
  const page = await machineFirstPageObject(ctx);
  const {strings, decoded, raw, readShown} = await machinePageText(ctx, page && page.body, true);
  const metadata = await machineMetadata(ctx);
  return {text:strings + '\n' + decoded + raw, shown:strings + '\n' + decoded, readShown, readable:machineMostlyLetters(strings) || machineMostlyLetters(decoded), metadata, notes:new Set(notes), ctx};
}
function machineMostlyLetters(value) {
  const shown = value.replace(/\s/g, ''), letters = shown.replace(/[^A-Za-z]/g, '').length;
  return letters >= MACHINE_READABLE_MIN_LETTERS && letters >= shown.length * MACHINE_READABLE_MIN_RATIO;
}
async function machinePageText(ctx, pageBody, withFallbackFonts = false) {
  const notes = ctx.notes;
  let strings = '', raw = '', decoded = '';
  let readShown = () => ({text:'', recovered:false});
  if (pageBody) {
    const ids = await machineContentIds(ctx, pageBody);
    if (!ids.length) notes.add('contents_not_found');
    const fonts = await machinePageFonts(ctx, pageBody, withFallbackFonts);
    // A page's /Contents array is one logical stream (ISO 32000-1 7.8.2): an operator may start in one stream and end in the
    // next (a TJ array closed by "]" at the end of one and "TJ" at the start of the next), and the font selected in an
    // earlier stream stays current. Decode the streams joined, never one by one, or a title split that way is dropped.
    let joined = '';
    for (const id of ids) {
      const content = await machineContentText(ctx, id);
      if (content === null) { if (![...MACHINE_ENCRYPTION_REASONS, 'inflate_failed', 'filter_unsupported', 'objstm_unsupported'].some(code => notes.has(code))) notes.add('contents_not_found'); continue; }
      strings += machinePdfStrings(content);
      raw += '\n' + content;
      joined += content + '\n';
    }
    decoded += machineDecodeFontText(joined, fonts) + '\n';
    // Keep strict operator evidence separate so existing matches retain their checks.
    if (withFallbackFonts) readShown = () => {
      const evidence = {recovered:false};
      evidence.text = machineDecodeFontText(joined, fonts, evidence);
      return evidence;
    };
  }
  return {strings, decoded, raw, readShown};
}
async function machinePageBodies(ctx, limit = MACHINE_MAX_PAGES, includeBlank = false) {
  if (!limit || limit < 1) return [];
  const roots = [...ctx.text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  const rootId = roots.length ? roots[roots.length - 1][1] : '';
  let pagesId = '';
  if (rootId) {
    const catalog = await machineBody(ctx, rootId);
    pagesId = catalog && machineRefValue(catalog, 'Pages');
  } else if (!includeBlank) {
    // Trailerless PDFs (e.g. without /Root): locate the top-level /Catalog or /Pages object.
    let firstPagesId = '';
    for (const [id] of ctx.index) {
      const body = machineTopBody(ctx, id), streamAt = body.indexOf('stream');
      const dict = streamAt >= 0 ? body.slice(0, streamAt) : body;
      if (/\/Type\s*\/Catalog\b/.test(dict)) { pagesId = machineRefValue(dict, 'Pages'); if (pagesId) break; }
      if (!firstPagesId && /\/Type\s*\/Pages\b/.test(dict)) firstPagesId = String(id);
    }
    if (!pagesId) pagesId = firstPagesId;
  }
  if (!pagesId) return [];
  const out = [], seen = new Set(), stack = [{id:pagesId, depth:0}];
  while (stack.length && out.length < limit) {
    const {id, depth} = stack.pop();
    const key = Number(id);
    if (!Number.isInteger(key) || seen.has(key)) { if (includeBlank) return []; continue; }
    seen.add(key);
    const body = await machineBody(ctx, id);
    if (!body) { if (includeBlank) return []; continue; }
    let kids = /\/Kids\s*\[([^\]]*)\]/.exec(body);
    if (!kids && machineRefValue(body, 'Kids')) {
      const listed = await machineBody(ctx, machineRefValue(body, 'Kids'));
      kids = listed && /\[([^\]]*)\]/.exec(listed);
    }
    if (kids) {
      if (depth >= 32) { if (includeBlank) return []; continue; }
      const refs = machineRefList(kids[1]);
      for (let i = refs.length - 1; i >= 0; i--) stack.push({id:refs[i], depth:depth + 1});
    } else if (includeBlank ? /\/Type\s*\/Page\b/.test(body) : /\/Contents(?![A-Za-z0-9_])/.test(body)) {
      out.push(body);
    } else if (includeBlank) {
      return [];
    }
  }
  return out;
}
// Later-page DOI scan: only runs when page 1 already matched the title and missed the claimed DOI.
// Stops immediately on the first valid hit, and caps traversal at MACHINE_MAX_PAGES (200) pages and cumulative
// decompressed stream bytes at MACHINE_SCAN_INFLATE_BUDGET (64 MiB). Pages that match the claimed DOI alongside
// more than MACHINE_LATER_PAGE_MAX_OTHER_DOIS other DOIs are treated as reference/listing pages and skipped.
function machineDoiTokens(text) {
  const out = new Set();
  for (const match of String(text || '').matchAll(/10\.\d{4,9}\/[^\s"<>()\[\],;]+/gi)) {
    const token = match[0].toLowerCase().replace(/\.+$/, '');
    if (token && !token.endsWith('/')) out.add(token);
  }
  return [...out];
}
async function machineFindDoiOnLaterPages(ctx, doi) {
  const pages = await machinePageBodies(ctx, MACHINE_MAX_PAGES + 1);
  const target = libraryDoi(doi) || String(doi || '').trim().toLowerCase();
  let inflated = 0, citedPages = 0;
  for (let index = 1; index < pages.length; index++) {
    if (index >= MACHINE_MAX_PAGES) return {page:0, truncated:true, citedPages};
    const {strings, decoded, raw} = await machinePageText(ctx, pages[index]);
    inflated += raw.length;
    if (inflated > MACHINE_SCAN_INFLATE_BUDGET) return {page:0, truncated:true, citedPages};
    const pageText = strings + '\n' + decoded + raw;
    if (!machineDoiPresent(pageText, doi)) continue;
    // Exclude the claimed DOI and mutual prefixes caused by line-wrap splits (e.g. "10.1001/jama.2022.").
    const otherDois = machineDoiTokens(pageText).filter(token => !target.startsWith(token) && !token.startsWith(target));
    if (otherDois.length > MACHINE_LATER_PAGE_MAX_OTHER_DOIS) {
      citedPages++;
      continue;
    }
    return {page:index + 1, ...(citedPages ? {citedPages} : {})};
  }
  return {page:0, citedPages};
}
function machineDoiPresent(text, doi, strictBoundaries = false) {
  const escaped = [...doi].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  const start = strictBoundaries ? '(?:^|(?<=[\\s(:\'"<\\[{])|(?<=\\bdoi\\.org/))' : '(?<![A-Za-z0-9])';
  const end = strictBoundaries ? '(?=$|\\s|[.,;:)\\]}\'">]+(?=\\s|$))' : '(?![A-Za-z0-9])';
  return new RegExp(start + escaped + end, 'i').test(text);
}
function machineMetaTitleMatches(titles, expected) {
  return titles.some(title => {
    const value = machineNormalize(title);
    if (value.length < 10) return false;
    if (value.includes(expected)) return true;
    return expected.includes(value) && value.length >= expected.length * 0.8;
  });
}
function machineFailReason(page, doiFound, titleFound) {
  const empty = !page.text.replace(/\s/g, '').length;
  if (empty || !page.readable) {
    // Encryption comes first: when it blocks reading, every later failure (object streams, inflate) is only its echo.
    for (const code of [...MACHINE_ENCRYPTION_REASONS, 'objstm_unsupported', 'inflate_failed', 'filter_unsupported', 'page_tree_not_found', 'contents_not_found']) if (page.notes.has(code)) return code;
  }
  if (empty) return 'page_text_empty';
  if (!doiFound && !titleFound) return 'identity_mismatch';
  return doiFound ? 'title_not_found' : 'doi_not_found';
}
function machineLigatureTitleMatch(pageText, expected) {
  const ligatures = /ffi|ffl|ff|fi|fl/g;
  const parts = expected.split(ligatures);
  const groups = expected.match(ligatures);
  if (!groups || groups.length > 12) return false;
  let fixedLen = 0;
  for (const part of parts) fixedLen += part.length;
  if (fixedLen < 15) return false;
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern = escape(parts[0]);
  for (let index = 0; index < groups.length; index++) {
    pattern += '(?:' + groups[index] + '|\u00fe|0[0-3][0-7]|)' + escape(parts[index + 1]);
  }
  return new RegExp(pattern).test(pageText);
}
function machineTitleOnPage(pageText, expected) {
  if (pageText.includes(expected)) return {found:true, glyph:''};
  // Some publisher fonts (seen in MDPI PDFs) map the "fl" ligature glyph to U+00DF, so page 1 reads "Inßammation" for
  // "Inflammation". Only after the normal match fails, and only page-side: every page "ß" is read as "fl" and the whole
  // expected title must then appear unchanged. Nothing else is mapped, and an expected title with a real "ß" is untouched.
  if (pageText.includes('\u00df') && pageText.replace(/\u00df/g, 'fl').includes(expected)) return {found:true, glyph:'eszett_as_fl'};
  if (machineLigatureTitleMatch(pageText, expected)) return {found:true, glyph:'ligature_lost'};
  return {found:false, glyph:''};
}
function machineAnyDoi(text) {
  return /(?<![0-9A-Za-z])10\.\d{4,9}\s*\/\s*[^\s]/.test(String(text || ''));
}
function machineCatalogTitleVariant(shown, title) {
  // Keep word boundaries and the undecodable-glyph marker. A different year immediately before
  // the headline, or a change to any other letter/digit, must still prevent the match.
  const words = value => value.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\ufffd]+/gu, ' ').trim();
  const full = words(title);
  const dropped = /^\s*[0-9]{4}\s+/.test(title) ? full.slice(5) : '';
  const matches = (source, expected, yearDropped = false) => expected && new RegExp(
    '(?:^| )' + (yearDropped ? '(?<!\\b[0-9]{4} )' : '') + expected + '(?: |$)'
  ).test(source);
  const page = words(shown);
  if (matches(page, dropped, true)) return 'year_prefix_dropped';
  const withoutAcronyms = shown.replace(/(?<=\p{L})[ \t\r\n]*\([A-Z]{2,8}\)/gu, '');
  if (withoutAcronyms === shown) return '';
  const cleaned = words(withoutAcronyms);
  if (matches(cleaned, full) && !matches(page, full)) return 'acronym_inserted';
  if (matches(cleaned, dropped, true)) return 'year_prefix_dropped+acronym_inserted';
  return '';
}
function machineRepositoryCoverTitle(shown) {
  // An institutional heading plus ordered repository fields and a Handle URL, all in shown text.
  const heading = /\buniversity\s+repository\b/i.exec(shown.slice(0, 240));
  if (!heading) return null;
  const fields = /^\s*Title\s+([\s\S]{1,1200}?)\s+Authors?\s+[\s\S]{1,2400}?\s+Published\s+in\s+[\s\S]{1,600}?\s+Publication\s+Date\s+[\s\S]{1,120}?\s+Link\s+https?:\/\/hdl\.handle\.net\/[^\s]+[\s\S]{0,240}?\s+Citation\b/i;
  return fields.exec(shown.slice(heading.index + heading[0].length, heading.index + heading[0].length + 3600))?.[1] ?? null;
}
async function machineRepositoryIdentity(page, coverTitle, doi, expected) {
  const checks = {doi:'', title:'', readable:false, coverPage:'repository'};
  if (machineNormalize(coverTitle) !== expected) return {verdict:'mismatch', reason:'identity_mismatch', checks};
  const [, article] = await machinePageBodies(page.ctx, 2, true);
  const shown = article ? (await machinePageText(page.ctx, article, true)).readShown().text : '';
  checks.readable = machineMostlyLetters(shown);
  if (machineDoiPresent(shown, doi, true)) { checks.doi = 'page'; checks.doiPage = 2; }
  if (machineNormalize(shown).includes(expected)) checks.title = 'page';
  // A cover or document metadata cannot supply either part of the article's identity.
  if (checks.doi && checks.title) return {verdict:'ok', level:'full', checks};
  const reason = checks.doi ? 'title_not_found' : checks.title ? 'doi_not_found' : 'identity_mismatch';
  return {verdict:'mismatch', reason, checks};
}
// {verdict:'ok'|'invalid'|'mismatch', reason, level, doi, title}. level says how strong the evidence was:
// 'full' (DOI and title both read from page 1), 'metadata_doi' (title on page 1, DOI only from Info/XMP),
// 'metadata_title' (DOI on page 1, title only from Info/XMP because the page text could not be read),
// 'doi_only' (DOI on page 1, title unreadable), 'metadata_only', 'title_only' (machine uploads only, when
// options.allowTitleOnly: title read on page 1 and neither page 1 nor metadata carries any DOI). Anything that
// is not 'full' is still only a candidate: it waits for the independent dual-parser verification.
// If normal title matching (including section-label stripping) misses, falls back in order via machineTitleVariant
// (whole-word versus/vs./v. -> vs and stripping ™/®): checks.titleVariant = 'versus_or_mark', then 'c1_control_dropped', then 'line_number_inserted', then 'proof_marker_inserted'.
async function machineIdentity(bytes, doi, rawTitle, options = {}) {
  const title = String(rawTitle || '').replace(MACHINE_TITLE_MARKUP, '');
  const expected = machineNormalize(title);
  if (!libraryDoi(doi)) return {verdict:'invalid', reason:'doi_invalid'};
  if (expected.length < 5) return {verdict:'invalid', reason:'title_too_short'};
  const page = await machineFirstPage(bytes);
  const {text:shown, recovered} = page.readShown();
  const coverTitle = machineRepositoryCoverTitle(shown);
  if (coverTitle !== null) return machineRepositoryIdentity(page, coverTitle, doi, expected);
  let readable = page.readable;
  let doiPage = machineDoiPresent(page.text, doi), doiMeta = machineDoiPresent(page.metadata.text, doi);
  const pageText = machineNormalize(page.text);
  let titleMatch = machineTitleOnPage(pageText, expected);
  let titlePrefix = '';
  let titleVariant = '';
  let titleExtraction = '';
  let matchedExpected = expected;
  const hasSectionLabel = MACHINE_IDENTITY_SECTION_LABEL.test(String(title || ''));
  const strippedTitle = hasSectionLabel ? String(title || '').replace(MACHINE_IDENTITY_SECTION_LABEL, '') : '';
  if (!titleMatch.found && hasSectionLabel) {
    const stripped = machineNormalize(strippedTitle);
    if (stripped.length >= 5) {
      const retry = machineTitleOnPage(pageText, stripped);
      if (retry.found) { titleMatch = retry; titlePrefix = 'section_label_dropped'; matchedExpected = stripped; }
    }
  }
  if (!titleMatch.found) {
    const variantPage = machineTitleVariant(page.text);
    const c1Page = variantPage.replace(MACHINE_TITLE_C1_CONTROLS, '');
    const candidates = [[title, '']];
    if (hasSectionLabel) candidates.push([strippedTitle, 'section_label_dropped']);
    const tryVariant = (name, matchFn) => {
      if (titleMatch.found) return;
      for (const [candidate, prefix] of candidates) {
        const hit = matchFn(candidate);
        if (!hit) continue;
        titleMatch = hit.match;
        titleVariant = name;
        if (prefix) titlePrefix = prefix;
        matchedExpected = hit.expected;
        return;
      }
    };
    tryVariant('versus_or_mark', candidate => {
      const expectedVariant = machineTitleVariant(candidate);
      if (expectedVariant.length < 5) return null;
      const match = machineTitleOnPage(variantPage, expectedVariant);
      return match.found ? {match, expected:expectedVariant} : null;
    });
    tryVariant('c1_control_dropped', candidate => {
      const expectedC1 = machineTitleVariantNoC1(candidate);
      if (expectedC1.length < 5 || (c1Page === variantPage && expectedC1 === machineTitleVariant(candidate))) return null;
      const match = machineTitleOnPage(c1Page, expectedC1);
      return match.found ? {match, expected:expectedC1} : null;
    });
    // Insertion fallbacks (below) are only allowed once the claimed DOI is already confirmed (full / metadata_doi): without that, a
    // different paper whose title merely has an extra number would pass ("SPRINT 2 Trial" vs "SPRINT Trial").
    const doiConfirmed = doiPage || doiMeta;
    const wordsFor = candidate => String(candidate || '').trim().split(/\s+/).map(machineTitleVariantNoC1).filter(Boolean);
    if (!titleMatch.found && doiConfirmed) {
      const tokenized = machineTokenizedPage(page.text);
      const members = machineLineNumberMembers(tokenized.tokens);
      const memberAt = (at, text) => {
        for (let i = 0; i < tokenized.spans.length; i++) {
          const span = tokenized.spans[i];
          if (span.start > at) break;
          if (span.start === at && span.piece === text && members.has(i)) return true;
        }
        return false;
      };
      if (members.size) {
        tryVariant('line_number_inserted', candidate => {
          const words = wordsFor(candidate);
          const ok = machineMatchWordsWithInsertions(tokenized.norm, words, [1, 2], tok => /^[1-9]\d?$/.test(tok), inserted => {
            const nums = inserted.map(item => Number(item.text));
            if (nums.length === 2 && !(nums[0] < nums[1])) return false;
            return inserted.every(item => memberAt(item.at, item.text));
          });
          return ok ? {match:{found:true, glyph:''}, expected:words.join('')} : null;
        });
      }
      // Elsevier pre-proof PDFs print author-query markers (Q1, Q2 ...) inside the title. Needs proof-stage evidence on the page
      // ("HRTHM12284_proof" file tag or "Journal Pre-proof") and a query list: at least 3 distinct Q-numbers in the shown text, which
      // must include every inserted marker. page.shown excludes the raw content stream, where graphics-state operators
      // ("Q 1 0 0 1 ...") would fake a match.
      const proofStage = /[A-Z]{2,}\d{2,}_proof(?![A-Za-z])|(?:^|[^A-Za-z0-9])_proof(?![A-Za-z])|\bjournal\s+pre-?proof\b/i.test(page.shown);
      const queryNumbers = new Set([...page.shown.matchAll(/(?:^|[^A-Za-z0-9])Q\s*(\d{1,2})(?![0-9])/g)].map(item => item[1]));
      if (proofStage && queryNumbers.size >= MACHINE_PROOF_MIN_QUERIES) {
        tryVariant('proof_marker_inserted', candidate => {
          const words = wordsFor(candidate);
          const ok = machineMatchWordsWithInsertions(tokenized.norm, words, [2, 3], tok => /^q\d{1,2}$/.test(tok), inserted => inserted.every(item => queryNumbers.has(item.text.slice(1))));
          return ok ? {match:{found:true, glyph:''}, expected:words.join('')} : null;
        });
      }
    }
    // Medical News in Brief runs multiple unrelated headlines together. Separate title/DOI
    // hits on such a page do not justify the new fallbacks.
    if (!titleMatch.found && !/\bmedical\s+news\s+in\s+brief\b/i.test(shown)) {
      const shownDoi = machineDoiPresent(shown, doi, true);
      const metadataDoi = doiMeta && machineDoiPresent(page.metadata.text, doi, true);
      if (shownDoi && recovered) {
        const normalizedShown = machineNormalize(shown);
        for (const [candidate, prefix] of candidates) {
          const value = machineNormalize(candidate);
          if (value.length < 5 || !normalizedShown.includes(value)) continue;
          titleMatch = {found:true, glyph:''};
          titlePrefix = prefix;
          titleExtraction = 'text_operators';
          doiPage = true;
          readable ||= machineMostlyLetters(shown);
          break;
        }
      }
      if (!titleMatch.found && (shownDoi || metadataDoi)) {
        for (const [candidate, prefix] of candidates) {
          const variant = machineCatalogTitleVariant(shown, candidate);
          if (!variant) continue;
          titleMatch = {found:true, glyph:''};
          titlePrefix = prefix;
          titleVariant = variant;
          doiPage = shownDoi;
          doiMeta = metadataDoi;
          readable ||= machineMostlyLetters(shown);
          break;
        }
      }
    }
  }
  const titlePage = titleMatch.found;
  const titleMeta = !readable && !titlePage && machineMetaTitleMatches(page.metadata.titles, expected);
  const checks = {
    doi:doiPage ? 'page' : doiMeta ? 'metadata' : '',
    title:titlePage ? 'page' : titleMeta ? 'metadata' : '',
    readable,
    ...(titleMatch.glyph ? {titleGlyph:titleMatch.glyph} : {}),
    ...(titlePrefix ? {titlePrefix} : {}),
    ...(titleExtraction ? {titleExtraction} : {}),
    ...(titleVariant ? {titleVariant} : {})
  };
  const doiFound = doiPage || doiMeta;
  if (doiPage && titlePage) return {verdict:'ok', level:'full', checks};
  if (doiFound && titlePage) return {verdict:'ok', level:'metadata_doi', checks};
  if (doiPage && titleMeta) return {verdict:'ok', level:'metadata_title', checks};
  if (doiMeta && titleMeta) return {verdict:'ok', level:'metadata_only', checks};
  if (doiPage && !readable) return {verdict:'ok', level:'doi_only', reason:'title_not_found', checks};
  let citedPages = 0;
  if (options && options.scanAllPages && titlePage && !doiFound) {
    // Only scan later pages when page 1 read the title and missed the claimed DOI (stops at first valid match, <= 200 pages / 64 MiB).
    const later = await machineFindDoiOnLaterPages(page.ctx, doi);
    citedPages = later.citedPages || 0;
    if (later.page) return {verdict:'ok', level:'doi_later_page', checks:{...checks, doi:'later_page', doiPage:later.page, ...(citedPages ? {citedPages} : {})}};
  }
  const laterChecks = citedPages ? {...checks, citedPages} : checks;
  if (options && options.allowTitleOnly && titlePage && !titleVariant && !doiFound && matchedExpected.length >= 20 && !machineAnyDoi(page.text) && !machineAnyDoi(page.metadata.text)) {
    return {verdict:'ok', level:'title_only', checks:{...laterChecks, doi:'', doiAbsent:true}};
  }
  if (options && options.holdForeignDoi && titlePage && !doiFound && (machineAnyDoi(page.text) || machineAnyDoi(page.metadata.text))) {
    return {verdict:'ok', level:'title_mismatched_doi', hold:true, checks:{...laterChecks, foreignDoi:true}};
  }
  return {verdict:'mismatch', reason:machineFailReason(page, doiFound, titlePage || titleMeta), checks:laterChecks};
}
