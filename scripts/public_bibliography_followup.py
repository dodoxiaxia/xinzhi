#!/usr/bin/env python3
"""Offline validation/preview of a bounded, public-only bibliography overlay.

No builder wiring, source writes, network, classifier or private PDF access.
The integration owner must combine returned PDF HOLD IDs with existing HOLDs.
"""
import argparse
import copy
import datetime
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

from audit_public_bibliography import read_public_bundle
from public_library_quality import PROJECT_FIELDS
from sync_public_library import normalize_doi, normalize_pmid, public_text

ROOT = Path(__file__).resolve().parents[1]
IDENTITY = {'id', 'title', 'doi', 'journal', 'pmid'}
PATCH_FIELDS = {'title', 'doi', 'journal', 'url', 'date', 'onlineDate', 'datePrecision',
                'dateBasis', 'issueDate', 'issueDatePrecision', 'issueDateBasis',
                'bibliographicEvidenceUrl'}
ENTRY_FIELDS = {'id', 'original', 'status', 'action', 'privateBinding', 'reason',
                'evidenceUrls', 'publicPatch', 'canonicalId', 'canonicalOriginal', 'localEvidence'}
ENRICHMENT = {'titleZh', 'authors', 'affiliations', 'pubTypes', 'summary', 'abstractSections',
              'quantitativeMetrics', 'draftData', 'abstractStatus', 'abstractSource',
              'abstractSourceUrl', 'nonAbstractMetadata'}
OFFICIAL_HOSTS = {'api.crossref.org', 'jamanetwork.com', 'edhub.ama-assn.org'}


def hold(code):
    raise ValueError('public_bibliography_followup_hold:' + code)


def identity(record):
    return (record.get('id'), record.get('title'), normalize_doi(record.get('doi', '')),
            record.get('journal'), normalize_pmid(str(record.get('pmid') or '')))


def validate_identity(record):
    if not isinstance(record, dict) or set(record) != IDENTITY:
        hold('invalid_identity')
    for value in record.values():
        if not isinstance(value, str):
            hold('invalid_identity_text')
        public_text(value)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', record['id']):
        hold('invalid_id')
    identity(record)


def validate_policy(policy):
    if (not isinstance(policy, dict) or set(policy) != {'schemaVersion', 'batch', 'checkedOn',
                                                      'scope', 'sourceBase', 'entries'}
            or type(policy['schemaVersion']) is not int or policy['schemaVersion'] != 1
            or policy['scope'] != 'public_bibliography_only'
            or not re.fullmatch(r'[a-f0-9]{40}', str(policy['sourceBase']))):
        hold('invalid_policy')
    for key in ('batch', 'checkedOn'):
        if not isinstance(policy[key], str):
            hold('invalid_policy_text')
        public_text(policy[key])
    datetime.date.fromisoformat(policy['checkedOn'])
    entries = policy['entries']
    if not isinstance(entries, list) or not 1 <= len(entries) <= 10:
        hold('invalid_batch_size')
    ids = set()
    for entry in entries:
        if (not isinstance(entry, dict) or set(entry) - ENTRY_FIELDS
                or not ENTRY_FIELDS - {'canonicalId', 'canonicalOriginal', 'localEvidence'} <= set(entry)):
            hold('invalid_entry')
        validate_identity(entry['original'])
        if entry['id'] != entry['original']['id'] or entry['id'] in ids:
            hold('duplicate_or_mismatched_id')
        ids.add(entry['id'])
        if entry['privateBinding'] != 'hold':
            hold('private_binding_not_held')
        if not isinstance(entry['reason'], str):
            hold('invalid_reason')
        public_text(entry['reason'])
        patch = entry['publicPatch']
        if not isinstance(patch, dict) or set(patch) - PATCH_FIELDS:
            hold('non_bibliographic_patch_field')
        for value in patch.values():
            if not isinstance(value, str):
                hold('invalid_patch_text')
            public_text(value)
        urls = entry['evidenceUrls']
        if not isinstance(urls, list) or (not urls and entry['status'] != 'false-positive'):
            hold('missing_evidence')
        for url in urls:
            if not isinstance(url, str):
                hold('invalid_evidence_url')
            parsed = urlsplit(public_text(url))
            if parsed.scheme != 'https' or parsed.hostname not in OFFICIAL_HOSTS or parsed.username or parsed.password:
                hold('untrusted_evidence_url')
        if entry['status'] == 'verified' and entry['action'] in {'correct', 'alias'}:
            if not {'title', 'doi', 'journal', 'url', 'bibliographicEvidenceUrl'} <= set(patch):
                hold('incomplete_verified_patch')
            if (not patch['title'] or not patch['journal'] or not normalize_doi(patch['doi'])
                    or patch['doi'] != normalize_doi(patch['doi'])
                    or patch['url'] != 'https://doi.org/' + patch['doi']
                    or patch['bibliographicEvidenceUrl'] not in urls):
                hold('invalid_verified_patch')
        elif entry['status'] == 'unresolved' and entry['action'] == 'hold_link':
            if patch != {'doi': '', 'url': ''}:
                hold('unresolved_identity_cannot_be_replaced')
        elif entry['status'] == 'false-positive' and entry['action'] == 'retain':
            if patch:
                hold('false_positive_cannot_be_changed')
            evidence = entry.get('localEvidence')
            if (not isinstance(evidence, dict) or set(evidence) != {'type', 'counts', 'publicBundleSha256',
                    'rawSnapshotSha256', 'runtimeLibrarySha256', 'reportLibraryFileId', 'historicalMerge'}
                    or evidence['type'] != 'normalized_public_doi_cardinality'
                    or evidence['counts'] != {'LIBRARY': 1, 'FEEDS': 0, 'RAW_APPROVED': 1, 'RUNTIME_LIBRARY': 1}
                    or evidence['historicalMerge'] != 'not_established'):
                hold('invalid_local_cardinality_evidence')
            for key in ('publicBundleSha256', 'rawSnapshotSha256', 'runtimeLibrarySha256'):
                if not re.fullmatch(r'[a-f0-9]{64}', str(evidence[key])):
                    hold('invalid_local_evidence_hash')
            public_text(evidence['reportLibraryFileId'])
        else:
            hold('invalid_status_action')
        if entry['status'] != 'false-positive' and 'localEvidence' in entry:
            hold('unexpected_local_evidence')
        if ('date' in patch or 'onlineDate' in patch):
            if (patch.get('date') != patch.get('onlineDate') or patch.get('datePrecision') != 'day'
                    or not patch.get('dateBasis')):
                hold('online_date_requires_evidence_label')
            datetime.date.fromisoformat(patch['date'])
        if 'issueDate' in patch:
            if patch.get('issueDatePrecision') != 'month' or not patch.get('issueDateBasis'):
                hold('issue_date_requires_precision_label')
            datetime.datetime.strptime(patch['issueDate'], '%Y-%m')
        if entry['action'] == 'alias':
            validate_identity(entry['canonicalOriginal'])
            if entry['canonicalId'] != entry['canonicalOriginal']['id'] or entry['canonicalId'] == entry['id']:
                hold('invalid_canonical_id')
        elif 'canonicalId' in entry or 'canonicalOriginal' in entry:
            hold('unexpected_alias_fields')
    if any(e.get('canonicalId') in ids for e in entries):
        hold('alias_chain_not_allowed')
    return policy


def approved_identity(entry, original):
    return identity({**original, **{k: v for k, v in entry['publicPatch'].items() if k in IDENTITY}})


def hold_pdf(record):
    record.update(localAvailable=False, fulltextStatus='not_verified')


def project(papers, policy):
    """Pure preview; explicitly guarded aliases only, never title-based merges."""
    validate_policy(policy)
    rows = {}
    for record in papers:
        if not isinstance(record, dict) or not isinstance(record.get('id'), str) or record['id'] in rows:
            hold('duplicate_or_invalid_input_id')
        rows[record['id']] = copy.deepcopy({k: v for k, v in record.items() if k in PROJECT_FIELDS})
    entries, pdf_holds = [], set()
    for entry in policy['entries']:
        source = rows.get(entry['id'])
        original = entry['original']
        if source is None:
            if entry['action'] != 'alias':
                hold('reviewed_id_missing')
        elif identity(source) not in {identity(original), approved_identity(entry, original)}:
            hold('reviewed_identity_changed')
        target = source
        if entry['action'] == 'retain' and sum(normalize_doi(p.get('doi', '')) == original['doi']
                                              for p in rows.values()) != 1:
            hold('reported_duplicate_now_present')
        if entry['action'] == 'alias':
            canonical = entry['canonicalOriginal']
            target = rows.get(entry['canonicalId'])
            if target is None or identity(target) not in {identity(canonical), approved_identity(entry, canonical)}:
                hold('canonical_identity_changed')
            pdf_holds.add(entry['canonicalId'])
        if entry['action'] in {'correct', 'alias'}:
            allowed = {entry['id'], entry.get('canonicalId')}
            if any(p['id'] not in allowed and normalize_doi(p.get('doi', '')) == entry['publicPatch']['doi']
                   for p in rows.values()):
                hold('replacement_doi_already_present')
        if target is not None and entry['action'] != 'retain':
            # A canonical alias target already had the independently verified DOI.
            # Its legitimate public enrichment need not be rebound from the source.
            if entry['action'] != 'alias':
                for key in ENRICHMENT:
                    target.pop(key, None)
                target['hasDraft'] = False
            target.update(entry['publicPatch'])
            target['metadataStatus'] = ('official_bibliography_checked' if entry['status'] == 'verified'
                                        else 'hold_bibliography_review')
            target['basis'] = ('公共题录身份已复核 · 私有 PDF 身份未知 · 未读全文' if 'onlineDate' in entry['publicPatch']
                               else '公共题录复核 · 原发表日期未复核 · 私有 PDF 身份未知 · 未读全文')
            hold_pdf(target)
        elif target is not None:
            hold_pdf(target)
        if entry['action'] == 'alias':
            rows.pop(entry['id'], None)
        pdf_holds.add(entry['id'])
        entries.append({'id': entry['id'], 'status': entry['status'], 'action': entry['action'],
                        'reason': entry['reason'], 'original': copy.deepcopy(original),
                        'canonicalId': entry.get('canonicalId'), 'publicPatch': copy.deepcopy(entry['publicPatch'])})
    result = sorted(rows.values(), key=lambda p: (p.get('date') or '', p['id']), reverse=True)
    audit = {'scope': 'public_bibliography_only', 'inputCount': len(papers), 'outputCount': len(result),
             'counts': {s: sum(e['status'] == s for e in entries) for s in ('verified', 'false-positive', 'unresolved')},
             'entries': entries, 'pdfBindingHoldIds': sorted(pdf_holds),
             'networkRequests': 0, 'privatePdfBodiesRead': 0}
    return result, audit


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, default=ROOT / 'public/public.js')
    parser.add_argument('--policy', type=Path, default=ROOT / 'editorial/public_bibliography_followup_20261008.json')
    args = parser.parse_args(argv)
    try:
        datasets, _ = read_public_bundle(args.bundle)
        policy = json.loads(args.policy.read_text(encoding='utf-8'))
        _, audit = project(datasets['LIBRARY'], policy)
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        print(json.dumps({'error': 'public_bibliography_followup_hold'}), file=sys.stderr)
        return 1
    print(json.dumps({k: audit[k] for k in ('inputCount', 'outputCount', 'counts',
                                           'pdfBindingHoldIds', 'networkRequests', 'privatePdfBodiesRead')}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
