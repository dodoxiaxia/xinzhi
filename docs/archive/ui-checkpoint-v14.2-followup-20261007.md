# UI/断点合版复测与 v14.2 发布阻塞

本交接修复候选 `9918c8c67ade43e49a88aa6fe8bc9bc39cc23eaf` 的信源测试，并合入当前 main `12701e17e71eb3c2eb1f76cfc42766d352e5a5a8`。共同基线 `e238e6f2d93de6387f1530e079acc2836c2dbf95`；app、daily workflow、build_public、release_integrity 四处三方合并无冲突。v14.2 的下载 Worker、全文队列工作流、Cloudflare 调度器与配置保持 main 的原字节，未覆盖新队列功能。源码版本保留 v14.2，本候选未发布。

## 修复和回归

`test_source_health_ui.cjs` 加载实际 journal-metrics 模块与配置，并执行 app 中真实 journalMetricBadge/journalMetricDetails helper。没有空实现替代。原29项信源断言保留，增加11项实际指标/来源/未核实/历史参考/转义断言，共40项通过。

合版后457项 Python 单元测试、15个 Node 离线测试命令通过，包括新全文队列/OIDC/调度器、旧 PDF/DOI/模型边界与公开摘要证据验证。首屏20场景/240检查通过：颜色在 CSS 和 app 初始化间不跳变，裸网址保持不变，已保存的 compact 视图仍生效。

合版后浏览器520断言/60布局、67周榜 fixture、116期刊与真实周榜接入检查、完整 DOI 浏览器检查通过。全部外部请求拦截或模拟，实际模型调用为0。浏览器专用目录明确省略历史归档，构建6文件仅用于界面检查；不能冒充完整生产包。

原数据任务的完整 `9918c8c` 构建和3个ZIP逐文件回读证据另见 `727de5881c4da56e0f07349ed60ec91616913bc5` 的 `editorial/handoffs/offline-regression-9918c8c/README.md`。它验证固定 state `5dd46b9a0e8aaa3aee94f1c0bc6c88679baaae96` 的31,339,518字节/14,480条历史缓存；SHA256 `ec8b03e740668080dc93c46c70f1033bf36c377485bd6ae7edc47d9cf8f8efdc`。这些是旧候选的完整构建证据；本合版仍须在相同完整 restore 环境重跑构建/包回读。

原任务实际旧账本只含第一请求，本候选的两请求修复 helper 正确拒绝该文件。原任务按已授权固定收据先匹配第一条，后 merge_ledger 补第二条，将预留核对到4次/3800输出，并验证暂停继续生效；不能说本 helper 修复了实际单请求文件。提供商美元支出未知，8次/9600输出试跑上限不是套餐额度。

## 新发现的生产阻塞

main v14.2 的 daily-refresh run `37612765941`（2026-10-07 11:14–11:15 UTC）已失败。数据刷新/构建和全部发布前离线门禁通过；job `112763759621` 的第8步“更新全文队列调度器并确认既有受保护配置”失败，Pages 发布和 state 保存均 skipped。Cloudflare 日志原句为 `No access to the specified service.`，路径指向 `/workers/services/xinzhi-cron`，凭据/账号值未输出。不能仅据此断言是某个 token 权限或账号配置；应核对既有 Worker 服务身份、所属账号与既有部署权限。

同 commit 的 fulltext-queue run `37612765976` success，只证明该工作流运行完成，不能代替 Pages 发布或证明真实队列任务领取成功。本轮没有部署、触发 Actions、改权限、读取凭据值或创建调度。

发布链把另一个 Worker 的更新放在 Pages 前，现有故障会持续阻止 UI 与内容更新；不能忽略这一步并宣称后台下载工作正常，也不能未经验证新增权限解决。

## 最小 UI 发布建议

可独立交付信源卡片、状态位置、响应式阅读列、期刊指标与来源说明、首屏不跳色/不改裸网址。这些无需模型调用或完成24篇内容。应从最新 main 有选择地抽取展示变更，保留正常生产下载模式与已核公开库快照；将全文队列运行和 Worker 配置作为单独验收项，解决上述实际失败后再部署队列功能。

周榜24篇当前仅题名22、中文摘要1、study0、quicklook0。若暂不发布24篇预生成流程，必须保留原周榜/模型服务行为：组合 app 对 weeklyPick 的“只读预生成”限制不能原样带入旧8篇周榜；最小 UI 候选需改成仅对实际预生成榜成员生效并单独回归。保留证据校验、预算暂停、archive restore、构建/打包守卫；不得伪造结果、清除暂停或自动扩展收费工作。

本候选保留组合24榜严格待生成展示，未将其伪称最小 UI 发布候选。云端 GET 的403缺少原响应头/CF-Ray或对应 Security Event，归因仍未解决；本轮未重复发模型请求。公开摘要分析与受口令保护的 private PDF 全文下载边界不变，不能称现有模型已经读取全文。
