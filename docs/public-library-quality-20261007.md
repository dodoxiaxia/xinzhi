# 公共文献库数据质量补丁：2026-10-07

源码基线 `377aa936df7962261e693ccf1406ae18cc0856be`（v14.2.6）；只读网站运行数据基线 `4135d4f7f22b0411fc5bbaf40d2f2efe46e75a97`。原批准快照和运行库 1,268 条均不改写；仅在公共构建投影中隔离/校正，最终集成发布仍归任务 01a11479。

| 公共 ID | 核对与处理 |
|---|---|
| c7991c9cd94838c4 | Nature Medicine 导航文字，DOI/PMID/URL/date 空；仅从公共投影隔离，审计保留旧题录。 |
| 82c4998e9b7ccb09 | Nature Machine Intelligence 导航文字，同上。 |
| 816ecabbd93dfa60 | Nature Machine Intelligence 导航文字，同上。 |
| 79904b5d153128dc / e94e5de9640300e9 | [PubMed 41966941](https://pubmed.ncbi.nlm.nih.gov/41966941/) 确认 The rise of the agentic AI colleague，DOI `10.1016/j.landig.2026.101010`，Lancet Digital Health 期刊原来就正确。保留第一个历史 ID 作为公共题录，第二个列为显式重复别名；Epub 2026-04-10 与刊期 2026-03、8(3) 分存，不取最早值。 |
| a76a3fd5e0e70fd7 | [PubMed 42765414](https://pubmed.ncbi.nlm.nih.gov/42765414/) 的原始 XML 明确 Electronic 2026-09-21、64(11)、Online ahead of print。公开 date/onlineDate 改为 9 月 21 日；原索引 2026-11 仅保留为 issueDate、月精度，明确月份未独立复核，不称未来未发表。 |
| 47e6d48cc22b6000 | [PubMed 42765408](https://pubmed.ncbi.nlm.nih.gov/42765408/) 同样确认 Electronic 2026-09-21、64(11)、Online ahead of print；同上分离在线日期和原刊期月份。 |
| a762c60c31fbd3e2 | [npj Digital Medicine 官网](https://www.nature.com/articles/s41746-026-03312-y) 明确 Published 26 September 2026。仅此 ID 和完整 DOI 的公开日期改为 2026-09-26，不批量修改其余月初日期。 |

中华外科官方 XML 查证入口：[NCBI EFetch 三篇题录](https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=41966941,42765414,42765408&retmode=xml)。只使用每篇主记录 MedlineCitation/Article/ArticleDate 和 PubmedData/ArticleIdList，未把参考文献日期或标识误作本篇。出版商易格页面本次未返回可读题录，Crossref 查询未取到记录；因此未将索引的 November 月份升级为已核验官方出版月。在线日期及 64(11) 已由 PubMed 核实。

只改公共书目信息，不建立、移动或重绑私人 PDF。Agentic 的原两个 DOI 都截断，公开更正 DOI 不能证明私人文件身份；公共构建暂不把该校正条目放入 PDF 下载身份白名单，直到原集成任务独立核实绑定。所有校正仍 fulltextStatus=not_verified、localAvailable=false，入库日期不推断。旧 DOI 派生的摘要、译名和导读不会自动变成新 DOI 的证据；私人母库和全部 PDF 均未读取或修改。

计数：原库 1,268 → 公共库 **1,264**，原因仅为 3 条导航隔离和 1 条显式重复别名。原始 245 条无 DOI/URL → 公共保留 **242** 条；不将缺标识视为假文。其他 1,260 条公共书目字段保持原值。已核验导读 12、本地雷达 902、速览 11 均沿用原构建流程。

逐项审计见 `docs/public-library-quality-audit-20261007.json`，仅含已公开书目字段、公共 ID、官方证据链接和数量；无私人路径、账户、备注、文件指纹或 PDF。构建另生成本地 `docs/public-library-quality-audit.json`，不进入六文件 public 包。原快照及保留旧 ID 的校验门槛仍完整执行；目标 ID 的题名/期刊/标识发生冲突时 HOLD，不自动删除、猜合并或扩大匹配范围。

新增公开日期字段限定为 onlineDate、issueDate、issueDateBasis、issueDatePrecision、volume、issue、publicationStatus、bibliographicEvidenceUrl。当前 date 始终使用已核验在线日期，刊期只作为独立书目信息。此模块不修改 app 搜索、内容审核、API worker、调度或权限；新增投影脚本加入构建输入哈希，防止审核策略改变后打包旧产物。

验证：10 项逐项回归、全部 502 项脚本测试通过，真实运行数据的六文件构建及本地包 preflight 通过。原快照、快照 manifest、data/library.json 哈希不变；源输入重复投影及倒序输入结果一致。真实包中导航 ID 和重复别名无残留，隔离审计不进入 public。另有投影/审计的私人路径、凭据、备注及哈希注入测试。没有部署、写 main/state 或读取私人母库。

复现：恢复上述网站运行数据，执行 `python3 scripts/build_public.py`，再运行 `python3 -m unittest discover -s scripts -p 'test_public_library_quality.py'`。公共过滤与更正只在构建发生；主任务必须重新构建、审查并使用原唯一发布入口。
