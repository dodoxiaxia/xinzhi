"""Target-by-target public projection regressions, with frozen public fixtures."""
import contextlib
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_public as builder
import public_library_quality as quality
from package_release import public_payloads
from test_release_build import synthetic_root

ROOT = Path(__file__).resolve().parents[1]


def snapshot():
    return json.loads((ROOT / 'editorial/public_library_snapshot.json').read_text())['papers']


class QualityTests(unittest.TestCase):
    def test_each_navigation_id_is_quarantined_with_public_audit_not_bulk_missing_doi_filter(self):
        raw = snapshot()
        before = copy.deepcopy(raw)
        projected, audit = quality.project_public_library(raw)
        ids = {p['id'] for p in projected}
        for identifier in quality.NAVIGATION:
            with self.subTest(id=identifier):
                self.assertNotIn(identifier, ids)
                entry = next(q for q in audit['quarantined'] if q['record']['id'] == identifier)
                self.assertEqual(entry['reason'], 'publisher_navigation_not_article')
                self.assertEqual(entry['status'], 'quarantined')
                self.assertTrue(set(entry['record']) <= quality.AUDIT_FIELDS)
        no_identity_before = {p['id'] for p in raw if not p['doi'] and not p['url']}
        no_identity_after = {p['id'] for p in projected if not p['doi'] and not p['url']}
        self.assertEqual(len(no_identity_before), 245)
        self.assertEqual(no_identity_after, no_identity_before - quality.NAVIGATION.keys())
        self.assertEqual(len(no_identity_after), 242)
        self.assertEqual(raw, before)

    def test_agentic_official_metadata_deduplicates_only_enumerated_ids_and_holds_pdf_binding(self):
        projected, audit = quality.project_public_library(snapshot())
        papers = {p['id']: p for p in projected}
        self.assertIn(quality.AGENTIC_IDS[0], papers)
        self.assertNotIn(quality.AGENTIC_IDS[1], papers)
        p = papers[quality.AGENTIC_IDS[0]]
        self.assertEqual((p['title'], p['doi'], p['pmid'], p['journal']),
                         (quality.AGENTIC_TITLE, quality.AGENTIC_DOI, '41966941', 'Lancet Digital Health'))
        self.assertEqual((p['date'], p['onlineDate'], p['issueDate']), ('2026-04-10', '2026-04-10', '2026-03'))
        self.assertEqual((p['volume'], p['issue']), ('8', '3'))
        self.assertEqual(audit['aliases'][0]['canonicalId'], quality.AGENTIC_IDS[0])
        self.assertEqual(audit['pdfBindingHoldIds'], [quality.AGENTIC_IDS[0]])
        self.assertFalse(p['localAvailable'])
        self.assertEqual(p['fulltextStatus'], 'not_verified')
        self.assertIsNone(p['ingestedAt'])

    def test_each_surgery_record_separates_verified_online_date_from_indexed_issue_month(self):
        projected, _ = quality.project_public_library(snapshot())
        by_id = {p['id']: p for p in projected}
        for identifier, pmid in [('a76a3fd5e0e70fd7', '42765414'), ('47e6d48cc22b6000', '42765408')]:
            with self.subTest(id=identifier):
                p = by_id[identifier]
                self.assertEqual((p['date'], p['onlineDate'], p['pmid']), ('2026-09-21', '2026-09-21', pmid))
                self.assertEqual((p['issueDate'], p['volume'], p['issue']), ('2026-11', '64', '11'))
                self.assertEqual(p['publicationStatus'], 'online_ahead_of_print')
                self.assertEqual(p['datePrecision'], 'day')
                self.assertEqual(p['issueDatePrecision'], 'month')
                self.assertIn('月份未独立复核', p['issueDateBasis'])
                self.assertLess(p['date'], '2026-10-07')

    def test_npj_published_date_is_exact_id_and_doi_not_batch_first_day(self):
        raw = snapshot()
        other = dict(next(p for p in raw if p['id'] == 'a762c60c31fbd3e2'),
                     id='another-sep1-paper', doi='10.1038/s41746-026-other')
        raw.append(other)
        projected, _ = quality.project_public_library(raw)
        by_id = {p['id']: p for p in projected}
        self.assertEqual(by_id['a762c60c31fbd3e2']['date'], '2026-09-26')
        self.assertEqual(by_id['another-sep1-paper']['date'], '2026-09-01')
        targeted = set(quality.NAVIGATION) | set(quality.AGENTIC_IDS) | set(quality.ONLINE_CORRECTIONS)
        for p in raw:
            if p['id'] not in targeted:
                self.assertEqual(by_id[p['id']], p)

    def test_counts_order_idempotence_and_no_input_writes(self):
        raw = snapshot()
        first, audit = quality.project_public_library(raw)
        reversed_result, _ = quality.project_public_library(list(reversed(raw)))
        second, _ = quality.project_public_library(first)
        self.assertEqual(first, reversed_result)
        self.assertEqual(first, second)
        self.assertEqual((audit['inputCount'], audit['outputCount']), (1268, 1264))
        self.assertEqual((len(audit['quarantined']), len(audit['aliases']), len(audit['corrections'])), (3, 1, 4))
        self.assertEqual(audit['privatePdfBodiesRead'], 0)

    def test_changed_target_identity_holds_instead_of_deleting_or_rebinding(self):
        for identifier, change in [('c7991c9cd94838c4', {'doi': '10.1234/real'}),
                                   ('79904b5d153128dc', {'title': 'A different article'}),
                                   ('a76a3fd5e0e70fd7', {'doi': '10.1234/different'}),
                                   ('a762c60c31fbd3e2', {'doi': '10.1234/different'})]:
            raw = snapshot()
            next(p for p in raw if p['id'] == identifier).update(change)
            with self.subTest(id=identifier), self.assertRaisesRegex(ValueError, 'public_library_quality_hold:'):
                quality.project_public_library(raw)

    def test_missing_targets_do_not_modify_or_drop_unrelated_records(self):
        paper = {'id': 'legitimate-no-identifiers', 'title': 'A clinical article', 'journal': 'Heart',
                 'date': '', 'doi': '', 'url': '', 'pmid': ''}
        result, audit = quality.project_public_library([paper])
        self.assertEqual(result, [paper])
        self.assertEqual(audit['quarantined'], [])
        self.assertEqual(audit['aliases'], [])

    def test_projection_and_audit_never_export_private_unknown_fields(self):
        raw = snapshot()
        for p in raw:
            p.update(currentPath='/Users/private/paper.pdf', privateNotes='fixture-private-note',
                     SHA256='fixture-private-hash', api_key='fixture-private-credential')
        projected, audit = quality.project_public_library(raw)
        encoded = json.dumps(projected) + json.dumps(audit)
        for forbidden in ('/Users/', 'fixture-private-note', 'fixture-private-hash', 'fixture-private-credential',
                          'currentPath', 'privateNotes', 'SHA256', 'api_key'):
            self.assertNotIn(forbidden, encoded)

    def test_corrected_identity_does_not_inherit_old_doi_content(self):
        raw = snapshot()
        p = next(p for p in raw if p['id'] == quality.AGENTIC_IDS[0])
        p.update(titleZh='Old DOI title', summary='Old DOI abstract', abstractSource='PubMed',
                 abstractSourceUrl='https://pubmed.ncbi.nlm.nih.gov/1/',
                 draftData={'summary': 'Old DOI interpretation'}, hasDraft=True)
        projected, _ = quality.project_public_library(raw)
        target = next(p for p in projected if p['id'] == quality.AGENTIC_IDS[0])
        for field in ('titleZh', 'summary', 'abstractSource', 'abstractSourceUrl', 'draftData'):
            self.assertNotIn(field, target)
        self.assertFalse(target['hasDraft'])

    def test_build_projects_only_public_library_keeps_snapshot_state_and_audit_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            synthetic_root(root)
            (root / 'scripts/public_library_quality.py').write_bytes((ROOT / 'scripts/public_library_quality.py').read_bytes())
            # A second synthetic case uses the existing production-approved public
            # fixture. The frozen manifest stays unchanged throughout the build.
            for name in ('editorial/public_library_snapshot.json', 'editorial/public_library_snapshot_manifest.json'):
                (root / name).write_bytes((ROOT / name).read_bytes())
            (root / 'data/library.json').write_bytes((ROOT / 'editorial/public_library_snapshot.json').read_bytes())
            paths = [root / n for n in ('editorial/public_library_snapshot.json',
                                       'editorial/public_library_snapshot_manifest.json', 'data/library.json')]
            before = {p: p.read_bytes() for p in paths}
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', root / 'public'), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            bundle = (root / 'public/public.js').read_text()
            library, _ = json.JSONDecoder().raw_decode(bundle.split('window.LIBRARY=', 1)[1])
            self.assertEqual(len(library['papers']), 1264)
            self.assertEqual(json.loads((root / 'docs/public-manifest.json').read_text())['counts']['library'], 1264)
            audit = json.loads((root / 'docs/public-library-quality-audit.json').read_text())
            self.assertEqual(len(audit['quarantined']), 3)
            self.assertNotIn('quarantined', bundle)
            worker = (root / 'public/_worker.js').read_text()
            for identifier in (*quality.NAVIGATION, *quality.AGENTIC_IDS):
                self.assertNotIn(identifier, worker)
            for p in paths:
                self.assertEqual(p.read_bytes(), before[p])
            public_payloads(root)
            policy = root / 'scripts/public_library_quality.py'
            policy.write_text(policy.read_text() + '\n# changed projection\n')
            with self.assertRaisesRegex(ValueError, 'provenance'):
                public_payloads(root)


if __name__ == '__main__':
    unittest.main()
