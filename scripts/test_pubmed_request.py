"""Offline regression for long E-utilities queries and failure propagation."""
import datetime
import http.client
import io
import json
import unittest
import urllib.error
import urllib.parse
from unittest.mock import MagicMock, call, patch

import fetch_pubmed
from source_fallbacks import journal_query

ZERO_JITTER = lambda: 0.0


class FakeClock:
    def __init__(self, start=0.0):
        self.t = start

    def __call__(self):
        return self.t


class PubmedRequestTests(unittest.TestCase):
    def record_wait(self, clock=None):
        clock = clock or FakeClock()
        waits = []
        def wait(seconds):
            waits.append(seconds)
            clock.t += seconds
        return clock, waits, wait

    def call(self, action, params):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'public metadata'
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', return_value=response) as opener:
            self.assertEqual(fetch_pubmed.request(action, params), b'public metadata')
        opener.assert_called_once()
        response.__enter__.return_value.read.assert_called_once_with(10_000_000)
        self.assertEqual(opener.call_args.kwargs, {'timeout': 30})
        return opener.call_args.args[0]

    def test_full_watched_journal_query_posts_without_truncation(self):
        today = datetime.date(2026, 10, 7)
        term = '(' + ' OR '.join(journal_query(j) for j in fetch_pubmed.JOURNALS) + ') AND ("' + (today-datetime.timedelta(days=30)).strftime('%Y/%m/%d') + '"[Date - Publication] : "' + today.strftime('%Y/%m/%d') + '"[Date - Publication])'
        params = {'db': 'pubmed', 'term': term, 'retmode': 'json', 'retmax': 1500, 'sort': 'pub date'}
        self.assertGreater(len(urllib.parse.urlencode(params)), 1800)
        req = self.call('esearch.fcgi', params)
        self.assertEqual(req.get_method(), 'POST')
        self.assertEqual(req.full_url, 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi')
        self.assertEqual(req.get_header('Content-type'), 'application/x-www-form-urlencoded')
        self.assertEqual(urllib.parse.parse_qs(req.data.decode('ascii')), {k:[str(v)] for k,v in params.items()})

    def test_short_fetch_keeps_all_ids_in_get(self):
        params = {'db':'pubmed', 'id':'123,456', 'retmode':'xml'}
        req = self.call('efetch.fcgi', params)
        self.assertEqual(req.get_method(), 'GET')
        self.assertIsNone(req.data)
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query), {k:[v] for k,v in params.items()})

    def test_long_uid_fetch_uses_post_and_keeps_all_ids(self):
        params = {'db':'pubmed', 'id':','.join(str(10000000+i) for i in range(300)), 'retmode':'xml'}
        req = self.call('efetch.fcgi', params)
        self.assertEqual(req.get_method(), 'POST')
        self.assertEqual(urllib.parse.parse_qs(req.data.decode('ascii'))['id'], [params['id']])

    def test_incomplete_read_reopens_response_and_returns_only_complete_payload(self):
        first, second = MagicMock(), MagicMock()
        first.__enter__.return_value.read.side_effect = http.client.IncompleteRead(b'partial XML')
        second.__enter__.return_value.read.return_value = b'<PubmedArticleSet/>'
        responses = iter((first, second))

        def reopen(*args, **kwargs):
            response = next(responses)
            if response is second:
                first.__exit__.assert_called_once()
            return response

        waits = []
        def backoff(seconds):
            first.__exit__.assert_called_once()
            waits.append(seconds)

        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=reopen) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            result = fetch_pubmed.request('efetch.fcgi', {'db': 'pubmed', 'id': '123', 'retmode': 'xml'},
                                          wait=backoff, rng=ZERO_JITTER)
        self.assertEqual(result, b'<PubmedArticleSet/>')
        self.assertEqual(opener.call_count, 2)
        self.assertIs(opener.call_args_list[0].args[0], opener.call_args_list[1].args[0])
        self.assertEqual(waits, [5.0])
        sleep.assert_not_called()
        for response in (first, second):
            response.__enter__.return_value.read.assert_called_once_with(10_000_000)
            response.__exit__.assert_called_once()

    def test_incomplete_read_retries_are_bounded_and_last_error_propagates(self):
        responses = [MagicMock() for _ in range(4)]
        errors = [http.client.IncompleteRead(('partial %d' % i).encode()) for i in range(4)]
        for response, error in zip(responses, errors):
            response.__enter__.return_value.read.side_effect = error
        waits = []
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=responses) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            with self.assertRaises(http.client.IncompleteRead) as caught:
                fetch_pubmed.request('esearch.fcgi', {'term': 'public query ' * 500}, wait=waits.append, rng=ZERO_JITTER)
        self.assertIs(caught.exception, errors[-1])
        self.assertEqual(opener.call_count, 4)
        self.assertEqual(waits, [5.0, 15.0, 45.0])
        sleep.assert_not_called()
        for response in responses:
            response.__enter__.return_value.read.assert_called_once_with(10_000_000)
            response.__exit__.assert_called_once()

    def test_http_failure_does_not_report_success_or_partial_coverage(self):
        error = urllib.error.HTTPError('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', 414, 'Request-URI Too Long', {}, None)
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=error) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                fetch_pubmed.request('esearch.fcgi', {'term':'public query ' * 500})
        self.assertIs(caught.exception, error)
        opener.assert_called_once()
        sleep.assert_not_called()

    def test_bad_request_retains_action_and_public_error_without_retry_or_query(self):
        error = urllib.error.HTTPError('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi', 400, 'Bad Request', {}, io.BytesIO(b'{"error":"Invalid uid"}'))
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=error) as opener, patch.object(fetch_pubmed.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                fetch_pubmed.request('efetch.fcgi', {'db':'pubmed', 'id':'synthetic-invalid', 'retmode':'xml'})
        self.assertIs(caught.exception, error)
        opener.assert_called_once();sleep.assert_not_called()
        self.assertIn('efetch.fcgi', error.__notes__[0])
        self.assertIn('Invalid uid', error.__notes__[0])
        self.assertNotIn('synthetic-invalid',error.__notes__[0])

    def test_timeout_is_retried_with_backoff_then_raised(self):
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=TimeoutError('timed out')) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            with self.assertRaises(TimeoutError):
                fetch_pubmed.request('esearch.fcgi', {'db': 'pubmed', 'term': 'public', 'retmode': 'json'},
                                     wait=lambda _: None, rng=ZERO_JITTER)
        self.assertEqual(opener.call_count, 4)
        self.assertEqual(sleep.call_count, 0)
        self.assertEqual(opener.call_args.kwargs, {'timeout': 30})

    def test_server_error_retries_then_returns_the_completed_body(self):
        failure = urllib.error.HTTPError('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', 500, 'Internal Server Error', {}, io.BytesIO(b''))
        success = MagicMock()
        success.__enter__.return_value.read.return_value = b'{"esearchresult":{"count":"0","idlist":[]}}'
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=[failure, success]) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            body = fetch_pubmed.request('esearch.fcgi', {'db': 'pubmed', 'term': 'public', 'retmode': 'json'},
                                       wait=lambda _: None, rng=ZERO_JITTER)
        self.assertEqual(body, b'{"esearchresult":{"count":"0","idlist":[]}}')
        self.assertEqual(opener.call_count, 2)
        sleep.assert_not_called()

    def test_missing_idlist_and_error_payloads_do_not_replace_the_previous_file(self):
        import tempfile
        from pathlib import Path
        cases = [
            ({'esearchresult': {'count': '12'}}, 'pubmed_idlist_missing'),
            ({'esearchresult': {'count': '12', 'ERROR': 'Search Backend failed'}}, 'pubmed_upstream_error'),
            ({'error': 'API rate limit exceeded'}, 'pubmed_upstream_error'),
            ({'header': {}}, 'pubmed_esearchresult_missing'),
        ]
        previous = '{"items":[{"id":"pmid-previous"}],"note":"previous good"}\n'
        clock = datetime.datetime(2026, 11, 5, tzinfo=datetime.timezone.utc)
        for payload, code in cases:
            with self.subTest(code=code):
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / 'pubmed.json'
                    path.write_text(previous)
                    raw = json.dumps(payload).encode()
                    waits = []
                    with patch.object(fetch_pubmed, 'request', return_value=raw) as opener, \
                            patch.object(fetch_pubmed.time, 'sleep') as sleep:
                        with self.assertRaises(fetch_pubmed.PubmedError) as caught:
                            fetch_pubmed.refresh(path, 30, 1500, now=clock, wait=waits.append, rng=ZERO_JITTER)
                    self.assertEqual(caught.exception.code, code)
                    self.assertEqual(path.read_text(), previous)
                    self.assertFalse(path.with_name('.pubmed.json.tmp').exists())
                    self.assertEqual(opener.call_count, 4)
                    self.assertEqual(waits, [5.0, 15.0, 45.0])
                    sleep.assert_not_called()

    def test_empty_idlist_is_a_complete_result_and_efetch_error_keeps_previous(self):
        import json as jsonlib
        import tempfile
        from pathlib import Path
        previous = '{"items":[{"id":"pmid-previous"}]}\n'
        clock = datetime.datetime(2026, 11, 5, tzinfo=datetime.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            path.write_text(previous)
            raw = jsonlib.dumps({'esearchresult': {'count': '0', 'idlist': []}}).encode()
            with patch.object(fetch_pubmed, 'request', return_value=raw), patch.object(fetch_pubmed.time, 'sleep'):
                data = fetch_pubmed.refresh(path, 30, 1500, now=clock)
            saved = jsonlib.loads(path.read_text())
            self.assertEqual(data['fetched'], 0)
            self.assertEqual(saved['totalHits'], 0)
            self.assertEqual(saved['items'], [])
            self.assertFalse(path.with_name('.pubmed.json.tmp').exists())
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            path.write_text(previous)
            def fake(action, params, attempts=3, wait=None, **kwargs):
                if action == 'esearch.fcgi':
                    return jsonlib.dumps({'esearchresult': {'count': '1', 'idlist': ['12345678']}}).encode()
                return b'<ERROR>Unable to obtain query</ERROR>'
            with patch.object(fetch_pubmed, 'request', side_effect=fake), patch.object(fetch_pubmed.time, 'sleep'):
                with self.assertRaises(fetch_pubmed.PubmedError) as caught:
                    fetch_pubmed.refresh(path, 30, 1500, now=clock)
            self.assertEqual(caught.exception.code, 'pubmed_efetch_error')
            self.assertEqual(path.read_text(), previous)

    def _http_error(self, code, reason, body, url='https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi', headers=None):
        return urllib.error.HTTPError(url, code, reason, headers or {}, io.BytesIO(body))

    def _success(self, payload=b'<PubmedArticleSet/>'):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = payload
        return response

    def test_timeout_then_success_uses_injected_wait_and_does_not_sleep(self):
        waits = []
        success = self._success(b'{"esearchresult":{"count":"0","idlist":[]}}')
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=[TimeoutError('timed out'), success]) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            body = fetch_pubmed.request('esearch.fcgi', {'db': 'pubmed', 'term': 'public', 'retmode': 'json'},
                                       wait=waits.append, rng=ZERO_JITTER)
        self.assertEqual(body, b'{"esearchresult":{"count":"0","idlist":[]}}')
        self.assertEqual(opener.call_count, 2)
        self.assertEqual(waits, [5.0])
        sleep.assert_not_called()
        self.assertEqual(opener.call_args.kwargs, {'timeout': 30})

    def test_persistent_timeout_is_retried_then_raised_without_sleep(self):
        waits = []
        errors = [TimeoutError('timed out') for _ in range(4)]
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=errors) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            with self.assertRaises(TimeoutError) as caught:
                fetch_pubmed.request('efetch.fcgi', {'db': 'pubmed', 'id': '123', 'retmode': 'xml'},
                                     wait=waits.append, rng=ZERO_JITTER)
        self.assertIs(caught.exception, errors[-1])
        self.assertEqual(opener.call_count, 4)
        self.assertEqual(waits, [5.0, 15.0, 45.0])
        self.assertTrue(all(delay >= fetch_pubmed.NCBI_MIN_INTERVAL for delay in waits))
        sleep.assert_not_called()

    def test_genuine_bad_request_is_not_retried_and_does_not_sleep(self):
        waits = []
        error = self._http_error(400, 'Bad Request', b'{"error":"Invalid uid"}')
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=error) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                fetch_pubmed.request('efetch.fcgi', {'db': 'pubmed', 'id': 'synthetic-invalid', 'retmode': 'xml'}, wait=waits.append)
        self.assertIs(caught.exception, error)
        opener.assert_called_once()
        self.assertEqual(waits, [])
        sleep.assert_not_called()
        self.assertIn('Invalid uid', error.__notes__[0])
        self.assertNotIn('synthetic-invalid', error.__notes__[0])

    def test_http400_timeout_body_is_retried_then_returns_the_completed_body(self):
        waits = []
        # One object per attempt: the error body can be read only once.
        failures = [
            self._http_error(400, 'Bad Request', b'Error: External viewer error: Empty Response. Bytes read: 0 Status: Timeout')
            for _ in range(2)
        ]
        success = self._success(b'<PubmedArticleSet/>')
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=failures + [success]) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            body = fetch_pubmed.request('efetch.fcgi', {'db': 'pubmed', 'id': '123', 'retmode': 'xml'},
                                       wait=waits.append, rng=ZERO_JITTER)
        self.assertEqual(body, b'<PubmedArticleSet/>')
        self.assertEqual(opener.call_count, 3)
        self.assertEqual(waits, [5.0, 15.0])
        sleep.assert_not_called()
        self.assertIn('External viewer error', failures[0].__notes__[0])
        self.assertIn('"httpStatus": 400', failures[0].__notes__[0])
        self.assertNotIn('123', failures[0].__notes__[0])

    def test_http400_timeout_body_exhausted_retries_keep_the_previous_file(self):
        import tempfile
        from pathlib import Path
        previous = '{"items":[{"id":"pmid-previous"}]}\n'
        clock = datetime.datetime(2026, 11, 5, tzinfo=datetime.timezone.utc)
        waits = []
        errors = [
            self._http_error(400, 'Bad Request', b'Error: External viewer error: Empty Response. Bytes read: 0 Status: Timeout')
            for _ in range(4)
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            path.write_text(previous)
            with patch.object(fetch_pubmed, 'load_esearch', return_value={'count': '1', 'idlist': ['12345678']}), \
                    patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=errors) as opener, \
                    patch.object(fetch_pubmed.time, 'sleep') as sleep:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    fetch_pubmed.refresh(path, 30, 1500, now=clock, wait=waits.append, rng=ZERO_JITTER)
            self.assertIs(caught.exception, errors[-1])
            self.assertEqual(path.read_text(), previous)
            self.assertFalse(path.with_name('.pubmed.json.tmp').exists())
            self.assertEqual(opener.call_count, 4)
            # NCBI pacing after search and before the first batch, plus three retry backoffs.
            self.assertEqual(waits, [0.4, 0.4, 5.0, 15.0, 45.0])
            sleep.assert_not_called()

    def _health(self, root, **extra):
        from pathlib import Path
        health = Path(root) / 'source-health.json'
        payload = {'checkedAt': '2026-11-05T00:00:00+00:00', 'sources': [{'id': 'rss-1', 'name': 'Example', 'status': 'ok', 'url': 'https://example.org/rss'}], **extra}
        health.write_text(json.dumps(payload))
        return health

    def test_run_reuses_previous_snapshot_and_records_visible_health_after_timeout(self):
        import tempfile
        from pathlib import Path
        previous = json.dumps({'updatedAt': '2026-11-05T01:00:00+00:00', 'items': [{'id': 'pmid-previous'}]})
        clock = datetime.datetime(2026, 11, 5, 2, tzinfo=datetime.timezone.utc)
        waits = []
        errors = [
            self._http_error(400, 'Bad Request', b'Error: External viewer error: Empty Response. Bytes read: 0 Status: Timeout')
            for _ in range(4)
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            path.write_text(previous)
            health = self._health(tmp, pubmedFetch={'status': 'ok', 'checkedAt': '2026-11-05T01:00:00+00:00', 'api_key': 'must-not-leak'})
            with patch.object(fetch_pubmed, 'load_esearch', return_value={'count': '1', 'idlist': ['12345678']}), \
                    patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=errors) as opener, \
                    patch.object(fetch_pubmed.time, 'sleep') as sleep:
                result = fetch_pubmed.run(path, 30, 1500, now=clock, wait=waits.append, health_path=health, rng=ZERO_JITTER)
            self.assertTrue(result['degraded'])
            self.assertEqual(path.read_text(), previous)
            self.assertEqual(opener.call_count, 4)
            self.assertEqual(waits, [0.4, 0.4, 5.0, 15.0, 45.0])
            sleep.assert_not_called()
            saved = json.loads(health.read_text())
            fetch = saved['pubmedFetch']
            self.assertEqual(fetch['status'], 'failed')
            self.assertEqual(fetch['httpStatus'], 400)
            self.assertEqual(fetch['errorCategory'], 'pubmed_upstream_timeout')
            self.assertTrue(fetch['reusedPrevious'])
            self.assertEqual(fetch['cachedItems'], 1)
            self.assertEqual(fetch['previousUpdatedAt'], '2026-11-05T01:00:00+00:00')
            self.assertEqual(saved['sources'][0]['id'], 'rss-1')
            blob = health.read_text() + health.with_suffix('.js').read_text()
            self.assertNotIn('must-not-leak', blob)
            self.assertNotIn('api_key', json.dumps(fetch))
            self.assertNotIn('12345678', blob)
            self.assertNotIn('synthetic', blob)

    def test_run_without_previous_snapshot_still_fails_the_step(self):
        import tempfile
        from pathlib import Path
        clock = datetime.datetime(2026, 11, 5, 2, tzinfo=datetime.timezone.utc)
        waits = []
        errors = [TimeoutError('timed out') for _ in range(4)]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            health = self._health(tmp)
            with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=errors) as opener, \
                    patch.object(fetch_pubmed.time, 'sleep') as sleep:
                with self.assertRaises(TimeoutError):
                    fetch_pubmed.run(path, 30, 1500, now=clock, wait=waits.append, health_path=health, rng=ZERO_JITTER)
            opener.assert_called()
            sleep.assert_not_called()
            self.assertFalse(path.exists())
            self.assertNotIn('pubmedFetch', json.loads(health.read_text()) or {})
            self.assertEqual(waits, [5.0, 15.0, 45.0])

    def test_run_does_not_degrade_a_genuine_bad_request_even_with_cache(self):
        import tempfile
        from pathlib import Path
        previous = json.dumps({'updatedAt': '2026-11-05T01:00:00+00:00', 'items': [{'id': 'pmid-previous'}]})
        clock = datetime.datetime(2026, 11, 5, 2, tzinfo=datetime.timezone.utc)
        waits = []
        error = self._http_error(400, 'Bad Request', b'{"error":"Invalid uid"}')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            path.write_text(previous)
            health = self._health(tmp)
            with patch.object(fetch_pubmed, 'load_esearch', return_value={'count': '1', 'idlist': ['synthetic-invalid']}), \
                    patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=error) as opener, \
                    patch.object(fetch_pubmed.time, 'sleep') as sleep:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    fetch_pubmed.run(path, 30, 1500, now=clock, wait=waits.append, health_path=health, rng=ZERO_JITTER)
            self.assertIs(caught.exception, error)
            opener.assert_called_once()
            self.assertEqual(waits, [0.4, 0.4])  # pacing only, no retry
            sleep.assert_not_called()
            self.assertEqual(path.read_text(), previous)
            self.assertNotIn('pubmedFetch', json.loads(health.read_text()))

    def test_successful_run_clears_a_previous_fetch_failure(self):
        import tempfile
        from pathlib import Path
        clock = datetime.datetime(2026, 11, 5, 2, tzinfo=datetime.timezone.utc)
        waits = []
        raw = json.dumps({'esearchresult': {'count': '0', 'idlist': []}}).encode()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            health = self._health(tmp, pubmedFetch={'status': 'failed', 'errorCategory': 'pubmed_upstream_timeout', 'httpStatus': 400, 'checkedAt': '2026-11-05T01:00:00+00:00'})
            with patch.object(fetch_pubmed, 'request', return_value=raw) as opener, \
                    patch.object(fetch_pubmed.time, 'sleep') as sleep:
                data = fetch_pubmed.run(path, 30, 1500, now=clock, wait=waits.append, health_path=health, rng=ZERO_JITTER)
            self.assertFalse(data.get('degraded'))
            self.assertEqual(data['fetched'], 0)
            self.assertEqual(json.loads(path.read_text())['items'], [])
            saved = json.loads(health.read_text())['pubmedFetch']
            self.assertEqual(saved, {'status': 'ok', 'checkedAt': clock.isoformat()})
            self.assertNotIn('errorCategory', saved)
            self.assertNotIn('httpStatus', saved)
            opener.assert_called()
            sleep.assert_not_called()

    def test_retry_jitter_stays_within_20_percent(self):
        for attempt, base in enumerate((5.0, 15.0, 45.0)):
            with self.subTest(attempt=attempt):
                self.assertEqual(fetch_pubmed.retry_delay(attempt, rng=lambda: 0.0), base)
                self.assertEqual(fetch_pubmed.retry_delay(attempt, rng=lambda: 1.0), base * 1.2)
                self.assertEqual(fetch_pubmed.retry_delay(attempt, rng=lambda: 0.5), base * 1.1)
        waits = []
        success = self._success(b'{"esearchresult":{"count":"0","idlist":[]}}')
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=[TimeoutError('timed out'), success]), \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            fetch_pubmed.request('esearch.fcgi', {'db': 'pubmed', 'term': 'public', 'retmode': 'json'},
                                 wait=waits.append, rng=lambda: 0.25)
        self.assertEqual(waits, [5.0 * 1.05])
        self.assertGreaterEqual(waits[0], 5.0)
        self.assertLessEqual(waits[0], 5.0 * 1.2)
        sleep.assert_not_called()

    def test_429_with_retry_after_waits_that_header_value(self):
        waits = []
        failure = self._http_error(429, 'Too Many Requests', b'', headers={'Retry-After': '12'})
        success = self._success(b'<PubmedArticleSet/>')
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=[failure, success]) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            body = fetch_pubmed.request('efetch.fcgi', {'db': 'pubmed', 'id': '123', 'retmode': 'xml'},
                                       wait=waits.append, rng=ZERO_JITTER)
        self.assertEqual(body, b'<PubmedArticleSet/>')
        self.assertEqual(opener.call_count, 2)
        self.assertEqual(waits, [12.0])
        sleep.assert_not_called()

    def test_429_without_retry_after_uses_standard_backoff(self):
        waits = []
        failure = self._http_error(429, 'Too Many Requests', b'')
        success = self._success(b'<PubmedArticleSet/>')
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=[failure, success]), \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            fetch_pubmed.request('efetch.fcgi', {'db': 'pubmed', 'id': '123', 'retmode': 'xml'},
                                 wait=waits.append, rng=ZERO_JITTER)
        self.assertEqual(waits, [5.0])
        sleep.assert_not_called()

    def test_time_budget_degrades_without_sleeping_past_the_limit(self):
        import tempfile
        from pathlib import Path
        previous = json.dumps({'updatedAt': '2026-11-05T01:00:00+00:00', 'items': [{'id': 'pmid-previous'}]})
        stamp = datetime.datetime(2026, 11, 5, 2, tzinfo=datetime.timezone.utc)
        mono, waits, wait = self.record_wait()
        errors = [
            self._http_error(400, 'Bad Request', b'Error: External viewer error: Empty Response. Bytes read: 0 Status: Timeout')
            for _ in range(4)
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            path.write_text(previous)
            health = self._health(tmp)
            with patch.object(fetch_pubmed, 'load_esearch', return_value={'count': '1', 'idlist': ['12345678']}), \
                    patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=errors) as opener, \
                    patch.object(fetch_pubmed.time, 'sleep') as sleep:
                result = fetch_pubmed.run(path, 30, 1500, now=stamp, wait=wait, health_path=health,
                                          clock=mono, rng=ZERO_JITTER, time_budget=4)
            self.assertTrue(result['degraded'])
            self.assertEqual(result['pubmedFetch']['errorCategory'], 'pubmed_time_budget_exceeded')
            self.assertNotIn('httpStatus', result['pubmedFetch'])
            self.assertTrue(result['pubmedFetch']['reusedPrevious'])
            self.assertEqual(path.read_text(), previous)
            # Two NCBI pacing waits fit; the 5s retry would exceed the 4s budget, so it is skipped.
            self.assertEqual(waits, [0.4, 0.4])
            self.assertEqual(opener.call_count, 1)
            sleep.assert_not_called()
            self.assertEqual(json.loads(health.read_text())['pubmedFetch']['errorCategory'], 'pubmed_time_budget_exceeded')

    def test_time_budget_without_snapshot_still_fails_the_step(self):
        import tempfile
        from pathlib import Path
        stamp = datetime.datetime(2026, 11, 5, 2, tzinfo=datetime.timezone.utc)
        mono, waits, wait = self.record_wait()
        errors = [
            self._http_error(400, 'Bad Request', b'Error: External viewer error: Empty Response. Bytes read: 0 Status: Timeout')
            for _ in range(4)
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            health = self._health(tmp)
            with patch.object(fetch_pubmed, 'load_esearch', return_value={'count': '1', 'idlist': ['12345678']}), \
                    patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=errors), \
                    patch.object(fetch_pubmed.time, 'sleep') as sleep:
                with self.assertRaises(fetch_pubmed.PubmedBudgetExceeded) as caught:
                    fetch_pubmed.run(path, 30, 1500, now=stamp, wait=wait, health_path=health,
                                     clock=mono, rng=ZERO_JITTER, time_budget=4)
            self.assertEqual(caught.exception.code, 'pubmed_time_budget_exceeded')
            self.assertFalse(path.exists())
            self.assertNotIn('pubmedFetch', json.loads(health.read_text()))
            self.assertEqual(waits, [0.4, 0.4])
            sleep.assert_not_called()

    def test_429_retry_after_beyond_budget_degrades_without_waiting(self):
        import tempfile
        from pathlib import Path
        previous = json.dumps({'updatedAt': '2026-11-05T01:00:00+00:00', 'items': [{'id': 'pmid-previous'}]})
        stamp = datetime.datetime(2026, 11, 5, 2, tzinfo=datetime.timezone.utc)
        mono, waits, wait = self.record_wait()
        failure = self._http_error(429, 'Too Many Requests', b'', headers={'Retry-After': '30'})
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pubmed.json'
            path.write_text(previous)
            health = self._health(tmp)
            with patch.object(fetch_pubmed, 'load_esearch', return_value={'count': '1', 'idlist': ['12345678']}), \
                    patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=failure) as opener, \
                    patch.object(fetch_pubmed.time, 'sleep') as sleep:
                result = fetch_pubmed.run(path, 30, 1500, now=stamp, wait=wait, health_path=health,
                                          clock=mono, rng=ZERO_JITTER, time_budget=10)
            self.assertTrue(result['degraded'])
            self.assertEqual(result['pubmedFetch']['errorCategory'], 'pubmed_time_budget_exceeded')
            self.assertEqual(waits, [0.4, 0.4])
            opener.assert_called_once()
            sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
