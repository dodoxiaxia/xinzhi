"""Offline generation checks: synthetic responses only, never real credentials."""
import contextlib
import io
import json
import os
import stat
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import generate_drafts as generation


SOURCE = 'The study includes ten patient records. '
FAKE_KEY = 'synthetic-test-key-never-real'


def valid_payload():
    return {
        'title_zh': '中文题名', 'summary': '研究摘要', 'limitations': '尚需验证',
        'study_type': '观察研究', 'learning_question': '能否迁移？',
        'claims': [{'claim': 'Ten records', 'support_quote': 'ten patient records'}],
        'source_checked': True, 'reviewer': 'pretend reviewer', 'status': 'published',
    }


def article(article_id='synthetic-1'):
    return {
        'id': article_id, 'title': 'A synthetic article', 'journal': 'Test journal',
        'date': '2026-09-30', 'url': 'https://example.test/' + article_id,
        'summary': SOURCE * 6, 'summary_truncated': False,
    }


def envelope(payload=None, finish_reason='stop'):
    return {
        'choices': [{'finish_reason': finish_reason,
                     'message': {'content': json.dumps(payload or valid_payload(), ensure_ascii=False)}}],
        'usage': {'prompt_tokens': 123, 'completion_tokens': 45, 'total_tokens': 168},
    }


class Response:
    status = 200

    def __init__(self, body):
        self.body = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()

    def read(self, limit):
        return self.body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class ErrorAssertions:
    def assert_code(self, code, function, *args):
        with self.assertRaises(generation.GenerationError) as caught:
            function(*args)
        self.assertEqual(caught.exception.code, code)


class DraftValidation(ErrorAssertions, unittest.TestCase):
    def test_provider_cannot_mark_reviewed_or_published(self):
        payload = valid_payload()
        payload['claims'][0]['reviewer'] = 'pretend reviewer'
        result = generation.validate(payload, SOURCE)
        self.assertFalse(result['source_checked'])
        self.assertEqual(result['reviewer'], '')
        self.assertEqual(result['status'], 'draft')
        self.assertEqual(set(result['claims'][0]), {'claim', 'support_quote'})

    def test_unmatched_evidence_rejected(self):
        self.assert_code('unsupported_quote', generation.validate, valid_payload(), 'Unrelated abstract')

    def test_empty_claims_rejected(self):
        payload = valid_payload()
        payload['claims'] = []
        self.assert_code('missing_evidence', generation.validate, payload, SOURCE)

    def test_missing_empty_or_nonstring_fields_rejected(self):
        for field in generation.FIELDS:
            for value in (None, 123, '', ' \n '):
                with self.subTest(field=field, value=value):
                    payload = valid_payload()
                    payload[field] = value
                    self.assert_code('invalid_field', generation.validate, payload, SOURCE)

    def test_field_length_counts_trimmed_content(self):
        payload = valid_payload()
        payload['summary'] = ' \n' + '中' * 4000 + '\n '
        self.assertEqual(len(generation.validate(payload, SOURCE)['summary']), 4000)
        payload['summary'] = '中' * 4001
        self.assert_code('field_too_long', generation.validate, payload, SOURCE)

    def test_only_quote_outer_whitespace_is_removed(self):
        payload = valid_payload()
        payload['claims'][0]['support_quote'] = '\n  ten patient records  \n'
        result = generation.validate(payload, SOURCE)
        self.assertEqual(result['claims'][0]['support_quote'], 'ten patient records')
        for quote in ('Ten patient records', 'ten  patient records', 'ten\npatient records',
                      'ten patient Records', 'ten ... patient records', 'ten records'):
            with self.subTest(quote=quote):
                payload['claims'][0]['support_quote'] = quote
                self.assert_code('unsupported_quote', generation.validate, payload, SOURCE)

    def test_quote_length_boundary_and_no_title_evidence(self):
        payload = valid_payload()
        payload['claims'][0]['support_quote'] = '12345678'
        generation.validate(payload, 'Source contains 12345678 here.')
        payload['claims'][0]['support_quote'] = '1234567'
        self.assert_code('invalid_quote_length', generation.validate, payload, '1234567')
        payload['claims'][0]['support_quote'] = payload['title_zh'] = 'Only present in title'
        self.assert_code('unsupported_quote', generation.validate, payload, SOURCE)

    def test_malformed_empty_or_unbounded_claims_rejected(self):
        for claims, code in (
            ([None], 'malformed_claim'),
            ([{'claim': 1, 'support_quote': 'ten patient records'}], 'malformed_claim'),
            ([{'claim': '  ', 'support_quote': 'ten patient records'}], 'invalid_claim'),
            ([{'claim': 'x' * 4001, 'support_quote': 'ten patient records'}], 'invalid_claim'),
            ([{'claim': 'x', 'support_quote': 'x' * 4001}], 'invalid_quote_length'),
            (valid_payload()['claims'] * 13, 'too_many_claims'),
        ):
            with self.subTest(code=code):
                payload = valid_payload()
                payload['claims'] = claims
                self.assert_code(code, generation.validate, payload, SOURCE)


class ContentParsing(ErrorAssertions, unittest.TestCase):
    def test_single_json_fence_and_text_blocks_supported(self):
        text = json.dumps(valid_payload(), ensure_ascii=False)
        for content in (text, '\ufeff' + text, '```json\n' + text + '\n```',
                        [{'type': 'text', 'text': text[:30]}, {'type': 'text', 'text': text[30:]}]):
            with self.subTest(content_type=type(content).__name__):
                result = generation.validate(generation.parse_content(content), SOURCE)
                self.assertEqual(result['status'], 'draft')

    def test_invalid_json_and_ambiguous_objects_rejected(self):
        for text in ('{', '{} {}', 'Here is your draft: {}', '```json\n{}\n``` extra',
                     '{"summary":"one","summary":"two"}', '{"number":NaN}'):
            with self.subTest(text=text):
                self.assert_code('invalid_json', generation.parse_content, text)

    def test_empty_or_nontext_content_rejected(self):
        for content, code in ((None, 'missing_content'), ('  ', 'missing_content'),
                              ([], 'invalid_content'), ([{'type': 'image', 'text': '{}'}], 'invalid_content')):
            with self.subTest(content=content):
                self.assert_code(code, generation.parse_content, content)
        for text in ('[]', 'null'):
            self.assert_code('invalid_payload', generation.validate, generation.parse_content(text), SOURCE)


class ResponseHandling(unittest.TestCase):
    def call_response(self, response):
        diagnostic = {}
        with patch.object(generation.urllib.request, 'urlopen', return_value=Response(response)) as mocked:
            result = generation.call('https://example.test/chat/completions', FAKE_KEY,
                                     'glm-5.3-flash', article(), diagnostic)
        return result, diagnostic, mocked

    def test_success_bounded_request_and_safe_usage(self):
        response = envelope()
        response['usage']['api_key'] = 'discarded-secret'
        response['usage']['prompt_tokens_details'] = {'cached_tokens': 4, 'private': 'discarded'}
        (draft, usage), diagnostic, mocked = self.call_response(response)
        self.assertEqual(draft['status'], 'draft')
        self.assertEqual(usage['prompt_tokens_details'], {'cached_tokens': 4})
        self.assertNotIn('api_key', usage)
        request = mocked.call_args.args[0]
        body = json.loads(request.data)
        self.assertEqual(body['reasoning_effort'], 'low')
        self.assertEqual(body['max_tokens'], 2400)
        self.assertEqual(diagnostic['finish_reason'], 'stop')
        self.assertEqual(diagnostic['stage'], 'complete')
        self.assertNotIn('Authorization', json.dumps(diagnostic))

    def test_truncated_valid_json_never_becomes_a_draft(self):
        diagnostic = {}
        with patch.object(generation.urllib.request, 'urlopen', return_value=Response(envelope(finish_reason='length'))):
            with self.assertRaises(generation.GenerationError) as caught:
                generation.call('https://example.test/', FAKE_KEY, 'glm-5.3-flash', article(), diagnostic)
        self.assertEqual(caught.exception.code, 'output_truncated')
        self.assertEqual(diagnostic['finish_reason'], 'length')
        self.assertIn('response_body', diagnostic)

    def test_response_schema_size_and_encoding_classified(self):
        cases = (
            ({}, 'invalid_response_schema'),
            ({'choices': []}, 'invalid_response_schema'),
            ({'choices': [{'message': {}}]}, 'missing_content'),
            ({'choices': [{'message': None}]}, 'invalid_response_schema'),
            (b'{', 'invalid_response_json'),
            (b'\xff', 'invalid_response_encoding'),
            (b'x' * (generation.MAX_RESPONSE_BYTES + 1), 'response_too_large'),
        )
        for response, code in cases:
            with self.subTest(code=code):
                diagnostic = {}
                with patch.object(generation.urllib.request, 'urlopen', return_value=Response(response)):
                    with self.assertRaises(generation.GenerationError) as caught:
                        generation.call('https://example.test/', FAKE_KEY, 'glm-5.3-flash', article(), diagnostic)
                self.assertEqual(caught.exception.code, code)
                self.assertLessEqual(diagnostic['response_bytes_saved'], generation.MAX_RESPONSE_BYTES)

    def test_http_error_body_is_redacted_and_not_in_error_message(self):
        body = json.dumps({'api_key': FAKE_KEY, 'access_token': 'other-test-token',
                           'error': 'Bearer other-test-auth'}).encode()
        failure = urllib.error.HTTPError('https://example.test/', 401, FAKE_KEY, {}, io.BytesIO(body))
        diagnostic = {}
        with patch.object(generation.urllib.request, 'urlopen', side_effect=failure):
            with self.assertRaises(generation.GenerationError) as caught:
                generation.call('https://example.test/', FAKE_KEY, 'glm-5.3-flash', article(), diagnostic)
        self.assertEqual(caught.exception.code, 'authentication_error')
        saved = json.dumps(diagnostic)
        for secret in (FAKE_KEY, 'other-test-token', 'other-test-auth'):
            self.assertNotIn(secret, saved)
            self.assertNotIn(secret, str(caught.exception))

    def test_transport_error_text_is_not_logged(self):
        diagnostic = {}
        with patch.object(generation.urllib.request, 'urlopen', side_effect=urllib.error.URLError(FAKE_KEY)):
            with self.assertRaises(generation.GenerationError) as caught:
                generation.call('https://example.test/', FAKE_KEY, 'glm-5.3-flash', article(), diagnostic)
        self.assertEqual(caught.exception.code, 'transport_error')
        self.assertNotIn(FAKE_KEY, json.dumps(diagnostic) + str(caught.exception))


class GenerationFlow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.input = self.root / 'candidates.json'
        self.input.write_text(json.dumps({'items': [article(), article('synthetic-2')]}))
        self.output = self.root / '.local/model-drafts'
        self.root_patch = patch.object(generation, 'ROOT', self.root)
        self.root_patch.start()
        self.env_patch = patch.dict(os.environ, {
            'XINZHI_LLM_ENDPOINT': 'https://example.test/chat/completions',
            'XINZHI_LLM_API_KEY': FAKE_KEY, 'XINZHI_LLM_MODEL': 'glm-5.3-flash',
        }, clear=True)
        self.env_patch.start()

    def tearDown(self):
        self.env_patch.stop()
        self.root_patch.stop()
        self.temp.cleanup()

    def args(self, *extra):
        return ['--input', str(self.input), '--output', str(self.output), '--limit', '2', *extra]

    def test_dry_run_does_not_call_model_or_create_private_files(self):
        with patch.object(generation.urllib.request, 'urlopen') as mocked, contextlib.redirect_stdout(io.StringIO()) as out:
            generation.main(self.args('--article-id', 'synthetic-2'))
        mocked.assert_not_called()
        self.assertEqual(json.loads(out.getvalue())['articles'], ['synthetic-2'])
        self.assertFalse(self.output.exists())

    def test_failure_saves_private_diagnostic_and_stops_before_second_article(self):
        payload = valid_payload()
        payload['claims'][0]['support_quote'] = 'Invented evidence'
        payload['debug'] = FAKE_KEY
        with patch.object(generation.urllib.request, 'urlopen', return_value=Response(envelope(payload))) as mocked:
            with self.assertRaises(SystemExit) as caught:
                generation.main(self.args('--call-model'))
        self.assertEqual(mocked.call_count, 1)
        self.assertIn('unsupported_quote', str(caught.exception))
        self.assertNotIn(FAKE_KEY, str(caught.exception))
        receipts = [json.loads(line) for line in (self.output / 'receipts.jsonl').read_text().splitlines()]
        self.assertEqual([receipt['state'] for receipt in receipts], ['started', 'failed'])
        self.assertEqual(receipts[-1]['error_code'], 'unsupported_quote')
        diagnostic_path = self.output / receipts[-1]['diagnostic_file']
        diagnostic = json.loads(diagnostic_path.read_text())
        self.assertEqual(diagnostic['stage'], 'draft_validation')
        self.assertIn('Invented evidence', diagnostic['response_body'])
        self.assertNotIn(FAKE_KEY, diagnostic_path.read_text())
        self.assertEqual(stat.S_IMODE(diagnostic_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.output / 'receipts.jsonl').stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.output / 'diagnostics').stat().st_mode), 0o700)
        self.assertEqual(list(self.output.glob('*.json')), [])

    def test_exact_article_success_is_private_unreviewed_and_skipped_next_run(self):
        with patch.object(generation.urllib.request, 'urlopen', return_value=Response(envelope())) as mocked, contextlib.redirect_stdout(io.StringIO()):
            generation.main(self.args('--article-id', 'synthetic-2', '--call-model'))
            generation.main(self.args('--article-id', 'synthetic-2', '--call-model'))
        self.assertEqual(mocked.call_count, 1)
        drafts = list(self.output.glob('*.json'))
        self.assertEqual(len(drafts), 1)
        saved = json.loads(drafts[0].read_text())
        self.assertEqual(saved['article_id'], 'synthetic-2')
        self.assertFalse(saved['draft']['source_checked'])
        self.assertEqual(saved['draft']['status'], 'draft')
        self.assertEqual(stat.S_IMODE(drafts[0].stat().st_mode), 0o600)

    def test_public_output_and_symlinks_rejected_without_calls(self):
        with patch.object(generation.urllib.request, 'urlopen') as mocked, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                generation.main(['--input', str(self.input), '--output', str(self.root / 'public'), '--call-model'])
            self.root.joinpath('.local').mkdir()
            self.root.joinpath('.local/model-drafts').symlink_to(self.root / 'public')
            with self.assertRaises(SystemExit):
                generation.main(self.args('--call-model'))
        mocked.assert_not_called()

    def test_ineligible_article_never_called(self):
        item = article()
        item['summary_truncated'] = True
        self.input.write_text(json.dumps({'items': [item]}))
        with patch.object(generation.urllib.request, 'urlopen') as mocked, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                generation.main(self.args('--article-id', item['id'], '--call-model'))
        mocked.assert_not_called()


if __name__ == '__main__':
    unittest.main()
