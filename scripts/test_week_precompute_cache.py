import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import week_precompute as w
import week_precompute_cache as c
import restore_week_precompute_snapshot as restore

ROOT = Path(__file__).resolve().parents[1]


def real_fixture():
    cache = json.loads((ROOT / 'editorial/week_precompute_cache_20261007.json').read_text())
    rows = json.loads((ROOT / 'editorial/week_precompute_sources_20261007.json').read_text())['items']
    source = next(p for p in rows if w.identity(p) == c.LEGACY_PAPER_ID)
    paper = dict(source, paperID=w.identity(source), **w.public_abstract(source))
    paper['sourceHash'] = w.text_hash(paper['title'], paper['abstract'])
    return paper, cache


def accounted_ledger():
    # These are the actual two persisted public request identities; reservations
    # are reconstructed conservatively from the recorded cache hit and Worker caps.
    first = {'paperID': c.LEGACY_PAPER_ID, 'sourceHash': c.LEGACY_SOURCE_HASH,
        'task': 'translate', 'status': 'recovered_existing_cache',
        'at': '2026-10-07T09:29:06.645375+00:00', 'reservedAttempts': 2,
        'reservedOutputTokens': 0}
    second = dict(first, task='study', status='failed_or_uncertain',
        at='2026-10-07T09:33:25.428137+00:00', reservedOutputTokens=3800)
    return {'schemaVersion': 1, 'paused': 'http_502:quote_not_in_abstract',
        'days': {'2026-10-07': {'reservedAttempts': 4, 'reservedOutputTokens': 3800,
            'requests': [first, second], 'paused': 'http_502:quote_not_in_abstract'}}}


class CacheContracts(unittest.TestCase):
    def setUp(self):
        self.paper, self.cache = real_fixture()

    def test_real_historical_translation_survives_revalidation_without_forged_provenance(self):
        before = copy.deepcopy(self.cache)
        value, meta = c.find(self.cache, self.paper, 'translate', w.validate)
        self.assertEqual(value['title_zh'], next(iter(self.cache['entries'].values()))['value']['title_zh'])
        self.assertEqual(meta['promptVersion'], c.LEGACY_TRANSLATION_VERSION)
        self.assertEqual(meta['legacyLocalValidationVersion'], c.LEGACY_TRANSLATION_VERSION)
        self.assertEqual(meta['generationPromptVersion'], 'unobserved')
        self.assertFalse(meta['generationVersionKnown'])
        self.assertEqual(meta['generatedAt'], '2026-10-07T09:08:13.124Z')
        self.assertEqual(self.cache, before)

    def test_unrelated_worker_file_is_not_a_cache_version_input(self):
        before = c.version('translate', 'runtime-cache')
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('must not read Worker')):
            self.assertEqual(c.version('translate', 'runtime-cache'), before)
        with patch.dict(c.TASK_VALIDATOR_VERSIONS, {'study': 'changed-study-only'}):
            self.assertEqual(c.version('translate', 'runtime-cache'), before)
            self.assertIn('changed-study-only', c.version('study', 'runtime-cache'))
        with patch.dict(c.TASK_PROMPT_VERSIONS, {'translate': 'changed-translation-contract'}):
            self.assertNotEqual(c.version('translate', 'runtime-cache'), before)

    def test_only_explicit_legacy_version_allowed(self):
        entry = next(iter(self.cache['entries'].values()))
        entry['promptVersion'] = entry['promptVersion'][:-1] + '3'
        self.assertEqual(c.find(self.cache, self.paper, 'translate', w.validate), (None, None))

    def test_full_original_hash_and_original_text_both_must_match(self):
        for source_hash in (c.LEGACY_SOURCE_HASH[:16], '0' * 64):
            paper = dict(self.paper, sourceHash=source_hash)
            self.assertEqual(c.find(self.cache, paper, 'translate', w.validate), (None, None))
        paper = dict(self.paper, abstract=self.paper['abstract'] + ' changed')
        self.assertEqual(c.find(self.cache, paper, 'translate', w.validate), (None, None))

    def test_same_legacy_version_not_blanket_permission_for_another_paper(self):
        entry = next(iter(self.cache['entries'].values()))
        entry['paperID'] = 'doi:10.1001/another'
        paper = dict(self.paper, paperID=entry['paperID'])
        self.assertEqual(c.find(self.cache, paper, 'translate', w.validate), (None, None))

    def test_legacy_translation_cannot_bypass_current_numeric_validation(self):
        entry = next(iter(self.cache['entries'].values()))
        entry['value']['abstract_zh'] += '999999名患者。'
        self.assertEqual(c.find(self.cache, self.paper, 'translate', w.validate), (None, None))

    def test_new_runtime_cache_has_task_version_but_remote_prompt_unobserved(self):
        value, _ = c.find(self.cache, self.paper, 'translate', w.validate)
        cache = {'entries': {}}
        entry = c.store(cache, self.paper, 'translate', value, 'glm-5.3-flash',
                        '2026-10-07', 'runtime-precompute', w.validate)
        self.assertFalse(entry['generationVersionKnown'])
        self.assertEqual(entry['generationPromptVersion'], 'unobserved')
        self.assertTrue(c.find(cache, self.paper, 'translate', w.validate)[0])
        self.assertNotEqual(c.cache_key(self.paper, 'translate', 'm1'),
                            c.cache_key(self.paper, 'translate', 'm2'))
        with patch.dict(c.TASK_VALIDATOR_VERSIONS, {'translate': 'new'}):
            self.assertIsNone(c.find(cache, self.paper, 'translate', w.validate)[0])

    def test_local_generation_records_the_prompt_actually_sent(self):
        value, _ = c.find(self.cache, self.paper, 'translate', w.validate)
        cache = {'entries': {}}
        entry = c.store(cache, self.paper, 'translate', value, 'model', '2026-10-07',
                        'configured-precompute', w.validate, configured_prompt='known prompt')
        self.assertTrue(entry['generationVersionKnown'])
        self.assertIn(hashlib.sha256(b'known prompt').hexdigest(), entry['generationPromptVersion'])
        self.assertTrue(c.find(cache, self.paper, 'translate', w.validate, configured_prompt='known prompt')[0])
        self.assertIsNone(c.find(cache, self.paper, 'translate', w.validate, configured_prompt='different')[0])


class RestoreLedger(unittest.TestCase):
    def test_same_requests_union_idempotently_preserves_pause(self):
        ledger = accounted_ledger()
        merged = restore.merge_ledger(ledger, ledger)
        self.assertEqual(merged['days']['2026-10-07']['reservedAttempts'], 4)
        self.assertEqual(merged['days']['2026-10-07']['reservedOutputTokens'], 3800)
        self.assertEqual(len(merged['days']['2026-10-07']['requests']), 2)
        self.assertEqual(restore.merge_ledger(merged, ledger), merged)
        self.assertEqual(merged['paused'], ledger['paused'])

    def test_distinct_requests_are_added_not_maximized(self):
        old = accounted_ledger()
        new = accounted_ledger()
        day = new['days']['2026-10-07']
        request = dict(day['requests'][1], task='quicklook',
                       at='2026-10-07T10:33:25.428137+00:00', reservedOutputTokens=3600)
        day.update(requests=[request], reservedAttempts=2, reservedOutputTokens=3600)
        merged = restore.merge_ledger(old, new)['days']['2026-10-07']
        self.assertEqual(merged['reservedAttempts'], 6)
        self.assertEqual(merged['reservedOutputTokens'], 7400)
        self.assertEqual(len(merged['requests']), 3)

    def test_unknown_old_aggregate_fails_without_mutation(self):
        old = {'days': {'2026-10-07': {'reservedAttempts': 4, 'requests': []}}, 'paused': 'older_failure'}
        before = copy.deepcopy(old)
        with self.assertRaisesRegex(ValueError, 'unaccountable_output_tokens'):
            restore.merge_ledger(old, accounted_ledger())
        self.assertEqual(old, before)

    def test_missing_request_output_is_not_zero(self):
        ledger = accounted_ledger()
        del ledger['days']['2026-10-07']['requests'][1]['reservedOutputTokens']
        with self.assertRaisesRegex(ValueError, 'unaccountable_output_tokens'):
            restore.merge_ledger({'days': {}}, ledger)

    def test_unattributed_counters_fail_closed(self):
        ledger = accounted_ledger()
        ledger['days']['2026-10-07']['reservedAttempts'] += 2
        with self.assertRaisesRegex(ValueError, 'unattributed_reservation'):
            restore.merge_ledger({'days': {}}, ledger)

    def test_collision_cannot_disguise_different_reservation(self):
        old = accounted_ledger()
        new = accounted_ledger()
        new['days']['2026-10-07']['requests'][1]['reservedOutputTokens'] += 1
        new['days']['2026-10-07']['reservedOutputTokens'] += 1
        with self.assertRaisesRegex(ValueError, 'identity_conflict'):
            restore.merge_ledger(old, new)

    def test_preserves_original_pause_and_records_both_reasons(self):
        old = accounted_ledger()
        old['paused'] = 'prior_auth_failure'
        new = accounted_ledger()
        merged = restore.merge_ledger(old, new)
        self.assertEqual(merged['paused'], 'prior_auth_failure')
        self.assertEqual(merged['pauseReasons'], ['prior_auth_failure', 'http_502:quote_not_in_abstract'])

    def test_known_configured_max_output_is_accounted(self):
        request = accounted_ledger()['days']['2026-10-07']['requests'][0]
        request.pop('task')
        request.pop('reservedOutputTokens')
        request.update(tasks=['translate', 'study'], maxOutputTokens=5800, reservedAttempts=1)
        ledger = {'days': {'2026-10-07': {'requests': [request], 'reservedAttempts': 1, 'reservedOutputTokens': 5800}}}
        merged = restore.merge_ledger({'days': {}}, ledger)
        self.assertEqual(merged['days']['2026-10-07']['requests'][0]['reservedOutputTokens'], 5800)


if __name__ == '__main__':
    unittest.main()
