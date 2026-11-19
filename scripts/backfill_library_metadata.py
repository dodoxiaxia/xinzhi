#!/usr/bin/env python3
"""Preview missing journal/publication dates in the public supplemental DOI catalogue."""

import argparse
from collections import Counter
from datetime import date
import json
import os
import re
import sys
import time
import unicodedata
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


SITE = 'https://learn.dryz.info'
DOI_RE = re.compile(r'10\.\d{4,9}/[\x21-\x7e]{1,200}', re.ASCII)
TITLE_TAG_RE = re.compile(r'<[^>]*>')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(url, *, body=None, token=None):
    headers = {'Accept': 'application/json', 'User-Agent': 'XinZhiLibraryMetadata/1.0'}
    if token:
        headers.update({'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    request = Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with build_opener(NoRedirect()).open(request, timeout=20) as response:
        data = json.loads(response.read(2 * 1024 * 1024))
    if not isinstance(data, dict):
        raise ValueError('invalid_response')
    return data


def catalog(dois, fetch=request_json):
    if dois:
        for doi in dict.fromkeys(dois):
            result = fetch(SITE + '/api/library?' + urlencode({'doi': doi}))
            if result.get('ok') is not True or not result.get('found') or result['paper']['doi'] != doi:
                raise ValueError('doi_not_in_supplemental_catalog')
            yield result['paper']
        return
    query, cursors, seen = '', set(), set()
    while True:
        result = fetch(SITE + '/api/library' + query)
        if result.get('ok') is not True:
            raise ValueError('invalid_catalog_response')
        for paper in result['papers']:
            doi = paper['doi']
            if doi not in seen:
                seen.add(doi)
                yield paper
        cursor = result.get('cursor')
        if not cursor:
            return
        if cursor in cursors:
            raise ValueError('repeated_catalog_cursor')
        cursors.add(cursor)
        query = '?' + urlencode({'cursor': cursor})


def title_key(title):
    value = unicodedata.normalize('NFKC', title).lower()
    return ''.join(c for c in value if not c.isspace() and not unicodedata.category(c).startswith('P'))


def first_text(message, field):
    values = message.get(field)
    return TITLE_TAG_RE.sub('', values[0]).strip() if isinstance(values, list) and values and isinstance(values[0], str) else ''


def publication(message):
    for field in ('published-online', 'published-print', 'published'):
        field_value = message.get(field)
        dates = field_value.get('date-parts') if isinstance(field_value, dict) else None
        if not isinstance(dates, list) or not dates:
            continue
        parts = dates[0]
        if not isinstance(parts, list) or not 1 <= len(parts) <= 3 or any(type(n) is not int for n in parts):
            continue
        if not 1600 <= parts[0] <= 2200:
            continue
        try:
            date(*((parts + [1, 1])[:3]))
        except ValueError:
            continue
        return dict(date='-'.join(f'{part:0{4 if i == 0 else 2}d}' for i, part in enumerate(parts)),
                    datePrecision=('year', 'month', 'day')[len(parts) - 1], dateBasis='Crossref ' + field)
    return {}


def preview(paper, fetch=request_json):
    doi = paper['doi']
    try:
        result = fetch('https://api.crossref.org/works/' + quote(doi, safe='/'))
    except HTTPError as error:
        if error.code == 404:
            return {'result': 'not_in_crossref'}
        raise
    message = result.get('message')
    if not isinstance(message, dict) or str(message.get('DOI', '')).lower() != doi:
        return {'result': 'identity_mismatch'}
    key = title_key(first_text(message, 'title'))
    if len(key) < 5 or key != title_key(paper['title']):
        return {'result': 'identity_mismatch'}
    journal = first_text(message, 'container-title')
    change = {}
    if not paper['journal'] and 0 < len(journal) <= 300:
        change['journal'] = journal
    if not paper['date']:
        change.update(publication(message))
    if not change:
        return {'result': 'source_incomplete'}
    return {'result': 'would_update', 'before': {field: paper[field] for field in ('journal', 'date')},
            'after': {field: change.get(field, paper[field]) for field in ('journal', 'date', 'datePrecision', 'dateBasis')}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--doi', action='append', default=[], help='Only check this DOI (repeatable)')
    parser.add_argument('--apply', action='store_true', help='Write via the deployed API using XINZHI_METADATA_BACKFILL_TOKEN')
    args = parser.parse_args(argv)
    dois = [doi.strip().lower() for doi in args.doi]
    if any(not DOI_RE.fullmatch(doi) or any(c in doi for c in '<>?#@\\') for doi in dois):
        parser.error('invalid DOI')
    token = os.environ.get('XINZHI_METADATA_BACKFILL_TOKEN') if args.apply else None
    if args.apply and not token:
        parser.error('--apply requires XINZHI_METADATA_BACKFILL_TOKEN (existing fallback role)')
    counts, samples = Counter(), []
    try:
        papers = list(catalog(dois))
        counts['scanned'] = len(papers)
        for paper in papers:
            if paper['journal'] and paper['date']:
                continue
            counts['missing'] += 1
            doi = paper['doi']
            if args.apply:
                result = request_json(SITE + '/api/machine/metadata-backfill', body={'doi': doi, 'apply': True}, token=token)
            else:
                result = preview(paper)
            status = result['result']
            counts[status] += 1
            if 'before' in result and (dois or len(samples) < 5):
                samples.append({'doi': doi, 'before': result['before'], 'after': result['after']})
            time.sleep(0.25)
    except (OSError, ValueError, KeyError) as error:
        print('Scan interrupted. HTTP status or error type:', getattr(error, 'code', type(error).__name__), file=sys.stderr)
        counts['interrupted'] += 1
    print(json.dumps({'mode': 'apply' if args.apply else 'preview', 'counts': counts, 'samples': samples},
                     ensure_ascii=False, indent=2))
    return int(bool(counts['interrupted']))


if __name__ == '__main__':
    sys.exit(main())
