#!/usr/bin/env python3
"""CI entry point: refresh sources -> fill abstracts -> translate new titles -> build public bundle -> sanity gate.

Runs on GitHub Actions (no local sqlite / .local needed). Writes `deploy=true|false` to $GITHUB_OUTPUT.
Required steps must succeed; optional steps may fail without blocking the day's update.
"""
import datetime, hashlib, json, os, re, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = {'index.html', 'style.css', 'public.js', 'icon.svg', '_headers', '_worker.js'}

REQUIRED = [
    ['scripts/apply_public_library.py'],
    ['scripts/refresh_feeds.py', '--all'],
    ['scripts/fetch_pubmed.py'],
    ['scripts/merge_candidates.py'],
]
LIGHT_OPTIONAL = [(['scripts/media_signals.py'], 300), (['scripts/auto_picks.py'], 120)]
FULL_OPTIONAL = [  # (argv, timeout seconds); enrich before generating quicklooks
    (['scripts/fetch_archive.py', '--incremental'], 1500),
    (['scripts/archive_details.py', '--fill'], 1800),
    (['scripts/translate_titles.py', '--run', '--limit', '60'], 900),
    (['scripts/auto_picks.py'], 120),
]
BUILD = ['scripts/build_public.py']
WEEK_BOARD = ['scripts/week_precompute.py']
WEEK_CONSUMER = ['scripts/week_precompute.py', '--run', '--provider', 'configured',
                 '--attempt-limit', '8', '--pending-only', '--paper-limit', '3']
MIN_COUNTS = {'radar': 300, 'library': 1000}  # refuse to publish a collapsed build
VOLATILE_KEYS = {'createdAt', 'updatedAt', 'generatedAt', 'checkedAt', 'fetchedAt', 'weeklyAt', 'builtAt', 'radarUpdatedAt', 'healthCheckedAt', 'lastSuccessfulAt', 'lastCachedFetchAt'}
BUNDLE_DATA = re.compile(r'\bwindow\.(?:LIBRARY|FEEDS|SOURCE_HEALTH|CURATED|QUICKLOOKS|CONTENT_STATUS|JOURNAL_METRICS|WEEKLY_BOARD|PREGENERATED|RADAR)\s*=\s*')


def stable_data(value):
    """Remove refresh metadata, preserving article dates, text and list order."""
    if isinstance(value, dict):
        return {k: stable_data(v) for k, v in value.items() if k not in VOLATILE_KEYS}
    if isinstance(value, list):
        return [stable_data(v) for v in value]
    return value


def stable_bundle(text):
    """Normalize only JSON data assignments; application JavaScript stays exact."""
    decoder = json.JSONDecoder()
    pieces, cursor = [], 0
    for match in BUNDLE_DATA.finditer(text):
        if match.start() < cursor:
            continue
        # The builder emits these constants before app.js, separated by semicolons.
        # Stop at application code so quoted examples and templates stay untouched.
        if text[cursor:match.start()].strip(' \t\r\n;'):
            break
        try:
            value, length = decoder.raw_decode(text[match.end():])
        except ValueError:
            continue
        end = match.end() + length
        if not text[end:].lstrip().startswith(';'):
            continue
        pieces.extend([text[cursor:match.end()], json.dumps(stable_data(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))])
        cursor = end
    pieces.append(text[cursor:])
    return ''.join(pieces)


def weekly_content_status(text, counts, fast):
    """Inspect published constants, never call a model or infer ready from selection."""
    decoder, cursor, values = json.JSONDecoder(), 0, {}
    for match in BUNDLE_DATA.finditer(text):
        if match.start() < cursor:
            continue
        if text[cursor:match.start()].strip(' \t\r\n;'):
            break
        value, length = decoder.raw_decode(text[match.end():])
        end = match.end() + length
        if not text[end:].lstrip().startswith(';'):
            raise ValueError('weekly public constants malformed')
        name = match.group().split('.')[1].split('=')[0].strip()
        if name in ('WEEKLY_BOARD', 'PREGENERATED'):
            if name in values:
                raise ValueError('duplicate weekly public constant')
            values[name] = value
        cursor = end
    policy = {'name': 'publish_valid_content_with_explicit_pending',
              'generationMode': 'bounded_existing_configured_consumer',
              'nextGenerationTrigger': 'existing_refresh_workflow',
              'automaticGenerationOnPageLoad': False}
    board = values.get('WEEKLY_BOARD')
    if board is None:
        if counts.get('weekly_board', 0) or any(counts.get('weekly_precomputed', {}).values()):
            raise ValueError('prepared weekly content missing from public bundle')
        return {'status': 'unavailable', 'selected': 0, 'pending': [], 'publicationPolicy': policy}
    if not isinstance(board, dict) or not isinstance(board.get('items'), list):
        raise ValueError('invalid public weekly board')
    if not isinstance(board.get('window', {}), dict):
        raise ValueError('invalid weekly coverage window')
    rows, mapping = board['items'], values.get('PREGENERATED')
    if len(rows) > 30 or not isinstance(mapping, dict):
        raise ValueError('invalid public precomputed mapping')
    tasks = {'translate': 'translation', 'study': 'study', 'quicklook': 'quicklook'}
    coverage = dict.fromkeys(('title', *tasks), 0)
    pending, seen, ready, partial, core_ready = [], set(), 0, 0, 0
    for row in rows:
        if not isinstance(row, dict) or row.get('paperID') in seen:
            raise ValueError('invalid weekly coverage identity')
        paper_id, source_hash = row.get('paperID'), row.get('sourceHash')
        if not isinstance(paper_id, str) or not paper_id or not re.fullmatch('[a-f0-9]{64}', source_hash or ''):
            raise ValueError('invalid weekly coverage source')
        seen.add(paper_id)
        present = {task: bool(row.get(field)) for task, field in tasks.items()}
        missing = [task for task in tasks if not present[task]]
        expected_status = 'ready' if not missing else 'partial' if any(present.values()) else 'pending'
        if row.get('allowAutomaticGeneration') is not False:
            raise ValueError('weekly page-load generation policy differs')
        if row.get('precomputeStatus') != expected_status or row.get('missingTasks') != missing:
            raise ValueError('weekly ready claim differs from actual fields')
        keys = (['pmid:' + str(row['pmid'])] if row.get('pmid') else []) + (['doi:' + str(row['doi']).lower()] if row.get('doi') else [])
        if not keys:
            raise ValueError('weekly public alias missing')
        for key in keys:
            entry = mapping.get(key)
            if not isinstance(entry, dict) or not isinstance(entry.get('meta'), dict):
                raise ValueError('weekly public mapping missing')
            if entry['meta'].get('paperID') != paper_id or entry['meta'].get('sourceHash') != source_hash:
                raise ValueError('weekly public mapping source mismatch')
            if any(entry.get(field) != row.get(field) for field in tasks.values()):
                raise ValueError('weekly prepared fields differ from public mapping')
        coverage['title'] += bool(row.get('titleZh'))
        for task in tasks:
            coverage[task] += present[task]
        ready += not missing
        partial += expected_status == 'partial'
        core_ready += bool(row.get('titleZh')) and present['translate'] and present['quicklook']
        missing_fields = (['title'] if not row.get('titleZh') else []) + missing
        if missing_fields:
            pending.append({'paperID': paper_id, 'sourceHash': source_hash, 'missingFields': missing_fields})
    if board.get('coverage') != coverage or counts.get('weekly_precomputed', coverage) != coverage or counts.get('weekly_board', len(rows)) != len(rows):
        raise ValueError('weekly coverage counts differ from published fields')
    return {'status': 'empty' if not rows else 'partial' if pending else 'complete',
            'selected': len(rows), 'coverage': coverage, 'fullyPreparedPapers': ready,
            'titleTranslationQuicklookPreparedPapers': core_ready,
            'partialPapers': partial, 'pendingPapers': len(rows) - ready - partial,
            'pending': pending, 'window': {key: board.get('window', {}).get(key) for key in ('start', 'end', 'days', 'timezone')},
            'publicationPolicy': policy}


def record_precompute_pending(root):
    """Persist a finite source-bound queue via the existing state save, without generation."""
    from public_precompute_pending import pending_manifest
    from public_editorial_overlay import DIRECTORY, SUPPLEMENTS
    from week_precompute import atomic
    board_path = root / 'data/weekly-board.json'
    if not board_path.exists():
        return {'status': 'unavailable', 'contentComplete': False}
    board = json.loads(board_path.read_text())
    cache_path = root / 'data/week-precompute-cache.json'
    caches = [json.loads(cache_path.read_text())] if cache_path.exists() else []
    prior_sources = []
    for directory in (DIRECTORY, *(directory for directory, _ in SUPPLEMENTS)):
        path = root / directory / 'sources.json'
        if path.exists():
            prior_sources.append(json.loads(path.read_text()))
    pending = pending_manifest(board, caches, prior_sources)
    atomic(root / 'data/public-precompute-pending.json', pending)
    return {key: pending[key] for key in ('selected', 'coverage', 'pendingPapers', 'contentComplete', 'studyMissing')} | {
        'status': 'empty' if not pending['selected'] else 'complete' if pending['contentComplete'] else 'pending',
        'contentComplete': bool(pending['selected'] and pending['contentComplete']),
        'reasonCounts': {reason: sum(item['reason'] == reason for item in pending['items']) for reason in sorted({item['reason'] for item in pending['items']})},
        'queuePath': 'data/public-precompute-pending.json', 'externalModelApiRequests': 0,
        'runtimeCacheWrites': 0, 'ledgerWrites': 0}


def content_hash():
    """Hash every public asset, ignoring only known bundle refresh timestamps."""
    if not (ROOT / 'public' / 'public.js').exists():
        return ''
    digest = hashlib.sha256()
    for name in sorted(PUBLIC):
        path = ROOT / 'public' / name
        payload = path.read_bytes() if path.exists() else b'<missing>'
        if name == 'public.js':
            payload = stable_bundle(payload.decode('utf-8')).encode('utf-8')
        digest.update(name.encode() + b'\0' + str(len(payload)).encode() + b'\0' + payload)
    return digest.hexdigest()


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
    fast = '--fast' in sys.argv
    before = content_hash()
    budget = (25 if fast else 50) * 60
    deadline = time.monotonic() + budget
    report = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'runId': os.environ.get('GITHUB_RUN_ID'), 'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'codeSha': os.environ.get('GITHUB_SHA'), 'fast': fast, 'changed': None, 'status': 'running', 'deploymentRequested': False, 'budgetSeconds': budget, 'beforeContentHash': before, 'steps': []}

    def finish(status, problems=None):
        report['status'] = status
        report['problems'] = problems or []
        report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        report['deploymentRequested'] = status == 'success' and (report['changed'] or not fast)
        (ROOT / 'docs').mkdir(exist_ok=True)
        (ROOT / 'docs/last-refresh.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        out(report['deploymentRequested'])
        return 0 if status == 'success' else 1

    def log(argv, code, so, se, optional):
        report['steps'].append({'script': ' '.join(argv), 'exitCode': code, 'optional': optional, 'tail': so[-300:], 'error': se[-300:]})
        print(('OK  ' if code == 0 else 'FAIL') + ' ' + ' '.join(argv), flush=True)
        if code:
            print(se, file=sys.stderr)

    def execute(argv, timeout, optional=False, build=False, reserve=300):
        # Keep time for the build and, in full mode, model enrichment after archives.
        remaining = int(deadline - time.monotonic() - (0 if build else reserve))
        if remaining <= 0:
            if optional:
                report['steps'].append({'script': ' '.join(argv), 'exitCode': None, 'optional': True, 'outcome': 'skipped', 'reason': 'pipeline time budget'})
                return 0
            log(argv, 124, '', 'pipeline time budget exhausted', False)
            return 124
        code, so, se = run(argv, min(timeout, remaining))
        log(argv, code, so, se, optional)
        return code

    for argv in REQUIRED:
        code = execute(argv, 1200)
        if code:
            return finish('failed', ['required step failed: ' + ' '.join(argv)])
    for argv, t in LIGHT_OPTIONAL:
        execute(argv, t, optional=True, reserve=300 if fast else 900)
    if not fast:
        for argv, t in FULL_OPTIONAL:
            reserve = 300 if argv[0] in ('scripts/week_precompute.py', 'scripts/auto_picks.py') else 900
            execute(argv, t, optional=True, reserve=reserve)

    code = execute(WEEK_BOARD, 180, build=True)
    if code:
        return finish('failed', ['weekly public-abstract board failed'])
    try:
        report['precompute'] = record_precompute_pending(ROOT)
    except (ValueError, TypeError, KeyError, OSError, AttributeError) as exc:
        return finish('failed', ['public precompute queue failed: ' + type(exc).__name__])
    # One finite consumer in both existing refresh modes. Reuse current cache and
    # reviewed overlays before reserving; never run the former full-only pass too.
    execute(WEEK_CONSUMER, 600, optional=True, reserve=480)
    try:
        path = ROOT / 'data/weekly-board.json'
        generation_run = json.loads(path.read_text()).get('run', {}) if path.exists() else {}
        report['precomputeGeneration'] = generation_run if 'consumer' in generation_run else {'blocker': 'generation_report_unavailable'}
    except (ValueError, OSError):
        report['precomputeGeneration'] = {'blocker': 'generation_report_unreadable'}
    # Include successful siblings after a provider/validator failure, then persist
    # remaining gaps. A timed-out process/uncertain lock stays fail-closed.
    code = execute(WEEK_BOARD, 180, build=True)
    if code:
        return finish('failed', ['weekly post-consumer board failed'])
    try:
        report['precompute'] = record_precompute_pending(ROOT)
    except (ValueError, TypeError, KeyError, OSError, AttributeError) as exc:
        return finish('failed', ['post-consumer queue failed: ' + type(exc).__name__])
    code = execute(BUILD, 300, build=True)
    if code:
        return finish('failed', ['public build failed'])

    # sanity gate
    problems = []
    names = {p.name for p in (ROOT / 'public').iterdir()} if (ROOT / 'public').is_dir() else set()
    if names != PUBLIC:
        problems.append(f'public files differ: {sorted(names ^ PUBLIC)}')
    try:
        counts = json.loads((ROOT / 'docs/public-manifest.json').read_text()).get('counts', {})
        for k, v in MIN_COUNTS.items():
            if counts.get(k, 0) < v:
                problems.append(f'{k} count too low: {counts.get(k)}')
    except Exception as e:  # noqa
        problems.append(f'manifest unreadable: {e}')
    if problems:
        print('SANITY FAILED:', problems, file=sys.stderr)
        return finish('failed', problems)
    try:
        report['weeklyContent'] = weekly_content_status((ROOT / 'public/public.js').read_text(), counts, fast)
    except (ValueError, TypeError, KeyError, OSError) as exc:
        return finish('failed', ['weekly coverage integrity failed: ' + str(exc)])
    if report['weeklyContent']['status'] != 'complete':
        report['warnings'] = ['weekly_precompute_' + report['weeklyContent']['status']]
    generation = next((step for step in report['steps'] if step['script'].startswith('scripts/week_precompute.py --run ')), None)
    report['weeklyContent']['generationStep'] = ({'outcome': 'not_reached', 'exitCode': None} if generation is None else
        {'outcome': generation.get('outcome') or ('returned_without_generation_guarantee' if generation['exitCode'] == 0 else 'failed'),
         'exitCode': generation['exitCode']})
    print('WEEKLY CONTENT:', json.dumps({key: value for key, value in report['weeklyContent'].items() if key != 'pending'}, ensure_ascii=False), flush=True)
    changed = content_hash() != before
    report['changed'] = changed
    report['afterContentHash'] = content_hash()
    print('fast' if fast else 'full', 'changed' if changed else 'unchanged', flush=True)
    return finish('success')


if __name__ == '__main__':
    sys.exit(main())
