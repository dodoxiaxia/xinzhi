#!/usr/bin/env python3
"""Pick the lease for the final state save after this run's own checkpoints.

Usage: resolve_state_lease.py EXPECTED_SHA [REMOTE_REF]   (run inside a Git repo
that has fetched REMOTE_REF, default FETCH_HEAD, with enough history).

Daily full-text and weekly precompute checkpoints append commits to state during
a run. If the local head record missed the last one (an interrupted read-back),
the lease on EXPECTED_SHA is stale and the whole day's work would be dropped.
The remote tip is accepted only when every commit between EXPECTED_SHA and the
tip is a checkpoint commit descending from EXPECTED_SHA; any other writer
(e.g. another run's single-commit state) still fails the lease. Prints the
lease SHA, or exits 1.
"""
import re
import subprocess
import sys

CHECKPOINT_MESSAGES = {
    'Checkpoint daily public full-text reading',
    'Persist public abstract precompute checkpoint',
}
MAX_CHECKPOINTS = 64


def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout


def resolve(expected, remote='FETCH_HEAD'):
    if not re.fullmatch(r'[a-f0-9]{40}', expected or ''):
        return None
    try:
        tip = git('rev-parse', '--verify', remote + '^{commit}').strip()
        if tip == expected:
            return tip
        rows = git('log', '--first-parent', '--format=%H%x00%P%x00%s', '-n', str(MAX_CHECKPOINTS + 1), tip).splitlines()
    except subprocess.CalledProcessError:
        return None
    for row in rows:
        sha, parents, subject = row.split('\x00', 2)
        if sha == expected:
            return tip
        if subject not in CHECKPOINT_MESSAGES or len(parents.split()) != 1:
            return None
    return None


def main(argv):
    if len(argv) not in (2, 3):
        print(__doc__, file=sys.stderr)
        return 2
    lease = resolve(*argv[1:])
    if not lease:
        return 1
    print(lease)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
