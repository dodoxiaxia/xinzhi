# v14.2.3 独立移动阅读 QA（固定基线）

2026-10-07 14:59–15:08:54 UTC 首轮：真实 Chromium 151.0.7922.173，本地离线完整公开包；视口 320×740、375×812、390×844、1440×900。main `7dbe94c5465e7acca4097ac0282ef8ff78e4a48f`，state `6135056e3d544816ff3554a8e6241f60e3274698`。六文件 SHA256 全部匹配部署 manifest，见 [baseline.json](baseline.json)。[Actions 部署记录](https://github.com/dodoxiaxia/xinzhi/actions/runs/37636485099) 不替代本次公网验收。

新集成 SHA 交回前不重复全轮。本记录只适用于上述固定基线；不把旧版问题标成 v14.2.4 回归。

## 优先处理的三个 P2

| 问题 | 复现步骤 | 实际 / 预期 |
|---|---|---|
| 核心导航裁切 | 新打开首页，宽度 320/375/390，横向导航保持初始位置；a/b/c 风格复查 | a 风格文献库 x=322.59–424.03；320 完全不可见，375/390 部分裁切。导航 scrollWidth=434（c=442）。切到文献库后左侧入口出屏。预期四入口完整可辨、无需猜测横滑。 |
| 抽屉 `/` 逃逸焦点并改背景 | 打开 `?mode=candidates&reading=abstract`，滚动打开卡片，按 `/`，输入“房颤”，Esc | 四视口 `/` 都聚焦背景 globalSearch。390 完整序列中抽屉仍 open、背景 URL 增 q=房颤；关闭后 scrollY 从1021变0，背景首项改变，原卡片焦点丢失。预期模态期间不修改背景，关闭后保留筛选/位置。正常关闭/Esc 路径通过。 |
| 首屏无可识别文献 | 320×740，切雷达/文献库，保持默认筛选和页面顶部；375/390复查 | a 风格首卡顶部：雷达818/797/797，文库797/777/777。320 卡片完全屏外；375/390只露边缘/元信息，题名仍屏外。a/c 每日精选320首题名也在 y817/825。预期首屏露出文献题名或摘要入口。 |

原始坐标、URL 与焦点恢复观测见 [observations.json](observations.json)。没有从 CSS 推断上述问题，没有构造文献或成功译文。

## 附加发现

- 缓存 AI 速览挤占原摘要：390×844，雷达近365天搜索“我、我的医生与AI”，打开 DOI `10.1136/bmjdh-2026-000185`。AI 区 y393.98，公开摘要 y1247.84，原文直达按钮也在摘要区内。AI 未核对标签存在；建议按本轮阅读目标提前原摘要入口或折叠长速览。
- 原生后退未保持同一列表：先首页，再打开上述摘要筛选URL并打开抽屉，执行 browser Back。它返回首页，reading=abstract变空、scrollY1021变0。抽屉没有独立 history entry；不能按“返回保持列表”判通过。

## 覆盖与边界

通过：四视口正常关闭/Esc 精确保留 reading、URL、scrollY 与原 title-open 焦点；抽屉和精选清单 Tab/Shift+Tab 首尾循环；精读展开、#wk4目录定位、收起后summary焦点；回顶部600px显隐、抽屉/精选清单内隐藏、reduced-motion立即滚动并聚焦brandLogo；真实长标题换行、抽屉无横溢；320下 IF/JCR 来源展开可读并保留历史参考与待核对标签。

离线状态通过：公开摘要网络获取失败提示、缓存译文读取失败提示、周榜中文摘要/AI速览待预生成。包内预生成译文为0，成功译文与生产模型/全文未验收。Chromium safe-area inset为0，真实 iOS 非零 inset未验收。仅公网普通 HEAD返回200，没有公网页面/服务验收、登录、权限变更、403绕过或模型/全文点击。POST观测数量0。

## 最小回归脚本

[mobile_reading_browser.py](../../../tests/qa/mobile_reading_browser.py) 使用 Python Playwright + Chromium，对显式传入的六文件完整公开包启动随机本地端口，只允许本地GET/HEAD，阻断所有外部/写请求。检查320/390四入口可见、正常Esc恢复、`/`焦点隔离。失败退出1；v14.2.3预期导航/焦点检查失败。没有部署、构建、模型调用或数据注入。新脚本已做语法/CLI检查，未在旧基线上重跑浏览器；旧版观测已由首轮实际浏览器完成。

```bash
# 在隔离目录恢复指定 state 的公开包，不覆盖工作区数据。
mkdir -p qa-package
git archive 6135056e3d544816ff3554a8e6241f60e3274698 public | tar -x -C qa-package
python3 tests/qa/mobile_reading_browser.py --public-dir qa-package/public --evidence-dir qa-output
```

新 SHA 复测前应先核 main/state 部署关联与六文件 manifest，避免测试旧包。不要用仓库残留 public 或合成 fixture 代替当前完整公开包。

## 分支不会触发生产的依据

本 QA 分支从上述 main 基线创建，只新增 `docs/qa/` 和 `tests/qa/`。核对该基线全部两份工作流：daily.yml 和 fulltext.yml 的 push 都仅匹配 `branches: [main]`，有实际动作的 job 还检查 `github.ref == 'refs/heads/main'`；本分支不匹配。daily.yml 的 push paths 也不包括这两个目录，fulltext.yml 只匹配其workflow与队列runner。未触发 dispatch、未改 workflow、未推 main/state、未发布 PR。

Library 保存尝试在准备前遇到认证401，没有创建 Library 文件；未修改连接/权限。3张典型小图改保存在本私有QA分支：[320顶栏与首屏](xinzhi-v1423-320-nav-first-screen.png)、[抽屉焦点逃逸](xinzhi-v1423-modal-slash-focus.png)、[关闭后列表变化](xinzhi-v1423-after-close-list-changed.png)。本分支不包含49张大图、公开全文/完整摘要payload、机器私有路径或凭据。
