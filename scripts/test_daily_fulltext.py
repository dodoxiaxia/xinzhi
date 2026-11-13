"""Offline full-text identity, evidence, restart, public projection and payment reservation contracts."""
import copy
import datetime as dt
import json
import tempfile
import unittest
import urllib.parse as urllib_parse
from unittest.mock import patch
from pathlib import Path
import daily_fulltext as d

WHEN = dt.datetime(2026, 10, 9, 2, tzinfo=dt.timezone.utc)
QUOTE = 'The study included 120 patients with cardiovascular disease and assessed clinical outcomes prospectively.'

def paper(n=1, topic='心血管'):
    return {'title': 'Heart outcomes study', 'journal': 'Fixture journal', 'date': '2026-10-07',
            'doi': '10.1234/fixture' + str(n), 'pmid': str(n), 'pmcid': 'PMC' + str(n), 'topic': topic}

def xml(p):
    body = ''.join('<sec><title>Methods and results</title><p>' + (QUOTE + ' Additional public research context. ') * 4 + '</p></sec>' for _ in range(6))
    return ('<article article-type="research-article"><front><article-meta><article-id pub-id-type="pmc">' +
            p['pmcid'] + '</article-id><article-id pub-id-type="pmid">' + p['pmid'] +
            '</article-id><article-id pub-id-type="doi">' + p['doi'] +
            '</article-id><title-group><article-title>' + p['title'] +
            '</article-title></title-group></article-meta></front><body>' + body + '</body></article>').encode()

def output(paragraph_id='p1'):
    return {'titleZh': '心血管临床结局研究', 'sections': {k: {
        'text': '这段离线测试文字仅用于核对字段与证据链接，不是临床结论。研究纳入120名患者，真实含义仍需回查原文。',
        'evidence': [{'paragraph': paragraph_id, 'quote': QUOTE}]} for k in d.SECTION_KEYS}}

def item(n=1):
    p = paper(n)
    paragraphs, sha = d.parse_fulltext(xml(p), p)
    p.update(d.validate_output(output(), paragraphs, p['title']), publishedOn='2026-10-09',
             generatedAt=WHEN.isoformat(), retrievedAt=WHEN.isoformat(), sourceParagraphs=paragraphs,
             sourceHash=sha, sourceUrl='https://europepmc.org/articles/'+p['pmcid'],
             scope='public-fulltext-body', humanReviewed=False, whySelected='近30天 · 心血管 · 开放全文')
    return p

class SourceTests(unittest.TestCase):
    def test_beijing_day_and_future_dates(self):
        self.assertEqual(d.day_of(dt.datetime(2026, 10, 8, 17, tzinfo=dt.timezone.utc)), '2026-10-09')
        self.assertFalse(d.date_valid('2026-10-10', WHEN.date()))
        self.assertFalse(d.date_valid('2026-06-01', WHEN.date()))

    def test_only_recent_open_medical_articles_are_candidates(self):
        row = {'isOpenAccess':'Y','pmcid':'PMC1','title':'Artificial intelligence for heart disease','source':'MED','id':'1','firstPublicationDate':'2026-10-08','doi':'10.1234/test'}
        self.assertEqual(d.candidate(row, WHEN.date())['topic'], '心血管 × AI')
        for changes in ({'isOpenAccess':'N'}, {'firstPublicationDate':'2026-10-10'}, {'title':'Correction: Heart disease'}, {'title':'Heart disease study protocol'}, {'title':'Deep learning for astronomy'}):
            self.assertIsNone(d.candidate(dict(row, **changes), WHEN.date()))

    def test_xml_requires_matching_identity_and_actual_body(self):
        p = paper()
        paragraphs, digest = d.parse_fulltext(xml(p), p)
        self.assertEqual(len(digest), 64)
        self.assertGreaterEqual(len(paragraphs), 5)
        for field in ('pmcid','pmid','doi','title'):
            bad = dict(p, **{field:'unmatched'})
            with self.assertRaises(d.ReadingError):
                d.parse_fulltext(xml(p), bad)
        with self.assertRaises(d.ReadingError):
            d.parse_fulltext(xml(p).replace(b'<body>',b'<abstract>').replace(b'</body>',b'</abstract>'), p)
        with self.assertRaises(d.ReadingError):
            d.parse_fulltext(xml(p).replace(b'research-article',b'correction'), p)

    def test_numeric_spellings_preserve_value_and_reject_new_values(self):
        self.assertTrue(d.numbers('四周4周，3月至7月，p<0.001') <= d.numbers('Four weeks, March to July, p < .001'))
        self.assertEqual(d.numbers('7,639 and 1.60'),d.numbers('7639 and 1.6'))
        self.assertFalse(d.numbers('999 patients') <= d.numbers('nine patients'))
        self.assertNotIn('5',d.numbers('The intervention may improve outcomes.'))

    def test_evidence_and_numbers_are_checked_per_section(self):
        paragraphs, digest = d.parse_fulltext(xml(paper()), paper())
        self.assertIn('findings', d.validate_output(output(), paragraphs, paper()['title'])['sections'])
        for change in ('quote','number','paragraph'):
            bad = output()
            if change == 'quote': bad['sections']['findings']['evidence'][0]['quote'] = 'Invented text that never occurred in the original article.'
            if change == 'number': bad['sections']['findings']['text'] += '另外有999名患者。'
            if change == 'paragraph': bad['sections']['findings']['evidence'][0]['paragraph'] = 'abstract1'
            with self.assertRaises(d.ReadingError):
                d.validate_output(bad, paragraphs, paper()['title'])

    def test_fixed_evidence_ids_bind_exact_text_and_reject_unknown_ids(self):
        paragraphs, digest = d.parse_fulltext(xml(paper()), paper())
        units = d.evidence_units(paragraphs)
        self.assertTrue(all(len(p['text']) <= 650 for p in units))
        raw = output()
        for block in raw['sections'].values():
            block['evidence'] = [{'paragraph':units[0]['id']}]
        result = d.validate_output(raw, units, paper()['title'])
        self.assertEqual(result['sections']['findings']['evidence'][0]['quote'],units[0]['text'])
        raw['sections']['findings']['evidence']=[{'paragraph':'fabricated'}]
        with self.assertRaises(d.ReadingError):
            d.validate_output(raw,units,paper()['title'])

    def test_abstract_scope_cannot_be_promoted_to_fulltext(self):
        raw=d.empty_data()
        row=item()
        row['scope']='public-abstract'
        raw['items'].append(row)
        with self.assertRaises(d.ReadingError):
            d.public_readings(raw)

    def test_public_projection_never_exposes_private_source_or_ledger(self):
        raw = d.empty_data()
        p = item()
        p['private_path'] = '.local/secret.pdf'
        p['api_key'] = 'fixture-only-not-a-key'
        raw['items'].append(p)
        raw['drafts']={'private_unreviewed':{'api_key':'fixture-only-not-a-key'}}
        result = d.public_readings(raw)
        serialized = json.dumps(result)
        for field in ('sourceParagraphs','private_path','api_key','secret.pdf','drafts'):
            self.assertNotIn(field, serialized)
        self.assertFalse(result['items'][0]['humanReviewed'])
        self.assertEqual(result['items'][0]['scope'], 'public-fulltext-body')

class ScopeTests(unittest.TestCase):
    """Deep-reading column scope (owner decision 2026-11-13): cardiovascular, or general LLM/medical-AI methodology."""
    OUT = (
        ('10.1111/cas.70548', 'Multimodal Integration Identifies C16orf74 as an EMT Regulator With Prognostic Relevance in HNSCC.'),
        ('10.1186/s40798-026-01137-3', 'Sex-Equitable Machine Learning Prediction of Ankle Reinjury in Individuals with Chronic Ankle Instability: A 2-Year Prospective Cohort Study with Fairness Audit.'),
        ('10.1002/jsp2.70227', 'Development of a Multimodal Model Combining Imaging and Clinical Data to Predict Bone Cement Leakage During Vertebroplasty for Fresh Thoracolumbar Compression Fractures.'),
        ('bladder', 'Biparametric MRI with deep learning for the preoperative prediction of muscle invasion in patients with bladder cancer: a multicenter study.'),
        ('dental', 'Artificial Intelligence Applications in Pediatric Dentistry: A Systematic Scoping Review With Visual Evidence Mapping.'),
        ('breast', 'Magnetic resonance imaging radiomics for predicting pathologic complete response to neoadjuvant chemotherapy in breast cancer.'),
        ('triage', 'Explainable Machine Learning for Predicting Hospital Admission at Emergency Department Triage: Retrospective Cohort Study.'),
        ('delirium', 'External Validation of a Machine Learning Model for Delirium Risk.'),
        ('skin', 'Deep learning for skin lesion classification in dermatology clinics.'),
        ('lymphovascular', 'Machine learning to predict lymphovascular invasion in gastric cancer.'),
        ('astronomy', 'Deep learning for astronomy'),
        ('lung-cancer', 'Deep learning for early detection of lung cancer on chest CT'),
        ('lung-nodule', 'Machine learning classification of pulmonary nodules in screening CT'),
        ('lung-cancer-zh', '肺癌筛查中的深度学习'),
        ('heat-stroke', 'Heat stroke risk prediction with machine learning'),
    )
    IN_CARDIO = (
        ('ecg-af', 'Deep learning electrocardiogram analysis for atrial fibrillation detection'),
        ('acs-triage', 'Machine learning triage of chest pain and acute coronary syndrome in the emergency department'),
        ('10.1177/1753495x261499121', 'Evaluation of a postpartum cardiovascular risk clinic after hypertensive disorder of pregnancy: First-year experience.'),
        ('hf', 'Artificial intelligence for heart failure risk prediction'),
        ('pert', 'Real-world implementation of an AI-assisted PERT workflow for pulmonary embolism response teams'),
        ('pe', 'Machine learning for risk stratification in acute pulmonary embolism'),
        ('pah-ct', 'Deep learning CT measurement of pulmonary arterial hypertension severity'),
        ('pulm-vascular', 'Absolute and lung volume-normalized deep learning-derived pulmonary vascular measures'),
        ('aorta', 'Automated aorta segmentation and aortic dissection detection with deep learning'),
        ('pad', 'Machine learning for peripheral artery disease detection'),
        ('stroke', 'Deep learning prediction of outcomes after acute ischemic stroke'),
        ('zh', '肺栓塞应急团队流程；肺动脉高压CT测量；主动脉夹层；外周动脉疾病；脑卒中'),
        ('cardio-onc', 'Cardiotoxicity prediction in breast cancer patients treated with anthracyclines'),
    )
    IN_GENERAL = (
        ('reasoning', 'A benchmark for clinical reasoning in large language models'),
        ('llm-diagnosis', 'Evaluating large language models for diagnosis from clinical vignettes'),
        ('trial-method', 'Methodological standards for randomized clinical trials of artificial intelligence interventions'),
    )

    def test_off_scope_applications_are_rejected(self):
        for key, title in self.OUT:
            self.assertEqual(d.deep_reading_scope(title), '', key)
            self.assertEqual(d.topic_of(title, 'machine learning clinical patient health'), '', key)

    def test_cardiovascular_and_general_ai_methodology_are_accepted(self):
        for key, title in self.IN_CARDIO:
            self.assertEqual(d.deep_reading_scope(title), 'cardio', key)
        for key, title in self.IN_GENERAL:
            self.assertEqual(d.deep_reading_scope(title), 'general', key)
            self.assertEqual(d.topic_of(title), 'AI 医疗', key)
        self.assertEqual(d.topic_of('Deep learning electrocardiogram analysis for atrial fibrillation detection'), '心血管 × AI')
        self.assertEqual(d.topic_of('Evaluation of a postpartum cardiovascular risk clinic'), '心血管')

    def test_broad_cardio_words_do_not_mislabel_other_specialties(self):
        for title in ('Vascular endothelial growth factor expression in hepatocellular carcinoma',
                      'Portal hypertension and machine learning in cirrhosis', 'Heat stroke prediction with deep learning',
                      'Transarterial chemoembolization response prediction with machine learning'):
            self.assertEqual(d.deep_reading_scope(title), '', title)

    def test_the_title_alone_decides_so_export_matches_selection(self):
        row = {'isOpenAccess': 'Y', 'pmcid': 'PMC9', 'source': 'MED', 'id': '9', 'firstPublicationDate': '2026-10-08',
               'doi': '10.1234/x', 'title': 'Machine learning prediction of ankle reinjury',
               'abstractText': 'A clinical machine learning study of patients; cardiovascular and vascular risk noted.'}
        self.assertIsNone(d.candidate(row, WHEN.date()))
        row['title'] = 'Evaluating large language models for clinical reasoning: a benchmark'
        self.assertEqual(d.candidate(row, WHEN.date())['topic'], 'AI 医疗')

    def test_discovery_limits_the_ai_query_and_adds_a_narrow_general_query(self):
        urls = []
        def fetch(url, maximum):
            urls.append(urllib_parse.unquote(url))
            return b'{"resultList": {"result": []}}'
        papers, errors = d.discover(WHEN.date(), fetch=fetch)
        self.assertEqual((papers, errors, len(urls)), ([], [], 3))
        ai_cardio, general = urls[1], urls[2]
        self.assertIn('TITLE:cardiovascular', ai_cardio)
        self.assertNotIn('TITLE_ABS:health', ai_cardio)
        self.assertIn('TITLE:benchmark', general)
        self.assertNotIn('TITLE_ABS:patient', general)

    def test_public_column_drops_off_scope_items_but_keeps_the_private_store(self):
        raw = d.empty_data()
        keep, drop = item(1), item(2)
        drop['title'] = 'Machine learning prediction of ankle reinjury in chronic ankle instability'
        raw['items'] += [keep, drop]
        before = copy.deepcopy(raw)
        result = d.public_readings(raw)
        self.assertEqual([r['pmcid'] for r in result['items']], [keep['pmcid']])
        self.assertEqual(raw, before)

    def test_published_count_equals_the_items_the_column_shows(self):
        raw = d.empty_data()
        day = '2026-10-09'
        keep, drop, other_day = item(1), item(2), item(3)
        drop['title'] = 'Machine learning prediction of ankle reinjury in chronic ankle instability'
        other_day['publishedOn'] = '2026-10-08'
        raw['items'] += [keep, drop, other_day]
        raw['status'] = {'day': day, 'target': 12, 'completed': 2, 'state': 'complete', 'reason': ''}
        result = d.public_readings(raw)
        shown = [r for r in result['items'] if r['publishedOn'] == result['status']['day']]
        self.assertEqual(result['status']['completed'], len(shown))
        self.assertEqual(result['status']['completed'], 1)
        self.assertEqual(raw['status']['completed'], 2)  # private store keeps its own generation count

    def _status_for(self, status, titles):
        raw = d.empty_data()
        for n, title in enumerate(titles, 1):
            row = item(n)
            row['title'] = title
            raw['items'].append(row)
        raw['status'] = status
        return d.public_readings(raw)['status']

    def test_status_is_complete_when_anything_in_scope_is_shown_without_a_minimum(self):
        # Private store says "partial" with a shortfall reason; one exported reading is enough.
        status = self._status_for({'day': '2026-10-09', 'target': 12, 'completed': 7, 'state': 'partial',
                                   'reason': 'validation_or_fulltext_shortfall'},
                                  ['Heart outcomes study', 'Machine learning prediction of ankle reinjury'])
        self.assertEqual((status['state'], status['reason'], status['completed']), ('complete', '', 1))

    def test_status_with_nothing_in_scope_is_complete_not_a_failure(self):
        for reason in ('', 'validation_or_fulltext_shortfall'):
            status = self._status_for({'day': '2026-10-09', 'target': 12, 'completed': 3, 'state': 'waiting', 'reason': reason},
                                      ['Machine learning prediction of ankle reinjury', 'Deep learning for skin lesion classification in dermatology'])
            self.assertEqual((status['state'], status['reason'], status['completed']), ('complete', '', 0), reason)

    def test_status_keeps_a_real_generation_failure_when_nothing_is_shown(self):
        for reason in ('model_unavailable', 'provider_failed_today', 'prior_attempt_uncertain', 'checkpoint_write_failed'):
            status = self._status_for({'day': '2026-10-09', 'target': 12, 'completed': 0, 'state': 'waiting', 'reason': reason}, [])
            self.assertEqual((status['state'], status['reason'], status['completed']), ('waiting', reason, 0), reason)
        # No batch yet stays pending.
        self.assertEqual(self._status_for({'state': 'pending', 'target': 4}, []), {'state': 'pending', 'target': 4})

    def test_generation_never_pays_for_off_scope_papers(self):
        bad = dict(paper(1, 'AI 医疗'), title='Machine learning prediction of ankle reinjury')
        good = dict(paper(2, '心血管'))
        fetched = []
        def fetch(url):
            fetched.append(url)
            return xml(good)
        data, ledger = d.empty_data(), d.empty_ledger()
        d.generate(data, ledger, [bad, good], WHEN, lambda *_: None, {}, fetch=fetch,
                   model=lambda *args: output(args[-1][0]['id']))
        self.assertEqual([i['pmcid'] for i in data['items']], ['PMC2'])
        self.assertTrue(all('PMC1' not in u for u in fetched))

class RunExitCodeTests(unittest.TestCase):
    """`--run` has no minimum count: few or no readings exit 0; only a real generation error exits non-zero."""
    def run_main(self, papers, model=None, model_config=None):
        import contextlib, io, sys
        real_generate = d.generate
        class Writer:
            def save(self, data, ledger):
                d.atomic(d.ROOT / d.DATA_PATH, data)
                d.atomic(d.ROOT / d.LEDGER_PATH, ledger)
        by_pmc = {p['pmcid']: p for p in papers}
        generate = lambda *a, **k: real_generate(*a, fetch=lambda url: xml(by_pmc[url.split('/')[-2]]),
                                                 model=model or (lambda *args: output(args[-1][0]['id'])), **k)
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(d, 'ROOT', Path(tmp)), patch.object(d, 'now', return_value=WHEN), \
                patch.object(d, 'checkpoint', return_value=Writer()), \
                patch.object(d, 'model_config', model_config or (lambda: {})), \
                patch.object(d, 'discover', return_value=(papers, [])), \
                patch.object(d, 'generate', generate), patch.object(sys, 'argv', ['daily_fulltext.py', '--run']), \
                contextlib.redirect_stdout(io.StringIO()):
            code = d.main()
            return code, json.loads((Path(tmp) / d.DATA_PATH).read_text())['status']

    def test_too_few_candidates_exit_zero(self):
        for papers in ([], [paper(1, '心血管')], [dict(paper(2, 'AI 医疗'), title='Machine learning prediction of ankle reinjury')]):
            code, status = self.run_main(papers)
            self.assertEqual(code, 0, len(papers))
            self.assertEqual(status['state'], 'complete')
            self.assertEqual(status['completed'], 1 if papers and papers[0]['title'] == 'Heart outcomes study' else 0)

    def test_real_generation_errors_still_exit_non_zero(self):
        def unavailable(*_):
            raise d.ReadingError('model_unavailable')
        code, status = self.run_main([paper(1, '心血管')], model=unavailable)
        self.assertEqual((code, status['state'], status['reason']), (1, 'waiting', 'model_unavailable'))
        def not_configured():
            raise d.ReadingError('model_not_configured')
        code, status = self.run_main([paper(1, '心血管')], model_config=not_configured)
        self.assertEqual((code, status['reason']), (1, 'model_not_configured'))

    def test_the_run_exit_code_and_the_public_status_share_one_judgement(self):
        for reason in ('', 'validation_or_fulltext_shortfall'):
            self.assertFalse(d.generation_failed(reason))
        for reason in ('model_unavailable', 'provider_failed_today', 'prior_attempt_uncertain', 'checkpoint_write_failed', 'time_budget'):
            self.assertTrue(d.generation_failed(reason))
            self.assertEqual(d.generation_state(0, reason), 'waiting')
            self.assertEqual(d.generation_state(2, reason), 'partial')
        self.assertEqual(d.generation_state(0, 'validation_or_fulltext_shortfall'), 'complete')

class GenerationTests(unittest.TestCase):
    def generate(self, data=None, ledger=None, model=None, save=None):
        data, ledger = data or d.empty_data(), ledger or d.empty_ledger()
        papers = [paper(i, 'AI 医疗' if i % 2 == 0 else '心血管') for i in range(1, d.MAX_CALLS + 5)]
        bypmc = {p['pmcid']:p for p in papers}
        fetch = lambda url: xml(bypmc[url.split('/')[-2]])
        result = d.generate(data, ledger, papers, WHEN, save or (lambda *_:None), {}, fetch=fetch, model=model or (lambda *args: output(args[-1][0]['id'])))
        return data, ledger, result

    def test_local_preparation_error_leaves_no_started_reservation(self):
        ledger = d.empty_ledger()
        with patch.object(d, 'evidence_units', side_effect=IndexError('boom')):
            with self.assertRaises(IndexError):
                self.generate(ledger=ledger)
        self.assertEqual(ledger['days'][d.day_of(WHEN)], [])

    def test_resolution_closes_only_the_exact_started_row(self):
        row = {'identity': 'PMC1', 'sourceHash': 'a' * 64, 'at': '2026-10-10T22:01:54+00:00', 'state': 'started'}
        other = dict(row, at='2026-10-10T23:00:00+00:00')
        ledger = d.empty_ledger()
        ledger['days']['2026-10-11'] = [row, other]
        entry = {'day': '2026-10-11', 'identity': 'PMC1', 'sourceHash': 'a' * 64, 'at': row['at'], 'basis': 'crash before model'}
        self.assertEqual(d.apply_resolutions(ledger, [entry]), 1)
        self.assertEqual((row['state'], row['errorCode']), ('invalid', 'pre_model_crash'))
        self.assertEqual(other['state'], 'started')
        self.assertEqual(d.apply_resolutions(ledger, [entry]), 0)

    def test_new_day_publishes_target_distinct_articles_and_same_day_is_cached(self):
        calls = []
        model = lambda *args: (calls.append(True) or output(args[-1][0]['id']))
        data, ledger, status = self.generate(model=model)
        self.assertEqual(d.TARGET, 12)
        self.assertEqual(status['completed'], d.TARGET)
        self.assertEqual(len(calls), d.TARGET)
        self.assertEqual(len({d.identity(p) for p in data['items']}), d.TARGET)
        self.generate(data=data, ledger=ledger, model=model)
        self.assertEqual(len(calls), d.TARGET)
        self.assertEqual(len(data['items']), d.TARGET)

    def test_reservation_is_saved_before_each_model_request(self):
        observed = []
        def save(data, ledger): observed.append(copy.deepcopy(ledger))
        def model(*_):
            self.assertEqual(observed[-1]['days']['2026-10-09'][-1]['state'], 'started')
            return output(_[-1][0]['id'])
        data, ledger, status = self.generate(model=model, save=save)
        self.assertEqual(status['completed'], d.TARGET)
        self.assertTrue(all(r['state']=='validated' for r in ledger['days']['2026-10-09']))

    def test_failed_checkpoint_never_dispatches_model(self):
        calls = []
        def failed(*_): raise d.ReadingError('checkpoint_write_failed')
        with self.assertRaises(d.ReadingError):
            self.generate(model=lambda *_:calls.append(True), save=failed)
        self.assertEqual(calls, [])

    def test_cut_off_reply_skips_that_paper_and_the_day_continues(self):
        calls = []
        def model(*args):
            calls.append(True)
            if len(calls) == 1:
                raise d.ReadingError('model_output_incomplete')
            return output(args[-1][0]['id'])
        data, ledger, status = self.generate(model=model)
        rows = ledger['days']['2026-10-09']
        self.assertEqual((rows[0]['state'], rows[0]['errorCode']), ('invalid', 'model_output_incomplete'))
        self.assertEqual(status['completed'], d.TARGET)
        self.assertEqual(len(calls), d.TARGET + 1)

    def test_old_failed_row_for_a_cut_off_reply_no_longer_blocks_the_day(self):
        ledger = d.empty_ledger()
        ledger['days']['2026-10-09'] = [{'identity': '10.1234/fixture1', 'state': 'failed', 'errorCode': 'model_output_incomplete'}]
        data, ledger, status = self.generate(ledger=ledger)
        self.assertEqual(status['completed'], d.TARGET)
        blocked = d.empty_ledger()
        blocked['days']['2026-10-09'] = [{'identity': '10.1234/fixture1', 'state': 'failed', 'errorCode': 'model_unavailable'}]
        data, blocked, status = self.generate(ledger=blocked)
        self.assertEqual((status['completed'], status['reason']), (0, 'provider_failed_today'))

    def test_provider_error_stops_and_keeps_previous_readings(self):
        raw = d.empty_data()
        old = item(99)
        old['publishedOn'] = '2026-10-08'
        raw['items'].append(old)
        calls = []
        def failed(*_):
            calls.append(True)
            raise d.ReadingError('model_unavailable')
        data, ledger, status = self.generate(data=raw, model=failed)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(data['items']), 1)
        self.assertEqual(status['state'], 'waiting')
        self.generate(data=data, ledger=ledger, model=failed)
        self.assertEqual(len(calls), 1)

    def test_restart_with_started_attempt_never_pays_again(self):
        ledger = d.empty_ledger()
        ledger['days']['2026-10-09'] = [{'identity':'10.1234/fixture1','state':'started'}]
        calls = []
        data, ledger, status = self.generate(ledger=ledger, model=lambda *_:calls.append(True))
        self.assertEqual(calls, [])
        self.assertEqual(status['reason'], 'prior_attempt_uncertain')

    def test_invalid_outputs_are_skipped_with_daily_attempt_cap(self):
        calls = []
        def bad(*_):
            calls.append(True)
            result=output(_[-1][0]['id'])
            # The only sentence carries the unsupported number, so removal-only repair cannot help.
            result['sections']['findings']['text'] = '不支持的研究结果共纳入9999名患者，这一数字没有原文证据。'
            return result
        data, ledger, status = self.generate(model=bad)
        self.assertEqual(len(calls), d.MAX_CALLS)
        self.assertEqual(d.MAX_CALLS, 2 * d.TARGET)
        self.assertEqual(status['completed'], 0)
        self.assertEqual(status['attempts'], d.MAX_CALLS)

    def test_sources_invalid_on_earlier_days_are_not_paid_for_again(self):
        ledger = d.empty_ledger()
        ledger['days']['2026-10-08'] = [{'identity':'10.1234/fixture1','state':'invalid'},
                                        {'identity':'10.1234/fixture2','state':'validated'}]
        tried = []
        model = lambda *args: (tried.append(args[1]['doi']) or output(args[-1][0]['id']))
        data, ledger, status = self.generate(ledger=ledger, model=model)
        self.assertNotIn('10.1234/fixture1', tried)
        self.assertEqual(status['completed'], d.TARGET)

class DraftRecoveryTests(unittest.TestCase):
    def test_recovery_revalidates_cached_source_and_does_not_call_model(self):
        p=paper()
        paras,sha=d.parse_fulltext(xml(p),p)
        units=d.evidence_units(paras)
        raw=output(units[0]['id'])
        data=d.empty_data()
        data['drafts']={d.identity(p):{'paper':p,'output':raw,'sourceParagraphs':units,'sourceHash':sha,'createdAt':WHEN.isoformat()}}
        ledger=d.empty_ledger()
        ledger['days']['2026-10-09']=[{'identity':d.identity(p),'sourceHash':sha,'state':'invalid'}]
        writes=[]
        self.assertEqual(d.recover_drafts(data,ledger,WHEN,lambda *_:writes.append(True)),1)
        self.assertEqual(len(data['items']),1)
        self.assertTrue(ledger['days']['2026-10-09'][0]['recoveredWithoutModel'])
        self.assertFalse(data['drafts'])
        self.assertEqual(d.recover_drafts(data,ledger,WHEN,lambda *_:None),0)

    def test_recovery_rejects_changed_source_hash_or_unsupported_number(self):
        p=paper()
        paras,sha=d.parse_fulltext(xml(p),p)
        units=d.evidence_units(paras)
        raw=output(units[0]['id'])
        raw['sections']['findings']['text']='不支持的研究结果共纳入999名患者，这一数字没有原文证据。'
        data=d.empty_data()
        data['drafts']={d.identity(p):{'paper':p,'output':raw,'sourceParagraphs':units,'sourceHash':sha,'createdAt':WHEN.isoformat()}}
        ledger=d.empty_ledger()
        ledger['days']['2026-10-09']=[{'identity':d.identity(p),'sourceHash':sha,'state':'invalid'}]
        self.assertEqual(d.recover_drafts(data,ledger,WHEN,lambda *_:None),0)
        data['drafts'][d.identity(p)]['output']=output(units[0]['id'])
        ledger['days']['2026-10-09'][0]['sourceHash']='0'*64
        self.assertEqual(d.recover_drafts(data,ledger,WHEN,lambda *_:None),0)

class RepairTests(unittest.TestCase):
    def setUp(self):
        self.p=paper()
        paras,self.sha=d.parse_fulltext(xml(self.p),self.p)
        self.units=d.evidence_units(paras)

    def test_unsupported_trailing_sentence_is_removed_not_rewritten(self):
        raw=output(self.units[0]['id'])
        original=raw['sections']['findings']['text']
        raw['sections']['findings']['text']+='另有999名患者。'
        with self.assertRaises(d.ReadingError):
            d.validate_output(raw,self.units,self.p['title'])
        result,repaired=d.validate_or_repair(raw,self.units,self.p['title'])
        self.assertTrue(repaired)
        self.assertEqual(result['sections']['findings']['text'],original)
        self.assertNotIn('999',result['sections']['findings']['text'])

    def test_gutted_section_keeps_the_original_error(self):
        raw=output(self.units[0]['id'])
        raw['sections']['question']['text']='短句一。'+'研究纳入999名患者并随访多年，以评估长期心血管结局与生存差异的全部细节。'
        with self.assertRaisesRegex(d.ReadingError,'unsupported_number'):
            d.validate_or_repair(raw,self.units,self.p['title'])

    def test_evidence_over_cap_is_trimmed_to_bound_paragraphs(self):
        units=[dict(self.units[i % len(self.units)], id='u%d' % i) for i in range(d.MAX_EVIDENCE+3)]
        raw=output(units[0]['id'])
        ids=[u['id'] for u in units]
        raw['sections']['design']['evidence']=[{'paragraph':i} for i in ids]+[{'paragraph':'missing'}]
        result,repaired=d.validate_or_repair(raw,units,self.p['title'])
        self.assertTrue(repaired)
        self.assertEqual(len(result['sections']['design']['evidence']),d.MAX_EVIDENCE)
        self.assertTrue({e['paragraph'] for e in result['sections']['design']['evidence']}<=set(ids))

    def test_draft_from_an_earlier_day_is_recovered_and_flagged(self):
        raw=output(self.units[0]['id'])
        raw['sections']['findings']['text']+='另有999名患者。'
        data=d.empty_data()
        data['drafts']={d.identity(self.p):{'paper':self.p,'output':raw,'sourceParagraphs':self.units,'sourceHash':self.sha,'createdAt':WHEN.isoformat()}}
        ledger=d.empty_ledger()
        earlier=(WHEN.astimezone(d.SHANGHAI).date()-d.dt.timedelta(days=2)).isoformat()
        ledger['days'][earlier]=[{'identity':d.identity(self.p),'sourceHash':self.sha,'state':'invalid'}]
        self.assertEqual(d.recover_drafts(data,ledger,WHEN,lambda *_:None),1)
        row=ledger['days'][earlier][0]
        self.assertTrue(row['recoveredWithoutModel'] and row['repairedWithoutModel'])
        self.assertEqual(data['items'][0]['publishedOn'],d.day_of(WHEN))
        too_old=(WHEN.astimezone(d.SHANGHAI).date()-d.dt.timedelta(days=d.RECOVERY_DAYS+1)).isoformat()
        data2=d.empty_data()
        data2['drafts']={d.identity(self.p):{'paper':self.p,'output':raw,'sourceParagraphs':self.units,'sourceHash':self.sha,'createdAt':WHEN.isoformat()}}
        ledger2=d.empty_ledger()
        ledger2['days'][too_old]=[{'identity':d.identity(self.p),'sourceHash':self.sha,'state':'invalid'}]
        self.assertEqual(d.recover_drafts(data2,ledger2,WHEN,lambda *_:None),0)

class EvidenceUnitTests(unittest.TestCase):
    def units(self, text):
        return d.evidence_units([{'id': 'p1', 'section': 'Results', 'text': text}])

    def test_two_chunks_with_short_tail_merge_without_error(self):
        text = 'A' * 600 + ' tail end'
        units = self.units(text)
        self.assertEqual([u['text'] for u in units], [text])

    def test_three_chunks_keep_the_opening_and_merge_the_tail(self):
        text = 'A' * 350 + '. ' + 'B' * 600 + ' tail end'
        units = self.units(text)
        self.assertEqual([u['text'] for u in units], ['A' * 350 + '.', 'B' * 600 + ' tail end'])
        self.assertTrue(all(u['text'] in text for u in units))

class CheckpointTests(unittest.TestCase):
    def test_concurrent_state_update_blocks_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            transport = lambda *_: (200, {'ref':'refs/heads/state','object':{'type':'commit','sha':'b'*40}})
            writer=d.StateCheckpoint(Path(tmp),transport,'owner/repo','a'*40)
            with self.assertRaises(d.ReadingError):
                writer.save(d.empty_data(),d.empty_ledger())
            self.assertTrue(writer.blocked)
            self.assertFalse((Path(tmp)/d.DATA_PATH).exists())

    def _lagging_transport(self, stale_reads):
        state = {'head': 'a'*40, 'stale': stale_reads, 'patched': False}
        def transport(method, path, body):
            if method == 'GET' and path.endswith('/git/ref/heads/state'):
                if state['patched'] and state['stale'] > 0:
                    state['stale'] -= 1
                    return 200, {'ref':'refs/heads/state','object':{'type':'commit','sha':'a'*40}}
                return 200, {'ref':'refs/heads/state','object':{'type':'commit','sha':state['head']}}
            if method == 'GET' and '/git/commits/' in path:
                return 200, {'tree':{'sha':'t'*40}}
            if method == 'POST' and path.endswith('/git/trees'):
                return 201, {'sha':'u'*40}
            if method == 'POST' and path.endswith('/git/commits'):
                return 201, {'sha':'c'*40}
            if method == 'PATCH':
                state['head'] = body['sha']; state['patched'] = True
                return 200, {'ref':'refs/heads/state','object':{'type':'commit','sha':body['sha']}}
            return 500, {}
        return transport

    def test_lagging_read_after_update_keeps_local_head_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            waits=[]
            writer=d.StateCheckpoint(Path(tmp),self._lagging_transport(2),'owner/repo','a'*40,sleep=waits.append)
            writer.save(d.empty_data(),d.empty_ledger())
            self.assertFalse(writer.blocked)
            self.assertEqual((Path(tmp)/'.local/week-checkpoint-head').read_text().strip(),'c'*40)
            self.assertEqual(waits,[1,2])

    def test_persistently_stale_read_blocks_but_records_applied_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            writer=d.StateCheckpoint(Path(tmp),self._lagging_transport(99),'owner/repo','a'*40,sleep=lambda *_:None)
            with self.assertRaises(d.ReadingError):
                writer.save(d.empty_data(),d.empty_ledger())
            self.assertTrue(writer.blocked)
            # The ref was moved by this run; the final state save must lease on it.
            self.assertEqual((Path(tmp)/'.local/week-checkpoint-head').read_text().strip(),'c'*40)
            self.assertTrue((Path(tmp)/d.DATA_PATH).exists())

if __name__ == '__main__':
    unittest.main()
