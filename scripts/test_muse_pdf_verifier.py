import hashlib
import re
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

    def make_pdf(self, pages, name='synthetic.pdf', metadata=None):
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
        document.save(target, deflate=False)
        document.close()
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


if __name__ == '__main__':
    unittest.main()
