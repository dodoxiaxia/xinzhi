import copy,datetime as dt,json,tempfile,unittest,urllib.error
from pathlib import Path
from unittest.mock import patch
import week_precompute as w

CLOCK=dt.datetime(2026,10,7,9,tzinfo=dt.timezone.utc)
ABSTRACT=('METHODS: This randomized trial compared treatment and placebo in 120 patients. '
 'RESULTS: Events occurred in 12 patients with treatment and 24 with placebo. '
 'CONCLUSIONS: There was no significant difference in survival. Limitations included short follow-up.')
QUOTE='Events occurred in 12 patients with treatment and 24 with placebo.'

def paper(number=1,**extra):
 return dict(id='p'+str(number),pmid=str(number),doi='10.1234/'+str(number),title='A randomized clinical trial',date='2026-10-03',dateBasis='ArticleDate',datePrecision='day',clinicalTier='心血管旗舰顶刊',sourceId='pubmed-journal-fallback',summary=ABSTRACT,summary_truncated=False,**extra)
def tr():return {'title_zh':'一项随机临床试验','abstract_zh':'方法：随机试验比较治疗与安慰剂，纳入120例患者。结果：治疗组12例患者发生事件，安慰剂组24例。结论：生存无显著差异；局限为随访较短。'}
def ql():return {'title_zh':'一项随机临床试验','one_line':'生存无显著差异','design':'随机试验','findings':[{'text':'治疗组12例发生事件','quote':QUOTE},{'text':'安慰剂组24例发生事件','quote':QUOTE}],'limits':'随访较短','why_read':'了解摘要证据边界'}
def structure():return {k:{'text':'摘要未提供','quote':''} for k in w.STUDY_FIELDS}

class SelectionTests(unittest.TestCase):
 def test_strict_dates_and_future(self):
  bad=['2026-02-29','2026-10','2026-10-08','2026-09-30','2026-10-07T10:00:00Z','2026-10-01T00:00:00']
  for raw in bad:
   p=paper();p['date']=raw;self.assertEqual(w.select([p],CLOCK)[0],[],raw)
  p=paper();p['date']='2026-09-30T16:00:00Z';self.assertEqual(w.select([p],CLOCK)[0][0]['date'],'2026-10-01')
  for basis in ('published-print',None,'RSS updated'):
   p=paper();p['dateBasis']=basis;self.assertEqual(w.select([p],CLOCK)[0],[])
 def test_quality_no_old_low_relevance_or_partial_padding(self):
  rows=[paper(n) for n in range(1,29)]
  for n,p in enumerate(rows):p['title']='A randomized clinical trial '+chr(65+n//26)+chr(65+n%26)
  rows[0]['date']='2026-09-30';rows[1]['summary_truncated']=True
  rows[2]['title']='Correction: trial';rows[3]['clinicalTier']='前沿大模型与科技';rows[3]['title']='Enterprise partnership news'
  selected,window=w.select(rows,CLOCK);self.assertEqual(len(selected),24);self.assertNotIn('p1',[p['id'] for p in selected]);self.assertEqual(window['eligible'],24)
  selected,window=w.select(rows[:4],CLOCK);self.assertEqual(len(selected),0);self.assertTrue(window['shortfallReason'])
 def test_deduplicates_doi_pmid_title_bridge(self):
  a=paper();b=paper(2);b.update(doi='',title='Different title',pmid='1')
  c=paper(3);c.update(doi='10.1234/2',pmid='2',title='Different title')
  rows=[a,b,c];snapshot=copy.deepcopy(rows);selected,window=w.select(rows,CLOCK)
  self.assertEqual(len(selected),1);self.assertEqual(window['excluded']['duplicates'],2);self.assertEqual(rows,snapshot)
 def test_four_categories_not_filled_with_irrelevant(self):
  a=paper();b=paper(2);b.update(title='Cancer treatment randomized trial',clinicalTier='顶级综合与科学')
  c=paper(3);c.update(title='AI-assisted clinical diagnosis',clinicalTier='AI医疗与数字医学')
  d=paper(4);d.update(title='Large language models discover optimization heuristics',clinicalTier='前沿大模型与科技')
  selected,win=w.select([a,b,c,d],CLOCK);self.assertEqual(set(p['weeklyCategory'] for p in selected),set(w.CATEGORIES))

class CacheAndBudgetTests(unittest.TestCase):
 def setUp(self):self.p=w.select([paper()],CLOCK)[0][0]
 def test_translation_numbers_occurrences_and_quotes_are_strict(self):
  self.assertEqual(w.validate('translate',tr(),self.p),tr());self.assertEqual(w.validate('quicklook',ql(),self.p),ql())
  for task,value in [('translate',dict(tr(),abstract_zh=tr()['abstract_zh'].replace('120','121'))),('translate',dict(tr(),abstract_zh=tr()['abstract_zh']+'120')),('quicklook',dict(ql(),findings=[{'text':'999例','quote':QUOTE},ql()['findings'][1]]))]:
   with self.assertRaises(ValueError):w.validate(task,value,self.p)
  bad=structure();bad['results']={'text':'12例','quote':'Invented English evidence'}
  with self.assertRaises(ValueError):w.validate('study',bad,self.p)
 def test_cache_key_changes_with_source_prompt_model(self):
  cache={'entries':{}};key=w.cache_key(self.p,'translate','model-v1');w.store(cache,self.p,'translate',tr(),'model-v1','2026-10-07','fixture')
  self.assertIsNotNone(w.find(cache,self.p,'translate')[0]);changed=dict(self.p,sourceHash='new');self.assertNotEqual(key,w.cache_key(changed,'translate','model-v1'));self.assertIsNone(w.find(cache,changed,'translate')[0]);self.assertNotEqual(key,w.cache_key(self.p,'translate','model-v2'))
  with patch.object(w,'PROMPT_VERSION','new'):self.assertIsNone(w.find(cache,self.p,'translate')[0])
 def test_budget_precharged_failed_attempt_keeps_sibling_and_pauses(self):
  with tempfile.TemporaryDirectory() as d:
   cp=Path(d)/'cache.json';lp=Path(d)/'ledger.json';cache={'entries':{}};ledger={'days':{}};calls=[]
   def transport(url,payload=None):
    calls.append(payload)
    if payload is None:return {'found':False}
    disk=json.loads(lp.read_text());self.assertEqual(next(iter(disk['days'].values()))['reservedAttempts'],2 if payload['task']=='translate' else 4)
    if payload['task']=='translate':return {'ok':True,'tr':dict(tr(),model='existing',generatedAt='2026-10-07',validationVersion=2,sourceFingerprint=self.p['sourceHash'])}
    raise w.Halt('http_429:provider_rate_limit')
   report=w.acquire_runtime([self.p],cache,cp,ledger,lp,8,True,transport)
   self.assertTrue(report['stopped']);self.assertEqual(report['paidRequests'],2);self.assertTrue(w.find(cache,self.p,'translate')[0]);self.assertEqual(json.loads(cp.read_text()),cache)
   count=len(calls);again=w.acquire_runtime([self.p],cache,cp,ledger,lp,8,True,transport);self.assertTrue(again['stopped']);self.assertEqual(len(calls),count)
 def test_daily_budget_never_exceeded_even_with_worker_retry(self):
  with tempfile.TemporaryDirectory() as d:
   cache={'entries':{}};ledger={'days':{}};posts=[]
   def transport(url,payload=None):
    if payload is None:return {'found':False}
    posts.append(payload);return {'tr':dict(tr(),model='existing',generatedAt='2026-10-07',validationVersion=2,sourceFingerprint=self.p['sourceHash'])}
   report=w.acquire_runtime([self.p],cache,Path(d)/'cache',ledger,Path(d)/'ledger',2,True,transport)
   self.assertEqual(len(posts),1);self.assertEqual(report['reservedModelAttempts'],2);self.assertEqual(report['blocker'],'existing_daily_attempt_budget_exhausted')
 def test_uncertain_started_request_is_never_retried_automatically(self):
  ledger={'days':{w.now().date().isoformat():{'reservedAttempts':2,'requests':[{'status':'started'}]}}}
  with tempfile.TemporaryDirectory() as d:
   report=w.acquire_runtime([self.p],{'entries':{}},Path(d)/'cache',ledger,Path(d)/'ledger',8,True,lambda *a:self.fail('must not call'))
   self.assertEqual(report['blocker'],'uncertain_prior_attempt')
 def test_runtime_source_fingerprint_mismatch_is_not_reused(self):
  self.assertIsNone(w.runtime_value('translate',{'tr':dict(tr(),validationVersion=2,sourceFingerprint='wrong')},self.p))
 def test_configured_batch_one_call_covers_three_tasks_and_preserves_partial_on_403(self):
  cache={'entries':{}};ledger={'days':{}};calls=[]
  second=dict(self.p,paperID='doi:10.1234/2',id='p2',doi='10.1234/2',pmid='2')
  with tempfile.TemporaryDirectory() as d,patch.dict(w.os.environ,{'XINZHI_LLM_ENDPOINT':'https://model.fixture/api','XINZHI_LLM_MODEL':'existing','XINZHI_LLM_API_KEY':'fixture-secret'}):
   def call(public):
    calls.append(public);self.assertEqual(set(public),{'title','journal','abstract','missingTasks'})
    if len(calls)==2:raise w.Halt('provider_http_403')
    return {'translate':tr(),'study':structure(),'quicklook':ql()}
   report=w.configured_batch([self.p,second],cache,Path(d)/'cache',ledger,Path(d)/'ledger',8,call)
   self.assertTrue(report['stopped']);self.assertEqual(report['blocker'],'provider_http_403');self.assertEqual(len(calls),2)
   self.assertTrue(all(w.find(cache,self.p,t)[0] for t in w.TASKS));self.assertNotIn('fixture-secret',json.dumps(cache)+json.dumps(ledger))
   again=w.configured_batch([self.p,second],cache,Path(d)/'cache',ledger,Path(d)/'ledger',8,call)
   self.assertTrue(again['stopped']);self.assertEqual(len(calls),2)
 def test_configured_batch_invalid_sibling_does_not_destroy_successes(self):
  cache={'entries':{}};ledger={'days':{}}
  with tempfile.TemporaryDirectory() as d,patch.dict(w.os.environ,{'XINZHI_LLM_ENDPOINT':'https://model.fixture/api','XINZHI_LLM_MODEL':'existing','XINZHI_LLM_API_KEY':'fixture-secret'}):
   report=w.configured_batch([self.p],cache,Path(d)/'cache',ledger,Path(d)/'ledger',1,lambda public:{'translate':tr(),'study':{'wrong':'field'},'quicklook':ql()})
   self.assertEqual(report['generatedTasks'],2);self.assertTrue(report['stopped']);self.assertTrue(w.find(cache,self.p,'translate')[0]);self.assertTrue(w.find(cache,self.p,'quicklook')[0]);self.assertIsNone(w.find(cache,self.p,'study')[0])
 def test_identity_checked_source_hydration_preserves_real_publication_day(self):
  from hydrate_week_public_sources import fetch
  source={'resultList':{'result':[{'doi':self.p['doi'],'pmid':self.p['pmid'],'title':self.p['title'],'firstPublicationDate':'2026-09-17','abstractText':ABSTRACT}]}}
  result=fetch(self.p,lambda url:source)
  self.assertEqual(result['date'],'2026-09-17');self.assertEqual(w.select([result],CLOCK)[0],[])
  source['resultList']['result'][0]['doi']='10.1234/wrong'
  with self.assertRaises(w.Halt):fetch(self.p,lambda url:source)
 def test_runtime_truncated_fingerprint_is_matched_and_revalidated(self):
  value={'tr':dict(tr(),validationVersion=2,sourceFingerprint=self.p['sourceHash'][:16],model='existing')}
  self.assertIsNotNone(w.runtime_value('translate',value,self.p))
  value['tr']['sourceFingerprint']='0'*16
  self.assertIsNone(w.runtime_value('translate',value,self.p))
 def test_public_ui_contract_has_both_identity_aliases_and_safe_meta(self):
  from build_public import public_weekly_board,pregenerated_map
  cache={'entries':{}};w.store(cache,self.p,'translate',tr(),'existing','2026-10-07','fixture')
  data=w.board([self.p],w.select([paper()],CLOCK)[1],cache,{'secret':'excluded'})
  data['items'][0]['privatePath']='secret'
  public=public_weekly_board(data);mapping=pregenerated_map(public)
  self.assertEqual(mapping['pmid:1'],mapping['doi:10.1234/1'])
  self.assertEqual(mapping['pmid:1']['translation'],tr());self.assertNotIn('secret',json.dumps(mapping))
  self.assertFalse(mapping['pmid:1']['meta']['allowAutomaticGeneration'])
 def test_board_contract_explicit_pending_and_no_auto_generation(self):
  board=w.board([self.p],w.select([paper()],CLOCK)[1],{'entries':{}},{'mode':'offline'})
  row=board['items'][0];self.assertFalse(row['allowAutomaticGeneration']);self.assertEqual(row['missingTasks'],list(w.TASKS));self.assertEqual(row['precomputeStatus'],'pending');self.assertIn('未阅读全文',board['caveat'])

if __name__=='__main__':unittest.main()
