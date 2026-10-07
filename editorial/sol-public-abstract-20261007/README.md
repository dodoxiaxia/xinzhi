# 固定24篇公开摘要：完整翻译与速览

完整交付为 `full-cache.json` 的48条现有schema缓存，以及 `full-board.json` 的24篇榜单预览：中文题名24、完整摘要翻译24、quicklook24、study0。窗口为2026-10-01至2026-10-07（Asia/Shanghai），固定main `7dbe94c5465e7acca4097ac0282ef8ff78e4a48f`、state `6135056e3d544816ff3554a8e6241f60e3274698`。按当时已筛选榜单保留心血管16、综合医学6、AI医疗1、AI前沿1；两个AI类在92个合格候选中各仅有1篇，不用旧稿补数。

`sources.json` 保留24篇完整原始英文题名、公开摘要、DOI/PMID、源链接及SHA256(title + newline + abstract)。`coverage.json` 逐篇映射两类缓存键和独立复核文件。`full-validation.json` 记录48项生产校验通过；4份语义复核均通过并绑定当前草稿文件SHA256。首批3篇的缓存和复核原件完整保留，后21篇在首批独立复核通过后扩展。

生成来源为现有Sol会话直接阅读已保存的公开摘要，未调用外部模型API、未读全文或私有资料。请求的代理模型为gpt-6.1-sol，实际后端不可核验；缓存保留 `origin=sol-session-public-abstract`、`modelVersion=sol-session-model-unobserved`、`generationPromptVersion=unobserved`、`generationVersionKnown=false`。现有 `machine-validated-unreviewed` 标签未改写为人工/医学终审；独立Sol复核凭据单独保存。providerUsage未知，不以零调用伪造零费用或token账单。

原生产数字出现次数、连续逐字引句、引句内数字和身份规则均未放宽。第7篇原文一处LGE组标记不明确，译文显式括注，速览要点未引用该歧义句；第12篇原文百分比的分母不明，原值保留，不编解释。历史源修复 `69a46b6a6479773a725a742310e10b280ff29cf3` 的两条身份不在这24篇里，未沿用其旧污染文本。源质量检查只针对保存的摘要，未宣称本轮在线PubMed核验。

## 接入

交付分支包含早期流水线改动；唯一集成负责人应从最终固定SHA取出本目录及 `scripts/preview_sol_public_overlay.py`、`scripts/test_sol_public_overlay.py`，应用于当前main，勿合并整条旧基线分支。先与实际当前24榜逐项对照paperID、DOI/PMID和原始title/abstract的sourceHash；改源或改选文时旧条目必须失效。

```sh
python -m unittest discover -s scripts -p test_sol_public_overlay.py -v
python scripts/preview_sol_public_overlay.py \
  --sources editorial/sol-public-abstract-20261007/sources.json \
  --overlay editorial/sol-public-abstract-20261007/full-cache.json \
  --runtime-cache data/week-precompute-cache.json \
  --output editorial/sol-public-abstract-20261007/full-board.json
```

适配器逐条用现有find和validator复验，overlay在内存中优先，兼容现有schemaVersion1榜单和generationMeta；原运行缓存与ledger均不写。输出只允许本专用目录的独立 `*-board.json`，拒绝输入碰撞、账本路径及出目录符号链接。9项守卫回归覆盖实际首批、旧hash、重算源hash后拒绝旧缓存、DOI/PMID、数字、逐字引句、伪造API元信息、overlay优先且输入不变、输出边界。源质量review记录的是收紧输出守卫之前的代码快照；最终测试已覆盖该已修复边界。

最终榜内所有条目 `allowAutomaticGeneration=false`；只有study缺失，因此状态仍为partial。不加入点击后自动收费或重复生产调度。本任务不采用overlay写正式state，不部署；由唯一集成负责人在检查后接入UI和发布。

账本SHA256前后相同，暂停及4次尝试/3800输出预留保持原样。8次/9600输出是已有本地试验上限，不是已确认账户额度。此前API/site403及账户实际余额/账单仍未解决，本轮没有再次请求这些路径，离线结果不等于线上模型连接验证。`full-receipt.json` 与 `artifact-sha256.json` 给出审查、覆盖及文件证据。
