import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_public as builder  # noqa: E402
from scope_uncertain_export import build_scope_uncertain_list, load_topic_hide_filters  # noqa: E402
from test_release_build import synthetic_root  # noqa: E402


class ScopeUncertainExportTests(unittest.TestCase):
    def test_filters_deduplicates_and_sorts_uncertain_papers(self):
        papers = [
            # Library uncertain item with valid ingestedAt (older)
            {
                'id': 'lib-unc-old',
                'doi': 'https://doi.org/10.1000/UNC-OLD',
                'title': 'Hospital workflow standardization in general practice',
                'journal': 'JAMA',
                'url': 'https://doi.org/10.1000/UNC-OLD',
                'date': '2026-11-01',
                'ingestedAt': '2026-11-10T04:00:00Z',
                'fulltextStatus': 'not_verified',
                'localAvailable': False,
                'summary': 'Must never be exported.',
                'privateNotes': 'Sensitive note',
            },
            # Library uncertain item whose DOI duplicates a candidate item below, but has fulltext available -> shadows candidate!
            {
                'id': 'lib-avail-dup',
                'doi': '10.1000/shadow-avail',
                'title': 'Clinical perspectives on modern healthcare delivery',
                'journal': 'JAMA',
                'fulltextStatus': 'available',
                'ingestedAt': '2026-11-12T04:00:00Z',
            },
            # Library uncertain item with localAvailable=True -> skipped
            {
                'id': 'lib-local',
                'doi': '10.1000/local-yes',
                'title': 'Clinical perspectives on outpatient care',
                'journal': 'JAMA',
                'localAvailable': True,
                'ingestedAt': '2026-11-12T04:00:00Z',
            },
            # Library uncertain item in pdf_ids -> skipped
            {
                'id': 'lib-pdf-id',
                'doi': '10.1000/pdf-id',
                'title': 'Clinical perspectives on inpatient care',
                'journal': 'JAMA',
                'ingestedAt': '2026-11-12T04:00:00Z',
            },
            # Library uncertain item missing DOI -> still kept! invalid ingestedAt -> null
            {
                'id': 'lib-no-doi',
                'doi': '',
                'title': 'Beta general clinical consensus report',
                'journal': 'BMJ',
                'url': 'javascript:alert(1)',
                'date': '2026-11-02',
                'ingestedAt': 'not-a-timestamp',
            },
            # Candidate uncertain item with newer ingestedAt (+08:00 timezone)
            {
                'id': 'cand-unc-new',
                'doi': '10.1000/unc-new',
                'title': 'Evaluation of diagnostic pathways in primary care',
                'cleanJournal': 'NEJM',
                'journal': 'New England Journal of Medicine',
                'url': 'https://doi.org/10.1000/unc-new',
                'date': '2026-11-12',
                'ingestedAt': '2026-11-12T20:00:00+08:00',
            },
            # Candidate duplicate by DOI of lib-avail-dup -> must NOT sneak in!
            {
                'id': 'cand-shadowed',
                'doi': 'https://doi.org/10.1000/SHADOW-AVAIL',
                'title': 'Clinical perspectives on modern healthcare delivery',
                'journal': 'JAMA',
                'fulltextStatus': 'not_verified',
                'ingestedAt': '2026-11-13T00:00:00Z',
            },
            # Candidate duplicate by ID of lib-unc-old -> skipped
            {
                'id': 'lib-unc-old',
                'doi': '10.1000/different-doi',
                'title': 'Duplicate ID row',
                'journal': 'JAMA',
                'ingestedAt': '2026-11-13T01:00:00Z',
            },
            # Candidate keep -> skipped
            {
                'id': 'cand-keep',
                'doi': '10.1000/cv-keep',
                'title': 'Catheter ablation for atrial fibrillation',
                'journal': 'Heart',
                'ingestedAt': '2026-11-13T02:00:00Z',
            },
            # Candidate exclude -> skipped
            {
                'id': 'cand-exclude',
                'doi': '10.1000/onc-exclude',
                'title': 'Adjuvant chemotherapy in early breast cancer',
                'journal': 'JAMA Oncology',
                'ingestedAt': '2026-11-13T02:00:00Z',
            },
            # Candidate hidden by ID -> skipped
            {
                'id': 'hidden-id-1',
                'doi': '10.1000/unc-hidden-id',
                'title': 'Hidden uncertain study by ID',
                'journal': 'JAMA',
                'ingestedAt': '2026-11-13T02:00:00Z',
            },
            # Candidate hidden by DOI -> skipped
            {
                'id': 'cand-hidden-doi',
                'doi': 'doi:10.1000/UNC-HIDDEN-DOI',
                'title': 'Hidden uncertain study by DOI',
                'journal': 'JAMA',
                'ingestedAt': '2026-11-13T02:00:00Z',
            },
            # Candidate force-kept by DOI -> skipped (already keep)
            {
                'id': 'cand-force-keep',
                'doi': '10.1000/unc-force-keep',
                'title': 'Force kept uncertain study',
                'journal': 'JAMA',
                'ingestedAt': '2026-11-13T02:00:00Z',
            },
            # Candidate without ingestedAt -> sorted alphabetically by title after timestamped items
            {
                'id': 'cand-no-ts-a',
                'title': 'Alpha general clinical consensus report',
                'journal': 'Lancet',
            },
        ]

        out = build_scope_uncertain_list(
            papers,
            pdf_ids={'lib-pdf-id'},
            hidden_ids={'hidden-id-1'},
            hidden_dois={'https://doi.org/10.1000/unc-hidden-doi'},
            keep_dois={'10.1000/UNC-FORCE-KEEP'},
            generated_at='2026-11-13T08:00:00Z',
        )

        self.assertEqual(out['generatedAt'], '2026-11-13T08:00:00Z')
        self.assertEqual(out['count'], 4)
        self.assertEqual([item['id'] for item in out['items']], [
            'cand-unc-new',
            'lib-unc-old',
            'cand-no-ts-a',
            'lib-no-doi',
        ])

        first = out['items'][0]
        self.assertEqual(first['doi'], '10.1000/unc-new')
        self.assertEqual(first['journal'], 'NEJM')
        self.assertEqual(first['reason'], 'uncertain_scope')
        self.assertTrue(first['detail'])
        self.assertEqual(first['ingestedAt'], '2026-11-12T20:00:00+08:00')

        last = out['items'][3]
        self.assertEqual(last['doi'], '')
        self.assertEqual(last['url'], '')
        self.assertIsNone(last['ingestedAt'])

        for item in out['items']:
            self.assertTrue({'doi', 'title', 'journal', 'reason', 'detail', 'ingestedAt'} <= set(item.keys()))
            self.assertNotIn('summary', item)
            self.assertNotIn('abstract', item)
            self.assertNotIn('privateNotes', item)

    def test_topic_hide_loader_does_not_require_fixed_count_or_existing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            missing = root / 'missing.json'
            self.assertEqual(load_topic_hide_filters(missing), (frozenset(), frozenset()))

            custom = root / 'hides.json'
            custom.write_text(json.dumps({
                'schemaVersion': 1,
                'records': [
                    {'id': 'hide-1', 'doi': 'https://doi.org/10.1000/H1', 'title': 'A', 'category': '其他'},
                    {'id': 'hide-2', 'doi': '', 'title': 'B', 'category': '其他'},
                ],
            }), encoding='utf-8')
            ids, dois = load_topic_hide_filters(custom)
            self.assertEqual(ids, frozenset({'hide-1', 'hide-2'}))
            self.assertEqual(dois, frozenset({'10.1000/h1'}))

    def test_build_public_writes_uncertain_manifest_without_embedding_into_public_js(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            synthetic_root(root)
            hides = json.loads((root / 'config/public_library_topic_hides.json').read_text(encoding='utf-8'))
            hidden_rec = next(r for r in hides['records'] if r.get('doi'))
            (root / 'data/candidates.json').write_text(json.dumps({
                'updatedAt': '2026-11-13T04:00:00Z',
                'items': [
                    {
                        'id': 'cand-uncertain-1',
                        'title': 'Hospital resource utilization in general medicine',
                        'doi': '10.1000/cand-unc-1',
                        'journal': 'JAMA',
                        'url': 'https://doi.org/10.1000/cand-unc-1',
                        'date': '2026-11-12',
                        'ingestedAt': '2026-11-13T01:00:00Z',
                    },
                    {
                        'id': 'cand-hidden-mirror',
                        'title': 'Clinical perspectives on general care',
                        'doi': hidden_rec['doi'],
                        'journal': 'JAMA',
                        'url': 'https://doi.org/' + hidden_rec['doi'],
                        'date': '2026-11-12',
                        'ingestedAt': '2026-11-13T02:00:00Z',
                    },
                    {
                        'id': 'cand-cv-keep',
                        'title': 'Catheter ablation for atrial fibrillation',
                        'doi': '10.1000/cand-cv-keep',
                        'journal': 'Heart',
                        'url': 'https://doi.org/10.1000/cand-cv-keep',
                        'date': '2026-11-12',
                    },
                ],
            }), encoding='utf-8')

            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), contextlib.redirect_stdout(io.StringIO()):
                builder.main()

            out = json.loads((root / 'public/scope-uncertain.json').read_text(encoding='utf-8'))
            self.assertEqual(out['count'], 1)
            self.assertEqual(len(out['items']), 1)
            self.assertEqual(out['items'][0]['doi'], '10.1000/cand-unc-1')
            self.assertEqual(out['items'][0]['reason'], 'uncertain_scope')
            self.assertEqual(out['items'][0]['ingestedAt'], '2026-11-13T01:00:00Z')
            bundle = (root / 'public/public.js').read_text(encoding='utf-8')
            self.assertNotIn('scope-uncertain', bundle)
            self.assertNotIn('"uncertain_scope"', bundle)


if __name__ == '__main__':
    unittest.main()
