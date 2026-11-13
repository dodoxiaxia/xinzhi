-- D1 影子写镜像表结构（kv_mirror）
--
-- 说明：
-- 1. 站点主账本仍是 Cloudflare KV（QL_KV），每次成功写 KV 后同步写入本表，每条 KV 记录对应一行。
-- 2. 选择通用镜像表而不是多张业务实体表的原因：
--    - 对账脚本只需按 key 比较键集合与内容 sha256，无需为每个实体单独编写一套对账逻辑；
--    - 业务实体 JSON 字段后续演进时无需反复修改数据库表结构；
--    - 在 PR-5 正式切换主账本前，可再从本表安全迁出或派生所需的实体表。
-- 3. 执行方式：本仓库不自动执行本文件，只能由维护者人工通过以下 Wrangler 命令执行：
--      wrangler d1 execute xinzhi-library --remote --file d1/schema.sql
-- 4. 幂等性：所有建表与建索引语句均使用 IF NOT EXISTS，可安全重复执行。

CREATE TABLE IF NOT EXISTS kv_mirror (
  key        TEXT PRIMARY KEY NOT NULL,   -- 与 KV 键完全相同
  entity     TEXT NOT NULL,               -- 业务实体：paper、job、queue、attempt、drive、index、quota 等
  value      TEXT,                        -- KV 里的原始字符串；超过 1,000,000 字节时为 NULL
  size       INTEGER NOT NULL DEFAULT 0,  -- value 的 UTF-8 字节数
  sha256     TEXT,                        -- value 的小写十六进制 SHA-256
  expires_at INTEGER,                     -- KV 过期时间（毫秒时间戳），无 TTL 为 NULL
  updated_at INTEGER NOT NULL,            -- 这次 KV 写入或删除完成的毫秒时间戳
  deleted    INTEGER NOT NULL DEFAULT 0   -- 1 表示 KV 里已删除（只打标记，不删行）
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS kv_mirror_entity ON kv_mirror (entity, key);
CREATE INDEX IF NOT EXISTS kv_mirror_updated ON kv_mirror (updated_at);
