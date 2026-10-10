import copy
import datetime
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import ci_daily
import finalize_pipeline


class PipelineFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'public').mkdir()
        (self.root / 'docs').mkdir()
        (self.root / 'data').mkdir()
        (self.root / 'data/deep-readings.json').write_text(json.dumps({'schemaVersion': 1, 'generatorVersion': 3, 'items': [], 'status': {'state': 'pending', 'target': 4}}))
        self.data = {'updatedAt': 'old', 'items': [{'id': 'a', 'title': 'Cardiac AI', 'date': '2026-09-29', 'publication_date': '2026-09-29', 'publishedAt': '2026-09-29', 'draftData': {'published': '2026-09-30', 'source_date': '2026-09-28'}, 'weeklyAt': 'old'}]}
        for name in ci_daily.PUBLIC:
            (self.root / 'public' / name).write_text('asset: ' + name)
        self.write_bundle(self.data)
        (self.root / 'docs' / 'public-manifest.json').write_text(json.dumps({'release': 'v13.5', 'counts': {'radar': 350, 'library': 1300}}))
        self.root_patch = patch.object(ci_daily, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def write_bundle(self, data, app='const application = 1;'):
        (self.root / 'public' / 'public.js').write_text('window.FEEDS=' + json.dumps(data) + ';\n;\n' + app)

    def invoke(self, *, fast=True, run=None, clock=None):
        outputs = []
        with patch.object(sys, 'argv', ['ci_daily.py'] + (['--fast'] if fast else [])), patch.object(ci_daily, 'run', side_effect=run or (lambda argv, timeout: (0, '', ''))) as mock_run, patch.object(ci_daily, 'out', side_effect=outputs.append):
            if clock is None:
                result = ci_daily.main()
            else:
                with patch.object(ci_daily.time, 'monotonic', side_effect=clock):
                    result = ci_daily.main()
        report = json.loads((self.root / 'docs' / 'last-refresh.json').read_text())
        return result, report, outputs, [call.args[0] for call in mock_run.call_args_list]


class ContentHashTests(PipelineFixture):
    def test_nested_refresh_times_do_not_change_hash(self):
        data = copy.deepcopy(self.data)
        data['metadata'] = {key: 'old' for key in ci_daily.VOLATILE_KEYS}
        data['items'][0]['refresh'] = {'checkedAt': 'old', 'fetchedAt': 'old'}
        self.write_bundle(data)
        before = ci_daily.content_hash()
        data['updatedAt'] = 'new'
        data['items'][0]['weeklyAt'] = 'new'
        data['metadata'] = {key: 'new' for key in ci_daily.VOLATILE_KEYS}
        data['items'][0]['refresh'] = {'checkedAt': 'new', 'fetchedAt': 'new'}
        self.write_bundle(data)
        self.assertEqual(before, ci_daily.content_hash())

    def test_article_dates_and_text_remain_substantive(self):
        before = ci_daily.content_hash()
        for key in ('date', 'publication_date', 'publishedAt', 'title'):
            with self.subTest(key=key):
                data = copy.deepcopy(self.data)
                data['items'][0][key] = 'changed'
                self.write_bundle(data)
                self.assertNotEqual(before, ci_daily.content_hash())
        for key in ('published', 'source_date'):
            with self.subTest(key=key):
                data = copy.deepcopy(self.data)
                data['items'][0]['draftData'][key] = 'changed'
                self.write_bundle(data)
                self.assertNotEqual(before, ci_daily.content_hash())

    def test_timestamp_words_in_article_text_are_preserved(self):
        data = copy.deepcopy(self.data)
        data['items'][0]['summary'] = 'The field "createdAt": "old" is an example.'
        self.write_bundle(data)
        before = ci_daily.content_hash()
        data['items'][0]['summary'] = 'The field "createdAt": "new" is an example.'
        self.write_bundle(data)
        self.assertNotEqual(before, ci_daily.content_hash())

    def test_application_examples_are_preserved(self):
        self.write_bundle(self.data, 'const example = `window.FEEDS={"updatedAt":"old"};`;')
        before = ci_daily.content_hash()
        self.write_bundle(self.data, 'const example = `window.FEEDS={"updatedAt":"new"};`;')
        self.assertNotEqual(before, ci_daily.content_hash())

    def test_every_other_public_asset_is_hashed(self):
        before = ci_daily.content_hash()
        for name in sorted(ci_daily.PUBLIC - {'public.js'}):
            with self.subTest(name=name):
                path = self.root / 'public' / name
                original = path.read_text()
                path.write_text(original + ' changed')
                self.assertNotEqual(before, ci_daily.content_hash())
                path.write_text(original)

    def test_list_order_is_preserved(self):
        data = copy.deepcopy(self.data)
        data['items'].append({'id': 'b', 'title': 'Another paper'})
        self.write_bundle(data)
        before = ci_daily.content_hash()
        data['items'].reverse()
        self.write_bundle(data)
        self.assertNotEqual(before, ci_daily.content_hash())

    def test_all_bundle_constants_are_normalized(self):
        names = ('LIBRARY', 'FEEDS', 'SOURCE_HEALTH', 'CURATED', 'QUICKLOOKS', 'CONTENT_STATUS',
                 'JOURNAL_METRICS', 'WEEKLY_BOARD', 'PREGENERATED', 'RADAR', 'DEEP_READINGS')
        old = '\n;\n'.join('window.' + name + '={"generatedAt":"old","papers":[{"id":"a"}]};' for name in names)
        (self.root / 'public' / 'public.js').write_text(old + '\n;\nconst app = 1;')
        before = ci_daily.content_hash()
        (self.root / 'public' / 'public.js').write_text(old.replace('"old"', '"new"') + '\n;\nconst app = 1;')
        self.assertEqual(before, ci_daily.content_hash())

    def test_metric_and_precomputed_content_changes_after_new_global_are_substantive(self):
        def write(value, translation):
            (self.root / 'public' / 'public.js').write_text(
                'window.JOURNAL_METRICS=' + json.dumps({'journals': [{'jif': {'value': value}}]})
                + ';\n;\nwindow.PREGENERATED=' + json.dumps({'pmid:1': {'translation': {'abstract_zh': translation}}})
                + ';\n;\nconst app = 1;')
        write(1, 'offline fixture A')
        before = ci_daily.content_hash()
        write(2, 'offline fixture A')
        self.assertNotEqual(before, ci_daily.content_hash())
        write(1, 'offline fixture B')
        self.assertNotEqual(before, ci_daily.content_hash())

    def test_content_status_timestamps_and_coverage_have_distinct_meaning(self):
        status = {'release': 'v13.5', 'builtAt': 'old', 'radarUpdatedAt': 'old', 'healthCheckedAt': 'old', 'guideLatestPublishedAt': '2026-09-30', 'quicklookLatestAt': '2026-10-01', 'counts': {'guides': 12}}
        def write(value):
            (self.root / 'public' / 'public.js').write_text('window.CONTENT_STATUS=' + json.dumps(value) + ';\n;\nconst app = 1;')
        write(status)
        before = ci_daily.content_hash()
        changed_times = dict(status, builtAt='new', radarUpdatedAt='new', healthCheckedAt='new')
        write(changed_times)
        self.assertEqual(before, ci_daily.content_hash())
        for field in ('guideLatestPublishedAt', 'quicklookLatestAt'):
            with self.subTest(field=field):
                write(dict(status, **{field: '2026-10-07'}))
                self.assertNotEqual(before, ci_daily.content_hash())
        write(dict(status, counts={'guides': 13}))
        self.assertNotEqual(before, ci_daily.content_hash())


class RefreshExecutionTests(PipelineFixture):
    def test_fast_skips_heavy_steps_and_reports_unchanged(self):
        with patch.dict(os.environ, {'XINZHI_FAST_TITLE_BATCH': ''}):
            result, report, outputs, calls = self.invoke()
        names = [argv[0] for argv in calls]
        for name in ('generate_quicklooks.py', 'fetch_archive.py', 'archive_details.py', 'translate_titles.py'):
            self.assertNotIn('scripts/' + name, names)
        self.assertIn('scripts/auto_picks.py', names)
        self.assertEqual(result, 0)
        self.assertTrue(report['fast'])
        self.assertFalse(report['changed'])
        self.assertFalse(report['deploymentRequested'])
        self.assertEqual(report['status'], 'success')
        self.assertIn('finishedAt', report)
        self.assertEqual(outputs, [False])

    def test_scheduled_fast_translates_one_bounded_title_batch(self):
        with patch.dict(os.environ, {'XINZHI_FAST_TITLE_BATCH': '1'}):
            result, report, outputs, calls = self.invoke()
        self.assertIn(ci_daily.FAST_TITLES[0], calls)
        self.assertEqual(ci_daily.FAST_TITLES[0][-2:], ['--limit', '1'])
        self.assertLess(calls.index(ci_daily.FAST_TITLES[0]), calls.index(ci_daily.BUILD))
        self.assertIn(ci_daily.FAST_QUICKLOOKS[0], calls)
        self.assertEqual(ci_daily.FAST_QUICKLOOKS[0][2:4], ['--limit', '2'])
        for name in ('fetch_archive.py', 'archive_details.py'):
            self.assertNotIn('scripts/' + name, [argv[0] for argv in calls])

    def test_fast_uses_existing_reading_cache_without_paid_work(self):
        result, report, outputs, calls = self.invoke()
        self.assertNotIn(ci_daily.DEEP_READING, calls)
        self.assertIn(ci_daily.DEEP_READING_RECOVER, calls)
        self.assertNotIn('--run', ci_daily.DEEP_READING_RECOVER)
        self.assertEqual(report['deepReadings']['state'], 'pending')

    def test_new_column_bootstraps_once_before_build(self):
        (self.root / 'data/deep-readings.json').unlink()
        result, report, outputs, calls = self.invoke()
        self.assertIn(ci_daily.DEEP_READING, calls)
        self.assertLess(calls.index(ci_daily.DEEP_READING), calls.index(ci_daily.BUILD))

    def test_successful_full_run_records_the_day(self):
        result, report, outputs, calls = self.invoke(fast=False)
        self.assertEqual(result, 0)
        marker = json.loads((self.root / ci_daily.FULL_MARKER).read_text())
        self.assertEqual(marker['day'], ci_daily.beijing_now().date().isoformat())

    def test_daily_readings_precede_optional_archive_enrichment(self):
        result, report, outputs, calls = self.invoke(fast=False)
        self.assertLess(calls.index(ci_daily.DEEP_READING), calls.index(ci_daily.FULL_OPTIONAL[0][0]))

    def test_timestamp_only_rebuild_does_not_request_fast_deploy(self):
        def run(argv, timeout):
            if argv == ci_daily.BUILD:
                data = copy.deepcopy(self.data)
                data['updatedAt'] = 'new'
                data['items'][0]['weeklyAt'] = 'new'
                self.write_bundle(data)
            return 0, '', ''
        result, report, outputs, _ = self.invoke(run=run)
        self.assertEqual(result, 0)
        self.assertFalse(report['changed'])
        self.assertEqual(outputs, [False])

    def test_real_content_change_requests_fast_deploy(self):
        def run(argv, timeout):
            if argv == ci_daily.BUILD:
                (self.root / 'public' / 'style.css').write_text('new style')
            return 0, '', ''
        result, report, outputs, _ = self.invoke(run=run)
        self.assertEqual(result, 0)
        self.assertTrue(report['changed'])
        self.assertEqual(outputs, [True])

    def test_full_enriches_before_quicklooks_and_optional_failure_continues(self):
        def run(argv, timeout):
            return (7, '', 'model failed') if argv[0] == 'scripts/week_precompute.py' and '--run' in argv else (0, '', '')
        result, report, outputs, calls = self.invoke(fast=False, run=run)
        names = [argv[0] for argv in calls]
        self.assertLess(names.index('scripts/archive_details.py'), names.index('scripts/week_precompute.py'))
        self.assertEqual(result, 0)
        self.assertFalse(report['fast'])
        self.assertEqual(report['status'], 'success')
        self.assertEqual(outputs, [True])
        self.assertTrue(any(step['optional'] and step['exitCode'] == 7 for step in report['steps']))

    def test_required_failure_is_reported_without_deploy(self):
        result, report, outputs, calls = self.invoke(run=lambda argv, timeout: (3, '', 'source failed'))
        self.assertEqual(result, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], ['scripts/apply_public_library.py'])
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(report['fast'])
        self.assertIsNone(report['changed'])
        self.assertIn('finishedAt', report)
        self.assertEqual(outputs, [False])

    def test_build_failure_is_reported(self):
        result, report, outputs, _ = self.invoke(run=lambda argv, timeout: (2, '', 'build failed') if argv == ci_daily.BUILD else (0, '', ''))
        self.assertEqual(result, 1)
        self.assertEqual(report['problems'], ['public build failed'])
        self.assertIsNone(report['changed'])
        self.assertEqual(outputs, [False])

    def test_sanity_failure_is_reported(self):
        (self.root / 'public' / 'private.json').write_text('{}')
        result, report, outputs, _ = self.invoke()
        self.assertEqual(result, 1)
        self.assertTrue(any('private.json' in problem for problem in report['problems']))
        self.assertEqual(outputs, [False])

    def test_missing_manifest_fails_sanity(self):
        (self.root / 'docs' / 'public-manifest.json').unlink()
        result, report, outputs, _ = self.invoke()
        self.assertEqual(result, 1)
        self.assertTrue(any('manifest unreadable' in problem for problem in report['problems']))
        self.assertEqual(outputs, [False])

    def test_budget_skips_optional_steps_but_reserves_build(self):
        # Light steps and the model-free reading recovery are optional; board and build are not.
        clock = [0] * (1 + len(ci_daily.REQUIRED)) + [1250] * (len(ci_daily.LIGHT_OPTIONAL) + 3)
        result, report, outputs, calls = self.invoke(clock=clock)
        self.assertEqual(result, 0)
        self.assertEqual(calls[-1], ci_daily.BUILD)
        self.assertEqual(sum(step.get('outcome') == 'skipped' for step in report['steps']), len(ci_daily.LIGHT_OPTIONAL) + 1)
        self.assertEqual(outputs, [False])

    def test_required_budget_exhaustion_is_reported(self):
        result, report, outputs, calls = self.invoke(clock=[0, 1300])
        self.assertEqual(result, 1)
        self.assertEqual(calls, [])
        self.assertEqual(report['steps'][0]['exitCode'], 124)
        self.assertEqual(outputs, [False])

    def test_full_archive_work_reserves_time_for_model_and_build(self):
        timeouts = {}
        def run(argv, timeout):
            timeouts[argv[0] + (':paid' if '--run' in argv else '')] = timeout
            return 0, '', ''
        # Archive work reaches its budget, leaving 600 seconds for the model and
        # 300 for the build. Later archive/translation steps must be skipped.
        clock = [0] * (1 + len(ci_daily.REQUIRED) + len(ci_daily.LIGHT_OPTIONAL)) + [0, 1000, 2100, 2100, 2100, 2100, 2700, 2700, 2700]
        result, report, outputs, calls = self.invoke(fast=False, run=run, clock=clock)
        self.assertEqual(result, 0)
        self.assertEqual(timeouts['scripts/fetch_archive.py'], 1100)
        self.assertNotIn('scripts/archive_details.py', timeouts)
        self.assertNotIn('scripts/translate_titles.py', timeouts)
        self.assertNotIn('scripts/generate_quicklooks.py', timeouts)
        self.assertEqual(timeouts['scripts/week_precompute.py:paid'], 600)
        self.assertEqual(timeouts['scripts/build_public.py'], 300)
        self.assertEqual(outputs, [True])


class DeploymentEvidenceTests(PipelineFixture):
    def status(self, **changes):
        args = dict(refresh_outcome='success', deployment_outcome='success', state_outcome='success', deployment_requested='true', run_url='https://github.com/owner/repo/actions/runs/123', code_sha='abc123', run_attempt='1')
        args.update(changes)
        return finalize_pipeline.make_status(self.root, **args)

    def test_success_requires_observed_pages_success(self):
        status = self.status()
        self.assertTrue(status['deployed'])
        self.assertEqual(status['status'], 'deployed')
        self.assertEqual(status['codeSha'], 'abc123')
        self.assertTrue(status['recordedAt'].endswith('+00:00'))
        self.assertEqual(status['build']['release'], 'v13.5')

    def test_saved_state_does_not_imply_pages_deployed(self):
        status = self.status(deployment_outcome='failure')
        self.assertFalse(status['deployed'])
        self.assertEqual(status['status'], 'failed')

    def test_refresh_failure_is_not_deployed(self):
        self.assertFalse(self.status(refresh_outcome='failure')['deployed'])

    def test_unchanged_refresh_records_no_deploy(self):
        status = self.status(deployment_requested='false', deployment_outcome='skipped', state_outcome='skipped')
        self.assertFalse(status['deployed'])
        self.assertEqual(status['status'], 'not_requested')

    def test_pages_success_and_state_failure_are_distinct(self):
        status = self.status(state_outcome='failure')
        self.assertTrue(status['deployed'])
        self.assertEqual(status['stateOutcome'], 'failure')

    def test_missing_refresh_report_is_explicit(self):
        self.assertEqual(self.status()['refresh'], {'available': False})

    def test_snapshot_does_not_claim_state_write_finished(self):
        status = self.status(state_outcome='pending')
        self.assertTrue(status['deployed'])
        self.assertEqual(status['recordKind'], 'deployment_snapshot')
        self.assertEqual(status['stateOutcome'], 'pending')
        self.assertEqual(self.status()['recordKind'], 'pipeline_final')

    def test_restored_manifest_is_not_reported_as_current_build(self):
        self.assertFalse(self.status()['build']['currentAttempt'])
        (self.root / 'docs' / 'last-refresh.json').write_text(json.dumps({'runId': '123', 'runAttempt': '1', 'codeSha': 'abc123', 'steps': [{'script': 'scripts/build_public.py', 'exitCode': 0}]}))
        self.assertTrue(self.status()['build']['currentAttempt'])

    def test_old_report_is_not_current_when_restore_fails(self):
        (self.root / 'docs' / 'last-refresh.json').write_text(json.dumps({'runId': '122', 'runAttempt': '1', 'codeSha': 'abc123', 'steps': [{'script': 'scripts/build_public.py', 'exitCode': 0}]}))
        status = self.status(refresh_outcome='skipped', deployment_outcome='skipped', deployment_requested='')
        self.assertFalse(status['deployed'])
        self.assertFalse(status['refresh']['currentAttempt'])
        self.assertFalse(status['build']['currentAttempt'])

    def test_attempt_and_code_identity_must_also_match(self):
        for identity in ({'runId': '123', 'runAttempt': '2', 'codeSha': 'abc123'}, {'runId': '123', 'runAttempt': '1', 'codeSha': 'different'}):
            with self.subTest(identity=identity):
                data = dict(identity, steps=[{'script': 'scripts/build_public.py', 'exitCode': 0}])
                (self.root / 'docs' / 'last-refresh.json').write_text(json.dumps(data))
                self.assertFalse(self.status()['refresh']['currentAttempt'])
                self.assertFalse(self.status()['build']['currentAttempt'])


class FullRefreshOncePerDayTests(unittest.TestCase):
    BJ = datetime.timezone(datetime.timedelta(hours=8))

    def decide(self, fast, marker_day=None, hour=6, enabled='1'):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            if marker_day:
                (root / ci_daily.FULL_MARKER).write_text(json.dumps({'day': marker_day}))
            now = datetime.datetime(2026, 10, 11, hour, 7, tzinfo=self.BJ)
            with patch.dict(os.environ, {'XINZHI_DAILY_FULL_ONCE': enabled}):
                return ci_daily.full_refresh_decision(fast, root, now)

    def test_timed_fast_run_catches_up_a_missing_full_refresh(self):
        self.assertEqual(self.decide(True, '2026-10-10'), (False, 'catch_up_missing_full_refresh'))
        self.assertEqual(self.decide(True), (False, 'catch_up_missing_full_refresh'))

    def test_no_catch_up_before_five_or_after_success(self):
        self.assertEqual(self.decide(True, '2026-10-10', hour=4), (True, None))
        self.assertEqual(self.decide(True, '2026-10-11'), (True, None))

    def test_late_scheduled_full_downgrades_once_done(self):
        self.assertEqual(self.decide(False, '2026-10-11'), (True, 'full_refresh_already_done_today'))
        self.assertEqual(self.decide(False, '2026-10-10'), (False, None))

    def test_pushes_and_manual_full_runs_are_unaffected(self):
        self.assertEqual(self.decide(True, '2026-10-10', enabled=''), (True, None))
        self.assertEqual(self.decide(False, '2026-10-11', enabled=''), (False, None))

    def test_successful_full_run_writes_the_marker(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(ci_daily, 'ROOT', Path(tmp)), \
                patch.object(ci_daily, 'content_hash', return_value='h'), patch.object(ci_daily, 'out'), \
                patch.object(sys, 'argv', ['ci_daily.py']), patch.object(ci_daily, 'run', side_effect=lambda argv, timeout: (1, '', 'x')):
            (Path(tmp) / 'data').mkdir()
            ci_daily.main()  # required step fails: no marker
            self.assertFalse((Path(tmp) / ci_daily.FULL_MARKER).exists())


if __name__ == '__main__':
    unittest.main()
