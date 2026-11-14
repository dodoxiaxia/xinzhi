"""Unit tests for first-screen payload split and compression size budget gate."""
import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_public as builder
import check_first_screen_budget as cli
import public_bundle
import public_split


class _FakeBrotli:
    """Deterministic fake brotli compressor for testing strict br vs gzip comparisons."""

    def __init__(self, ratio=0.5):
        self.ratio = ratio

    def compress(self, raw, quality=11):
        size = max(1, int(len(raw) * self.ratio))
        return b'b' * size


def _synthetic_full_data():
    feeds = {
        'updatedAt': '2026-11-14T00:00:00Z',
        'windowDays': 14,
        'items': [
            {'id': 'cand-bulk-0', 'doi': '10.1000/bulk0', 'pmid': '1000', 'title': 'Bulk 0', 'summary': 'B' * 300},
            {'id': 'cand-pick-1', 'doi': '10.1000/pick1', 'pmid': '1001', 'title': 'Latest Pick', 'autoPick': {'d': '2026-11-14', 'r': 1}},
            {'id': 'cand-bulk-2', 'doi': '10.1000/bulk2', 'pmid': '1002', 'title': 'Bulk 2', 'summary': 'C' * 300},
            {'id': 'cand-weekly-3', 'doi': '10.1000/week3', 'pmid': '1003', 'title': 'Weekly Pick', 'weeklyPick': 1, 'autoPick': {'d': '2026-11-10', 'r': 1}},
        ],
    }
    curated = [{'id': 'cur-1', 'doi': '10.1000/cur1', 'title': 'Curated 1', 'hasDraft': True, 'draftData': {'published': '2026-11-13', 'summary': 'Guide'}}]
    library = {
        'generatedAt': '2026-11-14T00:00:00Z',
        'papers': [
            {'id': 'lib-1', 'doi': '10.1000/lib1', 'title': 'Library Paper 1'},
            {'id': 'lib-2', 'doi': '10.1000/lib2', 'title': 'Library Paper 2'},
        ],
        'pdfIds': ['lib-1'],
    }
    weekly_board = {
        'schemaVersion': 1,
        'scope': 'public-abstract',
        'items': [{'id': 'cand-weekly-3', 'paperID': 'doi:10.1000/week3', 'doi': '10.1000/week3', 'pmid': '1003', 'rank': 1, 'category': '心血管', 'date': '2026-11-10', 'title': 'Weekly Pick', 'abstract': 'Abs', 'sourceHash': 'abc'}],
    }
    quicklooks = {
        '10.1000/pick1': {'one_line': 'Latest pick quicklook'},
        '10.1000/week3': {'one_line': 'Older pick quicklook'},
        '10.1000/bulk0': {'one_line': 'Bulk quicklook that must be deferred'},
    }
    pregenerated = {
        'doi:10.1000/offweek': {'translation': {'title_zh': '非周榜预生成'}},
        'pmid:1003': {
            'translation': {'title_zh': '周榜译题', 'abstract_zh': '周榜中文摘要'},
            'quicklook': {'one_line': '周榜一句话速览'},
            'study': {'papers': [{'key': 'pmid:1003'}]},
            'meta': {'builtAt': '2026-11-14'},
        },
    }
    source_health = {
        'checkedAt': '2026-11-14T00:00:00Z',
        'sources': [{'id': 'src-1', 'name': 'Journal RSS', 'status': 'ok'}],
        'pubmedFetch': {'ok': True},
    }
    radar = {'v': 1, 'rows': [['2001', '10.1000/r1', '2026-11-12', 0, 0, 0, 0, [], 'Recent Radar']]}
    deep_readings = {'schemaVersion': 1, 'items': [{'pmcid': 'PMC9001', 'title': 'Deep Reading Index'}], 'shards': {}}
    return {
        'CURATED': curated,
        'CONTENT_STATUS': {'release': 'v14.4.0', 'builtAt': '2026-11-14T00:00:00Z'},
        'JOURNAL_METRICS': {'journals': []},
        'FEEDS': feeds,
        'LIBRARY': library,
        'SOURCE_HEALTH': source_health,
        'QUICKLOOKS': quicklooks,
        'PREGENERATED': pregenerated,
        'RADAR': radar,
        'DEEP_READINGS': deep_readings,
        'WEEKLY_BOARD': weekly_board,
    }


def _extract_part_payload(js_text):
    prefix, body = js_text.split('window.XINZHI_PART(', 1)
    self_check = prefix.endswith('&&')
    if not self_check:
        raise AssertionError('Expected defensive window.XINZHI_PART wrapper')
    _, rest = body.split(',', 1)
    payload, _ = json.JSONDecoder().raw_decode(rest)
    return payload


class FirstScreenBudgetTests(unittest.TestCase):
    def test_synthetic_payloads_under_budget_pass(self):
        data = _synthetic_full_data()
        files, app_path, style_path = public_split.build_assets(
            data,
            'window.RADAR_ARCHIVE={"rows":[]};',
            ['// app code\nconsole.log("ok");\n'],
            'body{margin:0;color:#111}',
        )
        index_html = (
            '<!doctype html><html><head>'
            f'<link rel="stylesheet" href="{style_path}">'
            '</head><body>'
            f'<script src="{app_path}"></script>'
            '</body></html>'
        )
        payloads = {'index.html': index_html.encode('utf-8')}
        payloads.update({k: v.encode('utf-8') for k, v in files.items()})
        report = public_split.check_first_screen_budget(payloads)
        self.assertEqual(report['appPath'], app_path)
        self.assertEqual([r['path'] for r in report['criticalFiles']], ['index.html', style_path, app_path])
        self.assertGreater(report['data']['raw'], 0)
        self.assertLessEqual(report['data']['gzip'], report['budgets']['dataGz'])
        self.assertLessEqual(report['total']['gzip'], report['budgets']['totalGz'])

    def test_over_data_and_total_budget_raises_with_actionable_details(self):
        app_path = 'assets/app.0123456789ab.js'
        style_path = 'assets/style.0123456789ab.css'
        # High-entropy mixed characters keep compressed size above tiny test budgets.
        blob = ''.join(chr(65 + (i * 7 + i // 3) % 52) for i in range(4000))
        app_js = f'window.FEEDS={json.dumps({"items": [blob]})};\n;\nconsole.log(1);'
        payloads = {
            'index.html': f'<link rel="stylesheet" href="{style_path}"><script src="{app_path}"></script>',
            style_path: 'body{color:#000}',
            app_path: app_js,
        }
        with self.assertRaises(ValueError) as ctx:
            public_split.check_first_screen_budget(payloads, data_budget_br=50, total_budget_br=80)
        msg = str(ctx.exception)
        self.assertIn(app_path, msg)
        self.assertIn(style_path, msg)
        self.assertIn('index.html', msg)
        self.assertIn('budget', msg)
        self.assertIn('move data into a deferred part', msg)

        # Total can fail even when tier-1 data is within its own budget (e.g., oversized stylesheet).
        small_app = 'window.FEEDS={"items":[]};\n;\nconsole.log(1);'
        big_css = 'body{' + ''.join(f'--v{i}:{blob[:20]};' for i in range(80)) + '}'
        with self.assertRaises(ValueError) as ctx2:
            public_split.check_first_screen_budget(
                {
                    'index.html': f'<link rel="stylesheet" href="{style_path}"><script src="{app_path}"></script>',
                    style_path: big_css,
                    app_path: small_app,
                },
                data_budget_br=5000,
                total_budget_br=100,
            )
        self.assertIn(style_path, str(ctx2.exception))
        self.assertIn('move data into a deferred part', str(ctx2.exception))

    def test_stricter_of_gzip_and_brotli_enforced(self):
        app_path = 'assets/app.0123456789ab.js'
        style_path = 'assets/style.0123456789ab.css'
        payload = {
            'index.html': f'<link rel="stylesheet" href="{style_path}"><script src="{app_path}"></script>',
            style_path: 'body{color:black}',
            app_path: 'window.FEEDS=' + json.dumps({'items': ['x' * 500]}) + ';\n;\nconsole.log(1);',
        }
        measured = public_split.measure_first_screen(payload, brotli_module=_FakeBrotli(ratio=0.9))
        # Brotli exceeds data_budget_br while gzip is under data_budget_br * ratio.
        self.assertGreater(measured['data']['br'], measured['data']['gzip'])
        with self.assertRaisesRegex(ValueError, 'tier-1 data budget exceeded'):
            public_split.check_first_screen_budget(
                payload,
                data_budget_br=measured['data']['br'] - 1,
                total_budget_br=100000,
                gzip_ratio=2.0,
                brotli_module=_FakeBrotli(ratio=0.9),
            )
        # Gzip exceeds data_budget_br * ratio while brotli is under data_budget_br.
        measured_low_br = public_split.measure_first_screen(payload, brotli_module=_FakeBrotli(ratio=0.1))
        self.assertLess(measured_low_br['data']['br'], measured_low_br['data']['gzip'])
        with self.assertRaisesRegex(ValueError, 'tier-1 data budget exceeded'):
            public_split.check_first_screen_budget(
                payload,
                data_budget_br=measured_low_br['data']['gzip'] - 1,
                total_budget_br=100000,
                gzip_ratio=1.0,
                brotli_module=_FakeBrotli(ratio=0.1),
            )

    def test_missing_brotli_fails_closed_for_checker_while_measure_remains_valid(self):
        app_path = 'assets/app.0123456789ab.js'
        style_path = 'assets/style.0123456789ab.css'
        payloads = {
            'index.html': f'<link rel="stylesheet" href="{style_path}"><script src="{app_path}"></script>',
            style_path: 'body{color:black}',
            app_path: 'window.FEEDS={"items":[]};\n;\nconsole.log(1);',
        }
        report = public_split.measure_first_screen(payloads, brotli_module=None)
        self.assertFalse(report['brotliAvailable'])
        self.assertIsNone(report['data']['br'])
        self.assertIsNone(report['total']['br'])
        self.assertGreater(report['data']['gzip'], 0)
        self.assertGreater(report['total']['gzip'], 0)

        with self.assertRaisesRegex(ValueError, 'brotli'):
            public_split.check_first_screen_budget(payloads, brotli_module=None)
        with patch.dict('sys.modules', {'brotli': None}):
            with self.assertRaisesRegex(ValueError, 'brotli'):
                public_split.check_first_screen_budget(payloads)

        # Verify build_public.main() fails closed before writing public/ when `import brotli` fails.
        with tempfile.TemporaryDirectory() as d:
            from test_release_build import synthetic_root
            root = Path(d)
            synthetic_root(root)
            dest = root / 'public'
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', dest), patch.dict('sys.modules', {'brotli': None}), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, 'brotli'):
                    builder.main()
            self.assertFalse((dest / 'index.html').exists())

    def test_tier1_has_no_bulk_and_round_trip_matches_original(self):
        original = _synthetic_full_data()
        snapshot = json.loads(json.dumps(original))
        first, parts = public_split.split_parts(original)
        # Input globals were not mutated.
        self.assertEqual(original, snapshot)

        # Tier-1 FEEDS keeps only autoPick/weeklyPick items plus order metadata.
        self.assertEqual([p['id'] for p in first['FEEDS']['items']], ['cand-pick-1', 'cand-weekly-3'])
        self.assertEqual(first['FEEDS']['order'], {'total': 4, 'at': [1, 3]})
        # Tier-1 LIBRARY & SOURCE_HEALTH carry no bulk arrays.
        self.assertEqual(first['LIBRARY'], {'generatedAt': original['LIBRARY']['generatedAt'], 'papers': [], 'pdfIds': [], 'deferred': True})
        self.assertEqual(first['SOURCE_HEALTH'], {'checkedAt': original['SOURCE_HEALTH']['checkedAt'], 'sources': [], 'deferred': True})
        # Tier-1 QUICKLOOKS & PREGENERATED carry only default-view subsets.
        self.assertEqual(set(first['QUICKLOOKS']), {'10.1000/pick1'})
        self.assertEqual(first['PREGENERATED'], {'pmid:1003': {'quicklook': {'one_line': '周榜一句话速览'}}})
        # Deferred-only globals are absent from tier 1.
        for excluded in ('DEEP_READINGS', 'WEEKLY_BOARD', 'RADAR'):
            self.assertNotIn(excluded, first)

        # Deferred parts hold the remainder.
        self.assertEqual([p['id'] for p in parts['feeds']['items']], ['cand-bulk-0', 'cand-bulk-2'])
        self.assertEqual(parts['feeds']['at'], [0, 2])
        self.assertEqual(parts['library'], {'papers': original['LIBRARY']['papers'], 'pdfIds': original['LIBRARY']['pdfIds']})
        self.assertEqual(set(parts['quicklooks']['items']), {'10.1000/week3', '10.1000/bulk0'})
        self.assertEqual(set(parts['pregenerated']['items']), {'doi:10.1000/offweek', 'pmid:1003'})
        self.assertEqual(set(parts['pregenerated']['items']['pmid:1003']), {'translation', 'study', 'meta'})

        # Round-trip through built assets via public_bundle.bundle_text equals original globals.
        files, app_path, style_path = public_split.build_assets(
            original,
            'window.RADAR_ARCHIVE={"rows":[]};',
            ['// synthetic app\n'],
            'body{color:black}',
        )
        with tempfile.TemporaryDirectory() as d:
            pub = Path(d)
            for rel, text in files.items():
                target = pub / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding='utf-8')
            (pub / 'index.html').write_text(f'<link rel="stylesheet" href="{style_path}"><script src="{app_path}"></script>', encoding='utf-8')
            reconstituted = public_bundle.bundle_text(pub)
            for name in ('CURATED', 'CONTENT_STATUS', 'JOURNAL_METRICS', 'FEEDS', 'LIBRARY', 'SOURCE_HEALTH', 'QUICKLOOKS', 'PREGENERATED', 'RADAR', 'DEEP_READINGS', 'WEEKLY_BOARD'):
                self.assertEqual(public_bundle._global(reconstituted, name), original[name], name)
            py_pre = public_bundle._global(reconstituted, 'PREGENERATED')
            self.assertEqual(list(py_pre.keys()), list(original['PREGENERATED'].keys()))
            self.assertEqual(list(py_pre['pmid:1003'].keys()), list(original['PREGENERATED']['pmid:1003'].keys()))

            helper = Path(__file__).with_name('public_bundle.cjs')
            node_out = subprocess.check_output(['node', '-e', 'process.stdout.write(require(process.argv[1]).bundleText(process.argv[2]))', str(helper), d], text=True)
            node_pre = public_bundle._global(node_out, 'PREGENERATED')
            self.assertEqual(node_pre, original['PREGENERATED'])
            self.assertEqual(list(node_pre.keys()), list(original['PREGENERATED'].keys()))
            self.assertEqual(list(node_pre['pmid:1003'].keys()), list(original['PREGENERATED']['pmid:1003'].keys()))

            # Also verify raw part decoding round-trip directly.
            manifest = public_bundle._global((pub / app_path).read_text(encoding='utf-8'), 'XINZHI_PARTS')
            self.assertEqual(list(manifest['parts']), list(public_split.PART_ORDER))
            self.assertEqual(_extract_part_payload(files[manifest['parts']['board']['src']]), original['WEEKLY_BOARD'])

    def test_hashed_names_change_only_when_content_changes(self):
        base = _synthetic_full_data()
        files1, app1, style1 = public_split.build_assets(base, 'window.RADAR_ARCHIVE={"rows":[]};', ['// app'], 'body{color:#111}')
        files2, app2, style2 = public_split.build_assets(base, 'window.RADAR_ARCHIVE={"rows":[]};', ['// app'], 'body{color:#111}')
        self.assertEqual((app1, style1, files1), (app2, style2, files2))

        # Changing only CSS changes only style.<hash>.css.
        files_css, app_css, style_css = public_split.build_assets(base, 'window.RADAR_ARCHIVE={"rows":[]};', ['// app'], 'body{color:#222}')
        self.assertNotEqual(style_css, style1)
        self.assertEqual(app_css, app1)
        self.assertEqual({k for k in files_css if k != style_css}, {k for k in files1 if k != style1})

        # Changing only LIBRARY changes data-library.<hash>.js and app.<hash>.js (manifest), leaving other parts untouched.
        changed_lib = json.loads(json.dumps(base))
        changed_lib['LIBRARY']['papers'].append({'id': 'lib-3', 'doi': '10.1000/lib3', 'title': 'Library Paper 3'})
        files_lib, app_lib, style_lib = public_split.build_assets(changed_lib, 'window.RADAR_ARCHIVE={"rows":[]};', ['// app'], 'body{color:#111}')
        self.assertEqual(style_lib, style1)
        self.assertNotEqual(app_lib, app1)
        m1 = public_bundle._global(files1[app1], 'XINZHI_PARTS')['parts']
        m2 = public_bundle._global(files_lib[app_lib], 'XINZHI_PARTS')['parts']
        self.assertNotEqual(m2['library']['src'], m1['library']['src'])
        for part_name in public_split.PART_ORDER:
            if part_name != 'library':
                self.assertEqual(m2[part_name]['src'], m1[part_name]['src'])

    def test_built_index_references_existing_assets_and_cli_enforces_budget(self):
        with tempfile.TemporaryDirectory() as d:
            from test_release_build import synthetic_root
            root = Path(d)
            synthetic_root(root)
            (root / 'index.html').write_text(
                '<!doctype html><html><head><link rel="stylesheet" href="style.css"><link rel="icon" href="icon.png"></head>'
                '<body><script src="data/library.js"></script><script src="app.js"></script></body></html>',
                encoding='utf-8',
            )
            dest = root / 'public'
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', dest), contextlib.redirect_stdout(io.StringIO()):
                builder.main()

            html = (dest / 'index.html').read_text(encoding='utf-8')
            refs, stylesheets, scripts = public_split.critical_assets_from_html(html)
            self.assertEqual(len(stylesheets), 1)
            self.assertEqual(len(scripts), 1)
            for rel in refs:
                self.assertTrue((dest / rel).is_file(), rel)
            for file_path in public_bundle.bundle_files(dest):
                self.assertTrue(file_path.is_file(), file_path)

            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = cli.main([str(dest)])
            self.assertEqual(code, 0)
            table = out.getvalue()
            self.assertIn('index.html', table)
            self.assertIn(stylesheets[0], table)
            self.assertIn(scripts[0], table)
            self.assertIn('Tier-1 data', table)
            self.assertIn('Total critical', table)

            # Over-budget CLI exits non-zero.
            out2, err2 = io.StringIO(), io.StringIO()
            with patch.object(public_split, 'FIRST_SCREEN_TOTAL_BUDGET_BR', 10), contextlib.redirect_stdout(out2), contextlib.redirect_stderr(err2):
                fail_code = cli.main([str(dest)])
            self.assertEqual(fail_code, 1)
            self.assertIn('FAIL:', err2.getvalue())
            self.assertIn('move data into a deferred part', err2.getvalue())

            # Over-budget build stops before replacing previous public/ files.
            before_index = (dest / 'index.html').read_bytes()
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', dest), patch.object(public_split, 'FIRST_SCREEN_DATA_BUDGET_BR', 10), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, 'move data into a deferred part'):
                    builder.main()
            self.assertEqual((dest / 'index.html').read_bytes(), before_index)

    def test_conservative_decimal_budget_and_production_shape_split(self):
        self.assertEqual(public_split.FIRST_SCREEN_DATA_BUDGET_BR, 100_000)
        self.assertEqual(public_split.FIRST_SCREEN_TOTAL_BUDGET_BR, 225 * 1024)
        self.assertEqual(public_split.FIRST_SCREEN_GZIP_TO_BR_RATIO, 1.25)

        data = _synthetic_full_data()
        board_items = []
        pregen = {'doi:10.1000/offweek-0': {'translation': {'abstract_zh': '非周榜译文' * 8}}}
        for i in range(28):
            pmid = str(5000 + i)
            doi = f'10.1000/prod-{i}'
            paper = {
                'id': f'cand-w-{i}',
                'pmid': pmid,
                'doi': doi,
                'title': f'Randomized Clinical Study {i} on Structural Heart Disease',
                'journal': 'JACC' if i % 2 == 0 else 'European Heart Journal',
                'date': '2026-11-14',
                'weeklyPick': i + 1,
                'summary': f'Background and methods summary sentence {i}. Results showed consistent benefit across subgroups. ',
            }
            data['FEEDS']['items'].append(paper)
            board_items.append({**paper, 'paperID': 'pmid:' + pmid, 'rank': i + 1, 'category': '心血管', 'abstract': paper['summary']})
            pregen['pmid:' + pmid] = {
                'translation': {'title_zh': f'临床研究 {i}', 'abstract_zh': f'背景与方法中文摘要段落 {i}，主要终点呈现显著获益。' * 8},
                'quicklook': {'one_line': f'一句话速览 {i}', 'why_read': f'临床要点 {i}', 'design': 'RCT'},
                'study': {'schemaVersion': 1, 'papers': [{'key': 'pmid:' + pmid, 'question': {'text': f'临床问题 {i}', 'quote': 'quote'}}], 'checklist': [f'核对项 {i}']},
                'meta': {'builtAt': '2026-11-14', 'version': i + 1},
            }
        for i in range(200):
            data['FEEDS']['items'].append({'id': f'cand-extra-{i}', 'doi': f'10.1000/extra-{i}', 'title': f'Candidate {i}', 'summary': 'Bulk ' * 20})
        data['WEEKLY_BOARD'] = {'schemaVersion': 1, 'items': board_items}
        data['PREGENERATED'] = pregen

        first, parts = public_split.split_parts(data)
        self.assertEqual(set(first['PREGENERATED']), {'pmid:' + str(5000 + i) for i in range(28)})
        for entry in first['PREGENERATED'].values():
            self.assertEqual(set(entry), {'quicklook'})
        for i in range(28):
            deferred_entry = parts['pregenerated']['items']['pmid:' + str(5000 + i)]
            self.assertNotIn('quicklook', deferred_entry)
            self.assertEqual(set(deferred_entry), {'translation', 'study', 'meta'})

        files, app_path, style_path = public_split.build_assets(
            data,
            'window.RADAR_ARCHIVE={"rows":[]};',
            ['// production-shape app stub\nconsole.log("ok");\n'],
            'body{margin:0;color:#111}',
        )
        payloads = {'index.html': f'<link rel="stylesheet" href="{style_path}"><script src="{app_path}"></script>'.encode('utf-8')}
        payloads.update({k: v.encode('utf-8') for k, v in files.items()})
        report = public_split.check_first_screen_budget(payloads)
        self.assertTrue(report['brotliAvailable'])
        self.assertLessEqual(report['data']['gzip'], int(100_000 * 1.25))
        self.assertLessEqual(report['data']['br'], 100_000)

        with tempfile.TemporaryDirectory() as d:
            pub = Path(d)
            for rel, text in files.items():
                target = pub / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding='utf-8')
            (pub / 'index.html').write_bytes(payloads['index.html'])
            py_bundle = public_bundle.bundle_text(pub)
            py_pre = public_bundle._global(py_bundle, 'PREGENERATED')
            self.assertEqual(py_pre, pregen)
            self.assertEqual(list(py_pre.keys()), list(pregen.keys()))
            self.assertEqual(list(py_pre['pmid:5000'].keys()), list(pregen['pmid:5000'].keys()))
            helper = Path(__file__).with_name('public_bundle.cjs')
            node_bundle = subprocess.check_output(['node', '-e', 'process.stdout.write(require(process.argv[1]).bundleText(process.argv[2]))', str(helper), d], text=True)
            node_pre = public_bundle._global(node_bundle, 'PREGENERATED')
            self.assertEqual(node_pre, pregen)
            self.assertEqual(list(node_pre.keys()), list(pregen.keys()))
            self.assertEqual(list(node_pre['pmid:5000'].keys()), list(pregen['pmid:5000'].keys()))


if __name__ == '__main__':
    unittest.main()
