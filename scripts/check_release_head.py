"""Refuse to publish or run paid work from a superseded main checkout."""
import argparse
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r'[a-f0-9]{40}')


def git_output(root, *args):
    try:
        result = subprocess.run(['git', *args], cwd=root, capture_output=True,
                                text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('release_head_unavailable') from None
    if result.returncode:
        raise ValueError('release_head_unavailable')
    return result.stdout.strip()


def check(root, expected_sha):
    if not isinstance(expected_sha, str) or not SHA.fullmatch(expected_sha):
        raise ValueError('release_sha_invalid')
    if git_output(root, 'rev-parse', 'HEAD') != expected_sha:
        raise ValueError('release_checkout_mismatch')
    # Read the remote now; a cached origin/main cannot detect an intervening push.
    remote = git_output(root, 'ls-remote', '--exit-code', 'origin', 'refs/heads/main')
    match = re.fullmatch(r'([a-f0-9]{40})\s+refs/heads/main', remote)
    if not match:
        raise ValueError('release_head_unavailable')
    if match.group(1) != expected_sha:
        raise ValueError('release_superseded')
    return expected_sha


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-sha', default=os.environ.get('GITHUB_SHA', ''))
    args = parser.parse_args()
    try:
        sha = check(ROOT, args.expected_sha)
    except ValueError as error:
        print('::error::' + str(error))
        return 1
    print('Release checkout matches current main: ' + sha)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
