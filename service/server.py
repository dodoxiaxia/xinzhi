"""
心知 (Xinzhi) - 本地知识服务后端
Python 3.9+ 标准库与 SQLite 实现。
功能：
- 严格显式静态资源白名单与防路径穿越、防符号链接检测
- 单编辑账号鉴权、防爆破限流、常量时间比对、HttpOnly 会话与 CSRF 防护
- 候选文章编辑、审核发布、即时撤回、独立内部共读笔记存储
- 公开读取层严格白名单过滤，永不泄露内部字段
"""

from __future__ import annotations

import argparse
import html
import http.cookies
import http.server
import json
import mimetypes
import os
import posixpath
import re
import socketserver
import sys
import threading
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# 引入本模块的 db 与 auth 工具
try:
    from .auth import (
        DEFAULT_TOKEN_FILE,
        LoginRateLimiter,
        create_session,
        get_or_init_admin_token,
        get_session,
        revoke_session,
        verify_admin_token,
    )
    from .db import (
        ALLOWED_EVIDENCE_BASIS,
        BASE_DIR,
        DEFAULT_DB_PATH,
        DEFAULT_LOCAL_DIR,
        EDITABLE_ARTICLE_FIELDS,
        add_audit_log,
        get_db_connection,
        get_shanghai_date_str,
        get_shanghai_iso_str,
        init_db,
        sanitize_public_article,
    )
except ImportError:
    current_dir = Path(__file__).resolve().parent
    sys.path.insert(0, str(current_dir.parent))
    from service.auth import (
        DEFAULT_TOKEN_FILE,
        LoginRateLimiter,
        create_session,
        get_or_init_admin_token,
        get_session,
        revoke_session,
        verify_admin_token,
    )
    from service.db import (
        ALLOWED_EVIDENCE_BASIS,
        BASE_DIR,
        DEFAULT_DB_PATH,
        DEFAULT_LOCAL_DIR,
        EDITABLE_ARTICLE_FIELDS,
        add_audit_log,
        get_db_connection,
        get_shanghai_date_str,
        get_shanghai_iso_str,
        init_db,
        sanitize_public_article,
    )

MAX_BODY_SIZE = 1024 * 1024  # 1MB 请求体限制
GITHUB_LIBRARY_MAX_LIMIT = 100


def github_library_relative_path(value: Any) -> str:
    """Expose only repository-relative references, never local filesystem paths."""
    if not isinstance(value, str) or not value or len(value) > 2000:
        return ""
    if value.startswith("/") or "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value) or re.match(r"^[A-Za-z]:", value):
        return ""
    if any(part in ("", ".", "..") for part in value.split("/")):
        return ""
    return value


def github_library_text(value: Any, length: int = 2000) -> str:
    return value[:length] if isinstance(value, str) else ""

# 默认绑定回环地址集合
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "127.0.1.1"}

# 全局限流器实例
rate_limiter = LoginRateLimiter(max_attempts=5, window_seconds=60.0)


class XinzhiRequestHandler(http.server.BaseHTTPRequestHandler):
    """心知服务 HTTP 请求处理类"""

    server_version = "XinzhiServer/1.0"

    def __init__(self, *args, **kwargs):
        # 提取应用配置
        super().__init__(*args, **kwargs)

    @property
    def db_conn(self):
        return self.server.db_conn

    @property
    def admin_token(self) -> str:
        return self.server.admin_token

    @property
    def static_base_dir(self) -> Path:
        return self.server.static_base_dir

    def log_message(self, format: str, *args: Any) -> None:
        """格式化请求日志，绝不记录敏感查询字符串或 Cookie"""
        client_ip = self.client_address[0]
        now = get_shanghai_iso_str()
        sys.stderr.write(f"[{now}] {client_ip} - {self.command} {urllib.parse.urlsplit(self.path).path}\n")

    def send_json(self, status_code: int, data: Any, extra_headers: Optional[Dict[str, str]] = None) -> None:
        """发送 JSON 响应"""
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def send_error_json(self, status_code: int, message: str, details: Optional[Any] = None) -> None:
        """发送结构化错误响应"""
        res = {"error": message}
        if details is not None:
            res["details"] = details
        self.send_json(status_code, res)

    def read_json_body(self) -> Optional[Dict[str, Any]]:
        """读取并解析 JSON 请求体，强制执行 1MB 长度限制"""
        content_length_str = self.headers.get("Content-Length", "0")
        try:
            content_length = int(content_length_str)
        except ValueError:
            self.send_error_json(400, "非法的 Content-Length")
            return None

        if content_length > MAX_BODY_SIZE:
            self.close_connection = True
            self.connection.settimeout(0.5)
            try:
                self.rfile.read(min(content_length, 2 * MAX_BODY_SIZE))
            except (OSError, TimeoutError):
                pass
            self.send_json(413, {"error": "请求体超过 1MB 限制"}, extra_headers={"Connection": "close"})
            return None

        if content_length <= 0:
            return {}

        raw_body = self.rfile.read(content_length)
        try:
            value = json.loads(raw_body.decode("utf-8"))
            if not isinstance(value, dict):
                self.send_error_json(400, "JSON 必须为对象")
                return None
            return value
        except Exception as e:
            self.send_error_json(400, f"JSON 解析失败: {str(e)}")
            return None

    def get_cookie(self, name: str) -> Optional[str]:
        """解析指定 Cookie"""
        cookie_header = self.headers.get("Cookie")
        if not cookie_header:
            return None
        cookie = http.cookies.SimpleCookie()
        try:
            cookie.load(cookie_header)
        except Exception:
            return None
        morsel = cookie.get(name)
        return morsel.value if morsel else None

    def get_authenticated_session(self) -> Optional[Dict[str, Any]]:
        """验证会话 Cookie 并返回会话记录；绝不信任 X-User 等伪造头"""
        session_token = self.get_cookie("xinzhi_session")
        if not session_token:
            return None
        return get_session(self.db_conn, session_token)

    def check_csrf(self, session: Optional[Dict[str, Any]] = None) -> bool:
        """
        验证 CSRF 保护：
        1. 检查 Origin 头（若存在），必须与本地服务地址匹配；
        2. 若为已登录编辑接口的写操作，还需校验请求头 X-CSRF-Token 与 session['csrf_token'] 的一致性。
        """
        origin = self.headers.get("Origin")
        if origin:
            try:
                parsed_origin = urllib.parse.urlparse(origin)
                if parsed_origin.scheme not in ("http", "https"):
                    return False
                origin_host = parsed_origin.hostname or ""
                origin_port = parsed_origin.port or (443 if parsed_origin.scheme == "https" else 80)
            except ValueError:
                return False

            # 允许的回环域名或当前绑定地址
            server_host = self.server.server_address[0]
            server_port = self.server.server_address[1]

            allowed_hosts = {"127.0.0.1", "localhost", "::1", server_host}
            if origin_host not in allowed_hosts or origin_port != server_port:
                return False

        if session:
            csrf_token_header = self.headers.get("X-CSRF-Token", "").strip()
            session_csrf = session.get("csrf_token", "")
            if not csrf_token_header or not session_csrf:
                return False
            import hmac
            if not hmac.compare_digest(csrf_token_header, session_csrf):
                return False

        return True

    # ==========================
    # HTTP Method Handlers
    # ==========================

    def do_OPTIONS(self) -> None:
        """处理预检请求"""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self) -> None:
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        query = urllib.parse.parse_qs(parsed_url.query)

        # 1. API 路由处理
        if path.startswith("/api/"):
            self.handle_api_get(path, query)
            return

        # 2. 静态白名单文件处理
        self.handle_static_file(path)

    def do_POST(self) -> None:
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        if path.startswith("/api/"):
            self.handle_api_post(path)
            return

        self.send_error_json(404, "接口不存在")

    def do_PATCH(self) -> None:
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        if path.startswith("/api/"):
            self.handle_api_patch(path)
            return

        self.send_error_json(404, "接口不存在")

    def do_PUT(self) -> None:
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        if path.startswith("/api/"):
            self.handle_api_put(path)
            return

        self.send_error_json(404, "接口不存在")

    def do_DELETE(self) -> None:
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        if path.startswith("/api/"):
            self.handle_api_delete(path)
            return

        self.send_error_json(404, "接口不存在")

    # ==========================
    # Static Files with Whitelist
    # ==========================

    def handle_static_file(self, raw_path: str) -> None:
        """
        静态文件严格白名单服务：
        仅允许访问：
        1. 根文件：/ -> index.html, /index.html, /style.css, /icon.svg
        2. /public/ 目录下的非目录文件
        3. /editor/ 目录下的非目录文件（/editor 或 /editor/ 映射为 /editor/index.html）

        严禁通过 URL 访问 data、scripts、docs、service、.local、父目录(..)或符号链接目标。
        """
        # 路径穿越防御：拒绝包含 .. 或空字符的请求
        if ".." in raw_path:
            self.send_error_json(403, "禁止路径穿越访问")
            return

        decoded_path = urllib.parse.unquote(raw_path)
        if "\0" in decoded_path or ".." in decoded_path:
            self.send_error_json(403, "路径包含非法字符或穿越序列")
            return

        norm_path = posixpath.normpath(decoded_path)
        if norm_path.startswith("../") or "/../" in norm_path or norm_path == "..":
            self.send_error_json(403, "禁止路径穿越访问")
            return

        # 检查是否触碰禁止目录或隐藏文件
        parts = [p for p in norm_path.strip("/").split("/") if p]
        forbidden_dirs = {"data", "scripts", "docs", "service", ".local"}
        for part in parts:
            if part in forbidden_dirs or part.startswith("."):
                self.send_error_json(403, f"禁止访问受保护目录或文件: {part}")
                return

        # 白名单映射
        target_file: Optional[Path] = None

        if norm_path in ("/", "/index.html"):
            target_file = self.static_base_dir / "index.html"
        elif norm_path == "/style.css":
            target_file = self.static_base_dir / "style.css"
        elif norm_path == "/icon.svg":
            target_file = self.static_base_dir / "icon.svg"
        elif norm_path in ("/editor", "/editor/"):
            target_file = self.static_base_dir / "editor" / "index.html"
        elif norm_path.startswith("/editor/"):
            rel_sub = norm_path[len("/editor/") :]
            target_file = (self.static_base_dir / "editor" / rel_sub).resolve()
            # 必须在 editor 目录内
            if not str(target_file).startswith(str((self.static_base_dir / "editor").resolve())):
                self.send_error_json(403, "禁止超出编辑端目录")
                return
        elif norm_path in ("/public", "/public/"):
            target_file = self.static_base_dir / "public" / "index.html"
        elif norm_path.startswith("/public/"):
            rel_sub = norm_path[len("/public/") :]
            target_file = (self.static_base_dir / "public" / rel_sub).resolve()
            # 必须在 public 目录内
            if not str(target_file).startswith(str((self.static_base_dir / "public").resolve())):
                self.send_error_json(403, "禁止超出公开端目录")
                return
        else:
            self.send_error_json(404, "文件未在静态白名单中")
            return

        if not target_file or not target_file.exists() or target_file.is_dir():
            self.send_error_json(404, "文件不存在")
            return

        # 符号链接与根目录边界防御
        curr = target_file
        while curr != self.static_base_dir and curr != curr.parent:
            if curr.is_symlink():
                self.send_error_json(403, "禁止访问符号链接文件或目录")
                return
            curr = curr.parent

        resolved_target = target_file.resolve()
        resolved_base = self.static_base_dir.resolve()
        try:
            rel_to_base = resolved_target.relative_to(resolved_base)
        except ValueError:
            self.send_error_json(403, "禁止超出静态根目录")
            return

        for part in rel_to_base.parts:
            if part in forbidden_dirs or part.startswith("."):
                self.send_error_json(403, f"禁止访问受保护目录或文件: {part}")
                return

        # 确定 MIME 类型
        mime_type, _ = mimetypes.guess_type(str(target_file))
        if not mime_type:
            mime_type = "application/octet-stream"
        if mime_type.startswith("text/") or mime_type in ("application/javascript", "application/json"):
            mime_type += "; charset=utf-8"

        try:
            content = target_file.read_bytes()
        except Exception as e:
            self.send_error_json(500, f"读取文件失败: {str(e)}")
            return

        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        # 缓存控制：本地编辑端协商无缓存
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    # ==========================
    # API Routers
    # ==========================

    def handle_api_get(self, path: str, query: Dict[str, List[str]]) -> None:
        """处理所有 GET API 请求"""
        # --- 公开接口 (无需鉴权) ---
        if path == "/api/public/articles":
            self.api_get_public_articles()
            return
        if path == "/api/public/briefings":
            date_str = query.get("date", [get_shanghai_date_str()])[0]
            self.api_get_public_briefings(date_str)
            return
        if path.startswith("/api/public/"):
            self.send_error_json(404, "公开接口不存在")
            return

        # --- 编辑接口 (除 session 查询外需登录鉴权) ---
        if path == "/api/editor/session":
            session = self.get_authenticated_session()
            if session:
                self.send_json(200, {"authenticated": True, "csrf_token": session["csrf_token"]})
            else:
                self.send_json(200, {"authenticated": False})
            return

        # 其余编辑端 GET 均需已登录会话
        session = self.get_authenticated_session()
        if not session:
            self.send_error_json(401, "请先登录编辑端")
            return

        if path == "/api/editor/github-library":
            self.api_get_editor_github_library(query)
            return

        if path == "/api/editor/articles":
            status_filter = query.get("status", ["all"])[0]
            search_query = query.get("search", [""])[0]
            category_filter = query.get("category", ["all"])[0]
            try:
                page = int(query.get("page", ["1"])[0])
                page_size = int(query.get("page_size", ["50"])[0])
            except ValueError:
                self.send_error_json(400, "分页参数必须为整数")
                return
            self.api_get_editor_articles(status_filter, search_query, category_filter, page, page_size)
            return

        article_match = re.match(r"^/api/editor/articles/([^/]+)$", path)
        if article_match:
            art_id = article_match.group(1)
            self.api_get_editor_article_by_id(art_id)
            return

        if path == "/api/editor/notes":
            self.api_get_editor_notes()
            return

        note_match = re.match(r"^/api/editor/notes/([^/]+)$", path)
        if note_match:
            note_key = note_match.group(1)
            self.api_get_editor_note_by_key(note_key)
            return

        self.send_error_json(404, "接口不存在")

    def api_get_editor_github_library(self, query: Dict[str, List[str]]) -> None:
        """Authenticated downstream view of an existing private index; no sync/download."""
        try:
            requested_limit = int(query.get("limit", ["20"])[0])
        except ValueError:
            self.send_error_json(400, "limit 必须为整数")
            return
        if requested_limit < 1:
            self.send_error_json(400, "limit 必须大于零")
            return
        limit = min(requested_limit, GITHUB_LIBRARY_MAX_LIMIT)
        search_query = query.get("q", [""])[0].strip()
        if len(search_query) > 500:
            self.send_error_json(400, "检索词过长，请缩短至 500 字以内")
            return

        headers = {"Cache-Control": "no-store"}
        try:
            # This module's snapshot loader/searcher are entirely local and read-only.
            from scripts.github_library import load_snapshot, search_snapshot
            snapshot = load_snapshot(root=self.static_base_dir)
            if snapshot is None:
                self.send_json(200, {
                    "available": False, "status": "needs_sync", "repository": {"full_name": "dodoxiaxia/AI-"},
                    "message": "还没有可检索的文献库索引，请先完成文献库索引更新。本页不会自行更新。",
                    "source_rows": 0, "returned_count": 0, "limit": limit, "items": [],
                }, extra_headers=headers)
                return
            matches = search_snapshot(snapshot, search_query, limit=limit)
        except (ValueError, OSError, ImportError):
            # Do not serialize exception text: it may contain a private cache path.
            self.send_json(503, {
                "available": False, "status": "snapshot_unavailable",
                "error": "文献库索引暂不可用，请检查文献库维护流程。本页不会自行更新。",
            }, extra_headers=headers)
            return

        repository = snapshot.get("repository") or {}
        repo_name = github_library_text(repository.get("full_name"), 200)
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo_name):
            repo_name = ""
        snapshot_meta = snapshot.get("snapshot") or {}
        commit = github_library_text(snapshot_meta.get("commit"), 64)
        if not re.fullmatch(r"[0-9a-fA-F]{7,64}", commit):
            commit = ""
        items = [{
            "id": github_library_text(p.get("id"), 128),
            "title": github_library_text(p.get("title")),
            "journal": github_library_text(p.get("journal"), 400),
            "doi": github_library_text(p.get("doi"), 400),
            "source_date": github_library_text(p.get("date"), 100),
            "date_basis": github_library_text(p.get("date_basis"), 400),
            "relative_path": github_library_relative_path(p.get("repo_path")),
            "pdf_sha256_status": p.get("pdf_sha256_status") if p.get("pdf_sha256_status") in ("valid", "missing", "invalid") else "missing",
        } for p in matches[:limit]]
        checksum_counts = {status: sum(p.get("pdf_sha256_status") == status for p in snapshot.get("papers", []))
                           for status in ("valid", "missing", "invalid")}
        self.send_json(200, {
            "available": True, "status": "ready",
            "repository": {"full_name": repo_name, "visibility": "private"},
            "snapshot": {
                "commit": commit,
                "indexed_at": github_library_text(snapshot_meta.get("indexed_at"), 100),
                "index_path": github_library_relative_path(snapshot_meta.get("index_path")),
            },
            "source_rows": snapshot.get("source_rows", 0),
            "checksum_counts": checksum_counts,
            "returned_count": len(items), "limit": limit, "items": items,
            "notice": "仅为私有文献库索引元数据，不代表已经下载或阅读全文；相对路径供后续获授权的后台取全文使用。",
        }, extra_headers=headers)

    def handle_api_post(self, path: str) -> None:
        """处理所有 POST API 请求"""
        client_ip = self.client_address[0]

        # 1. 登录接口 (无需会话，但需要 Origin 与限流校验)
        if path == "/api/editor/login":
            if not self.check_csrf(None):
                self.send_error_json(403, "CSRF Origin 校验未通过")
                return

            if rate_limiter.is_blocked(client_ip):
                add_audit_log(self.db_conn, "login_rate_limited", ip=client_ip)
                self.send_error_json(429, "登录失败次数过多，请等待 60 秒后再试")
                return

            body = self.read_json_body()
            if body is None:
                return

            input_token = str(body.get("token", "")).strip()
            if not verify_admin_token(input_token, self.admin_token):
                rate_limiter.record_failure(client_ip)
                add_audit_log(self.db_conn, "login_failed", ip=client_ip)
                self.send_error_json(401, "管理员口令错误")
                return

            # 登录成功
            rate_limiter.record_success(client_ip)
            session_token, csrf_token = create_session(self.db_conn)
            add_audit_log(self.db_conn, "login_success", ip=client_ip)

            # 设置 HttpOnly SameSite=Strict Cookie（明确提示：本地 HTTP 适用，上线需 HTTPS 与 Secure）
            cookie_val = f"xinzhi_session={session_token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400"
            self.send_json(
                200,
                {
                    "ok": True,
                    "message": "登录成功",
                    "csrf_token": csrf_token,
                    "notice": "单编辑账号本地版，尚未接入Google Workspace。生产环境需升级为 HTTPS 与 Secure Cookie。",
                },
                extra_headers={"Set-Cookie": cookie_val},
            )
            return

        # 2. 登出接口
        if path == "/api/editor/logout":
            session = self.get_authenticated_session()
            if not self.check_csrf(session):
                self.send_error_json(403, "CSRF 校验失败")
                return
            if session:
                revoke_session(self.db_conn, session["token"])
                add_audit_log(self.db_conn, "logout", ip=client_ip)
            clear_cookie = "xinzhi_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
            self.send_json(200, {"ok": True, "message": "已退出登录"}, extra_headers={"Set-Cookie": clear_cookie})
            return

        # 3. 需鉴权与 CSRF 保护的 POST 接口
        session = self.get_authenticated_session()
        if not session:
            self.send_error_json(401, "请先登录编辑端")
            return

        if not self.check_csrf(session):
            self.send_error_json(403, "CSRF 校验失败")
            return

        publish_match = re.match(r"^/api/editor/articles/([^/]+)/publish$", path)
        if publish_match:
            art_id = publish_match.group(1)
            self.api_post_publish_article(art_id, client_ip)
            return

        withdraw_match = re.match(r"^/api/editor/articles/([^/]+)/withdraw$", path)
        if withdraw_match:
            art_id = withdraw_match.group(1)
            self.api_post_withdraw_article(art_id, client_ip)
            return

        self.send_error_json(404, "接口不存在")

    def handle_api_patch(self, path: str) -> None:
        """处理所有 PATCH API 请求"""
        session = self.get_authenticated_session()
        if not session:
            self.send_error_json(401, "请先登录编辑端")
            return

        if not self.check_csrf(session):
            self.send_error_json(403, "CSRF 校验失败")
            return

        article_match = re.match(r"^/api/editor/articles/([^/]+)$", path)
        if article_match:
            art_id = article_match.group(1)
            self.api_patch_article(art_id, self.client_address[0])
            return

        self.send_error_json(404, "接口不存在")

    def handle_api_put(self, path: str) -> None:
        """处理所有 PUT API 请求"""
        session = self.get_authenticated_session()
        if not session:
            self.send_error_json(401, "请先登录编辑端")
            return

        if not self.check_csrf(session):
            self.send_error_json(403, "CSRF 校验失败")
            return

        note_match = re.match(r"^/api/editor/notes/([^/]+)$", path)
        if note_match:
            note_key = note_match.group(1)
            self.api_put_note(note_key, self.client_address[0])
            return

        self.send_error_json(404, "接口不存在")

    def handle_api_delete(self, path: str) -> None:
        """处理 DELETE 请求"""
        self.send_error_json(405, "Method Not Allowed")

    # ==========================
    # API Implementation Logic
    # ==========================

    def api_get_public_articles(self) -> None:
        """GET /api/public/articles：获取所有已发布文章，按日期降序，严格白名单字段过滤"""
        cur = self.db_conn.cursor()
        cur.execute(
            """
            SELECT * FROM articles
            WHERE status = 'published'
            ORDER BY published_date DESC, updated_at DESC
            """
        )
        rows = cur.fetchall()
        sanitized = [sanitize_public_article(r) for r in rows]
        self.send_json(200, {"count": len(sanitized), "items": sanitized})

    def api_get_public_briefings(self, target_date: str) -> None:
        """GET /api/public/briefings?date=YYYY-MM-DD：获取指定日期已发布文章，严格白名单字段过滤"""
        cur = self.db_conn.cursor()
        cur.execute(
            """
            SELECT * FROM articles
            WHERE status = 'published' AND published_date = ?
            ORDER BY id DESC
            """,
            (target_date,),
        )
        rows = cur.fetchall()
        sanitized = [sanitize_public_article(r) for r in rows]
        self.send_json(200, {"date": target_date, "count": len(sanitized), "items": sanitized})

    def api_get_editor_articles(
        self, status_filter: str, search: str, category: str, page: int, page_size: int
    ) -> None:
        """GET /api/editor/articles：编辑端候选列表（支持状态、搜索与分类过滤）"""
        cur = self.db_conn.cursor()
        clauses = []
        params = []

        if status_filter != "all":
            clauses.append("status = ?")
            params.append(status_filter)

        if category != "all":
            clauses.append("category = ?")
            params.append(category)

        if search.strip():
            kw = f"%{search.strip()}%"
            clauses.append("(title LIKE ? OR title_zh LIKE ? OR source LIKE ? OR doi LIKE ?)")
            params.extend([kw, kw, kw, kw])

        where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""

        # 统计总数
        count_sql = f"SELECT COUNT(*) as total FROM articles {where_sql}"
        cur.execute(count_sql, params)
        total = cur.fetchone()["total"]

        # 分页获取
        limit = max(1, min(page_size, 200))
        offset = max(0, (page - 1) * limit)

        query_sql = f"""
            SELECT * FROM articles
            {where_sql}
            ORDER BY source_date DESC, id DESC
            LIMIT ? OFFSET ?
        """
        cur.execute(query_sql, params + [limit, offset])
        rows = cur.fetchall()

        self.send_json(
            200,
            {
                "total": total,
                "page": page,
                "page_size": limit,
                "items": rows,
            },
        )

    def api_get_editor_article_by_id(self, art_id: str) -> None:
        """GET /api/editor/articles/:id"""
        cur = self.db_conn.cursor()
        cur.execute("SELECT * FROM articles WHERE id = ?", (art_id,))
        row = cur.fetchone()
        if not row:
            self.send_error_json(404, "文章不存在")
            return
        self.send_json(200, {"article": row})

    def api_patch_article(self, art_id: str, client_ip: str) -> None:
        """
        PATCH /api/editor/articles/:id
        仅允许修改：title_zh, summary, limitations, study_type, evidence_basis, reviewer, source_checked
        严格保留原 title/url/source_date/source，禁止越权修改
        """
        body = self.read_json_body()
        if body is None:
            return

        cur = self.db_conn.cursor()
        cur.execute("SELECT * FROM articles WHERE id = ?", (art_id,))
        article = cur.fetchone()
        if not article:
            self.send_error_json(404, "文章不存在")
            return

        updates = []
        params = []
        audit_details = {}

        for field in EDITABLE_ARTICLE_FIELDS:
            if field in body:
                val = body[field]
                if field == "evidence_basis":
                    if val not in ALLOWED_EVIDENCE_BASIS:
                        self.send_error_json(
                            400,
                            f"证据依据类型不合法，必须为 {ALLOWED_EVIDENCE_BASIS} 之一",
                        )
                        return
                elif field == "source_checked":
                    val = 1 if bool(val) else 0

                updates.append(f"{field} = ?")
                params.append(val)
                audit_details[field] = val

        if not updates:
            self.send_error_json(400, "未提供可更新的字段")
            return

        now_iso = get_shanghai_iso_str()
        updates.append("updated_at = ?")
        params.append(now_iso)

        # 若原状态为 candidate，编辑保存后转为 draft（已发布/已撤回状态保持原样）
        if article["status"] == "candidate":
            updates.append("status = 'draft'")
            audit_details["status"] = "draft"

        params.append(art_id)
        sql = f"UPDATE articles SET {', '.join(updates)} WHERE id = ?"

        with self.db_conn:
            cur.execute(sql, params)
            add_audit_log(
                self.db_conn,
                action="edit_article",
                target_id=art_id,
                details=audit_details,
                ip=client_ip,
            )

        cur.execute("SELECT * FROM articles WHERE id = ?", (art_id,))
        updated_article = cur.fetchone()
        self.send_json(200, {"ok": True, "article": updated_article})

    def api_post_publish_article(self, art_id: str, client_ip: str) -> None:
        """
        POST /api/editor/articles/:id/publish
        发布校验门禁：
        1. title_zh, summary, limitations, reviewer 均非空
        2. source_checked == 1 (已勾选来源核对)
        3. evidence_basis 不能为 'index' (必须为 'abstract' 或 'fulltext')
        发布成功后写入当前 Asia/Shanghai 日期 YYYY-MM-DD
        """
        cur = self.db_conn.cursor()
        cur.execute("SELECT * FROM articles WHERE id = ?", (art_id,))
        article = cur.fetchone()
        if not article:
            self.send_error_json(404, "文章不存在")
            return

        errors = []
        if not str(article["title_zh"]).strip():
            errors.append("中文标题 (title_zh) 不能为空")
        if not str(article["summary"]).strip():
            errors.append("核心导读/摘要 (summary) 不能为空")
        if not str(article["limitations"]).strip():
            errors.append("局限性与警示 (limitations) 不能为空")
        if not str(article["reviewer"]).strip():
            errors.append("审核人 (reviewer) 不能为空")
        if not article["source_checked"]:
            errors.append("必须勾选并确认已完成来源核对 (source_checked)")
        if article["evidence_basis"] == "index":
            errors.append("证据依据不能仅为索引元数据 (index)，必须核对摘要 (abstract) 或精读全文 (fulltext)")

        if errors:
            self.send_error_json(400, "发布门禁校验未通过", details=errors)
            return

        today_date = get_shanghai_date_str()
        now_iso = get_shanghai_iso_str()

        with self.db_conn:
            cur.execute(
                """
                UPDATE articles
                SET status = 'published',
                    published_date = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (today_date, now_iso, art_id),
            )
            add_audit_log(
                self.db_conn,
                action="publish_article",
                target_id=art_id,
                details={"published_date": today_date},
                ip=client_ip,
            )

        cur.execute("SELECT * FROM articles WHERE id = ?", (art_id,))
        published_article = cur.fetchone()
        self.send_json(200, {"ok": True, "article": published_article})

    def api_post_withdraw_article(self, art_id: str, client_ip: str) -> None:
        """
        POST /api/editor/articles/:id/withdraw
        撤回文章：立即更新 status 为 'withdrawn'，公开接口立即不可见
        """
        cur = self.db_conn.cursor()
        cur.execute("SELECT * FROM articles WHERE id = ?", (art_id,))
        article = cur.fetchone()
        if not article:
            self.send_error_json(404, "文章不存在")
            return

        now_iso = get_shanghai_iso_str()
        with self.db_conn:
            cur.execute(
                """
                UPDATE articles
                SET status = 'withdrawn',
                    updated_at = ?
                WHERE id = ?
                """,
                (now_iso, art_id),
            )
            add_audit_log(
                self.db_conn,
                action="withdraw_article",
                target_id=art_id,
                ip=client_ip,
            )

        cur.execute("SELECT * FROM articles WHERE id = ?", (art_id,))
        withdrawn_article = cur.fetchone()
        self.send_json(200, {"ok": True, "article": withdrawn_article})

    def api_get_editor_notes(self) -> None:
        """GET /api/editor/notes：获取内部共读记录列表（绝不公开）"""
        cur = self.db_conn.cursor()
        cur.execute("SELECT * FROM notes ORDER BY updated_at DESC")
        rows = cur.fetchall()
        self.send_json(200, {"notes": rows})

    def api_get_editor_note_by_key(self, note_key: str) -> None:
        """GET /api/editor/notes/:key：根据 key 获取单篇内部笔记"""
        cur = self.db_conn.cursor()
        cur.execute("SELECT * FROM notes WHERE key = ?", (note_key,))
        row = cur.fetchone()
        if not row:
            self.send_json(200, {"note": {"key": note_key, "title": "", "content": "", "reviewer": ""}})
            return
        self.send_json(200, {"note": row})

    def api_put_note(self, note_key: str, client_ip: str) -> None:
        """
        PUT /api/editor/notes/:key
        保存/更新内部共读记录（key 保持稳定，公开层绝不返回）
        """
        if not re.match(r"^[a-zA-Z0-9_\-\.]+$", note_key):
            self.send_error_json(400, "Note key 格式不合法，仅限字母、数字、点与下划线中划线")
            return

        body = self.read_json_body()
        if body is None:
            return

        title = str(body.get("title", "")).strip()
        content = str(body.get("content", "")).strip()
        reviewer = str(body.get("reviewer", "")).strip()
        now_iso = get_shanghai_iso_str()

        with self.db_conn:
            self.db_conn.execute(
                """
                INSERT INTO notes (key, title, content, reviewer, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    title = excluded.title,
                    content = excluded.content,
                    reviewer = excluded.reviewer,
                    updated_at = excluded.updated_at
                """,
                (note_key, title, content, reviewer, now_iso),
            )
            add_audit_log(
                self.db_conn,
                action="save_note",
                target_id=note_key,
                details={"title": title, "reviewer": reviewer},
                ip=client_ip,
            )

        cur = self.db_conn.cursor()
        cur.execute("SELECT * FROM notes WHERE key = ?", (note_key,))
        saved = cur.fetchone()
        self.send_json(200, {"ok": True, "note": saved})


class ThreadedXinzhiServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """支持多线程并发请求的 HTTP 服务器"""

    daemon_threads = True

    def process_request_thread(self, request, client_address):
        # Shared SQLite connection: serialize full requests to preserve transaction boundaries.
        request.settimeout(15)
        with self.request_lock:
            super().process_request_thread(request, client_address)

    def __init__(
        self,
        server_address: Tuple[str, int],
        db_conn,
        admin_token: str,
        static_base_dir: Path,
    ):
        self.request_lock = threading.RLock()
        super().__init__(server_address, XinzhiRequestHandler)
        self.db_conn = db_conn
        self.admin_token = admin_token
        self.static_base_dir = static_base_dir


def run_server(
    port: int = 8766,
    bind: str = "127.0.0.1",
    allow_network: bool = False,
    data_dir: Optional[Path | str] = None,
    static_dir: Optional[Path | str] = None,
) -> None:
    """启动本地知识服务"""
    local_dir = Path(data_dir) if data_dir else DEFAULT_LOCAL_DIR
    local_dir.mkdir(parents=True, exist_ok=True)
    db_path = local_dir / "xinzhi.db"
    token_file_path = local_dir / "admin-token"

    static_base = Path(static_dir) if static_dir else BASE_DIR

    # 1. 网络绑定安全校验：非 loopback 绑定必须显式提供 --allow-network 并要求 XINZHI_ADMIN_TOKEN
    is_loopback = bind.lower() in LOOPBACK_HOSTS
    if not is_loopback:
        if not allow_network:
            sys.exit(
                f"[安全拦截] 默认仅允许绑定本地回环地址 (127.0.0.1 / localhost)。"
                f"当前请求绑定为 '{bind}'，可能将未认证端口暴露至外部网络。\n"
                f"若确认要对外开放，必须显式附加参数 --allow-network 并在环境变量中设置 XINZHI_ADMIN_TOKEN。"
            )
        if not os.environ.get("XINZHI_ADMIN_TOKEN"):
            sys.exit(
                "[安全拦截] 对非 loopback 绑定必须通过环境变量 XINZHI_ADMIN_TOKEN 显式指定管理员口令，"
                "禁止在外网暴露自动生成的本地临时密码。"
            )

    # 2. 初始化数据库与管理员凭证
    db_conn = init_db(db_path)
    admin_token, token_file, from_env = get_or_init_admin_token(token_file_path)

    # 3. 打印密码文件绝对路径（严禁打印密码本身）
    print("=" * 68)
    print(f"心知 (Xinzhi) AI医疗+心血管每日精选/每周共读服务已准备就绪")
    print(f"管理员密码文件绝对路径: {token_file.resolve()}")
    if from_env:
        print(f"密码来源: 环境变量 XINZHI_ADMIN_TOKEN (已同步记录至密码文件)")
    else:
        print(f"密码来源: 本地自动生成并受权限保护 (0600)")
    print(f"本地数据库路径: {db_path.resolve()}")
    print(f"静态文件根路径: {static_base.resolve()}")
    print("-" * 68)
    print(f"服务监听地址: http://{bind}:{port}")
    print(f"编辑端入口:   http://{bind}:{port}/editor/")
    print(f"公开端入口:   http://{bind}:{port}/public/")
    print(f"公开日报接口: http://{bind}:{port}/api/public/briefings?date={get_shanghai_date_str()}")
    print("=" * 68)

    server = ThreadedXinzhiServer((bind, port), db_conn, admin_token, static_base)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[XINZHI] 服务正在优雅关闭...")
    finally:
        server.server_close()
        db_conn.close()
        print("[XINZHI] 服务已停止。")


def main() -> None:
    parser = argparse.ArgumentParser(description="心知 (Xinzhi) - 本地知识与编辑服务")
    parser.add_argument("--port", type=int, default=8766, help="服务监听端口 (默认: 8766)")
    parser.add_argument("--bind", type=str, default="127.0.0.1", help="服务绑定地址 (默认: 127.0.0.1)")
    parser.add_argument(
        "--allow-network",
        action="store_true",
        help="显式允许非本地回环地址绑定（需要配合 XINZHI_ADMIN_TOKEN 环境变量）",
    )
    parser.add_argument("--data-dir", type=str, default=None, help="数据存储目录 (默认: outputs/xinzhi/.local)")
    parser.add_argument("--static-dir", type=str, default=None, help="静态文件目录 (默认: outputs/xinzhi)")

    args = parser.parse_args()
    run_server(
        port=args.port,
        bind=args.bind,
        allow_network=args.allow_network,
        data_dir=args.data_dir,
        static_dir=args.static_dir,
    )


if __name__ == "__main__":
    main()
