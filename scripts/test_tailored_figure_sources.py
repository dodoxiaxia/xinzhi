"""Prevent mixing PP figure evidence and mITT body results in historical guide tables."""
import re
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

class TailoredFigureSources(unittest.TestCase):
    def html_rows(self, filename):
        text = (ROOT/filename).read_text()
        rows = re.findall(r'<tr\b[^>]*>.*?</tr>', text, re.S)
        figure = next(r for r in rows if re.search(r'(?:<b>|<strong>)Figure 3',r))
        body = next(r for r in rows if 'mITT 分析（非图 3 数据）' in r)
        return figure, body

    def check_populations(self, figure, body):
        self.assertIn('PP 人群', figure)
        self.assertIn('137', figure)
        self.assertIn('132', figure)
        self.assertIn('c–d 为其中病程亚组', figure)
        for wrong in ('60%', '0.94', 'mITT'):
            self.assertNotIn(wrong, figure)
        for value in ('60% vs 60%', 'HR 0.94', 'P = 0.16', '第 4 页', 'mITT'):
            self.assertIn(value, body)

    def test_actual_website_table_separates_physical_page5_pp_and_page4_mitt(self):
        # The site's example reading lives in demo-reading.html and loads when opened.
        self.check_populations(*self.html_rows('demo-reading.html'))

    def test_editorial_html_mirror_preserves_both_original_mitt_endpoints(self):
        figure, body = self.html_rows('editorial/weekly_checked.html')
        self.check_populations(figure, body)
        self.assertIn('76% vs 71%', body)
        self.assertIn('P = 0.07', body)

    def test_markdown_mirror_keeps_same_source_distinction(self):
        lines = (ROOT/'editorial/weekly_checked.md').read_text().splitlines()
        figure = next(r for r in lines if r.startswith('| **Figure 3**'))
        body = next(r for r in lines if r.startswith('| **正文次要终点**'))
        self.check_populations(figure, body)
        self.assertIn('76% vs 71%', body)
        self.assertIn('P = 0.07', body)

    def test_guide_remains_historical_example_and_original_conclusion_numbers_remain(self):
        self.assertIn('2025 年论文，非本周新文',(ROOT/'index.html').read_text())
        text = (ROOT/'demo-reading.html').read_text()
        self.assertIn('用作精读体例示范，非当周新文',text)
        for value in ('88% vs 70%', 'HR 0.94, 95% CI 0.68–1.31', 'HR 0.77, 95% CI 0.51–1.16', 'P = 0.07'):
            self.assertIn(value,text)

if __name__ == '__main__': unittest.main()
