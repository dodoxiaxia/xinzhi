# 2024 数据年历史分区参考的最小展示策略

用户追加指令明确允许将所供 2025 发布版表的本站匹配单学科 Q 作为历史参考展示。受支持的 Library 预览再次确认第一 sheet 名为 `2025JCRIF-分区`，字段为 `2024JIF`、`Quartile`、`JIF rank`，另有独立的 `2024分区` 字段。结合用户明确的发布年说明，足以标注 **2024 数据年 / 2025 发布版**。使用的是 `Quartile`；不使用后一列或中科院 sheet。没有取得官方当前分区核验，也没有把用户上传称为官方授权 JCR 导出。

展示范围为已有审计的 **50 个本站匹配期刊、每刊一条单学科历史 Q**。18 条多学科/单 Q 仍不进入展示，因为 Q 对应哪个学科未明。4 个历史条目所在期刊同时有官方 2025 JIF，继续显示官方 JIF 原值；其余较新官方 JIF 也保持不变。2024 JIF 数值、引用数、排名、原始整行、ISSN 增补、Library/file ID、下载链接与整表均未加入本次公共子集。403 未绕过，无新增下载或外部模型传输。

`config/journal-metrics.json` 增加可选顶层 `historicalReferences`，原 `journals[].jif/jcr` 完全独立且保持不变。每条仅包含 journalId、dataYear、releaseYear、category（参考表原文）、quartile、sources、checkedAt、status=`historical_reference_unverified`、categoryCoverage=`reference_single_category`。来源为 `user_reference`，url=null，scope=`matched_site_journals_only`；读取时间不是官方核验时间。旧 schemaVersion=1 输入仍可使用；用户参考来源不能通过验证器充当官方 JIF、JCR、ISSN 身份或发布版证据。

没有当前明确 Q 时，共用组件显示：`IF 45.6 (2025) · JCR 2024 Q1 · 用户提供参考表 · 待官方核对`。展开后显示 2025 发布版、原表单学科、读取时间、全部学科覆盖未核实及官方当前分区仍未核实。官方当前 Q 后续确实核到时，紧凑显示优先采用当前 Q，历史记录仍在展开内容中，避免把旧 Q 拼成当前版。`JM.historicalReferences(paper)` 可读取独立历史记录；原有 resolve/renderBadge/renderDetails/compactText 接口不变，布局任务无需增加另一套 badge。

`scripts/journal_reference_history.py` 只从已匹配、无冲突的有限预览报告挑出所需字段，不自行下载或写注册表；CSV 收录表和多学科汇总 Q 被排除。覆盖与未核实 CSV 增加独立 historical 列：当前官方状态仍为未核实，有历史参考不等于核实当前分区。公共子集不构成对整份参考表再分发许可的认定；本次依据是用户对上述限定展示的明确指令，没有扩展到整表公开。

新增 7 个 Python 历史层回归测试、16 个 Node 断言：年份与来源状态隔离、官方值不变、多学科不扩散、身份冲突不展示、私人字段/链接不进入 schema、当前 Q 优先、旧 schema 兼容。journal Python 合计 25、公开构建 20、打包 23，合计 68；Node 合计 43。完整固定 state 构建仍为六个公开文件。独立历史 badge/details fixture 在 320/390/1440 像素无横向溢出，Tab/Enter 展开通过，证据存 ignored `.local/journal-metrics/history-ui-evidence.json`。app/style 接入后的真实站点验收仍由布局和唯一集成任务完成。

剩余明确缺口：18 个多学科条目需要 **2024 年每个学科对应的 Q** 才能显示历史分区；当前值需要 **2026 发布版 / 2025 数据年每刊全部学科 Q 的官方可展示证据**。本轮 50 条限定历史展示无需整表导出或额外登录输入。
