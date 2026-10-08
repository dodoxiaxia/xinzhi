"""One new public paper, strict bindings, 23 reused rows and no cache/generation writes."""
import copy
import json
import unittest
from pathlib import Path

import week_precompute as w
from preview_sol_public_overlay import preview, preview_supplement
from public_editorial_overlay import apply_board, load_board
from public_precompute_pending import pending_manifest
from build_public import public_weekly_board
from verify_public_sol_gap import verify

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'editorial/sol-public-abstract-20261008c-gap'


class GapC(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = json.loads((BASE / 'sources.json').read_text())
        cls.cache = json.loads((BASE / 'gap-cache.json').read_text())
        cls.target = cls.sources['items'][0]
        cls.supplement = preview_supplement(cls.sources, cls.cache)
        cls.saved = load_board(ROOT)
        old = json.loads((ROOT / 'editorial/sol-public-abstract-20261008b-gap/sources.json').read_text())
        board = apply_board({'schemaVersion':1,'scope':'public-abstract','items':old['items'],
                             'window':copy.deepcopy(cls.sources['window'])}, cls.saved)
        board['window'] = copy.deepcopy(cls.sources['window'])
        board['items'][-1] = copy.deepcopy(cls.target)
        cls.before = public_weekly_board(board)

    def test_one_source_two_actual_results_complete_24_and_preserve_23(self):
        before = copy.deepcopy(self.before)
        result = verify(before, self.sources, self.cache)
        self.assertEqual(result['coverageBefore'], {'title':24,'translate':23,'study':0,'quicklook':23})
        self.assertEqual(result['coverageAfter'], {'title':24,'translate':24,'study':0,'quicklook':24})
        self.assertEqual((result['newPapers'],result['newEntries'],result['existingPapersReused']), (1,2,23))
        self.assertEqual((result['pendingBefore'],result['pendingAfter'],result['studyMissing']), (1,0,24))
        self.assertEqual(before, self.before)
        self.assertEqual(len(result['unchangedPapers']), 23)
        self.assertEqual(result['externalModelApiRequests'], 0)

    def test_single_source_scope_does_not_relax_default_fixed_24_preview(self):
        with self.assertRaisesRegex(ValueError, 'fixed_24'):
            preview(self.sources, self.cache)
        for count in (0,31):
            sources = {**self.sources, 'items':[self.target] * count}
            with self.assertRaisesRegex(ValueError, 'finite_public_supplement'):
                preview_supplement(sources, self.cache)
        with self.assertRaisesRegex(ValueError, 'finite_public_supplement'):
            preview_supplement({**self.sources,'scope':'public-abstract'}, self.cache)
        with self.assertRaises(ValueError):
            preview_supplement({**self.sources,'items':[self.target,self.target]}, self.cache)

    def test_source_changes_or_rehashing_never_reuse_old_results(self):
        for rehash in (False, True):
            sources = copy.deepcopy(self.sources)
            p = sources['items'][0]; p['abstract'] += ' Updated public source.'
            if rehash:p['sourceHash'] = w.text_hash(p['title'], p['abstract'])
            with self.assertRaisesRegex(ValueError, 'source_identity_or_hash|source_not_current'):
                preview_supplement(sources, self.cache)
        before = copy.deepcopy(self.before)
        p = before['items'][-1];p['abstract'] += ' Updated public source.'
        p['sourceHash'] = w.text_hash(p['title'], p['abstract'])
        with self.assertRaisesRegex(ValueError, 'gap_source_no_longer_current'):
            verify(before, self.sources, self.cache)

    def test_wrong_alias_versions_or_fake_paid_provenance_are_rejected(self):
        for field,value in (('doi','10.1234/wrong'),('pmid','1'),('promptVersion','old-version'),
                            ('origin','configured-precompute'),('providerUsage',{'total_tokens':0})):
            cache = copy.deepcopy(self.cache)
            next(iter(cache['entries'].values()))[field] = value
            with self.assertRaises(ValueError):preview_supplement(self.sources, cache)

    def test_numeric_occurrences_and_quote_support_use_original_validators(self):
        for task in ('translate','quicklook'):
            cache = copy.deepcopy(self.cache)
            entry = next(e for e in cache['entries'].values() if e['task']==task)
            if task=='translate':entry['value']['abstract_zh'] += ' 样本量987654321。'
            else:entry['value']['findings'][0]['quote'] = 'An invented quotation absent from the source abstract.'
            with self.assertRaisesRegex(ValueError, 'existing_validation'):
                preview_supplement(self.sources, cache)

    def test_incremental_verifier_refuses_replacing_completed_work(self):
        before = copy.deepcopy(self.before)
        before['items'][-1]['translation'] = self.supplement['items'][0]['translation']
        with self.assertRaisesRegex(ValueError, 'gap_would_replace_completed_task'):
            verify(before, self.sources, self.cache)

    def test_production_supplement_preserves_valid_current_work_and_repairs_invalid_gap(self):
        before = copy.deepcopy(self.before)
        row = before['items'][-1]
        row['translation'] = copy.deepcopy(self.supplement['items'][0]['translation'])
        row['translation']['abstract_zh'] += '（现有缓存副本）'
        row['generationMeta']['translate'] = {'origin':'runtime-cache','generatedAt':'2026-10-07'}
        row['quicklook'] = copy.deepcopy(self.supplement['items'][0]['quicklook'])
        row['quicklook']['why_read'] = '从生命历程视角理解冠状动脉粥样硬化相关因素。'
        old = copy.deepcopy(row)
        after = apply_board(before, self.supplement)
        self.assertEqual(after['items'][-1]['translation'], old['translation'])
        self.assertEqual(after['items'][-1]['quicklook'], old['quicklook'])
        self.assertEqual(after['items'][-1]['generationMeta'], old['generationMeta'])
        self.assertEqual(after['items'][-1]['titleZh'], old['titleZh'])
        row['quicklook']['findings'][0]['quote'] = 'An invalid cached quote not found in the public abstract.'
        repaired = apply_board(before, self.supplement)
        self.assertEqual(repaired['items'][-1]['quicklook'], self.supplement['items'][0]['quicklook'])
        self.assertFalse(public_weekly_board(repaired)['items'][-1]['allowAutomaticGeneration'])

    def test_registered_production_overlay_matches_same_24_and_honest_origin(self):
        current = copy.deepcopy(self.before)
        result = public_weekly_board(apply_board(current, self.saved))
        self.assertEqual(result['coverage'], {'title':24,'translate':24,'study':0,'quicklook':24})
        self.assertEqual(current, self.before)
        target = result['items'][-1]
        self.assertNotIn('fillMissingOnly', target)
        for task in ('translate','quicklook'):
            m = target['generationMeta'][task]
            self.assertEqual(m['origin'], 'sol-session-public-abstract')
            self.assertFalse(m['generationVersionKnown'])
            self.assertEqual(m['modelVersion'], 'sol-session-model-unobserved')

    def test_independent_review_is_bound_to_the_same_source(self):
        review = json.loads((BASE / 'reviews/one-paper-review.json').read_text())
        self.assertTrue(review['approved'])
        self.assertEqual(review['sourceHash'], self.target['sourceHash'])
        self.assertFalse(review['scopeBoundaries']['fullTextReviewed'])
        self.assertFalse(review['scopeBoundaries']['medicalReview'])


if __name__ == '__main__':
    unittest.main()
