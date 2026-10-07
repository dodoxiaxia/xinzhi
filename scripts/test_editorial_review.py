import copy
import datetime
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import editorial_review as r
import prepare_editorial_handoff as handoff

NOW = datetime.datetime(2026, 10, 7, 16, tzinfo=r.SHANGHAI)


def approved_draft(weekly=False):
    # Synthetic decision events: never evidence of an actual medical review.
    draft = {
        'doi': '10.1/synthetic', 'title_zh': '测试导读', 'summary': 'Synthetic evidence',
        'limitations': 'Synthetic limitations', 'learning_question': 'Test question',
        'study_type': 'Cohort', 'source_checked': True, 'evidence_basis': 'abstract',
        'source_url': 'https://example.org/source', 'attribution': 'Synthetic fixture',
        'published': '2026-10-07', 'reviewer': 'Private reviewer label',
    }
    if weekly:
        draft.update(content_kind='weekly', evidence_basis='fulltext',
                     body_markdown='Synthetic weekly body', evidence_table_markdown='Synthetic evidence table',
                     source_document_sha256='a' * 64,
                     target_week={'start': '2026-09-28', 'end': '2026-10-04'})
    digest = r.content_sha256(draft, draft['doi'])
    draft['review'] = {'schema_version': 1, 'state': 'approved', 'content_sha256': digest,
                       'reviewer_id': 'test-doctor', 'reviewer_role': 'physician',
                       'decided_at': '2026-10-07T10:00:00+08:00', 'event_id': 'test-review-1'}
    draft['publication'] = {'schema_version': 1, 'state': 'release_requested', 'content_sha256': digest,
                            'review_event_id': 'test-review-1', 'event_id': 'test-release-1',
                            'requested_by': 'test-integrator', 'requested_at': '2026-10-07T11:00:00+08:00',
                            'published_on': '2026-10-07'}
    return draft


class EditorialReviewTests(unittest.TestCase):
    def date(self, draft):
        return r.publication_date(draft, r.article_key(draft), now=NOW)

    def test_source_check_and_date_never_imply_physician_approval(self):
        draft = approved_draft()
        del draft['review']; del draft['publication']
        self.assertIsNone(self.date(draft))

    def test_pending_rejected_withdrawn_and_unpublished_are_hidden(self):
        for state in ('awaiting_physician', 'changes_requested', 'withdrawn'):
            draft = approved_draft(); draft['review']['state'] = state
            self.assertIsNone(self.date(draft))
        draft = approved_draft(); draft['published'] = False
        self.assertIsNone(self.date(draft))

    def test_approval_alone_does_not_release(self):
        draft = approved_draft(); del draft['publication']
        self.assertIsNone(self.date(draft))

    def test_separate_explicit_release_is_eligible(self):
        self.assertEqual(self.date(approved_draft()), '2026-10-07')

    def test_changes_after_approval_require_a_new_decision(self):
        for field in ('doi', 'summary', 'limitations', 'study_type', 'source_url', 'evidence_basis'):
            draft = approved_draft(); draft[field] += ' changed'
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'hash mismatch'):
                self.date(draft)

    def test_changed_weekly_body_evidence_or_week_invalidates_approval(self):
        for field, value in [('body_markdown', 'changed'), ('evidence_table_markdown', 'changed'),
                             ('target_week', {'start': '2026-10-05', 'end': '2026-10-11'})]:
            draft = approved_draft(weekly=True); draft[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'hash mismatch'):
                self.date(draft)

    def test_release_cannot_reference_another_review(self):
        draft = approved_draft(); draft['publication']['review_event_id'] = 'other-review'
        with self.assertRaisesRegex(ValueError, 'separate physician review'):
            self.date(draft)

    def test_non_physician_empty_identity_or_missing_audit_event_rejected(self):
        for record, field, value in [('review', 'reviewer_role', 'model'), ('review', 'reviewer_id', ''),
                                      ('publication', 'requested_by', ''), ('review', 'event_id', '')]:
            draft = approved_draft(); draft[record][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.date(draft)

    def test_future_naive_or_out_of_order_events_rejected(self):
        for record, field, value in [('review', 'decided_at', '2026-10-07T12:00:00+08:00'),
                                      ('publication', 'requested_at', '2026-10-08T11:00:00+08:00'),
                                      ('review', 'decided_at', '2026-10-07T10:00:00')]:
            draft = approved_draft(); draft[record][field] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.date(draft)

    def test_release_date_not_preparation_or_original_week_date(self):
        draft = approved_draft(); draft['publication']['published_on'] = '2026-10-02'
        draft['published'] = '2026-10-02'
        with self.assertRaisesRegex(ValueError, 'explicit release request'):
            self.date(draft)

    def test_weekly_original_week_survives_historical_release(self):
        draft = approved_draft(weekly=True)
        self.assertEqual(self.date(draft), '2026-10-07')
        self.assertEqual(draft['target_week']['start'], '2026-09-28')

    def test_weekly_requires_source_hash_body_evidence_and_fulltext(self):
        for field, value in [('evidence_basis', 'abstract'), ('body_markdown', ''),
                             ('evidence_table_markdown', ''), ('source_document_sha256', 'bad')]:
            draft = approved_draft(weekly=True); draft[field] = value
            digest = r.content_sha256(draft, draft['doi'])
            for record in ('review', 'publication'): draft[record]['content_sha256'] = digest
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.date(draft)

    def test_wednesday_not_overdue_and_historical_backlog_separate(self):
        current = {'start': '2026-10-05', 'end': '2026-10-11'}
        previous = {'start': '2026-09-28', 'end': '2026-10-04'}
        self.assertEqual(r.weekly_due_status(current, NOW.date()), 'before_friday')
        self.assertEqual(r.weekly_due_status(current, datetime.date(2026, 10, 9)), 'due_friday')
        self.assertEqual(r.weekly_due_status(previous, NOW.date()), 'historical_backlog')

    def test_legacy_content_and_date_are_frozen(self):
        draft = approved_draft(); del draft['review']; del draft['publication']
        draft.pop('published')
        legacy = {draft['doi']: {'content_sha256': r.content_sha256(draft, draft['doi']),
                                 'published_on': '2026-09-29'}}
        self.assertEqual(r.publication_date(draft, draft['doi'], legacy), '2026-09-29')
        draft['published'] = '2026-10-07'
        with self.assertRaisesRegex(ValueError, 'cannot be rewritten'):
            r.publication_date(draft, draft['doi'], legacy)

    def test_local_handoff_is_private_auditable_and_not_deployed(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(handoff, 'ROOT', Path(tmp)):
            output = Path(tmp) / '.local/handoffs/test'
            audit = handoff.prepare(approved_draft(), output)
            self.assertEqual(audit['stage'], 'prepared'); self.assertFalse(audit['deployed'])
            self.assertEqual(json.loads((output/'editorial-handoff.json').read_text()), approved_draft())
            self.assertEqual(audit['review_event_id'], 'test-review-1')
            self.assertNotIn('reviewer_id', audit); self.assertNotIn('summary', audit)
            with self.assertRaises(FileExistsError): handoff.prepare(approved_draft(), output)

    def test_handoff_rejects_pending_and_public_output_without_writes(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(handoff, 'ROOT', Path(tmp)):
            root = Path(tmp); draft = approved_draft()
            with self.assertRaises(ValueError): handoff.prepare(draft, root/'public/test')
            draft['review']['state'] = 'awaiting_physician'
            with self.assertRaises(ValueError): handoff.prepare(draft, root/'.local/test')
            self.assertEqual(list(root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
