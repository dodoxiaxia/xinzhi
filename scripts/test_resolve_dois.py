#!/usr/bin/env python3
"""Offline tests for DOI resolution of RSS items without DOIs (no network)."""
import datetime
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import resolve_dois as rd

NOW = datetime.datetime(2026, 10, 12, tzinfo=datetime.timezone.utc)
LANCET = {'id': 'rss-1', 'title': '[Articles] Conversational diagnostic artificial intelligence in ambulatory primary care: a prospective feasibility study',
          'doi': '', 'pmid': None, 'url': 'https://www.thelancet.com/journals/lancet/article/PIIS0140-6736(26)01535-7/fulltext?rss=yes'}
JACC = {'id': 'rss-2', 'title': 'Left Atrial Strain After Ablation', 'doi': '',
        'url': 'https://www.sciencedirect.com/science/article/pii/S0735109726012345?dgcid=rss'}
OPENAI = {'id': 'rss-3', 'title': 'Introducing a new research preview for clinicians', 'doi': '', 'url': 'https://openai.com/index/new-preview'}


def rows(doi, title):
    return [{'DOI': doi, 'title': [title]}]


class ResolveDoisTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def run_fill(self, items, fetch, **kw):
        return rd.fill(items, self.root, fetch=fetch, now=kw.pop('now', NOW), network=kw.pop('network', True), sleep=lambda s: None)

    def test_pii_parsing_and_title_identity(self):
        self.assertEqual(rd.pii_of(LANCET['url']), 'S0140673626015357')
        self.assertEqual(rd.pii_of(JACC['url']), 'S0735109726012345')
        self.assertEqual(rd.pii_of(OPENAI['url']), '')
        # The RSS section tag and markup do not change a title's identity.
        self.assertEqual(rd.title_key(LANCET['title']), rd.title_key('Conversational <i>diagnostic</i> artificial intelligence in ambulatory primary care: a prospective feasibility study'))
        self.assertEqual(rd.title_cache_key('short'), '')

    def test_pii_lookup_requires_matching_title(self):
        calls = []
        def fetch(params):
            calls.append(params)
            if params['filter'] == 'alternative-id:S0140673626015357':
                return rows('10.1016/S0140-6736(26)01535-7', LANCET['title'][11:])
            return rows('10.1016/j.jacc.2026.01.001', 'A different paper entirely')
        items = [dict(LANCET), dict(JACC)]
        stats = self.run_fill(items, fetch)
        self.assertEqual(items[0]['doi'], '10.1016/s0140-6736(26)01535-7')
        self.assertEqual(items[1]['doi'], '', 'a PII hit whose title differs is not accepted')
        self.assertEqual((stats['resolved'], stats['unresolved']), (1, 1))
        self.assertTrue(all('filter' in c for c in calls), 'PII links use the exact alternative-id filter')

    def test_pii_match_tolerates_a_missing_subtitle_but_title_query_does_not(self):
        case = {'title': 'Giant Thrombosed Coronary Aneurysm Causing Recurrent Ischemic Events: Insights From Multimodality Imaging', 'doi': '',
                'url': 'https://www.sciencedirect.com/science/article/pii/S2666084926028949'}
        item = dict(case)
        self.run_fill([item], lambda p: rows('10.1016/j.jaccas.2026.109733', 'Giant Thrombosed Coronary Aneurysm Causing Recurrent Ischemic Events'))
        self.assertEqual(item['doi'], '10.1016/j.jaccas.2026.109733')
        item = dict(case, url='https://example.org/article', title=case['title'])
        self.run_fill([item], lambda p: rows('10.1016/j.jaccas.2026.109733', 'Giant Thrombosed Coronary Aneurysm Causing Recurrent Ischemic Events'))
        self.assertEqual(item['doi'], '', 'without a PII only an exact title is trusted')
        item = dict(case)
        rd.fill([item], tempfile.mkdtemp(), fetch=lambda p: rows('10.1/x', 'Giant'), now=NOW, network=True, sleep=lambda s: None)
        self.assertEqual(item['doi'], '', 'a very short prefix is not a match')

    def test_title_query_for_links_without_pii_and_ambiguity(self):
        item = dict(OPENAI)
        self.run_fill([item], lambda p: rows('10.1000/a', OPENAI['title']) + rows('10.1000/b', OPENAI['title']))
        self.assertEqual(item['doi'], '', 'two different DOIs with the same title are ambiguous')
        item = dict(OPENAI, title='Machine learning for atrial fibrillation screening in primary care')
        self.run_fill([item], lambda p: rows('10.1000/c', item['title']), now=NOW + datetime.timedelta(days=4))
        self.assertEqual(item['doi'], '10.1000/c')

    def test_cache_reuse_and_retry_window(self):
        calls = []
        def fetch(params):
            calls.append(params)
            return []
        self.run_fill([dict(LANCET)], fetch)
        self.run_fill([dict(LANCET)], fetch, now=NOW + datetime.timedelta(days=1))
        self.assertEqual(len(calls), 1, 'a miss is not retried within the retry window')
        self.run_fill([dict(LANCET)], fetch, now=NOW + datetime.timedelta(days=4))
        self.assertEqual(len(calls), 2, 'a miss is retried after the window')
        cache = json.loads((self.root / rd.CACHE).read_text())
        cache['pii:S0140673626015357'] = {'doi': '10.1016/s0140-6736(26)01535-7', 'at': NOW.isoformat()}
        (self.root / rd.CACHE).write_text(json.dumps(cache))
        item = dict(LANCET)
        stats = self.run_fill([item], lambda p: self.fail('cached DOIs need no network'), network=False)
        self.assertEqual((item['doi'], stats['cached']), ('10.1016/s0140-6736(26)01535-7', 1))

    def test_items_with_identifiers_and_offline_mode_are_untouched(self):
        items = [dict(LANCET, doi='10.1/x'), dict(JACC, pmid='123'), dict(OPENAI)]
        stats = self.run_fill(items, lambda p: self.fail('no lookup'), network=False)
        self.assertEqual(stats['missing'], 1)
        self.assertEqual(items[2]['doi'], '')
        self.assertFalse((self.root / rd.CACHE).exists())

    def test_rate_limit_waits_then_stops_and_network_errors_never_raise(self):
        waits, attempts = [], []
        def limited(params):
            attempts.append(params)
            raise urllib.error.HTTPError('u', 429, 'Too Many', {'retry-after': '2'}, io.BytesIO())
        stats = rd.fill([dict(LANCET), dict(JACC)], self.root, fetch=limited, now=NOW, network=True, sleep=waits.append)
        self.assertEqual(stats['stopped'], 'http_429')
        self.assertEqual(stats['rate_limited'], rd.MAX_RATE_LIMITS)
        self.assertEqual(len(attempts), rd.MAX_RATE_LIMITS + 1, 'after the last allowed wait the run stops; JACC waits for the next run')
        self.assertTrue(all(w >= rd.RATE_LIMIT_WAIT for w in waits))
        self.assertFalse((self.root / rd.CACHE).exists(), 'nothing is cached as a miss when the lookup never completed')
        # One 429 then success: the paper still resolves in this run.
        seq = iter([urllib.error.HTTPError('u', 429, 'x', {}, io.BytesIO()), rows('10.1016/S0140-6736(26)01535-7', LANCET['title'])])
        def flaky(params):
            value = next(seq)
            if isinstance(value, Exception):
                raise value
            return value
        item = dict(LANCET)
        self.run_fill([item], flaky)
        self.assertEqual(item['doi'], '10.1016/s0140-6736(26)01535-7')
        stats = self.run_fill([dict(JACC)], lambda p: (_ for _ in ()).throw(TimeoutError()), now=NOW + datetime.timedelta(days=10))
        self.assertEqual(stats['stopped'], 'TimeoutError')


class PipelineKeysTest(unittest.TestCase):
    def test_merge_and_translation_keys(self):
        import merge_candidates, translate_titles
        self.assertEqual(merge_candidates.titlekey(LANCET['title']), merge_candidates.titlekey(LANCET['title'][11:]),
                         'RSS "[Articles] X" and PubMed "X" are one paper')
        self.assertEqual(translate_titles.keyof({'pmid': '1', 'doi': '10.1/x'}), 'pmid:1')
        self.assertEqual(translate_titles.keyof({'doi': '10.1/X'}), 'doi:10.1/x')
        self.assertTrue(translate_titles.keyof(OPENAI).startswith('title:'), 'items without DOI/PMID still get a translation key')
        self.assertEqual(translate_titles.keyof(OPENAI), translate_titles.keyof(dict(OPENAI, title='[News] ' + OPENAI['title'])))


if __name__ == '__main__':
    unittest.main()
