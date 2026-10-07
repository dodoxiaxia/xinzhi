#!/usr/bin/env python3
"""CI entry point: refresh sources -> fill abstracts -> translate new titles -> build public bundle -> sanity gate.

Runs on GitHub Actions (no local sqlite / .local needed). Writes `deploy=true|false` to $GITHUB_OUTPUT.
Required steps must succeed; optional steps may fail without blocking the day's update.
"""
import datetime, hashlib, json, os, re, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = {'index.html', 'style.css', 'public.js', 'icon.svg', '_headers', '_worker.js'}

REQUIRED = [
    ['scripts/apply_public_library.py'],
    ['scripts/refresh_feeds.py', '--all'],
    ['scripts/fetch_pubmed.py'],
    ['scripts/merge_candidates.py'],
]
LIGHT_OPTIONAL = [(['scripts/media_signals.py'], 300), (['scripts/auto_picks.py'], 120)]
FULL_OPTIONAL = [  # (argv, timeout seconds); enrich before generating quicklooks
    (['scripts/fetch_archive.py', '--incremental'], 1500),
    (['scripts/archive_details.py', '--fill'], 1800),
    (['scripts/translate_titles.py', '--run', '--limit', '60'], 900),
    (['scripts/week_precompute.py', '--run', '--provider', 'configured', '--attempt-limit', '8'], 600),
    (['scripts/auto_picks.py'], 120),
]
BUILD = ['scripts/build_public.py']
WEEK_BOARD = ['scripts/week_precompute.py']
MIN_COUNTS = {'radar': 300, 'library': 1000}  # refuse to publish a collapsed build
VOLATILE_KEYS = {'createdAt', 'updatedAt', 'generatedAt', 'checkedAt', 'fetchedAt', 'weeklyAt', 'builtAt', 'radarUpdatedAt', 'healthCheckedAt', 'lastSuccessfulAt', 'lastCachedFetchAt'}
BUNDLE_DATA = re.compile(r'\bwindow\.(?:LIBRARY|FEEDS|SOURCE_HEALTH|CURATED|QUICKLOOKS|CONTENT_STATUS|JOURNAL_METRICS|WEEKLY_BOARD|PREGENERATED|RADAR)\s*=\s*')


def stable_data(value):
    """Remove refresh metadata, preserving article dates, text and list order."""
    if isinstance(value, dict):
        return {k: stable_data(v) for k, v in value.items() if k not in VOLATILE_KEYS}
    if isinstance(value, list):
        return [stable_data(v) for v in value]
    return value


def stable_bundle(text):
    """Normalize only JSON data assignments; application JavaScript stays exact."""
    decoder = json.JSONDecoder()
    pieces, cursor = [], 0
    for match in BUNDLE_DATA.finditer(text):
        if match.start() < cursor:
            continue
        # The builder emits these constants before app.js, separated by semicolons.
        # Stop at application code so quoted examples and templates stay untouched.
        if text[cursor:match.start()].strip(' \t\r\n;'):
            break
        try:
            value, length = decoder.raw_decode(text[match.end():])
        except ValueError:
            continue
        end = match.end() + length
        if not text[end:].lstrip().startswith(';'):
            continue
        pieces.extend([text[cursor:match.end()], json.dumps(stable_data(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))])
        cursor = end
    pieces.append(text[cursor:])
    return ''.join(pieces)


def content_hash():
    """Hash every public asset, ignoring only known bundle refresh timestamps."""
    if not (ROOT / 'public' / 'public.js').exists():
        return ''
    digest = hashlib.sha256()
    for name in sorted(PUBLIC):
        path = ROOT / 'public' / name
        payload = path.read_bytes() if path.exists() else b'<missing>'
        if name == 'public.js':
            payload = stable_bundle(payload.decode('utf-8')).encode('utf-8')
        digest.update(name.encode() + b'\0' + str(len(payload)).encode() + b'\0' + payload)
    return digest.hexdigest()


def run(argv, timeout):
    try:
        r = subprocess.run([sys.executable, *argv], cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout[-800:], r.stderr[-800:]
    except subprocess.TimeoutExpired:
        return 124, '', 'timeout'


def out(deploy):
    path = os.environ.get('GITHUB_OUTPUT')
    if path:
        with open(path, 'a') as f:
            f.write(f'deploy={"true" if deploy else "false"}\n')


def main():
    fast = '--fast' in sys.argv
    before = content_hash()
    budget = (25 if fast else 50) * 60
    deadline = time.monotonic() + budget
    report = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'runId': os.environ.get('GITHUB_RUN_ID'), 'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'codeSha': os.environ.get('GITHUB_SHA'), 'fast': fast, 'changed': None, 'status': 'running', 'deploymentRequested': False, 'budgetSeconds': budget, 'beforeContentHash': before, 'steps': []}

    def finish(status, problems=None):
        report['status'] = status
        report['problems'] = problems or []
        report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        report['deploymentRequested'] = status == 'success' and (report['changed'] or not fast)
        (ROOT / 'docs').mkdir(exist_ok=True)
        (ROOT / 'docs/last-refresh.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        out(report['deploymentRequested'])
        return 0 if status == 'success' else 1

    def log(argv, code, so, se, optional):
        report['steps'].append({'script': ' '.join(argv), 'exitCode': code, 'optional': optional, 'tail': so[-300:], 'error': se[-300:]})
        print(('OK  ' if code == 0 else 'FAIL') + ' ' + ' '.join(argv), flush=True)
        if code:
            print(se, file=sys.stderr)

    def execute(argv, timeout, optional=False, build=False, reserve=300):
        # Keep time for the build and, in full mode, model enrichment after archives.
        remaining = int(deadline - time.monotonic() - (0 if build else reserve))
        if remaining <= 0:
            if optional:
                report['steps'].append({'script': ' '.join(argv), 'exitCode': None, 'optional': True, 'outcome': 'skipped', 'reason': 'pipeline time budget'})
                return 0
            log(argv, 124, '', 'pipeline time budget exhausted', False)
            return 124
        code, so, se = run(argv, min(timeout, remaining))
        log(argv, code, so, se, optional)
        return code

    for argv in REQUIRED:
        code = execute(argv, 1200)
        if code:
            return finish('failed', ['required step failed: ' + ' '.join(argv)])
    for argv, t in LIGHT_OPTIONAL:
        execute(argv, t, optional=True, reserve=300 if fast else 900)
    if not fast:
        for argv, t in FULL_OPTIONAL:
            reserve = 300 if argv[0] in ('scripts/week_precompute.py', 'scripts/auto_picks.py') else 900
            execute(argv, t, optional=True, reserve=reserve)

    code = execute(WEEK_BOARD, 180, build=True)
    if code:
        return finish('failed', ['weekly public-abstract board failed'])
    code = execute(BUILD, 300, build=True)
    if code:
        return finish('failed', ['public build failed'])

    # sanity gate
    problems = []
    names = {p.name for p in (ROOT / 'public').iterdir()} if (ROOT / 'public').is_dir() else set()
    if names != PUBLIC:
        problems.append(f'public files differ: {sorted(names ^ PUBLIC)}')
    try:
        counts = json.loads((ROOT / 'docs/public-manifest.json').read_text()).get('counts', {})
        for k, v in MIN_COUNTS.items():
            if counts.get(k, 0) < v:
                problems.append(f'{k} count too low: {counts.get(k)}')
    except Exception as e:  # noqa
        problems.append(f'manifest unreadable: {e}')
    if problems:
        print('SANITY FAILED:', problems, file=sys.stderr)
        return finish('failed', problems)
    changed = content_hash() != before
    report['changed'] = changed
    report['afterContentHash'] = content_hash()
    print('fast' if fast else 'full', 'changed' if changed else 'unchanged', flush=True)
    return finish('success')


if __name__ == '__main__':
    sys.exit(main())
