"""Finite v2 corrections, identity HOLDs, and offline audit privacy/normalization."""
import contextlib
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import audit_public_bibliography as audit
import build_public as builder
import public_library_quality as quality
from package_release import public_payloads
from test_release_build import synthetic_root

ROOT = Path(__file__).resolve().parents[1]


def originals():
    papers = json.loads((ROOT / 'editorial/public_library_snapshot.json').read_text())['papers']
    return [p for p in papers if p['id'] in quality.DOI_REVIEW]


class DoiReviewTests(unittest.TestCase):
    def test_each_registered_wrong_doi_is_corrected_without_changing_journal_or_unverified_online_date(self):
        raw = originals()
        projected, review, _ = quality.reviewed_doi_projection(raw)
        expected = {'93b958551c8bf865': '10.1001/jama.2026.14789',
                    '4944fe87d59c5e7b': '10.1001/jamainternmed.2025.7627'}
        before = {p['id']: p for p in raw}
        after = {p['id']: p for p in projected}
        for identifier, doi in expected.items():
            with self.subTest(id=identifier):
                p = after[identifier]
                self.assertEqual(p['doi'], doi)
                self.assertEqual(p['title'], quality.DOI_REVIEW[identifier]['title'])
                self.assertEqual(p['journal'], before[identifier]['journal'])
                self.assertEqual((p['date'], p['dateBasis']), (before[identifier]['date'], before[identifier]['dateBasis']))
                self.assertEqual(p['issueDatePrecision'], 'month')
                self.assertIn('原发表日期未复核', p['basis'])
                self.assertNotIn('onlineDate', p)
                self.assertEqual(p['url'], 'https://doi.org/' + doi)
        self.assertEqual(review['counts'], {'verified': 3, 'falsepositive': 0, 'unresolved': 2})

    def test_appended_resource_identifier_is_corrected_from_official_record_not_blind_suffix_stripping(self):
        projected, _, _ = quality.reviewed_doi_projection(originals())
        p = next(p for p in projected if p['id'] == 'b157bb0d131bf3d5')
        self.assertEqual(p['doi'], '10.1093/ehjdh/ztag011')
        self.assertEqual(p['title'], 'The digital divide in cardiovascular care: who gets left behind?')
        self.assertEqual((p['date'], p['onlineDate']), ('2026-01-21', '2026-01-21'))
        unrelated = {'id': 'unreviewed-resource-suffix', 'doi': '10.1234/valid/8431732', 'title': 'Valid article'}
        self.assertEqual(quality.reviewed_doi_projection([unrelated])[0], [unrelated])

    def test_truncated_and_placeholder_dois_hold_link_but_keep_both_articles_and_original_titles(self):
        raw = originals()
        projected, review, _ = quality.reviewed_doi_projection(raw)
        before = {p['id']: p for p in raw}
        after = {p['id']: p for p in projected}
        self.assertEqual(len(projected), len(raw))
        for identifier in ('a97bbb0a11844693', '814b860e19382e2f'):
            with self.subTest(id=identifier):
                p = after[identifier]
                self.assertEqual((p['doi'], p['url']), ('', ''))
                for key in ('id', 'title', 'journal', 'date', 'dateBasis', 'ingestedAt'):
                    self.assertEqual(p[key], before[identifier][key])
                self.assertEqual(p['metadataStatus'], 'hold_bibliography_review')
                self.assertEqual(next(r['status'] for r in review['entries'] if r['before']['id'] == identifier), 'unresolved')

    def test_each_review_holds_private_pdf_binding_and_preserves_original_public_evidence(self):
        raw = originals()
        projected, review, holds = quality.reviewed_doi_projection(raw)
        self.assertEqual(set(holds), set(quality.DOI_REVIEW))
        for p in projected:
            self.assertIsNone(p['ingestedAt'])
            self.assertFalse(p['localAvailable'])
            self.assertEqual(p['fulltextStatus'], 'not_verified')
        for entry in review['entries']:
            original = next(p for p in raw if p['id'] == entry['before']['id'])
            self.assertEqual(entry['before']['title'], original['title'])
            self.assertEqual(entry['before']['doi'], original['doi'])

    def test_changed_title_journal_identifier_or_unreviewed_pmid_holds(self):
        for change in ({'title': 'Another paper'}, {'journal': 'Another journal'},
                       {'doi': '10.1234/another'}, {'pmid': '123456'}):
            rows = originals()
            rows[0].update(change)
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'public_library_quality_hold:'):
                quality.reviewed_doi_projection(rows)

    def test_existing_replacement_doi_does_not_trigger_title_based_merge(self):
        for doi in ('10.1001/jama.2026.14789', '10.1001/JAMA.2026.14789',
                    'https://doi.org/10.1001/jama.2026.14789'):
            rows = originals() + [{'id': 'already-registered', 'doi': doi,
                                  'title': quality.DOI_REVIEW['93b958551c8bf865']['title']}]
            with self.subTest(doi=doi), self.assertRaisesRegex(ValueError, 'reviewed_doi_already_present'):
                quality.reviewed_doi_projection(rows)

    def test_idempotence_input_immutability_and_no_old_doi_enrichment_rebinding(self):
        raw = originals()
        for p in raw:
            p.update(summary='Old DOI abstract', titleZh='Old DOI translated title', hasDraft=True,
                     draftData={'summary': 'Old DOI interpretation'}, authors=['Old DOI author'])
        before = copy.deepcopy(raw)
        result, _, _ = quality.reviewed_doi_projection(raw)
        repeated, _, _ = quality.reviewed_doi_projection(result)
        self.assertEqual(result, repeated)
        self.assertEqual(raw, before)
        for p in result:
            for field in ('summary', 'titleZh', 'draftData', 'authors'):
                self.assertNotIn(field, p)
            self.assertFalse(p['hasDraft'])

    def test_full_public_projection_drops_private_fields_and_preserves_all_original_snapshot_ids(self):
        rows = originals()
        for p in rows:
            p.update(repo_path='/Users/private/source.pdf', api_key='private-credential',
                     privateNotes='private-note', SHA256='private-checksum')
        result, report = quality.project_public_library(rows)
        encoded = json.dumps(result) + json.dumps(report)
        for value in ('/Users/', 'private-credential', 'private-note', 'private-checksum', 'repo_path', 'api_key', 'SHA256'):
            self.assertNotIn(value, encoded)
        self.assertEqual({p['id'] for p in result}, {p['id'] for p in rows})


class OfflineAuditTests(unittest.TestCase):
    def test_nfkc_is_query_only_roman_and_kangxi_titles_are_not_automatically_garbage(self):
        records = [{'id': 'roman', 'title': 'Phase Ⅲ clinical trial', 'doi': '10.1234/a'},
                   {'id': 'kangxi', 'title': '⼈⼯智能与临床研究', 'doi': ''}]
        before = copy.deepcopy(records)
        report = audit.scan({'LIBRARY': records, 'FEEDS': []})
        self.assertEqual(records, before)
        self.assertEqual([r['title'] for r in report['suspects']], [r['title'] for r in records])
        self.assertEqual(report['suspects'][1]['queryTitle'], '人工智能与临床研究')
        self.assertTrue(all(r['status'] == 'unresolved' for r in report['suspects']))

    def test_publisher_prefix_alone_is_not_an_error_rule(self):
        record = {'id': 'publisher-change', 'title': 'Clinical trial', 'journal': 'JAMA', 'doi': '10.1016/legitimate-old-publisher'}
        self.assertEqual(audit.candidate_flags(record), [])
        self.assertEqual(audit.scan({'LIBRARY': [record], 'FEEDS': []})['prefixBasedErrors'], 0)

    def test_audit_denominator_both_public_datasets_and_changed_identity_is_unresolved(self):
        raw = originals()
        raw[0]['title'] = 'Changed title'
        report = audit.scan({'LIBRARY': raw, 'FEEDS': [{'id': 'normal', 'title': 'Clinical trial'}]})
        self.assertEqual(report['denominator'], len(raw) + 1)
        changed = next(r for r in report['suspects'] if r['id'] == raw[0]['id'])
        self.assertEqual(changed['status'], 'unresolved')
        self.assertEqual(changed['reviewAction'], 'hold')
        self.assertEqual(report['remoteRequests'], 0)

    def test_only_library_and_dynamic_are_scanned_not_full_radar_corpus(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'public.js'
            p.write_text('window.LIBRARY={"papers":[]};window.FEEDS={"items":[]};window.RADAR={"rows":["not parsed"]};')
            datasets, _ = audit.read_public_bundle(p)
            self.assertEqual(datasets, {'LIBRARY': [], 'FEEDS': []})
            self.assertEqual(audit.scan(datasets)['denominator'], 0)

    def test_audit_unknown_private_fields_never_escape(self):
        rows = [{'id': 'candidate', 'title': 'AMA Ed Hub > JN Learning > Public lecture',
                 'repo_path': '/Users/private/book.pdf', 'privateNotes': 'private-note', 'api_key': 'private-secret'}]
        result = json.dumps(audit.scan({'LIBRARY': rows, 'FEEDS': []}))
        for value in ('/Users/', 'private-note', 'private-secret', 'repo_path', 'privateNotes', 'api_key'):
            self.assertNotIn(value, result)

    def test_private_title_fails_with_fixed_code_and_no_written_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            p = root / 'public.js'
            p.write_text('window.LIBRARY={"papers":[{"id":"bad","title":"/Users/private/book.pdf"}]};window.FEEDS={"items":[]};')
            with patch.object(audit, 'ROOT', root), contextlib.redirect_stderr(io.StringIO()) as stderr:
                status = audit.main(['--bundle', str(p)])
            self.assertEqual(status, 1)
            self.assertEqual(json.loads(stderr.getvalue()), {'error': 'public_bibliography_audit_hold'})
            self.assertFalse((root / '.local').exists())


class ReviewBuildTests(unittest.TestCase):
    def test_real_approved_snapshot_projection_holds_all_reviewed_pdf_ids_without_source_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); synthetic_root(root)
            for name in ('editorial/public_library_snapshot.json', 'editorial/public_library_snapshot_manifest.json'):
                (root / name).write_bytes((ROOT / name).read_bytes())
            (root / 'data/library.json').write_bytes((ROOT / 'editorial/public_library_snapshot.json').read_bytes())
            library_before = (root / 'data/library.json').read_bytes()
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            bundle = (root / 'public/public.js').read_text()
            library, _ = json.JSONDecoder().raw_decode(bundle.split('window.LIBRARY=', 1)[1])
            self.assertEqual(len(library['papers']), 1264)
            worker = (root / 'public/_worker.js').read_text()
            for identifier in quality.DOI_REVIEW:
                self.assertNotIn(identifier, worker)
            self.assertEqual((root / 'data/library.json').read_bytes(), library_before)
            self.assertNotIn('old_doi_identifies_unrelated', bundle)
            public_payloads(root)


if __name__ == '__main__':
    unittest.main()
