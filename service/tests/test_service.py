"""
心知 (Xinzhi) - 全面自动化测试套件
覆盖项：
1. 未认证无法读/写编辑端接口与内部共读笔记
2. CSRF Origin 与 Token 防护
3. 重复导入幂等性（严格保留人工编辑与发布状态）
4. 发布门禁校验（未核对来源、索引证据依据、空字段均禁止发布）
5. 发布出现在当日日报，撤回后立即消失
6. 内部记录与 Token 凭据绝对不能经公开 API/URL 读取
7. 请求路径穿越与符号链接被严格拒绝 (403)
8. 服务重启后数据库与文章状态、共读记录完整保留
9. 非 loopback 绑定安全拦截
"""

from __future__ import annotations

import http.client
import csv
import hashlib
import io
import json
import os
import shutil
import socketserver
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
import sys

# 确保 outputs/xinzhi 目录位于 sys.path
TEST_DIR = Path(__file__).resolve().parent
SERVICE_DIR = TEST_DIR.parent
XINZHI_DIR = SERVICE_DIR.parent
if str(XINZHI_DIR) not in sys.path:
    sys.path.insert(0, str(XINZHI_DIR))

from service.auth import (
    DEFAULT_TOKEN_FILE,
    LoginRateLimiter,
    create_session,
    get_or_init_admin_token,
    get_session,
    verify_admin_token,
)
from service.db import (
    PUBLIC_ARTICLE_FIELDS,
    add_audit_log,
    get_db_connection,
    get_shanghai_date_str,
    init_db,
    sanitize_public_article,
)
from service.import_data import import_feeds
from service.server import ThreadedXinzhiServer


class TestXinzhiService(unittest.TestCase):
    """心知服务端全面单元与集成测试"""

    @classmethod
    def setUpClass(cls):
        """启动测试专用服务器与隔离临时目录"""
        cls.temp_dir = tempfile.mkdtemp(prefix="xinzhi_test_")
        cls.temp_path = Path(cls.temp_dir)

        cls.local_dir = cls.temp_path / ".local"
        cls.local_dir.mkdir(parents=True, exist_ok=True)
        cls.db_path = cls.local_dir / "xinzhi.db"
        cls.token_path = cls.local_dir / "admin-token"

        # 准备静态文件根目录
        cls.static_dir = cls.temp_path / "static_root"
        cls.static_dir.mkdir(parents=True, exist_ok=True)
        (cls.static_dir / "index.html").write_text("<!doctype html><html>Root Index</html>", encoding="utf-8")
        (cls.static_dir / "style.css").write_text("body { color: #183b38; }", encoding="utf-8")
        (cls.static_dir / "icon.svg").write_text("<svg></svg>", encoding="utf-8")

        # public 目录
        cls.public_dir = cls.static_dir / "public"
        cls.public_dir.mkdir(parents=True, exist_ok=True)
        (cls.public_dir / "index.html").write_text("<html>Public Index</html>", encoding="utf-8")

        # editor 目录
        cls.editor_dir = cls.static_dir / "editor"
        cls.editor_dir.mkdir(parents=True, exist_ok=True)
        (cls.editor_dir / "index.html").write_text("<html>Editor Index</html>", encoding="utf-8")

        # 受保护目录（禁止访问）
        (cls.static_dir / "data").mkdir(parents=True, exist_ok=True)
        (cls.static_dir / "data" / "feeds.json").write_text('{"items":[]}', encoding="utf-8")
        (cls.static_dir / "service").mkdir(parents=True, exist_ok=True)
        (cls.static_dir / "service" / "secret.py").write_text("SECRET=1", encoding="utf-8")

        # 初始化数据库与管理员密码
        cls.db_conn = init_db(cls.db_path)
        cls.admin_token, _, _ = get_or_init_admin_token(cls.token_path)

        # 启动测试 HTTP 服务器 (动态绑定可用端口)
        cls.server = ThreadedXinzhiServer(
            ("127.0.0.1", 0),
            cls.db_conn,
            cls.admin_token,
            cls.static_dir,
        )
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"

        cls.server_thread = threading.Thread(target=cls.server.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        """关闭服务器并清理临时测试数据"""
        cls.server.shutdown()
        cls.server.server_close()
        cls.db_conn.close()
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def request(
        self,
        path: str,
        method: str = "GET",
        body: dict = None,
        headers: dict = None,
        cookie: str = None,
    ) -> tuple[int, dict | str, dict]:
        """HTTP 请求封装辅助函数"""
        url = f"{self.base_url}{path}"
        req_headers = {"User-Agent": "XinzhiTest/1.0"}
        if headers:
            req_headers.update(headers)
        if cookie:
            req_headers["Cookie"] = cookie

        data_bytes = None
        if body is not None:
            data_bytes = json.dumps(body).encode("utf-8")
            req_headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data_bytes, headers=req_headers, method=method)

        try:
            with urllib.request.urlopen(req) as resp:
                status = resp.status
                resp_headers = dict(resp.headers)
                raw = resp.read()
                try:
                    data = json.loads(raw.decode("utf-8"))
                except Exception:
                    data = raw.decode("utf-8")
                return status, data, resp_headers
        except urllib.error.HTTPError as e:
            status = e.code
            resp_headers = dict(e.headers)
            raw = e.read()
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:
                data = raw.decode("utf-8")
            return status, data, resp_headers

    def login_and_get_credentials(self) -> tuple[str, str]:
        """登录测试辅助函数，返回 (cookie_string, csrf_token)"""
        status, data, headers = self.request(
            "/api/editor/login",
            method="POST",
            body={"token": self.admin_token},
            headers={"Origin": f"http://127.0.0.1:{self.port}"},
        )
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        csrf_token = data.get("csrf_token")

        set_cookie = headers.get("Set-Cookie", "")
        # 提取 xinzhi_session
        cookie_val = set_cookie.split(";")[0]
        return cookie_val, csrf_token

    # ==========================================
    # 测试用例 1：未认证无法读/改/写编辑接口与笔记
    # ==========================================
    def test_01_unauthenticated_cannot_access_editor_apis(self):
        # 无法读取文章列表
        status, data, _ = self.request("/api/editor/articles")
        self.assertEqual(status, 401)
        self.assertIn("error", data)

        # 无法修改文章
        status, data, _ = self.request(
            "/api/editor/articles/nonexistent",
            method="PATCH",
            body={"title_zh": "未授权"},
        )
        self.assertEqual(status, 401)

        # 无法发布文章
        status, data, _ = self.request("/api/editor/articles/nonexistent/publish", method="POST")
        self.assertEqual(status, 401)

        # 无法撤回文章
        status, data, _ = self.request("/api/editor/articles/nonexistent/withdraw", method="POST")
        self.assertEqual(status, 401)

        # 无法读取共读记录
        status, data, _ = self.request("/api/editor/notes")
        self.assertEqual(status, 401)

        # 无法保存共读记录
        status, data, _ = self.request(
            "/api/editor/notes/test-key",
            method="PUT",
            body={"title": "泄露测试"},
        )
        self.assertEqual(status, 401)

    # ==========================================
    # 测试用例 2：登录鉴权、限流与登出
    # ==========================================
    def test_02_login_rate_limiting_and_logout(self):
        # 错误密码返回 401
        status, data, _ = self.request(
            "/api/editor/login",
            method="POST",
            body={"token": "wrong_password"},
            headers={"Origin": f"http://127.0.0.1:{self.port}"},
        )
        self.assertEqual(status, 401)

        # 正常登录获取 HttpOnly SameSite=Strict cookie
        cookie, csrf_token = self.login_and_get_credentials()
        self.assertIn("xinzhi_session=", cookie)

        # 登出并清理会话
        status, data, headers = self.request(
            "/api/editor/logout",
            method="POST",
            headers={"X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        self.assertIn("Max-Age=0", headers.get("Set-Cookie", ""))

        # 登出后原 Cookie 已失效
        status, _, _ = self.request("/api/editor/articles", cookie=cookie)
        self.assertEqual(status, 401)

    # ==========================================
    # 测试用例 3：CSRF 受限 (Origin 与 Token 验证)
    # ==========================================
    def test_03_csrf_restrictions(self):
        cookie, csrf_token = self.login_and_get_credentials()

        # 非法 Origin 被拦截 (403)
        status, data, _ = self.request(
            "/api/editor/notes/csrf-test",
            method="PUT",
            body={"title": "恶意伪造"},
            headers={"Origin": "http://attacker.example.com", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(status, 403)

        # 缺失 X-CSRF-Token 报 403
        status, data, _ = self.request(
            "/api/editor/notes/csrf-test",
            method="PUT",
            body={"title": "缺失CSRF"},
            headers={"Origin": f"http://127.0.0.1:{self.port}"},
            cookie=cookie,
        )
        self.assertEqual(status, 403)

        # 合法 Origin 与正确 CSRF Token 顺利通过 (200)
        status, data, _ = self.request(
            "/api/editor/notes/csrf-test",
            method="PUT",
            body={"title": "合法记录", "content": "内容", "reviewer": "测试人"},
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))

    # ==========================================
    # 测试用例 4：重复导入不覆盖人工修改
    # ==========================================
    def test_04_import_data_idempotent_preserves_edits(self):
        # 准备测试 fixture feeds
        fixture_feeds = self.temp_path / "test_feeds.json"
        fixture_data = {
            "candidateCount": 2,
            "items": [
                {
                    "id": "rss-test-01",
                    "title": "Machine learning in heart failure",
                    "url": "https://example.com/paper1",
                    "doi": "10.1000/test01",
                    "journal": "Heart Journal",
                    "date": "2026-09-28",
                    "category": "心血管",
                    "basis": "RSS 元数据 · 待编辑核验",
                },
                {
                    "id": "rss-test-02",
                    "title": "LLM evaluation in clinical records",
                    "url": "https://example.com/paper2",
                    "doi": "",
                    "journal": "NPJ Digital Med",
                    "date": "2026-09-29",
                    "category": "AI医疗",
                    "basis": "RSS 元数据 · 待编辑核验",
                },
            ],
        }
        fixture_feeds.write_text(json.dumps(fixture_data), encoding="utf-8")

        # 首次导入
        new_cnt, retained_cnt, total_cnt = import_feeds(fixture_feeds, self.db_path)
        self.assertEqual(new_cnt, 2)
        self.assertEqual(retained_cnt, 0)

        # 人工编辑 paper1
        cookie, csrf_token = self.login_and_get_credentials()
        edit_body = {
            "title_zh": "机器学习在心力衰竭风险分层中的多中心队列研究",
            "summary": "入组 5000 例患者，主要终点 1 年全因死亡率 C-index 达到 0.82。",
            "limitations": "单国别数据，缺乏外院异构数据前瞻验证。",
            "study_type": "前瞻性队列研究",
            "evidence_basis": "abstract",
            "reviewer": "夏医生",
            "source_checked": True,
        }
        patch_status, patch_data, _ = self.request(
            "/api/editor/articles/rss-test-01",
            method="PATCH",
            body=edit_body,
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(patch_status, 200)

        # 审核并发布 paper1
        pub_status, pub_data, _ = self.request(
            "/api/editor/articles/rss-test-01/publish",
            method="POST",
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(pub_status, 200)
        self.assertEqual(pub_data["article"]["status"], "published")
        published_date = pub_data["article"]["published_date"]
        self.assertTrue(bool(published_date))

        # 再次执行导入（模拟定时或手动多次导入）
        new_cnt2, retained_cnt2, _ = import_feeds(fixture_feeds, self.db_path)
        self.assertEqual(new_cnt2, 0)
        self.assertEqual(retained_cnt2, 2)

        # 验证人工编辑与发布状态完好保留！
        cur = self.db_conn.cursor()
        cur.execute("SELECT * FROM articles WHERE id = 'rss-test-01'")
        art = cur.fetchone()
        self.assertEqual(art["title_zh"], edit_body["title_zh"])
        self.assertEqual(art["summary"], edit_body["summary"])
        self.assertEqual(art["limitations"], edit_body["limitations"])
        self.assertEqual(art["reviewer"], "夏医生")
        self.assertEqual(art["source_checked"], 1)
        self.assertEqual(art["evidence_basis"], "abstract")
        self.assertEqual(art["status"], "published")
        self.assertEqual(art["published_date"], published_date)

    # ==========================================
    # 测试用例 5：未核对来源或证据不足不能发布
    # ==========================================
    def test_05_publish_gatekeeping_validation(self):
        cookie, csrf_token = self.login_and_get_credentials()

        # 针对尚未编辑的 paper2 (status=candidate, source_checked=0, evidence_basis=index)
        status, data, _ = self.request(
            "/api/editor/articles/rss-test-02/publish",
            method="POST",
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(status, 400)
        self.assertIn("details", data)
        # 确认错误信息涵盖各项要求
        details_str = " ".join(data["details"])
        self.assertIn("中文标题", details_str)
        self.assertIn("摘要", details_str)
        self.assertIn("局限性", details_str)
        self.assertIn("审核人", details_str)
        self.assertIn("来源核对", details_str)
        self.assertIn("不能仅为索引元数据", details_str)

        # 即使补充了文字，但 source_checked 仍未勾选 -> 依然拒绝
        self.request(
            "/api/editor/articles/rss-test-02",
            method="PATCH",
            body={
                "title_zh": "题名",
                "summary": "摘要",
                "limitations": "局限",
                "reviewer": "夏医生",
                "evidence_basis": "abstract",
                "source_checked": False,
            },
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        status, data, _ = self.request(
            "/api/editor/articles/rss-test-02/publish",
            method="POST",
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(status, 400)

        # 勾选来源核对，满足全部门禁条件后，发布成功
        self.request(
            "/api/editor/articles/rss-test-02",
            method="PATCH",
            body={"source_checked": True},
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        status, data, _ = self.request(
            "/api/editor/articles/rss-test-02/publish",
            method="POST",
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["article"]["status"], "published")

    # ==========================================
    # 测试用例 6：发布出现在当日日报，撤回后立即消失
    # ==========================================
    def test_06_published_in_briefing_and_withdrawn_disappears(self):
        cookie, csrf_token = self.login_and_get_credentials()
        today = get_shanghai_date_str()

        # 公开接口查询当日日报
        status, data, _ = self.request(f"/api/public/briefings?date={today}")
        self.assertEqual(status, 200)
        items = data.get("items", [])
        ids = [it["id"] for it in items]
        self.assertIn("rss-test-01", ids)

        # 严格检查白名单：绝无内部字段
        for it in items:
            for k in it.keys():
                self.assertIn(k, PUBLIC_ARTICLE_FIELDS)
            self.assertNotIn("reviewer", it)
            self.assertNotIn("source_checked", it)
            self.assertNotIn("audit_logs", it)

        # 执行撤回
        w_status, w_data, _ = self.request(
            "/api/editor/articles/rss-test-01/withdraw",
            method="POST",
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(w_status, 200)
        self.assertEqual(w_data["article"]["status"], "withdrawn")

        # 撤回后公开日报立即不可见
        status2, data2, _ = self.request(f"/api/public/briefings?date={today}")
        self.assertEqual(status2, 200)
        ids2 = [it["id"] for it in data2.get("items", [])]
        self.assertNotIn("rss-test-01", ids2)

        # 公开全量文章接口中也立即不可见
        status_pub, data_pub, _ = self.request("/api/public/articles")
        self.assertEqual(status_pub, 200)
        all_pub_ids = [it["id"] for it in data_pub.get("items", [])]
        self.assertNotIn("rss-test-01", all_pub_ids)

    # ==========================================
    # 测试用例 7：内部记录与 Token 文件无法通过公开 URL 读取
    # ==========================================
    def test_07_internal_data_and_token_cannot_be_read_publicly(self):
        # 尝试通过公共接口访问内部笔记 -> 404
        status, _, _ = self.request("/api/public/notes")
        self.assertEqual(status, 404)

        # 尝试通过 URL 直接访问受保护的本地密码文件
        status, _, _ = self.request("/.local/admin-token")
        self.assertEqual(status, 403)

        status, _, _ = self.request("/.local/xinzhi.db")
        self.assertEqual(status, 403)

        # 尝试访问 service 与 data 目录
        status, _, _ = self.request("/service/server.py")
        self.assertEqual(status, 403)

        status, _, _ = self.request("/data/feeds.json")
        self.assertEqual(status, 403)

    # ==========================================
    # 测试用例 8：路径穿越与符号链接被拒绝
    # ==========================================
    def test_08_path_traversal_and_symlinks_rejected(self):
        # 路径穿越
        status, _, _ = self.request("/public/../../etc/passwd")
        self.assertEqual(status, 403)

        status, _, _ = self.request("/editor/../.local/admin-token")
        self.assertEqual(status, 403)

        # 创建符号链接测试
        symlink_target = self.static_dir / "public" / "symlink_test.txt"
        if not symlink_target.exists():
            try:
                os.symlink(str(self.token_path), str(symlink_target))
                status, _, _ = self.request("/public/symlink_test.txt")
                self.assertEqual(status, 403)
            except OSError:
                pass  # 在个别受限环境中若无法建符号链接则跳过
            finally:
                if symlink_target.is_symlink():
                    symlink_target.unlink()

        # 白名单文件正常响应
        status, body, _ = self.request("/")
        self.assertEqual(status, 200)

        status, body, _ = self.request("/style.css")
        self.assertEqual(status, 200)

        status, body, _ = self.request("/public/index.html")
        self.assertEqual(status, 200)

        status, body, _ = self.request("/editor/index.html")
        self.assertEqual(status, 200)

    # ==========================================
    # 测试用例 9：服务重启后数据持久性
    # ==========================================
    def test_09_database_persistence_across_restarts(self):
        # 新增一条内部笔记
        cookie, csrf_token = self.login_and_get_credentials()
        self.request(
            "/api/editor/notes/restart-test-key",
            method="PUT",
            body={"title": "持久化测试", "content": "重启后仍保留", "reviewer": "夏老师"},
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )

        # 模拟服务重启：重新打开 DB 连接
        new_conn = get_db_connection(self.db_path)
        cur = new_conn.cursor()

        # 验证笔记存在
        cur.execute("SELECT * FROM notes WHERE key = 'restart-test-key'")
        note = cur.fetchone()
        self.assertIsNotNone(note)
        self.assertEqual(note["title"], "持久化测试")

        # 验证文章存在且状态准确
        cur.execute("SELECT * FROM articles WHERE id = 'rss-test-02'")
        art = cur.fetchone()
        self.assertIsNotNone(art)
        self.assertEqual(art["status"], "published")
        new_conn.close()

    # ==========================================
    # 测试用例 10：非 loopback 绑定安全拦截
    # ==========================================
    def test_10_network_binding_guardrail(self):
        from service.server import run_server

        # 尝试绑定 0.0.0.0 但未指定 --allow-network -> 必须 SystemExit
        with self.assertRaises(SystemExit) as cm:
            run_server(port=9999, bind="0.0.0.0", allow_network=False)
        self.assertIn("安全拦截", str(cm.exception))

    # ==========================================
    # 测试用例 11：不信任伪造头 (X-User, Host) 与请求体大小限制
    # ==========================================
    def test_11_untrusted_headers_and_body_size_limit(self):
        # 伪造 X-User 头无法绕过认证
        status, data, _ = self.request(
            "/api/editor/articles",
            headers={"X-User": "admin", "X-Role": "editor", "Host": "trusted.internal"},
        )
        self.assertEqual(status, 401)

        # 超过 1MB 的请求体被拦截 (413)
        cookie, csrf_token = self.login_and_get_credentials()
        huge_payload = {"title": "A" * (1024 * 1024 + 500)}
        status, data, _ = self.request(
            "/api/editor/notes/huge-note",
            method="PUT",
            body=huge_payload,
            headers={"Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": csrf_token},
            cookie=cookie,
        )
        self.assertEqual(status, 413)

    # ==========================================
    # 测试用例 12：连续 5 次登录失败触发限流 (429)
    # ==========================================
    def test_12_rate_limiter_blocks_after_5_failures(self):
        from service.auth import LoginRateLimiter

        limiter = LoginRateLimiter(max_attempts=5, window_seconds=60.0)
        test_ip = "192.168.1.100"

        self.assertFalse(limiter.is_blocked(test_ip))
        for _ in range(4):
            limiter.record_failure(test_ip)
            self.assertFalse(limiter.is_blocked(test_ip))

        limiter.record_failure(test_ip)  # 第 5 次失败
        self.assertTrue(limiter.is_blocked(test_ip))  # 此时被拦截

        # 成功后恢复
        limiter.record_success(test_ip)
        self.assertFalse(limiter.is_blocked(test_ip))

    # ==========================================
    # 测试用例 13：导入工作区真实 feeds.json 数据
    # ==========================================
    def test_13_import_actual_workspace_feeds(self):
        actual_feeds_file = XINZHI_DIR / "data" / "feeds.json"
        if not actual_feeds_file.exists():
            self.skipTest("真实 feeds.json 不存在")

        # 导入至临时数据库
        new_cnt, retained_cnt, total_cnt = import_feeds(actual_feeds_file, self.db_path)
        self.assertGreater(total_cnt, 0)
        self.assertEqual(new_cnt + retained_cnt, total_cnt)

        # 验证数据库中存在这些文章，且全部为 candidate 状态未自动发布
        cur = self.db_conn.cursor()
        cur.execute("SELECT COUNT(*) as cnt FROM articles WHERE status = 'candidate'")
        row = cur.fetchone()
        self.assertGreaterEqual(row["cnt"], 50)


class TestGithubLibraryReadOnly(unittest.TestCase):
    """Synthetic local sessions/snapshots only; never reads an existing admin token."""

    def setUp(self):
        self.pdf_passphrase = "synthetic-download-phrase"
        self.pdf_env = mock.patch.dict(os.environ, {"PDF_DOWNLOAD_PASSPHRASE": self.pdf_passphrase})
        self.pdf_env.start()
        self.temp = tempfile.TemporaryDirectory(prefix="xinzhi_library_api_")
        self.root = Path(self.temp.name)
        (self.root / ".local").mkdir()
        self.db = init_db(self.root / ".local" / "synthetic.db")
        self.server = ThreadedXinzhiServer(
            ("127.0.0.1", 0), self.db, "synthetic-test-only-credential", self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        session, _ = create_session(self.db)
        self.cookie = "xinzhi_session=" + session

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.db.close()
        self.temp.cleanup()
        self.pdf_env.stop()

    def get(self, path, authenticated=False):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        headers = {"Cookie": self.cookie} if authenticated else {}
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        status, headers = response.status, dict(response.getheaders())
        body = json.loads(response.read().decode("utf-8"))
        connection.close()
        return status, body, headers

    def snapshot(self, count=2, hash_values=None, paper_overrides=None):
        """Build a matching raw CSV/JSON fixture, using only synthetic paper rows."""
        from scripts.github_library import normalize_index

        cache = self.root / ".local" / "github-library"
        (cache / "snapshots").mkdir(parents=True, exist_ok=True)
        csv_text = io.StringIO(newline="")
        writer = csv.DictWriter(csv_text, fieldnames=["题名", "DOI", "期刊", "实际出版日期", "日期来源", "当前路径", "SHA256"])
        writer.writeheader()
        for i in range(count):
            row = {
                "题名": "Atrial fibrillation synthetic study " + str(i),
                "DOI": "10.1234/synthetic" + str(i), "期刊": "Synthetic Cardiology",
                "实际出版日期": "2026-09", "日期来源": "synthetic issue month",
                "当前路径": "papers/synthetic-" + str(i) + ".pdf", "SHA256": hash_values[i] if hash_values else "",
            }
            if paper_overrides:
                row.update(paper_overrides[i])
            writer.writerow(row)
        raw = csv_text.getvalue().encode("utf-8-sig")
        papers, source_rows = normalize_index(raw, "dodoxiaxia/AI-")
        commit = "a" * 40
        blob = hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
        raw_path = "snapshots/" + commit + "-" + blob + ".csv"
        (cache / raw_path).write_bytes(raw)
        snapshot = {
            "schema_version": 1, "private_only": True,
            "repository": {"full_name": "dodoxiaxia/AI-", "default_branch": "main", "visibility": "private"},
            "snapshot": {"commit": commit, "index_path": "文献索引/文献索引.csv", "index_blob": blob,
                         "fingerprint": hashlib.sha256(raw).hexdigest(), "indexed_at": "2026-09-30T12:00:00+08:00", "raw_csv_file": raw_path},
            "source_rows": source_rows, "papers": papers,
        }
        (cache / "index.json").write_text(json.dumps(snapshot), encoding="utf-8")
        return cache

    def pdf_snapshot(self, count=2, hash_values=None, paper_overrides=None):
        data, _ = self.synthetic_pdf()
        values = hash_values if hash_values is not None else [hashlib.sha256(data).hexdigest()] * count
        return self.snapshot(count, values, paper_overrides)

    def public_library(self, doi="10.1234/synthetic0", title="合成医学文献"):
        (self.root / "data").mkdir(exist_ok=True)
        paper = {"id": "1234567890abcdef", "title": title, "doi": doi}
        (self.root / "data" / "library.json").write_text(json.dumps({"papers": [paper]}, ensure_ascii=False), encoding="utf-8")
        return paper

    def pdf_request(self, query="id=1234567890abcdef", authenticated=False, accept="application/json", cookie=None,
                    method="POST", passphrase=None, body=None, extra_headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        headers = {"Accept": accept}
        if authenticated:
            headers["Cookie"] = cookie if cookie is not None else self.cookie
        if method == "POST":
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            if body is None:
                phrase = self.pdf_passphrase if passphrase is None else passphrase
                body = urllib.parse.urlencode({"passphrase": phrase}).encode("utf-8")
        if extra_headers:
            headers.update(extra_headers)
        connection.request(method, "/api/pdf?" + query, body=body, headers=headers)
        response = connection.getresponse()
        status, response_headers, body = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return status, body, response_headers

    @staticmethod
    def synthetic_pdf():
        data = b"%PDF-1.4\nsynthetic test content\n%%EOF\n"
        blob = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
        return data, blob

    def test_pdf_requires_correct_phrase_before_any_catalog_or_github_read(self):
        with mock.patch("service.server.public_pdf_paper") as public_read, \
                mock.patch("scripts.github_library.load_snapshot") as private_read, \
                mock.patch("scripts.github_library.fetch_pdf") as fetch:
            for phrase in ("", "wrong-synthetic-phrase"):
                status, raw, headers = self.pdf_request(passphrase=phrase)
                body = json.loads(raw)
                self.assertEqual(status, 403)
                self.assertEqual(body["code"], "invalid_passphrase")
                self.assertNotIn(phrase or "wrong-synthetic-phrase", raw.decode("utf-8"))
                self.assertEqual(headers["Cache-Control"], "no-store")
            public_read.assert_not_called()
            private_read.assert_not_called()
            fetch.assert_not_called()

    def test_pdf_browser_gets_phrase_form_without_session_or_private_read(self):
        self.public_library(title='<script>alert("synthetic")</script>')
        with mock.patch("scripts.github_library.load_snapshot") as private_read, \
                mock.patch("scripts.github_library.fetch_pdf") as fetch, \
                mock.patch("service.server.XinzhiRequestHandler.get_authenticated_session", side_effect=AssertionError("No account lookup")):
            status, raw, headers = self.pdf_request(method="GET", accept="text/html,application/xhtml+xml")
            private_read.assert_not_called()
            fetch.assert_not_called()
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
        self.assertIn('method="post"', raw.decode("utf-8"))
        self.assertIn('action="/api/pdf?id=1234567890abcdef"', raw.decode("utf-8"))
        self.assertIn('type="password"', raw.decode("utf-8"))
        self.assertIn('href="/?mode=library"', raw.decode("utf-8"))
        self.assertNotIn('href="/editor/"', raw.decode("utf-8"))
        self.assertNotIn("<script>", raw.decode("utf-8"))
        self.assertNotIn(self.pdf_passphrase, raw.decode("utf-8"))
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Referrer-Policy"], "same-origin")

    def test_pdf_wrong_phrase_browser_form_preserves_id_without_echo(self):
        with mock.patch("scripts.github_library.load_snapshot") as private_read, \
                mock.patch("scripts.github_library.fetch_pdf") as fetch:
            status, raw, headers = self.pdf_request(accept="text/html", passphrase="wrong-synthetic-phrase")
            self.assertEqual(status, 403)
            self.assertIn("口令错误", raw.decode("utf-8"))
            self.assertIn('action="/api/pdf?id=1234567890abcdef"', raw.decode("utf-8"))
            self.assertIn('type="password"', raw.decode("utf-8"))
            self.assertNotIn("wrong-synthetic-phrase", raw.decode("utf-8"))
            self.assertNotIn("value=", raw.decode("utf-8"))
            self.assertNotIn("Set-Cookie", headers)
            self.assertEqual(headers["Referrer-Policy"], "same-origin")
            private_read.assert_not_called()
            fetch.assert_not_called()

    def test_pdf_get_json_requires_phrase_and_never_downloads(self):
        self.public_library()
        with mock.patch("scripts.github_library.load_snapshot") as private_read, \
                mock.patch("scripts.github_library.fetch_pdf") as fetch:
            status, raw, _ = self.pdf_request(method="GET", authenticated=True)
            self.assertEqual(status, 401)
            self.assertEqual(json.loads(raw)["code"], "passphrase_required")
            private_read.assert_not_called()
            fetch.assert_not_called()

    def test_pdf_phrase_origin_and_form_validation_precede_private_reads(self):
        self.public_library()
        with mock.patch("service.server.public_pdf_paper") as public_read, \
                mock.patch("scripts.github_library.load_snapshot") as private_read, \
                mock.patch("scripts.github_library.fetch_pdf") as fetch:
            for origin in ("https://other.example", "null"):
                status, raw, _ = self.pdf_request(extra_headers={"Origin": origin})
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(raw)["code"], "invalid_origin")
            port = self.server.server_address[1]
            status, raw, _ = self.pdf_request(extra_headers={"Origin": f"http://localhost:{port}"})
            self.assertEqual(status, 403)
            for fetch_site in ("cross-site", "same-site", "unknown"):
                status, raw, _ = self.pdf_request(extra_headers={"Sec-Fetch-Site": fetch_site})
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(raw)["code"], "invalid_origin")
            for body in (b"passphrase=first&passphrase=second", b"passphrase=first&id=1234567890abcdef",
                         b"passphrase=first&extra=", b"", b"passphrase=" + b"x" * 257, b"passphrase=%ff"):
                status, raw, _ = self.pdf_request(body=body)
                self.assertEqual(status, 400, body[:50])
                self.assertEqual(json.loads(raw)["code"], "invalid_form")
            status, raw, _ = self.pdf_request(body=b"{}", extra_headers={"Content-Type": "application/json"})
            self.assertEqual(status, 415)
            status, raw, _ = self.pdf_request(body=b"passphrase=" + b"x" * 2048)
            self.assertEqual(status, 413)
            self.assertEqual(json.loads(raw)["code"], "form_too_large")
            public_read.assert_not_called()
            private_read.assert_not_called()
            fetch.assert_not_called()

    def test_pdf_same_origin_or_cli_phrase_submission_is_accepted_without_editor_session(self):
        self.public_library()
        port = self.server.server_address[1]
        with mock.patch("scripts.github_library.load_snapshot", return_value=None) as private_read, \
                mock.patch("service.server.XinzhiRequestHandler.get_authenticated_session", side_effect=AssertionError("No account lookup")):
            for headers in ({}, {"Origin": f"http://127.0.0.1:{port}", "Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Site": "none"}):
                status, raw, _ = self.pdf_request(extra_headers=headers)
                self.assertEqual(status, 404)
                self.assertEqual(json.loads(raw)["code"], "pdf_not_found")
            self.assertEqual(private_read.call_count, 3)

    def test_pdf_invalid_override_is_closed_without_private_access(self):
        with mock.patch("service.server.public_pdf_paper") as public_read, \
                mock.patch("scripts.github_library.load_snapshot") as private_read:
            for configured in ("", "x" * 257):
                with mock.patch.dict(os.environ, {"PDF_DOWNLOAD_PASSPHRASE": configured}):
                    status, raw, _ = self.pdf_request()
                    self.assertEqual(status, 503)
                    self.assertEqual(json.loads(raw)["code"], "pdf_not_configured")
            with mock.patch.dict(os.environ, {}):
                os.environ.pop("PDF_DOWNLOAD_PASSPHRASE", None)
                status, raw, _ = self.pdf_request()
                self.assertEqual(status, 503, "no built-in phrase when the environment has none")
                self.assertEqual(json.loads(raw)["code"], "pdf_not_configured")
            public_read.assert_not_called()
            private_read.assert_not_called()

    def test_pdf_phrase_override_changes_download_access_and_is_not_logged(self):
        self.public_library()
        with mock.patch.dict(os.environ, {"PDF_DOWNLOAD_PASSPHRASE": "second-synthetic-download-phrase"}), \
                mock.patch("service.server.sys.stderr", new_callable=io.StringIO) as log, \
                mock.patch("scripts.github_library.load_snapshot", return_value=None) as private_read:
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 403)
            private_read.assert_not_called()
            status, raw, _ = self.pdf_request(passphrase="second-synthetic-download-phrase")
            self.assertEqual(status, 404)
            private_read.assert_called_once()
            self.assertNotIn("synthetic-download-phrase", log.getvalue())
            self.assertNotIn("second-synthetic-download-phrase", log.getvalue())

    def test_pdf_rejects_nonpublic_ids_and_path_repository_query_parameters(self):
        self.public_library()
        with mock.patch("scripts.github_library.fetch_pdf") as fetch:
            for query in ("", "id=../secret", "id=gh-" + "a" * 24,
                          "id=1234567890abcdef&id=1234567890abcdef", "doi=10.1234/synthetic0",
                          "id=1234567890abcdef&path=papers/secret.pdf", "id=1234567890abcdef&repo=other/private",
                          "id=1234567890abcdef&passphrase=wrong-synthetic-phrase", "id=1234567890abcdef&passphrase=",
                          "id=1234567890abcdef&path=", "id=1234567890abcdef&repo=", "id=1234567890abcdef&flag"):
                for method in ("GET", "POST"):
                    status, raw, _ = self.pdf_request(query=query, method=method)
                    self.assertEqual(status, 400, query)
                    self.assertEqual(json.loads(raw)["code"], "invalid_paper_id")
            status, raw, _ = self.pdf_request(query="id=0000000000000000")
            self.assertEqual(status, 404)
            self.assertEqual(json.loads(raw)["code"], "pdf_not_found")
            fetch.assert_not_called()

    def test_pdf_uses_normalized_exact_doi_and_fixed_snapshot_commit(self):
        data, blob = self.synthetic_pdf()
        self.pdf_snapshot(hash_values=[hashlib.sha256(data).hexdigest(), ""])
        self.public_library(doi=" HTTPS://DOI.ORG/10.1234/SYNTHETIC0 ", title='合成医学文献/\r\nInjected: "header"')
        with mock.patch("scripts.github_library._repository_file", return_value=(data, blob)) as repository_read:
            status, raw, headers = self.pdf_request()
            self.assertEqual(status, 200)
            self.assertEqual(raw, data)
            self.assertEqual(headers["Content-Type"], "application/pdf")
            self.assertEqual(headers["Content-Length"], str(len(data)))
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertNotIn("Set-Cookie", headers)
            disposition = headers["Content-Disposition"]
            self.assertTrue(disposition.startswith('attachment; filename="paper-1234567890abcdef.pdf"; filename*=UTF-8\'\''))
            utf8_name = urllib.parse.unquote(disposition.split("filename*=UTF-8''", 1)[1])
            self.assertIn("合成医学文献", utf8_name)
            self.assertNotIn("\r", utf8_name)
            self.assertNotIn("\n", utf8_name)
            self.assertNotIn("/", utf8_name)
            self.assertNotIn("Injected", headers)
            repository_read.assert_called_once_with("dodoxiaxia/AI-", "papers/synthetic-0.pdf", "a" * 40, 50 * 1024 * 1024)
            # A second request validates the existing receipt instead of calling GitHub.
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 200)
            self.assertEqual(raw, data)
            self.assertEqual(repository_read.call_count, 1)

    def test_pdf_with_absent_doi_requires_complete_normalized_title(self):
        data, blob = self.synthetic_pdf()
        self.pdf_snapshot()
        self.public_library(doi="", title="  ATRIAL   fibrillation\n synthetic study 0  ")
        with mock.patch("scripts.github_library._repository_file", return_value=(data, blob)) as repository_read:
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 200)
            self.assertEqual(raw, data)
            repository_read.assert_called_once()
        self.public_library(doi="", title="Atrial fibrillation")
        with mock.patch("scripts.github_library.fetch_pdf") as fetch:
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 404)
            self.assertEqual(json.loads(raw)["code"], "pdf_not_found")
            fetch.assert_not_called()

    def test_pdf_doi_match_never_falls_back_to_title_or_prefix_match(self):
        self.pdf_snapshot()
        self.public_library(doi="10.1234/synthetic", title="Atrial fibrillation synthetic study 0")
        with mock.patch("scripts.github_library.fetch_pdf") as fetch:
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 404)
            self.assertEqual(json.loads(raw)["code"], "pdf_not_found")
            fetch.assert_not_called()

    def test_pdf_missing_snapshot_duplicate_matches_and_invalid_checksum_do_not_fetch(self):
        self.public_library()
        with mock.patch("scripts.github_library.fetch_pdf") as fetch:
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 404)
            self.assertEqual(json.loads(raw)["code"], "pdf_not_found")
            self.pdf_snapshot(paper_overrides=[{}, {"DOI": "10.1234/synthetic0"}])
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 409)
            self.assertEqual(json.loads(raw)["code"], "pdf_ambiguous")
            self.pdf_snapshot(hash_values=["not a checksum", ""])
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 422)
            self.assertEqual(json.loads(raw)["code"], "pdf_integrity_failed")
            self.pdf_snapshot(hash_values=["", ""])
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 422)
            self.assertEqual(json.loads(raw)["code"], "pdf_integrity_failed")
            fetch.assert_not_called()

    def test_pdf_absent_doi_duplicate_titles_are_rejected(self):
        self.public_library(doi="", title="Atrial fibrillation synthetic study 0")
        self.pdf_snapshot(paper_overrides=[{}, {"题名": "  ATRIAL fibrillation synthetic study 0 "}])
        with mock.patch("scripts.github_library.fetch_pdf") as fetch:
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 409)
            self.assertEqual(json.loads(raw)["code"], "pdf_ambiguous")
            fetch.assert_not_called()

    def test_pdf_corrupted_content_and_cache_fail_without_private_details(self):
        from scripts.github_library import read_verified_pdf
        data, blob = self.synthetic_pdf()
        cache = self.pdf_snapshot()
        self.public_library()
        with mock.patch("scripts.github_library._repository_file", return_value=(b"not a PDF", blob)):
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 422)
            self.assertEqual(json.loads(raw)["code"], "pdf_integrity_failed")
        with mock.patch("scripts.github_library._repository_file", return_value=(data, blob)):
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 200)
        # The service reopens through a verifying helper; modifications after fetch fail.
        def corrupt_before_read(root, receipt):
            (cache / receipt["cache_file"]).write_bytes(b"%PDF-1.4\ncorrupted\n")
            return read_verified_pdf(root, receipt)
        with mock.patch("scripts.github_library.read_verified_pdf", side_effect=corrupt_before_read):
            status, raw, headers = self.pdf_request()
            self.assertEqual(status, 422)
            self.assertEqual(json.loads(raw)["code"], "pdf_integrity_failed")
            self.assertNotIn(self.temp.name, raw.decode("utf-8"))
            self.assertNotIn("github-library", raw.decode("utf-8"))
            self.assertEqual(headers["Cache-Control"], "no-store")

    def test_pdf_source_failures_are_fixed_diagnostics_for_json_and_html(self):
        from scripts.github_library import LibraryError
        self.pdf_snapshot()
        self.public_library()
        with mock.patch("scripts.github_library.fetch_pdf", side_effect=LibraryError("github_read_failed", self.temp.name + "/private-secret")):
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 502)
            self.assertEqual(json.loads(raw)["code"], "pdf_upstream_unavailable")
            self.assertNotIn(self.temp.name, raw.decode("utf-8"))
            status, raw, headers = self.pdf_request(accept="text/html")
            self.assertEqual(status, 502)
            self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
            self.assertIn("官网原文", raw.decode("utf-8"))
            self.assertNotIn("private-secret", raw.decode("utf-8"))

    def test_pdf_rejects_snapshot_changed_between_selection_and_fetch(self):
        from scripts.github_library import fetch_pdf
        data, blob = self.synthetic_pdf()
        self.pdf_snapshot()
        self.public_library()
        def changed_receipt(root, paper_id):
            receipt = fetch_pdf(root, paper_id)
            receipt["commit"] = "b" * 40
            return receipt
        with mock.patch("scripts.github_library._repository_file", return_value=(data, blob)), \
                mock.patch("scripts.github_library.fetch_pdf", side_effect=changed_receipt), \
                mock.patch("scripts.github_library.read_verified_pdf") as read:
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(raw)["code"], "snapshot_changed")
            read.assert_not_called()

    def test_pdf_symlink_public_catalog_is_rejected_without_reading_target(self):
        self.public_library()
        catalog = self.root / "data" / "library.json"
        target = self.root / "private-catalog.json"
        catalog.rename(target)
        catalog.symlink_to(target)
        with mock.patch("scripts.github_library.load_snapshot") as load:
            status, raw, _ = self.pdf_request()
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(raw)["code"], "public_library_unavailable")
            self.assertNotIn(self.temp.name, raw.decode("utf-8"))
            load.assert_not_called()

    def test_anonymous_is_blocked_before_snapshot_read(self):
        status, body, _ = self.get("/api/editor/github-library?q=test")
        self.assertEqual(status, 401)
        self.assertNotIn("items", body)

    def test_authenticated_reads_only_temp_snapshot_metadata(self):
        self.snapshot()
        status, body, headers = self.get("/api/editor/github-library?q=synthetic1&limit=20", authenticated=True)
        self.assertEqual(status, 200)
        self.assertTrue(body["available"])
        self.assertEqual(body["repository"]["full_name"], "dodoxiaxia/AI-")
        self.assertEqual(body["snapshot"]["commit"], "a" * 40)
        self.assertEqual(body["source_rows"], 2)
        self.assertEqual(body["returned_count"], 1)
        item = body["items"][0]
        self.assertEqual(item["source_date"], "2026-09")
        self.assertEqual(item["relative_path"], "papers/synthetic-1.pdf")
        self.assertEqual(set(item), {"id", "title", "journal", "doi", "source_date", "date_basis", "relative_path", "pdf_sha256_status"})
        self.assertEqual(item["pdf_sha256_status"], "missing")
        self.assertEqual(body["checksum_counts"], {"valid": 0, "missing": 2, "invalid": 0})
        self.assertNotIn(self.temp.name, json.dumps(body))
        self.assertNotIn("raw_csv_file", body["snapshot"])
        self.assertEqual(headers.get("Cache-Control"), "no-store")

    def test_invalid_index_hash_is_searchable_and_warned_without_exposing_raw_hash(self):
        self.snapshot(3, ["b" * 64, "", "Synthetic volume 29 issue 5"])
        status, body, _ = self.get("/api/editor/github-library?q=synthetic2", authenticated=True)
        self.assertEqual(status, 200)
        self.assertEqual(body["returned_count"], 1)
        self.assertEqual(body["items"][0]["pdf_sha256_status"], "invalid")
        self.assertEqual(body["checksum_counts"], {"valid": 1, "missing": 1, "invalid": 1})
        serialized = json.dumps(body)
        self.assertNotIn("Synthetic volume 29 issue 5", serialized)
        self.assertNotIn("b" * 64, serialized)
        self.assertNotIn("pdf_sha256", body["items"][0])

    def test_private_cache_is_never_served_as_static_file(self):
        self.snapshot()
        for authenticated in (False, True):
            status, _, _ = self.get("/.local/github-library/index.json", authenticated=authenticated)
            self.assertEqual(status, 403)

    def test_missing_snapshot_reports_need_for_index_update(self):
        status, body, _ = self.get("/api/editor/github-library", authenticated=True)
        self.assertEqual(status, 200)
        self.assertFalse(body["available"])
        self.assertEqual(body["status"], "needs_sync")
        self.assertEqual(body["items"], [])
        self.assertIn("更新", body["message"])
        self.assertFalse((self.root / ".local" / "github-library").exists())

    def test_limit_is_capped_and_invalid_limit_rejected(self):
        self.snapshot(120)
        status, body, _ = self.get("/api/editor/github-library?limit=999999", authenticated=True)
        self.assertEqual(status, 200)
        self.assertEqual(body["limit"], 100)
        self.assertEqual(len(body["items"]), 100)
        for value in ("0", "-2", "not-a-number"):
            status, _, _ = self.get("/api/editor/github-library?limit=" + value, authenticated=True)
            self.assertEqual(status, 400)

    def test_corrupt_snapshot_has_no_private_exception_text(self):
        cache = self.root / ".local" / "github-library"
        cache.mkdir()
        (cache / "index.json").write_text("invalid-json", encoding="utf-8")
        status, body, _ = self.get("/api/editor/github-library", authenticated=True)
        self.assertEqual(status, 503)
        self.assertEqual(body["status"], "snapshot_unavailable")
        self.assertNotIn(self.temp.name, json.dumps(body))


if __name__ == "__main__":
    unittest.main()
