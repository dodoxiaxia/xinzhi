"""Synthetic PDFs only; no network, production state, or model calls."""
import contextlib
from datetime import timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import build_public as builder
import daily_fulltext as daily
import deep_reading_input as pdf
import save_state
from test_daily_fulltext import WHEN, output, paper, xml
from test_release_build import synthetic_root

BODY = ('The study included 120 patients with cardiovascular disease and assessed clinical outcomes prospectively. '
        'The independent research team recorded clinically important observations and described the sampling '
        'strategy and limits of inference for the study population in detail. Additional methods are described '
        'to contextualize comparison groups and clinical interpretation. ')
PRIVATE_MARK = 'synthetic_UNPUBLISHED_paragraph_marker'


def synthetic_pdf(*, doi=None, title=None, header='Introduction', pages=2, doi_on_page_two=False, abstract=''):
    import pymupdf
    article = paper()
    doi = article['doi'] if doi is None else doi
    title = article['title'] if title is None else title
    with pymupdf.open() as doc:
        for i in range(pages):
            page = doc.new_page()
            if i == 0:
                page.insert_text((40, 40), title, fontsize=14)
            if i == int(doi_on_page_two):
                page.insert_text((40, 75), 'DOI: ' + doi)
            if i == 0:
                if abstract:
                    page.insert_text((40, 110), abstract, fontsize=14)
                page.insert_text((40, 140 if abstract else 110), header, fontsize=14)
            if i < 2:
                for y in (175, 290, 405, 520):
                    assert page.insert_textbox((40, y, 550, y + 100), BODY + PRIVATE_MARK, fontsize=11) > 0
        return doc.tobytes()


class PrivateInputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.valid_pdf = synthetic_pdf()

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.data = daily.empty_data()
        self.data['wanted'] = []
        self.article = paper()
        self.doi = self.article['doi']
        daily.track_wanted(self.data['wanted'], {**self.article, 'open': False}, WHEN.date())
        daily.atomic(self.root / daily.DATA_PATH, self.data)
        self.folder = self.root / pdf.INPUT_DIR

    def plant(self, raw=None, **changes):
        raw = self.valid_pdf if raw is None else raw
        entry = {'doi': self.doi, 'sha256': hashlib.sha256(raw).hexdigest(), 'sizeBytes': len(raw), **changes}
        destination = self.folder / 'pdfs' / (entry['sha256'] + '.pdf')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)
        daily.atomic(self.folder / 'manifest.json', {'schemaVersion': 1, 'items': [entry]})
        return destination, entry

    def preview(self, **kwargs):
        kwargs.setdefault('model', Mock(side_effect=lambda article, units: output(units[0]['id'])))
        kwargs.setdefault('fetch', Mock(side_effect=daily.ReadingError('source_unavailable')))
        writer = Mock(root=self.root)
        writer.private_state.return_value = kwargs.pop('visibility', True)
        try:
            return daily.preview_private_reading(writer, self.data['wanted'], self.article, WHEN.date(), **kwargs)
        finally:
            writer.save.assert_not_called()

    def test_staged_pdf_previews_without_written_state_or_source_link(self):
        destination, entry = self.plant()
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        original = json.dumps(self.data)
        model = Mock(side_effect=lambda article, units: output(units[0]['id']))
        projected = self.preview(model=model)
        model.assert_called_once()
        self.assertLessEqual(sum(len(p['text']) for p in model.call_args.args[1]), 120000)
        self.assertNotIn('sourceUrl', projected)
        quotes = [e['quote'] for section in projected['sections'].values() for e in section['evidence']]
        counts = [len(q.split()) for q in quotes]
        self.assertTrue(counts)
        self.assertLessEqual(max(counts), 25)
        self.assertLessEqual(sum(counts), 100)
        serialized = json.dumps(projected)
        for marker in (PRIVATE_MARK, entry['sha256'], str(destination), 'sourceParagraphs'):
            self.assertNotIn(marker, serialized)
        self.assertEqual(json.dumps(self.data), original)
        self.assertEqual({p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}, before)

    def test_oa_xml_has_precedence_and_verified_pdf_is_fallback(self):
        self.plant()
        with patch.object(pdf, 'input_directory', side_effect=AssertionError('unexpected PDF read')):
            self.assertIsNone(self.preview(fetch=lambda _: xml(self.article)))
        self.assertEqual(set(self.preview()), {'titleZh', 'sections'})

    def test_bad_pdf_returns_exact_reason_without_mutating_wanted_or_calling_model(self):
        cases = [
            ('private_pdf_sha256_mismatch', self.valid_pdf, {'sha256': 'a' * 64}),
            ('private_pdf_size_mismatch', self.valid_pdf, {'sizeBytes': len(self.valid_pdf) + 1}),
            ('private_pdf_lfs_pointer', b'version https://git-lfs.github.com/spec/v1\n', {}),
            ('private_pdf_magic', b'not a PDF', {}),
            ('private_pdf_doi_mismatch', synthetic_pdf(doi='10.1234/other'), {}),
            ('private_pdf_doi_mismatch', synthetic_pdf(doi_on_page_two=True), {}),
            ('private_pdf_doi_mismatch', synthetic_pdf(doi=self.doi + '.different'), {}),
            ('private_pdf_title_mismatch', synthetic_pdf(title='An unrelated heart study'), {}),
            ('private_pdf_incomplete_body', synthetic_pdf(header='Abstract'), {}),
            ('private_pdf_incomplete_body', synthetic_pdf(header='Abstract\nBackground:'), {}),
            ('private_pdf_page_limit', synthetic_pdf(pages=201), {}),
            ('private_pdf_too_large', self.valid_pdf, {'sizeBytes': pdf.MAX_PDF + 1}),
        ]
        for reason, raw, changes in cases:
            with self.subTest(reason=reason):
                self.plant(raw, **changes)
                self.assert_rejected(reason)

    def test_oversized_on_disk_symlink_and_hardlink_are_rejected(self):
        path, _ = self.plant()
        with path.open('r+b') as file:
            file.truncate(pdf.MAX_PDF + 1)
        self.assert_rejected('private_pdf_too_large')
        path.unlink()
        other = self.root / 'other.pdf'
        other.write_bytes(self.valid_pdf)
        path.symlink_to(other)
        self.assert_rejected('private_pdf_symlink')
        path.unlink()
        os.link(other, path)
        self.assert_rejected('private_pdf_hardlink')

    def assert_rejected(self, reason):
        model = Mock()
        original = json.dumps(self.data)
        with self.assertRaisesRegex(pdf.InputError, '^' + reason + '$'):
            self.preview(model=model)
        model.assert_not_called()
        self.assertEqual(json.dumps(self.data), original)

    def test_manifest_bounds_and_strict_fields(self):
        _, entry = self.plant()
        manifest = self.folder / 'manifest.json'
        tests = [
            ('private_pdf_manifest_fields', [{**entry, 'path': 'outside.pdf'}]),
            ('private_pdf_manifest_doi', [{**entry, 'doi': self.doi.upper()}]),
            ('private_pdf_manifest_sha256', [{**entry, 'sha256': 'A' * 64}]),
            ('private_pdf_manifest_duplicate_doi', [entry, entry]),
            ('private_pdf_manifest_item_limit', [entry] * (pdf.MAX_ITEMS + 1)),
            ('private_pdf_manifest_total_limit', [{**entry, 'doi': self.doi + str(n), 'sizeBytes': pdf.MAX_PDF}
                                                  for n in range(pdf.MAX_TOTAL // pdf.MAX_PDF + 1)]),
        ]
        for reason, items in tests:
            with self.subTest(reason=reason):
                daily.atomic(manifest, {'schemaVersion': 1, 'items': items})
                self.assert_rejected(reason)
        manifest.write_bytes(b' ' * (pdf.MAX_MANIFEST + 1))
        self.assert_rejected('private_pdf_manifest_too_large')

    def test_timeout_is_fixed_and_does_not_call_model(self):
        self.plant()
        with patch.object(pdf.subprocess, 'run', side_effect=subprocess.TimeoutExpired('fixture', 30)) as runner:
            self.assert_rejected('private_pdf_parse_timeout')
        self.assertEqual(runner.call_args.kwargs['timeout'], 30)
        self.assertEqual(runner.call_args.kwargs['stderr'], subprocess.DEVNULL)

    def test_structured_abstract_introduction_is_not_body_text(self):
        for header in ('Introduction', 'Introduction: motivation for this study'):
            with self.subTest(header=header):
                self.plant(synthetic_pdf(abstract='Abstract', header=header))
                self.assert_rejected('private_pdf_incomplete_body')
        self.plant(synthetic_pdf(abstract='Abstract: Summary omitted from the model input.'))
        model = Mock(return_value=output('p1_1'))
        self.preview(model=model)
        model.assert_called_once()
        self.assertNotIn('Summary omitted', repr(model.call_args.args[1]))

    def test_rejected_reading_does_not_store_private_draft(self):
        self.plant()
        draft = output('p1_1')
        draft['sections']['question']['text'] += ' https://example.invalid/private-location'
        with self.assertRaisesRegex(daily.ReadingError, 'private_pdf_output_contains_source'):
            self.preview(model=Mock(return_value=draft))
        self.assertNotIn('drafts', self.data)
        self.assertFalse(self.data['items'])

    def test_preview_never_opens_inputs_without_confirmed_private_state(self):
        self.plant()
        model, fetch = Mock(), Mock()
        for visibility in (False, None):
            with patch.object(pdf, 'input_directory') as inputs:
                self.assertIsNone(self.preview(visibility=visibility, model=model, fetch=fetch))
                inputs.assert_not_called()
        model.assert_not_called()
        fetch.assert_not_called()

    def test_legacy_path_and_symlinked_staging_parent_are_not_read(self):
        self.plant()
        self.folder.rename(self.root / 'data' / pdf.INPUT_NAME)
        self.assert_rejected('private_pdf_missing')
        self.folder.parent.rmdir()
        self.folder.parent.symlink_to(self.root / 'data')
        self.assert_rejected('private_pdf_unsafe_directory')

    def test_final_state_save_excludes_staging_and_refuses_misplaced_input(self):
        planted, _ = self.plant()
        (self.root / 'public').mkdir()
        (self.root / 'docs').mkdir()
        for name in save_state.STATE_DOCS:
            (self.root / 'docs' / name).write_text('{}')
        head = 'a' * 40
        remote = 'https://github.com/owner/destination.git'
        with patch.object(save_state, 'git') as git, \
                patch.object(save_state, 'push') as push:
            for rel in ('data', 'public', 'public/data'):
                with self.subTest(directory=rel):
                    misplaced = self.root / rel / pdf.INPUT_NAME
                    shutil.copytree(self.folder, misplaced)
                    with self.assertRaisesRegex(save_state.StateError, '^state_contains_private_reading_input$'):
                        save_state.save(self.root, remote, head)
                    shutil.rmtree(misplaced)
            alias = self.root / 'data' / 'renamed'
            for create_alias in (lambda: alias.symlink_to(self.folder), lambda: os.link(planted, alias)):
                create_alias()
                with self.assertRaisesRegex(save_state.StateError, '^state_contains_private_reading_input$'):
                    save_state.save(self.root, remote, head)
                alias.unlink()
            git.assert_not_called()
            push.assert_not_called()

            def inspect_state(repo, destination, expected):
                self.assertEqual((destination, expected), (remote, head))
                self.assertFalse((repo / '.local').exists())
                self.assertEqual((repo / daily.DATA_PATH).read_bytes(), (self.root / daily.DATA_PATH).read_bytes())
                self.assertFalse(list(repo.rglob(pdf.INPUT_NAME)))
                return True
            push.side_effect = inspect_state
            self.assertEqual(save_state.save(self.root, remote, head), {'status': 'saved', 'lease': 'original'})
            push.assert_called_once()

    def test_offline_stage_check_prune_and_public_tree_refusal(self):
        source = self.root / 'received.pdf'
        source.write_bytes(self.valid_pdf)
        def cli(command, root=self.root, *args):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = pdf.main([command, '--state-dir', str(root), *args])
            return rc, json.loads(out.getvalue())
        self.assertEqual(cli('stage', self.root, '--doi', self.doi, '--pdf', str(source)), (0, {'status': 'ok', 'count': 1}))
        self.assertEqual(cli('check'), (0, {'status': 'ok', 'count': 1}))
        wanted, published = pdf.wanted_for(self.root)
        wanted[self.doi].update(status='published', publishedOn=WHEN.date().isoformat())
        self.assertEqual(pdf.prune(self.root, wanted, published, WHEN.date() + timedelta(days=30)), 0)
        self.assertEqual(pdf.prune(self.root, wanted, published, WHEN.date() + timedelta(days=31)), 1)
        self.assertFalse(list((self.folder / 'pdfs').iterdir()))
        self.assertEqual(cli('stage', self.root, '--doi', self.doi, '--pdf', str(source))[0], 0)
        self.assertEqual(pdf.prune(self.root, {}, {}, WHEN.date()), 1)
        self.assertEqual(cli('check', pdf.ROOT / 'scripts')[1]['reason'], 'private_pdf_public_checkout')
        alias = self.root / 'public-alias'
        alias.symlink_to(pdf.ROOT)
        self.assertEqual(cli('check', alias)[1]['reason'], 'private_pdf_public_checkout')

    def test_stage_refuses_checkout_until_staging_is_gitignored(self):
        source = self.root / 'received.pdf'
        source.write_bytes(self.valid_pdf)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True)
        args = ['stage', '--state-dir', str(self.root), '--doi', self.doi, '--pdf', str(source)]
        for ignore, expected in (('', 'private_pdf_staging_not_gitignored'), ('.local/\n', None)):
            (self.root / '.git/info/exclude').write_text(ignore)
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(pdf.main(args), int(expected is not None))
            self.assertEqual(json.loads(out.getvalue()).get('reason'), expected)
            self.assertEqual(self.folder.exists(), expected is None)
        source.unlink()
        subprocess.run(['git', '-C', str(self.root), 'add', '-A', '--', '.'], check=True, capture_output=True)
        tracked = subprocess.check_output(['git', '-C', str(self.root), 'ls-files', '--', pdf.INPUT_DIR])
        self.assertEqual(tracked, b'')

    def test_planted_input_never_reaches_build_or_shards(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            synthetic_root(root)
            _, entry = self.plant()
            data, ledger = daily.empty_data(), daily.empty_ledger()
            daily.generate(data, ledger, [self.article], WHEN, Mock(), {}, fetch=lambda _: xml(self.article),
                           model=lambda cfg, article, units: output(units[0]['id']))
            daily.atomic(root / daily.DATA_PATH, data)
            planted = root / pdf.INPUT_DIR / 'private-planted-file.pdf'
            planted.parent.mkdir(parents=True)
            planted.write_bytes(self.valid_pdf + b'PRIVATE_BUILD_CANARY')
            public = root / 'public'
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', public), contextlib.redirect_stdout(io.StringIO()) as log:
                builder.main()
            self.assertTrue(list((public / 'shards').glob('readings-*.js')))
            all_outputs = [p.read_bytes() for p in public.rglob('*') if p.is_file()]
            all_outputs += [(root / 'docs/public-manifest.json').read_bytes(), log.getvalue().encode()]
            self.assertTrue(any(output()['sections']['question']['text'].encode() in raw for raw in all_outputs))
            for marker in ('PRIVATE_BUILD_CANARY', PRIVATE_MARK, 'private-planted-file', entry['sha256'],
                           pdf.INPUT_DIR, '%PDF-'):
                self.assertTrue(all(marker.encode() not in raw for raw in all_outputs), marker)
            output_alias = public / 'data' / pdf.INPUT_NAME
            output_alias.parent.mkdir()
            output_alias.symlink_to(planted.parent)
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', public), \
                    self.assertRaisesRegex(ValueError, 'Public directory contains a private reading input'):
                builder.main()


if __name__ == '__main__':
    unittest.main()
