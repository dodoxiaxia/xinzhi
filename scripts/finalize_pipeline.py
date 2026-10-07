#!/usr/bin/env python3
"""Record observed CI outcomes; a refresh decision never implies deployment."""
import argparse
import datetime
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def make_status(root, *, refresh_outcome, deployment_outcome, state_outcome,
                deployment_requested, run_url, code_sha, run_attempt=''):
    requested = deployment_requested == 'true'
    deployed = requested and refresh_outcome == 'success' and deployment_outcome == 'success'
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    status = {
        'recordedAt': now,
        'recordKind': 'deployment_snapshot' if state_outcome == 'pending' else 'pipeline_final',
        'runUrl': run_url,
        'runAttempt': run_attempt,
        'codeSha': code_sha,
        'refreshOutcome': refresh_outcome or 'unknown',
        'deploymentRequested': requested,
        'deploymentOutcome': deployment_outcome or 'unknown',
        'stateOutcome': state_outcome or 'unknown',
        'deployed': deployed,
        'status': 'deployed' if deployed else ('not_requested' if refresh_outcome == 'success' and not requested else 'failed'),
    }
    built_this_attempt = False
    warnings = []
    for name, field in [('last-refresh.json', 'refresh'), ('public-manifest.json', 'build')]:
        path = root / 'docs' / name
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            status[field] = ({key: data[key] for key in ('runId', 'runAttempt', 'codeSha', 'startedAt', 'finishedAt', 'fast', 'changed', 'status', 'afterContentHash', 'problems') if key in data}
                             if field == 'refresh' else {key: data[key] for key in ('release', 'createdAt', 'counts', 'files') if key in data})
            if field == 'refresh':
                expected_run = run_url.rstrip('/').rsplit('/', 1)[-1]
                current = bool(expected_run and run_attempt and code_sha and
                               data.get('runId') == expected_run and
                               data.get('runAttempt') == run_attempt and
                               data.get('codeSha') == code_sha)
                status[field]['currentAttempt'] = current
                built_this_attempt = current and any(step.get('script') == 'scripts/build_public.py' and step.get('exitCode') == 0 for step in data.get('steps', []))
                if current:
                    for step in data.get('steps', []):
                        if step.get('optional') and (step.get('outcome') == 'skipped' or step.get('exitCode') not in (None, 0)):
                            warnings.append({'code': 'optional_step_skipped' if step.get('outcome') == 'skipped' else 'optional_step_failed',
                                             'script': step.get('script', '')})
                    try:
                        health = json.loads((root / 'data/source-health.json').read_text(encoding='utf-8'))
                        checked = datetime.datetime.fromisoformat(health['checkedAt'])
                        started = datetime.datetime.fromisoformat(data['startedAt'])
                        if checked >= started:
                            sources = health['sources']
                            failed = sum(source.get('ok') is not True for source in sources)
                            status['sourceHealth'] = {'checkedAt': health['checkedAt'], 'total': len(sources),
                                                      'succeeded': len(sources) - failed, 'failed': failed}
                            if failed:
                                warnings.append({'code': 'source_fetch_failures', 'count': failed})
                    except (OSError, ValueError, KeyError, TypeError):
                        pass
            else:
                status[field]['currentAttempt'] = built_this_attempt
        except (OSError, ValueError):
            status[field] = {'available': False}
    if deployed and state_outcome not in ('success', 'pending'):
        warnings.append({'code': 'state_save_incomplete'})
    # Pages acceptance remains a separate fact from end-to-end pipeline health.
    status['pipelineStatus'] = ('failed' if status['status'] == 'failed' else
                                'pending' if state_outcome == 'pending' else
                                'degraded' if warnings else 'healthy')
    status['warnings'] = warnings
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('refresh-outcome', 'deployment-outcome', 'state-outcome', 'deployment-requested', 'run-url', 'code-sha', 'run-attempt'):
        parser.add_argument('--' + name, default='')
    args = parser.parse_args()
    status = make_status(ROOT, **vars(args))
    (ROOT / 'docs').mkdir(exist_ok=True)
    (ROOT / 'docs' / 'deployment-status.json').write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: status[key] for key in ('status', 'pipelineStatus', 'deployed', 'deploymentOutcome', 'stateOutcome', 'warnings', 'runUrl')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
