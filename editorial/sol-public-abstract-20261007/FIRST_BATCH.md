# 首批3篇实际公开摘要结果

固定main7dbe94c、state6135056。首批榜内rank1–3，DOI/PMID、完整原文与sourceHash见sources.json。batch-01-cache.json是6条现有缓存schema的有效translate/quicklook结果；原生产数字次数、逐字引句、同句数字及身份规则均保持，通过store/find复验。独立Sol审读已逐篇通过，review绑定修订后草稿SHA。

来源是当前Sol会话直接阅读公开摘要后的整理，不是GLM API、不是全文精读或人工/医学终审。origin=sol-session-public-abstract，modelVersion=sol-session-model-unobserved，providerUsage未知，未伪造API调用或token账单。保留generationPromptVersion=unobserved、generationVersionKnown=false和machine-validated-unreviewed。

接入：python scripts/preview_sol_public_overlay.py --sources editorial/sol-public-abstract-20261007/sources.json --overlay editorial/sol-public-abstract-20261007/batch-01-cache.json --runtime-cache data/week-precompute-cache.json --output editorial/sol-public-abstract-20261007/batch-01-board.json。该命令只读原运行缓存，在内存中让overlay优先，输出既有schemaVersion1的完整24榜预览；覆盖题名24、翻译3、速览3、study0。只给实际已缓存条目内容，其余保持缺失，前端不自动付费。只有唯一集成负责人可在复验实际当前24榜身份及hash后将预览接入正式weekly-board；本任务不写data缓存/ledger/main/state、不部署。

源修复69a46b6的两个已核身份不在当前固定24榜中；未沿用其污染摘要。任何后续源文本/选文改变，都要重算hash并拒绝旧条目，不可强行接入。6项overlay守卫回归通过：真实结果、源hash、DOI/PMID、错误数字、非原句证据、伪造模型/usage。

账本暂停4次/3800输出预留不变。后续同一路径补齐其余有效摘要，首批不是全24完成。
