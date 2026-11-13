"""Build-time download buttons (pdf_identity) and the Worker's handlePdf must agree on file categories.

Each case is one synthetic AI- index CSV. Python decides from the hashed snapshot whether the paper
gets a download button; node runs the real edge/_worker.js handlePdf against fixture GitHub responses
(offline, synthetic passphrase and token) and reports whether it sends a PDF and which one. Both must
match the expectation, so the two implementations of the 文件类别 rule cannot drift apart.
"""
import base64
import csv
import hashlib
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import pdf_identity as pi

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = ['题名', 'DOI', '期刊', '实际出版日期', '日期来源', '当前路径', 'SHA256']

NODE_HARNESS = r"""
const fs = require('fs'), vm = require('vm');
const { webcrypto, createHash } = require('crypto');
const input = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const original = fs.readFileSync(input.worker, 'utf8');
const source = original.replace('const PDF_LIBRARY = {};', 'const PDF_LIBRARY = ' + JSON.stringify(input.library) + ';').replace('export default {', 'globalThis.worker = {');
if (source === original) throw new Error('worker markers not found');
const blobSha = bytes => createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
const env = { PDF_DOWNLOAD_ENABLED:'true', GITHUB_LIBRARY_TOKEN:'synthetic-parity-token', PDF_DOWNLOAD_PASSPHRASE:'synthetic-parity-passphrase', PDF_GITHUB_COMMIT:'a'.repeat(40) };
const prefix = '/repos/dodoxiaxia/AI-/contents/', index = '文献索引/文献索引.csv';
(async () => {
  const out = {};
  for (const c of input.cases) {
    const fetch = async (url, init) => {
      const target = new URL(url), path = decodeURIComponent(target.pathname);
      if (target.hostname !== 'api.github.com' || !path.startsWith(prefix)) return new Response('unexpected', { status:500 });
      if (path === prefix + index) return new Response(c.csv);
      const name = path.slice(prefix.length), file = c.files[name];
      if (file === undefined) return new Response('missing', { status:404 });
      const bytes = Buffer.from(file, 'base64');
      if (init.headers.accept === 'application/vnd.github+json') return Response.json({ type:'file', path:name, size:bytes.length, sha:blobSha(bytes) });
      return new Response(bytes);
    };
    const context = vm.createContext({ btoa, URL, Response, Request, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, Uint8Array, URLSearchParams, crypto:webcrypto, fetch, console });
    vm.runInContext(source, context);
    const response = await context.worker.fetch(new Request('https://site.test/api/pdf?id=' + c.id, { method:'POST', headers:{ 'content-type':'application/x-www-form-urlencoded' }, body:new URLSearchParams({ passphrase:env.PDF_DOWNLOAD_PASSPHRASE }).toString() }), env);
    const body = Buffer.from(await response.arrayBuffer());
    out[c.id] = { status:response.status, sha256:response.status === 200 ? createHash('sha256').update(body).digest('hex') : '' };
  }
  console.log(JSON.stringify(out));
})().catch(error => { console.error(error); process.exitCode = 1; });
"""


def pdf_bytes(label):
    return ('%PDF-1.7\nparity ' + label + '\n%%EOF\n').encode('utf-8')


def row(category=None, label='main', path=None, title='Parity paper'):
    """(category or None for no cell, file label, path override, index title)."""
    return {'category': category, 'label': label, 'path': path or '期刊/2026/' + label + '.pdf', 'title': title}


# id: (paper identity, rows, with category column, label of the file that must be sent or None)
CASES = {
    'c01': ({'doi': '10.3000/c01'}, [row('补充材料', 'supp'), row('正文')], True, 'main'),
    'c02': ({'doi': '10.3000/c02'}, [row('译本', 'trans'), row('正文')], True, 'main'),
    'c03': ({'doi': '10.3000/c03'}, [row('补充材料', 'supp1'), row('正文'), row('补充材料', 'supp2')], True, 'main'),
    'c04': ({'doi': '10.3000/c04'}, [row('', 'undecided'), row('')], True, None),
    'c05': ({'doi': '10.3000/c05'}, [row('补充材料', 'supp'), row('译本', 'trans')], True, None),
    'c06': ({'doi': '10.3000/c06'}, [row('正文'), row('正文', 'other')], True, None),
    'c07': ({'doi': '10.3000/c07'}, [row('正文'), row('正文', 'main', path='期刊/2026/copy.pdf')], True, 'main'),
    'c08': ({'doi': '10.3000/c08'}, [row('补充材料')], True, None),
    'c09': ({'doi': '10.3000/c09'}, [row('正文')], True, 'main'),
    'c10': ({'doi': '10.3000/c10'}, [row('', 'undecided'), row('正文')], True, 'main'),
    'c11a': ({'doi': '10.3000/c11a'}, [row()], False, 'main'),
    'c11b': ({'doi': '10.3000/c11b'}, [row(), row()], False, 'main'),
    'c11c': ({'doi': '10.3000/c11c'}, [row(), row(None, 'other')], False, None),
    'unknown': ({'doi': '10.3000/unknown'}, [row('待定', 'pending'), row('正文')], True, 'main'),
    'trimmed': ({'doi': '10.3000/trimmed'}, [row('补充材料', 'supp'), row(' 正文 ')], True, 'main'),
    'single-blank': ({'doi': '10.3000/single-blank'}, [row('')], True, 'main'),
    'single-translation': ({'doi': '10.3000/single-translation'}, [row('译本')], True, None),
    'main-unsafe-path': ({'doi': '10.3000/main-unsafe-path'}, [row('补充材料', 'supp'), row('正文', path='../main.pdf')], True, None),
    'title-main': ({'title': 'Parity title paper'}, [row('补充材料', 'supp', title='Parity title paper'), row('正文', title='parity  TITLE paper')], True, 'main'),
    'title-supplement': ({'title': 'Parity lonely supplement'}, [row('补充材料', title='Parity lonely supplement')], True, None),
    # A DOI paper never falls back to its title, even if the title row is the main text.
    'doi-first': ({'doi': '10.3000/doi-first', 'title': 'Parity doi first'}, [row('正文', title='Parity doi first')], True, None),
}


def case_csv(case_id, identity, rows, with_category):
    out = io.StringIO()
    writer = csv.writer(out, lineterminator='\r\n')
    writer.writerow(COLUMNS + (['文件类别'] if with_category else []))
    doi = identity.get('doi', '') if case_id != 'doi-first' else '10.3000/somebody-else'
    for r in rows:
        cells = [r['title'], doi, 'fixture', '', '', r['path'], hashlib.sha256(pdf_bytes(r['label'])).hexdigest()]
        if with_category:
            cells.append(r['category'] or '')
        writer.writerow(cells)
    return '\ufeff' + out.getvalue()


class PdfCategoryParityTests(unittest.TestCase):
    def test_python_snapshot_and_worker_agree_on_downloads(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node is not installed')
        library, cases, python = {}, [], {}
        for case_id, (identity, rows, with_category, _) in CASES.items():
            library[case_id] = {'doi': identity.get('doi', ''), 'title': identity.get('title', '')}
            text = case_csv(case_id, identity, rows, with_category)
            files = {r['path']: base64.b64encode(pdf_bytes(r['label'])).decode('ascii') for r in rows if pi.safe_path(r['path'])}
            cases.append({'id': case_id, 'csv': text, 'files': files})
            paper = {'id': case_id, 'doi': identity.get('doi', ''), 'title': identity.get('title', '')}
            snapshot = pi.build_snapshot(pi.read_index_csv(text.encode('utf-8')))
            python[case_id] = pi.downloadable_ids([paper], snapshot) == [case_id]
        with tempfile.TemporaryDirectory() as d:
            spec = Path(d) / 'cases.json'
            spec.write_text(json.dumps({'worker': str(ROOT / 'edge/_worker.js'), 'library': library, 'cases': cases}, ensure_ascii=False), encoding='utf-8')
            result = subprocess.run([node, '-e', NODE_HARNESS, str(spec)], capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        worker = json.loads(result.stdout)
        for case_id, (_, _, _, want) in CASES.items():
            with self.subTest(case=case_id):
                sent = worker[case_id]['status'] == 200
                self.assertEqual(python[case_id], sent, 'Python button and Worker download disagree')
                self.assertEqual(sent, want is not None, worker[case_id])
                if want:
                    self.assertEqual(worker[case_id]['sha256'], hashlib.sha256(pdf_bytes(want)).hexdigest(), 'Worker sent the wrong file')
                else:
                    self.assertIn(worker[case_id]['status'], (404, 409, 502), worker[case_id])


if __name__ == '__main__':
    unittest.main()
