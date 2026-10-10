"""Offline full-text identity, evidence, restart, public projection and payment reservation contracts."""
import copy
import datetime as dt
import json
import tempfile
import unittest
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

class GenerationTests(unittest.TestCase):
    def generate(self, data=None, ledger=None, model=None, save=None):
        data, ledger = data or d.empty_data(), ledger or d.empty_ledger()
        papers = [paper(i, 'AI 医疗' if i % 2 == 0 else '心血管') for i in range(1,9)]
        bypmc = {p['pmcid']:p for p in papers}
        fetch = lambda url: xml(bypmc[url.split('/')[-2]])
        result = d.generate(data, ledger, papers, WHEN, save or (lambda *_:None), {}, fetch=fetch, model=model or (lambda *args: output(args[-1][0]['id'])))
        return data, ledger, result

    def test_new_day_publishes_four_distinct_articles_and_same_day_is_cached(self):
        calls = []
        model = lambda *args: (calls.append(True) or output(args[-1][0]['id']))
        data, ledger, status = self.generate(model=model)
        self.assertEqual(status['completed'], 4)
        self.assertEqual(len(calls), 4)
        self.assertEqual(len({d.identity(p) for p in data['items']}), 4)
        self.generate(data=data, ledger=ledger, model=model)
        self.assertEqual(len(calls), 4)
        self.assertEqual(len(data['items']), 4)

    def test_reservation_is_saved_before_each_model_request(self):
        observed = []
        def save(data, ledger): observed.append(copy.deepcopy(ledger))
        def model(*_):
            self.assertEqual(observed[-1]['days']['2026-10-09'][-1]['state'], 'started')
            return output(_[-1][0]['id'])
        data, ledger, status = self.generate(model=model, save=save)
        self.assertEqual(status['completed'], 4)
        self.assertTrue(all(r['state']=='validated' for r in ledger['days']['2026-10-09']))

    def test_failed_checkpoint_never_dispatches_model(self):
        calls = []
        def failed(*_): raise d.ReadingError('checkpoint_write_failed')
        with self.assertRaises(d.ReadingError):
            self.generate(model=lambda *_:calls.append(True), save=failed)
        self.assertEqual(calls, [])

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

    def test_invalid_outputs_are_skipped_with_eight_attempt_cap(self):
        calls = []
        def bad(*_):
            calls.append(True)
            result=output(_[-1][0]['id'])
            # The only sentence carries the unsupported number, so removal-only repair cannot help.
            result['sections']['findings']['text'] = '不支持的研究结果共纳入9999名患者，这一数字没有原文证据。'
            return result
        data, ledger, status = self.generate(model=bad)
        self.assertEqual(len(calls), 8)
        self.assertEqual(status['completed'], 0)
        self.assertEqual(status['attempts'], 8)

    def test_sources_invalid_on_earlier_days_are_not_paid_for_again(self):
        ledger = d.empty_ledger()
        ledger['days']['2026-10-08'] = [{'identity':'10.1234/fixture1','state':'invalid'},
                                        {'identity':'10.1234/fixture2','state':'validated'}]
        tried = []
        model = lambda *args: (tried.append(args[1]['doi']) or output(args[-1][0]['id']))
        data, ledger, status = self.generate(ledger=ledger, model=model)
        self.assertNotIn('10.1234/fixture1', tried)
        self.assertEqual(status['completed'], 4)

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
