# 付费调用前持久化断点：独立、默认关闭

> 2026-10-10 更新：经站点所有者授权已默认启用（变量设为 0 可关闭）；证据核对未通过记为终态 `rejected`，不再全局暂停；10/07 的暂停已按固定回执解除。见 [运行依赖与故障复盘](运行依赖与故障复盘-20261010.md)。

本修复供唯一集成负责人审查，不能作为“已线上验证”的证据。没有执行真实 GitHub state 写入、模型调用或部署，没有增加 token/权限/预算或生产调度。

`week_precompute_checkpoint.py` 通过既有 GitHub Git Data API，仅提交 `data/week-precompute-ledger.json` 和 `data/week-precompute-cache.json`。每个新请求有独立 requestId；在其预算预留被远端确认之前，模型回调不会执行。每份通过原文/数字校验的结果随后持久化；最终记录 validated。原公开目录、其他 state 文件及 main 代码不会被该模块修改。

提交以读到的 state HEAD 为唯一 parent；PATCH ref 使用 force:false，并前后核对 ref。403/401/429、分支竞争、超时或结果不确定立即停止，不自动重试。即使模型返回后 runner 消失，远端保留 started 预留，下次恢复会阻止重复付费；已经持久化的成功结果不丢弃。对刚返回、还没能写入的响应，不能保证恢复内容，因此必须保持未确认状态而不是重新收费。

`week_precompute_ci.py` 提供严格限定 api.github.com、拒绝重定向、响应大小/时间受限的适配器。它只在既有 Actions 执行环境且 `XINZHI_PRECOMPUTE_STATE_CHECKPOINT=1` 时使用已有 `GITHUB_TOKEN`。没有创建新 token；workflow 原有 contents:write 权限保持。开关默认关闭，未启用时维持 `paid_ci_requires_durable_checkpoint` 拒绝付费。

本次已接入 runner 的 restore → save合并账本 → 持久化预留 → 调模型 → 验证 → 持久化结果路径，并修复 workflow 最终保存 state 时的旧租约：使用本次最新 checkpoint HEAD，不能继续以最初 restore SHA 覆盖。若过程中出现其他写者，租约仍拒绝覆盖。失败 artifact 额外带两份断点文件，作为补充恢复证据；不是依靠结束时上传来保护调用前预留。

离线测试：27项后端测试、5项实际 runner/CI 适配测试；覆盖调用前远端可读预留、零模型的预留写失败、生成后写失败、跨 runner 不重复付费、暂停保留、竞争与不确定确认、同一提交包含两个文件、Git blob hash及最新租约。现有本地预算和缓存测试继续有效。

启用前仍由集成负责人完成：

1. 审查并集成本补丁，核实既有 token 对既有 state 分支的权限/分支保护；不扩大权限。
2. 核对真实历史账本及暂停原因；必须有明确人工核对记录才能解决旧 failed_or_uncertain，不得仅删除 pause 来重跑。自动恢复器不会解除这些状态。
3. 在既有 Actions 的无模型测试中验证真实 checkpoint 权限与租约，再设仓库变量 `XINZHI_PRECOMPUTE_STATE_CHECKPOINT=1`。本任务没有替用户设置该变量。
4. 实际付费仍受单独确认的任务执行包络、服务限额及账户条件约束。本提交保留8次/9600的本地试跑上限；它不是用户套餐额度，详见预算审计文档。

API修复与本流水线修复分阶段审查：API小提交无需依赖此开关或本模块，先部署API、单篇验证，再按确认预算补齐缓存，最后发布整榜UI。
