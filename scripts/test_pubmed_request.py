"""Offline regression for long E-utilities queries and failure propagation."""
import datetime
import unittest
import urllib.error
import urllib.parse
from unittest.mock import MagicMock, patch

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

    def test_http_failure_does_not_report_success_or_partial_coverage(self):
        error = urllib.error.HTTPError('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', 414, 'Request-URI Too Long', {}, None)
        with patch.object(fetch_pubmed.urllib.request, 'urlopen', side_effect=error), self.assertRaises(urllib.error.HTTPError):
            fetch_pubmed.request('esearch.fcgi', {'term':'public query ' * 500})


if __name__ == '__main__':
    unittest.main()
