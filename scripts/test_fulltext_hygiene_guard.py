#!/usr/bin/env python3
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import daily_fulltext as d
from test_daily_fulltext import WHEN, item, output, paper, xml


class FulltextHygieneGuardTests(unittest.TestCase):
    def setUp(self):
        self.paper = paper()
        paragraphs, self.source_hash = d.parse_fulltext(xml(self.paper), self.paper)
        self.units = d.evidence_units(paragraphs)
        self.draft = output(self.units[0]['id'])

    def validate(self):
        return d.validate_or_repair(self.draft, self.units, self.paper['title'])

    def test_rejects_raw_artifacts_in_findings(self):
        findings = self.draft['sections']['findings']
        clean = findings['text']
        result, repaired = self.validate()
        self.assertEqual(result['sections']['findings']['text'], clean)
        self.assertFalse(repaired)
        for artifact in ('�', '\x00', '\x85', '\r', r'\u2014', r'\x41',
                         r'\342\200\224', '&amp;lt;', 'FranÃ§ais'):
            with self.subTest(artifact=artifact):
                findings['text'] = clean + ' ' + artifact
                with self.assertRaisesRegex(d.ReadingError, 'unrecoverable_text_artifact'):
                    self.validate()

    def test_preserves_body_whitespace_and_valid_clinical_text(self):
        quote = 'The DAPA-HF trial NCT03701234 evaluated 037 patients across groups.'
        self.units[0]['text'] = quote
        findings = self.draft['sections']['findings']
        for block in self.draft['sections'].values():
            block['evidence'] = [{'paragraph': self.units[0]['id']}]
            block['text'] = '供离线验证引用的研究描述，纳入样本量由所选原文支持。'
        findings['text'] = 'DAPA-HF（NCT03701234）的样本量为 037。\n\t比较 α、β 与 ≥ ≤ ±；原样保留。'
        result, repaired = self.validate()
        self.assertEqual(result['sections']['findings']['text'], findings['text'])
        self.assertEqual(result['sections']['findings']['evidence'][0]['quote'], quote)
        self.assertFalse(repaired)

    def test_surrounding_title_newlines_are_trimmed_and_embedded_ones_rejected(self):
        title = self.draft.pop('titleZh')
        self.draft['title_zh'] = '\n ' + title + ' \n'
        self.assertEqual(self.validate()[0]['titleZh'], title)
        self.draft['title_zh'] = title[:3] + '\n' + title[3:]
        with self.assertRaisesRegex(d.ReadingError, 'unrecoverable_text_artifact'):
            self.validate()

    def test_rejects_explicit_and_source_bound_dirty_quotes(self):
        evidence = self.draft['sections']['findings']['evidence'][0]
        evidence_id = evidence['paragraph']
        self.validate()
        self.units[0]['text'] += ' �'
        for dirty in ({'paragraph': evidence_id, 'quote': self.units[0]['text']},
                      {'paragraph': evidence_id}):
            with self.subTest(explicit='quote' in dirty):
                evidence.clear()
                evidence.update(dirty)
                with self.assertRaisesRegex(d.ReadingError, 'unrecoverable_text_artifact'):
                    self.validate()

    def test_recovery_keeps_dirty_draft_and_recovers_clean_one_without_model(self):
        data, ledger = d.empty_data(), d.empty_ledger()
        data['drafts'] = {}
        rows = ledger['days'].setdefault(d.day_of(WHEN), [])
        for candidate in (self.paper, paper(2)):
            paragraphs, source_hash = d.parse_fulltext(xml(candidate), candidate)
            units = d.evidence_units(paragraphs)
            draft = output(units[0]['id'])
            if candidate == self.paper:
                draft['sections']['findings']['text'] += ' �'
            key = d.identity(candidate)
            data['drafts'][key] = {'paper': candidate, 'output': draft, 'sourceParagraphs': units,
                                   'sourceHash': source_hash, 'createdAt': WHEN.isoformat()}
            rows.append({'identity': key, 'sourceHash': source_hash, 'state': 'invalid'})

        dirty_key = d.identity(self.paper)
        original = copy.deepcopy(data['drafts'][dirty_key])
        save = Mock()
        with patch.object(d, 'call_model') as model:
            self.assertEqual(d.recover_drafts(data, ledger, WHEN, save), 1)
        model.assert_not_called()
        save.assert_called_once()
        self.assertEqual(data['drafts'], {dirty_key: original})
        self.assertEqual([entry['pmcid'] for entry in data['items']], [paper(2)['pmcid']])
        self.assertEqual([row['state'] for row in rows], ['invalid', 'validated'])
        self.assertTrue(rows[1]['recoveredWithoutModel'])

    def test_same_model_calls_at_budget_with_guard_enabled_or_disabled(self):
        candidates = [paper(n) for n in range(1, 6)]
        by_pmcid = {candidate['pmcid']: candidate for candidate in candidates}

        def run():
            data, ledger = d.empty_data(), d.empty_ledger()
            writes = []

            def save(data, ledger):
                writes.append((copy.deepcopy(data), copy.deepcopy(ledger)))

            def respond(cfg, candidate, units):
                # Each request already has a durable reservation.
                self.assertEqual(writes[-1][1]['days'][d.day_of(WHEN)][-1]['state'], 'started')
                draft = output(units[0]['id'])
                if model.call_count == 1:
                    draft['sections']['findings']['text'] += ' �'
                elif model.call_count < 4:
                    draft['titleZh'] = '短题'  # Ordinary, recoverable validation failure.
                return draft

            model = Mock(side_effect=respond)
            fetch = Mock(side_effect=lambda url: xml(by_pmcid[url.split('/')[-2]]))
            with patch.multiple(d, TARGET=2, MAX_CALLS=4):
                status = d.generate(data, ledger, candidates, WHEN, save, {}, fetch=fetch, model=model)
                next_status = d.generate(data, ledger, candidates, WHEN, save, {}, fetch=fetch, model=model)
            self.assertEqual(model.call_count, 4)
            self.assertEqual(fetch.call_count, 4)
            self.assertEqual(status['attempts'], 4)
            self.assertEqual(status['sourceRequests'], 4)
            self.assertEqual(next_status['attempts'], 4)
            return model.call_args_list, writes, ledger['days'][d.day_of(WHEN)], status

        with patch.object(d, 'validate_draft_text', side_effect=lambda draft: draft):
            before_calls, before_writes, before_rows, before_status = run()
        after_calls, after_writes, after_rows, after_status = run()
        self.assertEqual(after_calls, before_calls)
        self.assertEqual([row['state'] for row in before_rows], ['validated', 'invalid', 'invalid', 'validated'])
        self.assertEqual([row['state'] for row in after_rows], ['invalid', 'invalid', 'invalid', 'validated'])
        self.assertEqual(after_rows[0]['errorCode'], 'unrecoverable_text_artifact')
        self.assertEqual(after_rows[1]['errorCode'], 'invalid_title_translation')
        self.assertEqual(after_status['errorCodes'], ['invalid_title_translation', 'unrecoverable_text_artifact'])
        self.assertEqual((before_status['completed'], after_status['completed']), (2, 1))
        dirty_key = after_rows[0]['identity']
        self.assertTrue(any(dirty_key in data.get('drafts', {}) for data, _ in before_writes))
        self.assertTrue(all(dirty_key not in data.get('drafts', {}) for data, _ in after_writes))
        self.assertTrue(any(after_rows[1]['identity'] in data.get('drafts', {}) for data, _ in after_writes))
        self.assertTrue(any(after_rows[-1]['identity'] in data.get('drafts', {}) for data, _ in after_writes))

    def test_read_only_audit_reports_fields_without_blocking_historical_projection(self):
        clean, bad = item(), item(2)
        bad['sections']['findings']['text'] += ' �'
        draft = output()
        draft['titleZh'] += r'\u2014'
        store = {**d.empty_data(), 'items': [clean, bad],
                 'drafts': {'draft-id': {'paper': paper(3), 'output': draft}}}
        original_store = copy.deepcopy(store)
        historical = d.public_readings(store)['items']
        self.assertEqual(len(historical), 2)
        self.assertTrue(any('�' in row['sections']['findings']['text'] for row in historical))
        self.assertEqual(store, original_store)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / Path(d.DATA_PATH).name
            script = Path(__file__).with_name('audit_text_hygiene.py')
            command = [sys.executable, str(script), '--check-readings', '--data-dir', tmp]
            original = json.dumps(store, ensure_ascii=False).encode('utf-8')
            path.write_bytes(original)
            audited = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(audited.returncode, 1, audited.stderr)
            self.assertEqual(json.loads(audited.stdout), {
                'readings_scanned': 2, 'drafts_scanned': 1, 'findings': [
                    {'record_type': 'reading', 'id': bad['pmcid'], 'field': 'sections.findings.text',
                     'artifacts': {'replacement': 1}},
                    {'record_type': 'draft', 'id': paper(3)['pmcid'], 'field': 'titleZh',
                     'artifacts': {'unicode_escape': 1}},
                ],
            })
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(Path(tmp).iterdir()), [path])

            clean_store = json.dumps({**d.empty_data(), 'items': [clean]}).encode('utf-8')
            path.write_bytes(clean_store)
            audited = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(audited.returncode, 0, audited.stderr)
            self.assertEqual(json.loads(audited.stdout), {
                'readings_scanned': 1, 'drafts_scanned': 0, 'findings': [],
            })
            self.assertEqual(path.read_bytes(), clean_store)


if __name__ == '__main__':
    unittest.main()
