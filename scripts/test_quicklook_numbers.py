import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_quicklooks as g  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CASES = ['HR 0.70 (95% CI 0.51-0.98)', 'RR 0.7，95% CI 0.51–0.98', '3,364 patients', '共3364例', '共1,234例',
         'NCT02316886', 'mean 8.90 vs 10.90', '8.9 与 10.9', '.5 mg', '0.5 mg', '５０％', '12 May 2024',
         'May 2024', 'in May', '2024-05-01', 'p<0.001', '1.0', 'H3K4me3 KDM5A D18', '٣ cases', 'Ⅱ期',
         'We analyzed 13 238 patients', '(N=137 704; PAD cases=2014)', '1 000 000 people', '13\u2009238 patients',
         'aged 65 123', '2.5 123 456', '12 3456']
WORKER_TOKENS = r"""
const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync(process.argv[1],'utf8').replace('export default {','globalThis.worker = {');
const ctx=vm.createContext({URL,Response,Request,TextEncoder,AbortController,setTimeout,clearTimeout,crypto:require('crypto').webcrypto});
vm.runInContext(src,ctx); ctx.cases=JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify(vm.runInContext('cases.map(numberTokens)',ctx)));
"""


class QuicklookNumberTests(unittest.TestCase):
    def test_tokens_match_the_production_worker(self):
        out = subprocess.run(['node', '-e', WORKER_TOKENS, str(ROOT / 'edge/_worker.js'), json.dumps(CASES)],
                             capture_output=True, text=True, timeout=30, check=True).stdout
        for case, expected in zip(CASES, json.loads(out)):
            with self.subTest(case=case):
                self.assertEqual(g.number_tokens(case), expected)

    def test_equal_spellings_pass_and_new_numbers_still_fail(self):
        abstract = ('Among 3,364 patients, recurrence fell (HR 0.70, 95% CI 0.51-0.98; mean 8.90 vs 10.90 '
                    'months). Lifestyle clinics reduced recurrence in atrial fibrillation.')
        out = {'title_zh': '生活方式门诊与房颤', 'one_line': '3364例中复发降低（HR 0.7）。', 'design': '荟萃分析',
               'limits': '摘要未报告异质性', 'why_read': '房颤综合管理',
               'findings': [{'text': '平均8.9对10.9个月。', 'quote': 'mean 8.90 vs 10.90 months'},
                            {'text': '95% CI 0.51-0.98。', 'quote': '95% CI 0.51-0.98'}]}
        self.assertEqual(g.validate(out, abstract)['one_line'], out['one_line'])
        out['one_line'] = '3364例中复发降低（HR 0.69）。'
        with self.assertRaisesRegex(g.QuicklookError, 'numbers_not_in_abstract'):
            g.validate(out, abstract)

    def test_space_grouped_thousands_match_joined_numbers(self):
        abstract = 'We analyzed 13 238 patients (N=137 704) with acute heart failure.'
        self.assertTrue({'13238', '137704'} <= g.nums(abstract))
        self.assertTrue(g.nums('纳入13238例（137,704人）') <= g.nums(abstract))
        self.assertFalse(g.nums('纳入13239例') <= g.nums(abstract))

    def test_bare_fraction_is_not_an_integer(self):
        self.assertFalse(g.nums('5 mg') <= g.nums('dose .5 mg'))


if __name__ == '__main__':
    unittest.main()
