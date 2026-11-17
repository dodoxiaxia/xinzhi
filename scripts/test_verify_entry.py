"""scripts/verify.sh must judge the working tree with the referee's guardrails, never the branch copy."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ENTRY = Path(__file__).resolve().parent / 'verify.sh'

REFEREE_CHECKER = '''CHECKS = ('referee-stub',)
def run_checks(root, only, base, public, extra, commit_range, config, include_untracked=False):
    print('checker=' + config.get('marker', '?'))
    return []
'''


@unittest.skipIf(shutil.which('bash') is None or shutil.which('git') is None,  # verify-allow: needs bash and git binaries
                 'needs bash and git')
class VerifyEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Verify Test')
        self.write('scripts/check_guardrails.py', REFEREE_CHECKER)
        self.write('config/guardrails.json', '{"marker": "referee"}\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'referee')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True, text=True).stdout

    def write(self, rel, text):
        target = self.root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def run_entry(self, *args, entry=ENTRY):
        env = {k: v for k, v in os.environ.items() if k != 'VERIFY_FROM_REFEREE'}
        return subprocess.run(['bash', str(entry), '--referee-only', '--no-fetch', *args],
                              cwd=self.root, env=env, capture_output=True, text=True, timeout=60)

    def test_tampered_branch_checker_and_config_are_ignored(self):
        self.git('checkout', '-qb', 'feature')
        self.write('scripts/check_guardrails.py', REFEREE_CHECKER.replace("'?'", "'?') + ' TAMPERED'"))
        self.write('config/guardrails.json', '{"marker": "branch"}\n')
        self.git('commit', '-qam', 'tamper referee on branch')
        result = self.run_entry()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('checker=referee', result.stdout)
        self.assertNotIn('TAMPERED', result.stdout)
        self.assertNotIn('checker=branch', result.stdout)
        self.assertIn('differs; ignored', result.stdout)

    def test_referee_entry_replaces_branch_entry(self):
        # Once the referee ref carries scripts/verify.sh, a branch edit to the entry does not run.
        self.git('checkout', '-q', 'origin/main')
        self.write('scripts/verify.sh', ENTRY.read_text())
        self.git('add', '.')
        self.git('commit', '-qm', 'entry on referee')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.git('checkout', '-qb', 'feature2')
        edited = ENTRY.read_text().replace('exit "$FAIL"\n', 'echo BRANCH-ENTRY\nexit 0\n')
        self.assertIn('BRANCH-ENTRY', edited)
        self.write('scripts/verify.sh', edited)
        self.git('commit', '-qam', 'edit entry on branch')
        canonical = self.root.parent / (self.root.name + '-referee-verify.sh')
        canonical.write_text(self.git('show', 'origin/main:scripts/verify.sh'))
        self.addCleanup(canonical.unlink)
        for entry in (self.root / 'scripts/verify.sh', canonical):
            with self.subTest(entry=entry.name):
                result = self.run_entry(entry=entry)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('verify entry: referee origin/main@', result.stdout)
                self.assertNotIn('BRANCH-ENTRY', result.stdout)
                self.assertIn('checker=referee', result.stdout)

    def test_findings_fail_the_entry(self):
        self.write('scripts/check_guardrails.py', REFEREE_CHECKER.replace('return []', 'return ["x.py:1: [stub] finding"]'))
        self.git('commit', '-qam', 'referee that finds something')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        result = self.run_entry()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('FAIL guardrails-referee', result.stdout)


if __name__ == '__main__':
    unittest.main()
