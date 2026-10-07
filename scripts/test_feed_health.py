"""Offline feed/health regressions: no publishers, RSS services or credentials."""
from copy import deepcopy
import datetime
import importlib
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import refresh_feeds as feeds


NOW = datetime.datetime(2026, 10, 7, 6, tzinfo=datetime.timezone.utc)
CHECKED = NOW.isoformat()
SOURCE = {'id': 's1', 'name': 'Heart', 'url': 'https://example.org/rss', 'enabled': True}


def rss(title='AI-enabled cardiac screening', link='https://example.org/article', date='2026-10-06T12:00:00Z'):
    return ('<rss><channel><item><title>' + title + '</title><link>' + link + '</link><pubDate>' + date + '</pubDate><description>Abstract</description></item></channel></rss>').encode()


def report(source, *, ok=True, raw=1, status='ok', code=None):
    return {'id': source['id'], 'source': source['name'], 'url': source['url'],
            'checkedAt': CHECKED, 'ok': ok, 'status': status, 'rawItems': raw if ok else None,
            'items': raw if ok else 0, 'code': code, 'attempted': True}


def parsed(source=SOURCE, **kwargs):
    return feeds.parse_feed(rss(**kwargs), source, checked_at=CHECKED)['items']


def previous(source=SOURCE):
    items = parsed(source)
    items[0]['fetchedAt'] = '2026-10-07T02:00:00+00:00'
    items[0].pop('sourceUrl')
    return {'reports': [{'source': source['name'], 'url': source['url'], 'ok': True, 'items': 1}], 'items': items}


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.guards = [patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')),
                       patch('socket.create_connection', side_effect=AssertionError('Network forbidden'))]
        for guard in self.guards:
            guard.start()
            self.addCleanup(guard.stop)


class ParserTests(OfflineTests):
    def test_rss_atom_and_rdf_direct_members(self):
        payloads = [rss(),
                    b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Cardiac AI</title><link rel="self" href="https://example.org/feed"/><link href="https://example.org/article"/><published>2026-10-06</published></entry></feed>',
                    b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel rdf:about="https://example.org"/><item><title>Cardiac AI</title><link>https://example.org/article</link></item></rdf:RDF>']
        for kind, payload in zip(('rss', 'atom', 'rdf'), payloads):
            value = feeds.parse_feed(payload, SOURCE, checked_at=CHECKED)
            self.assertEqual((value['feedType'], value['rawItems'], value['parser']), (kind, 1, 'strict'))
            self.assertEqual(value['items'][0]['url'], 'https://example.org/article')

    def test_html_plaintext_and_feed_looking_nested_tags_rejected(self):
        for raw in (b'<html><body><item><title>Cardiac AI</title></item></body></html>',
                    b'<html><rss><channel/></rss></html>', b'Site Unavailable',
                    b'<feed xmlns="http://www.w3.org/1999/xhtml"/>', b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>'):
            with self.assertRaises(feeds.FeedParseError) as caught:
                feeds.parse_feed(raw, SOURCE)
            self.assertEqual(caught.exception.status, 'not_feed')

    def test_rss_missing_channel_truncated_or_mismatched_xml_not_empty(self):
        for raw in (b'<rss/>', b'<rss><channel><item>', b'<rss><channel><item></channel></rss>'):
            with self.assertRaises(feeds.FeedParseError) as caught:
                feeds.parse_feed(raw, SOURCE)
            self.assertEqual(caught.exception.status, 'parse_error')

    def test_bounded_text_recovery_does_not_rebuild_structure(self):
        value = feeds.parse_feed(rss(title='Cardiac AI P<0.05 & benefit'), SOURCE)
        self.assertEqual(value['parser'], 'recovered')
        self.assertIn('P<0.05 & benefit', value['items'][0]['title'])
        self.assertEqual(set(value['parserWarnings']), {'bare_ampersand', 'text_less_than'})

    def test_cdata_entities_and_namespace_date_retained(self):
        value = feeds.parse_feed(rss(title='<![CDATA[Heart & AI]]>'), SOURCE)
        self.assertEqual(value['parser'], 'strict')
        self.assertEqual(value['items'][0]['title'], 'Heart & AI')
        namespaced = b'<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>Cardiac AI</title><link>https://example.org/article</link><dc:date>2026-10-06</dc:date></item></channel></rss>'
        self.assertTrue(feeds.parse_feed(namespaced, SOURCE)['items'][0]['date'].startswith('2026-10-06'))

    def test_dtd_utf16_and_unknown_entities_rejected(self):
        dtd = '<!DOCTYPE rss [<!ENTITY payload "Cardiac AI">]><rss><channel><item><title>&payload;</title></item></channel></rss>'
        for raw in (dtd.encode(), dtd.encode('utf-16'), rss(title='Cardiac AI &UndefinedEntity;')):
            with self.assertRaises(feeds.FeedParseError) as caught:
                feeds.parse_feed(raw, SOURCE)
            self.assertEqual(caught.exception.status, 'parse_error')

    def test_oversize_and_bad_encoding_are_not_recovered(self):
        for raw in (b'x' * (feeds.MAX_BYTES + 1), rss().replace(b'Cardiac', b'Card\xffiac').replace(b'AI-enabled', b'AI\xff-enabled')):
            with self.assertRaises(feeds.FeedParseError):
                feeds.parse_feed(raw, SOURCE)

    def test_raw_items_distinct_from_filtered_and_empty(self):
        valid = feeds.parse_feed(rss(title='Unrelated gardening news'), {**SOURCE, 'name': 'Other'})
        self.assertEqual(valid['rawItems'], 1)
        self.assertEqual(valid['classifiedItems'], 0)
        empty = feeds.parse_feed(b'<rss><channel/></rss>', SOURCE)
        self.assertEqual((empty['rawItems'], empty['classifiedItems']), (0, 0))

    def test_credential_article_links_omitted(self):
        value = feeds.parse_feed(rss(link='https://example.org/article?token=must-not-appear'), SOURCE)
        self.assertEqual(value['rawItems'], 1)
        self.assertEqual(value['items'], [])

    def test_safe_simple_system_and_public_doctype_ignore_without_resolution(self):
        declarations = [('<!DOCTYPE rss>', 'simple'),
                        ('<!DOCTYPE rss SYSTEM "https://never-request.example/external.dtd">', 'external_system'),
                        ('<!DOCTYPE rss PUBLIC "-//Example//RSS//EN" "file:///never-read.dtd">', 'external_public')]
        with (patch('refresh_feeds.urllib.request.urlopen', side_effect=AssertionError('DTD must never resolve')),
              patch('builtins.open', side_effect=AssertionError('External DTD files must never open'))):
            for declaration, kind in declarations:
                value = feeds.parse_feed(declaration.encode() + rss(), SOURCE)
                self.assertEqual((value['rootKind'], value['doctypeKind'], value['parser']), ('rss', kind, 'strict'))
                self.assertEqual(value['rawItems'], 1)
                self.assertIn('doctype_ignored_without_resolution', value['parserWarnings'])

    def test_doctype_atom_and_prefixed_rdf_match_actual_root(self):
        atom = b'<!DOCTYPE feed SYSTEM "https://never-request.example/feed.dtd"><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Cardiac AI</title><link href="https://example.org/article"/></entry></feed>'
        rdf = b'<!DOCTYPE rdf:RDF SYSTEM "https://never-request.example/rss.dtd"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel/><item><title>Cardiac AI</title><link>https://example.org/article</link></item></rdf:RDF>'
        for raw, root_kind in [(atom, 'atom'), (rdf, 'rdf')]:
            value = feeds.parse_feed(raw, SOURCE)
            self.assertEqual((value['rootKind'], value['rawItems']), (root_kind, 1))

    def test_safe_doctype_utf8_and_utf16_delete_only_original_declaration_bytes(self):
        declaration = '<!DOCTYPE rss SYSTEM "https://never-request.example/rss.dtd">'
        body = rss(title='Cardiac AI café').decode()
        for codec, prefix, xml_encoding in [('utf-8', b'\xef\xbb\xbf', 'UTF-8'),
                                            ('utf-16-le', b'\xff\xfe', 'UTF-16'),
                                            ('utf-16-be', b'\xfe\xff', 'UTF-16')]:
            prolog = '<?xml version="1.0" encoding="' + xml_encoding + '"?>\n<!--prefix-->'
            raw = prefix + (prolog + declaration + body).encode(codec)
            diagnostic, _ = feeds._diagnostic_text(raw)
            stripped, _, _ = feeds._without_safe_doctype(raw, diagnostic)
            self.assertEqual(stripped, prefix + (prolog + body).encode(codec))
            value = feeds.parse_feed(raw, SOURCE)
            self.assertIn('café', value['items'][0]['title'])

    def test_doctype_internal_subset_entity_and_unknown_entity_still_fail_closed(self):
        payloads = [b'<!DOCTYPE rss []>' + rss(),
                    b'<!DOCTYPE rss [<!ENTITY external SYSTEM "file:///never-read">]>' + rss(title='Cardiac AI &external;'),
                    b'<!ENTITY external SYSTEM "https://never-request.example/">' + rss(),
                    b'<!DOCTYPE rss SYSTEM "https://never-request.example/feed.dtd">' + rss(title='Cardiac AI &publisherOnlyEntity;'),
                    b'<!DOCTYPE rss>' + rss(title='Cardiac AI &copycat;'),
                    b'<!DOCTYPE rss>' + rss(title='Cardiac AI &notarealentity;')]
        with patch('refresh_feeds.urllib.request.urlopen', side_effect=AssertionError('Entities must never resolve')):
            for raw in payloads:
                with self.assertRaises(feeds.FeedParseError) as caught:
                    feeds.parse_feed(raw, SOURCE)
                self.assertEqual(caught.exception.status, 'parse_error')
                self.assertIn('doctypeKind', caught.exception.metadata)

    def test_doctype_name_position_duplicate_structure_and_html_not_loosened(self):
        cases = [(b'<!DOCTYPE rss><html/>', 'not_feed', 'html'),
                 (b'<!DOCTYPE html><html><body>Unavailable</body></html>', 'not_feed', 'html'),
                 (b'<!DOCTYPE feed>' + rss(), 'parse_error', 'rss'),
                 (b'<!DOCTYPE rss><!DOCTYPE rss>' + rss(), 'parse_error', 'unknown'),
                 (b'<rss><channel/><!DOCTYPE rss></rss>', 'parse_error', 'rss'),
                 (b'<!DOCTYPE rss><rss/>', 'parse_error', 'rss'),
                 (b'<!DOCTYPE rss><rss><channel><item>', 'parse_error', 'rss')]
        for raw, status, root_kind in cases:
            with self.assertRaises(feeds.FeedParseError) as caught:
                feeds.parse_feed(raw, SOURCE)
            self.assertEqual(caught.exception.status, status)
            self.assertEqual(caught.exception.metadata['rootKind'], root_kind)

    def test_doctype_invalid_or_disagreeing_encoding_never_replaces_bytes(self):
        invalid = b'<!DOCTYPE rss>' + rss().replace(b'AI-enabled', b'AI\xff-enabled')
        wrong = ('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE rss>' + rss().decode()).encode('utf-8')
        for raw in [invalid, wrong]:
            with self.assertRaises(feeds.FeedParseError) as caught:
                feeds.parse_feed(raw, SOURCE)
            self.assertEqual(caught.exception.metadata['doctypeKind'], 'encoding_rejected')

    def test_external_literal_brackets_are_not_an_internal_subset(self):
        value = feeds.parse_feed(b'<!DOCTYPE rss SYSTEM "https://never-request.example/[rss].dtd">' + rss(), SOURCE)
        self.assertEqual(value['doctypeKind'], 'external_system')

    def test_doctype_metadata_does_not_store_external_identifier_or_body(self):
        raw = b'<!DOCTYPE rss SYSTEM "https://user:must-not-appear@never-request.example/rss.dtd?token=hidden">' + rss()
        value = feeds.parse_feed(raw, SOURCE)
        self.assertNotIn('must-not-appear', json.dumps(value))
        self.assertNotIn('hidden', json.dumps(value))
        self.assertNotIn('never-request', json.dumps(value))

    def test_html_entity_recovery_cannot_manufacture_xml_structure_or_quotes(self):
        for raw in (b'<rss>&LT;channel&GT;&LT;/channel&GT;</rss>',
                    b'<!DOCTYPE rss><rss>&LT;channel&GT;&LT;/channel&GT;</rss>',
                    b'<rss xmlns=&QUOT;urn:other&QUOT;><channel/></rss>'):
            with self.assertRaises(feeds.FeedParseError) as caught:
                feeds.parse_feed(raw, SOURCE)
            self.assertEqual(caught.exception.status, 'parse_error')
        escaped = b'<rss><channel>&LT;item&GT;&LT;title&GT;Cardiac AI&LT;/title&GT;&LT;link&GT;https://example.org/article&LT;/link&GT;&LT;/item&GT;</channel></rss>'
        value = feeds.parse_feed(escaped, SOURCE)
        self.assertEqual((value['rawItems'], value['items']), (0, []))


class HealthTests(OfflineTests):
    def test_current_valid_zero_filtered_zero_and_failure_are_distinct(self):
        sources = [SOURCE, {**SOURCE, 'id': 's2', 'url': 'https://second.org/rss'}, {**SOURCE, 'id': 's3', 'url': 'https://third.org/rss'}]
        old = parsed(sources[1], date='2020-01-01')
        fetched = [(report(sources[0], raw=0, status='empty_feed'), []),
                   (report(sources[1]), old), (report(sources[2], ok=False, status='parse_error'), [])]
        result, health = feeds.build_results(sources, fetched, now=NOW)
        self.assertEqual([row['status'] for row in health['sources']], ['empty_feed', 'filtered_empty', 'parse_error'])
        self.assertEqual([row['rawItems'] for row in health['sources']], [0, 1, None])
        self.assertEqual([row['eligibleItems'] for row in health['sources']], [0, 0, None])
        self.assertEqual(result['candidateCount'], 0)

    def test_failure_preserves_same_endpoint_cache_without_refreshing_time(self):
        old = previous()
        initial = deepcopy(old)
        result, health = feeds.build_results([SOURCE], [(report(SOURCE, ok=False, status='http_error', code=403), [])],
                                             previous_feeds=old, previous_health={'sources': [{'id': 's1', 'url': SOURCE['url'], 'status': 'ok', 'checkedAt': '2026-09-29T09:00:00Z'}]}, now=NOW)
        self.assertEqual(old, initial)
        self.assertEqual(result['candidateCount'], 1)
        self.assertEqual(result['cachedItemCount'], 1)
        self.assertEqual(result['items'][0]['fetchedAt'], '2026-10-07T02:00:00+00:00')
        self.assertEqual(health['sources'][0]['checkedAt'], CHECKED)
        self.assertEqual(health['sources'][0]['status'], 'http_error')
        self.assertEqual(health['sources'][0]['lastSuccessfulAt'], '2026-09-29T09:00:00Z')
        self.assertEqual(health['sources'][0]['lastCachedFetchAt'], '2026-10-07T02:00:00+00:00')

    def test_changed_endpoint_and_expired_cache_not_relabelled(self):
        old = previous()
        changed = {**SOURCE, 'url': 'https://different.org/rss'}
        result, _ = feeds.build_results([changed], [(report(changed, ok=False), [])], previous_feeds=old, now=NOW)
        self.assertEqual(result['candidateCount'], 0)
        old['items'][0]['date'] = '2020-01-01'
        result, _ = feeds.build_results([SOURCE], [(report(SOURCE, ok=False), [])], previous_feeds=old, now=NOW)
        self.assertEqual(result['candidateCount'], 0)
        self.assertEqual(result['excluded']['olderThan14Days'], 1)

    def test_changed_endpoint_does_not_inherit_prior_success_timestamp(self):
        changed = {**SOURCE, 'url': 'https://different.org/rss'}
        old_health = {'sources': [{'id': SOURCE['id'], 'url': SOURCE['url'], 'status': 'ok',
                                  'checkedAt': '2026-09-29T09:00:00Z', 'lastSuccessfulAt': '2026-10-06T09:00:00Z'}]}
        _, health = feeds.build_results([changed], [(report(changed, ok=False), [])],
                                       previous_feeds=previous(), previous_health=old_health, now=NOW)
        self.assertIsNone(health['sources'][0]['lastSuccessfulAt'])
        self.assertIsNone(health['sources'][0]['lastCachedFetchAt'])

    def test_duplicate_names_are_not_cache_identity(self):
        second = {**SOURCE, 'id': 's2', 'url': 'https://other.org/rss'}
        old = previous()
        old['reports'].append({'source': second['name'], 'url': second['url'], 'ok': True, 'items': 0})
        result, health = feeds.build_results([SOURCE, second], [(report(SOURCE, ok=False), []), (report(second, ok=False), [])], previous_feeds=old, now=NOW)
        self.assertEqual(result['candidateCount'], 1)
        self.assertEqual([row['cachedItems'] for row in health['sources']], [1, 0])

    def test_successful_empty_feed_does_not_keep_obsolete_source_cache(self):
        result, _ = feeds.build_results([SOURCE], [(report(SOURCE, raw=0, status='empty_feed'), [])], previous_feeds=previous(), now=NOW)
        self.assertEqual(result['candidateCount'], 0)
        self.assertEqual(result['cachedItemCount'], 0)

    def test_fresh_duplicate_wins_over_failed_source_cache(self):
        fresh_source = {**SOURCE, 'id': 's2', 'url': 'https://other.org/rss'}
        old = previous()
        new = parsed(fresh_source)
        old['items'][0]['doi'] = new[0]['doi'] = '10.1234/same'
        new[0]['summary'] = 'Fresh summary'
        result, _ = feeds.build_results([SOURCE, fresh_source], [(report(SOURCE, ok=False), []), (report(fresh_source), new)], previous_feeds=old, now=NOW)
        self.assertEqual(result['candidateCount'], 1)
        self.assertEqual(result['items'][0]['summary'], 'Fresh summary')
        self.assertEqual(result['cachedItemCount'], 0)

    def test_14_day_and_future_date_boundaries(self):
        item = {'date': (NOW - datetime.timedelta(days=14)).isoformat()}
        self.assertTrue(feeds.eligible(item, NOW)[0])
        item['date'] = (NOW - datetime.timedelta(days=14, microseconds=1)).isoformat()
        self.assertEqual(feeds.eligible(item, NOW), (False, 'olderThan14Days'))
        item['date'] = (NOW + datetime.timedelta(days=2)).isoformat()
        self.assertEqual(feeds.eligible(item, NOW), (False, 'future'))

    def test_no_permanent_source_filter_and_82_scope_stays_website_only(self):
        library = json.loads((feeds.ROOT / 'data/library.json').read_text())
        chosen = feeds.select_sources(library, all_sources=True)
        self.assertEqual(len(chosen), 82)
        self.assertEqual(sum(row['name'] == 'OpenAI News' for row in chosen), 1)
        # This API deliberately accepts no previous health selection input.
        self.assertEqual({row['url'] for row in chosen}, {row['url'] for row in library['feeds'] if row['enabled'] or row['name'] == 'OpenAI News'})

    def test_main_collects_once_and_writes_current_health_despite_old_blocked_status(self):
        library = json.loads((feeds.ROOT / 'data/library.json').read_text())
        chosen = feeds.select_sources(library, all_sources=True)
        observed = [(report(source, raw=0, status='empty_feed'), []) for source in chosen]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'data/library.json').write_text(json.dumps(library))
            (root / 'data/source-health.json').write_text(json.dumps({'checkedAt': '2026-09-29T00:00:00Z',
                'sources': [{'id': source['id'], 'status': 'http_error'} for source in chosen]}))
            with patch.object(feeds, 'ROOT', root), patch.object(feeds, 'collect', return_value=observed) as collector, patch('builtins.print'):
                self.assertEqual(feeds.main(['--all']), 0)
            self.assertEqual(collector.call_count, 1)
            self.assertEqual(len(collector.call_args.args[0]), 82)
            output = json.loads((root / 'data/source-health.json').read_text())
            self.assertEqual(len(output['sources']), 82)
            self.assertEqual(output['summary'], {'empty_feed': 82})
            self.assertNotEqual(output['checkedAt'], '2026-09-29T00:00:00Z')
            self.assertEqual({path.name for path in (root / 'data').iterdir()},
                             {'library.json', 'feeds.json', 'feeds.js', 'source-health.json', 'source-health.js'})

    def test_host_block_prevents_repeat_requests_but_reports_every_source(self):
        same = {**SOURCE, 'id': 's2', 'url': 'https://example.org/second'}
        seen = []
        def fixture(source):
            seen.append(source['id'])
            return report(source, ok=False, status='http_error', code=403), []
        collected = feeds.collect([SOURCE, same], fixture)
        self.assertEqual(seen, ['s1'])
        self.assertEqual(len(collected), 2)
        self.assertEqual(collected[1][0]['status'], 'not_checked_host_blocked')
        self.assertFalse(collected[1][0]['attempted'])
        self.assertIn('checkedAt', collected[1][0])

    def test_fetch_once_emits_strict_health_and_http200_non_feed_failure(self):
        class Response:
            headers = {'Content-Type': 'text/html'}
            def geturl(self): return SOURCE['url']
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def getcode(self): return 200
            def read(self, size):
                self.size = size
                return b'<html><body>Site Unavailable</body></html>'
        with patch('refresh_feeds.urllib.request.urlopen', return_value=Response()) as opener:
            current, items = feeds.fetch(SOURCE)
        self.assertEqual(opener.call_count, 1)
        self.assertEqual((current['status'], current['ok'], current['httpStatus']), ('not_feed', False, 200))
        self.assertEqual(items, [])
        self.assertEqual(current['failureReason'], 'html_instead_of_feed')

    def test_http200_access_challenge_stops_same_host_without_retry(self):
        same = {**SOURCE, 'id': 's2', 'url': 'https://example.org/second'}
        calls = []
        def get(source):
            calls.append(source['id'])
            return {**report(source, ok=False, status='not_feed', code=200),
                    'failureReason': 'publisher_access_challenge'}, []
        current = feeds.fetch_group([SOURCE, same], fetcher=get)
        self.assertEqual(calls, ['s1'])
        self.assertEqual(current[1][0]['status'], 'not_checked_host_blocked')
        self.assertEqual(current[1][0]['blockedReason'], 'publisher_access_challenge')

    def test_diagnostic_redirect_credentials_and_body_are_not_retained(self):
        class Response:
            headers = {'Content-Type': 'text/html; charset=utf-8'}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def getcode(self): return 200
            def geturl(self): return 'https://link.springer.com/journal/12933/articles?error=cookies_not_supported&code=private-secret'
            def read(self, size): return b'<html><title>Public landing page</title><body>private response text</body></html>'
        with patch('refresh_feeds.urllib.request.urlopen', return_value=Response()):
            current, _ = feeds.fetch(SOURCE)
        self.assertEqual(current['failureReason'], 'publisher_cookie_requirement')
        self.assertEqual(current['responseContentType'], 'text/html')
        self.assertNotIn('private-secret', json.dumps(current))
        self.assertNotIn('private response text', json.dumps(current))

    def test_publisher_verification_resource_stops_host_even_at_original_feed_url(self):
        class Response:
            headers = {'Content-Type': 'text/html; charset=utf-8'}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def getcode(self): return 200
            def geturl(self): return SOURCE['url']
            def read(self, size):
                return b'<!DOCTYPE html><html><img src="https://verify.nature.com/check?code=private-secret"/></html>'
        same = {**SOURCE, 'id': 's2', 'url': 'https://example.org/second'}
        with patch('refresh_feeds.urllib.request.urlopen', return_value=Response()) as opener:
            current = feeds.fetch_group([SOURCE, same])
        self.assertEqual(opener.call_count, 1)
        self.assertEqual(current[0][0]['failureReason'], 'publisher_access_challenge')
        self.assertEqual(current[0][0]['rootKind'], 'html')
        self.assertEqual(current[1][0]['status'], 'not_checked_host_blocked')
        self.assertNotIn('private-secret', json.dumps(current))
        self.assertNotIn('verify.nature.com', json.dumps(current))

    def test_cookie_failure_canonical_target_is_observed_without_following_it(self):
        raw = b'<html><link rel="canonical" href="https://www.nature.com/npjhealthsyst/?error=cookies_not_supported&amp;code=private-secret"/></html>'
        with patch('refresh_feeds.urllib.request.urlopen', side_effect=AssertionError('No follow-up request')):
            self.assertEqual(feeds.non_feed_reason(raw, SOURCE['url']), 'publisher_cookie_requirement')

    def test_verification_words_links_comments_and_lookalike_hosts_do_not_prove_challenge(self):
        for raw in (b'<html><p>verify.nature.com</p></html>',
                    b'<html><!-- <img src="https://verify.nature.com/check"> --></html>',
                    b'<html><a href="https://verify.nature.com/check">Reference</a></html>',
                    b'<html><img src="https://verify.nature.com.example.org/check"/></html>',
                    b'<html><![malformed html]></html>'):
            with self.subTest(raw=raw):
                self.assertEqual(feeds.non_feed_reason(raw, SOURCE['url']), 'html_instead_of_feed')

    def test_http_refusal_preserves_sanitized_final_endpoint_and_content_type_without_body_read(self):
        same = {**SOURCE, 'id': 's2', 'url': 'https://example.org/second'}
        failure = urllib.error.HTTPError('https://user:secret@example.org/refused?code=private-secret',
                                         403, 'Forbidden', {'Content-Type': 'text/html; charset=utf-8'}, None)
        with patch('refresh_feeds.urllib.request.urlopen', side_effect=failure) as opener:
            current = feeds.fetch_group([SOURCE, same])
        self.assertEqual(opener.call_count, 1)
        self.assertEqual(current[0][0]['responseContentType'], 'text/html')
        self.assertEqual(current[0][0]['responseUrl'], 'https://example.org/refused?code=<redacted>')
        self.assertEqual(current[1][0]['status'], 'not_checked_host_blocked')
        self.assertNotIn('secret', json.dumps(current))

    def test_filtered_zero_reports_actual_exclusion_reasons(self):
        items = parsed(date='2020-01-01') + parsed(link='https://example.org/two', date='')
        feeds_data, health = feeds.build_results([SOURCE], [(report(SOURCE, raw=3), items)], now=NOW)
        row = health['sources'][0]
        self.assertEqual(row['status'], 'filtered_empty')
        self.assertEqual(row['excludedItems'], {'undated': 1, 'future': 0, 'olderThan14Days': 1, 'unclassifiedOrInvalid': 1})
        self.assertTrue(row['latestPublishedAt'].startswith('2020-01-01'))

    def test_network_diagnostics_do_not_expose_proxy_url_or_secret_values(self):
        error = urllib.error.URLError('proxy https://user:secret@example.org?token=must-not-appear')
        with patch('refresh_feeds.urllib.request.urlopen', side_effect=error):
            current, _ = feeds.fetch(SOURCE)
        serialized = json.dumps(current)
        self.assertNotIn('secret', serialized)
        self.assertNotIn('must-not-appear', serialized)
        self.assertEqual(current['errorClass'], 'URLError')
        secret_source = {**SOURCE, 'url': 'https://user:secret@example.org/rss?token=must-not-appear'}
        with patch('refresh_feeds.urllib.request.urlopen') as opener:
            current, _ = feeds.fetch(secret_source)
        self.assertFalse(opener.called)
        self.assertNotIn('must-not-appear', json.dumps(current))

    def test_tunnel403_also_stops_host_without_logging_proxy_credentials(self):
        same = {**SOURCE, 'id': 's2', 'url': 'https://example.org/second'}
        error = urllib.error.URLError('Tunnel connection failed: 403 Forbidden https://user:secret@proxy.example')
        with patch('refresh_feeds.urllib.request.urlopen', side_effect=error) as opener:
            current = feeds.fetch_group([SOURCE, same])
        self.assertEqual(opener.call_count, 1)
        self.assertEqual(current[0][0]['code'], 403)
        self.assertEqual(current[1][0]['status'], 'not_checked_host_blocked')
        self.assertNotIn('secret', json.dumps(current))

    def test_audit_import_has_no_network_or_file_write(self):
        with (patch('refresh_feeds.urllib.request.urlopen', side_effect=AssertionError('Audit import must not fetch')),
              patch.object(Path, 'write_text', side_effect=AssertionError('Audit import must not write'))):
            import audit_sources
            importlib.reload(audit_sources)


if __name__ == '__main__':
    unittest.main()
