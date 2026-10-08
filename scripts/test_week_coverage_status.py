"""Coverage policy uses the real pipeline with injected offline steps."""
import copy
import json
import unittest
from test_ci_daily import PipelineFixture
import ci_daily

TASKS = {"translate":"translation", "study":"study", "quicklook":"quicklook"}

def fixture(total=24, core=19, study=False):
    rows=[]; mapping={}
    for n in range(1,total+1):
        present=n<=core
        row={"paperID":"doi:10.1234/"+str(n),"doi":"10.1234/"+str(n),"pmid":str(n),"sourceHash":format(n,"064x"),"titleZh":"已准备的中文题名" if present else "", "translation":{"abstract_zh":"已准备译文"} if present else None,"quicklook":{"one_line":"已准备速览"} if present else None,"study":{"papers":[{"status":"available"}]} if present and study else None,"allowAutomaticGeneration":False}
        row["missingTasks"]=[task for task, field in TASKS.items() if not row[field]]
        row["precomputeStatus"]="ready" if not row["missingTasks"] else "partial" if present else "pending"
        entry={field:copy.deepcopy(row[field]) for field in TASKS.values()}
        entry["meta"]={key:row[key] for key in ("paperID","sourceHash")}
        for key in ("doi:"+row["doi"],"pmid:"+row["pmid"]):mapping[key]=copy.deepcopy(entry)
        rows.append(row)
    coverage={"title":core,"translate":core,"quicklook":core,"study":core if study else 0}
    board={"items":rows,"coverage":coverage,"window":{"start":"2026-10-02","end":"2026-10-08","days":7,"timezone":"Asia/Shanghai"}}
    counts={"radar":350,"library":1300,"weekly_board":total,"weekly_precomputed":coverage}
    return board,mapping,counts

def bundle(board,mapping):
    return 'window.FEEDS='+json.dumps({"items":[{"summary":"window.WEEKLY_BOARD={fake};"}]})+';\n;\nwindow.WEEKLY_BOARD='+json.dumps(board)+';\n;\nwindow.PREGENERATED='+json.dumps(mapping)+';\n;\nconst app=`window.WEEKLY_BOARD={fake};`;'

class CoverageTests(unittest.TestCase):
    def test_twenty_four_selected_is_not_twenty_four_prepared(self):
        board,mapping,counts=fixture();s=ci_daily.weekly_content_status(bundle(board,mapping),counts,True)
        self.assertEqual(s["status"],"partial");self.assertEqual(s["selected"],24)
        self.assertEqual(s["titleTranslationQuicklookPreparedPapers"],19);self.assertEqual(s["fullyPreparedPapers"],0)
        self.assertEqual(s["partialPapers"],19);self.assertEqual(s["pendingPapers"],5)
        self.assertEqual(len(s["pending"]),24);self.assertEqual(s["pending"][-1]["missingFields"],["title","translate","study","quicklook"])
        self.assertEqual(s["publicationPolicy"]["generationMode"],"cache_only")
        self.assertEqual(s["window"]["days"],7)
    def test_complete_requires_all_fields(self):
        b,m,c=fixture(2,2,True);s=ci_daily.weekly_content_status(bundle(b,m),c,False)
        self.assertEqual(s["status"],"complete");self.assertEqual(s["fullyPreparedPapers"],2);self.assertEqual(s["pending"],[])
    def test_empty_is_not_complete(self):
        b,m,c=fixture(0,0);self.assertEqual(ci_daily.weekly_content_status(bundle(b,m),c,True)["status"],"empty")
    def test_legacy_without_board_is_honestly_unavailable(self):
        s=ci_daily.weekly_content_status('window.FEEDS={}; const app=1;',{},True)
        self.assertEqual(s["status"],"unavailable");self.assertNotIn("coverage",s)
    def test_false_ready_claim_rejected(self):
        b,m,c=fixture(1,1);b["items"][0]["precomputeStatus"]="ready"
        with self.assertRaisesRegex(ValueError,"ready claim"):ci_daily.weekly_content_status(bundle(b,m),c,True)
    def test_missing_public_alias_rejected(self):
        b,m,c=fixture(1,1);del m["doi:10.1234/1"]
        with self.assertRaisesRegex(ValueError,"mapping missing"):ci_daily.weekly_content_status(bundle(b,m),c,True)
    def test_foreign_source_hash_rejected(self):
        b,m,c=fixture(1,1);m["pmid:1"]["meta"]["sourceHash"]="f"*64
        with self.assertRaisesRegex(ValueError,"source mismatch"):ci_daily.weekly_content_status(bundle(b,m),c,True)
    def test_public_field_loss_rejected_even_when_counts_unchanged(self):
        b,m,c=fixture(1,1);m["pmid:1"]["translation"]=None
        with self.assertRaisesRegex(ValueError,"fields differ"):ci_daily.weekly_content_status(bundle(b,m),c,True)
    def test_stale_board_coverage_rejected(self):
        b,m,c=fixture(1,1);b["coverage"]=dict(b["coverage"],study=1)
        with self.assertRaisesRegex(ValueError,"coverage counts"):ci_daily.weekly_content_status(bundle(b,m),c,True)
    def test_stale_receipt_coverage_rejected(self):
        b,m,c=fixture(1,1);c["weekly_precomputed"]=dict(c["weekly_precomputed"],translate=0)
        with self.assertRaisesRegex(ValueError,"coverage counts"):ci_daily.weekly_content_status(bundle(b,m),c,True)
    def test_missing_published_board_with_nonzero_receipt_rejected(self):
        with self.assertRaisesRegex(ValueError,"missing from public"):ci_daily.weekly_content_status('window.FEEDS={};',fixture()[2],True)
    def test_duplicate_identity_rejected(self):
        b,m,c=fixture(2,2);b["items"][1]["paperID"]=b["items"][0]["paperID"]
        with self.assertRaisesRegex(ValueError,"identity"):ci_daily.weekly_content_status(bundle(b,m),c,True)
    def test_no_new_page_load_generation(self):
        b,m,c=fixture(1,1);b["items"][0]["allowAutomaticGeneration"]=True
        with self.assertRaisesRegex(ValueError,"page-load"):ci_daily.weekly_content_status(bundle(b,m),c,True)

class PipelineCoverageTests(PipelineFixture):
    def install(self, mutate=None):
        b,m,c=fixture()
        if mutate:mutate(b,m,c)
        (self.root/"public/public.js").write_text(bundle(b,m))
        (self.root/"docs/public-manifest.json").write_text(json.dumps({"counts":c}))
    def test_optional_model_failure_publishes_valid_partial_with_pending_artifact(self):
        self.install()
        code,report,out,calls=self.invoke(fast=False,run=lambda argv, timeout:(7,"","failed") if argv[0]=="scripts/week_precompute.py" and "--run" in argv else (0,"",""))
        self.assertEqual(code,0);self.assertEqual(out,[True]);self.assertEqual(report["status"],"success")
        self.assertEqual(report["weeklyContent"]["status"],"partial");self.assertEqual(report["warnings"],["weekly_precompute_partial"])
        self.assertEqual(report["weeklyContent"]["fullyPreparedPapers"],0)
        paid=[args for args in calls if "--run" in args and args[0]=="scripts/week_precompute.py"]
        self.assertEqual(len(paid),1);self.assertIn("8",paid[0])
    def test_fast_is_read_only_cache_without_extra_generation(self):
        self.install();code,r,out,calls=self.invoke()
        self.assertEqual(code,0);self.assertEqual(r["weeklyContent"]["publicationPolicy"]["generationMode"],"cache_only")
        self.assertFalse(any(args[0]=="scripts/week_precompute.py" and "--run" in args for args in calls))
        self.assertEqual(out,[False])
    def test_false_ready_blocks_only_corrupt_publication_and_leaves_failure_receipt(self):
        self.install(lambda b,m,c:b["items"][0].update(precomputeStatus="ready"))
        code,r,out,calls=self.invoke()
        self.assertEqual(code,1);self.assertEqual(out,[False]);self.assertEqual(r["status"],"failed")
        self.assertIn("weekly coverage integrity failed",r["problems"][0]);self.assertIn("finishedAt",r)

if __name__=="__main__":unittest.main()
