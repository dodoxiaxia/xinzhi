import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_picks  # noqa: E402

ABSTRACT = ('Background: Atrial fibrillation ablation outcomes vary. Methods: We randomized 412 patients '
            'to two ablation strategies and followed them for 12 months. Results: Recurrence was lower '
            'with the tailored strategy. Conclusions: A tailored ablation approach reduced recurrence.')


def paper(title, **extra):
    p = {'id': 'x', 'title': title, 'summary': ABSTRACT, 'clinicalTier': 'AI医疗与数字医学',
         'cleanJournal': 'The Lancet', 'studyDesign': 'RCT', 'date': '2026-10-10'}
    p.update(extra)
    return p


class DailyPickRuleTests(unittest.TestCase):
    def test_original_research_still_qualifies(self):
        self.assertGreaterEqual(auto_picks.score(paper('Tailored ablation for atrial fibrillation'), {}), 5)

    def test_letters_corrections_and_news_never_become_daily_picks(self):
        for title in ('[Correspondence] Regulate prospective development of medical AI now',
                      '[Obituary] A cardiologist', '[World Report] Health systems',
                      'Correction to: Tailored ablation', 'Reply to: Tailored ablation'):
            with self.subTest(title=title):
                self.assertEqual(auto_picks.score(paper(title), {}), 0)
        self.assertEqual(auto_picks.score(paper('Tailored ablation', pubTypes=['Letter']), {}), 0)

    def test_commentary_is_downweighted_below_original_research(self):
        research = auto_picks.score(paper('Tailored ablation for atrial fibrillation'), {})
        comment = auto_picks.score(paper('[Comment] Tailored ablation for atrial fibrillation'), {})
        self.assertEqual(research - comment, 2)

    def test_scope_excluded_paper_scores_zero(self):
        mouse_rct = paper('Mouse model of atrial fibrillation: randomized evaluation', clinicalTier='心律失常与电生理')
        self.assertEqual(auto_picks.score(mouse_rct, {}), 0)
        oncology = paper('Adjuvant chemotherapy in triple-negative breast cancer', cleanJournal='JAMA Oncology', clinicalTier='顶级综合与科学')
        self.assertEqual(auto_picks.score(oncology, {}), 0)


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    suite.addTests(tests)
    suite.addTests(loader.loadTestsFromName('test_scope_filter'))
    return suite


if __name__ == '__main__':
    unittest.main()
