# 隔离界面补丁交接（2026-10-07）

本分支为 `codex/weekly-v14-ui-20261007`，源代码基线 `03e2c7c98b2ba80583962df2e6da29d110e67c99`。唯一集成任务 `01a11479-1ff2-733a-b6d0-14c60dd320ef` 负责合并及发布。本任务没有推送 main/state、部署、触发 Actions、修改 Worker/API 连接、密钥或私人 PDF 权限。

## 最终界面

- 周榜保持桌面左侧两列卡片、右侧精读；按心血管、综合医学、AI 医疗、AI 前沿分类，数量取实际数据。旧期示范明确保留 2025 年论文身份。
- 精读保留原生 details，展开后“收起精读”持续可见，底部按钮恢复 summary 焦点。鼠标、键盘、触摸、重复折叠与切换返回已验证。
- 每日精选长摘要保持一个宽阅读栏，使用说明和主题筛选移至右侧。旧截图绿色的摘要核对说明段落删除；必要证据标签、AI 限制和后台日期保留。
- 周榜阅读直接使用 `PREGENERATED` 已验证缓存；中英对照桌面双列、手机堆叠。缺失项明确简短显示，不自动查询或生成，不伪造译文。
- 所有期刊显示点通过共享 JournalMetrics 接口读取指标：筛选、下拉及关注项、分组、卡片及列表、阅读页、晨会清单、证据对照、周榜及下期候选、信源状态、静态正文期刊引用。指标详情放在按钮/链接外，分享及 Markdown 作为独立附注，标准引用/BibTeX journal 字段不混入指标。
- 当前官方 IF 与历史 JCR 参考分开标注。只展示模块核实/允许的实际 Q，历史值保留数据年、用户提供参考表、待官方核对；展开保留发布版、学科、来源状态。无 UI 硬编码指标或按指标排序。
- 原始 logo PNG 字节与上游已合入的 icon.svg 不变。

## 依赖与冲突

本隔离分支合入两位内容所有者的原始提交用于离线验证：

- 周榜预生成 `111cb59aa71a13aff7b57b634c36e103bc15e04f`，分支 `codex/week-precompute-20261007`。
- 期刊指标最新 `7a1f25b36dd275beccff7e9803046b88e00b7097`，分支 `codex/journal-metrics-20261007`，包括历史参考层。

两依赖的唯一合并冲突为 `scripts/build_public.py` 的 bundle 拼接：同时保留 JOURNAL_METRICS、WEEKLY_BOARD、PREGENERATED，以及 journal-metrics.js 在 app.js 之前；release_integrity.py 自动合并保留两套实际输入。没有改动生产者的 API、预算或验证规则。

UI 提交为 `d8f5cdac9c2bd441fe34cb9baea0b7c9dd43c6bd`（分类与折叠）、`685cd79e1a231763a3f97a2abd2b97c902b0b59c`（每日精选右侧栏）和本交接文件所在提交（指标接入及回归）。可直接三方合并完整分支；若单独 cherry-pick UI，先合两依赖并检查上述构建拼接。不要重复 cherry-pick 其他所有者的整个历史范围。

UI 改动文件：app.js、index.html、style.css、scripts/test_layout_ui.py、scripts/test_weekly_ui.py、scripts/test_weekly_window.cjs、scripts/test_journal_ui.py、本交接文件。与父任务可能冲突的前端区域包括缓存预填/周榜自动请求保护、周榜 renderer、摘要 drawer、筛选/来源 renderer、每日精选 rail 切换、相应 HTML/CSS。父任务较新的 API 错误处理、日期精度和发布收据修复应保留，不用整文件覆盖。

## 可复现验证

先恢复授权的完整 state 数据。本次固定原始 state 为 `652e67852f87ffdacab1582f8e5723cab32ab3b9`；不是稀疏检出或示例数据。以下只恢复内容所有者快照和离线预生成，不能加 `--run`：

```bash
python3 scripts/restore_week_precompute_snapshot.py --apply
python3 scripts/week_precompute.py
python3 scripts/build_public.py
python3 scripts/test_layout_ui.py --browser /usr/bin/chromium
python3 scripts/test_weekly_ui.py
python3 scripts/test_journal_ui.py
node scripts/test_weekly_window.cjs
node scripts/test_reading_logic.cjs
node scripts/test_study_ui.cjs
node scripts/test_journal_metrics.cjs
python3 -m unittest discover -s scripts -p 'test_journal*.py'
python3 -m unittest discover -s scripts -p 'test_week_precompute.py'
python3 -m unittest discover -s scripts -p 'test_ci_daily.py'
python3 -m unittest discover -s scripts -p 'test_*public*.py'
python3 -m unittest discover -s scripts -p 'test_package_release.py'
```

结果：480 浏览器断言、60 个四风格/多尺寸布局；67 个周榜离线 fixture 断言（20/24/30 篇）；116 个实际周榜/期刊接入断言（1440/390/320 像素，真实缓存翻译，比较表为明确标注的离线 metadata-only fixture）；无页面 JS 错误或页面/阅读框横向溢出。周榜日期 61、阅读/API/PDF 30、研究结构 UI 83、期刊 Node 43 个断言；期刊 Python 25、周榜预生成 Python 16、CI Python 29、公开构建相关 Python 63、打包 Python 23 个测试通过。API/模型响应均离线模拟，模型 POST 为零。

实际公开包仍恰好六文件，候选 866、文献库 1219、导读 12、未核验速览 11、历史公开标题 12635。周榜 24，标题译文覆盖 23、摘要翻译 1、结构/速览 0。完整 state 离线重新选择得到 91 个合格候选、分类 14/6/3/1；不同于生产者原始快照选择时的 90 候选、13/7/3/1，界面没有补篇或人为改分类。不得把界面接入完成解释为全量译文/总结完成。真实付费批次已有暂停记录，本任务保持暂停、不重试模型。

## 图片证据与剩余阻塞

已实际查看用户 ZIP 中 1554×2092 标注图，PNG SHA256 `4e9fb66e838cc5d3586401c991daaf1195cea28c493e30cf54d8c5bbe6bc6996`：两个红框对应使用导航及主题筛选，旧绿色框对应精选说明段落。桌面/手机最终截图在交付 ZIP 的 regression 与 journal 目录；真实翻译截图与离线测试译文截图分别标注。

后来“绿框部分不要了”的**新增**图片 `libfile_59ad92f85d50819190eb8819dee3cf82` 已走正式 prepare_materialize 和当前 helper，下载 HTTP 403，未拿到像素。只尝试一次并停止，无旁路。已询问新框内文字；准确区域确认前没有猜删，也不声称看过新截图。这与旧绿框已完成删除分开记录。

公开指标的当前分区未核实及预生成实际缺口由数据任务继续处理；UI 接口契约已确认。原始 state、私有 PDF、ledger/缓存和凭据不进入交付 ZIP 或源代码 UI 提交。
