import unittest,sys,json,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from refresh_feeds import parse,dateval
from build_data import clean,classify
ROOT=Path(__file__).resolve().parents[1]
class PipelineTests(unittest.TestCase):
 def test_rss_namespaced_date(self):
  raw=b'<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>AI-enabled cardiac screening</title><link>https://example.com/paper</link><dc:date>2026-09-29</dc:date></item></channel></rss>'
  p=parse(raw,{'name':'Heart','id':'test'})[0]
  self.assertEqual(p['category'],'交叉研究');self.assertTrue(p['date'].startswith('2026-09-29'))
 def test_atom_and_unsafe_url(self):
  raw=b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Artificial intelligence in health</title><link href="https://example.com/paper"/><updated>2026-09-29T00:00:00Z</updated></entry><entry><title>Cardiac AI</title><link href="javascript:alert(1)"/></entry></feed>'
  p=parse(raw,{'name':'Digital Medicine','id':'t'});self.assertEqual(len(p),1);self.assertEqual(p[0]['url'],'https://example.com/paper')
 def test_general_and_ai_sources_not_lost(self):
  self.assertEqual(classify('A randomized trial of pneumonia care','NEJM'),'综合医学')
  self.assertEqual(classify('Climate risk with machine learning','Nature Machine Intelligence'),'AI前沿')
  self.assertEqual(classify('Total intravenous anesthesia for noncardiac surgery','JAMA'),'综合医学')
  self.assertEqual(classify('Tumor ablation with nanoparticles','Science Advances'),'待分类')
 def test_unknown_date_not_today(self):self.assertEqual(dateval('not dated'),'')
 def test_strips_source_markup(self):self.assertEqual(clean('<b>Heart &amp; AI</b>'),'Heart & AI')
 def test_library_unique_and_paths_not_exposed(self):
  data=json.loads((ROOT/'data/library.json').read_text());ids=[p['id'] for p in data['papers']]
  self.assertEqual(len(ids),len(set(ids)));self.assertNotIn('/Users/',json.dumps(data));self.assertEqual(data['stats']['papers'],len(ids))
 def test_public_allowlist(self):
  files={p.name for p in (ROOT/'public').iterdir()}
  self.assertEqual(files,{'index.html','style.css','public.js','icon.svg','_headers','_worker.js'})
  source=(ROOT/'public/index.html').read_text()
  for forbidden in ('weeklyNotes','localStorage','当前路径','/Users/','data/library.js','reviewer','QA临时记录'):
   self.assertNotIn(forbidden,source)
  self.assertNotIn('library.json',str(files))
if __name__=='__main__':unittest.main()
