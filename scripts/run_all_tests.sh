#!/usr/bin/env bash
# Run the offline test suite; local setup and fixture options are documented in
# docs/testing-local.md.
#
#   scripts/run_all_tests.sh                      # auto fixture when data/ is absent
#   scripts/run_all_tests.sh --fixture             # fresh isolated source copy
#   scripts/run_all_tests.sh --no-fixture          # use existing files as-is
#   scripts/run_all_tests.sh --no-browser          # skip browser-driven entries
#   scripts/run_all_tests.sh --print-env           # report detected browser tooling
#
# Missing optional browser tools are SKIPped before launching browser commands.
# A command that starts and fails is always counted as FAIL.

CHROMIUM_CANDIDATES=(/usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome)
NODE_BROWSER="test_boot_url_ui test_citation_export_ui test_deep_reader_history_ui test_doi_direct_download test_doi_library_ui test_doi_radar_archive_ui test_download_inline_ui test_filter_panel_toggle_ui test_fulltext_resilience_ui test_doi_miss_form_persist_ui test_grok_fulltext test_mode_toolrow_ui test_popstate_restore_ui test_range_bar_ui test_topics_requests_ui test_ux_ce5de25_ui test_mobile_chipbar"
PYTHON_BROWSER_MODULES="test_back_to_top_ui test_brief_feedback_ui test_curated_doi_layout_ui test_deferred_reader_ui test_faceted_filters_ui test_journal_ui test_layout_ui test_mobile_library_ui test_navigation_search_ui test_reader_drawer_scroll test_reader_overlays_ui test_search_shortlist_ui test_search_toggle_ui test_sidebar_focus_trap_ui test_sol_gap_reader test_weekly_ui test_list_actions_ui test_shortlist_share_ui test_reading_shards_ui test_reading_mode_ui test_mwg_local_ui test_request_loop_ui test_weekly_layout_ui test_list_readability_ui test_long_titles_ui test_topic_multitag_ui test_radar_filter_followup_ui test_search_zh_expansion_ui test_smoke_live"

runner_root() {
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd
}

usage() {
  cat <<'EOF'
Usage: bash scripts/run_all_tests.sh [--fixture | --no-fixture] [--no-browser]
       bash scripts/run_all_tests.sh --print-env

  --fixture      build and run in a fresh source copy; leave current files untouched
  --no-fixture   never generate fixture files; use existing data/ and public/ as-is
  --no-browser   skip browser-driven tests (non-browser tests still run)
  --print-env    print Python/Node Playwright and Chrome/Chromium detection, then exit
EOF
}

parse_options() {
  BROWSER_ENABLED=1
  FIXTURE_MODE=auto
  FIXTURE_MODE_SET=0
  PRINT_ENV=0
  SHOW_HELP=0
  while (($#)); do
    case "$1" in
      --no-browser) BROWSER_ENABLED=0 ;;
      --fixture)
        if [[ "$FIXTURE_MODE_SET" = 1 ]]; then
          echo '--fixture and --no-fixture cannot be combined' >&2
          return 2
        fi
        FIXTURE_MODE=fixture; FIXTURE_MODE_SET=1
        ;;
      --no-fixture)
        if [[ "$FIXTURE_MODE_SET" = 1 ]]; then
          echo '--fixture and --no-fixture cannot be combined' >&2
          return 2
        fi
        FIXTURE_MODE=none; FIXTURE_MODE_SET=1
        ;;
      --print-env) PRINT_ENV=1 ;;
      -h|--help) SHOW_HELP=1 ;;
      *) echo "unknown option: $1" >&2; return 2 ;;
    esac
    shift
  done
  if [[ "$PRINT_ENV" = 1 && ( "$FIXTURE_MODE_SET" = 1 || "$BROWSER_ENABLED" = 0 || "$SHOW_HELP" = 1 ) ]]; then
    echo '--print-env must be used by itself' >&2
    return 2
  fi
}

resolve_executable() {
  local candidate="$1"
  if [[ "$candidate" == */* ]]; then
    [[ -f "$candidate" && -x "$candidate" ]] || return 1
    printf '%s\n' "$candidate"
  else
    command -v -- "$candidate" 2>/dev/null || return 1
  fi
}

python_playwright_browser() {
  "$PYTHON_BIN" -c 'from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    print(p.chromium.executable_path)' 2>/dev/null
}

node_playwright_browser() {
  "$NODE_BIN" -e "process.stdout.write(require('playwright').chromium.executablePath())" 2>/dev/null
}

detect_chromium_path() {
  local explicit="${CHROMIUM_PATH:-}" candidate
  local tried=""
  CHROME_DETECTION_REASON=""
  if [[ -n "$explicit" ]]; then
    candidate="$(resolve_executable "$explicit" || true)"
    if [[ -n "$candidate" ]]; then
      CHROMIUM_PATH="$candidate"; export CHROMIUM_PATH
      CHROME_DETECTION_REASON="selected CHROMIUM_PATH"
      return 0
    fi
    tried="CHROMIUM_PATH '$explicit' is not executable; "
  fi
  for candidate in "${CHROMIUM_CANDIDATES[@]}"; do
    tried+="tried $candidate; "
    if [[ -f "$candidate" && -x "$candidate" ]]; then
      CHROMIUM_PATH="$candidate"; export CHROMIUM_PATH
      CHROME_DETECTION_REASON="${tried}selected system browser $candidate"
      return 0
    fi
  done
  if [[ "$PYTHON_PLAYWRIGHT" = 1 ]]; then
    candidate="$(python_playwright_browser || true)"
    if [[ -n "$candidate" && -f "$candidate" && -x "$candidate" ]]; then
      CHROMIUM_PATH="$candidate"; export CHROMIUM_PATH
      CHROME_DETECTION_REASON="${tried}selected Python Playwright bundled browser"
      return 0
    fi
    tried+='Python Playwright bundled browser executable is unavailable; '
  fi
  if [[ "$NODE_PLAYWRIGHT" = 1 ]]; then
    candidate="$(node_playwright_browser || true)"
    if [[ -n "$candidate" && -f "$candidate" && -x "$candidate" ]]; then
      CHROMIUM_PATH="$candidate"; export CHROMIUM_PATH
      CHROME_DETECTION_REASON="${tried}selected Node Playwright bundled browser"
      return 0
    fi
    tried+='Node Playwright bundled browser executable is unavailable; '
  fi
  CHROMIUM_PATH=""; export CHROMIUM_PATH
  CHROME_DETECTION_REASON="Chrome/Chromium executable not found; ${tried}install Chromium or set CHROMIUM_PATH"
  return 1
}

initialize_environment() {
  local project_node_path="$PWD/node_modules"
  export LANG="${LANG:-C.UTF-8}"
  PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [[ -z "${NODE_PATH:-}" ]] && command -v npm >/dev/null 2>&1; then
    NODE_PATH="$(npm root -g 2>/dev/null || true)"
  fi
  if [[ -d "$project_node_path" ]]; then
    case ":${NODE_PATH:-}:" in
      *":$project_node_path:"*) ;;
      *) NODE_PATH="${NODE_PATH:+$NODE_PATH:}$project_node_path" ;;
    esac
  fi
  export NODE_PATH="${NODE_PATH:-}"

  PYTHON_PLAYWRIGHT=0
  if [[ -n "$PYTHON_BIN" ]] && "$PYTHON_BIN" -c 'import importlib.util; raise SystemExit(importlib.util.find_spec("playwright") is None)' >/dev/null 2>&1; then
    PYTHON_PLAYWRIGHT=1
    PYTHON_PLAYWRIGHT_REASON="Python playwright package is importable"
  elif [[ -z "$PYTHON_BIN" ]]; then
    PYTHON_PLAYWRIGHT_REASON="python3 executable not found"
  else
    PYTHON_PLAYWRIGHT_REASON="Python playwright package not installed"
  fi

  NODE_PLAYWRIGHT=0
  if [[ -n "$NODE_BIN" ]] && "$NODE_BIN" -e "require.resolve('playwright')" >/dev/null 2>&1; then
    NODE_PLAYWRIGHT=1
    NODE_PLAYWRIGHT_REASON="Node playwright package is resolvable"
  elif [[ -z "$NODE_BIN" ]]; then
    NODE_PLAYWRIGHT_REASON="node executable not found"
  else
    NODE_PLAYWRIGHT_REASON="Node playwright package not installed (NODE_PATH=${NODE_PATH:-empty})"
  fi
  detect_chromium_path || true
}

print_environment() {
  printf '%s\n' '== Browser environment'
  printf 'Python 3: %s\n' "${PYTHON_BIN:-not found}"
  printf 'Python Playwright: %s (%s)\n' "$([[ "$PYTHON_PLAYWRIGHT" = 1 ]] && echo available || echo missing)" "$PYTHON_PLAYWRIGHT_REASON"
  printf 'Node: %s\n' "${NODE_BIN:-not found}"
  printf 'Node Playwright: %s (%s)\n' "$([[ "$NODE_PLAYWRIGHT" = 1 ]] && echo available || echo missing)" "$NODE_PLAYWRIGHT_REASON"
  printf 'Chrome/Chromium: %s (%s)\n' "${CHROMIUM_PATH:-missing}" "$CHROME_DETECTION_REASON"
}

initialize_results() {
  PASSED=(); FAILED=(); SKIPPED=()
  LAST_RUN_STATUS=0
}

run() {
  local name="$1"; shift
  local log="$LOG_DIR/${name//\//_}.log" status
  mkdir -p "$LOG_DIR"
  printf '%-48s ' "$name"
  if "$@" >"$log" 2>&1; then
    echo 'PASS'
    PASSED+=("$name")
    LAST_RUN_STATUS=0
  else
    status=$?
    echo "FAIL  (exit $status; log: $log)"
    FAILED+=("$name")
    LAST_RUN_STATUS="$status"
  fi
  return 0
}

skip() {
  printf '%-48s SKIP  (%s)\n' "$1" "$2"
  SKIPPED+=("$1: $2")
}

print_summary() {
  local item
  echo
  echo "== Summary: ${#PASSED[@]} passed, ${#FAILED[@]} failed, ${#SKIPPED[@]} skipped"
  for item in "${SKIPPED[@]}"; do echo "  SKIP $item"; done
  for item in "${FAILED[@]}"; do echo "  FAIL $item"; done
  [[ "${#FAILED[@]}" = 0 ]]
}

public_is_ready() {
  [[ -f "$RUN_ROOT/public/index.html" && -d "$RUN_ROOT/public/assets" ]]
}

public_skip_reason() {
  case "$FIXTURE_MODE" in
    none) printf '%s' 'public/ not built (--no-fixture; provide public/ or run with --fixture)' ;;
    fixture) printf '%s' 'public/ not built (isolated fixture setup failed)' ;;
    *) printf '%s' 'public/ not built; existing data/ is used as-is and no state is synthesized' ;;
  esac
}

browser_skip_reasons() {
  local kind="$1" needs_public="$2" reason=""
  if [[ "$BROWSER_ENABLED" = 0 ]]; then
    printf '%s' '--no-browser requested'
    return
  fi
  if [[ "$needs_public" = yes ]] && ! public_is_ready; then
    reason="$(public_skip_reason)"
  fi
  if [[ "$kind" = python && "$PYTHON_PLAYWRIGHT" != 1 ]]; then
    [[ -n "$reason" ]] && reason+='; '
    reason+='Python playwright package not installed'
  fi
  if [[ "$kind" = node && "$NODE_PLAYWRIGHT" != 1 ]]; then
    [[ -n "$reason" ]] && reason+='; '
    reason+='Node playwright package not installed'
  fi
  if [[ -z "$CHROMIUM_PATH" ]]; then
    [[ -n "$reason" ]] && reason+='; '
    reason+='Chrome/Chromium executable not found'
  fi
  printf '%s' "$reason"
}

run_python_browser() {
  local name="$1" needs_public="$2" reason
  shift 2
  reason="$(browser_skip_reasons python "$needs_public")"
  if [[ -n "$reason" ]]; then skip "$name" "$reason"; else run "$name" "$@"; fi
}

run_node_browser() {
  local name="$1" needs_public="$2" reason
  shift 2
  reason="$(browser_skip_reasons node "$needs_public")"
  if [[ -n "$reason" ]]; then skip "$name" "$reason"; else run "$name" "$@"; fi
}

copy_source_tree() {
  python3 - "$1" "$2" <<'PY'
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys

source, destination = map(Path, sys.argv[1:])
if destination.exists() or destination.is_symlink():
    raise SystemExit(f'destination already exists: {destination}')
destination.mkdir(parents=True)
excluded_roots = {'.git', '.local', 'data', 'public', 'node_modules'}
excluded_dirs = {'__pycache__', '.venv', 'venv', '.pytest_cache', 'secrets', '.secrets', 'private', 'credentials'}
secret_suffixes = {'.pem', '.key', '.p12', '.pfx', '.credentials', '.secret'}
sensitive_names = {'.env', '.npmrc', '.pypirc', '.netrc', 'credentials.json', 'credentials.yml',
                   'credentials.yaml', 'credentials.toml', 'secrets.json', 'secret.json', 'id_rsa', 'id_ed25519'}

def excluded(name):
    parts = PurePosixPath(name).parts
    base = parts[-1].lower() if parts else ''
    return (not parts or parts[0] in excluded_roots or
            any(part in excluded_dirs for part in parts) or
            base in sensitive_names or base.startswith('.env.') or
            Path(base).suffix in secret_suffixes)

try:
    result = subprocess.run(['git', '-C', str(source), 'ls-files', '-z', '-c', '-o', '--exclude-standard'],
                            check=True, capture_output=True)
    names = result.stdout.decode().split('\0')
    names = [name for name in names if name]
except (OSError, subprocess.CalledProcessError):
    names = []
    for current, directories, files in os.walk(source, followlinks=False):
        relative = Path(current).relative_to(source)
        directories[:] = sorted(name for name in directories
                                if not excluded((relative / name).as_posix()) and
                                not (Path(current) / name).is_symlink())
        names.extend((relative / name).as_posix() for name in files)

copied = 0
for name in sorted(set(names)):
    if excluded(name):
        continue
    relative = PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts:
        continue
    source_file = source.joinpath(*relative.parts)
    if source_file.is_symlink() or not source_file.is_file():
        continue
    destination_file = destination.joinpath(*relative.parts)
    destination_file.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_file, destination_file, follow_symlinks=False)
    copied += 1
print(f'isolated source copy: copied {copied} regular files; excluded data/, public/, .local/, .git, secrets, and symlinks')
PY
}

write_offline_guards() {
  python3 - "$1" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
(root / 'sitecustomize.py').write_text('''import socket\n\ndef _offline_denied(*args, **kwargs):\n    raise OSError("network disabled during offline fixture generation/build")\n\nsocket.socket.connect = _offline_denied\nsocket.socket.connect_ex = _offline_denied\nsocket.create_connection = _offline_denied\nsocket.getaddrinfo = _offline_denied\n''', encoding='utf-8')
(root / 'offline-network-guard.cjs').write_text(''''use strict';\nconst deny = () => { throw new Error('network disabled during offline fixture build'); };\nconst net = require('node:net');\nnet.connect = deny; net.createConnection = deny;\nif (net.Socket) net.Socket.prototype.connect = deny;\nfor (const name of ['node:http', 'node:https']) { const mod = require(name); mod.request = deny; mod.get = deny; }\nif (globalThis.fetch) globalThis.fetch = deny;\n''', encoding='utf-8')
PY
}

build_offline_fixture() {
  local root="$1" guard_dir="$2" pythonpath node_options
  if [[ -e "$root/data" || -L "$root/data" || -e "$root/public" || -L "$root/public" ]]; then
    echo 'isolated fixture root unexpectedly contains data/ or public/' >&2
    return 1
  fi
  write_offline_guards "$guard_dir" || return 1
  pythonpath="$guard_dir:$root/scripts${PYTHONPATH:+:$PYTHONPATH}"
  node_options="${NODE_OPTIONS:+$NODE_OPTIONS }--require=$guard_dir/offline-network-guard.cjs"
  (
    cd "$root" || exit 1
    PYTHONPATH="$pythonpath" PYTHONDONTWRITEBYTECODE=1 NODE_OPTIONS="$node_options" \
      python3 scripts/fixtures/build_browser_data.py "$root/data" &&
    PYTHONPATH="$pythonpath" PYTHONDONTWRITEBYTECODE=1 NODE_OPTIONS="$node_options" \
      python3 scripts/build_public.py
  )
}

prepare_fixture_workspace() {
  local source="$1" destination="$2" guard_dir="$3"
  copy_source_tree "$source" "$destination" || return 1
  build_offline_fixture "$destination" "$guard_dir"
}

publish_auto_fixture_outputs() {
  local root="$1" fixture_root="$2"
  if [[ -e "$root/data" || -L "$root/data" ]]; then
    echo 'refusing to overwrite existing data/' >&2
    return 1
  fi
  if ! git -C "$root" check-ignore -q -- data/library.json; then
    echo 'refusing to publish fixture: data/ is not ignored' >&2
    return 1
  fi
  mkdir -- "$root/data" || return 1
  cp -a -- "$fixture_root/data/." "$root/data/" || return 1
  if [[ -e "$root/public" || -L "$root/public" ]]; then
    echo 'existing public/ left unchanged'
  else
    if ! git -C "$root" check-ignore -q -- public/index.html; then
      echo 'refusing to publish fixture: public/ is not ignored' >&2
      return 1
    fi
    mkdir -- "$root/public" || return 1
    cp -a -- "$fixture_root/public/." "$root/public/" || return 1
  fi
  echo 'published only ignored generated data/ and missing public/'
}

prepare_auto_fixture() {
  local root="$1" destination="$2" guard_dir="$3"
  if [[ -e "$root/data" || -L "$root/data" ]]; then
    AUTO_FIXTURE_RESULT=existing
    echo 'data/ exists; using existing data as-is; offline fixture not built'
    return 0
  fi
  prepare_fixture_workspace "$root" "$destination" "$guard_dir" || return 1
  publish_auto_fixture_outputs "$root" "$destination" || return 1
  AUTO_FIXTURE_RESULT=built
}

prepare_selected_fixture() {
  local root="$1" destination="$2" guard_dir="$3"
  case "$FIXTURE_MODE" in
    none)
      AUTO_FIXTURE_RESULT=disabled
      echo 'offline fixture disabled (--no-fixture); existing data/ and public/ are used as-is'
      ;;
    fixture)
      prepare_fixture_workspace "$root" "$destination" "$guard_dir" || return 1
      AUTO_FIXTURE_RESULT=isolated
      ;;
    auto)
      prepare_auto_fixture "$root" "$destination" "$guard_dir"
      ;;
  esac
}

run_python_unittest() {
  local skip_muse="$1"
  XINZHI_PYTHON_BROWSER_MODULES="$PYTHON_BROWSER_MODULES" XINZHI_SKIP_MUSE="$skip_muse" python3 - <<'PY'
import importlib.util
from pathlib import Path
import os
import sys
import unittest

sys.path.insert(0, str(Path('scripts').resolve()))
excluded = set(os.environ['XINZHI_PYTHON_BROWSER_MODULES'].split())
if os.environ.get('XINZHI_SKIP_MUSE') == '1':
    excluded.add('test_muse_pdf_verifier')
loader = unittest.TestLoader()
suite = unittest.TestSuite()
for path in sorted(Path('scripts').glob('test_*.py')):
    if path.stem not in excluded:
        suite.addTests(loader.loadTestsFromName(path.stem))
sys.exit(not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful())
PY
}

run_smoke_static() {
  PYTHONPATH="$RUN_ROOT/scripts${PYTHONPATH:+:$PYTHONPATH}" python3 -m unittest -v \
    test_smoke_live.SmokeTests.test_static_passing_fixtures \
    test_smoke_live.SmokeTests.test_static_broken_fixtures \
    test_smoke_live.SmokeTests.test_wait_and_stalled_radar \
    test_smoke_live.SmokeTests.test_static_probe_regressions \
    test_smoke_live.SmokeTests.test_text_artifact_classes \
    test_smoke_live.SmokeTests.test_http_refuses_write_disallowed_get_and_redirect \
    test_smoke_live.SmokeTests.test_browser_route_redirect_policy \
    test_smoke_live.SmokeTests.test_blocked_paths_are_bounded_deduplicated_and_queryless \
    test_smoke_live.SmokeTests.test_shared_budget_caps_requests_and_reuses_responses \
    test_smoke_live.SmokeTests.test_skip_text_is_explicit_and_exit_zero \
    test_smoke_live.SmokeTests.test_json_uses_exclusive_create_and_repo_local_paths
}

run_smoke_entry() {
  local reason
  reason="$(browser_skip_reasons python yes)"
  if [[ -n "$reason" ]]; then
    run 'smoke-live-offline' run_smoke_static
    skip 'smoke-live browser tests' "$reason"
  else
    run 'smoke-live-offline' python3 scripts/test_smoke_live.py
  fi
}

run_node_test_entry() {
  local file="$1" name
  name="$(basename "$file" .cjs)"
  if [[ "$name" = test_worker_fetch_compat ]] && ! command -v workerd >/dev/null 2>&1 && [[ ! -x node_modules/.bin/workerd ]]; then
    skip "$name" 'workerd executable not available'
    return 0
  fi
  case " $NODE_BROWSER " in
    *" $name "*) run_node_browser "$name" yes node "$file" ;;
    *) run "$name" node "$file" ;;
  esac
}

run_suite() {
  local root="$1" skip_muse=0 f
  RUN_ROOT="$root"
  if ! cd "$root"; then
    echo "cannot enter test root: $root" >&2
    FAILED+=(suite-root)
    return 1
  fi
  echo '== Python unit tests (excluding standalone browser scripts)'
  if python3 -c 'import fitz' >/dev/null 2>&1; then
    skip_muse=0
  else
    skip_muse=1
    skip 'test_muse_pdf_verifier.py' 'PyMuPDF (fitz) package not installed'
  fi
  run 'python-unittest' run_python_unittest "$skip_muse"
  run 'service-unittest' python3 -m unittest discover -s service/tests -t .

  run_smoke_entry
  run 'text-hygiene' python3 scripts/test_text_hygiene.py --check-built

  run 'feature-map-doc' node scripts/feature_map_md.cjs --check
  echo '== Node tests'
  for f in scripts/test_*.cjs; do
    run_node_test_entry "$f"
  done
  # test_shortlist_share.cjs runs via the Node discovery loop.

  echo '== First-screen budget'
  if public_is_ready; then
    run 'first-screen-budget' python3 scripts/check_first_screen_budget.py public
  else
    skip 'first-screen-budget' "$(public_skip_reason)"
  fi

  echo '== Feature map and reading-shard tests'
  run_node_browser 'feature-map-walk' yes node scripts/feature_map_walk.cjs --viewport all
  run_python_browser 'test_reading_shards_ui' yes python3 scripts/test_reading_shards_ui.py
  run_python_browser 'test_reading_mode_ui' yes python3 scripts/test_reading_mode_ui.py
  run_python_browser 'test_mwg_local_ui' yes python3 scripts/test_mwg_local_ui.py
  run_python_browser 'test_request_loop_ui' yes python3 scripts/test_request_loop_ui.py
  run_python_browser 'test_weekly_layout_ui' yes python3 scripts/test_weekly_layout_ui.py
  run_python_browser 'test_list_readability_ui' yes python3 scripts/test_list_readability_ui.py
  run_python_browser 'test_long_titles_ui' yes python3 scripts/test_long_titles_ui.py
  run_python_browser 'test_topic_multitag_ui' yes python3 scripts/test_topic_multitag_ui.py
  run_python_browser 'test_radar_filter_followup_ui' yes python3 scripts/test_radar_filter_followup_ui.py
  run_python_browser 'test_search_zh_expansion_ui' yes python3 scripts/test_search_zh_expansion_ui.py

  echo '== Browser tests (Python + Playwright)'
  for name in test_back_to_top_ui test_brief_feedback_ui test_curated_doi_layout_ui test_deferred_reader_ui test_faceted_filters_ui test_journal_ui \
              test_layout_ui test_mobile_library_ui test_navigation_search_ui test_reader_drawer_scroll test_reader_overlays_ui \
              test_search_shortlist_ui test_search_toggle_ui test_sidebar_focus_trap_ui test_sol_gap_reader test_weekly_ui test_list_actions_ui; do
    run_python_browser "$name" yes python3 "scripts/$name.py"
  done
  run_python_browser 'test_shortlist_share_ui' yes python3 scripts/test_shortlist_share_ui.py
}

cleanup_scratch() {
  if [[ -n "${SCRATCH_DIR:-}" && -d "$SCRATCH_DIR" ]]; then
    rm -rf -- "$SCRATCH_DIR"
  fi
}

main() {
  parse_options "$@" || { usage >&2; return 2; }
  if [[ "$SHOW_HELP" = 1 ]]; then usage; return 0; fi
  local root fixture_status
  root="$(runner_root)"
  cd "$root" || return 2
  initialize_environment
  print_environment
  if [[ "$PRINT_ENV" = 1 ]]; then return 0; fi

  if [[ -n "${XINZHI_TEST_LOG_DIR:-}" ]]; then
    LOG_DIR="$XINZHI_TEST_LOG_DIR"
  elif [[ "$FIXTURE_MODE" = fixture ]]; then
    LOG_DIR="$HOME/xinzhi-test-logs/fixture-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  else
    LOG_DIR="$root/.local/test-logs"
  fi
  mkdir -p "$LOG_DIR" || { echo "cannot create log directory: $LOG_DIR" >&2; return 2; }
  initialize_results
  RUN_ROOT="$root"

  case "$FIXTURE_MODE" in
    fixture)
      SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/xinzhi-test-fixture.XXXXXX")" || return 2
      trap cleanup_scratch EXIT
      run 'offline-fixture' prepare_selected_fixture "$root" "$SCRATCH_DIR/source" "$SCRATCH_DIR/guard"
      fixture_status="$LAST_RUN_STATUS"
      [[ "$fixture_status" = 0 ]] && echo 'offline fixture built in isolated copy (no state data; current data/public/.local unchanged)'
      if [[ -d "$SCRATCH_DIR/source" ]]; then
        run_suite "$SCRATCH_DIR/source"
      else
        skip 'test suite' 'isolated source copy could not be created'
      fi
      ;;
    none)
      prepare_selected_fixture "$root" '' '' || return 2
      run_suite "$root"
      ;;
    auto)
      if [[ -e "$root/data" || -L "$root/data" ]]; then
        prepare_selected_fixture "$root" '' '' || return 2
      else
        SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/xinzhi-test-fixture.XXXXXX")" || return 2
        trap cleanup_scratch EXIT
        run 'offline-fixture' prepare_selected_fixture "$root" "$SCRATCH_DIR/source" "$SCRATCH_DIR/guard"
        fixture_status="$LAST_RUN_STATUS"
        if [[ "$fixture_status" = 0 && "${AUTO_FIXTURE_RESULT:-}" = built ]]; then
          echo 'offline fixture built (no state data)'
        elif [[ "$fixture_status" != 0 ]]; then
          echo 'offline fixture setup failed; dependent browser checks will not be launched' >&2
        fi
      fi
      run_suite "$root"
      ;;
  esac
  print_summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -u
  main "$@"
  exit $?
fi
