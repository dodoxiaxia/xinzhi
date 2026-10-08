"""Explicit migration from six core files to hashed, public JSON assets.

The private release receipt hashes every byte, including this public data manifest.
No wildcard is a publication permission: only declared, verified files are allowed.
"""
import hashlib
import ctypes
import json
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path

CORE = {'index.html', 'style.css', 'public.js', 'icon.svg', '_headers', '_worker.js'}
MANIFEST = 'public-data-manifest.json'
NAMES = {'FEEDS', 'RECENT_RADAR', 'RADAR'}
PATH = re.compile(r'public-data/(feeds|recent_radar|radar)\.([a-f0-9]{64})\.json\Z')


def validate_data(name, value):
    """Mirror the browser's nested schema before blessing hash-valid shards."""
    def strings(v):
        return isinstance(v, list) and all(isinstance(x, str) for x in v)
    def index(v, pool):
        return type(v) is int and 0 <= v < len(pool)
    if name == 'FEEDS':
        valid = isinstance(value, dict) and isinstance(value.get('items'), list)
        if valid:
            for p in value['items']:
                if (not isinstance(p, dict) or not all(isinstance(p.get(k), str) for k in ('id', 'title'))
                    or any(p.get(k) is not None and not isinstance(p[k], str) for k in ('summary', 'doi', 'journal', 'date', 'url', 'pmid'))
                    or (p.get('tags') is not None and not strings(p['tags']))
                    or (p.get('abstractSections') is not None and (not isinstance(p['abstractSections'], list) or any(
                        not isinstance(s, dict) or not all(isinstance(s.get(k), str) for k in ('label', 'text')) for s in p['abstractSections'])))
                    or (p.get('quantitativeMetrics') is not None and not isinstance(p['quantitativeMetrics'], dict))):
                    valid = False; break
        if not valid: raise ValueError('Invalid current data')
    elif name in {'RADAR', 'RECENT_RADAR'}:
        pools = ('jn', 'pub', 'tier', 'design', 'tag')
        valid = (isinstance(value, dict) and type(value.get('v')) is int and value['v'] == 1
                 and isinstance(value.get('rows'), list) and all(strings(value.get(k)) for k in pools))
        if valid:
            valid = all(isinstance(row, list) and len(row) == 9
                        and all(isinstance(row[i], str) for i in (0, 1, 2, 8))
                        and all(index(row[i], value[k]) for i, k in zip((3, 4, 5, 6), pools))
                        and isinstance(row[7], list) and all(index(i, value['tag']) for i in row[7]) for row in value['rows'])
            if value.get('abs') is not None:
                valid = valid and isinstance(value['abs'], dict) and all(isinstance(ab, list) and all(
                    strings(s) and len(s) == 2 for s in ab) for ab in value['abs'].values())
            valid = valid and all(value.get(k) is None or (isinstance(value[k], dict) and all(
                isinstance(v, str) for v in value[k].values())) for k in ('zh', 'dateBases'))
        if not valid: raise ValueError('Invalid archive data')
    return value


def exchange_directories(left, right):
    """Linux atomic exchange; unsupported hosts fail before changing either tree."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise OSError('Atomic public directory exchange requires Linux renameat2')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(left), -100, os.fsencode(right), 2):  # AT_FDCWD, RENAME_EXCHANGE
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(left))


@contextmanager
def staged_public(public, payloads):
    """Build a separate, validated tree. A process interruption leaves public intact."""
    public = Path(public)
    stage = Path(tempfile.mkdtemp(prefix='.public-stage-', dir=public.parent))
    stage.chmod(public.stat().st_mode & 0o777)
    try:
        for name, content in payloads.items():
            path = stage / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(content)
        if read_payloads(stage) != payloads:
            raise ValueError('Staged public outputs changed before completion; rebuild public')
        yield stage
    finally:
        # Remove only ordinary files in an explicitly validated tree. Unknown
        # concurrent additions hold cleanup; never delete a whole public tree.
        if stage.exists():
            try:
                files = read_payloads(stage, allow_partial_classic=True)
            except (ValueError, OSError):
                pass  # Leave an incomplete/changed staging tree for inspection.
            else:
                for name in files: (stage / name).unlink()
                if (stage / 'public-data').exists(): (stage / 'public-data').rmdir()
                stage.rmdir()


def publish_staged(public, stage, payloads, previous):
    if read_payloads(stage) != payloads:
        raise ValueError('Staged public outputs changed before completion; rebuild public')
    if read_payloads(public, allow_partial_classic=True) != previous:
        raise ValueError('Public outputs changed before completion; rebuild public')
    exchange_directories(public, stage)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def semantic_hash(value):
    from ci_daily import stable_data
    return hashlib.sha256(json_bytes(stable_data(value))).hexdigest()


def data_manifest(payloads):
    try:
        doc = json.loads(payloads[MANIFEST])
        if doc.get('schemaVersion') != 2 or not re.fullmatch(r'[a-f0-9]{64}', doc['version']):
            raise ValueError('Invalid public asset manifest version')
        rows = doc['files']
        names, paths = set(), set()
        if not isinstance(rows, list) or not rows:
            raise ValueError('Empty public data manifest')
        for row in rows:
            name, path = row['name'], row['path']
            match = PATH.fullmatch(path)
            if name not in NAMES or name in names or path in paths or not match or match[1] != name.lower() or match[2] != row['sha256']:
                raise ValueError('Invalid/duplicate public data allowlist entry')
            body = payloads[path]
            if type(row['bytes']) is not int or row['bytes'] != len(body) or hashlib.sha256(body).hexdigest() != row['sha256']:
                raise ValueError('Public shard bytes differ from manifest: ' + path)
            envelope = json.loads(body)
            if envelope.get('schemaVersion') != 2 or envelope.get('version') != doc['version'] or envelope.get('name') != name or 'data' not in envelope:
                raise ValueError('Mixed public data versions or roles')
            validate_data(name, envelope['data'])
            if semantic_hash(envelope['data']) != row['contentHash']:
                raise ValueError('Public shard semantic hash differs')
            names.add(name); paths.add(path)
        if 'FEEDS' not in names or ('RADAR' in names) != ('RECENT_RADAR' in names):
            raise ValueError('Incomplete public data allowlist')
        return doc
    except (KeyError, TypeError, AttributeError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError('Malformed or missing public data manifest') from exc


def expected_paths(payloads):
    # Existing classic receipts remain supported for migration and rollback.
    if MANIFEST not in payloads:
        extra=set(payloads)-CORE
        if extra: raise ValueError('Unexpected public files: '+','.join(sorted(extra)))
        if set(payloads) != CORE:
            raise ValueError('Payload must contain exactly the six public files or an explicit static data manifest')
        return CORE
    doc = data_manifest(payloads)
    expected = CORE | {MANIFEST} | {row['path'] for row in doc['files']}
    if set(payloads) != expected:
        raise ValueError('Public assets differ from explicit allowlist')
    marker='<script data-public-data-boot>window.PUBLIC_DATA_BOOT='
    html=payloads['index.html'].decode('utf-8')
    if html.count(marker)!=1:raise ValueError('Missing public bootstrap for static asset policy')
    source=html.split(marker,1)[1]
    try:boot,length=json.JSONDecoder().raw_decode(source)
    except ValueError as exc:raise ValueError('Malformed public bootstrap') from exc
    if not source[length:].startswith(';</script>') or boot.get('schemaVersion')!=2 or boot.get('version')!=doc['version'] or boot.get('assets')!=doc['files'] or boot.get('deferred')!=[row['name'] for row in doc['files']]:
        raise ValueError('Public bootstrap differs from asset manifest')
    return expected


def read_payloads(public, allow_partial_classic=False):
    public = Path(public)
    if public.is_symlink() or not public.is_dir():
        raise ValueError('Public directory must be ordinary')
    def read(path):
        fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
        with os.fdopen(fd,'rb') as stream: return stream.read()
    files = {}
    for entry in public.iterdir():
        if entry.is_symlink():
            raise ValueError('Public asset must not be a symlink')
        if entry.is_file():
            if entry.name not in CORE | {MANIFEST}:raise ValueError('Unexpected public files: '+entry.name)
            files[entry.name] = read(entry)
        elif entry.name == 'public-data' and entry.is_dir():
            if not any(entry.iterdir()):raise ValueError('Unexpected empty public data directory')
            for path in entry.iterdir():
                if path.is_symlink() or not path.is_file() or not PATH.fullmatch('public-data/' + path.name):
                    raise ValueError('Unexpected public data file or directory')
                files['public-data/' + path.name] = read(path)
        else:
            raise ValueError('Unexpected public files or directories')
    if allow_partial_classic and MANIFEST not in files and set(files).issubset(CORE):return files
    expected_paths(files)
    return files
