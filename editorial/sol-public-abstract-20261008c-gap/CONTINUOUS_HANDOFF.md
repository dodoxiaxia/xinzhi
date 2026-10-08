# 单篇增量补齐与既有缺口处理步骤

本候选只生成 DOI `10.1161/jaha.126.050332` / PMID `42841502` 的中文公开摘要和速览，共两条缓存格式结果。来源 hash 为 `8353e8f5fdc72d999835aa2e789e725c3be34cbd357c569e0a76872ff78393aa`，定义是 SHA256(英文标题 + 换行 + 规范化公开摘要)。官方 PubMed XML 与既有 `build_data.clean` 空白归一化后的摘要逐字匹配，数字及词序未改。独立 Sol 已核对来源、该 hash、翻译、全部 OR/CI/P 和四条逐字引句。仅公开摘要审校，不是医学或全文审查。

固定 main `afe3ca1447beb12fb2441a101f816a781aa1ae2a`、state `efaaf69713fcc8b5468b9d0052daa672a666df0e`，真实七日窗口为北京时间 2026-10-02 至 2026-10-08。机器验收从实际 state 读取当前 24 篇，在内存只补这一篇，原 23 篇的整行 hash 均不变：标题 24→24、中文摘要 23→24、速览 23→24、P0 待补 1→0。`studyMissing` 仍为 24，不能称全部研究结构或全文精读完成。`sources.json` 仅一篇；其中 window 是原 24 榜的来源窗口上下文，不是新生成了 24 篇。

## 已经工作的环节与尚未完成的环节

在 .15，`ci_daily.py` 已实际接入 `record_precompute_pending`：WEEK_BOARD 后、BUILD 前重算并保存 `data/public-precompute-pending.json`，随现有 state 保存流程持久化。这次 fast 刷新已准确留队 `new_identity`，不是依赖人工查看网页才发现。现有快刷只复用已核对结果，没有模型生成；完整刷新中的 configured 生成是可选步骤，暂停/失败与构建完成分别报告。

当前缺少已验证、获授权且可由 CI 连续执行的 Sol 作者/审校队列消费者。本次提供的预览和验收命令均为只读本地计算，不会自动调用 Sol，也不会解除服务或预算阻塞。不能将“队列已接入”“构建成功”或本次单篇补齐称为持续生成链路已跑通。

该 state 的费用账本仍暂停于 `http_502:quote_not_in_abstract`，历史预留为 4 次、3800 输出 tokens；账户余额和账单未核实。本候选没有新增外部模型 API 请求，没有修改 ledger、runtime cache、state、凭据或调度。不执行 `--run`、不解除暂停、不增加额度或循环重试。

## 主集成可直接执行的步骤

以下步骤供唯一集成/发布负责人 `01a11479` 使用；本任务没有发布。先在隔离候选 checkout 中重新读取最新公开榜，不能把本目录快照写回 state：

```bash
git fetch --no-tags origin main state
xinzhi_gap_state_sha=$(gh api repos/dodoxiaxia/xinzhi/git/ref/heads/state --jq '.object.sha')
git show "${xinzhi_gap_state_sha}:data/weekly-board.json" > /tmp/xinzhi-current-public-board.json
python scripts/public_precompute_pending.py --board /tmp/xinzhi-current-public-board.json
```

1. 以既有队列的 `paperID/sourceHash/missingTasks/requiredTaskVersions` 为有限输入，重新核对当前英文标题、完整合法公开摘要、DOI/PMID。最多当前 20–30 篇；仅处理缺失或失效任务，现有有效结果复用。身份冲突、来源变化和认证/预算暂停分别保留，不把它们清成“完成”。
2. 将仍匹配的待补公开条目交给现有获授权 Sol 会话撰写和独立会话审校。这是受控作者步骤，尚不是 CI 中可自动运行的 API。未读全文就只输出摘要级内容；不发送私人 PDF/索引。若存在已完成任务，停止为它重新生成。
3. 用既有 `week_precompute.store` 在内存构造新的独立 editorial 包，保持 origin `sol-session-public-abstract`、model `sol-session-model-unobserved`、generationPromptVersion `unobserved`、providerUsage `null`。条目增加精确 DOI/PMID；`w.find` 复用，`w.validate` 复验。将结果写入专用 editorial 包，不写 `data/week-precompute-cache.json` 或在线 KV。
4. 稀疏包使用 `scope: public-abstract-supplement`、`publicOnly: true`，只放待补 1–30 篇。本次 `sources.json` 只有一篇、`gap-cache.json` 只有两条。旧的 `preview()` 仍固定 24；新增显式 supplement 入口保持身份、源 hash、版本、引句/数字和诚实 provenance 的全部检查。

本候选的两条直接验收命令：

```bash
python scripts/preview_sol_public_overlay.py \
  --sources editorial/sol-public-abstract-20261008c-gap/sources.json \
  --overlay editorial/sol-public-abstract-20261008c-gap/gap-cache.json

python scripts/verify_public_sol_gap.py \
  --board /tmp/xinzhi-current-public-board.json \
  --sources editorial/sol-public-abstract-20261008c-gap/sources.json \
  --overlay editorial/sol-public-abstract-20261008c-gap/gap-cache.json
```

`verify_public_sol_gap.py` 不写输入或缓存：来源已变化、论文已离榜、待补任务已有有效结果、包内缺任务，均明确失败；它还验证原其他条目的整行 hash、窗口、排序和来源不变。它是通用的有限增量验收，可对后续已审校包执行，不能代替独立语义审校。新 supplement 在生产应用时也只填缺失/原 validator 判无效的任务，保留已有有效内容及 generationMeta；旧纠正包保留原有经核对覆盖规则。

5. 当且仅当新包语义审校和最新榜机器验收通过，主集成纳入该包及 `public_editorial_overlay.SUPPLEMENTS` 注册，并将实际包文件加入 release provenance。本候选已完成这两处接线。以后新增包同样要登记，不能通过任意目录扫描将未审稿自动发布。
6. 集成负责人在其隔离、已恢复最新 state 的 checkout 中执行既有 cache-only WEEK_BOARD 与 pending 步骤，再执行既有 BUILD/发布验收。对应只读模型阶段是 `python scripts/week_precompute.py`（不带 `--run`/`--read-runtime-cache`）；队列步骤是现有 `record_precompute_pending(ROOT)`。这些步骤会写集成 checkout 的榜/队列文件，只能由该负责人按既有 state 保存流程接续，本补稿任务没有执行它们。
7. 再核实公开 bundle 的字段、覆盖和最新来源。P0 待补为 0 只说明标题/中文摘要/速览齐备；study、全文和医学审查状态独立。由唯一负责人完成实际发布和线上验证，不能把离线测试当成云端模型连通证明。

本轮作者/审校受控执行已完成，自动发现/留队有实际 state 证据，增量复用与机器验收已通过。后续自动作者/审校消费者尚未接入验证，现有模型连接和账户预算本轮未复核，不作已跑通声明；待负责人在原授权范围内解决。没有新增调度、API、token 或自动收费入口。
