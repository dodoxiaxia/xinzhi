"""Durable two-file checkpoints; no environment lookup, CLI, retries, or scheduling.

The integrator supplies the already-authorized GitHub transport and existing
request-level ledger merge function. No token is read or permission requested by
this module. Transport: ``(method, repository_relative_path, body) -> (status, JSON)``.
It must use the existing GITHUB_TOKEN only with api.github.com, reject redirects,
and bound its timeout. Never log its headers or raw error bodies.

Restore before paid work. ``run_reserved`` persists a new, fully accounted started
request before invoking its callback exactly once. After validating output, set
that request to validated and call ``save`` with ledger AND cache. A crash or any
uncertain checkpoint result leaves a durable started reservation, so a subsequent
runner must stop rather than repeat the charge. Content validation remains the
caller's existing strict source/citation/number gate.

The existing workflow's final orphan state push uses its original restore SHA.
The integrator must update that conditional lease to ``head_sha`` after successful
checkpoints, preserving the latest two files, or keep paid CI disabled. This
module deliberately does not edit workflow/deployment policy or force a ref.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Callable

LEDGER_PATH = 'data/week-precompute-ledger.json'
CACHE_PATH = 'data/week-precompute-cache.json'
PATHS = (LEDGER_PATH, CACHE_PATH)
_SHA = re.compile(r'[a-f0-9]{40}')
MAX_BLOB_BYTES = 8 * 1024 * 1024
UNCERTAIN = {'started', 'failed_or_uncertain'}
STATUSES = UNCERTAIN | {'validated', 'recovered_existing_cache'}


class CheckpointError(ValueError):
    """Safe fixed code; never contains a provider/GitHub response or credential."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _fail(code):
    raise CheckpointError(code)


def _sha(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        _fail('checkpoint_invalid_git_sha')
    return value


def _canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':'), allow_nan=False).encode()
    except (TypeError, ValueError):
        _fail('checkpoint_invalid_json')


def _requests(ledger):
    if (type(ledger) is not dict or ledger.get('schemaVersion', 1) != 1
            or type(ledger.get('days')) is not dict):
        _fail('checkpoint_invalid_ledger')
    _pause_reasons(ledger)
    records = {}
    for day, daily in ledger['days'].items():
        if (not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day)
                or type(daily) is not dict or type(daily.get('requests')) is not list):
            _fail('checkpoint_invalid_ledger')
        _pause_reasons(daily)
        totals = [0, 0]
        for row in daily['requests']:
            if type(row) is not dict:
                _fail('checkpoint_invalid_request')
            tasks = [row['task']] if row.get('task') else row.get('tasks')
            if (not isinstance(tasks, list) or not tasks
                    or any(not isinstance(t, str) or t not in ('translate', 'study', 'quicklook') for t in tasks)
                    or len(set(tasks)) != len(tasks)
                    or not isinstance(row.get('paperID'), str) or not row['paperID']
                    or not isinstance(row.get('sourceHash'), str)
                    or not re.fullmatch('[a-f0-9]{64}', row['sourceHash'])
                    or not isinstance(row.get('at'), str) or not row['at']
                    or not isinstance(row.get('status'), str) or row['status'] not in STATUSES):
                _fail('checkpoint_invalid_request')
            identity = {k: row[k] for k in ('paperID', 'sourceHash', 'at')}
            identity['tasks'] = sorted(tasks)
            request_id = row.get('requestId')
            if request_id is not None and (not isinstance(request_id, str)
                    or not re.fullmatch('[A-Za-z0-9:_-]{1,128}', request_id)):
                _fail('checkpoint_invalid_request_id')
            key = 'id:' + request_id if request_id else 'legacy:' + hashlib.sha256(_canonical(identity)).hexdigest()
            for i, field in enumerate(('reservedAttempts', 'reservedOutputTokens')):
                value = row.get(field)
                if type(value) is not int or value < 0:
                    _fail('checkpoint_unaccounted_request')
                totals[i] += value
            if key in records:
                _fail('checkpoint_duplicate_request')
            records[key] = (day, identity, row)
        if any(type(daily.get(field)) is not int or daily[field] != totals[i]
               for i, field in enumerate(('reservedAttempts', 'reservedOutputTokens'))):
            _fail('checkpoint_unattributed_reservation')
    return records


def _cache(cache):
    if (type(cache) is not dict or cache.get('schemaVersion', 1) != 1
            or type(cache.get('entries')) is not dict):
        _fail('checkpoint_invalid_cache')
    for key, entry in cache['entries'].items():
        if (not isinstance(key, str) or type(entry) is not dict
                or entry.get('scope') != 'public-abstract'
                or entry.get('task') not in ('translate', 'study', 'quicklook')
                or not isinstance(entry.get('sourceHash'), str)
                or not re.fullmatch('[a-f0-9]{64}', entry['sourceHash'])):
            _fail('checkpoint_invalid_public_cache')
    return cache


def _pause_reasons(value):
    reasons = value.get('pauseReasons', [])
    paused = value.get('paused')
    if (not isinstance(reasons, list) or any(not isinstance(reason, str) for reason in reasons)
            or (paused is not None and not isinstance(paused, str))):
        _fail('checkpoint_invalid_pause')
    return [paused] + reasons


def _pauses_preserved(old, new):
    reasons = _pause_reasons(old)
    kept = _pause_reasons(new)
    if any(reason and reason not in kept for reason in reasons):
        _fail('checkpoint_pause_cannot_be_cleared')


@dataclass(frozen=True)
class Snapshot:
    head_sha: str
    ledger: dict
    cache: dict


class GitHubStateCheckpoint:
    """Serial, fail-closed conditional state commits, restricted to two paths.

    ``merge_ledger`` must union complete request records, reject ambiguous totals,
    and preserve all pauses/uncertain statuses (the existing snapshot importer
    supplies this function). Construction and import perform no network I/O.
    An exception from any GitHub operation poisons this instance; never retry it
    or a model call on the same instance. Restore in a later authorized run.
    """

    def __init__(self, repository: str, transport: Callable, merge_ledger: Callable):
        if (not isinstance(repository, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository)
                or any(part in ('.', '..') for part in repository.split('/'))):
            _fail('checkpoint_invalid_repository')
        if not callable(transport) or not callable(merge_ledger):
            _fail('checkpoint_missing_dependency')
        self._prefix = '/repos/' + repository
        self._transport = transport
        self._merge_ledger = merge_ledger
        self._head = self._tree = None
        self._ledger = self._cache = None
        self._owned = set()
        self._blocked = False

    @property
    def head_sha(self):
        return self._head

    def _api(self, method, path, body=None, expected=200):
        if self._blocked:
            _fail('checkpoint_instance_blocked')
        try:
            status, value = self._transport(method, self._prefix + path, body)
        except Exception:
            self._blocked = True
            _fail('checkpoint_transport_uncertain')
        if status != expected or type(value) is not dict:
            self._blocked = True
            code = ({401: 'checkpoint_authentication_failed', 403: 'checkpoint_access_or_rate_limit',
                     409: 'checkpoint_ref_conflict', 422: 'checkpoint_ref_conflict',
                     429: 'checkpoint_rate_limited'}.get(status, 'checkpoint_http_failed'))
            _fail(code)
        return value

    def _ref(self):
        value = self._api('GET', '/git/ref/heads/state')
        if (value.get('ref') != 'refs/heads/state' or type(value.get('object')) is not dict
                or value['object'].get('type') != 'commit'):
            _fail('checkpoint_invalid_state_ref')
        return _sha(value.get('object', {}).get('sha'))

    def _blob(self, sha):
        value = self._api('GET', '/git/blobs/' + _sha(sha))
        try:
            if value.get('encoding') != 'base64' or value.get('sha') != sha:
                raise ValueError()
            content = value['content']
            if not isinstance(content, str) or len(content) > MAX_BLOB_BYTES * 2:
                raise ValueError()
            raw = base64.b64decode(''.join(content.split()), validate=True)
            if len(raw) > MAX_BLOB_BYTES or value.get('size') != len(raw):
                raise ValueError()
            actual = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
            if actual != sha:
                raise ValueError()
            return json.loads(raw)
        except (KeyError, TypeError, ValueError, UnicodeError):
            _fail('checkpoint_invalid_blob')

    def restore(self, local_ledger, local_cache):
        """Read the live state ref and merge, never overwrite local reservations."""
        if self._head is not None:
            _fail('checkpoint_already_restored')
        _requests(local_ledger)
        _cache(local_cache)
        try:
            head = self._ref()
            commit = self._api('GET', '/git/commits/' + head)
            if commit.get('sha') != head:
                _fail('checkpoint_commit_mismatch')
            if type(commit.get('tree')) is not dict:
                _fail('checkpoint_invalid_commit_tree')
            tree_sha = _sha(commit['tree'].get('sha'))
            tree = self._api('GET', '/git/trees/' + tree_sha + '?recursive=1')
            if tree.get('sha') != tree_sha or tree.get('truncated') is not False or type(tree.get('tree')) is not list:
                _fail('checkpoint_incomplete_tree')
            entries = {}
            for entry in tree['tree']:
                if type(entry) is not dict:
                    _fail('checkpoint_invalid_tree')
                if entry.get('path') in PATHS:
                    if entry['path'] in entries or entry.get('type') != 'blob' or entry.get('mode') != '100644':
                        _fail('checkpoint_invalid_checkpoint_path')
                    entries[entry['path']] = self._blob(entry.get('sha'))
            if CACHE_PATH in entries and LEDGER_PATH not in entries:
                _fail('checkpoint_cache_without_ledger')
            remote_ledger = entries.get(LEDGER_PATH, {'schemaVersion': 1, 'days': {}})
            remote_cache = entries.get(CACHE_PATH, {'schemaVersion': 1, 'entries': {}})
            _requests(remote_ledger)
            _cache(remote_cache)
            try:
                merged = self._merge_ledger(copy.deepcopy(local_ledger), copy.deepcopy(remote_ledger))
            except Exception:
                _fail('checkpoint_ledger_merge_failed')
            _requests(merged)
            cache = copy.deepcopy(remote_cache)
            for key, entry in local_cache['entries'].items():
                if key in cache['entries'] and cache['entries'][key] != entry:
                    _fail('checkpoint_cache_key_conflict')
                cache['entries'][key] = copy.deepcopy(entry)
            # A concurrent writer during restore must not produce a stale base.
            if self._ref() != head:
                _fail('checkpoint_ref_changed')
            self._head, self._tree = head, tree_sha
            self._ledger, self._cache = copy.deepcopy(remote_ledger), copy.deepcopy(remote_cache)
            return Snapshot(head, merged, cache)
        except CheckpointError:
            self._blocked = True
            raise

    def _check_update(self, ledger, cache):
        old, new = _requests(self._ledger), _requests(ledger)
        _cache(cache)
        _pauses_preserved(self._ledger, ledger)
        for day, daily in self._ledger['days'].items():
            if day not in ledger['days']:
                _fail('checkpoint_history_cannot_be_removed')
            _pauses_preserved(daily, ledger['days'][day])
        for key, (day, identity, row) in old.items():
            if key not in new or new[key][:2] != (day, identity):
                _fail('checkpoint_request_cannot_be_removed')
            target = new[key][2]
            if any(target.get(field) != row[field] for field in ('reservedAttempts', 'reservedOutputTokens')):
                _fail('checkpoint_reservation_cannot_change')
            if target['status'] != row['status']:
                if not (key in self._owned and row['status'] == 'started'
                        and target['status'] in ('validated', 'failed_or_uncertain')):
                    _fail('checkpoint_unowned_status_transition')
        for key, entry in self._cache['entries'].items():
            if cache['entries'].get(key) != entry:
                _fail('checkpoint_cached_result_cannot_change')

    def save(self, ledger, cache):
        """Atomically persist only both checkpoint files; never silently retry."""
        if self._head is None:
            _fail('checkpoint_restore_required')
        if self._blocked:
            _fail('checkpoint_instance_blocked')
        self._check_update(ledger, cache)
        encoded = {LEDGER_PATH: _canonical(ledger), CACHE_PATH: _canonical(cache)}
        if any(len(data) > MAX_BLOB_BYTES for data in encoded.values()):
            _fail('checkpoint_too_large')
        try:
            if self._ref() != self._head:
                _fail('checkpoint_ref_changed')
            tree_entries = []
            for path, raw in encoded.items():
                blob = self._api('POST', '/git/blobs', {'content': base64.b64encode(raw).decode(), 'encoding': 'base64'}, 201)
                sha = _sha(blob.get('sha'))
                if sha != hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest():
                    _fail('checkpoint_blob_write_mismatch')
                tree_entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': sha})
            tree = self._api('POST', '/git/trees', {'base_tree': self._tree, 'tree': tree_entries}, 201)
            tree_sha = _sha(tree.get('sha'))
            commit = self._api('POST', '/git/commits', {'message': 'Persist public abstract precompute checkpoint',
                                'tree': tree_sha, 'parents': [self._head]}, 201)
            commit_sha = _sha(commit.get('sha'))
            if self._ref() != self._head:
                _fail('checkpoint_ref_changed')
            # A race after the check is rejected as non-fast-forward by GitHub.
            result = self._api('PATCH', '/git/refs/heads/state', {'sha': commit_sha, 'force': False})
            if (result.get('ref') != 'refs/heads/state' or type(result.get('object')) is not dict
                    or result['object'].get('sha') != commit_sha):
                _fail('checkpoint_ref_update_uncertain')
            if self._ref() != commit_sha:
                _fail('checkpoint_ref_update_uncertain')
            self._head, self._tree = commit_sha, tree_sha
            self._ledger, self._cache = copy.deepcopy(ledger), copy.deepcopy(cache)
            return Snapshot(commit_sha, copy.deepcopy(ledger), copy.deepcopy(cache))
        except CheckpointError:
            self._blocked = True
            raise

    def run_reserved(self, ledger, cache, request_id, model_call):
        """Persist one NEW accounted reservation, then dispatch once, synchronously."""
        if self._head is None:
            _fail('checkpoint_restore_required')
        key = 'id:' + request_id if isinstance(request_id, str) else ''
        old, records = _requests(self._ledger), _requests(ledger)
        if (key in old or key not in records or not callable(model_call)
                or records[key][2]['status'] != 'started'
                or records[key][2]['reservedAttempts'] <= 0
                or records[key][2]['reservedOutputTokens'] <= 0):
            _fail('checkpoint_new_reservation_required')
        if ledger.get('paused') or any(d.get('paused') for d in ledger['days'].values()):
            _fail('checkpoint_paid_work_paused')
        if any(k != key and r[2]['status'] in UNCERTAIN for k, r in records.items()):
            _fail('checkpoint_uncertain_prior_attempt')
        if set(records) - set(old) != {key}:
            _fail('checkpoint_one_reservation_required')
        self.save(ledger, cache)
        self._owned.add(key)
        return model_call()
