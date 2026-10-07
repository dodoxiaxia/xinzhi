# 用户参考表的有限覆盖审计

**后续限定展示更新：** 用户追加明确指令后，50 条单学科 Q 已按 [独立历史参考策略](journal-reference-history-20261007.md)纳入本站最小公共子集，标明 2024 数据年、2025 发布版、用户提供参考表、待官方核对。以下保留初次只读审计范围与私人原始报告说明；18 条多学科单 Q 及原始整行仍不公开，官方当前指标未改变。

2026-10-07 补充收到 1 份 2025 年度 JCR/中科院 XLSX 和 4 份 2025-05-19 WoS 收录目录 CSV，用户用途为“供参考”。只将本站需要的匹配记录提取为私有中间表，没有把整表或原始参考指标加入 Git、public 或官方指标注册表，没有外发给其他模型。

正式 Library materialize/helper 对 XLSX 返回 HTTP 403，已停止字节下载。Library read/find 可读解析文本：XLSX 每 sheet 前 1,000 行，共两个 sheet；每 CSV 前 1,000 行。本审计只覆盖这些可读预览，**预览未命中不表示原文件不存在该刊**。本环境没有额外 executor 表格技能，采用可复用本地 Python/csv 脚本处理已授权匹配片段，不绕取图/下载限制。

| 参考文件 | 匹配本站记录 | 本次能证明的范围 |
|---|---:|---|
| 2025年度中国科学院及科睿唯安JCR期刊分区表.xlsx，sheet 2025JCRIF-分区 | 68 | 2024 JIF、2025 发布版；用户参考值，未当成官方独立核实值 |
| AHCI目录 20250519.csv | 0 | 可读前 1,000 行未命中，整表覆盖未知 |
| ESCI目录 20250519.csv | 0 | 可读前 1,000 行未命中，整表覆盖未知 |
| SCIE目录 20250519.csv | 5 | American Heart Journal、American Journal of Physiology - Heart and Circulatory Physiology、Annals of Internal Medicine、Arabian Journal for Science and Engineering、Artificial Intelligence 的当时收录/类别参考 |
| SSCI目录 20250519.csv | 1 | BMC Medical Education 的当时收录/类别参考 |

合计 74 条记录，对应 73 个本站标签；182 个适用/身份不清标签中还有 109 个未在可读预览内匹配。没有发现这些已匹配记录的名称/ISSN 身份冲突或 ISSN 校验码错误。不能将这个数量解释为整个参考表或全部 WoS 的覆盖率。

JCR 68 条中，50 条仅有一个 Category 与一个 Quartile，可以作为**2024 数据年/2025 发布版的单学科参考候选**。18 条有多个 Category，但只有一个 Quartile/JIF rank，映射范围不明；私有报告保留原值为 `quartileAsProvided`，标记 `unmapped_multiple_categories`，不把它分配给每个学科，也不称全学科已核。表中的“2024分区”列没有充作当前 JCR Quartile。

7 刊同时匹配较新的官方 2025 JIF：Nature Medicine、Nature Reviews Cardiology、European Heart Journal、Nature Machine Intelligence、National Science Review、npj Digital Medicine、Cardiovascular Research。参考表是 2024 JIF，数值不同属年份变化，不能报成同年冲突；公共注册表的官方 2025 JIF 均保留，未用旧表覆盖或与旧分区拼成年份统一的 badge。

第二 sheet 明确为 `2025中科学院分区表`，列为期刊名称/2025分区/Top/Open Access。本轮排除，1 条被首轮全文匹配命中的该 sheet 行已剔除。四个 CSV 只有 WoS 收录类别，没有 IF 或 JCR Quartile，不填入指标字段。

复用脚本为 `scripts/audit_journal_references.py`，测试为 `scripts/test_journal_reference_audit.py`。私有输入为 `.local/journal-metrics/reference-match-input.json`，私有提取/冲突/逐刊参考范围报告为 `.local/journal-metrics/reference-audit.json`。后者保留源文件与 Library 身份、来源类型 `user_reference`、核验时间、预览范围及 `publicUse=false`；输出路径强制位于 ignored `.local`。这些文件未提交/推送。脚本不会改 public registry。

要完成全量匹配，需要这 5 份文件在当前环境的受支持授权字节访问恢复，或仅本站期刊的授权相关行。要把分区作为最新值展示，需要 2026 发布版/2025 数据年的官方逐学科 Q 及可展示范围；这批旧表可以用于后续官方核对线索，不能证明当前分区。无需整库追加导出、登录凭据或私人全文。

5 个新增离线回归检查通过：多学科汇总 Q 不扩散、CAS 排除、CSV 收录类别不变成指标、身份冲突停止匹配、预览范围与重复片段去重。加上原指标/别名测试共 18 个 journal Python 测试通过。此前公共构建与组件验证不受影响；生产显示点仍由布局/唯一集成任务接入。
