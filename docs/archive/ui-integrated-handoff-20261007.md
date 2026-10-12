# 组合界面验收交接（2026-10-07）

源分支 `codex/ui-integrated-20261007`，基于最新 main `75f538eff711e7eb53628e0c101df278a97c3ee7`（v14.1.3），固定完整 state `58d48555e6a804a6dfd29de4ecd501012e734ca1`。由原任务 `01a11479-1ff2-733a-b6d0-14c60dd320ef` 最终合并和发布。本任务只组合隔离源码与离线验收，没有推 main/state、部署、触发 Actions、添加调度、改变连接/密钥/PDF 权限或实际模型调用。

## 已组合的原始提交

- UI `f8a86cb89e1bec4c3ed1caf2b7b878798bbbb9f2`：分类 24 篇周榜、桌面双列卡片及右侧精读、原生折叠、缓存优先中英摘要、每日精选右侧导航/主题、统一期刊指标。
- 用户确认的页头文字删除 `dfb33f1ab2a1603792bd21a9dece5dc60841e177`：仅保留原 logo，删除可见 AIHOT-Med 和“心血管 × AI 医疗文献”。通过文字确认解决了新增绿框的位置；仍未声称看过下载 403 的新截图。
- 期刊模块原始历史已包含最新 `7a1f25b36dd275beccff7e9803046b88e00b7097`：当前 IF 与用户提供的 2024 JCR 历史 Q 独立，保留年份、来源和待核对标识；实际 Q 按注册表读取。
- 预生成数据模块更新到原作者 `176e98be6679c9798f85e6e98af68ccfb2ce364f`：保留原作者 study 引句 ID/逐字证据修复、缓存任务版本和累计预算保护。该模块的 Worker 改动来自原始提交，本任务没有自行改 API 行为或连接。

main 原有 1,268 篇已审公开文库、DOI 全文收录/手动重试、PDF 身份与权限、官方出版日期修复、发布版 v14.1.3 均保留。公开候选中的 JAMA 房颤论文 DOI `10.1001/jamanetworkopen.2026.37533` 实际构建日期已检查为 `2026-10-05`，带官网已复核日期来源。

## 合并处理

冲突在 `scripts/build_public.py` 的导入及 `scripts/test_ci_daily.py` 时钟 fixture：保留官方日期、公开库 snapshot 和 DOI adjudication，以及期刊指标与周榜两个数据契约。app.js/style.css/Worker 自动合并后通过各模块原有边界检查。

额外修复 `scripts/ci_daily.py` 内容哈希识别 JOURNAL_METRICS。否则它会把指标视作 app 开始，停止归一化后面的周榜/预生成刷新时间，造成无内容变化也发布。已有全常量测试扩展，并新增指标或译文变化仍触发内容差异的断言。没有修改 daily.yml。`scripts/test_release_build.py` 为旧主线出版日期/构建 fixture 补指标实际依赖，保持发布收据和日期回归有效。

本轮自主变更仅上述 CI 内容哈希、两项测试适配和本交接文件；其他功能来自保留原所有者提交的合并历史。可直接 fetch 并审核合并完整组合分支，避免从多个独立分支手工覆盖完整 app.js/Worker。若 main 后续推进，采用三方合并并保留后续修复；不要重写 main/state。

## 离线结果

先恢复固定 state 全部 data，然后依次运行：

```bash
python3 scripts/restore_week_precompute_snapshot.py --apply
python3 scripts/week_precompute.py
python3 scripts/build_public.py
python3 scripts/test_layout_ui.py --output .local/integration-qa/regression
python3 scripts/test_weekly_ui.py
python3 scripts/test_journal_ui.py
python3 -m unittest discover -s scripts -p 'test_ci_daily.py'
python3 -m unittest discover -s scripts -p 'test_week_precompute*.py'
python3 -m unittest discover -s scripts -p 'test_journal*.py'
python3 -m unittest discover -s scripts -p 'test_*public*.py'
python3 -m unittest discover -s scripts -p 'test_release_build.py'
python3 -m unittest discover -s scripts -p 'test_package_release.py'
python3 -m unittest discover -s scripts -p 'test_pipeline.py'
```

浏览器：520 断言／60 个四风格多尺寸布局、67 个周榜 fixture 断言、116 个实际周榜/期刊接入断言；无页面 JS 错误或页面/阅读框横向溢出。鼠标、触摸、Enter/Space、重复折叠、模式返回、缓存译文即开、翻译中断/重试/迟到结果隔离、指标展开/分享/Markdown/对照均通过。实际查看组合版桌面周榜、手机周榜、每日精选与真实缓存译文截图。模型 POST 仅在明确模拟的失败/交互 fixture 内，真实模型调用为零。

Python：CI 30、周榜与预算/缓存 61、期刊 25、公开相关 83、完整构建收据 3、打包 23、pipeline 7。Node：DOI UI/Worker、publication-date UI 10、reading/API/PDF 30、周榜日期 61、study UI 83、期刊 43、study services、真实来源证据回归 20、edge 与 PDF worker 均通过。脚本语法和 diff 检查通过。

构建仍为恰好六个白名单文件。当前候选 870、文库 1268、导读 12、未核验速览 11、历史公开题名 12635。93 个合格近期候选中实际选 24，分类 14/6/3/1。标题译文 22/24、摘要译文 1/24、study 0/24、quicklook 0/24；与先前快照数量差异来自新的完整 state，UI 未填旧稿或编造结果。

## 剩余发布条件

全榜预生成仍未完成；失败尝试、输出预留与暂停保持。新模块在 GitHub Actions 付费路径检测到缺少可靠逐次账本保存时拒绝执行，错误码 `paid_ci_requires_durable_checkpoint`；现有工作流没有被本任务修改。唯一集成负责人须先解决既有调用前后及失败状态的可靠持久化，再按原预算和授权恢复真实验证，不能直接删暂停或重跑旧付费接口。离线构建与 UI 成功不证明线上模型修复已生效。

当前组合源码和最新证据为原实施任务提供审核及最终发布输入；代码分支、离线构建和 Library 保存都不能表述成网站已上线。原 state、PDF、私有索引、付费 ledger 和凭据不进入交付包。
