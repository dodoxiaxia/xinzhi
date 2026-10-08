# v2 研究状态与设计标注候选（2026-10-08）

已确认报告列出的九个 PMID 在固定 state 中全部被分为 RCT，并修复其公开投影。PREVENT-TAHA8 原文显示「已撤稿」，声明回链原文；三个设计/方案论文及两个 APERITIF 评论回复不再进入原始 RCT 类。题录、DOI、题名、原始出版类型及来源均保留。

候选分支 `fix/v2-study-status-design` 基于 main `7ed3157a88ed00ea1079aaecd00403aa04148b3d`；只读恢复的数据为 state `48ad7788e4065a1d3317feaeeed2f73d9e6774dd`。审计输入为 Library `libfile_776ebc6f9fc08191bc768618a1669abf`，已通过 Library 文本读取，无假设跨环境共享路径。唯一发布者仍为主集成任务 `01a11479-1ff2-733a-b6d0-14c60dd320ef`。本候选没有改变 main/state、发布版本号或部署。

## 官方核验与实际修正

使用 NCBI E-utilities efetch 的官方 XML 批量核验，保留 PublicationTypeList 和 CommentsCorrectionsList 的结构。需要补充文章角色的两篇 JAMA 文献另外核验出版社页面。

| PMID | 核验结果与候选标签 | 官方证据 |
|---|---|---|
| 41224473 | Retracted Publication；RetractionIn → 41916660；ExpressionOfConcernIn → 41224475；显示「已撤稿」 | [PubMed 原文记录](https://pubmed.ncbi.nlm.nih.gov/41224473/) |
| 41916660 | Retraction Notice；RetractionOf → 41224473；显示「撤稿声明」 | [PubMed 撤稿声明](https://pubmed.ncbi.nlm.nih.gov/41916660/) |
| 41224475 | Expression of Concern；ExpressionOfConcernFor → 41224473；显示「关注声明」 | [PubMed 关注声明](https://pubmed.ncbi.nlm.nih.gov/41224475/) |
| 41412600 | Retraction Notice；RetractionOf → 39043416；显示「撤稿声明」 | [PubMed VICTOR 声明](https://pubmed.ncbi.nlm.nih.gov/41412600/) |
| 39043416 | 额外核验 VICTOR 原文：Retracted Publication；RetractionIn → 41412600。该文在当前 365 天存档窗口外 | [PubMed VICTOR 原文](https://pubmed.ncbi.nlm.nih.gov/39043416/) |
| 42104840 | PubMed 同时含 RCT 类型，但题名为 Rationale and Design，摘要介绍设计及未来结局评估；显示「研究方案」 | [PubMed CARDIO-TTRansform](https://pubmed.ncbi.nlm.nih.gov/42104840/) |
| 41771068 | Clinical Trial Protocol，题名为 Rationale and design；显示「研究方案」 | [PubMed ALT-FLOW II](https://pubmed.ncbi.nlm.nih.gov/41771068/) |
| 40920457 | Clinical Trial Protocol；描述未来随机分组及结局；显示「研究方案」 | [PubMed CONDUCT-AF](https://pubmed.ncbi.nlm.nih.gov/40920457/) |
| 42418170 | PubMed 只有 Journal Article；JAMA 页面为 Comment & Response，正文以 To the Editor 开始；显示「述评观点」 | [PubMed](https://pubmed.ncbi.nlm.nih.gov/42418170/)、[JAMA](https://jamanetwork.com/journals/jamacardiology/article-abstract/2851276) |
| 42418194 | PubMed 只有 Journal Article；JAMA 页面为 Comment & Response，正文以 In Reply 开始；显示「述评观点」 | [PubMed](https://pubmed.ncbi.nlm.nih.gov/42418194/)、[JAMA](https://jamanetwork.com/journals/jamacardiology/article-abstract/2851275) |
| 42836743、42836296 | 当前 AFACT 与 PREVENT 事后分析。题名和 Methods 表明使用母试验数据；两篇均显示「RCT 二次分析」 | [PubMed AFACT](https://pubmed.ncbi.nlm.nih.gov/42836743/)、[PubMed PREVENT](https://pubmed.ncbi.nlm.nih.gov/42836296/) |

精确核验记录在 [publication-status.json](../config/publication-status.json)，包含 PMID、官方题名、DOI、出版类型、关系与来源链接。只在 PMID/DOI 与题名一致时使用静态核验关联，冲突时不传播状态。不会因为另一篇题名含相同试验名称而把它标为撤稿。后续新取得的 PubMed 类型/关联可增加更高优先级的状态，静态角色不会屏蔽新撤稿信息。

官方 XML 字节摘要：

- 九个报告样例：`3accf16a849729e24f73e06ce62fccb8279c0d202dd8cc7dbcea5ee4374163bd`。
- VICTOR 原文及两篇当前事后分析：`523155ddc14db10ed273dc257ee1558759b4c5f9a84676e36982379294136c10`。

原始响应字节现已保存在候选证据目录：[九个报告样例的 XML 原件](evidence/pubmed-study-status-20261008/pubmed-verified.xml)、[三篇补充核验的 XML 原件](evidence/pubmed-study-status-20261008/pubmed-additional.xml)及[字节/哈希/来源清单](evidence/pubmed-study-status-20261008/manifest.json)。本次证据补交仅复用本任务已经取得的下载，未发起新的 PubMed 或出版商请求，未重新序列化 XML；复制前后字节一致，并与上述原 SHA-256 一致。复核者可直接解析原件中的 `PublicationTypeList` 和 `CommentsCorrectionsList`，核对 PREVENT-TAHA8 及两声明的双向关联。

独立复核提出的未来状态边界已补修：声明自身的新 `Retracted Publication`/`RetractionIn` 优先于其旧关注、撤稿或更正声明角色；`ExpressionOfConcernIn` 也描述这篇记录自身的关注状态。`RetractionOf` 仅表示声明指向被撤稿原文，不能把声明自身标成撤稿。新增三个回归方法覆盖「已注册关注声明自身后来被撤稿」「更正声明自身后来被撤稿」和「撤稿声明目标不代表自身撤稿」。这些更新使用假设 fixture，不是关于 PMID 41224475 当前状态的新指控；已取得的当前官方原件和九个实际样例不变。

## 最小实现边界

原文状态只接受 PubMed 官方出版类型/结构化关联或此次核验的精确身份；声明题名仅用于声明自身的文章角色，不推断其他原文的状态。撤稿优先于关注声明。方案、声明、评论回复及明确的二次分析优先于 randomized 题名或 RCT 出版类型。研究快报/Letter 必须有自己的 Methods 和 Results，才继续判断研究设计。提及其他试验、背景里的二次分析、非随机分组及不明母研究均保守处理。

卡片、紧凑列表、阅读抽屉、周榜和精选清单展示状态及 PubMed 原文/声明链接；复制和 Markdown 导出携带状态。旧导读和 AI 速览的研究设计字段无法恢复已撤稿或非原始试验的 RCT 徽章。原摘要和历史 AI 内容字节未作删除。新增两种二次分析筛选，不把母研究未确认的分析推定为 RCT。

修改范围为：

- `scripts/enrich_metadata.py` 仅研究设计函数；没有改 DOI、题名、期刊修正规则。
- 新 `scripts/publication_status.py`、`config/publication-status.json`。
- `scripts/fetch_pubmed.py` 和 `scripts/archive_details.py` 仅保留官方关联字段。
- `scripts/build_public.py` 的题录投影、紧凑存档和必需核验注册表检查；`scripts/release_integrity.py` 增加构建输入哈希。
- `app.js` 状态展示、角色优先级、筛选和导出；`style.css` 三条状态样式。
- 新 Python/UI 回归，以及 `test_release_build.py` 的隔离 fixture 和哈希守卫。

公共状态只投影固定字段和生成的 PubMed 链接，不透传任意关系对象中的 URL/私人字段。没有修改私人 PDF、私人母索引、公开题名快照、DOI 裁决文件、Worker、发布流程或凭据。

## 验证

新增 12 项 Python 回归，覆盖九个报告样例、VICTOR 双向关联、两篇实际事后分析、协议类型优先、来源身份冲突、未知状态不传播、未来官方状态优先、两个 PubMed 解析路径及紧凑投影。新增 34 项 Node UI 断言，覆盖过期 RCT 字段、官方回链、安全转义和导出。

最终全套 Python 测试 `564/564` 通过；既有周榜 71 项、阅读逻辑与研究服务/UI 回归亦通过。首次运行在构建完成前检查空 `public` 目录而失败一次；构建完成后已重跑整套并通过，没有保留该失败为阻塞。

本次证据与未来状态补充后的全套 Python 测试为 `567/567` 通过，状态专项为 15 项；新增 UI 的 34 项断言继续通过。

完整六文件构建与打包通过，候选保持公开文库 1,264 条、当前雷达 870 条、存档 12,671 条、已发布导读 12 篇。构建产物及生成 manifest 未加入候选提交，发布由主集成任务重建。

Chromium 在 1440px 和 390px 下验证卡片/紧凑列表与抽屉：撤稿状态及声明链接可见，页面异常为零、无横向溢出。浏览器请求仅允许本地文件，API 为无生成能力的只读 fixture；这不代表生产 API 或部署已验收。可复现结果和各例实际标签见 [核验 JSON](research-status-design-20261008.json)。

运行命令：

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
node scripts/test_publication_status_ui.cjs
node scripts/test_weekly_window.cjs
node scripts/test_reading_logic.cjs
node scripts/test_study_services.cjs
node scripts/test_study_ui.cjs
node scripts/test_publication_dates_ui.cjs
node --check app.js
python3 scripts/build_public.py
python3 scripts/package_release.py
git diff --check
```

## 未核验与来源限制

BMJ 的两个出版商声明页面返回 403 后停止该来源，没有循环重试；相关撤稿/关注事实由成功取得的 PubMed 官方 XML 核验。没有获取 PDF 或付费全文。

报告声称的全站「191 条」「175 条」「11 个方案」等数量、未逐一列明的其他条目及 GOLDEN BRIDGE II 尚未逐篇裁决。本候选规则标签统计不是人工核验数量。既有存档中，此次精确核验范围之外的原文只有在缓存已有 PubMed 关联，或未来重新取得关联后，才会有具体声明回链；没有对全站旧记录新增无界网络扫描。默认归档过滤和窗口策略未变。
