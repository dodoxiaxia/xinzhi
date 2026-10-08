"""Exercise a complete offline build and manual-package preflight with synthetic data."""
import contextlib
import datetime
import io
import json
import multiprocessing
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_public as builder
import apply_public_library as snapshot_apply
import sync_public_library as library_sync
from package_release import PUBLIC, public_payloads
from public_library_test_fixture import write_public_library_fixture
from public_assets import read_payloads, exchange_directories


def synthetic_root(root):
    for folder in ('scripts', 'data', 'editorial', 'edge', 'docs', 'config'):
        (root / folder).mkdir()
    for name in ('public_assets.py', 'public_data_bundle.py', 'build_public.py', 'release_integrity.py', 'enrich_metadata.py',
                 'editorial_review.py', 'refresh_feeds.py', 'build_data.py', 'source_fallbacks.py',
                 'publication_dates.py', 'journal_metrics.py'):
        shutil.copyfile(Path(builder.__file__).parent / name, root / 'scripts' / name)
    for module in (snapshot_apply, library_sync):
        source = Path(module.__file__)
        shutil.copyfile(source, root / 'scripts' / source.name)
    shutil.copyfile(Path(builder.__file__).parents[1] / 'editorial/legacy_published_guides.json',
                    root / 'editorial/legacy_published_guides.json')
    shutil.copyfile(Path(builder.__file__).parents[1] / 'config/public_library_adjudications.json',
                    root / 'config/public_library_adjudications.json')
    shutil.copyfile(Path(builder.__file__).parents[1] / 'config/journal-metrics.json',
                    root / 'config/journal-metrics.json')
    shutil.copyfile(Path(builder.__file__).parents[1] / 'journal-metrics.js',
                    root / 'journal-metrics.js')
    shutil.copyfile(Path(builder.__file__).parents[1] / 'citation-export.js', root / 'citation-export.js')
    shutil.copyfile(Path(builder.__file__).parents[1] / 'public-data-loader.js', root / 'public-data-loader.js')
    shutil.copyfile(Path(builder.__file__).parents[1] / 'edge/public-static-assets.js', root / 'edge/public-static-assets.js')
    shutil.copyfile(Path(builder.__file__).parent / 'public_data_bundle.py', root / 'scripts/public_data_bundle.py')
    for name, text in {
        'index.html': '<script src="data/library.js"></script>\n<script src="app.js"></script>',
        'app.js': '// synthetic application', 'style.css': 'body{color:black}',
        'icon.svg': '<svg></svg>', 'edge/_worker.js': 'const PDF_LIBRARY = {}; const DOI_ADJUDICATIONS = {}; // synthetic worker',
    }.items():
        (root / name).write_text(text)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for name, data in {
        'data/candidates.json': {'updatedAt': now, 'items': []},
        'data/source-health.json': {'checkedAt': now, 'sources': []},
        'editorial/source_checked_drafts.json': {'articles': []},
    }.items():
        (root / name).write_text(json.dumps(data))
    write_public_library_fixture(root)


class ReleaseBuildTests(unittest.TestCase):
    def test_build_receipt_packages_fresh_inputs_and_rejects_changed_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            synthetic_root(root)
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            self.assertTrue(PUBLIC.issubset(public_payloads(root)))
            self.assertIn('public-data-manifest.json', public_payloads(root))
            self.assertIn(b'root.CITATION_EXPORT = api', (root / 'public/public.js').read_bytes())
            self.assertNotIn(b'citation-export.js', (root / 'public/index.html').read_bytes())
            manifest = json.loads((root / 'docs/public-manifest.json').read_text())
            self.assertEqual(manifest['release'], builder.RELEASE)
            self.assertIsNotNone(manifest['buildProvenance']['inputs']['data/curated-archive.json'])
            # Provenance stays private in docs, outside the six-file public bundle.
            self.assertNotIn(b'buildProvenance', (root / 'public/public.js').read_bytes())
            for name in ('app.js', 'citation-export.js', 'data/candidates.json', 'editorial/source_checked_drafts.json',
                         'config/public_library_adjudications.json',
                         'editorial/public_library_snapshot.json',
                         'editorial/public_library_snapshot_manifest.json'):
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
                    if path.name == 'index.html' and path.parent.name.startswith('.public-stage-'):
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
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            receipt = root / 'docs/public-manifest.json'
            receipt.write_text('previous receipt')
            original = Path.write_text

            def replace_during_local_write(path, text, *args, **kwargs):
                if path == root / 'data/curated.js':
                    original(root / 'public/public.js', '// concurrent replacement')
                return original(path, text, *args, **kwargs)

            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), patch.object(Path, 'write_text', replace_during_local_write), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, 'Public outputs changed'):
                    builder.main()
            self.assertEqual(receipt.read_text(), 'previous receipt')

    def test_static_a_to_b_process_interruption_keeps_valid_tree_and_retry_recovers(self):
        from test_public_data_bundle import fixture
        # Exercise an actual process exit, so neither finally cleanup nor normal
        # exception recovery is responsible for keeping the public tree intact.
        for point in ('shard_write', 'after_exchange'):
            with self.subTest(point=point), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); synthetic_root(root); dest = root / 'public'
                radar = fixture()['RADAR']
                with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', dest), patch.object(builder, 'make_radar', return_value=radar), contextlib.redirect_stdout(io.StringIO()):
                    builder.main()
                    before = read_payloads(dest)
                    receipt = (root / 'docs/public-manifest.json').read_bytes()
                    (root / 'app.js').write_text('// static release B')

                    def interrupted_build():
                        original_write = Path.write_bytes
                        def write(path, content):
                            result = original_write(path, content)
                            if path.parent.name == 'public-data': os._exit(74)
                            return result
                        def exchange(left, right):
                            exchange_directories(left, right); os._exit(74)
                        target = patch.object(Path, 'write_bytes', write) if point == 'shard_write' else patch('public_assets.exchange_directories', exchange)
                        with target: builder.main()

                    process = multiprocessing.get_context('fork').Process(target=interrupted_build)
                    process.start(); process.join(timeout=10)
                    if process.is_alive(): process.kill(); process.join(); self.fail('Interrupted build did not exit')
                    self.assertEqual(process.exitcode, 74)
                    after = read_payloads(dest)
                    if point == 'shard_write': self.assertEqual(after, before)
                    else: self.assertNotEqual(after, before)  # Complete B already visible.
                    self.assertEqual((root / 'docs/public-manifest.json').read_bytes(), receipt)
                    builder.main()
                    recovered = read_payloads(dest)
                    self.assertNotEqual(recovered, before)
                    self.assertEqual(len(recovered), 10)
                    self.assertTrue(PUBLIC.issubset(public_payloads(root)))

    def test_atomic_exchange_failure_leaves_previous_static_release_intact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); synthetic_root(root); dest = root / 'public'
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', dest), contextlib.redirect_stdout(io.StringIO()):
                builder.main(); before = read_payloads(dest)
                receipt = (root / 'docs/public-manifest.json').read_bytes()
                (root / 'app.js').write_text('// release B')
                with patch('public_assets.exchange_directories', side_effect=OSError('unsupported filesystem')):
                    with self.assertRaisesRegex(OSError, 'unsupported filesystem'): builder.main()
                self.assertEqual(read_payloads(dest), before)
                self.assertEqual((root / 'docs/public-manifest.json').read_bytes(), receipt)
                builder.main()
                self.assertNotEqual(read_payloads(dest), before)


if __name__ == '__main__':
    unittest.main()
