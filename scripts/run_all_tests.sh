#!/usr/bin/env bash
# Run every test in the repository and print one pass/fail summary.
#
#   scripts/run_all_tests.sh            # unit + Node + browser tests
#   scripts/run_all_tests.sh --no-browser
#
# Browser tests need a built public/ (restore data from the state branch, then
# `python3 scripts/build_public.py`; see AGENTS.md) and Chromium. The Chromium
# binary is taken from $CHROMIUM_PATH, else /usr/bin/chromium. Node tests that
# drive a browser need the Playwright package; if it is installed globally the
# script sets NODE_PATH to `npm root -g` for them.
#
# Known environment-only failures (reported as SKIP when their dependency is
# missing): test_muse_pdf_verifier.py needs PyMuPDF (`fitz`);
# test_worker_fetch_compat.cjs needs a startable workerd.
set -u
cd "$(dirname "$0")/.."

BROWSER=1
for arg in "$@"; do
  case "$arg" in
    --no-browser) BROWSER=0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

export LANG="${LANG:-C.UTF-8}"
export CHROMIUM_PATH="${CHROMIUM_PATH:-/usr/bin/chromium}"
if [ -z "${NODE_PATH:-}" ] && command -v npm >/dev/null 2>&1; then
  NODE_PATH="$(npm root -g 2>/dev/null)"; export NODE_PATH
fi

LOG_DIR=".local/test-logs"
mkdir -p "$LOG_DIR"
PASSED=(); FAILED=(); SKIPPED=()

run() { # name, command...
  local name="$1"; shift
  local log="$LOG_DIR/${name//\//_}.log"
  printf '%-48s ' "$name"
  if "$@" >"$log" 2>&1; then
    echo "PASS"; PASSED+=("$name")
  else
    echo "FAIL  (log: $log)"; FAILED+=("$name")
  fi
}
skip() { printf '%-48s SKIP  (%s)\n' "$1" "$2"; SKIPPED+=("$1: $2"); }

echo "== Python unit tests (unittest discover)"
if python3 -c 'import fitz' >/dev/null 2>&1; then
  run "python-unittest" python3 -m unittest discover -s scripts -p 'test_*.py'
else
  skip "test_muse_pdf_verifier.py" "PyMuPDF (fitz) not installed"
  # Same discovery, minus the one module that cannot import here.
  run "python-unittest" python3 - <<'PY'
import sys, unittest
loader = unittest.TestLoader()
suite = unittest.TestSuite()
for test in loader.discover('scripts', pattern='test_*.py'):
    if 'test_muse_pdf_verifier' not in str(test):
        suite.addTest(test)
sys.exit(not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful())
PY
fi
run "service-unittest" python3 -m unittest discover -s service/tests -t .

# Browser-driven Node tests (need Playwright + Chromium).
NODE_BROWSER="test_boot_url_ui test_citation_export_ui test_doi_direct_download test_doi_library_ui test_grok_fulltext"
echo "== Node tests"
for f in scripts/test_*.cjs; do
  name="$(basename "$f" .cjs)"
  if [ "$name" = "test_worker_fetch_compat" ] && ! command -v workerd >/dev/null 2>&1 && [ ! -x node_modules/.bin/workerd ]; then
    skip "$name" "workerd not available"; continue
  fi
  case " $NODE_BROWSER " in
    *" $name "*) [ "$BROWSER" = 1 ] || { skip "$name" "--no-browser"; continue; } ;;
  esac
  run "$name" node "$f"
done

if [ "$BROWSER" = 1 ]; then
  echo "== Browser tests (Python + Playwright)"
  if [ ! -f public/public.js ]; then
    skip "python browser tests" "public/ not built (python3 scripts/build_public.py)"
  else
    # Standalone scripts, not unittest modules.
    for name in test_back_to_top_ui test_brief_feedback_ui test_faceted_filters_ui test_journal_ui \
                test_layout_ui test_navigation_search_ui test_reader_drawer_scroll test_reader_overlays_ui \
                test_search_shortlist_ui test_sol_gap_reader test_weekly_ui; do
      run "$name" python3 "scripts/$name.py"
    done
  fi
fi

echo
echo "== Summary: ${#PASSED[@]} passed, ${#FAILED[@]} failed, ${#SKIPPED[@]} skipped"
for s in "${SKIPPED[@]}"; do echo "  SKIP $s"; done
for f in "${FAILED[@]}"; do echo "  FAIL $f"; done
[ "${#FAILED[@]}" -eq 0 ]
