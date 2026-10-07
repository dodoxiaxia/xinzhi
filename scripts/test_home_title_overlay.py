"""Source-bound title-only fallback for the five observed homepage gaps."""
import copy
import hashlib
import json
import unittest
from pathlib import Path

import week_precompute as w
from build_public import public_paper

ROOT = Path(__file__).resolve().parents[1]


class HomepageTitleOverlay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = json.loads((ROOT/'editorial/public_title_translations.json').read_text())
        cls.receipt = json.loads((ROOT/'editorial/home-title-gap-20261008.json').read_text())

    def source(self, entry):
        return {'id':entry['sourceId'], 'doi':entry['doi'], 'pmid':entry['pmid'],
                'title':entry['sourceTitle'], 'url':entry['sourceUrl'], 'date':entry['sourceDate']}

    def test_all_five_attach_through_existing_public_title_fallback_only(self):
        self.assertEqual(len(self.receipt['translations']), 5)
        for entry in self.receipt['translations']:
            source = self.source(entry)
            original = copy.deepcopy(source)
            public = public_paper(source)
            before = copy.deepcopy(public)
            public['titleZh'] = w.editorial_title(public, self.registry)
            self.assertEqual(public['titleZh'], entry['titleZh'])
            self.assertEqual({k:v for k,v in public.items() if k!='titleZh'}, before)
            self.assertEqual(source, original)
            self.assertEqual(hashlib.sha256(source['title'].encode()).hexdigest(), entry['sourceTitleHash'])
            self.assertEqual(entry['scope'], 'public-title-only')
            self.assertEqual(entry['origin'], 'codex-editorial-translation')

    def test_changed_doi_original_title_or_hash_rejects_old_translation(self):
        for entry in self.receipt['translations']:
            source = self.source(entry)
            for field, value in [('doi','10.1001/other'), ('title',source['title']+' correction')]:
                self.assertEqual(w.editorial_title({**source,field:value},self.registry),'')
            registry = copy.deepcopy(self.registry)
            registry['entries'][entry['paperID']]['sourceTitleHash'] = 'wrong'
            self.assertEqual(w.editorial_title(source,registry),'')

    def test_title_scope_retains_medical_distinctions_without_fabricated_content(self):
        for entry in self.receipt['translations']:
            self.assertNotIn('abstract_zh',entry)
            self.assertNotIn('quicklook',entry)
            self.assertNotIn('results',entry)
            if 'Unrecognized' in entry['sourceTitle']:
                self.assertIn('未被识别',entry['titleZh'])
                self.assertNotIn('无症状',entry['titleZh'])
        self.assertEqual(self.receipt['externalModelApiRequests'],0)
        self.assertEqual(self.receipt['abstractsGenerated'],0)
        self.assertIsNone(self.receipt['providerUsage'])

    def test_previous_two_valid_titles_remain_usable(self):
        for key in self.receipt['existingEntriesPreserved']:
            entry = self.registry['entries'][key]
            self.assertEqual(w.editorial_title({'doi':key.removeprefix('doi:'),
                                               'pmid':entry['pmid'],'title':entry['sourceTitle']},
                                              self.registry),entry['titleZh'])


if __name__ == '__main__':
    unittest.main()
