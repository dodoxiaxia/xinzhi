"""Reject unsafe public package inputs using isolated temporary directories."""
import tempfile
import unittest
from pathlib import Path
from package_release import PUBLIC, public_payloads

class TestPublicPackaging(unittest.TestCase):
 def setUp(self):
  self.temporary=tempfile.TemporaryDirectory()
  self.root=Path(self.temporary.name)
  (self.root/'public').mkdir()
  for name in PUBLIC:(self.root/'public'/name).write_text(name)
 def tearDown(self):self.temporary.cleanup()
 def test_only_five_regular_files_are_read(self):
  self.assertEqual(set(public_payloads(self.root)),PUBLIC)
 def test_private_file_symlink_is_rejected(self):
  private=self.root/'private-secret';private.write_text('synthetic')
  file=self.root/'public/public.js';file.unlink();file.symlink_to(private)
  with self.assertRaises(ValueError):public_payloads(self.root)
 def test_public_directory_symlink_is_rejected(self):
  public=self.root/'public';public.rename(self.root/'elsewhere');public.symlink_to(self.root/'elsewhere')
  with self.assertRaises(ValueError):public_payloads(self.root)
 def test_extra_file_is_rejected(self):
  (self.root/'public/unexpected.pdf').write_bytes(b'%PDF-synthetic')
  with self.assertRaises(ValueError):public_payloads(self.root)
 def test_directory_with_allowed_filename_is_rejected(self):
  file=self.root/'public/public.js';file.unlink();file.mkdir()
  with self.assertRaises(ValueError):public_payloads(self.root)

if __name__=='__main__':unittest.main()
