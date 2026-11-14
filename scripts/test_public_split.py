"""Synthetic round trips exercise every deferred global without production counts."""
import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from public_split import build_assets, js, split_parts, select_first_screen
from public_bundle import bundle_text, bundle_files, radar_text, _global


class PublicSplitTests(unittest.TestCase):
    def payload(self):
        papers = [{'id': 'same', 'doi': '10.example/a', 'autoPick': {'d': '2026-11-12'}},
                  {'id': 'other'}, {'id': 'board', 'doi': '10.example/b', 'weeklyPick': 1},
                  {'id': 'same'}, {'id': 'old', 'autoPick': {'d': '2026-11-11'}}]
        return dict(FEEDS={'updatedAt': 'now', 'windowDays': 14, 'items': papers},
                    LIBRARY={'generatedAt': 'now', 'papers': [{'id': 'lib'}], 'pdfIds': ['lib']},
                    SOURCE_HEALTH={'checkedAt': 'now', 'sources': [{'id': 'source'}], 'pubmedFetch': {'status': 'ok'}},
                    CURATED=[], CONTENT_STATUS={'builtAt': 'now'}, JOURNAL_METRICS={'journals': []},
                    QUICKLOOKS={'10.example/a': {'one_line': 'latest'}, '10.example/b': {'one_line': 'rest'}},
                    PREGENERATED={'other': {'title': 'rest'}, 'doi:10.example/b': {'translation': {'abstract_zh': '译文'}, 'quicklook': {'one_line': 'board'}, 'study': {'papers': []}}},
                    WEEKLY_BOARD={'items': [papers[2]]}, DEEP_READINGS={'items': [{'id': 'reading'}]},
                    RADAR={'rows': [['recent']], 'jn': ['journal']})

    def test_roundtrip_every_global_and_original_item_order(self):
        data = self.payload()
        untouched = copy.deepcopy(data)
        archive = {'rows': [['older']], 'jn': ['journal']}
        files, app, css = build_assets(data, js('RADAR_ARCHIVE', archive), ['// app'], 'body{}')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, text in files.items():
                (root/name).parent.mkdir(parents=True, exist_ok=True)
                (root/name).write_text(text)
            (root/'index.html').write_text('<link href="'+css+'"><script src="'+app+'"></script>')
            rebuilt = bundle_text(root)
            for name, value in data.items():
                with self.subTest(name=name):self.assertEqual(_global(rebuilt, name), value)
            self.assertEqual(list(_global(rebuilt, 'PREGENERATED').keys()), list(data['PREGENERATED'].keys()))
            self.assertEqual(list(_global(rebuilt, 'PREGENERATED')['doi:10.example/b'].keys()), list(data['PREGENERATED']['doi:10.example/b'].keys()))
            self.assertEqual(_global(radar_text(root), 'RADAR_ARCHIVE'), archive)
            self.assertEqual(set(bundle_files(root)), {root/name for name in files if name.endswith('.js')})
            helper = Path(__file__).with_name('public_bundle.cjs')
            node = subprocess.check_output(['node', '-e', 'process.stdout.write(require(process.argv[1]).bundleText(process.argv[2]))', str(helper), tmp], text=True)
            for name, value in data.items():self.assertEqual(_global(node, name), value)
            self.assertEqual(list(_global(node, 'PREGENERATED').keys()), list(data['PREGENERATED'].keys()))
            self.assertEqual(list(_global(node, 'PREGENERATED')['doi:10.example/b'].keys()), list(data['PREGENERATED']['doi:10.example/b'].keys()))
        self.assertEqual(data, untouched)
        self.assertEqual(build_assets(data, js('RADAR_ARCHIVE', archive), ['// app'], 'body{}'), (files, app, css))

    def test_first_screen_and_partition_keys(self):
        data = self.payload()
        at, quick, prepared = select_first_screen(data['FEEDS'], [], data['LIBRARY'], data['WEEKLY_BOARD'])
        self.assertEqual([data['FEEDS']['items'][i] for i in at], [p for p in data['FEEDS']['items'] if p.get('autoPick') or p.get('weeklyPick')])
        first, parts = split_parts(data)
        self.assertEqual(set(first['QUICKLOOKS']), {'10.example/a'})
        self.assertEqual(first['PREGENERATED'], {'doi:10.example/b': {'quicklook': {'one_line': 'board'}}})
        self.assertNotIn('RADAR', first)
        self.assertNotIn('DEEP_READINGS', first)
        self.assertNotIn('WEEKLY_BOARD', first)
        self.assertEqual(first['FEEDS']['order']['total'], len(data['FEEDS']['items']))
        self.assertEqual(parts['feeds']['at'], [i for i in range(len(data['FEEDS']['items'])) if i not in at])
        curated = [{'id': 'curated-only', 'doi': '10.example/c', 'hasDraft': True, 'draftData': {'published': '2026-11-13'}}]
        _, latest_keys, _ = select_first_screen(data['FEEDS'], curated, data['LIBRARY'], data['WEEKLY_BOARD'])
        self.assertEqual(latest_keys, set())

    def test_pregenerated_splits_by_weekly_board_tr_keys(self):
        board_items = [
            {'id': 'b-both', 'pmid': '1001', 'doi': '10.Example/B1', 'weeklyPick': 1},
            {'id': 'b-doi', 'doi': '10.Example/B2', 'weeklyPick': 2},
            {'id': 'b-pmid', 'pmid': '1003', 'weeklyPick': 3},
        ]
        pregenerated = {
            'pmid:9001': {'translation': {'abstract_zh': '非周榜'}, 'title': 'offweek-pmid'},
            'pmid:1001': {
                'translation': {'abstract_zh': '双键译文'},
                'quicklook': {'one_line': 'both-pmid-ql'},
                'study': {'papers': [{'key': 'pmid:1001'}]},
                'meta': {'builtAt': '2026-11-14'},
            },
            'doi:10.example/b1': {'title': 'both-doi-alias'},
            'doi:10.example/b2': {'quicklook': {'one_line': 'doi-ql'}, 'translation': {'abstract_zh': 'DOI译文'}},
            'pmid:1003': {'translation': {'abstract_zh': '仅译文无速览'}},
            'doi:10.example/off': {'title': 'offweek-doi'},
        }
        data = self.payload()
        data['FEEDS'] = {'updatedAt': 'now', 'windowDays': 14, 'items': list(board_items)}
        data['WEEKLY_BOARD'] = {'items': board_items}
        data['PREGENERATED'] = pregenerated
        first, parts = split_parts(data)
        self.assertEqual(first['PREGENERATED'], {
            'pmid:1001': {'quicklook': {'one_line': 'both-pmid-ql'}},
            'doi:10.example/b2': {'quicklook': {'one_line': 'doi-ql'}},
        })
        self.assertNotIn('quicklook', parts['pregenerated']['items']['pmid:1001'])
        self.assertEqual(set(parts['pregenerated']['items']['pmid:1001']), {'translation', 'study', 'meta'})
        self.assertEqual(parts['pregenerated']['items']['pmid:1003'], {'translation': {'abstract_zh': '仅译文无速览'}})
        self.assertEqual(parts['pregenerated']['items']['doi:10.example/b1'], {'title': 'both-doi-alias'})
        files, app, css = build_assets(data, js('RADAR_ARCHIVE', {'rows': []}), ['// app'], 'body{}')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, text in files.items():
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(text)
            (root / 'index.html').write_text('<link href="' + css + '"><script src="' + app + '"></script>')
            py_pre = _global(bundle_text(root), 'PREGENERATED')
            self.assertEqual(py_pre, pregenerated)
            self.assertEqual(list(py_pre.keys()), list(pregenerated.keys()))
            for k in pregenerated:
                self.assertEqual(list(py_pre[k].keys()), list(pregenerated[k].keys()))
            helper = Path(__file__).with_name('public_bundle.cjs')
            node = subprocess.check_output(['node', '-e', 'process.stdout.write(require(process.argv[1]).bundleText(process.argv[2]))', str(helper), tmp], text=True)
            node_pre = _global(node, 'PREGENERATED')
            self.assertEqual(node_pre, pregenerated)
            self.assertEqual(list(node_pre.keys()), list(pregenerated.keys()))
            for k in pregenerated:
                self.assertEqual(list(node_pre[k].keys()), list(pregenerated[k].keys()))
        no_board = {**data, 'WEEKLY_BOARD': None}
        first_none, parts_none = split_parts(no_board)
        self.assertEqual(first_none['PREGENERATED'], {})
        self.assertEqual(parts_none['pregenerated'], {'items': pregenerated})

    def test_build_twice_cleans_legacy_and_stale_assets(self):
        import contextlib
        import io
        from unittest.mock import patch
        import build_public as builder
        from test_release_build import synthetic_root
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            synthetic_root(root)
            dest = root/'public'
            with patch.object(builder, 'ROOT', root), patch.object(builder, 'DEST', dest), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
                def snapshot():
                    return {p.relative_to(dest).as_posix(): p.read_bytes() for p in dest.rglob('*') if p.is_file()}
                before = snapshot()
                for name in ('public.js', 'radar.js', 'style.css'):
                    (dest/name).write_text('// previous output')
                (dest/'assets/app.aaaaaaaaaaaa.js').write_text('// stale')
                (dest/'shards').mkdir(exist_ok=True)
                (dest/'shards/readings-2026-01.aaaaaaaaaaaa.js').write_text('// stale')
                # A reverted receipt cannot change published asset hashes.
                (root/'docs/public-manifest.json').write_text('{}')
                builder.main()
                self.assertEqual(snapshot(), before)
