"""Target-by-target public projection regressions, with frozen public fixtures."""
from public_bundle import bundle_text
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
        self.assertEqual(len(no_identity_before), 220)  # 245 before 25 DOI-less records received verified DOIs
        self.assertEqual(len(no_identity_after), 194)
        self.assertEqual(no_identity_after,
                         (no_identity_before - quality.NAVIGATION.keys() - quality.DUPLICATES.keys()
                          - quality.TOPIC_HIDES.keys()) | {'a97bbb0a11844693', '814b860e19382e2f'})
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
        self.assertEqual(set(audit['pdfBindingHoldIds']), {quality.AGENTIC_IDS[0], *quality.DOI_REVIEW, *(set(quality.PDF_BINDING_HOLDS) & set(papers))})
        self.assertFalse(p['localAvailable'])
        self.assertEqual(p['fulltextStatus'], 'not_verified')
        self.assertIsNone(p['ingestedAt'])

    def test_record_whose_doi_names_another_article_keeps_listing_without_pdf_binding(self):
        raw = [{'id': 'held-record', 'title': 'x', 'doi': '10.1016/j.landig.2026.100979'}]
        with patch.object(quality, 'PDF_BINDING_HOLDS', {'held-record': 'reviewed'}):
            projected, audit = quality.project_public_library(raw)
        self.assertEqual([p['id'] for p in projected], ['held-record'])
        self.assertEqual(projected[0]['doi'], '10.1016/j.landig.2026.100979')
        self.assertIn('held-record', audit['pdfBindingHoldIds'])

    def test_duplicates_are_listed_once_and_snapshot_records_are_kept(self):
        self.assertEqual(quality.DUPLICATES, {
            '3bcf52b03b3bfd64': ('ffeb47ca0a734600', '10.1001/jama.2026.0946', quality.DUPLICATES['3bcf52b03b3bfd64'][2]),
            '4fe78ed54cf5523d': ('77f5287fc55d4220', '10.1016/j.landig.2025.100916', quality.DUPLICATES['4fe78ed54cf5523d'][2]),
            '891a0ca9ca481407': ('ba5cc383031aa08f', '10.1016/j.landig.2025.100922', quality.DUPLICATES['891a0ca9ca481407'][2]),
            '37cb5c6f96b8b0f5': ('3b51e13dda54492e', '10.1016/j.landig.2025.100960', quality.DUPLICATES['37cb5c6f96b8b0f5'][2]),
            'f8345cffb3130085': ('f3ab7fe35456aeca', '10.1001/jama.2026.1327', quality.DUPLICATES['f8345cffb3130085'][2]),
            'aac74a7aaeeff6ef': ('f3ab7fe35456aeca', '10.1001/jama.2026.1327', quality.DUPLICATES['aac74a7aaeeff6ef'][2]),
        })
        raw = snapshot()
        before = copy.deepcopy(raw)
        projected, audit = quality.project_public_library(raw)
        shown = {p['id'] for p in projected}
        in_snapshot = {p['id']: p for p in snapshot()}
        aliases = {a['record']['id']: a for a in audit['aliases']}
        for duplicate, (canonical, doi, title) in quality.DUPLICATES.items():
            with self.subTest(duplicate=duplicate):
                self.assertIn(canonical, shown)                  # original stays listed
                self.assertNotIn(duplicate, shown)               # duplicate is not shown
                self.assertIn(duplicate, in_snapshot)            # snapshot record is not deleted
                self.assertEqual(in_snapshot[duplicate]['title'], title)
                self.assertEqual(aliases[duplicate]['canonicalId'], canonical)
                self.assertEqual(aliases[duplicate]['status'], 'public_bibliographic_duplicate')
                self.assertEqual(next(p for p in projected if p['id'] == canonical)['doi'], doi)
        self.assertEqual(raw, before)
        # The 37cb5c6f record's own DOI belongs to another article and is never rewritten.
        self.assertEqual(in_snapshot['37cb5c6f96b8b0f5']['doi'], '10.1016/j.landig.2026.100979')

    def test_changed_duplicate_or_original_identity_holds_the_build(self):
        for identifier, change in [('3bcf52b03b3bfd64', {'title': 'A different title'}),
                                   ('ffeb47ca0a734600', {'doi': '10.1001/jama.2026.9999'}),
                                   ('77f5287fc55d4220', {'doi': ''}),
                                   ('3b51e13dda54492e', {'doi': '10.1016/j.landig.2025.100961'})]:
            raw = snapshot()
            next(p for p in raw if p['id'] == identifier).update(change)
            with self.subTest(id=identifier), self.assertRaisesRegex(ValueError, 'duplicate_identity_changed'):
                quality.project_public_library(raw)
        raw = [p for p in snapshot() if p['id'] != '891a0ca9ca481407']
        projected, _ = quality.project_public_library(raw)   # absent duplicate: nothing to do
        self.assertIn('ba5cc383031aa08f', {p['id'] for p in projected})
        raw = [p for p in snapshot() if p['id'] != 'ba5cc383031aa08f']
        with self.assertRaisesRegex(ValueError, 'duplicate_identity_changed'):  # original gone, duplicate present
            quality.project_public_library(raw)

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
        targeted = (set(quality.NAVIGATION) | set(quality.AGENTIC_IDS) |
                    set(quality.ONLINE_CORRECTIONS) | set(quality.DOI_REVIEW) |
                    set(quality.DUPLICATES) | set(quality.TOPIC_HIDES))
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
        self.assertEqual((audit['inputCount'], audit['outputCount']), (1268, 1167))
        self.assertEqual((len(audit['quarantined']), len(audit['aliases']), len(audit['corrections'])), (3, 7, 4))
        self.assertEqual(len(audit['topicHides']), 91)
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
        self.assertEqual(audit['topicHides'], [])

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
            bundle = bundle_text(root / "public")
            library, _ = json.JSONDecoder().raw_decode(bundle.split('window.LIBRARY=', 1)[1])
            self.assertEqual(len(library['papers']), 1167)
            self.assertEqual(json.loads((root / 'docs/public-manifest.json').read_text())['counts']['library'], 1167)
            audit = json.loads((root / 'docs/public-library-quality-audit.json').read_text())
            self.assertEqual(len(audit['quarantined']), 3)
            self.assertEqual(len(audit['topicHides']), 91)
            self.assertNotIn('quarantined', bundle)
            worker = (root / 'public/_worker.js').read_text()
            for identifier in (*quality.NAVIGATION, *quality.AGENTIC_IDS, *quality.DUPLICATES, *quality.TOPIC_HIDES):
                self.assertNotIn(identifier, worker)
            for p in paths:
                self.assertEqual(p.read_bytes(), before[p])
            public_payloads(root)
            policy = root / 'scripts/public_library_quality.py'
            policy.write_text(policy.read_text() + '\n# changed projection\n')
            with self.assertRaisesRegex(ValueError, 'provenance'):
                public_payloads(root)

    def test_topic_hides_omit_only_pinned_ids_and_keep_snapshot_unchanged(self):
        self.assertEqual(len(quality.TOPIC_HIDES), 91)
        raw = snapshot()
        before = copy.deepcopy(raw)
        projected, audit = quality.project_public_library(raw)
        shown = {p['id'] for p in projected}
        in_snapshot = {p['id']: p for p in snapshot()}
        entries = {entry['record']['id']: entry for entry in audit['topicHides']}
        self.assertEqual(len(entries), 91)
        for identifier, (pinned_doi, pinned_title, category) in quality.TOPIC_HIDES.items():
            with self.subTest(id=identifier):
                self.assertNotIn(identifier, shown)
                self.assertIn(identifier, in_snapshot)
                self.assertEqual(in_snapshot[identifier]['title'], pinned_title)
                self.assertEqual(quality.normalize_doi(in_snapshot[identifier].get('doi') or ''), pinned_doi)
                self.assertEqual(entries[identifier]['status'], 'public_topic_hidden')
                self.assertEqual(entries[identifier]['category'], category)
                self.assertTrue(set(entries[identifier]['record']) <= quality.AUDIT_FIELDS)
        self.assertEqual(raw, before)

    def test_general_ai_and_tech_papers_remain_public(self):
        projected, _ = quality.project_public_library(snapshot())
        shown = {p['id'] for p in projected}
        for identifier in ('8df1104bbf8da115', 'd5e6765952d1e264', 'ed458e90359ee85b',
                           '073274ec0b04bbb1', 'cc0db6a315499f7d'):
            self.assertIn(identifier, shown)

    def test_changed_topic_hide_identity_holds_and_absent_id_is_skipped(self):
        for identifier, change in [('02812acb29e11998', {'title': 'A different title'}),
                                   ('02812acb29e11998', {'doi': '10.1056/nejmp9999999'}),
                                   ('02812acb29e11998', {'doi': ''}),
                                   ('0568c9b011c1a4a9', {'doi': '10.1234/filled'})]:
            raw = snapshot()
            next(p for p in raw if p['id'] == identifier).update(change)
            with self.subTest(id=identifier, change=change), self.assertRaisesRegex(ValueError, 'topic_hide_identity_changed'):
                quality.project_public_library(raw)
        raw = [p for p in snapshot() if p['id'] != '0fe528d72fd56af2']
        projected, audit = quality.project_public_library(raw)
        self.assertEqual(len(projected), 1167)
        self.assertEqual(len(audit['topicHides']), 90)
        self.assertNotIn('0fe528d72fd56af2', {entry['record']['id'] for entry in audit['topicHides']})

    def test_malformed_topic_hides_config_raises_clear_error(self):
        base = json.loads(quality.TOPIC_HIDES_PATH.read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for label, mutator in [
                ('wrong_count', lambda d: d['records'].pop()),
                ('duplicate_id', lambda d: d['records'].__setitem__(1, dict(d['records'][0]))),
                ('non_string_doi', lambda d: d['records'][0].__setitem__('doi', None)),
                ('empty_category', lambda d: d['records'][0].__setitem__('category', '')),
            ]:
                data = copy.deepcopy(base)
                mutator(data)
                path = root / f'{label}.json'
                path.write_text(json.dumps(data), encoding='utf-8')
                with self.subTest(case=label), self.assertRaises(ValueError):
                    quality._load_topic_hides(path)


if __name__ == '__main__':
    unittest.main()
