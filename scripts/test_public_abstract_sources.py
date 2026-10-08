import copy, unittest
import build_public as b
from week_precompute import text_hash

class PublicAbstractSourceTests(unittest.TestCase):
    def setUp(self):
        self.row={'paperID':'doi:10.1000/test','pmid':'1234','doi':'10.1000/test','title':'Published title','abstract':'Public source sentence. '*20,'abstractSource':'PubMed','abstractSourceUrl':'https://pubmed.ncbi.nlm.nih.gov/1234/','date':'2026-10-07','private_note':'Never emit'}
        self.row['sourceHash']=text_hash(self.row['title'],self.row['abstract'])
        self.candidate={'title':self.row['title'],'doi':self.row['doi'],'pmid':self.row['pmid'],'journal':'Public journal','repo_path':'Never emit'}
    def project(self, rows=None, catalogue=None, candidates=None):
        return b.public_abstract_sources({'items':rows or [self.row]}, {'items':catalogue or []}, candidates if candidates is not None else [self.candidate])
    def test_only_validated_boards_are_projected_and_duplicates_collapse(self):
        out=self.project(catalogue=[copy.deepcopy(self.row)])
        self.assertEqual(out['scope'],'published-public-abstract');self.assertEqual(len(out['items']),1)
        self.assertEqual(set(out['items'][0]),{'paperID','pmid','doi','title','journal','abstract','sourceHash','abstractSource','abstractSourceUrl','date'})
        self.assertEqual(out['items'][0]['journal'],'Public journal')
        self.assertEqual(b.public_abstract_sources(None,None,[self.candidate])['items'],[])
    def test_hash_is_full_and_unchanged(self):
        self.assertEqual(self.project()['items'][0]['sourceHash'],text_hash(self.row['title'],self.row['abstract']))
        self.row['abstract']+=' changed'
        with self.assertRaises(ValueError):self.project()
    def test_cross_identity_and_title_conflicts_fail(self):
        for field,value in [('doi','10.1000/other'),('pmid','9999'),('title','Other title')]:
            row=dict(self.candidate,**{field:value})
            with self.subTest(field=field),self.assertRaises(ValueError):self.project(candidates=[row])
    def test_alias_conflicts_fail_even_with_valid_hash(self):
        other=dict(self.row,title='Other title',paperID='doi:10.1000/other',doi='10.1000/other')
        other['sourceHash']=text_hash(other['title'],other['abstract'])
        with self.assertRaises(ValueError):self.project(rows=[self.row,other],candidates=[])
    def test_count_bound_does_not_silently_truncate(self):
        rows=[dict(self.row,paperID=f'doi:10.1000/p{i}',doi=f'10.1000/p{i}',pmid=str(1000+i)) for i in range(97)]
        with self.assertRaises(ValueError):self.project(rows=rows,candidates=[])
    def test_invalid_identity_and_source_urls_fail(self):
        for field,value in [('paperID','arbitrary'),('pmid','private/path'),('doi','invalid'),('abstractSourceUrl','https://private.example/pdf'),('abstractSourceUrl','https://pubmed.ncbi.nlm.nih.gov:8443/1234/'),('abstractSourceUrl','https://user:password@pubmed.ncbi.nlm.nih.gov/1234/')]:
            row=dict(self.row,**{field:value})
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):self.project(rows=[row])
    def test_large_sources_are_rejected_without_truncation(self):
        for field,value in [('title','x'*1001),('abstract','x'*32001)]:
            row=dict(self.row,**{field:value});row['sourceHash']=text_hash(row['title'],row['abstract'])
            with self.subTest(field=field),self.assertRaises(ValueError):self.project(rows=[row])
        with self.assertRaises(ValueError):self.project(candidates=[dict(self.candidate,journal='x'*2001)])
    def test_journal_alias_conflict_fails(self):
        with self.assertRaises(ValueError):self.project(candidates=[self.candidate,dict(self.candidate,journal='Other journal')])

if __name__=='__main__':unittest.main()
