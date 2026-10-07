#!/usr/bin/env python3
"""Validate an explicitly reviewed revision and stage a private, local handoff.

No network, credentials, repository mutation, Actions or deployment. Inputs must
come from a trusted review service; this CLI does not prove who signed them.
"""
import argparse
import json
from pathlib import Path

from editorial_review import article_key, content_sha256, publication_date

ROOT = Path(__file__).resolve().parents[1]


def prepare(draft, output):
    key = article_key(draft)
    if not key or not publication_date(draft, key):
        raise ValueError('An approved revision and separate release request are required')
    output = Path(output).resolve()
    private = (ROOT / '.local').resolve()
    if private not in output.parents:
        raise ValueError('Handoff output must be inside this checkout .local directory')
    # Every handoff has its own directory. Never overwrite an earlier audit event.
    output.mkdir(parents=True, exist_ok=False)
    audit = {
        'schema_version': 1, 'action': 'prepare_editorial_handoff', 'key': key,
        'content_sha256': content_sha256(draft, key),
        'review_event_id': draft['review']['event_id'],
        'release_event_id': draft['publication']['event_id'],
        'published_on': draft['publication']['published_on'],
        'target_week': draft.get('target_week'),
        'stage': 'prepared', 'deployed': False,
    }
    (output / 'editorial-handoff.json').write_text(
        json.dumps(draft, ensure_ascii=False, indent=2), encoding='utf-8')
    (output / 'audit.json').write_text(
        json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
    return audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        audit = prepare(json.loads(args.input.read_text(encoding='utf-8')), args.output)
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, str(exc) + '\n')
    print(json.dumps({'stage': audit['stage'], 'deployed': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
