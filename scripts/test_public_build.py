import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import build_public as b
class PublicBuildTests(unittest.TestCase):
 def test_pdf_allowlist_contains_only_public_identity(self):
  papers=[{'id':'public-one','title':'Published title','doi':'https://doi.org/10.1234/ONE','repo_path':'private/paper.pdf','pdf_sha256':'private'}, {'id':'title-only','title':'Exact published title'}, {'id':'missing','doi':''}, {'id':'__proto__','doi':'10.1234/unsafe'}]
  out=b.pdf_library_registry(papers)
  self.assertEqual(out,{'public-one':{'doi':'10.1234/one','title':'Published title'},'title-only':{'doi':'','title':'Exact published title'}})
  self.assertNotIn('private',json.dumps(out))
  with self.assertRaisesRegex(ValueError,'Conflicting'):
   b.pdf_library_registry([{'id':'one','doi':'10.1234/a'},{'id':'one','doi':'10.1234/b'}])
 def test_private_unknown_fields_never_pass(self):
  p={'id':'one','title':'Public paper','url':'javascript:alert(1)','privateNotes':'secret','api_key':'secret','copies':2,'quantitativeMetrics':{'trialId':'NCT001','private':'secret'},'draftData':{'summary':'draft','source_checked':False},'hasDraft':True}
  out=b.public_paper(p);self.assertNotIn('api_key',out);self.assertNotIn('privateNotes',out);self.assertNotIn('copies',out);self.assertNotIn('draftData',out);self.assertNotIn('private',out['quantitativeMetrics']);self.assertEqual(out['url'],'')
 def test_checked_archive_survives_radar_expiry_and_date(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'data').mkdir();(r/'editorial').mkdir();draft={'doi':'10.1/test','source_checked':True,'summary':'Checked','source_date':'2026-09-01'}
   (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'prepared_on':'2026-09-29','articles':[draft]}))
   (r/'data/curated-archive.json').write_text(json.dumps({'papers':[{'id':'p','title':'Title','doi':'10.1/test','hasDraft':True,'draftData':dict(draft,published='2026-09-29')}]}))
   with patch.object(b,'ROOT',r):
    one=b.make_archive([],[]);self.assertEqual(len(one),1);self.assertEqual(one[0]['draftData']['published'],'2026-09-29')
    (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'prepared_on':'2026-10-01','articles':[draft]}));two=b.make_archive([],[]);self.assertEqual(two[0]['draftData']['published'],'2026-09-29')
 def test_missing_checked_metadata_fails_instead_of_dropping(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'editorial').mkdir();(r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[{'doi':'10.1/missing','source_checked':True}]}))
   with patch.object(b,'ROOT',r),self.assertRaises(ValueError):b.make_archive([],[])
 def test_public_directory_extra_file_blocks_build(self):
  with tempfile.TemporaryDirectory() as d:
   dest=Path(d);(dest/'secret.txt').write_text('secret')
   with patch.object(b,'DEST',dest),self.assertRaises(ValueError):b.main()
 def test_private_paths_stop_publication(self):
  for text in ['/Users/someone/file.pdf','{"api_key":"test"}','.local/llm.json']:
   with self.assertRaises(ValueError):b.validate_public(text)
 def test_replacing_editorial_with_latest_only_blocks_archive_loss(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'data').mkdir();(r/'editorial').mkdir()
   (r/'data/curated-archive.json').write_text(json.dumps({'papers':[{'id':'old','doi':'10.1/old','hasDraft':True,'draftData':{'source_checked':True}}]}))
   (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[]}))
   with patch.object(b,'ROOT',r),self.assertRaisesRegex(ValueError,'withdrawal'):b.make_archive([],[])
 def test_quicklook_provenance_is_preserved_but_private_fields_are_not(self):
  item={'abstractSource':'PubMed','abstractSourceUrl':'https://pubmed.ncbi.nlm.nih.gov/1/','api_key':'private','findings':[{'text':'claim','quote':'source','privateNotes':'secret'}]}
  out=b.public_quicklook(item);self.assertEqual(out['abstractSource'],'PubMed');self.assertEqual(out['abstractSourceUrl'],item['abstractSourceUrl']);self.assertNotIn('api_key',out);self.assertNotIn('privateNotes',out['findings'][0])
 def test_explicit_unpublished_checked_draft_is_not_public(self):
  draft={'source_checked':True,'published':False,'summary':'Withheld'}
  self.assertFalse(b.public_paper({'id':'p','hasDraft':True,'draftData':draft})['hasDraft'])
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'editorial').mkdir()
   (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[dict(draft,id='p')]}))
   with patch.object(b,'ROOT',r):self.assertEqual(b.make_archive([],[]),[])
 def test_missing_abstract_cache_blocks_archive_rebuild(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'data').mkdir();(r/'data/radar-archive.json').write_text('{"rows":[]}')
   with patch.object(b,'ROOT',r),self.assertRaisesRegex(ValueError,'abstract cache missing'):b.make_radar([])
 def test_content_status_keeps_guide_and_ai_dates_separate(self):
  status=b.content_status({'updatedAt':'2026-10-07T00:00:00Z'},{'checkedAt':'2026-10-06T00:00:00Z'},[{'draftData':{'published':'2026-09-30'}}],{'a':{'generatedAt':'2026-10-05T00:00:00Z'}},'2026-10-07T01:00:00Z')
  self.assertEqual(status['guideLatestPublishedAt'],'2026-09-30');self.assertEqual(status['quicklookLatestAt'],'2026-10-05T00:00:00Z');self.assertNotIn('reviewed',status)
if __name__=='__main__':unittest.main()
