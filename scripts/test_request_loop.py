import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import quote

from enrich_metadata import enrich_paper
from request_loop import CLASSIFICATION, ROOT, decide_requests, doi_key


FIXTURE = json.loads((ROOT / 'scripts/fixtures/request-loop-cases.json').read_text())


class RequestLoopTest(unittest.TestCase):
    def test_decisions_and_no_mutation(self):
        papers = [case['paper'] for case in FIXTURE['cases']]
        snapshot = FIXTURE['snapshot']
        original = copy.deepcopy((papers, snapshot))
        results = decide_requests(papers, snapshot)
        self.assertEqual((papers, snapshot), original)
        self.assertEqual({result['decision'] for result in results}, {
            'awaiting_fulltext', 'already_in_library', 'identity_conflict', 'possible_duplicate', 'ready_to_ingest',
        })
        for case, result in zip(FIXTURE['cases'], results, strict=True):
            with self.subTest(doi=case['paper']['doi']):
                self.assertEqual(result['decision'], case['decision'])
                self.assertEqual(result['doi'], doi_key(case['paper']['doi']))
                self.assertEqual(result.get('matchedIds'), [case['match']] if 'match' in case else None)
                if result['decision'] == 'ready_to_ingest':
                    doi = result['doi']
                    enriched = enrich_paper({**case['paper'], 'doi': doi, 'url': 'https://doi.org/' + quote(doi, safe='/')})
                    self.assertEqual(result['classification'], {field: enriched[field] for field in CLASSIFICATION})
                    if 'tags' in case:
                        self.assertEqual(result['classification']['tags'], case['tags'])
                else:
                    self.assertNotIn('classification', result)
                if result['decision'] == 'possible_duplicate':
                    self.assertNotIn(result['doi'], result['matchedDois'])

    def test_awaiting_cannot_become_ready_or_a_duplicate(self):
        for status in ('pending', 'review', 'manual_needed', 'unknown', None):
            for baseline in [case for case in FIXTURE['cases'] if case['decision'] != 'awaiting_fulltext']:
                with self.subTest(status=status, doi=baseline['paper']['doi']):
                    result, = decide_requests([{**baseline['paper'], 'fulltextStatus': status}], FIXTURE['snapshot'])
                    self.assertEqual(result['decision'], 'awaiting_fulltext')
                    self.assertNotIn('classification', result)

    def test_same_title_other_doi_does_not_hide_a_conflict(self):
        case = next(case for case in FIXTURE['cases'] if case['decision'] == 'identity_conflict')
        paper = case['paper']
        snapshot = [*FIXTURE['snapshot'], {**paper, 'doi': '10.9999/different-doi'}]
        result, = decide_requests([paper], snapshot)
        self.assertEqual(result['decision'], 'identity_conflict')

    def test_doi_validation(self):
        for bad in ('other', '10.9999/foo bar', '10.9999/foo"bar', 'https://other.invalid/10.9999/foo',
                    'https://doi.org/10.9999/foo?bar', 'https://doi.org/10.9999/foo%FF'):
            self.assertEqual(doi_key(bad), '')
        with self.assertRaisesRegex(ValueError, '有效 DOI 和题名'):
            decide_requests([{'doi': 'not a DOI', 'title': 'Example'}], [])

    def test_cli_is_read_only_by_default_and_confines_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            git = lambda *args: subprocess.check_output(['git', *args], cwd=root, text=True).strip()
            git('init', '-q')
            (root / 'scripts').mkdir()
            for name in ('request_loop', 'enrich_metadata', 'sync_public_library', 'backfill_library_metadata',
                         'ai_column', 'scope_filter', 'pdf_identity', 'build_data', 'publication_status'):
                shutil.copyfile(ROOT / 'scripts' / f'{name}.py', root / 'scripts' / f'{name}.py')
            (root / 'editorial').mkdir()
            snapshot = root / 'editorial/public_library_snapshot.json'
            snapshot.write_text(json.dumps({'papers': FIXTURE['snapshot']}))
            records = root / 'records.json'
            records.write_text(json.dumps({'papers': [case['paper'] for case in FIXTURE['cases']]}))
            git('add', '.')
            status = git('status', '--porcelain', '--untracked-files=all')
            cli = [sys.executable, str(root / 'scripts/request_loop.py'), '--records', str(records)]
            result = subprocess.run(cli, cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual([row['decision'] for row in json.loads(result.stdout)],
                             [case['decision'] for case in FIXTURE['cases']])
            self.assertEqual(git('status', '--porcelain', '--untracked-files=all'), status)
            for path in ('outside.json', '.local/../outside.json', str(root.parent / 'request-loop-outside.json')):
                result = subprocess.run([*cli, '--out', path], cwd=root, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('必须在仓库的 .local/ 下', result.stderr)
            output = root / '.local' / 'report.md'
            subprocess.run([*cli, '--snapshot', str(snapshot), '--format', 'md', '--out', str(output)], cwd=root, check=True)
            self.assertIn('| DOI |', output.read_text())
            self.assertFalse((root / 'outside.json').exists())
            alias = output.with_name('escape.md')
            alias.symlink_to(records)
            result = subprocess.run([*cli, '--out', str(alias)], cwd=root, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('必须在仓库的 .local/ 下', result.stderr)


if __name__ == '__main__':
    unittest.main()
