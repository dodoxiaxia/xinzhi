import hashlib
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
        self.assertFalse(verify(encrypted, '10.1000/exact', 'Exact cardiovascular trial')['verified'])
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



if __name__ == '__main__':
    unittest.main()
