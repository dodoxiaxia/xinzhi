"""Offline workflow checks using temporary local Git repositories only."""
import ast
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github/workflows/daily.yml'


def refresh_argument(context):
    """Evaluate the actual workflow's small expression without executing code."""
    match = re.search(r'^\s*run:\s*python3 scripts/ci_daily\.py\s*\$\{\{(.*?)\}\}\s*$', WORKFLOW.read_text(), re.MULTILINE)
    if not match:
        raise AssertionError('refresh command expression not found')
    expression = ast.parse(match[1].strip().replace('&&', ' and ').replace('||', ' or '), mode='eval').body

    def evaluate(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return context[node.id]
        if isinstance(node, ast.Attribute):
            target = evaluate(node.value)
            if not isinstance(target, dict):
                raise AssertionError('unsupported workflow context')
            return target.get(node.attr)
        if isinstance(node, ast.BoolOp):
            value = evaluate(node.values[0])
            for child in node.values[1:]:
                if isinstance(node.op, ast.And) and not value:
                    return value
                if isinstance(node.op, ast.Or) and value:
                    return value
                value = evaluate(child)
            return value
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = evaluate(node.left), evaluate(node.comparators[0])
            if isinstance(left, str) and isinstance(right, str):
                left, right = left.casefold(), right.casefold()
            if isinstance(node.ops[0], ast.Eq):
                return left == right
            if isinstance(node.ops[0], ast.NotEq):
                return left != right
        raise AssertionError('unsupported workflow expression: ' + type(node).__name__)

    return evaluate(expression)


class RefreshModeTests(unittest.TestCase):
    def select(self, event, *, schedule=None, mode=None):
        return refresh_argument({'github': {'event_name': event, 'ref': 'refs/heads/main', 'event': {'schedule': schedule}}, 'inputs': {'mode': mode}})

    def test_main_source_push_is_fast(self):
        self.assertEqual(self.select('push'), '--fast')

    def test_manual_full_remains_full(self):
        self.assertEqual(self.select('workflow_dispatch', mode='full'), '')

    def test_daily_0517_beijing_remains_full(self):
        self.assertEqual(self.select('schedule', schedule='47 20 * * *'), '')

    def test_every_two_hours_remains_fast(self):
        self.assertEqual(self.select('schedule', schedule='37 */2 * * *'), '--fast')

    def test_explicit_manual_fast_remains_fast(self):
        self.assertEqual(self.select('workflow_dispatch', mode='fast'), '--fast')

    def test_manual_default_remains_full(self):
        self.assertEqual(self.select('workflow_dispatch'), '')


def restore_commands():
    lines = WORKFLOW.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == 'id: restore_state')
    run = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == 'run: |')
    indent = len(lines[run]) - len(lines[run].lstrip())
    body = []
    for line in lines[run + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line[indent + 2:])
    return '\n'.join(body)


class StateWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.remote = self.base / 'remote.git'
        self.repo = self.base / 'checkout'
        self.repo.mkdir()
        self.git(self.base, 'init', '--bare', str(self.remote))
        self.git(self.repo, 'init', '-b', 'main')
        self.git(self.repo, 'config', 'user.email', 'fixture@example.invalid')
        self.git(self.repo, 'config', 'user.name', 'Offline fixture')
        self.git(self.repo, 'remote', 'add', 'origin', str(self.remote))
        (self.repo / 'app.js').write_text('trusted main code')
        (self.repo / 'docs').mkdir()
        for name in ('last-refresh.json', 'deployment-status.json'):
            (self.repo / 'docs' / name).write_text('old main report')
        self.commit(self.repo, 'main code')
        self.git(self.repo, 'checkout', '--orphan', 'state')
        self.git(self.repo, 'rm', '-rf', '.')
        (self.repo / 'data').mkdir()
        (self.repo / 'public').mkdir()
        (self.repo / 'docs').mkdir()
        (self.repo / 'data' / 'feeds.json').write_text('{"items": []}')
        (self.repo / 'public' / 'public.js').write_text('published bundle')
        (self.repo / 'docs' / 'public-manifest.json').write_text(json.dumps({'release': 'v13.4'}))
        (self.repo / 'docs' / 'last-refresh.json').write_text('old state report')
        # A hostile or accidental state code file must not overwrite main.
        (self.repo / 'app.js').write_text('untrusted state code')
        self.commit(self.repo, 'state fixture')
        self.original_sha = self.git(self.repo, 'rev-parse', 'HEAD').stdout.strip()
        self.git(self.repo, 'push', 'origin', 'state')
        self.git(self.repo, 'checkout', 'main')

    def git(self, repo, *args, check=True):
        return subprocess.run(['git', *args], cwd=repo, check=check, capture_output=True, text=True)

    def commit(self, repo, message):
        self.git(repo, 'add', '-A')
        self.git(repo, 'commit', '-m', message)

    def restore(self):
        output = self.base / 'github-output'
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', restore_commands()], cwd=self.repo, env=dict(os.environ, GITHUB_OUTPUT=str(output)), capture_output=True, text=True), output

    def test_restore_uses_pinned_data_only_and_accepts_old_state_schema(self):
        result, output = self.restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('sha=' + self.original_sha, output.read_text())
        self.assertEqual((self.repo / 'app.js').read_text(), 'trusted main code')
        self.assertEqual((self.repo / 'public' / 'public.js').read_text(), 'published bundle')
        self.assertEqual(json.loads((self.repo / 'docs' / 'public-manifest.json').read_text())['release'], 'v13.4')
        self.assertFalse((self.repo / 'docs' / 'last-refresh.json').exists())
        self.assertFalse((self.repo / 'docs' / 'deployment-status.json').exists())

    def test_restore_failure_removes_old_run_reports_first(self):
        self.git(self.remote, 'update-ref', '-d', 'refs/heads/state')
        result, _ = self.restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.repo / 'docs' / 'last-refresh.json').exists())
        self.assertFalse((self.repo / 'docs' / 'deployment-status.json').exists())

    def test_explicit_lease_rejects_an_unseen_concurrent_state_write(self):
        source = WORKFLOW.read_text()
        self.assertIn("STATE_EXPECTED_SHA='${{ steps.restore_state.outputs.sha }}'", source)
        self.assertIn('python3 scripts/save_state.py --expected "$STATE_EXPECTED_SHA"', source)
        self.assertIn("'--force-with-lease=refs/heads/state:' + expected", (ROOT / 'scripts/save_state.py').read_text())
        self.assertIn('STATE_EXPECTED_SHA=$(cat .local/week-checkpoint-head)', source)
        self.assertIn("XINZHI_PRECOMPUTE_STATE_CHECKPOINT: ${{ vars.XINZHI_PRECOMPUTE_STATE_CHECKPOINT || '1' }}", source)
        self.assertNotIn('git push -f ', source)
        self.git(self.repo, 'checkout', 'state')
        (self.repo / 'data' / 'feeds.json').write_text('{"items": ["concurrent"]}')
        self.commit(self.repo, 'concurrent writer')
        concurrent_sha = self.git(self.repo, 'rev-parse', 'HEAD').stdout.strip()
        self.git(self.repo, 'push', 'origin', 'state')
        self.git(self.repo, 'checkout', 'main')
        result = self.git(self.repo, 'push', '--force-with-lease=refs/heads/state:' + self.original_sha, 'origin', 'main:state', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git(self.remote, 'rev-parse', 'refs/heads/state').stdout.strip(), concurrent_sha)


    def run_save(self, expected):
        workspace = self.base / 'workspace'
        if not workspace.exists():
            (workspace / 'data').mkdir(parents=True)
            (workspace / 'public').mkdir()
            (workspace / 'docs').mkdir()
            (workspace / 'data' / 'feeds.json').write_text('{"items": ["new run"]}')
            (workspace / 'data' / 'deep-reading-ledger.json').write_text('{"local": true}')
            (workspace / 'public' / 'public.js').write_text('new bundle')
            for name in ('public-manifest.json', 'last-refresh.json', 'deployment-status.json'):
                (workspace / 'docs' / name).write_text('{}')
        result = subprocess.run(['python3', str(ROOT / 'scripts/save_state.py'), '--expected', expected, '--remote', str(self.remote)],
                                cwd=workspace, capture_output=True, text=True)
        return result, workspace

    def remote_file(self, path):
        return self.git(self.remote, 'show', 'refs/heads/state:' + path).stdout

    def push_state_commit(self, message, files):
        self.git(self.repo, 'checkout', 'state')
        for path, content in files.items():
            (self.repo / path).write_text(content)
        self.commit(self.repo, message)
        self.git(self.repo, 'push', 'origin', 'state')
        sha = self.git(self.repo, 'rev-parse', 'HEAD').stdout.strip()
        self.git(self.repo, 'checkout', 'main')
        return sha

    def test_save_state_with_matching_lease(self):
        result, _ = self.run_save(self.original_sha)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('"lease": "original"', result.stdout)
        self.assertEqual(self.remote_file('public/public.js'), 'new bundle')
        self.assertNotIn('app.js', self.git(self.remote, 'ls-tree', '--name-only', 'refs/heads/state').stdout)

    def test_unconfirmed_own_checkpoint_is_merged_not_lost(self):
        # The checkpoint landed on GitHub but its client timed out, so the run kept the old lease.
        self.push_state_commit('Checkpoint daily public full-text reading', {'data/deep-reading-ledger.json': '{"started": true}'})
        result, workspace = self.run_save(self.original_sha)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('checkpoint_merged', result.stdout)
        self.assertEqual(self.remote_file('data/deep-reading-ledger.json'), '{"started": true}')
        self.assertEqual(self.remote_file('data/feeds.json'), '{"items": ["new run"]}')
        self.assertEqual((workspace / 'data' / 'deep-reading-ledger.json').read_text(), '{"started": true}')

    def test_foreign_writer_or_checkpoint_outside_its_files_still_rejected(self):
        for message, files in (('concurrent writer', {'data/deep-reading-ledger.json': 'x'}),
                               ('Checkpoint daily public full-text reading', {'data/feeds.json': 'x'})):
            with self.subTest(message=message):
                self.git(self.repo, 'branch', '-f', 'state', self.original_sha)
                head = self.push_state_commit(message, files)
                result, _ = self.run_save(self.original_sha)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('state_foreign_writer', result.stdout)
                self.assertEqual(self.git(self.remote, 'rev-parse', 'refs/heads/state').stdout.strip(), head)
                self.git(self.repo, 'push', '-f', 'origin', self.original_sha + ':refs/heads/state')


if __name__ == '__main__':
    unittest.main()
