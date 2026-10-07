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
QUALITY_WORKFLOW = ROOT / '.github/workflows/ci.yml'


def evaluate_expression(expression, context):
    """Evaluate the workflow's boolean subset without executing workflow code."""
    translated = re.sub(r'!(?!=)', ' not ', expression.strip().replace('&&', ' and ').replace('||', ' or ')).strip()
    expression = ast.parse(translated, mode='eval').body

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
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not evaluate(node.operand)
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


def refresh_argument(context):
    match = re.search(r'^\s*run:\s*python3 scripts/ci_daily\.py\s*\$\{\{(.*?)\}\}\s*$', WORKFLOW.read_text(), re.MULTILINE)
    if not match:
        raise AssertionError('refresh command expression not found')
    return evaluate_expression(match[1], context)


def job_configuration(name):
    """Read a top-level job's configuration, excluding its step bodies."""
    match = re.search(r'^  ' + re.escape(name) + r':\n(.*?)(?=^  [\w-]+:|\Z)', WORKFLOW.read_text(), re.MULTILINE | re.DOTALL)
    if not match:
        raise AssertionError('workflow job not found: ' + name)
    return match[1].split('    steps:', 1)[0]


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


class QualityGateTests(unittest.TestCase):
    def context(self, event, *, mode=None, allow=False, ref='refs/heads/main'):
        return {'github': {'event_name': event, 'ref': ref}, 'inputs': {'mode': mode, 'allow_fast_dispatch': allow}}

    def enabled(self, job, context):
        match = re.search(r'^    if: (.+)$', job_configuration(job), re.MULTILINE)
        self.assertIsNotNone(match, 'job must have an explicit event gate')
        return bool(evaluate_expression(match[1], context))

    def group(self, context):
        match = re.search(r'^  group: \$\{\{(.*?)\}\}', WORKFLOW.read_text(), re.MULTILINE)
        self.assertIsNotNone(match, 'concurrency must distinguish ignored dispatches')
        return evaluate_expression(match[1], context)

    def test_scheduled_push_and_manual_refreshes_require_quality(self):
        contexts = [self.context('schedule'), self.context('push'), self.context('workflow_dispatch'),
                    self.context('workflow_dispatch', mode='full'),
                    self.context('workflow_dispatch', mode='fast', allow=True)]
        for context in contexts:
            with self.subTest(context=context):
                self.assertTrue(self.enabled('quality', context))
                self.assertTrue(self.enabled('refresh', context))
        refresh = job_configuration('refresh')
        self.assertRegex(refresh, r'(?m)^    needs: quality$')
        self.assertNotIn('always()', refresh)
        self.assertRegex(job_configuration('quality'), r'(?m)^    uses: \./\.github/workflows/ci\.yml$')

    def test_ignored_legacy_requests_do_not_run_quality_or_replace_refresh_queue(self):
        ignored = self.context('workflow_dispatch', mode='fast')
        self.assertTrue(self.enabled('ignored-dispatch', ignored))
        self.assertFalse(self.enabled('quality', ignored))
        self.assertFalse(self.enabled('refresh', ignored))
        active_groups = {self.group(self.context(event)) for event in ('schedule', 'push', 'workflow_dispatch')}
        active_groups.add(self.group(self.context('workflow_dispatch', mode='fast', allow=True)))
        self.assertEqual(len(active_groups), 1, 'legitimate refreshes must still serialize')
        self.assertNotIn(self.group(ignored), active_groups)

    def test_non_main_dispatch_cannot_refresh_or_run_production_quality(self):
        context = self.context('workflow_dispatch', mode='full', ref='refs/heads/feature')
        self.assertFalse(self.enabled('quality', context))
        self.assertFalse(self.enabled('refresh', context))

    def test_existing_schedules_are_preserved_without_an_extra_schedule(self):
        self.assertEqual(re.findall(r"cron: '([^']+)'", WORKFLOW.read_text()), ['17 21 * * *', '7 */2 * * *'])
        self.assertNotRegex(QUALITY_WORKFLOW.read_text(), r'(?m)^  schedule:')

    def test_offline_quality_has_read_only_permissions_and_no_production_secrets(self):
        source = QUALITY_WORKFLOW.read_text()
        self.assertRegex(source, r'(?m)^  pull_request:$')
        self.assertRegex(source, r'(?m)^  workflow_call:$')
        self.assertRegex(source, r'(?m)^  workflow_dispatch:$')
        self.assertRegex(source, r'(?m)^permissions:\n  contents: read$')
        self.assertNotIn('secrets.', source)
        self.assertNotIn('secrets: inherit', WORKFLOW.read_text())
        self.assertNotIn('contents: write', job_configuration('quality'))
        self.assertNotRegex(source, r'(?m)^\s+(?:run: )?(?:git push|npx .*wrangler|python3 scripts/ci_daily\.py)')

    def test_new_service_and_workflow_changes_trigger_the_production_gate(self):
        source = WORKFLOW.read_text()
        for path in ('service/**', 'config/**', 'editor/**', 'workers/**', '.github/workflows/**'):
            with self.subTest(path=path):
                self.assertIn("      - '" + path + "'", source)


def restore_commands(workflow=WORKFLOW):
    lines = workflow.read_text().splitlines()
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

    def restore(self, workflow=WORKFLOW):
        output = self.base / 'github-output'
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', restore_commands(workflow)], cwd=self.repo, env=dict(os.environ, GITHUB_OUTPUT=str(output)), capture_output=True, text=True), output

    def test_quality_restores_pinned_data_without_overwriting_code_or_reports(self):
        result, output = self.restore(QUALITY_WORKFLOW)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('sha=' + self.original_sha, output.read_text())
        self.assertEqual((self.repo / 'app.js').read_text(), 'trusted main code')
        self.assertEqual((self.repo / 'public' / 'public.js').read_text(), 'published bundle')
        self.assertEqual(json.loads((self.repo / 'data' / 'feeds.json').read_text()), {'items': []})
        for name in ('last-refresh.json', 'deployment-status.json'):
            self.assertEqual((self.repo / 'docs' / name).read_text(), 'old main report')
        self.assertFalse((self.repo / 'docs' / 'public-manifest.json').exists())

    def test_quality_restore_fails_when_state_is_missing(self):
        self.git(self.remote, 'update-ref', '-d', 'refs/heads/state')
        result, _ = self.restore(QUALITY_WORKFLOW)
        self.assertNotEqual(result.returncode, 0)

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
        self.assertIn('--force-with-lease=refs/heads/state:${{ steps.restore_state.outputs.sha }}', source)
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


if __name__ == '__main__':
    unittest.main()
