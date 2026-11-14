"""Mutation coverage for the deterministic release gate; no real credentials."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import check_guardrails as g

REAL_ROOT = Path(__file__).resolve().parents[1]


class GuardrailMutationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Guardrail Test')
        self.write('README.md', 'Clean tree\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Initial fixture')

    def git(self, *args):
        return g.git(self.root, *args)

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self.git('add', '--', path)

    def run_check(self, check=None, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return g.run_checks(self.root, only=check, **kwargs)

    def violation(self, check, path, text, sensitive=None, **kwargs):
        self.write(path, text)
        found = self.run_check(check, **kwargs)
        self.assertTrue(found, check)
        match = next(f for f in found if f.check == check and f.path == path)
        self.assertEqual(match.line, 2 if text.startswith('\n') else 1)
        if sensitive:
            self.assertNotIn(sensitive, str(match) + match.snippet)
        return match

    def test_clean_tree(self):
        self.assertEqual(self.run_check(), [])

    def test_banned_words_case_boundaries_and_safe_output(self):
        for i, word in enumerate(g.BANNED_WORDS, 1):
            f = self.violation('banned-words', 'README.md', '\n' + word.upper(), word)
            self.assertEqual(f.line, 2)
            self.assertIn('#' + str(i), f.rule)
        word = g.BANNED_WORDS[0]
        self.write('README.md', 'send' + word.title() + ' ' + 'A' + word + '9')
        self.assertEqual(self.run_check('banned-words'), [])
        self.write('extra.md', g.BANNED_WORDS[1])
        self.git('rm', '--cached', 'extra.md')
        self.assertTrue(self.run_check('banned-words', extra_files=('extra.md',)))

    def test_commit_messages(self):
        self.git('commit', '--allow-empty', '-qm', g.BANNED_WORDS[0])
        found = self.run_check('banned-words', commit_range='HEAD~1..HEAD')
        self.assertEqual(found[0].path, '<commit-messages>')
        self.assertNotIn(g.BANNED_WORDS[0], str(found[0]))

    def test_secret_families_and_redaction(self):
        opaque = 'Ab9zQ2mWx7Rk0NfY5uTc' + '8LdE3sVh6JpG1aBo4ZiK'
        samples = [
            '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
            'AK' + 'IA' + 'A1B2C3D4E5F6G7H8',
            'AS' + 'IA' + 'A1B2C3D4E5F6G7H8',
            'gh' + 'p_' + opaque,
            'github_' + 'pat_' + opaque,
            'AI' + 'za' + opaque,
            'xo' + 'xb-' + opaque,
            's' + 'k-' + opaque,
            's' + 'k-ant-' + opaque,
            's' + 'k_live_' + opaque,
            'r' + 'k_live_' + opaque,
            'ey' + 'Jabc123.ey' + 'Jabc456.signature123',
            'Authorization: ' + 'Bear' + 'er ' + opaque,
            'CLOUDFLARE_API_TOKEN = "' + opaque[:40] + '"',
            'api_key = "' + opaque + '"',
            opaque,
        ]
        for sample in samples:
            with self.subTest(family=samples.index(sample)):
                self.violation('secrets', 'sample.txt', '\n' + sample, sample)
        self.write('sample.txt', 'token = "synthetic-credential-for-testing"\n' + 'a' * 50 + '\n' + 'a1' * 32)
        self.assertEqual(self.run_check('secrets'), [])

    def test_hex32(self):
        value = 'a1b2c3d4' * 4
        self.violation('hex32', 'README.md', '\n' + value, value)
        self.write('README.md', value * 2)
        self.assertEqual(self.run_check('hex32'), [])

    def test_sources_fresh(self):
        self.write('src/app/00-main.js', 'const n = 1;\n')
        self.violation('sources-fresh', 'app.js', 'stale\n')
        self.write('app.js', 'const n = 1;\n')
        self.assertEqual(self.run_check('sources-fresh'), [])
        self.write('src/app/journal-tiers.js', 'tiers\n')
        self.assertEqual(self.run_check('sources-fresh')[0].path, 'journal-tiers.js')

    def test_forbidden_files_and_diff_baseline(self):
        self.violation('forbidden-files', 'evidence.pdf', 'binary fixture')
        self.git('rm', '-f', 'evidence.pdf')
        self.write('docs/screenshots/new.png', 'image fixture')
        self.assertEqual(self.run_check('forbidden-files'), [])
        self.git('commit', '-qm', 'Add image fixture')
        self.assertEqual(self.run_check('forbidden-files', base='HEAD~1')[0].path, 'docs/screenshots/new.png')
        self.git('rm', 'docs/screenshots/new.png')
        self.git('commit', '-qm', 'Remove image fixture')
        (self.root / 'untracked.pdf').write_text('fixture')
        self.assertTrue(self.run_check('forbidden-files', base='HEAD'))

    def test_workflows_untouched(self):
        self.write('.github/workflows/sample.yml', 'name: sample\n')
        self.git('commit', '-qm', 'Workflow fixture')
        found = self.run_check('workflows-untouched', base='HEAD~1')
        self.assertEqual(found[0].path, '.github/workflows/sample.yml')
        self.assertEqual(self.run_check('workflows-untouched', base='HEAD~1', config={'allow_workflows': True}), [])

    def test_ui_labels_and_scope(self):
        for label in g.UI_LABELS:
            self.violation('ui-banned-labels', 'index.html', '\n' + label)
        self.write('index.html', 'clean')
        self.write('feed.xml', g.UI_LABELS[0])
        self.assertEqual(self.run_check('ui-banned-labels'), [])

    def test_feature_map_selectors(self):
        self.write('docs/feature-map.json', json.dumps({'nested': [{'selector': '#missing .card[data-action="go"]'}]}))
        found = self.run_check('feature-map-selectors')
        self.assertEqual(found[0].path, 'docs/feature-map.json')
        self.write('index.html', '<div id="missing" class="card" data-action="go"></div>')
        self.assertEqual(self.run_check('feature-map-selectors'), [])

    def test_public_ids_static_injections(self):
        self.violation('public-ids', 'edge/src/00-test.js', 'const NEW_DATA = {};\n')
        self.write('edge/src/00-test.js', 'const PDF_LIBRARY = {};\n')
        self.assertEqual(self.run_check('public-ids'), [])
        self.violation('public-ids', 'scripts/build_public.py', "worker=worker.replace('anything', payload)\n")

    def test_public_ids_real_directory_and_large_literals(self):
        directory = self.root / 'public'
        directory.mkdir()
        (directory / 'private.pdf').write_text('fixture')
        self.assertEqual(self.run_check('public-ids')[0].path, 'public/private.pdf')
        (directory / 'private.pdf').unlink()
        quality = g.load_module('public_library_quality')
        for identifier in set(quality.DOI_REVIEW) | set(quality.PDF_BINDING_HOLDS) | {'hidden-fixture'}:
            self.write('config/public_library_topic_hides.json', json.dumps({'records': [{'id': 'hidden-fixture'}]}))
            (directory / '_worker.js').write_text('const X = ' + json.dumps([identifier]) + ';')
            found = self.run_check('public-ids')
            self.assertEqual(found[0].path, 'public/_worker.js')
            self.assertNotIn(identifier, str(found[0]) + found[0].snippet)
        (directory / '_worker.js').write_text('const X = ' + json.dumps(['a' * (201 * 1024)]) + ';')
        self.assertTrue(self.run_check('public-ids'))
        (directory / '_worker.js').write_text('const PDF_LIBRARY = ' + json.dumps(['a' * (201 * 1024)]) + ';')
        shards = directory / 'shards'
        shards.mkdir()
        (shards / ('readings-2026-11.' + 'a' * 12 + '.js')).write_text('fixture')
        self.assertEqual(self.run_check('public-ids'), [])

    def test_allowlist_reason_staleness_and_inline(self):
        value = 'a1b2c3d4' * 4
        self.write('README.md', value)
        entry = dict(check='hex32', path='README.md', reason='fixture identifier', line_regex='a1b2')
        self.assertEqual(self.run_check('hex32', config={'allow': [entry]}), [])
        entry['reason'] = ''
        self.assertEqual(len(self.run_check('hex32', config={'allow': [entry]})), 2)
        entry['reason'] = 'fixture identifier'
        self.write('README.md', 'clean')
        self.assertTrue(self.run_check('hex32', config={'allow': [entry]}))
        self.write('README.md', '# guardrails:allow hex32 fixture identifier\n' + value)
        self.assertEqual(self.run_check('hex32'), [])
        self.write('README.md', '# guardrails:allow hex32\n' + value)
        self.assertTrue(self.run_check('hex32'))

    def test_non_git_checkout(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(g.run_checks(directory), [])
            self.assertIn('SKIP', out.getvalue())

    def test_output_shows_only_four_characters_of_a_match(self):
        value = 'a1b2c3d4' * 4
        self.write('README.md', value)
        text = str(self.run_check('hex32')[0])
        self.assertIn('README.md:1:', text)
        self.assertIn('starts with a1b2', text)
        self.assertNotIn(value[:8], text)

    def test_selector_for_script_built_data_attribute(self):
        self.write('docs/feature-map.json', json.dumps({'entries': [{'selector': '[data-some-thing]'}]}))
        self.assertTrue(self.run_check('feature-map-selectors'))
        self.write('src/app/00-x.js', 'el.dataset.someThing = "1";')
        self.assertEqual(self.run_check('feature-map-selectors'), [])

    def test_untracked_files_are_scanned_only_when_asked(self):
        (self.root / 'new.md').write_text('a1b2c3d4' * 4)
        self.assertEqual(self.run_check('hex32'), [])
        self.assertEqual(self.run_check('hex32', include_untracked=True)[0].path, 'new.md')

    def test_state_counts_catches_hardcoded_inventory_and_allows_derived_or_fixture_data(self):
        # The anti-pattern that stalled daily-refresh: a live state inventory
        # count compared with a hard-coded integer.
        bad = (
            "from pathlib import Path\nimport json\n"
            "ROOT = Path(__file__).resolve().parents[1]\n"
            "def test_scope():\n"
            "    library = json.loads((ROOT / 'data/library.json').read_text())\n"
            "    chosen = [row for row in library['feeds'] if row['enabled']]\n"
            "    assert len(chosen) == 82\n"
            "    self.assertEqual(len(library['feeds']), 79)\n"
            "    self.assertEqual(health['enabledFeeds'], 79)\n"
            "    self.assertEqual(output['summary'], {'empty_feed': 82})\n"
        )
        self.write('scripts/test_bad_counts.py', bad)
        found = [item for item in self.run_check('state-counts') if item.path == 'scripts/test_bad_counts.py']
        self.assertGreaterEqual(len(found), 3, found)
        self.assertTrue(all(item.check == 'state-counts' for item in found))
        self.assertTrue({7, 8, 9, 10} <= {item.line for item in found}, found)
        # Deriving the expected count from the same loaded data is the fix.
        derived = (
            "from pathlib import Path\nimport json\n"
            "ROOT = Path(__file__).resolve().parents[1]\n"
            "def test_scope():\n"
            "    library = json.loads((ROOT / 'data/library.json').read_text())\n"
            "    expected = sum(1 for row in library['feeds'] if row['enabled'])\n"
            "    chosen = [row for row in library['feeds'] if row['enabled']]\n"
            "    self.assertGreater(expected, 1)\n"
            "    self.assertEqual(len(chosen), expected)\n"
            "    self.assertEqual(len(output['sources']), expected)\n"
            "    self.assertEqual(output['summary'], {'empty_feed': expected})\n"
        )
        self.write('scripts/test_bad_counts.py', derived)
        self.assertEqual(self.run_check('state-counts'), [])
        # Fixture data written under a temporary directory is allowed,
        # as are the small constants 0, 1 and 2 against live state.
        fixture = (
            "from pathlib import Path\nimport json, tempfile\n"
            "ROOT = Path(__file__).resolve().parents[1]\n"
            "def test_scope():\n"
            "    with tempfile.TemporaryDirectory() as directory:\n"
            "        root = Path(directory)\n"
            "        (root / 'data').mkdir()\n"
            "        (root / 'data/library.json').write_text(json.dumps({'feeds': [1, 2, 3, 4, 5]}))\n"
            "        library = json.loads((root / 'data/library.json').read_text())\n"
            "        self.assertEqual(len(library['feeds']), 5)\n"
            "    live = json.loads((ROOT / 'data/library.json').read_text())\n"
            "    self.assertEqual(sum(1 for row in live['feeds'] if row['name'] == 'OpenAI News'), 1)\n"
        )
        self.write('scripts/test_bad_counts.py', fixture)
        self.assertEqual(self.run_check('state-counts'), [])
        # An inline exemption must sit on the same line or the previous line
        # and must include a reason.
        allowed = bad.replace(
            'assert len(chosen) == 82',
            'assert len(chosen) == 82  # guardrails:allow state-counts frozen demo count',
        ).replace(
            "self.assertEqual(len(library['feeds']), 79)",
            "self.assertEqual(len(library['feeds']), 79)  # guardrails:allow state-counts frozen demo count",
        ).replace(
            "self.assertEqual(health['enabledFeeds'], 79)",
            "self.assertEqual(health['enabledFeeds'], 79)  # guardrails:allow state-counts frozen demo count",
        ).replace(
            "self.assertEqual(output['summary'], {'empty_feed': 82})",
            "self.assertEqual(output['summary'], {'empty_feed': 82})  # guardrails:allow state-counts frozen demo count",
        )
        self.write('scripts/test_bad_counts.py', allowed)
        self.assertEqual(self.run_check('state-counts'), [])
        self.write('scripts/test_bad_counts.py', bad.replace('== 82', '== 82  # guardrails:allow state-counts'))
        self.assertTrue(self.run_check('state-counts'))


class GuardrailsOnThisCheckoutTests(unittest.TestCase):
    def test_checkout_passes(self):
        self.assertEqual(g.run_checks(REAL_ROOT, extra_files=('scripts/check_guardrails.py', 'scripts/test_guardrails.py', 'config/guardrails.json', 'docs/guardrails.md')), [])

    def test_own_sources_never_spell_prohibited_vocabulary(self):
        for filename in ('check_guardrails.py', 'test_guardrails.py'):
            content = (REAL_ROOT / 'scripts' / filename).read_text().lower()
            for word in g.BANNED_WORDS:
                self.assertNotIn(word.lower(), content)


if __name__ == '__main__':
    unittest.main()
