import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_quicklooks as g  # noqa: E402

ABSTRACT = ('Background: Atrial fibrillation ablation outcomes vary. Methods: We randomized 412 patients to two '
            'strategies. Results: Recurrence was 18% with tailored ablation versus 27% with standard ablation. '
            'Conclusions: Tailored ablation reduced recurrence at 12 months.')


def output(findings):
    return {'title_zh': '个体化房颤消融', 'one_line': '个体化消融降低复发', 'design': '随机对照试验，412例患者',
            'limits': '摘要未提供', 'why_read': '可指导消融策略选择', 'findings': findings}


GOOD = [{'text': '纳入412例患者', 'quote': 'We randomized 412 patients to two strategies'},
        {'text': '复发率18%对27%', 'quote': 'Recurrence was 18% with tailored ablation versus 27%'}]


class QuicklookRepairTests(unittest.TestCase):
    def test_finding_with_unsupported_number_is_dropped(self):
        raw = output(GOOD + [{'text': '死亡率降低35%', 'quote': 'Tailored ablation reduced recurrence'}])
        with self.assertRaises(g.QuicklookError):
            g.validate(raw, ABSTRACT)
        item, repaired = g.validate_or_repair(raw, ABSTRACT)
        self.assertTrue(repaired)
        self.assertEqual([f['text'] for f in item['findings']], [f['text'] for f in GOOD])

    def test_never_below_two_findings(self):
        raw = output(GOOD[:1] + [{'text': '死亡率降低35%', 'quote': 'Tailored ablation reduced recurrence'}])
        with self.assertRaisesRegex(g.QuicklookError, 'numbers_not_in_abstract'):
            g.validate_or_repair(raw, ABSTRACT)

    def test_unsupported_number_outside_findings_is_not_repaired(self):
        raw = dict(output(GOOD), one_line='复发率降低50%')
        with self.assertRaisesRegex(g.QuicklookError, 'numbers_not_in_abstract'):
            g.validate_or_repair(raw, ABSTRACT)

    def test_valid_output_is_untouched(self):
        item, repaired = g.validate_or_repair(output(GOOD), ABSTRACT)
        self.assertFalse(repaired)
        self.assertEqual(len(item['findings']), 2)


if __name__ == '__main__':
    unittest.main()
