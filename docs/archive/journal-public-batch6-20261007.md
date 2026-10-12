# 第六批：6 刊公开 JIF 增量与两刊优先缺口审计

保留已交付 `7f7b2b7`，专用分支不修改 `config/journal-metrics.json`。本批交 [可复验数据 overlay](../journal-public-observations-batch6-20261007.json)、安全合并函数及离线测试，让唯一集成任务在其当前注册表上合入，避免覆盖正在集成的数据。没有发布、调用模型 API、新权限费用或调度变更。

| 本站期刊 | 2025 两年 JIF | 官方公开源 |
|---|---:|---|
| Science | 47.3 | [官方 Ovid 发行目录](https://www.wolterskluwer.com/en/solutions/ovid/science-1250) |
| Science Advances | 13.9 | [官方 Ovid 发行目录](https://www.wolterskluwer.com/en/solutions/ovid/science-advances-15526) |
| Journal of Arrhythmia | 1.9 | [官方 Ovid 发行目录](https://www.wolterskluwer.com/en/solutions/ovid/journal-of-arrhythmia-14318) |
| The Clinical Teacher | 1.7 | [官方 Ovid 发行目录](https://www.wolterskluwer.com/en/solutions/ovid/clinical-teacher-the-2626) |
| Postgraduate Medical Journal | 3.6 | [当前 OUP 指标页](https://academic.oup.com/pmj/pages/about) |
| Journal of Thoracic Disease | 2.3 | [AME 2026-06-23 公告](https://jtd.amegroups.org/announcement/view/10124) |

来源页面均明确 2025 数据年，对应 JCR 发布年 2026；观察记录保留核验时间和 ISSN。OUP 同页的五年 IF 3.3 和 CiteScore 6.4 被排除；其 Medicine, General & Internal 的 JIF 排名 64/336 只记排名，不推 Q。JTD 公告直接给出 2025 citation year，并明确 pISSN 2072-1439/eISSN 2077-6624；其 Ovid 目录也给出相同年度和值，可交叉核对。

在上批 94 刊基础上离线合入本批，可得 **100 刊官方 JIF**，完整官方 JCR 仍为 **2 刊**；新增官方 Quartile 为 **0**。固定 state `6135056` 的文献库覆盖由 727/1268 到 **765/1268**，雷达由 624/868 到 **626/868**。精选期刊仍为 **20/24**，没有用其他刊的指标填平缺口。完整统计及逐条访问结果见 [batch6 report](journal-public-batch6-report-20261007.json)。这些是待合入数据的计算结果，不是已发布站点状态。

## JAHA、Heart Rhythm 与 JCR 的实际审计

JAHA：本批读取 Wiley 的公开 overview，未找到 JIF 年份和值；出版社媒体资料链接指向 AHA 的 `https://www.ahajournals.org/metrics`，一次读取返回 403，即停该入口。普通 Wiley 首页 HTTP 读取也返回 403，停止，无修改请求头或旁路。公开检索摘要里的旧 IF 6.106 没有年版，不入当前指标。

Heart Rhythm：[Elsevier 官方目录](https://www.mea.elsevierhealth.com/heart-rhythm-15475271.html)实际读到标题、发行出版社和 print ISSN **1547-5271**，据此新增 `HeartRhythm` 别名和 ISSN 身份证据，**不提升 JIF 状态**。公开索引摘要可见 `Journal Citation Reports 2025 (Clarivate Analytics, 2026)`，但未取得其自身 JIF 数字与该年版的明确对应。ScienceDirect 比较栏里的 IF **2.8 属于 Heart Rhythm O2**，不是 Heart Rhythm，不得误取；6.6 是 CiteScore。已停用之前 403 的期刊/HRS 入口，没有重试或绕过。

用户 2025 参考表只通过受支持的 Library read/find 在首个 JCR sheet 的 **1–1003 行**内查刊名及 ISSN，JAHA/Heart Rhythm 均未命中；零命中只说明有限可见范围未匹配，不能断言完整工作簿没有。没有尝试此前被拒绝的下载，没有读取中科院 sheet 或上传私人材料到外部模型，50 条已交付历史参考保持原样。

JTD 公告的 Table 1 是出版社公开图像，可能包含逐学科分区。但阅读工具报不支持 application/octet-stream，一次普通原图请求返回 403，已经停用。不能根据“12 刊有 Q1/Q2”等出版社整体统计给 JTD 填 Q，也不从别处转抄没有逐类别证据的值。

European Heart Journal Supplements：[OUP 当期公开指标表](https://academic.oup.com/eurheartjsupp/pages/About)只有 2025 Scopus CiteScore 4.0，没有 JIF/JCR 字段，未借用。其他低覆盖刊仍需继续实查，不把未完成检索写成不存在指标。

另核到 [Wolters Kluwer 2026 媒体资料](https://mediakits.wkadcenter.com/mediakit/circulation-population-health-and-outcomes)明确 **Circulation: Population Health and Outcomes formerly Circulation: Cardiovascular Quality and Outcomes**。仅给原注册条目加现名别名，保留原规范名和历史文章书目；该媒体资料不含可直接验证的 IF 数字，未提升指标。

## 安全集成

合并本批提交后，在唯一集成任务自己的工作树执行：

```python
import json
from pathlib import Path
from journal_metrics import load_registry
from journal_public_metrics import apply_observations, apply_identity_observations

batch = json.loads(Path('docs/journal-public-observations-batch6-20261007.json').read_text())
current = load_registry('.')
updated = apply_identity_observations(
    apply_observations(current, batch['observations']),
    batch['identityObservations'])
# 检阅 updated 后由唯一集成任务写入其当前 config/journal-metrics.json。
```

在 scripts 可导入的 Python 环境下运行即可。合并函数遇到已有不同的已核实 JIF 会拒绝，已有相同事实会保留其证据和更完整的 JCR；身份合并只追加已有条目的精确别名/ISSN/公开证据，身份冲突由 schema validator 拒绝。共用展示 API、JS/CSS/d.ts、app/style/index 均无变动。

本批新增 5 个测试：保留全部已有官方对象与历史、两年 IF/五年 IF/排名分离、身份不提升指标、别名/ISSN/私有字段冲突、幂等。合计 36 个 journal Python 测试、20 个 public build、23 个 package（79 项），49 个 Node 断言通过。待合入注册表只存于忽略的 `.local`；Git diff 确认原注册表未改。
