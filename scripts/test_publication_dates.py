"""Regression coverage for the publisher-confirmed JAMA publication date."""
import contextlib
import datetime
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import auto_picks
import build_public as builder
import merge_candidates
from package_release import public_payloads
from publication_dates import canonical_publication_date
from test_release_build import synthetic_root

DOI = '10.1001/jamanetworkopen.2026.37533'


def paper(**changes):
    return dict({'id': 'pmid-42832198', 'pmid': '42832198', 'doi': DOI,
                 'title': 'Anticoagulation Outcomes in Nursing Home Residents',
                 'journal': 'JAMA Network Open', 'url': 'https://doi.org/' + DOI,
                 'date': '2026-10-01', 'dateBasis': 'ArticleDate',
                 'fetchedAt': '2026-10-07T09:05:48Z', 'ingestedAt': None,
                 'category': '心血管', 'clinicalTier': '心血管综合与其他',
                 'summary': 'Public abstract. ' * 10}, **changes)


class PublicationDateTests(unittest.TestCase):
    def test_exact_identity_copy_provenance_and_idempotence(self):
        raw = paper()
        result = canonical_publication_date(raw)
        self.assertEqual(raw['date'], '2026-10-01')
        self.assertIsNot(raw, result)
        self.assertEqual(result['date'], '2026-10-05')
        self.assertEqual(result['datePrecision'], 'day')
        self.assertEqual(result['sourceDate'], raw['date'])
        self.assertEqual(result['sourceDateBasis'], raw['dateBasis'])
        self.assertIn('官网', result['dateBasis'])
        for field in ('fetchedAt', 'ingestedAt', 'id', 'pmid', 'title'):
            self.assertEqual(result[field], raw[field])
        self.assertEqual(canonical_publication_date(result), result)
        for doi in ('10.1001/jamanetworkopen.2026.375330', '', None):
            other = paper(doi=doi)
            self.assertEqual(canonical_publication_date(other), other)

    def test_merge_corrects_before_window_sort_and_daily_pick(self):
        class Clock(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 17, 12, tzinfo=tz)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'data').mkdir()
            target = paper()
            other = paper(id='other', pmid='42', doi='10.1000/other',
                          title='Other article', url='https://doi.org/10.1000/other', date='2026-10-03')
            for name, data in {
                'feeds.json': {'items': []}, 'source-health.json': {'sources': []},
                'pubmed.json': {'items': [other, target], 'fetched': 2, 'totalHits': 2,
                                'truncated': False, 'journals': []},
            }.items():
                (root / 'data' / name).write_text(json.dumps(data))
            with patch.object(merge_candidates, 'ROOT', root), patch.object(merge_candidates.datetime, 'datetime', Clock), patch('subprocess.run') as run, contextlib.redirect_stdout(io.StringIO()):
                merge_candidates.main()
            run.assert_called_once()  # no pipeline or network subprocess executed
            items = json.loads((root / 'data/candidates.json').read_text())['items']
            self.assertEqual([p['id'] for p in items], [target['id'], other['id']])
            self.assertEqual(items[0]['date'], '2026-10-05')
            # On Oct 9 the old Oct 1 date misses the 7-day window, the correction fits.
            class PickClock(datetime.datetime):
                @classmethod
                def now(cls, tz=None):
                    return cls(2026, 10, 9, 12, tzinfo=tz)
            with patch.object(auto_picks, 'ROOT', root), patch.object(auto_picks.datetime, 'datetime', PickClock), contextlib.redirect_stdout(io.StringIO()):
                auto_picks.main()
            picks = json.loads((root / 'data/picks.json').read_text())
            self.assertIn(target['id'], picks['daily']['2026-10-05'])
            self.assertNotIn('2026-10-01', picks['daily'])

    def test_old_state_build_corrects_public_candidates_keeps_library_and_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); synthetic_root(root)
            raw = {'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'items': [paper(date='2026-10-04', doi='10.1000/other', id='other'), paper()]}
            candidates = root / 'data/candidates.json'; candidates.write_text(json.dumps(raw))
            original_candidates = candidates.read_bytes()
            original_library = (root / 'data/library.json').read_bytes()
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            bundle = (root / 'public/public.js').read_text()
            feeds, _ = json.JSONDecoder().raw_decode(bundle.split('window.FEEDS=', 1)[1])
            self.assertEqual([p['date'] for p in feeds['items']], ['2026-10-05', '2026-10-04'])
            self.assertNotIn('sourceDate', bundle)
            self.assertNotIn('sourceDateBasis', bundle)
            self.assertEqual(candidates.read_bytes(), original_candidates)
            self.assertEqual((root / 'data/library.json').read_bytes(), original_library)
            public_payloads(root)
            module = root / 'scripts/publication_dates.py'
            module.write_text(module.read_text() + '\n# changed correction\n')
            with self.assertRaisesRegex(ValueError, 'provenance'):
                public_payloads(root)

    def test_old_archive_build_corrects_date_without_touching_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'data').mkdir()
            path = root / 'data/radar-archive.json'
            ordinary = paper(pmid='42', doi='10.1000/other', title='Other article', datePrecision='day')
            path.write_text(json.dumps({'rows': [paper(datePrecision='day'), ordinary]}))
            (root / 'data/archive-full.json').write_text('{}')
            before = path.read_bytes()
            with patch.object(builder, 'ROOT', root):
                result = builder.make_radar([])
            self.assertEqual(result['rows'][0][2], '2026-10-05')
            self.assertEqual(result['dateBases'], {'42832198': '期刊官网 published-online（已复核）'})
            self.assertEqual(result['rows'][1][2], '2026-10-01')
            self.assertEqual(path.read_bytes(), before)
            # Old compact consumers need no new field when every row is unchanged.
            path.write_text(json.dumps({'rows': [ordinary]}))
            with patch.object(builder, 'ROOT', root):
                self.assertNotIn('dateBases', builder.make_radar([]))


if __name__ == '__main__':
    unittest.main()
