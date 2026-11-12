'use strict';
// Synthetic PDFs that reproduce, byte structure by byte structure, what three genuine publisher originals do to the
// site's first-page identity check. Every DOI, title and word here is invented; no publisher content is used.
// `node scripts/machine_identity_fixtures.cjs` rewrites scripts/fixtures/machine-identity/*.pdf (deterministic).
const zlib = require('zlib'), fs = require('fs'), path = require('path');
const PAD_TO = 52000;
const latin1 = text => Buffer.from(text, 'latin1');
function pad(chunks) {
  // The site refuses uploads under 50 KiB: pad with comment lines that carry no identity text.
  let size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (size < PAD_TO) chunks.push(latin1('% ' + 'filler '.repeat(Math.ceil((PAD_TO - size) / 7)).slice(0, PAD_TO - size - 3) + '\n'));
  return chunks;
}
function assemble(parts) {
  // parts: array of {id, head, body?} → top-level objects; returns Buffer. Offsets are tracked for the optional xref table.
  const chunks = [latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')], offsets = new Map();
  let size = chunks[0].length;
  for (const part of parts) {
    offsets.set(part.id, size);
    const chunk = Buffer.concat([latin1(part.id + ' 0 obj\n' + part.head), part.body || Buffer.alloc(0), latin1('endobj\n')]);
    chunks.push(chunk); size += chunk.length;
  }
  return {chunks, offsets, size};
}
function stream(dict, data, eol = '\n') {
  return {head:'<< ' + dict + ' /Length ' + data.length + ' >>\nstream\n', body:Buffer.concat([data, latin1(eol + 'endstream\n')])};
}
function finish(built, trailer, tail = '') {
  const chunks = pad(built.chunks);
  chunks.push(latin1(tail + 'startxref\n0\n%%EOF\n'));
  return Buffer.concat(chunks);
}
const escapeText = value => String(value).replace(/[\\()]/g, ch => '\\' + ch);
function textContent(doi, title) {
  return '1 0 0 1 72 720 Tm /F1 12 Tf (' + escapeText('Synthetic Journal of Imaginary Medicine. doi:' + doi) + ') Tj 0 -24 Td (' + escapeText(title) + ') Tj';
}
// A: FlateDecode content stream with an end-of-line between the compressed data and "endstream".
// The EOL is not part of /Length, but a reader that cuts at "endstream" hands it to inflate, which throws on trailing bytes.
function flateEol({doi, title, eol = '\n', lengthWrong = false}) {
  const content = zlib.deflateSync(latin1('BT ' + textContent(doi, title) + ' ET\n'));
  const parts = [
    {id:1, head:'<< /Type /Catalog /Pages 2 0 R >>\n'},
    {id:2, head:'<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n'},
    {id:3, head:'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\n'},
    {id:4, ...stream('/Filter /FlateDecode', content, eol)},
    {id:5, head:'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n'}
  ];
  if (lengthWrong) parts[3].head = parts[3].head.replace('/Length ' + content.length, '/Length ' + (content.length + 7));
  return finish(assemble(parts), '', 'trailer\n<< /Size 6 /Root 1 0 R >>\n');
}
// B: the catalog, page tree and page live inside /ObjStm; the cross-reference is an /XRef stream (no "trailer", no "N 0 obj" for the page).
function objStm({doi, title, predictor = false}) {
  const packed = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>']
  ];
  let header = '', body = '';
  for (const [id, text] of packed) { header += id + ' ' + body.length + ' '; body += text + '\n'; }
  let stored = latin1(header + body);
  if (predictor) {
    // PNG "Up" predictor over 8-byte rows, as some producers write object streams.
    const width = 8, rows = Math.ceil(stored.length / width), padded = Buffer.alloc(rows * width, 0x20);
    stored.copy(padded);
    const out = Buffer.alloc(rows * (width + 1));
    for (let r = 0; r < rows; r++) {
      out[r * (width + 1)] = 2;
      for (let c = 0; c < width; c++) out[r * (width + 1) + 1 + c] = (padded[r * width + c] - (r ? padded[(r - 1) * width + c] : 0)) & 255;
    }
    stored = out;
  }
  const objectStream = zlib.deflateSync(stored), content = zlib.deflateSync(latin1('BT ' + textContent(doi, title) + ' ET\n'));
  const parts = [
    {id:5, ...stream('/Type /ObjStm /N 3 /First ' + header.length + ' /Filter /FlateDecode' + (predictor ? ' /DecodeParms << /Predictor 12 /Columns 8 >>' : ''), objectStream)},
    {id:4, ...stream('/Filter /FlateDecode', content)},
    {id:6, head:'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n'}
  ];
  const built = assemble(parts);
  // XRef stream: /W [1 3 1]; entries for objects 0..7 (type 2 = inside object stream 5, type 1 = file offset).
  const rows = [];
  const entry = (type, a, b) => Buffer.from([type, (a >> 16) & 255, (a >> 8) & 255, a & 255, b]);
  rows.push(entry(0, 0, 255));
  rows.push(entry(2, 5, 0), entry(2, 5, 1), entry(2, 5, 2), entry(1, built.offsets.get(4), 0), entry(1, built.offsets.get(5), 0), entry(1, built.offsets.get(6), 0));
  rows.push(entry(1, built.size, 0));
  const xref = zlib.deflateSync(Buffer.concat(rows));
  const chunk = Buffer.concat([latin1('7 0 obj\n<< /Type /XRef /Size 8 /W [1 3 1] /Root 1 0 R /Filter /FlateDecode /Length ' + xref.length + ' >>\nstream\n'), xref, latin1('\nendstream\nendobj\n')]);
  built.chunks.push(chunk);
  return finish(built, '');
}
// C: custom font encoding. The title is shown with 2-byte glyph ids of an Identity-H Type0 font, so the content stream holds no ASCII title.
// Only the font's ToUnicode CMap (when present) and the XMP / Info title say what the glyphs spell. The DOI is plain ASCII.
function customEncoding({doi, title, toUnicode = true, xmpTitle = '', infoTitle = ''}) {
  const alphabet = [...new Set([...title])].sort(), glyph = new Map(alphabet.map((ch, n) => [ch, 0x0100 + n * 3]));
  const hex = code => code.toString(16).toUpperCase().padStart(4, '0');
  const shown = '<' + [...title].map(ch => hex(glyph.get(ch))).join('') + '>';
  let cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
  cmap += alphabet.length + ' beginbfchar\n' + alphabet.map(ch => '<' + hex(glyph.get(ch)) + '> <' + hex(ch.codePointAt(0)) + '>').join('\n') + '\nendbfchar\nendcmap end end\n';
  const content = zlib.deflateSync(latin1('BT /F1 9 Tf 1 0 0 1 72 760 Tm (doi:' + escapeText(doi) + ') Tj /F2 14 Tf 0 -30 Td [' + shown + '] TJ ET\n'));
  const xmp = '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + (xmpTitle ? '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">' + xmpTitle.replace(/&/g, '&amp;') + '</rdf:li></rdf:Alt></dc:title>' : '') + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const parts = [
    {id:1, head:'<< /Type /Catalog /Pages 2 0 R' + (xmpTitle ? ' /Metadata 9 0 R' : '') + ' >>\n'},
    {id:2, head:'<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n'},
    {id:3, head:'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>\n'},
    {id:4, ...stream('/Filter /FlateDecode', content)},
    {id:5, head:'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n'},
    {id:6, head:'<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+SyntheticSans /Encoding /Identity-H /DescendantFonts [7 0 R]' + (toUnicode ? ' /ToUnicode 8 0 R' : '') + ' >>\n'},
    {id:7, head:'<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+SyntheticSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>\n'},
    {id:8, ...stream('/Filter /FlateDecode', zlib.deflateSync(latin1(cmap)))}
  ];
  if (xmpTitle) parts.push({id:9, ...stream('/Type /Metadata /Subtype /XML', Buffer.from(xmp, 'utf8'))});
  if (infoTitle) parts.push({id:10, head:'<< /Title (' + escapeText(infoTitle) + ') >>\n'});
  return finish(assemble(parts), '', 'trailer\n<< /Size 11 /Root 1 0 R' + (infoTitle ? ' /Info 10 0 R' : '') + ' >>\n');
}
const samples = {
  flate: {doi:'10.9999/synthetic.flate', title:'Synthetic trailing newline after compressed page content in an imaginary cohort'},
  objstm: {doi:'10.9999/synthetic.objstm', title:'Synthetic page tree stored inside an object stream of an imaginary registry'},
  custom: {doi:'10.9999/synthetic.enc', title:'Synthetic custom glyph encoding recovered through a unicode map'}
};
function files() {
  return {
    'flate-eol-before-endstream.pdf':flateEol(samples.flate),
    'objstm-xref-stream.pdf':objStm(samples.objstm),
    'custom-encoding-tounicode.pdf':customEncoding(samples.custom)
  };
}
module.exports = {flateEol, objStm, customEncoding, samples, files, directory:path.join(__dirname, 'fixtures/machine-identity')};
if (require.main === module) {
  fs.mkdirSync(module.exports.directory, {recursive:true});
  for (const [name, bytes] of Object.entries(files())) fs.writeFileSync(path.join(module.exports.directory, name), bytes);
  console.log('machine identity fixtures written');
}
