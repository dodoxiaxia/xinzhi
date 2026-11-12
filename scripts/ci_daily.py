#!/usr/bin/env python3
"""CI entry point: refresh sources -> fill abstracts -> translate new titles -> build public bundle -> sanity gate.

Runs on GitHub Actions (no local sqlite / .local needed). Writes `deploy=true|false` to $GITHUB_OUTPUT.
Required steps must succeed; optional steps may fail without blocking the day's update.
"""
import datetime, hashlib, json, os, re, subprocess, sys, time
from pathlib import Path

from release_integrity import PUBLIC, is_published_file, published_files

ROOT = Path(__file__).resolve().parents[1]

BUILD = ['scripts/build_public.py']
WEEK_BOARD = ['scripts/week_precompute.py']
DEEP_READING = ['scripts/daily_fulltext.py', '--run']
DEEP_READING_RECOVER = ['scripts/daily_fulltext.py', '--recover']  # model-free; push runs publish repaired drafts
WEEK_PRECOMPUTE = ['scripts/week_precompute.py', '--run', '--provider', 'configured']
DEEP_READING_TIMEOUT = 3000  # up to 24 calls plus source fetches
FAST_BUDGET_MINUTES, FULL_BUDGET_MINUTES = 60, 150  # daily.yml job timeout must exceed the full budget
ARCHIVE_RESERVE = 5400

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
    # Owner decision 2026-10-12: provider quota has ample headroom, so the paid steps are sized by
    # runner time, not by a token budget. Both stop starting new calls near XINZHI_STEP_DEADLINE.
    (['scripts/generate_quicklooks.py', '--call-model', '--limit', '120', '--lookup-limit', '240'], 3600),
    # Daily ceiling: week_precompute_budget.MAX_ATTEMPTS (repository variable XINZHI_WEEK_MAX_CALLS).
    (WEEK_PRECOMPUTE, 3000),
    (['scripts/auto_picks.py'], 120),
]
# Scheduled fast refreshes opt in (env) to one bounded title batch (<=30 newest
# missing titles, a single model call) so new daily picks get Chinese titles
# within hours instead of waiting for the next 04:47 full run. Source pushes stay model-free.
FAST_TITLES = (['scripts/translate_titles.py', '--run', '--limit', '1'], 240)
# Same opt-in: Chinese quicklooks for the newest picks (verbatim-quote and number checks unchanged),
# new weekly-board papers, and a top-up of today's full-text readings if the full run fell short.
FAST_QUICKLOOKS = (['scripts/generate_quicklooks.py', '--call-model', '--limit', '30', '--lookup-limit', '60'], 1500)
FAST_WEEK_PRECOMPUTE = (WEEK_PRECOMPUTE, 900)
FAST_DEEP_READING = (DEEP_READING, 1500)

def deep_reading_needs_bootstrap(root):
    path = root / 'data/deep-readings.json'
    if not path.exists():
        return True
    from daily_fulltext import GENERATOR_VERSION
    return json.loads(path.read_text()).get('generatorVersion', 0) < GENERATOR_VERSION
MIN_COUNTS = {'radar': 300, 'library': 1000}  # refuse to publish a collapsed build
VOLATILE_KEYS = {'createdAt', 'updatedAt', 'generatedAt', 'checkedAt', 'fetchedAt', 'weeklyAt', 'builtAt', 'radarUpdatedAt', 'healthCheckedAt', 'lastSuccessfulAt', 'lastCachedFetchAt'}
BUNDLE_DATA = re.compile(r'\bwindow\.(?:LIBRARY|FEEDS|SOURCE_HEALTH|CURATED|QUICKLOOKS|CONTENT_STATUS|JOURNAL_METRICS|WEEKLY_BOARD|PREGENERATED|RADAR|RADAR_ARCHIVE|DEEP_READINGS)\s*=\s*')


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
              'generationMode': 'cache_only' if fast else 'bounded_existing_full_step',
              'nextGenerationTrigger': 'existing_daily_full_schedule',
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


def public_file_sizes():
    """Byte size of each file the build is allowed to publish. Missing or unreadable trees yield []."""
    directory = ROOT / 'public'
    if not directory.is_dir() or directory.is_symlink():
        return []
    try:
        names = published_files(directory)
    except (OSError, ValueError):
        return []
    rows = []
    for name in names:
        if not is_published_file(name):
            continue
        path = directory / name
        if path.is_file() and not path.is_symlink():
            rows.append({'path': name, 'bytes': path.stat().st_size})
    return rows


def content_hash():
    """Hash every public asset, ignoring only known bundle refresh timestamps."""
    if not (ROOT / 'public' / 'public.js').exists():
        return ''
    digest = hashlib.sha256()
    try:
        present = published_files(ROOT / 'public')
    except (OSError, ValueError):
        present = []
    names = sorted(set(PUBLIC) | {name for name in present if is_published_file(name)})
    for name in names:
        path = ROOT / 'public' / name
        payload = path.read_bytes() if path.is_file() and not path.is_symlink() else b'<missing>'
        if name in ('public.js', 'radar.js') or name.startswith('shards/'):
            try:
                payload = stable_bundle(payload.decode('utf-8')).encode('utf-8')
            except UnicodeDecodeError:
                pass
        digest.update(name.encode() + b'\0' + str(len(payload)).encode() + b'\0' + payload)
    return digest.hexdigest()


def run(argv, timeout):
    # Paid steps read the deadline and stop starting model calls before the runner kills them.
    env = dict(os.environ, XINZHI_STEP_DEADLINE=str(time.time() + timeout))
    try:
        r = subprocess.run([sys.executable, *argv], cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=env)
        return r.returncode, r.stdout[-800:], r.stderr[-800:]
    except subprocess.TimeoutExpired:
        return 124, '', 'timeout'


def out(deploy):
    path = os.environ.get('GITHUB_OUTPUT')
    if path:
        with open(path, 'a') as f:
            f.write(f'deploy={"true" if deploy else "false"}\n')


FULL_MARKER = 'data/full-refresh-marker.json'
FULL_EARLIEST_HOUR = 5  # Beijing; the full refresh is scheduled for 04:47
# Last successful timed or full refresh; fast_refresh_gate measures the interval from it so
# model-free push deploys do not postpone the timed title/quicklook batches.
TIMED_MARKER = 'data/timed-refresh-marker.json'


def beijing_now():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))


def refresh_trigger():
    value = os.environ.get('XINZHI_TRIGGER') or 'local'
    return value if value in ('push', 'schedule', 'external', 'manual', 'local') else 'local'


def _pause_reason(scope):
    if not isinstance(scope, dict):
        return None
    paused = scope.get('paused')
    if isinstance(paused, str) and paused:
        return paused
    listed = scope.get('pauseReasons')
    if isinstance(listed, list):
        for reason in listed:
            if isinstance(reason, str) and reason:
                return reason
    tasks = scope.get('pausedTasks')
    if isinstance(tasks, dict):
        for reason in tasks.values():
            if isinstance(reason, str) and reason:
                return reason
    return None


def _count(value):
    return value if type(value) is int and value >= 0 else 0


def describe_precompute_pause(ledger, now, weekly=None):
    """Pause start, whole days, reason and coverage. None when precompute is not paused.

    ``over24h`` is true only when the pause has lasted more than 24 hours. A caller
    records that as a warning and still publishes.
    """
    if not isinstance(ledger, dict) or now.tzinfo is None:
        return None
    reason = _pause_reason(ledger)
    earliest = None
    uncertain = False
    days = ledger.get('days')
    if isinstance(days, dict):
        for daily in days.values():
            if not isinstance(daily, dict):
                continue
            if reason is None:
                reason = _pause_reason(daily)
            for row in daily.get('requests') or []:
                if not isinstance(row, dict) or row.get('status') not in ('started', 'failed_or_uncertain'):
                    continue
                uncertain = True
                if reason is None:
                    code = row.get('failureCode')
                    reason = code if isinstance(code, str) and code else 'uncertain_prior_attempt'
                stamp = row.get('at')
                if not isinstance(stamp, str):
                    continue
                try:
                    parsed = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                except ValueError:
                    continue
                if parsed.tzinfo is None:
                    continue
                if earliest is None or parsed < earliest:
                    earliest = parsed
    if reason is None and not uncertain:
        return None
    elapsed = (now - earliest).total_seconds() if earliest is not None else None
    if elapsed is not None and elapsed < 0:
        elapsed = None
    weekly = weekly if isinstance(weekly, dict) else {}
    counts = weekly.get('coverage') if isinstance(weekly.get('coverage'), dict) else {}
    return {
        'startedAt': earliest.astimezone(datetime.timezone.utc).isoformat() if earliest is not None else None,
        'days': int(elapsed // 86400) if elapsed is not None else None,
        'reason': reason or 'uncertain_prior_attempt',
        'coverage': {
            'selected': _count(weekly.get('selected')),
            'title': _count(counts.get('title')),
            'translate': _count(counts.get('translate')),
            'study': _count(counts.get('study')),
            'quicklook': _count(counts.get('quicklook')),
        },
        'over24h': elapsed is not None and elapsed > 86400,
    }


def load_precompute_ledger(root):
    try:
        value = json.loads((root / 'data/week-precompute-ledger.json').read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def note_step_summary(line):
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if not path:
        return
    with open(path, 'a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def full_refresh_decision(fast, root=ROOT, now=None):
    """Timed runs (XINZHI_DAILY_FULL_ONCE=1) do the paid full refresh exactly once per Beijing day.

    GitHub often drops the 04:47 cron (10-10: not fired an hour later), while the external
    2-hourly dispatcher is punctual. A timed fast run after 05:00 therefore catches up a missing
    full refresh, and a late scheduled full run after one already succeeded downgrades to fast.
    Pushes and manual full runs are unaffected."""
    if os.environ.get('XINZHI_DAILY_FULL_ONCE') != '1':
        return fast, None
    now = now or beijing_now()
    try:
        done = json.loads((root / FULL_MARKER).read_text()).get('day') == now.date().isoformat()
    except (OSError, ValueError, AttributeError):
        done = False
    if fast and not done and now.hour >= FULL_EARLIEST_HOUR:
        return False, 'catch_up_missing_full_refresh'
    if not fast and done:
        return True, 'full_refresh_already_done_today'
    return fast, None


def main():
    fast, full_policy = full_refresh_decision('--fast' in sys.argv)
    before = content_hash()
    budget = (FAST_BUDGET_MINUTES if fast else FULL_BUDGET_MINUTES) * 60
    deadline = time.monotonic() + budget
    report = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'runId': os.environ.get('GITHUB_RUN_ID'), 'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'codeSha': os.environ.get('GITHUB_SHA'), 'trigger': refresh_trigger(), 'fast': fast, 'changed': None, 'status': 'running', 'deploymentRequested': False, 'budgetSeconds': budget, 'beforeContentHash': before, 'steps': []}
    if full_policy:
        report['fullRefreshPolicy'] = full_policy

    def finish(status, problems=None):
        report['publicFiles'] = public_file_sizes()
        report['status'] = status
        report['problems'] = problems or []
        report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        report['trigger'] = refresh_trigger()
        pause = describe_precompute_pause(load_precompute_ledger(ROOT), datetime.datetime.fromisoformat(report['finishedAt']), report.get('weeklyContent'))
        if pause:
            report['precomputePause'] = {key: pause[key] for key in ('startedAt', 'days', 'reason', 'coverage')}
            if pause['over24h']:
                report.setdefault('warnings', [])
                if 'precompute_paused_over_24h' not in report['warnings']:
                    report['warnings'].append('precompute_paused_over_24h')
                days = pause['days'] if pause['days'] is not None else '未知'
                note_step_summary('近7天榜预生成已暂停超过 24 小时（%s 天）。这次发布不因此失败。' % days)
        report['deploymentRequested'] = status == 'success' and (report['changed'] or not fast)
        if status == 'success' and not fast:
            # Saved with data/ in state only when the run deploys; a failed run stays retryable today.
            (ROOT / FULL_MARKER).write_text(json.dumps({'day': beijing_now().date().isoformat(), 'runId': report['runId'],
                                                         'finishedAt': report['finishedAt']}))
        if status == 'success' and (not fast or os.environ.get('XINZHI_FAST_TITLE_BATCH') == '1'):
            (ROOT / TIMED_MARKER).write_text(json.dumps({'startedAt': report['startedAt'], 'runId': report['runId']}))
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
    # Daily readings run before archive enrichment. Bootstrap the new column once;
    # later fast refreshes read its persisted cache without paid model calls.
    timed_fast = fast and os.environ.get('XINZHI_FAST_TITLE_BATCH') == '1'
    if not fast or deep_reading_needs_bootstrap(ROOT):
        execute(DEEP_READING, DEEP_READING_TIMEOUT, optional=True, reserve=600)
    elif timed_fast:
        execute(*FAST_DEEP_READING, optional=True, reserve=600)  # exits at once when today's target is met
    else:
        execute(DEEP_READING_RECOVER, 120, optional=True, reserve=600)
    if timed_fast:
        execute(*FAST_TITLES, optional=True, reserve=300)
        execute(*FAST_QUICKLOOKS, optional=True, reserve=300)
        execute(*FAST_WEEK_PRECOMPUTE, optional=True, reserve=300)
    if not fast:
        for argv, t in FULL_OPTIONAL:
            # Archive enrichment leaves an hour for the paid steps after it.
            reserve = (300 if argv[0] in ('scripts/week_precompute.py', 'scripts/auto_picks.py') else
                       ARCHIVE_RESERVE if argv[0] in ('scripts/fetch_archive.py', 'scripts/archive_details.py') else 900)
            execute(argv, t, optional=True, reserve=reserve)

    code = execute(WEEK_BOARD, 180, build=True)
    if code:
        return finish('failed', ['weekly public-abstract board failed'])
    try:
        report['precompute'] = record_precompute_pending(ROOT)
    except (ValueError, TypeError, KeyError, OSError, AttributeError) as exc:
        return finish('failed', ['public precompute queue failed: ' + type(exc).__name__])
    code = execute(BUILD, 300, build=True)
    if code:
        return finish('failed', ['public build failed'])

    # sanity gate
    problems = []
    try:
        names = set(published_files(ROOT / 'public')) if (ROOT / 'public').is_dir() else set()
    except ValueError as exc:
        problems.append(str(exc))
        names = set()
    missing = PUBLIC - names
    extra = {name for name in names if not is_published_file(name)}
    if missing or extra:
        problems.append(f'public files differ: {sorted(missing | extra)}')
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
    report['weeklyContent']['generationStep'] = ({'outcome': 'not_requested_fast', 'exitCode': None} if fast and generation is None else
        {'outcome': 'not_reached', 'exitCode': None} if generation is None else
        {'outcome': generation.get('outcome') or ('returned_without_generation_guarantee' if generation['exitCode'] == 0 else 'failed'),
         'exitCode': generation['exitCode']})
    from daily_fulltext import public_readings
    reading_path = ROOT / 'data/deep-readings.json'
    report['deepReadings'] = public_readings(json.loads(reading_path.read_text()) if reading_path.exists() else None)['status']
    print('WEEKLY CONTENT:', json.dumps({key: value for key, value in report['weeklyContent'].items() if key != 'pending'}, ensure_ascii=False), flush=True)
    changed = content_hash() != before
    report['changed'] = changed
    report['afterContentHash'] = content_hash()
    print('fast' if fast else 'full', 'changed' if changed else 'unchanged', flush=True)
    return finish('success')


if __name__ == '__main__':
    sys.exit(main())
