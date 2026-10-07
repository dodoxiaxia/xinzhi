# 首屏公共数据按需加载候选

候选把首页与周榜的首次数据解析从完整全年包中分离。完整 12,635 条雷达、911 条当前订阅、1,264 篇文献库、24 篇周榜以及全部已有摘要、译文、快读仍预先构建；没有删除文献、收窄历史日期或新增模型调用。仅首页不再下载和执行完整 `public.js`。完整发布包没有变小，兼容脚本还增加了约 130 KB 的近期雷达副本。

固定对照代码为 main `da5852595d5bff1a1e4a1311f0536651fd811059`，固定数据为 state `ffcd8fa4356656458509484fe7e83bb4f46a54fb`。候选分支 `perf/lazy-public-data-20261007` 已合并该 main，搜索、手机导航、AI 快读反馈、DOI 直接下载改动原样保留。最初实现基于 `a3f31ec`，最终测量与下列回归均已改用上述最新固定基线。未更新 main/state、发布版本或执行部署；发布由任务 `01a11479` 统一负责。

## 数据与回退

- 六个发布文件仍为 `index.html`、`public.js`、`style.css`、`icon.svg`、`_headers`、`_worker.js`。index 内嵌首屏所需数据和应用脚本，完整经典 public.js 保留原有全局变量，兼容旧缓存 HTML。
- 首屏包含精选、周榜、全部已准备的公共译文/快读、健康与期刊元数据、完整文献库、选中的 39 条订阅。文献库暂未拆分，因为现有 DOI/PDF 身份校验依赖完整静态身份集合。这是第一阶段，不能声称彻底消除了所有大数据初始化。
- 默认 14 天雷达按需加载完整 FEEDS 与 66 条近期归档；30/90/365/全部范围、搜索和历史阅读室再加载完整年度 RADAR。仅从 FEEDS 构建近期页会漏掉已有归档行，故保留单独近期副本。所有文献内容仍在发布前准备好。
- 现有 Worker 用已有 ASSETS 流读取经典包中的白名单 JSON 段。虚拟地址是 `/public-data/<语义内容版本>/<FEEDS|RECENT_RADAR|RADAR>.json`，没有新增存储、绑定、外部服务或权限。只接受 GET/HEAD，不读取 KV、私有 PDF、模型或凭据，不转发 Cookie/Authorization/Range。
- 浏览器使用 JSON.parse，不执行下载的数据。每段至多一个请求；已加载数据可在当前页面离线切换。未实现离线刷新或新 Service Worker。
- 超时、503、损坏 JSON 或形状错误提示手动重试，可返回首页、周榜、文献库。版本不符要求刷新；失败不会自动拉取 9 MB。仅没有 Worker 的普通本地服务器返回 404 时，用一次完整 public.js 请求作经典回退，并验证版本，不使用 eval。
- 语义版本和发布指纹沿用现有时间戳归一化；摘要、日期、脚本及内容变化仍影响指纹。新构建输入已纳入发布完整性校验。完整 state 缓存、预计算、私有路径与六文件包守卫全部保留。

Cloudflare Pages 官方说明其静态文件 Range 请求目前返回 200 而非 206，因此没有采用浏览器字节范围请求：[Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)。虚拟数据路由使用现有 [ASSETS binding](https://developers.cloudflare.com/workers/static-assets/)。数据响应保守使用 no-store，页面内存去重；未改变 CDN 或站点权限设置。

## 回归与测量边界

- 537 项 Python 检查通过，覆盖发布包、构建指纹、完整缓存缺失拒绝、私有字段守卫与新 bootstrap。
- Worker 206 项边界检查通过：1 字节至 64 KiB 分块、Unicode、三种公开数据段、允许名单、版本、截断、取消、HEAD 与敏感头隔离。
- 实际构建六文件浏览器回归 885 项通过：16 组桌面/手机与经典包对照，分享参数/hash、搜索/DOI 抽屉、周榜已有译文、快速来回切换、请求去重、14 天不加载全年、365 天完整、已加载数据离线切换、五类故障、人工重试、本地 404 回退、历史阅读室 ID、运行时题录与静态 DOI 身份重新核对。
- 现有 Node 发布检查通过，包括 DOI 直接下载、全文队列、研究服务、快读反馈、周榜、源健康、期刊、引用导出。发表日期 UI 检查的源码定位适配为可重入 expandRadar 函数后，原有日期断言通过。
- 所有浏览器网络均由离线公开数据夹具拦截，读 API 为空或明确的合成题录；没有调用模型、线上获取私有 PDF 或绕过出口 403。冷启动为 Chromium 的新上下文、4 倍 CPU 节流、每组 5 次交替样本。模拟弱网为各完整资源延迟 150ms 加 gzip 大小/1MiBps，属于合成下载模型，不是线上带宽整形或 CDN 实测。
- 内嵌 bootstrap 增大 HTML，模拟弱网下空壳的 FCP 会退步，不能把 DOM 就绪或文章可见的加速称为所有首屏指标都加速。文章可见时间用实际文章链接进入 DOM 后两个动画帧的 performance mark 近似，不等于 LCP。数据与解析收益应和这个明确代价一并评审。
- 虚拟段在 Worker 内仍须读取经典静态资产的前缀；这是将年度读取和解析移出首页，而非消除所有服务器读取。Node 流夹具的 CPU 数字不能证明 Cloudflare CPU 配额适用性。统一发布任务仍须在部署预览/真实 Worker 环境检查该路径与配额，不能把离线通过写成线上验收。

详细数字与原始冷启动样本见同目录 `lazy-public-data-measurements-20261008.json`；本地完整日志与包在 `/workspace/xinzhi-lazy-evidence/`。

## 固定基线测量结果

| 指标 | 经典基线 | 候选 |
|---|---:|---:|
| 首页 HTML + 数据脚本原始字节 | 9,183,714 | 2,235,555（减少 75.7%） |
| 同组 gzip 字节（Python gzip level 9） | 2,514,611 | 421,379（减少 83.2%） |
| 完整六文件原始字节 | 10,345,398 | 12,686,597（增加 22.6%） |
| 本地文章可见中位数 | 1,570 ms | 1,177 ms |
| 本地 ScriptDuration 中位数 | 661 ms | 247 ms |
| 模拟弱网文章可见中位数 | 4,175 ms | 1,710 ms |
| 模拟弱网 ScriptDuration 中位数 | 658 ms | 234 ms |
| 模拟弱网空壳 FCP 中位数 | 688 ms | 1,088 ms（退步） |

文章内容、计数与列表在两组之间逐次断言一致。ScriptDuration 是执行时间，不能当作单独的 JSON.parse 耗时；TaskDuration 和 JSHeap 也见原始样本。完整包增长来自新 HTML 保留首屏副本及兼容脚本的近期副本，这是保留六文件与旧缓存兼容的成本。

## 集成与回滚

按分支提交应用候选，不要复制整个 app.js 覆盖其他任务。主要合并点只有 app 的归档扩展、静态身份表、renderStream/renderSidebarFilters 的数据就绪门、计数元数据、历史阅读室和初始抽屉；新模块独立于搜索输入与手机导航事件。其他改动是构建、指纹与现有 Worker 的公开数据路由。

部署前在固定完整 state 上重建并运行 `python3 scripts/build_public.py`、`node scripts/test_public_data_worker.cjs` 和常规发布检查。浏览器回归：`XINZHI_BASELINE_PUBLIC=/path/to/classic/public XINZHI_DATA_QA_OUTPUT=/path/to/evidence node scripts/test_public_data_browser.cjs`；量化：相同环境变量运行 `node scripts/benchmark_public_data.cjs`。经典基线必须从上述未修改 main 和同一 state 独立构建，不可把部署期间不同内容比较为性能收益。

回滚候选提交后用同一完整 state 重建六文件，指纹守卫会恢复经典 HTML/public.js。若统一任务把候选拆为多个提交，应整体撤销这组构建、加载器、Worker 路由和 app 就绪门；禁止只移除 Worker 后留下新 HTML。已有经典回退兼容旧 HTML，所有数据仍在。

推送前已检查两个 workflow：daily 与 fulltext 的 push 均仅 main，job 也限定 main；普通候选分支不会触发生产部署。没有新增定时、账号、凭据、授权或服务。
