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

`data/week-precompute-cache.json` 是不进入公开包的内容缓存。键由稳定 DOI/PMID paperID、题名+完整公开摘要的SHA256、任务独立的提示词/校验契约版本、模型版本组成。每次复用重新机械校验。修改原文或该任务提示词/校验契约使旧键失效，保留旧条目；无关 Worker/DOI 改动不会失效其他任务。线上缓存未报告提示词版本时，明确记录 `generationPromptVersion=unobserved`，本地版本不冒充线上生成版本。唯一历史翻译仅按已知旧版本、paperID、完整原文哈希白名单及重新校验兼容，保留原始版本标签；已验证同版结果只补缺。只有公开候选数据入模型，不读 library、私人索引、PDF 或内部资料。

`data/week-precompute-ledger.json` 是不进入公开包的持久尝试账本，随现有 state 数据恢复；调用前写入预留，不因失败退款。`.local/week-precompute.lock` 阻止同时运行。不确定已发出请求/崩溃遗留的 started 状态阻止自动重试，必须核对后由维护者恢复；认证/403/429/传输/证据错误暂停本 UTC 日付费工作，保留所有成功兄弟结果。只读恢复仍允许。不同机器的锁不构成分布式硬额度。审计发现现有 daily.yml 只在部署成功后保存 state，失败 runner 会丢失付费账本，因此本补丁在 `GITHUB_ACTIONS=true` 时拒绝付费预生成，错误码 `paid_ci_requires_durable_checkpoint`。离线构建仍可运行；需唯一集成负责人修复每次调用前后均可靠持久化与失败恢复，再启用原有执行路径。本分支不修改工作流或新增执行者。

生产旧缓存提供16位十六进制 SHA256 前缀，须匹配本地完整原文指纹前缀，并重新校验翻译数字及引句。翻译严格保留题名与摘要所有数字及出现次数；研究六项与要点的中文数字必须来自同一项引句。语义、效应方向及医学可靠性仍需人工核对。

## 执行与预算

默认离线，不读配置、不联网、不调用模型。`--run --provider configured` 仅使用既有 `XINZHI_LLM_*` 环境或 `.local/llm.json`（不新建凭据/权限）；每篇把缺少的翻译/研究结构/要点合并为一次调用，单次输出上限5800 token（现有三个服务首轮上限之和），且每天累计预留输出最多9600 token（从被替换速览步骤每次8×1200推定的本地保守试跑上限，非用户套餐/余额/原有服务级每日预算），余额不足时缩小本次上限，用尽即停，不自动重试，串行。现有 full daily 的8次速览步骤替换为这个步骤，避免新增8次并行收费；原标题批处理预算不变。默认/硬最大为每UTC日8次尝试，恢复 state 中账本累计计数。美元预算和账户实际余量本环境不可读取，不能宣称已核实余额。已有公开摘要来源水合另有最多40次来源请求的硬边界。

`--run --provider runtime` 只调既有 learn.dryz.info 同域服务，只发送 PMID/DOI。每次POST先预留2次实际模型尝试及该任务首轮+重试输出上限：translate 9000、study 3800、quicklook 3600 token；每天最多8次尝试且9600输出 token，两项必须同时通过。缺少历史输出账或损坏/未知请求时拒绝收费，不能按零消费处理。先只读查共享缓存，命中不预留。POST 命中缓存可能没有模型调用，不能把POST数当实际提供商调用数。全站/每IP/提供商每日平台限额仍有效；不绕过、不扩大。

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


## 502 修复证据与真实验证边界

历史 HTTP502 只能证明 study 没有通过校验。未保存失败字段、引句或模型原始 JSON，因此不能断言历史根因就是虚构引句或超长引用。实际保存摘要为2952字符、ASCII、单空格；题名+摘要完整SHA256为 `2195a1591c9db6cf0be4b6eea1d16869a073a28cbc017898b16fdc21d6231f8c`。它与翻译缓存16位前缀匹配；当时 study 的模型输入与校验共用同一摘要，指纹在校验后生成，故16/64位兼容问题不是本次 study 502 的直接触发点。

已证实的实现缺陷是 `quote_not_in_abstract` 混淆长度错误和原文不匹配。真实摘要 Results 段为1098字符，即使完整逐字存在也被旧校验拒绝；真实343字符结果句则可通过。这两个模型形输出都是构造回归案例，不是恢复出的历史模型响应。fixture 明确标记原始失败输出未保存。

修复仅涉及 study 摘要提示词和证据选择：服务端从当前摘要生成连续逐字片段及稳定本篇ID/offset，模型选择单个 `quote_id`；服务端还原原文后仍执行12–360字符、literal includes、同一引句数字检查。不接受跨论文/未知/拼接ID或模型额外提供的quote。过长且无法按原文分号分出的片段不截短充当证据；无法支持的字段按缺项处理。公开 `PREGENERATED` 与 study `{text,quote}` 契约保持，仍提供 PMID/DOI 双别名；新增版本元信息不会要求 UI 改动。长度错误现在单列 `invalid_study_quote_length`。

真实账本按严格白名单一次性补记输出：确认命中已有翻译缓存为0输出；失败 study 按1600+2200上限保守计3800。仍保留4次尝试预留和两层暂停。在新设本地试跑上限下，2026-10-07算术剩余4次尝试、5800输出上限（不是提供商余额）；若验证走 runtime，一次修复后study需再预留2次尝试/3800输出，之后仅剩2000输出，不足另一次完整study/quicklook/translate预留。未核实任何美元余额或实际收费。

剩余23份翻译、24份study、24份quicklook。逐任务runtime上界为71 POST、最多142提供商尝试、首轮最多136200输出token、含一次重试最多384600输出token；configured合并24篇最多24调用、139200输出token。均不能在本次自行收紧的本地单日8尝试/9600输出试跑上限内完成；这些是输出上限估算，不是实际计费或新增预算请求。保持当前本地上限，真实预算与服务限额由集成负责人核对后按用户授权安排，不能称本批已经完成。

本环境无既有模型配置，现有线上API还未部署本补丁；继续POST旧接口不能验证此修复。已请求唯一集成负责人提供修复后的既有授权执行路径，不读取/迁移/创建凭据、不部署。本次修复新增实际模型请求为0，未宣称线上跑通。再次验证应先保留账本并核对暂停/预算，只执行一篇一次，成功才按余量增量补缺；403/429/认证或再次证据失败立即停。恢复器按请求身份合并明细，拒绝未知旧汇总，不能用max估算来抵扣独立调用。


预算来源与成本口径更正见 `docs/week-precompute-budget-audit-20261007.md`，实际逐篇输入测量见 `editorial/week_precompute_token_estimate_20261007.json`。独立API小提交及分阶段顺序见 `editorial/handoffs/study-evidence-api-bb55fc2.md`。
