"""Offline: the R2 backfill check is read-only, compares SHA-256 and has no write path. Synthetic files only.
The name starts with test_muse so the verify-muse job (python3 -m unittest discover -p 'test_muse*.py') runs it."""
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import r2_backfill_check as tool  # noqa: E402

PDF_A = b'%PDF-1.7\nsynthetic A\n' + b'a' * 100 + b'\n%%EOF\n'
PDF_B = b'%PDF-1.7\nsynthetic B\n' + b'b' * 100 + b'\n%%EOF\n'
sha = lambda data: hashlib.sha256(data).hexdigest()


def snapshot(directory):
    return {p.relative_to(directory).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns, stat.S_IMODE(p.stat().st_mode)) for p in sorted(Path(directory).rglob('*')) if p.is_file()}


class BackfillCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'pdfs' / 'sub').mkdir(parents=True)
        (self.root / 'pdfs' / 'a.pdf').write_bytes(PDF_A)
        (self.root / 'pdfs' / 'sub' / 'b.pdf').write_bytes(PDF_B)
        self.dir = str(self.root / 'pdfs')

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *args):
        out = io.StringIO()
        code = tool.main(list(args), out)
        return code, out.getvalue()

    def expected_file(self, lines):
        path = self.root / 'expected.txt'
        path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        return str(path)

    def test_matching_digests_pass(self):
        expected = self.expected_file(['# comment', sha(PDF_A) + '  a.pdf', '', sha(PDF_B) + '  sub/b.pdf'])
        code, text = self.run_tool('--dir', self.dir, '--expected', expected)
        self.assertEqual(code, 0, text)
        self.assertIn('ok=2', text)
        self.assertIn('read-only', text)

    def test_mismatch_missing_and_non_pdf_fail(self):
        (self.root / 'pdfs' / 'page.pdf').write_bytes(b'<html>not a pdf</html>')
        expected = self.expected_file([sha(PDF_B) + '  a.pdf', sha(PDF_B) + '  sub/b.pdf', sha(PDF_A) + '  gone.pdf'])
        code, text = self.run_tool('--dir', self.dir, '--expected', expected, '--json')
        report = json.loads(text)
        self.assertEqual(code, 1)
        status = {row['file']: row['status'] for row in report['files']}
        self.assertEqual(status['a.pdf'], 'mismatch')
        self.assertEqual(status['sub/b.pdf'], 'ok')
        self.assertEqual(status['page.pdf'], 'not_pdf')
        self.assertEqual(report['missing'], ['gone.pdf'])
        mismatch = next(row for row in report['files'] if row['file'] == 'a.pdf')
        self.assertEqual(mismatch['expected'], sha(PDF_B))
        self.assertEqual(mismatch['sha256'], sha(PDF_A))

    def test_unexpected_file_is_reported_but_is_not_a_failure(self):
        expected = self.expected_file([sha(PDF_A) + '  a.pdf'])
        code, text = self.run_tool('--dir', self.dir, '--expected', expected, '--json')
        report = json.loads(text)
        self.assertEqual(code, 0)
        self.assertEqual({row['file']: row['status'] for row in report['files']}['sub/b.pdf'], 'unexpected')

    def test_r2_listing_separates_done_from_to_archive(self):
        listing = self.root / 'keys.txt'
        listing.write_text(tool.r2_key(sha(PDF_A)) + '\n', encoding='utf-8')
        code, text = self.run_tool('--dir', self.dir, '--r2-keys', str(listing), '--json')
        report = json.loads(text)
        self.assertEqual(code, 0)
        status = {row['file']: row for row in report['files']}
        self.assertEqual(status['a.pdf']['status'], 'already_in_r2')
        self.assertEqual(status['sub/b.pdf']['status'], 'to_archive')
        self.assertEqual(status['sub/b.pdf']['key'], 'pdf/sha256/' + sha(PDF_B) + '.pdf')
        self.assertRegex(status['sub/b.pdf']['key'], r'^pdf/sha256/[a-f0-9]{64}\.pdf$')

    def test_never_writes_to_the_checked_folder(self):
        before = snapshot(self.dir)
        expected = self.expected_file([sha(PDF_A) + '  a.pdf'])
        self.run_tool('--dir', self.dir, '--expected', expected)
        self.run_tool('--dir', self.dir)
        self.assertEqual(snapshot(self.dir), before)
        # A read-only folder and read-only files are enough for it to work.
        for p in Path(self.dir).rglob('*'):
            os.chmod(p, 0o555 if p.is_dir() else 0o444)
        try:
            self.assertEqual(self.run_tool('--dir', self.dir)[0], 0)
        finally:
            for p in sorted(Path(self.dir).rglob('*'), reverse=True):
                os.chmod(p, 0o755 if p.is_dir() else 0o644)

    def test_bad_arguments(self):
        err = io.StringIO()
        real = sys.stderr
        sys.stderr = err
        try:
            self.assertEqual(self.run_tool('--dir', str(self.root / 'nope'))[0], 2)
            bad = self.expected_file(['not a digest line'])
            self.assertEqual(self.run_tool('--dir', self.dir, '--expected', bad)[0], 2)
            dup = self.expected_file([sha(PDF_A) + '  a.pdf', sha(PDF_A) + '  a.pdf'])
            self.assertEqual(self.run_tool('--dir', self.dir, '--expected', dup)[0], 2)
        finally:
            sys.stderr = real

    def test_source_has_no_write_or_network_path(self):
        source = (Path(__file__).resolve().parent / 'r2_backfill_check.py').read_text(encoding='utf-8')
        code = re.sub(r'""".*?"""', '', source, count=1, flags=re.S)
        for forbidden in ('socket', 'urllib', 'http.client', 'requests', 'boto', 'subprocess', 'wrangler', 'os.system', 'shutil',
                          'write_text', 'write_bytes', 'os.remove', 'os.rename', 'unlink', 'rmtree', 'PDF_ARCHIVE', 'CLOUDFLARE', 'Authorization'):
            self.assertNotIn(forbidden, code, forbidden)
        for mode in re.findall(r"open\([^)]*?,\s*'([^']*)'", code):
            self.assertEqual(mode, 'rb')
        self.assertEqual(len(re.findall(r'\bopen\(', code)), 1)


if __name__ == '__main__':
    unittest.main()
