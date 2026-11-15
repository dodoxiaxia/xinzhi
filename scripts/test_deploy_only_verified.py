"""Offline unit tests for input-bound deploy-only-verified CI workflow and gates.

All checks use local temporary directories, bare Git fixtures, in-memory ZIP
archives, and mocked API responses. No network access, real secrets, or
production deployments occur.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import deploy_only_verified as dov  # noqa: E402

WORKFLOW_PATH = ROOT / '.github/workflows/deploy-only-verified.yml'
FAKE_CF_TOKEN = 'fake-cf-api-token-for-offline-test'
FAKE_CF_ACCOUNT = 'fake-cf-account-for-offline-test'
FAKE_GH_TOKEN = 'fake-gh-token-for-offline-test'
FAKE_STATE_TOKEN = 'fake-state-token-for-offline-test'
FAKE_REPO = 'dodoxiaxia/xinzhi'

SYNTHETIC_19_PATHS = (
    '_headers',
    '_worker.js',
    'assets/app.111111111111.js',
    'assets/data-board.222222222222.js',
    'assets/data-feeds.333333333333.js',
    'assets/data-health.444444444444.js',
    'assets/data-library.555555555555.js',
    'assets/data-pregenerated.666666666666.js',
    'assets/data-quicklooks.777777777777.js',
    'assets/data-radar.888888888888.js',
    'assets/data-readings.999999999999.js',
    'assets/radar.aaaaaaaaaaaa.js',
    'assets/style.bbbbbbbbbbbb.css',
    'demo-reading.html',
    'feed.xml',
    'icon.png',
    'index.html',
    'shards/readings-2026-10.cccccccccccc.js',
    'shards/readings-2026-11.dddddddddddd.js',
)


def _git(cwd, *args):
    return subprocess.run(
        ['git', *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
    )


def _init_git_repo(repo_dir):
    _git(repo_dir, 'init', '-q', '-b', 'main')
    _git(repo_dir, 'config', 'user.email', 'offline-fixture@example.invalid')
    _git(repo_dir, 'config', 'user.name', 'Offline Fixture')


def _init_bare_state_remote(bare_dir):
    _git(bare_dir.parent, 'init', '--bare', str(bare_dir))
    _git(bare_dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true')


def _commit_all(repo_dir, message):
    _git(repo_dir, 'add', '-A')
    _git(repo_dir, 'commit', '-qm', message)
    return _git(repo_dir, 'rev-parse', 'HEAD').stdout.strip()


def _make_19_files(public_dir, *, tag='v1', override_content=None):
    content_by_path = {}
    manifest = []
    for idx, rel in enumerate(SYNTHETIC_19_PATHS):
        content = f'offline-synthetic-{tag}-{idx}-{rel}\n'.encode('utf-8')
        if override_content and rel in override_content:
            content = override_content[rel]
        target = Path(public_dir) / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        content_by_path[rel] = content
        manifest.append({
            'path': rel,
            'bytes': len(content),
            'sha256': hashlib.sha256(content).hexdigest(),
        })
    return manifest, content_by_path


def _make_receipt_zip(receipt_dict, *, member_name='docs/deployment-status.json'):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(member_name, json.dumps(receipt_dict, ensure_ascii=False))
    return buf.getvalue()


def _make_run_obj(
    run_id,
    *,
    repo=FAKE_REPO,
    path='.github/workflows/daily.yml',
    name='daily-refresh',
    status='completed',
    conclusion='success',
    run_attempt=1,
    head_branch='main',
    head_sha='a' * 40,
):
    return {
        'id': run_id,
        'path': path,
        'name': name,
        'status': status,
        'conclusion': conclusion,
        'run_attempt': run_attempt,
        'head_branch': head_branch,
        'head_sha': head_sha,
        'repository': {'full_name': repo},
        'url': f'https://api.github.com/repos/{repo}/actions/runs/{run_id}',
        'html_url': f'https://github.com/{repo}/actions/runs/{run_id}',
        'artifacts_url': f'https://api.github.com/repos/{repo}/actions/runs/{run_id}/artifacts',
    }


def _make_receipt_dict(
    run_id,
    *,
    repo=FAKE_REPO,
    run_attempt=1,
    code_sha='a' * 40,
    files=None,
    deployed=True,
    deployment_outcome='success',
    deployment_requested=True,
    refresh_outcome='success',
    state_outcome='success',
    status='deployed',
):
    return {
        'recordKind': 'pipeline_final',
        'runUrl': f'https://github.com/{repo}/actions/runs/{run_id}',
        'runAttempt': str(run_attempt),
        'codeSha': code_sha,
        'refreshOutcome': refresh_outcome,
        'deploymentRequested': deployment_requested,
        'deploymentOutcome': deployment_outcome,
        'stateOutcome': state_outcome,
        'deployed': deployed,
        'status': status,
        'build': {'files': list(files or [])},
    }


def _make_artifacts_payload(run_id, *, repo=FAKE_REPO, run_attempt=1, artifact_id=5001, name=None, expired=False):
    art_name = name if name is not None else f'pipeline-final-{run_id}-{run_attempt}'
    return {
        'total_count': 1,
        'artifacts': [
            {
                'id': artifact_id,
                'name': art_name,
                'expired': expired,
                'workflow_run': {'id': run_id},
                'archive_download_url': f'https://api.github.com/repos/{repo}/actions/artifacts/{artifact_id}/zip',
            }
        ],
    }


def _cf_project_response(
    commit_hash,
    *,
    canonical_id='dep-prod-1',
    latest_id=None,
    latest_commit=None,
    latest_status='success',
    canonical_status='success',
    switch_value='false',
    switch_type='plain_text',
    switch_present=True,
    live_dep_switch=None,
):
    actual_latest_id = latest_id if latest_id is not None else canonical_id
    latest_hash = latest_commit if latest_commit is not None else commit_hash
    env_vars = {}
    if switch_present:
        env_vars['D1_BACKFILL_ENABLED'] = {'type': switch_type, 'value': switch_value}
    dep_env_snapshot = {}
    if live_dep_switch is not None:
        dep_env_snapshot['D1_BACKFILL_ENABLED'] = {'type': 'plain_text', 'value': live_dep_switch}
    return {
        'success': True,
        'result': {
            'name': dov.PINNED_PAGES_PROJECT,
            'subdomain': 'dryz-xinzhi.pages.dev',
            'domains': ['learn.dryz.info'],
            'deployment_configs': {
                'production': {
                    'env_vars': env_vars,
                }
            },
            'canonical_deployment': {
                'id': canonical_id,
                'environment': 'production',
                'latest_stage': {'name': 'deploy', 'status': canonical_status},
                'env_vars': dep_env_snapshot,
                'deployment_trigger': {
                    'type': 'ad_hoc',
                    'metadata': {
                        'branch': 'main',
                        'commit_hash': commit_hash,
                        'commit_dirty': True,
                    },
                },
            },
            'latest_deployment': {
                'id': actual_latest_id,
                'environment': 'production',
                'latest_stage': {'name': 'deploy', 'status': latest_status},
                'env_vars': dep_env_snapshot,
                'deployment_trigger': {
                    'type': 'ad_hoc',
                    'metadata': {
                        'branch': 'main',
                        'commit_hash': latest_hash,
                        'commit_dirty': True,
                    },
                },
            },
        },
    }


def _cf_deployments_response(*statuses):
    return {
        'success': True,
        'result': [
            {
                'id': f'fake-dep-{idx}',
                'environment': 'production',
                'latest_stage': {'name': 'deploy', 'status': status},
            }
            for idx, status in enumerate(statuses)
        ],
    }


def _gh_runs_response(runs):
    return {'total_count': len(runs), 'workflow_runs': runs}


def _top_level_yaml_keys(text):
    keys = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if not line[0].isspace() and ':' in line:
            keys.append(line.split(':', 1)[0].strip())
    return keys


def _on_section_events(text):
    lines = text.splitlines()
    events = []
    in_on = False
    for line in lines:
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if not line[0].isspace():
            in_on = line.startswith('on:')
            continue
        if in_on and line.startswith('  ') and not line.startswith('    ') and ':' in line:
            events.append(line.strip().split(':', 1)[0])
    return events


class WorkflowYamlTests(unittest.TestCase):
    def test_workflow_is_input_bound_manual_dispatch_only_with_minimal_permissions(self):
        text = WORKFLOW_PATH.read_text(encoding='utf-8')
        self.assertIn('on', _top_level_yaml_keys(text))
        self.assertEqual(_on_section_events(text), ['workflow_dispatch'])
        for forbidden in ('push:', 'schedule:', 'pull_request:', 'workflow_call:', 'repository_dispatch:'):
            self.assertNotIn(forbidden, text)

        self.assertIn('contents: read', text)
        self.assertIn('actions: read', text)
        self.assertNotIn('contents: write', text)
        self.assertNotIn('id-token:', text)

        self.assertIn("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'", text)
        self.assertIn('group: daily-refresh-state', text)
        self.assertIn('cancel-in-progress: false', text)
        self.assertNotIn('daily-refresh-push', text)

        for required_input in ('purpose:', 'confirm:', 'daily_run_id:', 'state_commit:'):
            self.assertIn(required_input, text)
        self.assertIn('publish-official-bound-bundle', text)

        self.assertIn('fetch-depth: 0', text)
        self.assertIn('persist-credentials: false', text)
        self.assertIsNone(re.search(r'persist-credentials:\s*true', text))
        self.assertIn("vars.XINZHI_STATE_REPO || 'dodoxiaxia/xinzhi-state'", text)
        self.assertIn('secrets.XINZHI_STATE_TOKEN', text)

        for forbidden_ref in (
            'XINZHI_MACHINE_TOKEN',
            'save_state',
            'ci_daily',
            'build_public',
            'public-manifest.json',
            'deploy-only-verified-public.json',
            'd646340',
            'c6eb758',
            'wrangler@4',
            '--no-bundle',
            'D1_BACKFILL_ENABLED',
        ):
            self.assertNotIn(forbidden_ref, text)

        self.assertIn("steps.gate.outcome == 'success' && steps.gate.outputs.verified == 'true'", text)
        self.assertIn('--recheck-before-deploy', text)
        self.assertIn("steps.recheck.outcome == 'success'", text)
        self.assertIn("steps.recheck.outputs.verified == 'true'", text)
        self.assertLess(text.index('--recheck-before-deploy'), text.index('wrangler@3'))
        self.assertIn("CI: 'true'", text)
        self.assertIn('npx --yes wrangler@3 pages deploy "${{ runner.temp }}/verified-public"', text)
        self.assertIn('--project-name dryz-xinzhi', text)
        self.assertIn('--branch main', text)
        self.assertIn('--commit-dirty=true', text)
        self.assertIn('--commit-hash "$BOUND_CODE_SHA"', text)
        self.assertIn('steps.recheck.outputs.code_sha', text)


class InputValidationTests(unittest.TestCase):
    def test_accepts_valid_inputs_and_rejects_bad_inputs(self):
        valid_sha = 'a' * 40
        for purpose in ('open', 'close'):
            with self.subTest(purpose=purpose):
                res = dov.validate_inputs(
                    purpose,
                    dov.EXPECTED_CONFIRM,
                    '43713838396',
                    valid_sha,
                    state_repo=dov.PINNED_STATE_REPOSITORY,
                    github_repo=FAKE_REPO,
                    github_ref='refs/heads/main',
                    event_name='workflow_dispatch',
                )
                self.assertEqual(res['purpose'], purpose)
                self.assertEqual(res['dailyRunId'], 43713838396)
                self.assertEqual(res['stateCommit'], valid_sha)

        for bad_purpose in ('', 'other', ' open', 'open\nclose', '../open', 'open;id', 'https://evil.example'):
            with self.assertRaises(dov.GateError):
                dov.validate_inputs(bad_purpose, dov.EXPECTED_CONFIRM, '123', valid_sha)

        for bad_confirm in ('', 'wrong', 'publish-verified-d646340-c6eb758', dov.EXPECTED_CONFIRM + '\n'):
            with self.assertRaises(dov.GateError):
                dov.validate_inputs('open', bad_confirm, '123', valid_sha)

        for bad_run in ('', '0', '-1', '0123', 'abc', '123;id', '123 ', True, 0):
            with self.assertRaises(dov.GateError):
                dov.validate_inputs('open', dov.EXPECTED_CONFIRM, bad_run, valid_sha)

        for bad_state in ('', 'state', 'refs/heads/state', 'd887925', 'A' * 40, 'g' * 40, valid_sha + ' '):
            with self.assertRaises(dov.GateError):
                dov.validate_inputs('open', dov.EXPECTED_CONFIRM, '123', bad_state)

        for bad_repo in ('other/xinzhi-state', '../xinzhi-state', 'https://github.com/dodoxiaxia/xinzhi-state'):
            with self.assertRaises(dov.GateError):
                dov.validate_inputs('open', dov.EXPECTED_CONFIRM, '123', valid_sha, state_repo=bad_repo)

        with self.assertRaises(dov.GateError):
            dov.validate_inputs('open', dov.EXPECTED_CONFIRM, '123', valid_sha, github_ref='refs/heads/feature')
        with self.assertRaises(dov.GateError):
            dov.validate_inputs('open', dov.EXPECTED_CONFIRM, '123', valid_sha, event_name='push')

        for bad_path in ('', '/abs/path', '../escape', 'a/../b', 'a\\b', 'https://x.invalid/a', 'a\nb', 'a\x00b'):
            with self.assertRaises(dov.GateError):
                dov.validate_safe_relpath(bad_path)


class OfficialRunReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.files, _ = _make_19_files(self.base / 'pub')
        self.code_sha = '1' * 40
        self.run_id = 43713838396

    def test_valid_run_and_attempt_artifact_passes(self):
        run = _make_run_obj(self.run_id, run_attempt=2, head_sha=self.code_sha)
        receipt = _make_receipt_dict(self.run_id, run_attempt=2, code_sha=self.code_sha, files=self.files)
        zip_bytes = _make_receipt_zip(receipt)
        arts = _make_artifacts_payload(self.run_id, run_attempt=2, artifact_id=777)

        res = dov.verify_official_daily_run(
            FAKE_REPO,
            FAKE_GH_TOKEN,
            self.run_id,
            run_fetcher=lambda _r, _t, _id: run,
            artifacts_fetcher=lambda _r, _t, _id: arts,
            artifact_zip_fetcher=lambda _r, _t, _aid: zip_bytes,
        )
        self.assertEqual(res['runId'], self.run_id)
        self.assertEqual(res['runAttempt'], 2)
        self.assertEqual(res['artifactName'], f'pipeline-final-{self.run_id}-2')
        self.assertEqual(res['codeSha'], self.code_sha)
        self.assertEqual(len(res['files']), 19)

    def test_rejects_foreign_repo_forged_url_wrong_workflow_failed_or_missing_artifact(self):
        receipt = _make_receipt_dict(self.run_id, code_sha=self.code_sha, files=self.files)
        zip_bytes = _make_receipt_zip(receipt)
        arts = _make_artifacts_payload(self.run_id)

        # Foreign repository ownership
        foreign_run = _make_run_obj(self.run_id, repo='evil/xinzhi', head_sha=self.code_sha)
        with self.assertRaises(dov.GateError):
            dov.verify_official_daily_run(
                FAKE_REPO, FAKE_GH_TOKEN, self.run_id,
                run_fetcher=lambda _r, _t, _id: foreign_run,
                artifacts_fetcher=lambda _r, _t, _id: arts,
                artifact_zip_fetcher=lambda _r, _t, _aid: zip_bytes,
            )

        # Forged html_url pointing outside repository
        forged_run = _make_run_obj(self.run_id, head_sha=self.code_sha)
        forged_run['html_url'] = 'https://github.com/evil/xinzhi/actions/runs/43713838396'
        with self.assertRaises(dov.GateError):
            dov.verify_official_daily_run(
                FAKE_REPO, FAKE_GH_TOKEN, self.run_id,
                run_fetcher=lambda _r, _t, _id: forged_run,
                artifacts_fetcher=lambda _r, _t, _id: arts,
                artifact_zip_fetcher=lambda _r, _t, _aid: zip_bytes,
            )

        # Wrong workflow path even if name pretends to be daily-refresh
        wrong_wf = _make_run_obj(self.run_id, path='.github/workflows/evil.yml', name='daily-refresh', head_sha=self.code_sha)
        with self.assertRaises(dov.GateError):
            dov.verify_official_daily_run(
                FAKE_REPO, FAKE_GH_TOKEN, self.run_id,
                run_fetcher=lambda _r, _t, _id: wrong_wf,
                artifacts_fetcher=lambda _r, _t, _id: arts,
                artifact_zip_fetcher=lambda _r, _t, _aid: zip_bytes,
            )

        # Failed / cancelled / in_progress runs
        for status, conclusion in (('completed', 'failure'), ('completed', 'cancelled'), ('in_progress', None)):
            bad_run = _make_run_obj(self.run_id, status=status, conclusion=conclusion, head_sha=self.code_sha)
            with self.assertRaises(dov.GateError):
                dov.verify_official_daily_run(
                    FAKE_REPO, FAKE_GH_TOKEN, self.run_id,
                    run_fetcher=lambda _r, _t, _id: bad_run,
                    artifacts_fetcher=lambda _r, _t, _id: arts,
                    artifact_zip_fetcher=lambda _r, _t, _aid: zip_bytes,
                )

        # Receipt deployed=false
        undeployed = _make_receipt_dict(
            self.run_id, code_sha=self.code_sha, files=self.files,
            deployed=False, deployment_outcome='skipped', deployment_requested=False, status='not_requested',
        )
        with self.assertRaises(dov.GateError):
            dov.verify_official_daily_run(
                FAKE_REPO, FAKE_GH_TOKEN, self.run_id,
                run_fetcher=lambda _r, _t, _id: _make_run_obj(self.run_id, head_sha=self.code_sha),
                artifacts_fetcher=lambda _r, _t, _id: arts,
                artifact_zip_fetcher=lambda _r, _t, _aid: _make_receipt_zip(undeployed),
            )

        # Missing or wrong-attempt artifact
        wrong_attempt_art = _make_artifacts_payload(self.run_id, run_attempt=1, name=f'pipeline-final-{self.run_id}-2')
        with self.assertRaises(dov.GateError):
            dov.verify_official_daily_run(
                FAKE_REPO, FAKE_GH_TOKEN, self.run_id,
                run_fetcher=lambda _r, _t, _id: _make_run_obj(self.run_id, run_attempt=1, head_sha=self.code_sha),
                artifacts_fetcher=lambda _r, _t, _id: wrong_attempt_art,
                artifact_zip_fetcher=lambda _r, _t, _aid: zip_bytes,
            )

    def test_rejects_bad_19_file_manifest_missing_extra_dup_bad_hash_or_missing_special(self):
        # 18 files (missing)
        with self.assertRaises(dov.GateError):
            dov.validate_manifest_files(self.files[:-1])

        # 20 files (extra)
        extra = dict(self.files[-1], path='extra.txt')
        with self.assertRaises(dov.GateError):
            dov.validate_manifest_files(self.files + [extra])

        # Duplicate path (still 19 entries)
        dup_files = list(self.files[:-1]) + [dict(self.files[0])]
        with self.assertRaises(dov.GateError):
            dov.validate_manifest_files(dup_files)

        # Bad 32-char or non-hex sha256
        bad_hash_files = [dict(x) for x in self.files]
        bad_hash_files[2]['sha256'] = 'deadbeef' * 4
        with self.assertRaises(dov.GateError):
            dov.validate_manifest_files(bad_hash_files)

        # Missing _worker.js (replaced with another path)
        no_worker = [dict(x) for x in self.files]
        for entry in no_worker:
            if entry['path'] == '_worker.js':
                entry['path'] = 'other.js'
        with self.assertRaises(dov.GateError):
            dov.validate_manifest_files(no_worker)

        # Missing _headers
        no_headers = [dict(x) for x in self.files]
        for entry in no_headers:
            if entry['path'] == '_headers':
                entry['path'] = 'other.txt'
        with self.assertRaises(dov.GateError):
            dov.validate_manifest_files(no_headers)


class StateAndProductionGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def test_fetch_reads_only_exact_state_commit_not_branch_tip(self):
        bare = self.base / 'state-remote.git'
        work = self.base / 'state-work'
        work.mkdir()
        _init_bare_state_remote(bare)
        _init_git_repo(work)

        files_v1, _ = _make_19_files(work / 'public', tag='v1')
        _git(work, 'checkout', '-b', 'state')
        bound_sha = _commit_all(work, 'bound state')
        _git(work, 'push', str(bare), 'state:refs/heads/state')

        # Advance state branch tip with modified public/content; fetcher must ignore tip.
        _make_19_files(work / 'public', tag='v1', override_content={'index.html': b'newer state tip must not be used\n'})
        _commit_all(work, 'newer state tip')
        _git(work, 'push', str(bare), 'state:refs/heads/state')

        repo_root = self.base / 'repo-root'
        repo_root.mkdir()
        with self.assertRaises(dov.GateError):
            dov.fetch_verified_package_from_state(
                repo_root / 'public',
                files_v1,
                state_commit=bound_sha,
                remote_url=str(bare),
                repo_root=repo_root,
            )

        calls = []
        real_runner = dov._default_git_runner

        def recording_runner(cwd, args, env=None):
            calls.append(args)
            return real_runner(cwd, args, env=env)

        out_dir = self.base / 'extracted-public'
        summary = dov.fetch_verified_package_from_state(
            out_dir,
            files_v1,
            state_commit=bound_sha,
            remote_url=str(bare),
            repo_root=repo_root,
            git_runner=recording_runner,
        )
        self.assertEqual(summary['fileCount'], 19)
        self.assertEqual(summary['stateCommit'], bound_sha)
        self.assertTrue(any('http.https://github.com/.extraheader=' in args for args in calls))
        self.assertFalse(any('refs/heads/state' in args for args in calls))

        # Missing state commit fails closed (never falls back to refs/heads/state)
        with self.assertRaises(dov.GateError):
            dov.fetch_verified_package_from_state(
                self.base / 'extracted-missing',
                files_v1,
                state_commit='c' * 40,
                remote_url=str(bare),
                repo_root=repo_root,
            )

    def test_switch_setting_gates_open_true_and_close_false_without_checking_live_snapshot(self):
        code_sha = 'a' * 40
        # open succeeds when project setting is plain_text 'true', even if live deployment snapshot is still 'false'
        res_open = dov.verify_production_state(
            FAKE_CF_ACCOUNT,
            FAKE_CF_TOKEN,
            purpose='open',
            project_fetcher=lambda _a, _t, _p: _cf_project_response(
                code_sha, switch_value='true', live_dep_switch='false'
            ),
        )
        self.assertEqual(res_open['switchValue'], 'true')

        # open rejects when project setting is 'false' or non-plain_text
        for bad_type, bad_val in (('plain_text', 'false'), ('plain_text', '1'), ('secret_text', 'true')):
            with self.assertRaises(dov.GateError):
                dov.verify_production_state(
                    FAKE_CF_ACCOUNT,
                    FAKE_CF_TOKEN,
                    purpose='open',
                    project_fetcher=lambda _a, _t, _p: _cf_project_response(
                        code_sha, switch_type=bad_type, switch_value=bad_val
                    ),
                )

        # close succeeds when project setting is plain_text 'false', even if live deployment snapshot is still 'true'
        res_close = dov.verify_production_state(
            FAKE_CF_ACCOUNT,
            FAKE_CF_TOKEN,
            purpose='close',
            project_fetcher=lambda _a, _t, _p: _cf_project_response(
                code_sha, switch_value='false', live_dep_switch='true'
            ),
        )
        self.assertEqual(res_close['switchValue'], 'false')

        # close rejects when project setting is 'true' or missing
        with self.assertRaises(dov.GateError):
            dov.verify_production_state(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                purpose='close',
                project_fetcher=lambda _a, _t, _p: _cf_project_response(code_sha, switch_value='true'),
            )
        with self.assertRaises(dov.GateError):
            dov.verify_production_state(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                purpose='close',
                project_fetcher=lambda _a, _t, _p: _cf_project_response(code_sha, switch_present=False),
            )

    def test_canonical_and_latest_must_be_same_deployment(self):
        code_sha = 'a' * 40
        with self.assertRaises(dov.GateError) as ctx:
            dov.verify_production_state(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                purpose='close',
                project_fetcher=lambda _a, _t, _p: _cf_project_response(
                    code_sha, canonical_id='dep-1', latest_id='dep-2', switch_value='false'
                ),
            )
        self.assertNotIn(FAKE_CF_TOKEN, str(ctx.exception))
        self.assertNotIn(FAKE_CF_ACCOUNT, str(ctx.exception))

    def test_live_static_check_excludes_worker_and_headers_and_rejects_same_codesha_old_bundle(self):
        files_old, content_old = _make_19_files(self.base / 'old', tag='old')
        files_new, content_new = _make_19_files(self.base / 'new', tag='new')
        requested_paths = []

        def live_fetcher(_url, rel):
            requested_paths.append(rel)
            if rel in ('_worker.js', '_headers'):
                return b'<html>SPA fallback HTML</html>'
            return content_new[rel]

        # Current run (files_new) passes and never queries _worker.js or _headers over HTTP
        res = dov.verify_live_static_assets(files_new, static_fetcher=live_fetcher)
        self.assertEqual(res['staticCount'], 17)
        self.assertNotIn('_worker.js', requested_paths)
        self.assertNotIn('_headers', requested_paths)

        # Older historical run with same codeSha but different 19-file fingerprints is rejected
        with self.assertRaises(dov.GateError):
            dov.verify_live_static_assets(files_old, static_fetcher=lambda _u, r: content_new[r])

        # Explicitly calling default_static_asset_fetcher for _worker.js / _headers is forbidden
        for special in ('_worker.js', '_headers'):
            with self.assertRaises(dov.GateError):
                dov.default_static_asset_fetcher(dov.PINNED_PRODUCTION_URL, special)


class MainDiffGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / 'repo'
        self.repo.mkdir()
        _init_git_repo(self.repo)
        (self.repo / 'index.html').write_text('prod html', encoding='utf-8')
        (self.repo / '.github/workflows').mkdir(parents=True)
        (self.repo / '.github/workflows/daily.yml').write_text('name: daily', encoding='utf-8')
        (self.repo / 'config').mkdir(parents=True)
        (self.repo / 'config/deploy-only-verified-public.json').write_text('{"old": true}', encoding='utf-8')
        for rel in sorted(dov.ALLOWED_MAIN_DIFF_PATHS):
            target = self.repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('initial allowlisted file\n', encoding='utf-8')
        self.base_sha = _commit_all(self.repo, 'base official commit')

    def test_allows_modifications_to_4_ci_files_only_and_rejects_old_pin_or_other_files(self):
        res_same = dov.verify_main_diff(self.repo, base_sha=self.base_sha)
        self.assertEqual(res_same['headSha'], self.base_sha)
        self.assertEqual(res_same['changedPaths'], [])

        for rel in sorted(dov.ALLOWED_MAIN_DIFF_PATHS):
            (self.repo / rel).write_text('updated audited ci file\n', encoding='utf-8')
        merged_sha = _commit_all(self.repo, 'update 4 input-bound ci files')

        res_merged = dov.verify_main_diff(self.repo, base_sha=self.base_sha)
        self.assertEqual(res_merged['headSha'], merged_sha)
        self.assertEqual(res_merged['changedPaths'], sorted(dov.ALLOWED_MAIN_DIFF_PATHS))

        # Touching config/deploy-only-verified-public.json must be rejected
        (self.repo / 'config/deploy-only-verified-public.json').write_text('{"modified": true}', encoding='utf-8')
        _commit_all(self.repo, 'modify old pin file')
        with self.assertRaises(dov.GateError):
            dov.verify_main_diff(self.repo, base_sha=self.base_sha)

        # Touching daily.yml must be rejected
        _git(self.repo, 'reset', '--hard', merged_sha)
        (self.repo / '.github/workflows/daily.yml').write_text('modified daily', encoding='utf-8')
        _commit_all(self.repo, 'modify daily.yml')
        with self.assertRaises(dov.GateError):
            dov.verify_main_diff(self.repo, base_sha=self.base_sha)


class EndToEndAndRebindTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

        # Remote code repo & local checkout
        self.code_remote = self.base / 'code-remote.git'
        self.code_work = self.base / 'code-work'
        self.checkout = self.base / 'checkout'
        self.code_work.mkdir()
        _git(self.base, 'init', '--bare', str(self.code_remote))
        _init_git_repo(self.code_work)
        (self.code_work / 'app.js').write_text('main code v1\n', encoding='utf-8')
        for rel in sorted(dov.ALLOWED_MAIN_DIFF_PATHS):
            target = self.code_work / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('ci v1\n', encoding='utf-8')
        self.code_sha_v1 = _commit_all(self.code_work, 'v1 production code')

        # Add CI-only commit on main so HEAD != code_sha_v1
        for rel in sorted(dov.ALLOWED_MAIN_DIFF_PATHS):
            (self.code_work / rel).write_text('ci v2 input-bound\n', encoding='utf-8')
        self.head_sha = _commit_all(self.code_work, 'ci-only PR commit')
        _git(self.code_work, 'push', str(self.code_remote), 'main:refs/heads/main')
        _git(self.base, 'clone', str(self.code_remote), str(self.checkout))
        _git(self.checkout, 'checkout', self.head_sha)

        # Bare state repo with two historical official commits + non-matching tip
        self.state_bare = self.base / 'state.git'
        self.state_work = self.base / 'state-work'
        self.state_work.mkdir()
        _init_bare_state_remote(self.state_bare)
        _init_git_repo(self.state_work)
        _git(self.state_work, 'checkout', '-b', 'state')

        self.files_v1, self.content_v1 = _make_19_files(self.state_work / 'public', tag='bundle-v1')
        self.state_sha_v1 = _commit_all(self.state_work, 'state bundle v1')

        self.files_v2, self.content_v2 = _make_19_files(self.state_work / 'public', tag='bundle-v2')
        self.state_sha_v2 = _commit_all(self.state_work, 'state bundle v2')

        # Advance state branch tip with a newer non-deployed/unmatched package so blind tip following fails
        self.files_tip, self.content_tip = _make_19_files(self.state_work / 'public', tag='bundle-tip-unmatched')
        self.state_sha_tip = _commit_all(self.state_work, 'unmatched newer state tip')
        _git(self.state_work, 'push', str(self.state_bare), 'state:refs/heads/state')

        self.run_id_v1 = 1001
        self.run_id_v2 = 1002

    def _run_fixtures(self):
        run_v1 = _make_run_obj(self.run_id_v1, head_sha=self.code_sha_v1)
        run_v2 = _make_run_obj(self.run_id_v2, head_sha=self.code_sha_v1)
        # Also include a non-deployed fast run (no build.files) to ensure discovery skips it safely.
        run_fast_noop = _make_run_obj(1003, head_sha=self.code_sha_v1)

        receipt_v1 = _make_receipt_dict(self.run_id_v1, code_sha=self.code_sha_v1, files=self.files_v1)
        receipt_v2 = _make_receipt_dict(self.run_id_v2, code_sha=self.code_sha_v1, files=self.files_v2)
        receipt_noop = {
            'recordKind': 'pipeline_final',
            'runUrl': f'https://github.com/{FAKE_REPO}/actions/runs/1003',
            'runAttempt': '1',
            'codeSha': self.code_sha_v1,
            'refreshOutcome': 'success',
            'deploymentRequested': False,
            'deploymentOutcome': 'skipped',
            'stateOutcome': 'skipped',
            'deployed': False,
            'status': 'not_requested',
            'build': {'available': False},
        }

        runs_by_id = {self.run_id_v1: run_v1, self.run_id_v2: run_v2, 1003: run_fast_noop}
        zips_by_aid = {
            5001: _make_receipt_zip(receipt_v1),
            5002: _make_receipt_zip(receipt_v2),
            5003: _make_receipt_zip(receipt_noop),
        }
        arts_by_rid = {
            self.run_id_v1: _make_artifacts_payload(self.run_id_v1, artifact_id=5001),
            self.run_id_v2: _make_artifacts_payload(self.run_id_v2, artifact_id=5002),
            1003: _make_artifacts_payload(1003, artifact_id=5003),
        }
        return runs_by_id, arts_by_rid, zips_by_aid

    def test_open_and_close_succeed_when_ci_files_differ_and_use_same_wrangler_args(self):
        runs_by_id, arts_by_rid, zips_by_aid = self._run_fixtures()
        args_by_purpose = {}

        for purpose, switch_val in (('open', 'true'), ('close', 'false')):
            out_dir = self.base / f'verified-public-{purpose}'
            binding_file = self.base / f'binding-{purpose}.json'
            summary = dov.run_all_gates(
                repo_root=self.checkout,
                purpose=purpose,
                confirm=dov.EXPECTED_CONFIRM,
                daily_run_id=self.run_id_v1,
                state_commit=self.state_sha_v1,
                output_dir=out_dir,
                binding_file=binding_file,
                account_id=FAKE_CF_ACCOUNT,
                api_token=FAKE_CF_TOKEN,
                state_repo=dov.PINNED_STATE_REPOSITORY,
                state_remote_url=str(self.state_bare),
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                github_run_id='9000',
                github_ref='refs/heads/main',
                event_name='workflow_dispatch',
                project_fetcher=lambda _a, _t, _p, sv=switch_val: _cf_project_response(
                    self.code_sha_v1, canonical_id='dep-v1', switch_value=sv
                ),
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                static_fetcher=lambda _u, rel: self.content_v1[rel],
            )
            self.assertTrue(summary['verified'])
            self.assertFalse(summary['rebound'])
            self.assertEqual(summary['codeSha'], self.code_sha_v1)
            self.assertEqual(summary['stateCommit'], self.state_sha_v1)
            self.assertEqual(summary['headSha'], self.head_sha)
            self.assertEqual(summary['changedPaths'], sorted(dov.ALLOWED_MAIN_DIFF_PATHS))

            recheck = dov.revalidate_before_deploy(
                self.checkout,
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                purpose=purpose,
                output_dir=out_dir,
                binding_file=binding_file,
                state_remote_url=str(self.state_bare),
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                github_run_id='9000',
                project_fetcher=lambda _a, _t, _p, sv=switch_val: _cf_project_response(
                    self.code_sha_v1, canonical_id='dep-v1', switch_value=sv
                ),
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                static_fetcher=lambda _u, rel: self.content_v1[rel],
            )
            self.assertTrue(recheck['verified'])
            self.assertFalse(recheck['rebound'])
            args_by_purpose[purpose] = dov.build_wrangler_deploy_args(self.base / 'shared-dir', code_sha=recheck['codeSha'])

        self.assertEqual(args_by_purpose['open'], args_by_purpose['close'])
        cmd = args_by_purpose['close']
        self.assertIn('wrangler@3', cmd)
        self.assertNotIn('--no-bundle', cmd)
        self.assertIn('--project-name', cmd)
        self.assertIn(dov.PINNED_PAGES_PROJECT, cmd)
        self.assertIn('--branch', cmd)
        self.assertIn('main', cmd)
        self.assertIn('--commit-dirty=true', cmd)
        self.assertIn('--commit-hash', cmd)
        self.assertIn(self.code_sha_v1, cmd)

    def test_same_code_sha_different_bundle_rejects_old_historical_run(self):
        runs_by_id, arts_by_rid, zips_by_aid = self._run_fixtures()
        out_dir = self.base / 'old-bundle-out'
        # Production currently serves v2 (same codeSha as v1, different 19 fingerprints)
        with self.assertRaises(dov.GateError):
            dov.run_all_gates(
                repo_root=self.checkout,
                purpose='open',
                confirm=dov.EXPECTED_CONFIRM,
                daily_run_id=self.run_id_v1,
                state_commit=self.state_sha_v1,
                output_dir=out_dir,
                account_id=FAKE_CF_ACCOUNT,
                api_token=FAKE_CF_TOKEN,
                state_repo=dov.PINNED_STATE_REPOSITORY,
                state_remote_url=str(self.state_bare),
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                github_run_id='9000',
                github_ref='refs/heads/main',
                event_name='workflow_dispatch',
                project_fetcher=lambda _a, _t, _p: _cf_project_response(
                    self.code_sha_v1, canonical_id='dep-v2', switch_value='true'
                ),
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                static_fetcher=lambda _u, rel: self.content_v2[rel],
            )
        self.assertFalse(out_dir.exists())

    def test_mid_run_production_change_open_fails_closed_while_close_rebinds_uniquely(self):
        runs_by_id, arts_by_rid, zips_by_aid = self._run_fixtures()

        # 1. Start with v1 at gate time for both open and close, then switch live production to v2 before recheck.
        for purpose, switch_val in (('open', 'true'), ('close', 'false')):
            out_dir = self.base / f'recheck-mid-{purpose}'
            binding_file = self.base / f'recheck-binding-{purpose}.json'
            summary = dov.run_all_gates(
                repo_root=self.checkout,
                purpose=purpose,
                confirm=dov.EXPECTED_CONFIRM,
                daily_run_id=self.run_id_v1,
                state_commit=self.state_sha_v1,
                output_dir=out_dir,
                binding_file=binding_file,
                account_id=FAKE_CF_ACCOUNT,
                api_token=FAKE_CF_TOKEN,
                state_repo=dov.PINNED_STATE_REPOSITORY,
                state_remote_url=str(self.state_bare),
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                github_run_id='9000',
                github_ref='refs/heads/main',
                event_name='workflow_dispatch',
                project_fetcher=lambda _a, _t, _p, sv=switch_val: _cf_project_response(
                    self.code_sha_v1, canonical_id='dep-v1', switch_value=sv
                ),
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                static_fetcher=lambda _u, rel: self.content_v1[rel],
            )
            self.assertEqual(summary['runId'], self.run_id_v1)

            if purpose == 'open':
                # open MUST refuse and delete out_dir when production moved to v2
                with self.assertRaises(dov.GateError):
                    dov.revalidate_before_deploy(
                        self.checkout,
                        FAKE_CF_ACCOUNT,
                        FAKE_CF_TOKEN,
                        purpose='open',
                        output_dir=out_dir,
                        binding_file=binding_file,
                        state_remote_url=str(self.state_bare),
                        github_token=FAKE_GH_TOKEN,
                        github_repo=FAKE_REPO,
                        github_run_id='9000',
                        project_fetcher=lambda _a, _t, _p: _cf_project_response(
                            self.code_sha_v1, canonical_id='dep-v2', switch_value='true'
                        ),
                        deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                        gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                        run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                        artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                        artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                        static_fetcher=lambda _u, rel: self.content_v2[rel],
                    )
                self.assertFalse(out_dir.exists())
            else:
                # close rebinds to unique v2 official run + state_sha_v2 (NOT state tip!) and replaces out_dir
                recheck = dov.revalidate_before_deploy(
                    self.checkout,
                    FAKE_CF_ACCOUNT,
                    FAKE_CF_TOKEN,
                    purpose='close',
                    output_dir=out_dir,
                    binding_file=binding_file,
                    state_remote_url=str(self.state_bare),
                    github_token=FAKE_GH_TOKEN,
                    github_repo=FAKE_REPO,
                    github_run_id='9000',
                    project_fetcher=lambda _a, _t, _p: _cf_project_response(
                        self.code_sha_v1, canonical_id='dep-v2', switch_value='false'
                    ),
                    deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                    gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                    discover_runs_fetcher=lambda _r, _t: _gh_runs_response([
                        runs_by_id[1003],
                        runs_by_id[self.run_id_v2],
                        runs_by_id[self.run_id_v1],
                    ]),
                    run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                    artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                    artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                    static_fetcher=lambda _u, rel: self.content_v2[rel],
                )
                self.assertTrue(recheck['verified'])
                self.assertTrue(recheck['rebound'])
                self.assertEqual(recheck['runId'], self.run_id_v2)
                self.assertEqual(recheck['stateCommit'], self.state_sha_v2)
                self.assertNotEqual(recheck['stateCommit'], self.state_sha_tip)
                self.assertEqual((out_dir / 'index.html').read_bytes(), self.content_v2['index.html'])
                self.assertEqual((out_dir / '_worker.js').read_bytes(), self.content_v2['_worker.js'])

    def test_close_rebinds_when_production_sha_and_origin_main_moved(self):
        """Close may rebind to a newer official package even if checkout HEAD is stale.

        This is the post-merge daily case: production commit_hash and origin/main
        both advance to a new official SHA. Open still fails closed. Close must
        not require the reviewed checkout to equal origin/main, must not deploy
        the old package, and must publish the newly verified bundle.
        """
        # Advance origin/main (and official codeSha) while leaving checkout HEAD stale.
        (self.code_work / 'app.js').write_text('main code v3\n', encoding='utf-8')
        code_sha_v3 = _commit_all(self.code_work, 'v3 production code')
        _git(self.code_work, 'push', str(self.code_remote), 'main:refs/heads/main')
        self.assertEqual(_git(self.checkout, 'rev-parse', 'HEAD').stdout.strip(), self.head_sha)
        self.assertNotEqual(self.head_sha, code_sha_v3)

        files_v3, content_v3 = _make_19_files(self.state_work / 'public', tag='bundle-v3')
        state_sha_v3 = _commit_all(self.state_work, 'state bundle v3')
        _git(self.state_work, 'push', str(self.state_bare), 'state:refs/heads/state')

        run_id_v3 = 1004
        runs_by_id, arts_by_rid, zips_by_aid = self._run_fixtures()
        run_v3 = _make_run_obj(run_id_v3, head_sha=code_sha_v3)
        receipt_v3 = _make_receipt_dict(run_id_v3, code_sha=code_sha_v3, files=files_v3)
        runs_by_id[run_id_v3] = run_v3
        arts_by_rid[run_id_v3] = _make_artifacts_payload(run_id_v3, artifact_id=5004)
        zips_by_aid[5004] = _make_receipt_zip(receipt_v3)

        def discover(_r, _t):
            return _gh_runs_response([
                runs_by_id[1003],
                runs_by_id[run_id_v3],
                runs_by_id[self.run_id_v2],
                runs_by_id[self.run_id_v1],
            ])

        # Open must refuse and must not leave an old package behind.
        out_open = self.base / 'moved-sha-open'
        with self.assertRaises(dov.GateError):
            dov.run_all_gates(
                repo_root=self.checkout,
                purpose='open',
                confirm=dov.EXPECTED_CONFIRM,
                daily_run_id=self.run_id_v1,
                state_commit=self.state_sha_v1,
                output_dir=out_open,
                account_id=FAKE_CF_ACCOUNT,
                api_token=FAKE_CF_TOKEN,
                state_repo=dov.PINNED_STATE_REPOSITORY,
                state_remote_url=str(self.state_bare),
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                github_run_id='9000',
                github_ref='refs/heads/main',
                event_name='workflow_dispatch',
                project_fetcher=lambda _a, _t, _p: _cf_project_response(
                    code_sha_v3, canonical_id='dep-v3', switch_value='true'
                ),
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                discover_runs_fetcher=discover,
                run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                static_fetcher=lambda _u, rel: content_v3[rel],
            )
        self.assertFalse(out_open.exists())

        # Close at gate time rebinds to the unique v3 official run + state commit.
        out_close = self.base / 'moved-sha-close-gate'
        summary = dov.run_all_gates(
            repo_root=self.checkout,
            purpose='close',
            confirm=dov.EXPECTED_CONFIRM,
            daily_run_id=self.run_id_v1,
            state_commit=self.state_sha_v1,
            output_dir=out_close,
            binding_file=self.base / 'moved-sha-gate-binding.json',
            account_id=FAKE_CF_ACCOUNT,
            api_token=FAKE_CF_TOKEN,
            state_repo=dov.PINNED_STATE_REPOSITORY,
            state_remote_url=str(self.state_bare),
            github_token=FAKE_GH_TOKEN,
            github_repo=FAKE_REPO,
            github_run_id='9000',
            github_ref='refs/heads/main',
            event_name='workflow_dispatch',
            project_fetcher=lambda _a, _t, _p: _cf_project_response(
                code_sha_v3, canonical_id='dep-v3', switch_value='false'
            ),
            deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
            gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
            discover_runs_fetcher=discover,
            run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
            artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
            artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
            static_fetcher=lambda _u, rel: content_v3[rel],
        )
        self.assertTrue(summary['verified'])
        self.assertTrue(summary['rebound'])
        self.assertEqual(summary['runId'], run_id_v3)
        self.assertEqual(summary['codeSha'], code_sha_v3)
        self.assertEqual(summary['stateCommit'], state_sha_v3)
        self.assertNotEqual(summary['stateCommit'], self.state_sha_tip)
        self.assertEqual((out_close / 'index.html').read_bytes(), content_v3['index.html'])
        wrangler = dov.build_wrangler_deploy_args(out_close, code_sha=summary['codeSha'])
        self.assertIn(code_sha_v3, wrangler)
        self.assertNotIn(self.code_sha_v1, wrangler)

        # Mid-run path: gate still sees v1, then origin/main + production move to v3 before recheck.
        # Reset origin/main in the checkout's remote view by using a fresh checkout
        # would be heavy; instead start from a second clone frozen at head_sha,
        # run the v1 gate, then push v3 (already on the bare remote) and recheck.
        frozen = self.base / 'frozen-checkout'
        _git(self.base, 'clone', str(self.code_remote), str(frozen))
        _git(frozen, 'checkout', self.head_sha)
        # Make the frozen clone's origin/main also start at the stale head:
        # After the earlier push, code_remote already has v3, so the clone fetched
        # v3 as origin/main. Point the remote temporarily back, then re-push? The
        # mid-run sequence needs origin/main == head_sha at gate, then v3 at recheck.
        # Recreate a frozen remote lineage:
        frozen_remote = self.base / 'frozen-remote.git'
        _git(self.base, 'init', '--bare', str(frozen_remote))
        _git(frozen_remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
        _git(self.code_work, 'push', str(frozen_remote), f'{self.head_sha}:refs/heads/main')
        frozen2 = self.base / 'frozen-checkout-2'
        _git(self.base, 'clone', str(frozen_remote), str(frozen2))
        self.assertEqual(_git(frozen2, 'rev-parse', 'HEAD').stdout.strip(), self.head_sha)
        self.assertEqual(_git(frozen2, 'rev-parse', 'origin/main').stdout.strip(), self.head_sha)

        out_mid = self.base / 'moved-sha-close-recheck'
        binding_mid = self.base / 'moved-sha-recheck-binding.json'
        mid_gate = dov.run_all_gates(
            repo_root=frozen2,
            purpose='close',
            confirm=dov.EXPECTED_CONFIRM,
            daily_run_id=self.run_id_v1,
            state_commit=self.state_sha_v1,
            output_dir=out_mid,
            binding_file=binding_mid,
            account_id=FAKE_CF_ACCOUNT,
            api_token=FAKE_CF_TOKEN,
            state_repo=dov.PINNED_STATE_REPOSITORY,
            state_remote_url=str(self.state_bare),
            github_token=FAKE_GH_TOKEN,
            github_repo=FAKE_REPO,
            github_run_id='9000',
            github_ref='refs/heads/main',
            event_name='workflow_dispatch',
            project_fetcher=lambda _a, _t, _p: _cf_project_response(
                self.code_sha_v1, canonical_id='dep-v1', switch_value='false'
            ),
            deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
            gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
            run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
            artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
            artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
            static_fetcher=lambda _u, rel: self.content_v1[rel],
        )
        self.assertFalse(mid_gate['rebound'])
        self.assertEqual(mid_gate['codeSha'], self.code_sha_v1)
        self.assertEqual((out_mid / 'index.html').read_bytes(), self.content_v1['index.html'])

        # Now production and origin/main both move to v3 (already committed on code_work).
        _git(self.code_work, 'push', str(frozen_remote), 'main:refs/heads/main')
        # Checkout HEAD stays stale.
        self.assertEqual(_git(frozen2, 'rev-parse', 'HEAD').stdout.strip(), self.head_sha)

        mid_recheck = dov.revalidate_before_deploy(
            frozen2,
            FAKE_CF_ACCOUNT,
            FAKE_CF_TOKEN,
            purpose='close',
            output_dir=out_mid,
            binding_file=binding_mid,
            state_remote_url=str(self.state_bare),
            github_token=FAKE_GH_TOKEN,
            github_repo=FAKE_REPO,
            github_run_id='9000',
            project_fetcher=lambda _a, _t, _p: _cf_project_response(
                code_sha_v3, canonical_id='dep-v3', switch_value='false'
            ),
            deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
            gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
            discover_runs_fetcher=discover,
            run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
            artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
            artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
            static_fetcher=lambda _u, rel: content_v3[rel],
        )
        self.assertTrue(mid_recheck['verified'])
        self.assertTrue(mid_recheck['rebound'])
        self.assertEqual(mid_recheck['runId'], run_id_v3)
        self.assertEqual(mid_recheck['codeSha'], code_sha_v3)
        self.assertEqual(mid_recheck['stateCommit'], state_sha_v3)
        self.assertEqual(mid_recheck['remoteMainSha'], code_sha_v3)
        self.assertEqual(mid_recheck['match'], 'rebind-origin-main')
        self.assertEqual((out_mid / 'index.html').read_bytes(), content_v3['index.html'])
        self.assertEqual((out_mid / '_worker.js').read_bytes(), content_v3['_worker.js'])

    def test_close_rebind_fails_closed_when_run_or_state_cannot_be_uniquely_identified(self):
        runs_by_id, arts_by_rid, zips_by_aid = self._run_fixtures()
        out_dir = self.base / 'rebind-ambiguous'

        # Case A: 0 matching runs -> fail closed
        with self.assertRaises(dov.GateError):
            dov.run_all_gates(
                repo_root=self.checkout,
                purpose='close',
                confirm=dov.EXPECTED_CONFIRM,
                daily_run_id=self.run_id_v1,
                state_commit=self.state_sha_v1,
                output_dir=out_dir,
                account_id=FAKE_CF_ACCOUNT,
                api_token=FAKE_CF_TOKEN,
                state_repo=dov.PINNED_STATE_REPOSITORY,
                state_remote_url=str(self.state_bare),
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                github_run_id='9000',
                github_ref='refs/heads/main',
                event_name='workflow_dispatch',
                project_fetcher=lambda _a, _t, _p: _cf_project_response(
                    self.code_sha_v1, canonical_id='dep-v2', switch_value='false'
                ),
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                discover_runs_fetcher=lambda _r, _t: _gh_runs_response([runs_by_id[self.run_id_v1]]),
                run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                static_fetcher=lambda _u, rel: self.content_v2[rel],
            )
        self.assertFalse(out_dir.exists())

        # Case B: duplicate matching state commit in history -> fail closed (never guess)
        _make_19_files(self.state_work / 'public', tag='bundle-v2')
        _commit_all(self.state_work, 'duplicate state bundle v2')
        _git(self.state_work, 'push', str(self.state_bare), 'state:refs/heads/state')
        with self.assertRaises(dov.GateError):
            dov.discover_unique_state_commit_for_receipt(
                self.files_v2,
                remote_url=str(self.state_bare),
            )

        # Case C: truncated state history -> fail closed
        with mock.patch.object(dov, 'STATE_HISTORY_MAX_COMMITS', 1):
            with self.assertRaises(dov.GateError) as ctx:
                dov.discover_unique_state_commit_for_receipt(
                    self.files_v2,
                    remote_url=str(self.state_bare),
                )
            self.assertIn('truncated', str(ctx.exception))

    def test_pre_gate_production_change_open_rejects_and_close_rebinds(self):
        runs_by_id, arts_by_rid, zips_by_aid = self._run_fixtures()
        out_open = self.base / 'pre-gate-open'
        with self.assertRaises(dov.GateError):
            dov.run_all_gates(
                repo_root=self.checkout,
                purpose='open',
                confirm=dov.EXPECTED_CONFIRM,
                daily_run_id=self.run_id_v1,
                state_commit=self.state_sha_v1,
                output_dir=out_open,
                account_id=FAKE_CF_ACCOUNT,
                api_token=FAKE_CF_TOKEN,
                state_repo=dov.PINNED_STATE_REPOSITORY,
                state_remote_url=str(self.state_bare),
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                github_run_id='9000',
                github_ref='refs/heads/main',
                event_name='workflow_dispatch',
                project_fetcher=lambda _a, _t, _p: _cf_project_response(
                    self.code_sha_v1, canonical_id='dep-v2', switch_value='true'
                ),
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                static_fetcher=lambda _u, rel: self.content_v2[rel],
            )
        self.assertFalse(out_open.exists())

        out_close = self.base / 'pre-gate-close'
        summary = dov.run_all_gates(
            repo_root=self.checkout,
            purpose='close',
            confirm=dov.EXPECTED_CONFIRM,
            daily_run_id=self.run_id_v1,
            state_commit=self.state_sha_v1,
            output_dir=out_close,
            account_id=FAKE_CF_ACCOUNT,
            api_token=FAKE_CF_TOKEN,
            state_repo=dov.PINNED_STATE_REPOSITORY,
            state_remote_url=str(self.state_bare),
            github_token=FAKE_GH_TOKEN,
            github_repo=FAKE_REPO,
            github_run_id='9000',
            github_ref='refs/heads/main',
            event_name='workflow_dispatch',
            project_fetcher=lambda _a, _t, _p: _cf_project_response(
                self.code_sha_v1, canonical_id='dep-v2', switch_value='false'
            ),
            deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
            gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
            discover_runs_fetcher=lambda _r, _t: _gh_runs_response([
                runs_by_id[1003],
                runs_by_id[self.run_id_v2],
                runs_by_id[self.run_id_v1],
            ]),
            run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
            artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
            artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
            static_fetcher=lambda _u, rel: self.content_v2[rel],
        )
        self.assertTrue(summary['verified'])
        self.assertTrue(summary['rebound'])
        self.assertEqual(summary['runId'], self.run_id_v2)
        self.assertEqual(summary['stateCommit'], self.state_sha_v2)

    def test_close_rebind_fails_closed_if_production_changes_again_during_rebind(self):
        """After discovering the new official bundle, a later production/switch change must stop deploy."""
        runs_by_id, arts_by_rid, zips_by_aid = self._run_fixtures()
        out_dir = self.base / 'rebind-late-change'
        calls = {'project': 0, 'static': 0}

        def project_fetcher(_a, _t, _p):
            calls['project'] += 1
            if calls['project'] == 1:
                # First read: production already moved to v2, so close starts rebind.
                return _cf_project_response(self.code_sha_v1, canonical_id='dep-v2', switch_value='false')
            # Confirmation read: production moved again (new deployment id / same SHA is not enough;
            # serve a different live identity by flipping the switch, which must also fail closed).
            return _cf_project_response(self.code_sha_v1, canonical_id='dep-v2', switch_value='true')

        with self.assertRaises(dov.GateError) as ctx:
            dov.run_all_gates(
                repo_root=self.checkout,
                purpose='close',
                confirm=dov.EXPECTED_CONFIRM,
                daily_run_id=self.run_id_v1,
                state_commit=self.state_sha_v1,
                output_dir=out_dir,
                account_id=FAKE_CF_ACCOUNT,
                api_token=FAKE_CF_TOKEN,
                state_repo=dov.PINNED_STATE_REPOSITORY,
                state_remote_url=str(self.state_bare),
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                github_run_id='9000',
                github_ref='refs/heads/main',
                event_name='workflow_dispatch',
                project_fetcher=project_fetcher,
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                discover_runs_fetcher=lambda _r, _t: _gh_runs_response([
                    runs_by_id[self.run_id_v2],
                    runs_by_id[self.run_id_v1],
                ]),
                run_fetcher=lambda _r, _t, rid: runs_by_id[rid],
                artifacts_fetcher=lambda _r, _t, rid: arts_by_rid[rid],
                artifact_zip_fetcher=lambda _r, _t, aid: zips_by_aid[aid],
                static_fetcher=lambda _u, rel: self.content_v2[rel],
            )
        self.assertIn('D1_BACKFILL_ENABLED', str(ctx.exception))
        self.assertGreaterEqual(calls['project'], 2)
        self.assertFalse(out_dir.exists())

    def test_cli_exits_nonzero_and_marks_unverified_on_gate_failure(self):
        gh_out = self.base / 'github-output.txt'
        unused_out = self.base / 'unused-out'
        with mock.patch.dict(os.environ, {
            'GITHUB_OUTPUT': str(gh_out),
            'GITHUB_REF': 'refs/heads/feature',
            'GITHUB_EVENT_NAME': 'workflow_dispatch',
            'GITHUB_REPOSITORY': FAKE_REPO,
        }, clear=False):
            rc = dov.main([
                '--purpose', 'close',
                '--confirm', dov.EXPECTED_CONFIRM,
                '--daily-run-id', str(self.run_id_v1),
                '--state-commit', self.state_sha_v1,
                '--output-dir', str(unused_out),
            ])
        self.assertEqual(rc, 1)
        out_text = gh_out.read_text(encoding='utf-8')
        self.assertIn('verified=false', out_text)
        self.assertNotIn('code_sha=', out_text)
        self.assertFalse(unused_out.exists())

        # Recheck CLI also writes verified=true and code_sha on success, and verified=false on missing binding
        gh_recheck_out = self.base / 'github-recheck-output.txt'
        recheck_out_dir = self.base / 'recheck-cli-out'
        _make_19_files(recheck_out_dir, tag='bundle-v1')
        binding_file = self.base / 'recheck-cli-binding.json'
        binding_file.write_text(json.dumps({
            'purpose': 'close',
            'runId': self.run_id_v1,
            'runAttempt': 1,
            'codeSha': self.code_sha_v1,
            'stateCommit': self.state_sha_v1,
            'canonicalDeploymentId': 'dep-v1',
            'files': self.files_v1,
        }), encoding='utf-8')
        with mock.patch.dict(os.environ, {
            'GITHUB_OUTPUT': str(gh_recheck_out),
            'CLOUDFLARE_ACCOUNT_ID': FAKE_CF_ACCOUNT,
            'CLOUDFLARE_API_TOKEN': FAKE_CF_TOKEN,
            'XINZHI_STATE_REPOSITORY': dov.PINNED_STATE_REPOSITORY,
            'XINZHI_STATE_TOKEN': FAKE_STATE_TOKEN,
            'GITHUB_TOKEN': FAKE_GH_TOKEN,
            'GITHUB_REPOSITORY': FAKE_REPO,
            'GITHUB_RUN_ID': '9000',
        }, clear=False):
            with mock.patch.object(dov, 'revalidate_before_deploy', return_value={
                'verified': True,
                'codeSha': self.code_sha_v1,
            }):
                rc_ok = dov.main([
                    '--recheck-before-deploy',
                    '--purpose', 'close',
                    '--output-dir', str(recheck_out_dir),
                    '--binding-file', str(binding_file),
                ])
        self.assertEqual(rc_ok, 0)
        recheck_text = gh_recheck_out.read_text(encoding='utf-8')
        self.assertIn('verified=true', recheck_text)
        self.assertIn(f'code_sha={self.code_sha_v1}', recheck_text)


class FreshnessRecheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.checkout = self.base / 'checkout'
        self.remote = self.base / 'remote.git'
        self.remote_work = self.base / 'remote-work'
        self.checkout.mkdir()
        self.remote_work.mkdir()
        _git(self.base, 'init', '--bare', str(self.remote))
        _init_git_repo(self.remote_work)
        (self.remote_work / 'README.md').write_text('base\n', encoding='utf-8')
        self.base_sha = _commit_all(self.remote_work, 'base official fixture')
        for rel in sorted(dov.ALLOWED_MAIN_DIFF_PATHS):
            target = self.remote_work / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('allowlisted\n', encoding='utf-8')
        self.allow_sha = _commit_all(self.remote_work, 'allowlist only')
        _git(self.remote_work, 'branch', '-M', 'main')
        _git(self.remote_work, 'push', str(self.remote), 'main:refs/heads/main')
        _git(self.base, 'clone', str(self.remote), str(self.checkout))
        _git(self.checkout, 'checkout', self.allow_sha)

        self.files, self.content = _make_19_files(self.base / 'pub', tag='fresh')
        self.out_dir = self.base / 'verified-public'
        _make_19_files(self.out_dir, tag='fresh')
        self.binding = {
            'purpose': 'close',
            'runId': 2001,
            'runAttempt': 1,
            'codeSha': self.base_sha,
            'stateCommit': 'e' * 40,
            'canonicalDeploymentId': 'dep-fresh',
            'files': self.files,
        }
        self.run_obj = _make_run_obj(2001, head_sha=self.base_sha)
        self.arts = _make_artifacts_payload(2001)
        self.zip_bytes = _make_receipt_zip(_make_receipt_dict(2001, code_sha=self.base_sha, files=self.files))

    def test_recheck_uses_fetched_remote_main_and_allows_only_exact_commit_or_same_tree(self):
        ok = dov.revalidate_before_deploy(
            self.checkout,
            FAKE_CF_ACCOUNT,
            FAKE_CF_TOKEN,
            purpose='close',
            output_dir=self.out_dir,
            binding=self.binding,
            github_token=FAKE_GH_TOKEN,
            github_repo=FAKE_REPO,
            project_fetcher=lambda _a, _t, _p: _cf_project_response(
                self.base_sha, canonical_id='dep-fresh', switch_value='false'
            ),
            run_fetcher=lambda _r, _t, _id: self.run_obj,
            artifacts_fetcher=lambda _r, _t, _id: self.arts,
            artifact_zip_fetcher=lambda _r, _t, _aid: self.zip_bytes,
            static_fetcher=lambda _u, rel: self.content[rel],
        )
        self.assertTrue(ok['verified'])
        self.assertEqual(ok['match'], 'commit')
        self.assertEqual(ok['remoteMainSha'], self.allow_sha)

        # Empty commit on remote main (same tree) still passes
        _git(self.remote_work, 'commit', '--allow-empty', '-m', 'same tree, new commit')
        empty_sha = _git(self.remote_work, 'rev-parse', 'HEAD').stdout.strip()
        _git(self.remote_work, 'push', str(self.remote), 'main:refs/heads/main')
        same_tree = dov.revalidate_before_deploy(
            self.checkout,
            FAKE_CF_ACCOUNT,
            FAKE_CF_TOKEN,
            purpose='close',
            output_dir=self.out_dir,
            binding=self.binding,
            github_token=FAKE_GH_TOKEN,
            github_repo=FAKE_REPO,
            project_fetcher=lambda _a, _t, _p: _cf_project_response(
                self.base_sha, canonical_id='dep-fresh', switch_value='false'
            ),
            run_fetcher=lambda _r, _t, _id: self.run_obj,
            artifacts_fetcher=lambda _r, _t, _id: self.arts,
            artifact_zip_fetcher=lambda _r, _t, _aid: self.zip_bytes,
            static_fetcher=lambda _u, rel: self.content[rel],
        )
        self.assertEqual(same_tree['match'], 'tree')
        self.assertEqual(same_tree['remoteMainSha'], empty_sha)

        # Later allowlisted-only edit on remote main must NOT reject close while production is unchanged
        (self.remote_work / 'docs/deploy-only-verified.md').write_text('later audited ci edit\n', encoding='utf-8')
        later_ci_sha = _commit_all(self.remote_work, 'later allowlisted ci edit')
        _git(self.remote_work, 'push', str(self.remote), 'main:refs/heads/main')
        self.assertEqual(_git(self.checkout, 'rev-parse', 'HEAD').stdout.strip(), self.allow_sha)
        close_ci_only = dov.revalidate_before_deploy(
            self.checkout,
            FAKE_CF_ACCOUNT,
            FAKE_CF_TOKEN,
            purpose='close',
            output_dir=self.out_dir,
            binding=self.binding,
            github_token=FAKE_GH_TOKEN,
            github_repo=FAKE_REPO,
            project_fetcher=lambda _a, _t, _p: _cf_project_response(
                self.base_sha, canonical_id='dep-fresh', switch_value='false'
            ),
            run_fetcher=lambda _r, _t, _id: self.run_obj,
            artifacts_fetcher=lambda _r, _t, _id: self.arts,
            artifact_zip_fetcher=lambda _r, _t, _aid: self.zip_bytes,
            static_fetcher=lambda _u, rel: self.content[rel],
        )
        self.assertTrue(close_ci_only['verified'])
        self.assertFalse(close_ci_only['rebound'])
        self.assertEqual(close_ci_only['match'], 'close-allowlist-origin-main')
        self.assertEqual(close_ci_only['remoteMainSha'], later_ci_sha)
        self.assertTrue(self.out_dir.exists())

        # The same later allowlisted tip must still be rejected on the open path
        open_binding = dict(self.binding)
        open_binding['purpose'] = 'open'
        with self.assertRaises(dov.GateError) as ctx_open:
            dov.revalidate_before_deploy(
                self.checkout,
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                purpose='open',
                output_dir=self.out_dir,
                binding=open_binding,
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                project_fetcher=lambda _a, _t, _p: _cf_project_response(
                    self.base_sha, canonical_id='dep-fresh', switch_value='true'
                ),
                run_fetcher=lambda _r, _t, _id: self.run_obj,
                artifacts_fetcher=lambda _r, _t, _id: self.arts,
                artifact_zip_fetcher=lambda _r, _t, _aid: self.zip_bytes,
                static_fetcher=lambda _u, rel: self.content[rel],
            )
        self.assertIn('later main changes are not auto-approved', str(ctx_open.exception))
        self.assertFalse(self.out_dir.exists())
        _make_19_files(self.out_dir, tag='fresh')

        # Non-allowlisted remote change is still rejected for close
        (self.remote_work / 'README.md').write_text('non-ci change\n', encoding='utf-8')
        _commit_all(self.remote_work, 'non-ci change')
        _git(self.remote_work, 'push', str(self.remote), 'main:refs/heads/main')
        with self.assertRaises(dov.GateError):
            dov.revalidate_before_deploy(
                self.checkout,
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                purpose='close',
                output_dir=self.out_dir,
                binding=self.binding,
                github_token=FAKE_GH_TOKEN,
                github_repo=FAKE_REPO,
                project_fetcher=lambda _a, _t, _p: _cf_project_response(
                    self.base_sha, canonical_id='dep-fresh', switch_value='false'
                ),
                run_fetcher=lambda _r, _t, _id: self.run_obj,
                artifacts_fetcher=lambda _r, _t, _id: self.arts,
                artifact_zip_fetcher=lambda _r, _t, _aid: self.zip_bytes,
                static_fetcher=lambda _u, rel: self.content[rel],
            )
        self.assertFalse(self.out_dir.exists())


class ConcurrencyAndPaginationTests(unittest.TestCase):
    def test_passes_when_idle_and_blocks_on_active_runs_or_deploys(self):
        ok = dov.verify_no_concurrent_deploy(
            FAKE_CF_ACCOUNT,
            FAKE_CF_TOKEN,
            repo=FAKE_REPO,
            github_token=FAKE_GH_TOKEN,
            current_run_id='100',
            deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success', 'failure'),
            gh_runs_fetcher=lambda _r, _t: _gh_runs_response([
                {'id': 100, 'path': '.github/workflows/deploy-only-verified.yml', 'status': 'in_progress'},
                {'id': 101, 'path': '.github/workflows/deploy-only-verified.yml', 'status': 'completed'},
                {'id': 99, 'path': '.github/workflows/daily.yml', 'status': 'completed'},
            ]),
        )
        self.assertEqual(ok['cloudflareChecked'], 2)

        with self.assertRaises(dov.GateError):
            dov.verify_no_concurrent_deploy(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                repo=FAKE_REPO,
                github_token=FAKE_GH_TOKEN,
                current_run_id='100',
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('active'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
            )

        with self.assertRaises(dov.GateError):
            dov.verify_no_concurrent_deploy(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                repo=FAKE_REPO,
                github_token=FAKE_GH_TOKEN,
                current_run_id='100',
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([
                    {'id': 98, 'path': '.github/workflows/daily.yml', 'status': 'in_progress'},
                ]),
            )

    def test_gh_runs_pagination_finds_incomplete_run_on_later_page_and_truncates_fail_closed(self):
        pages = {
            1: {
                'total_count': dov.GH_RUNS_PER_PAGE + 1,
                'workflow_runs': [
                    {'id': i, 'path': '.github/workflows/muse-review.yml', 'status': 'completed'}
                    for i in range(dov.GH_RUNS_PER_PAGE)
                ],
            },
            2: {
                'total_count': dov.GH_RUNS_PER_PAGE + 1,
                'workflow_runs': [
                    {'id': 999, 'path': '.github/workflows/daily.yml', 'status': 'in_progress'},
                ],
            },
        }

        def http_get(url, _headers):
            return pages[2] if 'page=2' in url else pages[1]

        payload = dov.default_gh_runs_fetcher(FAKE_REPO, FAKE_GH_TOKEN, http_get=http_get)
        self.assertEqual(len(payload['workflow_runs']), dov.GH_RUNS_PER_PAGE + 1)
        with self.assertRaises(dov.GateError):
            dov.verify_no_concurrent_deploy(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                repo=FAKE_REPO,
                github_token=FAKE_GH_TOKEN,
                current_run_id='1',
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: payload,
            )

        def truncated_gh(url, _headers):
            page = 1
            for part in url.split('&'):
                if part.startswith('page='):
                    page = int(part.split('=', 1)[1])
            return {
                'total_count': dov.GH_RUNS_PER_PAGE * dov.GH_RUNS_MAX_PAGES + 1,
                'workflow_runs': [
                    {'id': page * 1000 + i, 'path': '.github/workflows/muse-review.yml', 'status': 'completed'}
                    for i in range(dov.GH_RUNS_PER_PAGE)
                ],
            }

        with self.assertRaises(dov.GateError) as ctx:
            dov.default_gh_runs_fetcher(FAKE_REPO, FAKE_GH_TOKEN, http_get=truncated_gh)
        self.assertIn('truncated', str(ctx.exception))
        self.assertIn(str(dov.GH_RUNS_PER_PAGE), str(ctx.exception))
        self.assertNotIn(FAKE_GH_TOKEN, str(ctx.exception))

    def test_cf_deployments_truncated_listing_is_fail_closed(self):
        def truncated_cf(_url, _headers):
            return {
                'success': True,
                'result_info': {'total_pages': dov.CF_DEPLOYS_MAX_PAGES + 1},
                'result': [
                    {'id': f'dep-{i}', 'latest_stage': {'status': 'success'}}
                    for i in range(dov.CF_DEPLOYS_PER_PAGE)
                ],
            }

        with self.assertRaises(dov.GateError) as ctx:
            dov.default_cf_deployments_fetcher(
                FAKE_CF_ACCOUNT, FAKE_CF_TOKEN, dov.PINNED_PAGES_PROJECT, http_get=truncated_cf
            )
        self.assertIn('truncated', str(ctx.exception))
        self.assertIn(str(dov.CF_DEPLOYS_PER_PAGE), str(ctx.exception))
        self.assertNotIn(FAKE_CF_TOKEN, str(ctx.exception))


if __name__ == '__main__':
    unittest.main()
