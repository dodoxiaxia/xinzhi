# 静态公共数据分片候选

候选已实现构建期的哈希 JSON 分片，替代上一候选的 Worker 扫描 9 MB classic bundle。现有 ASSETS 直接返回目标文件，Worker 只检查路径/方法/响应类型、添加缓存头并透传 body；没有读取、扫描或解析 public.js，也没有新存储、账号、令牌、权限、调度或模型调用。原私有 PDF/全文/AI API 的实现和鉴权没有改动，唯一 dispatcher 增量是公开数据路径分支。

固定基线 main `0371c21e846f05fdb5ef8e41968a711ac01a5a19`，state `622b0d719496e84ac61af6ac155dcd73861dc0f6`，隔离分支 `perf/static-public-data-20261008`。未改发布版本，未推 main/state，未部署。统一集成/发布仍由任务 `01a11479` 负责。本方案不是 1010 修复，没有访问被拒的 pages.dev 预览，也没有改变域名、UA、网络、防护或申请新授权。

## 显式迁移六文件守卫

六个核心文件继续强制存在：index.html、public.js、style.css、icon.svg、_headers、_worker.js。协议 v2 增加 `public-data-manifest.json` 和其明确声明的 3 个文件；本次共 10 个普通文件。清单示例路径 `public-data/radar.<SHA-256>.json`；只有 feeds/recent_radar/radar 三种角色、单层固定目录与 64 位小写哈希被接受。目录通配符不是发布许可。

公开清单只包含 schema/version、角色、公开相对路径、字节、完整 SHA-256 和语义内容 hash。私有 `docs/public-manifest.json` receipt 必须逐字节覆盖全部 10 文件，并声明 `assetPolicy`。index bootstrap 的版本、deferred 和资产引用必须与清单完全对应。目录外路径、额外/缺失/重复文件、符号链接、私有字段/本地路径、哈希/角色/版本混用或来源指纹变化均拒绝构建/打包。既有完整摘要缓存、预生成内容、文献范围与静态身份守卫保留，经典六文件 receipt 仍被支持。

CI 内容比较覆盖全部资产。精确字节 hash 用于命名、打包和客户端校验；语义 hash 沿用既有时间戳归一化，避免仅更新时间导致新文件名就重复发布。真实题名、日期、摘要、代码变化仍改变内容指纹。构建只清理之前完整验证过、但本轮不再声明的生成文件。

## 加载、缓存与兼容

首页内嵌所需精选、周榜、全部现有预计算内容、源健康/期刊信息、完整文献库与 37 条精选/周榜订阅。14 天雷达按需取 FEEDS 和近期归档，较长范围/搜索/历史阅读室再取完整 RADAR。保留完整文献库是为了沿用 DOI/PDF 静态身份边界，尚未做它的第二阶段投影优化。

客户端在应用每个分片之前检查 Content-Type、长度、SHA-256、schema、版本和角色，下载内容只作 JSON 解析，不执行代码；普通静态 localhost 服务也直接支持同一分片，不需要 Worker 动态切片。成功的哈希 JSON 设 `public, max-age=31536000, immutable`，错误 no-store；请求不携带凭据，ASSETS 转发也不带 Cookie/Authorization。数据缓存保存在当前页内存，支持已经加载栏目断网切换；没有新增持久离线刷新功能。

503/超时/断网显示重试，期间首页/周榜/文献库仍可读；损坏/缺失文件、SPA HTML 错误回退或混版要求刷新，不将新旧数据拼接，也不自动下载 9 MB 作失败回退。旧缓存 HTML 仍可使用完整 classic public.js，其原有全局数据完整保留。旧 v2 HTML 的哈希片在下次部署已不存在时，明确要求刷新，并保留其内嵌内容；没有假装其全年数据已经加载。

预生成覆盖完全取自固定 state：当前订阅 874、雷达归档 12,678、文献库 1,264、周榜 24；本次构建公开 title/translate/quicklook 各 19，study 0。已逐一比较原始全局数据与基线、分片与 classic bundle，全部相等（仅既有刷新时间戳语义归一化）。没有删除文献、收窄日期或以缺省内容替代已准备内容。

兼容成本是完整发布包增加：保留 classic bundle，同时新增静态公开数据副本；完整十文件原始字节约 19.90 MB，经典基线约 10.31 MB。首屏不请求这些全年副本，不能把首屏传输减负说成总发布包缩小。HTML 约 2.23 MB，较大 HTML 会延迟空壳 FCP；文章可见、脚本执行与 FCP 分别报告。

## 本地证据与限制

- 全套 Python 550 项通过；另有纯 ASSETS 透传 63 项检查，明确禁止任何 body 解析/扫描与私有 binding 访问。
- 实际完整资产浏览器回归 1,004 项通过：16 组桌面/手机经典对照、分享 URL/hash、搜索/DOI 抽屉、现有译文、近期/全年完整、快速切换去重、人工重试、8 类故障、纯静态服务器、旧 HTML/current classic、旧 bootstrap/新 envelope、历史阅读室与晚到 API 题录的身份核对。
- 常规 Node 发布验证通过，覆盖原私有 PDF/DOI 下载、全文队列、研究服务、快读反馈、周榜、健康与期刊。全部 fixtures，无模型/真实私有文件请求。
- 已用本机 Wrangler 3 的实际 workerd/Pages dev 运行时检验 3 个目标文件：HTTP body 与构建文件逐字节一致、SHA 与缓存头一致；不存在哈希和非法路径返回 404。四个页面模式通过真实 localhost HTTP 浏览器检查，未配置私有 binding。
- 冷启动用 Chromium、4 倍 CPU 节流、每种条件 5 次交替冷上下文；合成弱网每个完整响应延迟 150ms 加 gzip大小/1MiBps。文章可见指标为 DOM 文章出现后两个动画帧，非 LCP；ScriptDuration 为脚本执行，非单独 JSON.parse 时间。详见同目录 `static-public-data-evidence-20261008.json`。

官方 [Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) 明确提供现有 ASSETS binding；这里复用该接口。Functions 生成的响应不能单凭 _headers 保证自定义头，所以缓存/类型安全头由狭窄公开透传路径明确附加，见 [Headers](https://developers.cloudflare.com/pages/configuration/headers/)。本地运行方式依据 [Pages local development](https://developers.cloudflare.com/pages/functions/local-development/)。上述是本地证据，不是 Cloudflare 生产 CPU、CDN 或完整线上验收。

## 冷启动结果（同一内容、五次中位数）

| 条件/指标 | 基线 | 候选 |
|---|---:|---:|
| 首页 HTML + 数据脚本原始字节 | 9,151,433 | 2,233,284（减少 75.6%） |
| 同组 gzip level 9 字节 | 2,503,505 | 421,749（减少 83.2%） |
| 本地 文章可见 | 1596 ms | 1152 ms |
| 本地 ScriptDuration | 642 ms | 225 ms |
| 本地 空壳 FCP | 564 ms | 528 ms |
| 模拟弱网 文章可见 | 4239 ms | 1703 ms |
| 模拟弱网 ScriptDuration | 678 ms | 223 ms |
| 模拟弱网 空壳 FCP | 648 ms | 1068 ms |

## 合法集成与发布验收

1. 统一任务审阅并应用此分支；旧动态切片候选 `4cdb45f` 不应叠加应用。本候选已包含所需 app 就绪门与独立加载器，基于最新 main，避免覆盖其他 UI 工作。
2. 从固定完整 state 恢复 data/public，先 apply_public_library，再 build_public、完整常规测试和 package_release。打包器要求完整 10 文件与 receipt 对应；两份公开 ZIP 和本地包内 public 必须逐文件一致。保存发布前经典六文件的 state SHA/receipt，供回滚。
3. 用已有权限和既有 Pages 发布入口完成获授权的发布，不新增 token/scope/项目。预览若仍被 1010 拒绝，只记录该限制并停止访问；不换域名/UA/网络重试。集成任务决定是否继续既有获授权发布，离线回归不能代替这个决定。
4. 在允许的正常访问环境检查已有正式域名的首页、14 天/365 天、中文/DOI 分享 URL、三片内容类型/哈希/缓存头、旧缓存刷新和受保护接口拒绝未授权请求。只读抽查已有缓存，不为验收调用模型、下载私有 PDF 或改变防护。若仍被拒，准确记“发布/线上验收待完成”，不能称完整验收或 1010 已修复。

复现：`XINZHI_BASELINE_PUBLIC=/path/to/classic/public XINZHI_DATA_QA_OUTPUT=/path/to/evidence node scripts/test_public_data_browser.cjs`；冷启动使用相同变量运行 `node scripts/benchmark_public_data.cjs`。classic 基线必须来自同一 main/state 的独立构建。本地真实运行：`npx wrangler@3 pages dev public --ip 127.0.0.1 --port 8799 --compatibility-date=2026-10-08`；这是 localhost dev，不是部署或远端预览。

## 回滚

整体撤销候选，包括构建器、加载器、app 就绪门和清单协议，不能只删除 Worker 分支或只发布旧六个文件。回滚准备时先在候选 checkout 用 `public_assets.read_payloads(Path('public'))` 完整校验，然后仅删除其返回集合中不属于 `CORE` 的已声明文件，并移除空的 public-data 目录；不触碰 data 或完整缓存。再由统一任务撤销代码、用当前完整 state 重建经典六文件并通过原发布指纹/包守卫后发布。保存的发布前六文件 state 可用于恢复生成输出，但不能以旧摘要缓存覆盖当前完整 data，也不能把旧 receipt 冒充新构建。旧 v2 缓存页面遇到已撤下的哈希片会保留内嵌内容并要求刷新。

两个 workflow 的 push/job 仍限定 main；普通隔离分支推送不触发生产部署。没有新增授权。
