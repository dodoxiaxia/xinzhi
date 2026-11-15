#!/usr/bin/env python3
"""Fail-closed gates and official-bundle binder for deploy-only-verified CI.

This script enforces three-way verification across:
1. Official daily-refresh GitHub Actions run receipt (pipeline-final artifact)
2. Immutable private state commit export (exact 19-file public/ bytes + sha256)
3. Live Cloudflare Pages production state (canonical == latest, commit_hash,
   D1_BACKFILL_ENABLED setting, and 17 live static asset fingerprints)

It never builds, refreshes, modifies D1_BACKFILL_ENABLED, writes to state,
reads config/deploy-only-verified-public.json as an authority, or prints credentials.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

PINNED_STATE_REPOSITORY = 'dodoxiaxia/xinzhi-state'
PINNED_PAGES_PROJECT = 'dryz-xinzhi'
PINNED_PRODUCTION_BRANCH = 'main'
PINNED_PRODUCTION_URL = 'https://learn.dryz.info'
EXPECTED_CONFIRM = 'publish-official-bound-bundle'
ALLOWED_PURPOSES = frozenset(('open', 'close'))
REQUIRED_FILE_COUNT = 19
SPECIAL_NON_STATIC_PATHS = frozenset(('_worker.js', '_headers'))
REQUIRED_STATIC_FILE_COUNT = REQUIRED_FILE_COUNT - len(SPECIAL_NON_STATIC_PATHS)

DAILY_WORKFLOW_PATH = '.github/workflows/daily.yml'
DAILY_WORKFLOW_NAME = 'daily-refresh'
DEPLOY_ONLY_WORKFLOW_PATH = '.github/workflows/deploy-only-verified.yml'
DEPLOY_ONLY_WORKFLOW_NAME = 'deploy-only-verified'

ALLOWED_MAIN_DIFF_PATHS = frozenset((
    '.github/workflows/deploy-only-verified.yml',
    'scripts/deploy_only_verified.py',
    'scripts/test_deploy_only_verified.py',
    'docs/deploy-only-verified.md',
))

TERMINAL_CF_STAGES = frozenset(('success', 'failure', 'canceled', 'skipped'))
ACTIVE_GH_STATUSES = ('in_progress', 'queued', 'waiting', 'pending', 'requested')
GH_RUNS_PER_PAGE = 30
GH_RUNS_MAX_PAGES = 10
GH_DISCOVER_PER_PAGE = 100
GH_DISCOVER_MAX_PAGES = 10
GH_ARTIFACTS_PER_PAGE = 100
GH_ARTIFACTS_MAX_PAGES = 10
CF_DEPLOYS_PER_PAGE = 25
CF_DEPLOYS_MAX_PAGES = 20
STATE_HISTORY_MAX_COMMITS = 50
MAX_RECEIPT_BYTES = 10 * 1024 * 1024

SHA40_RE = re.compile(r'^[0-9a-f]{40}$')
SHA64_RE = re.compile(r'^[0-9a-f]{64}$')
RUN_ID_RE = re.compile(r'^[1-9][0-9]*$')
REPO_RE = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')


class GateError(RuntimeError):
    """Raised when any fail-closed verification gate rejects deployment."""


def _reject_control_or_traversal(value, label):
    if not isinstance(value, str) or not value:
        raise GateError(f'invalid {label}: must be a non-empty string')
    if value != value.strip():
        raise GateError(f'invalid {label}: leading or trailing whitespace is not allowed')
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
        raise GateError(f'invalid {label}: control characters are not allowed')
    if '..' in value or '\\' in value or '://' in value:
        raise GateError(f'invalid {label}: path traversal or URL syntax is not allowed')


def validate_safe_relpath(rel):
    """Validate a clean POSIX relative path without traversal or symlinks."""
    _reject_control_or_traversal(rel, 'relative path')
    if rel.startswith('/'):
        raise GateError(f'invalid relative path: absolute path is not allowed: {rel}')
    parts = rel.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise GateError(f'invalid relative path segment in: {rel}')
    return '/'.join(parts)


def validate_sha40(value, label):
    if not isinstance(value, str) or not SHA40_RE.fullmatch(value):
        raise GateError(f'invalid {label}: expected 40-char lowercase hex SHA')
    return value


def validate_sha64(value, label):
    if not isinstance(value, str) or not SHA64_RE.fullmatch(value):
        raise GateError(f'invalid {label}: expected 64-char lowercase hex sha256')
    return value


def validate_run_id(value, label='daily_run_id'):
    if isinstance(value, bool):
        raise GateError(f'invalid {label}: boolean is not allowed')
    if isinstance(value, int):
        if value <= 0:
            raise GateError(f'invalid {label}: must be a positive integer')
        return value
    _reject_control_or_traversal(value, label)
    if not RUN_ID_RE.fullmatch(value):
        raise GateError(f'invalid {label}: must be a positive integer without leading zeros')
    return int(value)


def validate_github_repo(value, label='github_repo'):
    _reject_control_or_traversal(value, label)
    if not REPO_RE.fullmatch(value):
        raise GateError(f'invalid {label}: expected owner/repo format')
    return value


def validate_purpose(purpose):
    _reject_control_or_traversal(purpose, 'purpose')
    if purpose not in ALLOWED_PURPOSES:
        raise GateError(f'invalid purpose: expected one of {sorted(ALLOWED_PURPOSES)}')
    return purpose


def validate_inputs(
    purpose,
    confirm,
    daily_run_id,
    state_commit,
    *,
    state_repo=None,
    github_repo=None,
    github_ref=None,
    event_name=None,
):
    """Validate workflow_dispatch inputs and execution context strictly."""
    validate_purpose(purpose)

    _reject_control_or_traversal(confirm, 'confirm')
    if confirm != EXPECTED_CONFIRM:
        raise GateError('invalid confirm literal: does not match required confirmation token')

    parsed_run_id = validate_run_id(daily_run_id, 'daily_run_id')
    _reject_control_or_traversal(state_commit, 'state_commit')
    validate_sha40(state_commit, 'state_commit')

    if state_repo is not None:
        _reject_control_or_traversal(state_repo, 'state_repo')
        if state_repo != PINNED_STATE_REPOSITORY:
            raise GateError(f'state repository mismatch: expected {PINNED_STATE_REPOSITORY}')

    if github_repo is not None:
        validate_github_repo(github_repo, 'github_repo')

    if github_ref is not None:
        _reject_control_or_traversal(github_ref, 'github_ref')
        if github_ref != f'refs/heads/{PINNED_PRODUCTION_BRANCH}':
            raise GateError(f'ref gate failed: only refs/heads/{PINNED_PRODUCTION_BRANCH} is allowed')

    if event_name is not None:
        _reject_control_or_traversal(event_name, 'event_name')
        if event_name != 'workflow_dispatch':
            raise GateError('event gate failed: only workflow_dispatch is allowed')

    return {
        'purpose': purpose,
        'confirm': confirm,
        'dailyRunId': parsed_run_id,
        'stateCommit': state_commit,
    }


def validate_manifest_files(files, *, label='receipt'):
    """Validate an exact 19-file list containing _worker.js, _headers, and 17 static assets."""
    if not isinstance(files, list) or len(files) != REQUIRED_FILE_COUNT:
        raise GateError(f'{label} must contain exactly {REQUIRED_FILE_COUNT} files')

    seen = set()
    validated = []
    for idx, entry in enumerate(files):
        if not isinstance(entry, dict):
            raise GateError(f'{label} entry {idx} must be an object')
        rel = validate_safe_relpath(entry.get('path', ''))
        if rel in seen:
            raise GateError(f'duplicate path in {label}: {rel}')
        seen.add(rel)
        size = entry.get('bytes')
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise GateError(f'invalid byte size in {label} for {rel}')
        digest = validate_sha64(entry.get('sha256'), f'{label} sha256 for {rel}')
        validated.append({'path': rel, 'bytes': size, 'sha256': digest})

    missing_special = sorted(SPECIAL_NON_STATIC_PATHS - seen)
    if missing_special:
        raise GateError(f'{label} missing required special file(s): {missing_special}')

    validated.sort(key=lambda item: item['path'])
    return validated


def _require_nonempty_secret(value, name):
    if not isinstance(value, str) or not value.strip():
        raise GateError(f'missing required environment secret/config: {name}')


def _ensure_outside_repo(path_value, repo_root, label='output directory'):
    resolved = Path(path_value).resolve()
    if repo_root is not None:
        root_resolved = Path(repo_root).resolve()
        if resolved == root_resolved or root_resolved in resolved.parents:
            raise GateError(f'{label} must be outside repository working tree')
    return resolved


class _StripAuthOnCrossHostRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never forward Authorization headers to third-party redirect targets (e.g. artifact blobs)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is None:
            return None
        orig_host = urllib.parse.urlparse(req.full_url).netloc.lower()
        next_host = urllib.parse.urlparse(redirected.full_url).netloc.lower()
        if orig_host != next_host:
            redirected.headers.pop('Authorization', None)
            redirected.unredirected_hdrs.pop('Authorization', None)
        return redirected


def _http_get_bytes(url, headers=None, *, strip_auth_on_redirect=False, timeout=20):
    req = urllib.request.Request(url, headers=headers or {}, method='GET')
    opener = (
        urllib.request.build_opener(_StripAuthOnCrossHostRedirectHandler())
        if strip_auth_on_redirect
        else urllib.request.build_opener()
    )
    try:
        with opener.open(req, timeout=timeout) as resp:
            status = getattr(resp, 'status', 200)
            body = resp.read()
    except urllib.error.HTTPError as exc:
        raise GateError(f'HTTP request failed with status {exc.code}') from None
    except (urllib.error.URLError, OSError) as exc:
        raise GateError(f'network request failed: {type(exc).__name__}') from None
    if status < 200 or status >= 300:
        raise GateError(f'unexpected HTTP status {status}')
    return body


def _http_get_json(url, headers=None):
    raw = _http_get_bytes(url, headers=headers, strip_auth_on_redirect=False)
    try:
        text = raw.decode('utf-8')
        return json.loads(text)
    except (UnicodeDecodeError, ValueError):
        raise GateError('API returned invalid JSON') from None


def _gh_headers(github_token):
    return {
        'Authorization': f'Bearer {github_token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'xinzhi-deploy-only-verified',
    }


def _cf_headers(api_token):
    return {
        'Authorization': f'Bearer {api_token}',
        'Accept': 'application/json',
    }


def default_gh_run_fetcher(repo, github_token, run_id, *, http_get=_http_get_json):
    url = f'https://api.github.com/repos/{repo}/actions/runs/{run_id}'
    return http_get(url, _gh_headers(github_token))


def default_gh_artifacts_fetcher(repo, github_token, run_id, *, http_get=_http_get_json):
    """List artifacts for a single run with bounded pagination (fail-closed on truncation)."""
    headers = _gh_headers(github_token)
    all_artifacts = []
    page = 1
    total_count = None
    while page <= GH_ARTIFACTS_MAX_PAGES:
        url = (
            f'https://api.github.com/repos/{repo}/actions/runs/{run_id}/artifacts'
            f'?per_page={GH_ARTIFACTS_PER_PAGE}&page={page}'
        )
        payload = http_get(url, headers)
        if not isinstance(payload, dict) or not isinstance(payload.get('artifacts'), list):
            raise GateError('unable to inspect GitHub Actions run artifacts (fail-closed)')
        items = payload['artifacts']
        if 'total_count' in payload:
            total_count = payload.get('total_count')
        all_artifacts.extend(items)
        if isinstance(total_count, int) and total_count >= 0 and len(all_artifacts) >= total_count:
            return {'total_count': total_count, 'artifacts': all_artifacts}
        if len(items) < GH_ARTIFACTS_PER_PAGE:
            return {
                'total_count': total_count if total_count is not None else len(all_artifacts),
                'artifacts': all_artifacts,
            }
        page += 1
    raise GateError(
        f'GitHub Actions artifacts listing truncated after {len(all_artifacts)} entries '
        f'(per_page={GH_ARTIFACTS_PER_PAGE}, max_pages={GH_ARTIFACTS_MAX_PAGES}); fail-closed, not a complete scan'
    )


def default_gh_artifact_zip_fetcher(repo, github_token, artifact_id, *, http_get_bytes=_http_get_bytes):
    url = f'https://api.github.com/repos/{repo}/actions/artifacts/{artifact_id}/zip'
    return http_get_bytes(url, _gh_headers(github_token), strip_auth_on_redirect=True, timeout=60)


def default_gh_runs_fetcher(
    repo,
    github_token,
    *,
    status=None,
    workflow_id=None,
    per_page=GH_RUNS_PER_PAGE,
    max_pages=GH_RUNS_MAX_PAGES,
    http_get=_http_get_json,
):
    """List Actions runs with bounded pagination. Never claims an unbounded scan.

    If listing cannot be shown complete within max_pages, raise GateError (fail-closed).
    """
    headers = _gh_headers(github_token)
    base = (
        f'https://api.github.com/repos/{repo}/actions/workflows/{workflow_id}/runs'
        if workflow_id
        else f'https://api.github.com/repos/{repo}/actions/runs'
    )
    all_runs = []
    page = 1
    total_count = None
    while page <= max_pages:
        query = f'per_page={per_page}&page={page}'
        if status:
            query += f'&status={urllib.parse.quote(status)}'
        url = f'{base}?{query}'
        payload = http_get(url, headers)
        if not isinstance(payload, dict) or not isinstance(payload.get('workflow_runs'), list):
            raise GateError('unable to inspect GitHub Actions workflow runs (fail-closed)')
        runs = payload['workflow_runs']
        if 'total_count' in payload:
            total_count = payload.get('total_count')
        all_runs.extend(runs)
        if isinstance(total_count, int) and total_count >= 0 and len(all_runs) >= total_count:
            return {'total_count': total_count, 'workflow_runs': all_runs}
        if len(runs) < per_page:
            return {'total_count': total_count if total_count is not None else len(all_runs), 'workflow_runs': all_runs}
        page += 1
    raise GateError(
        f'GitHub Actions runs listing truncated after {len(all_runs)} entries '
        f'(per_page={per_page}, max_pages={max_pages}); fail-closed, not a complete scan'
    )


def default_cf_project_fetcher(account_id, api_token, project_name):
    url = f'https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}'
    return _http_get_json(url, _cf_headers(api_token))


def default_cf_deployments_fetcher(account_id, api_token, project_name, *, http_get=_http_get_json):
    """List Pages deployments with bounded pagination (fail-closed on truncation)."""
    headers = _cf_headers(api_token)
    all_items = []
    page = 1
    while page <= CF_DEPLOYS_MAX_PAGES:
        url = (
            f'https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/'
            f'{project_name}/deployments?per_page={CF_DEPLOYS_PER_PAGE}&page={page}'
        )
        payload = http_get(url, headers)
        if not isinstance(payload, dict) or payload.get('success') is not True:
            raise GateError('unable to query Cloudflare Pages deployments (fail-closed)')
        items = payload.get('result')
        if not isinstance(items, list):
            raise GateError('Cloudflare Pages deployments list invalid (fail-closed)')
        all_items.extend(items)
        info = payload.get('result_info') if isinstance(payload.get('result_info'), dict) else {}
        total_pages = info.get('total_pages')
        if isinstance(total_pages, int) and total_pages >= 0:
            if page >= total_pages:
                return {'success': True, 'result': all_items}
            page += 1
            continue
        if len(items) < CF_DEPLOYS_PER_PAGE:
            return {'success': True, 'result': all_items}
        page += 1
    raise GateError(
        f'Cloudflare Pages deployments listing truncated after {len(all_items)} items '
        f'(per_page={CF_DEPLOYS_PER_PAGE}, max_pages={CF_DEPLOYS_MAX_PAGES}); fail-closed, not a complete scan'
    )


def default_static_asset_fetcher(production_url, rel_path, *, http_get_bytes=_http_get_bytes):
    rel = validate_safe_relpath(rel_path)
    if rel in SPECIAL_NON_STATIC_PATHS:
        raise GateError(f'refusing to use live HTTP for non-static path {rel}')
    url = f'{production_url.rstrip("/")}/{rel}'
    return http_get_bytes(url, {'User-Agent': 'xinzhi-deploy-only-verified', 'Accept-Encoding': 'identity'})


def _assert_run_belongs_to_repo(run, github_repo, run_id):
    if not isinstance(run, dict):
        raise GateError('GitHub Actions run payload must be a JSON object')
    if run.get('id') != run_id:
        raise GateError(f'GitHub Actions run id mismatch: expected {run_id}')

    repo_obj = run.get('repository')
    if not isinstance(repo_obj, dict) or repo_obj.get('full_name') != github_repo:
        raise GateError(f'run {run_id} does not belong to repository {github_repo}')

    expected_api_url = f'https://api.github.com/repos/{github_repo}/actions/runs/{run_id}'
    expected_html_url = f'https://github.com/{github_repo}/actions/runs/{run_id}'
    expected_artifacts_url = f'{expected_api_url}/artifacts'

    if 'url' in run and run['url'] != expected_api_url:
        raise GateError(f'run {run_id} url does not match repository {github_repo}')
    if 'html_url' in run and run['html_url'] != expected_html_url:
        raise GateError(f'run {run_id} html_url does not match repository {github_repo}')
    if 'artifacts_url' in run and run['artifacts_url'] != expected_artifacts_url:
        raise GateError(f'run {run_id} artifacts_url does not match repository {github_repo}')


def _is_daily_refresh_run(run):
    wf_path = str(run.get('path') or '')
    wf_name = str(run.get('name') or '')
    if wf_path:
        if wf_path != DAILY_WORKFLOW_PATH:
            return False
        return (not wf_name) or wf_name == DAILY_WORKFLOW_NAME
    return wf_name == DAILY_WORKFLOW_NAME


def _extract_receipt_from_zip(zip_bytes):
    if not isinstance(zip_bytes, (bytes, bytearray)) or not zip_bytes:
        raise GateError('official pipeline-final artifact archive is empty')
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes), 'r') as zf:
            matches = [info for info in zf.infolist() if info.filename.lstrip('./') == 'docs/deployment-status.json']
            if not matches:
                # Some uploaders strip the common prefix when single directory/file, check basename fallback?
                # daily.yml uploads multiple paths (docs/... and data/...), so path is docs/deployment-status.json.
                matches = [info for info in zf.infolist() if info.filename.lstrip('./') == 'deployment-status.json']
            if len(matches) != 1:
                raise GateError('pipeline-final artifact missing unique docs/deployment-status.json')
            info = matches[0]
            mode = (info.external_attr >> 16) & 0o170000
            if mode == 0o120000 or info.is_dir():
                raise GateError('docs/deployment-status.json inside artifact must be a regular file')
            if info.file_size > MAX_RECEIPT_BYTES:
                raise GateError('docs/deployment-status.json inside artifact exceeds max size')
            with zf.open(info, 'r') as stream:
                raw = stream.read(MAX_RECEIPT_BYTES + 1)
            if len(raw) > MAX_RECEIPT_BYTES:
                raise GateError('docs/deployment-status.json inside artifact exceeds max read size')
    except zipfile.BadZipFile:
        raise GateError('official pipeline-final artifact is not a valid ZIP archive') from None

    try:
        data = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise GateError('docs/deployment-status.json inside artifact is not valid UTF-8 JSON') from None
    return data


def parse_official_receipt(
    receipt_data,
    *,
    github_repo,
    run_id,
    run_attempt,
    expected_head_sha=None,
    require_deployed=True,
):
    """Parse and validate docs/deployment-status.json from pipeline-final artifact."""
    if not isinstance(receipt_data, dict):
        raise GateError('official receipt must be a JSON object')

    expected_run_url = f'https://github.com/{github_repo}/actions/runs/{run_id}'
    if 'runUrl' in receipt_data and receipt_data['runUrl'] != expected_run_url:
        raise GateError(f'official receipt runUrl mismatch for run {run_id}')
    if 'runAttempt' in receipt_data and str(receipt_data['runAttempt']).strip():
        if str(receipt_data['runAttempt']).strip() != str(run_attempt):
            raise GateError(f'official receipt runAttempt mismatch: expected {run_attempt}')

    deployed = receipt_data.get('deployed')
    deployment_outcome = receipt_data.get('deploymentOutcome')
    all_deployed_ok = (
        deployed is True
        and deployment_outcome == 'success'
        and ('deploymentRequested' not in receipt_data or receipt_data['deploymentRequested'] is True)
        and ('refreshOutcome' not in receipt_data or receipt_data['refreshOutcome'] == 'success')
        and ('stateOutcome' not in receipt_data or receipt_data['stateOutcome'] == 'success')
        and ('status' not in receipt_data or receipt_data['status'] == 'deployed')
    )
    if require_deployed:
        if deployed is not True:
            raise GateError(f'official run {run_id} receipt has deployed={deployed!r}, expected true')
        if deployment_outcome != 'success':
            raise GateError(f'official run {run_id} deploymentOutcome={deployment_outcome!r}, expected success')
        if 'deploymentRequested' in receipt_data and receipt_data['deploymentRequested'] is not True:
            raise GateError(f'official run {run_id} deploymentRequested is not true')
        if 'refreshOutcome' in receipt_data and receipt_data['refreshOutcome'] != 'success':
            raise GateError(f'official run {run_id} refreshOutcome is not success')
        if 'stateOutcome' in receipt_data and receipt_data['stateOutcome'] != 'success':
            raise GateError(f'official run {run_id} stateOutcome is not success')
        if 'status' in receipt_data and receipt_data['status'] != 'deployed':
            raise GateError(f'official run {run_id} status is not deployed')

    code_sha = validate_sha40(receipt_data.get('codeSha'), f'receipt codeSha for run {run_id}')
    if expected_head_sha is not None and code_sha != expected_head_sha:
        raise GateError(f'official receipt codeSha mismatch vs workflow run head_sha for run {run_id}')

    if not require_deployed and not all_deployed_ok:
        return {
            'runId': run_id,
            'runAttempt': run_attempt,
            'codeSha': code_sha,
            'deployed': bool(deployed),
            'allDeployedOk': False,
            'deploymentOutcome': str(deployment_outcome or ''),
            'files': [],
        }

    build = receipt_data.get('build')
    if not isinstance(build, dict):
        raise GateError(f'official receipt for run {run_id} missing build object')
    files = validate_manifest_files(build.get('files'), label=f'run {run_id} build.files')

    return {
        'runId': run_id,
        'runAttempt': run_attempt,
        'codeSha': code_sha,
        'deployed': bool(deployed),
        'allDeployedOk': bool(all_deployed_ok),
        'deploymentOutcome': str(deployment_outcome or ''),
        'files': files,
    }


def verify_official_daily_run(
    github_repo,
    github_token,
    run_id,
    *,
    run_fetcher=None,
    artifacts_fetcher=None,
    artifact_zip_fetcher=None,
    require_deployed=True,
):
    """Triad Part 1: Verify official daily-refresh run and download pipeline-final-{id}-{attempt}."""
    validate_github_repo(github_repo, 'github_repo')
    _require_nonempty_secret(github_token, 'GITHUB_TOKEN')
    parsed_run_id = validate_run_id(run_id, 'daily_run_id')

    get_run = run_fetcher or default_gh_run_fetcher
    list_artifacts = artifacts_fetcher or default_gh_artifacts_fetcher
    get_zip = artifact_zip_fetcher or default_gh_artifact_zip_fetcher

    run = get_run(github_repo, github_token, parsed_run_id)
    _assert_run_belongs_to_repo(run, github_repo, parsed_run_id)

    if not _is_daily_refresh_run(run):
        raise GateError(f'run {parsed_run_id} is not {DAILY_WORKFLOW_PATH} ({DAILY_WORKFLOW_NAME})')

    head_branch = run.get('head_branch')
    if head_branch is not None and head_branch != PINNED_PRODUCTION_BRANCH:
        raise GateError(f'run {parsed_run_id} head_branch is {head_branch!r}, expected {PINNED_PRODUCTION_BRANCH}')

    if run.get('status') != 'completed':
        raise GateError(f'run {parsed_run_id} is not completed (status={run.get("status")})')
    if run.get('conclusion') != 'success':
        raise GateError(f'run {parsed_run_id} conclusion is {run.get("conclusion")!r}, expected success')

    run_attempt = run.get('run_attempt')
    if isinstance(run_attempt, bool) or not isinstance(run_attempt, int) or run_attempt < 1:
        raise GateError(f'run {parsed_run_id} missing valid integer run_attempt')

    head_sha = None
    if run.get('head_sha') is not None:
        head_sha = validate_sha40(run.get('head_sha'), f'run {parsed_run_id} head_sha')

    expected_artifact_name = f'pipeline-final-{parsed_run_id}-{run_attempt}'
    artifacts_payload = list_artifacts(github_repo, github_token, parsed_run_id)
    if not isinstance(artifacts_payload, dict) or not isinstance(artifacts_payload.get('artifacts'), list):
        raise GateError(f'invalid artifacts payload for run {parsed_run_id}')

    matching = [
        item for item in artifacts_payload['artifacts']
        if isinstance(item, dict) and item.get('name') == expected_artifact_name
    ]
    if len(matching) != 1:
        raise GateError(
            f'expected unique artifact {expected_artifact_name} for run {parsed_run_id}, found {len(matching)}'
        )
    artifact = matching[0]
    if artifact.get('expired') is True:
        raise GateError(f'artifact {expected_artifact_name} is expired')
    wf_run_meta = artifact.get('workflow_run')
    if isinstance(wf_run_meta, dict) and wf_run_meta.get('id') is not None and wf_run_meta.get('id') != parsed_run_id:
        raise GateError(f'artifact {expected_artifact_name} workflow_run.id mismatch')

    artifact_id = artifact.get('id')
    if isinstance(artifact_id, bool) or not isinstance(artifact_id, int) or artifact_id <= 0:
        raise GateError(f'artifact {expected_artifact_name} missing valid integer id')

    dl_url = artifact.get('archive_download_url')
    expected_dl_prefix = f'https://api.github.com/repos/{github_repo}/actions/artifacts/{artifact_id}/zip'
    if dl_url is not None and dl_url != expected_dl_prefix:
        raise GateError(f'artifact {expected_artifact_name} archive_download_url mismatch')

    zip_bytes = get_zip(github_repo, github_token, artifact_id)
    receipt_raw = _extract_receipt_from_zip(zip_bytes)
    receipt = parse_official_receipt(
        receipt_raw,
        github_repo=github_repo,
        run_id=parsed_run_id,
        run_attempt=run_attempt,
        expected_head_sha=head_sha,
        require_deployed=require_deployed,
    )
    receipt['artifactName'] = expected_artifact_name
    receipt['artifactId'] = artifact_id
    return receipt


def _default_git_runner(cwd, args, env=None, timeout=60):
    merged_env = dict(os.environ)
    if env:
        merged_env.update(env)
    if args and 'fetch' in args:
        timeout = max(timeout, 300)
    try:
        return subprocess.run(
            ['git', *args],
            cwd=str(cwd),
            env=merged_env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise GateError(f'git command timed out after {timeout}s') from exc


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_package_tree(public_dir, expected_files, *, state_commit=None):
    """Verify extracted public directory matches the exact 19 files (bytes + sha256)."""
    directory = Path(public_dir)
    if directory.is_symlink() or not directory.is_dir():
        raise GateError('verified public directory does not exist or is a symlink')

    validated_expected = validate_manifest_files(expected_files, label='expected package manifest')
    actual_files = {}
    for entry in sorted(directory.rglob('*')):
        rel = entry.relative_to(directory).as_posix()
        if entry.is_symlink():
            raise GateError(f'symlink not allowed in verified public package: {rel}')
        if entry.is_dir():
            continue
        if not entry.is_file():
            raise GateError(f'non-ordinary file in verified public package: {rel}')
        actual_files[rel] = entry

    expected_by_path = {item['path']: item for item in validated_expected}
    expected_paths = set(expected_by_path)
    actual_paths = set(actual_files)

    missing = sorted(expected_paths - actual_paths)
    extra = sorted(actual_paths - expected_paths)
    if missing or extra:
        raise GateError(f'verified public file set mismatch (missing={missing}, extra={extra})')
    if len(actual_paths) != REQUIRED_FILE_COUNT:
        raise GateError(f'expected {REQUIRED_FILE_COUNT} files, got {len(actual_paths)}')

    total_bytes = 0
    for rel in sorted(expected_paths):
        expected = expected_by_path[rel]
        file_path = actual_files[rel]
        actual_bytes = file_path.stat().st_size
        if actual_bytes != expected['bytes']:
            raise GateError(
                f'byte size mismatch for {rel}: expected {expected["bytes"]}, got {actual_bytes}'
            )
        actual_sha = _sha256_file(file_path)
        if actual_sha != expected['sha256']:
            raise GateError(
                f'sha256 mismatch for {rel}: expected {expected["sha256"]}, got {actual_sha}'
            )
        total_bytes += actual_bytes

    return {
        'fileCount': REQUIRED_FILE_COUNT,
        'totalBytes': total_bytes,
        'stateCommit': state_commit,
    }


def _safe_extract_public_tar(tar_path, output_dir):
    out_root = Path(output_dir)
    if out_root.exists():
        shutil.rmtree(out_root)
    out_root.mkdir(parents=True, exist_ok=True)

    extracted_regular = 0
    with tarfile.open(tar_path, 'r:') as tf:
        for member in tf.getmembers():
            raw_name = member.name.lstrip('./').rstrip('/')
            if not raw_name or raw_name == 'pax_global_header':
                continue
            if '\\' in raw_name or '\x00' in raw_name:
                raise GateError(f'unsafe tar member path: {raw_name}')
            parts = raw_name.split('/')
            if any(part in ('', '.', '..') for part in parts):
                raise GateError(f'traversal tar member path: {raw_name}')
            if parts[0] != 'public':
                raise GateError(f'unexpected archive entry outside public/: {raw_name}')
            if member.issym() or member.islnk() or member.isdev() or member.ischr() or member.isblk() or member.isfifo():
                raise GateError(f'unsupported special tar entry: {raw_name}')
            rel_parts = parts[1:]
            if not rel_parts:
                continue
            dest = out_root.joinpath(*rel_parts)
            if member.isdir():
                dest.mkdir(parents=True, exist_ok=True)
            elif member.isreg():
                dest.parent.mkdir(parents=True, exist_ok=True)
                src = tf.extractfile(member)
                if src is None:
                    raise GateError(f'failed to read tar member: {raw_name}')
                with src, dest.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
                extracted_regular += 1
            else:
                raise GateError(f'unsupported tar member type for {raw_name}')
    if extracted_regular == 0:
        raise GateError('state commit archive contained no files under public/')


def _make_askpass_script(scratch_dir):
    script = Path(scratch_dir) / 'git-askpass.sh'
    script.write_text(
        '#!/bin/sh\n'
        'case "$1" in\n'
        '  *Username*|*username*) printf "%s\\n" "x-access-token" ;;\n'
        '  *) printf "%s\\n" "$XINZHI_STATE_TOKEN" ;;\n'
        'esac\n',
        encoding='utf-8',
    )
    os.chmod(script, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    return script


def _prepare_state_git_env(scratch_dir, state_repo, state_token, remote_url):
    git_env = {'GIT_TERMINAL_PROMPT': '0'}
    if remote_url is None:
        _require_nonempty_secret(state_token, 'XINZHI_STATE_TOKEN')
        askpass = _make_askpass_script(scratch_dir)
        git_env['GIT_ASKPASS'] = str(askpass)
        git_env['XINZHI_STATE_TOKEN'] = state_token
        effective_remote = f'https://github.com/{state_repo}.git'
    else:
        effective_remote = remote_url
    return git_env, effective_remote


def fetch_verified_package_from_state(
    output_dir,
    expected_files,
    *,
    state_repo=PINNED_STATE_REPOSITORY,
    state_commit,
    state_token=None,
    remote_url=None,
    repo_root=None,
    git_runner=None,
):
    """Triad Part 2: Fetch public/ exclusively from exact state_commit (never branch tip)."""
    if state_repo != PINNED_STATE_REPOSITORY:
        raise GateError(f'state repository mismatch: expected {PINNED_STATE_REPOSITORY}')
    validate_sha40(state_commit, 'state_commit')
    out_resolved = _ensure_outside_repo(output_dir, repo_root, 'verified output directory')
    run_git = git_runner or _default_git_runner

    with tempfile.TemporaryDirectory(prefix='xinzhi-verified-pkg-') as tmp:
        tmp_path = Path(tmp)
        git_dir = tmp_path / 'state-git'
        git_dir.mkdir()

        init_res = run_git(git_dir, ['init', '-q'])
        if init_res.returncode != 0:
            raise GateError('failed to initialize temporary git directory')

        git_env, effective_remote = _prepare_state_git_env(tmp_path, state_repo, state_token, remote_url)
        clear_header = ['-c', 'http.https://github.com/.extraheader=']
        fetch_sha = run_git(
            git_dir,
            [*clear_header, 'fetch', '-q', '--depth=1', effective_remote, state_commit],
            env=git_env,
        )
        if fetch_sha.returncode != 0:
            raise GateError(f'failed to fetch exact state commit {state_commit} from state repository')

        has_commit = run_git(git_dir, ['cat-file', '-e', f'{state_commit}^{{commit}}'])
        if has_commit.returncode != 0:
            raise GateError(f'exact state commit {state_commit} not found after fetch')

        tar_path = tmp_path / 'verified-public.tar'
        arch_res = run_git(git_dir, ['archive', '--format=tar', '-o', str(tar_path), state_commit, 'public'])
        if arch_res.returncode != 0 or not tar_path.is_file():
            raise GateError(f'failed to export public/ from state commit {state_commit}')

        try:
            _safe_extract_public_tar(tar_path, out_resolved)
            summary = verify_package_tree(out_resolved, expected_files, state_commit=state_commit)
        except Exception:
            shutil.rmtree(out_resolved, ignore_errors=True)
            raise

    return summary


def _parse_ls_tree_public_sizes(stdout):
    """Parse `git ls-tree -r --long --full-tree <commit> -- public` output."""
    sizes = {}
    for raw_line in stdout.splitlines():
        line = raw_line.rstrip('\r\n')
        if not line:
            continue
        if '\t' not in line:
            return None
        meta, raw_path = line.split('\t', 1)
        fields = meta.split()
        if len(fields) < 4:
            return None
        mode, obj_type, _obj_sha, size_str = fields[0], fields[1], fields[2], fields[3]
        if obj_type != 'blob' or mode == '120000':
            return None
        if not raw_path.startswith('public/'):
            return None
        rel = validate_safe_relpath(raw_path[len('public/'):])
        if rel in sizes or not size_str.isdigit():
            return None
        sizes[rel] = int(size_str)
    return sizes


def discover_unique_state_commit_for_receipt(
    expected_files,
    *,
    state_repo=PINNED_STATE_REPOSITORY,
    state_token=None,
    remote_url=None,
    git_runner=None,
):
    """Search state history for the unique commit whose public/ matches all 19 receipt hashes.

    Never blindly trusts the state branch tip; fails closed on 0, >1, or truncated history.
    """
    if state_repo != PINNED_STATE_REPOSITORY:
        raise GateError(f'state repository mismatch: expected {PINNED_STATE_REPOSITORY}')
    validated_files = validate_manifest_files(expected_files, label='receipt')
    expected_sizes = {item['path']: item['bytes'] for item in validated_files}
    run_git = git_runner or _default_git_runner

    with tempfile.TemporaryDirectory(prefix='xinzhi-state-search-') as tmp:
        tmp_path = Path(tmp)
        git_dir = tmp_path / 'state-git'
        git_dir.mkdir()
        if run_git(git_dir, ['init', '-q']).returncode != 0:
            raise GateError('failed to initialize temporary git directory for state search')

        git_env, effective_remote = _prepare_state_git_env(tmp_path, state_repo, state_token, remote_url)
        clear_header = ['-c', 'http.https://github.com/.extraheader=']
        fetch_res = run_git(
            git_dir,
            [*clear_header, 'fetch', '-q', f'--depth={STATE_HISTORY_MAX_COMMITS + 1}', effective_remote, 'refs/heads/state'],
            env=git_env,
        )
        if fetch_res.returncode != 0:
            raise GateError('failed to fetch state history during close rebind')

        rev_res = run_git(
            git_dir,
            ['rev-list', f'--max-count={STATE_HISTORY_MAX_COMMITS + 1}', 'FETCH_HEAD'],
        )
        if rev_res.returncode != 0:
            raise GateError('failed to enumerate state commit history during close rebind')

        commits = [validate_sha40(line.strip(), 'state history commit') for line in rev_res.stdout.splitlines() if line.strip()]
        if not commits:
            raise GateError('state repository history is empty')
        if len(commits) > STATE_HISTORY_MAX_COMMITS:
            raise GateError(
                f'state history truncated after {STATE_HISTORY_MAX_COMMITS} commits; '
                'fail-closed, re-dispatch with explicit daily_run_id and state_commit'
            )

        matches = []
        for idx, commit_sha in enumerate(commits):
            ls_res = run_git(git_dir, ['ls-tree', '-r', '--long', '--full-tree', commit_sha, '--', 'public'])
            if ls_res.returncode != 0:
                continue
            sizes = _parse_ls_tree_public_sizes(ls_res.stdout)
            if sizes != expected_sizes:
                continue

            tar_path = tmp_path / f'cand-{idx}.tar'
            extract_dir = tmp_path / f'cand-{idx}'
            arch_res = run_git(git_dir, ['archive', '--format=tar', '-o', str(tar_path), commit_sha, 'public'])
            if arch_res.returncode != 0 or not tar_path.is_file():
                continue
            try:
                _safe_extract_public_tar(tar_path, extract_dir)
                verify_package_tree(extract_dir, validated_files, state_commit=commit_sha)
            except GateError:
                continue
            finally:
                shutil.rmtree(extract_dir, ignore_errors=True)
                if tar_path.exists():
                    tar_path.unlink()
            matches.append(commit_sha)

        if len(matches) != 1:
            raise GateError(
                f'cannot uniquely identify state commit matching official 19-file receipt '
                f'(matched={len(matches)} across {len(commits)} commits); fail-closed, re-dispatch manually'
            )
        return matches[0]


def verify_production_state(account_id, api_token, *, purpose, project_fetcher=None):
    """Triad Part 3a: Verify live Cloudflare Pages project canonical==latest and D1_BACKFILL_ENABLED setting."""
    validate_purpose(purpose)
    _require_nonempty_secret(account_id, 'CLOUDFLARE_ACCOUNT_ID')
    _require_nonempty_secret(api_token, 'CLOUDFLARE_API_TOKEN')
    fetcher = project_fetcher or default_cf_project_fetcher

    payload = fetcher(account_id, api_token, PINNED_PAGES_PROJECT)
    if not isinstance(payload, dict) or payload.get('success') is not True:
        raise GateError('Cloudflare Pages project query did not succeed')
    result = payload.get('result')
    if not isinstance(result, dict) or result.get('name') != PINNED_PAGES_PROJECT:
        raise GateError('Cloudflare Pages project payload mismatch')

    canonical = result.get('canonical_deployment')
    latest = result.get('latest_deployment')
    if not isinstance(canonical, dict):
        raise GateError('Cloudflare Pages project has no canonical_deployment (fail-closed)')
    if not isinstance(latest, dict):
        raise GateError('Cloudflare Pages project has no latest_deployment (fail-closed)')

    for label, dep in (('canonical_deployment', canonical), ('latest_deployment', latest)):
        if dep.get('environment') != 'production':
            raise GateError(f'{label} environment is not production')
        stage = dep.get('latest_stage')
        if not isinstance(stage, dict) or stage.get('status') != 'success':
            raise GateError(f'{label} latest_stage is not success')
        trigger = dep.get('deployment_trigger') or {}
        meta = trigger.get('metadata') if isinstance(trigger, dict) else None
        if not isinstance(meta, dict):
            raise GateError(f'{label} missing deployment_trigger.metadata')
        branch = meta.get('branch')
        if branch is not None and branch != PINNED_PRODUCTION_BRANCH:
            raise GateError(f'{label} branch mismatch: {branch}')

    canonical_id = str(canonical.get('id') or '').strip()
    latest_id = str(latest.get('id') or '').strip()
    if not canonical_id or canonical_id != latest_id:
        raise GateError(
            f'canonical_deployment ({canonical_id or "missing"}) and latest_deployment ({latest_id or "missing"}) '
            'are not the same deployment'
        )

    canonical_commit = validate_sha40(
        str(canonical['deployment_trigger']['metadata'].get('commit_hash') or '').strip().lower(),
        'canonical_deployment commit_hash',
    )
    latest_commit = validate_sha40(
        str(latest['deployment_trigger']['metadata'].get('commit_hash') or '').strip().lower(),
        'latest_deployment commit_hash',
    )
    if canonical_commit != latest_commit:
        raise GateError('canonical and latest commit_hash differ')

    expected_switch = 'true' if purpose == 'open' else 'false'
    env_vars = (
        (result.get('deployment_configs') or {})
        .get('production', {})
        .get('env_vars', {})
    )
    if not isinstance(env_vars, dict):
        raise GateError('Cloudflare Pages project missing deployment_configs.production.env_vars')
    switch_obj = env_vars.get('D1_BACKFILL_ENABLED')
    if not isinstance(switch_obj, dict) or switch_obj.get('type') != 'plain_text':
        raise GateError(
            f'D1_BACKFILL_ENABLED project setting must be plain_text {expected_switch!r} for purpose={purpose}'
        )
    actual_switch = switch_obj.get('value')
    if actual_switch != expected_switch:
        raise GateError(
            f'D1_BACKFILL_ENABLED project setting mismatch for purpose={purpose}: '
            f'expected {expected_switch!r}, got {actual_switch!r}'
        )

    return {
        'productionCommit': canonical_commit,
        'canonicalDeploymentId': canonical_id,
        'switchValue': actual_switch,
        'productionUrl': PINNED_PRODUCTION_URL,
    }


def verify_live_static_assets(expected_files, *, production_url=PINNED_PRODUCTION_URL, static_fetcher=None):
    """Triad Part 3b: Verify the 17 static assets on live production match the official 19-file list.

    _worker.js and _headers are explicitly excluded; live HTTP HTML responses for those two paths
    are never treated as either a match or a bundle-mismatch failure.
    """
    validated = validate_manifest_files(expected_files, label='receipt')
    static_entries = [item for item in validated if item['path'] not in SPECIAL_NON_STATIC_PATHS]
    if len(static_entries) != REQUIRED_STATIC_FILE_COUNT:
        raise GateError(f'expected {REQUIRED_STATIC_FILE_COUNT} static entries, got {len(static_entries)}')

    fetcher = static_fetcher or default_static_asset_fetcher
    verified_paths = []
    for entry in static_entries:
        rel = entry['path']
        body = fetcher(production_url, rel)
        if not isinstance(body, (bytes, bytearray)):
            raise GateError(f'live static asset {rel} did not return bytes')
        raw = bytes(body)
        if len(raw) != entry['bytes']:
            raise GateError(
                f'live static byte length mismatch for {rel}: expected {entry["bytes"]}, got {len(raw)}'
            )
        actual_sha = hashlib.sha256(raw).hexdigest()
        if actual_sha != entry['sha256']:
            raise GateError(
                f'live static sha256 mismatch for {rel}: expected {entry["sha256"]}, got {actual_sha}'
            )
        verified_paths.append(rel)

    return {'staticCount': len(verified_paths), 'staticPaths': verified_paths}


def verify_main_diff(repo_root, *, base_sha, tip_ref='HEAD', require_clean_tree=True, git_runner=None):
    """Ensure tip_ref (HEAD or origin/main) only adds/modifies the 4 audited CI files relative to base_sha."""
    validate_sha40(base_sha, 'base_sha')
    if not isinstance(tip_ref, str) or not tip_ref or tip_ref.startswith('-'):
        raise GateError('invalid tip_ref')
    run_git = git_runner or _default_git_runner
    root = Path(repo_root)

    res_tip = run_git(root, ['rev-parse', '--verify', f'{tip_ref}^{{commit}}'])
    if res_tip.returncode != 0:
        raise GateError(f'failed to resolve git tip {tip_ref}')
    tip_sha = res_tip.stdout.strip()
    validate_sha40(tip_sha, f'tip {tip_ref}')

    res_base = run_git(root, ['cat-file', '-e', f'{base_sha}^{{commit}}'])
    if res_base.returncode != 0:
        raise GateError(f'bound codeSha {base_sha} missing from local git history (fetch-depth must include it)')

    res_anc = run_git(root, ['merge-base', '--is-ancestor', base_sha, tip_sha])
    if res_anc.returncode != 0:
        raise GateError(f'bound codeSha {base_sha} is not an ancestor of {tip_ref}')

    if require_clean_tree:
        res_dirty = run_git(root, ['diff', '--name-only', 'HEAD'])
        if res_dirty.returncode != 0:
            raise GateError('failed to inspect working tree cleanliness')
        if res_dirty.stdout.strip():
            raise GateError('working tree has uncommitted tracked modifications')

    res_diff = run_git(root, ['diff', '--name-status', '--no-renames', f'{base_sha}..{tip_sha}'])
    if res_diff.returncode != 0:
        raise GateError(f'failed to compute git diff from {base_sha}..{tip_ref}')

    changed_paths = []
    for raw_line in res_diff.stdout.splitlines():
        line = raw_line.rstrip('\r\n')
        if not line:
            continue
        parts = line.split('\t', 1)
        if len(parts) != 2:
            raise GateError(f'unexpected git diff --name-status line: {line}')
        status, raw_path = parts
        rel = validate_safe_relpath(raw_path)
        if status not in ('A', 'M'):
            raise GateError(f'disallowed diff status relative to {base_sha}: {status} {rel}')
        if rel not in ALLOWED_MAIN_DIFF_PATHS:
            raise GateError(f'path outside deploy-only allowlist relative to {base_sha}: {rel}')
        changed_paths.append(rel)

    return {'headSha': tip_sha, 'tipRef': tip_ref, 'changedPaths': sorted(changed_paths)}


def fetch_origin_main(repo_root, *, git_runner=None):
    """Fetch current origin/main. Fail-closed; never fall back to stale checkout HEAD."""
    run_git = git_runner or _default_git_runner
    root = Path(repo_root)
    res = run_git(root, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
    if res.returncode != 0:
        raise GateError('failed to fetch remote origin/main (fail-closed; cannot trust checkout HEAD alone)')
    res_tip = run_git(root, ['rev-parse', '--verify', 'origin/main^{commit}'])
    if res_tip.returncode != 0:
        raise GateError('failed to resolve origin/main after fetch')
    tip_sha = res_tip.stdout.strip()
    validate_sha40(tip_sha, 'origin/main')
    return tip_sha


def _resolve_git_object(run_git, repo_root, rev, kind, label):
    if not isinstance(rev, str) or not rev or rev.startswith('-'):
        raise GateError(f'invalid rev for {label}')
    if kind == 'commit':
        spec = f'{rev}^{{commit}}'
    elif kind == 'tree':
        spec = f'{rev}^{{tree}}'
    else:
        raise GateError(f'invalid git object kind for {label}')
    res = run_git(repo_root, ['rev-parse', '--verify', spec])
    if res.returncode != 0:
        raise GateError(f'failed to resolve {label}')
    sha = res.stdout.strip()
    validate_sha40(sha, label)
    return sha


def verify_remote_matches_reviewed_checkout(
    repo_root,
    *,
    reviewed_ref='HEAD',
    remote_ref='origin/main',
    git_runner=None,
):
    """Require remote tip to equal the reviewed checkout commit, or have the exact same tree."""
    run_git = git_runner or _default_git_runner
    root = Path(repo_root)
    reviewed_sha = _resolve_git_object(run_git, root, reviewed_ref, 'commit', f'reviewed {reviewed_ref}')
    remote_sha = _resolve_git_object(run_git, root, remote_ref, 'commit', f'remote {remote_ref}')
    if reviewed_sha == remote_sha:
        return {'reviewedSha': reviewed_sha, 'remoteSha': remote_sha, 'match': 'commit'}
    reviewed_tree = _resolve_git_object(run_git, root, reviewed_sha, 'tree', 'reviewed tree')
    remote_tree = _resolve_git_object(run_git, root, remote_sha, 'tree', 'remote tree')
    if reviewed_tree == remote_tree:
        return {
            'reviewedSha': reviewed_sha,
            'remoteSha': remote_sha,
            'reviewedTree': reviewed_tree,
            'remoteTree': remote_tree,
            'match': 'tree',
        }
    raise GateError(
        f'remote {remote_ref} {remote_sha} does not match reviewed checkout {reviewed_ref} {reviewed_sha} '
        f'(trees {remote_tree} vs {reviewed_tree}); later main changes are not auto-approved'
    )


def verify_no_concurrent_deploy(
    account_id,
    api_token,
    *,
    repo=None,
    github_token=None,
    current_run_id=None,
    deployments_fetcher=None,
    gh_runs_fetcher=None,
    require_github_check=True,
):
    """Fail-closed check for active Cloudflare Pages deployments or conflicting CI runs."""
    _require_nonempty_secret(account_id, 'CLOUDFLARE_ACCOUNT_ID')
    _require_nonempty_secret(api_token, 'CLOUDFLARE_API_TOKEN')

    cf_fetch = deployments_fetcher or default_cf_deployments_fetcher
    cf_payload = cf_fetch(account_id, api_token, PINNED_PAGES_PROJECT)
    if not isinstance(cf_payload, dict) or cf_payload.get('success') is not True:
        raise GateError('unable to query Cloudflare Pages deployments (fail-closed)')
    deployments = cf_payload.get('result')
    if not isinstance(deployments, list) or not deployments:
        raise GateError('Cloudflare Pages deployments list empty or invalid (fail-closed)')

    for dep in deployments:
        if not isinstance(dep, dict):
            raise GateError('unexpected Cloudflare deployment item (fail-closed)')
        stage_status = (dep.get('latest_stage') or {}).get('status')
        if stage_status not in TERMINAL_CF_STAGES:
            raise GateError(f'active or unknown Cloudflare Pages deployment detected: status={stage_status}')

    gh_checked_count = 0
    if require_github_check:
        validate_github_repo(repo, 'github_repo')
        _require_nonempty_secret(github_token, 'GITHUB_TOKEN')
        if not current_run_id or not str(current_run_id).strip():
            raise GateError('missing GITHUB_RUN_ID for concurrency check (fail-closed)')

        if gh_runs_fetcher is not None:
            gh_payload = gh_runs_fetcher(repo, github_token)
            if not isinstance(gh_payload, dict) or not isinstance(gh_payload.get('workflow_runs'), list):
                raise GateError('unable to inspect GitHub Actions workflow runs (fail-closed)')
            runs_to_check = gh_payload['workflow_runs']
        else:
            runs_to_check = []
            for active_status in ACTIVE_GH_STATUSES:
                gh_payload = default_gh_runs_fetcher(
                    repo,
                    github_token,
                    status=active_status,
                    per_page=GH_RUNS_PER_PAGE,
                    max_pages=GH_RUNS_MAX_PAGES,
                )
                runs_to_check.extend(gh_payload['workflow_runs'])

        gh_checked_count = len(runs_to_check)
        self_id = str(current_run_id).strip()
        for run in runs_to_check:
            if not isinstance(run, dict):
                continue
            if str(run.get('id') or '') == self_id:
                continue
            wf_path = str(run.get('path') or '')
            wf_name = str(run.get('name') or '')
            status = run.get('status')
            if wf_path.endswith('/daily.yml') or wf_path == DAILY_WORKFLOW_PATH or wf_name == DAILY_WORKFLOW_NAME:
                if status != 'completed':
                    raise GateError(f'daily-refresh workflow has non-completed run (status={status})')
            elif (
                wf_path.endswith('/deploy-only-verified.yml')
                or wf_path == DEPLOY_ONLY_WORKFLOW_PATH
                or wf_name == DEPLOY_ONLY_WORKFLOW_NAME
            ):
                if status != 'completed':
                    raise GateError(f'another deploy-only-verified run is not completed (status={status})')

    return {
        'cloudflareChecked': len(deployments),
        'githubChecked': gh_checked_count if require_github_check else 0,
    }


def _cached_static_fetcher(static_fetcher, production_url):
    cache = {}
    base = static_fetcher or default_static_asset_fetcher

    def _fetch(prod_url, rel_path):
        key = (prod_url, rel_path)
        if key not in cache:
            cache[key] = base(prod_url, rel_path)
        return cache[key]

    return _fetch


def discover_unique_official_run_for_production(
    github_repo,
    github_token,
    *,
    prod_commit,
    production_url=PINNED_PRODUCTION_URL,
    gh_runs_fetcher=None,
    run_fetcher=None,
    artifacts_fetcher=None,
    artifact_zip_fetcher=None,
    static_fetcher=None,
):
    """Discover the unique official successful deployed daily-refresh run matching current production."""
    validate_github_repo(github_repo, 'github_repo')
    _require_nonempty_secret(github_token, 'GITHUB_TOKEN')
    validate_sha40(prod_commit, 'prod_commit')

    if gh_runs_fetcher is not None:
        runs_payload = gh_runs_fetcher(github_repo, github_token)
    else:
        runs_payload = default_gh_runs_fetcher(
            github_repo,
            github_token,
            workflow_id='daily.yml',
            status='completed',
            per_page=GH_DISCOVER_PER_PAGE,
            max_pages=GH_DISCOVER_MAX_PAGES,
        )

    if not isinstance(runs_payload, dict) or not isinstance(runs_payload.get('workflow_runs'), list):
        raise GateError('unable to list daily-refresh runs during close rebind (fail-closed)')

    cached_static = _cached_static_fetcher(static_fetcher, production_url)
    matches = []
    seen_ids = set()
    for run in runs_payload['workflow_runs']:
        if not isinstance(run, dict):
            continue
        run_id = run.get('id')
        if isinstance(run_id, bool) or not isinstance(run_id, int) or run_id <= 0 or run_id in seen_ids:
            continue
        seen_ids.add(run_id)
        if not _is_daily_refresh_run(run):
            continue
        repo_obj = run.get('repository')
        if isinstance(repo_obj, dict) and repo_obj.get('full_name') != github_repo:
            continue
        if run.get('head_branch') not in (None, PINNED_PRODUCTION_BRANCH):
            continue
        if run.get('status') != 'completed' or run.get('conclusion') != 'success':
            continue
        if run.get('head_sha') is not None and run.get('head_sha') != prod_commit:
            continue

        # Ensure full run verification (including ownership & artifact download).
        effective_run_fetcher = run_fetcher or (
            lambda _r, _t, rid, _run=run: _run
            if isinstance(_run.get('repository'), dict)
            else default_gh_run_fetcher(_r, _t, rid)
        )
        receipt = verify_official_daily_run(
            github_repo,
            github_token,
            run_id,
            run_fetcher=effective_run_fetcher,
            artifacts_fetcher=artifacts_fetcher,
            artifact_zip_fetcher=artifact_zip_fetcher,
            require_deployed=False,
        )
        if not receipt['allDeployedOk']:
            continue
        if receipt['codeSha'] != prod_commit:
            continue
        try:
            verify_live_static_assets(
                receipt['files'],
                production_url=production_url,
                static_fetcher=cached_static,
            )
        except GateError:
            continue
        matches.append(receipt)

    if len(matches) != 1:
        raise GateError(
            f'cannot uniquely identify official daily-refresh run for live production commit {prod_commit} '
            f'(matched={len(matches)}); fail-closed, re-dispatch manually with explicit daily_run_id and state_commit'
        )
    return matches[0]


def _confirm_bound_bundle_still_current(
    *,
    repo_root,
    output_dir,
    account_id,
    api_token,
    purpose,
    bound_receipt,
    bound_state_commit,
    previous_remote_sha,
    production_url=PINNED_PRODUCTION_URL,
    project_fetcher=None,
    static_fetcher=None,
    git_runner=None,
):
    """Terminal recheck after close rebind: production, switch, 17 static, 19-file tree, and origin/main.

    This is not a last-instant race claim. It closes the discovery/fetch window that
    happens after the first production read and before wrangler is allowed to run.
    """
    validate_purpose(purpose)
    remote_sha = fetch_origin_main(repo_root, git_runner=git_runner)
    if previous_remote_sha is not None and remote_sha != previous_remote_sha:
        raise GateError(
            'origin/main changed again during close rebind confirmation (fail-closed); '
            're-dispatch with the then-current daily_run_id and state_commit'
        )
    prod_info = verify_production_state(
        account_id,
        api_token,
        purpose=purpose,
        project_fetcher=project_fetcher,
    )
    prod_info['productionUrl'] = production_url
    if prod_info['productionCommit'] != bound_receipt['codeSha']:
        raise GateError(
            'production commit_hash changed during close rebind confirmation; '
            'refusing to publish a bundle that is no longer current'
        )
    verify_live_static_assets(
        bound_receipt['files'],
        production_url=production_url,
        static_fetcher=static_fetcher,
    )
    verify_package_tree(output_dir, bound_receipt['files'], state_commit=bound_state_commit)
    diff_info = verify_main_diff(
        repo_root,
        base_sha=bound_receipt['codeSha'],
        tip_ref='origin/main',
        require_clean_tree=False,
        git_runner=git_runner,
    )
    if diff_info['headSha'] != remote_sha:
        raise GateError('origin/main SHA changed during close rebind confirmation (fail-closed)')
    return {
        'prod_info': prod_info,
        'diff_info': diff_info,
        'remote_sha': remote_sha,
    }


def _rebind_close_to_current_production(
    *,
    repo_root,
    output_dir,
    account_id,
    api_token,
    prod_info,
    state_repo,
    state_token,
    state_remote_url,
    github_token,
    github_repo,
    github_run_id,
    tip_ref,
    require_clean_tree,
    deployments_fetcher,
    gh_runs_fetcher,
    discover_runs_fetcher,
    run_fetcher,
    artifacts_fetcher,
    artifact_zip_fetcher,
    static_fetcher,
    git_runner,
    require_github_check,
):
    """Fail-closed rebind on close when production moved to a newer official daily-refresh bundle."""
    verify_no_concurrent_deploy(
        account_id,
        api_token,
        repo=github_repo,
        github_token=github_token,
        current_run_id=github_run_id,
        deployments_fetcher=deployments_fetcher,
        gh_runs_fetcher=gh_runs_fetcher,
        require_github_check=require_github_check,
    )
    new_receipt = discover_unique_official_run_for_production(
        github_repo,
        github_token,
        prod_commit=prod_info['productionCommit'],
        production_url=prod_info['productionUrl'],
        gh_runs_fetcher=discover_runs_fetcher or gh_runs_fetcher,
        run_fetcher=run_fetcher,
        artifacts_fetcher=artifacts_fetcher,
        artifact_zip_fetcher=artifact_zip_fetcher,
        static_fetcher=static_fetcher,
    )
    new_state_commit = discover_unique_state_commit_for_receipt(
        new_receipt['files'],
        state_repo=state_repo,
        state_token=state_token,
        remote_url=state_remote_url,
        git_runner=git_runner,
    )
    pkg_info = fetch_verified_package_from_state(
        output_dir,
        new_receipt['files'],
        state_repo=state_repo,
        state_commit=new_state_commit,
        state_token=state_token,
        remote_url=state_remote_url,
        repo_root=repo_root,
        git_runner=git_runner,
    )
    diff_info = verify_main_diff(
        repo_root,
        base_sha=new_receipt['codeSha'],
        tip_ref=tip_ref,
        require_clean_tree=require_clean_tree,
        git_runner=git_runner,
    )
    return new_receipt, new_state_commit, pkg_info, diff_info


def _save_binding_file(binding_file, binding_data, repo_root):
    if not binding_file:
        return
    resolved = _ensure_outside_repo(binding_file, repo_root, 'binding file')
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(json.dumps(binding_data, ensure_ascii=False, indent=2), encoding='utf-8')


def _load_binding_file(binding_file, repo_root):
    resolved = _ensure_outside_repo(binding_file, repo_root, 'binding file')
    if resolved.is_symlink() or not resolved.is_file():
        raise GateError('verified binding file missing or invalid (fail-closed)')
    try:
        data = json.loads(resolved.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise GateError('failed to parse verified binding file') from None
    if not isinstance(data, dict):
        raise GateError('verified binding file must be a JSON object')
    return _validate_binding_dict(data)


def _validate_binding_dict(data):
    purpose = validate_purpose(data.get('purpose'))
    run_id = validate_run_id(data.get('runId'), 'binding.runId')
    run_attempt = validate_run_id(data.get('runAttempt'), 'binding.runAttempt')
    code_sha = validate_sha40(data.get('codeSha'), 'binding.codeSha')
    state_commit = validate_sha40(data.get('stateCommit'), 'binding.stateCommit')
    canonical_id = str(data.get('canonicalDeploymentId') or '').strip()
    if not canonical_id:
        raise GateError('binding missing canonicalDeploymentId')
    files = validate_manifest_files(data.get('files'), label='binding.files')
    return {
        'purpose': purpose,
        'runId': run_id,
        'runAttempt': run_attempt,
        'codeSha': code_sha,
        'stateCommit': state_commit,
        'canonicalDeploymentId': canonical_id,
        'files': files,
    }


def run_all_gates(
    *,
    repo_root,
    purpose,
    confirm,
    daily_run_id,
    state_commit,
    output_dir,
    account_id,
    api_token,
    state_repo=PINNED_STATE_REPOSITORY,
    state_token=None,
    state_remote_url=None,
    github_token=None,
    github_repo=None,
    github_run_id=None,
    github_ref=None,
    event_name=None,
    binding_file=None,
    production_url=PINNED_PRODUCTION_URL,
    project_fetcher=None,
    deployments_fetcher=None,
    gh_runs_fetcher=None,
    discover_runs_fetcher=None,
    run_fetcher=None,
    artifacts_fetcher=None,
    artifact_zip_fetcher=None,
    static_fetcher=None,
    git_runner=None,
    require_github_check=True,
):
    """Execute full three-way verification and materialize verified public_dir."""
    out_resolved = _ensure_outside_repo(output_dir, repo_root, 'verified output directory')
    try:
        validated = validate_inputs(
            purpose,
            confirm,
            daily_run_id,
            state_commit,
            state_repo=state_repo,
            github_repo=github_repo,
            github_ref=github_ref,
            event_name=event_name,
        )
        run_id_int = validated['dailyRunId']

        # Part 1: Verify the bound official daily-refresh run & 19-file receipt.
        receipt = verify_official_daily_run(
            github_repo,
            github_token,
            run_id_int,
            run_fetcher=run_fetcher,
            artifacts_fetcher=artifacts_fetcher,
            artifact_zip_fetcher=artifact_zip_fetcher,
            require_deployed=True,
        )

        # Part 2: Verify the bound exact state_commit contains the exact 19 files from the receipt.
        pkg_info = fetch_verified_package_from_state(
            out_resolved,
            receipt['files'],
            state_repo=state_repo,
            state_commit=state_commit,
            state_token=state_token,
            remote_url=state_remote_url,
            repo_root=repo_root,
            git_runner=git_runner,
        )

        # Concurrency & Part 3a: Verify CF production state + D1_BACKFILL_ENABLED setting.
        concurrency_info = verify_no_concurrent_deploy(
            account_id,
            api_token,
            repo=github_repo,
            github_token=github_token,
            current_run_id=github_run_id,
            deployments_fetcher=deployments_fetcher,
            gh_runs_fetcher=gh_runs_fetcher,
            require_github_check=require_github_check,
        )
        prod_info = verify_production_state(
            account_id,
            api_token,
            purpose=purpose,
            project_fetcher=project_fetcher,
        )
        prod_info['productionUrl'] = production_url

        # Part 3b: Cross-check live production commit + 17 static assets against bound receipt.
        rebound = False
        bound_receipt = receipt
        bound_state_commit = state_commit
        matches_prod = prod_info['productionCommit'] == receipt['codeSha']
        if matches_prod:
            try:
                verify_live_static_assets(
                    receipt['files'],
                    production_url=production_url,
                    static_fetcher=static_fetcher,
                )
            except GateError:
                matches_prod = False

        if matches_prod:
            diff_info = verify_main_diff(
                repo_root,
                base_sha=bound_receipt['codeSha'],
                tip_ref='HEAD',
                require_clean_tree=True,
                git_runner=git_runner,
            )
        elif purpose == 'open':
            raise GateError(
                'bound official bundle does not match current live production; '
                'open path refuses mismatch and never rebinds'
            )
        else:
            # Use freshly fetched origin/main, not a stale checkout HEAD, as the
            # allowlist tip. The new official codeSha may be a descendant of HEAD.
            remote_sha = fetch_origin_main(repo_root, git_runner=git_runner)
            bound_receipt, bound_state_commit, pkg_info, diff_info = _rebind_close_to_current_production(
                repo_root=repo_root,
                output_dir=out_resolved,
                account_id=account_id,
                api_token=api_token,
                prod_info=prod_info,
                state_repo=state_repo,
                state_token=state_token,
                state_remote_url=state_remote_url,
                github_token=github_token,
                github_repo=github_repo,
                github_run_id=github_run_id,
                tip_ref='origin/main',
                require_clean_tree=True,
                deployments_fetcher=deployments_fetcher,
                gh_runs_fetcher=gh_runs_fetcher,
                discover_runs_fetcher=discover_runs_fetcher,
                run_fetcher=run_fetcher,
                artifacts_fetcher=artifacts_fetcher,
                artifact_zip_fetcher=artifact_zip_fetcher,
                static_fetcher=static_fetcher,
                git_runner=git_runner,
                require_github_check=require_github_check,
            )
            if diff_info['headSha'] != remote_sha:
                raise GateError('origin/main SHA changed during close rebind (fail-closed)')
            confirm = _confirm_bound_bundle_still_current(
                repo_root=repo_root,
                output_dir=out_resolved,
                account_id=account_id,
                api_token=api_token,
                purpose=purpose,
                bound_receipt=bound_receipt,
                bound_state_commit=bound_state_commit,
                previous_remote_sha=remote_sha,
                production_url=production_url,
                project_fetcher=project_fetcher,
                static_fetcher=static_fetcher,
                git_runner=git_runner,
            )
            prod_info = confirm['prod_info']
            diff_info = confirm['diff_info']
            rebound = True

        binding_record = {
            'purpose': purpose,
            'runId': bound_receipt['runId'],
            'runAttempt': bound_receipt['runAttempt'],
            'codeSha': bound_receipt['codeSha'],
            'stateCommit': bound_state_commit,
            'canonicalDeploymentId': prod_info['canonicalDeploymentId'],
            'files': bound_receipt['files'],
        }
        _save_binding_file(binding_file, binding_record, repo_root)

        return {
            'verified': True,
            'purpose': purpose,
            'rebound': rebound,
            'runId': bound_receipt['runId'],
            'runAttempt': bound_receipt['runAttempt'],
            'codeSha': bound_receipt['codeSha'],
            'stateCommit': bound_state_commit,
            'pagesProject': PINNED_PAGES_PROJECT,
            'productionBranch': PINNED_PRODUCTION_BRANCH,
            'canonicalDeploymentId': prod_info['canonicalDeploymentId'],
            'switchValue': prod_info['switchValue'],
            'headSha': diff_info['headSha'],
            'changedPaths': diff_info['changedPaths'],
            'productionCommit': prod_info['productionCommit'],
            'fileCount': pkg_info['fileCount'],
            'totalBytes': pkg_info['totalBytes'],
            'concurrency': concurrency_info,
        }
    except Exception:
        shutil.rmtree(out_resolved, ignore_errors=True)
        raise


def revalidate_before_deploy(
    repo_root,
    account_id,
    api_token,
    *,
    purpose,
    output_dir,
    binding=None,
    binding_file=None,
    state_repo=PINNED_STATE_REPOSITORY,
    state_token=None,
    state_remote_url=None,
    github_token=None,
    github_repo=None,
    github_run_id=None,
    production_url=PINNED_PRODUCTION_URL,
    project_fetcher=None,
    deployments_fetcher=None,
    gh_runs_fetcher=None,
    discover_runs_fetcher=None,
    run_fetcher=None,
    artifacts_fetcher=None,
    artifact_zip_fetcher=None,
    static_fetcher=None,
    git_runner=None,
    require_github_check=True,
):
    """Immediate pre-wrangler freshness recheck across origin/main, production, 17 static, and official 19-file receipt."""
    out_resolved = _ensure_outside_repo(output_dir, repo_root, 'verified output directory')
    try:
        validate_purpose(purpose)
        if state_repo != PINNED_STATE_REPOSITORY:
            raise GateError(f'state repository mismatch: expected {PINNED_STATE_REPOSITORY}')
        if binding is None:
            if not binding_file:
                raise GateError('binding or binding_file is required for recheck')
            loaded = _load_binding_file(binding_file, repo_root)
        else:
            loaded = _validate_binding_dict(binding)
        if loaded['purpose'] != purpose:
            raise GateError(f'binding purpose mismatch: expected {loaded["purpose"]}, got {purpose}')

        remote_sha = fetch_origin_main(repo_root, git_runner=git_runner)

        prod_info = verify_production_state(
            account_id,
            api_token,
            purpose=purpose,
            project_fetcher=project_fetcher,
        )
        prod_info['productionUrl'] = production_url

        # Verify local extracted package still matches bound 19-file list.
        verify_package_tree(out_resolved, loaded['files'], state_commit=loaded['stateCommit'])

        # Re-check official run receipt (19-file package) when GitHub context is provided.
        receipt_still_matches = True
        if github_token and github_repo:
            latest_receipt = verify_official_daily_run(
                github_repo,
                github_token,
                loaded['runId'],
                run_fetcher=run_fetcher,
                artifacts_fetcher=artifacts_fetcher,
                artifact_zip_fetcher=artifact_zip_fetcher,
                require_deployed=True,
            )
            if latest_receipt['codeSha'] != loaded['codeSha'] or latest_receipt['files'] != loaded['files']:
                receipt_still_matches = False

        static_matches = True
        try:
            verify_live_static_assets(
                loaded['files'],
                production_url=production_url,
                static_fetcher=static_fetcher,
            )
        except GateError:
            static_matches = False

        unchanged = (
            receipt_still_matches
            and static_matches
            and prod_info['productionCommit'] == loaded['codeSha']
            and prod_info['canonicalDeploymentId'] == loaded['canonicalDeploymentId']
        )

        if unchanged:
            # Same official package.
            # open still requires the reviewed checkout to match origin/main.
            # close must not be rejected solely because origin/main advanced with
            # only the four audited CI files; other path changes still fail.
            if purpose == 'close':
                try:
                    match_info = verify_remote_matches_reviewed_checkout(repo_root, git_runner=git_runner)
                except GateError:
                    match_info = {
                        'reviewedSha': _resolve_git_object(
                            git_runner or _default_git_runner, Path(repo_root), 'HEAD', 'commit', 'reviewed HEAD'
                        ),
                        'remoteSha': remote_sha,
                        'match': 'close-allowlist-origin-main',
                    }
                else:
                    if match_info['remoteSha'] != remote_sha:
                        raise GateError('origin/main SHA changed during revalidation (fail-closed)')
            else:
                match_info = verify_remote_matches_reviewed_checkout(repo_root, git_runner=git_runner)
                if match_info['remoteSha'] != remote_sha:
                    raise GateError('origin/main SHA changed during revalidation (fail-closed)')
            diff_info = verify_main_diff(
                repo_root,
                base_sha=loaded['codeSha'],
                tip_ref='origin/main',
                require_clean_tree=False,
                git_runner=git_runner,
            )
            if diff_info['headSha'] != remote_sha:
                raise GateError('origin/main SHA changed during revalidation (fail-closed)')
            return {
                'verified': True,
                'rebound': False,
                'purpose': purpose,
                'runId': loaded['runId'],
                'runAttempt': loaded['runAttempt'],
                'codeSha': loaded['codeSha'],
                'stateCommit': loaded['stateCommit'],
                'remoteMainSha': remote_sha,
                'reviewedSha': match_info['reviewedSha'],
                'match': match_info['match'],
                'changedPaths': diff_info['changedPaths'],
                'productionCommit': prod_info['productionCommit'],
                'canonicalDeploymentId': prod_info['canonicalDeploymentId'],
                'switchValue': prod_info['switchValue'],
            }

        if purpose == 'open':
            raise GateError(
                'production, live static assets, or official 19-file receipt changed before deploy; '
                'open path fails closed and refuses rebinding or deploying stale bundle'
            )

        # Close rebind: origin/main may have advanced with the new official package.
        # Do not require the stale reviewed checkout to equal origin/main; the
        # allowlist is origin/main relative to the newly discovered official codeSha.
        new_receipt, new_state_commit, _pkg_info, diff_info = _rebind_close_to_current_production(
            repo_root=repo_root,
            output_dir=out_resolved,
            account_id=account_id,
            api_token=api_token,
            prod_info=prod_info,
            state_repo=state_repo,
            state_token=state_token,
            state_remote_url=state_remote_url,
            github_token=github_token,
            github_repo=github_repo,
            github_run_id=github_run_id,
            tip_ref='origin/main',
            require_clean_tree=False,
            deployments_fetcher=deployments_fetcher,
            gh_runs_fetcher=gh_runs_fetcher,
            discover_runs_fetcher=discover_runs_fetcher,
            run_fetcher=run_fetcher,
            artifacts_fetcher=artifacts_fetcher,
            artifact_zip_fetcher=artifact_zip_fetcher,
            static_fetcher=static_fetcher,
            git_runner=git_runner,
            require_github_check=require_github_check,
        )
        if diff_info['headSha'] != remote_sha:
            raise GateError('origin/main SHA changed during revalidation (fail-closed)')
        confirm = _confirm_bound_bundle_still_current(
            repo_root=repo_root,
            output_dir=out_resolved,
            account_id=account_id,
            api_token=api_token,
            purpose=purpose,
            bound_receipt=new_receipt,
            bound_state_commit=new_state_commit,
            previous_remote_sha=remote_sha,
            production_url=production_url,
            project_fetcher=project_fetcher,
            static_fetcher=static_fetcher,
            git_runner=git_runner,
        )
        prod_info = confirm['prod_info']
        diff_info = confirm['diff_info']
        remote_sha = confirm['remote_sha']

        updated_binding = {
            'purpose': purpose,
            'runId': new_receipt['runId'],
            'runAttempt': new_receipt['runAttempt'],
            'codeSha': new_receipt['codeSha'],
            'stateCommit': new_state_commit,
            'canonicalDeploymentId': prod_info['canonicalDeploymentId'],
            'files': new_receipt['files'],
        }
        if binding_file:
            _save_binding_file(binding_file, updated_binding, repo_root)

        return {
            'verified': True,
            'rebound': True,
            'purpose': purpose,
            'runId': new_receipt['runId'],
            'runAttempt': new_receipt['runAttempt'],
            'codeSha': new_receipt['codeSha'],
            'stateCommit': new_state_commit,
            'remoteMainSha': remote_sha,
            'reviewedSha': None,
            'match': 'rebind-origin-main',
            'changedPaths': diff_info['changedPaths'],
            'productionCommit': prod_info['productionCommit'],
            'canonicalDeploymentId': prod_info['canonicalDeploymentId'],
            'switchValue': prod_info['switchValue'],
        }
    except Exception:
        shutil.rmtree(out_resolved, ignore_errors=True)
        raise


def build_wrangler_deploy_args(public_dir, *, code_sha):
    """Build the exact Wrangler 3 Pages deploy command arguments for open/close."""
    validate_sha40(code_sha, 'code_sha')
    resolved = Path(public_dir).resolve()
    return [
        'npx',
        '--yes',
        'wrangler@3',
        'pages',
        'deploy',
        str(resolved),
        '--project-name',
        PINNED_PAGES_PROJECT,
        '--branch',
        PINNED_PRODUCTION_BRANCH,
        '--commit-dirty=true',
        '--commit-hash',
        code_sha,
    ]


def _write_github_output(verified, *, code_sha=None):
    out_file = os.environ.get('GITHUB_OUTPUT', '').strip()
    if not out_file:
        return
    with open(out_file, 'a', encoding='utf-8') as stream:
        stream.write(f'verified={"true" if verified else "false"}\n')
        if verified and code_sha:
            validate_sha40(code_sha, 'output code_sha')
            stream.write(f'code_sha={code_sha}\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description='Three-way verification and official-bundle binder.')
    parser.add_argument(
        '--recheck-before-deploy',
        action='store_true',
        help='Immediate pre-wrangler freshness recheck (and fail-closed close rebind if production moved).',
    )
    parser.add_argument('--purpose')
    parser.add_argument('--confirm')
    parser.add_argument('--daily-run-id')
    parser.add_argument('--state-commit')
    parser.add_argument('--output-dir')
    parser.add_argument('--binding-file')
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[1]
    try:
        if args.recheck_before_deploy:
            if not args.purpose or not args.output_dir or not args.binding_file:
                raise GateError('purpose, output-dir, and binding-file are required for --recheck-before-deploy')
            summary = revalidate_before_deploy(
                repo_root,
                os.environ.get('CLOUDFLARE_ACCOUNT_ID', ''),
                os.environ.get('CLOUDFLARE_API_TOKEN', ''),
                purpose=args.purpose,
                output_dir=args.output_dir,
                binding_file=args.binding_file,
                state_repo=os.environ.get('XINZHI_STATE_REPOSITORY', PINNED_STATE_REPOSITORY),
                state_token=os.environ.get('XINZHI_STATE_TOKEN', ''),
                github_token=os.environ.get('GITHUB_TOKEN', ''),
                github_repo=os.environ.get('GITHUB_REPOSITORY', ''),
                github_run_id=os.environ.get('GITHUB_RUN_ID', ''),
            )
        else:
            if (
                not args.purpose
                or not args.confirm
                or not args.daily_run_id
                or not args.state_commit
                or not args.output_dir
            ):
                raise GateError(
                    'purpose, confirm, daily-run-id, state-commit, and output-dir are required'
                )
            summary = run_all_gates(
                repo_root=repo_root,
                purpose=args.purpose,
                confirm=args.confirm,
                daily_run_id=args.daily_run_id,
                state_commit=args.state_commit,
                output_dir=args.output_dir,
                binding_file=args.binding_file,
                account_id=os.environ.get('CLOUDFLARE_ACCOUNT_ID', ''),
                api_token=os.environ.get('CLOUDFLARE_API_TOKEN', ''),
                state_repo=os.environ.get('XINZHI_STATE_REPOSITORY', PINNED_STATE_REPOSITORY),
                state_token=os.environ.get('XINZHI_STATE_TOKEN', ''),
                github_token=os.environ.get('GITHUB_TOKEN', ''),
                github_repo=os.environ.get('GITHUB_REPOSITORY', ''),
                github_run_id=os.environ.get('GITHUB_RUN_ID', ''),
                github_ref=os.environ.get('GITHUB_REF'),
                event_name=os.environ.get('GITHUB_EVENT_NAME'),
            )
    except GateError as exc:
        _write_github_output(False)
        print(f'GATE_FAILED: {exc}', file=sys.stderr)
        return 1

    _write_github_output(True, code_sha=summary.get('codeSha'))
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
