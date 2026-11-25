#!/usr/bin/env python3
import datetime
import tempfile
import unittest
from pathlib import Path

import title_translation_hold as h


NOW = datetime.datetime(2026, 11, 25, 8, 4, tzinfo=datetime.timezone.utc)


def paper(**kwargs):
    row = {'id': 'p1', 'title': 'A clinical trial of PCI', 'doi': '10.1234/example'}
    row.update(kwargs)
    return row


class QualifiedTitleTests(unittest.TestCase):
    def test_original_chinese_title_counts(self):
        self.assertTrue(h.has_qualified_zh_title(paper(title='经皮冠状动脉介入的临床试验', titleZh='')))

    def test_machine_title_needs_han(self):
        self.assertTrue(h.has_qualified_zh_title(paper(titleZh='经皮冠状动脉介入试验')))
        self.assertFalse(h.has_qualified_zh_title(paper(titleZh='PCI trial')))
        self.assertFalse(h.has_qualified_zh_title(paper(titleZh='')))
        self.assertFalse(h.has_qualified_zh_title(paper()))


class HoldWindowTests(unittest.TestCase):
    def test_new_english_only_paper_is_held(self):
        visible, held, legacy, ledger = h.partition([paper(fetchedAt='2026-11-25T07:00:00Z')], NOW, h.load_ledger(Path('/tmp/missing')))
        self.assertEqual([p['doi'] for p in held], ['10.1234/example'])
        self.assertEqual(visible, [])
        self.assertEqual(legacy, [])
        self.assertEqual(ledger['entries']['doi:10.1234/example']['reason'], 'translation_missing')

    def test_qualified_title_is_published_and_dropped_from_ledger(self):
        ledger = {'entries': {'doi:10.1234/example': {'firstMissingAt': '2026-11-25T00:00:00+00:00'}}}
        visible, held, legacy, out = h.partition([paper(titleZh='经皮冠状动脉介入试验')], NOW, ledger)
        self.assertEqual(len(visible), 1)
        self.assertEqual(held, [])
        self.assertEqual(legacy, [])
        self.assertNotIn('doi:10.1234/example', out['entries'])

    def test_missing_title_stays_held_after_a_day(self):
        row = paper(fetchedAt='2026-11-23T08:00:00Z')
        visible, held, legacy, ledger = h.partition([row], NOW, {'entries': {}})
        self.assertEqual(held, [row])
        self.assertEqual(visible, [])
        self.assertEqual(legacy, [])
        self.assertEqual(ledger['entries']['doi:10.1234/example']['status'], 'hold')

    def test_does_not_accept_a_title_that_failed_han_or_hygiene(self):
        visible, held, legacy, ledger = h.partition([paper(titleZh='PCI')], NOW, {'entries': {}})
        self.assertEqual(len(held), 1)
        self.assertEqual(visible, [])
        self.assertEqual(ledger['entries']['doi:10.1234/example']['reason'], 'translation_rejected_no_han')

    def test_journal_name_title_is_held_and_reported(self):
        row = paper(title='JAMA', journal='JAMA Current Issue', cleanJournal='JAMA', doi='10.1001/jama.2025.16112')
        visible, held, legacy, ledger = h.partition([row], NOW, {'entries': {}})
        self.assertEqual(held, [row])
        self.assertEqual(visible, [])
        self.assertEqual(ledger['entries']['doi:10.1001/jama.2025.16112']['reason'], 'unusable_title_equals_journal')
        alerts = h.alert_rows(held)
        self.assertEqual(alerts[0]['doi'], '10.1001/jama.2025.16112')
        self.assertEqual(alerts[0]['reason'], 'unusable_title_equals_journal')

    def test_short_openai_headline_has_a_translation_key(self):
        row = {'id': 'rss-openai', 'title': 'The Silent Consensus', 'journal': 'OpenAI News', 'doi': ''}
        self.assertTrue(h.paper_key(row).startswith('title:'))
        visible, held, legacy, ledger = h.partition([row], NOW, {'entries': {}})
        self.assertEqual(len(held), 1)
        self.assertIn(h.paper_key(row), ledger['entries'])

    def test_existing_library_inventory_is_not_withdrawn(self):
        row = paper(ingestedAt=None)
        visible, held, legacy, _ = h.partition([row], NOW, {'entries': {}}, legacy_keys={'doi:10.1234/example'})
        self.assertEqual(visible, [row])
        self.assertEqual(held, [])
        self.assertEqual(legacy, [row])
        # Snapshot membership, not ingest time, keeps approved library inventory listed.
        fresh = paper(doi='10.1234/fresh', ingestedAt='2026-11-25T07:00:00Z')
        visible, held, legacy, _ = h.partition([fresh], NOW, {'entries': {}}, legacy_keys={'doi:10.1234/fresh'})
        self.assertEqual(visible, [fresh])
        self.assertEqual(legacy, [fresh])
        self.assertEqual(held, [])

    def test_ledger_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            _, _, _, ledger = h.partition([paper(fetchedAt='2026-11-25T07:00:00Z')], NOW, h.load_ledger(root))
            h.save_ledger(root, ledger)
            loaded = h.load_ledger(root)
            self.assertEqual(loaded['entries']['doi:10.1234/example']['reason'], 'translation_missing')
            self.assertEqual(loaded['entries']['doi:10.1234/example']['status'], 'hold')


class BuildHoldIntegrationTests(unittest.TestCase):
    def test_public_build_holds_fresh_feed_item_and_keeps_translated_one(self):
        import contextlib, io, json
        from unittest.mock import patch
        import build_public as b
        from test_release_build import synthetic_root

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            synthetic_root(root)
            now = '2026-11-25T08:04:00+00:00'
            items = [
                {'id': 'rss-new', 'title': 'A brand new untranslated paper', 'doi': '10.1234/new-paper',
                 'journal': 'Heart', 'date': '2026-11-25', 'url': 'https://doi.org/10.1234/new-paper',
                 'fetchedAt': '2026-11-25T07:00:00Z'},
                {'id': 'rss-old', 'title': 'JAMA', 'doi': '10.1001/jama.2025.16112',
                 'journal': 'JAMA Current Issue', 'cleanJournal': 'JAMA', 'date': '2026-11-24',
                 'url': 'https://doi.org/10.1001/jama.2025.16112', 'fetchedAt': '2026-11-23T00:00:00Z'},
                {'id': 'rss-ready', 'title': 'An already translated paper', 'doi': '10.1234/ready-paper',
                 'journal': 'Heart', 'date': '2026-11-25', 'url': 'https://doi.org/10.1234/ready-paper',
                 'fetchedAt': '2026-11-25T07:00:00Z'},
            ]
            (root / 'data/candidates.json').write_text(json.dumps({'updatedAt': now, 'items': items}))
            (root / 'data/translations.json').write_text(json.dumps({'doi:10.1234/ready-paper': '一篇已翻译论文'}))
            dest = root / 'public'
            stdout = io.StringIO()
            with patch.object(b, 'ROOT', root), patch.object(b, 'DEST', dest), contextlib.redirect_stdout(stdout):
                b.main()
            from public_bundle import bundle_text
            text = bundle_text(dest)
            log = stdout.getvalue()
            self.assertIn('一篇已翻译论文', text)
            self.assertIn('10.1234/ready-paper', text)
            self.assertNotIn('10.1234/new-paper', text)
            self.assertNotIn('A brand new untranslated paper', text)
            self.assertNotIn('10.1001/jama.2025.16112', text)
            self.assertIn('TITLE TRANSLATION HOLD:', log)
            self.assertIn('unusable_title_equals_journal', log)
            self.assertIn('10.1001/jama.2025.16112', log)
            manifest = json.loads((root / 'docs/public-manifest.json').read_text())
            self.assertEqual(manifest['counts']['titles_held'], 2)
            reasons = {row['doi']: row['reason'] for row in manifest['counts']['titles_held_alerts']}
            self.assertEqual(reasons['10.1234/new-paper'], 'translation_missing')
            self.assertEqual(reasons['10.1001/jama.2025.16112'], 'unusable_title_equals_journal')
            self.assertEqual(manifest['counts']['titles_legacy_missing_zh'], 1)
            self.assertEqual(manifest['counts']['titles_legacy_missing_zh_alerts'][0]['doi'], '10.1234/synthetic')
            ledger = json.loads((root / 'data/title-translation-hold.json').read_text())
            self.assertIn('doi:10.1234/new-paper', ledger['entries'])
            self.assertNotIn('doi:10.1234/ready-paper', ledger['entries'])
            # Approved library fixture stays listed even without a Chinese title.
            self.assertGreaterEqual(manifest['counts']['library'], 1)


if __name__ == '__main__':
    unittest.main()
