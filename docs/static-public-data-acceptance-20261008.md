# 静态公开数据分片：集成与发布验收准备（未部署）

记录时间：2026-10-08 00:14:25 UTC。此文仅为唯一集成者的验收准备，不实现分片、不合入动态扫描候选、不部署、不读取凭据。静态候选由既定性能任务独立实现；候选 source SHA 尚未交付，所以所有候选测试均为 **pending / 未运行**。

## 当前已核实状态

生产 main 仍是 `0371c21e846f05fdb5ef8e41968a711ac01a5a19`（v14.2.12）。当前 state 回读为 `622b0d719496e84ac61af6ac155dcd73861dc0f6`；正式合版前必须重新核实最新 state，不能沿用旧 v11 固定输入。

[定时运行37706195711](https://github.com/dodoxiaxia/xinzhi/actions/runs/37706195711)的 refresh 已成功。[外部 fast dispatch37706072130](https://github.com/dodoxiaxia/xinzhi/actions/runs/37706072130)由 ignored-dispatch 成功忽略，refresh 跳过；这证明本次防重复门禁生效，不证明外部定时器已关闭，也不等同于新增发布完成。

既有预览一次诊断收到 Cloudflare403/error1010，Ray `a470d49d4c81c47e-LAX`。它是尚未解决的客户端签名拒绝证据。静态架构消除 Worker 在线扫描，不能叫作“解决1010”。不触碰该被拒 URL，不改域名、UA、身份、网络或防护。动态候选 `53bee6b1`保持 HOLD。

## 合版前必须同时迁移的门禁

六文件约束并非只有一个常量。当前源码中至少存在以下耦合点，不能只改打包脚本：

| 位置 | 必须核实的迁移 |
| --- | --- |
| scripts/build_public.py | 旧输出预检、生成目录、公开内容检查、输出集合断言、逐文件回读、构建清单 |
| scripts/release_integrity.py | 允许集合、路径安全、每个 payload 的 bytes/SHA256、source/state provenance、时间与版本一致性 |
| scripts/package_release.py | 普通文件逐项读取、ZIP 精确清单、预检失败不替换旧包、禁止秘密/私库 |
| scripts/ci_daily.py | content_hash 必须覆盖全部新静态分片及数据清单；sanity 必须使用同一白名单机制 |
| scripts/public_data_bundle.py / public-data-loader.js | 版本与数据清单生成、可信 hash 校验、合法 JSON 深层形状、失败缓存清除、显式重试 |
| edge/public-data.js / edge/_worker.js | 数据路由不再扫描 public.js；静态转发及未知路径边界；保留全部 API/PDF 鉴权 |
| daily.yml / state恢复与保存 | 恢复的是旧 public 目录；迁移、重复构建、回滚旧版本时不能遗留分片或误删未知文件 |

使用统一受控的静态文件路径清单。实际输出、部署 payload、ZIP 条目、构建 manifest 和预检期待集合必须完全一致。精确允许的相对路径和命名规则由候选提供；禁止靠宽泛 `**/*.json`、忽略额外目录或跳过验证通过。

旧版本 public 的迁移应只处理可核实的上一版生成输出；额外文件、未识别路径、任一父目录或文件 symlink、目录逃逸、重复清单条目、缺失文件应拒绝。不删除安全门禁。

## 候选到齐后的完整回归

1. **身份与输入**：唯一 source SHA、最新 main/state SHA、source diff、构建后 input hashes 全记录。私有库快照/目录身份及需隔离的 PDF binding hold 保持一致；不让 state 覆盖代码。
2. **完整性**：每个新增静态文件 bytes/SHA256 全量校验；修改任一 shard/清单/代码/输入、缺文件、重复/额外/越界路径、symlink、旧构建必须失败。预检失败不得替换原可用归档。
3. **版本与缓存**：内容寻址或版本路径必须对应准确的 payload；同一不可变路径不可因浮动构建时间产生不同内容。bootstrap 必须锚定期待版本/清单或 hash，混版、旧缓存、损坏合法 JSON、哈希不符均不可采用。区分构建完整性 hash 与忽略已知刷新时间的内容变更判断。
4. **日常更新**：仅 shard 内容改变也触发发布判断；仅已明确允许的刷新时间改变不能无意造成无限发布。首次六文件→多文件、再次恢复上一版 public、连续构建和回滚均验证。main 的每日全刷/两小时快刷、确认 fast dispatch 门禁与预算不改。
5. **静态服务**：离线模拟 Pages ASSETS 运行，核对 GET/HEAD、JSON MIME、缓存/nosniff、公开路径限定、未知/错版本路径、Range/失败响应行为；不得因直接静态服务绕开 API 鉴权。路由变更若需要 `_routes.json`，必须将其自身纳入新白名单且保留全部 API/PDF 路由。
6. **前端与行为**：与同一新输入构建的稳定生产架构对照；首页不自动下载年度包，14日/全年/搜索/周榜/源健康/文献库/DOI 入口、旧 URL 均保持行为。覆盖慢网、断流、超时、失败不自动循环、显式重试、旧版本提示、深层雷达数据形状、ready-only 缓存和恢复后的近期视图。
7. **边界与内容回归**：现有 Worker、PDF、DOI、全文任务、OIDC、摘要翻译/解读/证据服务和预算用离线 mock 回归。无真模型调用、PDF 下载、外部同步；公开 JSON/manifest 不包含凭据、全文 PDF、路径、私人笔记或私人 provider 配置。全文下载鉴权与内部凭据响应处理保持完整。
8. **页面回归**：320/390/768/1440 × 既有四外观验证 sticky、Shift+Tab 焦点、周榜锚点、sources 布局，保持 v14.2.12 维护修复；模拟桌面 viewport 不叫真机测试。
9. **量化与运行**：记录首页原始/gzip、完整部署总量、首屏/切换耗时、静态文件量及解析量，不能只报首页变小。纯静态数据请求若不进入 Worker，说明资源门禁如何迁移并提供该事实证据；没有 Worker 指标不是“CPU=0”。任何最终线上验收需要针对精确新候选和真实版本，旧预览或本地 mock 不能替代。

至少运行 daily 已列离线完整回归、适配后的 build/package/release/ci_daily/workflow 测试、真实字节构建与打包预检，以及针对新静态架构的浏览器/ASSETS测试。测试失败先修候选并重跑相关项，再进行完整合版回归。

## 发布决定与透明回执

当前决定为 **AWAIT_STATIC_CANDIDATE**，没有部署授权或部署执行。候选到齐后完成本地回归，再明确列出已通过、未验证及阻断项。不得借改架构的名义放行任何尚未通过的运行门禁；不复用旧预览性能证明，不自行解除1010拦截。

满足验收且有明确最终候选部署授权后，由唯一集成者串行合版，记录 source SHA/state SHA、完整新白名单 manifest、Actions/Pages版本与成功发布/保存状态，做全部静态字节 hash 回读以及必要页面/API边界验收。失败维持稳定生产，保留可审计证据和回滚产物；不能用刷新成功冒充发布成功。

[机器可读准备状态](static-public-data-acceptance-status-20261008.json)中的所有新候选 gate 均为 pending，不能用于宣称测试通过。

