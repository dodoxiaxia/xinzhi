"""Exercise a complete offline build and manual-package preflight with synthetic data."""
import contextlib
import datetime
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_public as builder
from package_release import PUBLIC, public_payloads


def synthetic_root(root):
    for folder in ('scripts', 'data', 'editorial', 'edge', 'docs'):
        (root / folder).mkdir()
    for name in ('build_public.py', 'release_integrity.py', 'enrich_metadata.py'):
        shutil.copyfile(Path(__file__).parent / name, root / 'scripts' / name)
    for name, text in {
        'index.html': '<script src="data/library.js"></script>\n<script src="app.js"></script>',
        'app.js': '// synthetic application', 'style.css': 'body{color:black}',
        'icon.svg': '<svg></svg>', 'edge/_worker.js': '// synthetic worker',
    }.items():
        (root / name).write_text(text)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for name, data in {
        'data/candidates.json': {'updatedAt': now, 'items': []},
        'data/library.json': {'papers': []},
        'data/source-health.json': {'checkedAt': now, 'sources': []},
        'editorial/source_checked_drafts.json': {'articles': []},
    }.items():
        (root / name).write_text(json.dumps(data))


class ReleaseBuildTests(unittest.TestCase):
    def test_build_receipt_packages_fresh_inputs_and_rejects_changed_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            synthetic_root(root)
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            self.assertEqual(set(public_payloads(root)), PUBLIC)
            manifest = json.loads((root / 'docs/public-manifest.json').read_text())
            self.assertEqual(manifest['release'], builder.RELEASE)
            self.assertIsNotNone(manifest['buildProvenance']['inputs']['data/curated-archive.json'])
            # Provenance stays private in docs, outside the six-file public bundle.
            self.assertNotIn(b'buildProvenance', (root / 'public/public.js').read_bytes())
            for name in ('app.js', 'data/candidates.json', 'editorial/source_checked_drafts.json'):
                with self.subTest(input=name):
                    file = root / name
                    before = file.read_bytes()
                    file.write_bytes(before + b' ')
                    with self.assertRaisesRegex(ValueError, 'provenance'):
                        public_payloads(root)
                    file.write_bytes(before)

    def test_archive_update_during_output_writes_is_preserved_and_build_fails(self):
        for existed in (False, True):
            with self.subTest(existed=existed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                synthetic_root(root)
                archive = root / 'data/curated-archive.json'
                if existed:
                    archive.write_text('{"papers":[]}')
                receipt = root / 'docs/public-manifest.json'
                receipt.write_text('previous receipt')
                update = b'{"papers":[],"concurrent_update":"preserved"}'
                original = Path.write_bytes

                def update_during_write(path, content):
                    if path == root / 'public/index.html':
                        original(archive, update)
                    return original(path, content)

                with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), patch.object(Path, 'write_bytes', update_during_write), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(ValueError, 'changed before archive rewrite'):
                        builder.main()
                self.assertEqual(archive.read_bytes(), update)
                self.assertEqual(receipt.read_text(), 'previous receipt')
                self.assertEqual(list((root / 'data').glob('.curated-archive.json-*')), [])

    def test_replaced_public_output_is_not_blessed_by_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            synthetic_root(root)
            receipt = root / 'docs/public-manifest.json'
            receipt.write_text('previous receipt')
            original = Path.write_text

            def replace_during_local_write(path, text, *args, **kwargs):
                if path == root / 'data/curated.js':
                    original(root / 'public/public.js', '// concurrent replacement')
                return original(path, text, *args, **kwargs)

            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), patch.object(Path, 'write_text', replace_during_local_write), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, 'Public output changed'):
                    builder.main()
            self.assertEqual(receipt.read_text(), 'previous receipt')


if __name__ == '__main__':
    unittest.main()
