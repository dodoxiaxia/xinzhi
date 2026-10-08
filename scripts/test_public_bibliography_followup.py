"""Public identity, privacy, date evidence and explicit alias regression tests."""
import contextlib
import copy
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import public_bibliography_followup as followup
from build_public import pdf_library_registry
from public_library_quality import DOI_REVIEW, project_public_library

ROOT = Path(__file__).resolve().parents[1]


def policy():
    return json.loads((ROOT / 'editorial/public_bibliography_followup_20261008.json').read_text())


def originals():
    ids = {e['id'] for e in policy()['entries']} | {'ffeb47ca0a734600'}
    rows = json.loads((ROOT / 'editorial/public_library_snapshot.json').read_text())['papers']
    return [p for p in rows if p['id'] in ids]


class FollowupTests(unittest.TestCase):
    def test_ten_new_ids_and_official_evidence_policy(self):
        decisions = followup.validate_policy(policy())['entries']
        self.assertEqual(len(decisions), 10)
        self.assertFalse({e['id'] for e in decisions} & DOI_REVIEW.keys())
        self.assertEqual(sum(e['status'] == 'verified' for e in decisions), 7)
        self.assertEqual(sum(e['status'] == 'false-positive' for e in decisions), 2)
        self.assertEqual(sum(e['status'] == 'unresolved' for e in decisions), 1)
        self.assertTrue(all('pmid' not in e['publicPatch'] and 'ingestedAt' not in e['publicPatch'] for e in decisions))

    def test_reviewed_official_identities_and_original_column_title_retained(self):
        rows, report = followup.project(originals(), policy())
        byid = {p['id']: p for p in rows}
        self.assertEqual(len(rows), 10)  # Eleven input rows include the existing alias target.
        for e in policy()['entries']:
            target = byid[e.get('canonicalId', e['id'])]
            for k, v in e['publicPatch'].items():
                self.assertEqual(target[k], v)
        unresolved = byid['14ac10d88baa1cf1']
        self.assertEqual(unresolved['title'], 'Invited Commentary AI IN SURGERY')
        self.assertEqual((unresolved['doi'], unresolved['url']), ('', ''))
        self.assertEqual(report['counts'], {'verified': 7, 'false-positive': 2, 'unresolved': 1})

    def test_explicit_named_duplicate_only_not_title_based_merges(self):
        extra = {'id': 'same-title-independent', 'title': 'The Lost Aura of the Physician in the Age of Artificial Intelligence',
                 'doi': '10.1234/independent-version', 'journal': 'JAMA', 'pmid': ''}
        rows, report = followup.project(originals() + [extra], policy())
        self.assertNotIn('3bcf52b03b3bfd64', {p['id'] for p in rows})
        self.assertIn('ffeb47ca0a734600', {p['id'] for p in rows})
        self.assertIn(extra, rows)
        self.assertEqual(sum(e['action'] == 'alias' for e in report['entries']), 1)

    def test_changed_original_identity_is_fixed_hold(self):
        for update in ({'title': 'Different title'}, {'doi': '10.1234/another'},
                       {'journal': 'Different journal'}, {'pmid': '123456'}):
            rows = originals()
            rows[0].update(update)
            with self.subTest(update=update), self.assertRaisesRegex(ValueError, 'public_bibliography_followup_hold:'):
                followup.project(rows, policy())

    def test_alias_canonical_change_or_missing_target_holds(self):
        for update in ({'title': 'Different title'}, {'doi': '10.1234/another'}, {'pmid': '123456'}):
            rows = originals()
            next(p for p in rows if p['id'] == 'ffeb47ca0a734600').update(update)
            with self.subTest(update=update), self.assertRaisesRegex(ValueError, 'canonical_identity_changed'):
                followup.project(rows, policy())
        rows = [p for p in originals() if p['id'] != 'ffeb47ca0a734600']
        with self.assertRaisesRegex(ValueError, 'canonical_identity_changed'):
            followup.project(rows, policy())

    def test_idempotence_including_absent_alias_and_input_immutability(self):
        raw = originals()
        before = copy.deepcopy(raw)
        first, report = followup.project(raw, policy())
        second, repeated = followup.project(first, policy())
        self.assertEqual(first, second)
        self.assertEqual(raw, before)
        self.assertEqual(report['counts'], repeated['counts'])
        self.assertEqual(report['pdfBindingHoldIds'], repeated['pdfBindingHoldIds'])

    def test_outer_private_fields_are_discarded(self):
        raw = originals()
        for p in raw:
            p.update(repo_path='/Users/private/book.pdf', api_key='private-secret', privateNotes='private-note')
        result, report = followup.project(raw, policy())
        encoded = json.dumps(result) + json.dumps(report)
        for value in ('repo_path', 'api_key', 'privateNotes', '/Users/', 'private-secret', 'private-note'):
            self.assertNotIn(value, encoded)

    def test_wrong_identifier_enrichment_is_not_rebound_to_new_identity(self):
        raw = originals()
        for p in raw:
            p.update(summary='Old identifier abstract', authors=['Old identifier author'], titleZh='Old translation',
                     draftData={'summary': 'Old derived interpretation'}, hasDraft=True)
        canonical = next(p for p in raw if p['id'] == 'ffeb47ca0a734600')
        canonical.update(summary='Existing proper DOI abstract')
        rows, _ = followup.project(raw, policy())
        retained = {e['id'] for e in policy()['entries'] if e['action'] == 'retain'}
        for p in rows:
            if p['id'] in retained:
                self.assertEqual(p['summary'], 'Old identifier abstract')
                continue
            if p['id'] == canonical['id']:
                self.assertEqual(p['summary'], 'Existing proper DOI abstract')
                continue
            self.assertTrue(all(k not in p for k in ('summary', 'authors', 'titleZh', 'draftData')))
            self.assertFalse(p['hasDraft'])

    def test_print_issue_never_replaces_online_or_ingestion_dates(self):
        raw = originals()
        rows, report = followup.project(raw, policy())
        byid = {p['id']: p for p in rows}
        for e in policy()['entries']:
            target_id = e.get('canonicalId', e['id'])
            p = byid[target_id]
            before = next(r for r in raw if r['id'] == target_id)
            if 'onlineDate' not in e['publicPatch']:
                self.assertEqual((p['date'], p['dateBasis']), (before['date'], before['dateBasis']))
            self.assertIsNone(p['ingestedAt'])
            self.assertFalse(p['localAvailable'])
            self.assertEqual(p['fulltextStatus'], 'not_verified')
        self.assertEqual(len(report['pdfBindingHoldIds']), 11)

    def test_publisher_first_online_date_wins_documented_registry_conflict(self):
        rows, _ = followup.project(originals(), policy())
        wizard = next(p for p in rows if p['id'] == 'c9dcd2b66a6ce72b')
        self.assertEqual((wizard['date'], wizard['onlineDate']), ('2026-06-17', '2026-06-17'))
        self.assertIn('Crossref 日期冲突', wizard['dateBasis'])
        evidence = json.loads((ROOT / 'docs/public-bibliography-followup-evidence-20261008.json').read_text())
        case = next(c for c in evidence['cases'] if c['id'] == wizard['id'])
        self.assertEqual(case['publisherMetadata']['dateConflict']['crossrefPublishedOnline'], '2026-07-14')

    def test_classifier_fields_cannot_be_patched_and_are_preserved(self):
        raw = originals()
        for p in raw:
            p.update(studyDesign='existing-design', tags=['existing-tag'], clinicalTier='existing-tier')
        rows, _ = followup.project(raw, policy())
        for p in rows:
            self.assertEqual((p['studyDesign'], p['tags'], p['clinicalTier']),
                             ('existing-design', ['existing-tag'], 'existing-tier'))
        bad = policy(); bad['entries'][0]['publicPatch']['studyDesign'] = 'randomized'
        with self.assertRaisesRegex(ValueError, 'non_bibliographic_patch_field'):
            followup.validate_policy(bad)

    def test_policy_rejects_private_unknown_fields_and_untrusted_evidence(self):
        for mutate in (lambda p: p.update(privateSource='/Users/private/index.csv'),
                       lambda p: p['entries'][0]['original'].update(repo_path='/Users/private/book.pdf'),
                       lambda p: p['entries'][0]['publicPatch'].update(title='/Users/private/book.pdf'),
                       lambda p: p['entries'][0].update(evidenceUrls=['https://untrusted.example/article'])):
            bad = policy(); mutate(bad)
            with self.assertRaises(ValueError):
                followup.validate_policy(bad)

    def test_duplicate_batch_input_or_alias_chain_holds(self):
        bad = policy(); bad['entries'].append(copy.deepcopy(bad['entries'][0]))
        with self.assertRaisesRegex(ValueError, 'invalid_batch_size'):
            followup.validate_policy(bad)
        rows = originals()
        with self.assertRaisesRegex(ValueError, 'duplicate_or_invalid_input_id'):
            followup.project(rows + [rows[0]], policy())
        bad = policy(); alias = next(e for e in bad['entries'] if e['action'] == 'alias')
        alias['canonicalId'] = bad['entries'][0]['id']; alias['canonicalOriginal'] = bad['entries'][0]['original']
        with self.assertRaisesRegex(ValueError, 'alias_chain_not_allowed'):
            followup.validate_policy(bad)

    def test_duplicate_replacement_identifier_variants_hold_instead_of_merging(self):
        for doi in ('10.1001/JAMA.2026.3533', 'https://doi.org/10.1001/jama.2026.3533'):
            other = {'id': 'different-id', 'title': 'Independent title', 'doi': doi, 'journal': 'JAMA', 'pmid': ''}
            with self.subTest(doi=doi), self.assertRaisesRegex(ValueError, 'replacement_doi_already_present'):
                followup.project(originals() + [other], policy())

    def test_new_reported_same_doi_duplicate_holds_and_singletons_are_retained(self):
        retained = [e for e in policy()['entries'] if e['action'] == 'retain']
        result, _ = followup.project(originals(), policy())
        for entry in retained:
            before = next(p for p in originals() if p['id'] == entry['id'])
            after = next(p for p in result if p['id'] == entry['id'])
            self.assertEqual(after, before)
            other = {**before, 'id': 'new-duplicate', 'doi': 'https://doi.org/' + before['doi'].upper()}
            with self.subTest(id=entry['id']), self.assertRaisesRegex(ValueError, 'reported_duplicate_now_present'):
                followup.project(originals() + [other], policy())

    def test_full_public_projection_and_combined_pdf_registry_holds(self):
        raw = json.loads((ROOT / 'editorial/public_library_snapshot.json').read_text())['papers']
        baseline, old = project_public_library(raw)
        result, new = followup.project(baseline, policy())
        self.assertEqual((len(baseline), len(result)), (1264, 1263))
        holds = set(old['pdfBindingHoldIds']) | set(new['pdfBindingHoldIds'])
        self.assertEqual(len(holds), 17)
        registry = pdf_library_registry([p for p in result if p['id'] not in holds])
        self.assertFalse(holds & registry.keys())

    def test_cli_offline_summary_and_fixed_error_contains_no_raw_sensitive_value(self):
        with patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(followup.main([]), 0)
        report = json.loads(out.getvalue())
        self.assertEqual((report['inputCount'], report['outputCount']), (1264, 1263))
        self.assertEqual(report['networkRequests'], 0)
        with patch.object(followup, 'read_public_bundle', side_effect=ValueError('/Users/private/secret')):
            with contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(followup.main([]), 1)
        self.assertEqual(json.loads(err.getvalue()), {'error': 'public_bibliography_followup_hold'})


if __name__ == '__main__':
    unittest.main()
