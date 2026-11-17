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

    def run_entry(self, *args, entry=ENTRY, env_extra=None, referee_only=True):
        env = {k: v for k, v in os.environ.items() if not k.startswith('VERIFY_')}
        env.update(env_extra or {})
        flags = ['--referee-only'] if referee_only else []
        return subprocess.run(['bash', str(entry), *flags, '--no-fetch', *args],
                              cwd=self.root, env=env, capture_output=True, text=True, timeout=60)

    def run_canonical(self, *args):
        # The documented entry, verbatim: the entry itself comes from origin/main through a pipe.
        env = {k: v for k, v in os.environ.items() if not k.startswith('VERIFY_')}
        command = 'bash <(git show origin/main:scripts/verify.sh) --referee-only --no-fetch "$@"'
        return subprocess.run(['bash', '-c', command, 'verify', *args],
                              cwd=self.root, env=env, capture_output=True, text=True, timeout=60)

    def put_entry_on_referee(self, checker=REFEREE_CHECKER):
        self.git('checkout', '-q', 'origin/main')
        self.write('scripts/verify.sh', ENTRY.read_text())
        self.write('scripts/check_guardrails.py', checker)
        self.git('add', '.')
        self.git('commit', '-qm', 'entry on referee')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.git('checkout', '-qb', 'feature-' + str(len(self.git('log', '--oneline').splitlines())))

    def tamper_branch_entry(self, old, new):
        edited = ENTRY.read_text().replace(old, new, 1)
        self.assertNotEqual(edited, ENTRY.read_text())
        self.write('scripts/verify.sh', edited)
        self.git('commit', '-qam', 'edit entry on branch')

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
        # Before the referee carries an entry the banner must not claim to be the referee.
        self.assertIn('verify entry: branch copy, NOT the referee entry', result.stdout)

    def test_referee_entry_replaces_a_tail_edited_branch_entry(self):
        self.put_entry_on_referee()
        self.tamper_branch_entry('exit "$FAIL"\n', 'echo BRANCH-ENTRY\nexit 0\n')
        ref_sha = self.git('rev-parse', 'origin/main').strip()
        branch_file = str(self.root / 'scripts/verify.sh')
        runs = {
            'canonical': self.run_canonical(),
            'branch-file': self.run_entry(entry=self.root / 'scripts/verify.sh'),
            # The old VERIFY_FROM_REFEREE=<referee sha> shortcut no longer skips the content check.
            'from-referee-sha': self.run_entry(entry=self.root / 'scripts/verify.sh', env_extra={'VERIFY_FROM_REFEREE': ref_sha}),
        }
        for name, result in runs.items():
            with self.subTest(run=name):
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('verify entry: referee origin/main@' + ref_sha[:12], result.stdout)
                self.assertIn('working-tree scripts/verify.sh differs from the referee entry; ignored', result.stdout)
                self.assertNotIn('BRANCH-ENTRY', result.stdout)
                self.assertIn('checker=referee', result.stdout)
        # Claiming to be the re-executed referee copy does not make a branch file the referee.
        forged = self.run_entry(entry=self.root / 'scripts/verify.sh', env_extra={'VERIFY_ENTRY_CHILD': branch_file})
        self.assertEqual(forged.returncode, 2, forged.stdout + forged.stderr)
        self.assertNotIn('verify entry: referee', forged.stdout)
        self.assertNotIn('BRANCH-ENTRY', forged.stdout)
        self.assertTrue((self.root / 'scripts/verify.sh').is_file())

    def test_prefix_tamper_never_yields_a_referee_banner_or_a_pass(self):
        # A branch can edit lines that run before any self-check, so only the canonical entry counts.
        self.put_entry_on_referee(REFEREE_CHECKER.replace('return []', 'return ["x.py:1: [stub] finding"]'))
        self.tamper_branch_entry('set -u\n', 'set -u\necho BRANCH-ENTRY-TAMPERED; exit 0\n')
        canonical = self.run_canonical()
        self.assertEqual(canonical.returncode, 1, canonical.stdout + canonical.stderr)
        self.assertIn('verify entry: referee origin/main@', canonical.stdout)
        self.assertIn('FAIL guardrails-referee', canonical.stdout)
        self.assertIn('working-tree scripts/verify.sh differs from the referee entry; ignored', canonical.stdout)
        self.assertNotIn('BRANCH-ENTRY-TAMPERED', canonical.stdout)
        direct = self.run_entry(entry=self.root / 'scripts/verify.sh')
        self.assertIn('BRANCH-ENTRY-TAMPERED', direct.stdout)
        self.assertNotIn('verify entry: referee', direct.stdout)

    def test_no_fetch_prints_referee_sha_and_date(self):
        result = self.run_entry()
        sha = self.git('rev-parse', 'origin/main').strip()
        self.assertIn('WARNING --no-fetch: referee origin/main may be stale; using ' + sha[:12] + ' committed ', result.stdout)

    def test_edge_worker_sources_need_ui(self):
        self.git('checkout', '-qb', 'feature-edge')
        self.write('edge/src/10-sample.js', 'export const x = 1;\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'edge source')
        result = self.run_entry(referee_only=False)
        self.assertIn('NOT RUN browser-and-feature-map: UI files changed (edge/src/10-sample.js', result.stdout)

    def test_findings_fail_the_entry(self):
        self.write('scripts/check_guardrails.py', REFEREE_CHECKER.replace('return []', 'return ["x.py:1: [stub] finding"]'))
        self.git('commit', '-qam', 'referee that finds something')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        result = self.run_entry()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('FAIL guardrails-referee', result.stdout)


if __name__ == '__main__':
    unittest.main()
