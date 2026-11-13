"""Verify actual release workflow boundaries without external actions."""
import ast
import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def queue_enabled(ref, value=None):
    workflow = (ROOT / '.github/workflows/fulltext.yml').read_text()
    condition = re.search(r'^    if: (.+)$', workflow, re.MULTILINE).group(1)
    expression = ast.parse(condition.replace('&&', ' and '), mode='eval').body

    def evaluate(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return {'github': {'ref': ref}, 'vars': {'FULLTEXT_ASYNC_ENABLED': value}}[node.id]
        if isinstance(node, ast.Attribute):
            return evaluate(node.value).get(node.attr)
        if isinstance(node, ast.BoolOp) and isinstance(node.op, ast.And):
            return all(evaluate(x) for x in node.values)
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.Eq):
            left, right = evaluate(node.left), evaluate(node.comparators[0])
            # GitHub Actions compares strings without case sensitivity.
            if isinstance(left, str) and isinstance(right, str):
                left, right = left.casefold(), right.casefold()
            return left == right
        raise AssertionError('unexpected queue activation expression')
    return evaluate(expression)


class ReleaseDecouplingTests(unittest.TestCase):
    def test_queue_job_is_explicitly_activated_only_on_main(self):
        for value in (None, '', 'false', '0', True, 1):
            with self.subTest(value=value):
                self.assertFalse(queue_enabled('refs/heads/main', value))
        self.assertTrue(queue_enabled('refs/heads/main', 'true'))
        self.assertTrue(queue_enabled('refs/heads/main', 'TRUE'))
        self.assertFalse(queue_enabled('refs/heads/feature', 'true'))

    def test_site_release_only_deploys_pages(self):
        workflow = (ROOT / '.github/workflows/daily.yml').read_text()
        deploys = re.findall(r'^\s*run: (npx[^\n]+deploy[^\n]+)$', workflow, re.MULTILINE)
        self.assertEqual(deploys, ['npx --yes wrangler@3 pages deploy public --project-name dryz-xinzhi --branch main --commit-dirty=true'])
        self.assertNotRegex(workflow, r'npx[^\n]*deploy --config')
        self.assertNotIn('check_fulltext_dispatcher.py /tmp/', workflow)
        self.assertIn("if: steps.refresh.outcome == 'success' && steps.deploy.outcome == 'success'", workflow)
        self.assertIn('from package_release import public_payloads; public_payloads()', workflow)
        self.assertIn('node scripts/test_fulltext_activation.cjs', workflow)
        self.assertIn("-p 'test_release_decoupling.py'", workflow)

    def test_existing_schedules_and_dispatcher_source_are_preserved(self):
        workflow = (ROOT / '.github/workflows/daily.yml').read_text()
        self.assertEqual(re.findall(r"cron: '([^']+)'", workflow), ['47 20 * * *', '37 */4 * * *'])  # fast fallback every 4h (owner, 2026-10-11)
        source = (ROOT / 'workers/cron-dispatch/index.js').read_text()
        config = (ROOT / 'workers/cron-dispatch/wrangler.toml').read_text()
        self.assertIn("const WORKFLOW = 'daily.yml';", source)
        self.assertIn("{ ref:'main', inputs:{ mode:'fast' } }", source)
        self.assertNotIn('fulltext.yml', source)
        self.assertNotIn('fulltext-pending', source)
        self.assertNotIn("source:'external'", source)
        self.assertIn('crons = ["7 */2 * * *"]', config)
        self.assertNotIn('*/5', config)
        for name, digest in (
            ('workers/cron-dispatch/index.js', '9af7ae38f31f353b7a3ae00c90b79d490003bca948743d853dd82562c92cfc3f'),
            ('workers/cron-dispatch/wrangler.toml', '05d65286ca71bd8a7dadbeaafee5e75983d335b538063792c74fe98bf44085a9'),
        ):
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)


if __name__ == '__main__':
    unittest.main()
