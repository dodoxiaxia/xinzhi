#!/usr/bin/env python3
"""Deterministic public-repository checks.

The prohibited vocabulary must not itself enter GitHub content. Its UTF-8 words
are encoded below and decoded in memory only, including in mutation tests.
"""
import argparse
import ast
import base64
from collections import Counter
from dataclasses import dataclass
import fnmatch
import importlib.util
import json
import math
from pathlib import Path
import re
import subprocess
import sys

ENCODED_WORDS = ('YmVhY29u', '54O954Gr5Y+w', '5b+D5ZCJ5bq3', 'eGluamlrYW5n', 'eGpr', '5LqS6IGU572R5Yy76Zmi', 'QUnljLvnlJ8=')
BANNED_WORDS = tuple(base64.b64decode(w).decode() for w in ENCODED_WORDS)
CHECKS = ('banned-words', 'public-ids', 'secrets', 'hex32', 'sources-fresh', 'forbidden-files', 'workflows-untouched', 'ui-banned-labels', 'feature-map-selectors')
INJECTED_WORKER_CONSTANTS = frozenset(('PDF_LIBRARY', 'DOI_ADJUDICATIONS', 'PUBLIC_ABSTRACT_SOURCES', 'FULLTEXT_OIDC_BUILD_KEYS', 'SCOPE_UNCERTAIN_LIST'))
BASELINE = ('docs/screenshots/**', 'docs/manual-assets/*', 'docs/使用说明.pdf', 'scripts/fixtures/machine-identity/*.pdf', 'icon.png')
ADDED_ALLOW = ('scripts/fixtures/machine-identity/*.pdf', 'icon.png')
HEX = re.compile(r'\b[0-9a-fA-F]{32}\b')
EXTENSIONS = {'.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.mp4', '.mov', '.webm', '.mkv', '.zip', '.tar', '.gz', '.7z', '.sqlite', '.sqlite3', '.db', '.pem', '.key'}
UI_LABELS = ('未经人工核对', '未经人工审核', '未经医生终审', '未经人工核验')


@dataclass(frozen=True)
class Finding:
    check: str
    path: str
    line: int
    rule: str
    fix: str
    snippet: str = ''

    def __str__(self):
        # Only the first 4 characters of a match are ever shown, never the whole value.
        shown = f' [starts with {self.snippet}]' if self.snippet else ''
        return f'{self.path}:{self.line}: [{self.check}] {self.rule}{shown} -> {self.fix} (see docs/guardrails.md#{self.check})'


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL).decode('utf-8', 'replace')


def entropy(value):
    return -sum(n / len(value) * math.log2(n / len(value)) for n in Counter(value).values()) if value else 0


def fake(value):
    return bool(re.search(r'fake|test|example|sample|dummy|synthetic|placeholder|xxxx|changeme|your_|\$\{|process\.env|os\.environ|secrets\.', value, re.I)) or len(set(value)) == 1


SECRET_PATTERNS = tuple(re.compile(p, re.I if i in (8, 9) else 0) for i, p in enumerate((
    r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',
    r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})',
    r'\bAIza[A-Za-z0-9_-]{30,}',
    r'\bxox[abprs]-[A-Za-z0-9-]{20,}',
    r'\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}',
    r'\b(?:sk_live|rk_live)_[A-Za-z0-9]{16,}',
    r'\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}',
    r'\bBearer\s+[\'\"]?([A-Za-z0-9._~+/-]{20,})',
    r'\b(?:CLOUDFLARE\w*|CF_\w*)\s*[:=]\s*[\'\"]([A-Za-z0-9_-]{40})[\'\"]',
)))
GENERIC = re.compile(r'(?:api[_-]?key|token|secret|passw(?:or)?d|passphrase)\s*[:=]\s*[\'\"]([^\s\'\"]{16,})[\'\"]', re.I)
HIGH = re.compile(r'(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}(?![A-Za-z0-9+/_-])')


def secret_matches(line):
    for pattern in SECRET_PATTERNS:
        for m in pattern.finditer(line):
            value = m.group(1) if m.lastindex else m.group()
            if not fake(value):
                yield m.start(), value, 'credential pattern'
    for m in GENERIC.finditer(line):
        if entropy(m[1]) >= 3.5 and not fake(m[1]):
            yield m.start(), m[1], 'high-entropy credential assignment'
    for m in HIGH.finditer(line):
        value = m.group()
        # Paths, resource names and URLs are common in this repository. Only
        # opaque mixed-case tokens qualify; hex hashes have their own check.
        if (entropy(value) >= 4.3 and not fake(value)
                and not re.fullmatch('[0-9a-fA-F]+', value)
                and not re.search(r'(?:https?://|[./][A-Za-z][A-Za-z0-9_-]*/)', line[max(0, m.start()-100):m.end()])
                and re.search('[a-z]', value) and re.search('[A-Z]', value)
                and re.search('[0-9]', value)
                and not re.search(r'https?://\S*$', line[:m.start()])):
            yield m.start(), value, 'high-entropy token'


def load_module(name):
    spec = importlib.util.spec_from_file_location('_guardrails_' + name, Path(__file__).parent / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    directory = str(Path(__file__).parent)
    sys.path.insert(0, directory)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(directory)
    return module


def map_source_file(path):
    # Where a feature-map selector may be defined: the UI sources plus the standalone browser modules.
    return ui_file(path) or path in ('citation-export.js', 'journal-metrics.js', 'journal-tiers.js')


def ui_file(path):
    return path in ('index.html', 'style.css') or fnmatch.fnmatch(path, 'src/app/*.js') or fnmatch.fnmatch(path, 'edge/src/*.js')


def run_checks(root, only=None, base=None, public=None, extra_files=(), commit_range=None, config=None, include_untracked=False):
    root = Path(root).resolve()
    try:
        tracked = git(root, 'ls-files', '-z').split('\0')
        if include_untracked:
            # Local runs also scan new files that are not ignored yet (before `git add`). CI does not:
            # the build leaves generated, untracked reports in the tree that are not repository content.
            tracked += git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')
    except (subprocess.CalledProcessError, FileNotFoundError):
        print('SKIP guardrails: not a git checkout')
        return []
    selected = set(only.split(',') if isinstance(only, str) else only or CHECKS)
    unknown = selected - set(CHECKS)
    if unknown:
        raise ValueError('Unknown check name')
    if config is None:
        cfg_path = root / 'config/guardrails.json'
        config = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
    elif isinstance(config, (str, Path)):
        config = json.loads(Path(config).read_text())
    allows = config.get('allow', [])
    used = set()
    findings = []
    texts = {}
    paths = set(filter(None, tracked)) | {str(p) for p in extra_files}
    for path in sorted(paths):
        file = root / path
        if not file.is_file() or file.is_symlink():
            continue
        if file.stat().st_size > 3 * 1024 * 1024 and not any(fnmatch.fnmatch(path, g) for g in config.get('large_text', [])):
            continue
        raw = file.read_bytes()
        if b'\0' in raw:
            continue
        try:
            texts[path] = raw.decode('utf-8')
        except UnicodeDecodeError:
            continue

    def emit(check, path, line, rule, fix, value='', column=None):
        if check not in selected:
            return
        lines = texts.get(path, '').splitlines()
        context = lines[max(0, line - 2):line]
        for text in context:
            marker = re.search(r'guardrails:allow\s+' + re.escape(check) + r'\s+(\S.*)', text)
            if marker:
                return
        for i, entry in enumerate(allows):
            if (entry.get('check') == check and entry.get('reason', '').strip()
                    and fnmatch.fnmatch(path, entry.get('path', ''))
                    and (not entry.get('line_regex') or any(re.search(entry['line_regex'], t) for t in lines[line - 1:line]))):
                used.add(i)
                return
        if column is not None:
            rule += f' at column {column}'
        # Vocabulary is never echoed, even as a prefix.
        snippet = '' if check == 'banned-words' else (value[:4] + '…' if value else '')
        if any(word.lower() in snippet.lower() for word in BANNED_WORDS):
            snippet = '[redacted]'
        findings.append(Finding(check, path, line, rule, fix, snippet))

    def scan_words(path, text):
        text = re.sub(r'data:[^\s\'\"<>]+', lambda m: ' ' * len(m.group()), text)
        for n, word in enumerate(BANNED_WORDS, 1):
            pattern = re.escape(word)
            if word.isascii():
                pattern = r'(?<![A-Za-z0-9])' + pattern + r'(?![A-Za-z0-9])'
            for m in re.finditer(pattern, text, re.I):
                emit('banned-words', path, text.count('\n', 0, m.start()) + 1,
                     f'banned word #{n} (see docs/guardrails.md)', 'remove prohibited vocabulary', column=m.start() - text.rfind('\n', 0, m.start()))

    for path, text in texts.items():
        if 'banned-words' in selected:
            scan_words(path, text)
        for number, line in enumerate(text.splitlines(), 1):
            line = re.sub(r'data:[^\s\'\"<>]+', '', line)
            marker = re.search(r'guardrails:allow\s+([a-z-]+)(.*)$', line)
            if marker and marker[1] in selected and not marker[2].strip():
                findings.append(Finding(marker[1], path, number, 'inline allowance requires a reason', 'add a specific reason or remove marker'))
            if 'hex32' in selected:
                for m in HEX.finditer(line):
                    emit('hex32', path, number, '32-character hex identifier', 'use a 7-character SHA or a justified exception', m.group())
            if 'secrets' in selected:
                for offset, value, rule in secret_matches(line):
                    emit('secrets', path, number, rule, 'remove credential; use an environment/Secret reference', value, offset + 1)
            if ui_file(path):
                for label in UI_LABELS:
                    if label in line:
                        emit('ui-banned-labels', path, number, 'prohibited reader-facing review label', 'remove the label from the UI')
    if commit_range and 'banned-words' in selected:
        scan_words('<commit-messages>', git(root, 'log', '--format=%B', commit_range))
    if 'sources-fresh' in selected:
        try:
            for path in load_module('build_sources').stale(root):
                emit('sources-fresh', path, 1, 'generated source is stale', 'run python3 scripts/build_sources.py and commit the result')
        except ValueError:
            emit('sources-fresh', 'src/app', 1, 'source parts missing or lack final newline', 'repair source parts and run python3 scripts/build_sources.py')
    if 'forbidden-files' in selected:
        candidates = set(filter(None, tracked))
        if base:
            candidates = {row.split('\t')[-1] for row in git(root, 'diff', '--name-status', base + '...HEAD', '--diff-filter=A').splitlines()}
            candidates.update(filter(None, git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')))
        for path in sorted(candidates):
            if Path(path).suffix.lower() in EXTENSIONS or Path(path).name == '.env' or Path(path).name.startswith('.env.'):
                globs = config.get('added_allow', ADDED_ALLOW) if base else config.get('baseline', BASELINE)
                if not any(fnmatch.fnmatch(path, g) for g in globs):
                    emit('forbidden-files', path, 1, 'PR must not contain screenshots/PDFs; put evidence outside the repo (see .github/pull_request_template.md)', 'remove the file from the PR')
    if base and not config.get('allow_workflows'):
        for path in git(root, 'diff', '--name-only', base + '...HEAD').splitlines():
            if path.startswith('.github/workflows/'):
                emit('workflows-untouched', path, 1, 'workflow changed', 'propose CI changes as a docs/ plan first')
    if 'public-ids' in selected:
        fix = 'new data injected into public/_worker.js: prove it carries no reviewed/hold/hidden ids, add it to the registry and a test in test_public_bibliography_review.py'
        build = texts.get('scripts/build_public.py', '')
        if build:
            tree = ast.parse(build)
            constants = {}
            for node in ast.walk(tree):
                if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            constants[target.id] = node.value.value
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'worker' and node.func.attr == 'replace':
                    strings = [n.value for n in ast.walk(node) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
                    strings += [constants.get(n.id, '') for n in node.args if isinstance(n, ast.Name)]
                    names = set(re.findall(r'const\s+(\w+)\s*=', ' '.join(strings)))
                    if not names or names - INJECTED_WORKER_CONSTANTS:
                        emit('public-ids', 'scripts/build_public.py', node.lineno, 'unregistered Worker injection', fix)
        for path, text in texts.items():
            if fnmatch.fnmatch(path, 'edge/src/*.js'):
                for m in re.finditer(r'^const\s+(\w+)\s*=\s*(?:\{\s*\}|\[\s*\]|/\*[^*]*\*/\s*null)\s*;', text, re.M):
                    if m[1] not in INJECTED_WORKER_CONSTANTS:
                        emit('public-ids', path, text.count('\n', 0, m.start()) + 1, 'unregistered Worker placeholder', fix)
        directory = Path(public) if public is not None else root / 'public'
        if not directory.is_dir():
            print('SKIP public-ids: no public/ dir')
        else:
            release = load_module('release_integrity')
            try:
                for path in release.published_files(directory):
                    if not release.is_published_file(path):
                        emit('public-ids', 'public/' + path, 1, 'file outside published allowlist', 'remove unpublished file')
            except ValueError:
                emit('public-ids', 'public', 1, 'unsafe public file or directory', 'remove symlinks and non-ordinary files')
            worker = directory / '_worker.js'
            if worker.is_file():
                text = worker.read_text()
                quality = load_module('public_library_quality')
                ids = set(quality.DOI_REVIEW) | set(quality.PDF_BINDING_HOLDS)
                hidden = root / 'config/public_library_topic_hides.json'
                if hidden.is_file():
                    ids.update(row['id'] for row in json.loads(hidden.read_text()).get('records', []))
                for identifier in sorted(ids):
                    for m in re.finditer(r'(?<![A-Za-z0-9])' + re.escape(identifier) + r'(?![A-Za-z0-9])', text):
                        emit('public-ids', 'public/_worker.js', text.count('\n', 0, m.start()) + 1, f'reviewed/hold/hidden identifier at offset {m.start()}', 'remove identifier from Worker projection', identifier)
                decoder = json.JSONDecoder()
                for m in re.finditer(r'\bconst\s+(\w+)\s*=\s*([\[{])', text):
                    if m[1] in INJECTED_WORKER_CONSTANTS:
                        continue
                    try:
                        _, length = decoder.raw_decode(text[m.start(2):])
                    except ValueError:
                        continue
                    if len(text[m.start(2):m.start(2) + length].encode()) > 200 * 1024:
                        emit('public-ids', 'public/_worker.js', text.count('\n', 0, m.start()) + 1, 'large unregistered JSON literal', fix)
    if 'feature-map-selectors' in selected:
        path = root / 'docs/feature-map.json'
        if not path.exists():
            print('SKIP feature-map-selectors: no docs/feature-map.json')
        else:
            source = '\n'.join(t for p, t in texts.items() if map_source_file(p))
            def selectors(value):
                if isinstance(value, dict):
                    if isinstance(value.get('selector'), str):
                        yield value['selector']
                    for child in value.values():
                        yield from selectors(child)
                elif isinstance(value, list):
                    for child in value:
                        yield from selectors(child)
            content = path.read_text()
            texts['docs/feature-map.json'] = content
            for selector in selectors(json.loads(content)):
                tokens = re.findall(r'#([\w-]+)|\.([\w-]+)|\[([\w-]+)', selector)
                for identifier, cls, attr in tokens:
                    token = identifier or cls or attr
                    camel = re.sub(r'-([a-z])', lambda m: m[1].upper(), token[5:]) if token.startswith('data-') else ''
                    # data-foo-bar is written as dataset.fooBar when elements are created by script.
                    present = token in source or bool(camel and 'dataset.' + camel in source)
                    if identifier:
                        present = bool(re.search(r'(?:id\s*=\s*[\'\"]' + re.escape(token) + r'[\'\"]|#' + re.escape(token) + r'\b|[\'\"]' + re.escape(token) + r'[\'\"])', source))
                    if not present:
                        line = next((i for i, s in enumerate(content.splitlines(), 1) if selector in s), 1)
                        emit('feature-map-selectors', 'docs/feature-map.json', line, f'feature map selector not found in source: {selector} (token {token})', 'update docs/feature-map.json (scripts/feature_map_walk.cjs shows the live state)')
    for i, entry in enumerate(allows):
        if entry.get('check') in selected and (not entry.get('reason', '').strip() or i not in used):
            findings.append(Finding(entry.get('check', 'config'), 'config/guardrails.json', 1, 'allow entry missing reason or matches no finding', 'remove stale entry or supply a specific reason'))
    return sorted(findings, key=lambda f: (f.path, f.line, f.check, f.rule))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only')
    parser.add_argument('--base')
    parser.add_argument('--public')
    parser.add_argument('--commit-range')
    parser.add_argument('--allow-workflows', action='store_true')
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--tracked-only', action='store_true', help='skip untracked files (what CI does)')
    parser.add_argument('files', nargs='*')
    args = parser.parse_args()
    if args.list:
        print('\n'.join(CHECKS))
        return 0
    root = Path(__file__).resolve().parents[1]
    config_path = root / 'config/guardrails.json'
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    config['allow_workflows'] = args.allow_workflows
    try:
        findings = run_checks(root, args.only, args.base, args.public, args.files, args.commit_range, config, include_untracked=not args.tracked_only)
    except (ValueError, subprocess.CalledProcessError, OSError):
        print('guardrails: invalid configuration, git reference, or unreadable input', file=sys.stderr)
        return 1
    for finding in findings:
        print(finding)
    if not findings:
        print('guardrails: all checks passed')
    return int(bool(findings))


if __name__ == '__main__':
    sys.exit(main())
