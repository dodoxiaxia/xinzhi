import contextlib
import io
import json
import unittest
from unittest.mock import patch

import backfill_library_metadata as backfill


DOI = '10.1000/synthetic'
PAPER = dict(doi=DOI, title='Synthetic Study – Results', journal='', date='', datePrecision='', dateBasis='')


class BackfillLibraryMetadataTests(unittest.TestCase):
    def test_paginated_catalog_deduplicates_and_walks_past_an_empty_page(self):
        replies = iter([dict(ok=True, papers=[PAPER], cursor='a+/='),
                        dict(ok=True, papers=[], cursor='b'),
                        dict(ok=True, papers=[PAPER, dict(PAPER, doi='10.1000/other')])])
        urls = []

        def fetch(url):
            urls.append(url)
            return next(replies)

        self.assertEqual([paper['doi'] for paper in backfill.catalog([], fetch)], [DOI, '10.1000/other'])
        self.assertEqual(urls, [backfill.SITE + '/api/library' + suffix for suffix in ('', '?cursor=a%2B%2F%3D', '?cursor=b')])

    def test_preview_preserves_existing_values_and_publication_precision(self):
        message = {'DOI': DOI.upper(), 'title': ['Synthetic Study: Results'], 'container-title': ['Synthetic Journal'],
                   'published-online': {'date-parts': [[2026, 2, 30]]}, 'published-print': {'date-parts': [[2026, 3]]}}
        result = backfill.preview(dict(PAPER, journal='Existing Journal'), lambda _: {'message': message})
        self.assertEqual(result['result'], 'would_update')
        self.assertEqual(result['after'], dict(journal='Existing Journal', date='2026-03', datePrecision='month',
                                               dateBasis='Crossref published-print'))
        result = backfill.preview(dict(PAPER, title='Conflicting title'), lambda _: {'message': message})
        self.assertEqual(result['result'], 'identity_mismatch')

    def test_cli_defaults_to_preview_and_requires_explicit_apply(self):
        with patch.object(backfill, 'catalog', return_value=[PAPER]), patch.object(backfill, 'preview') as preview, \
             patch.object(backfill, 'request_json') as request, patch.object(backfill.time, 'sleep'), \
             patch.dict(backfill.os.environ, {'XINZHI_METADATA_BACKFILL_TOKEN': 'synthetic-token'}), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            preview.return_value = {'result': 'would_update'}
            self.assertEqual(backfill.main([]), 0)
            self.assertEqual(json.loads(output.getvalue())['counts']['would_update'], 1)
            request.assert_not_called()
            output.seek(0)
            output.truncate()
            request.return_value = {'result': 'updated'}
            self.assertEqual(backfill.main(['--apply']), 0)
            request.assert_called_once_with(backfill.SITE + '/api/machine/metadata-backfill',
                                            body={'doi': DOI, 'apply': True}, token='synthetic-token')
            self.assertEqual(json.loads(output.getvalue())['counts']['updated'], 1)
