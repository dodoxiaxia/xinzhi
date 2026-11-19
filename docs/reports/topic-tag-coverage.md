# 文章主题标签覆盖率

由 `scripts/report_topic_tag_coverage.py` 读取公开构建生成。文献雷达合并近期数据与 365 天存档，按 DOI/PMID 排除存档重复。跨栏目合计按条目出现次数计，同一论文可出现在两个栏目。文献库仅统计静态公开构建。

## 总览与标签数分布

| 栏目 | 总篇数 | 0 | 1 | 2 | 3 | 4 | 5+ | 无标签占比 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 文献库 | 1167 | 736 | 378 | 48 | 4 | 1 | 0 | 63.1% |
| 文献雷达 | 14625 | 3853 | 5907 | 2979 | 1344 | 542 | 0 | 26.3% |
| 合计 | 15792 | 4589 | 6285 | 3027 | 1348 | 543 | 0 | 29.1% |

## 各标签篇数

| 标签 | 文献库 | 文献雷达 | 合计 |
| --- | ---: | ---: | ---: |
| #房颤/电生理 | 42 | 2391 | 2433 |
| #心衰/心肌 | 34 | 3351 | 3385 |
| #心电 | 11 | 384 | 395 |
| #AI-ECG | 18 | 193 | 211 |
| #大模型/NLP | 276 | 399 | 675 |
| #卒中/抗凝 | 18 | 2186 | 2204 |
| #高血压/血管 | 15 | 2303 | 2318 |
| #冠脉介入 | 20 | 2394 | 2414 |
| #穿戴/远程监测 | 10 | 228 | 238 |
| #影像 | 16 | 2031 | 2047 |
| #AI-RCT证据 | 15 | 30 | 45 |
| #结构性心脏病 | 4 | 1246 | 1250 |
| #先心病 | 1 | 315 | 316 |
| #预防/血脂 | 10 | 614 | 624 |

## 按栏目与期刊档拆分

| 栏目 | 期刊档 | 总篇数 | 无标签 | 无标签占比 |
| --- | --- | ---: | ---: | ---: |
| 文献库 | 综合医学 | 140 | 93 | 66.4% |
| 文献库 | 心血管临床 | 63 | 26 | 41.3% |
| 文献库 | 基础与转化 | 0 | 0 | — |
| 文献库 | 综述 | 6 | 2 | 33.3% |
| 文献库 | 顶刊 | 47 | 36 | 76.6% |
| 文献库 | AI 期刊 | 465 | 295 | 63.4% |
| 文献库 | 其他期刊 | 446 | 284 | 63.7% |
| 文献库 | 期刊待补 | 0 | 0 | — |
| 文献雷达 | 综合医学 | 946 | 411 | 43.4% |
| 文献雷达 | 心血管临床 | 8683 | 1857 | 21.4% |
| 文献雷达 | 基础与转化 | 259 | 70 | 27.0% |
| 文献雷达 | 综述 | 4 | 1 | 25.0% |
| 文献雷达 | 顶刊 | 2 | 2 | 100.0% |
| 文献雷达 | AI 期刊 | 1387 | 718 | 51.8% |
| 文献雷达 | 其他期刊 | 3313 | 792 | 23.9% |
| 文献雷达 | 期刊待补 | 31 | 2 | 6.5% |

## 共现 Top 20

两词及以上的非空 AND 组合共有 394 种。文献库 43 种，文献雷达 389 种。表格按标签对的共现次数排序，涵盖 15792 条栏目记录。

| 标签 A | 标签 B | 文献库 | 文献雷达 | 共现篇数 |
| --- | --- | ---: | ---: | ---: |
| #心衰/心肌 | #房颤/电生理 | 6 | 791 | 797 |
| #影像 | #心衰/心肌 | 2 | 717 | 719 |
| #冠脉介入 | #卒中/抗凝 | 0 | 610 | 610 |
| #卒中/抗凝 | #房颤/电生理 | 6 | 557 | 563 |
| #卒中/抗凝 | #高血压/血管 | 1 | 524 | 525 |
| #冠脉介入 | #心衰/心肌 | 0 | 522 | 522 |
| #心衰/心肌 | #高血压/血管 | 2 | 491 | 493 |
| #冠脉介入 | #影像 | 3 | 480 | 483 |
| #卒中/抗凝 | #心衰/心肌 | 0 | 447 | 447 |
| #冠脉介入 | #高血压/血管 | 0 | 381 | 381 |
| #影像 | #高血压/血管 | 1 | 380 | 381 |
| #影像 | #房颤/电生理 | 1 | 339 | 340 |
| #卒中/抗凝 | #影像 | 0 | 307 | 307 |
| #影像 | #结构性心脏病 | 1 | 287 | 288 |
| #心衰/心肌 | #结构性心脏病 | 1 | 282 | 283 |
| #冠脉介入 | #房颤/电生理 | 4 | 264 | 268 |
| #房颤/电生理 | #高血压/血管 | 0 | 244 | 244 |
| #卒中/抗凝 | #结构性心脏病 | 0 | 243 | 243 |
| #心电 | #房颤/电生理 | 0 | 214 | 214 |
| #冠脉介入 | #预防/血脂 | 1 | 178 | 179 |

## 样例

按公开构建顺序取前 20 条，优先文献库，档次限心血管临床、基础与转化、综述。

| 公开题名 | DOI |
| --- | --- |
| 2026 ESC Guidelines on cardiac rehabilitation | 10.1093/eurheartj/ehag099 |
| 2026 ESC Guidelines for the management of cardiovascular disease and chronic kidney disease, in collaboration with the European Renal Association (ERA) | 10.1093/eurheartj/ehag098 |
| When Evidence Meets the System | 10.1016/j.jacc.2026.08.002 |
| Remote Detection of Cardiac Implantable Electrical Devices | 10.1001/jamacardio.2026.3403 |
| The myth of Sisyphos and the route of cardiovascular medicine | 10.1093/eurheartj/ehag586 |
| Understanding atrial failure: from diagnosis to clinical implications | 10.1038/s41569-026-01266-y |
| Cardiovascular research in China: pathways, incentives and editorial implications | 10.1038/s41569-026-01341-4 |
| Trustworthiness of artificial intelligence from a patient perspective | 10.1093/eurheartj/ehag303 |
| An Integrated Ecosystem for Cardiovascular Science and Health | 10.1161/circulationaha.126.080162 |
| Deprescribing in Patients With Cardiovascular Disease Experiencing Polypharmacy: A Scientific Statement From the American Heart Association | 10.1161/cir.0000000000001459 |
| Refining the Role of Beta-Blockers in Cardiovascular Medicine | 10.1016/j.jacc.2026.06.015 |
| Transforming clinical decisions with artificial intelligence: the HYPERMARKER project | 10.1093/eurheartj/ehag165 |
| Who Dies Suddenly, and Why We Miss Them | 10.1016/j.jacc.2026.06.001 |
| What is the cardiologist of the future? | 10.1093/eurheartj/ehag319 |
| Updated critical quality criteria for real-world artificial intelligence implementation | 10.1093/eurheartj/ehag121 |
| Using Artificial Intelligence to Adjudicate Major Adverse Cardiovascular Events in Clinical Trials | 10.1016/j.jacc.2025.10.055 |
| Closing the Guideline Gap | 10.1016/j.jacadv.2026.102639 |
| Artificial Intelligence to Propel Evidence Generation | 10.1016/j.jacc.2025.11.011 |
| Myocardial bridging: a practical guide for clinicians | 10.1093/eurheartj/ehaf1038 |
| When Care Becomes Autonomous | 10.1016/j.jacc.2026.01.069 |

## 建议

以下题名关键词只用于定位优先人工核对的条目。核对摘要和研究对象后再补标签。

| 无标签题名线索 | 文献库 | 文献雷达 | 建议 |
| --- | ---: | ---: | --- |
| 心代谢、肥胖、糖尿病和风险评估 | 6 | 178 | 涉及心血管一级预防或脂质结局时复核「#预防/血脂」。 |
| 骤停、复苏、室速和猝死 | 1 | 135 | 核对是否属于心律失常管理，可补「#房颤/电生理」。 |
| 心源性休克与机械循环支持 | 0 | 2 | 有明确心肌衰竭或心室支持证据时复核「#心衰/心肌」。 |
| 肺动脉高压与肺血管病 | 0 | 0 | 先做与「#高血压/血管」的边界抽查。若无标签线索少，暂缓新增词表项。 |
