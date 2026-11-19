"""Offline regressions for the Nature Biomedical Engineering official RSS feed."""
import contextlib
import datetime
import hashlib
import io
import json
import os
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import xml.etree.ElementTree as ET

import build_public as builder
from build_data import clean
import merge_candidates
import refresh_feeds as feeds
from public_bundle import bundle_text
from scope_filter import scope_decision
from test_release_build import synthetic_root

NATBME_NAME = 'Nature Biomedical Engineering'
NATBME_URL = 'https://www.nature.com/natbiomedeng.rss'
FIXTURE_PATH = feeds.ROOT / 'scripts/fixtures/natbiomedeng.rss'
# Catalogue row used only to show the existing website-only / non --all path.
CATALOGUE = {'id': 'a', 'name': 'Heart Online First', 'url': 'https://example.org/rss', 'enabled': True}


class NatBMEFeedTests(unittest.TestCase):
    def setUp(self):
        self.guards = [
            patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')),
            patch('socket.create_connection', side_effect=AssertionError('Network forbidden')),
        ]
        for guard in self.guards:
            guard.start()
            self.addCleanup(guard.stop)

    def _extra_rows(self):
        return json.loads(feeds.EXTRA_FEEDS_PATH.read_text(encoding='utf-8'))

    def _natbme_row(self):
        matches = [row for row in self._extra_rows() if row.get('url') == NATBME_URL]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def _natbme_source(self):
        return next(entry for entry in feeds.extra_sources() if entry['url'] == NATBME_URL)

    def test_extra_feeds_contains_official_natbme_entry(self):
        rows = self._extra_rows()
        urls = [row['url'] for row in rows]
        self.assertEqual(len(urls), len(set(urls)))

        row = self._natbme_row()
        self.assertEqual(row['name'], NATBME_NAME)
        self.assertTrue(row['url'].startswith('https://'))
        self.assertIs(row['enabled'], True)
        self.assertFalse(feeds.has_credentials(row['url']))
        # extra_feeds.category is the existing refresh-catalogue enum, not a journal-tier / menu change.
        self.assertEqual(row['category'], '综合医学')
        self.assertIn(row['category'], {'心血管', 'AI医疗', '综合医学'})
        self.assertEqual(row['sourceType'], '出版商/学术平台')
        self.assertEqual(row['route'], 'publisher')
        self.assertNotIn('fallbackCategory', row)

        expected_id = hashlib.sha256(row['url'].encode('utf-8')).hexdigest()[:12]
        self.assertEqual(feeds.source_id(row['url']), expected_id)
        self.assertRegex(expected_id, r'^[0-9a-f]{12}$')

    def test_extra_sources_selects_and_deduplicates_natbme(self):
        selected = feeds.extra_sources()
        matches = [source for source in selected if source['url'] == NATBME_URL]
        self.assertEqual(len(matches), 1)

        source = matches[0]
        self.assertEqual(source['name'], NATBME_NAME)
        self.assertEqual(source['id'], feeds.source_id(NATBME_URL))
        self.assertIs(source['enabled'], True)
        self.assertEqual(source['category'], '综合医学')

        deduped = feeds.extra_sources(known_urls={NATBME_URL})
        self.assertNotIn(NATBME_URL, {entry['url'] for entry in deduped})
        self.assertEqual(len(deduped), len(selected) - 1)

    def test_select_sources_includes_natbme_only_when_all_sources(self):
        library = {'feeds': [CATALOGUE]}
        default = feeds.select_sources(library)
        self.assertEqual([row['name'] for row in default], [CATALOGUE['name']])
        self.assertNotIn(NATBME_URL, {row['url'] for row in default})

        all_run = feeds.select_sources(library, all_sources=True)
        matches = [row for row in all_run if row['url'] == NATBME_URL]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]['name'], NATBME_NAME)
        self.assertEqual(matches[0]['id'], feeds.source_id(NATBME_URL))
        self.assertEqual(matches[0]['origin'], 'config/extra_feeds.json')
        self.assertEqual(matches[0]['category'], '综合医学')
        self.assertGreater(len(all_run), len(default))

    def test_parse_fixture_derives_counts_dois_and_source_dates(self):
        source = self._natbme_source()
        raw = FIXTURE_PATH.read_bytes()
        root = ET.fromstring(raw)
        xml_items = [
            el for el in root
            if feeds.local(el.tag) == 'item' and feeds.namespace(el.tag) in ('', feeds.RSS1_NS)
        ]
        self.assertGreater(len(xml_items), 0)

        expected_dates = {}
        expected_excluded = 0
        for el in xml_items:
            link = feeds.text(el, 'link')
            title = clean(feeds.text(el, 'title'))
            doi = feeds.extract_doi(link, el)
            expected_dates[link] = feeds.dateval(feeds.text(el, 'date'))
            category = feeds.classify(title, source['name'])
            self.assertNotEqual(category, '待分类')
            decision = scope_decision({
                'title': title,
                'journal': source['name'],
                'doi': doi,
                'category': category,
            })
            if decision['action'] == 'exclude':
                expected_excluded += 1

        checked_at = '2099-01-01T00:00:00+00:00'
        result = feeds.parse_feed(raw, source, checked_at=checked_at)

        self.assertEqual(result['feedType'], 'rdf')
        self.assertEqual(result['parser'], 'strict')
        self.assertEqual(result['rawItems'], len(xml_items))
        self.assertEqual(result['scopeExcludedCount'], expected_excluded)
        self.assertEqual(len(result['scopeExcluded']), result['scopeExcludedCount'])
        self.assertEqual(result['classifiedItems'], len(result['items']))
        self.assertEqual(len(result['items']) + result['scopeExcludedCount'], result['rawItems'])

        for item in result['items']:
            self.assertTrue(item['url'].startswith('https://'))
            self.assertRegex(item['doi'], r'^10\.1038/s41551-[a-z0-9-]+$')
            self.assertEqual(item['journal'], NATBME_NAME)
            self.assertEqual(item['category'], feeds.classify(item['title'], NATBME_NAME))
            self.assertEqual(item['date'], expected_dates[item['url']])
            self.assertNotEqual(item['date'], checked_at)
            self.assertEqual(item['fetchedAt'], checked_at)

    def test_official_fixture_enters_isolated_merge_and_build(self):
        """Fixture items in the 14-day window enter merge and an isolated build under a deterministic test clock.

        Injects a unit-test reference clock derived from the fixture's real article
        dates (max parseable item date + 1 day UTC) into eligible(), build_results(),
        and merge_candidates without altering any article date, production input, or
        state branch. Separate from the real-clock offline integration evidence at
        /workspace/xz-perf/natbme-feed-1115/official-probe/merge-build-evidence.json
        (2026-11-15 18:41:10 Asia/Shanghai); this unit-test reference clock must never
        be used as production or integration evidence.
        """
        source = self._natbme_source()
        raw = FIXTURE_PATH.read_bytes()
        probe = feeds.parse_feed(raw, source, checked_at='1970-01-01T00:00:00+00:00')
        valid_dates = [
            datetime.datetime.fromisoformat(value)
            for item in probe['items']
            for value in (feeds.dateval(item.get('date', '')),)
            if value
        ]
        self.assertTrue(valid_dates, 'official fixture has no parseable article dates')
        clock = max(valid_dates).astimezone(datetime.timezone.utc) + datetime.timedelta(days=1)
        checked_at = clock.isoformat()
        parsed = feeds.parse_feed(raw, source, checked_at=checked_at)
        window = {}
        for item in parsed['items']:
            keep, reason = feeds.eligible(item, clock)
            window[item['doi']] = {'keep': keep, 'reason': reason, 'date': item['date'], 'title': item['title']}
        expected_dois = {doi for doi, row in window.items() if row['keep']}
        self.assertTrue(
            expected_dois,
            'expected at least one fixture item in the 14-day window relative to the derived reference clock',
        )

        def fixture_fetch(src):
            details = dict(parsed)
            items = details.pop('items')
            details.pop('scopeExcluded', [])
            return feeds._report(
                src, ok=True, status='ok', items=len(items), startedAt=checked_at,
                checkedAt=checked_at, httpStatus=200, attempted=True,
                responseUrl=NATBME_URL, responseContentType='application/rss+xml',
                **details,
            ), items

        feed_doc, health = feeds.build_results([source], [fixture_fetch(source)], now=clock)
        feed_dois = {item['doi'] for item in feed_doc['items']}
        self.assertEqual(feed_dois, expected_dois)
        self.assertGreater(feed_doc.get('excluded', {}).get('olderThan14Days', 0) + len(expected_dois), 0)

        class Clock(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                base = cls(
                    clock.year, clock.month, clock.day,
                    clock.hour, clock.minute, clock.second,
                    clock.microsecond, tzinfo=datetime.timezone.utc,
                )
                if tz is None:
                    return base.replace(tzinfo=None)
                if tz == datetime.timezone.utc:
                    return base
                return base.astimezone(tz)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            synthetic_root(root)
            (root / 'data' / 'feeds.json').write_text(json.dumps(feed_doc, ensure_ascii=False))
            (root / 'data' / 'source-health.json').write_text(json.dumps(health, ensure_ascii=False))
            (root / 'data' / 'pubmed.json').write_text(json.dumps({
                'items': [], 'fetched': 0, 'totalHits': 0, 'truncated': False, 'journals': [],
            }))
            env = {**os.environ, 'XINZHI_DOI_LOOKUP': '0'}
            with patch.object(merge_candidates, 'ROOT', root), \
                    patch.object(merge_candidates.datetime, 'datetime', Clock), \
                    patch.dict(os.environ, env, clear=False), \
                    patch('subprocess.run') as run, \
                    contextlib.redirect_stdout(io.StringIO()):
                merge_candidates.main()
            run.assert_called_once()
            merged = json.loads((root / 'data' / 'candidates.json').read_text())
            merged_natbme = [item for item in merged['items'] if item.get('doi') in {item['doi'] for item in parsed['items']}]
            merged_dois = {item['doi'] for item in merged_natbme}
            self.assertEqual(merged_dois, expected_dois)
            for item in merged_natbme:
                self.assertEqual(item['journal'], NATBME_NAME)
                self.assertEqual(item['date'], window[item['doi']]['date'])
                self.assertTrue(item['url'].startswith('https://'))

            dest = root / 'public'
            with patch.object(builder, 'ROOT', root), \
                    patch.object(builder, 'DEST', dest), \
                    contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            bundle = bundle_text(dest)
            public_feeds, _ = json.JSONDecoder().raw_decode(bundle.split('window.FEEDS=', 1)[1])
            public_natbme = [item for item in public_feeds['items'] if item.get('doi') in expected_dois]
            self.assertEqual({item['doi'] for item in public_natbme}, expected_dois)
            for item in public_natbme:
                self.assertEqual(item['journal'], NATBME_NAME)


if __name__ == '__main__':
    unittest.main()
