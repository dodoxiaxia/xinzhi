# 官方公开指标增量 1：2026-10-07

基于最新 main `bd69b63d2289a31012b58081e693387dd1d5ca36` 和实际公开 state `28edb64292ad5bb5ea54612e7dc8180256658a2a`；沿用专用分支 `codex/journal-metrics-20261007`。本批只改数据、离线解析/校验和测试，没有改 app/style/index、构建接线、工作流或部署。

48 个原有期刊新增明确年份的 **2025 两年 JIF / 2026 JCR 发布版**。注册表官方 JIF 为 62 刊（原 14 刊全部对象保持一致）；完整官方 JCR 分区为 2 刊；50 条 2024 用户历史参考保持原样，不能当作当前官方分区。

## 当前实际展示覆盖

| 位置 | 总条数 | 官方 JIF 已核实 | JIF 未核实 | 非期刊不适用 | 新刊名待映射 |
|---|---:|---:|---:|---:|---:|
| 精选 | 25 | 18 | 6 | 1 | 0 |
| 雷达 | 867 | 518 | 304 | 45 | 0 |
| 文献库 | 1268 | 659 | 466 | 135 | 8 |

精选包含一个 `atrial fibrillation` 非期刊主题标签，因此实际期刊文章为 24 条，已核实 18/24。四个缺 JIF 的精选期刊为 JAHA（2 条）、Heart Rhythm（2 条）、Journal of Cardiovascular Electrophysiology（1 条）、Heart（1 条）。JCR 官方完整分区目前覆盖文献库 2 条；精选和雷达尚无完整官方分区。覆盖统计直接读上述 state 的 public.js；priority 列表只含期刊/身份不清标签，不能据其小计声称是全部页面条数。

逐刊源 URL、值、年份、ISSN 和已公开的全部学科见 [覆盖 CSV](journal-public-coverage-batch1-20261007.csv)，页面出现次数、剩余刊名见 [统计 JSON](journal-public-coverage-batch1-20261007.json)。可复验的最小公开事实集见 [48 刊 observation JSON](../journal-public-observations-batch1-20261007.json)，核验时间 `2026-10-07T14:28:04Z`。这是人工读取官方公开页后的有限事实记录；不是受限 JCR 数据库抓取或整表复制。

## 可靠来源与展示边界

- Nature 24 刊直接读取各刊 `journal-impact`；Scientific Reports 读取 `srep/about`。只取 **Journal Impact Factor**，未取 5-year Journal Impact Factor。Scientific Reports 正文同时明确数据年 2025、Clarivate 发布年 2026。规范 URL 不含公开 cookies 提示查询参数。
- [ACC 的 2026-06-17 公告](https://www.acc.org/Latest-in-Cardiology/Articles/2026/06/17/17/26/just-announced)明确 2025 JIF。只补本站已有的 8 刊；公告还列 JACC: CardioOncology，但本站没有此刊，未额外入库。公告没有逐学科 Quartile，因此不根据 JIF 排名推 Q。8 刊本批按公告中的明确刊名映射，未凭记忆加 ISSN；后续另核书目信息。
- Wolters Kluwer Ovid 官方公开期刊目录的 **2025 Journal Impact Factor** 字段核到 12 刊及 ISSN。AHA 刊属于其出版业务；NEJM/JAMA 系列条目是 Ovid 的官方发行目录，来源标签明确该平台，并未冒称为 JAMA/NEJM 自身指标网页。目录没有完整 JCR 学科分区。
- [European Journal of Heart Failure 当前 OUP 页](https://academic.oup.com/eurjhf/pages/about)核到 2025 JIF 10.3 和 Cardiac & Cardiovascular Systems **JIF 排名 16/237**。同页 JCI 排名 9/237 被排除。Wiley 已声明该刊 2026 年转至 OUP，因此没有沿用旧出版社数据。
- [JMIR Medical Informatics](https://medinform.jmir.org/about-journal/indexing-and-impact-factor)明确 2025 JIF 5.0、Medical Informatics **Q2**（17/54）。同页 Scopus CiteScore 7.5 和 Q1 被排除。
- [JMIR AI](https://ai.jmir.org/about-journal/indexing-and-impact-factor)明确 2025 JIF 6.1，列出的全部 JCR 学科为 Health Care Sciences & Services **Q1**（21/194）及 Medical Informatics **Q1**（13/54）。同页 Scopus 部分被排除。两刊原有组件直接显示带年份 badge，详情保留全部学科及来源；没有改 UI 文件。

## 已实查但尚缺的具体证据

| 刊名 | 本轮已查官方公开源 | 实际缺口 |
|---|---|---|
| Journal of the American Heart Association | `https://onlinelibrary.wiley.com/journal/20479980` 可读；AHA 当前期刊主页返回 403 | Wiley 可读页有 ISSN 2047-9980，没有明确 JIF 数据年和值；2027 年转出版消息不能替代指标 |
| Heart Rhythm | HRS 出版页面、期刊 aims 页返回 403；ScienceDirect insights 不可读 | 尚未获得可读、明确数据年的官方 JIF/JCR |
| Journal of Cardiovascular Electrophysiology | `https://onlinelibrary.wiley.com/journal/15408167` 可读；产品信息页可读，metrics 子页不可读 | 主页显示 IF 2.4，但没有 IF 年份；不能用网页版权年补为 2025 |
| Heart | `https://heart.bmj.com/pages/about` 等返回 403；官方搜索摘要可见 IF 4.4 | 尚不能把 Journal Statistics 2025 等运营统计年份当作 JIF 年份；继续找官方明确年版 |
| JMIR Biomedical Engineering | `https://biomedeng.jmir.org/about-journal/indexing-and-impact-factor` 可读 | 页面只有 Scopus CiteScore 2.6 (2025) 及 Scopus Q3，不是 JIF/JCR；不可借用 |
| Diagnostics / Life | MDPI 官方当前页面返回 429 | 此访问范围内没有读到当前年度指标；不反复重试、改请求头或绕限制 |

其余 60 个新增已核实 JIF/原已有 JIF 的无完整 JCR 刊，具体缺口为所读官方公开页未列逐学科 Quartile，而非宣称指标不存在。继续查出版社其他公开材料与 Clarivate 的公开资源；可读到用户旧表的有限预览只用于核对年份、身份，未重试已拒绝的下载，也未把私人表上传给外部模型。

文献库另有 7 个最新刊名/8 条文章尚未进入既有注册表，本批未猜它们的指标或 ISSN：中华普外科手术学杂志（电子版）、Frontiers in Medicine、Frontiers in Physiology、The Journal of Tehran University Heart Center、中华口腔医学杂志、中华消化外科杂志、中华腔镜泌尿外科杂志（电子版）。后续批次单独核对。

## 验证与唯一集成

74 个 Python 测试通过（journal 31、public build 20、package 23），49 个 Node 组件断言通过。新增校验覆盖重复/不存在刊名、已有准确值冲突、未来年版、错误 ISSN、私有字段、保留全部 JMIR 学科、排名不推 Q、幂等导入以及完整历史参考保留。测试可在浅克隆/发行包运行，不依赖历史 Git 对象。

唯一集成任务可只取本批提交。`config/journal-metrics.json` 是双方唯一可能的数据冲突文件；没有变更公共展示组件接口和 CSS。现有 `renderBadge`/`renderDetails` 已支持完整多学科 Q，仍由唯一集成发布。推专用分支前重新确认唯一 workflow 的 push 分支只有 main，任务不触发生产。
