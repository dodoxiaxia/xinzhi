"""Finite, reviewed corrections to public projections; never mutate model caches.

Title corrections require exact identities, source title hashes and prior wording.
Abstract corrections additionally require the exact public source hash. This is a
small evidence-bound registry, not a general medical/semantic validation system.
"""
import copy
import hashlib
import json
import re
from pathlib import Path

import week_precompute as w

REGISTRY = 'editorial/public_content_corrections.json'


def load_corrections(root):
    path = Path(root) / REGISTRY
    if not path.exists():
        return {'entries': []}
    if not path.is_file() or path.is_symlink():
        raise ValueError('invalid_public_correction_registry')
    registry = json.loads(path.read_text())
    if registry.get('schemaVersion') != 1 or registry.get('scope') != 'public-content-corrections':
        raise ValueError('invalid_public_correction_registry')
    ids = [e['paperID'] for e in registry['entries']]
    if len(ids) != len(set(ids)):
        raise ValueError('duplicate_public_correction_identity')
    for e in registry['entries']:
        if w.identity(e) != e['paperID'] or not str(e.get('pmid', '')).isdigit():
            raise ValueError('invalid_public_correction_identity')
        for binding in e['titleBindings']:
            if hashlib.sha256(binding['title'].encode()).hexdigest() != binding['titleSHA256']:
                raise ValueError('invalid_public_correction_title_hash')
    return registry


def _identity_matches(paper, entry):
    return (w.identity(paper) == entry['paperID']
            and str(paper.get('doi') or '').lower() == entry['doi']
            and str(paper.get('pmid') or '') == entry['pmid'])


def _title_matches(paper, entry):
    title = paper.get('title', '')
    return any(title == b['title'] and hashlib.sha256(title.encode()).hexdigest() == b['titleSHA256']
               for b in entry['titleBindings'])


def corrected_title(paper, value, registry):
    for e in registry['entries']:
        correction = e.get('titleCorrection')
        if correction and _identity_matches(paper, e) and _title_matches(paper, e):
            if value == correction['before']:
                return correction['after']
    return value


def corrected_title_map(rows, translations, registry):
    """Copy the public lookup only; leave the source translations file untouched."""
    out = dict(translations)
    users = {}
    for p in rows:
        for key in ('pmid:' + str(p.get('pmid') or ''), 'doi:' + str(p.get('doi') or '').lower()):
            if key in translations:
                users.setdefault(key, []).append(p)
    for key, papers in users.items():
        values = {corrected_title(p, translations[key], registry) for p in papers}
        if len(values) == 1:
            out[key] = values.pop()  # A conflicting identity/title must not inherit another row's correction.
    return out


def corrected_quicklook(doi, item, registry, *, source=None):
    """Patch exact known wording; hide new known overclaims in the same source.

    With no current candidate, a historical public QUICKLOOKS item can be bound
    to its own exact cached public abstract + independently verified title/PMID.
    That fallback does not assert membership in today's feed or rolling board.
    """
    if not item:
        return item
    for e in registry['entries']:
        if not e.get('quicklookCorrections') or str(doi).lower() != e['doi']:
            continue
        p = source
        if p is None:
            p = {'doi': doi, 'pmid': item.get('pmid'), 'title': e['titleBindings'][0]['title'],
                 'abstract': item.get('abstract', '')}
        if not _identity_matches(p, e) or not _title_matches(p, e):
            return None  # A changed source/alias needs a fresh review, not an old correction.
        if item.get('pmid') and str(item['pmid']) != e['pmid']:
            return None
        abstract = p.get('abstract', '')
        if (w.text_hash(p['title'], abstract) != e['sourceHash']
                or hashlib.sha256(abstract.encode()).hexdigest() != e['abstractSHA256']
                or ('abstract' in item and item['abstract'] != abstract)):
            return None
        out = copy.deepcopy(item)
        for field, change in e['quicklookCorrections'].items():
            if out.get(field) == change['before']:
                out[field] = change['after']
        for change in e.get('findingCorrections', []):
            i = change['index']
            if i < len(out.get('findings', [])) and out['findings'][i] == change['before']:
                out['findings'][i] = copy.deepcopy(change['after'])
        if any(re.search(pattern, str(out.get(field, '')), re.I)
               for field in e['guardFields'] for pattern in e['unsupportedPatterns']):
            return None  # Preserve the input cache; do not publish a new unsupported claim.
        try:
            w.validate('quicklook', out, p)  # Original quote/numeric checks remain authoritative.
        except ValueError:
            return None
        out['contentCorrection'] = {k: registry[k] for k in
                                    ('correctionVersion', 'correctedOn', 'origin', 'reviewScope')}
        out['contentCorrection'].update(sourceHash=e['sourceHash'], scope='public-abstract')
        return out
    return copy.deepcopy(item)


def corrected_quicklook_map(items, public_sources, registry):
    out = {}
    for doi, item in items.items():
        value = corrected_quicklook(doi, item, registry, source=public_sources.get(str(doi).lower()))
        if value is not None:
            out[doi] = value
    return out
