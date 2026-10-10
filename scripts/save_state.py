"""Publish this run's data as the single-commit state branch, with an explicit lease.

The lease normally equals the restored (or last confirmed checkpoint) SHA. A
checkpoint request can succeed on GitHub while its client times out, so the run
never learns the new head. When the lease is rejected, this script accepts the
newer remote head only if every commit after the lease is a known checkpoint
commit touching only checkpoint files; those files are then taken from the
remote (they are a superset of local data) and the push is retried once. Any
other writer still rejects the push, preserving the original concurrency guard.
"""
import argparse
import datetime
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

CHECKPOINT_MESSAGES = {
    'Checkpoint daily public full-text reading': {'data/deep-readings.json', 'data/deep-reading-ledger.json'},
    'Persist public abstract precompute checkpoint': {'data/week-precompute-ledger.json', 'data/week-precompute-cache.json'},
}
STATE_DOCS = ('public-manifest.json', 'last-refresh.json', 'deployment-status.json')
MAX_CHECKPOINTS = 40


class StateError(RuntimeError):
    pass


def git(cwd, *args, check=True):
    result = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True)
    if check and result.returncode:
        # Never echo stderr: it may contain the authenticated remote URL.
        raise StateError('git_' + args[0] + '_failed')
    return result


def checkpoint_paths(repo, expected, head):
    """Paths changed by checkpoint commits between expected and head, or StateError."""
    paths, sha = set(), head
    for _ in range(MAX_CHECKPOINTS):
        if sha == expected:
            return paths
        parents = git(repo, 'rev-list', '--parents', '-n', '1', sha).stdout.split()[1:]
        subject = git(repo, 'log', '-1', '--format=%s', sha).stdout.strip()
        allowed = CHECKPOINT_MESSAGES.get(subject)
        if len(parents) != 1 or allowed is None:
            raise StateError('state_foreign_writer')
        changed = set(git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', parents[0], sha).stdout.split())
        if not changed or not changed <= allowed:
            raise StateError('state_foreign_writer')
        paths |= changed
        sha = parents[0]
    raise StateError('state_checkpoint_chain_too_long')


def build(root, work):
    target = work / 's'
    (target / 'docs').mkdir(parents=True)
    for name in ('data', 'public'):
        shutil.copytree(root / name, target / name)
    for name in STATE_DOCS:
        shutil.copy2(root / 'docs' / name, target / 'docs' / name)
    git(target, 'init', '-q', '-b', 'state')
    git(target, 'config', 'user.name', 'xinzhi-bot')
    git(target, 'config', 'user.email', 'bot@users.noreply.github.com')
    git(target, 'add', '-A')
    git(target, 'commit', '-qm', 'state ' + datetime.datetime.now(datetime.timezone.utc).date().isoformat())
    return target


def push(repo, remote, expected):
    return git(repo, 'push', '--force-with-lease=refs/heads/state:' + expected, remote, 'state', check=False).returncode == 0


def save(root, remote, expected):
    with tempfile.TemporaryDirectory() as tmp:
        repo = build(root, pathlib.Path(tmp))
        if push(repo, remote, expected):
            return {'status': 'saved', 'lease': 'original'}
        git(repo, 'fetch', '-q', '--depth=' + str(MAX_CHECKPOINTS + 2), remote, 'state')
        head = git(repo, 'rev-parse', 'FETCH_HEAD').stdout.strip()
        if head == expected:
            raise StateError('state_push_failed')
        paths = checkpoint_paths(repo, expected, head)
        for path in sorted(paths):
            blob = git(repo, 'cat-file', '-e', head + ':' + path, check=False)
            if blob.returncode:
                raise StateError('state_checkpoint_file_missing')
            content = subprocess.run(['git', 'show', head + ':' + path], cwd=repo, capture_output=True, check=True).stdout
            (repo / path).write_bytes(content)
            (root / path).write_bytes(content)
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '--amend', '--no-edit')
        if not push(repo, remote, head):
            raise StateError('state_push_failed_after_checkpoint_merge')
        return {'status': 'saved', 'lease': 'checkpoint_merged', 'mergedPaths': sorted(paths)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected', required=True)
    parser.add_argument('--remote', default=os.environ.get('STATE_REMOTE', ''))
    args = parser.parse_args()
    expected = args.expected.strip()
    if len(expected) != 40 or any(c not in '0123456789abcdef' for c in expected) or not args.remote:
        print('{"status": "invalid_arguments"}')
        return 1
    try:
        result = save(pathlib.Path.cwd(), args.remote, expected)
    except StateError as error:
        print('{"status": "failed", "error": "%s"}' % error)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
