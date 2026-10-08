# 搜索范围与快捷键第二版交接

本补丁建立在首版 `8cca35892d78a86de8c33d87b28e89f8c1dff99b` 上；初始 main `7dbe94c5465e7acca4097ac0282ef8ff78e4a48f` / state `6135056e3d544816ff3554a8e6241f60e3274698`。首版清单空状态与计数补丁已经完整验证并提供独立bundle。本篇只说明后续明确授权的搜索范围、分享URL和 `/` 焦点保护。

最终推荐交付分支为 `codex/search-shortlist-v14.2.4-20261007`：两版补丁无冲突cherry-pick到最新 main `8943dc2aaf55e2716f383ee8d199031ac6e156dd`（v14.2.4），完整恢复最新 state `e3067cca7d9e87de3206aa0b9967c1419553d911` 后重新构建并验收。源码相对该main仅28行diff（22新增、6删除），保留主集成的顶栏、阅读和指标更新。没有修改main/state远端。

普通关键词原本只在当前栏目匹配，但没有说明范围。现在搜索条件旁显示“检索范围：每日精选 / 文献雷达 / 文献库 · 当前筛选；切换栏目保留关键词”。保留现有导航切换及关键词传参；没有把普通词搜索改成全站搜索。精确DOI仍使用既有全站精确匹配，并明确显示“按 DOI 全站检索”。

原来仅保存于浏览器的compact偏好不会写入搜索链接，其他浏览器打开可能变成cards。现在有搜索或筛选的URL明确包含当前view，沿用既有mode、q和筛选序列化。无搜索/筛选的裸首页仍保留原有浏览器偏好和裸地址。回归用“房颤 + RCT”、已保存compact偏好，在无任何旧存储的新浏览器打开生成URL，核对相同栏目、视图、条件和结果数。个人关注期刊仍按既有设计仅存当前浏览器，没有外传关注内容。

`/` 缺陷真实复现：在空精选清单弹窗按 `/` 后，焦点到了背景 `globalSearch`，继续输入x使查询变为“房颤x”。补丁在已有弹窗、输入框、textarea、select、contenteditable、组合输入或修饰键场景不抢焦点；正常页面上的快捷键保留。Tab/Shift+Tab沿用首版的disabled过滤。

修改范围仅 `app.js` 的 `syncUrl`、`renderActiveFilterChips`、快捷键handler，及相关测试；没有CSS、布局、搜索算法、翻译、期刊指标、来源、后端、模型、权限或调度改动。

## 验证

`python3 scripts/build_public.py` 后运行 `python3 scripts/test_search_shortlist_ui.py --output .local/search-shortlist-followup-qa`，原固定基线上1165项检查通过。使用真实已审公开数据、Chromium 1440/390/320px及手机触摸上下文；除首版全部场景，还覆盖栏目范围随切换更新、房颤/复合条件分享URL在新浏览器复现、从当前公开题录选择作者及DOI检索、精选清单/阅读弹窗快捷键、四类编辑控件和正常页面快捷键。

最新v14.2.4/state复验同样1165项通过，0页面JS错误，0模型调用。实际无搜索/AI-ECG结果分别为每日精选37/2、雷达847/6、文库1267/11，三尺寸一致。构建为六文件：雷达872、文库1268、导读12、未核验速览11；默认列表差值来自时间或非原创过滤。已查看最新桌面、390和320px实际搜索/空状态截图，未把CSS审查称为窄屏验收。

全部 `/api/` 与必要的Europe PMC摘要读取都被只读fixture截获，不访问生产API、摘要服务、模型或全文。JS错误为0，实际模型调用为0。证据目录 `.local/search-shortlist-followup-qa/` 包含结果JSON、三栏目三尺寸截图、三尺寸空清单截图和 `boot-url.json`；日志在 `.local/search-shortlist-qa/followup-run.log`。这些证据不提交到公开包。

其他相关验证：boot URL20场景/240项、阅读/API/PDF30、study UI83、DOI helpers及真实离线浏览器均通过；公开构建23、打包23、release build3项Python测试通过。JS/Python语法与diff检查通过。

首版普通分支push两次收到GitHub `Internal Server Error`，没有远端分支，也没有main/state更新或部署。第二版继续以固定提交和验证过的bundle交付，唯一集成发布负责人 `01a11479` 决定集成。不要用本地public或manifest覆盖主任务源码/状态。
