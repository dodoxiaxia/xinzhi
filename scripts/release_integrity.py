"""Offline build provenance and preflight for the six-file manual release."""
import ast
import datetime
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

PUBLIC = {'index.html', 'style.css', 'public.js', 'icon.svg', '_headers', '_worker.js'}
MAX_BUILD_AGE = datetime.timedelta(hours=6)
INPUTS = (
    'scripts/ci_daily.py',
    'scripts/public_precompute_pending.py', 'data/public-precompute-pending.json',
    'editorial/sol-public-abstract-20261008-gap/sources.json',
    'editorial/sol-public-abstract-20261008-gap/gap-cache.json',
    'editorial/sol-public-abstract-20261008b-gap/sources.json',
    'editorial/sol-public-abstract-20261008b-gap/gap-cache.json',
    '.github/workflows/fulltext.yml', 'scripts/fulltext_queue_runner.cjs',
    'workers/cron-dispatch/index.js', 'workers/cron-dispatch/wrangler.toml',
    'scripts/check_fulltext_dispatcher.py',
    'scripts/publication_dates.py',
    'scripts/public_library_quality.py',
    'scripts/apply_public_library.py',
    'editorial/public_library_snapshot.json', 'editorial/public_library_snapshot_manifest.json',
    'index.html', 'app.js', 'citation-export.js', 'style.css', 'icon.svg', 'edge/_worker.js',
    'journal-metrics.js', 'config/journal-metrics.json', 'scripts/journal_metrics.py',
    'scripts/build_public.py', 'scripts/release_integrity.py', 'scripts/enrich_metadata.py',
    'scripts/publication_status.py', 'config/publication-status.json',
    'scripts/editorial_review.py', 'scripts/refresh_feeds.py', 'scripts/build_data.py',
    'scripts/source_fallbacks.py', 'editorial/legacy_published_guides.json', 'data/pubmed.json',
    'scripts/sync_public_library.py', 'config/public_library_adjudications.json',
    'data/candidates.json', 'data/library.json', 'data/source-health.json',
    'data/curated-archive.json', 'editorial/source_checked_drafts.json',
    'data/translations.json', 'data/media.json', 'data/picks.json',
    'data/radar-archive.json', 'data/archive-full.json', 'data/quicklooks.json',
    'data/weekly-board.json', 'scripts/week_precompute.py', 'scripts/validate_week_precompute.cjs', 'scripts/auto_picks.py',
    'scripts/week_precompute_cache.py', 'scripts/week_precompute_budget.py',
    'scripts/week_precompute_checkpoint.py', 'scripts/week_precompute_ci.py',
    'scripts/week_precompute_usage.py',
    'editorial/public_title_translations.json',
    'editorial/public_content_corrections.json', 'scripts/public_content_corrections.py',
    'scripts/public_editorial_overlay.py', 'scripts/preview_sol_public_overlay.py',
    'editorial/sol-public-abstract-20261007/sources.json',
    'editorial/sol-public-abstract-20261007/corrected-cache.json',
    'scripts/abstract_quality.py', 'editorial/public_abstract_evidence.json',
)


def ordinary_file(root, relative):
    root = Path(root)
    path = root
    for part in Path(relative).parts:
        path /= part
        if path.is_symlink():
            raise ValueError('Release input must not be a symlink: ' + relative)
    if path.exists() and not path.is_file():
        raise ValueError('Release input must be an ordinary file: ' + relative)
    return path


def input_hash(root, name):
    path = ordinary_file(root, name)
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def input_hashes(root):
    """Include absent optional inputs so newly added data also invalidates a build."""
    return {name: input_hash(root, name) for name in INPUTS}


def replace_unchanged_input(root, name, content, expected_hash):
    """Stage an input rewrite and reject changes observed just before replacement.

    This is an optimistic check, not atomic compare-and-swap against other writers.
    """
    path = ordinary_file(root, name)
    staged = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name + '-', delete=False) as stream:
            staged = Path(stream.name)
            stream.write(content)
        if input_hash(root, name) != expected_hash:
            raise ValueError('Build input changed before archive rewrite: ' + name)
        os.replace(staged, path)
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)


def code_sha(root):
    """Do not mistake a parent checkout for a source archive's own repository."""
    if not (Path(root) / '.git').exists():
        return None
    result = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'],
                            capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise ValueError('Cannot identify release checkout')
    return result.stdout.strip()


def provenance(root):
    return {'schema': 1, 'codeSha': code_sha(root), 'inputs': input_hashes(root)}


def source_release(root):
    """Read the version without importing or executing the builder."""
    tree = ast.parse(ordinary_file(root, 'scripts/build_public.py').read_text(encoding='utf-8'))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'RELEASE' for t in node.targets):
            value = ast.literal_eval(node.value)
            if isinstance(value, str) and value:
                return value
    raise ValueError('Builder release is missing')


def require_fresh_timestamp(value, label, now):
    timestamp = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError(label + ' time must include a timezone')
    age = now - timestamp
    if age > MAX_BUILD_AGE or age < -datetime.timedelta(minutes=5):
        raise ValueError(label + ' is stale or future-dated; refresh inputs and rebuild public')


def validate_release(root, payloads, now=None):
    """Fail before archives are replaced; validate the exact bytes to be packaged."""
    try:
        manifest = json.loads(ordinary_file(root, 'docs/public-manifest.json').read_text(encoding='utf-8'))
        release = source_release(root)
        if manifest.get('release') != release:
            raise ValueError('Manifest release differs from current builder; rebuild public')
        status = manifest.get('contentStatus', {})
        if status.get('release') != release or status.get('builtAt') != manifest.get('createdAt'):
            raise ValueError('Manifest content version or build time is inconsistent; rebuild public')
        now = now or datetime.datetime.now(datetime.timezone.utc)
        require_fresh_timestamp(manifest['createdAt'], 'Public build', now)
        # Rebuilding yesterday's state must not masquerade as current source evidence.
        for field in ('radarUpdatedAt', 'healthCheckedAt'):
            require_fresh_timestamp(status[field], field, now)
        rows = manifest['files']
        if not isinstance(rows, list) or len(rows) != len(PUBLIC) or {r['path'] for r in rows} != PUBLIC:
            raise ValueError('Manifest must identify exactly the six public files')
        if set(payloads) != PUBLIC:
            raise ValueError('Payload must contain exactly the six public files')
        for row in rows:
            content = payloads[row['path']]
            if type(row['bytes']) is not int or row['bytes'] != len(content) or row['sha256'] != hashlib.sha256(content).hexdigest():
                raise ValueError('Public bytes differ from manifest: ' + row['path'])
        if manifest.get('buildProvenance') != provenance(root):
            raise ValueError('Build provenance is missing or inputs/checkout changed; rebuild public')
        return manifest
    except (OSError, KeyError, TypeError, AttributeError, SyntaxError) as exc:
        raise ValueError('Release manifest or source is missing/malformed; rebuild public') from exc
