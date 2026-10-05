"""
心知 (Xinzhi) - 认证、会话与 CSRF 安全防护
支持本地单编辑账号、Rate Limit 防爆破、常量时间比对、HttpOnly 会话与双重 CSRF 验证。
"""

from __future__ import annotations

import hmac
import os
import secrets
import sqlite3
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .db import DEFAULT_LOCAL_DIR, add_audit_log

DEFAULT_TOKEN_FILE = DEFAULT_LOCAL_DIR / "admin-token"


def get_or_init_admin_token(token_file_path: Optional[Path | str] = None) -> Tuple[str, Path, bool]:
    """
    获取或初始化管理员令牌。
    规则：
    1. 若环境变量 XINZHI_ADMIN_TOKEN 有值，优先使用它。若对应文件不存在则写入该值（权限 0600）。
    2. 否则读取 token 文件，若文件不存在则随机生成并保存到 .local/admin-token（权限 0600）。
    返回值：(token, token_file_path, is_from_env)
    """
    if token_file_path is None:
        token_path = DEFAULT_TOKEN_FILE
    else:
        token_path = Path(token_file_path)

    token_path.parent.mkdir(parents=True, exist_ok=True)

    env_token = os.environ.get("XINZHI_ADMIN_TOKEN", "").strip()
    if env_token:
        # 环境变量提供令牌
        try:
            token_path.write_text(env_token, encoding="utf-8")
            token_path.chmod(0o600)
        except OSError:
            pass
        return env_token, token_path, True

    if token_path.exists():
        token = token_path.read_text(encoding="utf-8").strip()
        if token:
            return token, token_path, False

    # 生成安全随机密码并保存
    new_token = secrets.token_urlsafe(32)
    token_path.write_text(new_token, encoding="utf-8")
    token_path.chmod(0o600)
    return new_token, token_path, False


class LoginRateLimiter:
    """基于客户端 IP 的登录尝试限流器（60秒内最多5次失败）"""

    def __init__(self, max_attempts: int = 5, window_seconds: float = 60.0):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self.failed_attempts: Dict[str, List[float]] = defaultdict(list)

    def is_blocked(self, ip: str) -> bool:
        """检查该 IP 是否因尝试失败过多被临时封锁"""
        now = time.time()
        cutoff = now - self.window_seconds
        # 清理过期时间戳
        self.failed_attempts[ip] = [t for t in self.failed_attempts[ip] if t > cutoff]
        return len(self.failed_attempts[ip]) >= self.max_attempts

    def record_failure(self, ip: str) -> None:
        """记录一次失败尝试"""
        now = time.time()
        cutoff = now - self.window_seconds
        self.failed_attempts[ip] = [t for t in self.failed_attempts[ip] if t > cutoff]
        self.failed_attempts[ip].append(now)

    def record_success(self, ip: str) -> None:
        """登录成功时重置该 IP 失败记录"""
        self.failed_attempts.pop(ip, None)


def verify_admin_token(input_token: str, actual_token: str) -> bool:
    """使用常量时间比对密码，抵御时序侧信道攻击"""
    if not input_token or not actual_token:
        return False
    return hmac.compare_digest(input_token.strip().encode("utf-8"), actual_token.strip().encode("utf-8"))


def create_session(conn: sqlite3.Connection, ttl_seconds: float = 86400.0) -> Tuple[str, str]:
    """生成新会话与关联的 CSRF Token，存入 sessions 表"""
    session_token = secrets.token_urlsafe(32)
    csrf_token = secrets.token_urlsafe(32)
    now = time.time()
    expires_at = now + ttl_seconds

    with conn:
        conn.execute(
            """
            INSERT INTO sessions (token, csrf_token, created_at, expires_at)
            VALUES (?, ?, ?, ?)
            """,
            (session_token, csrf_token, now, expires_at),
        )

    return session_token, csrf_token


def get_session(conn: sqlite3.Connection, session_token: str) -> Optional[Dict[str, any]]:
    """验证并获取有效会话（未过期）"""
    if not session_token:
        return None
    now = time.time()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT token, csrf_token, created_at, expires_at
        FROM sessions
        WHERE token = ? AND expires_at > ?
        """,
        (session_token, now),
    )
    row = cur.fetchone()
    return row


def revoke_session(conn: sqlite3.Connection, session_token: str) -> None:
    """注销会话"""
    if not session_token:
        return
    with conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (session_token,))


def clean_expired_sessions(conn: sqlite3.Connection) -> None:
    """定期清理过期会话"""
    now = time.time()
    with conn:
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
