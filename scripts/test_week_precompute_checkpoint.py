"""Offline Git Data API fixtures: no token, network, remote refs, or model calls."""
import base64
import copy
import hashlib
import json
import unittest

from restore_week_precompute_snapshot import merge_ledger
from week_precompute_checkpoint import (CACHE_PATH, LEDGER_PATH, CheckpointError,
                                       GitHubStateCheckpoint)


def ledger():
    return {'schemaVersion': 1, 'days': {}}


def cache():
    return {'schemaVersion': 1, 'entries': {}}


def reserve(value, request_id='request-1'):
    daily = value['days'].setdefault('2026-10-07', {
        'reservedAttempts': 0, 'reservedOutputTokens': 0, 'requests': []})
    row = {'requestId': request_id, 'paperID': 'doi:10.1001/fixture',
           'sourceHash': 'a' * 64, 'at': '2026-10-07T12:00:00+00:00',
           'task': 'study', 'status': 'started', 'reservedAttempts': 2,
           'reservedOutputTokens': 3800}
    daily['requests'].append(row)
    daily['reservedAttempts'] += 2
    daily['reservedOutputTokens'] += 3800
    return row


def entry():
    return {'scope': 'public-abstract', 'task': 'study', 'sourceHash': 'a' * 64,
            'value': {'fixture': 'validated by caller'}}


class GitFixture:
    def __init__(self, initial_ledger=None, initial_cache=None):
        self.calls = []
        self.head = '1' * 40
        self.initial_head = self.head
        self.blobs = {}
        self.trees = {}
        self.commits = {}
        self.next_sha = 10
        self.fail = None
        self.race = False
        self.confirm_failure = False
        self.truncated = False
        self.ref_reads = 0
        items = [{'path': 'data/unrelated.json', 'type': 'blob',
                  'mode': '100644', 'sha': self.blob(b'{"keep":true}')},
                 {'path': 'public/index.html', 'type': 'blob',
                  'mode': '100644', 'sha': self.blob(b'keep') }]
        for path, value in ((LEDGER_PATH, initial_ledger), (CACHE_PATH, initial_cache)):
            if value is not None:
                items.append({'path': path, 'type': 'blob', 'mode': '100644',
                              'sha': self.blob(json.dumps(value).encode())})
        tree = self.sha()
        self.trees[tree] = items
        self.commits[self.head] = {'sha': self.head, 'tree': {'sha': tree}, 'parents': []}

    def sha(self):
        self.next_sha += 1
        return format(self.next_sha, '040x')

    def blob(self, raw):
        sha = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        self.blobs[sha] = {'sha': sha, 'content': base64.b64encode(raw).decode(),
                           'encoding': 'base64', 'size': len(raw)}
        return sha

    def __call__(self, method, path, body):
        self.calls.append((method, path, copy.deepcopy(body)))
        path = path.removeprefix('/repos/example/site')
        if self.fail and self.fail[:2] == (method, path):
            if self.fail[2] == 'exception':
                raise RuntimeError('fixture-secret must never reach error')
            return self.fail[2], {'message': 'fixture-secret must never reach error'}
        if method == 'GET' and path == '/git/ref/heads/state':
            self.ref_reads += 1
            if self.confirm_failure and self.head != self.initial_head:
                raise RuntimeError('uncertain after successful PATCH')
            return 200, {'ref': 'refs/heads/state', 'object': {'type': 'commit', 'sha': self.head}}
        if method == 'GET' and path.startswith('/git/commits/'):
            return 200, copy.deepcopy(self.commits[path.rsplit('/', 1)[1]])
        if method == 'GET' and path.startswith('/git/trees/'):
            sha = path.rsplit('/', 1)[1].split('?')[0]
            return 200, {'sha': sha, 'tree': copy.deepcopy(self.trees[sha]), 'truncated': self.truncated}
        if method == 'GET' and path.startswith('/git/blobs/'):
            return 200, copy.deepcopy(self.blobs[path.rsplit('/', 1)[1]])
        if method == 'POST' and path == '/git/blobs':
            return 201, {'sha': self.blob(base64.b64decode(body['content']))}
        if method == 'POST' and path == '/git/trees':
            entries = {entry['path']: entry for entry in copy.deepcopy(self.trees[body['base_tree']])}
            entries.update({entry['path']: entry for entry in body['tree']})
            sha = self.sha()
            self.trees[sha] = list(entries.values())
            return 201, {'sha': sha}
        if method == 'POST' and path == '/git/commits':
            sha = self.sha()
            self.commits[sha] = {'sha': sha, 'tree': {'sha': body['tree']}, 'parents': body['parents']}
            return 201, {'sha': sha}
        if method == 'PATCH' and path == '/git/refs/heads/state':
            if self.race:
                self.head = 'f' * 40
            if self.commits[body['sha']]['parents'] != [self.head]:
                return 409, {'message': 'not fast forward'}
            assert body['force'] is False
            self.head = body['sha']
            return 200, {'ref': 'refs/heads/state', 'object': {'type': 'commit', 'sha': self.head}}
        raise AssertionError((method, path))

    def contents(self, path):
        tree = self.trees[self.commits[self.head]['tree']['sha']]
        blob = next(item['sha'] for item in tree if item['path'] == path)
        return json.loads(base64.b64decode(self.blobs[blob]['content']))


class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.remote = GitFixture(ledger(), cache())
        self.backend = GitHubStateCheckpoint('example/site', self.remote, merge_ledger)
        snapshot = self.backend.restore(ledger(), cache())
        self.ledger, self.cache = snapshot.ledger, snapshot.cache

    def test_restore_is_read_only_and_constructor_has_no_io(self):
        remote = GitFixture()
        backend = GitHubStateCheckpoint('example/site', remote, merge_ledger)
        self.assertFalse(remote.calls)
        result = backend.restore(ledger(), cache())
        self.assertEqual(result.ledger, ledger())
        self.assertTrue(all(call[0] == 'GET' for call in remote.calls))

    def test_model_observes_durable_reservation_before_dispatch(self):
        row = reserve(self.ledger)
        calls = []
        def model():
            calls.append(self.remote.contents(LEDGER_PATH)['days']['2026-10-07']['requests'][0])
            return 'result'
        self.assertEqual(self.backend.run_reserved(self.ledger, self.cache, row['requestId'], model), 'result')
        self.assertEqual(calls, [row])
        self.assertEqual(self.remote.contents(CACHE_PATH), self.cache)
        self.assertNotEqual(self.backend.head_sha, self.remote.initial_head)

    def test_only_two_paths_updated_in_atomic_commit_preserving_other_files(self):
        row = reserve(self.ledger)
        self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: None)
        trees = [body for method, path, body in self.remote.calls if method == 'POST' and path.endswith('/trees')]
        self.assertEqual({entry['path'] for entry in trees[0]['tree']}, {LEDGER_PATH, CACHE_PATH})
        self.assertEqual(self.remote.contents('data/unrelated.json'), {'keep': True})
        commit = self.remote.commits[self.remote.head]
        self.assertEqual(commit['parents'], [self.remote.initial_head])
        self.assertTrue(all(body['force'] is False for method, _, body in self.remote.calls if method == 'PATCH'))

    def test_validated_cache_and_result_status_saved_together(self):
        row = reserve(self.ledger)
        self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: None)
        first = self.remote.head
        row['status'] = 'validated'
        self.cache['entries']['a'] = entry()
        self.backend.save(self.ledger, self.cache)
        self.assertEqual(self.remote.commits[self.remote.head]['parents'], [first])
        self.assertEqual(self.remote.contents(CACHE_PATH), self.cache)
        self.assertEqual(self.remote.contents(LEDGER_PATH), self.ledger)

    def test_401_403_429_never_dispatch_or_retry_and_errors_are_safe(self):
        for status, code in [(401, 'authentication_failed'), (403, 'access_or_rate_limit'), (429, 'rate_limited')]:
            with self.subTest(status=status):
                self.setUp()
                row = reserve(self.ledger)
                self.remote.fail = ('POST', '/git/blobs', status)
                with self.assertRaisesRegex(CheckpointError, code):
                    self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: self.fail('model called'))
                count = len(self.remote.calls)
                with self.assertRaisesRegex(CheckpointError, 'instance_blocked'):
                    self.backend.save(self.ledger, self.cache)
                self.assertEqual(len(self.remote.calls), count)
                self.assertEqual(self.remote.head, self.remote.initial_head)

    def test_ref_conflict_after_precheck_never_dispatches_or_overwrites(self):
        row = reserve(self.ledger)
        self.remote.race = True
        with self.assertRaisesRegex(CheckpointError, 'ref_conflict'):
            self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: self.fail('model called'))
        self.assertEqual(self.remote.head, 'f' * 40)

    def test_changed_ref_before_write_stops_without_mutation(self):
        row = reserve(self.ledger)
        self.remote.head = 'e' * 40
        before = len(self.remote.calls)
        with self.assertRaisesRegex(CheckpointError, 'ref_changed'):
            self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: self.fail('model called'))
        self.assertTrue(all(call[0] == 'GET' for call in self.remote.calls[before:]))

    def test_uncertain_successful_patch_retains_reservation_without_dispatch(self):
        row = reserve(self.ledger)
        self.remote.confirm_failure = True
        with self.assertRaisesRegex(CheckpointError, 'transport_uncertain'):
            self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: self.fail('model called'))
        self.assertEqual(self.remote.contents(LEDGER_PATH), self.ledger)
        self.assertEqual(self.remote.contents(LEDGER_PATH)['days']['2026-10-07']['reservedOutputTokens'], 3800)

    def test_model_exception_leaves_started_reservation_for_next_runner(self):
        row = reserve(self.ledger)
        def model():
            raise RuntimeError('model failed')
        with self.assertRaisesRegex(RuntimeError, 'model failed'):
            self.backend.run_reserved(self.ledger, self.cache, row['requestId'], model)
        again = GitHubStateCheckpoint('example/site', self.remote, merge_ledger)
        snapshot = again.restore(ledger(), cache())
        next_row = reserve(snapshot.ledger, 'request-2')
        with self.assertRaisesRegex(CheckpointError, 'uncertain_prior_attempt'):
            again.run_reserved(snapshot.ledger, snapshot.cache, next_row['requestId'], lambda: self.fail('model called'))

    def test_after_model_save_failure_stops_further_calls_and_keeps_reservation(self):
        row = reserve(self.ledger)
        self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: None)
        row['status'] = 'validated'
        self.cache['entries']['a'] = entry()
        self.remote.fail = ('POST', '/git/blobs', 403)
        with self.assertRaises(CheckpointError):
            self.backend.save(self.ledger, self.cache)
        remote_row = self.remote.contents(LEDGER_PATH)['days']['2026-10-07']['requests'][0]
        self.assertEqual(remote_row['status'], 'started')
        with self.assertRaises(CheckpointError):
            self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: self.fail('model called'))

    def test_same_request_cannot_dispatch_twice(self):
        row = reserve(self.ledger)
        self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: None)
        before = len(self.remote.calls)
        with self.assertRaisesRegex(CheckpointError, 'new_reservation_required'):
            self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: self.fail('model called'))
        self.assertEqual(len(self.remote.calls), before)

    def test_restore_unions_independent_requests_and_preserves_pause(self):
        local = ledger()
        a = reserve(local, 'local')
        a['status'] = 'validated'
        remote = ledger()
        reserve(remote, 'remote')
        remote['paused'] = 'model_failed'
        fixture = GitFixture(remote, cache())
        backend = GitHubStateCheckpoint('example/site', fixture, merge_ledger)
        result = backend.restore(local, cache())
        daily = result.ledger['days']['2026-10-07']
        self.assertEqual((daily['reservedAttempts'], daily['reservedOutputTokens']), (4, 7600))
        self.assertEqual(result.ledger['paused'], 'model_failed')
        self.assertEqual(len(daily['requests']), 2)
        self.assertEqual(remote['days']['2026-10-07']['reservedAttempts'], 2)

    def test_cached_reads_do_not_reserve_or_call_model(self):
        self.cache['entries']['a'] = entry()
        self.backend.save(self.ledger, self.cache)
        self.assertEqual(self.remote.contents(LEDGER_PATH), ledger())

    def test_missing_old_output_accounting_fails_closed(self):
        value = ledger()
        reserve(value)
        del value['days']['2026-10-07']['reservedOutputTokens']
        fixture = GitFixture(value, cache())
        backend = GitHubStateCheckpoint('example/site', fixture, merge_ledger)
        with self.assertRaisesRegex(CheckpointError, 'unattributed_reservation'):
            backend.restore(ledger(), cache())

    def test_remote_uncertainty_is_not_resolved_by_local_success(self):
        remote = ledger()
        reserve(remote)
        local = copy.deepcopy(remote)
        local['days']['2026-10-07']['requests'][0]['status'] = 'validated'
        fixture = GitFixture(remote, cache())
        backend = GitHubStateCheckpoint('example/site', fixture, merge_ledger)
        result = backend.restore(local, cache())
        self.assertEqual(result.ledger['days']['2026-10-07']['requests'][0]['status'], 'started')
        result.ledger['days']['2026-10-07']['requests'][0]['status'] = 'validated'
        with self.assertRaisesRegex(CheckpointError, 'unowned_status_transition'):
            backend.save(result.ledger, result.cache)

    def test_pause_cannot_be_cleared(self):
        remote = ledger()
        remote['paused'] = 'failure'
        fixture = GitFixture(remote, cache())
        backend = GitHubStateCheckpoint('example/site', fixture, merge_ledger)
        result = backend.restore(ledger(), cache())
        del result.ledger['paused']
        result.ledger.pop('pauseReasons', None)
        with self.assertRaisesRegex(CheckpointError, 'pause_cannot_be_cleared'):
            backend.save(result.ledger, result.cache)

    def test_existing_cache_cannot_be_overwritten_or_removed(self):
        self.cache['entries']['a'] = entry()
        self.backend.save(self.ledger, self.cache)
        self.cache['entries'].clear()
        with self.assertRaisesRegex(CheckpointError, 'cached_result_cannot_change'):
            self.backend.save(self.ledger, self.cache)

    def test_cache_collision_restore_rejected(self):
        remote_cache = cache()
        remote_cache['entries']['a'] = entry()
        local_cache = copy.deepcopy(remote_cache)
        local_cache['entries']['a']['value'] = 'different'
        backend = GitHubStateCheckpoint('example/site', GitFixture(ledger(), remote_cache), merge_ledger)
        with self.assertRaisesRegex(CheckpointError, 'cache_key_conflict'):
            backend.restore(ledger(), local_cache)

    def test_truncated_tree_rejected(self):
        fixture = GitFixture(ledger(), cache())
        fixture.truncated = True
        backend = GitHubStateCheckpoint('example/site', fixture, merge_ledger)
        with self.assertRaisesRegex(CheckpointError, 'incomplete_tree'):
            backend.restore(ledger(), cache())

    def test_cache_without_ledger_rejected(self):
        backend = GitHubStateCheckpoint('example/site', GitFixture(None, cache()), merge_ledger)
        with self.assertRaisesRegex(CheckpointError, 'cache_without_ledger'):
            backend.restore(ledger(), cache())

    def test_git_blob_hash_mismatch_rejected(self):
        fixture = GitFixture(ledger(), cache())
        for blob in fixture.blobs.values():
            blob['content'] = base64.b64encode(b'{}').decode()
            blob['size'] = 2
        backend = GitHubStateCheckpoint('example/site', fixture, merge_ledger)
        with self.assertRaisesRegex(CheckpointError, 'invalid_blob'):
            backend.restore(ledger(), cache())

    def test_private_cache_is_not_accepted(self):
        self.cache['entries']['a'] = dict(entry(), scope='private-pdf')
        with self.assertRaisesRegex(CheckpointError, 'invalid_public_cache'):
            self.backend.save(self.ledger, self.cache)

    def test_reservation_cannot_be_refunded_or_removed(self):
        row = reserve(self.ledger)
        self.backend.run_reserved(self.ledger, self.cache, row['requestId'], lambda: None)
        with self.assertRaisesRegex(CheckpointError, 'history_cannot_be_removed'):
            self.backend.save(ledger(), self.cache)
        daily = self.ledger['days']['2026-10-07']
        row['reservedOutputTokens'] = daily['reservedOutputTokens'] = 1
        with self.assertRaisesRegex(CheckpointError, 'reservation_cannot_change'):
            self.backend.save(self.ledger, self.cache)

    def test_missing_or_empty_request_id_cannot_dispatch(self):
        reserve(self.ledger)
        for key in ('', None, 'absent'):
            with self.subTest(key=key), self.assertRaisesRegex(CheckpointError, 'new_reservation_required'):
                self.backend.run_reserved(self.ledger, self.cache, key, lambda: self.fail('model called'))

    def test_zero_or_multiple_reservations_cannot_dispatch(self):
        reserve(self.ledger)
        reserve(self.ledger, 'request-2')
        with self.assertRaises(CheckpointError):
            self.backend.run_reserved(self.ledger, self.cache, 'request-2', lambda: self.fail('model called'))

    def test_malformed_request_and_pause_fail_with_safe_codes(self):
        for mutation in (
            lambda d, r: r.update(tasks=[{}], task=None),
            lambda d, r: r.update(status='unknown'),
            lambda d, r: d.update(pauseReasons='not-a-list'),
        ):
            with self.subTest(mutation=mutation):
                value = ledger()
                row = reserve(value)
                mutation(value['days']['2026-10-07'], row)
                with self.assertRaises(CheckpointError):
                    self.backend.save(value, cache())

    def test_bad_repository_and_restore_required_do_not_call_transport(self):
        with self.assertRaisesRegex(CheckpointError, 'invalid_repository'):
            GitHubStateCheckpoint('example/site/../../other', lambda *args: self.fail('called'), merge_ledger)
        backend = GitHubStateCheckpoint('example/site', lambda *args: self.fail('called'), merge_ledger)
        with self.assertRaisesRegex(CheckpointError, 'restore_required'):
            backend.save(ledger(), cache())


if __name__ == '__main__':
    unittest.main()
