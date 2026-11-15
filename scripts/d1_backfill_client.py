#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""KV -> D1 kv_mirror 回填与逐键对账客户端（fallback 角色令牌）。

对接 POST /api/machine/d1-backfill（见 docs/机器下载接口.md）。令牌只从本机令牌文件读取
（XINZHI_MACHINE_TOKEN_FILE，沿用 machine_client.py 的做法），不打印、不写入任何输出。

  python3 scripts/d1_backfill_client.py verify            # 只读：按前缀逐键对比，输出两边差异（目标 0）
  python3 scripts/d1_backfill_client.py verify --prefix library:muse-job:   # 只对一个前缀
  python3 scripts/d1_backfill_client.py verify --manifest path/to/manifest.json  # 只读：按显式清单核对
  python3 scripts/d1_backfill_client.py apply --manifest path/to/manifest.json   # 回填：必须带清单；先做只读全量前缀对账，全局差异集合恰好等于清单后才发送 apply

退出码：0 = 差异为 0；1 = 还有差异；3/4/5 = 接口拒绝、服务端错误、本地配置问题（同 machine_client.py）。
没有 Cloudflare 令牌也能用，这是它与 scripts/d1_kv_reconcile.py 的区别；后者在有 Cloudflare 只读令牌时，
可以从站点外独立复核同一件事（两种方式互相印证）。
"""
from __future__ import print_function

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import machine_client as mc  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREFIXES_PATH = os.path.join(ROOT, "d1", "shadow_prefixes.json")
SIDES = ("kv", "d1")
DIFF_CATEGORIES = ("missing_in_d1", "kv_present_d1_deleted", "value_diff", "missing_in_kv")
LABELS = {
    "same": "一致",
    "kv_present": "D1 行在 KV 里也在",
    "recent": "刚写入（交给影子写，不算差异）",
    "gone": "读取时已不在 KV",
    "expired_ok": "已自然过期",
    "deleted_ok": "已标删且 KV 里也没有",
    "missing_in_d1": "KV 有、D1 缺",
    "kv_present_d1_deleted": "KV 有、D1 标删",
    "value_diff": "两边内容不一致",
    "missing_in_kv": "D1 有、KV 缺",
}
MAX_PAGES = 1000
MANIFEST_MAX_KEYS = 100
MANIFEST_KEY_MAX = 1024
EXACT_MIRRORED_KEY = "library:machine-index:v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class BackfillError(Exception):
    def __init__(self, message, exit_code=4):
        Exception.__init__(self, message)
        self.exit_code = exit_code


def mirrored_prefixes(path=PREFIXES_PATH):
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    prefixes = data.get("mirrored")
    if not isinstance(prefixes, list) or not prefixes:
        raise BackfillError("d1/shadow_prefixes.json 格式无效", 5)
    return list(prefixes)


def manifest_key_allowed(key, known_prefixes):
    if not isinstance(key, str) or not key or len(key) > MANIFEST_KEY_MAX:
        return False
    for prefix in known_prefixes:
        if prefix == EXACT_MIRRORED_KEY:
            if key == prefix:
                return True
        elif key.startswith(prefix) and len(key) > len(prefix):
            return True
    return False


def load_manifest(path, known_prefixes):
    if not os.path.isfile(path):
        raise BackfillError("清单文件不存在：%s" % path, 5)
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, UnicodeDecodeError, ValueError):
        raise BackfillError("清单文件不是合法的 UTF-8 JSON：%s" % path, 5)
    if not isinstance(data, dict) or not isinstance(data.get("keys"), list):
        raise BackfillError("清单格式无效：必须包含 keys 数组", 5)
    raw_keys = data["keys"]
    if not raw_keys or len(raw_keys) > MANIFEST_MAX_KEYS:
        raise BackfillError("清单 keys 条数必须在 1–%d 之间（当前 %d）" % (MANIFEST_MAX_KEYS, len(raw_keys)), 5)
    seen = set()
    manifest = []
    for idx, entry in enumerate(raw_keys, 1):
        if not isinstance(entry, dict) or set(entry.keys()) != {"key", "sha256"}:
            raise BackfillError("清单第 %d 条格式无效：只允许 key 和 sha256 两个字段" % idx, 5)
        key = entry["key"]
        sha256 = entry["sha256"]
        if not manifest_key_allowed(key, known_prefixes):
            raise BackfillError("清单第 %d 条的 key 不在 mirrored 镜像范围内" % idx, 5)
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            raise BackfillError("清单第 %d 条的 sha256 必须是 64 位小写 hex" % idx, 5)
        if key in seen:
            raise BackfillError("清单第 %d 条存在重复 key" % idx, 5)
        seen.add(key)
        manifest.append({"key": key, "sha256": sha256})
    return manifest


def http_post(token, body):
    code, data, _raw = mc.request("POST", "/api/machine/d1-backfill", token=token, json_body=body)
    return code, data


def run_pass(post, token, prefix, side, limit):
    """一个前缀的一侧走完所有分页（只读 verify），返回合计。"""
    totals = {"scanned": 0, "written": 0, "counts": {}, "samples": {}}
    cursor = ""
    for _ in range(MAX_PAGES):
        body = {"prefix": prefix, "side": side, "limit": limit}
        if cursor:
            body["cursor"] = cursor
        code, data = post(token, body)
        if code != 200 or not isinstance(data, dict) or not data.get("ok"):
            error = data.get("error") if isinstance(data, dict) else ""
            exit_code = 3 if 400 <= code < 500 else 4
            raise BackfillError("接口返回 HTTP %s %s（前缀 %s，%s 侧）" % (code, error or "", prefix, side), exit_code)
        totals["scanned"] += int(data.get("scanned") or 0)
        totals["written"] += int(data.get("written") or 0)
        for name, value in (data.get("counts") or {}).items():
            totals["counts"][name] = totals["counts"].get(name, 0) + int(value)
        for name, keys in (data.get("samples") or {}).items():
            bucket = totals["samples"].setdefault(name, [])
            for key in keys:
                if len(bucket) < 10:
                    bucket.append(key)
        if data.get("done"):
            return totals
        cursor = data.get("cursor") or ""
        if not cursor:
            raise BackfillError("接口没有给出下一页的 cursor", 4)
    raise BackfillError("分页超过 %d 次，已停止" % MAX_PAGES, 4)


def sweep(post, token, prefixes, limit):
    """所有前缀、两侧各走一遍只读对账（KV 侧先，D1 侧后）。返回 {prefix: {side: totals}}。"""
    result = {}
    for prefix in prefixes:
        result[prefix] = {side: run_pass(post, token, prefix, side, limit) for side in SIDES}
    return result


def page_diff_keys(data):
    """从一页只读 verify 回复里收集四类差异键名，并判断该页样本是否被截断。"""
    found = set()
    truncated = []
    counts = data.get("counts") or {}
    samples = data.get("samples") or {}
    total = 0
    for name in DIFF_CATEGORIES:
        try:
            count = int(counts.get(name) or 0)
        except (TypeError, ValueError):
            truncated.append(name)
            continue
        if count < 0:
            truncated.append(name)
            continue
        total += count
        keys = samples.get(name) or []
        if not isinstance(keys, list) or any(not isinstance(key, str) or not key for key in keys):
            truncated.append(name)
            continue
        if count != len(keys):
            # 接口每类最多返回 10 个样本：样本数少于计数时无法还原完整集合，必须失败。
            truncated.append(name)
        found.update(keys)
    return found, total, truncated


def sweep_global_diffs(post, token, prefixes, limit):
    """只读扫完所有镜像前缀的两侧，汇总全局差异键集合（不发送 apply）。"""
    found = set()
    total = 0
    truncated = []
    scanned = 0
    for prefix in prefixes:
        for side in SIDES:
            cursor = ""
            for _ in range(MAX_PAGES):
                body = {"prefix": prefix, "side": side, "limit": limit}
                if cursor:
                    body["cursor"] = cursor
                code, data = post(token, body)
                if code != 200 or not isinstance(data, dict) or not data.get("ok"):
                    error = data.get("error") if isinstance(data, dict) else ""
                    exit_code = 3 if 400 <= code < 500 else 4
                    raise BackfillError("接口返回 HTTP %s %s（前缀 %s，%s 侧）" % (code, error or "", prefix, side), exit_code)
                page_keys, page_diff, page_trunc = page_diff_keys(data)
                found.update(page_keys)
                total += page_diff
                truncated.extend("%s/%s/%s" % (prefix, side, name) for name in page_trunc)
                scanned += int(data.get("scanned") or 0)
                if data.get("done"):
                    break
                cursor = data.get("cursor") or ""
                if not cursor:
                    raise BackfillError("接口没有给出下一页的 cursor", 4)
            else:
                raise BackfillError("分页超过 %d 次，已停止" % MAX_PAGES, 4)
    return {"keys": found, "diff": total, "truncated": truncated, "scanned": scanned}


def assert_exact_diff_set(precheck, manifest_keys):
    """要求全局四类差异键集合恰好等于清单。这是操作端检查，不是接口保证。"""
    expected = set(item["key"] for item in manifest_keys)
    if precheck["truncated"]:
        raise BackfillError(
            "只读全量对账的差异样本被截断，无法确认全局差异集合是否恰好等于清单，已停止，未发送 apply",
            5,
        )
    extras = sorted(precheck["keys"] - expected)
    missing = sorted(expected - precheck["keys"])
    if precheck["diff"] != len(expected) or precheck["keys"] != expected:
        raise BackfillError(
            "只读全量对账的差异集合与清单不完全一致（差异合计 %d，清单 %d；清单外 %s；清单内缺失 %s），已停止，未发送 apply"
            % (
                precheck["diff"],
                len(expected),
                ", ".join(extras[:10]) if extras else "无",
                ", ".join(missing[:10]) if missing else "无",
            ),
            5,
        )


def run_manifest(post, token, manifest_keys, apply):

    """按显式清单发送 verify 或 apply 请求。"""
    body = {"keys": manifest_keys}
    if apply:
        body["apply"] = True
    code, data = post(token, body)
    if code != 200 or not isinstance(data, dict) or not data.get("ok"):
        error = data.get("error") if isinstance(data, dict) else ""
        exit_code = 3 if 400 <= code < 500 else 4
        detail = ""
        if isinstance(data, dict) and isinstance(data.get("mismatches"), list) and data["mismatches"]:
            parts = []
            for item in data["mismatches"][:10]:
                if isinstance(item, dict) and item.get("key") and item.get("category"):
                    parts.append("%s:%s" % (item["category"], item["key"]))
            if parts:
                detail = "（不匹配：%s）" % ", ".join(parts)
        raise BackfillError("接口返回 HTTP %s %s%s" % (code, error or "", detail), exit_code)
    counts = {name: int(value) for name, value in (data.get("counts") or {}).items()}
    samples = {name: list(keys)[:10] for name, keys in (data.get("samples") or {}).items() if isinstance(keys, list)}
    diff = sum(counts.get(name, 0) for name in DIFF_CATEGORIES)
    return {
        "counts": counts,
        "written": int(data.get("written") or 0),
        "diff": diff,
        "samples": samples,
        "scanned": int(data.get("scanned") or 0),
        "scope": "manifest",
    }


def summarize(result):
    counts = {}
    written = 0
    samples = {}
    for sides in result.values():
        for totals in sides.values():
            written += totals["written"]
            for name, value in totals["counts"].items():
                counts[name] = counts.get(name, 0) + value
            for name, keys in totals["samples"].items():
                bucket = samples.setdefault(name, [])
                bucket.extend(k for k in keys if len(bucket) < 10)
    diff = sum(counts.get(name, 0) for name in DIFF_CATEGORIES)
    return {"counts": counts, "written": written, "diff": diff, "samples": samples,
            "per_prefix": {p: {s: {"scanned": t["scanned"], "counts": t["counts"]} for s, t in sides.items()} for p, sides in result.items()}}


def format_report(title, summary):
    lines = [title, "差异合计：%d%s" % (summary["diff"], "（两边一致）" if summary["diff"] == 0 else "")]
    lines.append("读取方式：KV 逐键读取，D1 只 SELECT（per_key_d1_only）")
    for name in ("same", "kv_present", "recent", "gone", "expired_ok", "deleted_ok") + DIFF_CATEGORIES:
        lines.append("  - %s (%s): %d" % (LABELS[name], name, summary["counts"].get(name, 0)))
    if summary["written"]:
        lines.append("本次写入 D1 行数：%d" % summary["written"])
    for name in DIFF_CATEGORIES:
        for key in summary["samples"].get(name, [])[:10]:
            lines.append("      * %s: %s" % (name, key))
    return "\n".join(lines)


def main(argv=None, post=http_post, token_loader=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("mode", choices=("verify", "apply"))
    parser.add_argument("--manifest", metavar="PATH", help="显式 keys+sha256 清单 JSON 文件；apply 模式必填")
    parser.add_argument("--prefix", action="append", help="仅 verify 模式可用：只处理这个前缀（可重复）；默认全部 mirrored 前缀")
    parser.add_argument("--limit", type=int, default=50, help="仅 prefix verify 模式可用：每页键数 1–100，默认 50")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args(argv)
    try:
        if args.mode == "apply" and not args.manifest:
            raise BackfillError("apply 必须指定 --manifest PATH（禁止按前缀扫描写入），未发送任何请求", 5)
        if args.manifest and args.prefix:
            raise BackfillError("--manifest 不能与 --prefix 同时使用", 5)
        if args.limit < 1 or args.limit > 100:
            raise BackfillError("limit 必须在 1–100", 5)
        known = mirrored_prefixes()
        outputs = {}
        if args.manifest:
            manifest_keys = load_manifest(args.manifest, known)
            token = (token_loader or mc.load_token)()
            if args.mode == "apply":
                mc.eprint("先做只读全量前缀对账，确认全局差异集合恰好等于清单后才会发送 apply。接口本身只核对清单内键的存在与哈希，不会因清单外新增差异而拒绝。")
                precheck = sweep_global_diffs(post, token, known, args.limit)
                assert_exact_diff_set(precheck, manifest_keys)
                outputs["exact_diff_precheck"] = {
                    "diff": precheck["diff"],
                    "scanned": precheck["scanned"],
                    "matched": True,
                }
                mc.eprint("将按显式清单写入 D1 kv_mirror（只写 D1，不碰 KV）。站点变量 D1_BACKFILL_ENABLED 不是 true 时接口会拒绝。")
                outputs["apply"] = run_manifest(post, token, manifest_keys, True)
                if not args.json:
                    print(format_report("回填结果", outputs["apply"]))
            final = run_manifest(post, token, manifest_keys, False)
            outputs["verify"] = final
            if args.json:
                print(json.dumps(outputs, ensure_ascii=False, indent=2))
            else:
                print(format_report("对账结果" + ("（回填后复核）" if args.mode == "apply" else ""), final))
            return 0 if final["diff"] == 0 else 1
        prefixes = args.prefix or known
        unknown = [p for p in prefixes if p not in known]
        if unknown:
            raise BackfillError("不在 mirrored 白名单里的前缀：%s" % ", ".join(unknown), 5)
        token = (token_loader or mc.load_token)()
        final = summarize(sweep(post, token, prefixes, args.limit))
        outputs["verify"] = final
        if args.json:
            print(json.dumps(outputs, ensure_ascii=False, indent=2))
        else:
            print(format_report("对账结果", final))
        return 0 if final["diff"] == 0 else 1
    except BackfillError as error:
        sys.stderr.write(str(error) + "\n")
        return error.exit_code
    except mc.ClientError as error:
        sys.stderr.write(str(error) + "\n")
        return error.exit_code


if __name__ == "__main__":
    sys.exit(main())
