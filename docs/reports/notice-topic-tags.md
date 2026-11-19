# 出版声明主题标签审计（t13）

## 数据范围

在两个临时工作树使用同一份离线输入，对比 `main`（`f333c59`）与 t13 的 `python3 scripts/build_public.py` 产物。基础输入由 `scripts/fixtures/build_browser_data.py` 生成，包含已审核的公开文献库快照、周榜及合成雷达样本；基础夹具没有 365 天存档，也没有已打标签的声明。

为验证实际存档构建，另将 `config/publication-status.json` 的全部题录及 PubMed 类型/关系和 H01 生成到临时存档输入。存档使用统一的夹具日期；H01 的 ID、PMID 和旧标签来自 `editorial/tag_backfill_overlay.json`（F1142，`machine_reviewed`），题名来自 [Crossref 公开题录](https://api.crossref.org/works/10.1093/ejcts/ezag240)。生产 state、动态 DOI 补录及 KV/D1 未读取或修改；本表不代表线上全量。

从构建分片读取文献库 1,167 条、近期雷达 83 条、每日精选归档 12 条及压缩雷达存档 12 条，按栏目和 ID 比对标签；用同一份构建输入补回不会公开的分类元数据。存档输入中的一条已由近期雷达收录，构建按原有规则去重。

## 所有命中且之前有主题标签的记录

| ID | 题名 | 构建前标签 | 分类依据 | 新构建标签 |
| --- | --- | --- | --- | --- |
| PMID 41916660 | RETRACTION: Prevention of acute myocardial infarction induced heart failure by intracoronary infusion of mesenchymal stem cells: phase 3 randomised clinical trial (PREVENT-TAHA8). | `#心衰/心肌`、`#冠脉介入` | PubMed 类型：`Retraction Notice` | 无 |
| PMID 41224475 | EXPRESSION OF CONCERN: Prevention of acute myocardial infarction induced heart failure by intracoronary infusion of mesenchymal stem cells: phase 3 randomised clinical trial. | `#心衰/心肌`、`#冠脉介入` | PubMed 类型：`Expression of Concern` | 无 |
| PMID 41412600 | RETRACTION: Intraosseous versus intravenous vascular access in upper extremity among adults with out-of-hospital cardiac arrest: cluster randomised clinical trial (VICTOR trial). | `#高血压/血管` | PubMed 类型：`Retraction Notice` | 无 |
| `rss-6d27e5a0b882b910` / PMID 42990128（H01） | Retraction of: A giant free-floating thrombus in the ascending aorta caused by radiofrequency ablation of premature ventricular contractions | `#房颤/电生理`、`#卒中/抗凝`、`#高血压/血管` | 题名前缀：`Retraction of:` | 无 |

四条记录仍在构建结果中，只移除了机器标签；其余记录的标签逐条相同。按文献雷达构建数据（含去重后的存档）计数：房颤/电生理 4 → 3，心衰/心肌 5 → 3，冠脉介入 3 → 1，高血压/血管 3 → 1，卒中/抗凝 1 → 0。

**人工标签（保留，单独报告）：** 离线输入中未发现带人工主题标签的声明；已提交的主题标签覆盖表也没有 `tagOrigin: human` 条目。单元测试验证了人工覆盖和带显式人工来源的标签仍保留。
