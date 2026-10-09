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


if __name__ == '__main__':
    unittest.main()
