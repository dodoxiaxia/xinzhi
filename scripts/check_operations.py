#!/usr/bin/env python3
"""Bounded, read-only production checks; never request models or PDFs.

A passing check proves static reachability and configuration presence only.
Exact static hashes are checked only after a deployment from this build attempt.
No response bodies, credentials, URLs from responses, or raw exceptions are saved.
"""
import datetime
import hashlib
import http.client
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://learn.dryz.info'
REQUEST_TIMEOUT = 10
TOTAL_BUDGET_SECONDS = 45
STATIC_FILES = ('index.html', 'public.js', 'style.css', 'icon.svg')
BOOLEAN_FIELDS = ('hasKV', 'hasEndpoint', 'hasModel', 'hasApiKey',
                  'endpointValid', 'canGenerate')
RECENT_FAILURE_WINDOW = datetime.timedelta(hours=6)
DIAGNOSTIC_PHASES = frozenset(('configuration', 'budget', 'fetch', 'provider_http', 'provider_response'))
DIAGNOSTIC_CODES = frozenset((
    'response_received', 'request_timeout', 'transport_error', 'fetch_dns', 'fetch_tls',
    'fetch_connection', 'provider_network_error', 'model_redirect', 'endpoint_invalid',
    'endpoint_insecure', 'context_limit', 'output_json', 'output_truncated', 'output_shape',
    'output_empty', 'output_incomplete', 'output_blocked', 'provider_auth',
    'provider_rate_limit', 'provider_unavailable', 'provider_or_output_error',
    'provider_budget', 'budget_unavailable',
))
CONFIGURATION_CODES = frozenset(('endpoint_invalid', 'endpoint_insecure'))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Limit checks to the fixed production routes, including their response bodies."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(path, *, limit, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {'error': 'deadline_exceeded', 'type': 'budget'}
    request = urllib.request.Request(ORIGIN + path, method='GET', headers={
        'User-Agent': 'Xinzhi-Operations-ReadOnly/1', 'Accept-Encoding': 'identity',
    })
    try:
        with urllib.request.build_opener(NoRedirect()).open(
                request, timeout=min(REQUEST_TIMEOUT, remaining)) as response:
            status = response.status
            if not 200 <= status < 300:
                return {'error': 'http_error', 'type': 'http', 'httpStatus': status}
            pieces, count = [], 0
            while True:
                if time.monotonic() >= deadline:
                    return {'error': 'deadline_exceeded', 'type': 'budget', 'httpStatus': status}
                piece = response.read(min(64 * 1024, limit + 1 - count))
                if not piece:
                    return {'body': b''.join(pieces), 'httpStatus': status}
                pieces.append(piece)
                count += len(piece)
                if count > limit:
                    return {'error': 'response_too_large', 'type': 'protocol', 'httpStatus': status}
    except urllib.error.HTTPError as error:
        # HTTP errors contain arbitrary remote text; only retain the status number.
        status = error.code if type(error.code) is int and 100 <= error.code <= 599 else None
        error.close()
        return {'error': 'http_error', 'type': 'http', 'httpStatus': status}
    except (urllib.error.URLError, OSError, http.client.HTTPException):
        return {'error': 'network_error', 'type': 'network'}


def safe_timestamp(value):
    if not isinstance(value, str) or not 20 <= len(value) <= 35:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(datetime.timezone.utc).isoformat()
    except ValueError:
        return None


def sanitize_status(value):
    """Copy fixed metadata only; unrecognized diagnostic strings never reach reports."""
    if not isinstance(value, dict) or value.get('ok') is not True:
        return None
    if any(type(value.get(field)) is not bool for field in BOOLEAN_FIELDS):
        return None
    safe = {field: value[field] for field in BOOLEAN_FIELDS}
    configuration_error = value.get('configurationError')
    safe['configurationError'] = (configuration_error if isinstance(configuration_error, str) and configuration_error in CONFIGURATION_CODES
                                  else ('unknown_code' if configuration_error is not None else None))
    safe['lastDiagnostic'] = None
    diagnostic = value.get('lastDiagnostic')
    if isinstance(diagnostic, dict):
        phase, code = diagnostic.get('phase'), diagnostic.get('code')
        at = safe_timestamp(diagnostic.get('at'))
        if isinstance(phase, str) and phase in DIAGNOSTIC_PHASES and isinstance(code, str) and code in DIAGNOSTIC_CODES and at:
            safe_diagnostic = {'phase': phase, 'code': code, 'at': at}
            status = diagnostic.get('httpStatus')
            if status is None or type(status) is int and 100 <= status <= 599:
                safe_diagnostic['httpStatus'] = status
            elapsed = diagnostic.get('elapsedMs')
            if type(elapsed) is int and 0 <= elapsed <= 86400000:
                safe_diagnostic['elapsedMs'] = elapsed
            if type(diagnostic.get('timedOut')) is bool:
                safe_diagnostic['timedOut'] = diagnostic['timedOut']
            safe['lastDiagnostic'] = safe_diagnostic
    return safe


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, RecursionError):
        return None


def recent_provider_failure(diagnostic, now):
    """Only observed failures within six hours describe recent provider health."""
    if not diagnostic or diagnostic['code'] == 'response_received':
        return False
    occurred_at = datetime.datetime.fromisoformat(diagnostic['at'])
    age = now - occurred_at
    return datetime.timedelta(0) <= age <= RECENT_FAILURE_WINDOW


def check(root=ROOT):
    deadline = time.monotonic() + TOTAL_BUDGET_SECONDS
    now = datetime.datetime.now(datetime.timezone.utc)
    deployment = read_json(root / 'docs' / 'deployment-status.json') or {}
    build = deployment.get('build')
    current_build = isinstance(build, dict) and build.get('currentAttempt') is True
    deployed = deployment.get('deployed') is True and current_build
    report = {
        'checkedAt': now.isoformat(),
        'scope': 'static-and-configuration', 'status': 'healthy',
        'deployedThisAttempt': deployed, 'buildCurrentAttempt': current_build,
        'staticReachabilityVerified': False, 'staticContentVerified': False,
        'workerConfigurationPresenceVerified': False, 'cloudModelCallVerified': False,
        'modelGeneration': 'unknown', 'staticManifestVerification': 'skipped',
        'api': None, 'checks': [],
    }

    def record(stage, response=None, *, error=None, kind=None, file=None):
        response = response or {}
        error = error or response.get('error')
        kind = kind or response.get('type')
        status = ('unverified' if error in ('network_error', 'deadline_exceeded')
                  else 'degraded' if error else 'ok')
        item = {'stage': stage, 'status': status, 'error': error, 'type': kind}
        if file is not None:
            item['file'] = file
        http_status = response.get('httpStatus')
        if type(http_status) is int and 100 <= http_status <= 599:
            item['httpStatus'] = http_status
        report['checks'].append(item)
        return status

    home = fetch('/', limit=2 * 1024 * 1024, deadline=deadline)
    home_status = record('homepage', home, error='empty_response' if home.get('body') == b'' else None,
                         kind='protocol' if home.get('body') == b'' else None)
    report['staticReachabilityVerified'] = home_status == 'ok'
    api_response = fetch('/api/ai?task=status', limit=64 * 1024, deadline=deadline)
    if api_response.get('error'):
        record('api_status', api_response)
    else:
        try:
            api = sanitize_status(json.loads(api_response['body']))
        except (ValueError, TypeError, RecursionError):
            api = None
        report['api'] = api
        if api is None:
            record('api_status', api_response, error='invalid_status', kind='protocol')
        elif not all(api[field] for field in BOOLEAN_FIELDS if field != 'canGenerate') or api['configurationError'] is not None:
            record('api_status', api_response, error='configuration_missing', kind='configuration')
        else:
            report['workerConfigurationPresenceVerified'] = True
            if not api['canGenerate']:
                record('api_status', api_response, error='generation_disabled', kind='configuration')
            elif recent_provider_failure(api['lastDiagnostic'], now):
                record('api_status', api_response, error='provider_recent_failure', kind='provider')
            else:
                record('api_status', api_response)

    if deployed:
        manifest = read_json(root / 'docs' / 'public-manifest.json')
        rows = manifest.get('files') if manifest else None
        expected = {}
        if isinstance(rows, list):
            for row in rows:
                if isinstance(row, dict) and row.get('path') in STATIC_FILES:
                    sha = row.get('sha256')
                    if isinstance(sha, str) and len(sha) == 64 and all(char in '0123456789abcdef' for char in sha):
                        expected[row['path']] = sha
        if len(expected) != len(STATIC_FILES):
            record('manifest', error='manifest_invalid', kind='integrity')
            report['staticManifestVerification'] = 'failed'
        else:
            hashes = []
            for name in STATIC_FILES:
                response = home if name == 'index.html' else fetch('/' + name, limit=16 * 1024 * 1024, deadline=deadline)
                mismatch = not response.get('error') and hashlib.sha256(response['body']).hexdigest() != expected[name]
                hashes.append(record('static_hash', response, error='hash_mismatch' if mismatch else None,
                                     kind='integrity' if mismatch else None, file=name))
            report['staticContentVerified'] = all(status == 'ok' for status in hashes)
            report['staticManifestVerification'] = ('verified' if report['staticContentVerified'] else
                                                    'failed' if 'degraded' in hashes else 'unverified')
    else:
        report['checks'].append({'stage': 'manifest', 'status': 'skipped',
                                 'error': None, 'type': None, 'reason': 'no_current_deployment'})
    statuses = {item['status'] for item in report['checks']}
    report['status'] = 'degraded' if 'degraded' in statuses else 'unverified' if 'unverified' in statuses else 'healthy'
    return report


def main():
    report = check(ROOT)
    destination = ROOT / 'docs' / 'operations-health.json'
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    # Printing a fixed summary is safe even if remote data is malformed or hostile.
    print(json.dumps({key: report[key] for key in ('status', 'scope', 'staticManifestVerification', 'cloudModelCallVerified')}))
    return 0 if report['status'] == 'healthy' else 1


if __name__ == '__main__':
    raise SystemExit(main())
