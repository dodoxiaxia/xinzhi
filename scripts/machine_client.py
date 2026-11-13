#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""learn.dryz.info 机器下载接口客户端（downloader 角色）。

令牌只从本地文件读取，绝不写入 stdout、stderr、日志或异常信息。
默认令牌路径：~/.config/xinzhi/dsh-downloader.token
可用环境变量 XINZHI_MACHINE_TOKEN_FILE 覆盖。

Cloudflare 会拦截 Python urllib 的默认 UA，本脚本所有 HTTP 请求都走 curl。
上传时原样发送 PDF 字节，不做任何改写。
"""
from __future__ import print_function

import argparse
import csv
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unicodedata
from urllib.parse import quote

WEBSITE = os.environ.get("XINZHI_MACHINE_BASE", "https://learn.dryz.info")
DEFAULT_TOKEN_PATH = os.path.expanduser("~/.config/xinzhi/dsh-downloader.token")
USER_AGENT = "xinzhi-dsh-machine/1.0"
FAILURE_REASONS = (
    "not_oa",
    "han_login",
    "han_quota",
    "source_blocked",
    "wrong_paper",
    "other",
)
STATUS_DETAILS = ("just_accepted",)
STATUS_DETAIL_MAX = 500
PUBLIC_STATES = (
    "to-download",
    "downloading",
    "uploaded-awaiting-verification",
    "done",
    "failed-awaiting-fallback",
    "confirmed-abandoned",
)
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")
REGISTER_MAX_ITEMS = 50
REGISTER_FIELDS = ("doi", "title", "source", "section")
REGISTER_SECTIONS = ("MAIN", "CARDIO")
REGISTER_SOURCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
REGISTER_DOI_RE = re.compile(r"^10\.\d{4,9}/[\x21-\x7e]{1,200}$")
EXIT_OVER_QUOTA = 6
EXIT_REJECTED = 7
EXIT_OVER_QUOTA_AND_REJECTED = 8
MIN_PDF_BYTES = 51200
CURL_TIMEOUT = 60
UPLOAD_TIMEOUT = 180


class ClientError(Exception):
    def __init__(self, message, exit_code=5):
        Exception.__init__(self, message)
        self.exit_code = exit_code


def eprint(*args):
    sys.stderr.write(" ".join(str(a) for a in args) + "\n")


def emit(payload, exit_code=0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return exit_code


def token_path():
    return os.environ.get("XINZHI_MACHINE_TOKEN_FILE") or DEFAULT_TOKEN_PATH


def load_token(require_env=False):
    """读本机令牌文件。require_env=True 时必须显式设置 XINZHI_MACHINE_TOKEN_FILE，不回退到默认路径。"""
    if require_env and not (os.environ.get("XINZHI_MACHINE_TOKEN_FILE") or "").strip():
        raise ClientError("register 必须显式设置环境变量 XINZHI_MACHINE_TOKEN_FILE，指向本机自己的令牌文件；"
                          "不会使用默认路径。未发送任何请求。", 5)
    path = token_path()
    if not os.path.isfile(path):
        raise ClientError("令牌文件不存在：%s" % path, 5)
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        raise ClientError("令牌文件权限过宽（当前 %03o），请改为 600 后再运行：%s" % (mode, path), 5)
    raw = open(path, "rb").read()
    try:
        text = raw.decode("ascii").strip()
    except UnicodeDecodeError:
        raise ClientError("令牌文件不是合法的 ASCII 文本", 5)
    if not TOKEN_RE.fullmatch(text):
        raise ClientError("令牌文件格式不符合接口要求（长度或字符不合法）", 5)
    return text


def check_doi(doi):
    if not doi or not DOI_RE.fullmatch(doi):
        raise ClientError("DOI 格式不合法：%s" % doi, 5)
    return doi


def curl_base(timeout):
    base = [
        "curl", "-sS", "--max-time", str(timeout),
        "-A", USER_AGENT,
    ]
    # Optional per-machine proxy (e.g. Mac mini Shadowrocket 127.0.0.1:1082).
    pf = os.path.expanduser("~/.config/xinzhi/curl_proxy")
    if os.path.isfile(pf):
        px = open(pf).read().strip()
        if px:
            base += ["-x", px]
    return base


def run_curl(args, header_lines, timeout):
    """Run curl. header_lines is a list of 'Name: value'. Token must only appear there.

    Returns (http_code:int, body:str).
    """
    tmpdir = tempfile.mkdtemp(prefix="xinzhi-mch-")
    os.chmod(tmpdir, 0o700)
    hdr_path = os.path.join(tmpdir, "headers")
    body_path = os.path.join(tmpdir, "body")
    resp_hdr_path = os.path.join(tmpdir, "resp-headers")
    try:
        with open(hdr_path, "w") as f:
            os.chmod(hdr_path, 0o600)
            for line in header_lines:
                f.write(line.rstrip("\n") + "\n")
        cmd = curl_base(timeout) + [
            "-D", resp_hdr_path,
            "-o", body_path,
            "-w", "%{http_code}",
            "-H", "@" + hdr_path,
        ] + args
        # --fail-with-body may not exist on older curl (MBP has 8.7.1, OK).
        proc = subprocess.run(cmd, capture_output=True, text=True)
        err = proc.stderr or ""
        # Never print stderr raw in case a proxy debug echoed headers.
        body = ""
        if os.path.isfile(body_path):
            body = open(body_path, "rb").read().decode("utf-8", "replace")
        code_txt = (proc.stdout or "").strip()
        try:
            code = int(code_txt)
        except ValueError:
            code = 0
        if proc.returncode != 0 and code == 0:
            raise ClientError("curl 调用失败（未拿到 HTTP 状态码）", 5)
        return code, body
    finally:
        for name in os.listdir(tmpdir):
            try:
                os.remove(os.path.join(tmpdir, name))
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


def auth_headers(token, extra=None):
    lines = ["Authorization: Bearer %s" % token]
    if extra:
        lines.extend(extra)
    return lines


def parse_json_body(body):
    if not body or not body.strip():
        return None
    try:
        return json.loads(body)
    except ValueError:
        return {"ok": False, "error": "non_json_body", "raw": body[:500]}


def request(method, path, token=None, json_body=None, pdf_path=None, doi=None, timeout=None):
    url = WEBSITE.rstrip("/") + path
    headers = []
    args = ["-X", method, url]
    tmp_json = None
    if token:
        headers = auth_headers(token)
    if json_body is not None:
        fd, tmp_json = tempfile.mkstemp(prefix="xinzhi-mch-json-")
        os.chmod(tmp_json, 0o600)
        os.write(fd, json.dumps(json_body, ensure_ascii=False).encode("utf-8"))
        os.close(fd)
        headers.append("Content-Type: application/json")
        args = ["-X", method, "--data-binary", "@" + tmp_json, url]
    if pdf_path is not None:
        headers.append("Content-Type: application/pdf")
        headers.append("X-Machine-Doi: %s" % doi)
        args = ["-X", method, "--data-binary", "@" + pdf_path, url]
        timeout = timeout or UPLOAD_TIMEOUT
    try:
        code, body = run_curl(args, headers, timeout or CURL_TIMEOUT)
    finally:
        if tmp_json:
            try:
                os.remove(tmp_json)
            except OSError:
                pass
    data = parse_json_body(body)
    return code, data, body


def classify_http(code, data):
    err = ""
    if isinstance(data, dict):
        err = data.get("error") or ""
    payload = data if data is not None else {"ok": False, "http": code}
    if isinstance(payload, dict):
        payload = dict(payload)
        payload["http"] = code
    if code == 200 or code == 202:
        return payload, 0
    if code == 503 and err == "machine_sync_pending":
        eprint("同步未完成（machine_sync_pending）。稍后对同一篇重试，不要另领一篇。")
        return payload, 4
    if 400 <= code < 500:
        return payload, 3
    if code >= 500:
        return payload, 4
    return payload, 5


def cmd_protocol(_args):
    code, data, _body = request("GET", "/api/machine/protocol", token=None)
    payload, rc = classify_http(code, data)
    return emit(payload, 0 if rc == 0 else rc)


def cmd_tasks(args):
    token = load_token()
    limit = args.limit
    if limit > 50:
        raise ClientError("limit 超过上限 50", 5)
    if limit < 1:
        raise ClientError("limit 必须在 1–50", 5)
    if args.state and args.state not in PUBLIC_STATES:
        raise ClientError("未知状态：%s" % args.state, 5)
    tasks = []
    cursor = args.cursor or None
    last = None
    for _page in range(10000):
        q = "?limit=%d" % limit
        if args.state:
            q += "&state=" + quote(args.state, safe="")
        if cursor:
            q += "&cursor=" + quote(str(cursor), safe="")
        code, data, _body = request("GET", "/api/machine/tasks" + q, token=token)
        payload, rc = classify_http(code, data)
        if rc != 0:
            err = payload.get("error") if isinstance(payload, dict) else "-"
            eprint("列表请求失败：HTTP %d  错误码 %s。已停止。" % (code, err or "-"))
            return emit(payload, rc)
        if not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
            raise ClientError("列表响应缺少 tasks，无法继续翻页", 5)
        tasks.extend(data["tasks"])
        last = payload
        cursor = data.get("cursor")
        if cursor is None or cursor == "":
            out = dict(last) if isinstance(last, dict) else {"ok": True}
            out["tasks"] = tasks
            out["cursor"] = None
            out["http"] = code
            return emit(out, 0)
    raise ClientError("列表翻页次数过多，已停止", 5)


def cmd_claim(_args):
    token = load_token()
    code, data, _body = request(
        "POST", "/api/machine/claim", token=token,
        json_body={"state": "to-download"},
    )
    payload, rc = classify_http(code, data)
    if rc == 0 and isinstance(data, dict) and data.get("task") is None:
        eprint("当前没有待下载任务。")
        return emit(payload, 2)
    if rc == 0 and isinstance(data, dict) and data.get("task"):
        task = data["task"]
        claimant = task.get("claimant") or ""
        if claimant and claimant not in ("dsh", "dsh-mini", "dsh-mbp"):
            eprint("警告：领取人不是本机下载端（dsh/dsh-mini/dsh-mbp），而是 %s" % claimant)
        eprint("已领取 %s  租约至 %s" % (task.get("doi") or "", task.get("leaseUntil") or ""))
    return emit(payload, 0 if rc == 0 else rc)


def inspect_pdf(path):
    if not os.path.isfile(path):
        raise ClientError("PDF 不存在：%s" % path, 5)
    size = os.path.getsize(path)
    if size < MIN_PDF_BYTES:
        raise ClientError("PDF 小于接口下限 51200 字节：%s（%d）" % (path, size), 5)
    with open(path, "rb") as f:
        head = f.read(5)
        digest = hashlib.sha256()
        digest.update(head)
        chunk = f.read(1024 * 1024)
        while chunk:
            digest.update(chunk)
            chunk = f.read(1024 * 1024)
    if head != b"%PDF-":
        raise ClientError("文件头不是 %%PDF-，拒绝上传：%s" % path, 5)
    return size, digest.hexdigest()


def cmd_upload(args):
    token = load_token()
    doi = check_doi(args.doi)
    size, sha256 = inspect_pdf(args.pdf)
    eprint("准备原样上传 %s  size=%d  sha256=%s" % (doi, size, sha256))
    code, data, _body = request(
        "PUT", "/api/machine/upload", token=token,
        pdf_path=os.path.abspath(args.pdf), doi=doi,
    )
    payload, rc = classify_http(code, data)
    if rc != 0 and isinstance(data, dict):
        err = data.get("error") or ""
        if err in ("machine_identity", "machine_identity_mismatch"):
            eprint("网站核验读不了这份原件（%s）。停止，不要改 PDF 再传。把上面的 JSON 报告给 ddx。" % err)
    return emit(payload, 0 if rc == 0 else rc)


def cmd_status(args):
    token = load_token()
    doi = check_doi(args.doi)
    if args.reason not in FAILURE_REASONS:
        raise ClientError("reason 不在协议允许范围内：%s" % args.reason, 5)
    body = {
        "doi": doi,
        "state": "failed-awaiting-fallback",
        "reason": args.reason,
    }
    if args.stage:
        if args.stage not in ("han", "yiigle"):
            raise ClientError("stage 只能是 han 或 yiigle", 5)
        body["stage"] = args.stage
    if args.detail is not None:
        if not isinstance(args.detail, str):
            raise ClientError("detail 必须是字符串", 5)
        detail = re.sub(r"[\x00-\x1f\x7f]", "", args.detail).strip()
        if not detail or len(detail) > STATUS_DETAIL_MAX or detail not in STATUS_DETAILS:
            raise ClientError("detail 目前只允许 just_accepted（最长 %d 字，已去除控制字符）" % STATUS_DETAIL_MAX, 5)
        if args.reason != "source_blocked":
            raise ClientError("detail 只允许在 just_accepted 结果下使用（reason 须为 source_blocked）", 5)
        body["detail"] = detail
    code, data, _body = request("POST", "/api/machine/status", token=token, json_body=body)
    payload, rc = classify_http(code, data)
    return emit(payload, 0 if rc == 0 else rc)


def cmd_requeue(args):
    token = load_token()
    if args.execute and args.dry_run:
        raise ClientError("不能同时指定 --dry-run 和 --execute", 5)
    dry_run = not args.execute
    limit = args.limit
    if limit < 1 or limit > 50:
        raise ClientError("limit 必须在 1–50", 5)
    body = {"dryRun": dry_run, "limit": limit}
    if not dry_run:
        eprint("将执行真正的 requeue，会改网站账本。")
    code, data, _body = request("POST", "/api/machine/requeue", token=token, json_body=body)
    payload, rc = classify_http(code, data)
    return emit(payload, 0 if rc == 0 else rc)


def register_doi(value):
    """与网站 libraryDoi 同一套归一化：去 doi.org / doi: 前缀，百分号解码，转小写。"""
    if not isinstance(value, str) or len(value) > 500:
        return ""
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value.strip(), flags=re.I)
    try:
        from urllib.parse import unquote
        doi = unquote(doi, errors="strict")
    except UnicodeDecodeError:
        return ""
    doi = doi.lower()
    if not REGISTER_DOI_RE.fullmatch(doi) or re.search(r"[<>?#@\\]", doi):
        return ""
    return doi


def register_title(value):
    if not isinstance(value, str) or len(value) > 8000:
        return ""
    text = re.sub(r"<[^>]*>", "", value)
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text).strip()
    return text if len(text) <= 800 else ""


def register_title_chars(title):
    """网站 machineNormalize：NFKD、小写、去组合符，只数 0-9、a-z 和非 ASCII 字符。"""
    text = unicodedata.normalize("NFKD", title).lower()
    return len([c for c in text if not 0x300 <= ord(c) <= 0x36f
                and (c.isascii() and c.isalnum() or ord(c) > 127)])


def validate_register_items(raw_items):
    """返回规范化后的条目列表；有任何问题就抛 ClientError（不发请求）。"""
    if not isinstance(raw_items, list) or not raw_items:
        raise ClientError("登记条目为空，至少 1 条", 5)
    if len(raw_items) > REGISTER_MAX_ITEMS:
        raise ClientError("一次最多登记 %d 条，当前 %d 条；请自行拆成多次，本命令不分批、不发请求"
                          % (REGISTER_MAX_ITEMS, len(raw_items)), 5)
    items, problems = [], []
    for idx, raw in enumerate(raw_items, 1):
        if not isinstance(raw, dict):
            problems.append("第 %d 条：不是对象" % idx)
            continue
        extra = sorted(set(raw) - set(REGISTER_FIELDS))
        if extra:
            problems.append("第 %d 条：多余字段 %s（只允许 doi、title、source、section）" % (idx, ",".join(extra)))
            continue
        doi = register_doi(raw.get("doi"))
        title = register_title(raw.get("title"))
        source, section = raw.get("source"), raw.get("section")
        if not doi:
            problems.append("第 %d 条：DOI 不合法" % idx)
        elif not title or register_title_chars(title) < 5:
            problems.append("第 %d 条（%s）：title 缺失、超过 800 字，或归一化后不足 5 个字" % (idx, doi))
        elif not isinstance(source, str) or not REGISTER_SOURCE_RE.fullmatch(source):
            problems.append("第 %d 条（%s）：source 须为 1–64 位字母、数字、. _ -，首字符为字母或数字" % (idx, doi))
        elif not isinstance(section, str) or section not in REGISTER_SECTIONS:
            problems.append("第 %d 条（%s）：section 只能是 MAIN 或 CARDIO（区分大小写）" % (idx, doi))
        else:
            items.append({"doi": doi, "title": title, "source": source, "section": section})
    if problems:
        raise ClientError("登记条目本地校验未通过，未发送任何请求：\n" + "\n".join(problems), 5)
    return items


def read_register_input(path, fmt):
    if path and path != "-":
        if not os.path.isfile(path):
            raise ClientError("输入文件不存在：%s" % path, 5)
        with open(path, "rb") as f:
            data = f.read()
        if fmt == "auto":
            ext = os.path.splitext(path)[1].lower()
            fmt = {".json": "json", ".jsonl": "jsonl", ".ndjson": "jsonl", ".csv": "csv"}.get(ext, "auto")
    else:
        data = sys.stdin.buffer.read()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ClientError("输入不是 UTF-8 文本", 5)
    if not text.strip():
        raise ClientError("输入为空", 5)
    if fmt == "auto":
        head = text.lstrip()[:1]
        fmt = "json" if head == "[" else "jsonl" if head == "{" else "csv"
    try:
        if fmt == "json":
            value = json.loads(text)
            if isinstance(value, dict) and "items" in value:
                if set(value) != {"items"}:
                    raise ClientError("JSON 对象只允许 items 一个字段", 5)
                value = value["items"]
            return value if isinstance(value, list) else [value]
        if fmt == "jsonl":
            rows = []
            for n, line in enumerate(text.splitlines(), 1):
                if line.strip():
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        raise ClientError("JSONL 第 %d 行不是合法 JSON" % n, 5)
            return rows
        reader = csv.DictReader(io.StringIO(text))
        header = [h.strip() for h in (reader.fieldnames or [])]
        reader.fieldnames = header
        missing = [f for f in REGISTER_FIELDS if f not in header]
        if missing:
            raise ClientError("CSV 表头缺少列：%s（表头须含 doi,title,source,section）" % ",".join(missing), 5)
        rows = []
        for row in reader:
            if None in row:
                raise ClientError("CSV 有行的列数多于表头", 5)
            rows.append({k: (v if v is not None else "") for k, v in row.items() if k in header})
        return rows
    except ValueError:
        raise ClientError("输入不是合法的 %s" % fmt.upper(), 5)


def cmd_register(args):
    token = load_token(require_env=True)
    items = validate_register_items(read_register_input(args.file, args.format))
    if args.dry_run:
        eprint("仅本地校验，未发送请求：%d 条通过。" % len(items))
        return emit({"ok": True, "dryRun": True, "items": items}, 0)
    code, data, _body = request("POST", "/api/machine/register", token=token, json_body={"items": items})
    payload = dict(data) if isinstance(data, dict) else {"ok": False}
    payload["http"] = code
    if not 200 <= code < 300:
        err = payload.get("error") or "-"
        eprint("登记失败：HTTP %d  错误码 %s。已停止。" % (code, err))
        emit(payload, 0)
        return 3 if 400 <= code < 500 else 4 if code >= 500 else 5
    results = payload.get("results")
    if not isinstance(results, list):
        eprint("登记响应缺少 results，无法确认结果。")
        emit(payload, 0)
        return 5
    over = rejected = 0
    for item in results:
        res = item.get("result") if isinstance(item, dict) else "?"
        over += res == "over_quota"
        rejected += res == "rejected"
        detail = (item.get("reason") or item.get("error") or "") if isinstance(item, dict) else ""
        eprint("%-12s %s %s" % (res, (item.get("doi") if isinstance(item, dict) else "") or "-", detail))
    quota = payload.get("quota")
    if isinstance(quota, dict):
        eprint("额度：已用 %s / %s，剩余 %s，重置 %s" % (
            quota.get("used"), quota.get("limit"), quota.get("remaining"), quota.get("resetsAt")))
    if over and rejected:
        rc = EXIT_OVER_QUOTA_AND_REJECTED
    elif rejected:
        rc = EXIT_REJECTED
    elif over:
        rc = EXIT_OVER_QUOTA
    else:
        rc = 0
    return emit(payload, rc)


def map_reason(status, channel):
    """把本机台账的 status/channel 映射到协议允许的 reason。"""
    text = " ".join([status or "", channel or ""]).lower()
    if any(k in text for k in ("文不对题", "wrong_paper", "wrong paper", "identity")):
        return "wrong_paper"
    if any(k in text for k in (
        "blocked-channel", "blocked-platform", "blocked", "无可用通道",
        "turnstile", "cpe00001", "付费墙", "get access", "source_blocked",
        "no access", "独立订阅",
    )):
        return "source_blocked"
    if "han_login" in text or "login_required" in text:
        return "han_login"
    if "han_quota" in text or "quota" in text and "han" in text:
        return "han_quota"
    if re.search(r"\bnot_oa\b", text) or "不是开放获取" in text or "is_oa=false" in text:
        # 仅当调用方明确只走 OA 时使用；主路径通道失败不要用这个。
        return "not_oa"
    return "other"


def cmd_map_reason(args):
    reason = map_reason(args.status, args.channel)
    return emit({"reason": reason, "allowed": list(FAILURE_REASONS)}, 0)


def build_parser():
    p = argparse.ArgumentParser(
        description="learn.dryz.info 机器下载接口客户端（downloader）。令牌不会被打印。",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("protocol", help="GET 公开协议（不需要令牌）")

    t = sub.add_parser("tasks", help="GET 任务列表")
    t.add_argument("--state", choices=PUBLIC_STATES)
    t.add_argument("--limit", type=int, default=20)
    t.add_argument("--cursor")

    sub.add_parser("claim", help="领取一篇待下载（不能指定 DOI）")

    u = sub.add_parser("upload", help="原样 PUT 上传 PDF")
    u.add_argument("--doi", required=True)
    u.add_argument("--pdf", required=True)

    s = sub.add_parser("status", help="失败回写 failed-awaiting-fallback")
    s.add_argument("--doi", required=True)
    s.add_argument("--reason", required=True, choices=FAILURE_REASONS)
    s.add_argument("--stage", choices=("han", "yiigle"))
    s.add_argument("--detail", help="可选备注；目前只允许 just_accepted，且仅与 source_blocked 连用")

    r = sub.add_parser("requeue", help="批量重排；默认 dry-run，不改账本")
    r.add_argument("--dry-run", action="store_true", default=False,
                   help="只报告将改哪些（默认就是 dry-run，除非 --execute）")
    r.add_argument("--execute", action="store_true",
                   help="真正写入。验收和日常不要用，除非明确要求。")
    r.add_argument("--limit", type=int, default=20)

    g = sub.add_parser("register", help="登记新 DOI（POST /api/machine/register，一次最多 50 条）")
    g.add_argument("--file", help="输入文件（.json/.jsonl/.csv）；省略或 - 表示读 stdin")
    g.add_argument("--format", choices=("auto", "json", "jsonl", "csv"), default="auto")
    g.add_argument("--dry-run", action="store_true", help="只做本地校验并打印规范化后的条目，不发请求")

    m = sub.add_parser("map-reason", help="把本机台账字段映射为协议 reason")
    m.add_argument("--status", default="")
    m.add_argument("--channel", default="")
    return p


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {
        "protocol": cmd_protocol,
        "tasks": cmd_tasks,
        "claim": cmd_claim,
        "upload": cmd_upload,
        "status": cmd_status,
        "requeue": cmd_requeue,
        "register": cmd_register,
        "map-reason": cmd_map_reason,
    }
    try:
        return handlers[args.cmd](args)
    except ClientError as exc:
        eprint(str(exc))
        return emit({"ok": False, "error": "client_error", "message": str(exc)}, exc.exit_code)
    except KeyboardInterrupt:
        eprint("已中断")
        return 130


if __name__ == "__main__":
    sys.exit(main())
