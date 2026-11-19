"""Exercise text writers and the offline public-data gate."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import archive_details
from audit_text_hygiene import ROOT, audit
from build_public import split_deep_readings
import fetch_archive
import fetch_pubmed
import generate_quicklooks
from public_split import build_assets, js
from refresh_feeds import parse_feed
from text_hygiene import artifact_counts, normalize_text
import translate_titles


class TextHygieneTests(unittest.TestCase):
    def test_each_artifact(self):
        for kind, text, reference, count in (
            ('octal_escape', r'A\342\200\224B', None, 3),
            ('octal_escape', r'A\037B\035C', None, 2),
            ('hex_escape', r'\xe2\x80\x94', None, 3),
            ('unicode_escape', r'\u2014', None, 1),
            ('nested_html_entity', '&amp;amp; &amp;lt;', None, 2),
            ('html_entity', '&ge; &#8805; &#x2265;', None, 3),
            ('control', 'one\x1ftwo\x85three', None, 2),
            ('replacement', 'mo\ufffdel', None, 1),
            ('mojibake', 'JosÃ© â€” â€™', None, 3),
            ('bare_dash_residue', 'Code 037, MRI 035 CT', 'Code 037, MRI — CT', 1),
        ):
            with self.subTest(kind=kind, text=text):
                self.assertEqual(artifact_counts(text, reference=reference)[kind], count)

    def test_legitimate_text_and_numbers_survive(self):
        for text in (
            'N-acetyl-L-cysteine, Na⁺/K⁺-ATPase, Fe2(SO4)3',
            'C-reactive protein ≥ 4, TNF-α and β-blockers',
            '中文标点，括号（样本）；风险：低。',
            r'Path A\B; literal \ in a LaTeX-free title',
            'NCT03701234, sample 035, 254 037 participants',
            'SÃO PAULO & Co.; AT&T; unknown &copycat;',
        ):
            with self.subTest(text=text):
                self.assertFalse(any(artifact_counts(text, reference=text).values()))
                self.assertEqual(normalize_text(text), text)
        self.assertEqual(artifact_counts('037', reference='study —')['bare_dash_residue'], 0)
        self.assertEqual(artifact_counts('one\n\ntwo')['control'], 0)
        self.assertEqual(artifact_counts('one\ntwo', single_line=True)['control'], 1)

    def test_decoding_order_and_unrecoverable_text(self):
        text = r'José\342\x80\224 A &amp;lt;B&amp;gt; \uD83D\uDE00 â€™'
        expected = 'José— A <B> 😀 ’'
        self.assertEqual(normalize_text(text), expected)
        self.assertEqual(normalize_text(expected), expected)
        self.assertEqual(normalize_text(r'A\037B\035C'), 'A B C')
        self.assertEqual(normalize_text(r'\xFF \777 \uD800 �'), r'\xFF \777 \uD800 �')

    def test_rss_ingest_decodes_text_and_flattens_wiley_author_wrapping(self):
        xml = r'''<rss xmlns:dc="urn:dc"><channel><item>
          <title>Cardiac MRI \342\200\224 cohort</title>
          <link>https://example.invalid/article</link>
          <description><![CDATA[<p>JosÃ© &amp;lt;4</p>]]></description>
          <dc:creator>First Author,
                Second Author</dc:creator></item></channel></rss>'''.encode()
        rows = parse_feed(xml, {'id': 'wiley-fixture', 'name': 'Cardiology', 'url': 'https://example.invalid/feed'})['items']
        self.assertEqual(rows[0]['title'], 'Cardiac MRI — cohort')
        self.assertEqual(rows[0]['summary'], 'José <4')
        self.assertEqual(rows[0]['authors'], ['First Author, Second Author'])

    def test_pubmed_and_crossref_ingest(self):
        xml = r'''<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID>
          <Article><ArticleTitle>Cardiac \u2014 study</ArticleTitle><Abstract>
          <AbstractText Label="METHODS">A &amp;amp; B &#x85; &lt;5</AbstractText>
          </Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>'''
        paper = fetch_pubmed.parse(ET.fromstring(xml))[0]
        self.assertEqual(paper['title'], 'Cardiac — study')
        self.assertEqual(paper['summary'], 'METHODS: A & B <5')
        self.assertEqual(archive_details.parse_efetch(xml)['123']['a'][0]['t'], 'A & B <5')
        self.assertEqual(fetch_archive.ingest({'123': {'t': r'Cardiac \u2014 study.'}})[0]['title'], paper['title'])
        with patch.object(archive_details, 'get', return_value={'message': {'abstract': '<jats:p>JosÃ© &amp;ge;4</jats:p>'}}):
            self.assertEqual(archive_details.crossref_abs('10.1000/example'), 'José ≥4')

    def test_translation_repairs_cache_and_requeues_lossy_title(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'translations.json'
            out.write_text(json.dumps({'pmid:123': '心脏�病', 'pmid:456': '阈值 &ge; 4'}), encoding='utf-8')
            env = {'XINZHI_LLM_ENDPOINT': 'https://example.invalid', 'XINZHI_LLM_API_KEY': 'test-only', 'XINZHI_LLM_MODEL': 'test-model'}
            with patch.object(translate_titles, 'OUT', out), patch.object(
                translate_titles, 'collect', return_value=[('pmid:123', 'Heart disease'), ('pmid:456', 'Threshold')]
            ), patch.object(translate_titles, 'call', return_value={'0': r'心脏\u2014疾病'}) as call, patch.dict(
                os.environ, env
            ), patch.object(sys, 'argv', ['translate_titles.py', '--run']), patch('builtins.print'):
                translate_titles.main()
            self.assertEqual(call.call_args.args[1], ['Heart disease'])
            self.assertEqual(json.loads(out.read_text(encoding='utf-8')), {'pmid:123': '心脏—疾病', 'pmid:456': '阈值 ≥ 4'})
        self.assertEqual(translate_titles.translated_title('心脏�病'), '')

    def test_quicklook_cleans_model_text_before_matching_quotes(self):
        abstract = 'The study reported a threshold of ≥4. The design did not confirm causation.'
        findings = [
            {'text': '阈值为4。', 'quote': r'The study reported a threshold of \u22654.'},
            {'text': '未证实因果。', 'quote': 'The design did not confirm causation.'},
        ]
        raw = {'title_zh': '阈值研究', 'one_line': '研究 &amp; 分析', 'design': '观察设计',
               'limits': '未证实因果', 'why_read': '核对证据', 'findings': findings}
        paper = {'id': 'pmid-123', 'pmid': '123', 'title': 'Trial'}
        staged, *_ = generate_quicklooks.batch(
            [paper], {'items': {}}, {}, {'model': 'test-model'}, datetime.date(2026, 11, 17), 1, 1,
            fetch=lambda _paper: {'abstract': abstract}, model=lambda *_: (raw, {}),
        )
        result = next(iter(staged['items'].values()))
        self.assertEqual(result['findings'][0]['quote'], 'The study reported a threshold of ≥4.')
        self.assertEqual(result['one_line'], '研究 & 分析')
        with self.assertRaisesRegex(generate_quicklooks.QuicklookError, 'invalid_field_one_line'):
            generate_quicklooks.normalize_model_output(dict(raw, one_line='观�测'))

    def test_bundle_audit_and_exit_status_cover_first_screen_parts_radar_shards_and_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / 'data'
            data.mkdir()
            (data / 'translations.json').write_text(json.dumps({'pmid:123': '题名�'}), encoding='utf-8')
            readings, shards = split_deep_readings({'items': [
                {'pmcid': 'PMC123', 'publishedOn': '2026-11-17', 'sections': {'design': {'text': 'Stage &amp;lt;4'}}},
            ]})
            radar = {'rows': [['123', '', '', 0, 0, 0, 0, [], 'MRI 037 CT']]}
            public = {
                'CURATED': [{'id': 'rss-test', 'title': r'Title \u2014 here', 'url': 'https://example.invalid/?x=1&amp;y=2'}],
                'CONTENT_STATUS': {}, 'JOURNAL_METRICS': {}, 'FEEDS': {'items': [
                    {'id': 'rss-test-2', 'summary': 'JosÃ©', 'authors': ['First,\nSecond'],
                     'quantitativeMetrics': {'effectSizes': 'OR &#8805; 2', 'trialId': 'NCT03701234'}},
                ]}, 'LIBRARY': {'papers': [], 'pdfIds': []}, 'SOURCE_HEALTH': {},
                'DEEP_READINGS': readings,
            }
            assets, app, _ = build_assets(public, js('RADAR_ARCHIVE', radar), [r'const regex = /\u2014/;'], '')
            for name, content in {**{k: v.encode() for k, v in assets.items()}, **shards}.items():
                path = root / name
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(content)
            (root / 'index.html').write_text(f'<script src="{app}"></script>', encoding='utf-8')
            reference = root / 'reference.json'
            reference.write_text(json.dumps({'123': {'title': 'MRI — CT'}}), encoding='utf-8')
            report = audit(root, data, json.loads(reference.read_text(encoding='utf-8')))
            self.assertEqual({row['artifact']: (row['source'], row['example_ids']) for row in report['groups']}, {
                'replacement': ('translate_titles.py', ['pmid:123']),
                'unicode_escape': ('refresh_feeds.py', ['rss-test']),
                'mojibake': ('refresh_feeds.py', ['rss-test-2']),
                'control': ('refresh_feeds.py', ['rss-test-2']),
                'html_entity': ('enrich_metadata.py (metric extraction)', ['rss-test-2']),
                'nested_html_entity': ('daily_fulltext.py', ['PMC123']),
                'bare_dash_residue': ('fetch_archive.py', ['123']),
            })
            proc = subprocess.run(
                [sys.executable, str(ROOT / 'scripts/audit_text_hygiene.py'), '--public-dir', str(root),
                 '--data-dir', str(data), '--dash-reference', str(reference), '--check'],
                capture_output=True, text=True,
            )
            self.assertEqual(proc.returncode, 1, proc.stderr)
            self.assertEqual(json.loads(proc.stdout), report)


def check_built():
    public = ROOT / 'public'
    data = ROOT / 'data'
    if not public.exists() and not data.exists():
        print('No built public/ or data/. Synthetic audit is covered by unittest discovery.')
        return 0
    report = audit(public if public.exists() else None, data if data.exists() else None)
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return int(any(report['totals'].values()))


if __name__ == '__main__':
    if sys.argv[1:] == ['--check-built']:
        sys.exit(check_built())
    unittest.main()
