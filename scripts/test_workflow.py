"""Offline workflow checks using temporary local Git repositories only."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github/workflows/daily.yml'


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
