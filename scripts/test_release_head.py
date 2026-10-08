"""Exercise old-run publication guards against real local Git repositories."""
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import check_release_head


class ReleaseHeadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / 'remote.git'
        self.repo = self.root / 'repo'
        self.git(self.root, 'init', '--bare', str(self.remote))
        self.git(self.root, 'init', '-b', 'main', str(self.repo))
        self.git(self.repo, 'config', 'user.name', 'Test')
        self.git(self.repo, 'config', 'user.email', 'test@example.test')
        (self.repo / 'app.js').write_text('version one')
        self.git(self.repo, 'add', 'app.js')
        self.git(self.repo, 'commit', '-m', 'initial')
        self.original = self.git(self.repo, 'rev-parse', 'HEAD')
        self.git(self.repo, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.repo, 'push', 'origin', 'main')

    def git(self, cwd, *args):
        return subprocess.run(['git', *args], cwd=cwd, check=True,
                              capture_output=True, text=True).stdout.strip()

    def test_current_main_passes(self):
        self.assertEqual(check_release_head.check(self.repo, self.original), self.original)

    def test_old_rerun_cannot_pass_after_remote_main_advances(self):
        self.assertEqual(check_release_head.check(self.repo, self.original), self.original)
        (self.repo / 'app.js').write_text('version two')
        self.git(self.repo, 'commit', '-am', 'newer')
        self.git(self.repo, 'push', 'origin', 'main')
        self.git(self.repo, 'checkout', '--detach', self.original)
        # The local tracking branch can itself be stale; the guard reads the remote.
        self.git(self.repo, 'update-ref', 'refs/remotes/origin/main', self.original)
        with self.assertRaisesRegex(ValueError, '^release_superseded$'):
            check_release_head.check(self.repo, self.original)

    def test_checkout_mismatch_and_invalid_expected_sha_fail_closed(self):
        for value, code in [('0' * 40, 'release_checkout_mismatch'), ('', 'release_sha_invalid')]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, '^' + code + '$'):
                check_release_head.check(self.repo, value)

    def test_unavailable_remote_never_uses_cached_head(self):
        self.git(self.repo, 'remote', 'set-url', 'origin', str(self.root / 'missing.git'))
        with self.assertRaisesRegex(ValueError, '^release_head_unavailable$'):
            check_release_head.check(self.repo, self.original)

    def test_timeout_is_a_fixed_error(self):
        with patch.object(check_release_head.subprocess, 'run', side_effect=subprocess.TimeoutExpired('sensitive remote', 20)):
            with self.assertRaisesRegex(ValueError, '^release_head_unavailable$'):
                check_release_head.check(self.repo, self.original)


if __name__ == '__main__':
    unittest.main()
