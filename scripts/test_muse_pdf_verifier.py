import hashlib
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
import fitz
from muse_pdf_verifier import verify


class MuseOriginalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'original.pdf'
        document = fitz.open()
        for number in range(2):
            page = document.new_page()
            page.insert_text((36, 50), 'Exact cardiovascular trial\n10.1000/exact' if number == 0 else 'Second page content')
            for index in range(1300):
                x, y = 40 + index % 50 * 10, 100 + index // 50 * 10
                page.draw_rect(fitz.Rect(x, y, x + 4, y + 4), color=(.2, .3, .5))
        document.save(self.path, deflate=False)
        document.close()

    def make_pdf(self, pages, name='synthetic.pdf', metadata=None, xmp=None):
        target = Path(self.directory.name) / name
        document = fitz.open()
        for text in pages:
            page = document.new_page()
            if text:
                page.insert_text((36, 50), text)
            for index in range(1300):
                x, y = 40 + index % 50 * 10, 100 + index // 50 * 10
                page.draw_rect(fitz.Rect(x, y, x + 4, y + 4), color=(.2, .3, .5))
        if metadata:
            document.set_metadata(metadata)
        if xmp:
            document.set_xml_metadata(xmp)
        document.save(target, deflate=False)
        document.close()
        return target

    def make_type1c_pdf(self, pages):
        target = Path(self.directory.name) / 'type1c.pdf'
        script = r"""
const fs = require('node:fs');
const {type1cTextPages} = require('./scripts/machine_identity_fixtures.cjs');
const pages = JSON.parse(fs.readFileSync(0, 'utf8'));
const pdf = type1cTextPages(encode => pages.map(lines => [lines.map((line, i) =>
  'BT /F2 10 Tf 1 0 0 1 36 ' + (750 - i * 16) + ' Tm ' + encode(line) + ' Tj ET\n').join('')]),
  {encodingFormat:1, charsetFormat:2, supplement:true});
fs.writeFileSync(process.argv[1], pdf);
"""
        subprocess.run(['node', '-e', script, str(target)], cwd=Path(__file__).resolve().parents[1],
                       input=json.dumps(pages), text=True, check=True)
        return target

    def damage_xref(self, target):
        original = target.read_bytes()
        damaged = re.sub(rb'(?m)^xref\r?$', b'nope', original, count=1)
        self.assertNotEqual(damaged, original)
        target.write_bytes(damaged)

    def test_doi_on_later_page_is_accepted(self):
        pages = ['Exact cardiovascular trial'] + ['ordinary text'] * 3 + ['DOI 10.1000/exact']
        target = self.make_pdf(pages)
        result = verify(target, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertTrue(result['verified'], result)
        self.assertEqual(result['pages'], len(pages))

    def test_damaged_xref_retries_non_strict_and_preserves_bytes(self):
        target = self.make_pdf(['Exact cardiovascular trial 10.1000/exact', 'Second page content'], 'xref.pdf')
        original = target.read_bytes()
        damaged = re.sub(rb'(?m)^xref\r?$', b'nope', original, count=1)
        self.assertNotEqual(damaged, original)
        target.write_bytes(damaged)
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError
        with self.assertRaises(PdfReadError):
            PdfReader(target, strict=True)
        self.assertEqual(len(PdfReader(target, strict=False).pages), 2)
        with fitz.open(target) as document:
            self.assertEqual(document.page_count, 2)
        before = target.read_bytes()
        result = verify(target, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertTrue(result['verified'], result)
        self.assertEqual(result['sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(target.read_bytes(), before)

    def test_damaged_xref_without_page_text_is_rejected(self):
        target = self.make_pdf(['', ''], 'xref-no-text.pdf')
        self.damage_xref(target)
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError
        with self.assertRaises(PdfReadError):
            PdfReader(target, strict=True)
        self.assertEqual(len(PdfReader(target, strict=False).pages), 2)
        result = verify(target, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertFalse(result['verified'], result)
        self.assertEqual(result['reason'], 'invalid_pdf')

    def test_damaged_xref_encrypted_pdf_is_rejected(self):
        encrypted = Path(self.directory.name) / 'encrypted-xref.pdf'
        with fitz.open(self.path) as document:
            document.save(encrypted, encryption=fitz.PDF_ENCRYPT_AES_256,
                          owner_pw='synthetic-owner', user_pw='synthetic-reader')
        self.damage_xref(encrypted)
        from pypdf import PdfReader
        # The strict read fails for the damaged xref. Whether strict=False then raises
        # (pypdf without `cryptography`, as in muse-checks.yml) or opens it as encrypted
        # (pypdf with `cryptography`) depends on the environment; both must be rejected.
        with self.assertRaises(Exception):
            PdfReader(encrypted, strict=True).pages[0]
        result = verify(encrypted, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertFalse(result['verified'], result)
        self.assertEqual(result['reason'], 'invalid_pdf')

    def test_strict_readable_blank_pdf_keeps_identity_mismatch_reason(self):
        target = self.make_pdf(['', ''], 'strict-no-text.pdf')
        from pypdf import PdfReader
        self.assertEqual(len(PdfReader(target, strict=True).pages), 2)
        result = verify(target, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertFalse(result['verified'], result)
        self.assertEqual(result['reason'], 'identity_mismatch')

    def test_identity_and_pdf_structure_rejections(self):
        cases = [
            (['ordinary text 10.1000/exact', 'Exact cardiovascular trial'], 'identity_mismatch'),
            (['Exact cardiovascular trial', 'ordinary text'], 'identity_mismatch'),
            (['Exact cardiovascular trial 10.1000/exact2'], 'identity_mismatch'),
            (['Exact cardiovascular trial 110.1000/exact'], 'identity_mismatch'),
            (['Wrong title', '10.1000/exact'], 'identity_mismatch'),
        ]
        for index, (pages, reason) in enumerate(cases):
            with self.subTest(index=index):
                result = verify(self.make_pdf(pages, f'case-{index}.pdf'), '10.1000/exact', 'Exact cardiovascular trial')
                self.assertFalse(result['verified'], result)
                self.assertEqual(result['reason'], reason)
        metadata_pdf = self.make_pdf(['Exact cardiovascular trial', 'ordinary text'], 'metadata.pdf',
                                     {'title': '10.1000/exact', 'subject': '10.1000/exact'})
        result = verify(metadata_pdf, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertFalse(result['verified'], result)
        self.assertEqual(result['reason'], 'identity_mismatch')

    def test_page_count_mismatch_and_empty_file_rejected(self):
        target = self.make_pdf(['Exact cardiovascular trial 10.1000/exact', 'Second page'], 'mismatch.pdf')
        raw = target.read_bytes()
        changed = re.sub(rb'/Count\s+2\b', b'/Count 3', raw, count=1)
        self.assertNotEqual(changed, raw)
        changed = re.sub(rb'(?m)^xref\r?$', b'nope', changed, count=1)
        target.write_bytes(changed)
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError
        with self.assertRaises(PdfReadError):
            PdfReader(target, strict=True)
        fallback_count = len(PdfReader(target, strict=False).pages)
        with fitz.open(target) as doc:
            self.assertNotEqual(fallback_count, doc.page_count)
        result = verify(target, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertFalse(result['verified'], result)
        self.assertEqual(result['reason'], 'invalid_pdf')
        self.path.write_bytes(b'')
        result = verify(self.path, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertFalse(result['verified'], result)
        self.assertEqual(result['reason'], 'invalid_pdf')

    def test_both_parsers_all_pages_and_immutable_original(self):
        before = self.path.read_bytes()
        result = verify(self.path, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertTrue(result['verified'], result)
        self.assertEqual(result['pages'], 2)
        self.assertEqual(result['sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(self.path.read_bytes(), before)

    def test_wrong_identity_and_truncation(self):
        self.assertFalse(verify(self.path, '10.1000/wrong', 'Exact cardiovascular trial')['verified'])
        self.assertFalse(verify(self.path, '10.1000/exact', 'Another trial')['verified'])
        self.path.write_bytes(self.path.read_bytes()[:-1200])
        self.assertFalse(verify(self.path, '10.1000/exact', 'Exact cardiovascular trial')['verified'])

    def test_opening_password_and_html(self):
        with fitz.open(self.path) as document:
            encrypted = Path(self.directory.name) / 'encrypted.pdf'
            document.save(encrypted, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='synthetic-owner', user_pw='synthetic-reader')
        result = verify(encrypted, '10.1000/exact', 'Exact cardiovascular trial')
        self.assertFalse(result['verified'], result)
        self.assertEqual(result['reason'], 'invalid_pdf')
        self.path.write_bytes(b'<html>' + b'x' * 52000)
        self.assertFalse(verify(self.path, '10.1000/exact', 'Exact cardiovascular trial')['verified'])


    def numbered_pdf(self, marker='ACCEPTED MANUSCRIPT', margin=47.3, doi_text=None, numbers=4):
        target = Path(self.directory.name) / 'numbered.pdf'
        document = fitz.open()
        page = document.new_page(width=612, height=792)
        lines = ['Rivaroxaban trial for Type 2 diabetes and',
                 'Clinical benefit over 5 years', 'Running title: diabetes', 'Study authors']
        for index, line in enumerate(lines):
            y = 90 + index * 30
            page.insert_text((72.1, y), line, fontsize=12)
            if index < numbers:
                page.insert_text((margin, y), str(index + 1), fontsize=12)
        page.insert_text((72.1, 300), marker, fontsize=12)
        page.insert_text((72.1, 740), doi_text or 'Downloaded from https://academic.oup.com/doi/10.1000/exact/12345', fontsize=9)
        with fitz.open(self.path) as source:
            document.insert_pdf(source, from_page=1, to_page=1)
        document.save(target, deflate=False)
        document.close()
        return target

    def test_numbered_accepted_manuscript_keeps_original_and_clinical_numbers(self):
        title = 'Rivaroxaban trial for Type 2 diabetes and Clinical benefit over 5 years'
        target = self.numbered_pdf()
        before = target.read_bytes()
        result = verify(target, '10.1000/exact', title)
        self.assertTrue(result['verified'], result)
        self.assertEqual(result['pages'], 2)
        self.assertEqual(result['sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(target.read_bytes(), before)
        self.assertFalse(verify(target, '10.1000/exact', title.replace('Type 2', 'Type 1'))['verified'])
        self.assertFalse(verify(target, '10.1000/exact', title.replace('5 years', '6 years'))['verified'])

    def test_cleanup_requires_accepted_marker_and_margin_number_series(self):
        title = 'Rivaroxaban trial for Type 2 diabetes and Clinical benefit over 5 years'
        for options in [dict(marker='Published article'), dict(margin=120), dict(numbers=2)]:
            self.assertFalse(verify(self.numbered_pdf(**options), '10.1000/exact', title)['verified'], options)

    def test_numbered_manuscript_still_requires_exact_first_page_doi(self):
        title = 'Rivaroxaban trial for Type 2 diabetes and Clinical benefit over 5 years'
        for doi_text in ['https://academic.oup.com/doi/10.1000/wrong/12345',
                         '10.1000/exact2', '110.1000/exact']:
            result = verify(self.numbered_pdf(doi_text=doi_text), '10.1000/exact', title)
            self.assertFalse(result['verified'], (doi_text, result))



    def test_manual_release_skips_only_the_doi_check(self):
        title = 'Exact cardiovascular trial'
        # The page prints another paper's DOI, never the claimed one: a normal verification rejects it.
        target = self.make_pdf([title + '\n10.1000/other-paper', 'Second page content'], 'held.pdf')
        sha = hashlib.sha256(target.read_bytes()).hexdigest()
        self.assertFalse(verify(target, '10.1000/exact', title)['verified'])
        released = verify(target, '10.1000/exact', title, sha)
        self.assertTrue(released['verified'], released)
        self.assertEqual(released['skipped'], ['doi_in_fulltext'])
        self.assertEqual(released['method'], 'dual_parser_title_manual_release')
        self.assertEqual(released['sha256'], sha)
        self.assertNotIn('skipped', verify(self.path, '10.1000/exact', 'Exact cardiovascular trial'))

    def test_manual_release_still_needs_the_recorded_file_and_the_exact_title(self):
        title = 'Exact cardiovascular trial'
        target = self.make_pdf([title + '\n10.1000/other-paper'], 'held2.pdf')
        sha = hashlib.sha256(target.read_bytes()).hexdigest()
        # A different file than the one released.
        swapped = self.make_pdf([title + '\n10.1000/other-paper', 'extra page'], 'swapped.pdf')
        result = verify(swapped, '10.1000/exact', title, sha)
        self.assertFalse(result['verified'])
        self.assertNotIn('skipped', result)
        self.assertFalse(verify(target, '10.1000/exact', title, 'f' * 64)['verified'])
        self.assertFalse(verify(target, '10.1000/exact', title, 'not-a-hash')['verified'])
        # A title that is not on the first page is rejected even when released.
        self.assertFalse(verify(target, '10.1000/exact', 'Exact cardiovascular trials', sha)['verified'])
        self.assertFalse(verify(target, '10.1000/exact', 'Different cardiovascular trial', sha)['verified'])
        # The spelling-variant fallbacks do not apply to a released file: strict title only.
        vs = self.make_pdf(['Beta-blocker therapy vs placebo after myocardial infarction\n10.1000/other-paper'], 'vs-held.pdf')
        vs_sha = hashlib.sha256(vs.read_bytes()).hexdigest()
        self.assertFalse(verify(vs, '10.1000/exact', 'Beta-blocker therapy versus placebo after myocardial infarction', vs_sha)['verified'])
        # PDF structure still has to parse.
        broken = Path(self.directory.name) / 'broken.pdf'
        broken.write_bytes(b'%PDF-1.4\n' + b'x' * 60000)
        self.assertFalse(verify(broken, '10.1000/exact', title, hashlib.sha256(broken.read_bytes()).hexdigest())['verified'])


    def test_command_line_passes_the_released_hash(self):
        import json
        import subprocess
        import sys
        title = 'Exact cardiovascular trial'
        target = self.make_pdf([title + '\n10.1000/other-paper'], 'cli-held.pdf')
        sha = hashlib.sha256(target.read_bytes()).hexdigest()
        script = str(Path(__file__).with_name('muse_pdf_verifier.py'))
        base = [sys.executable, script, str(target), '--doi', '10.1000/exact', '--title', title]
        plain = json.loads(subprocess.run(base, capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1])
        released = json.loads(subprocess.run(base + ['--released-sha256', sha], capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1])
        self.assertFalse(plain['verified'])
        self.assertTrue(released['verified'])
        self.assertEqual(released['skipped'], ['doi_in_fulltext'])

    def test_spelling_variants_match_like_the_upload_worker(self):
        doi, base = '10.1000/exact', 'Beta-blocker therapy {} placebo after myocardial infarction in synthetic cohorts'
        target = self.make_pdf([base.format('vs') + '\n10.1000/exact'], 'vs.pdf')
        self.assertTrue(verify(target, doi, base.format('versus'))['verified'])
        self.assertTrue(verify(target, doi, base.format('v.'))['verified'])
        self.assertFalse(verify(target, doi, base.format('versus').replace('placebo', 'aspirin'))['verified'])
        self.assertFalse(verify(target, doi, base.format('versuss'))['verified'])
        marked = self.make_pdf(['SyntheticValve Transcatheter Repair in Elderly Cohorts\n10.1000/exact'], 'mark.pdf')
        self.assertTrue(verify(marked, doi, 'SyntheticValve\u00ae Transcatheter Repair in Elderly Cohorts')['verified'])
        self.assertFalse(verify(marked, doi, 'SyntheticValve\u00ae Transcatheter Repair in Elderly Cohortx')['verified'])

    def test_unmapped_trademark_glyph_name_is_dropped_only_when_title_has_the_mark(self):
        from muse_pdf_verifier import title_matches
        page = 'SOCIETAL DOCUMENT\nCAD-RADS/C228 2.0 \u2013 2022 Coronary Artery\nDisease-Reporting and Data System'
        self.assertTrue(title_matches(page, 'CAD-RADS\u2122 2.0 \u2013 2022 Coronary Artery Disease-Reporting and Data System'))
        self.assertFalse(title_matches(page, 'CAD-RADS 2.0 \u2013 2022 Coronary Artery Disease-Reporting and Data System'))
        self.assertFalse(title_matches(page, 'CAD-RADS\u2122 3.0 \u2013 2022 Coronary Artery Disease-Reporting and Data System'))

    def proof_pdf(self, title_line, tag='HRTHM12284_proof', queries='Q1 Q3 Q4', name='proof.pdf'):
        return self.make_pdf([f'FLA 5.7.0 DTD {tag}\n{title_line}\n{queries}\n10.1000/exact'], name)

    def test_proof_stage_query_markers_need_proof_evidence_query_list_and_narrow_shape(self):
        doi, title = '10.1000/exact', 'Synthetic atrial fibrillation entrenchment revisited: Early timing of AF cohorts'
        line = 'Synthetic atrial fibrillation entrenchment revisited: Early timing of AF Q2 cohorts'
        self.assertTrue(verify(self.proof_pdf(line), doi, title)['verified'])
        self.assertTrue(verify(self.proof_pdf('Synthetic Q1 atrial fibrillation entrenchment revisited: Early timing of AF Q12 cohorts', queries='Q3 Q4'), doi, title)['verified'])
        negatives = {
            'no proof evidence': self.proof_pdf(line, tag='HRTHM12284'),
            'no query list': self.proof_pdf(line, queries=''),
            'short query list': self.proof_pdf(line, queries='Q1'),
            'q plus three digits': self.proof_pdf(line.replace('Q2', 'Q123'), queries='Q1 Q3 Q4'),
            'inside a word': self.proof_pdf(line.replace('cohorts', 'cohq2orts')),
            'three markers': self.proof_pdf('Synthetic Q1 atrial fibrillation Q2 entrenchment revisited: Early timing Q3 of AF cohorts', queries='Q4'),
            'not a q marker': self.proof_pdf(line.replace('Q2', 'X2')),
            'extra word': self.proof_pdf(line.replace('cohorts', 'extra cohorts')),
        }
        for label, target in negatives.items():
            self.assertFalse(verify(target, doi, title)['verified'], label)
        self.assertFalse(verify(self.proof_pdf('Synthetic atrial Q2 timing of cohorts'), doi, 'Synthetic atrial timing of cohorts')['verified'], 'short title')
        no_doi = self.make_pdf(['FLA 5.7.0 DTD HRTHM12284_proof\n' + line + '\nQ1 Q3 Q4'], 'nodoi.pdf')
        self.assertFalse(verify(no_doi, doi, title)['verified'], 'no doi')
        coenzyme = self.proof_pdf('Coenzyme Q10 supplementation and cardiovascular outcomes in synthetic heart failure cohorts', queries='')
        self.assertFalse(verify(coenzyme, doi, 'Coenzyme supplementation and cardiovascular outcomes in synthetic heart failure cohorts')['verified'])

    def test_manual_release_never_uses_the_title_variants_of_normal_verification(self):
        # Each file matches its title only through a variant rule. The same file passes normal verification (the claimed DOI is on
        # the page) but is rejected on the release path, which compares the first-page title strictly.
        from muse_pdf_verifier import exact_title_matches, title_matches
        doi = '10.1000/exact'
        cases = {
            'versus': (self.make_pdf(['Beta-blocker therapy vs placebo after myocardial infarction in synthetic cohorts\n10.1000/exact'], 'rv-vs.pdf'),
                       'Beta-blocker therapy versus placebo after myocardial infarction in synthetic cohorts'),
            'trademark': (self.make_pdf(['SyntheticValve Transcatheter Repair in Elderly Cohorts\n10.1000/exact'], 'rv-mark.pdf'),
                          'SyntheticValve\u2122 Transcatheter Repair in Elderly Cohorts'),
            'proof marker': (self.proof_pdf('Synthetic atrial fibrillation entrenchment revisited: Early timing of AF Q2 cohorts', name='rv-proof.pdf'),
                             'Synthetic atrial fibrillation entrenchment revisited: Early timing of AF cohorts'),
        }
        for label, (target, title) in cases.items():
            self.assertTrue(verify(target, doi, title)['verified'], label + ': normal verification accepts the variant')
            result = verify(target, doi, title, hashlib.sha256(target.read_bytes()).hexdigest())
            self.assertFalse(result['verified'], label + ': released path must not accept a variant-only title')
            self.assertEqual(result['reason'], 'identity_mismatch', label)
            self.assertNotIn('skipped', result, label)
        # Same split at the comparison functions, including the unmapped trademark glyph name and the margin-number cleanup.
        page = 'SOCIETAL DOCUMENT\nCAD-RADS/C228 2.0 \u2013 2022 Coronary Artery\nDisease-Reporting and Data System'
        title = 'CAD-RADS\u2122 2.0 \u2013 2022 Coronary Artery Disease-Reporting and Data System'
        self.assertTrue(title_matches(page, title))
        self.assertFalse(exact_title_matches(page, title))
        self.assertTrue(exact_title_matches('Exact cardiovascular trial', 'Exact cardiovascular trial'))
        self.assertTrue(exact_title_matches('Accepted Manuscript\n1 Exact\n2 cardiovascular\n3 trial', 'Exact cardiovascular trial', 'Accepted Manuscript\nExact cardiovascular trial'))


    def test_t18_type1c_headings_require_independent_pypdf_and_mupdf_evidence(self):
        from pypdf import PdfReader
        doi = '10.1000/exact'
        a_title = 'Synthetic guidelines for ventricular rhythm in imaginary cohorts'
        c_title = 'Synthetic commands for pacing in an imaginary registry'
        for lines, title in (
            (['Synthetic co-publication notice', 'DOI ' + doi, 'DOI 10.1000/copublished',
              'Synthetic guidelines for ventricular', 'rhythm in imaginary cohorts'], a_title),
            (['4207', 'CardioPulse', 'DOI ' + doi, 'Global Spotlights', 'Synthetic authors', c_title], c_title),
        ):
            with self.subTest(title=title):
                target = self.make_type1c_pdf([lines])
                reader = PdfReader(target, strict=True)
                self.assertNotIn(doi, reader.pages[0].extract_text())
                with fitz.open(target) as document:
                    self.assertIn(doi, document[0].get_text())
                    self.assertIn('Type1', [entry[2] for entry in document[0].get_fonts() if entry[1] == 'cff'])
                self.assertTrue(verify(target, doi, title)['verified'])
                self.assertFalse(verify(target, doi, title.replace('imaginary', 'real'))['verified'])
                self.assertFalse(verify(target, '10.1000/foreign', title)['verified'])
                # The ordinary font recovery does not broaden the existing strict manual-release rules.
                sha = hashlib.sha256(target.read_bytes()).hexdigest()
                self.assertFalse(verify(target, doi, title, release_sha256=sha)['verified'])

        printed = 'European Rhythm Association (ERA) consensus on atrial ﬁbrillation'
        title = '2024 European Rhythm Association consensus on atrial fibrillation'
        self.assertTrue(verify(self.make_type1c_pdf([[printed, 'DOI ' + doi]]), doi, title)['verified'])
        self.assertFalse(verify(self.make_type1c_pdf([[printed, 'DOI 10.1000/foreign']]), doi, title)['verified'])

        cover = ['Utrecht University Repository', 'Title', a_title, 'Authors', 'Synthetic Author',
                 'Published in', 'Synthetic Journal', 'Publication Date', '2024', 'Link',
                 'https://hdl.handle.net/1/synthetic', 'Citation', 'Synthetic citation']
        self.assertTrue(verify(self.make_type1c_pdf([cover, [a_title, 'DOI ' + doi]]), doi, a_title)['verified'])
        self.assertFalse(verify(self.make_type1c_pdf([cover, [a_title, 'DOI 10.1000/foreign']]), doi, a_title)['verified'])

    def test_t18_catalogue_year_and_acronyms_require_matching_doi(self):
        from muse_pdf_verifier import catalog_title_variant
        doi = '10.1000/exact'
        title = 'European Rhythm Association/Pacific Rhythm Society consensus on atrial fibrillation'
        abbreviated = 'European Rhythm Association (ERA)/Pacific Rhythm Society (PRS) consensus on atrial fibrillation'
        self.assertTrue(catalog_title_variant(abbreviated.replace('fi', '\ufb01'), '2024 ' + title))
        for registered, printed in (('2024 ' + title, title), (title, abbreviated), ('2024 ' + title, abbreviated)):
            with self.subTest(registered=registered, printed=printed):
                target = self.make_pdf([printed + '\nDOI ' + doi])
                self.assertTrue(verify(target, doi, registered)['verified'])
        for label, registered, pages, metadata in (
            ('changed word', '2024 ' + title, [title.replace('atrial', 'ventricular') + '\nDOI ' + doi], None),
            ('changed year', '2024 ' + title, ['2023 ' + abbreviated + '\nDOI ' + doi], None),
            ('long acronym', title, [abbreviated.replace('ERA', 'TOOLONGXY') + '\nDOI ' + doi], None),
            ('lowercase acronym', title, [abbreviated.replace('ERA', 'Era') + '\nDOI ' + doi], None),
            ('no DOI', title, [abbreviated], None),
            ('foreign DOI', title, [abbreviated + '\nDOI 10.1000/other'], None),
            ('longer foreign DOI', title, [abbreviated + '\nDOI ' + doi + '.other'], None),
            ('DOI only later', title, [abbreviated, doi], None),
            ('DOI only in metadata', title, [abbreviated], {'subject': doi}),
            ('metadata with longer foreign DOI', title, [abbreviated, doi + '.other'], {'subject': doi}),
        ):
            with self.subTest(label=label):
                target = self.make_pdf(pages, metadata=metadata)
                self.assertEqual(verify(target, doi, registered)['reason'], 'identity_mismatch')
        confirmed = self.make_pdf([abbreviated, doi], metadata={'subject': doi})
        self.assertTrue(verify(confirmed, doi, '2024 ' + title)['verified'])
        xmp = self.make_pdf([abbreviated, doi], xmp=f'<synthetic>DOI {doi}</synthetic>')
        self.assertTrue(verify(xmp, doi, title)['verified'])

    def test_t18_repository_requires_correct_cover_and_both_article_matches_on_page_two(self):
        doi, title = '10.1000/exact', 'Exact cardiovascular trial in synthetic cohorts'
        cover = ('Utrecht University Repository\nTitle\n' + title + '\nAuthors\nSynthetic Author\n'
                 'Published in\nSynthetic Journal\nPublication Date\n2024\n'
                 'Link https://hdl.handle.net/1/synthetic\nCitation\nSynthetic citation')
        article = title + '\nDOI ' + doi
        self.assertTrue(verify(self.make_pdf([cover, article]), doi, title)['verified'])
        for label, pages in (
            ('wrong title on cover', [cover.replace('trial', 'registry'), article]),
            ('wrong title on article', [cover, article.replace('trial', 'registry')]),
            ('wrong DOI on article', [cover, article.replace(doi, '10.1000/other')]),
            ('DOI prefix on article', [cover, article.replace(doi, doi + '.other')]),
            ('DOI on cover only', [cover + '\n' + doi, title]),
            ('DOI on third page', [cover, title, doi]),
            ('blank article page', [cover, '', article]),
        ):
            with self.subTest(label=label):
                result = verify(self.make_pdf(pages), doi, title)
                self.assertEqual(result['reason'], 'identity_mismatch', result)

    def test_t18_multi_item_news_stays_rejected_when_target_headline_is_absent(self):
        title = 'Synthetic Testosterone Trial and Cardiovascular Events'
        news = ('Medical News in Brief\nSynthetic Sleep and Recovery\n'
                'DOI 10.1000/exact\nA Synthetic Report on Nutrition\n')
        for printed in ('', title.replace('Trial', 'Trial (STT)')):
            with self.subTest(printed=printed):
                target = self.make_pdf([news + printed])
                self.assertEqual(verify(target, '10.1000/exact', title)['reason'], 'identity_mismatch')


if __name__ == '__main__':
    unittest.main()
