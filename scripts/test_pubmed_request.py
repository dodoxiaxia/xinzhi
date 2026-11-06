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


class PubmedRequestTests(unittest.TestCase):
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

        def backoff(seconds):
            first.__exit__.assert_called_once()

        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=reopen) as opener, \
                patch.object(fetch_pubmed.time, 'sleep', side_effect=backoff) as sleep:
            result = fetch_pubmed.request('efetch.fcgi', {'db': 'pubmed', 'id': '123', 'retmode': 'xml'})
        self.assertEqual(result, b'<PubmedArticleSet/>')
        self.assertEqual(opener.call_count, 2)
        self.assertIs(opener.call_args_list[0].args[0], opener.call_args_list[1].args[0])
        sleep.assert_called_once_with(0.5)
        for response in (first, second):
            response.__enter__.return_value.read.assert_called_once_with(10_000_000)
            response.__exit__.assert_called_once()

    def test_incomplete_read_retries_are_bounded_and_last_error_propagates(self):
        responses = [MagicMock() for _ in range(3)]
        errors = [http.client.IncompleteRead(('partial %d' % i).encode()) for i in range(3)]
        for response, error in zip(responses, errors):
            response.__enter__.return_value.read.side_effect = error
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=responses) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            with self.assertRaises(http.client.IncompleteRead) as caught:
                fetch_pubmed.request('esearch.fcgi', {'term': 'public query ' * 500})
        self.assertIs(caught.exception, errors[-1])
        self.assertEqual(opener.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(0.5), call(1.0)])
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
                fetch_pubmed.request('esearch.fcgi', {'db': 'pubmed', 'term': 'public', 'retmode': 'json'})
        self.assertEqual(opener.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(0.5), call(1.0)])
        self.assertEqual(opener.call_args.kwargs, {'timeout': 30})

    def test_server_error_retries_then_returns_the_completed_body(self):
        failure = urllib.error.HTTPError('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', 500, 'Internal Server Error', {}, io.BytesIO(b''))
        success = MagicMock()
        success.__enter__.return_value.read.return_value = b'{"esearchresult":{"count":"0","idlist":[]}}'
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=[failure, success]) as opener, \
                patch.object(fetch_pubmed.time, 'sleep') as sleep:
            body = fetch_pubmed.request('esearch.fcgi', {'db': 'pubmed', 'term': 'public', 'retmode': 'json'})
        self.assertEqual(body, b'{"esearchresult":{"count":"0","idlist":[]}}')
        self.assertEqual(opener.call_count, 2)
        sleep.assert_called_once_with(0.5)

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
                    with patch.object(fetch_pubmed, 'request', return_value=raw) as opener, \
                            patch.object(fetch_pubmed.time, 'sleep') as sleep:
                        with self.assertRaises(fetch_pubmed.PubmedError) as caught:
                            fetch_pubmed.refresh(path, 30, 1500, now=clock)
                    self.assertEqual(caught.exception.code, code)
                    self.assertEqual(path.read_text(), previous)
                    self.assertFalse(path.with_name('.pubmed.json.tmp').exists())
                    self.assertEqual(opener.call_count, 3)
                    self.assertEqual(sleep.call_args_list, [call(0.5), call(1.0)])

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
            def fake(action, params, attempts=3):
                if action == 'esearch.fcgi':
                    return jsonlib.dumps({'esearchresult': {'count': '1', 'idlist': ['12345678']}}).encode()
                return b'<ERROR>Unable to obtain query</ERROR>'
            with patch.object(fetch_pubmed, 'request', side_effect=fake), patch.object(fetch_pubmed.time, 'sleep'):
                with self.assertRaises(fetch_pubmed.PubmedError) as caught:
                    fetch_pubmed.refresh(path, 30, 1500, now=clock)
            self.assertEqual(caught.exception.code, 'pubmed_efetch_error')
            self.assertEqual(path.read_text(), previous)


if __name__ == '__main__':
    unittest.main()
