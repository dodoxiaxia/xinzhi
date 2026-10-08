# Rolling board GLM consumer handoff

本补丁仅供 `01a11479` 集成；未发布、未调用真实模型、未写远端 main/state、未改变调度、变量、凭据、模型权限或预算。基线 main 为 `1e6d028024c005e813fbec29828c33201ce09b2e`。已读取 .19 发布回执 `a49ee2150b9bd4402860807ae6145cc7b3fc8de4/docs/night-v14219-release-receipt-20261008.md`，审计固定 state `0e9b75e078ba7208d645bdff16ef9dfacafc1e3d`。该实际产物为 24 篇，title/translate/quicklook 各 21/24，study 0/24；本补丁不声称线上覆盖已补齐。

## 有限接线

`ci_daily.py` 在既有 fast/full 刷新中执行相同流程：公开来源刷新 → cache-only 周榜（含已核对 overlay）→ 持久 pending 清单 → 一次 configured consumer → cache-only 重建周榜与 pending → public build/完整性校验。删除旧 full-only、overlay 前的重复模型入口，没有新增 cron/job/service。

消费者使用原 `week_precompute.py --run --provider configured --attempt-limit 8`，新增 `--pending-only --paper-limit 3`。先按当前真实窗口与 sourceHash 重新规划，最多三篇，core 缺口优先，之后才补 study-only。只向既有模型发送公开标题、刊名、摘要、摘要证据片段及 missingTasks。已完成的译文/quicklook 不会因为缺 study 而重新收费。sourceHash 变更重新生成；身份映射冲突跳过并记录，禁止自动重绑。

继续使用原缓存 prompt/model/validator 版本、数字与原文引句校验、请求前持久预约、现有 state CAS checkpoint。成功任务逐项落盘；403/429/认证、无效数字/引句或不确定请求立即停止、保留结果和暂停，不重试，不清空历史账本。失败后仍重建有效内容与剩余队列；硬超时留下的不确定锁/预约继续 fail-closed，下一 runner 从持久 checkpoint 恢复，不宣称所有超时都能当次发布。前端 `allowAutomaticGeneration=false` 不变。

生成结果与计划另存入 `docs/last-refresh.json.precomputeGeneration`，避免后续 cache-only 重建覆盖调用/阻塞证据。`weeklyContent.generationStep` 和 publicationPolicy 已改为两种模式共用的消费者；完整覆盖仍以公开产物的字段、别名、sourceHash 和计数校验为准。

## 当前三缺口及调用计划

固定 state 的三篇全部为 `new_identity`，不是 hashchange/mapping；见同名 JSON 审计。

| PMID | paperID | 待生成 |
| --- | --- | --- |
| 42844166 | doi:10.1093/ehjci/jeag280 | title/translate/study/quicklook |
| 42843992 | doi:10.1136/heartjnl-2026-328438 | title/translate/study/quicklook |
| 42843991 | doi:10.1136/heartjnl-2026-328566 | title/translate/study/quicklook |

沿用本地保守上限：每 UTC 日 8 次尝试、9,600 输出 token，每次最多 5,800。它不是已核实账户金额/余额。每篇一个 combined 请求、最多三篇、零自动重试；实际受每日剩余额度限制。原预约规则从零余额使用开始时，前两次预约 5,800 和 3,800，第三次因当日输出预约耗尽不发出，下一 UTC 日由既有刷新再补。未退款已预约 token、未按未知实际费用回收额度、未降低截断守卫、未扩大限额来保证当批 24/24。

## 配置复用与真实阻塞

原 daily workflow 已传入 `XINZHI_LLM_ENDPOINT/MODEL/API_KEY` 及现有 `GITHUB_TOKEN`、`XINZHI_PRECOMPUTE_STATE_CHECKPOINT`，已有 contents:write 和 checkpoint-head lease，因此结构上可直接复用；补丁没有创建配置。

本环境没有这三项模型环境变量或 `.local/llm.json`。只读仓库变量请求返回 GitHub 403 `Resource not accessible by integration`，已停止该读取；无法核实生产 endpoint/model、checkpoint opt-in 是否为 1 或账户金额。固定 state 的持久账本仍暂停 `http_502:quote_not_in_abstract`，包含 2026-10-07 的 failed_or_uncertain study 请求，四次历史预约及 3,800 输出 token 预约保留；实际账单未知。没有因“token够用”擅自清除暂停或折算金额。

真实 GLM POST、真实 state checkpoint 写入/CAS、CI 生产环境、custom-domain/model/status endpoint 和部署后覆盖都未验。用户已授权范围内的生产实测，需要唯一主集成确认既有配置可见、原 checkpoint opt-in 已启用，并用既有账本恢复流程核对历史不确定请求。不得为此新增权限/额度或自动抹掉历史。随后按上述最多三篇、原限额计划运行既有消费者；失败回执必须保留 pending/paidRequests/blocker，不能把离线 fixture 通过当线上跑通。

## 离线验收

181 项离线回归通过（54.466 秒），py_compile 与 diff --check 通过。新 `test_week_precompute_consumer.py` 使用公开合成摘要、假的 GitHub/provider transport；真实脚本入口证明部分成功持久保存、重启零重复模型请求。包含新三篇优先、study-only 不重复译文/quicklook、9,600 预约耗尽、sourceHash 变更、映射冲突、完成缓存零 checkpoint/模型请求、403/429 一次即停、无效引句/数字保留成功任务。原预算、缓存、checkpoint、CI、周榜公开覆盖、pending 和 workflow 回归共同执行。

```bash
PYTHONPATH=scripts python3 -m unittest test_week_precompute test_week_precompute_budget test_week_precompute_cache test_week_precompute_checkpoint test_week_precompute_ci test_week_precompute_integration test_week_precompute_consumer test_ci_daily test_week_coverage_status test_public_precompute_pending test_workflow
```

集成只需 cherry-pick 最终候选 SHA，再按原流程审阅/验证；此任务不负责发布或开启配置。没有用 Sol 手填三篇，也没有将旧离线 24/24 冒充 .19 的实际产物。
