# 搜索、计数和精选清单空状态交接

独立候选分支 `codex/search-shortlist-20261007`；源码基线 `7dbe94c5465e7acca4097ac0282ef8ff78e4a48f`，恢复的真实 state `6135056e3d544816ff3554a8e6241f60e3274698`（v14.2.3）。唯一集成与发布负责人仍为任务 `01a11479`。本分支只交付前端窄函数及回归，没有推 main/state、部署、调用模型、改权限或调度。重新 fetch 时 main 仍为该基线。

## 实际复现

固定 state 的公开六文件在本地重新构建，用真实 Chromium 运行，API 全部截获为只读 fixture；没有访问生产 API、全文或模型。

| 栏目（全部分类） | 无搜索 | AI-ECG | 无命中词 |
| --- | ---: | ---: | ---: |
| 每日精选 | 37 | 2 | 0 |
| 文献雷达（默认近14天） | 843 | 6 | 0 |
| 文献库 | 1267 | 11 | 0 |

`AI-ECG` 检索能改变列表，当前 main 无需重复修搜索。文库 `AI ECG` 同样为11条；符合题录已有标签。导航徽标为1268，默认列表1267；打开“含更正 / 来信”后列表1268，差值为一条默认隐藏的非原创条目。第三方报告的1270/1269不是这个静态快照的绝对数，未用生产补录接口验证那两条新增记录；此次明确总题录与当前筛选结果的口径，不改计数算法。

空精选清单三个操作按钮在基线均 `disabled=false`，确实可点；原复制/导出函数有空值提示，但按钮自身没有禁用。修复后原生 disabled，并通过 `aria-describedby` 指向可见的空状态理由；加文献、移出最后一篇、清空、刷新及未解析的旧保存ID都更新正确。键盘焦点循环排除 disabled 控件，空弹窗的 Tab/Shift+Tab 保持在关闭按钮。

## 范围与已有能力

`app.js` 只改 `updateHeaderBadges`、`renderActiveFilterChips`、`openHuddleModal` 和键盘焦点过滤，共15行新增、4行删除；没有全文件重排、CSS、布局、译文、指标、来源、模型或后端变更。

当前 main 已有 compact 视图和0结果“重置所有筛选”。回归证明复合期刊/研究类型/日期条件保留可见的条件标签，保持0结果，点击一次后才清空条件并恢复结果；没有自动放宽。手机 `/` 提示涉及主任务顶栏样式，本分支未改。

## 验证与取证

先运行 `python3 scripts/build_public.py`，再运行 `python3 scripts/test_search_shortlist_ui.py`。最终运行940项检查通过。新测试用固定已审公开数据覆盖每日精选/雷达/文库的搜索、条件清除、空结果、一键重置、模式切换、URL刷新、浏览器离开后回退、compact、计数说明、清单添加/移出/清空/持久化/复制/导出和键盘可访问性。实测 viewport 为1440、390、320px；有触摸手机浏览器上下文和实际截图，非CSS审查。所有API请求仅被本地mock，真实模型调用0。

其他相关检查通过：Node阅读/API/PDF30断言、study UI83、真实来源证据20、source health40、DOI helper及真实离线浏览器、boot URL20场景/240检查；公开构建23、打包23、release build3项Python测试；JS/Python语法和 `git diff --check`。

本地证据在忽略目录 `.local/search-shortlist-qa/`：`baseline.json`、`baseline-empty-desktop.png`、`results.json`、`final-run.log`、`empty-1440.png`/`empty-390.png`/`empty-320.png`，以及三栏目的三尺寸搜索截图。实际查看了三尺寸空状态截图，说明和按钮均可见，没有横向溢出或页面JS错误。截图/数据不进入此分支或公开包。

普通分支push前已读全部两个工作流：`daily.yml` 和 `fulltext.yml` 的push均限定main，job同样守卫 `refs/heads/main`；本分支不会触发发布。不触发workflow_dispatch。集成人应保留主任务未交顶栏/卡片布局，按窄函数合并本提交并重新构建；本地构建产物与manifest不提交。
