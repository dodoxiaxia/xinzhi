#!/usr/bin/env python3
"""Fail-closed gates and verified-package fetcher for deploy-only-verified CI.

This script enforces all pre-deploy gates before Cloudflare Pages deployment of
the pre-verified 19-file public package (package code SHA d646340, state commit
c6eb758). It never builds, refreshes, writes to the state branch, or prints
credentials.
"""
import argparse
import hashlib
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
import urllib.request

PINNED_PACKAGE_CODE_SHA = 'd646340107ca82ceb902ded4f64c403556ad7345'
PINNED_STATE_COMMIT = 'c6eb758a08b9b449fe84e2139564d3eb474b38d3'
PINNED_STATE_REPOSITORY = 'dodoxiaxia/xinzhi-state'
PINNED_PAGES_PROJECT = 'dryz-xinzhi'
PINNED_PRODUCTION_BRANCH = 'main'
EXPECTED_CONFIRM = 'publish-verified-d646340-c6eb758'
ALLOWED_PURPOSES = frozenset(('open', 'close'))
PINNED_FILE_COUNT = 19
DEFAULT_PIN_REL = Path('config/deploy-only-verified-public.json')

ALLOWED_MAIN_DIFF_PATHS = frozenset((
    '.github/workflows/deploy-only-verified.yml',
    'scripts/deploy_only_verified.py',
    'scripts/test_deploy_only_verified.py',
    'config/deploy-only-verified-public.json',
    'docs/deploy-only-verified.md',
))

TERMINAL_CF_STAGES = frozenset(('success', 'failure', 'canceled', 'skipped'))
ACTIVE_GH_STATUSES = frozenset(('in_progress', 'waiting', 'pending', 'requested'))
GH_RUNS_PER_PAGE = 30
GH_RUNS_MAX_PAGES = 10
CF_DEPLOYS_PER_PAGE = 10
CF_DEPLOYS_MAX_PAGES = 10
SHA40_RE = re.compile(r'^[0-9a-f]{40}$')
SHA64_RE = re.compile(r'^[0-9a-f]{64}$')


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


def validate_inputs(purpose, confirm, *, state_repo=None, github_ref=None, event_name=None):
    """Validate workflow_dispatch inputs and execution context strictly."""
    _reject_control_or_traversal(purpose, 'purpose')
    if purpose not in ALLOWED_PURPOSES:
        raise GateError(f'invalid purpose: expected one of {sorted(ALLOWED_PURPOSES)}')

    _reject_control_or_traversal(confirm, 'confirm')
    if confirm != EXPECTED_CONFIRM:
        raise GateError('invalid confirm literal: does not match required confirmation token')

    if state_repo is not None:
        _reject_control_or_traversal(state_repo, 'state_repo')
        if state_repo != PINNED_STATE_REPOSITORY:
            raise GateError(f'state repository mismatch: expected {PINNED_STATE_REPOSITORY}')

    if github_ref is not None:
        _reject_control_or_traversal(github_ref, 'github_ref')
        if github_ref != f'refs/heads/{PINNED_PRODUCTION_BRANCH}':
            raise GateError(f'ref gate failed: only refs/heads/{PINNED_PRODUCTION_BRANCH} is allowed')

    if event_name is not None:
        _reject_control_or_traversal(event_name, 'event_name')
        if event_name != 'workflow_dispatch':
            raise GateError('event gate failed: only workflow_dispatch is allowed')

    return {'purpose': purpose, 'confirm': confirm}


def load_pin_manifest(pin_path):
    """Load and validate the pinned 19-file package manifest."""
    path = Path(pin_path)
    if path.is_symlink() or not path.is_file():
        raise GateError(f'pinned manifest missing or not an ordinary file: {path}')
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise GateError(f'failed to parse pinned manifest: {exc}') from exc

    if not isinstance(data, dict):
        raise GateError('pinned manifest must be a JSON object')

    expected_meta = {
        'packageCodeSha': PINNED_PACKAGE_CODE_SHA,
        'stateCommit': PINNED_STATE_COMMIT,
        'stateRepository': PINNED_STATE_REPOSITORY,
        'pagesProject': PINNED_PAGES_PROJECT,
        'productionBranch': PINNED_PRODUCTION_BRANCH,
        'file_count': PINNED_FILE_COUNT,
    }
    for key, expected in expected_meta.items():
        if data.get(key) != expected:
            raise GateError(f'pinned manifest metadata mismatch for {key}')

    files = data.get('files')
    if not isinstance(files, list) or len(files) != PINNED_FILE_COUNT:
        raise GateError(f'pinned manifest must contain exactly {PINNED_FILE_COUNT} files')

    seen = set()
    validated_files = []
    for idx, entry in enumerate(files):
        if not isinstance(entry, dict):
            raise GateError(f'pinned manifest entry {idx} must be an object')
        rel = validate_safe_relpath(entry.get('path', ''))
        if rel in seen:
            raise GateError(f'duplicate path in pinned manifest: {rel}')
        seen.add(rel)
        size = entry.get('bytes')
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise GateError(f'invalid byte size in pinned manifest for {rel}')
        digest = entry.get('sha256')
        if not isinstance(digest, str) or not SHA64_RE.fullmatch(digest):
            raise GateError(f'invalid 64-char sha256 in pinned manifest for {rel}')
        validated_files.append({'path': rel, 'bytes': size, 'sha256': digest})

    return {
        **expected_meta,
        'files': validated_files,
    }


def _default_git_runner(cwd, args, env=None, timeout=60):
    merged_env = dict(os.environ)
    if env:
        merged_env.update(env)
    # Fetching the pinned public/ tree can exceed a short timeout on a cold runner.
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


def verify_main_diff(repo_root, *, base_sha=None, tip_ref='HEAD', require_clean_tree=True, git_runner=None):
    """Gate 3: Ensure a tip (HEAD or origin/main) only adds the audited deploy-only CI files relative to d646340.

    The tip is allowed (and expected, after merging) to differ from d646340.
    Pre-deploy recheck must pass tip_ref='origin/main' after a fresh fetch; do not reuse a stale checkout HEAD.
    """
    if base_sha is None:
        base_sha = PINNED_PACKAGE_CODE_SHA
    validate_sha40(base_sha, 'base_sha')
    if base_sha != PINNED_PACKAGE_CODE_SHA:
        raise GateError('base_sha must match pinned packageCodeSha')
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
        raise GateError(f'pinned base commit {base_sha} missing from local git history (fetch-depth must include it)')

    res_anc = run_git(root, ['merge-base', '--is-ancestor', base_sha, tip_sha])
    if res_anc.returncode != 0:
        raise GateError(f'pinned base commit {base_sha} is not an ancestor of {tip_ref}')

    if require_clean_tree:
        res_dirty = run_git(root, ['diff', '--name-only', 'HEAD'])
        if res_dirty.returncode != 0:
            raise GateError('failed to inspect working tree cleanliness')
        if res_dirty.stdout.strip():
            raise GateError('working tree has uncommitted tracked modifications')

    res_diff = run_git(root, ['diff', '--name-status', '--no-renames', f'{base_sha}..{tip_sha}'])
    if res_diff.returncode != 0:
        raise GateError(f'failed to compute git diff from {base_sha}..{tip_ref}')

    added_paths = []
    for raw_line in res_diff.stdout.splitlines():
        line = raw_line.rstrip('\r\n')
        if not line:
            continue
        parts = line.split('\t', 1)
        if len(parts) != 2:
            raise GateError(f'unexpected git diff --name-status line: {line}')
        status, raw_path = parts
        rel = validate_safe_relpath(raw_path)
        if status != 'A':
            raise GateError(f'existing file modified/deleted relative to {base_sha}: {status} {rel}')
        if rel not in ALLOWED_MAIN_DIFF_PATHS:
            raise GateError(f'path outside deploy-only allowlist relative to {base_sha}: {rel}')
        added_paths.append(rel)

    return {'headSha': tip_sha, 'tipRef': tip_ref, 'addedPaths': sorted(added_paths)}


def _http_get_json(url, headers):
    req = urllib.request.Request(url, headers=headers, method='GET')
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            status = getattr(resp, 'status', 200)
            body = resp.read().decode('utf-8')
    except urllib.error.HTTPError as exc:
        raise GateError(f'HTTP request failed with status {exc.code}') from None
    except (urllib.error.URLError, OSError, UnicodeDecodeError) as exc:
        raise GateError(f'network request failed: {type(exc).__name__}') from None
    if status < 200 or status >= 300:
        raise GateError(f'unexpected HTTP status {status}')
    try:
        return json.loads(body)
    except ValueError:
        raise GateError('API returned invalid JSON') from None


def default_cf_project_fetcher(account_id, api_token, project_name):
    url = f'https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}'
    return _http_get_json(url, {
        'Authorization': f'Bearer {api_token}',
        'Accept': 'application/json',
    })


def default_cf_deployments_fetcher(account_id, api_token, project_name, *, http_get=_http_get_json):
    """List Pages deployments with pagination. This is not a claim of infinite history.

    Each page is CF_DEPLOYS_PER_PAGE items (10). If listing cannot be shown complete
    within CF_DEPLOYS_MAX_PAGES, raise GateError (fail-closed).
    """
    headers = {
        'Authorization': f'Bearer {api_token}',
        'Accept': 'application/json',
    }
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


def default_gh_runs_fetcher(repo, github_token, *, http_get=_http_get_json):
    """List Actions runs with pagination. Not a full historical scan.

    Each page is GH_RUNS_PER_PAGE (30). If the listing cannot be shown complete
    within GH_RUNS_MAX_PAGES, raise GateError (fail-closed) instead of treating
    the first page as complete.
    """
    headers = {
        'Authorization': f'Bearer {github_token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'xinzhi-deploy-only-verified',
    }
    all_runs = []
    page = 1
    total_count = None
    while page <= GH_RUNS_MAX_PAGES:
        url = f'https://api.github.com/repos/{repo}/actions/runs?per_page={GH_RUNS_PER_PAGE}&page={page}'
        payload = http_get(url, headers)
        if not isinstance(payload, dict) or not isinstance(payload.get('workflow_runs'), list):
            raise GateError('unable to inspect GitHub Actions workflow runs (fail-closed)')
        runs = payload['workflow_runs']
        if 'total_count' in payload:
            total_count = payload.get('total_count')
        all_runs.extend(runs)
        if isinstance(total_count, int) and total_count >= 0 and len(all_runs) >= total_count:
            return {'total_count': total_count, 'workflow_runs': all_runs}
        if len(runs) < GH_RUNS_PER_PAGE:
            return {'total_count': total_count if total_count is not None else len(all_runs), 'workflow_runs': all_runs}
        page += 1
    raise GateError(
        f'GitHub Actions runs listing truncated after {len(all_runs)} entries '
        f'(per_page={GH_RUNS_PER_PAGE}, max_pages={GH_RUNS_MAX_PAGES}); fail-closed, not a complete scan'
    )


def _require_nonempty_secret(value, name):
    if not isinstance(value, str) or not value.strip():
        raise GateError(f'missing required environment secret/config: {name}')


def verify_production_code_sha(account_id, api_token, *, project_fetcher=None):
    """Gate 1: Verify live Cloudflare Pages canonical/latest production deployment is d646340."""
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
    if not isinstance(canonical, dict):
        raise GateError('Cloudflare Pages project has no canonical_deployment (fail-closed)')
    if canonical.get('environment') != 'production':
        raise GateError('canonical_deployment environment is not production')

    stage = canonical.get('latest_stage')
    if not isinstance(stage, dict) or stage.get('status') != 'success':
        raise GateError('canonical_deployment latest_stage is not success')

    trigger = canonical.get('deployment_trigger') or {}
    meta = trigger.get('metadata') if isinstance(trigger, dict) else None
    if not isinstance(meta, dict):
        raise GateError('canonical_deployment missing deployment_trigger.metadata')

    branch = meta.get('branch')
    if branch is not None and branch != PINNED_PRODUCTION_BRANCH:
        raise GateError(f'canonical_deployment branch mismatch: {branch}')

    commit_hash = str(meta.get('commit_hash') or '').strip().lower()
    if commit_hash != PINNED_PACKAGE_CODE_SHA:
        raise GateError(
            f'production code SHA mismatch: live canonical is {commit_hash or "unknown"}, '
            f'expected {PINNED_PACKAGE_CODE_SHA}'
        )

    latest = result.get('latest_deployment')
    if isinstance(latest, dict) and latest.get('environment') == 'production':
        latest_stage = (latest.get('latest_stage') or {}).get('status')
        if latest_stage not in ('success', 'failure', 'canceled'):
            raise GateError(f'latest production deployment is not in terminal state: {latest_stage}')
        if latest_stage == 'success':
            latest_meta = (latest.get('deployment_trigger') or {}).get('metadata') or {}
            latest_commit = str(latest_meta.get('commit_hash') or '').strip().lower()
            if latest_commit != PINNED_PACKAGE_CODE_SHA:
                raise GateError(
                    f'latest successful production deployment is {latest_commit or "unknown"}, '
                    f'expected {PINNED_PACKAGE_CODE_SHA}'
                )

    return {
        'productionCommit': commit_hash,
        'canonicalDeploymentId': str(canonical.get('id') or ''),
    }


def fetch_origin_main(repo_root, *, git_runner=None):
    """Fetch current origin/main. Fail-closed; do not fall back to a stale checkout HEAD."""
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
    """Require remote tip to be the reviewed checkout commit, or an exact same tree.

    The d646340 allowlist only sees path additions. A later commit that rewrites
    the same five files would still appear as status A and must not auto-pass.
    This workflow's own merge may be the reviewed HEAD; later tip changes must stop.
    """
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


def revalidate_before_deploy(
    repo_root,
    account_id,
    api_token,
    *,
    project_fetcher=None,
    git_runner=None,
):
    """Immediate pre-wrangler freshness check: live production SHA and remote origin/main allowlist."""
    remote_sha = fetch_origin_main(repo_root, git_runner=git_runner)
    match_info = verify_remote_matches_reviewed_checkout(repo_root, git_runner=git_runner)
    if match_info['remoteSha'] != remote_sha:
        raise GateError('origin/main SHA changed during revalidation (fail-closed)')
    diff_info = verify_main_diff(
        repo_root,
        tip_ref='origin/main',
        require_clean_tree=False,
        git_runner=git_runner,
    )
    if diff_info['headSha'] != remote_sha:
        raise GateError('origin/main SHA changed during revalidation (fail-closed)')
    prod_info = verify_production_code_sha(account_id, api_token, project_fetcher=project_fetcher)
    return {
        'verified': True,
        'remoteMainSha': remote_sha,
        'reviewedSha': match_info['reviewedSha'],
        'match': match_info['match'],
        'addedPaths': diff_info['addedPaths'],
        'productionCommit': prod_info['productionCommit'],
        'canonicalDeploymentId': prod_info['canonicalDeploymentId'],
    }


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
    """Gate 5: Fail-closed check for active Cloudflare Pages deployments or conflicting CI runs."""
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

    if require_github_check:
        if not repo or not isinstance(repo, str):
            raise GateError('missing GITHUB_REPOSITORY for concurrency check (fail-closed)')
        _require_nonempty_secret(github_token, 'GITHUB_TOKEN')
        if not current_run_id or not str(current_run_id).strip():
            raise GateError('missing GITHUB_RUN_ID for concurrency check (fail-closed)')
        gh_fetch = gh_runs_fetcher or default_gh_runs_fetcher
        gh_payload = gh_fetch(repo, github_token)
        if not isinstance(gh_payload, dict) or not isinstance(gh_payload.get('workflow_runs'), list):
            raise GateError('unable to inspect GitHub Actions workflow runs (fail-closed)')

        self_id = str(current_run_id).strip()
        for run in gh_payload['workflow_runs']:
            if not isinstance(run, dict):
                continue
            if str(run.get('id') or '') == self_id:
                continue
            wf_path = str(run.get('path') or '')
            wf_name = str(run.get('name') or '')
            status = run.get('status')
            if wf_path.endswith('/daily.yml') or wf_path == '.github/workflows/daily.yml' or wf_name == 'daily-refresh':
                if status != 'completed':
                    raise GateError(f'daily-refresh workflow has non-completed run (status={status})')
            elif (
                wf_path.endswith('/deploy-only-verified.yml')
                or wf_path == '.github/workflows/deploy-only-verified.yml'
                or wf_name == 'deploy-only-verified'
            ):
                if status != 'completed':
                    raise GateError(f'another deploy-only-verified run is not completed (status={status})')

    return {'cloudflareChecked': len(deployments), 'githubChecked': bool(require_github_check)}


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_package_tree(public_dir, pin):
    """Gate 2: Verify extracted public directory matches the exact 19 pinned files (bytes + sha256)."""
    directory = Path(public_dir)
    if directory.is_symlink() or not directory.is_dir():
        raise GateError('verified public directory does not exist or is a symlink')

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

    expected_by_path = {item['path']: item for item in pin['files']}
    expected_paths = set(expected_by_path)
    actual_paths = set(actual_files)

    missing = sorted(expected_paths - actual_paths)
    extra = sorted(actual_paths - expected_paths)
    if missing or extra:
        raise GateError(f'verified public file set mismatch (missing={missing}, extra={extra})')
    if len(actual_paths) != PINNED_FILE_COUNT:
        raise GateError(f'expected {PINNED_FILE_COUNT} files, got {len(actual_paths)}')

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
        'fileCount': PINNED_FILE_COUNT,
        'totalBytes': total_bytes,
        'stateCommit': pin['stateCommit'],
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


def fetch_verified_package_from_state(
    output_dir,
    pin,
    *,
    state_repo=PINNED_STATE_REPOSITORY,
    state_commit=PINNED_STATE_COMMIT,
    state_token=None,
    remote_url=None,
    repo_root=None,
    git_runner=None,
):
    """Fetch public/ exclusively from pinned state commit and verify 19-file fingerprints."""
    if state_repo != PINNED_STATE_REPOSITORY:
        raise GateError(f'state repository mismatch: expected {PINNED_STATE_REPOSITORY}')
    validate_sha40(state_commit, 'state_commit')
    if state_commit != PINNED_STATE_COMMIT:
        raise GateError(f'state commit mismatch: expected {PINNED_STATE_COMMIT}')

    out_resolved = Path(output_dir).resolve()
    if repo_root is not None:
        root_resolved = Path(repo_root).resolve()
        if out_resolved == root_resolved or root_resolved in out_resolved.parents:
            raise GateError('verified output directory must be outside repository working tree')

    run_git = git_runner or _default_git_runner

    with tempfile.TemporaryDirectory(prefix='xinzhi-verified-pkg-') as tmp:
        tmp_path = Path(tmp)
        git_dir = tmp_path / 'state-git'
        git_dir.mkdir()

        init_res = run_git(git_dir, ['init', '-q'])
        if init_res.returncode != 0:
            raise GateError('failed to initialize temporary git directory')

        git_env = {'GIT_TERMINAL_PROMPT': '0'}
        if remote_url is None:
            _require_nonempty_secret(state_token, 'XINZHI_STATE_TOKEN')
            askpass = _make_askpass_script(tmp_path)
            git_env['GIT_ASKPASS'] = str(askpass)
            git_env['XINZHI_STATE_TOKEN'] = state_token
            effective_remote = f'https://github.com/{state_repo}.git'
        else:
            effective_remote = remote_url

        # Clear any actions/checkout http.extraheader so state auth never uses wrong token.
        clear_header = ['-c', 'http.https://github.com/.extraheader=']
        fetch_sha = run_git(git_dir, [*clear_header, 'fetch', '-q', '--depth=1', effective_remote, state_commit], env=git_env)
        if fetch_sha.returncode != 0:
            # Some git servers disallow fetching raw SHA directly when it is a branch tip;
            # fetch refs/heads/state only to populate objects, then verify exact state_commit below.
            fetch_ref = run_git(
                git_dir,
                [*clear_header, 'fetch', '-q', '--depth=1', effective_remote, 'refs/heads/state'],
                env=git_env,
            )
            if fetch_ref.returncode != 0:
                raise GateError('failed to fetch pinned state commit from state repository')

        has_commit = run_git(git_dir, ['cat-file', '-e', f'{state_commit}^{{commit}}'])
        if has_commit.returncode != 0:
            raise GateError(f'pinned state commit {state_commit} not found in fetched state repository')

        tar_path = tmp_path / 'verified-public.tar'
        arch_res = run_git(git_dir, ['archive', '--format=tar', '-o', str(tar_path), state_commit, 'public'])
        if arch_res.returncode != 0 or not tar_path.is_file():
            raise GateError(f'failed to export public/ from pinned state commit {state_commit}')

        try:
            _safe_extract_public_tar(tar_path, out_resolved)
            summary = verify_package_tree(out_resolved, pin)
        except Exception:
            shutil.rmtree(out_resolved, ignore_errors=True)
            raise

    return summary


def build_wrangler_deploy_args(public_dir):
    """Build the exact Wrangler 3 Pages deploy command arguments for open/close."""
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
        PINNED_PACKAGE_CODE_SHA,
    ]


def run_all_gates(
    *,
    repo_root,
    purpose,
    confirm,
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
    pin_path=None,
    project_fetcher=None,
    deployments_fetcher=None,
    gh_runs_fetcher=None,
    git_runner=None,
    require_github_check=True,
):
    """Execute all fail-closed pre-deploy gates and materialize verified public_dir."""
    validate_inputs(
        purpose,
        confirm,
        state_repo=state_repo,
        github_ref=github_ref,
        event_name=event_name,
    )
    resolved_pin = Path(pin_path) if pin_path is not None else Path(repo_root) / DEFAULT_PIN_REL
    pin = load_pin_manifest(resolved_pin)

    diff_info = verify_main_diff(repo_root, base_sha=pin['packageCodeSha'], git_runner=git_runner)
    prod_info = verify_production_code_sha(account_id, api_token, project_fetcher=project_fetcher)
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
    pkg_info = fetch_verified_package_from_state(
        output_dir,
        pin,
        state_repo=state_repo,
        state_commit=pin['stateCommit'],
        state_token=state_token,
        remote_url=state_remote_url,
        repo_root=repo_root,
        git_runner=git_runner,
    )

    return {
        'verified': True,
        'purpose': purpose,
        'packageCodeSha': pin['packageCodeSha'],
        'stateCommit': pin['stateCommit'],
        'pagesProject': pin['pagesProject'],
        'productionBranch': pin['productionBranch'],
        'headSha': diff_info['headSha'],
        'addedPaths': diff_info['addedPaths'],
        'productionCommit': prod_info['productionCommit'],
        'fileCount': pkg_info['fileCount'],
        'totalBytes': pkg_info['totalBytes'],
        'concurrency': concurrency_info,
    }


def _write_github_output(verified):
    out_file = os.environ.get('GITHUB_OUTPUT', '').strip()
    if not out_file:
        return
    with open(out_file, 'a', encoding='utf-8') as stream:
        stream.write(f'verified={"true" if verified else "false"}\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description='Verify gates and fetch pinned public package.')
    parser.add_argument('--recheck-before-deploy', action='store_true',
                        help='Immediate pre-wrangler freshness recheck only (production SHA + origin/main).')
    parser.add_argument('--purpose')
    parser.add_argument('--confirm')
    parser.add_argument('--output-dir')
    parser.add_argument('--pin-path', default=None)
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[1]
    try:
        if args.recheck_before_deploy:
            summary = revalidate_before_deploy(
                repo_root,
                os.environ.get('CLOUDFLARE_ACCOUNT_ID', ''),
                os.environ.get('CLOUDFLARE_API_TOKEN', ''),
            )
        else:
            if not args.purpose or not args.confirm or not args.output_dir:
                raise GateError('purpose, confirm, and output-dir are required unless --recheck-before-deploy')
            summary = run_all_gates(
                repo_root=repo_root,
                purpose=args.purpose,
                confirm=args.confirm,
                output_dir=args.output_dir,
                account_id=os.environ.get('CLOUDFLARE_ACCOUNT_ID', ''),
                api_token=os.environ.get('CLOUDFLARE_API_TOKEN', ''),
                state_repo=os.environ.get('XINZHI_STATE_REPOSITORY', PINNED_STATE_REPOSITORY),
                state_token=os.environ.get('XINZHI_STATE_TOKEN', ''),
                github_token=os.environ.get('GITHUB_TOKEN', ''),
                github_repo=os.environ.get('GITHUB_REPOSITORY', ''),
                github_run_id=os.environ.get('GITHUB_RUN_ID', ''),
                github_ref=os.environ.get('GITHUB_REF'),
                event_name=os.environ.get('GITHUB_EVENT_NAME'),
                pin_path=args.pin_path,
            )
    except GateError as exc:
        _write_github_output(False)
        print(f'GATE_FAILED: {exc}', file=sys.stderr)
        return 1

    _write_github_output(True)
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
