# 文献雷达筛选区：线上可用性走查（修复前）

2026-11-19，未登录、只读 Chromium。均从 [首页](https://learn.dryz.info/) 点击「文献雷达」，确认地址变为 <https://learn.dryz.info/?mode=candidates>、雷达页签高亮、默认条件为「心血管+AI · 近 14 天」，再开始操作。视口为桌面 **1280 × 850 CSS px**、触屏模拟 **390 × 844 CSS px**。实时数据会变动；本文数字仅为当次观察。没有提交表单、关注期刊、保存预设或下载；浏览器拦截非 GET/HEAD 及下载路径，本次无请求触发拦截。

| 桌面 1280：默认状态 | 手机 390：默认状态 |
| --- | --- |
| [桌面默认状态](https://github.com/dodoxiaxia/xinzhi/pull/206#baseline-1280) | [手机默认状态](https://github.com/dodoxiaxia/xinzhi/pull/206#baseline-390) |

**改动范围：**只有下列 Bug 1、Bug 2 属于本票修复；其余仅记录建议，请站主决定是否立项。

截图以各小节的链接跳转到 [本 PR 的线上走查截图](https://github.com/dodoxiaxia/xinzhi/pull/206#线上走查截图)，图片未提交到仓库。

## 本票问题

### Bug 1 · 期刊数与当前筛选实际结果不符 — 高

**复现（两种宽度）：**从默认状态点「AI」右侧箭头，在「搜索刊名」输入 `Nature Machine Intelligence`，点刊名（不是左侧的 ☆）。这一行仍显示 **5**，活动条件确认选中了该刊，而结果为 **共 0 篇**。没有设置全局关键词。

同一问题还有三个实测表现：

- **期刊档也会出现空结果。**默认状态下「顶刊」可选；展开可见 `Nature 2`，点「查看整档」结果为 0。 [桌面截图](https://github.com/dodoxiaxia/xinzhi/pull/206#flagship-empty-1280)
- **全局关键词没有反映在期刊数上。**先在页头搜索填入 `radarnoresults20261119xyz`（结果 0），再打开 AI 刊名搜索 `Nature Machine Intelligence`，仍显示 5。 [桌面截图](https://github.com/dodoxiaxia/xinzhi/pull/206#search-count-mismatch-1280)
- **加载存档后，用同样的 14 天条件会看到完全不同的期刊数。**新会话默认 14 天，打开 AI 清单搜索 `npj Digital Medicine`，显示 29；关掉清单，切到 30 天，等总数更新，再用活动条件「近 30 天 ×」恢复 14 天，重开同刊清单，显示 **1020**。两次 14 天的结果总数均为 1184，两种宽度均复现。 [390：切换前 29](https://github.com/dodoxiaxia/xinzhi/pull/206#journal-before-archive-390) / [390：恢复默认后 1020](https://github.com/dodoxiaxia/xinzhi/pull/206#journal-after-archive-390)

**建议改法：**期刊行的数字应按当前领域、日期、关键词及其他非期刊条件下可进入结果列表的题录计算；该档可打开查看哪些期刊当前为 0。计算替换/追加刊名的候选数时不受当前期刊选择本身限制；切回 14 天后不能继续用存档全量计数。0 篇保持现有灰显外观。

| 桌面 1280：选中后，刊名显示 5，结果显示 0 | 手机 390：同样是 5 → 0 |
| --- | --- |
| [桌面期刊计数不一致](https://github.com/dodoxiaxia/xinzhi/pull/206#count-mismatch-1280) | [手机期刊计数不一致](https://github.com/dodoxiaxia/xinzhi/pull/206#count-mismatch-390) |

### Bug 2 · 筛选弹层遮住结果 — 高

**复现：**默认雷达里点 AI 右侧箭头。1280 下，计数还可见，但 420 px 宽的浮层盖住列表中部和多行标题/摘要，选刊后仍覆盖同一区域。390 下先横滑至 AI；底部弹层从视口约 y=169 开始，结果计数约在 y=174，计数和首屏结果都被盖住。若找的是一条刊名，弹层变矮才重新露出计数。

**建议改法：**雷达筛选面板进入正常布局，把结果向下推而不是覆盖；限制面板高度并让内容可内部滚动，不加遮罩。打开或选择后仍能看到结果计数和首批结果，外层页面仍可滚动。

| 桌面 1280：遮住结果内容 | 手机 390：遮住结果及总数 |
| --- | --- |
| [桌面弹层遮住结果](https://github.com/dodoxiaxia/xinzhi/pull/206#popover-over-results-1280) | [手机弹层遮住结果和总数](https://github.com/dodoxiaxia/xinzhi/pull/206#popover-over-results-390) |

## 给站主的建议（本票不实现）

| 严重度与问题 | 复现与实测 | 建议改法 | 截图 |
| --- | --- | --- | --- |
| 中 · 档位文字和箭头热区重叠 | 在默认雷达中点「综合」文字最右侧，仍在「合」字范围内，但打开了期刊清单，没有选中整档。1280 鼠标和 390 触屏均复现。点文字中部才会正常选中整档。 | 给文字与箭头各自独立、不重叠的点击区域；必要时给分段芯片增加宽度。 | [390：点文字边缘却打开清单](https://github.com/dodoxiaxia/xinzhi/pull/206#split-hit-target-390) |
| 中 · 重新打开清单时搜索和整档入口不可见 | 打开 AI 清单，向下滚到后半段，按 × 关闭，再点 AI 箭头。两种宽度都保留了此前的滚动位置，顶部只剩标题，须向上滚才能看到「搜索刊名」和「查看整档」。 | 关闭后重新打开时回到列表顶部，或固定搜索及整档入口；同次操作中更新选择可保留当前位置。 | [1280](https://github.com/dodoxiaxia/xinzhi/pull/206#reopen-search-hidden-1280) · [390](https://github.com/dodoxiaxia/xinzhi/pull/206#reopen-search-hidden-390) |
| 中 · 「更多筛选」出版方数字超出当前结果范围 | 新会话默认 14 天，展开「⋯」→ 出版方，`AHA (Circulation)` 显示 230。切到 30 天加载存档，再清除该日期条件回到 14 天，此行显示 **3683**，列表总数仍只有 1184；点该出版方实际显示 **152**。两种宽度均复现。 | 单独核对出版方分面；若数字为当前可选结果数，应使用当前有效日期、领域、关键词及其他条件；若特意展示存档总数，应明确标注。 | [1280：显示 3683](https://github.com/dodoxiaxia/xinzhi/pull/206#publisher-before-select-1280) · [1280：选择后 152](https://github.com/dodoxiaxia/xinzhi/pull/206#publisher-after-select-1280) |
| 低 · 灰色 0 篇行仍可选 | AI 清单中点灰色 `JMIR 0` 的刊名（不点 ☆）；活动条件增加 `AI：JMIR`。两种宽度均复现。若此前已选 `Nature Machine Intelligence`，AI 从 1 项变为 2 项，结果仍为 0。 | 保留本票要求的灰显。如站主不希望选入空条件，另行决定是否仅禁用 0 篇的刊名按钮、同时保留独立关注按钮，以及如何移除已选但因其他条件变为 0 篇的刊名。 | [1280：灰色行已变为选中](https://github.com/dodoxiaxia/xinzhi/pull/206#zero-selectable-1280) |
| 低 · 「建议」标签被拆成两行 | 打开 AI 清单，搜索 `BMC Medical Informatics and Decision Making`，「建」「议」各占一行。1280 和 390 都可见。 | 只让刊名换行，为「建议」及右侧数字各留固定的最小空间；标签本身不换行。 | [390：两字拆行](https://github.com/dodoxiaxia/xinzhi/pull/206#suggestion-label-390) |
| 低 · 空状态引用不可见的「左侧」 | 选 `Nature Machine Intelligence` 后关闭弹层，空状态显示「清空左侧筛选」，雷达只有顶部筛选条。该按钮本身可清除选刊并恢复结果。 | 改为「清除筛选」，与现有「重置所有条件」区分；不要依赖布局方向描述操作。 | [390：空状态文案](https://github.com/dodoxiaxia/xinzhi/pull/206#empty-left-sidebar-copy-390) |
| 低 · 活动行「清除」未说明保留关键词 | 全局搜索 `heart failure`，选 AI 并切到 30 天，再点活动行「清除」：期刊、日期恢复默认，但关键词仍在，结果由 7 变为 154，而不是无关键词的 1184。这是可重复的作用范围，不是清除失效。 | 若保留该行为，把操作写成「清除筛选」并说明保留关键词，和搜索框里的「清除搜索」区分。 | [1280：清除前](https://github.com/dodoxiaxia/xinzhi/pull/206#combined-search-before-clear-1280) · [1280：清除后](https://github.com/dodoxiaxia/xinzhi/pull/206#combined-search-after-clear-1280) |

## 其他实测覆盖

- **领域、时间和搜索：**打开范围面板检查领域/时间选项；测试「心血管」、7 天、14 天、30 天，以及 `heart failure` 与 90/365 天的组合。`heart failure` 单独 154 篇，叠加 AI 期刊档为 5 篇，再叠加 30 天为 7 篇；单独清除日期回到 5 篇，保留期刊与关键词。另用搜索框 × 清除关键词，恢复默认结果。
- **七种期刊档：**逐项测试「综合、临床、转化、综述、顶刊、AI、其他」的文字芯片、展开箭头、刊名匹配/不匹配/清空搜索和「查看整档」。文字芯片与「查看整档」选中同一档、返回一致的结果总数；「顶刊」为上述 0 篇异常。390 下用触摸横滑确认能露出右侧芯片，滚动中即已看到变化（[手指未松开时的截图](https://github.com/dodoxiaxia/xinzhi/pull/206#mobile-swipe-held-390)）。
- **文章主题：**两种宽度下，选「房颤/电生理」为 197 篇，加入「心衰/心肌」后为 391 篇；改选「未分类」后只保留该条件并显示 242 篇；选「全部」后清空主题。
- **⋯ 与活动条件：**试了出版方、专科来源分组、RCT、不看病例、有公开摘要、含更正/来信；结果及活动行随选择变化。测试了单个条件 × 和活动行「清除」。未穷举面板每个选项。
- **☆、☆保存：**顶栏 ☆ 是「只看关注期刊」的筛选开关，不是关注动作。两种宽度下在新的匿名会话开启后，活动行出现该条件，结果为 0 并提示「还没有关注期刊」；再次点击关闭后恢复 1184 篇，活动行消失。期刊行 ☆ 与刊名为两个独立控件；活动行 ☆保存 与更多菜单说明预设仅保存到当前浏览器、不自动套用。按只读要求没有点击期刊行 ☆ 或执行保存，因此没有验证关注/预设状态变化。
