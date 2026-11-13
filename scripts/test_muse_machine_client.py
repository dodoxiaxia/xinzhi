#!/usr/bin/env python3
"""machine_client.py 的单元测试：全部 mock HTTP（替换 run_curl），不连线上，不读真实令牌。"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import machine_client as mc  # noqa: E402

FAKE_TOKEN = "T" * 40
GOOD = {"doi": "10.1093/eurheartj/ehag570", "title": "Example article title", "source": "rss-2026-11-12-am", "section": "CARDIO"}


class Harness(object):
    """一个假的 run_curl：记录请求头与正文，按预设返回 (状态码, 正文)。"""

    def __init__(self, code=200, body=None):
        self.code, self.body, self.calls = code, body if body is not None else {}, []

    def __call__(self, args, header_lines, timeout):
        sent = None
        for a in args:
            if a.startswith("@"):
                sent = json.loads(open(a[1:], "rb").read().decode("utf-8"))
        self.calls.append({"args": list(args), "headers": list(header_lines), "body": sent})
        return self.code, json.dumps(self.body)


class ClientTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.token_file = os.path.join(self.tmp.name, "dsh-mini.token")
        with open(self.token_file, "w") as f:
            f.write(FAKE_TOKEN + "\n")
        os.chmod(self.token_file, 0o600)
        env = mock.patch.dict(os.environ, {"XINZHI_MACHINE_TOKEN_FILE": self.token_file})
        env.start()
        self.addCleanup(env.stop)

    def write(self, name, text):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def run_cli(self, argv, harness=None, stdin=None):
        harness = harness or Harness()
        out, err = io.StringIO(), io.StringIO()
        stdin_bytes = io.TextIOWrapper(io.BytesIO((stdin or "").encode("utf-8")), encoding="utf-8")
        with mock.patch.object(mc, "run_curl", harness), \
                mock.patch.object(sys, "stdin", stdin_bytes), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mc.main(argv)
        self.assertNotIn(FAKE_TOKEN, out.getvalue())
        self.assertNotIn(FAKE_TOKEN, err.getvalue())
        return rc, out.getvalue(), err.getvalue(), harness

    def ok_body(self, results, quota=None):
        return {"ok": True, "counts": {}, "results": results,
                "quota": quota or {"limit": 200, "used": 1, "remaining": 199, "resetsAt": "2026-11-13T00:00:00.000Z"}}


class RegisterTests(ClientTestCase):
    # --- tokenIsOwnAndNeverFallsBack ---
    def test_register_requires_token_env_and_never_uses_default_path(self):
        batch = self.write("a.json", json.dumps([GOOD]))
        for value in (None, "", "   "):
            env = dict(os.environ)
            env.pop("XINZHI_MACHINE_TOKEN_FILE", None)
            if value is not None:
                env["XINZHI_MACHINE_TOKEN_FILE"] = value
            default = os.path.join(self.tmp.name, "default.token")
            with open(default, "w") as f:
                f.write(FAKE_TOKEN + "\n")
            os.chmod(default, 0o600)
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(mc, "DEFAULT_TOKEN_PATH", default):
                rc, out, err, h = self.run_cli(["register", "--file", batch])
            self.assertEqual(rc, 5, repr(value))
            self.assertEqual(h.calls, [], repr(value))
            self.assertIn("XINZHI_MACHINE_TOKEN_FILE", err)
        # dry-run 也同样要求变量，且其他子命令仍可用默认路径
        env = dict(os.environ)
        env.pop("XINZHI_MACHINE_TOKEN_FILE", None)
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(mc, "DEFAULT_TOKEN_PATH", default):
            rc, _o, _e, h = self.run_cli(["register", "--dry-run", "--file", batch])
            self.assertEqual((rc, h.calls), (5, []))
            rc, _o, _e, h = self.run_cli(["tasks"], Harness(200, {"ok": True, "tasks": []}))
            self.assertEqual(rc, 0)
            self.assertIn("Authorization: Bearer " + FAKE_TOKEN, h.calls[0]["headers"])

    def test_register_token_missing_exits_without_request(self):
        with mock.patch.dict(os.environ, {"XINZHI_MACHINE_TOKEN_FILE": os.path.join(self.tmp.name, "absent.token")}):
            rc, out, err, h = self.run_cli(["register", "--file", self.write("a.json", json.dumps([GOOD]))])
        self.assertEqual(rc, 5)
        self.assertEqual(h.calls, [])
        self.assertIn("令牌文件不存在", err)

    def test_register_token_loose_permissions_exits_without_request(self):
        os.chmod(self.token_file, 0o644)
        rc, out, err, h = self.run_cli(["register", "--file", self.write("a.json", json.dumps([GOOD]))])
        self.assertEqual(rc, 5)
        self.assertEqual(h.calls, [])

    def test_register_sends_bearer_from_configured_token_only(self):
        h = Harness(200, self.ok_body([{"doi": GOOD["doi"], "result": "registered"}]))
        rc, out, err, h = self.run_cli(["register", "--file", self.write("a.json", json.dumps([GOOD]))], h)
        self.assertEqual(rc, 0)
        self.assertEqual(len(h.calls), 1)
        self.assertIn("Authorization: Bearer " + FAKE_TOKEN, h.calls[0]["headers"])
        self.assertTrue(any(a.endswith("/api/machine/register") for a in h.calls[0]["args"]))
        self.assertIn("POST", h.calls[0]["args"])

    # --- request body and input formats ---
    def test_register_body_is_items_only_from_json_array(self):
        h = Harness(200, self.ok_body([{"doi": GOOD["doi"], "result": "registered"}]))
        rc, _o, _e, h = self.run_cli(["register", "--file", self.write("a.json", json.dumps([GOOD]))], h)
        self.assertEqual(h.calls[0]["body"], {"items": [GOOD]})

    def test_register_reads_json_object_jsonl_csv_and_stdin(self):
        second = dict(GOOD, doi="10.1000/second", title="Second article title", section="MAIN")
        cases = {
            "o.json": json.dumps({"items": [GOOD, second]}),
            "l.jsonl": json.dumps(GOOD) + "\n\n" + json.dumps(second) + "\n",
            "c.csv": "doi,title,source,section\n%s,%s,%s,%s\n10.1000/second,\"Second article title\",rss-2026-11-12-am,MAIN\n"
                     % (GOOD["doi"], GOOD["title"], GOOD["source"], GOOD["section"]),
        }
        for name, text in cases.items():
            h = Harness(200, self.ok_body([]))
            rc, _o, _e, h = self.run_cli(["register", "--file", self.write(name, text)], h)
            self.assertEqual(rc, 0, name)
            self.assertEqual([i["doi"] for i in h.calls[0]["body"]["items"]], [GOOD["doi"], "10.1000/second"], name)
        h = Harness(200, self.ok_body([]))
        rc, _o, _e, h = self.run_cli(["register"], h, stdin=json.dumps(GOOD) + "\n")
        self.assertEqual(rc, 0)
        self.assertEqual(h.calls[0]["body"], {"items": [GOOD]})

    def test_register_normalizes_doi_and_strips_title_tags(self):
        raw = dict(GOOD, doi="https://doi.org/10.1093/EurHeartJ/EHAG570", title="<i>Example</i> article\ttitle")
        rc, _o, _e, h = self.run_cli(["register", "--file", self.write("a.json", json.dumps([raw]))], Harness(200, self.ok_body([])))
        self.assertEqual(h.calls[0]["body"]["items"][0]["doi"], GOOD["doi"])
        self.assertEqual(h.calls[0]["body"]["items"][0]["title"], "Example article title")

    # --- local validation: never sends ---
    def test_register_local_validation_rejects_bad_items_without_request(self):
        bad = [
            dict(GOOD, doi="not-a-doi"),
            dict(GOOD, title=""),
            dict(GOOD, title="ab c"),
            dict(GOOD, title="x" * 801),
            dict(GOOD, source="-bad"),
            dict(GOOD, source="a" * 65),
            dict(GOOD, section="cardio"),
            dict(GOOD, section="OTHER"),
            dict(GOOD, extra="1"),
            {k: v for k, v in GOOD.items() if k != "section"},
        ]
        for item in bad:
            rc, _o, err, h = self.run_cli(["register", "--file", self.write("a.json", json.dumps([item]))])
            self.assertEqual(rc, 5, item)
            self.assertEqual(h.calls, [], item)
        rc, _o, err, h = self.run_cli(["register", "--file", self.write("e.json", "[]")])
        self.assertEqual((rc, h.calls), (5, []))

    def test_register_more_than_50_fails_locally_without_request(self):
        items = [dict(GOOD, doi="10.1000/n%d" % i) for i in range(51)]
        rc, _o, err, h = self.run_cli(["register", "--file", self.write("a.json", json.dumps(items))])
        self.assertEqual(rc, 5)
        self.assertEqual(h.calls, [])
        self.assertIn("50", err)
        # exactly 50 goes through in a single request
        items = items[:50]
        rc, _o, _e, h = self.run_cli(["register", "--file", self.write("b.json", json.dumps(items))], Harness(200, self.ok_body([])))
        self.assertEqual(rc, 0)
        self.assertEqual(len(h.calls), 1)
        self.assertEqual(len(h.calls[0]["body"]["items"]), 50)

    def test_register_dry_run_never_sends(self):
        rc, out, _e, h = self.run_cli(["register", "--dry-run", "--file", self.write("a.json", json.dumps([GOOD]))])
        self.assertEqual((rc, h.calls), (0, []))
        self.assertEqual(json.loads(out)["items"], [GOOD])

    # --- HTTP errors stop immediately ---
    def test_register_non_2xx_stops_with_status_and_error_code(self):
        for code, err_code, expect_rc in [(401, "machine_revoked", 3), (403, "machine_forbidden", 3),
                                          (400, "machine_batch_too_large", 3), (429, "rate_limited", 3),
                                          (503, "library_storage", 4)]:
            h = Harness(code, {"ok": False, "error": err_code})
            rc, out, err, h = self.run_cli(["register", "--file", self.write("a.json", json.dumps([GOOD]))], h)
            self.assertEqual(rc, expect_rc, code)
            self.assertEqual(len(h.calls), 1, "no retry")
            self.assertIn("HTTP %d" % code, err)
            self.assertIn(err_code, err)

    # --- results and exit codes ---
    def test_register_exit_codes_for_results(self):
        reg = {"doi": "10.1000/a", "result": "registered", "state": "to-download"}
        skip = {"doi": "10.1000/b", "result": "skipped", "reason": "exists"}
        over = {"doi": "10.1000/c", "result": "over_quota"}
        rej = {"doi": None, "result": "rejected", "error": "bad_doi"}
        cases = [([reg, skip], 0), ([reg, over], mc.EXIT_OVER_QUOTA), ([reg, rej], mc.EXIT_REJECTED),
                 ([over, rej], mc.EXIT_OVER_QUOTA_AND_REJECTED)]
        self.assertEqual({mc.EXIT_OVER_QUOTA, mc.EXIT_REJECTED, mc.EXIT_OVER_QUOTA_AND_REJECTED}, {6, 7, 8})
        for results, expect in cases:
            h = Harness(200, self.ok_body(results))
            rc, out, err, h = self.run_cli(["register", "--file", self.write("a.json", json.dumps([GOOD]))], h)
            self.assertEqual(rc, expect, results)
            payload = json.loads(out)
            self.assertEqual(payload["results"], results)
            self.assertEqual(payload["quota"]["remaining"], 199)
            self.assertIn("额度", err)
            for r in results:
                self.assertIn(r["result"], err)
        self.assertIn("exists", self.run_cli(
            ["register", "--file", self.write("a.json", json.dumps([GOOD]))], Harness(200, self.ok_body([skip])))[2])
        self.assertIn("bad_doi", self.run_cli(
            ["register", "--file", self.write("a.json", json.dumps([GOOD]))], Harness(200, self.ok_body([rej])))[2])

    def test_register_2xx_without_results_is_an_error(self):
        rc, _o, _e, _h = self.run_cli(["register", "--file", self.write("a.json", json.dumps([GOOD]))], Harness(200, {"ok": True}))
        self.assertEqual(rc, 5)



class StatusDetailTests(ClientTestCase):
    """status --detail：本地校验与请求正文。复用 RegisterTests 的令牌与 run_cli。"""

    def test_status_detail_just_accepted_is_sent_with_source_blocked(self):
        h = Harness(200, {"ok": True, "task": {"doi": "10.1000/a", "state": "to-download"}})
        rc, out, err, h = self.run_cli(
            ["status", "--doi", "10.1000/a", "--reason", "source_blocked",
             "--detail", "\x07just_accepted\n"], h)
        self.assertEqual(rc, 0)
        self.assertEqual(len(h.calls), 1)
        self.assertEqual(h.calls[0]["body"]["detail"], "just_accepted")
        self.assertEqual(h.calls[0]["body"]["reason"], "source_blocked")
        self.assertNotIn(FAKE_TOKEN, out)
        self.assertNotIn(FAKE_TOKEN, err)

    def test_status_detail_rejected_locally_for_other_reason_or_value(self):
        rc, _o, err, h = self.run_cli(
            ["status", "--doi", "10.1000/a", "--reason", "not_oa", "--detail", "just_accepted"], Harness())
        self.assertEqual(rc, 5)
        self.assertEqual(h.calls, [])
        self.assertIn("source_blocked", err)
        rc, _o, err, h = self.run_cli(
            ["status", "--doi", "10.1000/a", "--reason", "source_blocked", "--detail", "sciencedirect"], Harness())
        self.assertEqual(rc, 5)
        self.assertEqual(h.calls, [])
        self.assertIn("just_accepted", err)
        rc, _o, err, h = self.run_cli(
            ["status", "--doi", "10.1000/a", "--reason", "source_blocked", "--detail", ""], Harness())
        self.assertEqual(rc, 5)
        self.assertEqual(h.calls, [])

if __name__ == "__main__":
    unittest.main()
