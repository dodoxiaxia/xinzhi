# 内容拒绝隔离：不激活的候选策略

用户的生产恢复与预算确认尚未收到。本候选没有批准记录、生产账本/变量修改、真实 API、Actions 启动或部署。基线为 .19 `1e6d028024c005e813fbec29828c33201ce09b2e`；同时合入结构接线 `4c105af3ab2499e9e0e81787e6e986f04834d543` 与身份映射修补 `d75439f29187aa38c091a841b6692d347696765c`。原作者仍拥有映射修补，本文不重复修改其代码。

## 已核实历史

固定实际 state `0e9b75e078ba7208d645bdff16ef9dfacafc1e3d` 的 2026-10-07 第二项：DOI `10.1001/jamanetworkopen.2026.37545`、study、sourceHash `2195a1591c9db6cf0be4b6eea1d16869a073a28cbc017898b16fdc21d6231f8c`、时间 `2026-10-07T09:33:25.428137+00:00`。保留原 failed_or_uncertain、2 次/3800 输出 token 预约；当日总4次/3800不退款、不改成成功。

历史 Worker `03e2c7c98b2ba80583962df2e6da29d110e67c99` 的 checkStudy819 在引句长度<12/>360或非摘要逐字片段时抛 quote_not_in_abstract；generateStudy842～846最多一次校验重试；handleStudy945～946包装成网站 model_failed/detail 的HTTP502。它不是provider gateway502。原模型输出未保留，不能确定长度还是literal错误；精确调用、usage、账单未知。旧receipt里的HTTP200诊断没有绑定该ledger项，本策略显式保留 diagnosticRequestBound=false。

## 已完成的纯函数

`week_precompute_isolation_policy.py` 不读环境/配置、不做I/O，不被现有runner/budget/checkpoint导入。`legacy_proposal` 只生成未批准的精确请求处置提案；`reviewed_record` 要求外部明确的批准引用与限定scope，不能自动构造批准；`effective_blockers` 只预览历史隔离，原ledger/pause/status/预约逐字保留，productionPolicyActivated=false。fixture引用仅供测试，不是用户批准。

仅已批准且完全匹配历史receipt、日期、身份/hash/task/time、状态和预约的单项可在预览中解除对其它身份的全局拦截；该study仍quarantine，同项不得自动重试。其它日期或请求的相同错误码、403/429、认证、transport、checkpoint失败及未知状态不继承豁免。篡改身份、任务、时间、预约、类型、receipt或批准scope均拒绝。

`classify_configured_failure` 只有在受信任runner已明确记录收到完整stop响应、随后 evidence_validation_failed 时返回内容隔离分类；普通HTTP或错误字符串不能替代响应证明。其它失败仍要求全局暂停与保留不确定性。usage未知不等于请求结果未知，两种信息须分别保留。

## 下一阶段接线与验收

在生产确认之后仍需独立小补丁；当前策略不能仅靠发布生效：

1. configured runner checkpoint响应收到/finish_reason及逐任务验证结果；不合格任务不入库，成功同批任务保留，拒绝项无自动重试。checkpoint失败不得误分为内容拒绝。
2. planner排除sourceHash/身份/task绑定的隔离项；原作者的同PMID/不同DOI身份冲突继续阻止付费，不自动重绑。
3. 预算与checkpoint预约前统一判定effective blockers。现有checkpoint仍扫描全部历史pause/uncertain，不能只绕过runner的ledger.paused。
4. 恢复merge和checkpoint更新守卫支持append-only隔离核对记录，拒绝删改原记录、预约、usage、隔离证明或批准引用；未知历史、额外失败和分支竞争仍阻断。
5. 在既有Actions身份中先无模型验证两文件checkpoint与lease，核实已有opt-in与配置存在性；不绕过变量读取403、不新建凭据/权限。
6. 获批准后只运行独立周榜consumer或核实后的fast路径；不启动full的标题翻译。真实调用前先持久化预约，遇403/429或不确定写入一次即停。

回归须覆盖默认未批准零调用、旧项精准隔离且预约不变、同项无重试、其它新身份可按原预算处理、同样代码的另一项仍阻断、未知传输不放行、响应后checkpoint失效、有效同批结果保留、跨runner恢复不重复收费、CAS冲突、隔离记录删除/篡改，以及原作者DOI→DOI真实store fixture。

## 预算和生产边界

当前代码仍8次/9600周榜局部输出预约，未改为17400。每日从零预约开始最多两次5800+3800，第二次可能截断，不能保证两篇成功；第三篇下一UTC日补。希望同日3次各5800，需要用户明确批准9600→17400，仍8calls、首批最多3公开摘要，不买套餐。该局部上限不覆盖旧full中translate_titles --run --limit60（每批max_tokens4000），也不代表账户总费用。

真实配置和checkpoint opt-in仍未核实；仓库变量读取403保持尊重。真实PDF来源快检等待用户，与本候选隔离。这里没有清全账本、缩小原quote/数字守卫、放松暂停、取得全文、私有索引或正式归档。
