// ==== edge/src/04a-machine-pdf.js · First-page identity check for machine uploads ====
// A deliberately small PDF reader that only needs Workers APIs (DecompressionStream, TextDecoder).
// It is a gate in front of the independent GitHub dual-parser verification, never a replacement for it.
// Every way it can fail to read a page leaves a short internal reason code (no PDF content) so a 409
// says why: inflate_failed, objstm_unsupported, page_tree_not_found, contents_not_found, filter_unsupported,
// page_text_empty, doi_not_found, title_not_found, identity_mismatch, title_too_short.
const MACHINE_INFLATE_MAX = 16 * 1024 * 1024;
const MACHINE_READABLE_MIN_LETTERS = 20;
const MACHINE_READABLE_MIN_RATIO = 0.5;
function machineNormalize(value) {
  const stripped = String(value || '').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '');
  let out = '';
  for (const char of stripped) {
    const code = char.codePointAt(0);
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code > 127) out += char;
  }
  return out;
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
async function machineInflateOnce(bytes) {
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
      if (size > MACHINE_INFLATE_MAX) { error = 'too_large'; pdfCancel(reader); break; }
      chunks.push(item.value);
    }
  } catch (caught) { error = String(caught && (caught.code || caught.name) || 'inflate_error'); }
  const out = new Uint8Array(Math.min(size, MACHINE_INFLATE_MAX));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk.subarray(0, Math.max(0, out.length - offset)), offset); offset += chunk.byteLength; }
  return {bytes:out, error};
}
async function machineInflate(raw, notes) {
  if (typeof DecompressionStream !== 'function') { notes.add('inflate_failed'); return null; }
  const first = await machineInflateOnce(raw);
  if (!first.error) return first.bytes;
  if (first.error !== 'too_large' && first.bytes.length) { notes.add('inflate_tolerated'); return first.bytes; }
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
  const text = machineLatin1(bytes), index = new Map(), pattern = /(?<![0-9])(\d{1,10})\s+\d{1,5}\s+obj\b/g;
  let match;
  while ((match = pattern.exec(text))) index.set(Number(match[1]), match.index + match[0].length);
  return {text, index, packed:null, cache:new Map(), notes:new Set()};
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
async function machineStreamParts(ctx, body) {
  const marker = /(?<!end)stream(?:\r\n|\n|\r)/.exec(body);
  if (!marker) return null;
  const dict = body.slice(0, marker.index), start = marker.index + marker[0].length;
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
async function machineStreamBytes(ctx, body) {
  const parts = await machineStreamParts(ctx, body);
  if (!parts) return null;
  let bytes = machineBytes(parts.raw);
  for (const filter of machineFilters(parts.dict)) {
    if (filter !== 'FlateDecode' && filter !== 'Fl') { ctx.notes.add('filter_unsupported'); return null; }
    bytes = await machineInflate(bytes, ctx.notes);
    if (!bytes) return null;
    const predictor = machineIntValue(parts.dict, 'Predictor');
    if (predictor >= 10) bytes = machinePngPredictor(bytes, machineIntValue(parts.dict, 'Columns') || 1, machineIntValue(parts.dict, 'Colors') || 1, machineIntValue(parts.dict, 'BitsPerComponent') || 8);
    else if (predictor > 1) { ctx.notes.add('filter_unsupported'); return null; }
  }
  return bytes;
}
async function machinePackedObjects(ctx) {
  if (ctx.packed) return ctx.packed;
  ctx.packed = new Map();
  for (const [id, start] of ctx.index) {
    if (!/\/Type\s*\/ObjStm\b/.test(ctx.text.slice(start, start + 400))) continue;
    const body = machineTopBody(ctx, id), parts = await machineStreamParts(ctx, body);
    const count = parts && machineIntValue(parts.dict, 'N'), first = parts && machineIntValue(parts.dict, 'First');
    const bytes = parts && count !== null && first !== null ? await machineStreamBytes(ctx, body) : null;
    if (!bytes) { ctx.notes.add('objstm_unsupported'); continue; }
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
  return {width:width || (type0 ? 2 : 1), map};
}
async function machinePageFonts(ctx, page) {
  const fonts = new Map();
  const resources = await machinePageInherited(ctx, page, 'Resources');
  let table = machineDictValue(resources, 'Font');
  if (!table && machineRefValue(resources, 'Font')) table = await machineBody(ctx, machineRefValue(resources, 'Font')) || '';
  for (const entry of table.matchAll(/\/([^\s/\[\]<>()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const body = await machineBody(ctx, entry[2]), unicodeId = body && machineRefValue(body, 'ToUnicode');
    if (!unicodeId) continue;
    const stream = await machineBody(ctx, unicodeId), bytes = stream && await machineStreamBytes(ctx, stream);
    if (bytes) fonts.set(entry[1], machineParseCmap(machineLatin1(bytes), /\/Subtype\s*\/Type0\b/.test(body)));
  }
  return fonts;
}
function machineMapCodes(font, bytes) {
  if (!font) return bytes;
  let out = '';
  for (let at = 0; at + font.width <= bytes.length; at += font.width) {
    let code = 0;
    for (let n = 0; n < font.width; n++) code = code * 256 + bytes.charCodeAt(at + n);
    out += font.map.get(code) || '';
  }
  return out;
}
// Walks the operators of a content stream and decodes Tj / TJ / ' / " strings through the current font's ToUnicode map.
function machineDecodeFontText(content, fonts) {
  if (!fonts.size) return '';
  let out = '', font = null, name = '', last = null, array = null;
  const length = content.length, delimiters = /[\s()<>\[\]{}\/%]/;
  const escapes = {n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'};
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
      const text = machineHexBytes(content.slice(at + 1, end < 0 ? length : end));
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
      else if (token === 'Tj' || token === "'" || token === '"') { if (last !== null) out += machineMapCodes(font, last); last = null; }
      else if (token === 'TJ') {
        for (const part of array || []) out += part === null ? ' ' : machineMapCodes(font, part);
        array = null; last = null;
      } else if (['Td', 'TD', 'T*', 'Tm'].includes(token)) out += ' ';
      else if (token === 'ET') out += '\n';
      else if (token === 'BI') { const stop = content.indexOf('EI', at); at = stop < 0 ? length : stop + 2; }
    }
  }
  return out;
}
function machinePdfStringValue(text, key) {
  const match = new RegExp('/' + key + '(?![A-Za-z0-9_])\\s*([(<])').exec(text);
  if (!match) return '';
  let at = match.index + match[0].length, value = '';
  if (match[1] === '<') {
    const end = text.indexOf('>', at);
    value = machineHexBytes(text.slice(at, end < 0 ? text.length : end));
  } else {
    let depth = 1;
    for (; at < text.length && depth; at++) {
      const c = text[at];
      if (c === '\\') { value += text[at + 1] || ''; at++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (!depth) break; }
      value += c;
    }
  }
  if (value.startsWith('\xfe\xff')) { let out = ''; for (let n = 2; n + 1 < value.length; n += 2) out += String.fromCharCode(value.charCodeAt(n) * 256 + value.charCodeAt(n + 1)); return out; }
  if (value.startsWith('\xef\xbb\xbf')) { try { return new TextDecoder().decode(machineBytes(value.slice(3))); } catch { return value; } }
  return value;
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
  const infos = [...ctx.text.matchAll(/\/Info\s+(\d+)\s+\d+\s+R/g)], infoBody = infos.length ? await machineBody(ctx, infos[infos.length - 1][1]) : null;
  if (infoBody) {
    const title = machinePdfStringValue(infoBody, 'Title');
    if (title) titles.push(title);
    for (const key of ['Subject', 'Keywords', 'Title', 'Author', 'doi', 'DOI']) text += machinePdfStringValue(infoBody, key) + '\n';
  }
  const roots = [...ctx.text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)], catalog = roots.length ? await machineBody(ctx, roots[roots.length - 1][1]) : null;
  const xmpId = catalog && machineRefValue(catalog, 'Metadata'), xmpBody = xmpId && await machineBody(ctx, xmpId);
  const xmpBytes = xmpBody && await machineStreamBytes(ctx, xmpBody);
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
  const bytes = await machineStreamBytes(ctx, body);
  return bytes ? machineLatin1(bytes) : null;
}
// What the first page says. `strings` is the readable part (used to judge whether text could be read at all).
async function machineFirstPage(bytes) {
  const ctx = machinePdfContext(bytes), notes = ctx.notes;
  const page = await machineFirstPageObject(ctx);
  let strings = '', raw = '', decoded = '';
  if (page) {
    const ids = await machineContentIds(ctx, page.body);
    if (!ids.length) notes.add('contents_not_found');
    const fonts = await machinePageFonts(ctx, page.body);
    for (const id of ids) {
      const content = await machineContentText(ctx, id);
      if (content === null) { if (!notes.has('inflate_failed') && !notes.has('filter_unsupported') && !notes.has('objstm_unsupported')) notes.add('contents_not_found'); continue; }
      strings += machinePdfStrings(content);
      raw += '\n' + content;
      decoded += machineDecodeFontText(content, fonts) + '\n';
    }
  }
  const metadata = await machineMetadata(ctx);
  // Real text is mostly letters; glyph ids of a custom encoding come out as control and high bytes.
  const mostlyLetters = value => { const shown = value.replace(/\s/g, ''), letters = shown.replace(/[^A-Za-z]/g, '').length; return letters >= MACHINE_READABLE_MIN_LETTERS && letters >= shown.length * MACHINE_READABLE_MIN_RATIO; };
  return {text:strings + '\n' + decoded + raw, readable:mostlyLetters(strings) || mostlyLetters(decoded), metadata, notes};
}
function machineDoiPresent(text, doi) {
  const escaped = [...doi].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  return new RegExp('(?<![A-Za-z0-9])' + escaped + '(?![A-Za-z0-9])', 'i').test(text);
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
    for (const code of ['objstm_unsupported', 'inflate_failed', 'filter_unsupported', 'page_tree_not_found', 'contents_not_found']) if (page.notes.has(code)) return code;
  }
  if (empty) return 'page_text_empty';
  if (!doiFound && !titleFound) return 'identity_mismatch';
  return doiFound ? 'title_not_found' : 'doi_not_found';
}
// {verdict:'ok'|'invalid'|'mismatch', reason, level, doi, title}. level says how strong the evidence was:
// 'full' (DOI and title both read from page 1), 'metadata_title' (DOI on page 1, title only from Info/XMP because
// the page text could not be read), 'doi_only' (DOI on page 1, title unreadable), 'metadata_only'. Anything that
// is not 'full' is still only a candidate: it waits for the independent dual-parser verification.
async function machineIdentity(bytes, doi, title) {
  const expected = machineNormalize(title);
  if (!libraryDoi(doi)) return {verdict:'invalid', reason:'doi_invalid'};
  if (expected.length < 5) return {verdict:'invalid', reason:'title_too_short'};
  const page = await machineFirstPage(bytes);
  const readable = page.readable;
  const doiPage = machineDoiPresent(page.text, doi), doiMeta = machineDoiPresent(page.metadata.text, doi);
  const titlePage = machineNormalize(page.text).includes(expected);
  const titleMeta = !readable && !titlePage && machineMetaTitleMatches(page.metadata.titles, expected);
  const checks = {doi:doiPage ? 'page' : doiMeta ? 'metadata' : '', title:titlePage ? 'page' : titleMeta ? 'metadata' : '', readable};
  const doiFound = doiPage || doiMeta;
  if (doiPage && titlePage) return {verdict:'ok', level:'full', checks};
  if (doiFound && titlePage) return {verdict:'ok', level:'metadata_doi', checks};
  if (doiPage && titleMeta) return {verdict:'ok', level:'metadata_title', checks};
  if (doiMeta && titleMeta) return {verdict:'ok', level:'metadata_only', checks};
  if (doiPage && !readable) return {verdict:'ok', level:'doi_only', reason:'title_not_found', checks};
  return {verdict:'mismatch', reason:machineFailReason(page, doiFound, titlePage || titleMeta), checks};
}
