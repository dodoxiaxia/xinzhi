# 第一个 40 分钟检查点：5 批可集成增量

重新核对的最新 main 是 `7dbe94c5465e7acca4097ac0282ef8ff78e4a48f`，state 是 `6135056e3d544816ff3554a8e6241f60e3274698`。main 当时仍有 14 刊官方 JIF；专用分支 `codex/journal-metrics-20261007` 已核实 **94 刊官方 2025 JIF（新增 80 刊）**，**2 刊完整当前官方 JCR（3 个学科）**。注册表 207 标签；原先准确的 14 刊对象及 50 条 2024 用户历史参考保留。

五批最小公开事实分别记录在 `journal-public-observations-batch1` 至 `batch5` JSON；48 + 3 + 12 + 14 + 3 = 80 个新增 JIF 条目。额外核查 NEJM AI、JAHA 的身份，以及其他官方页面读不到/缺字段的情形；没有把这些尝试算作已核实指标，也没有给出虚构的“全部刊已查完”统计。

| 最新实际页面 | 总条数 | 官方 JIF 已核实 | JIF 未核实 | 非期刊不适用 | 身份待映射 |
|---|---:|---:|---:|---:|---:|
| 精选 | 25 | 20 | 4 | 1 | 0 |
| 雷达 | 868 | 624 | 199 | 45 | 0 |
| 文献库 | 1268 | 727 | 400 | 135 | 6 |

精选 24 条期刊文章覆盖 **20/24**，还缺 JAHA 和 Heart Rhythm，各 2 条。雷达从本轮最初 867 条更新为 868 条，表格按刚读取的新 state 重新计算。期刊指标不用于单篇研究质量评分。完整官方分区覆盖文献库 2 条；其余所读页尚缺完整逐学科 Quartile。

[逐刊指标/全部学科/来源覆盖 CSV](journal-public-checkpoint-20261007.csv) 与 [最新页面统计及剩余清单 JSON](journal-public-checkpoint-20261007.json) 是本检查点交付。上午及 batch1 文件保留各自原版快照，不能据其旧数字汇报当前状态。

## 核验来源和关键约束

- Nature 的各刊公开 Journal Metrics（25 个新增）明确 2025 两年 JIF，排除五年 JIF；Scientific Reports 同时列 2025 数据/2026 发布版。
- [ACC 2026-06-17 公告](https://www.acc.org/Latest-in-Cardiology/Articles/2026/06/17/17/26/just-announced)核实本站已有的 8 刊。JACC: Advances 和 JACC Asia 的首次 IF 分别为 5.5、6.1；未把公告中本站没有的第九刊加进注册表。
- Wolters Kluwer 官方 Ovid 公开期刊目录的 **2025 Journal Impact Factor** 字段补 29 刊，包括 JAMA 系列、AHA、NEJM、Annals、JCE 等；NEJM/JAMA/Wiley 期刊来源标签明确是官方发行目录。每项单独保存规范 HTTPS 来源及 ISSN 证据。
- 当前 OUP 页核实 EJHF 10.3；只记录 JIF 排名 16/237，排除 JCI 排名 9/237。
- [JMIR Medical Informatics](https://medinform.jmir.org/about-journal/indexing-and-impact-factor)明确 Medical Informatics **Q2**；[JMIR AI](https://ai.jmir.org/about-journal/indexing-and-impact-factor)明确两学科均 **Q1**。分别排除同页 Scopus Q 和 CiteScore，保留全体学科。
- [BMJ 官方公开产品册](https://info.bmj.com/view/1051614497)明确 2025 JCR / Clarivate 2026 脚注，核到 Heart 4.4、The BMJ 55.1、BMJ Evidence-Based Medicine 10.8；没有用运营统计年份推指标年份。
- Springer Nature Link 核到 8 个新增期刊，各页明确 2025 JIF、ISSN。
- [Frontiers 2026 公开年版表](https://www.frontiersin.org/about/impact)核到 3 刊明确 2025 JIF，补齐当前两个 Frontiers 新刊名。表里仅有不注明类别/选择规则的单个汇总 Q，不冒充完整逐学科 JCR。
- [PNAS 本刊指标页](https://www.pnas.org/about/article-journal-metrics)在 2025 Metrics 下列 JIF 9.5、Multidisciplinary Sciences JIF 排名 14/140。五年 IF 10.6、无自引 IF 9.2、CiteScore 14.7 及 Scopus 12/223 排名均排除。

## 尚未解决的实际缺口

JAHA 的 [当前 Wiley 公共页](https://onlinelibrary.wiley.com/journal/20479980)已核到 ISSN 2047-9980，但没有 JIF 年份和值；AHA 当前主页 403，官方 About 的搜索摘要含旧 IF 6.106 却没有年版。Heart Rhythm 的期刊/HRS 页 403，ScienceDirect 本轮不可读；第三方“2024/2025 IF 5.7”不能用来判明数据年。两刊继续优先查官方公开且明确年份的资料。

NEJM AI 的 [官方公开目录](https://www.wolterskluwer.com/en/solutions/ovid/nejm-ai-16597)核到 ISSN 2836-9386，目录没有 JIF 字段，NEJM about 页 403。缺字段不等于不存在 JIF；注册表保持未核实，并记具体缺口。JMIR Biomedical Engineering 公开页只有 Scopus 指标，不用其 Q3 替代 JCR。MDPI 主页/公告页本次返回 429；没有改请求头、绕登录、重试拒绝的 Library 下载或外传私人表。

仍有当前 5 个刊名/6 条文献待官方身份映射：中华普外科手术学杂志（电子版）2 条，其余中华口腔医学杂志、中华腔镜泌尿外科杂志（电子版）、中华消化外科杂志、The Journal of Tehran University Heart Center 各 1 条。剩余清单明确保留未实查完的刊，不虚称为数据库未收录。

当前官方 JCR 覆盖缺口仍大；已有公开页只给 JIF 或学科排名，不能按排名推 Q、只挑最好分区或借用中科院分区。若后续公开源仍缺学科对应关系，最小额外输入是已获授权且允许本站展示的 **本站未核实刊子集** 的 JCR 2026/2025 数据：刊名/ISSN、全部类别与各类 Quartile、核验时间；无需整库、私人论文或凭据。

## 集成与测试

专用分支的五批提交从 `c5f9db2` 起（另有 `7921bed`、`3c63e80`、`52f2b09` 及本检查点提交），接在先前 `7a1f25b` 之后。唯一集成任务可直接 cherry-pick `7a1f25b..codex/journal-metrics-20261007`。最新 main 的 UI 工作没有被覆盖；本轮只写注册表、离线解析、校验/tests 和来源交接资料。主要冲突文件只有 `config/journal-metrics.json`，共用组件接口/JS/CSS/d.ts 没有变动。

74 个 Python 测试及 49 个 Node 断言通过；覆盖官方已核值与历史保留、逐学科完整性、JIF/五年/Scopus 分离、重复或未知刊名、ISSN、私有字段和年份校验、离线幂等导入。沒有发布或推 main/state。专用分支 push 前确认 workflow 的 push 分支只有 main，refresh 还限制 refs/heads/main。
