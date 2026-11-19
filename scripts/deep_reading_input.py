#!/usr/bin/env python3
"""Offline staging and bounded input verification for private daily readings."""
import argparse
from contextlib import contextmanager
from datetime import date, datetime, timedelta
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

from muse_pdf_verifier import normalized as title_key, page_has_doi, title_matches, without_margin_numbers

ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = 'data/deep-reading-input'
MAX_MANIFEST = 64 * 1024
MAX_PDF = 20 * 1024 * 1024
MAX_ITEMS = 12
MAX_TOTAL = 120 * 1024 * 1024
MAX_PAGES = 200
MAX_TEXT = 120000
PARSE_TIMEOUT = 30
ACTIVE = {'awaiting_oa', 'now_open'}
SHA = re.compile(r'[0-9a-f]{64}')
DOI = re.compile(r'10\.[0-9]{4,9}/[^\s<>?#@\\\x00-\x1f\x7f]{1,200}')
BODY_HEADING = re.compile(
    r'(\d+(?:\.\d+)*[.)]?\s+)?(introduction|background|(?:materials and )?methods'
    r'|patients and methods|results|discussion|conclusions?)(?:\s*[:.]\s*|$)', re.I)
ABSTRACT_HEADING = re.compile(r'^(?:structured\s+)?abstract(?:\s*[:.]|\s*$)', re.I)
ABSTRACT_END = re.compile(r'^(?:key\s*words?|clinical perspective)(?:\s*[:.]|\s*$)', re.I)
END_HEADING = re.compile(
    r'(?:\d+[.)]?\s+)?(?:references(?: and notes)?|bibliography|supplement(?:ary|al) (?:materials?|information))'
    r'(?:\s*[:.]|$)', re.I)


class InputError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def canonical_doi(value):
    return isinstance(value, str) and value == value.lower() and bool(DOI.fullmatch(value))


@contextmanager
def directory(path, *, parent=None, create=False):
    try:
        if create:
            try:
                os.mkdir(path, mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    except FileNotFoundError:
        raise InputError('private_pdf_missing') from None
    except OSError:
        raise InputError('private_pdf_unsafe_directory') from None
    try:
        yield fd
    finally:
        os.close(fd)


def read_regular(path, maximum, kind, *, parent=None):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise InputError(kind + '_not_regular')
            if info.st_nlink != 1:
                raise InputError(kind + '_hardlink')
            if info.st_size > maximum:
                raise InputError(kind + '_too_large')
            raw = stream.read(maximum + 1)
            final = os.fstat(stream.fileno())
            if final.st_nlink != 1:
                raise InputError(kind + '_hardlink')
            if len(raw) > maximum:
                raise InputError(kind + '_too_large')
            if len(raw) != info.st_size or final.st_size != info.st_size or final.st_mtime_ns != info.st_mtime_ns:
                raise InputError(kind + '_changed')
            return raw
    except FileNotFoundError:
        raise InputError(kind + '_missing') from None
    except OSError as exc:
        raise InputError(kind + ('_symlink' if exc.errno == errno.ELOOP else '_unreadable')) from None


def validate_manifest(obj):
    if (not isinstance(obj, dict) or set(obj) != {'schemaVersion', 'items'}
            or type(obj['schemaVersion']) is not int or obj['schemaVersion'] != 1
            or not isinstance(obj['items'], list)):
        raise InputError('private_pdf_manifest_schema')
    if len(obj['items']) > MAX_ITEMS:
        raise InputError('private_pdf_manifest_item_limit')
    entries = {}
    for item in obj['items']:
        if not isinstance(item, dict) or set(item) != {'doi', 'sha256', 'sizeBytes'}:
            raise InputError('private_pdf_manifest_fields')
        if not canonical_doi(item['doi']):
            raise InputError('private_pdf_manifest_doi')
        if not isinstance(item['sha256'], str) or not SHA.fullmatch(item['sha256']):
            raise InputError('private_pdf_manifest_sha256')
        if type(item['sizeBytes']) is not int or item['sizeBytes'] <= 0:
            raise InputError('private_pdf_manifest_size')
        if item['sizeBytes'] > MAX_PDF:
            raise InputError('private_pdf_too_large')
        if item['doi'] in entries:
            raise InputError('private_pdf_manifest_duplicate_doi')
        entries[item['doi']] = item
    if sum(item['sizeBytes'] for item in entries.values()) > MAX_TOTAL:
        raise InputError('private_pdf_manifest_total_limit')
    return entries


def unique_json(raw, code):
    def pairs(values):
        obj = dict(values)
        if len(obj) != len(values):
            raise InputError(code)
        return obj
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, RecursionError):
        raise InputError(code) from None


def read_manifest(folder, *, optional=False):
    try:
        raw = read_regular('manifest.json', MAX_MANIFEST, 'private_pdf_manifest', parent=folder)
    except InputError as exc:
        if optional and exc.code == 'private_pdf_manifest_missing':
            return {}
        raise
    return validate_manifest(unique_json(raw, 'private_pdf_manifest_json'))


@contextmanager
def input_directory(root, *, create=False):
    with directory(root) as base, directory('data', parent=base, create=create) as data:
        with directory('deep-reading-input', parent=data, create=create) as folder:
            yield folder


def verify_pdf(raw, entry, title):
    if raw.startswith(b'version https://git-lfs.github.com/spec/'):
        raise InputError('private_pdf_lfs_pointer')
    if not raw.startswith(b'%PDF-'):
        raise InputError('private_pdf_magic')
    if len(raw) != entry['sizeBytes']:
        raise InputError('private_pdf_size_mismatch')
    if hashlib.sha256(raw).hexdigest() != entry['sha256']:
        raise InputError('private_pdf_sha256_mismatch')
    if not isinstance(title, str) or not 5 <= len(title_key(title)) <= 1500:
        raise InputError('private_pdf_title_missing')
    metadata = json.dumps({'doi': entry['doi'], 'title': title}).encode()
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--parse-worker'],
                                input=metadata + b'\n' + raw, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=PARSE_TIMEOUT, check=True)
        parsed = json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        raise InputError('private_pdf_parse_timeout') from None
    except (OSError, ValueError, subprocess.CalledProcessError):
        raise InputError('private_pdf_parse_failed') from None
    if 'error' in parsed:
        raise InputError(parsed['error'])
    return parsed['paragraphs']


def read_pdf(folder, entry, title):
    with directory('pdfs', parent=folder) as pdfs:
        raw = read_regular(entry['sha256'] + '.pdf', MAX_PDF, 'private_pdf', parent=pdfs)
    return verify_pdf(raw, entry, title)


def extract_body(document, text_flags):
    paragraphs, length, section, abstract, abstract_text = [], 0, None, False, False
    for page in document:
        for block in page.get_text('blocks', sort=True, flags=text_flags):
            if block[-1] != 0:
                continue
            lines = block[4].splitlines()
            if not lines:
                continue
            line = lines[0].strip()
            if not section and (start := ABSTRACT_HEADING.match(line)):
                abstract = True
                abstract_text = bool(line[start.end():].strip() or len(lines) > 1)
                continue
            if abstract and ABSTRACT_END.match(line):
                abstract = False
                continue
            if section and END_HEADING.match(line):
                return paragraphs, length
            heading = BODY_HEADING.match(line)
            if heading:
                section_title = heading[2].capitalize()
                if abstract and not heading[1] and not (abstract_text and line.casefold() == 'introduction'):
                    continue
                abstract = False
                section = section_title
                lines[0] = line[heading.end():]
            text = ' '.join(' '.join(lines).split())
            if abstract and text:
                abstract_text = True
            if section and len(text) >= 30:
                length += len(text)
                if length > MAX_TEXT:
                    raise InputError('private_pdf_text_limit')
                paragraphs.append({'id': 'p' + str(len(paragraphs) + 1), 'section': section, 'text': text})
    return paragraphs, length


def parse_pdf(raw, doi, title):
    try:
        import pymupdf
    except ImportError:
        raise InputError('private_pdf_parser_unavailable') from None
    with pymupdf.open(stream=raw, filetype='pdf') as document:
        if document.needs_pass:
            raise InputError('private_pdf_encrypted')
        if not 1 <= document.page_count <= MAX_PAGES:
            raise InputError('private_pdf_page_limit')
        page = document[0]
        first = page.get_text()
        pattern = r'(?<![a-z0-9])' + r'\s*'.join(re.escape(c) for c in doi) + r'(?=$|\s|[,;>\])}.]+(?:\s|$))'
        if not page_has_doi(first, pattern):
            raise InputError('private_pdf_doi_mismatch')
        cleaned = None
        if 'accepted manuscript' in first.casefold():
            blocks = page.get_text('dict', flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)['blocks']
            runs = [(span['text'], span['bbox'][0], span['bbox'][1])
                    for block in blocks if block['type'] == 0
                    for line in block['lines'] for span in line['spans']]
            cleaned = without_margin_numbers(runs, page.rect.width)
        if not title_matches(first, title, cleaned):
            raise InputError('private_pdf_title_mismatch')
        paragraphs, length = extract_body(document, pymupdf.TEXTFLAGS_BLOCKS & ~pymupdf.TEXT_PRESERVE_IMAGES)
        if length < 1500:
            raise InputError('private_pdf_incomplete_body')
        return paragraphs


def worker():
    if sys.platform == 'linux':
        import resource
        memory = 768 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    try:
        meta = json.loads(sys.stdin.buffer.readline(32768))
        raw = sys.stdin.buffer.read(MAX_PDF + 1)
        result = {'paragraphs': parse_pdf(raw, meta['doi'], meta['title'])}
    except InputError as exc:
        result = {'error': exc.code}
    except Exception:
        result = {'error': 'private_pdf_parse_failed'}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))


def atomic_input(folder, name, content):
    temp = '.tmp-' + os.urandom(16).hex()
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode=0o600, dir_fd=folder)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
        os.replace(temp, name, src_dir_fd=folder, dst_dir_fd=folder)
    finally:
        try:
            os.unlink(temp, dir_fd=folder)
        except FileNotFoundError:
            pass


def manifest_bytes(entries):
    obj = {'schemaVersion': 1, 'items': [entries[key] for key in sorted(entries)]}
    validate_manifest(obj)
    raw = json.dumps(obj, ensure_ascii=True, indent=2).encode() + b'\n'
    if len(raw) > MAX_MANIFEST:
        raise InputError('private_pdf_manifest_too_large')
    return raw


def wanted_for(root):
    from daily_fulltext import check_wanted, ReadingError, DATA_PATH
    with directory(root) as base, directory('data', parent=base) as data:
        raw = read_regular(Path(DATA_PATH).name, 64 * 1024 * 1024, 'private_pdf_wanted', parent=data)
    store = unique_json(raw, 'private_pdf_wanted_json')
    try:
        wanted = store['wanted']
        check_wanted(wanted)
        items = store.get('items', [])
        published = {item['doi']: item['publishedOn'] for item in items if item.get('doi')}
    except (ReadingError, KeyError, TypeError, AttributeError):
        raise InputError('private_pdf_wanted_invalid') from None
    return {entry['doi']: entry for entry in wanted if entry['doi']}, published


def remove_unreferenced(pdfs, old, remaining):
    for sha in {entry['sha256'] for entry in old.values()} - {entry['sha256'] for entry in remaining.values()}:
        try:
            os.unlink(sha + '.pdf', dir_fd=pdfs)
        except FileNotFoundError:
            pass


def stage(root, doi, source, wanted):
    if doi not in wanted or wanted[doi]['status'] not in ACTIVE:
        raise InputError('private_pdf_not_wanted')
    raw = read_regular(source, MAX_PDF, 'private_pdf')
    sha = hashlib.sha256(raw).hexdigest()
    entry = {'doi': doi, 'sha256': sha, 'sizeBytes': len(raw)}
    verify_pdf(raw, entry, wanted[doi]['title'])
    with input_directory(root, create=True) as folder:
        old = read_manifest(folder, optional=True)
        entries = {**old, doi: entry}
        manifest = manifest_bytes(entries)
        with directory('pdfs', parent=folder, create=True) as pdfs:
            name = sha + '.pdf'
            try:
                if read_regular(name, MAX_PDF, 'private_pdf', parent=pdfs) != raw:
                    raise InputError('private_pdf_sha256_mismatch')
            except InputError as exc:
                if exc.code != 'private_pdf_missing':
                    raise
                atomic_input(pdfs, name, raw)
            atomic_input(folder, 'manifest.json', manifest)
            remove_unreferenced(pdfs, old, entries)


def check(root, wanted):
    with input_directory(root) as folder:
        entries = read_manifest(folder)
        for doi, entry in entries.items():
            if doi not in wanted:
                raise InputError('private_pdf_not_wanted')
            read_pdf(folder, entry, wanted[doi]['title'])
    return len(entries)


def prune(root, wanted, published, today):
    with input_directory(root) as folder:
        entries = read_manifest(folder)
        kept = {}
        for doi, entry in entries.items():
            status = wanted.get(doi, {}).get('status')
            when = wanted.get(doi, {}).get('publishedOn') or published.get(doi)
            if status in ACTIVE or (status == 'published' and when and date.fromisoformat(when) >= today - timedelta(days=30)):
                kept[doi] = entry
        if kept != entries:
            with directory('pdfs', parent=folder) as pdfs:
                atomic_input(folder, 'manifest.json', manifest_bytes(kept))
                remove_unreferenced(pdfs, entries, kept)
        return len(entries) - len(kept)


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise InputError('private_pdf_invalid_arguments')


def in_public_checkout(root):
    if root.is_relative_to(ROOT) or ROOT.is_relative_to(root):
        return True
    remotes = subprocess.run(['git', '-C', str(root), 'remote', '-v'], capture_output=True, text=True,
                             encoding='utf-8', errors='replace', timeout=5, check=False)
    return any(re.search(r'(?i)[:/]dodoxiaxia/xinzhi(?:\.git)?/?(?:\s|$)', line)
               for line in remotes.stdout.splitlines())


def main(argv=None):
    parser = QuietParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('stage', 'check', 'prune'):
        cmd = commands.add_parser(name)
        cmd.add_argument('--state-dir', required=True, type=Path)
        if name == 'stage':
            cmd.add_argument('--doi', required=True)
            cmd.add_argument('--pdf', required=True, type=Path)
    try:
        args = parser.parse_args(argv)
        root = args.state_dir.resolve(strict=True)
        if in_public_checkout(root):
            raise InputError('private_pdf_public_checkout')
        wanted, published = wanted_for(root)
        if args.command == 'stage':
            from daily_fulltext import doi
            key = doi(args.doi)
            if not canonical_doi(key):
                raise InputError('private_pdf_manifest_doi')
            stage(root, key, args.pdf, wanted)
            count = 1
        elif args.command == 'check':
            count = check(root, wanted)
        else:
            from daily_fulltext import SHANGHAI
            count = prune(root, wanted, published, datetime.now(SHANGHAI).date())
        print(json.dumps({'status': 'ok', 'count': count}))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({'status': 'failed', 'reason': exc.code if isinstance(exc, InputError) else 'private_pdf_state_unavailable'}))
        return 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--parse-worker']:
        worker()
    else:
        raise SystemExit(main())
