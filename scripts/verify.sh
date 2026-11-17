#!/usr/bin/env bash
# Fixed self-verification entry for this repository. See .claude/skills/verify/SKILL.md.
#
#   scripts/verify.sh                 # referee guardrails + build_sources --check + run_all_tests.sh --no-browser
#   scripts/verify.sh --ui            # also browser tests and feature_map_walk (needs built public/ and Chromium)
#   scripts/verify.sh --referee-only  # only the guardrails, taken from the referee ref
#   scripts/verify.sh --no-fetch      # do not `git fetch origin main` first (offline; referee may be stale)
#   scripts/verify.sh --pr-body FILE  # also scan a PR body file with the guardrails
#
# The referee (scripts/check_guardrails.py, its helper modules and config/guardrails.json) always comes from
# $VERIFY_REFEREE_REF (default origin/main) and runs against this working tree; the branch copies are ignored.
# When the referee ref has its own scripts/verify.sh, that copy is what runs, so a branch cannot edit the entry
# either. Exit code: 0 all run steps passed; 1 a step failed; 3 UI files changed but --ui was not run.
set -u
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "verify: not inside a git checkout" >&2; exit 2; }
cd "$ROOT"

UI=0; REFEREE_ONLY=0; FETCH=1; PR_BODY=""; ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --ui) UI=1 ;;
    --referee-only) REFEREE_ONLY=1 ;;
    --no-fetch) FETCH=0 ;;
    --pr-body) shift; PR_BODY="${1:-}"; [ -f "$PR_BODY" ] || { echo "verify: --pr-body needs a file" >&2; exit 2; } ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" 2>/dev/null || echo "see .claude/skills/verify/SKILL.md"; exit 0 ;;
    *) echo "verify: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

REF="${VERIFY_REFEREE_REF:-origin/main}"
if [ "$FETCH" = 1 ] && [ -z "${VERIFY_FROM_REFEREE:-}" ]; then
  git fetch -q origin main || echo "verify: WARNING git fetch origin main failed; using the local $REF"
fi
REF_SHA="$(git rev-parse --verify -q "$REF^{commit}")" || { echo "verify: referee ref $REF not found" >&2; exit 2; }

# Run the referee's own copy of this entry when it has one (once per invocation).
if [ -z "${VERIFY_FROM_REFEREE:-}" ] && git cat-file -e "$REF_SHA:scripts/verify.sh" 2>/dev/null; then
  export VERIFY_FROM_REFEREE="$REF_SHA"
  exec bash <(git show "$REF_SHA:scripts/verify.sh") "${ARGS[@]}"
fi
if [ "${VERIFY_FROM_REFEREE:-}" = "$REF_SHA" ]; then ENTRY="referee $REF@${REF_SHA:0:12}"
elif [ -n "${VERIFY_FROM_REFEREE:-}" ]; then ENTRY="branch copy (VERIFY_FROM_REFEREE override; not the referee entry)"
else ENTRY="branch copy (referee $REF has no scripts/verify.sh yet)"; fi

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR=".local/verify/$STAMP"; mkdir -p "$LOG_DIR"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
RESULTS=()

echo "== verify entry: $ENTRY"
echo "   tree: $ROOT  HEAD $(git rev-parse HEAD)  logs: $LOG_DIR"
git status --short | sed -n '1,20p' | sed 's/^/   dirty: /'

step() { # name, command...
  local name="$1"; shift
  local log="$LOG_DIR/$name.log"
  echo "== [$name] $*"
  "$@" 2>&1 | tee "$log"
  local rc="${PIPESTATUS[0]}"
  if [ "$rc" = 0 ]; then RESULTS+=("PASS $name"); else RESULTS+=("FAIL $name (exit $rc, log $log)"); fi
  return "$rc"
}

referee() {
  git archive "$REF_SHA" scripts config | tar -x -C "$TMP" || return 2
  python3 - "$TMP" "$ROOT" "$REF" "$REF_SHA" ${PR_BODY:+"$PR_BODY"} <<'PY'
import hashlib, importlib.util, json, sys
from pathlib import Path
referee, root, ref, sha = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
extra = tuple(sys.argv[5:])
checker = referee / 'scripts/check_guardrails.py'
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()[:12] if p.is_file() else 'missing'
for rel in ('scripts/check_guardrails.py', 'config/guardrails.json'):
    same = digest(referee / rel) == digest(root / rel)
    print(f'referee {rel} from {ref}@{sha[:12]} sha256:{digest(referee / rel)}'
          + ('' if same else f'  (working-tree copy sha256:{digest(root / rel)} differs; ignored)'))
spec = importlib.util.spec_from_file_location('referee_check_guardrails', checker)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = json.loads((referee / 'config/guardrails.json').read_text())
config['allow_workflows'] = False
print('referee checks: ' + ', '.join(module.CHECKS))
# Same arguments as the documented PR command: --base REF --commit-range REF..HEAD, untracked files included.
findings = module.run_checks(root, None, ref, None, extra, ref + '..HEAD', config, include_untracked=True)
for finding in findings:
    print(finding)
print('guardrails: all checks passed' if not findings else f'guardrails: {len(findings)} finding(s)')
sys.exit(int(bool(findings)))
PY
}

FAIL=0
step guardrails-referee referee || FAIL=1
if [ "$REFEREE_ONLY" = 0 ]; then
  step build-sources-check python3 scripts/build_sources.py --check || FAIL=1
  step run-all-tests-no-browser scripts/run_all_tests.sh --no-browser || FAIL=1
  MERGE="$(git merge-base "$REF_SHA" HEAD)"
  UI_CHANGED="$( { git diff --name-only "$MERGE" --; git ls-files --others --exclude-standard; } \
    | grep -E '^(index\.html|style\.css|src/app/|app\.js|journal-metrics\.js|citation-export\.js|journal-tiers\.js|docs/feature-map\.json)' | sort -u)"
  if [ "$UI" = 1 ]; then
    if [ -f public/index.html ] && [ -d public/assets ]; then
      step browser-and-feature-map scripts/run_all_tests.sh || FAIL=1
    else
      RESULTS+=("FAIL browser-and-feature-map (public/ not built; see AGENTS.md section 2)"); FAIL=1
    fi
  elif [ -n "$UI_CHANGED" ]; then
    RESULTS+=("NOT RUN browser-and-feature-map: UI files changed ($(echo "$UI_CHANGED" | tr '\n' ' ')); rerun with --ui")
    [ "$FAIL" = 1 ] || FAIL=3
  fi
fi

# Track consecutive failures per step so the 3-round stop rule is visible.
HIST=".local/verify/history.tsv"
for r in "${RESULTS[@]}"; do printf '%s\t%s\t%s\n' "$STAMP" "$(git rev-parse --short HEAD)" "$r" >> "$HIST"; done

echo
echo "== verify summary ($ENTRY)"
for r in "${RESULTS[@]}"; do
  echo "  $r"
  case "$r" in FAIL\ *)
    name="$(echo "$r" | awk '{print $2}')"
    streak="$(awk -F'\t' -v n="$name" '{split($3,a," "); if (a[2]==n) s=(a[1]=="FAIL")?s+1:0} END{print s+0}' "$HIST")"
    echo "    consecutive failing runs of $name: $streak"
    [ "$streak" -ge 3 ] && echo "    STOP: $name failed 3 rounds; stop fixing and hand to ddx with the three attempts and errors"
  ;; esac
done
exit "$FAIL"
