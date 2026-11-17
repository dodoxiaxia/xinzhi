#!/usr/bin/env python3
"""Append reviewed model tags to the editorial overlay, or remove one batch.

Model rows with abstain=true, empty modelTags, or confidence=low are treated
as abstentions and are not written.
"""
import argparse
import collections
import importlib.util
import json
import subprocess
import sys
from pathlib import Path


def load_vocab(repo):
    path = repo / 'scripts' / 'enrich_metadata.py'
    spec = importlib.util.spec_from_file_location('enrich_metadata_for_overlay', path)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    spec.loader.exec_module(module)
    return set(module.TOPIC_VOCAB)


def is_abstention(row):
    """Return True when a model row must not be written to the overlay."""
    tags = row.get('modelTags') or []
    if row.get('abstain') is True or not tags:
        return True
    confidence = str(row.get('confidence') or '').strip().lower()
    return confidence == 'low'


def metadata(batch, batch_id, state_sha, code_sha):
    prefix = f'batch{batch}'
    if batch == '2':
        note = '第2批：有摘要但正则为空；模型输出经抽核（30/30）后以 machine_reviewed 写入；弃权不写'
    else:
        note = '第3批：仅题名；模型输出经抽核（28/30，补充心源性休克、肺动脉压传感器、机械循环支持归心衰/心肌的规则后全批重跑）以 machine_reviewed 写入；弃权不写；仅题名条目的标签均经人工抽核口径确认；confidence=low 的结果一律不写入'
    return {
        prefix + 'BatchId': batch_id,
        prefix + 'Model': 'gemini-4-hydrogen-high',
        prefix + 'OfficialState': state_sha,
        prefix + 'CodeShaForExtractTags': code_sha,
        prefix + 'Note': note,
    }


def append_json_members(raw_text, key, members):
    """Insert members before a known closing array/object while preserving old bytes."""
    pos = raw_text.rfind(']') if key == 'items' else raw_text.rfind('}')
    if pos < 0:
        raise ValueError(f'cannot locate closing delimiter for {key}')
    prefix = raw_text[:pos].rstrip()
    suffix = raw_text[pos:]
    indent = '    ' if key == 'items' else '  '
    encoded = ',\n'.join(
        indent + json.dumps(x, ensure_ascii=False, indent=2).replace('\n', '\n' + indent)
        for x in members
    )
    if prefix.rstrip().endswith('[') or prefix.rstrip().endswith('{'):
        insertion = '\n' + encoded + '\n  ' if key == 'items' else '\n' + encoded + '\n'
    else:
        insertion = ',\n' + encoded + ('\n  ' if key == 'items' else '\n')
    return prefix + insertion + suffix


def collect_writes(rows, existing, vocab, batch_id, fields):
    """Select overlay additions from model output. Low-confidence rows are abstentions."""
    keys = {(x.get('doi', '').strip().lower(), x.get('id', '').strip()) for x in existing}
    counts, additions = collections.Counter(), []
    abstentions = skipped = 0
    for row in rows:
        tags = row.get('modelTags') or []
        if is_abstention(row):
            abstentions += 1
            continue
        if (
            not isinstance(tags, list)
            or len(set(tags)) != len(tags)
            or len(tags) > 4
            or any(t not in vocab for t in tags)
        ):
            raise ValueError(f"invalid modelTags at {row.get('sid')}: {tags}")
        doi, paper_id = (row.get('doi') or '').strip().lower(), (row.get('id') or '').strip()
        if any((doi and doi == d) or (paper_id and paper_id == i) for d, i in keys):
            skipped += 1
            continue
        item = {
            'id': row.get('id', ''),
            'doi': row.get('doi', ''),
            'pmid': row.get('pmid', ''),
            'tags': tags,
            'tagOrigin': 'machine_reviewed',
            'batchId': batch_id,
            'model': 'gemini-4-hydrogen-high',
            'inputHash': row.get('inputHash', ''),
            'inputFields': fields,
            'sampleId': row.get('sid', ''),
        }
        additions.append(item)
        keys.add((doi, paper_id))
        counts.update(tags)
    return {
        'written': len(additions),
        'abstained': abstentions,
        'skipped': skipped,
        'additions': additions,
        'perTag': dict(sorted(counts.items())),
    }


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--batch', choices=['2', '3'])
    p.add_argument('--model-output', type=Path)
    p.add_argument('--overlay', type=Path, required=True)
    p.add_argument('--batch-id')
    p.add_argument('--input-fields', default='title,abstract')
    p.add_argument('--state-commit')
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--remove-batch')
    args = p.parse_args(argv)
    raw_text = args.overlay.read_text(encoding='utf-8')
    data = json.loads(raw_text)
    if args.remove_batch:
        data['items'] = [row for row in data.get('items', []) if row.get('batchId') != args.remove_batch]
        for prefix in ('batch2', 'batch3'):
            if data.get(prefix + 'BatchId') == args.remove_batch:
                for suffix in ('BatchId', 'Model', 'OfficialState', 'CodeShaForExtractTags', 'Note'):
                    data.pop(prefix + suffix, None)
        args.overlay.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        return 0
    if not all((args.batch, args.model_output, args.batch_id, args.state_commit)):
        p.error('--batch, --model-output, --batch-id and --state-commit are required for writing')
    repo = args.overlay.parent.parent
    if not (repo / 'scripts' / 'enrich_metadata.py').is_file():
        repo = Path.cwd()
    vocab = load_vocab(repo)
    rows = [json.loads(line) for line in args.model_output.read_text(encoding='utf-8').splitlines() if line.strip()]
    existing = data.get('items', [])
    if args.batch_id in {x.get('batchId') for x in existing}:
        raise ValueError(f'batch id already exists: {args.batch_id}')
    fields = [x.strip() for x in args.input_fields.split(',') if x.strip()]
    result = collect_writes(rows, existing, vocab, args.batch_id, fields)
    summary = {
        'written': result['written'],
        'abstained': result['abstained'],
        'skipped': result['skipped'],
        'perTag': result['perTag'],
    }
    if args.dry_run:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    updated = append_json_members(raw_text, 'items', result['additions'])
    end = updated.rfind('}')
    code_sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    meta = metadata(args.batch, args.batch_id, args.state_commit, code_sha)
    encoded = ',\n'.join(
        '  ' + json.dumps(k, ensure_ascii=False) + ': ' + json.dumps(v, ensure_ascii=False)
        for k, v in meta.items()
    )
    updated = updated[:end].rstrip() + ',\n' + encoded + '\n' + updated[end:]
    json.loads(updated)
    args.overlay.write_text(updated, encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
