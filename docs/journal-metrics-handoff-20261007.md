# 期刊指标补丁与集成交接（2026-10-07）

本任务只实现可审计注册表、统一组件和构建接线。`app.js`、`style.css`、`index.html` 未修改，所有页面展示点仍需布局任务 01a1153c 与唯一集成任务 01a11479 接入。没有部署、推送 main/state、创建调度或改凭据。

基线为 main `03e2c7c98b2ba80583962df2e6da29d110e67c99`、固定 state `652e67852f87ffdacab1582f8e5723cab32ab3b9`。工作目录 `/workspace/journal-metrics`，分支 `codex/journal-metrics-20261007`。最新 xinzhi 无自身 AGENTS.md 或 .agents/skills；相邻 AI- 的指引属于另一文献归档仓库，未进行该库的同步/下载工作。

实际 state：文献库 1,219、候选 866、原始历史雷达 13,287、公开构建历史雷达 12,635、导读 12、未核验 AI 速览 15。原有各数据集没有 IF/JCR/ISSN 字段。原始 208 标签归并为 205：176 个刊名标签、6 个身份不清的标签、23 个明确非期刊标签；176 不等于独立核实了 176 个期刊身份。别名补丁将 Lancet (London, England)、BMJ (Clinical research ed.)、Euro J Heart Failure 与已有规范名统一，并统一已有 Progress in Cardio Dis 信源别名。

完整逐刊来源覆盖见 [coverage CSV](journal-metrics-coverage-20261007.csv)，缺失见 [unverified CSV](journal-metrics-unverified-20261007.csv)，原始别名及出现次数见 [inventory JSON](journal-metrics-inventory-20261007.json)。14 刊有核实 JIF，168 标签 JIF 未核实；全部 182 个适用/身份不清标签的 JCR 分区仍未核实，23 标签为不适用。8 刊公开学科与 JIF 排名已记录，但不以排名比例推算 Q 值。没有混用 JCI 排名、CiteScore、SJR 或中科院分区。

后续收到的 5 份“供参考”表已按 [有限覆盖审计](journal-reference-audit-20261007.md)纳入：受支持字节访问 403，预览可见范围匹配 73 标签/74 记录；2024 JIF/2025 JCR 与官方较新值分开，50 单学科 Q 候选及 18 多学科单 Q 行只进私有中间表，未变成已核当前指标。新增 5 个参考表回归检查通过，journal Python 总数为 18。

## 核实来源

核验时间均为 `2026-10-07T09:24:05Z`。表中数据年为 2025；JCR 发布版年为 2026。[Annual Reviews 出版社页面](https://www.annualreviews.org/page/librarians/impact-factors)正文明确两者关系，但小标题仍写 2025，已记录这一页面内部不一致。Clarivate 2026 发布新闻可搜索到，但直接打开失败，未用其不可读正文补值。

| 规范刊名 | 2025 JIF | 官方公开页 | 已公开的全部 JIF 学科排名（分区均未核实） |
|---|---:|---|---|
| European Heart Journal | 45.6 | [OUP](https://academic.oup.com/eurheartj/pages/About) | Cardiac & Cardiovascular Systems 2/237 |
| Europace | 10.2 | [OUP](https://academic.oup.com/europace/pages/About) | Cardiac & Cardiovascular Systems 17/237 |
| European Heart Journal - Digital Health | 5.3 | [OUP](https://academic.oup.com/ehjdh/pages/about) | Cardiac & Cardiovascular Systems 50/237 |
| European Heart Journal - Cardiovascular Imaging | 6.1 | [OUP](https://academic.oup.com/ehjcimaging/pages/About) | Radiology, Nuclear Medicine & Medical Imaging 20/217；Cardiac & Cardiovascular Systems 37/237 |
| European Heart Journal - Cardiovascular Pharmacotherapy | 8.2 | [OUP](https://academic.oup.com/ehjcvp) | Pharmacology & Pharmacy 20/356；Cardiac & Cardiovascular Systems 28/237 |
| Cardiovascular Research | 12.5 | [OUP](https://academic.oup.com/cardiovascres/pages/about) | Cardiac & Cardiovascular Systems 12/237 |
| PNAS Nexus | 4.8 | [OUP](https://academic.oup.com/pnasnexus/pages/About) | Social Sciences, Interdisciplinary 9/275；Multidisciplinary Sciences 23/140 |
| National Science Review | 18.1 | [OUP](https://academic.oup.com/nsr/pages/About) | Multidisciplinary Sciences 8/140 |
| Journal of the American Medical Informatics Association | 7.1 | [OUP](https://academic.oup.com/jamia/pages/About) | 未公开 |
| Nature Medicine | 52.5 | [Nature](https://www.nature.com/nm/journal-impact) | 未公开 |
| Nature Machine Intelligence | 29.8 | [Nature](https://www.nature.com/natmachintell/journal-impact) | 未公开 |
| Communications Medicine | 7.4 | [Nature](https://www.nature.com/commsmed/journal-impact) | 未公开 |
| npj Digital Medicine | 18.0 | [Nature](https://www.nature.com/npjdigitalmed/journal-impact) | 未公开 |
| Nature Reviews Cardiology | 50.2 | [Nature](https://www.nature.com/nrcardio/journal-impact) | 未公开 |

上述页同时核到对应 ISSN，未凭记忆补其他印刷/网络 ISSN。[Frontiers in Digital Health](https://www.frontiersin.org/journals/digital-health/about)核到 ISSN 2673-253X；页面显示 IF 5.2 但没有指标年份，所以仍为 JIF 未核实。MDPI stats 返回 429/不可读，BMJ 页面不可读，部分 Nature/OUP 页面出现跳转错误/超时；未绕登录或付费墙。公开 Nature 指标页的正常正文通过阅读工具获得；注册表保留无查询参数的规范源 URL。

用户截图 Library `libfile_82f6a032502c8191935527ee90875835` 经正式 Library read 成功解析文件身份；正式 materialize/helper 下载返回 HTTP 403，未获得像素内容。没有改用旁路下载或据文字摘要声称看过截图。站点文本读取也失败，本轮盘点依据最新仓库与固定 state。

## 共用接口与展示规则

注册表是 `config/journal-metrics.json`，运行时 validator 是 `scripts/journal_metrics.py`；类型契约见 `journal-metrics.d.ts`。`sources` 分别记 URL、来源类型及 UTC 核验时间；每项 JIF 和 JCR 学科引用明确 source ID。JIF 年份、JCR 数据年、JCR 发布版年独立字段。缺失值为 null，不能用 0 替代缺失。新刊没有核实数据时保留未核实，不按新刊年份推断不存在 JIF。

`scripts/build_public.py` 将 `window.JOURNAL_METRICS` 和 `journal-metrics.js` 放在 app 之前；继续只有六个公开文件。`scripts/release_integrity.py` 把新实际构建输入加入内容哈希，旧构建收据不能隐藏新注册表变动。注册表按刊一次打包，未在每篇文献复制。

```js
const JM = window.JournalMetrics;
JM.resolve(paper);          // paper/string/ISSN 精确映射；名称与 ISSN 冲突时未核实
JM.renderBadge(paper);      // 无交互 span，可放在筛选 button 内
JM.renderDetails(paper);    // 原生 details/summary，必须放在 button/a 外
JM.compactText(paper);      // option、分享/Markdown 用纯文本
JM.detailText(paper);       // 完整学科、年份、状态与边界说明
```

示例：`IF 18.0 (2025) · JCR 未核实 (2026)`；非期刊：`IF/JCR 不适用`。多学科只在完整核实时显示全体不同分区 `Q1/Q3`，不选最好分区。部分学科已有明确 Q 值时显示 `Q1/Q3*`，展开说明覆盖不完整；当前真实数据没有 Q 值。类别排名和分区是不同字段。期刊指标只描述期刊，不给单篇文献评级，不参与现有优先级排序。

`journal-metrics.css` 是提供布局任务合并的样式片段，未自动改变 style.css。badge 可在两个完整 token 之间换行；展开内容允许长学科/URL换行。原始本地 index 预览尚未加新的 scripts；集成时可用 public/index.html + 已打包 public.js 预览，或明确加开发用注册表脚本。

## 实际页面接入位置（基线 app.js）

| 展示位置 | 代码位置/处理 |
|---|---|
| 左侧出版社展开的期刊筛选 | `renderSidebarFilters`，约行 920；button 内用 renderBadge，展开详情放外部 |
| 期刊下拉、已关注、激活筛选 | `renderBrowseBar` 约行 1888；option 用 compactText，value 继续规范刊名；`renderActiveFilterChips` 约行 1005 |
| 卡片/紧凑列表 | `renderArticleCard` 行 1058、`renderCompactRow` 行 1114；刊名后 badge |
| 按期刊分组标题 | `renderStream` 行 1176；刊名后 badge |
| 文章详情 | 约行 1248；刊名后 badge，并放 renderDetails |
| 晨会清单 | 约行 1589；刊名后 badge |
| 逐篇证据对照表 | 约行 460，表头 p.journal；刊名后 badge、独立详情位置 |
| 本周规则榜/下一期候选 | `renderWeeklyAuto` 行 1860、`renderNextCandidates` 行 1881 |
| 信源状态 | `renderSourcesHealth` 行 1728；s.name 以注册表别名解析，但保留原信源名称 |
| 分享单篇、证据对照复制、晨会 Markdown/微信复制 | 约行 199/542/1639/1668；compactText 独立附注，不把指标写入 journal 字段 |
| 旧期示范的静态刊名 | index.html 行 195/199/335 的 Nature Medicine，以及正文行 230 的 JAMA/NEJM 引文；由布局任务决定脚注/相邻附注方式，保留原论文年份 |

标准引文、BibTeX 的 journal 字段约 app.js 行 1215 保持纯刊名；期刊指标作为另行附注，避免破坏标准书目。正文中的 Nature 品牌/Reporting Summary 或链接文本若不表示期刊，不挂期刊指标。`editorial/weekly_checked.html` 含刊名但不在六文件公开包中，未修改历史人工正文。

潜在集成冲突文件为 `scripts/build_public.py`、`scripts/release_integrity.py`、`scripts/enrich_metadata.py`；没有改 app/style/index。合并时需保留唯一发布任务的其他构建/摘要/收据修复。来源 JSON、组件 JS/CSS/d.ts、tests 和新交接文件是新增文件。

## 测试与最小缺失输入

已通过：13 个 journal Python 测试（含原别名测试）、27 个 Node 指标断言、20 个公开构建测试、23 个打包测试；完整固定 state 构建恰好六文件，脚本语法通过，原有内容计数保留。组件离线 fixture 在系统 Chromium 的 320/390/1440 像素宽度没有横向溢出，原生 details 可用 Tab/Enter 展开；截图为 `.local/journal-metrics/component-320.png`，构建证据为 `.local/journal-metrics/build-manifest.json`，两者未进入 Git/public。该验证不能代替 app/style 接入后的真实站点验收。

要补分区，最小输入是用户已授权、且允许本站展示的 2026 JCR 发布版/2025 数据年的**本站具体刊名子集**：规范刊名、ISSN/eISSN、JIF、JIF 年、JCR 发布年、全部学科类别及对应官方 JIF Quartile（有则排名）、导出/核验时间。只需未核实表对应期刊；不需要整库导出、登录凭据、私人 PDF 或私人索引。6 个身份不清标签还需确切期刊名/ISSN；不能借系列/文章标题猜刊名。收到授权导出后逐项核对年份和身份，完整学科才把 categoryCoverage/status 提升为 complete/verified。

唯一仓库工作流 `.github/workflows/daily.yml` 的 push 分支为 main，refresh 又校验 refs/heads/main；运营说明记载唯一发布入口为该工作流。专用分支可供集成读取，但本任务不触发生产或创建 PR/部署。

后续仅改 `config/journal-metrics.json`/`journal-metrics.js` 时，现有 push.paths 不会立即启动刷新，已有定时刷新仍会读取 main。若唯一发布任务要求与旧 app/style 编辑相同的即时发布行为，应在其最终 daily.yml 中加入这两个精确 paths；本子任务没有修改工作流，以避免覆盖集成任务。
