# 近7日榜与 API 预生成交接（2026-10-07）

本分支负责数据与预生成；app/style 的分类及折叠由 UI 分支负责；原集成任务是唯一发布负责人。本分支不部署、不修改 main/state、不新增生产调度。

默认24篇，可选20–30。北京时间当日及前6个自然日，严格校验真实出版日期。排除缺完整公开摘要、未来/过期/不精确日期、更新日期未独立确认的 RSS、勘误/评论/来信、低相关条目；DOI、PMID、规范化题名跨记录去重。四类为心血管、综合医学、AI医疗、AI前沿。分类不够时由其他合格方向填名额；不足20明确说明，不填旧稿。日榜原规则保留；周榜选择基于公开摘要与相关性，不代表医学质量评分。

## UI 数据契约

接受 UI 已实现的 `window.PREGENERATED`；键为 `pmid:数字` 或 `doi:小写doi`，同篇同时提供两种别名（若存在）：

```js
window.PREGENERATED['pmid:123'] = {
  translation: {title_zh:'…', abstract_zh:'…'} || null,
  quicklook: {title_zh:'…',one_line:'…',design:'…',findings:[{text:'…',quote:'…'}],limits:'…',why_read:'…'} || null,
  study: {task:'study',schemaVersion:1,scope:'public-abstract',papers:[/* 现有 study 格式 */],missingKeys:[],checklist:[],caveat:'…',generatedAt:'…',model:'…',generatedBy:'week-precompute'} || null,
  meta: {paperID:'doi:…',sourceHash:'完整64位SHA256',precomputeStatus:'ready|partial|pending',missingTasks:['study'],allowAutomaticGeneration:false,abstractSource:'…',abstractSourceUrl:'…',generationMeta:{translate:{modelVersion:'…',generatedAt:'…',promptVersion:'…',origin:'…'}}}
}
```

FEEDS 中入榜条目提供 `weeklyPick`（1开始）、`weeklyAt`、`weeklyCategory`（UI原有枚举：`cardio / general / aimed / aitech`，依次为心血管/综合医学/AI医疗/AI前沿），出版日期及英文原摘要用本批核对的原文。`window.WEEKLY_BOARD` 额外提供窗口、分类候选/入榜数、不足原因和覆盖数；UI 无须消费这个额外对象即可使用 PREGENERATED。空缺项不得自动 POST/自动重复收费，显示未完成状态；现成内容直接本地读取。

## 缓存与断点

`data/week-precompute-cache.json` 是不进入公开包的内容缓存。键由稳定 DOI/PMID paperID、题名+完整公开摘要的SHA256、任务/提示词版本（含 Worker 校验源码版本）、模型版本组成。每次复用重新机械校验。修改原文或提示词使旧键失效，保留旧条目；已验证同版结果只补缺。只有公开候选数据入模型，不读 library、私人索引、PDF 或内部资料。

`data/week-precompute-ledger.json` 是不进入公开包的持久尝试账本，随现有 state 数据恢复；调用前写入预留，不因失败退款。`.local/week-precompute.lock` 阻止同时运行。不确定已发出请求/崩溃遗留的 started 状态阻止自动重试，必须核对后由维护者恢复；认证/403/429/传输/证据错误暂停本 UTC 日付费工作，保留所有成功兄弟结果。只读恢复仍允许。不同机器的锁不构成分布式硬额度，必须继续使用既有唯一 daily-refresh 执行者和平台预算。

生产旧缓存提供16位十六进制 SHA256 前缀，须匹配本地完整原文指纹前缀，并重新校验翻译数字及引句。翻译严格保留题名与摘要所有数字及出现次数；研究六项与要点的中文数字必须来自同一项引句。语义、效应方向及医学可靠性仍需人工核对。

## 执行与预算

默认离线，不读配置、不联网、不调用模型。`--run --provider configured` 仅使用既有 `XINZHI_LLM_*` 环境或 `.local/llm.json`（不新建凭据/权限）；每篇把缺少的翻译/研究结构/要点合并为一次调用，单次输出上限5800 token（现有三个服务首轮上限之和），且每天累计预留输出最多9600 token（被替换的8×1200既有速览步骤上限），余额不足时缩小本次上限，用尽即停，不自动重试，串行。现有 full daily 的8次速览步骤替换为这个步骤，避免新增8次并行收费；原标题批处理预算不变。默认/硬最大为每UTC日8次尝试，恢复 state 中账本累计计数。美元预算和账户实际余量本环境不可读取，不能宣称已核实余额。已有公开摘要来源水合另有最多40次来源请求的硬边界。

`--run --provider runtime` 只调既有 learn.dryz.info 同域服务，只发送 PMID/DOI。每次POST预留2次实际模型尝试，覆盖 Worker 内部至多一次重试；先只读查共享缓存。POST 命中缓存可能没有模型调用，不能把POST数当实际提供商调用数。全站/每IP/提供商每日平台限额仍有效；不绕过、不扩大。

```bash
python3 scripts/week_precompute.py
python3 scripts/hydrate_week_public_sources.py --limit 24
python3 scripts/week_precompute.py --input data/week-source-candidates.json --read-runtime-cache
python3 scripts/week_precompute.py --input data/week-source-candidates.json --run --provider runtime --attempt-limit 8
python3 scripts/week_precompute.py --run --provider configured --attempt-limit 8
python3 scripts/build_public.py
```

生产调度继续由现有 daily.yml 唯一执行者负责。本分支不启用新定时器，不触发部署。必须由集成负责人验收代码、数据、预算与真实生成覆盖后发布。生成失败或不足24篇完整覆盖时，不宣称全榜预生成已完成；离线测试和构建成功不代表线上模型或UI端到端通过。

## 固定公开快照与本次覆盖

`editorial/week_precompute_sources_20261007.json` 为24篇有限公开源材料；`week_precompute_cache_20261007.json` 仅含已重新校验的1篇共享缓存译文；`week_precompute_coverage_20261007.json` 列出逐篇缺项；`week_precompute_receipt_20261007.json` 记录来源、离线检查与真实失败证据。当前标题23/24、摘要翻译1/24、研究结构0/24、要点0/24，全榜未完成。调用研究结构得到HTTP502 / quote_not_in_abstract，未通过逐字证据校验，已暂停。第一次翻译POST命中旧共享缓存，不能记作新的模型生成成功。

集成同日快照时，先恢复现有 state（数据），然后运行 `python3 scripts/restore_week_precompute_snapshot.py --apply`；只补匹配的24篇来源与缓存，不替换全库。接着离线 `python3 scripts/week_precompute.py`、`python3 scripts/build_public.py`。恢复器同时带回真实失败暂停，避免集成后自动重复收费。此步骤不部署。修复失败、人工核对付费尝试及既有费用限额前不要删除暂停或强行运行付费步骤。
