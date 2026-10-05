"""
心知 (Xinzhi) - 数据库与模型层
使用 Python 标准库 sqlite3 实现，数据持久化于 .local/xinzhi.db
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# 默认基础路径为 outputs/xinzhi
BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_LOCAL_DIR = BASE_DIR / ".local"
DEFAULT_DB_PATH = DEFAULT_LOCAL_DIR / "xinzhi.db"

# 亚洲/上海时区 (+08:00)
SHANGHAI_TZ = timezone(timedelta(hours=8))


def get_shanghai_now() -> datetime:
    """获取当前 Asia/Shanghai 时区的时间对象"""
    return datetime.now(SHANGHAI_TZ)


def get_shanghai_date_str() -> str:
    """获取当前 Asia/Shanghai 日期字符串 YYYY-MM-DD"""
    return get_shanghai_now().strftime("%Y-%m-%d")


def get_shanghai_iso_str() -> str:
    """获取当前 Asia/Shanghai ISO 时间字符串"""
    return get_shanghai_now().isoformat()


# 公开读取层白名单字段（绝对不含内部审核人、内部核对标记、内部笔记或审计日志）
PUBLIC_ARTICLE_FIELDS = (
    "id",
    "title",
    "title_zh",
    "url",
    "doi",
    "source",
    "source_date",
    "category",
    "summary",
    "limitations",
    "study_type",
    "evidence_basis",
    "published_date",
)

# 编辑端可修改字段
EDITABLE_ARTICLE_FIELDS = (
    "title_zh",
    "summary",
    "limitations",
    "study_type",
    "evidence_basis",
    "reviewer",
    "source_checked",
)

# 允许的证据依据类型
ALLOWED_EVIDENCE_BASIS = ("index", "abstract", "fulltext")


def dict_factory(cursor: sqlite3.Cursor, row: tuple) -> Dict[str, Any]:
    """将 sqlite 查询行转换为字典"""
    d = {}
    for idx, col in enumerate(cursor.description):
        d[col[0]] = row[idx]
    return d


def get_db_connection(db_path: Optional[Path | str] = None) -> sqlite3.Connection:
    """获取数据库连接，并启用 WAL 模式与外键约束"""
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = dict_factory
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db(db_path: Optional[Path | str] = None) -> sqlite3.Connection:
    """初始化数据库表结构与索引"""
    conn = get_db_connection(db_path)
    with conn:
        # 文章表：保存文献原始元数据、编辑审核字段与发布状态
        conn.execute("""
        CREATE TABLE IF NOT EXISTS articles (
            id TEXT PRIMARY KEY,
            doi TEXT,
            url TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            source TEXT DEFAULT '',
            source_date TEXT DEFAULT '',
            category TEXT DEFAULT 'AI医疗',
            basis_raw TEXT DEFAULT '',
            title_zh TEXT DEFAULT '',
            summary TEXT DEFAULT '',
            limitations TEXT DEFAULT '',
            study_type TEXT DEFAULT '',
            evidence_basis TEXT DEFAULT 'index',
            reviewer TEXT DEFAULT '',
            source_checked INTEGER DEFAULT 0,
            status TEXT DEFAULT 'candidate',
            published_date TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """)

        conn.execute("CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_articles_published_date ON articles(published_date);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_articles_doi ON articles(doi);")

        # 内部共读记录表：独立存储科室共读记录与研讨纪要，公开层绝不返回
        conn.execute("""
        CREATE TABLE IF NOT EXISTS notes (
            key TEXT PRIMARY KEY,
            title TEXT DEFAULT '',
            content TEXT DEFAULT '',
            reviewer TEXT DEFAULT '',
            updated_at TEXT NOT NULL
        );
        """)

        # 会话表：存储编辑端登录生成的 session 与 csrf_token
        conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            csrf_token TEXT NOT NULL,
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL
        );
        """)

        # 审计日志表：记录编辑、发布、撤回、导入等关键操作（严禁记录密码或cookie）
        conn.execute("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            target_id TEXT,
            details TEXT,
            ip TEXT,
            created_at TEXT NOT NULL
        );
        """)

    return conn


def add_audit_log(
    conn: sqlite3.Connection,
    action: str,
    target_id: Optional[str] = None,
    details: Optional[str | dict] = None,
    ip: Optional[str] = None,
) -> None:
    """写入审计日志，安全过滤敏感数据"""
    if isinstance(details, dict):
        # 移除任何可能存在的密码、凭据或 cookie 字段
        safe_details = {k: v for k, v in details.items() if "token" not in k.lower() and "cookie" not in k.lower() and "pass" not in k.lower()}
        details_str = json.dumps(safe_details, ensure_ascii=False)
    else:
        details_str = str(details) if details else ""

    now_str = get_shanghai_iso_str()
    with conn:
        conn.execute(
            """
            INSERT INTO audit_logs (action, target_id, details, ip, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (action, target_id or "", details_str, ip or "", now_str),
        )


def sanitize_public_article(row: Dict[str, Any]) -> Dict[str, Any]:
    """严格按白名单输出公开文章字段，彻底阻断内部字段泄露"""
    return {k: row.get(k) for k in PUBLIC_ARTICLE_FIELDS}
