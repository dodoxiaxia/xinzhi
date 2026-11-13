#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""KV -> D1 kv_mirror 回填与逐键对账客户端（fallback 角色令牌）。

对接 POST /api/machine/d1-backfill（见 docs/机器下载接口.md）。令牌只从本机令牌文件读取
（XINZHI_MACHINE_TOKEN_FILE，沿用 machine_client.py 的做法），不打印、不写入任何输出。

  python3 scripts/d1_backfill_client.py verify            # 只读：逐键对比，输出两边差异（目标 0）
  python3 scripts/d1_backfill_client.py apply             # 回填：先要站点变量 D1_BACKFILL_ENABLED=true，再对账一次
  python3 scripts/d1_backfill_client.py verify --prefix library:muse-job:   # 只对一个前缀

退出码：0 = 差异为 0；1 = 还有差异；3/4/5 = 接口拒绝、服务端错误、本地配置问题（同 machine_client.py）。
没有 Cloudflare 令牌也能用，这是它与 scripts/d1_kv_reconcile.py 的区别；后者在有 Cloudflare 只读令牌时，
可以从站点外独立复核同一件事（两种方式互相印证）。
"""
from __future__ import print_function

import argparse
import json
import os
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


def http_post(token, body):
    code, data, _raw = mc.request("POST", "/api/machine/d1-backfill", token=token, json_body=body)
    return code, data


def run_pass(post, token, prefix, side, apply, limit):
    """一个前缀的一侧走完所有分页，返回合计。"""
    totals = {"scanned": 0, "written": 0, "counts": {}, "samples": {}}
    cursor = ""
    for _ in range(MAX_PAGES):
        body = {"prefix": prefix, "side": side, "limit": limit}
        if apply:
            body["apply"] = True
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


def sweep(post, token, prefixes, apply, limit):
    """所有前缀、两侧各走一遍（KV 侧先，D1 侧后）。返回 {prefix: {side: totals}}。"""
    result = {}
    for prefix in prefixes:
        result[prefix] = {side: run_pass(post, token, prefix, side, apply, limit) for side in SIDES}
    return result


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
    parser.add_argument("--prefix", action="append", help="只处理这个前缀（可重复）；默认 d1/shadow_prefixes.json 里全部 mirrored 前缀")
    parser.add_argument("--limit", type=int, default=50, help="每页键数 1–100，默认 50")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args(argv)
    try:
        if args.limit < 1 or args.limit > 100:
            raise BackfillError("limit 必须在 1–100", 5)
        known = mirrored_prefixes()
        prefixes = args.prefix or known
        unknown = [p for p in prefixes if p not in known]
        if unknown:
            raise BackfillError("不在 mirrored 白名单里的前缀：%s" % ", ".join(unknown), 5)
        token = (token_loader or mc.load_token)()
        outputs = {}
        if args.mode == "apply":
            mc.eprint("将写入 D1 kv_mirror（只写 D1，不碰 KV）。站点变量 D1_BACKFILL_ENABLED 不是 true 时接口会拒绝。")
            outputs["apply"] = summarize(sweep(post, token, prefixes, True, args.limit))
            if not args.json:
                print(format_report("回填结果", outputs["apply"]))
        final = summarize(sweep(post, token, prefixes, False, args.limit))
        outputs["verify"] = final
        if args.json:
            print(json.dumps(outputs, ensure_ascii=False, indent=2))
        else:
            print(format_report("对账结果" + ("（回填后复核）" if args.mode == "apply" else ""), final))
        return 0 if final["diff"] == 0 else 1
    except BackfillError as error:
        sys.stderr.write(str(error) + "\n")
        return error.exit_code
    except mc.ClientError as error:
        sys.stderr.write(str(error) + "\n")
        return error.exit_code


if __name__ == "__main__":
    sys.exit(main())
