import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_public  # noqa: E402

BUILT = '2026-10-10T12:00:00+00:00'


def pick(n, day, rank=1, **extra):
    q = {'id': 'p%d' % n, 'title': 'Trial <%d> & outcomes' % n, 'doi': '10.1/x%d' % n, 'url': 'https://doi.org/10.1/x%d' % n,
         'journal': 'JACC', 'date': day, 'summary': 'Background: ' + 'a' * 600, 'autoPick': {'d': day, 'r': rank}}
    q.update(extra)
    return q


class FeedTests(unittest.TestCase):
    def items(self, rows, ql=None):
        root = ET.fromstring(build_public.make_feed(rows, ql or {}, BUILT))
        return root.findall('./channel/item')

    def test_newest_day_first_and_older_than_window_dropped(self):
        rows = [pick(1, '2026-10-01'), pick(2, '2026-10-10', 2), pick(3, '2026-10-10', 1), pick(4, '2026-10-04'), {'id': 'x', 'title': 'not a pick'}]
        guids = [i.find('guid').text for i in self.items(rows)]
        self.assertEqual(guids, ['xinzhi-p3', 'xinzhi-p2', 'xinzhi-p4'])

    def test_chinese_title_and_quicklook_are_labelled_machine_made(self):
        item = self.items([pick(1, '2026-10-10')], {'10.1/x1': {'title_zh': '试验结局', 'one_line': '主要终点降低', 'why_read': '可改变实践'}})[0]
        self.assertEqual(item.find('title').text, '试验结局 | Trial <1> & outcomes')
        body = item.find('description').text
        self.assertIn('AI 速览（未经人工核对）：主要终点降低', body)
        self.assertIn('机器翻译', body)
        self.assertNotIn('Background', body)

    def test_abstract_excerpt_is_bounded_and_escaped(self):
        body = self.items([pick(1, '2026-10-10')])[0].find('description').text
        self.assertIn('…', body)
        self.assertLess(len(body), 700)
        self.assertIn('规则自动精选，非医学审查', body)

    def test_empty_feed_is_valid(self):
        self.assertEqual(self.items([]), [])


if __name__ == '__main__':
    unittest.main()
