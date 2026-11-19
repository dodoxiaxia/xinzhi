import tempfile
import unittest
from pathlib import Path

from report_topic_tag_coverage import journal_tiers, public_data, render, summarize


class TopicCoverageTests(unittest.TestCase):
    def test_distribution_cooccurrences_and_sample_privacy(self):
        base = {'journal': 'Circulation', 'doi': '10.9999/fixture'}
        topics = ['#房颤/电生理', '#AI-ECG', '#影像']
        library = [
            {**base, 'title': 'Public tagged title', 'tags': [*topics, topics[0], 'bad', None]},
            {**base, 'title': 'Public untagged title', 'tags': [], 'email': 'private@example.invalid'},
            {**base, 'title': 'Omit private@example.invalid'},
            {**base, 'title': 'Omit /home/hidden/private.txt'},
            {**base, 'title': 'Omit relative ./research/private.txt'},
            {**base, 'title': 'Omit Windows C:\\Users\\hidden\\a.txt'},
            {**base, 'title': 'Private DOI', 'doi': 'not-a-doi'},
            {**base, 'title': 'Outside cardio tiers', 'journal': 'The BMJ'},
        ]
        radar = [{**base, 'title': 'Public radar title', 'tags': topics[:2]}]
        columns = {'library': library, 'radar': radar}
        _, mapping = journal_tiers(columns)
        counts, sizes, by_tier, pairs, combinations, samples, _ = summarize(library, mapping)
        self.assertEqual(counts, dict.fromkeys(topics, 1))
        self.assertEqual(sizes, {0: len(library) - 1, 3: 1})
        self.assertEqual(by_tier['cardioClinical'][0], len(library) - 2)
        self.assertEqual(len(pairs), 3)
        self.assertEqual(len(combinations), 4)
        self.assertEqual(samples, [('Public untagged title', '10.9999/fixture')])
        report = render(columns)
        self.assertIn('| #AI-ECG | #房颤/电生理 | 1 | 1 | 2 |', report)
        for private in ['private@example.invalid', '/home/hidden', 'research/private', 'Users', 'not-a-doi', 'Outside cardio tiers']:
            self.assertNotIn(private, report)

    def test_empty_library(self):
        report = render({'library': [], 'radar': []})
        self.assertIn('| 文献库 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |', report)
        self.assertIn('非空 AND 组合共有 0 种', report)

    def test_built_radar_merges_both_archives_and_prioritizes_feed_copies(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            assets = root / 'assets'
            assets.mkdir()
            files = {
                'app': 'window.FEEDS={"items":[{"pmid":1,"doi":"10.9999/DUPE","title":"Feed"}]};',
                'data-library': 'window.XINZHI_PART("library",{"papers":[{"title":"Library"}]});',
                'data-feeds': 'window.XINZHI_PART("feeds",{"items":[{"pmid":2,"title":"Deferred feed"}]});',
                'data-radar': 'window.XINZHI_PART("radar",{"rows":[[3,"10.9999/dupe","",0,0,0,0,[],"Duplicate"]]});',
                'radar': 'window.RADAR_ARCHIVE={"jn":["Circulation"],"tag":["#影像"],"rows":'
                         '[[2,"","",0,0,0,0,[],"Duplicate"],[4,"","",0,0,0,0,[0],"Archive"]]};',
            }
            for stem, contents in files.items():
                (assets / (stem + '.hash.js')).write_text(contents, encoding='utf-8')
            columns = public_data(root)
            self.assertEqual([p['title'] for p in columns['library']], ['Library'])
            self.assertEqual([p['title'] for p in columns['radar']], ['Feed', 'Deferred feed', 'Archive'])
            self.assertEqual(columns['radar'][-1]['tags'], ['#影像'])
