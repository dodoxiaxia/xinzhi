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

# Standalone data file loaded before app.js locally, and inlined into public.js.
# Kept next to the quick-filter sources but not concatenated into the app IIFE
# (its name would sort after boot code). Synced to the repo root for index.html.
ROOT_COPIES = {'journal-tiers.js': 'src/app/journal-tiers.js'}


def copy_text(root, dest):
    src = Path(root) / ROOT_COPIES[dest]
    text = src.read_text(encoding='utf-8')
    if not text.endswith('\n'):
        raise ValueError('Source part must end with a newline: ' + ROOT_COPIES[dest])
    return text


def stale_copies(root=ROOT):
    names = []
    for dest, src in ROOT_COPIES.items():
        src_path = Path(root) / src
        dest_path = Path(root) / dest
        if not src_path.is_file():
            continue
        if not dest_path.is_file() or dest_path.read_text(encoding='utf-8') != copy_text(root, dest):
            names.append(dest)
    return names



def parts(root, directory):
    files = sorted(p for p in (Path(root) / directory).glob('*.js') if p.is_file() and p.name != 'journal-tiers.js')
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
            and (not (Path(root) / target).is_file() or (Path(root) / target).read_text(encoding='utf-8') != joined(root, target))] + stale_copies(root)


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
    for dest in ROOT_COPIES:
        src_path = Path(root) / ROOT_COPIES[dest]
        if not src_path.is_file():
            continue
        text = copy_text(root, dest)
        path = Path(root) / dest
        if not path.is_file() or path.read_text(encoding='utf-8') != text:
            path.write_text(text, encoding='utf-8')
            changed.append(dest)
    return changed


if __name__ == '__main__':
    if sys.argv[1:] == ['--check']:
        names = stale()
        print('stale: ' + ', '.join(names) if names else 'up to date')
        sys.exit(1 if names else 0)
    print('rebuilt: ' + (', '.join(write()) or 'nothing (already up to date)'))
