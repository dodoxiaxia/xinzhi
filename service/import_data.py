"""
心知 (Xinzhi) - 候选文献幂等导入脚本
按 doi/url 幂等导入 data/feeds.json 中的真实候选文章。
安全准则：
- 严格保留已有人工编辑字段（title_zh, summary, limitations, study_type, evidence_basis, reviewer, source_checked）
- 严格保留发布状态（status, published_date），绝不自动发布
- 保留原题名、URL、信源与原始日期，不凭空生成虚构研究结果
"""

from __future__ import annotations

import argparse
import json
import hashlib
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# 引入本模块的 db 工具
try:
    from .db import (
        BASE_DIR,
        DEFAULT_DB_PATH,
        add_audit_log,
        get_db_connection,
        get_shanghai_iso_str,
        init_db,
    )
except ImportError:
    # 允许作为顶层脚本直接执行 (python3 service/import_data.py)
    current_dir = Path(__file__).resolve().parent
    sys.path.insert(0, str(current_dir.parent))
    from service.db import (
        BASE_DIR,
        DEFAULT_DB_PATH,
        add_audit_log,
        get_db_connection,
        get_shanghai_iso_str,
        init_db,
    )

DEFAULT_FEEDS_PATH = BASE_DIR / "data" / "feeds.json"


def import_feeds(
    feeds_file: Path | str = DEFAULT_FEEDS_PATH,
    db_path: Path | str = DEFAULT_DB_PATH,
) -> Tuple[int, int, int]:
    """
    执行幂等导入。
    返回 (新增数, 保留数, 总候选数)
    """
    feeds_file = Path(feeds_file)
    db_path = Path(db_path)

    if not feeds_file.exists():
        raise FileNotFoundError(f"未找到 feeds 数据文件: {feeds_file.resolve()}")

    with open(feeds_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    items: List[Dict[str, Any]] = data.get("items", [])
    if not items:
        print("[XINZHI IMPORT] 提示: feeds.json 中无 items 数据")
        return 0, 0, 0

    conn = init_db(db_path)
    cur = conn.cursor()

    count_new = 0
    count_retained = 0
    now_iso = get_shanghai_iso_str()

    with conn:
        for item in items:
            url = str(item.get("url", "")).strip()
            doi = str(item.get("doi", "")).strip()
            title = str(item.get("title", "")).strip()
            source = str(item.get("journal", "") or item.get("source", "")).strip()
            source_date = str(item.get("date", "")).strip()
            category = str(item.get("category", "") or "AI医疗").strip()
            basis_raw = str(item.get("basis", "") or "RSS 元数据 · 待编辑核验").strip()
            item_id = str(item.get("id", "")).strip()

            if not url:
                continue

            # 1. 尝试按 doi 或 url 查询现有记录
            existing = None
            if doi:
                cur.execute("SELECT * FROM articles WHERE doi = ?", (doi,))
                existing = cur.fetchone()

            if not existing:
                cur.execute("SELECT * FROM articles WHERE url = ?", (url,))
                existing = cur.fetchone()

            if existing:
                # 记录已存在：严格保留已编辑/已发布字段！
                # 仅在现有记录元数据为空时补充元数据
                cur.execute(
                    """
                    UPDATE articles
                    SET source = CASE WHEN source = '' THEN ? ELSE source END,
                        source_date = CASE WHEN source_date = '' THEN ? ELSE source_date END,
                        category = CASE WHEN category = '' THEN ? ELSE category END,
                        basis_raw = CASE WHEN basis_raw = '' THEN ? ELSE basis_raw END
                    WHERE id = ?
                    """,
                    (source, source_date, category, basis_raw, existing["id"]),
                )
                count_retained += 1
            else:
                # 记录不存在：作为新候选插入，初始状态 candidate，未核对，未发布
                art_id = item_id if item_id else "art_" + hashlib.sha256(url.encode()).hexdigest()[:24]
                cur.execute(
                    """
                    INSERT INTO articles (
                        id, doi, url, title, source, source_date, category, basis_raw,
                        title_zh, summary, limitations, study_type, evidence_basis,
                        reviewer, source_checked, status, published_date, created_at, updated_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?,
                        '', '', '', '', 'index',
                        '', 0, 'candidate', NULL, ?, ?
                    )
                    """,
                    (
                        art_id,
                        doi,
                        url,
                        title,
                        source,
                        source_date,
                        category,
                        basis_raw,
                        now_iso,
                        now_iso,
                    ),
                )
                count_new += 1

        # 写入导入审计日志
        add_audit_log(
            conn,
            action="import_feeds",
            target_id=str(feeds_file.name),
            details={
                "new_imported": count_new,
                "retained_existing": count_retained,
                "total_processed": len(items),
            },
        )

    return count_new, count_retained, len(items)


def main() -> None:
    parser = argparse.ArgumentParser(description="心知 (Xinzhi) - 候选文献幂等导入")
    parser.add_argument(
        "--file",
        type=str,
        default=str(DEFAULT_FEEDS_PATH),
        help=f"feeds.json 文件路径 (默认: {DEFAULT_FEEDS_PATH})",
    )
    parser.add_argument(
        "--db",
        type=str,
        default=str(DEFAULT_DB_PATH),
        help=f"SQLite 数据库路径 (默认: {DEFAULT_DB_PATH})",
    )

    args = parser.parse_args()
    print(f"[XINZHI IMPORT] 正在从 {args.file} 导入候选文章到 {args.db} ...")
    new_cnt, retained_cnt, total_cnt = import_feeds(args.file, args.db)
    print(
        f"[XINZHI IMPORT] 导入完成！新增候选 {new_cnt} 篇，保留已存在/已编辑 {retained_cnt} 篇，总计处理 {total_cnt} 篇。"
    )


if __name__ == "__main__":
    main()
