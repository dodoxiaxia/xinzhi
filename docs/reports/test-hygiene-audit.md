# Ticket H：测试卫生审计

基线：`a7a6383`。下表未另注明的行号指该未修改的 main；只改测试和本报告。浏览器使用离线公共包、拦截 API，不连生产。#211、#208 和 #213 合入后复查了同一批选择器：产品源码仍只有被排除的 `index.html:246` 标签；没有新增这四个旧标记或旧翻译动作。

## 产出证据

在基线上运行（无命中表示 `rg` 退出 1）：

| 编号 | 命令 | 结果 |
| --- | --- | --- |
| E1 | `rg -n 'content-label\|ql-flag\|ft-badge-none\|translation-note' src/app index.html style.css` | HTML 仅有 `index.html:226` 的 `#deepReaderLabel`；CSS 有 `style.css:537,1616`，不是 DOM 生产者。 |
| E2 | `rg -n "ft-badge-\|未申请" src/app/04-filters.js` | 62、78、189 有 `未申请`（视图数据和筛选项）；134、142 动态拼类前明确排除 `view.kind === 'none'`，不是仅靠查不到完整字符串。 |
| E3 | `rg -n '未经人工核对\|未经医生终审\|未经人工审核\|未经人工医学终审\|以英文原文为准\|机器翻译[， ·]\|AI 速览 ·\|AI 全文精读 ·\|AI 综述前' src/app index.html` | 只有 `03-ai.js:177,363`：综述控件文字，以及复制研究结构的文本。其余词无匹配。 |
| E4 | `rg -n 'ai-translate\|ai-study\|ai-interpret\|data-abs-tab="zh"\|正在检查已有结果\|drawer-section-title[^<]*>AI 速览' src/app index.html` | `03-ai.js:294–302` 研究结构等待与生成；`06-reader.js:139,204` 速览生成与译文切换；`10-browse-events.js` 有现存按钮的事件处理。旧翻译按钮和旧速览小节标题无匹配。 |
| E5 | `rg -n '生成时间\|本次生成\|引文未能\|点击后由模型读取公开摘要\|ai-compare' src/app/03-ai.js` | 269 有生成/缓存/只取摘要三态；302 有摘要生成按钮及提示；337、342 有证据对照生成按钮；377 的时间只在复制文本中；408 有引文校验错误。 |
| E6 | `rg -n 'trBoxHtml\|abstractTranslationStatus\|validTranslation\|LIVE_TR\|trKeyOf' src/app` | 前两项无匹配；后三项仍由 `03-ai.js` 定义，并用于 `06-reader.js:191–192` 的缓存译文。 |
| E7 | `rg -n 'count\(\)\s*==\s*0\|not in (text\|page)\|assert\(!.*includes\|!.*includes' scripts/test_*.py scripts/test_*.cjs` | 定位候选；不能仅凭否定形式认定空转。具体复核如下。 |

## VM 桩

从两个测试的 `vm.createContext` 对象取得顶层键，按同一上下文收集 `vm.runInContext` 最终提交的原始函数和补充代码。用临时目录中的 Acorn 解析，再用 eslint-scope 的 `globalScope.through` 枚举自由变量，扣除 VM 内建全局；对象属性、注释或文字里的同名不算引用。一次性审计命令：`node .local/hygiene-free-globals.cjs .local/hygiene-baseline`（工具及依赖均未加入仓库）。下面是输出的完整桩清单和处置：

| 文件:行 / 上下文 | 使用状态 | 名称 | 处置 / 核验 |
| --- | --- | --- | --- |
| `test_terms_consistency.cjs:31` listCtx | 使用 | state, getPublisherClass, dateLabel, esc, quicklookOf, publicationStatusHtml, pdfDownloadLink, doiStatusBlock, safeSourceUrl, exactDoi, designBadgeHtml | 保留 |
| 同上 | 未使用 | journalMetricBadge | 删除 |
| `test_terms_consistency.cjs:56` modeCtx | 无桩 | — | 保留 |
| `test_terms_consistency.cjs:88` huddleCtx | 使用 | DEFERRED, partsSettled, $, document, state, huddlePapers, huddlePaper, RADAR_LOAD, selectedComparePapers, pushOverlay, compareCheck, window, buildCitations, copyToClipboard, beijingToday, esc, quicklookOf, journalMetricBadge, publicationStatusHtml, studyKey, compareBoxHtml, briefHtml, AI_AVAIL | 保留 |
| 同上 | 引用但未提供 | PART_STATE, loadRadarArchive | 补齐；状态模拟非拆分页，意外走存档加载显式失败 |
| `test_terms_consistency.cjs:140` readerCtx | 使用 | DEFERRED, partsPending, partsReady, $, document, state, hydratePreGenerated, getPublisherClass, getDesignClass, dateLabel, safeSourceUrl, exactDoi, journalMetricBadge, designBadgeHtml, esc, quicklookOf, forgetPaper, prioritizedDesign, validTranslation, LIVE_TR, trKeyOf, publicationStatusHtml, fulltextStatusHtml, studyBoxHtml, pdfDownloadUrl, resetDlForm, pushOverlay, aiApiCheck, trCheck, studyCheck, aiWaitingMessage | 保留；E6 |
| 同上 | 未使用 | preGeneratedOf, trBoxHtml, buildCitations, journalMetricDetails, abstractTranslationStatus, fulltextView, MAINTAINER | 删除；E6 |
| 同上 | 引用但未提供 | PART_STATE, fetchPublicAbstract, openBodyOnly, prioritizeParts, pumpPartQueue | 补齐；不加载题录或发网络请求 |
| `test_official_article_url.cjs:34` c | 使用 | URL, encodeURIComponent, decodeURIComponent, esc, state, LIVE_TR, document, $, getPublisherClass, getDesignClass, dateLabel, quicklookOf, publicationStatusHtml, doiStatusBlock, journalMetricBadge, cardJournalName, designBadgeHtml, DEFERRED, PART_STATE, partsReady, partsPending, cardTakeaway, authorAffilHtml, abstractMayBeIncomplete, forgetPaper, prioritizedDesign, huddleStarSvg, fetchPublicAbstract, openBodyOnly, lastFocus, validTranslation, trKeyOf, fulltextStatusHtml, pdfDownloadUrl, resetDlForm, pushOverlay, hydratePreGenerated, aiApiCheck, trCheck, studyCheck, studyBoxHtml, renderDrawerRegions | 保留 |
| 同上 | 未使用 | MAINTAINER, preGeneratedOf, pdfDownloadLink, journalMetricDetails, abstractTranslationStatus, trBoxHtml, buildCitations, fulltextView, hamburgFulltextUrl | 删除；E6 |
| 同上 | 引用但未提供 | aiWaitingMessage, prioritizeParts, pumpPartQueue | 补齐 |
| #211 后的 `listCtx` 和 `c` | 新增引用 | topicBadgeHtml | 补齐：卡片与列表有新主题标签；这两个测试不检验主题标签。 |
| #208 后的 `readerCtx` 和 `c` | 新增引用 | refreshReadingContent | 补齐：只有正式阅读模式才应调用；两个普通阅读面板夹具若走入此分支即失败。 |

验证：两套 Node 测试保持原来的加载函数及断言；`test_harness_hygiene.py` 检查桩名是否在其上下文加载的函数中使用，并用临时副本检查拒绝新增死桩。

## 否定断言

| 基线文件:行 | 断言 | 能否产出及证据 | 处置 / 覆盖 |
| --- | --- | --- | --- |
| `test_list_actions_ui.py:51–52,116–117` | 无 `.content-label:not(#deepReaderLabel)`、`.ql-flag`、`.translation-note` | 否；E1。允许的精读标签恰被排除。 | 保留原覆盖；各宽度用实际 CSS locator 注入、检出、清除。 |
| 同上 | 无 `.ft-badge-none` | 当前否；E1、E2。删除 kind 条件即可复现。 | 同上；仍覆盖卡片、列表、精读栏和阅读器。 |
| `test_list_actions_ui.py:49–50,113–115` | 十条禁用短语均不在检查区 | E3：无对应标签生产者；两个字符串可在不同用途的代码里产出。 | 保留每条原有断言；每个宽度用同一个文本探测器检出注入的每条短语，并确认清除。 |
| `test_list_actions_ui.py:53,119` | 综述入口隐藏；阅读器无旧速览标题 | `rg -n 'aiDigest' index.html style.css src/app`：入口在 `index.html:122`，CSS 强制隐藏；旧标题无生产者（E4）。 | 每个宽度暂时解除真实入口的隐藏，验证同一可见性检测后恢复属性；给旧标题探测器注入正控。 |
| `test_weekly_ui.py:180` | 已缓存阅读器不出现加载文字 | 是；读者等待状态会渲染 `正在`，E4。 | 保留；离线等候状态也用同一探测器检出。 |
| `test_weekly_ui.py:191–192` | 缺结果无分析面板、缺译文无中文切换 | 是；E4，之前已缓存的同一篇可产出。 | 保留；同一次运行显式检查已缓存的两个面板和中文切换。 |
| `test_weekly_ui.py:194` | 缺结果不出现三个生成动作 | E4：`ai-translate` 无生产者；另两个在可生成、含公开摘要的非榜单题录可产出，但在榜单缺结果分支不产出。 | 保留无三个动作；旧动作注入正控，另外两个由真实渲染正控，不触发按钮。 |
| `test_weekly_ui.py:101,185,193,202` | URL 去掉 read、重开及缺结果不多请求、不 POST | 是：同一流程打开阅读会产生 read；非榜单会发 GET；支付按钮有独立 POST 路径（不点击）。 | 保留。打开状态、GET 对照与独立离线 waiting suite 提供对应证据。 |

### 他人拥有的文件（只读）

| 基线文件:行 | 断言 | 能否产出及证据 | 决定 |
| --- | --- | --- | --- |
| `test_doi_library_ui.cjs:73,103` | none 不输出 `未申请` / `ft-badge-none` | E2：视图中有这段文字，渲染器排除 none 标签；其它状态的动态标签在同一循环为真，但没有正控证明可检出完整 none 字符串。 | 保留；建议单独 PR 补精确标记的正控，不动发布门禁。 |
| `test_doi_library_ui.cjs:74,78,81,132–133,396` | 无旧申请链接、按钮及标签 | `rg -n '查看处理状态\|再次获取全文\|刷新状态\|查看任务\|/api/acquire\?doi=' src/app index.html` 无对应旧渲染片段；`未申请` 见 E2。 | 旧入口为退役形态；保留、列为独立后续。 |
| `test_doi_library_ui.cjs:77,108,112,119,123,141–147,315,398` | 状态/输入不产生错误链接、提示或不匹配题录 | 对应分支可产生链接、核验文字或提示；不应出现在选定状态。比如 142 同行验证维护者能看到原因，315 与身份待核对状态对照。 | 保留；不按无生产者处理。 |
| `test_study_ui.cjs:89–90,168` | 缓存不显示机器时间、付费按钮 | E5：时间没有阅读区生产者；两个付费按钮有生产者，disabled/cached 分支不产出。 | 时间是空转候选；动作有状态对照（下行和 waiting suite）。保留发布门禁。 |
| `test_study_ui.cjs:136–139,149,159,163,171–173` | 非法 HTML/链接、原始错误或其他状态文字不泄漏 | 恶意内容已放入输入；E5 验证其它状态会产生相应文案。 | 保留；不是无输入的否定。 |
| `test_ai_waiting_ui.cjs:50–52` | 无摘要时无生成动作及说明 | 是；E4/E5、同文件 52 有可生成且有摘要的正例，50 无摘要和 51 正在获取摘要是反例。 | 保留；不编辑。 |
| `test_machine_content_labels.cjs:42`、`test_weekly_window.cjs:69`、`test_terms_consistency.cjs:59,199,221` | 拒绝旧标签、旧双语提示或旧摘要按钮文案 | E3；另查 `rg -n '阅读摘要 · 中英对照\|阅读摘要\|机器标注' src/app index.html`，无对应生产者。 | 既有约束不动；列表/阅读器里的同类短语由新正控覆盖。 |

## 搜索与精选清单

未改的基线在 `clear/1440: disabled button cannot take focus clearHuddleBtn` 处实际失败。二次点清空触发 `10-browse-events.js:807–824`，同步调用 `openHuddleModal`，在 `07-shortlist.js:65–70` 禁用当前有焦点的按钮；测试只等到 disabled 就调用 `focus()`。禁用按钮不能获得新焦点，但 Chromium 可以暂时仍把它当作旧焦点；同一次读取因而误报。让测试先观察旧焦点离开，再即时断言 disabled 按钮确实不能取得焦点，保留键盘正反向遍历断言。

最小确定性复现：同一个浏览器任务中对普通按钮依次执行 `e.focus(); e.disabled = true; e.focus();`。禁用后及第二次调用后读 `document.activeElement === e` 均为真；等焦点清除后再主动调用 `focus()`，该比较为假。无需应用、API 或计时器，不是已证实的产品竞态。

另有独立的计数前置条件：`index.html:120` 首屏占位本来就是 `共 0 篇`；`00z-deferred-parts.js:13–21,279–318` 在合并各分片后才置 `XINZHI_DATA_READY`，并同步重绘。导航 load 或 networkidle 不是这个状态。等待显式数据状态及可见/匹配的计数文字，原有相等、严格范围和零结果预期不变。

## 如何写不会空转的否定断言

在同一次运行中，先验证已挂载的探测器真的能看到反例。
优先走真实状态（例如可生成的离线公开摘要）；无生产者时才注入最小节点。
```python
detector_sees(page, '#articlesStream', '.ql-flag')  # 添加 → 精确匹配 1 → 移除 → 0
assert page.locator('#articlesStream .ql-flag').count() == 0
```
控件必须属于实际检查的作用域；移除探针后照常运行真实页面的断言。
