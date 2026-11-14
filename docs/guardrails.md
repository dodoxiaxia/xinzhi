# 发布前守卫

运行 `python3 scripts/check_guardrails.py`；提交 PR 前运行
`python3 scripts/check_guardrails.py --base origin/main --commit-range origin/main..HEAD PR_BODY.md`。
`--list` 列出检查，`--only NAME[,NAME]` 选检查，`--public DIR` 指定实际发布目录。
无 Git 元数据时明确 SKIP；默认只读取 Git 跟踪文本，不遍历运行时数据。
额外位置参数可检查 PR 正文；二进制、超过 3 MiB 的文件和 data URI 不做文本匹配。

CI 经 `test_public_build.py` 导入两组守卫测试；本任务不能修改工作流。
daily 的测试仅在 `deploy=='true'`、真实构建后运行，所以此时检查的是从 state 构建的真实 public/。

配置在 `config/guardrails.json`，`allow` 每项包含 `check`、路径 glob `path`、
必填的具体 `reason`，可用 `line_regex` 限定命中行。无理由或没有抑制任何命中的条目会失败。
也可在同一行或上一行写 `guardrails:allow CHECK 具体理由`。
例外应限定到实际内容，不得为新凭据加例外。`baseline` 记录既有二进制路径；
`added_allow` 只保留明确测试夹具及站点图标；`large_text` 可列出需扫描的大文本 glob。

## banned-words

禁止词表在检查器的 `ENCODED_WORDS` UTF-8 base64 元组中，文档和测试不写原词。
忽略大小写，英文按字母数字边界匹配，中文按子串匹配；同时检查指定提交范围的消息。
删除相关文字并重写提交消息。错误仅报告序号、行和列；例外必须说明保留原因。

## public-ids

Worker 注入点及顶层构建占位符必须登记在 `INJECTED_WORKER_CONSTANTS`。
增加注入时证明不携带审核、暂缓或隐藏标识，并在 `test_public_bibliography_review.py` 添加测试。
真实 public/ 文件名必须通过发布白名单（包括月分片）；Worker 不能携带上述标识，
未登记的大 JSON 常量也会失败。移除多余文件或修正投影，避免题录泄漏；例外需具体证据。
本地没有 public/ 时输出 SKIP，不触发构建。

## secrets

检测常见凭据前缀、私钥头、Bearer 字面量、Cloudflare 赋值、凭据赋值及保守高熵候选。
诊断只保留前四字符。删除凭据，改用环境变量或平台 Secret；已经泄漏的凭据需轮换。
明显测试占位符、散列、路径和 URL 排除；合法字母表、历史资源定位符等使用带理由的精确例外。
此检查是启发式守卫，不能替代人工审查。

## hex32

文档和源码不得新增独立 32 位十六进制标识；长散列不匹配。
改用七位提交 SHA；确需保存历史原始标识时，用配置或行内标记说明理由。

## sources-fresh

复用 `build_sources.stale(root)` 检查两套拼接产物和期刊分级副本。
运行 `python3 scripts/build_sources.py` 并提交产物。保持源码与发布行为一致；不建议例外。

## forbidden-files

禁止将 PDF、截图、录像、压缩包、数据库、环境文件和密钥文件放入 PR。
证据放仓库外，参照 PR 模板。全树检查允许既有 baseline；差异检查中新增截图即使在旧目录也失败，
仅允许 `added_allow` 中明确夹具与图标。新增例外必须解释用途，不能将整个截图目录加入新增许可。

## workflows-untouched

仅 `--base` 差异模式检查工作流；CI 变更先写 docs/ 计划。
已获授权的维护可显式使用 `--allow-workflows`；常规 PR 应移除工作流变更。

## ui-banned-labels

只扫描 index.html、src/app/*.js、style.css、edge/src/*.js 中的四种旧审核提示。
移除读者可见旧标签。feed 和生成器不在扫描范围；既有 UI 违例用理由明确的例外保留待后续修复。

## feature-map-selectors

存在 docs/feature-map.json 时递归检查 selector；缺文件时明确 SKIP。
检查 ID、属性名和类名在界面源码中的证据，以发现地图与实现脱节。
更新地图或修正源码，`scripts/feature_map_walk.cjs` 展示在线状态；动态构造的例外应解释来源。

## state-counts

扫描 `scripts/test_*`、`tests/`、`service/tests/` 中的测试，找出把 state 库存数量
（源数、条目数、feed 数、题录数等）和大于 2 的整数字面量做相等比较的写法。
只跟踪从仓库根目录读取的 state 文件（如 `data/library.json`、`data/source-health.json`、
`public/public.js`、`public/assets/*.js`），再检查 `len(...)==82`、`assertEqual(count, 79)`、
`enabledFeeds` / `feedCount` / `sources` 等字段等于字面量，或 `{'empty_feed': 82}` 这类摘要。
0、1、2 以及测试自己在临时目录里构造的夹具数据不报。期望值应从同一份数据推导（见 #161）。
行内或配置例外必须写明理由。
