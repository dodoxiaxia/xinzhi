import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import d1_backfill_client as client  # noqa: E402

TOKEN = "synthetic_fallback_token_0123456789abc"
HASH_A = hashlib.sha256(b"synthetic-a").hexdigest()
HASH_B = hashlib.sha256(b"synthetic-b").hexdigest()


class FakeSite:
    """站点接口的离线替身：prefix verify 每侧两页，manifest 支持 verify/apply。

    global_diffs 为 None 时保持原有两页样例（供 verify --prefix 测试）。
    设为 {类别: [键名, ...]} 时，只在第一次 kv 侧请求里如实回报这些差异，其余页差异为 0，且单页完成。
    """

    def __init__(self, enabled=True, fail=None, manifest_mismatch=False, global_diffs=None, truncate_samples=False):
        self.enabled = enabled
        self.fail = fail
        self.manifest_mismatch = manifest_mismatch
        self.global_diffs = global_diffs
        self.truncate_samples = truncate_samples
        self.calls = []
        self.filled = False
        self._reported_global = False

    def _prefix_reply(self, body):
        if self.global_diffs is None:
            first = not body.get("cursor")
            missing = 0 if body["side"] != "kv" or not first else 2
            counts = {"same": 3, "missing_in_d1": missing}
            data = {
                "ok": True,
                "prefix": body["prefix"],
                "side": body["side"],
                "scanned": 5,
                "counts": counts,
                "diff": missing,
                "written": 0,
                "samples": {"missing_in_d1": [body["prefix"] + "k1"]} if missing else {},
                "done": not first,
            }
            if first:
                data["cursor"] = "next"
            return 200, data
        samples = {}
        counts = {name: 0 for name in client.DIFF_CATEGORIES}
        report = (
            not self._reported_global
            and body.get("side") == "kv"
            and not body.get("cursor")
        )
        if report:
            self._reported_global = True
            for name, keys in self.global_diffs.items():
                counts[name] = len(keys)
                if self.truncate_samples and keys:
                    samples[name] = keys[:1]
                    counts[name] = len(keys)  # 计数大于样本，模拟接口每类最多 10 条的截断
                else:
                    samples[name] = list(keys)
        diff = sum(counts.values())
        return 200, {
            "ok": True,
            "prefix": body["prefix"],
            "side": body["side"],
            "scanned": 5,
            "counts": counts,
            "diff": diff,
            "written": 0,
            "samples": samples,
            "done": True,
        }

    def __call__(self, token, body):
        assert token == TOKEN
        self.calls.append(dict(body))
        if self.fail:
            return self.fail
        if body.get("apply") and not self.enabled:
            return 403, {"ok": False, "error": "machine_d1_backfill_disabled"}
        if "keys" in body:
            if self.manifest_mismatch:
                return 409, {
                    "ok": False,
                    "error": "machine_d1_backfill_manifest_mismatch",
                    "mismatches": [{"key": body["keys"][0]["key"], "category": "sha256_mismatch"}],
                }
            if body.get("apply"):
                self.filled = True
                return 200, {
                    "ok": True,
                    "mode": "apply",
                    "scope": "manifest",
                    "side": "kv",
                    "scanned": len(body["keys"]),
                    "counts": {"same": len(body["keys"]) - 1, "missing_in_d1": 1},
                    "diff": 1,
                    "written": 1,
                    "samples": {"missing_in_d1": [body["keys"][0]["key"]]},
                    "done": True,
                }
            missing = 0 if self.filled else 1
            return 200, {
                "ok": True,
                "mode": "verify",
                "scope": "manifest",
                "side": "kv",
                "scanned": len(body["keys"]),
                "counts": {"same": len(body["keys"]) - missing, "missing_in_d1": missing},
                "diff": missing,
                "written": 0,
                "samples": {"missing_in_d1": [body["keys"][0]["key"]]} if missing else {},
                "done": True,
            }
        return self._prefix_reply(body)


def run(argv, post, loader=lambda: TOKEN):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = client.main(argv, post=post, token_loader=loader)
    return code, out.getvalue(), err.getvalue()


def write_manifest(tmpdir, payload):
    path = os.path.join(tmpdir, "manifest.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    return path


def manifest_keys(*entries):
    return [{"key": key, "sha256": digest} for key, digest in entries]


PREFIX_CALL_COUNT = 2 * len(client.mirrored_prefixes())


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

    def test_apply_requires_manifest_locally_without_sending_requests(self):
        site = FakeSite()
        for argv in (["apply"], ["apply", "--prefix", "library:muse-job:"]):
            code, out, err = run(argv, site)
            self.assertEqual(code, 5)
            self.assertEqual(out, "")
            self.assertIn("--manifest", err)
        self.assertEqual(site.calls, [])

    def test_apply_with_manifest_writes_then_reverifies_to_zero(self):
        keys = [
            {"key": "library:muse-job:10.1000/a", "sha256": HASH_A},
            {"key": "library:machine-index:v1", "sha256": HASH_B},
        ]
        site = FakeSite(global_diffs={"missing_in_d1": [item["key"] for item in keys]})
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write_manifest(tmpdir, {
                "schema": 1,
                "description": "synthetic manifest with metadata",
                "keys": keys,
            })
            code, out, err = run(["apply", "--manifest", manifest], site)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(site.calls), PREFIX_CALL_COUNT + 2)
        self.assertTrue(all("keys" not in c and "apply" not in c for c in site.calls[:PREFIX_CALL_COUNT]))
        self.assertEqual({c["prefix"] for c in site.calls[:PREFIX_CALL_COUNT]}, set(client.mirrored_prefixes()))
        self.assertEqual(site.calls[PREFIX_CALL_COUNT], {"keys": keys, "apply": True})
        self.assertEqual(site.calls[PREFIX_CALL_COUNT + 1], {"keys": keys})
        self.assertIn("回填结果", out)
        self.assertIn("回填后复核", out)
        self.assertIn("差异合计：0（两边一致）", out)
        self.assertNotIn(TOKEN, out + err)

    def test_verify_with_manifest(self):
        site = FakeSite()
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write_manifest(tmpdir, {"keys": [{"key": "library:muse-job:10.1000/a", "sha256": HASH_A}]})
            code, out, _err = run(["verify", "--manifest", manifest, "--json"], site)
        self.assertEqual(code, 1)
        self.assertEqual(site.calls, [{"keys": [{"key": "library:muse-job:10.1000/a", "sha256": HASH_A}]}])
        payload = json.loads(out)
        self.assertEqual(payload["verify"]["diff"], 1)
        self.assertEqual(payload["verify"]["scope"], "manifest")

    def test_apply_with_manifest_is_refused_when_the_site_switch_is_off(self):
        key = "library:muse-job:10.1000/a"
        site = FakeSite(enabled=False, global_diffs={"missing_in_d1": [key]})
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write_manifest(tmpdir, {"keys": [{"key": key, "sha256": HASH_A}]})
            code, out, err = run(["apply", "--manifest", manifest], site)
        self.assertEqual(code, 3)
        self.assertIn("machine_d1_backfill_disabled", err)
        self.assertEqual(out, "")
        self.assertEqual(len(site.calls), PREFIX_CALL_COUNT + 1)
        self.assertEqual(site.calls[PREFIX_CALL_COUNT], {"keys": [{"key": key, "sha256": HASH_A}], "apply": True})

    def test_manifest_mismatch_returns_exit_3_without_values_or_hashes(self):
        key = "library:muse-job:10.1000/a"
        site = FakeSite(manifest_mismatch=True, global_diffs={"missing_in_d1": [key]})
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write_manifest(tmpdir, {"keys": [{"key": key, "sha256": HASH_A}]})
            code, out, err = run(["apply", "--manifest", manifest], site)
        self.assertEqual(code, 3)
        self.assertIn("machine_d1_backfill_manifest_mismatch", err)
        self.assertIn("sha256_mismatch:library:muse-job:10.1000/a", err)
        self.assertNotIn(HASH_A, err)
        self.assertNotIn(TOKEN, out + err)
        self.assertTrue(any(c.get("apply") for c in site.calls))

    def test_rejects_invalid_manifest_and_manifest_with_prefix_locally(self):
        site = FakeSite()
        with tempfile.TemporaryDirectory() as tmpdir:
            valid = write_manifest(tmpdir, {"keys": [{"key": "library:muse-job:10.1000/a", "sha256": HASH_A}]})
            self.assertEqual(run(["verify", "--manifest", valid, "--prefix", "library:muse-job:"], site)[0], 5)
            self.assertEqual(run(["apply", "--manifest", os.path.join(tmpdir, "missing.json")], site)[0], 5)
            bad_payloads = [
                {"keys": []},
                {"keys": [{"key": "library:muse-job:10.1000/" + str(i), "sha256": HASH_A} for i in range(101)]},
                {"keys": [{"key": "library:pdf:10.1000/a", "sha256": HASH_A}]},
                {"keys": [{"key": "library:machine-index:v1:extra", "sha256": HASH_A}]},
                {"keys": [{"key": "library:muse-job:", "sha256": HASH_A}]},
                {"keys": [{"key": "library:muse-job:10.1000/a", "sha256": HASH_A.upper()}]},
                {"keys": [{"key": "library:muse-job:10.1000/a", "sha256": HASH_A, "extra": 1}]},
                {"keys": [
                    {"key": "library:muse-job:10.1000/a", "sha256": HASH_A},
                    {"key": "library:muse-job:10.1000/a", "sha256": HASH_A},
                ]},
            ]
            for payload in bad_payloads:
                path = write_manifest(tmpdir, payload)
                self.assertEqual(run(["apply", "--manifest", path], site)[0], 5, str(payload))
        self.assertEqual(site.calls, [])

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

    def test_apply_stops_when_global_diff_has_an_extra_key(self):
        key = "library:muse-job:10.1000/a"
        extra = "library:muse-job:10.1000/extra"
        site = FakeSite(global_diffs={"missing_in_d1": [key, extra]})
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write_manifest(tmpdir, {"keys": [{"key": key, "sha256": HASH_A}]})
            code, out, err = run(["apply", "--manifest", manifest], site)
        self.assertEqual(code, 5)
        self.assertIn("差异集合与清单不完全一致", err)
        self.assertIn(extra, err)
        self.assertEqual(out, "")
        self.assertEqual(len(site.calls), PREFIX_CALL_COUNT)
        self.assertTrue(all("apply" not in c and "keys" not in c for c in site.calls))

    def test_apply_stops_when_global_diff_is_missing_a_manifest_key(self):
        keys = ["library:muse-job:10.1000/a", "library:machine-index:v1"]
        site = FakeSite(global_diffs={"missing_in_d1": [keys[0]]})
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write_manifest(tmpdir, {"keys": manifest_keys((keys[0], HASH_A), (keys[1], HASH_B))})
            code, out, err = run(["apply", "--manifest", manifest], site)
        self.assertEqual(code, 5)
        self.assertIn("清单内缺失", err)
        self.assertIn(keys[1], err)
        self.assertEqual(out, "")
        self.assertTrue(all("apply" not in c for c in site.calls))

    def test_apply_stops_when_a_non_manifest_value_diff_appears(self):
        key = "library:muse-job:10.1000/a"
        other = "library:job:10.1000/other"
        site = FakeSite(global_diffs={"missing_in_d1": [key], "value_diff": [other]})
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write_manifest(tmpdir, {"keys": [{"key": key, "sha256": HASH_A}]})
            code, _out, err = run(["apply", "--manifest", manifest], site)
        self.assertEqual(code, 5)
        self.assertIn(other, err)
        self.assertTrue(all("apply" not in c for c in site.calls))

    def test_apply_stops_when_prefix_samples_are_truncated(self):
        keys = ["library:muse-job:10.1000/a", "library:muse-job:10.1000/b"]
        site = FakeSite(global_diffs={"missing_in_d1": keys}, truncate_samples=True)
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write_manifest(tmpdir, {"keys": manifest_keys((keys[0], HASH_A), (keys[1], HASH_B))})
            code, _out, err = run(["apply", "--manifest", manifest], site)
        self.assertEqual(code, 5)
        self.assertIn("差异样本被截断", err)
        self.assertTrue(all("apply" not in c for c in site.calls))

    def test_verify_manifest_does_not_run_global_precheck(self):
        site = FakeSite()
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write_manifest(tmpdir, {"keys": [{"key": "library:muse-job:10.1000/a", "sha256": HASH_A}]})
            code, out, _err = run(["verify", "--manifest", manifest, "--json"], site)
        self.assertEqual(code, 1)
        self.assertEqual(site.calls, [{"keys": [{"key": "library:muse-job:10.1000/a", "sha256": HASH_A}]}])
        self.assertEqual(json.loads(out)["verify"]["scope"], "manifest")
        self.assertNotIn("exact_diff_precheck", json.loads(out))


if __name__ == "__main__":
    unittest.main()
