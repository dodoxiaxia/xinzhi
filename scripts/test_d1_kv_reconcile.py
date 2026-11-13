"""scripts/d1_kv_reconcile.py 的离线单元测试。"""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import re
import sys
from typing import Sequence
import unittest
from unittest import mock
import urllib.error
import urllib.parse

SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT = SCRIPTS_DIR.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import d1_kv_reconcile as rec  # noqa: E402


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _base_env() -> dict[str, str]:
    return {
        "CLOUDFLARE_API_TOKEN": "FAKE_TOKEN_SECRET_VALUE_9999",
        "CLOUDFLARE_ACCOUNT_ID": "acct-fake-id-1234",
        "CF_KV_NAMESPACE_ID": "ns-fake-id-5678",
        "CF_D1_DATABASE_ID": "d1-fake-id-9012",
    }


class CompareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.prefixes = ["library:paper:", "library:job:", "library:machine-index:v1"]
        self.now_ms = 1_700_000_000_000

    def test_compare_all_categories_and_ignores_non_mirrored(self) -> None:
        old_ts = self.now_ms - 600_000
        recent_ts = self.now_ms - 30_000  # 120s 宽限期内

        kv = {
            "library:paper:same": _sha("v-same"),
            "library:paper:missing-d1": _sha("v-missing-d1"),
            "library:paper:kv-present-d1-deleted": _sha("v-deleted-old"),
            "library:paper:kv-present-d1-deleted-recent": _sha("v-deleted-recent"),
            "library:paper:diff-sha": _sha("v-new"),
            "library:paper:diff-null": _sha("v-null"),
            "library:paper:diff-recent": _sha("v-recent-write"),
            # 非 mirrored 前缀应被忽略
            "library:pdf:10.1000/ignored": _sha("pdf-bytes"),
            "ai:ql:ignored": _sha("ai-cache"),
        }

        d1_rows = {
            "library:paper:same": {
                "key": "library:paper:same",
                "entity": "paper",
                "sha256": _sha("v-same"),
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 0,
            },
            "library:paper:deleted-ok": {
                "key": "library:paper:deleted-ok",
                "entity": "paper",
                "sha256": _sha("gone"),
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 1,
            },
            "library:job:expired-ok": {
                "key": "library:job:expired-ok",
                "entity": "job",
                "sha256": _sha("job-1"),
                "expires_at": self.now_ms - 300_001,
                "updated_at": old_ts,
                "deleted": 0,
            },
            "library:job:not-yet-expired-missing": {
                "key": "library:job:not-yet-expired-missing",
                "entity": "job",
                "sha256": _sha("job-2"),
                "expires_at": self.now_ms - 100_000,  # 尚未超过 +300000ms 宽限
                "updated_at": old_ts,
                "deleted": 0,
            },
            "library:paper:kv-present-d1-deleted": {
                "key": "library:paper:kv-present-d1-deleted",
                "entity": "paper",
                "sha256": _sha("v-deleted-old"),
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 1,
            },
            "library:paper:kv-present-d1-deleted-recent": {
                "key": "library:paper:kv-present-d1-deleted-recent",
                "entity": "paper",
                "sha256": _sha("v-deleted-recent"),
                "expires_at": None,
                "updated_at": recent_ts,
                "deleted": 1,
            },
            "library:paper:missing-kv": {
                "key": "library:paper:missing-kv",
                "entity": "paper",
                "sha256": _sha("v-mk"),
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 0,
            },
            "library:paper:missing-kv-recent": {
                "key": "library:paper:missing-kv-recent",
                "entity": "paper",
                "sha256": _sha("v-mkr"),
                "expires_at": None,
                "updated_at": recent_ts,
                "deleted": 0,
            },
            "library:paper:diff-sha": {
                "key": "library:paper:diff-sha",
                "entity": "paper",
                "sha256": _sha("v-old"),
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 0,
            },
            "library:paper:diff-null": {
                "key": "library:paper:diff-null",
                "entity": "paper",
                "sha256": None,
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 0,
            },
            "library:paper:diff-recent": {
                "key": "library:paper:diff-recent",
                "entity": "paper",
                "sha256": _sha("v-stale"),
                "expires_at": None,
                "updated_at": recent_ts,
                "deleted": 0,
            },
            # 非 mirrored 前缀应被忽略
            "cfg:flags": {
                "key": "cfg:flags",
                "entity": "cfg",
                "sha256": _sha("x"),
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 0,
            },
        }

        res = rec.compare(kv, d1_rows, self.now_ms, grace_s=120, prefixes=self.prefixes)
        self.assertEqual(res["same"], ["library:paper:same"])
        self.assertEqual(res["deleted_ok"], ["library:paper:deleted-ok"])
        self.assertEqual(res["expired_ok"], ["library:job:expired-ok"])
        self.assertEqual(res["missing_in_d1"], ["library:paper:missing-d1"])
        self.assertEqual(res["kv_present_d1_deleted"], ["library:paper:kv-present-d1-deleted"])
        self.assertEqual(
            res["missing_in_kv"],
            ["library:job:not-yet-expired-missing", "library:paper:missing-kv"],
        )
        self.assertEqual(res["value_diff"], ["library:paper:diff-null", "library:paper:diff-sha"])
        self.assertEqual(
            res["recent"],
            [
                "library:paper:diff-recent",
                "library:paper:kv-present-d1-deleted-recent",
                "library:paper:missing-kv-recent",
            ],
        )


class RecheckTests(unittest.TestCase):
    def test_reconcile_recheck_clears_transient_diffs(self) -> None:
        now_ms = 1_700_000_000_000
        old_ts = now_ms - 500_000
        sleeps: list[float] = []

        kv_initial = {
            "library:paper:ok": _sha("a"),
            "library:paper:lag": _sha("b"),
            "library:paper:still-diff": _sha("c-kv"),
        }
        d1_initial = {
            "library:paper:ok": {
                "key": "library:paper:ok",
                "entity": "paper",
                "sha256": _sha("a"),
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 0,
            },
            # lag 初始缺失；still-diff 内容不同
            "library:paper:still-diff": {
                "key": "library:paper:still-diff",
                "entity": "paper",
                "sha256": _sha("c-d1"),
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 0,
            },
            # 初始在 D1 有但 KV 无；复查时 D1 已标 deleted=1
            "library:job:gone": {
                "key": "library:job:gone",
                "entity": "job",
                "sha256": _sha("j"),
                "expires_at": None,
                "updated_at": old_ts,
                "deleted": 0,
            },
        }

        recheck_calls: list[list[str]] = []

        def fake_recheck_kv(keys):
            recheck_calls.append(list(keys))
            return {
                "library:paper:lag": _sha("b"),
                "library:paper:still-diff": _sha("c-kv"),
            }

        def fake_recheck_d1(keys):
            return {
                "library:paper:lag": {
                    "key": "library:paper:lag",
                    "entity": "paper",
                    "sha256": _sha("b"),
                    "expires_at": None,
                    "updated_at": now_ms,
                    "deleted": 0,
                },
                "library:paper:still-diff": {
                    "key": "library:paper:still-diff",
                    "entity": "paper",
                    "sha256": _sha("c-d1"),
                    "expires_at": None,
                    "updated_at": old_ts,
                    "deleted": 0,
                },
                "library:job:gone": {
                    "key": "library:job:gone",
                    "entity": "job",
                    "sha256": _sha("j"),
                    "expires_at": None,
                    "updated_at": now_ms,
                    "deleted": 1,
                },
            }

        res = rec.reconcile(
            prefixes=["library:paper:", "library:job:"],
            kv_list_fn=lambda p: [k for k in kv_initial if k.startswith(p)],
            kv_bulk_get_fn=lambda keys: {k: kv_initial[k] for k in keys},
            d1_fetch_all_fn=lambda: dict(d1_initial),
            recheck_kv_fn=fake_recheck_kv,
            recheck_d1_fn=fake_recheck_d1,
            grace_s=120,
            recheck_delay_s=5.0,
            sleep_fn=sleeps.append,
            now_fn=lambda: now_ms,
        )

        self.assertTrue(res["rechecked"])
        self.assertEqual(sleeps, [5.0])
        self.assertEqual(
            recheck_calls,
            [["library:job:gone", "library:paper:lag", "library:paper:still-diff"]],
        )
        cats = res["categories"]
        self.assertEqual(cats["same"], ["library:paper:lag", "library:paper:ok"])
        self.assertEqual(cats["deleted_ok"], ["library:job:gone"])
        self.assertEqual(cats["missing_in_d1"], [])
        self.assertEqual(cats["missing_in_kv"], [])
        self.assertEqual(cats["value_diff"], ["library:paper:still-diff"])


class SqlGuardAndEnvTests(unittest.TestCase):
    def test_non_select_sql_is_rejected_before_http(self) -> None:
        called = False

        def forbid_transport(*_args, **_kwargs):
            nonlocal called
            called = True
            raise AssertionError("transport must not be called for non-SELECT SQL")

        env = _base_env()
        client = rec.CloudflareClient(
            token=env["CLOUDFLARE_API_TOKEN"],
            account_id=env["CLOUDFLARE_ACCOUNT_ID"],
            kv_namespace_id=env["CF_KV_NAMESPACE_ID"],
            d1_database_id=env["CF_D1_DATABASE_ID"],
            transport=forbid_transport,
            request_interval=0,
        )

        bad_queries = [
            "DELETE FROM kv_mirror",
            "  update kv_mirror set deleted = 1",
            "INSERT INTO kv_mirror (key, entity, updated_at) VALUES ('a', 'b', 1)",
            "DROP TABLE kv_mirror",
            "PRAGMA table_info(kv_mirror)",
            "SELECT 1; DELETE FROM kv_mirror",
            "",
            "   ",
        ]
        for sql in bad_queries:
            with self.subTest(sql=sql):
                with self.assertRaises(ValueError):
                    client.d1_query(sql)
        self.assertFalse(called)

    def test_missing_env_vars_exit_2_and_only_print_names(self) -> None:
        present_secret = "PRESENT_SECRET_SHOULD_NOT_PRINT"
        env = {
            "CLOUDFLARE_API_TOKEN": present_secret,
            "CLOUDFLARE_ACCOUNT_ID": "acct-present",
            # 缺少 CF_KV_NAMESPACE_ID 与 CF_D1_DATABASE_ID
        }
        out = io.StringIO()
        err = io.StringIO()
        code = rec.main(["--json"], environ=env, stdout=out, stderr=err)
        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        err_text = err.getvalue()
        self.assertIn("CF_KV_NAMESPACE_ID", err_text)
        self.assertIn("CF_D1_DATABASE_ID", err_text)
        self.assertNotIn("CLOUDFLARE_API_TOKEN", err_text)
        self.assertNotIn("CLOUDFLARE_ACCOUNT_ID", err_text)
        self.assertNotIn(present_secret, err_text)
        self.assertNotIn("acct-present", err_text)


class FakeCloudflareServer:
    """离线模拟 Cloudflare KV & D1 API，并记录全部 HTTP 请求。"""

    def __init__(
        self,
        *,
        env: dict[str, str],
        kv_data: dict[str, str],
        d1_rows: list[dict],
        kv_page_size: int = 1000,
        bulk_fail_status: int | None = None,
        status_override: dict[str, list[tuple[int, dict[str, str], bytes]]] | None = None,
    ) -> None:
        self.env = env
        self.kv_data = dict(kv_data)
        self.d1_rows = list(d1_rows)
        self.kv_page_size = kv_page_size
        self.bulk_fail_status = bulk_fail_status
        self.status_override = {k: list(v) for k, v in (status_override or {}).items()}
        self.requests: list[dict] = []

    def transport(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        _timeout: float,
    ) -> tuple[int, dict[str, str], bytes]:
        parsed = urllib.parse.urlparse(url)
        body_text = body.decode("utf-8") if body else ""
        self.requests.append(
            {
                "method": method,
                "path": parsed.path,
                "query": parsed.query,
                "headers": dict(headers),
                "body": body_text,
            }
        )

        # 验证鉴权头（测试用假令牌）
        expected_auth = f"Bearer {self.env['CLOUDFLARE_API_TOKEN']}"
        if headers.get("Authorization") != expected_auth:
            err = {"success": False, "errors": [{"code": 10000, "message": "Invalid token detail"}]}
            return 401, {}, json.dumps(err).encode("utf-8")

        for op_key, queue in self.status_override.items():
            if op_key in parsed.path and queue:
                return queue.pop(0)

        acct = self.env["CLOUDFLARE_ACCOUNT_ID"]
        ns = self.env["CF_KV_NAMESPACE_ID"]
        db = self.env["CF_D1_DATABASE_ID"]
        kv_prefix = f"/client/v4/accounts/{acct}/storage/kv/namespaces/{ns}"
        d1_path = f"/client/v4/accounts/{acct}/d1/database/{db}/query"

        if method == "GET" and parsed.path == f"{kv_prefix}/keys":
            qs = urllib.parse.parse_qs(parsed.query)
            prefix = qs.get("prefix", [""])[0]
            cursor = int(qs.get("cursor", ["0"])[0] or "0")
            matched = sorted(k for k in self.kv_data if k.startswith(prefix))
            page = matched[cursor : cursor + self.kv_page_size]
            next_cursor = str(cursor + self.kv_page_size) if cursor + self.kv_page_size < len(matched) else ""
            payload = {
                "success": True,
                "result": [{"name": k} for k in page],
                "result_info": {"cursor": next_cursor},
            }
            return 200, {}, json.dumps(payload).encode("utf-8")

        if method == "POST" and parsed.path == f"{kv_prefix}/bulk/get":
            if self.bulk_fail_status is not None:
                err = {"success": False, "errors": [{"code": 9001, "message": "bulk unavailable"}]}
                return self.bulk_fail_status, {}, json.dumps(err).encode("utf-8")
            req_json = json.loads(body_text)
            req_keys = req_json.get("keys", [])
            values = {k: self.kv_data.get(k) for k in req_keys}
            return 200, {}, json.dumps({"success": True, "result": {"values": values}}).encode("utf-8")

        if method == "GET" and parsed.path.startswith(f"{kv_prefix}/values/"):
            encoded_key = parsed.path[len(f"{kv_prefix}/values/") :]
            key = urllib.parse.unquote(encoded_key)
            if key not in self.kv_data:
                return 404, {}, b""
            return 200, {}, self.kv_data[key].encode("utf-8")

        if method == "POST" and parsed.path == d1_path:
            req_json = json.loads(body_text)
            sql = req_json["sql"]
            params = req_json.get("params", [])
            if "WHERE key > ?1" in sql:
                last_key = params[0]
                matched = sorted((r for r in self.d1_rows if r["key"] > last_key), key=lambda r: r["key"])
                page = matched[: rec.D1_PAGE_LIMIT]
                return 200, {}, json.dumps({"success": True, "result": [{"results": page}]}).encode("utf-8")
            if "WHERE key IN (" in sql:
                wanted = set(params)
                matched = [r for r in self.d1_rows if r["key"] in wanted]
                return 200, {}, json.dumps({"success": True, "result": [{"results": matched}]}).encode("utf-8")
            raise AssertionError(f"Unexpected SQL in test: {sql}")

        raise AssertionError(f"Unexpected HTTP call: {method} {parsed.path}")


class ClientAndSecurityTests(unittest.TestCase):
    def _assert_no_secrets_leaked(
        self, text: str, env: dict[str, str], forbidden_extra: Sequence[str] = ()
    ) -> None:
        self.assertNotIn(env["CLOUDFLARE_API_TOKEN"], text)
        self.assertNotIn("Authorization", text)
        self.assertNotIn(env["CLOUDFLARE_ACCOUNT_ID"], text)
        self.assertNotIn(env["CF_KV_NAMESPACE_ID"], text)
        self.assertNotIn(env["CF_D1_DATABASE_ID"], text)
        for item in forbidden_extra:
            self.assertNotIn(item, text)

    def test_zero_diff_exits_0_and_skips_recheck(self) -> None:
        env = _base_env()
        now_ms = 1_700_000_000_000
        val = "index-json"
        server = FakeCloudflareServer(
            env=env,
            kv_data={"library:machine-index:v1": val},
            d1_rows=[
                {
                    "key": "library:machine-index:v1",
                    "entity": "index",
                    "sha256": _sha(val),
                    "size": len(val),
                    "expires_at": None,
                    "updated_at": now_ms - 10_000,
                    "deleted": 0,
                }
            ],
        )
        sleeps: list[float] = []
        out = io.StringIO()
        err = io.StringIO()
        code = rec.main(
            ["--json", "--prefix", "library:machine-index:v1"],
            environ=env,
            transport=server.transport,
            sleep_fn=sleeps.append,
            now_fn=lambda: now_ms,
            request_interval=0,
            recheck_delay_s=5.0,
            stdout=out,
            stderr=err,
        )
        self.assertEqual(code, 0)
        self.assertEqual(err.getvalue(), "")
        self.assertEqual(sleeps, [])
        report = json.loads(out.getvalue())
        self.assertTrue(report["ok"])
        self.assertFalse(report["rechecked"])
        self.assertEqual(report["kv_read_mode"], "bulk")
        self.assertEqual(report["counts"]["same"], 1)
        self.assertEqual(report["entity_counts"], {"index": 1})
        self._assert_no_secrets_leaked(out.getvalue(), env, [val])
        self._assert_readonly_requests(server.requests, env)

    def test_429_retries_with_retry_after_and_backoff_then_succeeds(self) -> None:
        env = _base_env()
        now_ms = 1_700_000_000_000
        server = FakeCloudflareServer(
            env=env,
            kv_data={"library:paper:ok": "v1"},
            d1_rows=[
                {
                    "key": "library:paper:ok",
                    "entity": "paper",
                    "sha256": _sha("v1"),
                    "size": 2,
                    "expires_at": None,
                    "updated_at": now_ms - 10_000,
                    "deleted": 0,
                }
            ],
            status_override={
                "/keys": [
                    (429, {"Retry-After": "1.5"}, b'{"errors":[{"code":1001}]}'),
                    (429, {}, b'{"errors":[{"code":1001}]}'),
                ]
            },
        )
        sleeps: list[float] = []
        out = io.StringIO()
        err = io.StringIO()
        code = rec.main(
            ["--json", "--prefix", "library:paper:"],
            environ=env,
            transport=server.transport,
            sleep_fn=sleeps.append,
            now_fn=lambda: now_ms,
            request_interval=0,
            recheck_delay_s=0,
            stdout=out,
            stderr=err,
        )
        self.assertEqual(code, 0)
        # 第一次按 Retry-After=1.5s，第二次无 Retry-After 按指数退避 0.5*(2**1)=1.0s
        self.assertEqual(sleeps, [1.5, 1.0])
        self._assert_readonly_requests(server.requests, env)

    def test_http_401_and_429_never_leak_token_ids_or_body(self) -> None:
        env = _base_env()
        secret_body_msg = "SUPER_SENSITIVE_CF_BODY_DETAIL"

        # 1) 401 via urllib HTTPError path
        err_payload = json.dumps(
            {"success": False, "errors": [{"code": 10000, "message": secret_body_msg}]}
        ).encode("utf-8")

        def fake_urlopen(req, timeout=30.0):
            raise urllib.error.HTTPError(
                req.full_url,
                401,
                "Unauthorized",
                {"Content-Type": "application/json"},
                io.BytesIO(err_payload),
            )

        out = io.StringIO()
        err = io.StringIO()
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            code = rec.main(
                ["--prefix", "library:paper:"],
                environ=env,
                sleep_fn=lambda _s: None,
                request_interval=0,
                recheck_delay_s=0,
                stdout=out,
                stderr=err,
            )
        self.assertEqual(code, 2)
        combined = out.getvalue() + err.getvalue()
        self.assertIn("401", combined)
        self.assertIn("10000", combined)
        self._assert_no_secrets_leaked(combined, env, [secret_body_msg])

        # 2) 429 exhausting retries
        server = FakeCloudflareServer(
            env=env,
            kv_data={},
            d1_rows=[],
            status_override={
                "/keys": [
                    (429, {"Retry-After": "0.1"}, json.dumps({"errors": [{"code": 9999, "message": secret_body_msg}]}).encode("utf-8"))
                    for _ in range(6)
                ]
            },
        )
        sleeps: list[float] = []
        out2 = io.StringIO()
        err2 = io.StringIO()
        code2 = rec.main(
            ["--prefix", "library:paper:"],
            environ=env,
            transport=server.transport,
            sleep_fn=sleeps.append,
            request_interval=0,
            recheck_delay_s=0,
            stdout=out2,
            stderr=err2,
        )
        self.assertEqual(code2, 2)
        self.assertEqual(len(sleeps), 5)
        combined2 = out2.getvalue() + err2.getvalue()
        self.assertIn("429", combined2)
        self.assertIn("9999", combined2)
        self._assert_no_secrets_leaked(combined2, env, [secret_body_msg])

        # 3) URLError path
        def fake_urlopen_urlerror(_req, timeout=30.0):
            raise urllib.error.URLError(f"failed reaching {env['CLOUDFLARE_ACCOUNT_ID']}")

        out3 = io.StringIO()
        err3 = io.StringIO()
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen_urlerror):
            code3 = rec.main(
                ["--prefix", "library:paper:"],
                environ=env,
                sleep_fn=lambda _s: None,
                request_interval=0,
                recheck_delay_s=0,
                stdout=out3,
                stderr=err3,
            )
        self.assertEqual(code3, 2)
        self._assert_no_secrets_leaked(out3.getvalue() + err3.getvalue(), env)

    def test_bulk_get_fallback_to_per_key_and_kv_values_never_printed(self) -> None:
        env = _base_env()
        now_ms = 1_700_000_000_000
        secret_kv_val_1 = "SECRET_PAPER_JSON_BODY_ALPHA"
        secret_kv_val_2 = "SECRET_PAPER_JSON_BODY_BETA"
        key_with_slash = "library:paper:10.1000/j.2026:v1"
        key_diff = "library:paper:10.1000/diff"

        server = FakeCloudflareServer(
            env=env,
            kv_data={
                key_with_slash: secret_kv_val_1,
                key_diff: secret_kv_val_2,
            },
            d1_rows=[
                {
                    "key": key_with_slash,
                    "entity": "paper",
                    "sha256": _sha(secret_kv_val_1),
                    "size": len(secret_kv_val_1),
                    "expires_at": None,
                    "updated_at": now_ms - 500_000,
                    "deleted": 0,
                },
                {
                    "key": key_diff,
                    "entity": "paper",
                    "sha256": _sha("OLD_VALUE"),
                    "size": 9,
                    "expires_at": None,
                    "updated_at": now_ms - 500_000,
                    "deleted": 0,
                },
            ],
            bulk_fail_status=404,
        )

        out = io.StringIO()
        err = io.StringIO()
        code = rec.main(
            ["--json", "--prefix", "library:paper:"],
            environ=env,
            transport=server.transport,
            sleep_fn=lambda _s: None,
            now_fn=lambda: now_ms,
            request_interval=0,
            recheck_delay_s=0,
            stdout=out,
            stderr=err,
        )
        self.assertEqual(code, 1)
        self.assertEqual(err.getvalue(), "")
        report = json.loads(out.getvalue())
        self.assertEqual(report["counts"]["same"], 1)
        self.assertEqual(report["counts"]["value_diff"], 1)
        self.assertEqual(report["samples"]["value_diff"], [key_diff])
        self.assertEqual(report["kv_read_mode"], "per_key")

        # KV 原始值不得出现在输出中
        combined = out.getvalue() + err.getvalue()
        self._assert_no_secrets_leaked(combined, env, [secret_kv_val_1, secret_kv_val_2])

        # 验证 bulk/get 失败后确实发出了 URL 编码后的逐键 GET 请求，且包含 404 不报错逻辑
        per_key_paths = [r["path"] for r in server.requests if r["method"] == "GET" and "/values/" in r["path"]]
        expected_encoded = urllib.parse.quote(key_with_slash, safe="")
        self.assertTrue(any(p.endswith(f"/values/{expected_encoded}") for p in per_key_paths))

        # 验证所有请求的 HTTP 方法与 POST 路径白名单
        self._assert_readonly_requests(server.requests, env)

    def test_pagination_kv_cursor_and_d1_pages_plus_recheck_batch_50(self) -> None:
        env = _base_env()
        now_ms = 1_700_000_000_000
        old_ts = now_ms - 500_000

        # 构造 5002 条记录（D1 超过一页 5000，KV 列键超过一页）
        kv_data: dict[str, str] = {}
        d1_rows: list[dict] = []
        for i in range(5002):
            key = f"library:paper:k-{i:04d}"
            val = f"payload-{i}"
            kv_data[key] = val
            # 前 55 条故意设成 sha256 不一致，触发复查分批（50 + 5）
            d1_sha = _sha("stale") if i < 55 else _sha(val)
            d1_rows.append(
                {
                    "key": key,
                    "entity": "paper",
                    "sha256": d1_sha,
                    "size": len(val),
                    "expires_at": None,
                    "updated_at": old_ts,
                    "deleted": 0,
                }
            )

        server = FakeCloudflareServer(
            env=env,
            kv_data=kv_data,
            d1_rows=d1_rows,
            kv_page_size=2000,
        )

        out = io.StringIO()
        err = io.StringIO()
        code = rec.main(
            ["--prefix", "library:paper:", "--sample", "5"],
            environ=env,
            transport=server.transport,
            sleep_fn=lambda _s: None,
            now_fn=lambda: now_ms,
            request_interval=0,
            recheck_delay_s=0,
            stdout=out,
            stderr=err,
        )
        self.assertEqual(code, 1)
        self.assertEqual(err.getvalue(), "")
        text = out.getvalue()
        self.assertIn("一致 (same): 4947", text)
        self.assertIn("内容 SHA-256 不一致 (value_diff): 55", text)
        self.assertIn("paper: 5002", text)
        self._assert_no_secrets_leaked(text, env, ["payload-0", "payload-5001"])

        # 验证 KV list 分页使用了 cursor（2000 + 2000 + 1002 -> 3 次请求）
        kv_list_reqs = [r for r in server.requests if r["method"] == "GET" and r["path"].endswith("/keys")]
        self.assertEqual(len(kv_list_reqs), 3)
        self.assertIn("cursor=2000", kv_list_reqs[1]["query"])
        self.assertIn("cursor=4000", kv_list_reqs[2]["query"])

        # 验证 D1 全表分页（5000 + 2 -> 2 次）以及复查 IN 分批（50 + 5 -> 2 次）
        d1_reqs = [r for r in server.requests if r["method"] == "POST" and r["path"].endswith("/query")]
        paginated_reqs = [r for r in d1_reqs if "WHERE key > ?1" in r["body"]]
        recheck_d1_reqs = [r for r in d1_reqs if "WHERE key IN (" in r["body"]]
        self.assertEqual(len(paginated_reqs), 2)
        self.assertEqual(len(recheck_d1_reqs), 2)
        self.assertEqual(len(json.loads(recheck_d1_reqs[0]["body"])["params"]), 50)
        self.assertEqual(len(json.loads(recheck_d1_reqs[1]["body"])["params"]), 5)

        self._assert_readonly_requests(server.requests, env)

    def test_per_key_get_404_treated_as_missing_key(self) -> None:
        env = _base_env()
        server = FakeCloudflareServer(
            env=env,
            kv_data={"library:paper:exists": "hello"},
            d1_rows=[],
            bulk_fail_status=501,
        )
        client = rec.CloudflareClient(
            token=env["CLOUDFLARE_API_TOKEN"],
            account_id=env["CLOUDFLARE_ACCOUNT_ID"],
            kv_namespace_id=env["CF_KV_NAMESPACE_ID"],
            d1_database_id=env["CF_D1_DATABASE_ID"],
            transport=server.transport,
            request_interval=0,
        )
        res = client.bulk_get_kv_sha256(["library:paper:exists", "library:paper:vanished"])
        self.assertEqual(res, {"library:paper:exists": _sha("hello")})
        self.assertEqual(client.kv_read_mode, "per_key")
        self._assert_readonly_requests(server.requests, env)

    def test_human_report_prints_kv_read_mode_line(self) -> None:
        for mode, text in (("bulk", "KV 读取方式: bulk（批量读取）"), ("per_key", "KV 读取方式: 逐键")):
            report = rec.build_report(
                result={"categories": {c: [] for c in rec.CATEGORIES}, "entity_counts": {}, "rechecked": False, "checked_at_ms": 1},
                active_prefixes=["library:paper:"],
                shadow_prefixes={"mirrored": ["library:paper:"], "excluded": []},
                sample=5,
                grace_s=120,
                kv_read_mode=mode,
            )
            self.assertEqual(report["kv_read_mode"], mode)
            self.assertIn(text, rec.format_human_report(report))

    def _assert_readonly_requests(self, requests: list[dict], env: dict[str, str]) -> None:
        acct = env["CLOUDFLARE_ACCOUNT_ID"]
        ns = env["CF_KV_NAMESPACE_ID"]
        db = env["CF_D1_DATABASE_ID"]
        allowed_post_paths = {
            f"/client/v4/accounts/{acct}/storage/kv/namespaces/{ns}/bulk/get",
            f"/client/v4/accounts/{acct}/d1/database/{db}/query",
        }
        for req in requests:
            self.assertIn(req["method"], ("GET", "POST"))
            if req["method"] == "POST":
                self.assertIn(req["path"], allowed_post_paths)


class PrefixConsistencyTests(unittest.TestCase):
    def test_shadow_prefixes_matches_worker_d1_shadow_prefixes(self) -> None:
        prefixes_data = rec.load_shadow_prefixes()
        mirrored = prefixes_data["mirrored"]
        self.assertGreater(len(mirrored), 0)

        js_path = ROOT / "edge" / "src" / "07c-d1-shadow.js"
        if not js_path.exists():
            print(f"[跳过] {js_path.relative_to(ROOT)} 尚未存在，暂跳过 D1_SHADOW_PREFIXES 一致性断言")
            self.skipTest("edge/src/07c-d1-shadow.js 尚未存在")

        content = js_path.read_text(encoding="utf-8")
        array_match = re.search(r"const\s+D1_SHADOW_PREFIXES\s*=\s*\[(.*?)\]", content, re.DOTALL)
        if array_match:
            js_prefixes = re.findall(r"""['"]([^'"]+)['"]""", array_match.group(1))
        else:
            map_match = re.search(r"const\s+D1_SHADOW_PREFIX_MAP\s*=\s*\[(.*?)\n\];", content, re.DOTALL)
            self.assertIsNotNone(
                map_match,
                "edge/src/07c-d1-shadow.js 中未找到 D1_SHADOW_PREFIXES 或 D1_SHADOW_PREFIX_MAP",
            )
            js_prefixes = re.findall(r"""\[\s*['"]([^'"]+)['"]""", map_match.group(1))

        self.assertEqual(len(js_prefixes), len(set(js_prefixes)))
        self.assertEqual(sorted(mirrored), sorted(js_prefixes))


if __name__ == "__main__":
    unittest.main()
