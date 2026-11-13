import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import d1_backfill_client as client  # noqa: E402

TOKEN = "synthetic_fallback_token_0123456789abc"


class FakeSite:
    """站点接口的离线替身：每个前缀每侧两页，回填后差异归零。"""

    def __init__(self, enabled=True, fail=None):
        self.enabled = enabled
        self.fail = fail
        self.calls = []
        self.filled = False

    def __call__(self, token, body):
        assert token == TOKEN
        self.calls.append(dict(body))
        if self.fail:
            return self.fail
        if body.get("apply") and not self.enabled:
            return 403, {"ok": False, "error": "machine_d1_backfill_disabled"}
        first = not body.get("cursor")
        if body.get("apply") and first and body["side"] == "kv":
            self.filled = True
        missing = 0 if self.filled or body["side"] != "kv" or not first else 2
        counts = {"same": 3, "missing_in_d1": missing}
        data = {"ok": True, "prefix": body["prefix"], "side": body["side"], "scanned": 5, "counts": counts, "diff": missing,
                "written": missing if body.get("apply") else 0, "samples": {"missing_in_d1": [body["prefix"] + "k1"]} if missing else {},
                "done": not first}
        if first:
            data["cursor"] = "next"
        return 200, data


def run(argv, post, loader=lambda: TOKEN):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = client.main(argv, post=post, token_loader=loader)
    return code, out.getvalue(), err.getvalue()


class D1BackfillClientTest(unittest.TestCase):
    def test_verify_pages_every_prefix_and_both_sides_and_reports_differences(self):
        site = FakeSite()
        code, out, _err = run(["verify", "--prefix", "library:muse-job:"], site)
        self.assertEqual(code, 1)
        self.assertEqual(len(site.calls), 4, "两侧各两页")
        self.assertEqual({c["side"] for c in site.calls}, {"kv", "d1"})
        self.assertTrue(all("apply" not in c for c in site.calls), "verify 绝不带 apply")
        self.assertIn("差异合计：2", out)
        self.assertIn("per_key_d1_only", out)
        self.assertNotIn(TOKEN, out)

    def test_all_mirrored_prefixes_by_default(self):
        site = FakeSite()
        run(["verify"], site)
        self.assertEqual({c["prefix"] for c in site.calls}, set(client.mirrored_prefixes()))

    def test_apply_writes_then_reverifies_to_zero(self):
        site = FakeSite()
        code, out, err = run(["apply", "--prefix", "library:muse-job:", "--limit", "100"], site)
        self.assertEqual(code, 0, out)
        applies = [c for c in site.calls if c.get("apply")]
        verifies = [c for c in site.calls if not c.get("apply")]
        self.assertEqual(len(applies), 4)
        self.assertEqual(len(verifies), 4)
        self.assertTrue(all(c["limit"] == 100 for c in site.calls))
        self.assertIn("回填结果", out)
        self.assertIn("回填后复核", out)
        self.assertIn("差异合计：0（两边一致）", out)
        self.assertNotIn(TOKEN, out + err)

    def test_apply_is_refused_when_the_site_switch_is_off(self):
        site = FakeSite(enabled=False)
        code, out, err = run(["apply", "--prefix", "library:muse-job:"], site)
        self.assertEqual(code, 3)
        self.assertIn("machine_d1_backfill_disabled", err)
        self.assertEqual(out, "")

    def test_server_error_stops_with_a_fixed_message(self):
        site = FakeSite(fail=(503, {"ok": False, "error": "machine_d1_read"}))
        code, _out, err = run(["verify", "--prefix", "library:muse-job:"], site)
        self.assertEqual(code, 4)
        self.assertIn("machine_d1_read", err)

    def test_rejects_unknown_prefix_and_bad_limit_without_a_request(self):
        site = FakeSite()
        self.assertEqual(run(["verify", "--prefix", "library:pdf:"], site)[0], 5)
        self.assertEqual(run(["verify", "--limit", "0"], site)[0], 5)
        self.assertEqual(run(["verify", "--limit", "101"], site)[0], 5)
        self.assertEqual(site.calls, [])

    def test_json_output_has_no_values_or_token(self):
        site = FakeSite()
        code, out, _err = run(["verify", "--prefix", "library:muse-job:", "--json"], site)
        self.assertEqual(code, 1)
        payload = json.loads(out)
        self.assertEqual(payload["verify"]["diff"], 2)
        self.assertNotIn(TOKEN, out)


if __name__ == "__main__":
    unittest.main()
