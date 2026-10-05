#!/usr/bin/env python3
"""CI entry point: refresh sources -> fill abstracts -> translate new titles -> build public bundle -> sanity gate.

Runs on GitHub Actions (no local sqlite / .local needed). Writes `deploy=true|false` to $GITHUB_OUTPUT.
Required steps must succeed; optional steps may fail without blocking the day's update.
"""
import datetime, hashlib, json, os, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = {'index.html', 'style.css', 'public.js', 'icon.svg', '_headers', '_worker.js'}

REQUIRED = [
    ['scripts/refresh_feeds.py', '--all'],
    ['scripts/fetch_pubmed.py'],
    ['scripts/merge_candidates.py'],
]
ALWAYS_OPTIONAL = [(['scripts/media_signals.py'], 300)]  # 媒体热度信号:轻量,每次都跑
OPTIONAL = [  # (argv, timeout seconds)
    (['scripts/fetch_archive.py', '--incremental'], 1500),
    (['scripts/archive_details.py', '--fill'], 1800),
    (['scripts/translate_titles.py', '--run', '--limit', '60'], 900),
]
BUILD = ['scripts/build_public.py']
MIN_COUNTS = {'radar': 300, 'library': 1000}  # refuse to publish a collapsed build


def content_hash():
    """Hash of public/public.js ignoring build timestamps, so unchanged content never triggers a deploy."""
    f = ROOT / 'public' / 'public.js'
    if not f.exists():
        return ''
    t = f.read_text(encoding='utf-8', errors='ignore')
    t = re.sub(r'"?createdAt"?\s*:\s*"[^"]*"', '', t)
    return hashlib.sha256(t.encode()).hexdigest()


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
    fast = '--fast' in sys.argv  # 半小时轻量刷新:只抓取+合并+构建,跳过归档/翻译等重活
    before = content_hash()
    report = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'steps': []}

    def log(argv, code, so, se, optional):
        report['steps'].append({'script': ' '.join(argv), 'exitCode': code, 'optional': optional, 'tail': so[-300:], 'error': se[-300:]})
        print(('OK  ' if code == 0 else 'FAIL') + ' ' + ' '.join(argv), flush=True)
        if code:
            print(se, file=sys.stderr)

    for argv in REQUIRED:
        code, so, se = run(argv, 1200)
        log(argv, code, so, se, False)
        if code:
            out(False)
            return 1
    for argv, t in ALWAYS_OPTIONAL + ([] if fast else OPTIONAL):
        code, so, se = run(argv, t)
        log(argv, code, so, se, True)

    code, so, se = run(BUILD, 900)
    log(BUILD, code, so, se, False)
    if code:
        out(False)
        return 1

    # sanity gate
    problems = []
    names = {p.name for p in (ROOT / 'public').iterdir()}
    if names != PUBLIC:
        problems.append(f'public files differ: {sorted(names ^ PUBLIC)}')
    try:
        counts = json.loads((ROOT / 'docs/public-manifest.json').read_text()).get('counts', {})
        for k, v in MIN_COUNTS.items():
            if counts.get(k, 0) < v:
                problems.append(f'{k} count too low: {counts.get(k)}')
    except Exception as e:  # noqa
        problems.append(f'manifest unreadable: {e}')
    report['problems'] = problems
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (ROOT / 'docs').mkdir(exist_ok=True)
    (ROOT / 'docs/last-refresh.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    if problems:
        print('SANITY FAILED:', problems, file=sys.stderr)
        out(False)
        return 1
    changed = content_hash() != before
    report['fast'] = fast
    report['changed'] = changed
    print('fast' if fast else 'full', 'changed' if changed else 'unchanged', flush=True)
    out(changed or not fast)
    return 0


if __name__ == '__main__':
    sys.exit(main())
