"""Offline evidence, cost-bound and rollback regressions for AI quicklooks."""
import contextlib
import datetime
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch
import generate_quicklooks as q

TODAY = datetime.date(2026, 9, 30)
ABSTRACT = ('Background: A public clinical study examined 23 patients with atrial fibrillation. '
            'Methods: Investigators collected longitudinal electrocardiograms and evaluated outcomes. '
            'Results: The model identified a signal but the study did not demonstrate a clinical benefit. '
            'Conclusions: Independent clinical validation is required before use in patient care.')


def paper(number=1, local=True, **changes):
    p = {'doi': '10.1000/test%s' % number, 'pmid': str(42000000 + number), 'title': 'Cardiac model study',
         'date': TODAY.isoformat(), 'clinicalTier': '心律失常与电生理', 'sourceId': 'pubmed-journal-fallback',
         'summary_truncated': False, 'summary': ABSTRACT, 'abstractSections': [{'label': '', 'text': ABSTRACT}]}
    if not local:
        p.update(summary='', abstractSections=[], sourceId='rss-source')
    p.update(changes)
    return p


def valid_output():
    return {'title_zh': '心房颤动模型研究', 'one_line': '模型发现信号，未证实临床获益。',
            'design': '研究纳入23名患者。', 'limits': '仍需独立验证', 'why_read': '辨别模型信号与临床获益',
            'findings': [{'text': '研究评估心房颤动患者。', 'quote': '23 patients with atrial fibrillation'},
                         {'text': '使用前需要独立临床验证。', 'quote': 'Independent clinical validation is required'}]}


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(json.dumps(value).encode())
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()


class QuicklooksTests(unittest.TestCase):
    def setUp(self):
        # A forgotten mock must fail here instead of contacting a real provider.
        self.net = patch.object(q.urllib.request, 'urlopen', side_effect=AssertionError('unexpected network'))
        self.net.start()
        self.addCleanup(self.net.stop)
        self.model_net = patch.object(q.urllib.request, 'build_opener', side_effect=AssertionError('unexpected model transport'))
        self.model_net.start()
        self.addCleanup(self.model_net.stop)
        # Real process configuration must never affect offline synthetic requests.
        self.environment = patch.dict(q.os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_scope_does_not_use_arbitrary_tags(self):
        self.assertFalse(q.lane_core({'tags': ['自然语言处理', '眼科']}))
        self.assertFalse(q.lane_core({'clinicalTier': '前沿大模型与科技', 'category': 'AI前沿', 'tags': ['心电']}))
        self.assertTrue(q.lane_core({'category': 'AI医疗'}))
        self.assertTrue(q.lane_core(paper()))

    def test_only_full_official_abstracts_reused(self):
        self.assertEqual(q.local_abstract(paper())['abstractSource'], 'PubMed')
        self.assertIsNone(q.local_abstract(paper(sourceId='rss', basis='RSS 元数据 · 待编辑核验')))
        self.assertIsNone(q.local_abstract(paper(summary_truncated=True)))
        self.assertIsNone(q.local_abstract(paper(abstractSections=[{'label': 'CONCLUSIONS', 'text': ABSTRACT}])))
        self.assertIsNone(q.local_abstract(paper(abstractSections=[], summary='CONCLUSIONS: ' + ABSTRACT)))
        self.assertIsNone(q.local_abstract(paper(abstractSections=[], summary='Brief abstract.')))

    def test_candidate_first_dedup_keeps_richer_pubmed_abstract(self):
        candidate = paper(local=False)
        library = paper(date='2026-09-25', title='Older title')
        merged = q.merge_papers([candidate], [library])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]['date'], TODAY.isoformat())
        self.assertEqual(merged[0]['title'], candidate['title'])
        self.assertIsNotNone(q.local_abstract(merged[0]))

    def test_doi_pmid_bridge_does_not_duplicate_model_work(self):
        doi_only, pmid_only = paper(pmid='', local=False), paper(doi='')
        merged = q.merge_papers([doi_only, pmid_only], [paper()])
        self.assertEqual(len(merged), 1)
        self.assertEqual(q.paper_key(merged[0]), '10.1000/test1')
        self.assertIsNotNone(q.local_abstract(merged[0]))
        # Existing DOI-keyed output retains PMID and suppresses a future PMID-only row.
        have = {'items': {'10.1000/test1': {'pmid': '42000001'}}}
        self.assertEqual(q.eligible_papers([pmid_only], have, {}, set(), TODAY), [])

    def test_new_official_abstract_overrides_expired_missing_lookup(self):
        missing = {'10.1000/test1': {'first': '2026-09-01'}}
        self.assertEqual(len(q.eligible_papers([paper()], {'items': {}}, missing, set(), TODAY)), 1)
        self.assertEqual(q.eligible_papers([paper(local=False)], {'items': {}}, missing, set(), TODAY), [])

    def test_recent_new_candidates_and_pmid_without_doi_are_eligible(self):
        candidates = [paper(doi=''), paper(2, hasDraft=True), paper(3), paper(4),
                      paper(5, date='2026-09'), paper(6, date='2026-10-01'), paper(7, pubTypes=['Published Erratum'])]
        have = {'items': {'10.1000/test3': {}}}
        checked = {'10.1000/test4'}
        todo = q.eligible_papers(candidates, have, {}, checked, TODAY)
        self.assertEqual([q.paper_key(p) for p in todo], ['pmid-42000001'])

    def test_europepmc_query_and_identity_check(self):
        record = {'doi': '10.1000/test1', 'pmid': '42000001', 'abstractText': '<p>' + ABSTRACT + '</p>'}
        with patch.object(q.urllib.request, 'urlopen', return_value=Response({'resultList': {'result': [record]}})) as request:
            info = q.epmc(paper(local=False))
            self.assertIn('DOI%3A', request.call_args.args[0].full_url)
            self.assertEqual(info['abstract'], ABSTRACT)
            self.assertEqual(info['abstractSource'], 'Europe PMC')
        record['doi'] = '10.1000/wrong'
        with patch.object(q.urllib.request, 'urlopen', return_value=Response({'resultList': {'result': [record]}})):
            with self.assertRaisesRegex(q.QuicklookError, 'source_doi_mismatch'):
                q.epmc(paper(local=False))
        record['doi'] = '10.1000/test1'
        record['pmid'] = 'wrong'
        with patch.object(q.urllib.request, 'urlopen', return_value=Response({'resultList': {'result': [record]}})):
            with self.assertRaisesRegex(q.QuicklookError, 'source_pmid_mismatch'):
                q.epmc(paper(local=False))

    def test_pmid_source_and_missing_abstract(self):
        with patch.object(q.urllib.request, 'urlopen', return_value=Response({'resultList': {'result': []}})) as request:
            self.assertIsNone(q.epmc(paper(doi='', local=False)))
            self.assertIn('EXT_ID%3A42000001', request.call_args.args[0].full_url)
            self.assertIn('SRC%3AMED', request.call_args.args[0].full_url)

    def test_quote_and_numeric_guards_are_not_weakened(self):
        self.assertEqual(len(q.validate(valid_output(), ABSTRACT)['findings']), 2)
        wrong_quote = valid_output()
        wrong_quote['findings'][0]['quote'] = 'Paraphrased quote which never appeared'
        with self.assertRaisesRegex(q.QuicklookError, 'quote_not_in_abstract'):
            q.validate(wrong_quote, ABSTRACT)
        wrong_number = valid_output()
        wrong_number['title_zh'] += '（500名）'
        with self.assertRaisesRegex(q.QuicklookError, 'numbers_not_in_abstract'):
            q.validate(wrong_number, ABSTRACT)

    def test_prompt_short_field_limits_are_enforced(self):
        for field in ('one_line', 'design', 'why_read'):
            with self.subTest(field=field):
                value = valid_output()
                value[field] = '中' * 60
                self.assertEqual(len(q.validate(value, ABSTRACT)[field]), 60)
                value[field] += '中'
                with self.assertRaisesRegex(q.QuicklookError, 'invalid_field_' + field):
                    q.validate(value, ABSTRACT)

    def model_response(self, response, model='glm-5.3-flash'):
        opener = Mock()
        opener.open.return_value = response
        with patch.object(q.urllib.request, 'build_opener', return_value=opener) as build:
            result = q.call({'endpoint': 'https://provider.test/chat/completions',
                             'api_key': 'offline-fake-key', 'model': model},
                            'Study title', 'Journal', ABSTRACT)
        return result, opener, build

    def test_model_response_and_request_configuration(self):
        result, opener, build = self.model_response(Response({
            'choices': [{'message': {'content': json.dumps(valid_output())}, 'finish_reason': 'stop'}],
            'usage': {'total_tokens': 5}}))
        self.assertEqual(result[0], valid_output())
        self.assertEqual(result[1], {'total_tokens': 5})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.full_url, 'https://provider.test/chat/completions')
        self.assertEqual(opener.open.call_args.kwargs['timeout'], 90)
        self.assertEqual(request.get_header('Authorization'), 'Bearer offline-fake-key')
        payload = json.loads(request.data)
        self.assertEqual(payload['reasoning_effort'], 'low')
        self.assertEqual(payload['response_format'], {'type': 'json_object'})
        self.assertIsInstance(build.call_args.args[0], q.NoModelRedirect)

    def test_model_bad_provider_json_is_distinct_from_invalid_output(self):
        with self.assertRaisesRegex(q.QuicklookError, '^model_response_json$'):
            self.model_response(io.BytesIO(b'not JSON'))
        with self.assertRaisesRegex(q.QuicklookError, '^model_output_json$'):
            self.model_response(Response({'choices': [{'message': {'content': 'not JSON'}}]}))

    def test_model_decoder_limits_use_fixed_provider_or_item_error_codes(self):
        # Decoder limits vary by runtime. Inject their documented error classes.
        provider = {'choices': [{'message': {'content': '{}'}}]}
        for error_type in (ValueError, RecursionError):
            with self.subTest(error_type=error_type.__name__):
                with patch.object(q.json, 'loads', side_effect=error_type('offline-sensitive-detail')):
                    with self.assertRaisesRegex(q.QuicklookError, '^model_response_json$'):
                        self.model_response(Response(provider))
                with patch.object(q.json, 'loads', side_effect=[provider, error_type('offline-sensitive-detail')]):
                    with self.assertRaisesRegex(q.QuicklookError, '^model_output_json$'):
                        self.model_response(Response(provider))

    def test_model_envelope_output_shape_and_truncation(self):
        cases = [({}, 'model_response_shape'),
                 ([], 'model_response_shape'),
                 ({'choices': []}, 'model_response_shape'),
                 ({'choices': [{'message': {'content': None}}]}, 'model_output_shape'),
                 ({'choices': [{'message': {'content': '{}'}, 'finish_reason': 'length'}]}, 'model_output_truncated')]
        for response, code in cases:
            with self.subTest(code=code), self.assertRaisesRegex(q.QuicklookError, '^' + code + '$'):
                self.model_response(Response(response))

    def test_model_response_size_is_bounded(self):
        with self.assertRaisesRegex(q.QuicklookError, '^model_response_too_large$'):
            self.model_response(io.BytesIO(b'x' * 200_001))

    def test_model_redirect_never_forwards_credentials(self):
        handler = q.NoModelRedirect()
        request = q.urllib.request.Request('https://provider.test/chat', data=b'{}',
                                          headers={'Authorization': 'Bearer offline-secret'})
        for code in (301, 302, 303, 307, 308):
            for target in ('https://other.test/?token=offline-secret', 'http://provider.test/chat'):
                with self.subTest(code=code, target=target), self.assertRaisesRegex(q.QuicklookError, '^model_redirect_not_allowed$'):
                    handler.redirect_request(request, None, code, 'redirect', {}, target)

    def test_safe_metadata_never_copies_messages_identifiers_or_urls(self):
        secret = 'Bearer offline-secret https://provider.test/?token=offline-secret'
        result = q.safe_failure({'stage': secret, 'code': secret, 'error_type': secret,
                                 'paper': secret, 'url': secret, 'http_status': 403, 'scope': 'batch'})
        self.assertEqual(result, {'stage': 'processing', 'code': 'request_or_processing_failed',
                                  'error_type': 'ProcessingError', 'http_status': 403, 'scope': 'batch'})
        self.assertNotIn('offline-secret', json.dumps(result))
        self.assertEqual(q.safe_failure({'stage': [], 'code': {}, 'error_type': {}, 'scope': []}),
                         {'stage': 'processing', 'code': 'request_or_processing_failed', 'error_type': 'ProcessingError'})

    def test_model_and_lookup_caps_and_cached_content(self):
        old = {'items': {'10.1000/old': {'one_line': 'Keep me'}}, 'updatedAt': 'previous'}
        calls, lookups = [], []
        def fetch(p):
            lookups.append(q.paper_key(p))
            return None
        def model(cfg, title, journal, abstract):
            calls.append(title)
            return valid_output(), {}
        todo = [paper(i, local=False) for i in range(1, 8)] + [paper(i) for i in range(10, 15)]
        staged, _, stats, error = q.batch(todo, old, {}, {'model': 'mock'}, TODAY, 2, 3, fetch, model)
        self.assertIsNone(error)
        self.assertEqual(len(lookups), 3)
        self.assertEqual(len(calls), 2)
        self.assertEqual(stats['source_lookups'], 3)
        self.assertEqual(stats['model_calls'], 2)
        self.assertEqual(staged['items']['10.1000/old'], old['items']['10.1000/old'])
        self.assertEqual(len(old['items']), 1)  # Batch staging does not mutate cache.

    def test_validation_failure_skips_item_and_commits_only_verified_outputs(self):
        old, misses = {'items': {'old': {'value': 1}}, 'updatedAt': 'yesterday'}, {'pending': {'first': '2026-09-30'}}
        calls = []
        def model(*args):
            calls.append(1)
            output = valid_output()
            if len(calls) == 2:
                output['findings'][0]['quote'] = 'invented evidence snippet'
            return output, {}
        staged, missing, stats, error = q.batch([paper(i) for i in range(1, 5)], old, misses, {'model': 'mock'}, TODAY, 4, 4, model=model)
        self.assertEqual(len(calls), 4)
        self.assertEqual(staged['items']['old'], old['items']['old'])
        self.assertNotIn('10.1000/test2', staged['items'])
        self.assertEqual(set(staged['items']) - {'old'}, {'10.1000/test1', '10.1000/test3', '10.1000/test4'})
        self.assertEqual(missing, misses)
        self.assertEqual(stats['generated'], 3)
        self.assertEqual(stats['skipped_validation'], 1)
        self.assertTrue(stats['partial'])
        self.assertFalse(stats['batch_stopped'])
        self.assertEqual(error['stage'], 'validation')
        self.assertEqual(error['scope'], 'item')

    def test_invalid_output_json_is_item_failure_with_same_call_cap(self):
        calls = []
        def model(*args):
            calls.append(1)
            if len(calls) == 1:
                raise q.QuicklookError('model_output_json')
            return valid_output(), {}
        staged, _, stats, error = q.batch([paper(1), paper(2), paper(3)], {'items': {}}, {},
                                          {'model': 'mock'}, TODAY, 2, 2, model=model)
        self.assertEqual(len(calls), 2)
        self.assertEqual(set(staged['items']), {'10.1000/test2'})
        self.assertEqual(stats['skipped_validation'], 1)
        self.assertEqual(error['code'], 'model_output_json')

    def test_identity_mismatch_skips_only_that_paper(self):
        def fetch(p):
            if p['doi'] == '10.1000/test1':
                raise q.QuicklookError('source_doi_mismatch')
            return {'abstract': ABSTRACT, 'pmid': '', 'abstractSource': 'Europe PMC'}
        staged, _, stats, error = q.batch([paper(1, local=False), paper(2, local=False)], {'items': {}}, {},
                                          {'model': 'mock'}, TODAY, 3, 3, fetch=fetch,
                                          model=lambda *a: (valid_output(), {}))
        self.assertFalse(stats['batch_stopped'])
        self.assertEqual(stats['generated'], 1)
        self.assertEqual(error['scope'], 'item')

    def test_global_failure_stops_after_verified_success_and_keeps_old_cache(self):
        calls = []
        def model(*args):
            calls.append(1)
            if len(calls) == 2:
                raise urllib.error.HTTPError('https://provider.test/?token=offline-secret', 429,
                                             'offline-secret', {}, None)
            return valid_output(), {}
        old = {'items': {'old': {'one_line': 'Keep me'}}}
        staged, _, stats, error = q.batch([paper(1), paper(2), paper(3)], old, {},
                                          {'model': 'mock'}, TODAY, 3, 3, model=model)
        self.assertEqual(len(calls), 2)
        self.assertEqual(set(staged['items']), {'old', '10.1000/test1'})
        self.assertEqual(staged['items']['old'], old['items']['old'])
        self.assertEqual(stats['generated'], 1)
        self.assertTrue(stats['partial'])
        self.assertTrue(stats['batch_stopped'])
        self.assertEqual(error['scope'], 'batch')
        self.assertEqual(error['http_status'], 429)
        self.assertNotIn('offline-secret', json.dumps(stats))

    def test_all_invalid_outputs_consume_cap_without_becoming_fresh_content(self):
        calls = []
        old = {'items': {'old': {'one_line': 'Keep me'}}, 'updatedAt': 'previous'}
        def model(*args):
            calls.append(1)
            value = valid_output()
            value['design'] = '研究纳入99999名患者。'
            return value, {}
        staged, _, stats, error = q.batch([paper(1), paper(2), paper(3)], old, {},
                                          {'model': 'mock'}, TODAY, 2, 2, model=model)
        self.assertEqual(len(calls), 2)
        self.assertEqual(staged, old)
        self.assertEqual(stats['generated'], 0)
        self.assertEqual(stats['skipped_validation'], 2)
        self.assertTrue(stats['failed'])
        self.assertFalse(stats['partial'])
        self.assertEqual(error['code'], 'numbers_not_in_abstract')

    def test_invalid_unicode_item_does_not_block_verified_items_or_cache_encoding(self):
        def model(cfg, title, journal, abstract):
            output = valid_output()
            if title == 'Invalid study':
                output['title_zh'] = chr(0xD800)
            return output, {}
        staged, _, stats, error = q.batch([paper(title='Invalid study'), paper(2)], {'items': {}}, {},
                                          {'model': 'mock'}, TODAY, 2, 2, model=model)
        self.assertEqual(set(staged['items']), {'10.1000/test2'})
        self.assertEqual(stats['skipped_validation'], 1)
        self.assertEqual(error['code'], 'invalid_field_title_zh')
        json.dumps(staged, ensure_ascii=False).encode('utf-8')
        for field in ('text', 'quote'):
            output = valid_output()
            output['findings'][0][field] = chr(0xD800)
            with self.subTest(field=field), self.assertRaisesRegex(q.QuicklookError, '^invalid_finding_shape$'):
                q.validate(output, ABSTRACT)

    def test_provider_envelope_auth_and_rate_failures_stop_batch(self):
        for failure in (q.QuicklookError('model_response_shape'),
                        *(urllib.error.HTTPError('https://provider.test/', status, 'offline-secret', {}, None)
                          for status in (401, 403, 429))):
            calls = []
            def model(*args):
                calls.append(1)
                raise failure
            old = {'items': {'old': {'one_line': 'Keep me'}}}
            staged, _, stats, error = q.batch([paper(1), paper(2)], old, {},
                                              {'model': 'mock'}, TODAY, 2, 2, model=model)
            with self.subTest(error_type=type(failure).__name__, status=getattr(failure, 'code', None)):
                self.assertEqual(len(calls), 1)
                self.assertEqual(staged, old)
                self.assertTrue(stats['batch_stopped'])
                self.assertEqual(stats['skipped_validation'], 0)
                self.assertEqual(error['scope'], 'batch')

    def test_source_failure_and_model_http_failure_stop_without_leaking(self):
        old = {'items': {}}
        secret = 'pretend-sensitive-provider-token'
        def fail_source(p):
            raise urllib.error.URLError(secret)
        _, _, stats, error = q.batch([paper(local=False), paper(2)], old, {}, {'model': 'mock'}, TODAY, 2, 2, fetch=fail_source)
        self.assertEqual(stats['model_calls'], 0)
        self.assertEqual(error['stage'], 'source')
        self.assertNotIn(secret, json.dumps(error))
        def fail_model(*args):
            raise urllib.error.HTTPError('https://provider.test/' + secret, 429, secret, {}, None)
        staged, _, stats, error = q.batch([paper(), paper(2)], old, {}, {'model': 'mock'}, TODAY, 2, 2, model=fail_model)
        self.assertEqual(staged, old)
        self.assertEqual(stats['model_calls'], 1)
        self.assertEqual(error['http_status'], 429)
        self.assertNotIn(secret, json.dumps(error))

    def test_dry_run_does_not_read_credentials_write_cache_or_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / 'data/candidates.json').write_text(json.dumps({'items': [paper()]}))
            (root / 'data/library.json').write_text(json.dumps({'papers': []}))
            out, miss, diag = root / 'data/quicklooks.json', root / '.local/misses.json', root / '.local/diagnostic.json'
            with patch.object(q, 'ROOT', root), patch.object(q, 'OUT', out), patch.object(q, 'MISS', miss), patch.object(q, 'DIAGNOSTIC', diag), patch.object(q.datetime, 'date', type('Date', (datetime.date,), {'today': classmethod(lambda cls: TODAY)})):
                real_read = q.read_json
                def guarded(path, fallback):
                    self.assertNotEqual(path.name, 'llm.json')
                    return real_read(path, fallback)
                with patch.object(q, 'read_json', side_effect=guarded), contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(q.main([]), 0)
                self.assertTrue(json.loads(output.getvalue())['dry_run'])
            self.assertFalse(out.exists())
            self.assertFalse(diag.exists())
            self.assertFalse((root / 'data/quicklook-status.json').exists())

    def test_main_failure_does_not_replace_existing_disk_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / '.local').mkdir()
            (root / 'data/candidates.json').write_text(json.dumps({'items': [paper()]}))
            (root / 'data/library.json').write_text(json.dumps({'papers': []}))
            (root / '.local/llm.json').write_text(json.dumps({'model': 'mock', 'api_key': 'fake-offline-key', 'endpoint': 'https://provider.test/call'}))
            out, miss, diag = root / 'data/quicklooks.json', root / '.local/misses.json', root / '.local/diagnostic.json'
            original = '{"items":{"old":{"one_line":"old valid text"}},"updatedAt":"old"}'
            out.write_text(original)
            failure = ({'items': {}}, {}, {'generated': 0, 'failed_validation_or_model': 1}, {'stage': 'validation', 'code': 'quote_not_in_abstract'})
            with patch.object(q, 'ROOT', root), patch.object(q, 'OUT', out), patch.object(q, 'MISS', miss), patch.object(q, 'DIAGNOSTIC', diag), patch.object(q, 'batch', return_value=failure), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(q.main(['--call-model']), 1)
            self.assertEqual(out.read_text(), original)
            self.assertTrue(diag.exists())
            self.assertNotIn('fake-offline-key', diag.read_text())

    def test_main_partial_is_nonzero_and_persists_only_verified_cache_and_safe_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / '.local').mkdir()
            (root / 'data/candidates.json').write_text(json.dumps({'items': []}))
            (root / 'data/library.json').write_text(json.dumps({'papers': []}))
            qcfg = {'model': 'mock', 'api_key': 'offline-secret', 'endpoint': 'https://provider.test/call'}
            (root / '.local/llm.json').write_text(json.dumps(qcfg))
            out = root / 'data/quicklooks.json'
            old = {'items': {'old': {'one_line': 'Keep me'}}}
            out.write_text(json.dumps(old))
            def model(cfg, title, journal, abstract):
                value = valid_output()
                if title == 'Invalid study':
                    value['findings'][0]['quote'] = 'invented evidence snippet'
                return value, {}
            partial = q.batch([paper(title='Invalid study'), paper(2)], old, {}, qcfg,
                              TODAY, 2, 2, model=model)
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(q, 'ROOT', root), patch.object(q, 'OUT', out), patch.object(q, 'MISS', root / '.local/misses.json'), patch.object(q, 'DIAGNOSTIC', root / '.local/diagnostic.json'), patch.object(q, 'batch', return_value=partial), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(q.main(['--call-model']), 1)
            cached = json.loads(out.read_text())
            self.assertEqual(set(cached['items']), {'old', '10.1000/test2'})
            status = json.loads((root / 'data/quicklook-status.json').read_text())
            self.assertEqual(status['outcome'], 'partial')
            self.assertTrue(status['stats']['committed'])
            self.assertEqual(status['stats']['generated'], 1)
            self.assertEqual(status['stats']['skipped_validation'], 1)
            self.assertEqual(status['failures'][0]['code'], 'quote_not_in_abstract')
            self.assertIn('QUICKLOOK_ERROR', stderr.getvalue())
            for value in (stdout.getvalue(), stderr.getvalue(), json.dumps(status)):
                self.assertNotIn('offline-secret', value)
                self.assertNotIn('invented evidence snippet', value)
                self.assertNotIn('provider.test', value)

    def test_missing_or_unsafe_config_is_not_success_and_has_safe_status(self):
        for cfg, code in (({}, 'missing_config'),
                          ({'model': 'mock', 'api_key': 'offline-secret', 'endpoint': 'http://provider.test/?token=offline-secret'}, 'unsafe_endpoint'),
                          ({'model': 'mock', 'api_key': 'offline-secret', 'endpoint': 'https://['}, 'unsafe_endpoint')):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'data').mkdir()
                (root / '.local').mkdir()
                (root / 'data/candidates.json').write_text(json.dumps({'items': []}))
                (root / 'data/library.json').write_text(json.dumps({'papers': []}))
                (root / '.local/llm.json').write_text(json.dumps(cfg))
                out = root / 'data/quicklooks.json'
                original = '{"items":{"old":{"one_line":"Keep me"}}}'
                out.write_text(original)
                stderr = io.StringIO()
                with patch.object(q, 'ROOT', root), patch.object(q, 'OUT', out), patch.object(q, 'MISS', root / '.local/misses.json'), contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as failure:
                    q.main(['--call-model'])
                self.assertEqual(failure.exception.code, 2)
                self.assertEqual(out.read_text(), original)
                status = json.loads((root / 'data/quicklook-status.json').read_text())
                self.assertEqual(status['outcome'], 'failed')
                self.assertEqual(status['error']['code'], code)
                self.assertNotIn('offline-secret', stderr.getvalue() + json.dumps(status))


if __name__ == '__main__':
    unittest.main()
