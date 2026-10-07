"""Reject unsafe public package inputs using isolated temporary directories."""
import tempfile
import unittest
import datetime
import hashlib
import json
import os
import contextlib
import io
from pathlib import Path
from unittest.mock import patch
import package_release as packaging
from package_release import PUBLIC, public_payloads
from release_integrity import MAX_BUILD_AGE, provenance

class TestPublicPackaging(unittest.TestCase):
 def setUp(self):
  self.temporary=tempfile.TemporaryDirectory()
  self.root=Path(self.temporary.name)
  (self.root/'public').mkdir()
  for name in PUBLIC:(self.root/'public'/name).write_text(name)
  (self.root/'scripts').mkdir()
  (self.root/'scripts/build_public.py').write_text("RELEASE = 'vtest'\n")
  (self.root/'docs').mkdir()
  self.manifest=self.root/'docs/public-manifest.json'
  self.write_manifest()
 def tearDown(self):self.temporary.cleanup()
 def write_manifest(self,**updates):
  built=datetime.datetime.now(datetime.timezone.utc).isoformat()
  data={'release':'vtest','createdAt':built,'contentStatus':{'release':'vtest','builtAt':built,'radarUpdatedAt':built,'healthCheckedAt':built},
        'files':[{'path':n,'bytes':len(n.encode()),'sha256':hashlib.sha256(n.encode()).hexdigest()} for n in sorted(PUBLIC)],
        'buildProvenance':provenance(self.root)}
  data.update(updates);self.manifest.write_text(json.dumps(data))
 def change_manifest(self,update):
  data=json.loads(self.manifest.read_text());update(data);self.manifest.write_text(json.dumps(data))
 def test_only_six_matching_regular_files_are_read(self):
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
 def test_missing_manifest_is_rejected(self):
  self.manifest.unlink()
  with self.assertRaisesRegex(ValueError,'missing/malformed'):public_payloads(self.root)
 def test_old_manifest_without_provenance_is_rejected(self):
  self.change_manifest(lambda d:d.pop('buildProvenance'))
  with self.assertRaisesRegex(ValueError,'provenance'):public_payloads(self.root)
 def test_all_six_payload_hashes_are_checked(self):
  for name in PUBLIC:
   with self.subTest(name=name):
    file=self.root/'public'/name;file.write_text('changed')
    with self.assertRaisesRegex(ValueError,'differ from manifest'):public_payloads(self.root)
    file.write_text(name)
 def test_wrong_file_size_is_rejected(self):
  self.change_manifest(lambda d:d['files'][0].update(bytes=0))
  with self.assertRaisesRegex(ValueError,'differ from manifest'):public_payloads(self.root)
 def test_missing_or_duplicate_manifest_files_are_rejected(self):
  self.change_manifest(lambda d:d['files'].__setitem__(0,dict(d['files'][1])))
  with self.assertRaisesRegex(ValueError,'exactly the six'):public_payloads(self.root)
 def test_mismatched_release_is_rejected(self):
  self.write_manifest(release='vold')
  with self.assertRaisesRegex(ValueError,'release differs'):public_payloads(self.root)
 def test_changed_source_with_preserved_mtime_is_rejected(self):
  file=self.root/'scripts/build_public.py';mtime=file.stat().st_mtime_ns
  file.write_text("RELEASE = 'vtest'\n# changed\n");os.utime(file,ns=(mtime,mtime))
  with self.assertRaisesRegex(ValueError,'provenance'):public_payloads(self.root)
 def test_added_optional_input_is_rejected(self):
  (self.root/'data').mkdir();(self.root/'data/quicklooks.json').write_text('{"items":{}}')
  with self.assertRaisesRegex(ValueError,'provenance'):public_payloads(self.root)
 def test_changed_checkout_is_rejected(self):
  with patch('release_integrity.code_sha',return_value='different-checkout'):
   with self.assertRaisesRegex(ValueError,'provenance'):public_payloads(self.root)
 def test_stale_and_future_builds_are_rejected(self):
  for delta in (-MAX_BUILD_AGE-datetime.timedelta(seconds=1),datetime.timedelta(minutes=6)):
   with self.subTest(delta=delta):
    built=(datetime.datetime.now(datetime.timezone.utc)+delta).isoformat()
    self.write_manifest(createdAt=built,contentStatus={'release':'vtest','builtAt':built})
    with self.assertRaisesRegex(ValueError,'stale or future'):public_payloads(self.root)
 def test_naive_timestamp_is_rejected(self):
  built=datetime.datetime.now().isoformat()
  self.write_manifest(createdAt=built,contentStatus={'release':'vtest','builtAt':built})
  with self.assertRaisesRegex(ValueError,'timezone'):public_payloads(self.root)
 def test_fresh_build_cannot_hide_stale_radar_or_source_health(self):
  for field in ('radarUpdatedAt','healthCheckedAt'):
   with self.subTest(field=field):
    self.write_manifest()
    old=(datetime.datetime.now(datetime.timezone.utc)-MAX_BUILD_AGE-datetime.timedelta(seconds=1)).isoformat()
    self.change_manifest(lambda d:d['contentStatus'].update({field:old}))
    with self.assertRaisesRegex(ValueError,field+' is stale'):public_payloads(self.root)
 def test_inconsistent_content_status_is_rejected(self):
  self.change_manifest(lambda d:d['contentStatus'].update(release='old'))
  with self.assertRaisesRegex(ValueError,'inconsistent'):public_payloads(self.root)
 def test_input_symlink_is_rejected(self):
  (self.root/'app.js').symlink_to(self.root/'scripts/build_public.py')
  with self.assertRaisesRegex(ValueError,'symlink'):public_payloads(self.root)
 def test_failed_preflight_preserves_all_existing_archives(self):
  archives=('xinzhi-public.zip','心知-公开网站包.zip','心知-本地学习站.zip')
  for name in archives:(self.root/name).write_bytes(b'previous archive')
  self.manifest.unlink()
  with patch.object(packaging,'ROOT',self.root),patch.object(packaging,'OUT',self.root):
   with self.assertRaises(ValueError):packaging.main()
  for name in archives:self.assertEqual((self.root/name).read_bytes(),b'previous archive')
 def test_zip_write_failures_preserve_all_existing_archives(self):
  names=('xinzhi-public.zip','心知-公开网站包.zip','心知-本地学习站.zip')
  original=packaging.zipfile.ZipFile.writestr
  for failed_name in names:
   with self.subTest(archive=failed_name):
    for name in names:(self.root/name).write_bytes(b'previous archive')
    def fail_write(archive,*args,**kwargs):
     if Path(archive.filename).name.startswith('.'+failed_name+'-'):
      raise OSError('synthetic ZIP write failure')
     return original(archive,*args,**kwargs)
    with patch.object(packaging,'ROOT',self.root),patch.object(packaging,'OUT',self.root),patch.object(packaging.zipfile.ZipFile,'writestr',fail_write):
     with self.assertRaisesRegex(OSError,'write failure'):packaging.main()
    for name in names:self.assertEqual((self.root/name).read_bytes(),b'previous archive')
    self.assertEqual(list(self.root.glob('.*.tmp')),[])
 def test_zip_close_failure_preserves_all_existing_archives(self):
  names=('xinzhi-public.zip','心知-公开网站包.zip','心知-本地学习站.zip')
  for name in names:(self.root/name).write_bytes(b'previous archive')
  original=packaging.zipfile.ZipFile.close
  failed=[]
  def fail_close(archive):
   fail=archive.fp is not None and Path(archive.filename).name.startswith('.'+names[-1]+'-')
   result=original(archive)
   if fail and not failed:
    failed.append(True)
    raise OSError('synthetic ZIP close failure')
   return result
  with patch.object(packaging,'ROOT',self.root),patch.object(packaging,'OUT',self.root),patch.object(packaging.zipfile.ZipFile,'close',fail_close):
   with self.assertRaisesRegex(OSError,'close failure'):packaging.main()
  self.assertTrue(failed)
  for name in names:self.assertEqual((self.root/name).read_bytes(),b'previous archive')
  self.assertEqual(list(self.root.glob('.*.tmp')),[])
 def test_every_archive_uses_verified_public_snapshot(self):
  names=('xinzhi-public.zip','心知-公开网站包.zip','心知-本地学习站.zip')
  real_payloads=packaging.public_payloads
  snapshot={}
  def change_after_preflight(root):
   snapshot.update(real_payloads(root))
   (root/'public/public.js').write_bytes(b'changed after preflight')
   return dict(snapshot)
  with patch.object(packaging,'ROOT',self.root),patch.object(packaging,'OUT',self.root),patch.object(packaging,'public_payloads',change_after_preflight),contextlib.redirect_stdout(io.StringIO()):
   packaging.main()
  for name in names:
   with packaging.zipfile.ZipFile(self.root/name) as archive:
    prefix='xinzhi/public/' if name==names[-1] else ''
    for filename,content in snapshot.items():self.assertEqual(archive.read(prefix+filename),content)
  self.assertEqual(list(self.root.glob('.*.tmp')),[])

if __name__=='__main__':unittest.main()
