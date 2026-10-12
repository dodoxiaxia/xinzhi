#!/usr/bin/env python3
"""Join the split sources into the single files the site runs.

app.js and edge/_worker.js are each one script at runtime (app.js is one IIFE that
build_public.py bundles into public.js; Cloudflare Pages advanced mode needs a single
_worker.js). Their sources live in parts that are joined in file-name order:

  src/app/*.js   -> app.js
  edge/src/*.js  -> edge/_worker.js

Edit the parts, then run `python3 scripts/build_sources.py`. The joined files are
committed so tests, the local preview and the release package keep reading them;
`--check` (also run by build_public.py and the tests) fails when they are stale.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLES = {'app.js': 'src/app', 'edge/_worker.js': 'edge/src'}


def parts(root, directory):
    files = sorted(p for p in (Path(root) / directory).glob('*.js') if p.is_file())
    if not files:
        raise ValueError('No source parts in ' + directory)
    return files


def joined(root, target):
    """The exact text of `target`: its parts concatenated byte for byte."""
    out = []
    for path in parts(root, BUNDLES[target]):
        text = path.read_text(encoding='utf-8')
        if not text.endswith('\n'):
            raise ValueError('Source part must end with a newline: ' + str(path.relative_to(root)))
        out.append(text)
    return ''.join(out)


def stale(root=ROOT):
    """Targets whose committed text differs from their parts.

    A tree without the parts (the local release package ships only the joined files)
    has nothing to compare and is not stale."""
    return [target for target in BUNDLES
            if (Path(root) / BUNDLES[target]).is_dir()
            and (not (Path(root) / target).is_file() or (Path(root) / target).read_text(encoding='utf-8') != joined(root, target))]


def require_fresh(root=ROOT):
    names = stale(root)
    if names:
        raise ValueError('Joined sources are out of date: ' + ', '.join(names) + '; run python3 scripts/build_sources.py')


def write(root=ROOT):
    changed = []
    for target in BUNDLES:
        text = joined(root, target)
        path = Path(root) / target
        if not path.is_file() or path.read_text(encoding='utf-8') != text:
            path.write_text(text, encoding='utf-8')
            changed.append(target)
    return changed


if __name__ == '__main__':
    if sys.argv[1:] == ['--check']:
        names = stale()
        print('stale: ' + ', '.join(names) if names else 'up to date')
        sys.exit(1 if names else 0)
    print('rebuilt: ' + (', '.join(write()) or 'nothing (already up to date)'))
