import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_public
import enrich_metadata as enrich


class NoticeTopicTagsTests(unittest.TestCase):
    def test_notice_title_prefixes_do_not_trigger_any_rules(self):
        summary = 'Randomized controlled trial of artificial intelligence for atrial fibrillation.'
        for prefix in (
            'Correction to', 'Correction:', 'Author Correction:', 'Publisher Correction:',
            'Erratum', 'Retraction:', 'Retraction of:', '[Correspondence] Notice of Retraction:',
            '[Expression of Concern:', 'Corrigendum', '撤稿声明：', '【勘误】', '更正：',
        ):
            title = prefix + ' AI-ECG in a randomized controlled trial'
            with self.subTest(title=title):
                self.assertTrue(enrich.topic_notice_reason({'title': title}).startswith('title prefix:'))
                self.assertEqual(enrich.extract_tags(title, summary), [])

    def test_structured_metadata_identifies_notices_with_neutral_titles(self):
        for fields, reason in (
            ({'pubTypes': ['Retraction of Publication']}, 'PubMed pubTypes: Retraction of Publication'),
            ({'pubTypes': ['Published Erratum']}, 'PubMed pubTypes: Published Erratum'),
            ({'pubTypes': ['Expression of Concern']}, 'PubMed pubTypes: Expression of Concern'),
            ({'pubmedRelations': [{'type': 'ErratumFor', 'pmid': '123'}]}, 'PubMed pubmedRelations: ErratumFor'),
            ({'type': 'retraction-notice'}, 'Crossref type: retraction-notice'),
            ({'type': 'journal-article', 'update-to': [{'type': 'correction', 'DOI': '10.0000/original'}]},
             'Crossref update-to: correction'),
            ({'update-to': [{'type': 'expression_of_concern', 'DOI': '10.0000/original'}]},
             'Crossref update-to: expression-of-concern'),
            ({'relation': {'is-retraction-of': [{'id': '10.0000/original'}]}},
             'Crossref relation: is-retraction-of'),
        ):
            with self.subTest(fields=fields):
                paper = {'title': 'Atrial fibrillation outcomes', 'tags': ['#影像'], **fields}
                self.assertEqual(enrich.topic_notice_reason(paper), reason)
                self.assertEqual(enrich.enrich_paper(dict(paper))['tags'], [])
                self.assertEqual(build_public.public_paper(paper)['tags'], [])

    def test_research_titles_and_notices_about_an_original_do_not_lose_tags(self):
        for title in (
            'QT correction formulas and atrial fibrillation',
            'Bias correction in echocardiography',
            'Correction of QT intervals in atrial fibrillation',
            'Retraction of the mitral valve leaflet in heart failure',
            'Coronary injury following muscle retraction',
        ):
            with self.subTest(title=title):
                self.assertEqual(enrich.topic_notice_reason({'title': title}), '')
                self.assertTrue(enrich.extract_tags(title))
        title = 'AI-ECG in a randomized controlled trial'
        paper = {
            'title': title, 'type': 'journal-article', 'pubTypes': ['Journal Article', 'Retracted Publication'],
            'pubmedRelations': [{'type': 'ErratumIn', 'pmid': '123'}, {'type': 'RetractionIn', 'pmid': '124'}],
            'relation': {'has-correction': [{'id': '10.0000/erratum'}]},
            'updated-by': [{'type': 'correction', 'DOI': '10.0000/erratum'}],
            'update-to': [{'type': 'new_version', 'DOI': '10.0000/version'}],
        }
        paper['tags'] = enrich.extract_tags(title)
        self.assertIn(enrich.TAG_AI_RCT, paper['tags'])
        self.assertEqual(enrich.topic_notice_reason(paper), '')
        self.assertEqual(enrich.resolve_topic_tags(paper), paper['tags'])
        self.assertEqual(build_public.public_paper(paper)['tags'], paper['tags'])

    def test_notice_discards_machine_tags_but_keeps_human_origin(self):
        paper = {'id': 'notice', 'title': 'Corrigendum: Heart failure outcomes', 'tags': ['#心电']}
        for origin in ('machine_reviewed', 'machine_agreed', 'human'):
            with self.subTest(origin=origin), tempfile.TemporaryDirectory() as tmp:
                overlay = Path(tmp) / 'overlay.json'
                overlay.write_text(json.dumps({'items': [
                    {'id': 'notice', 'tags': ['#影像'], 'tagOrigin': origin},
                ]}), encoding='utf-8')
                self.addCleanup(enrich.clear_tag_overlay_cache)
                enrich.clear_tag_overlay_cache()
                with patch.object(enrich, 'TAG_BACKFILL_OVERLAY', overlay):
                    tags = ['#影像'] if origin == 'human' else []
                    self.assertEqual(enrich.resolve_topic_tags(paper), tags)
                    self.assertEqual(build_public.public_paper(paper)['tags'], tags)
                    human = dict(paper, tagOrigin='human')
                    self.assertIs(enrich.resolve_topic_tags(human), human['tags'])
                    self.assertEqual(build_public.public_paper(human)['tags'], human['tags'])
                    self.assertNotIn('tagOrigin', build_public.public_paper(human))

    def test_h01_historical_overlay_is_suppressed_without_editing_it(self):
        paper = {
            'id': 'rss-6d27e5a0b882b910', 'doi': '10.1093/ejcts/ezag240',
            'title': 'Retraction of: A giant free-floating thrombus in the ascending aorta caused by '
                     'radiofrequency ablation of premature ventricular contractions',
        }
        enrich.clear_tag_overlay_cache()
        row = next(r for r in json.loads(enrich.TAG_BACKFILL_OVERLAY.read_text())['items']
                   if r.get('doi') == paper['doi'])
        self.assertEqual(row['tags'], ['#房颤/电生理', '#卒中/抗凝', '#高血压/血管'])
        self.assertEqual(enrich.resolve_topic_tags(paper), [])
        self.assertEqual(build_public.public_paper(dict(paper, tags=row['tags']))['tags'], [])

    def test_compact_radar_uses_notice_metadata_from_full_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / 'data'
            data.mkdir()
            rows = [
                {'pmid': '9991', 'title': 'Atrial fibrillation clinical results'},
                {'pmid': '9992', 'title': 'Atrial fibrillation clinical outcomes'},
            ]
            (data / 'radar-archive.json').write_text(json.dumps({'rows': [
                dict(row, date='2026-10-01', datePrecision='day') for row in rows
            ]}))
            (data / 'archive-full.json').write_text(json.dumps({
                '9991': {'pt': ['Published Erratum']},
                '9992': {'pubmedRelations': [{'type': 'ErratumIn', 'pmid': '9991'}]},
            }))
            with patch.object(build_public, 'ROOT', root):
                radar = build_public.make_radar([], corrections={})
            tags = {row[0]: [radar['tag'][i] for i in row[7]] for row in radar['rows']}
            self.assertEqual(tags, {'9991': [], '9992': ['#房颤/电生理']})
