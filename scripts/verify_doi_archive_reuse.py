#!/usr/bin/env python3
"""Verify already-read private archive bytes. No network, consumer, queue or writes to the library."""
import argparse
import csv
import hashlib
import importlib
import io
import json
import os
import sys
from pathlib import Path

INDEX_SHA = 'f7ad67b3f5a73ab1ceb16e2874da16b78fbf6b017f4020ad2058cec3c6715816'
LEDGER_SHA = 'b2a6d3dbf01656c9347646198001cf5a200590bb633d734f4a671174979f2d33'
BLOBS = {'workflow_state.py':'fca6d7c51743ce48ae461a79f5c03ef99ad69dc3',
         'sync_receipt.py':'4d715b547b1516a77779d64a8240460b368ed9e0',
         'strict_pdf_verifier.py':'c164a69c933eecb9b08b4920562bc63dfdc57efc'}
sha = lambda b: hashlib.sha256(b).hexdigest()


def verify(args):
    for name, expected in BLOBS.items():
        content = (args.workflows / name).read_bytes()
        if hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest() != expected:
            raise ValueError('workflow_source_changed')
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(args.workflows.resolve()))
    state = importlib.import_module('workflow_state')
    verifier = importlib.import_module('strict_pdf_verifier')
    receipts = importlib.import_module('sync_receipt')
    gh, drive, ledger_bytes = args.github_index.read_bytes(), args.drive_index.read_bytes(), args.ledger.read_bytes()
    if sha(gh) != INDEX_SHA or sha(drive) != INDEX_SHA or sha(ledger_bytes) != LEDGER_SHA:
        raise ValueError('source_fingerprint_mismatch')
    rows = list(csv.DictReader(io.StringIO(gh.decode('utf-8-sig'))))
    ledger = json.loads(ledger_bytes)
    if len(rows) != 1336 or len(rows[0]) != 20 or ledger.get('version') != 1 or len(ledger.get('items', {})) != 815:
        raise ValueError('source_schema_mismatch')
    doi = state.normalize_doi(args.doi)
    matching = [row for row in rows if state.normalize_doi(row['DOI']) == doi]
    record = ledger['items'].get(doi)
    if len(matching) != 1 or not record or not state.dedupe_eligible(matching[0]):
        raise ValueError('identity_requires_review')
    state.reconcile_index(ledger, [dict(row, index_source='github_and_drive') for row in rows])
    if record.get('identity_review_required') or record.get('index_identity_review_required'):
        raise ValueError('identity_requires_review')
    expected_title = record.get('sides', {}).get('local', {}).get('expected_title')
    if not expected_title:
        raise ValueError('verified_expected_title_missing')
    proofs = []
    for path in (args.github_pdf, args.drive_pdf):
        if path.stat().st_size > 30 * 1024 * 1024:
            raise ValueError('pdf_too_large')
        proof = verifier.verify_pdf(path, doi, expected_title)
        if not proof['verified'] or proof['sha256'] != record.get('content', {}).get('sha256') or proof['sha256'] != matching[0]['SHA256']:
            raise ValueError('pdf_identity_or_hash_failed')
        proofs.append(proof)
    if proofs[0]['bytes'] != proofs[1]['bytes'] or proofs[0]['sha256'] != proofs[1]['sha256']:
        raise ValueError('readback_mismatch')
    return {'doi':doi,'indexRows':1336,'indexColumns':20,'ledgerItems':815,
            'githubIndexSha256':sha(gh),'driveIndexSha256':sha(drive),'ledgerSha256':sha(ledger_bytes),
            'sourceCommit':'fed03f8d789429fc84c94cefcb4b636d75ec9ee3',
            'pdfSha256':proofs[0]['sha256'],'pdfBytes':proofs[0]['bytes'],'pages':proofs[0]['pages'],
            'twoParsers':True,'titleVerified':True,'doiVerified':True,'reuseEligible':True,
            'historicalReceipts':{side:receipts.verified_side(record,side) for side in ('local','github','drive')},
            'currentReadbacks':{'github':True,'drive':True,'mac':False},'threeSideComplete':False,
            'executionClaimed':False,'newPublisherDownloads':0,'modelCalls':0,'libraryWrites':0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--doi', required=True)
    for name in ('workflows','github-index','drive-index','ledger','github-pdf','drive-pdf','output'):
        parser.add_argument('--'+name, type=Path, required=True)
    args = parser.parse_args()
    if '.local' not in args.output.resolve().parts:
        parser.error('output must remain in a private .local directory')
    result = verify(args)
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(args.output.parent, 0o700)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(result, handle, indent=2)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
