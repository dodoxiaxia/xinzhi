"""Verify production credential and publisher boundaries of the new jobs."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class MuseWorkflowBoundaries(unittest.TestCase):
    def test_import_has_no_schedule_or_private_credentials(self):
        text = (ROOT / '.github/workflows/fulltext-import.yml').read_text()
        self.assertNotIn('schedule:', text)
        self.assertIn("- 'editorial/fulltext-imports.json'", text)
        self.assertIn("- 'scripts/fulltext_import_runner.cjs'", text)
        self.check_worker(text)

    def test_verifier_schedules_uploaded_originals_only(self):
        text = (ROOT / '.github/workflows/muse-review.yml').read_text()
        self.assertEqual(re.findall(r"cron: '([^']+)'", text), ['23 * * * *'])
        self.check_worker(text)
        runner = (ROOT / 'scripts/muse_review_runner.cjs').read_text()
        self.assertNotRegex(runner, r'https://(?:api\.github\.com|[^/]*emedien|[^/]*sciencedirect|[^/]*unpaywall)')
        self.assertNotIn('MUSE_FULLTEXT_KEY', runner)

    def check_worker(self, text):
        self.assertIn("github.ref == 'refs/heads/main'", text)
        self.assertIn('id-token: write', text)
        self.assertIn('contents: read', text)
        self.assertIn('persist-credentials: false', text)
        self.assertNotIn('secrets.', text)
        self.assertNotRegex(text, r'contents: write|wrangler|pages deploy|runQueue|lit-download')


if __name__ == '__main__':
    unittest.main()
