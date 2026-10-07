"""Offline production smoke fixtures; no public requests or credential use."""
import hashlib
import datetime
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import check_operations as operations


class OperationsFixtures(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'docs').mkdir()
        self.assets = {name: ('production: ' + name).encode() for name in operations.STATIC_FILES}
        self.api = {'ok': True, **{field: True for field in operations.BOOLEAN_FIELDS},
                    'configurationError': None, 'lastDiagnostic': None}
        self.write_deployment(False)
        self.write_manifest()
        self.calls = []
        for target in ('socket.socket.connect', 'socket.create_connection'):
            guard = patch(target, side_effect=AssertionError('Fixture must not access network'))
            guard.start()
            self.addCleanup(guard.stop)

    def write_deployment(self, deployed, current=True):
        (self.root / 'docs' / 'deployment-status.json').write_text(json.dumps({
            'deployed': deployed, 'build': {'currentAttempt': current},
        }))

    def write_manifest(self):
        (self.root / 'docs' / 'public-manifest.json').write_text(json.dumps({'files': [
            {'path': name, 'sha256': hashlib.sha256(body).hexdigest()} for name, body in self.assets.items()
        ]}))

    def fetch(self, path, **kwargs):
        self.calls.append(path)
        if path == '/api/ai?task=status':
            return {'httpStatus': 200, 'body': json.dumps(self.api).encode()}
        return {'httpStatus': 200, 'body': self.assets['index.html' if path == '/' else path[1:]]}

    def invoke(self, fetch=None):
        with patch.object(operations, 'fetch', side_effect=fetch or self.fetch):
            return operations.check(self.root)

    def test_undeployed_candidate_is_not_compared_to_live_assets(self):
        self.assets['public.js'] = b'new local timestamps differing from production'
        report = self.invoke()
        self.assertEqual(report['status'], 'healthy')
        self.assertEqual(self.calls, ['/', '/api/ai?task=status'])
        self.assertEqual(report['staticManifestVerification'], 'skipped')
        self.assertFalse(report['staticContentVerified'])
        self.assertFalse(report['cloudModelCallVerified'])
        self.assertEqual(report['modelGeneration'], 'unknown')

    def test_old_build_is_not_compared_even_when_deployed_flag_is_true(self):
        self.write_deployment(True, current=False)
        report = self.invoke()
        self.assertEqual(report['staticManifestVerification'], 'skipped')
        self.assertFalse(report['deployedThisAttempt'])
        self.assertEqual(self.calls, ['/', '/api/ai?task=status'])

    def test_current_deployment_verifies_four_exact_static_hashes(self):
        self.write_deployment(True)
        report = self.invoke()
        self.assertEqual(report['status'], 'healthy')
        self.assertTrue(report['staticContentVerified'])
        self.assertEqual(report['staticManifestVerification'], 'verified')
        self.assertEqual(self.calls, ['/', '/api/ai?task=status', '/public.js', '/style.css', '/icon.svg'])
        self.assertEqual([item['file'] for item in report['checks'] if item['stage'] == 'static_hash'], list(operations.STATIC_FILES))

    def test_hash_mismatch_is_degraded(self):
        self.write_deployment(True)
        self.assets['public.js'] = b'outdated production'
        report = self.invoke()
        self.assertEqual(report['status'], 'degraded')
        self.assertEqual(report['staticManifestVerification'], 'failed')
        self.assertFalse(report['staticContentVerified'])
        self.assertIn('hash_mismatch', {item['error'] for item in report['checks']})

    def test_current_deployment_with_missing_hash_is_degraded(self):
        self.write_deployment(True)
        (self.root / 'docs' / 'public-manifest.json').write_text('{"files": []}')
        report = self.invoke()
        self.assertEqual(report['status'], 'degraded')
        self.assertEqual(report['staticManifestVerification'], 'failed')
        self.assertIn('manifest_invalid', {item['error'] for item in report['checks']})

    def test_network_block_is_unverified_not_reported_as_outage(self):
        report = self.invoke(lambda *args, **kwargs: {'error': 'network_error', 'type': 'network'})
        self.assertEqual(report['status'], 'unverified')
        self.assertFalse(report['staticReachabilityVerified'])
        self.assertEqual({item['error'] for item in report['checks'] if item['status'] != 'skipped'}, {'network_error'})

    def test_configuration_missing_is_degraded(self):
        self.api['hasKV'] = False
        report = self.invoke()
        self.assertEqual(report['status'], 'degraded')
        self.assertFalse(report['workerConfigurationPresenceVerified'])
        self.assertIn('configuration_missing', {item['error'] for item in report['checks']})

    def diagnostic(self, code, age=datetime.timedelta(minutes=10)):
        return {'phase': 'provider_http', 'code': code,
                'at': (datetime.datetime.now(datetime.timezone.utc) - age).isoformat(),
                'httpStatus': 401 if code == 'provider_auth' else 200,
                'elapsedMs': 200, 'timedOut': False}

    def test_recent_provider_failure_is_degraded_with_safe_diagnostic(self):
        for code in ('provider_auth', 'transport_error', 'provider_rate_limit', 'output_shape'):
            with self.subTest(code=code):
                self.api['lastDiagnostic'] = self.diagnostic(code)
                report = self.invoke()
                self.assertEqual(report['status'], 'degraded')
                self.assertTrue(report['workerConfigurationPresenceVerified'])
                self.assertEqual(report['checks'][1]['error'], 'provider_recent_failure')
                self.assertEqual(report['checks'][1]['type'], 'provider')
                self.assertEqual(report['api']['lastDiagnostic']['code'], code)
                self.assertEqual(report['modelGeneration'], 'unknown')

    def test_expired_and_future_failures_do_not_describe_current_failure(self):
        for age in (datetime.timedelta(hours=7), datetime.timedelta(hours=-1)):
            with self.subTest(age=age):
                self.api['lastDiagnostic'] = self.diagnostic('provider_auth', age)
                report = self.invoke()
                self.assertEqual(report['status'], 'healthy')
                self.assertEqual(report['api']['lastDiagnostic']['code'], 'provider_auth')

    def test_recent_response_received_does_not_prove_model_generation(self):
        self.api['lastDiagnostic'] = self.diagnostic('response_received')
        report = self.invoke()
        self.assertEqual(report['status'], 'healthy')
        self.assertFalse(report['cloudModelCallVerified'])
        self.assertEqual(report['modelGeneration'], 'unknown')

    def test_generation_disabled_has_distinct_error_from_missing_configuration(self):
        self.api['canGenerate'] = False
        report = self.invoke()
        self.assertEqual(report['status'], 'degraded')
        self.assertTrue(report['workerConfigurationPresenceVerified'])
        self.assertEqual(report['checks'][1]['error'], 'generation_disabled')
        self.assertNotIn('configuration_missing', {item['error'] for item in report['checks']})

    def test_api_http_failure_is_degraded(self):
        def fetch(path, **kwargs):
            return {'error': 'http_error', 'type': 'http', 'httpStatus': 503} if path.startswith('/api/') else self.fetch(path, **kwargs)
        report = self.invoke(fetch)
        self.assertEqual(report['status'], 'degraded')
        self.assertEqual(report['checks'][1]['httpStatus'], 503)

    def test_error_and_response_fields_are_allowlisted(self):
        secret = 'SECRET-https://username:password@example.org?api_key=private'
        self.api.update(endpoint=secret, rawResponse=secret, note=secret,
                        configurationError=secret, lastDiagnostic={
                            'phase': 'fetch', 'code': 'transport_error',
                            'at': '2026-10-07T12:00:00.000Z', 'httpStatus': 503,
                            'elapsedMs': 200, 'timedOut': False, 'error': secret,
                            'requestId': secret, 'endpoint': secret,
                        })
        report = self.invoke()
        self.assertNotIn(secret, json.dumps(report))
        self.assertEqual(report['api']['configurationError'], 'unknown_code')
        self.assertEqual(set(report['api']['lastDiagnostic']), {'phase', 'code', 'at', 'httpStatus', 'elapsedMs', 'timedOut'})
        self.api['lastDiagnostic']['code'] = secret
        self.assertIsNone(self.invoke()['api']['lastDiagnostic'])

    def test_invalid_api_shapes_are_degraded_and_do_not_expose_payload(self):
        for api in ({'ok': True}, {'ok': True, **self.api, 'hasKV': 'secret'}, ['secret']):
            self.api = api
            report = self.invoke()
            self.assertEqual(report['status'], 'degraded')
            self.assertIsNone(report['api'])
            self.assertNotIn('secret', json.dumps(report))

    def test_non_scalar_configuration_error_is_replaced_with_fixed_code(self):
        self.api['configurationError'] = {'secret': 'SECRET-key'}
        report = self.invoke()
        self.assertEqual(report['status'], 'degraded')
        self.assertEqual(report['api']['configurationError'], 'unknown_code')
        self.assertNotIn('SECRET-key', json.dumps(report))

    def test_excessively_nested_api_json_is_degraded_without_body(self):
        def fetch(path, **kwargs):
            return {'httpStatus': 200, 'body': b'[' * 2000 + b'0' + b']' * 2000} if path.startswith('/api/') else self.fetch(path, **kwargs)
        report = self.invoke(fetch)
        self.assertEqual(report['status'], 'degraded')
        self.assertIsNone(report['api'])
        self.assertEqual(report['checks'][1]['error'], 'invalid_status')

    def test_report_written_before_failure_exit(self):
        with patch.object(operations, 'ROOT', self.root), patch.object(operations, 'fetch', return_value={'error': 'network_error', 'type': 'network'}), patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(operations.main(), 1)
        report = json.loads((self.root / 'docs' / 'operations-health.json').read_text())
        self.assertEqual(report['status'], 'unverified')

    def test_transport_exception_is_never_recorded(self):
        with patch('urllib.request.OpenerDirector.open', side_effect=urllib.error.URLError('SECRET-key')):
            value = operations.fetch('/', limit=100, deadline=operations.time.monotonic() + 10)
        self.assertEqual(value, {'error': 'network_error', 'type': 'network'})

    def test_http_exception_retains_only_safe_numeric_status(self):
        error = urllib.error.HTTPError(operations.ORIGIN, 503, 'SECRET-body', {}, io.BytesIO(b'SECRET-body'))
        with patch('urllib.request.OpenerDirector.open', side_effect=error):
            value = operations.fetch('/', limit=100, deadline=operations.time.monotonic() + 10)
        self.assertEqual(value, {'error': 'http_error', 'type': 'http', 'httpStatus': 503})

    def test_requests_have_read_only_method_and_bounded_timeout(self):
        class Response(io.BytesIO):
            status = 200
        with patch('urllib.request.OpenerDirector.open', return_value=Response(b'hello')) as opened:
            response = operations.fetch('/api/ai?task=status', limit=100, deadline=operations.time.monotonic() + 100)
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, 'https://learn.dryz.info/api/ai?task=status')
        self.assertEqual(request.get_method(), 'GET')
        self.assertLessEqual(opened.call_args.kwargs['timeout'], 10)
        self.assertEqual(response['body'], b'hello')

    def test_size_and_time_budgets_fail_without_body(self):
        class Response(io.BytesIO):
            status = 200
        with patch('urllib.request.OpenerDirector.open', return_value=Response(b'SECRET-too-large')):
            response = operations.fetch('/', limit=2, deadline=operations.time.monotonic() + 10)
        self.assertEqual(response['error'], 'response_too_large')
        self.assertNotIn('body', response)
        response = operations.fetch('/', limit=100, deadline=operations.time.monotonic() - 1)
        self.assertEqual(response, {'error': 'deadline_exceeded', 'type': 'budget'})


if __name__ == '__main__':
    unittest.main()
