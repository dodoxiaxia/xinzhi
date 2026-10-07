"""Apply manually verified public publisher observations; never fetch or infer Q."""
import copy
from enrich_metadata import _journal_key
from journal_metrics import timestamp, validate_registry


def apply_observations(registry, observations):
    """Keep identities, prior official values and historical user references intact.

    Observations contain only bibliographic facts read from public official pages.
    Explicitly enumerated JCR categories may carry Q; a rank never generates Q.
    New labels and contradictory already-verified metrics require separate review.
    """
    result = copy.deepcopy(validate_registry(registry))
    aliases = {_journal_key(name): row for row in result['journals']
               for name in [row['name'], *row['aliases']]}
    seen = set()
    for observation in observations:
        expected = {'name', 'sourceId', 'url', 'label', 'verifiedAt', 'value',
                    'year', 'issns', 'categories', 'categoryCoverage'}
        if set(observation) != expected:
            raise ValueError('Unexpected public observation fields')
        row = aliases.get(_journal_key(observation['name']))
        if not row or row['kind'] != 'journal':
            raise ValueError('Public observation requires an existing journal identity')
        if row['id'] in seen:
            raise ValueError('Duplicate public journal observation')
        seen.add(row['id'])
        time = timestamp(observation['verifiedAt'])
        year = observation['year']
        if type(year) is not int or year + 1 > time.year:
            raise ValueError('JIF data cannot precede its release')
        if row['jif']['status'] == 'verified':
            if (row['jif']['value'], row['jif']['year']) != (observation['value'], year):
                raise ValueError('Existing verified JIF differs; explicit review required')
            # Idempotent observation import cannot discard old official evidence.
            continue
        source_id = observation['sourceId']
        source = {'label': observation['label'], 'url': observation['url'],
                  'kind': 'publisher_public', 'verifiedAt': observation['verifiedAt']}
        if source_id in result['sources'] and result['sources'][source_id] != source:
            raise ValueError('Conflicting public source identity')
        result['sources'][source_id] = source
        row['issns'] = list(dict.fromkeys([*row['issns'], *observation['issns']]))
        row['identitySources'] = list(dict.fromkeys([*row['identitySources'], source_id]))
        row['jif'] = {'status': 'verified', 'value': observation['value'], 'year': year,
                      'sources': [source_id], 'verifiedAt': observation['verifiedAt'], 'reason': ''}
        coverage = observation['categoryCoverage']
        categories = [{**category, 'sources': [source_id],
                       'verifiedAt': observation['verifiedAt']}
                      for category in observation['categories']]
        verified = coverage == 'complete' and categories and all(c['quartile'] for c in categories)
        row['jcr'] = {'status': 'verified' if verified else 'unverified',
                      'dataYear': year, 'releaseYear': year + 1,
                      'editionSources': ['edition-2026'] if year == 2025 else [source_id],
                      'categories': categories, 'categoryCoverage': coverage,
                      'reason': '' if verified else '该官方公开页面明确列出 JIF 年份和值，但未列完整 JCR 逐学科分区；排名不推算为分区。'}
        if time > timestamp(result['verifiedAt']):
            result['verifiedAt'] = observation['verifiedAt']
    return validate_registry(result)


def apply_identity_observations(registry, observations):
    """Merge public bibliographic evidence without promoting or replacing metrics."""
    result = copy.deepcopy(validate_registry(registry))
    aliases = {_journal_key(name): row for row in result['journals']
               for name in [row['name'], *row['aliases']]}
    seen = set()
    for observation in observations:
        if set(observation) != {'name', 'aliases', 'issns', 'sourceId', 'url',
                                'label', 'verifiedAt'}:
            raise ValueError('Unexpected public identity fields')
        row = aliases.get(_journal_key(observation['name']))
        if not row or row['kind'] != 'journal':
            raise ValueError('Identity evidence requires an existing journal')
        if row['id'] in seen:
            raise ValueError('Duplicate identity observation')
        seen.add(row['id'])
        source_id = observation['sourceId']
        source = {'label': observation['label'], 'url': observation['url'],
                  'kind': 'publisher_public', 'verifiedAt': observation['verifiedAt']}
        if source_id in result['sources'] and result['sources'][source_id] != source:
            raise ValueError('Conflicting public identity source')
        result['sources'][source_id] = source
        row['aliases'] = list(dict.fromkeys([*row['aliases'], *observation['aliases']]))
        row['issns'] = list(dict.fromkeys([*row['issns'], *observation['issns']]))
        row['identitySources'] = list(dict.fromkeys([*row['identitySources'], source_id]))
        time = timestamp(observation['verifiedAt'])
        if time > timestamp(result['verifiedAt']):
            result['verifiedAt'] = observation['verifiedAt']
    return validate_registry(result)
