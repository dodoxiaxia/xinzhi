"""Small, public, evidence-backed journal registry. No network or JCR scraping."""
import datetime
import json
import math
import re
from pathlib import Path
from urllib.parse import urlsplit
from enrich_metadata import _journal_key

KINDS = {'journal', 'preprint', 'conference', 'news', 'blog', 'book', 'collection', 'unknown'}
STATUSES = {'verified', 'unverified', 'not_applicable'}
OFFICIAL_EVIDENCE = {'publisher_public', 'clarivate_public', 'authorized_jcr_export'}
HISTORY_STATUS = 'historical_reference_unverified'


def valid_issn(value):
    value = str(value).upper().replace('-', '')
    return bool(re.fullmatch(r'\d{7}[\dX]', value)) and sum(
        (10 if c == 'X' else int(c)) * (8-i) for i, c in enumerate(value)) % 11 == 0


def timestamp(value):
    time = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if time.tzinfo is None:
        raise ValueError('Metric verification time requires a timezone')
    return time


def validate_registry(data):
    """Fail a build for ambiguous aliases, unsupported years or unproven values."""
    required = {'schemaVersion', 'verifiedAt', 'notice', 'sources', 'journals'}
    if not required <= set(data) or set(data) - required - {'historicalReferences'} or data.get('schemaVersion') != 1 or not isinstance(data.get('journals'), list):
        raise ValueError('Unsupported journal metrics registry')
    timestamp(data['verifiedAt'])
    aliases, issns, ids = {}, {}, set()
    sources = data.get('sources', {})
    for key, source in sources.items():
        if source.get('kind') == 'user_reference':
            if set(source) != {'label', 'url', 'kind', 'checkedAt', 'status', 'dataYear', 'releaseYear', 'scope'}:
                raise ValueError('Unexpected historical source fields: ' + key)
            if source['url'] is not None or not source['label'] or source['status'] != HISTORY_STATUS or source['scope'] != 'matched_site_journals_only':
                raise ValueError('Historical source must remain a bounded unverified reference')
            if type(source['dataYear']) is not int or type(source['releaseYear']) is not int or source['releaseYear'] != source['dataYear'] + 1:
                raise ValueError('Historical source data/release years differ')
            if timestamp(source['checkedAt']).year < source['releaseYear']:
                raise ValueError('Historical source cannot precede its release')
            continue
        if set(source) != {'label', 'url', 'kind', 'verifiedAt'}:
            raise ValueError('Unexpected source fields: ' + key)
        url = urlsplit(source['url'])
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query:
            raise ValueError('Source must be a public HTTPS URL without credentials/query')
        if source['kind'] not in OFFICIAL_EVIDENCE:
            raise ValueError('Unsupported evidence kind')
        timestamp(source['verifiedAt'])

    def evidence(refs):
        if not refs or any(ref not in sources for ref in refs):
            raise ValueError('Verified metric requires source evidence')
        if any(sources[ref]['kind'] not in OFFICIAL_EVIDENCE for ref in refs):
            raise ValueError('User reference cannot verify official journal metrics or identity')

    for row in data['journals']:
        if set(row) != {'id', 'name', 'aliases', 'issns', 'identitySources', 'kind', 'jif', 'jcr'}:
            raise ValueError('Unexpected registry journal fields')
        if row['id'] in ids or not row['id'] or not row['name'] or row['kind'] not in KINDS:
            raise ValueError('Invalid journal identity')
        ids.add(row['id'])
        for name in [row['name'], *row['aliases']]:
            key = _journal_key(name)
            if key in aliases and aliases[key] != row['id']:
                raise ValueError('Conflicting journal alias: ' + name)
            aliases[key] = row['id']
        for issn in row['issns']:
            if not valid_issn(issn):
                raise ValueError('Invalid ISSN: ' + issn)
            key = issn.upper().replace('-', '')
            if key in issns and issns[key] != row['id']:
                raise ValueError('Conflicting ISSN')
            issns[key] = row['id']
        if row['issns'] or row['identitySources']:
            evidence(row['identitySources'])
        jif, jcr = row['jif'], row['jcr']
        if set(jif) != {'status', 'value', 'year', 'sources', 'verifiedAt', 'reason'}:
            raise ValueError('Unexpected JIF fields')
        if set(jcr) != {'status', 'dataYear', 'releaseYear', 'editionSources', 'categories', 'categoryCoverage', 'reason'}:
            raise ValueError('Unexpected JCR fields')
        if jif['status'] not in STATUSES or jcr['status'] not in STATUSES:
            raise ValueError('Unsupported verification status')
        if row['kind'] not in {'journal', 'unknown'} and (jif['status'] != 'not_applicable' or jcr['status'] != 'not_applicable'):
            raise ValueError('Non-journal sources cannot receive journal metrics')
        if jif['status'] == 'verified':
            if type(jif['value']) not in {int, float} or not math.isfinite(jif['value']) or jif['value'] < 0 or type(jif['year']) is not int:
                raise ValueError('Invalid JIF value/year')
            evidence(jif['sources']); timestamp(jif['verifiedAt'])
        elif any(jif[k] is not None for k in ('value', 'year', 'verifiedAt')) or jif['sources']:
            raise ValueError('Unverified JIF must not carry a number/year')
        if jcr['dataYear'] is not None:
            if type(jcr['dataYear']) is not int or type(jcr['releaseYear']) is not int or jcr['releaseYear'] != jcr['dataYear'] + 1:
                raise ValueError('JIF data year and JCR release year differ')
            evidence(jcr['editionSources'])
            if jif['status'] == 'verified' and jcr['dataYear'] != jif['year']:
                raise ValueError('Do not mix JIF/JCR years')
        elif jcr['releaseYear'] is not None or jcr['editionSources']:
            raise ValueError('Missing JCR data year')
        if jcr['categoryCoverage'] not in {'complete', 'publisher_reported', 'unverified', 'not_applicable'}:
            raise ValueError('Invalid category completeness')
        for category in jcr['categories']:
            if set(category) != {'name', 'quartile', 'rank', 'total', 'sources', 'verifiedAt'}:
                raise ValueError('Unexpected category fields')
            if category['quartile'] not in {None, 'Q1', 'Q2', 'Q3', 'Q4'}:
                raise ValueError('Invalid JCR quartile')
            if not category['name'] or jcr['dataYear'] is None:
                raise ValueError('Category requires a name and edition')
            evidence(category['sources']); timestamp(category['verifiedAt'])
            if category['rank'] is not None and (type(category['rank']) is not int or type(category['total']) is not int or not 1 <= category['rank'] <= category['total']):
                raise ValueError('Invalid official JIF rank')
        if jcr['status'] == 'verified' and (jcr['categoryCoverage'] != 'complete' or not jcr['categories'] or any(c['quartile'] is None for c in jcr['categories'])):
            raise ValueError('Verified JCR requires all categories/quartiles')
    histories = data.get('historicalReferences', [])
    if not isinstance(histories, list):
        raise ValueError('Historical references must be a list')
    journal_by_id = {row['id']: row for row in data['journals']}
    seen_history = set()
    for history in histories:
        if set(history) != {'journalId', 'dataYear', 'releaseYear', 'category', 'quartile', 'sources', 'checkedAt', 'status', 'categoryCoverage'}:
            raise ValueError('Unexpected historical reference fields')
        row = journal_by_id.get(history['journalId'])
        if not row or row['kind'] != 'journal':
            raise ValueError('Historical reference requires an existing journal identity')
        if history['status'] != HISTORY_STATUS or history['categoryCoverage'] != 'reference_single_category':
            raise ValueError('Historical reference must remain unverified and single-category')
        if not isinstance(history['category'], str) or not history['category'].strip() or re.search(r'[;；|\n]', history['category']) or history['quartile'] not in {'Q1', 'Q2', 'Q3', 'Q4'}:
            raise ValueError('Historical reference requires one category and one quartile')
        if type(history['dataYear']) is not int or type(history['releaseYear']) is not int or history['releaseYear'] != history['dataYear'] + 1:
            raise ValueError('Historical data/release years differ')
        timestamp(history['checkedAt'])
        refs = history['sources']
        if not isinstance(refs, list) or len(refs) != 1 or refs[0] not in sources or sources[refs[0]]['kind'] != 'user_reference':
            raise ValueError('Historical reference requires its user-provided source')
        source = sources[refs[0]]
        if any(source[k] != history[k] for k in ('dataYear', 'releaseYear', 'checkedAt')):
            raise ValueError('Historical reference years/time must match its source')
        identity = (history['journalId'], history['dataYear'])
        if identity in seen_history:
            raise ValueError('Duplicate historical reference')
        seen_history.add(identity)
    return data


def load_registry(root):
    return validate_registry(json.loads((Path(root)/'config/journal-metrics.json').read_text(encoding='utf-8')))


def public_registry(root):
    # Explicit schema validation precedes publication; no private metadata accepted.
    return load_registry(root)
