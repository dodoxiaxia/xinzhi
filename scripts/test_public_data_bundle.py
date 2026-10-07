"""Bootstrap privacy, exact content preservation and refresh-fingerprint contract."""
import copy
import json
import unittest
from public_data_bundle import prepare, inline_boot, stable_index
from ci_daily import stable_bundle


def fixture():
    papers = [{'id': 'pick', 'title': '[Article] A heart trial', 'date': '2026-10-07', 'autoPick': {'d': '2026-10-07'}, 'summary': '原文🙂</script><script>bad()</script>'},
              {'id': 'ordinary', 'title': 'A public abstract', 'date': '2026-10-05', 'summary': 'Retain every full public abstract.'}]
    return {'LIBRARY': {'papers': [{'id': 'library', 'doi': '10.1/a', 'title': 'Public library identity'}]},
            'FEEDS': {'items': papers, 'updatedAt': 'old'}, 'CURATED': [],
            'CONTENT_STATUS': {'builtAt': 'old', 'release': 'fixture'},
            'RADAR': {'v': 1, 'jn': ['Journal'], 'pub': ['Publisher'], 'tier': ['Tier'], 'design': ['RCT'], 'tag': [],
                      'rows': [['3', '', '2026-10-06', 0, 0, 0, 0, [], 'An archived heart paper']], 'abs': {'3': [['', 'Full original abstract🙂']]}}}


class PublicDataBundleTests(unittest.TestCase):
    def test_core_omits_archive_and_nonselected_abstracts_but_classic_keeps_every_value(self):
        data = fixture(); before = copy.deepcopy(data)
        bundle, boot = prepare(data, '// application')
        self.assertNotIn('RADAR', boot['data'])
        self.assertEqual([p['id'] for p in boot['data']['FEEDS']['items']], ['pick'])
        self.assertEqual(boot['data']['LIBRARY'], data['LIBRARY'])
        self.assertEqual(boot['counts']['library'], 1)
        self.assertEqual(boot['counts']['radarDates']['2026-10-06'], 1)
        for name, value in data.items():
            literal = next(p for p in bundle.split('\n;\n') if p.startswith('window.' + name + '='))
            self.assertEqual(json.loads(literal.split('=', 1)[1][:-1]), value)
        self.assertEqual(data, before)

    def test_deferred_segments_precede_unrelated_library_and_full_archive(self):
        bundle, _ = prepare(fixture(), '// app')
        positions = [bundle.index('window.' + key + '=') for key in ('FEEDS', 'RECENT_RADAR', 'RADAR', 'LIBRARY')]
        self.assertEqual(positions, sorted(positions))
        # Whole-library size must not amplify reads of either default-radar segment.
        data = fixture(); original, _ = prepare(data, '// app')
        data['LIBRARY']['papers'][0]['title'] = 'x' * 1000000
        changed, _ = prepare(data, '// app')
        for name in ('FEEDS', 'RECENT_RADAR'):
            self.assertEqual(original.index('window.' + name + '='), changed.index('window.' + name + '='))

    def test_version_and_fingerprints_ignore_only_existing_refresh_times(self):
        data = fixture(); bundle, boot = prepare(data, '// app')
        html = inline_boot('<script src="public.js"></script>', boot, '// loader', '// app')
        changed = copy.deepcopy(data)
        changed['FEEDS']['updatedAt'] = 'new'; changed['CONTENT_STATUS']['builtAt'] = 'new'
        other, boot2 = prepare(changed, '// app')
        html2 = inline_boot('<script src="public.js"></script>', boot2, '// loader', '// app')
        self.assertEqual(boot['version'], boot2['version'])
        self.assertEqual(stable_bundle(bundle), stable_bundle(other))
        self.assertEqual(stable_index(html), stable_index(html2))
        for field in ('title', 'summary', 'date'):
            changed = copy.deepcopy(data); changed['FEEDS']['items'][1][field] = 'substantive change'
            self.assertNotEqual(boot['version'], prepare(changed, '// app')[1]['version'])
        self.assertNotEqual(boot['version'], prepare(data, '// app changed')[1]['version'])
        self.assertNotEqual(boot['version'], prepare(data, '// app', '// loader changed')[1]['version'])

    def test_object_key_order_does_not_create_a_new_release_identity(self):
        data = fixture(); reordered = dict(reversed(list(data.items())))
        self.assertEqual(prepare(data, 'app')[1]['version'], prepare(reordered, 'app')[1]['version'])

    def test_inline_public_abstracts_cannot_close_script_or_inject_code(self):
        _, boot = prepare(fixture(), 'app')
        html = inline_boot('<script src="public.js"></script>', boot, '// loader', '// app')
        self.assertEqual(html.count('</script>'), 2)
        self.assertNotIn('<script>bad()', html)
        literal = html.split('window.PUBLIC_DATA_BOOT=', 1)[1].split(';</script>', 1)[0]
        self.assertEqual(json.loads(literal)['data']['FEEDS']['items'][0]['summary'], fixture()['FEEDS']['items'][0]['summary'])
        self.assertIn('bad()', stable_index(html))

    def test_nonowned_html_javascript_and_article_dates_remain_substantive(self):
        _, boot = prepare(fixture(), 'app')
        index = '<script>const example={"builtAt":"old"};</script><script src="public.js"></script>'
        html = inline_boot(index, boot, '// loader', '// app')
        self.assertNotEqual(stable_index(html), stable_index(html.replace('"builtAt":"old"', '"builtAt":"new"', 1)))
        self.assertNotEqual(stable_index(html), stable_index(html.replace('2026-10-07', '2026-10-08', 1)))


if __name__ == '__main__':
    unittest.main()
