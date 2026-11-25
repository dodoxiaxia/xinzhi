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
        visible, held, fallback, ledger = h.partition([paper(fetchedAt='2026-11-25T07:00:00Z')], NOW, h.load_ledger(Path('/tmp/missing')))
        self.assertEqual([p['doi'] for p in held], ['10.1234/example'])
        self.assertEqual(visible, [])
        self.assertEqual(fallback, [])
        self.assertEqual(ledger['entries']['doi:10.1234/example']['firstMissingAt'], '2026-11-25T07:00:00+00:00')

    def test_qualified_title_is_published_and_dropped_from_ledger(self):
        ledger = {'entries': {'doi:10.1234/example': {'firstMissingAt': '2026-11-25T00:00:00+00:00'}}}
        visible, held, fallback, out = h.partition([paper(titleZh='经皮冠状动脉介入试验')], NOW, ledger)
        self.assertEqual(len(visible), 1)
        self.assertEqual(held, [])
        self.assertEqual(fallback, [])
        self.assertNotIn('doi:10.1234/example', out['entries'])

    def test_stale_missing_title_falls_back_to_english(self):
        row = paper(fetchedAt='2026-11-23T08:00:00Z')
        visible, held, fallback, ledger = h.partition([row], NOW, {'entries': {}})
        self.assertEqual(visible, [row])
        self.assertEqual(held, [])
        self.assertEqual([p['doi'] for p in fallback], ['10.1234/example'])
        self.assertEqual(ledger['entries']['doi:10.1234/example']['firstMissingAt'], '2026-11-23T08:00:00+00:00')
        self.assertIn('fallbackAt', ledger['entries']['doi:10.1234/example'])

    def test_untimestamped_paper_starts_the_clock_on_first_build(self):
        visible, held, fallback, ledger = h.partition([paper()], NOW, {'entries': {}})
        self.assertEqual(held[0]['doi'], '10.1234/example')
        self.assertEqual(visible, [])
        first = ledger['entries']['doi:10.1234/example']['firstMissingAt']
        later = NOW + datetime.timedelta(hours=h.HOLD_HOURS)
        visible, held, fallback, _ = h.partition([paper()], later, {'entries': {'doi:10.1234/example': {'firstMissingAt': first}}})
        self.assertEqual(held, [])
        self.assertEqual(len(fallback), 1)
        self.assertEqual(len(visible), 1)

    def test_does_not_accept_a_title_that_failed_han_or_hygiene(self):
        # A cached English string is not a qualified translation, even if present.
        visible, held, fallback, _ = h.partition([paper(titleZh='PCI')], NOW, {'entries': {}})
        self.assertEqual(len(held), 1)
        self.assertEqual(visible, [])

    def test_private_fetched_at_map_covers_public_papers_that_dropped_the_field(self):
        public = paper()
        times = h.seen_times([paper(fetchedAt='2026-11-25T07:30:00Z')])
        self.assertEqual(h.decision(public, NOW, {'entries': {}}, times), 'hold')
        old = paper()
        old_times = h.seen_times([paper(fetchedAt='2026-11-20T00:00:00Z')])
        self.assertEqual(h.decision(old, NOW, {'entries': {}}, old_times), 'fallback')

    def test_existing_library_inventory_without_a_clock_is_not_hidden(self):
        row = paper(ingestedAt=None)
        visible, held, fallback, _ = h.partition([row], NOW, {'entries': {}}, legacy_keys={'doi:10.1234/example'})
        self.assertEqual(visible, [row])
        self.assertEqual(held, [])
        self.assertEqual(fallback, [row])
        # A newly ingested library paper is still held.
        fresh = paper(doi='10.1234/fresh', ingestedAt='2026-11-25T07:00:00Z')
        visible, held, fallback, _ = h.partition([fresh], NOW, {'entries': {}}, legacy_keys={'doi:10.1234/fresh'})
        self.assertEqual(held, [fresh])
        self.assertEqual(visible, [])

    def test_ledger_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            _, _, _, ledger = h.partition([paper(fetchedAt='2026-11-25T07:00:00Z')], NOW, h.load_ledger(root))
            h.save_ledger(root, ledger)
            loaded = h.load_ledger(root)
            self.assertEqual(loaded['holdHours'], 24)
            self.assertEqual(loaded['entries']['doi:10.1234/example']['firstMissingAt'], '2026-11-25T07:00:00+00:00')


class BuildHoldIntegrationTests(unittest.TestCase):
    def test_public_build_holds_fresh_feed_item_and_keeps_translated_one(self):
        import contextlib, io, json, shutil
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
                {'id': 'rss-ready', 'title': 'An already translated paper', 'doi': '10.1234/ready-paper',
                 'journal': 'Heart', 'date': '2026-11-25', 'url': 'https://doi.org/10.1234/ready-paper',
                 'fetchedAt': '2026-11-25T07:00:00Z'},
            ]
            (root / 'data/candidates.json').write_text(json.dumps({'updatedAt': now, 'items': items}))
            (root / 'data/translations.json').write_text(json.dumps({'doi:10.1234/ready-paper': '一篇已翻译论文'}))
            dest = root / 'public'
            with patch.object(b, 'ROOT', root), patch.object(b, 'DEST', dest), contextlib.redirect_stdout(io.StringIO()):
                b.main()
            # Locate the published feeds payload
            from public_bundle import bundle_text
            text = bundle_text(dest)
            self.assertIn('一篇已翻译论文', text)
            self.assertIn('10.1234/ready-paper', text)
            self.assertNotIn('10.1234/new-paper', text)
            self.assertNotIn('A brand new untranslated paper', text)
            manifest = json.loads((root / 'docs/public-manifest.json').read_text())
            self.assertEqual(manifest['counts']['titles_held'], 1)
            self.assertEqual(manifest['counts']['titles_fallback_english'], 1)  # approved library fixture has no Chinese title
            ledger = json.loads((root / 'data/title-translation-hold.json').read_text())
            self.assertIn('doi:10.1234/new-paper', ledger['entries'])
            self.assertNotIn('doi:10.1234/ready-paper', ledger['entries'])
            # The approved library fixture still has a Chinese title and remains listed.
            self.assertGreaterEqual(manifest['counts']['library'], 1)


if __name__ == '__main__':
    unittest.main()
