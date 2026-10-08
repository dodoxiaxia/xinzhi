"""Reject unlisted assets, symlinks, private paths and mixed/cache-invalid data."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from public_assets import CORE, MANIFEST, data_manifest, expected_paths, read_payloads, json_bytes
from public_data_bundle import prepare, inline_boot, stable_index
from test_public_data_bundle import fixture


class StaticPublicAssetsTests(unittest.TestCase):
    def payloads(self):
        _, boot, assets = prepare(fixture(), '// app')
        payloads=dict({name: b'core file' for name in CORE}, **assets)
        payloads['index.html']=inline_boot('<script src="public.js"></script>',boot,'// loader','// app').encode()
        return payloads, boot

    def test_classic_six_files_remain_a_valid_explicit_migration_source(self):
        self.assertEqual(expected_paths({name: b'old' for name in CORE}), CORE)

    def test_new_manifest_covers_all_assets_with_hash_named_paths(self):
        payloads, boot = self.payloads()
        self.assertEqual(len(expected_paths(payloads)), 10)
        self.assertEqual(data_manifest(payloads)['files'], boot['assets'])

    def test_incomplete_additional_missing_or_wrong_hash_assets_fail(self):
        original, boot = self.payloads()
        for mode in ('missing_core','missing_shard','extra','wrong_bytes','missing_manifest','duplicate','wrong_role','path_traversal'):
            with self.subTest(mode=mode):
                p = copy.deepcopy(original); row=boot['assets'][0]
                if mode=='missing_core':p.pop('index.html')
                if mode=='missing_shard':p.pop(row['path'])
                if mode=='extra':p['private.pdf']=b'not public'
                if mode=='wrong_bytes':p[row['path']]+=b' '
                if mode=='missing_manifest':p.pop(MANIFEST)
                if mode in ('duplicate','wrong_role','path_traversal'):
                    m=json.loads(p[MANIFEST])
                    if mode=='duplicate':m['files'].append(m['files'][0])
                    if mode=='wrong_role':m['files'][0]['name']='RADAR'
                    if mode=='path_traversal':m['files'][0]['path']='../private.pdf'
                    p[MANIFEST]=json_bytes(m)
                with self.assertRaises(ValueError):expected_paths(p)

    def test_envelope_version_is_checked_even_with_rehashed_contents(self):
        p, boot=self.payloads();m=json.loads(p[MANIFEST]);row=m['files'][0]
        e=json.loads(p.pop(row['path']));e['version']='b'*64;body=json_bytes(e);digest=hashlib.sha256(body).hexdigest()
        row.update(path='public-data/feeds.'+digest+'.json',sha256=digest,bytes=len(body));p[row['path']]=body;p[MANIFEST]=json_bytes(m)
        with self.assertRaisesRegex(ValueError,'Mixed'):expected_paths(p)

    def test_nested_symlink_private_or_unknown_directory_fails(self):
        p, boot=self.payloads()
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'public';root.mkdir()
            for name,body in p.items():
                path=root/name;path.parent.mkdir(exist_ok=True);path.write_bytes(body)
            self.assertEqual(read_payloads(root),p)
            path=root/boot['assets'][0]['path'];body=path.read_bytes();path.unlink();path.symlink_to(root/'index.html')
            with self.assertRaisesRegex(ValueError,'Unexpected'):read_payloads(root)
            path.unlink();path.write_bytes(body);private=root/'public-data/private.pdf';private.write_bytes(b'private')
            with self.assertRaisesRegex(ValueError,'Unexpected'):read_payloads(root)
            private.unlink();(root/'private').mkdir()
            with self.assertRaisesRegex(ValueError,'Unexpected'):read_payloads(root)

    def test_bootstrap_asset_refs_must_match_published_manifest(self):
        p,boot=self.payloads()
        for mode in ('version','hash','role','missing'):
            with self.subTest(mode=mode):
                b=copy.deepcopy(boot)
                if mode=='version':b['version']='b'*64
                if mode=='hash':b['assets'][0]['sha256']='b'*64
                if mode=='role':b['deferred']=[]
                if mode=='missing':b['assets']=[]
                p['index.html']=inline_boot('<script src="public.js"></script>',b,'// loader','// app').encode()
                with self.assertRaisesRegex(ValueError,'bootstrap differs'):expected_paths(p)

    def test_refresh_time_changes_exact_asset_hash_but_not_semantic_fingerprint(self):
        data=fixture();_,boot,assets=prepare(data,'// app');data['FEEDS']['updatedAt']='new time'
        _,other,updated=prepare(data,'// app')
        self.assertNotEqual(boot['assets'][0]['sha256'],other['assets'][0]['sha256'])
        self.assertEqual(boot['assets'][0]['contentHash'],other['assets'][0]['contentHash'])
        self.assertEqual(boot['version'],other['version'])
        html=lambda b:inline_boot('<script src="public.js"></script>',b,'// loader','// app')
        self.assertEqual(stable_index(html(boot)),stable_index(html(other)))

    def test_ci_fingerprint_tracks_meaningful_shard_change_not_refresh_names(self):
        import ci_daily
        from unittest.mock import patch
        data=fixture()
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);public=root/'public';public.mkdir()
            def write():
                bundle,boot,assets=prepare(data,'// app')
                payloads={name:b'core' for name in CORE};payloads['public.js']=bundle.encode();payloads['index.html']=inline_boot('<script src="public.js"></script>',boot,'// loader','// app').encode();payloads.update(assets)
                for path in public.rglob('*'):
                    if path.is_file():path.unlink()
                for name,body in payloads.items():
                    path=public/name;path.parent.mkdir(exist_ok=True);path.write_bytes(body)
                with patch.object(ci_daily,'ROOT',root):return ci_daily.content_hash()
            first=write();data['FEEDS']['updatedAt']='new timestamp';self.assertEqual(first,write())
            data['FEEDS']['items'][1]['summary']='Changed public source evidence';self.assertNotEqual(first,write())

    def test_package_requires_explicit_policy_and_scans_all_new_json(self):
        from test_package_release import TestPublicPackaging
        from package_release import public_payloads
        from release_integrity import provenance
        helper=TestPublicPackaging();helper.setUp()
        try:
            data=fixture()
            def write():
                _,boot,assets=prepare(data,'// app')
                for path in (helper.root/'public/public-data').glob('*'):path.unlink()
                for name,body in assets.items():
                    path=helper.root/'public'/name;path.parent.mkdir(exist_ok=True);path.write_bytes(body)
                (helper.root/'public/index.html').write_text(inline_boot('<script src="public.js"></script>',boot,'// loader','// app'))
                payloads={name:(helper.root/'public'/name).read_bytes() for name in CORE};payloads.update(assets)
                m=json.loads(helper.manifest.read_text());m.update(assetPolicy={'schemaVersion':2,'manifest':MANIFEST,'version':boot['version']},files=[{'path':n,'bytes':len(v),'sha256':hashlib.sha256(v).hexdigest()} for n,v in sorted(payloads.items())],buildProvenance=provenance(helper.root));helper.manifest.write_text(json.dumps(m));return m
            manifest=write();self.assertEqual(len(public_payloads(helper.root)),10)
            manifest.pop('assetPolicy');helper.manifest.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'policy'):public_payloads(helper.root)
            for path in ['/Users/private/PDF/index.txt','/workspace/private/index.json','/tmp/private.pdf']:
                data['FEEDS']['items'][1]['summary']=path;write()
                with self.assertRaisesRegex(ValueError,'private'):public_payloads(helper.root)
        finally:helper.tearDown()
