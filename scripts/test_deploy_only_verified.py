"""Offline unit tests for deploy-only-verified CI workflow and gates.

All checks use local temporary directories, bare Git fixtures, and mocked API
responses. No network access, real secrets, or production deployments occur.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import deploy_only_verified as dov  # noqa: E402

WORKFLOW_PATH = ROOT / '.github/workflows/deploy-only-verified.yml'
PIN_PATH = ROOT / 'config/deploy-only-verified-public.json'
FAKE_CF_TOKEN = 'fake-cf-api-token-for-offline-test'
FAKE_CF_ACCOUNT = 'fake-cf-account-for-offline-test'
FAKE_GH_TOKEN = 'fake-gh-token-for-offline-test'


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


def _commit_all(repo_dir, message):
    _git(repo_dir, 'add', '-A')
    _git(repo_dir, 'commit', '-qm', message)
    return _git(repo_dir, 'rev-parse', 'HEAD').stdout.strip()


def _make_19_files(public_dir, *, override_content=None):
    pin_data = json.loads(PIN_PATH.read_text(encoding='utf-8'))
    pin_paths = [entry['path'] for entry in pin_data['files']]
    synthetic_files = []
    for idx, rel in enumerate(pin_paths):
        content = f'offline-synthetic-{idx}-{rel}\n'.encode('utf-8')
        if override_content and rel in override_content:
            content = override_content[rel]
        target = Path(public_dir) / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        synthetic_files.append({
            'path': rel,
            'bytes': len(content),
            'sha256': hashlib.sha256(content).hexdigest(),
        })
    return synthetic_files


def _cf_project_response(commit_hash, *, latest_commit=None, latest_status='success', canonical_status='success'):
    latest_hash = latest_commit if latest_commit is not None else commit_hash
    return {
        'success': True,
        'result': {
            'name': dov.PINNED_PAGES_PROJECT,
            'canonical_deployment': {
                'id': 'fake-canonical-dep-id',
                'environment': 'production',
                'latest_stage': {'name': 'deploy', 'status': canonical_status},
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
                'id': 'fake-latest-dep-id',
                'environment': 'production',
                'latest_stage': {'name': 'deploy', 'status': latest_status},
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
    def test_workflow_is_manual_dispatch_only_on_main_with_minimal_permissions(self):
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

        self.assertIn('fetch-depth: 0', text)
        self.assertIn('persist-credentials: false', text)
        self.assertIn("vars.XINZHI_STATE_REPO || 'dodoxiaxia/xinzhi-state'", text)
        self.assertIn('secrets.XINZHI_STATE_TOKEN', text)

        for forbidden_ref in (
            'XINZHI_MACHINE_TOKEN',
            'save_state',
            'ci_daily',
            'build_public',
            'public-manifest.json',
            'wrangler@4',
            '--no-bundle',
        ):
            self.assertNotIn(forbidden_ref, text)

        self.assertIn("steps.gate.outcome == 'success' && steps.gate.outputs.verified == 'true'", text)
        self.assertIn('--recheck-before-deploy', text)
        self.assertIn("steps.recheck.outcome == 'success'", text)
        self.assertLess(text.index('--recheck-before-deploy'), text.index('wrangler@3'))
        recheck_block = text[text.index('id: recheck'):text.index('发布已核验原包')]
        self.assertIn('CLOUDFLARE_API_TOKEN', recheck_block)
        self.assertIn('CLOUDFLARE_ACCOUNT_ID', recheck_block)
        self.assertNotIn('GITHUB_TOKEN', recheck_block)
        self.assertNotIn('XINZHI_STATE_TOKEN', recheck_block)
        self.assertRegex(text, r'persist-credentials:\s*false')
        self.assertIsNone(re.search(r'persist-credentials:\s*true', text))
        self.assertIn("CI: 'true'", text)
        self.assertIn('npx --yes wrangler@3 pages deploy "${{ runner.temp }}/verified-public"', text)
        self.assertIn('--project-name dryz-xinzhi', text)
        self.assertIn('--branch main', text)
        self.assertIn('--commit-dirty=true', text)
        self.assertIn(f'--commit-hash {dov.PINNED_PACKAGE_CODE_SHA}', text)


class PinManifestTests(unittest.TestCase):
    def test_pinned_manifest_is_valid_19_file_pin_without_hex32(self):
        raw = PIN_PATH.read_text(encoding='utf-8')
        self.assertIsNone(re.search(r'\b[0-9a-fA-F]{32}\b', raw))
        pin = dov.load_pin_manifest(PIN_PATH)
        self.assertEqual(pin['packageCodeSha'], dov.PINNED_PACKAGE_CODE_SHA)
        self.assertEqual(pin['stateCommit'], dov.PINNED_STATE_COMMIT)
        self.assertEqual(pin['stateRepository'], dov.PINNED_STATE_REPOSITORY)
        self.assertEqual(pin['pagesProject'], dov.PINNED_PAGES_PROJECT)
        self.assertEqual(pin['productionBranch'], dov.PINNED_PRODUCTION_BRANCH)
        self.assertEqual(pin['file_count'], 19)
        self.assertEqual(len(pin['files']), 19)


class InputValidationTests(unittest.TestCase):
    def test_accepts_open_and_close_with_exact_confirm(self):
        for purpose in ('open', 'close'):
            with self.subTest(purpose=purpose):
                result = dov.validate_inputs(
                    purpose,
                    dov.EXPECTED_CONFIRM,
                    state_repo=dov.PINNED_STATE_REPOSITORY,
                    github_ref='refs/heads/main',
                    event_name='workflow_dispatch',
                )
                self.assertEqual(result['purpose'], purpose)

    def test_rejects_injection_traversal_and_bad_inputs(self):
        bad_purposes = ('', 'other', ' open', 'open\nclose', '../open', 'open;id', 'https://evil.example')
        for bad in bad_purposes:
            with self.subTest(bad_purpose=bad):
                with self.assertRaises(dov.GateError):
                    dov.validate_inputs(bad, dov.EXPECTED_CONFIRM)

        bad_confirms = (
            '',
            'wrong',
            dov.EXPECTED_CONFIRM + '\n',
            '../' + dov.EXPECTED_CONFIRM,
            'https://evil.example/' + dov.EXPECTED_CONFIRM,
            dov.EXPECTED_CONFIRM + ';echo',
        )
        for bad in bad_confirms:
            with self.subTest(bad_confirm=bad):
                with self.assertRaises(dov.GateError):
                    dov.validate_inputs('open', bad)

        for bad_repo in ('other/xinzhi-state', '../xinzhi-state', 'https://github.com/dodoxiaxia/xinzhi-state'):
            with self.subTest(bad_repo=bad_repo):
                with self.assertRaises(dov.GateError):
                    dov.validate_inputs('open', dov.EXPECTED_CONFIRM, state_repo=bad_repo)

        with self.assertRaises(dov.GateError):
            dov.validate_inputs('open', dov.EXPECTED_CONFIRM, github_ref='refs/heads/feature')
        with self.assertRaises(dov.GateError):
            dov.validate_inputs('open', dov.EXPECTED_CONFIRM, event_name='push')

        for bad_path in ('', '/abs/path', '../escape', 'a/../b', 'a\\b', 'https://x.invalid/a', 'a\nb', 'a\x00b'):
            with self.subTest(bad_path=bad_path):
                with self.assertRaises(dov.GateError):
                    dov.validate_safe_relpath(bad_path)


class ProductionShaGateTests(unittest.TestCase):
    def test_passes_when_canonical_and_latest_match_pinned_sha(self):
        res = dov.verify_production_code_sha(
            FAKE_CF_ACCOUNT,
            FAKE_CF_TOKEN,
            project_fetcher=lambda _a, _t, _p: _cf_project_response(dov.PINNED_PACKAGE_CODE_SHA),
        )
        self.assertEqual(res['productionCommit'], dov.PINNED_PACKAGE_CODE_SHA)

    def test_rejects_when_production_is_different_sha(self):
        other_sha = 'a' * 40
        with self.assertRaises(dov.GateError) as ctx:
            dov.verify_production_code_sha(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                project_fetcher=lambda _a, _t, _p: _cf_project_response(other_sha),
            )
        self.assertNotIn(FAKE_CF_TOKEN, str(ctx.exception))
        self.assertNotIn(FAKE_CF_ACCOUNT, str(ctx.exception))

    def test_rejects_when_latest_production_deployment_diverged_or_active(self):
        other_sha = 'b' * 40
        with self.assertRaises(dov.GateError):
            dov.verify_production_code_sha(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                project_fetcher=lambda _a, _t, _p: _cf_project_response(
                    dov.PINNED_PACKAGE_CODE_SHA, latest_commit=other_sha, latest_status='success'
                ),
            )
        with self.assertRaises(dov.GateError):
            dov.verify_production_code_sha(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                project_fetcher=lambda _a, _t, _p: _cf_project_response(
                    dov.PINNED_PACKAGE_CODE_SHA, latest_status='active'
                ),
            )

    def test_rejects_missing_canonical_or_api_failure(self):
        with self.assertRaises(dov.GateError):
            dov.verify_production_code_sha(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                project_fetcher=lambda _a, _t, _p: {'success': False},
            )
        with self.assertRaises(dov.GateError):
            dov.verify_production_code_sha(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                project_fetcher=lambda _a, _t, _p: {'success': True, 'result': {'name': dov.PINNED_PAGES_PROJECT}},
            )


class PackagePinGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def _pin_for(self, files, state_commit=dov.PINNED_STATE_COMMIT):
        return {
            'packageCodeSha': dov.PINNED_PACKAGE_CODE_SHA,
            'stateCommit': state_commit,
            'stateRepository': dov.PINNED_STATE_REPOSITORY,
            'pagesProject': dov.PINNED_PAGES_PROJECT,
            'productionBranch': dov.PINNED_PRODUCTION_BRANCH,
            'file_count': len(files),
            'files': files,
        }

    def test_verify_package_tree_accepts_exact_match_and_rejects_mutations(self):
        pub = self.base / 'pub'
        files = _make_19_files(pub)
        pin = self._pin_for(files)

        summary = dov.verify_package_tree(pub, pin)
        self.assertEqual(summary['fileCount'], 19)

        # Wrong sha256 with identical byte length
        index_path = pub / 'index.html'
        orig = index_path.read_bytes()
        index_path.write_bytes(b'X' + orig[1:])
        with self.assertRaises(dov.GateError):
            dov.verify_package_tree(pub, pin)

        # Wrong byte length
        index_path.write_bytes(orig + b'extra')
        with self.assertRaises(dov.GateError):
            dov.verify_package_tree(pub, pin)
        index_path.write_bytes(orig)

        # Extra file
        extra_path = pub / 'unexpected.txt'
        extra_path.write_text('extra', encoding='utf-8')
        with self.assertRaises(dov.GateError):
            dov.verify_package_tree(pub, pin)
        extra_path.unlink()

        # Missing file
        index_path.unlink()
        with self.assertRaises(dov.GateError):
            dov.verify_package_tree(pub, pin)
        index_path.write_bytes(orig)

        # Symlink inside public/
        (pub / 'sym.txt').symlink_to(index_path)
        with self.assertRaises(dov.GateError):
            dov.verify_package_tree(pub, pin)

    def test_fetch_reads_only_pinned_state_commit_not_branch_tip(self):
        bare = self.base / 'state-remote.git'
        work = self.base / 'state-work'
        work.mkdir()
        _git(self.base, 'init', '--bare', str(bare))
        _init_git_repo(work)

        files_v1 = _make_19_files(work / 'public')
        _git(work, 'checkout', '-b', 'state')
        pinned_sha = _commit_all(work, 'pinned state')
        _git(work, 'push', str(bare), 'state:refs/heads/state')

        # Advance state branch tip with modified public/content; fetcher must ignore tip and read pinned_sha.
        _make_19_files(work / 'public', override_content={'index.html': b'newer state tip must not be used\n'})
        _commit_all(work, 'newer state tip')
        _git(work, 'push', str(bare), 'state:refs/heads/state')

        pin = self._pin_for(files_v1, state_commit=pinned_sha)
        out_dir = self.base / 'extracted-public'
        repo_root = self.base / 'repo-root'
        repo_root.mkdir()

        # Output dir inside repo_root must be refused.
        with mock.patch.object(dov, 'PINNED_STATE_COMMIT', pinned_sha):
            with self.assertRaises(dov.GateError):
                dov.fetch_verified_package_from_state(
                    repo_root / 'public',
                    pin,
                    state_commit=pinned_sha,
                    remote_url=str(bare),
                    repo_root=repo_root,
                )

            # Force direct fetch fallback path by checking extraheader clearing is passed
            calls = []
            real_runner = dov._default_git_runner

            def recording_runner(cwd, args, env=None):
                calls.append(args)
                return real_runner(cwd, args, env=env)

            summary = dov.fetch_verified_package_from_state(
                out_dir,
                pin,
                state_commit=pinned_sha,
                remote_url=str(bare),
                repo_root=repo_root,
                git_runner=recording_runner,
            )
            self.assertEqual(summary['fileCount'], 19)
            self.assertEqual(summary['stateCommit'], pinned_sha)
            self.assertTrue(any('http.https://github.com/.extraheader=' in args for args in calls))

        # Missing pinned commit must fail closed, never fall back to branch tip.
        missing_sha = 'c' * 40
        with mock.patch.object(dov, 'PINNED_STATE_COMMIT', missing_sha):
            with self.assertRaises(dov.GateError):
                dov.fetch_verified_package_from_state(
                    self.base / 'extracted-missing',
                    self._pin_for(files_v1, state_commit=missing_sha),
                    state_commit=missing_sha,
                    remote_url=str(bare),
                    repo_root=repo_root,
                )


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
        self.base_sha = _commit_all(self.repo, 'base d646340 fixture')

    def test_allows_base_and_allowlisted_new_files_even_when_head_differs(self):
        with mock.patch.object(dov, 'PINNED_PACKAGE_CODE_SHA', self.base_sha):
            res_same = dov.verify_main_diff(self.repo, base_sha=self.base_sha)
            self.assertEqual(res_same['headSha'], self.base_sha)
            self.assertEqual(res_same['addedPaths'], [])

            for rel in sorted(dov.ALLOWED_MAIN_DIFF_PATHS):
                target = self.repo / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('new allowlisted file', encoding='utf-8')
            merged_sha = _commit_all(self.repo, 'merge deploy-only-verified CI')
            self.assertNotEqual(merged_sha, self.base_sha)

            res_merged = dov.verify_main_diff(self.repo, base_sha=self.base_sha)
            self.assertEqual(res_merged['headSha'], merged_sha)
            self.assertEqual(res_merged['addedPaths'], sorted(dov.ALLOWED_MAIN_DIFF_PATHS))

    def test_rejects_non_allowlist_addition_or_existing_file_modification(self):
        with mock.patch.object(dov, 'PINNED_PACKAGE_CODE_SHA', self.base_sha):
            # Dirty working tree
            (self.repo / 'index.html').write_text('dirty', encoding='utf-8')
            with self.assertRaises(dov.GateError):
                dov.verify_main_diff(self.repo, base_sha=self.base_sha)
            (self.repo / 'index.html').write_text('prod html', encoding='utf-8')

            # Unlisted new file committed
            (self.repo / 'extra.js').write_text('unlisted', encoding='utf-8')
            _commit_all(self.repo, 'unlisted file')
            with self.assertRaises(dov.GateError):
                dov.verify_main_diff(self.repo, base_sha=self.base_sha)

        # Reset to base and test modifying existing file
        _git(self.repo, 'reset', '--hard', self.base_sha)
        (self.repo / '.github/workflows/daily.yml').write_text('modified daily', encoding='utf-8')
        _commit_all(self.repo, 'modify daily.yml')
        with mock.patch.object(dov, 'PINNED_PACKAGE_CODE_SHA', self.base_sha):
            with self.assertRaises(dov.GateError):
                dov.verify_main_diff(self.repo, base_sha=self.base_sha)


class ConcurrencyGateTests(unittest.TestCase):
    def test_passes_when_idle_and_blocks_on_active_or_unknown(self):
        ok = dov.verify_no_concurrent_deploy(
            FAKE_CF_ACCOUNT,
            FAKE_CF_TOKEN,
            repo='dodoxiaxia/xinzhi',
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

        # Active CF deployment -> fail
        with self.assertRaises(dov.GateError):
            dov.verify_no_concurrent_deploy(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                repo='dodoxiaxia/xinzhi',
                github_token=FAKE_GH_TOKEN,
                current_run_id='100',
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('active'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
            )

        # Empty CF deployments (fail-closed) -> fail
        with self.assertRaises(dov.GateError):
            dov.verify_no_concurrent_deploy(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                repo='dodoxiaxia/xinzhi',
                github_token=FAKE_GH_TOKEN,
                current_run_id='100',
                deployments_fetcher=lambda _a, _t, _p: {'success': True, 'result': []},
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
            )

        # Running daily.yml -> fail
        with self.assertRaises(dov.GateError):
            dov.verify_no_concurrent_deploy(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                repo='dodoxiaxia/xinzhi',
                github_token=FAKE_GH_TOKEN,
                current_run_id='100',
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: _gh_runs_response([
                    {'id': 98, 'path': '.github/workflows/daily.yml', 'status': 'in_progress'},
                ]),
            )

        # Another active or queued deploy-only-verified run -> fail
        for other_status in ('in_progress', 'queued'):
            with self.assertRaises(dov.GateError):
                dov.verify_no_concurrent_deploy(
                    FAKE_CF_ACCOUNT,
                    FAKE_CF_TOKEN,
                    repo='dodoxiaxia/xinzhi',
                    github_token=FAKE_GH_TOKEN,
                    current_run_id='100',
                    deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                    gh_runs_fetcher=lambda _r, _t: _gh_runs_response([
                        {'id': 95, 'path': '.github/workflows/deploy-only-verified.yml', 'status': other_status},
                    ]),
                )

        # Unparseable GH response (fail-closed) -> fail
        with self.assertRaises(dov.GateError):
            dov.verify_no_concurrent_deploy(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                repo='dodoxiaxia/xinzhi',
                github_token=FAKE_GH_TOKEN,
                current_run_id='100',
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: {'message': 'bad credentials'},
            )


class EndToEndGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

        # Local code repo with merged allowlist commit (HEAD != base packageCodeSha)
        self.repo = self.base / 'code-repo'
        self.repo.mkdir()
        _init_git_repo(self.repo)
        (self.repo / 'app.js').write_text('main code', encoding='utf-8')
        self.base_sha = _commit_all(self.repo, 'd646340 fixture')

        # Local bare state repo with pinned commit
        self.state_bare = self.base / 'state.git'
        self.state_work = self.base / 'state-work'
        self.state_work.mkdir()
        _git(self.base, 'init', '--bare', str(self.state_bare))
        _init_git_repo(self.state_work)
        _git(self.state_work, 'checkout', '-b', 'state')
        self.files = _make_19_files(self.state_work / 'public')
        self.state_sha = _commit_all(self.state_work, 'state fixture')
        _git(self.state_work, 'push', str(self.state_bare), 'state:refs/heads/state')

        # Write matching pin file in allowlisted path and commit so HEAD != base_sha
        for rel in sorted(dov.ALLOWED_MAIN_DIFF_PATHS):
            target = self.repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if rel == 'config/deploy-only-verified-public.json':
                target.write_text(json.dumps({
                    'packageCodeSha': self.base_sha,
                    'stateCommit': self.state_sha,
                    'stateRepository': dov.PINNED_STATE_REPOSITORY,
                    'pagesProject': dov.PINNED_PAGES_PROJECT,
                    'productionBranch': dov.PINNED_PRODUCTION_BRANCH,
                    'file_count': len(self.files),
                    'files': self.files,
                }), encoding='utf-8')
            else:
                target.write_text('allowlisted ci file\n', encoding='utf-8')
        self.head_sha = _commit_all(self.repo, 'merge deploy-only-verified PR')

    def test_open_and_close_paths_succeed_when_head_differs_and_use_same_wrangler_args(self):
        self.assertNotEqual(self.head_sha, self.base_sha)
        args_by_purpose = {}
        with mock.patch.object(dov, 'PINNED_PACKAGE_CODE_SHA', self.base_sha), \
             mock.patch.object(dov, 'PINNED_STATE_COMMIT', self.state_sha):
            for purpose in ('open', 'close'):
                out_dir = self.base / f'verified-public-{purpose}'
                summary = dov.run_all_gates(
                    repo_root=self.repo,
                    purpose=purpose,
                    confirm=dov.EXPECTED_CONFIRM,
                    output_dir=out_dir,
                    account_id=FAKE_CF_ACCOUNT,
                    api_token=FAKE_CF_TOKEN,
                    state_repo=dov.PINNED_STATE_REPOSITORY,
                    state_remote_url=str(self.state_bare),
                    github_token=FAKE_GH_TOKEN,
                    github_repo='dodoxiaxia/xinzhi',
                    github_run_id='200',
                    github_ref='refs/heads/main',
                    event_name='workflow_dispatch',
                    project_fetcher=lambda _a, _t, _p: _cf_project_response(self.base_sha),
                    deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                    gh_runs_fetcher=lambda _r, _t: _gh_runs_response([]),
                )
                self.assertTrue(summary['verified'])
                self.assertEqual(summary['purpose'], purpose)
                self.assertEqual(summary['headSha'], self.head_sha)
                self.assertEqual(summary['productionCommit'], self.base_sha)
                self.assertEqual(summary['fileCount'], 19)
                args_by_purpose[purpose] = dov.build_wrangler_deploy_args(self.base / 'shared-dir')

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
        self.assertIn(self.base_sha, cmd)

    def test_cli_exits_nonzero_and_marks_unverified_on_gate_failure(self):
        gh_out = self.base / 'github-output.txt'
        with mock.patch.dict(os.environ, {
            'GITHUB_OUTPUT': str(gh_out),
            'GITHUB_REF': 'refs/heads/feature',
            'GITHUB_EVENT_NAME': 'workflow_dispatch',
        }, clear=False):
            rc = dov.main([
                '--purpose', 'close',
                '--confirm', dov.EXPECTED_CONFIRM,
                '--output-dir', str(self.base / 'unused-out'),
            ])
        self.assertEqual(rc, 1)
        self.assertIn('verified=false', gh_out.read_text(encoding='utf-8'))


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
        self.base_sha = _commit_all(self.remote_work, 'base d646340 fixture')
        for rel in sorted(dov.ALLOWED_MAIN_DIFF_PATHS):
            target = self.remote_work / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('allowlisted\n', encoding='utf-8')
        self.allow_sha = _commit_all(self.remote_work, 'allowlist only')
        _git(self.remote_work, 'branch', '-M', 'main')
        _git(self.remote_work, 'push', str(self.remote), 'main:refs/heads/main')
        _git(self.base, 'clone', str(self.remote), str(self.checkout))
        _git(self.checkout, 'checkout', self.allow_sha)

    def test_recheck_uses_remote_main_and_rejects_new_production_or_main_changes(self):
        with mock.patch.object(dov, 'PINNED_PACKAGE_CODE_SHA', self.base_sha):
            ok = dov.revalidate_before_deploy(
                self.checkout,
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                project_fetcher=lambda _a, _t, _p: _cf_project_response(self.base_sha),
            )
            self.assertTrue(ok['verified'])
            self.assertEqual(ok['remoteMainSha'], self.allow_sha)
            self.assertEqual(ok['productionCommit'], self.base_sha)

            with self.assertRaises(dov.GateError):
                dov.revalidate_before_deploy(
                    self.checkout,
                    FAKE_CF_ACCOUNT,
                    FAKE_CF_TOKEN,
                    project_fetcher=lambda _a, _t, _p: _cf_project_response('ffffffffffffffffffffffffffffffffffffffff'),
                )

            (self.remote_work / 'app.js').write_text('new production code\n', encoding='utf-8')
            _commit_all(self.remote_work, 'new version on main')
            _git(self.remote_work, 'push', str(self.remote), 'main:refs/heads/main')
            # Local checkout HEAD is still the allowlisted commit; only remote main moved.
            self.assertEqual(_git(self.checkout, 'rev-parse', 'HEAD').stdout.strip(), self.allow_sha)
            with self.assertRaises(dov.GateError):
                dov.revalidate_before_deploy(
                    self.checkout,
                    FAKE_CF_ACCOUNT,
                    FAKE_CF_TOKEN,
                    project_fetcher=lambda _a, _t, _p: _cf_project_response(self.base_sha),
                )

    def test_recheck_rejects_later_edits_to_allowlisted_paths_but_allows_same_tree(self):
        """Allowlist vs d646340 still shows A after later edits to the same five files; recheck must not auto-pass."""
        with mock.patch.object(dov, 'PINNED_PACKAGE_CODE_SHA', self.base_sha):
            ok = dov.revalidate_before_deploy(
                self.checkout,
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                project_fetcher=lambda _a, _t, _p: _cf_project_response(self.base_sha),
            )
            self.assertEqual(ok['match'], 'commit')
            self.assertEqual(ok['reviewedSha'], self.allow_sha)

            _git(self.remote_work, 'commit', '--allow-empty', '-m', 'same tree, new commit')
            empty_sha = _git(self.remote_work, 'rev-parse', 'HEAD').stdout.strip()
            self.assertNotEqual(empty_sha, self.allow_sha)
            _git(self.remote_work, 'push', str(self.remote), 'main:refs/heads/main')
            same_tree = dov.revalidate_before_deploy(
                self.checkout,
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                project_fetcher=lambda _a, _t, _p: _cf_project_response(self.base_sha),
            )
            self.assertEqual(same_tree['match'], 'tree')
            self.assertEqual(same_tree['reviewedSha'], self.allow_sha)
            self.assertEqual(same_tree['remoteMainSha'], empty_sha)
            self.assertEqual(_git(self.checkout, 'rev-parse', 'HEAD').stdout.strip(), self.allow_sha)

            # Later rewrite of an already-allowlisted path would still be status A vs d646340.
            edited = self.remote_work / 'docs/deploy-only-verified.md'
            edited.write_text('later unreviewed rewrite\n', encoding='utf-8')
            later_sha = _commit_all(self.remote_work, 'rewrite allowlisted file')
            _git(self.remote_work, 'push', str(self.remote), 'main:refs/heads/main')
            later_diff = _git(
                self.remote_work, 'diff', '--name-status', '--no-renames',
                f'{self.base_sha}..{later_sha}',
            ).stdout
            self.assertIn('A\tdocs/deploy-only-verified.md', later_diff)
            self.assertNotIn('M\tdocs/deploy-only-verified.md', later_diff)
            with self.assertRaises(dov.GateError) as ctx:
                dov.revalidate_before_deploy(
                    self.checkout,
                    FAKE_CF_ACCOUNT,
                    FAKE_CF_TOKEN,
                    project_fetcher=lambda _a, _t, _p: _cf_project_response(self.base_sha),
                )
            self.assertIn('later main changes are not auto-approved', str(ctx.exception))
            self.assertEqual(_git(self.checkout, 'rev-parse', 'HEAD').stdout.strip(), self.allow_sha)


class PaginationBoundaryTests(unittest.TestCase):
    def test_gh_runs_pagination_finds_incomplete_run_on_later_page(self):
        pages = {
            1: {
                'total_count': 31,
                'workflow_runs': [
                    {'id': i, 'path': '.github/workflows/muse-review.yml', 'status': 'completed'}
                    for i in range(dov.GH_RUNS_PER_PAGE)
                ],
            },
            2: {
                'total_count': 31,
                'workflow_runs': [
                    {'id': 999, 'path': '.github/workflows/daily.yml', 'status': 'in_progress'},
                ],
            },
        }

        def http_get(url, _headers):
            if 'page=2' in url:
                return pages[2]
            return pages[1]

        payload = dov.default_gh_runs_fetcher('dodoxiaxia/xinzhi', FAKE_GH_TOKEN, http_get=http_get)
        self.assertEqual(len(payload['workflow_runs']), 31)
        with self.assertRaises(dov.GateError):
            dov.verify_no_concurrent_deploy(
                FAKE_CF_ACCOUNT,
                FAKE_CF_TOKEN,
                repo='dodoxiaxia/xinzhi',
                github_token=FAKE_GH_TOKEN,
                current_run_id='1',
                deployments_fetcher=lambda _a, _t, _p: _cf_deployments_response('success'),
                gh_runs_fetcher=lambda _r, _t: payload,
            )

    def test_gh_runs_truncated_listing_is_fail_closed(self):
        def http_get(url, _headers):
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
            dov.default_gh_runs_fetcher('dodoxiaxia/xinzhi', FAKE_GH_TOKEN, http_get=http_get)
        self.assertIn('truncated', str(ctx.exception))
        self.assertIn(str(dov.GH_RUNS_PER_PAGE), str(ctx.exception))
        self.assertNotIn(FAKE_GH_TOKEN, str(ctx.exception))


if __name__ == '__main__':
    unittest.main()
