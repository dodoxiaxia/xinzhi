"""Audit only site-matched Library text snippets into a private local report.

This does not convert a capped spreadsheet preview into a complete data source,
copy a workbook into the repository, or update the public metrics registry.
"""
import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path
from journal_metrics import load_registry, valid_issn
from enrich_metadata import _journal_key


def title_key(value):
    return _journal_key(re.sub(r'^the\s+', '', value, flags=re.I))


def audit_snippets(payload, registry):
    if payload.get('scope') != 'rendered_preview_only':
        raise ValueError('Snippet input must explicitly retain its preview scope')
    names, issns = {}, {}
    for journal in registry['journals']:
        for name in [journal['name'], *journal['aliases']]:
            names.setdefault(title_key(name), []).append(journal)
        for issn in journal['issns']:
            issns[issn.upper().replace('-', '')] = journal
    # An exact bibliographic spelling already recognized by source_fallbacks.py.
    jacc = next((r for r in registry['journals'] if r['name'] == 'JACC'), None)
    if jacc:
        names[title_key('Journal of the American College of Cardiology')] = [jacc]
    for spelling, canonical in [('JAMA-Journal of the American Medical Association', 'JAMA'),
                                ('BMJ-British Medical Journal', 'The BMJ')]:
        journal = next((r for r in registry['journals'] if r['name'] == canonical), None)
        if journal:
            names[title_key(spelling)] = [journal]
    records, excluded, conflicts, seen = [], Counter(), [], set()
    for source in payload['files']:
        is_jcr = source['name'].endswith('.xlsx')
        for match in source['matches']:
            identity = (source['library_file_id'], match['start_line'])
            if identity in seen:
                continue
            seen.add(identity)
            # Library renders 1000 rows plus three header lines per sheet. The
            # second sheet is the separate CAS table and is never a JCR input.
            if is_jcr and match['start_line'] > 1003:
                excluded['CAS_sheet'] += 1
                continue
            fields = next(csv.reader([match['content']]))
            if len(fields) != (10 if is_jcr else 8):
                conflicts.append({'source': source['name'], 'line': match['start_line'], 'reason': 'unexpected_columns'})
                continue
            title, raw_issns = fields[1], [s.strip().upper() for s in fields[2:4] if s.strip()]
            by_name = names.get(title_key(title), [])
            by_issn = [issns[s.replace('-', '')] for s in raw_issns if s.replace('-', '') in issns]
            candidates = {j['id']: j for j in by_name + by_issn}
            if len(candidates) != 1:
                conflicts.append({'source': source['name'], 'line': match['start_line'], 'title': title,
                                  'reason': 'identity_conflict' if candidates else 'no_exact_identity'})
                continue
            journal = next(iter(candidates.values()))
            bad_issns = [s for s in raw_issns if not valid_issn(s)]
            if bad_issns:
                conflicts.append({'source': source['name'], 'line': match['start_line'], 'journal': journal['name'], 'reason': 'invalid_issn_checksum', 'issns': bad_issns})
            record = {'journalId': journal['id'], 'journal': journal['name'], 'referenceTitle': title,
                      'sourceType': 'user_reference', 'sourceFile': source['name'],
                      'libraryFileId': source['library_file_id'], 'fileId': source['file_id'],
                      'sourceLine': match['start_line'], 'scope': 'matched_visible_preview',
                      'issns': sorted(set(raw_issns)), 'identityMatch': 'issn_and_or_exact_title',
                      'verifiedAt': payload['checkedAt'], 'publicUse': False}
            if is_jcr:
                categories = [c.strip() for c in fields[4].split(';') if c.strip()]
                record.update(jif={'year': 2024, 'releaseYear': 2025, 'value': float(fields[6]), 'status': 'user_reference_unverified'},
                              jcr={'categoriesAsProvided': categories, 'quartileAsProvided': fields[7],
                                   'rankAsProvided': fields[8], 'status': 'user_reference_unverified',
                                   'quartileScope': 'single_category_reference_only' if len(categories) == 1 else 'unmapped_multiple_categories'})
                if journal['jif']['status'] == 'verified':
                    record['officialComparison'] = {'jifYear': journal['jif']['year'], 'value': journal['jif']['value'],
                        'sameYear': journal['jif']['year'] == 2024, 'resolution': 'preserve_official_newer_year'}
            else:
                record.update(indexSnapshotDate='2025-05-19', index=source['name'].split('目录')[0],
                              wosCategoriesAsProvided=fields[7], jif=None, jcr=None)
            records.append(record)
    applicable = {r['id'] for r in registry['journals'] if r['kind'] in ('journal', 'unknown')}
    covered = {r['journalId'] for r in records}
    jcr = [r for r in records if r['jcr']]
    counts = {'files': len(payload['files']), 'matchedRecords': len(records), 'uniqueSiteLabelsMatched': len(covered),
              'jcrReferenceRows': len(jcr), 'singleCategoryReferenceRows': sum(len(r['jcr']['categoriesAsProvided']) == 1 for r in jcr),
              'multiCategoryQuartileUnmappedRows': sum(len(r['jcr']['categoriesAsProvided']) > 1 for r in jcr),
              'newerOfficialJifPreserved': sum('officialComparison' in r for r in jcr),
              'conflicts': len(conflicts), 'CASRowsExcluded': excluded['CAS_sheet'],
              'unresolvedOutsideVisiblePreview': len(applicable - covered)}
    return {'schemaVersion': 1, 'sourceType': 'user_reference', 'scope': 'rendered_preview_only',
            'completeWorkbookRead': False, 'materializationStatus': 'blocked_http_403',
            'checkedAt': payload['checkedAt'], 'counts': counts,
            'coverageByFile': dict(Counter(r['sourceFile'] for r in records)),
            'records': records, 'conflicts': conflicts,
            'unresolvedSiteLabelIds': sorted(applicable - covered),
            'notice': '未命中只代表可读预览未命中；不表示原表无记录。不得将单个汇总 Q 复制到多个学科，或将 WoS 收录类别当成 JCR 分区。'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    destination = args.output.resolve()
    if not destination.is_relative_to(root/'.local'):
        raise ValueError('Reference reports must remain in ignored private .local')
    report = audit_snippets(json.loads(args.input.read_text()), load_registry(root))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'counts': report['counts'], 'coverageByFile': report['coverageByFile']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
