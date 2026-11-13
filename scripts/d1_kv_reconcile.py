#!/usr/bin/env python3
"""D1 与 Cloudflare KV 只读对账脚本。

用途：
  在 PR-5 将主账本从 Cloudflare KV（QL_KV）切换为 D1 之前，每日运行本脚本对比 KV 与
  D1 镜像表（kv_mirror）的键集合与内容 SHA-256。需连续三天对账结果为 0 差异才可切换。

只读保证：
  - 对 KV 仅执行列键（GET .../keys）、批量读（POST .../bulk/get）及逐键只读（GET .../values/...）。
  - 对 D1 仅执行 SELECT 查询（POST .../d1/database/{db}/query，并在发请求前强校验 SQL 必须以 SELECT 开头）。
  - 绝不向 KV 或 D1 写入、修改或删除任何数据。

环境变量（仅从环境变量读取，不接受命令行传令牌，不写入文件，不打印）：
  - CLOUDFLARE_API_TOKEN   Cloudflare API 令牌（仅需 KV Read 与 D1 Read 权限）
  - CLOUDFLARE_ACCOUNT_ID  Cloudflare Account ID
  - CF_KV_NAMESPACE_ID     QL_KV 命名空间 ID
  - CF_D1_DATABASE_ID      xinzhi-library D1 数据库 ID

安全约定：
  - 令牌值、Authorization 请求头、含账号/库 ID 的完整 URL 及响应体均不得出现在任何输出、
    异常信息或日志中；HTTP 错误仅输出状态码和 Cloudflare 返回的 errors[].code（数字）。
  - 读取 KV 值后立即在本地计算 UTF-8 SHA-256，值本身不保留、不打印。

退出码：
  - 0：无差异（missing_in_d1、missing_in_kv、value_diff、kv_present_d1_deleted 均为 0）
  - 1：存在差异
  - 2：配置缺失、参数错误或接口错误
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Callable, Mapping, Sequence
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PREFIXES_PATH = ROOT / "d1" / "shadow_prefixes.json"

REQUIRED_ENV_VARS = (
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_KV_NAMESPACE_ID",
    "CF_D1_DATABASE_ID",
)

CATEGORIES = (
    "same",
    "deleted_ok",
    "expired_ok",
    "missing_in_d1",
    "kv_present_d1_deleted",
    "missing_in_kv",
    "value_diff",
    "recent",
)

DIFF_CATEGORIES = (
    "missing_in_d1",
    "kv_present_d1_deleted",
    "missing_in_kv",
    "value_diff",
)

CATEGORY_LABELS = {
    "same": "一致 (same)",
    "deleted_ok": "已同步删除 (deleted_ok)",
    "expired_ok": "已自然过期 (expired_ok)",
    "missing_in_d1": "KV 有但 D1 缺失 (missing_in_d1)",
    "kv_present_d1_deleted": "KV 有但 D1 标记已删 (kv_present_d1_deleted)",
    "missing_in_kv": "D1 有但 KV 缺失 (missing_in_kv)",
    "value_diff": "内容 SHA-256 不一致 (value_diff)",
    "recent": "宽限期内写入 (recent)",
}

D1_PAGINATED_SQL = (
    "SELECT key, entity, sha256, size, expires_at, updated_at, deleted "
    "FROM kv_mirror WHERE key > ?1 ORDER BY key LIMIT 5000"
)
D1_PAGE_LIMIT = 5000
D1_IN_BATCH_SIZE = 50
KV_BULK_BATCH_SIZE = 100
KV_EXPIRY_GRACE_MS = 300_000


class MissingConfigError(Exception):
    """缺少必需环境变量。异常消息只包含变量名。"""

    def __init__(self, missing_vars: Sequence[str]) -> None:
        self.missing_vars = list(missing_vars)
        super().__init__(", ".join(self.missing_vars))


class CloudflareAPIError(Exception):
    """Cloudflare API 错误，不包含令牌、URL、账号/库 ID 或响应体。"""

    def __init__(
        self,
        status: int | None,
        error_codes: Sequence[int] = (),
        operation: str = "request",
    ) -> None:
        self.status = status
        self.error_codes = [int(c) for c in error_codes]
        self.operation = operation
        if status is None:
            msg = f"Cloudflare API 请求失败 ({operation}): 网络或传输错误"
        else:
            msg = f"Cloudflare API 错误 ({operation}): HTTP {status}, errors[].code={self.error_codes}"
        super().__init__(msg)


def load_shadow_prefixes(path: Path = DEFAULT_PREFIXES_PATH) -> dict[str, Any]:
    """读取 d1/shadow_prefixes.json。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("mirrored"), list) or not isinstance(data.get("excluded"), list):
        raise ValueError("shadow_prefixes.json 格式无效")
    return data


def read_env_config(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """从环境变量读取 Cloudflare 配置，缺失任意一项即抛出 MissingConfigError。"""
    env = os.environ if environ is None else environ
    missing: list[str] = []
    config: dict[str, str] = {}
    for name in REQUIRED_ENV_VARS:
        val = env.get(name, "")
        if not isinstance(val, str) or not val.strip():
            missing.append(name)
        else:
            config[name] = val.strip()
    if missing:
        raise MissingConfigError(missing)
    return config


def validate_select_sql(sql: str) -> str:
    """硬校验：发往 D1 的 SQL 去掉空白后必须以 SELECT 开头，且不得包含多语句分号。"""
    if not isinstance(sql, str):
        raise ValueError("D1 查询 SQL 必须是字符串")
    stripped = sql.strip()
    if not re.match(r"^SELECT\b", stripped, re.IGNORECASE):
        raise ValueError("只允许执行 SELECT 查询")
    # 允许末尾可选的单个分号，拒绝中间出现分号拼接其他语句
    without_trailing_semi = stripped[:-1].rstrip() if stripped.endswith(";") else stripped
    if ";" in without_trailing_semi:
        raise ValueError("只允许执行单条 SELECT 查询")
    return stripped


def _extract_error_codes(raw_body: bytes) -> list[int]:
    """从 Cloudflare 错误响应中仅提取数字 errors[].code，丢弃响应体其他内容。"""
    if not raw_body:
        return []
    try:
        payload = json.loads(raw_body.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeDecodeError):
        return []
    if not isinstance(payload, dict):
        return []
    errors = payload.get("errors")
    if not isinstance(errors, list):
        return []
    codes: list[int] = []
    for item in errors:
        if isinstance(item, dict):
            code = item.get("code")
            if isinstance(code, int) and not isinstance(code, bool):
                codes.append(code)
    return codes


def sha256_utf8(value: str) -> str:
    """计算字符串 UTF-8 编码的小写十六进制 SHA-256。"""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def default_transport(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None,
    timeout: float = 30.0,
) -> tuple[int, dict[str, str], bytes]:
    """基于标准库 urllib 的 HTTP 传输实现，异常路径绝不透出 URL 或请求头。"""
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return int(resp.status), resp_headers, resp.read()
    except urllib.error.HTTPError as exc:
        resp_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
        raw = b""
        try:
            if exc.fp is not None:
                raw = exc.read()
        except Exception:
            raw = b""
        return int(exc.code), resp_headers, raw
    except (urllib.error.URLError, OSError, TimeoutError):
        raise CloudflareAPIError(status=None, error_codes=[], operation="network") from None


TransportFn = Callable[[str, str, dict[str, str], bytes | None, float], tuple[int, dict[str, str], bytes]]


class CloudflareClient:
    """只读 Cloudflare KV / D1 客户端。"""

    def __init__(
        self,
        *,
        token: str,
        account_id: str,
        kv_namespace_id: str,
        d1_database_id: str,
        transport: TransportFn = default_transport,
        sleep_fn: Callable[[float], None] = time.sleep,
        request_interval: float = 0.05,
        max_retries: int = 5,
        timeout: float = 30.0,
    ) -> None:
        self._token = token
        self._account_id = account_id
        self._kv_namespace_id = kv_namespace_id
        self._d1_database_id = d1_database_id
        self._transport = transport
        self._sleep_fn = sleep_fn
        self._request_interval = max(0.0, float(request_interval))
        self._max_retries = max(0, int(max_retries))
        self._timeout = float(timeout)
        self._has_made_request = False

    def _kv_base_path(self) -> str:
        return f"/client/v4/accounts/{self._account_id}/storage/kv/namespaces/{self._kv_namespace_id}"

    def _d1_query_path(self) -> str:
        return f"/client/v4/accounts/{self._account_id}/d1/database/{self._d1_database_id}/query"

    def _bulk_get_path(self) -> str:
        return f"{self._kv_base_path()}/bulk/get"

    def _assert_readonly_request(self, method: str, path_no_query: str) -> None:
        if method == "GET":
            if not path_no_query.startswith(f"{self._kv_base_path()}/"):
                raise ValueError("只允许访问 KV 只读路径")
            return
        if method == "POST":
            if path_no_query not in (self._bulk_get_path(), self._d1_query_path()):
                raise ValueError("只允许向 bulk/get 或 d1/query 发送 POST 请求")
            return
        raise ValueError("只读客户端仅允许 GET 与 POST 方法")

    def _request(
        self,
        method: str,
        path_with_query: str,
        *,
        json_body: dict[str, Any] | None = None,
        operation: str,
        allow_404: bool = False,
    ) -> tuple[int, bytes]:
        path_no_query = path_with_query.split("?", 1)[0]
        self._assert_readonly_request(method, path_no_query)

        url = f"https://api.cloudflare.com{path_with_query}"
        headers = {"Authorization": f"Bearer {self._token}"}
        body_bytes: bytes | None = None
        if json_body is not None:
            headers["Content-Type"] = "application/json"
            body_bytes = json.dumps(json_body, separators=(",", ":")).encode("utf-8")

        for attempt in range(self._max_retries + 1):
            if self._has_made_request and self._request_interval > 0:
                self._sleep_fn(self._request_interval)
            self._has_made_request = True

            try:
                status, raw_resp_headers, raw_body = self._transport(
                    method, url, headers, body_bytes, self._timeout
                )
                resp_headers = {str(k).lower(): str(v) for k, v in (raw_resp_headers or {}).items()}
            except CloudflareAPIError:
                raise
            except urllib.error.HTTPError as exc:
                status = int(exc.code)
                resp_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
                try:
                    raw_body = exc.read() if exc.fp is not None else b""
                except Exception:
                    raw_body = b""
            except Exception:
                raise CloudflareAPIError(status=None, error_codes=[], operation=operation) from None

            if status == 429 and attempt < self._max_retries:
                delay = self._retry_delay(resp_headers, attempt)
                self._sleep_fn(delay)
                continue

            if status == 404 and allow_404:
                return status, raw_body

            if 200 <= status < 300:
                return status, raw_body

            codes = _extract_error_codes(raw_body)
            raise CloudflareAPIError(status=status, error_codes=codes, operation=operation)

        raise CloudflareAPIError(status=429, error_codes=[], operation=operation)

    @staticmethod
    def _retry_delay(resp_headers: dict[str, str], attempt: int) -> float:
        raw_ra = resp_headers.get("retry-after", "").strip()
        if raw_ra:
            try:
                val = float(raw_ra)
                if val > 0:
                    return val
            except ValueError:
                pass
        return min(30.0, 0.5 * (2**attempt))

    def list_kv_keys(self, prefix: str) -> list[str]:
        """按前缀分页列出 KV 键名。"""
        keys: list[str] = []
        cursor = ""
        seen_cursors: set[str] = set()
        while True:
            params: dict[str, Any] = {"prefix": prefix, "limit": 1000}
            if cursor:
                params["cursor"] = cursor
            qs = urllib.parse.urlencode(params)
            _, raw_body = self._request(
                "GET",
                f"{self._kv_base_path()}/keys?{qs}",
                operation="kv_list_keys",
            )
            try:
                payload = json.loads(raw_body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise CloudflareAPIError(status=200, error_codes=[], operation="kv_list_keys") from None

            result = payload.get("result") if isinstance(payload, dict) else None
            if not isinstance(result, list):
                raise CloudflareAPIError(status=200, error_codes=_extract_error_codes(raw_body), operation="kv_list_keys")

            for item in result:
                if isinstance(item, dict) and isinstance(item.get("name"), str):
                    keys.append(item["name"])

            result_info = payload.get("result_info") if isinstance(payload, dict) else None
            next_cursor = ""
            if isinstance(result_info, dict) and isinstance(result_info.get("cursor"), str):
                next_cursor = result_info["cursor"]

            if not next_cursor or next_cursor in seen_cursors:
                break
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        return keys

    def get_kv_value_sha256(self, key: str) -> str | None:
        """逐键读取 KV 值并立即返回 SHA-256；404 返回 None。值本身不保留。"""
        encoded_key = urllib.parse.quote(key, safe="")
        status, raw_body = self._request(
            "GET",
            f"{self._kv_base_path()}/values/{encoded_key}",
            operation="kv_get_value",
            allow_404=True,
        )
        if status == 404:
            return None
        return hashlib.sha256(raw_body).hexdigest()

    def get_kv_many_per_key(self, keys: Sequence[str]) -> dict[str, str]:
        """逐键读取多个 KV 键并返回 {key: sha256}，用于复查及 bulk/get 不可用时的回退。"""
        hashes: dict[str, str] = {}
        for key in keys:
            digest = self.get_kv_value_sha256(key)
            if digest is not None:
                hashes[key] = digest
        return hashes

    def bulk_get_kv_sha256(self, keys: Sequence[str]) -> dict[str, str]:
        """优先用 POST bulk/get 批量读取 KV 值并算 SHA-256；非 2xx 时退回逐键 GET。"""
        hashes: dict[str, str] = {}
        bulk_unavailable = False
        unique_keys = list(dict.fromkeys(keys))

        for start in range(0, len(unique_keys), KV_BULK_BATCH_SIZE):
            chunk = unique_keys[start : start + KV_BULK_BATCH_SIZE]
            if bulk_unavailable:
                hashes.update(self.get_kv_many_per_key(chunk))
                continue

            try:
                _, raw_body = self._request(
                    "POST",
                    self._bulk_get_path(),
                    json_body={"keys": chunk, "type": "text"},
                    operation="kv_bulk_get",
                )
            except CloudflareAPIError as exc:
                if exc.status in (401, 403, 429) or exc.status is None:
                    raise
                bulk_unavailable = True
                hashes.update(self.get_kv_many_per_key(chunk))
                continue

            try:
                payload = json.loads(raw_body.decode("utf-8"))
                values = payload.get("result", {}).get("values") if isinstance(payload, dict) else None
            except (ValueError, UnicodeDecodeError, AttributeError):
                values = None

            if not isinstance(values, dict):
                bulk_unavailable = True
                hashes.update(self.get_kv_many_per_key(chunk))
                continue

            for key in chunk:
                val = values.get(key)
                if isinstance(val, str):
                    hashes[key] = sha256_utf8(val)
            # 显式丢弃批量响应文本引用
            del payload, values, raw_body

        return hashes

    def d1_query(self, sql: str, params: Sequence[Any] | None = None) -> list[dict[str, Any]]:
        """执行只读 D1 SELECT 查询。"""
        checked_sql = validate_select_sql(sql)
        _, raw_body = self._request(
            "POST",
            self._d1_query_path(),
            json_body={"sql": checked_sql, "params": list(params or [])},
            operation="d1_query",
        )
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise CloudflareAPIError(status=200, error_codes=[], operation="d1_query") from None

        result = payload.get("result") if isinstance(payload, dict) else None
        if not isinstance(result, list):
            raise CloudflareAPIError(status=200, error_codes=_extract_error_codes(raw_body), operation="d1_query")
        if not result:
            return []
        first = result[0]
        if not isinstance(first, dict) or not isinstance(first.get("results"), list):
            raise CloudflareAPIError(status=200, error_codes=_extract_error_codes(raw_body), operation="d1_query")
        return [row for row in first["results"] if isinstance(row, dict)]

    def fetch_all_d1_mirror_rows(self) -> dict[str, dict[str, Any]]:
        """分页读取 D1 kv_mirror 表（不读 value 列）。"""
        d1_rows: dict[str, dict[str, Any]] = {}
        last_key = ""
        while True:
            rows = self.d1_query(D1_PAGINATED_SQL, [last_key])
            if not rows:
                break
            for row in rows:
                key = row.get("key")
                if isinstance(key, str):
                    d1_rows[key] = row
            if len(rows) < D1_PAGE_LIMIT:
                break
            next_key = rows[-1].get("key")
            if not isinstance(next_key, str) or next_key <= last_key:
                break
            last_key = next_key
        return d1_rows

    def fetch_d1_rows_by_keys(self, keys: Sequence[str]) -> dict[str, dict[str, Any]]:
        """按 key 批量重读 D1 kv_mirror（每批最多 50 个）。"""
        d1_rows: dict[str, dict[str, Any]] = {}
        unique_keys = list(dict.fromkeys(keys))
        for start in range(0, len(unique_keys), D1_IN_BATCH_SIZE):
            chunk = unique_keys[start : start + D1_IN_BATCH_SIZE]
            placeholders = ", ".join(f"?{idx + 1}" for idx in range(len(chunk)))
            sql = (
                "SELECT key, entity, sha256, size, expires_at, updated_at, deleted "
                f"FROM kv_mirror WHERE key IN ({placeholders})"
            )
            rows = self.d1_query(sql, chunk)
            for row in rows:
                key = row.get("key")
                if isinstance(key, str):
                    d1_rows[key] = row
        return d1_rows


def matches_prefix(key: str, prefixes: Sequence[str]) -> bool:
    """判断键名是否属于指定前缀白名单（library:machine-index:v1 为精确键匹配）。"""
    for prefix in prefixes:
        if prefix == "library:machine-index:v1":
            if key == prefix:
                return True
        elif key.startswith(prefix):
            return True
    return False


def _is_recent_row(row: Mapping[str, Any] | None, now_ms: int, grace_s: float) -> bool:
    if row is None:
        return False
    updated_at = row.get("updated_at")
    if updated_at is None:
        return False
    try:
        updated_ms = int(updated_at)
    except (TypeError, ValueError):
        return False
    return updated_ms >= now_ms - int(grace_s * 1000)


def compare(
    kv: Mapping[str, str],
    d1_rows: Mapping[str, Mapping[str, Any]],
    now_ms: int,
    grace_s: float = 120,
    prefixes: Sequence[str] | None = None,
) -> dict[str, list[str]]:
    """纯函数：比较 KV 键哈希与 D1 镜像行，按分类返回键名列表。"""
    active_prefixes = load_shadow_prefixes()["mirrored"] if prefixes is None else list(prefixes)
    scoped_kv = {k: v for k, v in kv.items() if matches_prefix(k, active_prefixes)}
    scoped_d1 = {k: v for k, v in d1_rows.items() if matches_prefix(k, active_prefixes)}

    buckets: dict[str, list[str]] = {cat: [] for cat in CATEGORIES}
    all_keys = sorted(set(scoped_kv) | set(scoped_d1))

    for key in all_keys:
        in_kv = key in scoped_kv
        row = scoped_d1.get(key)

        if in_kv and row is None:
            buckets["missing_in_d1"].append(key)
            continue

        assert row is not None
        deleted = int(row.get("deleted") or 0) == 1
        recent = _is_recent_row(row, now_ms, grace_s)

        if in_kv:
            if deleted:
                if recent:
                    buckets["recent"].append(key)
                else:
                    buckets["kv_present_d1_deleted"].append(key)
            else:
                d1_sha = row.get("sha256")
                kv_sha = scoped_kv[key]
                if isinstance(d1_sha, str) and d1_sha and d1_sha.lower() == kv_sha.lower():
                    buckets["same"].append(key)
                elif recent:
                    buckets["recent"].append(key)
                else:
                    buckets["value_diff"].append(key)
        else:
            if deleted:
                buckets["deleted_ok"].append(key)
            else:
                expires_at = row.get("expires_at")
                is_expired = False
                if expires_at is not None:
                    try:
                        is_expired = int(expires_at) + KV_EXPIRY_GRACE_MS < now_ms
                    except (TypeError, ValueError):
                        is_expired = False
                if is_expired:
                    buckets["expired_ok"].append(key)
                elif recent:
                    buckets["recent"].append(key)
                else:
                    buckets["missing_in_kv"].append(key)

    return buckets


def reconcile(
    *,
    prefixes: Sequence[str],
    kv_list_fn: Callable[[str], list[str]],
    kv_bulk_get_fn: Callable[[Sequence[str]], dict[str, str]],
    d1_fetch_all_fn: Callable[[], dict[str, dict[str, Any]]],
    recheck_kv_fn: Callable[[Sequence[str]], dict[str, str]],
    recheck_d1_fn: Callable[[Sequence[str]], dict[str, dict[str, Any]]],
    grace_s: float = 120,
    recheck_delay_s: float = 5.0,
    sleep_fn: Callable[[float], None] = time.sleep,
    now_fn: Callable[[], int] = lambda: int(time.time() * 1000),
) -> dict[str, Any]:
    """执行完整对账流程（含差异键延迟复查）。"""
    kv_keys_set: set[str] = set()
    for prefix in prefixes:
        for key in kv_list_fn(prefix):
            if matches_prefix(key, prefixes):
                kv_keys_set.add(key)

    kv_keys = sorted(kv_keys_set)
    kv_hashes = kv_bulk_get_fn(kv_keys) if kv_keys else {}
    d1_rows = d1_fetch_all_fn()

    checked_at_ms = now_fn()
    initial = compare(kv_hashes, d1_rows, checked_at_ms, grace_s=grace_s, prefixes=prefixes)

    diff_keys = sorted(
        {key for cat in DIFF_CATEGORIES for key in initial[cat]}
    )
    rechecked = False
    final_buckets = initial

    if diff_keys:
        rechecked = True
        if recheck_delay_s > 0:
            sleep_fn(recheck_delay_s)
        rechecked_kv = recheck_kv_fn(diff_keys)
        rechecked_d1 = recheck_d1_fn(diff_keys)
        checked_at_ms = now_fn()
        recheck_buckets = compare(
            rechecked_kv,
            rechecked_d1,
            checked_at_ms,
            grace_s=grace_s,
            prefixes=prefixes,
        )

        diff_key_set = set(diff_keys)
        merged: dict[str, list[str]] = {}
        for cat in CATEGORIES:
            kept = [k for k in initial[cat] if k not in diff_key_set]
            kept.extend(recheck_buckets[cat])
            merged[cat] = sorted(kept)
        final_buckets = merged

        for key in diff_keys:
            if key in rechecked_d1:
                d1_rows[key] = rechecked_d1[key]
            else:
                d1_rows.pop(key, None)

    entity_counter: Counter[str] = Counter()
    for key, row in d1_rows.items():
        if matches_prefix(key, prefixes):
            entity = row.get("entity")
            entity_counter[entity if isinstance(entity, str) and entity else "unknown"] += 1

    return {
        "categories": final_buckets,
        "entity_counts": dict(sorted(entity_counter.items())),
        "rechecked": rechecked,
        "checked_at_ms": checked_at_ms,
    }


def build_report(
    *,
    result: Mapping[str, Any],
    active_prefixes: Sequence[str],
    shadow_prefixes: Mapping[str, Any],
    sample: int,
    grace_s: float,
) -> dict[str, Any]:
    """构造可供 JSON 或中文摘要输出的报告结构。"""
    categories: Mapping[str, list[str]] = result["categories"]
    counts = {cat: len(categories[cat]) for cat in CATEGORIES}
    diff_total = sum(counts[cat] for cat in DIFF_CATEGORIES)
    samples = {
        cat: (categories[cat][:sample] if sample > 0 else [])
        for cat in CATEGORIES
    }
    exit_code = 0 if diff_total == 0 else 1
    return {
        "ok": diff_total == 0,
        "exit_code": exit_code,
        "checked_at_ms": result["checked_at_ms"],
        "grace_s": grace_s,
        "rechecked": bool(result["rechecked"]),
        "active_prefixes": list(active_prefixes),
        "mirrored_prefixes": list(shadow_prefixes["mirrored"]),
        "excluded_prefixes": list(shadow_prefixes["excluded"]),
        "counts": counts,
        "diff_total": diff_total,
        "samples": samples,
        "entity_counts": dict(result["entity_counts"]),
    }


def format_human_report(report: Mapping[str, Any]) -> str:
    """格式化人类可读的中文对账摘要（只输出统计、前缀和抽样键名，绝不输出值）。"""
    lines: list[str] = []
    status_text = "一致（0 差异）" if report["ok"] else f"发现 {report['diff_total']} 条差异"
    lines.append(f"D1 / KV 只读对账结果：{status_text}")
    lines.append(
        f"检查时间戳(ms): {report['checked_at_ms']} | 宽限期(s): {report['grace_s']} | 是否复查: {'是' if report['rechecked'] else '否'}"
    )
    lines.append("")
    lines.append("分类统计：")
    counts = report["counts"]
    samples = report["samples"]
    for cat in CATEGORIES:
        lines.append(f"  - {CATEGORY_LABELS[cat]}: {counts[cat]}")
        for key in samples[cat]:
            lines.append(f"      * {key}")

    lines.append("")
    lines.append("各 entity 总数（D1 kv_mirror）：")
    entity_counts = report["entity_counts"]
    if entity_counts:
        for entity, count in entity_counts.items():
            lines.append(f"  - {entity}: {count}")
    else:
        lines.append("  - （无记录）")

    lines.append("")
    lines.append(f"本次检查前缀 ({len(report['active_prefixes'])})：")
    for p in report["active_prefixes"]:
        lines.append(f"  - {p}")

    lines.append("")
    lines.append(f"mirrored 白名单前缀 ({len(report['mirrored_prefixes'])})：")
    for p in report["mirrored_prefixes"]:
        lines.append(f"  - {p}")

    lines.append("")
    lines.append(f"excluded 排除前缀 ({len(report['excluded_prefixes'])})：")
    for item in report["excluded_prefixes"]:
        lines.append(f"  - {item['prefix']}：{item['reason']}")

    return "\n".join(lines)


def _resolve_active_prefixes(
    requested: list[list[str]] | None,
    mirrored: Sequence[str],
) -> list[str]:
    if not requested:
        return list(mirrored)
    flat = [p for group in requested for p in group]
    invalid = [p for p in flat if not any(p.startswith(m) for m in mirrored)]
    if invalid:
        raise ValueError(f"包含非 mirrored 白名单前缀: {', '.join(invalid)}")
    return list(dict.fromkeys(flat))


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cloudflare KV 与 D1 kv_mirror 只读对账工具")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出结果")
    parser.add_argument("--sample", type=int, default=20, help="每类最多抽样输出的键名数量（默认 20）")
    parser.add_argument("--prefix", action="append", nargs="+", help="仅对账指定 mirrored 前缀")
    parser.add_argument("--grace", type=float, default=120, help="写入宽限期秒数（默认 120）")
    return parser.parse_args(argv)


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    transport: TransportFn = default_transport,
    sleep_fn: Callable[[float], None] = time.sleep,
    now_fn: Callable[[], int] = lambda: int(time.time() * 1000),
    prefixes_path: Path = DEFAULT_PREFIXES_PATH,
    recheck_delay_s: float = 5.0,
    request_interval: float = 0.05,
    stdout: Any = None,
    stderr: Any = None,
) -> int:
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr

    try:
        args = parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code != 0 else 0

    if args.sample < 0 or args.grace < 0:
        print("参数错误：--sample 与 --grace 不能为负数", file=err)
        return 2

    try:
        shadow_prefixes = load_shadow_prefixes(prefixes_path)
        active_prefixes = _resolve_active_prefixes(args.prefix, shadow_prefixes["mirrored"])
    except (OSError, ValueError) as exc:
        print(f"配置错误：{exc}", file=err)
        return 2

    try:
        env_cfg = read_env_config(environ)
    except MissingConfigError as exc:
        # 仅打印缺失的环境变量名
        print(f"缺少环境变量: {', '.join(exc.missing_vars)}", file=err)
        return 2

    client = CloudflareClient(
        token=env_cfg["CLOUDFLARE_API_TOKEN"],
        account_id=env_cfg["CLOUDFLARE_ACCOUNT_ID"],
        kv_namespace_id=env_cfg["CF_KV_NAMESPACE_ID"],
        d1_database_id=env_cfg["CF_D1_DATABASE_ID"],
        transport=transport,
        sleep_fn=sleep_fn,
        request_interval=request_interval,
    )

    try:
        result = reconcile(
            prefixes=active_prefixes,
            kv_list_fn=client.list_kv_keys,
            kv_bulk_get_fn=client.bulk_get_kv_sha256,
            d1_fetch_all_fn=client.fetch_all_d1_mirror_rows,
            recheck_kv_fn=client.get_kv_many_per_key,
            recheck_d1_fn=client.fetch_d1_rows_by_keys,
            grace_s=args.grace,
            recheck_delay_s=recheck_delay_s,
            sleep_fn=sleep_fn,
            now_fn=now_fn,
        )
    except CloudflareAPIError as exc:
        print(str(exc), file=err)
        return 2
    except Exception:
        print("对账执行失败（已屏蔽敏感信息）", file=err)
        return 2

    report = build_report(
        result=result,
        active_prefixes=active_prefixes,
        shadow_prefixes=shadow_prefixes,
        sample=args.sample,
        grace_s=args.grace,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2), file=out)
    else:
        print(format_human_report(report), file=out)

    return int(report["exit_code"])


if __name__ == "__main__":
    sys.exit(main())
