import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import week_precompute as w

ABSTRACT = ('Background: Atrial fibrillation increases stroke risk in older adults. '
            'Methods: We enrolled 1200 patients aged 65 years or older at 14 hospitals. '
            'Patients were randomized to screening or usual care. '
            'Results: Stroke occurred in 32 patients in the screening group and 51 in the control group. '
            'Conclusions: Screening reduced stroke events in this population.')
PAPER = {'title': 'Screening for atrial fibrillation', 'abstract': ABSTRACT}
UNKNOWN = {'text': w.UNKNOWN, 'quote_id': ''}


def ids():
    return {span['quote'][:12]: span['id'] for span in w.validate('study_evidence_catalog', None, PAPER)}


def output(**fields):
    base = {field: dict(UNKNOWN) for field in w.STUDY_FIELDS}
    base.update(fields)
    return base


class StudyRepairTests(unittest.TestCase):
    def setUp(self):
        self.ids = ids()
        self.methods = next(v for k, v in self.ids.items() if k.startswith('Methods'))
        self.results = next(v for k, v in self.ids.items() if k.startswith('Results'))
        self.background = next(v for k, v in self.ids.items() if k.startswith('Background'))
        self.random = next(v for k, v in self.ids.items() if k.startswith('Patients'))

    def test_valid_output_is_unchanged(self):
        raw = output(question={'text': '房颤筛查能否降低老年人卒中风险', 'quote_id': self.background},
                     population={'text': '在14家医院纳入1200名65岁及以上患者', 'quote_id': self.methods},
                     results={'text': '筛查组32例卒中，对照组51例', 'quote_id': self.results})
        self.assertEqual(w.study_value(raw, PAPER), w.validate('study_evidence', raw, PAPER))

    def test_wrong_citation_is_moved_to_the_snippet_with_the_numbers(self):
        raw = output(question={'text': '房颤筛查能否降低老年人卒中风险', 'quote_id': self.background},
                     design={'text': '随机分配至筛查或常规治疗', 'quote_id': self.random},
                     results={'text': '筛查组32例卒中，对照组51例', 'quote_id': self.methods})
        with self.assertRaises(w.EvidenceError):
            w.validate('study_evidence', raw, PAPER)
        value = w.study_value(raw, PAPER)
        self.assertIn('32 patients', value['results']['quote'])
        self.assertEqual(value['results']['text'], '筛查组32例卒中，对照组51例')

    def test_unsupported_sentence_is_dropped_and_nothing_is_added(self):
        raw = output(question={'text': '房颤筛查能否降低老年人卒中风险', 'quote_id': self.background},
                     design={'text': '随机分配至筛查或常规治疗', 'quote_id': self.random},
                     population={'text': '纳入1200名65岁及以上患者。随访3年。', 'quote_id': self.methods})
        value = w.study_value(raw, PAPER)
        self.assertEqual(value['population']['text'], '纳入1200名65岁及以上患者。')

    def test_too_little_left_keeps_the_original_rejection(self):
        raw = output(results={'text': '筛查组99例卒中', 'quote_id': self.results},
                     question={'text': '房颤筛查能否降低老年人卒中风险', 'quote_id': self.background})
        with self.assertRaises(w.EvidenceError) as caught:
            w.study_value(raw, PAPER)
        self.assertTrue(caught.exception.code.startswith('numbers_not_in_source'))


class QuicklookRepairTests(unittest.TestCase):
    def quicklook(self, *findings):
        return {'title_zh': '房颤筛查', 'one_line': '筛查减少卒中', 'design': '随机对照试验', 'limits': '摘要未提供',
                'why_read': '与老年房颤筛查相关', 'findings': list(findings)}

    def test_finding_with_numbers_outside_its_quote_is_dropped(self):
        good1 = {'text': '筛查组32例卒中', 'quote': 'Stroke occurred in 32 patients in the screening group'}
        good2 = {'text': '共纳入1200名患者', 'quote': 'We enrolled 1200 patients aged 65 years or older'}
        bad = {'text': '对照组51例卒中', 'quote': 'Patients were randomized to screening or usual care'}
        raw = self.quicklook(good1, bad, good2)
        with self.assertRaises(w.EvidenceError):
            w.validate('quicklook', raw, PAPER)
        value = w.quicklook_value(raw, PAPER)
        self.assertEqual([f['text'] for f in value['findings']], ['筛查组32例卒中', '共纳入1200名患者'])

    def test_fewer_than_two_left_keeps_the_original_rejection(self):
        good = {'text': '筛查组32例卒中', 'quote': 'Stroke occurred in 32 patients in the screening group'}
        bad = {'text': '对照组51例卒中', 'quote': 'Patients were randomized to screening or usual care'}
        with self.assertRaises(w.EvidenceError):
            w.quicklook_value(self.quicklook(good, bad), PAPER)


if __name__ == '__main__':
    unittest.main()
