# 生产只读冒烟验收（v2）

部署后从仓库根目录运行：

```sh
python3 scripts/smoke_live.py --browser
python3 scripts/smoke_live.py --no-browser --only 213,215,assets,budget,secrets --json .local/live-smoke.json
```

默认站点是 `https://learn.dryz.info`；`--base-url` 可指向其他 HTTP(S) 源（例如 loopback 夹具）。浏览器默认开启，使用已有 Python Playwright 与 Chromium（可用 `CHROMIUM_PATH`）；缺失时仅浏览器行标为 `SKIP no browser`。静态请求用 Python 标准库；未安装 Brotli 时，仍执行 gzip 门槛，gzip 通过后将完整体积验收标为 SKIP。通常用时约半分钟至两分钟，取决于网络、压缩和页面就绪时间；`--timeout` 是单次 HTTP I/O 或浏览器操作的秒数。页面导航单独给 20 秒，超时时只重试一次，第二次给 40 秒，并在验收证据里记录两次结果。

合并 PR N 并部署后，运行 `python3 scripts/smoke_live.py --only N` 定向复核。

`--only` 接受逗号分隔的 PR 号或下表全局项的名称；`--json -` 仅输出 JSON，文件输出只允许在仓库的 `.local/` 下独占创建。表中 FAIL 带预期和实际，SKIP 带原因。WAIT 表示检查需要合并或部署后的数据，但当前时间戳还没达到要求。证据列出数据时间、要求时间和数据年龄。未达要求的数据超过 36 小时则为 FAIL（`daily refresh stalled`）。有任一 FAIL 退出 1，其余结果（含 WAIT 和 SKIP）退出 0，用法或输出路径错误退出 2。

| PR | 可见验收点 |
| --- | --- |
| #203 | SKIP：DataCite 回退不在公开 GET 路径；`GET /api/library` 仅读既有题录。补录、全文获取和机器登记会写入或入队，不调用这些接口，也不用直接查询 DataCite 代替生产回退。 |
| #204 | SKIP，公开 GET 无法观察离线题录审核决定。 |
| #205 | 390×844 与 1280×800 打开四栏目，检查就绪、页面横向宽度、控制台错误和未捕获 JS 错误。 |
| #206 | 雷达 AI 期刊清单取一条 1–50 篇的期刊，点击后比较预览与列表总数。若确无候选，说明原因并跳过。 |
| #207 | SKIP，身份保留审核需要维护者鉴权。 |
| #208 | 从公开首屏题录取三个不同 ID 检查阅读模式；不存在的 ID 只提示一次并从 URL 移除。 |
| #209 | 检查申请记录的浏览器存储提示、刷新控件和 DOI 未命中表单；不输入口令、不点击提交或刷新、不模拟任务状态。 |
| #210 | 检查卡片、阅读面板和阅读模式不含 `ai-translate` 或 `tr-check`。不检查缓存译文本身。 |
| #211 | 点击两个能改变篇数的真实雷达主题，比较预览、OR/AND 总数和 URL；检查单选继续用 `tag`，清空恢复零主题状态。没有合适交集样本时 SKIP，仅限选样不足。 |
| #212 | 手机紧凑榜单取实际渲染的最长题名，精读从公开目录取最长显示题名、必要时展开往期；检查两个页面面板和可见题名行的横向边界。 |
| #213 | 检查北京时间最近七天每批最多 12 篇、ID/非空 DOI 不重复、必需字段齐全；检查整个公开目录的字段边界。少于 12 篇（含 0）不报错，期刊仅供参考。 |
| #214 | 检查打开的 AI 期刊列表中所有 0 篇项：名称禁用、关注控件可用；把已选期刊筛到 0 篇后仍可取消。 |
| #215 | 检查公开 FEEDS 和雷达近期与 365 天档案中的声明题名；仅豁免仓库人工覆盖能证明的标签。公开包至少来自合并后，源数据时间不早于 [#215 的首次线上部署](https://github.com/dodoxiaxia/xinzhi/actions/runs/44522181526)。 |
| #216 | 1280×800 检查四栏目首屏分页实际呈现的标题和摘要短句，及浏览器加载的文献库静态分片中的字符串。拒绝替换字符、C0/C1 控制字符和字面 `\u`、`\n`。 |
| #217 | SKIP，离线测试卫生无公开 GET 验收面。 |
| #218 | SKIP，冒烟脚本本身由离线夹具验证。 |
| #219 | 在文献库输入「房颤消融」和「AF」，验证扩展提示和正数结果。输入无映射的英文 `ablation`，验证无扩展提示。 |
| #220 | 用页面中的两个真实 ID 构造分享链接，检查横幅、条目和精选清单的浏览器存储。保留合并按钮原状。 |
| #221 | SKIP，机器上传的 PDF 题名匹配无公开 GET 验收面。 |
| #222 | 对两个猜测的私有 PDF 暂存目录发 HEAD 并要求 404。扫描本次选择的检查所读取的响应头，拒绝 `application/pdf`。 |
| #223 | 随机不存在路径返回有首页链接的中文 404。检查 robots 禁止 `/api/`、绝对 Sitemap、XML 命名空间和仅首页的 URL，以及首页五个分享标签。 |
| #224 | SKIP，发布前精读草稿异常拒绝无公开 GET 验收面。 |
| assets | 首页 HTTP 200；入口资产、静态清单、雷达档案和精读目录中的哈希文件均存在，且不可变缓存头正确。精读月度分片只发 HEAD。 |
| budget | 复用发布脚本的 gzip(9)/Brotli(11) 首屏数据与关键路径预算。 |
| secrets | 扫描本次获取的响应正文（含延迟清单和雷达档案）里的仓库守卫凭据模式；不输出匹配值。不下载未打开的精读正文章节扫描。 |

**#205 的 20 项覆盖范围。** 只覆盖 `test_layout_ui` 的页面加载/横向溢出和 `test_mobile_library_ui` 的手机文献库横向溢出，不覆盖这两项的筛选、焦点、点击面积、URL/返回和译文分支。完全未覆盖：`feature-map-walk`、`test_back_to_top_ui`、`test_brief_feedback_ui`、`test_faceted_filters_ui`、`test_filter_panel_toggle_ui`、`test_journal_ui`、`test_list_actions_ui`、`test_mode_toolrow_ui`、`test_navigation_search_ui`、`test_popstate_restore_ui`、`test_range_bar_ui`、`test_reader_drawer_scroll`、`test_search_shortlist_ui`、`test_sidebar_focus_trap_ui`、`test_sol_gap_reader`、`test_topics_requests_ui`、`test_weekly_layout_ui`、`test_weekly_ui`。#205 另提及的 `test_reader_overlays_ui` 也未重跑。

**只读边界。** 所有网络请求由同一个只读客户端发送：只允许本源公开静态路径及审查过的题录/状态 GET，只允许 GET/HEAD，整次最多 60 个上游请求，相同请求复用响应。浏览器请求最多跟随两跳，每一跳都必须是同源且目标在允许列表中，浏览器收到最终响应。静态检查直接检查状态码。不加缓存破坏参数，不读写浏览器现有会话；Chromium 路由拦截其他方法，禁用 Service Worker、WebSocket 和直接外网连接。没有生产下载、提交、队列、模型生成或 KV/D1 写操作；表格和 JSON 输出列出跟随跳数、拦截次数及最多 20 个去重的拦截路径。路径不含查询字符串。例行平台日志不在脚本控制范围内。
