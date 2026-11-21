"""Counterexamples for runner environment, fixture isolation, and failure accounting."""

import hashlib
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'scripts/run_all_tests.sh'


def source_shell(script, env=None, cwd=ROOT):
    command = f'source {shlex.quote(str(RUNNER))}\n{script}'
    return subprocess.run(['bash', '-c', command], cwd=cwd, env=env,
                          text=True, capture_output=True)


def executable(path, content):
    path.write_text(content, encoding='utf-8')
    path.chmod(0o755)
    return path


def checksum_tree(path):
    return {
        file.relative_to(path).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
        for file in sorted(path.rglob('*')) if file.is_file() and not file.is_symlink()
    }


class RunnerHarness(unittest.TestCase):
    def test_fixture_modes_and_conflicting_options(self):
        fixture = source_shell('parse_options --fixture || exit $?; printf "%s\\n" "$FIXTURE_MODE"')
        self.assertEqual(fixture.returncode, 0, fixture.stderr)
        self.assertEqual(fixture.stdout.strip(), 'fixture')

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            no_fixture = source_shell(
                'parse_options --no-fixture || exit $?; '
                f'prepare_selected_fixture {shlex.quote(str(root))} "" "" || exit $?; '
                f'[[ ! -e {shlex.quote(str(root / "data"))} && ! -e {shlex.quote(str(root / "public"))} ]] || exit 40; '
                'printf "%s\\n" "$FIXTURE_MODE" "$(public_skip_reason)"'
            )
            self.assertEqual(no_fixture.returncode, 0, no_fixture.stdout + no_fixture.stderr)
            self.assertIn('none', no_fixture.stdout)
            self.assertIn('--no-fixture', no_fixture.stdout)

        conflict = source_shell('parse_options --fixture --no-fixture')
        self.assertEqual(conflict.returncode, 2)
        self.assertIn('cannot be combined', conflict.stderr)

    def test_print_env_uses_fake_node_path_and_probes_node_playwright_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / 'bin'
            node_path = root / 'node-modules'
            bin_dir.mkdir()
            node_path.mkdir()
            calls = root / 'node-calls.txt'
            fake_chrome = executable(root / 'fake-chrome', '#!/bin/sh\nexit 0\n')
            executable(bin_dir / 'python3', '''#!/bin/sh
case "$*" in
  *find_spec*) [ "${FAKE_PYTHON_PLAYWRIGHT:-0}" = 1 ] && exit 0; exit 1 ;;
  *sync_playwright*) printf '%s\\n' "$FAKE_PYTHON_CHROME"; exit 0 ;;
esac
exit 1
''')
            executable(bin_dir / 'node', '''#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NODE_CALLS"
case "$*" in
  *require.resolve*) [ -f "$NODE_PATH/playwright.marker" ] && exit 0; exit 1 ;;
  *executablePath*) printf '%s\\n' "$FAKE_NODE_CHROME"; exit 0 ;;
esac
exit 0
''')
            env = os.environ.copy()
            env.update({
                'PATH': f'{bin_dir}:/usr/bin:/bin',
                'NODE_PATH': str(node_path),
                'FAKE_NODE_CALLS': str(calls),
                'FAKE_PYTHON_PLAYWRIGHT': '0',
                'FAKE_PYTHON_CHROME': str(fake_chrome),
                'FAKE_NODE_CHROME': str(fake_chrome),
                'CHROMIUM_PATH': str(root / 'invalid-explicit-browser'),
            })
            missing = subprocess.run(['bash', str(RUNNER), '--print-env'], cwd=ROOT, env=env,
                                     text=True, capture_output=True)
            self.assertEqual(missing.returncode, 0, missing.stderr)
            self.assertIn('Python Playwright: missing (Python playwright package not installed)', missing.stdout)
            self.assertIn('Node Playwright: missing (Node playwright package not installed', missing.stdout)
            self.assertEqual(sum('require.resolve' in line for line in calls.read_text().splitlines()), 1)

            (node_path / 'playwright.marker').write_text('fixture', encoding='utf-8')
            calls.write_text('', encoding='utf-8')
            present = subprocess.run(['bash', str(RUNNER), '--print-env'], cwd=ROOT, env=env,
                                     text=True, capture_output=True)
            self.assertEqual(present.returncode, 0, present.stderr)
            self.assertIn('Node Playwright: available', present.stdout)
            self.assertEqual(sum('require.resolve' in line for line in calls.read_text().splitlines()), 1)

    def test_chromium_order_and_invalid_explicit_path_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            explicit = executable(root / 'explicit-chrome', '#!/bin/sh\nexit 0\n')
            first = executable(root / 'first-system-chrome', '#!/bin/sh\nexit 0\n')
            second = executable(root / 'second-system-chrome', '#!/bin/sh\nexit 0\n')
            script = f'''CHROMIUM_CANDIDATES=({shlex.quote(str(first))} {shlex.quote(str(second))})
PYTHON_PLAYWRIGHT=0; NODE_PLAYWRIGHT=0
CHROMIUM_PATH={shlex.quote(str(explicit))}; detect_chromium_path || exit 1
printf 'explicit=%s\\n' "$CHROMIUM_PATH"
CHROMIUM_PATH={shlex.quote(str(root / 'missing'))}; detect_chromium_path || exit 1
printf 'fallback=%s\\n' "$CHROMIUM_PATH"
'''
            result = source_shell(script)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f'explicit={explicit}', result.stdout)
            self.assertIn(f'fallback={first}', result.stdout)
            self.assertNotIn(f'fallback={second}', result.stdout)

    def test_project_node_modules_are_available_to_isolated_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            bin_dir = root / 'bin'
            global_modules = root / 'global-modules'
            project_modules = repo / 'node_modules'
            repo.mkdir()
            bin_dir.mkdir()
            global_modules.mkdir()
            project_modules.mkdir()
            calls = root / 'node-calls.txt'
            fake_chrome = executable(root / 'fake-chrome', '#!/bin/sh\nexit 0\n')
            executable(bin_dir / 'python3', '#!/bin/sh\nexit 1\n')
            executable(bin_dir / 'node', '''#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NODE_CALLS"
case "$*" in
  *require.resolve*) case ":$NODE_PATH:" in *":$FAKE_PROJECT_NODE_MODULES:"*) exit 0 ;; *) exit 1 ;; esac ;;
  *executablePath*) printf '%s\\n' "$FAKE_NODE_CHROME"; exit 0 ;;
esac
exit 0
''')
            env = os.environ.copy()
            env.update({
                'PATH': f'{bin_dir}:/usr/bin:/bin',
                'NODE_PATH': str(global_modules),
                'FAKE_PROJECT_NODE_MODULES': str(project_modules),
                'FAKE_NODE_CALLS': str(calls),
                'FAKE_NODE_CHROME': str(fake_chrome),
                'CHROMIUM_PATH': str(root / 'invalid-chrome'),
            })
            result = source_shell(
                'initialize_environment; print_environment; '
                'case ":$NODE_PATH:" in *":$FAKE_PROJECT_NODE_MODULES:"*) exit 0 ;; *) exit 5 ;; esac',
                env=env, cwd=repo,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('Node Playwright: available', result.stdout)
            self.assertEqual(sum('require.resolve' in line for line in calls.read_text().splitlines()), 1)

    def test_browser_wrappers_skip_before_launch_for_missing_dependencies_and_public(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / 'public'
            (public / 'assets').mkdir(parents=True)
            (public / 'index.html').write_text('fixture', encoding='utf-8')
            marker = root / 'launched'
            chrome = executable(root / 'chrome', '#!/bin/sh\nexit 0\n')

            missing_chrome = source_shell(f'''RUN_ROOT={shlex.quote(str(root))}
BROWSER_ENABLED=1; FIXTURE_MODE=none; PYTHON_PLAYWRIGHT=1; NODE_PLAYWRIGHT=1
CHROMIUM_PATH=; initialize_results; LOG_DIR={shlex.quote(str(root / 'logs'))}
run_python_browser missing-chrome yes bash -c 'printf launched > {shlex.quote(str(marker))}'
[[ ! -e {shlex.quote(str(marker))} ]] || exit 10
[[ "${{#SKIPPED[@]}}" = 1 && "${{SKIPPED[0]}}" == *'Chrome/Chromium executable not found'* ]]
''')
            self.assertEqual(missing_chrome.returncode, 0, missing_chrome.stdout + missing_chrome.stderr)
            self.assertFalse(marker.exists())

            missing_node = source_shell(f'''RUN_ROOT={shlex.quote(str(root))}
BROWSER_ENABLED=1; FIXTURE_MODE=none; PYTHON_PLAYWRIGHT=1; NODE_PLAYWRIGHT=0
CHROMIUM_PATH={shlex.quote(str(chrome))}; initialize_results; LOG_DIR={shlex.quote(str(root / 'logs'))}
run_node_browser missing-node-playwright yes bash -c 'printf launched > {shlex.quote(str(marker))}'
[[ ! -e {shlex.quote(str(marker))} ]] || exit 11
[[ "${{#SKIPPED[@]}}" = 1 && "${{SKIPPED[0]}}" == *'Node playwright package not installed'* ]]
''')
            self.assertEqual(missing_node.returncode, 0, missing_node.stdout + missing_node.stderr)
            self.assertFalse(marker.exists())

            missing_python = source_shell(f'''RUN_ROOT={shlex.quote(str(root))}
BROWSER_ENABLED=1; FIXTURE_MODE=none; PYTHON_PLAYWRIGHT=0; NODE_PLAYWRIGHT=1
CHROMIUM_PATH={shlex.quote(str(chrome))}; initialize_results; LOG_DIR={shlex.quote(str(root / 'logs'))}
run_python_browser missing-python-playwright yes bash -c 'printf launched > {shlex.quote(str(marker))}'
[[ ! -e {shlex.quote(str(marker))} ]] || exit 13
[[ "${{#SKIPPED[@]}}" = 1 && "${{SKIPPED[0]}}" == *'Python playwright package not installed'* ]]
''')
            self.assertEqual(missing_python.returncode, 0, missing_python.stdout + missing_python.stderr)
            self.assertFalse(marker.exists())

            no_public = root / 'no-public'
            no_public.mkdir()
            no_fixture = source_shell(f'''RUN_ROOT={shlex.quote(str(no_public))}
BROWSER_ENABLED=1; FIXTURE_MODE=none; PYTHON_PLAYWRIGHT=1; NODE_PLAYWRIGHT=1
CHROMIUM_PATH={shlex.quote(str(chrome))}; initialize_results; LOG_DIR={shlex.quote(str(root / 'logs'))}
run_python_browser missing-public yes bash -c 'printf launched > {shlex.quote(str(marker))}'
[[ ! -e {shlex.quote(str(marker))} ]] || exit 12
[[ "${{#SKIPPED[@]}}" = 1 && "${{SKIPPED[0]}}" == *'--no-fixture'* ]]
''')
            self.assertEqual(no_fixture.returncode, 0, no_fixture.stdout + no_fixture.stderr)
            self.assertFalse(marker.exists())

    def test_smoke_entry_runs_static_checks_without_public_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / 'logs'
            result = source_shell(f'''BROWSER_ENABLED=1; FIXTURE_MODE=none
PYTHON_PLAYWRIGHT=1; NODE_PLAYWRIGHT=1; CHROMIUM_PATH=/bin/true
RUN_ROOT={shlex.quote(str(root))}; LOG_DIR={shlex.quote(str(logs))}
initialize_results
run_smoke_static() {{ printf 'static smoke assertions ran\\n'; }}
run_smoke_entry
print_summary
''')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('PASS', result.stdout)
            self.assertIn('SKIP  (public/ not built (--no-fixture', result.stdout)
            self.assertIn('static smoke assertions ran', (logs / 'smoke-live-offline.log').read_text())
            self.assertEqual(sorted(path.name for path in logs.iterdir()), ['smoke-live-offline.log'])

    def test_nonbrowser_node_entry_still_runs_without_node_playwright(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            marker = root / 'node-ran'
            executable(bin_dir / 'node', '#!/bin/sh\nprintf ran > "$NODE_MARKER"\n')
            script = root / 'test_plain_node.cjs'
            script.write_text('', encoding='utf-8')
            env = os.environ.copy()
            env.update({'PATH': f'{bin_dir}:/usr/bin:/bin', 'NODE_MARKER': str(marker)})
            result = source_shell(f'''BROWSER_ENABLED=1; NODE_PLAYWRIGHT=0; CHROMIUM_PATH=
initialize_results; LOG_DIR={shlex.quote(str(root / 'logs'))}
run_node_test_entry {shlex.quote(str(script))}
[[ -f "$NODE_MARKER" && "${{#SKIPPED[@]}}" = 0 && "${{#PASSED[@]}}" = 1 ]]
''', env=env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(marker.exists())

    def test_launched_browser_command_failure_remains_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'public' / 'assets').mkdir(parents=True)
            (root / 'public' / 'index.html').write_text('fixture', encoding='utf-8')
            chrome = executable(root / 'chrome', '#!/bin/sh\nexit 0\n')
            result = source_shell(f'''RUN_ROOT={shlex.quote(str(root))}; FIXTURE_MODE=none
BROWSER_ENABLED=1; PYTHON_PLAYWRIGHT=1; NODE_PLAYWRIGHT=1
CHROMIUM_PATH={shlex.quote(str(chrome))}; initialize_results; LOG_DIR={shlex.quote(str(root / 'logs'))}
run_python_browser python-browser-that-launched yes bash -c 'exit 7'
[[ "$LAST_RUN_STATUS" = 7 && "${{#FAILED[@]}}" = 1 && "${{#SKIPPED[@]}}" = 0 ]] || exit 20
run_node_browser node-browser-that-launched yes bash -c 'exit 8'
[[ "$LAST_RUN_STATUS" = 8 && "${{#FAILED[@]}}" = 2 && "${{#SKIPPED[@]}}" = 0 ]] || exit 22
if print_summary; then exit 21; fi
''')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('python-browser-that-launched', result.stdout)
            self.assertIn('node-browser-that-launched', result.stdout)
            self.assertIn('FAIL', result.stdout)
            self.assertIn('0 passed, 2 failed, 0 skipped', result.stdout)

    def test_fixture_setup_failure_is_not_hidden(self):
        with tempfile.TemporaryDirectory() as directory:
            result = source_shell(f'''initialize_results; LOG_DIR={shlex.quote(directory)}
run offline-fixture bash -c 'exit 9'
[[ "$LAST_RUN_STATUS" = 9 && "${{#FAILED[@]}}" = 1 ]] || exit 30
if print_summary; then exit 31; fi
''')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('offline-fixture', result.stdout)
            self.assertIn('1 failed', result.stdout)

    def test_partial_existing_data_and_public_checksums_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            (source / 'data').mkdir(parents=True)
            (source / 'public').mkdir()
            (source / 'data' / 'partial.json').write_bytes(b'partial-data\n')
            (source / 'public' / 'index.html').write_bytes(b'existing-public\n')
            before_data = checksum_tree(source / 'data')
            before_public = checksum_tree(source / 'public')
            result = source_shell(
                f'prepare_auto_fixture {shlex.quote(str(source))} '
                f'{shlex.quote(str(root / "unused-workspace"))} {shlex.quote(str(root / "guard"))}'
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('using existing data as-is', result.stdout)
            self.assertEqual(before_data, checksum_tree(source / 'data'))
            self.assertEqual(before_public, checksum_tree(source / 'public'))
            self.assertFalse((root / 'unused-workspace').exists())

    def test_auto_fixture_builds_and_publishes_only_ignored_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'working-copy'
            workspace = root / 'fixture-workspace'
            guard = root / 'guard'
            real_docs = checksum_tree(ROOT / 'docs')
            real_runtime = {name: checksum_tree(ROOT / name) for name in ('data', 'public')}
            copied = source_shell(f'copy_source_tree {shlex.quote(str(ROOT))} {shlex.quote(str(source))}')
            self.assertEqual(copied.returncode, 0, copied.stdout + copied.stderr)
            self.assertFalse((source / 'data').exists())
            self.assertFalse((source / 'public').exists())
            initialized = subprocess.run(['git', '-C', str(source), 'init', '--quiet'],
                                         text=True, capture_output=True)
            self.assertEqual(initialized.returncode, 0, initialized.stdout + initialized.stderr)
            source_docs = checksum_tree(source / 'docs')

            built = source_shell(
                f'prepare_auto_fixture {shlex.quote(str(source))} '
                f'{shlex.quote(str(workspace))} {shlex.quote(str(guard))}; '
                '[[ "${AUTO_FIXTURE_RESULT:-}" = built ]]'
            )
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            self.assertIn('published only ignored generated data/ and missing public/', built.stdout)
            self.assertTrue((source / 'data' / 'library.json').is_file())
            self.assertTrue((source / 'public' / 'index.html').is_file())
            self.assertTrue((source / 'public' / 'assets').is_dir())
            self.assertEqual(source_docs, checksum_tree(source / 'docs'))
            self.assertEqual(real_docs, checksum_tree(ROOT / 'docs'))
            self.assertEqual(real_runtime, {name: checksum_tree(ROOT / name) for name in ('data', 'public')})
            for relative in ('data/library.json', 'public/index.html'):
                ignored = subprocess.run(['git', '-C', str(source), 'check-ignore', '-q', '--', relative])
                self.assertEqual(ignored.returncode, 0, f'{relative} must remain ignored')

    def test_auto_browser_main_uses_current_source_copy_for_existing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            copied = source_shell(f'copy_source_tree {shlex.quote(str(ROOT))} {shlex.quote(str(source))}')
            self.assertEqual(copied.returncode, 0, copied.stdout + copied.stderr)
            generated = subprocess.run(
                [sys.executable, str(source / 'scripts/fixtures/build_browser_data.py'), str(source / 'data')],
                cwd=source, text=True, capture_output=True
            )
            self.assertEqual(generated.returncode, 0, generated.stdout + generated.stderr)

            marker = source / 'data' / '_runner_harness_input_marker.txt'
            marker.write_text('retain this existing input\n', encoding='utf-8')
            public = source / 'public'
            (public / 'assets').mkdir(parents=True)
            (public / 'index.html').write_text('STALE_MAIN_PUBLIC\n', encoding='utf-8')
            (public / 'assets' / 'stale.js').write_text('stale\n', encoding='utf-8')
            before = {name: checksum_tree(source / name) for name in ('data', 'public', 'docs')}
            capture = root / 'suite-root.txt'
            env = os.environ.copy()
            env.update({'HARNESS_ROOT': str(source), 'HARNESS_CAPTURE': str(capture),
                        'XINZHI_TEST_LOG_DIR': str(root / 'test-logs')})
            result = source_shell('''
runner_root() { printf '%s\\n' "$HARNESS_ROOT"; }
initialize_environment() { :; }
print_environment() { :; }
run_suite() {
  local suite_root="$1" app_ref
  [[ "$suite_root" != "$HARNESS_ROOT" ]] || exit 41
  [[ -f "$suite_root/data/_runner_harness_input_marker.txt" ]] || exit 42
  [[ -f "$suite_root/public/index.html" ]] || exit 43
  ! grep -q STALE_MAIN_PUBLIC "$suite_root/public/index.html" || exit 44
  app_ref="$(grep -oE 'assets/app\\.[a-f0-9]+\\.js' "$suite_root/public/index.html" | head -n 1)"
  [[ -n "$app_ref" && -f "$suite_root/public/$app_ref" ]] || exit 45
  printf '%s\\n%s\\n' "$suite_root" "$app_ref" > "$HARNESS_CAPTURE"
}
main
''', env=env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            selected_root, app_ref = capture.read_text(encoding='utf-8').splitlines()
            self.assertNotEqual(Path(selected_root), source)
            self.assertRegex(app_ref, r'^assets/app\.[a-f0-9]+\.js$')
            self.assertEqual(before, {name: checksum_tree(source / name) for name in ('data', 'public', 'docs')})

    def test_auto_browser_setup_failure_never_runs_suite_on_old_public(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            copied = source_shell(f'copy_source_tree {shlex.quote(str(ROOT))} {shlex.quote(str(source))}')
            self.assertEqual(copied.returncode, 0, copied.stdout + copied.stderr)
            (source / 'data').mkdir()
            (source / 'data' / 'library.json').write_text('{invalid json\n', encoding='utf-8')
            (source / 'public' / 'assets').mkdir(parents=True)
            (source / 'public' / 'index.html').write_text('STALE_MAIN_PUBLIC\n', encoding='utf-8')
            before = {name: checksum_tree(source / name) for name in ('data', 'public', 'docs')}
            capture = root / 'suite-ran.txt'
            env = os.environ.copy()
            env.update({'HARNESS_ROOT': str(source), 'HARNESS_CAPTURE': str(capture),
                        'XINZHI_TEST_LOG_DIR': str(root / 'test-logs')})
            result = source_shell('''
runner_root() { printf '%s\\n' "$HARNESS_ROOT"; }
initialize_environment() { :; }
print_environment() { :; }
run_suite() { printf '%s\\n' "$1" > "$HARNESS_CAPTURE"; }
main
''', env=env)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn('offline-fixture', result.stdout)
            self.assertIn('test suite not launched: isolated auto fixture preparation failed', result.stderr)
            self.assertFalse(capture.exists())
            self.assertIn('FileNotFoundError', (root / 'test-logs' / 'offline-fixture.log').read_text())
            self.assertEqual(before, {name: checksum_tree(source / name) for name in ('data', 'public', 'docs')})

    def test_existing_data_copy_rejects_symlinks_and_non_regular_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / 'data'
            data.mkdir()
            marker = data / 'regular.txt'
            marker.write_text('regular\n', encoding='utf-8')
            symlink = data / 'linked.txt'
            symlink.symlink_to(marker)
            symlink_result = source_shell(
                f'copy_existing_data {shlex.quote(str(data))} {shlex.quote(str(root / "symlink-copy"))}'
            )
            self.assertNotEqual(symlink_result.returncode, 0)
            self.assertIn('contains a symlink', symlink_result.stderr)
            self.assertFalse((root / 'symlink-copy').exists())
            symlink.unlink()

            fifo = data / 'pipe'
            os.mkfifo(fifo)
            fifo_result = source_shell(
                f'copy_existing_data {shlex.quote(str(data))} {shlex.quote(str(root / "fifo-copy"))}'
            )
            self.assertNotEqual(fifo_result.returncode, 0)
            self.assertIn('contains a non-regular file', fifo_result.stderr)
            self.assertFalse((root / 'fifo-copy').exists())

    def test_existing_data_copy_preserves_empty_directories_and_rejects_root_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            empty_data = root / 'empty-data'
            (empty_data / 'nested' / 'still-empty').mkdir(parents=True)
            destination = root / 'empty-copy'
            copied = source_shell(
                f'copy_existing_data {shlex.quote(str(empty_data))} {shlex.quote(str(destination))}'
            )
            self.assertEqual(copied.returncode, 0, copied.stdout + copied.stderr)
            self.assertTrue(destination.is_dir())
            self.assertTrue((destination / 'nested' / 'still-empty').is_dir())
            self.assertEqual({path.relative_to(destination).as_posix() for path in destination.rglob('*')},
                             {'nested', 'nested/still-empty'})

            external_data = root / 'external-data'
            external_data.mkdir()
            (external_data / 'marker.txt').write_text('external\n', encoding='utf-8')
            data_symlink = root / 'data-symlink'
            data_symlink.symlink_to(external_data, target_is_directory=True)
            rejected_destination = root / 'rejected-copy'
            rejected = source_shell(
                f'copy_existing_data {shlex.quote(str(data_symlink))} '
                f'{shlex.quote(str(rejected_destination))}'
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('must be a real directory', rejected.stderr)
            self.assertFalse(rejected_destination.exists())

    def test_auto_fixture_does_not_replace_preexisting_public_when_data_is_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            copied = source_shell(f'copy_source_tree {shlex.quote(str(ROOT))} {shlex.quote(str(source))}')
            self.assertEqual(copied.returncode, 0, copied.stdout + copied.stderr)
            initialized = subprocess.run(['git', '-C', str(source), 'init', '--quiet'],
                                         text=True, capture_output=True)
            self.assertEqual(initialized.returncode, 0, initialized.stdout + initialized.stderr)
            public = source / 'public'
            public.mkdir()
            (public / 'index.html').write_text('preexisting public\n', encoding='utf-8')
            before_public = checksum_tree(public)
            before_docs = checksum_tree(source / 'docs')
            capture = root / 'suite-root.txt'
            env = os.environ.copy()
            env.update({'HARNESS_ROOT': str(source), 'HARNESS_CAPTURE': str(capture),
                        'XINZHI_TEST_LOG_DIR': str(root / 'test-logs')})
            result = source_shell('''
runner_root() { printf '%s\\n' "$HARNESS_ROOT"; }
initialize_environment() { :; }
print_environment() { :; }
run_suite() {
  local suite_root="$1" app_ref
  [[ "$suite_root" != "$HARNESS_ROOT" ]] || exit 51
  [[ -f "$suite_root/data/library.json" && -f "$suite_root/public/index.html" ]] || exit 52
  [[ "$(<"$HARNESS_ROOT/public/index.html")" = 'preexisting public' ]] || exit 53
  app_ref="$(grep -oE 'assets/app\\.[a-f0-9]+\\.js' "$suite_root/public/index.html" | head -n 1)"
  [[ -n "$app_ref" && -f "$suite_root/public/$app_ref" ]] || exit 54
  printf '%s\\n%s\\n' "$suite_root" "$app_ref" > "$HARNESS_CAPTURE"
}
main
''', env=env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            selected_root, app_ref = capture.read_text(encoding='utf-8').splitlines()
            self.assertNotEqual(Path(selected_root), source)
            self.assertRegex(app_ref, r'^assets/app\.[a-f0-9]+\.js$')
            self.assertTrue((source / 'data' / 'library.json').is_file())
            self.assertEqual(before_public, checksum_tree(public))
            self.assertEqual(before_docs, checksum_tree(source / 'docs'))

    def test_auto_no_browser_keeps_existing_data_and_public_as_is(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.mkdir()
            (source / 'data').mkdir()
            (source / 'data' / 'marker.txt').write_text('data marker\n', encoding='utf-8')
            (source / 'public' / 'assets').mkdir(parents=True)
            (source / 'public' / 'index.html').write_text('existing public\n', encoding='utf-8')
            before = {name: checksum_tree(source / name) for name in ('data', 'public')}
            capture = root / 'suite-root.txt'
            env = os.environ.copy()
            env.update({'HARNESS_ROOT': str(source), 'HARNESS_CAPTURE': str(capture),
                        'XINZHI_TEST_LOG_DIR': str(root / 'test-logs')})
            result = source_shell('''
runner_root() { printf '%s\\n' "$HARNESS_ROOT"; }
initialize_environment() { :; }
print_environment() { :; }
run_suite() { printf '%s\\n' "$1" > "$HARNESS_CAPTURE"; }
main --no-browser
''', env=env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(capture.read_text(encoding='utf-8').strip(), str(source))
            self.assertEqual(before, {name: checksum_tree(source / name) for name in ('data', 'public')})

    def test_fixture_copy_builds_in_isolation_without_changing_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            copied = source_shell(f'copy_source_tree {shlex.quote(str(ROOT))} {shlex.quote(str(source))}')
            self.assertEqual(copied.returncode, 0, copied.stdout + copied.stderr)
            (source / 'data').mkdir()
            (source / 'public').mkdir()
            (source / '.local').mkdir()
            (source / 'secrets').mkdir()
            (source / 'data' / 'maintainer.json').write_bytes(b'existing-data-marker\n')
            (source / 'public' / 'index.html').write_bytes(b'existing-public-marker\n')
            (source / '.local' / 'run.log').write_bytes(b'existing-local-marker\n')
            (source / 'secrets' / 'private.txt').write_bytes(b'existing-secret-marker\n')
            (source / '.env').write_bytes(b'fixture-only-placeholder\n')
            (source / 'linked-maintainer-data').symlink_to(source / 'data' / 'maintainer.json')
            before = {name: checksum_tree(source / name) for name in ('data', 'public', '.local', 'secrets')}
            before_env = hashlib.sha256((source / '.env').read_bytes()).hexdigest()
            before_source = checksum_tree(source)
            workspace = root / 'isolated'
            built = source_shell(
                f'prepare_fixture_workspace {shlex.quote(str(source))} '
                f'{shlex.quote(str(workspace))} {shlex.quote(str(root / "network-guard"))}'
            )
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            self.assertEqual(before, {name: checksum_tree(source / name) for name in ('data', 'public', '.local', 'secrets')})
            self.assertEqual(before_env, hashlib.sha256((source / '.env').read_bytes()).hexdigest())
            self.assertEqual(before_source, checksum_tree(source))
            self.assertTrue((workspace / 'data' / 'library.json').is_file())
            self.assertTrue((workspace / 'public' / 'index.html').is_file())
            self.assertNotIn('existing-data-marker', (workspace / 'data' / 'library.json').read_text())
            self.assertFalse((workspace / '.local').exists())
            self.assertFalse((workspace / 'secrets').exists())
            self.assertFalse((workspace / '.env').exists())
            self.assertFalse((workspace / '.git').exists())
            self.assertFalse((workspace / 'linked-maintainer-data').exists())


if __name__ == '__main__':
    unittest.main()
