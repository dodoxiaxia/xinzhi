# 独立 study API 修复：先部署 API，再验证和填缓存

独立提交：`bb55fc29dc681a9a45a3534b911dd45954ad81fa`。
父提交是最新 main：`75f538eff711e7eb53628e0c101df278a97c3ee7`。
本地隔离分支：`codex/study-evidence-api-fix-20261007`，工作树 `/workspace/study-evidence-api`。

严格只改四个文件：

- `edge/_worker.js`：仅 study 提示词、证据 ID 选择/还原及证据校验。
- `scripts/test_study_services.cjs`：现有离线服务夹具适配内部协议。
- `scripts/test_study_evidence_regression.cjs`：20组真实公开摘要/构造反例回归。
- `editorial/week_study_failure_fixture_20261007.json`：嵌入完整公开摘要与历史502元数据；明确没有保存当时原始模型输出。

不依赖预生成流水线、周榜数据、UI、预算模块或新配置；没有包含 DOI/PDF 功能变更。
POST仍只接收既有ID字段；成功响应与共享缓存仍使用 `{text,quote}`，`STUDY_VERSION=1`、缓存键与读缓存行为保持。
服务端把当前原文的连续片段赋ID，模型只选一个本篇ID，然后恢复原文并执行长度、逐字包含和同引句数字检查。
长度错现在区分为 `invalid_study_quote_length`；未知/跨论文/拼接ID、额外quote、常见中文数量写法绕过均被拒绝。

单篇study仍为首轮最多1600、一次重试最多2200输出token；至多2次提供商调用，401/403/429不重试。
原摘要之外新增证据目录，会增加输入token；不能声称费用不变。没有修改MODEL_CALL_CAP/DAILY_CAP/IP_CAP/模型配置。

四项离线检查已通过，真实模型调用为0：

```sh
node scripts/test_study_evidence_regression.cjs
node scripts/test_study_services.cjs
node scripts/test_edge_worker.cjs
node scripts/test_pdf_worker.cjs
```

## 获取固定提交

遵守本任务仅推送 `codex/week-precompute-20261007` 的约束，没有推送额外生产/修复分支。
该允许分支携带本目录的 `.bundle` 与可读 `.patch`，因此集成负责人无需合并整个预生成分支。
在已有父提交 `75f538e` 的仓库中从 bundle 导入后，可审查和 cherry-pick 原固定SHA：

```sh
git bundle verify /path/to/study-evidence-api-bb55fc2.bundle
git fetch /path/to/study-evidence-api-bb55fc2.bundle refs/heads/codex/study-evidence-api-fix-20261007
git show --stat bb55fc29dc681a9a45a3534b911dd45954ad81fa
# 仅唯一集成负责人在批准后操作自己的集成分支
git cherry-pick bb55fc29dc681a9a45a3534b911dd45954ad81fa
```

## 阶段顺序

1. 唯一集成/发布负责人审查并发布本API小提交，保持现有UI/榜单。
2. 确认线上运行的确为修复后代码，再用既有API对失败论文做一次真实study验证；先记预留，失败立即停。不得重复收费测试旧代码。
3. 首次成功后按用户确认的真实预算与服务限额，增量补本批24篇的缺项，并保存每次尝试/校验结果。未通过不能计完成。
4. 整榜UI发布等待缓存覆盖验收。第一步不再依赖第四步，因此没有循环依赖。

本次没有部署、没有实际写state、没有调用模型、没有索取或创建凭据。
