import contextlib,io,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import build_public as b
import pdf_identity as pi
from editorial_review import content_sha256

def write_legacy(root,draft,date='2026-09-29'):
 key=draft.get('doi') or draft['id']
 (root/'editorial/legacy_published_guides.json').write_text(json.dumps({'schema_version':1,'guides':{key:{'content_sha256':content_sha256(draft,key),'published_on':date}}}))

class PublicBuildTests(unittest.TestCase):
 def test_doi_policy_projection_is_pinned_and_contains_only_reviewed_identities(self):
  out=b.doi_adjudication_registry()
  self.assertEqual(out['sourceCommit'],'fed03f8d789429fc84c94cefcb4b636d75ec9ee3')
  self.assertEqual(out['decisions']['10.1016/j.landig'],{'action':'hold','acceptedTitles':[],'metadata':None})
  for row in out['decisions'].values():
   self.assertEqual(set(row),{'action','acceptedTitles','metadata'})
  self.assertNotIn('reason',json.dumps(out))
  self.assertNotIn('evidence',json.dumps(out))
 def test_malformed_doi_policy_blocks_build_projection(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'config').mkdir()
   source=b.load('config/public_library_adjudications.json')
   for change in ('source','schema','identity'):
    policy=json.loads(json.dumps(source))
    if change=='source':policy['sourceCommit']='invalid'
    elif change=='schema':policy['decisions'][0]['unknown']='unreviewed'
    else:policy['decisions'][1]['doi']='10.1000/private?token=bad'
    (root/'config/public_library_adjudications.json').write_text(json.dumps(policy))
    with patch.object(b,'ROOT',root),self.assertRaises(ValueError):b.doi_adjudication_registry()
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
   write_legacy(r,draft)
   (r/'data/curated-archive.json').write_text(json.dumps({'papers':[{'id':'p','title':'Title','doi':'10.1/test','hasDraft':True,'draftData':dict(draft,published='2026-09-29')}]}))
   with patch.object(b,'ROOT',r):
    one=b.make_archive([],[]);self.assertEqual(len(one),1);self.assertEqual(one[0]['draftData']['published'],'2026-09-29')
    (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'prepared_on':'2026-10-01','articles':[draft]}));two=b.make_archive([],[]);self.assertEqual(two[0]['draftData']['published'],'2026-09-29')
 def test_missing_checked_metadata_fails_instead_of_dropping(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'editorial').mkdir();draft={'doi':'10.1/missing','source_checked':True};write_legacy(r,draft);(r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[draft]}))
   with patch.object(b,'ROOT',r),self.assertRaises(ValueError):b.make_archive([],[])
 def test_public_directory_extra_file_blocks_build(self):
  with tempfile.TemporaryDirectory() as d:
   from test_release_build import synthetic_root
   root=Path(d);synthetic_root(root);dest=root/'public';dest.mkdir();(dest/'secret.txt').write_text('secret')
   with patch.object(b,'ROOT',root),patch.object(b,'DEST',dest),self.assertRaisesRegex(ValueError,'Unexpected public files'):b.main()
 def test_obsolete_public_file_is_replaced_by_build(self):
  with tempfile.TemporaryDirectory() as d:
   from test_release_build import synthetic_root
   root=Path(d);synthetic_root(root);dest=root/'public';dest.mkdir();(dest/'icon.svg').write_text('<svg>old release</svg>')
   with patch.object(b,'ROOT',root),patch.object(b,'DEST',dest),contextlib.redirect_stdout(io.StringIO()):b.main()
   self.assertEqual({p.name for p in dest.iterdir()},b.PUBLIC)
   self.assertTrue((dest/'icon.png').read_bytes().startswith(b'\x89PNG'))
   self.assertIn('/icon.png',(dest/'_headers').read_text())
 def test_snapshot_guard_holds_before_replacing_previous_public_build(self):
  from test_release_build import synthetic_root
  for failure in ('missing_snapshot','changed_snapshot','missing_approved_id'):
   with self.subTest(failure=failure),tempfile.TemporaryDirectory() as d:
    root=Path(d);synthetic_root(root);dest=root/'public';dest.mkdir()
    output=dest/'public.js';output.write_text('// previous published bytes')
    receipt=root/'docs/public-manifest.json';receipt.write_text('previous receipt')
    snapshot=root/'editorial/public_library_snapshot.json'
    if failure=='missing_snapshot':snapshot.unlink()
    elif failure=='changed_snapshot':snapshot.write_bytes(snapshot.read_bytes()+b' ')
    else:
     state=json.loads((root/'data/library.json').read_text());state['papers']=[]
     (root/'data/library.json').write_text(json.dumps(state))
    with patch.object(b,'ROOT',root),patch.object(b,'DEST',dest),self.assertRaisesRegex(ValueError,'public_library_snapshot_hold'):
     b.main()
    self.assertEqual(output.read_text(),'// previous published bytes')
    self.assertEqual(receipt.read_text(),'previous receipt')
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
   write_legacy(r,dict(draft,id='p'))
   with patch.object(b,'ROOT',r):self.assertEqual(b.make_archive([],[]),[])
 def test_missing_abstract_cache_blocks_archive_rebuild(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'data').mkdir();(r/'data/radar-archive.json').write_text('{"rows":[]}')
   with patch.object(b,'ROOT',r),self.assertRaisesRegex(ValueError,'abstract cache missing'):b.make_radar([])
 def test_content_status_keeps_guide_and_ai_dates_separate(self):
  status=b.content_status({'updatedAt':'2026-10-07T00:00:00Z'},{'checkedAt':'2026-10-06T00:00:00Z'},[{'draftData':{'published':'2026-09-30'}}],{'a':{'generatedAt':'2026-10-05T00:00:00Z'}},'2026-10-07T01:00:00Z')
  self.assertEqual(status['guideLatestPublishedAt'],'2026-09-30');self.assertEqual(status['quicklookLatestAt'],'2026-10-05T00:00:00Z');self.assertNotIn('reviewed',status)
 def test_new_checked_draft_with_implicit_or_explicit_date_stays_private(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'editorial').mkdir()
   write_legacy(r,{'id':'previously-published-synthetic','source_checked':True})
   for date in (None,True,'2026-10-01'):
    draft={'doi':'10.1/new','source_checked':True,'summary':'Pending physician review','published':date}
    (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'prepared_on':'2026-10-01','articles':[draft]}))
    with patch.object(b,'ROOT',r):
     self.assertEqual(b.make_archive([{'doi':'10.1/new','title':'New paper'}],[]),[])
     self.assertNotIn('draftData',b.public_paper({'doi':'10.1/new','hasDraft':True,'draftData':draft}))
 def test_legacy_edit_or_redate_blocks_build(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'editorial').mkdir();draft={'doi':'10.1/old','source_checked':True,'summary':'Original'};write_legacy(r,draft)
   for altered in (dict(draft,summary='Edited'),dict(draft,published='2026-10-07')):
    (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[altered]}))
    with patch.object(b,'ROOT',r),self.assertRaises(ValueError):b.make_archive([],[])
 def test_approved_handoff_is_public_but_review_identity_is_private(self):
  from test_editorial_review import approved_draft
  draft=approved_draft()
  out=b.public_paper({'doi':draft['doi'],'hasDraft':True,'draftData':draft})
  self.assertTrue(out['hasDraft']);self.assertEqual(out['draftData']['published'],'2026-10-07')
  for field in ('review','publication','reviewer','body_markdown','source_document_sha256'):
   self.assertNotIn(field,out['draftData'])
 def test_weekly_handoff_cannot_be_misrepresented_as_short_guide(self):
  from test_editorial_review import approved_draft
  draft=approved_draft(weekly=True)
  with self.assertRaisesRegex(ValueError,'issue renderer'):
   b.public_paper({'doi':draft['doi'],'hasDraft':True,'draftData':draft})
 def test_main_decision_overrides_stale_cached_approved_draft(self):
  from test_editorial_review import approved_draft
  draft=approved_draft();paper={'doi':draft['doi'],'hasDraft':True,'draftData':draft}
  for current in ({},dict(draft,published=False),dict(draft,review={'state':'awaiting_physician'})):
   out=b.public_paper(paper,{draft['doi']:current})
   self.assertFalse(out['hasDraft']);self.assertNotIn('draftData',out)
  self.assertFalse(b.public_paper(paper,{})['hasDraft'])
 def test_pending_revision_of_history_blocks_build_but_explicit_withdrawal_is_allowed(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'data').mkdir();(r/'editorial').mkdir()
   old={'doi':'10.1/old','source_checked':True,'summary':'Published'}
   write_legacy(r,old)
   (r/'data/curated-archive.json').write_text(json.dumps({'papers':[{'doi':old['doi'],'hasDraft':True,'draftData':old}]}))
   pending=dict(old,summary='Pending replacement',review={'state':'awaiting_physician'})
   (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[pending]}))
   with patch.object(b,'ROOT',r),self.assertRaisesRegex(ValueError,'published history'):b.make_archive([],[])
   pending['published']=False
   (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[pending]}))
   with patch.object(b,'ROOT',r):self.assertEqual(b.make_archive([],[]),[])
 def test_duplicate_revisions_cannot_disagree_about_publication(self):
  from test_editorial_review import approved_draft
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'editorial').mkdir();approved=approved_draft();pending=dict(approved,published=False)
   (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[approved,pending]}))
   with patch.object(b,'ROOT',r),self.assertRaisesRegex(ValueError,'Duplicate'):b.make_archive([],[])
 def test_missing_legacy_registry_holds_even_without_state_archive(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'editorial').mkdir()
   draft={'doi':'10.1/old','source_checked':True,'summary':'Previously published'}
   (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[draft]}))
   with patch.object(b,'ROOT',r),self.assertRaisesRegex(ValueError,'registry is missing or invalid'):
    b.make_archive([{'doi':draft['doi'],'title':'Old paper'}],[])
 def test_invalid_legacy_registry_holds_instead_of_silently_dropping_history(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);(r/'editorial').mkdir()
   draft={'doi':'10.1/old','source_checked':True,'summary':'Previously published'}
   (r/'editorial/source_checked_drafts.json').write_text(json.dumps({'articles':[draft]}))
   valid={'schema_version':1,'guides':{draft['doi']:{'content_sha256':content_sha256(draft,draft['doi']),'published_on':'2026-09-29'}}}
   malformed=['{',json.dumps([]),json.dumps({'schema_version':True,'guides':valid['guides']}),
              json.dumps({'schema_version':1,'guides':{}}),json.dumps({'schema_version':1,'guides':[]})]
   for field,value in [('content_sha256','bad'),('published_on','2026-02-30'),('published_on',None)]:
    changed=json.loads(json.dumps(valid));changed['guides'][draft['doi']][field]=value
    malformed.append(json.dumps(changed))
   for text in malformed:
    with self.subTest(registry=text):
     (r/'editorial/legacy_published_guides.json').write_text(text)
     with patch.object(b,'ROOT',r),self.assertRaisesRegex(ValueError,'registry is missing or invalid'):
      b.make_archive([{'doi':draft['doi'],'title':'Old paper'}],[])
 def test_asset_size_guard_warns_at_70_percent_and_stops_at_90(self):
  limit=1000
  thresholds={'limitBytes':limit,'warnRatio':0.70,'failRatio':0.90}
  self.assertEqual(b.asset_size_findings({'a.js':b'x'*699},thresholds),[])
  warned=b.asset_size_findings({'a.js':b'x'*700},thresholds)
  self.assertEqual(len(warned),1)
  self.assertIn('700',warned[0]);self.assertIn('70%',warned[0])
  self.assertEqual(len(b.asset_size_findings({'a.js':b'x'*899},thresholds)),1)
  with self.assertRaisesRegex(ValueError,'构建停止'):
   b.asset_size_findings({'public.js':b'x'*900,'ok.js':b'x'},thresholds)
  with self.assertRaisesRegex(ValueError,'体积阈值无效'):
   b.asset_thresholds({'XINZHI_ASSET_LIMIT_BYTES':'0','XINZHI_ASSET_WARN_RATIO':'0.7','XINZHI_ASSET_FAIL_RATIO':'0.9'})
  with self.assertRaisesRegex(ValueError,'体积阈值无效'):
   b.asset_thresholds({'XINZHI_ASSET_WARN_RATIO':'0.95','XINZHI_ASSET_FAIL_RATIO':'0.9'})
  custom=b.asset_thresholds({'XINZHI_ASSET_LIMIT_BYTES':'500','XINZHI_ASSET_WARN_RATIO':'0.5','XINZHI_ASSET_FAIL_RATIO':'0.8'})
  self.assertEqual(custom,{'limitBytes':500,'warnRatio':0.5,'failRatio':0.8})
 def test_reading_shards_keep_a_stable_hash_until_that_month_changes(self):
  def item(pmcid,month,text):
   return {'pmcid':pmcid,'publishedOn':month+'-02','title':'T','titleZh':'题','sections':{'question':{'text':text,'evidence':[]}}}
  base={'schemaVersion':1,'status':{'state':'complete'},'items':[item('PMC1','2026-11','十一月正文'),item('PMC2','2026-10','十月正文')]}
  index,shards=b.split_deep_readings(base)
  self.assertTrue(all('sections' not in row for row in index['items']))
  self.assertEqual(set(index['shards']),{'2026-10','2026-11'})
  self.assertEqual(b.split_deep_readings(base)[1],shards)
  changed=json.loads(json.dumps(base));changed['items'][0]['sections']['question']['text']='十一月正文已改'
  index2,shards2=b.split_deep_readings(changed)
  self.assertEqual(index2['shards']['2026-10'],index['shards']['2026-10'])
  self.assertNotEqual(index2['shards']['2026-11'],index['shards']['2026-11'])
  self.assertIn('十月正文',shards[index['shards']['2026-10']].decode())
  self.assertNotIn('十月正文',json.dumps(index,ensure_ascii=False))
  with self.assertRaisesRegex(ValueError,'重复'):
   b.split_deep_readings({'items':[item('PMC1','2026-11','a'),item('PMC1','2026-10','b')]})
 def test_build_publishes_hashed_reading_shards_and_drops_stale_ones(self):
  with tempfile.TemporaryDirectory() as d:
   from test_release_build import synthetic_root
   root=Path(d);synthetic_root(root);dest=root/'public';dest.mkdir();(dest/'shards').mkdir()
   stale=dest/'shards'/'readings-2026-09.aaaaaaaaaaaa.js';stale.write_text('old')
   readings={'schemaVersion':1,'status':{'state':'complete'},'items':[
    {'pmcid':'PMC111','publishedOn':'2026-11-12','title':'November','titleZh':'十一月题名','humanReviewed':False,'scope':'public-fulltext-body','sections':{'question':{'text':'十一月正文只在分片里','evidence':[]}}},
    {'pmcid':'PMC222','publishedOn':'2026-10-03','title':'October','titleZh':'十月题名','humanReviewed':False,'scope':'public-fulltext-body','sections':{'question':{'text':'十月正文只在分片里','evidence':[]}}}]}
   with patch.object(b,'ROOT',root),patch.object(b,'DEST',dest),patch.object(b,'public_readings',return_value=readings),contextlib.redirect_stdout(io.StringIO()):
    b.main()
   self.assertFalse(stale.exists())
   text=(dest/'public.js').read_text()
   self.assertNotIn('只在分片',text)
   shard_files=list((dest/'shards').glob('readings-*.js'))
   self.assertEqual(len(shard_files),2)
   manifest=json.loads((root/'docs'/'public-manifest.json').read_text())
   paths={row['path']:row['bytes'] for row in manifest['files']}
   self.assertEqual(paths['public.js'],(dest/'public.js').stat().st_size)
   for shard in shard_files:
    rel='shards/'+shard.name
    self.assertEqual(paths[rel],shard.stat().st_size)
    self.assertIn(rel,text)
    self.assertIn('只在分片',shard.read_text())
   self.assertEqual(manifest['assetLimit']['limitBytes'],b.ASSET_LIMIT_BYTES)
   self.assertEqual(manifest['assetLimit']['warnRatio'],0.70)
   self.assertEqual(manifest['assetLimit']['failRatio'],0.90)
   self.assertEqual(manifest['assetLimit']['warnings'],[])
   self.assertIn('/shards/*',(dest/'_headers').read_text())
 def test_oversized_asset_stops_before_replacing_public_files(self):
  with tempfile.TemporaryDirectory() as d:
   from test_release_build import synthetic_root
   root=Path(d);synthetic_root(root);dest=root/'public';dest.mkdir()
   (dest/'public.js').write_text('// previous published bytes')
   env={'XINZHI_ASSET_LIMIT_BYTES':'100','XINZHI_ASSET_WARN_RATIO':'0.70','XINZHI_ASSET_FAIL_RATIO':'0.90'}
   with patch.object(b,'ROOT',root),patch.object(b,'DEST',dest),patch.dict(os.environ,env),self.assertRaisesRegex(ValueError,'构建停止'):
    b.main()
   self.assertEqual((dest/'public.js').read_text(),'// previous published bytes')
 def test_download_button_only_where_exactly_one_index_row_matches(self):
  row=lambda title,doi='',sha='a'*64,path='期刊/a.pdf':{'题名':title,'DOI':doi,'当前路径':path,'SHA256':sha}
  rows=[row('Exact DOI paper','https://doi.org/10.1000/ONE'),row('Title only paper'),row('Twice DOI','10.1000/dup',sha='d'*64),row('Twice DOI again','10.1000/dup',sha='e'*64),
   row('Same title'),row('Same title'),row('Registered twice','10.1000/twice'),row('Registered twice again','10.1000/TWICE',path='期刊/b.pdf'),
   row('Twice but one unusable','10.1000/half'),row('Twice but one unusable too','10.1000/half',path='../x.pdf'),row('Twice other sha','10.1000/other'),row('Twice other sha too','10.1000/other',sha='f'*64),
   row('Same SHA title'),row('Same SHA title',sha='A'*64),row('Diff sha title'),row('Diff sha title',sha='9'*64),row('Broken sha','10.1000/bad',sha='nothex'),row('Unsafe path','10.1000/path',path='../x.pdf'),
   row('Column paper'),row('AI IN MEDICINE Indexed with label'),row('Wrong DOI paper','10.1001/right')]
  snap=pi.build_snapshot(rows)
  papers=[{'id':'doi-ok','doi':'10.1000/one','title':'whatever'},{'id':'title-ok','title':'title  ONLY paper'},{'id':'doi-dup','doi':'10.1000/dup'},
   {'id':'title-dup','title':'Same title'},{'id':'twice-same-file','doi':'10.1000/twice'},{'id':'half-unusable','doi':'10.1000/half'},{'id':'twice-other-sha','doi':'10.1000/other'},{'id':'title-twice-same-file','title':'Same SHA title'},{'id':'title-other-sha','title':'Diff sha title'},{'id':'sha-bad','doi':'10.1000/bad'},{'id':'path-bad','doi':'10.1000/path'},
   {'id':'prefixed','title':'AI IN MEDICINE Column paper'},{'id':'index-prefixed','title':'Indexed with label'},
   {'id':'lowercase-label','title':'Ai in medicine Column paper'},{'id':'other-label','title':'NEWS Column paper'},
   {'id':'wrong-doi','doi':'10.1097/acm.0000000000001323','title':'Wrong DOI paper'},{'id':'bad-doi-format','doi':'not-a-doi','title':'Title only paper'},
   {'id':'unknown','title':'Not in the index'},{'id':'empty'},{'id':'held','doi':'10.1000/one'},{'id':'doi-title-ignored','doi':'10.1000/one','title':'Different'}]
  self.assertEqual(pi.downloadable_ids(papers,snap,{'held'}),sorted(['doi-ok','title-ok','prefixed','index-prefixed','doi-title-ignored','twice-same-file','title-twice-same-file','title-dup']))
 def test_prefix_removal_keeps_a_unique_match_requirement(self):
  rows=[{'题名':'Column paper','DOI':'','当前路径':'a.pdf','SHA256':'a'*64},{'题名':'AI IN MEDICINE Column paper','DOI':'','当前路径':'b.pdf','SHA256':'b'*64}]
  self.assertEqual(pi.downloadable_ids([{'id':'p','title':'AI IN MEDICINE Column paper'},{'id':'q','title':'Column paper'}],pi.build_snapshot(rows)),[])
  self.assertEqual(pi.title_key('AI IN MEDICINE'),'ai in medicine')
  self.assertEqual(pi.title_key('AI IN MEDICINE: A study'),'ai in medicine: a study')
  self.assertEqual(pi.title_key('  AI IN MEDICINE \u3000 Will   it?'),'will it?')
 def test_snapshot_keeps_titles_paths_and_checksums_private(self):
  rows=[{'题名':'Very private title','DOI':'10.1000/secret','当前路径':'私有/路径.pdf','SHA256':'c'*64,'文件类别':'补充材料'}]
  snap=pi.build_snapshot(rows)
  self.assertEqual(snap['schema'],3);self.assertEqual(len(snap['rows'][0]),4);self.assertEqual(snap['rows'][0][3],'x')
  text=json.dumps(snap,ensure_ascii=False)
  for word in ('private','secret','私有','路径','c'*64,'10.1000','补充','正文'):self.assertNotIn(word,text)
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'config').mkdir()
   with self.assertRaisesRegex(ValueError,'missing'):pi.load_snapshot(root)
   h='0'*24
   for bad in ({'schema':1,'generatedOn':'2026-11-13','rowCount':0,'rows':[]},{'schema':2,'generatedOn':'2026-11-13','rowCount':0,'rows':[]},
     {'schema':2,'generatedOn':'2026-11-13','rowCount':1,'rows':[[h,'',h]]},{'schema':3,'generatedOn':'2026-11-13','rowCount':1,'rows':[]},
     {'schema':3,'generatedOn':'2026-11-13','rowCount':1,'rows':[['x','','','']]},{'schema':3,'generatedOn':'2026-11-13','rowCount':1,'rows':[['','',1,'']]},
     {'schema':3,'generatedOn':'2026-11-13','rowCount':1,'rows':[[h,'',h]]},{'schema':3,'generatedOn':'2026-11-13','rowCount':1,'rows':[[h,'',h,'','']]},
     {'schema':3,'generatedOn':'2026-11-13','rowCount':1,'rows':[[h,'',h,'正文']]},{'schema':3,'generatedOn':'2026-11-13','rowCount':1,'rows':[[h,'',h,'y']]},
     {'schema':3,'generatedOn':'2026-11-13','rowCount':1,'rows':[[h,'',h,None]]},{'schema':3,'generatedOn':'later','rowCount':0,'rows':[]}):
    (root/'config/pdf_index_keys.json').write_text(json.dumps(bad))
    with self.assertRaises(ValueError):pi.load_snapshot(root)
   (root/'config/pdf_index_keys.json').write_text(json.dumps(pi.build_snapshot(rows)))
   self.assertEqual(pi.load_snapshot(root)['rowCount'],1)
   for code in ('','m','x'):
    (root/'config/pdf_index_keys.json').write_text(json.dumps({'schema':3,'generatedOn':'2026-11-13','rowCount':1,'rows':[[h,'',h,code]]}))
    self.assertEqual(pi.load_snapshot(root)['rows'][0][3],code)
 def test_snapshot_category_codes_follow_the_worker_constants(self):
  self.assertEqual((pi.CATEGORY_COLUMN,pi.CATEGORY_MAIN),('文件类别','正文'))
  base={'题名':'t','DOI':'','当前路径':'a.pdf','SHA256':'a'*64}
  for value,code in ((None,''),('',''),('  ',''),('正文','m'),(' 正文\u3000','m'),('补充材料','x'),('译本','x'),('待定','x'),('正文本','x')):
   row=dict(base) if value is None else {**base,'文件类别':value}
   self.assertEqual(pi.build_snapshot([row])['rows'][0][3],code,value)
  csv_text='\ufeff题名,DOI,期刊,实际出版日期,日期来源,当前路径,SHA256,文件类别\r\nA,10.1000/a,j,,,a.pdf,'+'a'*64+',正文\r\nB,10.1000/a,j,,,b.pdf,'+'b'*64+',补充材料\r\n'
  self.assertEqual(sorted(r[3] for r in pi.build_snapshot(pi.read_index_csv(csv_text.encode('utf-8')))['rows']),['m','x'])
  old_csv='题名,DOI,期刊,实际出版日期,日期来源,当前路径,SHA256\r\nA,10.1000/a,j,,,a.pdf,'+'a'*64+'\r\n'
  self.assertEqual(pi.build_snapshot(pi.read_index_csv(old_csv))['rows'][0][3],'')
 def test_download_button_follows_the_file_category_rule(self):
  def row(doi,cat=None,s='a',title='T',path=None):
   r={'题名':title,'DOI':doi,'当前路径':path or ('期刊/'+s+'.pdf'),'SHA256':s*64}
   if cat is not None:r['文件类别']=cat
   return r
  cases={
   'c01-main-supplement':([row('10.2000/c01','补充材料','b'),row('10.2000/c01','正文','a')],True),
   'c02-main-translation':([row('10.2000/c02','译本','b'),row('10.2000/c02','正文','a')],True),
   'c03-two-supplements-main':([row('10.2000/c03','补充材料','b'),row('10.2000/c03','正文','a'),row('10.2000/c03','补充材料','c')],True),
   'c04-all-blank':([row('10.2000/c04','','a'),row('10.2000/c04','','b')],False),
   'c05-no-main':([row('10.2000/c05','补充材料','a'),row('10.2000/c05','译本','b')],False),
   'c06-two-mains-differ':([row('10.2000/c06','正文','a'),row('10.2000/c06','正文','b')],False),
   'c07-two-mains-same':([row('10.2000/c07','正文','a'),row('10.2000/c07','正文','a',path='期刊/other.pdf')],True),
   'c08-single-supplement':([row('10.2000/c08','补充材料','a')],False),
   'c09-single-main':([row('10.2000/c09','正文','a')],True),
   'c10-main-blank':([row('10.2000/c10','','b'),row('10.2000/c10','正文','a')],True),
   'c11a-no-column-one':([row('10.2000/c11a')],True),
   'c11b-no-column-same':([row('10.2000/c11b'),row('10.2000/c11b')],True),
   'c11c-no-column-differ':([row('10.2000/c11c',s='a'),row('10.2000/c11c',s='b')],False),
   'unknown-value-main':([row('10.2000/u1','待定','b'),row('10.2000/u1','正文','a')],True),
   'single-translation':([row('10.2000/u2','译本','a')],False),
   'single-blank':([row('10.2000/u3','','a')],True),
   'main-unusable':([row('10.2000/u4','补充材料','b'),row('10.2000/u4','正文','a',path='../x.pdf')],False),
   'title-main-supplement':([row('','补充材料','b',title='Category title paper'),row('','正文','a',title='Category title paper')],True),
   'title-single-supplement':([row('','补充材料','a',title='Lonely supplement paper')],False)}
  rows=[r for case_rows,_ in cases.values() for r in case_rows]
  papers=[{'id':case,'doi':case_rows[0]['DOI'],'title':case_rows[0]['题名']} for case,(case_rows,_) in cases.items()]
  # A DOI paper never falls back to the title, even when the title has a main-text row.
  papers.append({'id':'doi-first','doi':'10.2000/c08','title':'Category title paper'})
  self.assertEqual(pi.downloadable_ids(papers,pi.build_snapshot(rows)),sorted(case for case,(_,expected) in cases.items() if expected))
 def test_committed_snapshot_is_valid_and_complete(self):
  snap=pi.load_snapshot(Path(__file__).resolve().parents[1])
  self.assertEqual(snap['schema'],3)
  self.assertGreater(snap['rowCount'],1000)
  self.assertTrue(all(r[2] for r in snap['rows']))
 def test_python_and_worker_normalise_identically(self):
  import shutil,subprocess
  node=shutil.which('node')
  if not node:self.skipTest('node is not installed')
  worker=(Path(__file__).resolve().parents[1]/'edge/src/00-header-pdf.js').read_text(encoding='utf-8')
  start,end=worker.index('const pdfDoi = '),worker.index('const pdfEscape = ')
  samples=['AI IN MEDICINE Will Autonomous AI?','AI IN MEDICINE  Two  spaces','AI IN MEDICINE','AI IN MEDICINE: colon','ai in medicine lower',' \u00a0AI IN MEDICINE\u3000Nbsp title\ufeff',
   'Straße ΣΊΣΥΦΟΣ ŉ ǰ','İstanbul ǅ','Tabs\tand\nnewlines','中文题名 AI IN MEDICINE','','  ','https://doi.org/10.1001/JAMA.2026.1','doi: 10.1000/x y','10.1000/'+'a'*201,'10.123/short','DOI:10.1001/ok']
  script=worker[start:end]+'\nconst samples=JSON.parse(process.argv[1]);console.log(JSON.stringify(samples.map(v=>[pdfDoi(v),pdfTitle(v),pdfTitleKey(v)])));'
  out=subprocess.run([node,'-e',script,json.dumps(samples)],capture_output=True,text=True,check=True).stdout
  self.assertEqual(json.loads(out),[[pi.pdf_doi(v),pi.pdf_title(v),pi.title_key(v)] for v in samples])
 def test_build_lists_download_ids_and_restricts_worker_allowlist(self):
  from test_release_build import synthetic_root
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);synthetic_root(root);dest=root/'public';dest.mkdir()
   rows=[{'题名':'Synthetic clinical trial','DOI':'10.1234/synthetic','当前路径':'a.pdf','SHA256':'a'*64}]
   with patch.object(b,'ROOT',root),patch.object(b,'DEST',dest),contextlib.redirect_stdout(io.StringIO()):
    (root/'config/pdf_index_keys.json').write_text(json.dumps(pi.build_snapshot([])));b.main()
    bundle=(dest/'public.js').read_text();worker=(dest/'_worker.js').read_text()
    self.assertIn('"pdfIds":[]',bundle);self.assertIn('const PDF_LIBRARY = {};',worker)
    for f in dest.iterdir():
     if f.is_file():f.unlink()
    (root/'config/pdf_index_keys.json').write_text(json.dumps(pi.build_snapshot(rows)));b.main()
    bundle=(dest/'public.js').read_text();worker=(dest/'_worker.js').read_text()
    ids=json.loads(bundle[bundle.index('"pdfIds":')+9:].split(']')[0]+']')
    self.assertEqual(len(ids),1);self.assertIn('"'+ids[0]+'":{"doi":"10.1234/synthetic"',worker)
if __name__=='__main__':unittest.main()
