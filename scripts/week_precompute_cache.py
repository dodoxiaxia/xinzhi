"""Task-scoped cache contracts for public-abstract precomputation.

Versions here describe the local task contract, not an unobserved remote prompt.
Bump the relevant task's validator/prompt constant when that contract changes;
unrelated Worker source changes deliberately have no effect. Runtime responses do
not attest their generation prompt, so their generation version stays unobserved.
"""
import copy
import hashlib
import json
import re

TASKS = ('translate', 'study', 'quicklook')
TASK_PROMPT_VERSIONS = {
    'translate': 'public-translation-v1',
    'study': 'public-study-evidence-id-v2',
    'quicklook': 'public-quicklook-v1',
}
TASK_VALIDATOR_VERSIONS = {
    'translate': 'translation-number-occurrences-v2',
    'study': 'literal-evidence-same-quote-numbers-v2',
    'quicklook': 'literal-findings-same-quote-numbers-v1',
}
DEFAULT_NAMESPACE = 'week-public-abstract-v1'
UNOBSERVED = 'unobserved'
LEGACY_TRANSLATION_VERSION = ('week-public-abstract-v1:translate:'
    'caa19ed86c6600a00d6c13c4132383a9b99cf9bec22bc6b510a71bd0cdddcd02')
LEGACY_PAPER_ID = 'doi:10.1001/jamanetworkopen.2026.37545'
LEGACY_SOURCE_HASH = '2195a1591c9db6cf0be4b6eea1d16869a073a28cbc017898b16fdc21d6231f8c'


def digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest()


def _task(task):
    if task not in TASKS:
        raise ValueError('unknown_cache_task')


def generation_prompt_version(task, origin, configured_prompt=''):
    _task(task)
    if origin == 'configured-precompute':
        if not isinstance(configured_prompt, str) or not configured_prompt:
            raise ValueError('missing_configured_prompt')
        return TASK_PROMPT_VERSIONS[task] + ':' + hashlib.sha256(configured_prompt.encode()).hexdigest()
    # A local source hash cannot prove which prompt a remote cache used.
    return UNOBSERVED


def version(task, origin='runtime', *, namespace=DEFAULT_NAMESPACE, configured_prompt=''):
    prompt = generation_prompt_version(task, origin, configured_prompt)
    return ':'.join((namespace, task, TASK_PROMPT_VERSIONS[task], prompt,
                     TASK_VALIDATOR_VERSIONS[task]))


def cache_key(paper, task, model, origin='runtime', **versions):
    return digest({'paperID': paper['paperID'], 'sourceHash': paper['sourceHash'],
                   'promptVersion': version(task, origin, **versions), 'modelVersion': model})


def _valid_source(paper):
    source_hash = paper.get('sourceHash')
    if not isinstance(source_hash, str) or not re.fullmatch('[a-f0-9]{64}', source_hash):
        return False
    if not isinstance(paper.get('title'), str) or not isinstance(paper.get('abstract'), str):
        return False
    return hashlib.sha256((paper['title'] + '\n' + paper['abstract']).encode()).hexdigest() == source_hash


def _known_legacy(entry, paper, task, namespace):
    return (namespace == DEFAULT_NAMESPACE and task == 'translate'
            and entry.get('promptVersion') == LEGACY_TRANSLATION_VERSION
            and entry.get('origin') == 'runtime-cache'
            and entry.get('paperID') == paper.get('paperID') == LEGACY_PAPER_ID
            and entry.get('sourceHash') == paper.get('sourceHash') == LEGACY_SOURCE_HASH)


def find(cache, paper, task, validate_fn, *, namespace=DEFAULT_NAMESPACE, configured_prompt=''):
    """Return revalidated content and honest provenance, without mutating stored history."""
    _task(task)
    if not _valid_source(paper):
        return None, None
    for entry in cache.get('entries', {}).values():
        if (not isinstance(entry, dict) or entry.get('paperID') != paper.get('paperID')
                or entry.get('sourceHash') != paper['sourceHash'] or entry.get('task') != task
                or not isinstance(entry.get('modelVersion'), str) or not entry['modelVersion'].strip()):
            continue
        try:
            current = version(task, entry.get('origin'), namespace=namespace,
                              configured_prompt=configured_prompt)
        except ValueError:
            continue
        legacy = _known_legacy(entry, paper, task, namespace)
        if entry.get('promptVersion') != current and not legacy:
            continue
        try:
            value = validate_fn(task, entry['value'], paper)
        except (ValueError, KeyError, TypeError):
            continue
        metadata = copy.deepcopy(entry)
        metadata['validatorVersion'] = TASK_VALIDATOR_VERSIONS[task]
        metadata['validatedWith'] = current
        metadata['generationPromptVersion'] = generation_prompt_version(
            task, entry.get('origin'), configured_prompt)
        metadata['generationVersionKnown'] = entry.get('origin') == 'configured-precompute'
        if legacy:
            # Keep the original local label as history. It never attested the online prompt.
            metadata['legacyLocalValidationVersion'] = entry['promptVersion']
        return value, metadata
    return None, None


def store(cache, paper, task, value, model, generated_at, origin, validate_fn,
          *, namespace=DEFAULT_NAMESPACE, configured_prompt=''):
    if not _valid_source(paper):
        raise ValueError('cache_source_hash_mismatch')
    if not isinstance(model, str) or not model.strip():
        raise ValueError('missing_model_version')
    value = validate_fn(task, value, paper)
    current = version(task, origin, namespace=namespace, configured_prompt=configured_prompt)
    entry = {'paperID': paper['paperID'], 'sourceHash': paper['sourceHash'],
             'promptVersion': current, 'validatorVersion': TASK_VALIDATOR_VERSIONS[task],
             'generationPromptVersion': generation_prompt_version(task, origin, configured_prompt),
             'generationVersionKnown': origin == 'configured-precompute',
             'modelVersion': model, 'task': task, 'value': value, 'generatedAt': generated_at,
             'origin': origin, 'scope': 'public-abstract',
             'reviewStatus': 'machine-validated-unreviewed'}
    cache.setdefault('entries', {})[cache_key(paper, task, model, origin,
        namespace=namespace, configured_prompt=configured_prompt)] = entry
    return entry
