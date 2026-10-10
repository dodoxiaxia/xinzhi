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
        self.assertEqual(self.select('schedule', schedule='17 21 * * *'), '')

    def test_every_two_hours_remains_fast(self):
        self.assertEqual(self.select('schedule', schedule='7 */2 * * *'), '--fast')

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
        self.assertIn('--force-with-lease=refs/heads/state:"$STATE_EXPECTED_SHA"', source)
        self.assertIn('STATE_EXPECTED_SHA=$(cat .local/week-checkpoint-head)', source)
        self.assertIn('XINZHI_PRECOMPUTE_STATE_CHECKPOINT: ${{ vars.XINZHI_PRECOMPUTE_STATE_CHECKPOINT }}', source)
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


class StateLeaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.git('init', '-q', '-b', 'state')
        self.git('config', 'user.email', 't@example.com')
        self.git('config', 'user.name', 't')
        self.base = self.commit('state 2026-10-10')

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, message):
        self.git('commit', '-q', '--allow-empty', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def resolve(self, expected):
        return subprocess.run(['python3', str(ROOT / 'scripts/resolve_state_lease.py'), expected, 'HEAD'],
                              cwd=self.repo, capture_output=True, text=True)

    def test_workflow_retries_only_through_the_resolver(self):
        source = WORKFLOW.read_text()
        self.assertIn('scripts/resolve_state_lease.py" "$STATE_EXPECTED_SHA"', source)
        self.assertEqual(source.count('--force-with-lease=refs/heads/state:"$STATE_EXPECTED_SHA"'), 2)

    def test_own_checkpoint_commits_advance_the_lease(self):
        self.commit('Checkpoint daily public full-text reading')
        tip = self.commit('Checkpoint daily public full-text reading')
        result = self.resolve(self.base)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), tip)

    def test_unchanged_remote_keeps_the_lease(self):
        self.assertEqual(self.resolve(self.base).stdout.strip(), self.base)

    def test_any_other_writer_is_rejected(self):
        self.commit('Checkpoint daily public full-text reading')
        self.commit('state 2026-10-11')
        self.assertEqual(self.resolve(self.base).returncode, 1)

    def test_unrelated_history_is_rejected(self):
        self.git('checkout', '-q', '--orphan', 'other')
        self.commit('Checkpoint daily public full-text reading')
        self.assertEqual(self.resolve(self.base).returncode, 1)
        self.assertEqual(self.resolve('not-a-sha').returncode, 1)


if __name__ == '__main__':
    unittest.main()
