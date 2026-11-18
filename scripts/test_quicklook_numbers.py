import json
import subprocess
import sys
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_quicklooks as g  # noqa: E402
import week_precompute as week  # noqa: E402

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
    def test_word_tokens_match_the_production_worker(self):
        cases = ['Thirteen studies met criteria', 'Fourteen of 35 SNVs; Three cohorts', 'twenty-four months, Ninety-nine',
                 'no one', 'Fourteenth', 'sixty five', 'ELEVEN trials', 'often', 'seventy-two']
        script = WORKER_TOKENS.replace('cases.map(numberTokens)', 'cases.map(wordNumberTokens)')
        out = subprocess.run(['node', '-e', script, str(ROOT / 'edge/_worker.js'), json.dumps(cases)],
                             capture_output=True, text=True, timeout=30, check=True).stdout
        for case, expected in zip(cases, json.loads(out)):
            with self.subTest(case=case):
                self.assertEqual(g.word_number_tokens(case), expected)

    def test_spelled_out_counts_allow_digits_but_are_never_required(self):
        abstract = ('BACKGROUND: Assisted reproduction may raise risk. RESULTS: Thirteen studies met the inclusion criteria '
                    'and showed a higher risk of congenital heart defects in offspring.')
        out = {'title_zh': '辅助生殖与先心病', 'one_line': '13项研究显示风险升高。', 'design': '荟萃分析',
               'limits': '摘要未报告异质性', 'why_read': '生殖与先心病风险',
               'findings': [{'text': '纳入13项研究。', 'quote': 'Thirteen studies met the inclusion criteria'},
                            {'text': '风险升高。', 'quote': 'showed a higher risk of congenital heart defects'}]}
        self.assertEqual(g.validate(out, abstract)['one_line'], out['one_line'])
        out['one_line'] = '14项研究显示风险升高。'
        with self.assertRaisesRegex(g.QuicklookError, 'numbers_not_in_abstract'):
            g.validate(out, abstract)

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

    def test_worker_translation_accepts_digits_for_spelled_counts_once(self):
        def check(title_zh, title):
            r = subprocess.run(['node', str(ROOT / 'scripts/validate_week_precompute.cjs')], capture_output=True, text=True, timeout=30,
                               input=json.dumps({'task': 'title', 'value': {'title_zh': title_zh}, 'title': title, 'abstract': ''}))
            return json.loads(r.stdout).get('code', 'ok')
        self.assertEqual(check('13项研究的荟萃分析', 'Thirteen Studies: A Meta-Analysis'), 'ok')
        self.assertEqual(check('一项试验的分析', 'One Trial Analysed'), 'ok')  # words are never required
        self.assertEqual(check('13项研究与13个队列', 'Thirteen Studies'), 'numbers_not_in_source:repeated_number')
        self.assertEqual(check('14项研究', 'Thirteen Studies'), 'numbers_not_in_source:14')

    def test_week_validator_details_follow_production_check_order(self):
        def validate(task, value, title, abstract):
            result = subprocess.run(['node', str(ROOT / 'scripts/validate_week_precompute.cjs')], capture_output=True, text=True, timeout=30,
                                    input=json.dumps({'task': task, 'value': value, 'title': title, 'abstract': abstract}, ensure_ascii=False))
            return json.loads(result.stdout)

        title = 'A randomized trial'
        abstract = 'Patients were followed for 48 weeks. The study entered phase 3. Outcomes improved across groups.'
        base = {'title_zh': '随机试验', 'one_line': '结果有所改善。', 'design': '随机试验', 'limits': '样本有限。',
                'why_read': '了解研究结果。', 'findings': [
                    {'text': '随访48周。', 'quote': 'followed for 48 weeks'},
                    {'text': '研究结果改善。', 'quote': 'Outcomes improved across groups'}]}
        for digit in ('48', '3'):
            with self.subTest(title_digit=digit):
                value = dict(base, title_zh=f'随机试验{digit}')
                result = validate('quicklook', value, title, abstract)
                self.assertFalse(result['ok'])
                self.assertEqual(result['code'], f'numbers_not_in_source:{digit}')
                self.assertEqual(result['detail'], {'where': 'title_zh_vs_title', 'source': 'title', 'numbers': [digit]})

        value = dict(base, findings=[{'text': '随访48周。', 'quote': 'Patients were followed'}, base['findings'][1]])
        result = validate('quicklook', value, title, abstract)
        self.assertEqual(result['detail'], {'where': 'finding[0].text_vs_quote', 'source': 'quote', 'numbers': ['48']})

        result = validate('quicklook', base, title, abstract)
        self.assertTrue(result['ok'])
        value = dict(base, title_zh='随机试验48', one_line='纳入99例。')
        result = validate('quicklook', value, title, abstract)
        self.assertFalse(result['ok'])
        self.assertTrue(result['code'].startswith('numbers_not_in_abstract'))
        self.assertEqual(result['detail'], {'where': 'one_line', 'source': 'abstract', 'numbers': ['99']})

        malformed = validate('translate', {'title_zh': '短', 'abstract_zh': ''}, title, abstract)
        self.assertFalse(malformed['ok'])
        self.assertEqual(malformed['detail']['where'], 'validate')
        self.assertEqual(malformed['detail']['numbers'], [])

    def test_week_validator_discards_malformed_failure_details(self):
        forged = {'ok': False, 'code': 'numbers_not_in_source:99', 'detail': {
            'where': 'bad where ' + 'x' * 100, 'source': 'private', 'numbers': ['99', 'not-a-number']}}
        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout=json.dumps(forged), stderr='')
        paper = {'title': 'A title', 'abstract': 'An abstract'}
        with mock.patch.object(week.subprocess, 'run', return_value=completed):
            with self.assertRaises(week.EvidenceError) as raised:
                week.validate('quicklook', {}, paper)
        self.assertEqual(raised.exception.detail, {'numbers': ['99']})

    def test_bare_fraction_is_not_an_integer(self):
        self.assertFalse(g.nums('5 mg') <= g.nums('dose .5 mg'))


if __name__ == '__main__':
    unittest.main()
