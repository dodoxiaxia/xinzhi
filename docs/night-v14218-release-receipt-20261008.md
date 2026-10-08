# v14.2.18 已发布：已有 LFS 全文复用

唯一主发布正常快进 main 到 `30b16e81a4a6a65cc9d0154f2ba42599187d1a54`。GitHub [run 37722771464](https://github.com/dodoxiaxia/xinzhi/actions/runs/37722771464)、refresh job `113134014101` 均 success；Cloudflare Pages [07928219](https://07928219.dryz-xinzhi.pages.dev) 于 2026-10-08 03:33:10 UTC 完成部署，最终 state 于 03:33:18 UTC 保存成功，run 于 03:33:22 UTC 完成。实际 state 为 `a03db83ac17843173288ae1187f1c81d271baafe`。

## 修复与审查

纳入作者 `f5639914e2bff2cf841dd5306655d8333863cd4e`、尺寸修订 `9081761da91d2524b2d2ddb1b2994db712770647`，以及主集成期限修复 `bd613d1180d030c17fd36575e9c9c991fc09a125`。指针 Git blob 131 B 与原件 598,792 B 分开绑定；原件 targetSize 贯穿 batch、object、最终 bytes 和 delta expectedSize，Git blob SHA1/原件 SHA256/OID/大小上限保持。固定官方 GitHub batch 使用现有凭据；对象 GET 不带凭据、拒绝 action headers 和重定向，限定 HTTPS/host，401/403/429 暂停。正文或取消忽略 Abort 也不能无限等待。

[集成源码](https://github.com/dodoxiaxia/xinzhi/blob/30b16e81a4a6a65cc9d0154f2ba42599187d1a54/edge/_worker.js)、[LFS 尺寸回归](https://github.com/dodoxiaxia/xinzhi/blob/30b16e81a4a6a65cc9d0154f2ba42599187d1a54/scripts/test_github_lfs_reuse.cjs)、[ignored-Abort 期限回归](https://github.com/dodoxiaxia/xinzhi/blob/30b16e81a4a6a65cc9d0154f2ba42599187d1a54/scripts/test_lfs_deadline.cjs)、[口令来源快检回归](https://github.com/dodoxiaxia/xinzhi/blob/30b16e81a4a6a65cc9d0154f2ba42599187d1a54/scripts/test_doi_source_check.cjs)。独立集成安全审查核对最终固定 SHA，无阻断；父线程另一独立尺寸审查解除 9081761 HOLD。这些只读审查不冒充独立 CI。

## 已完成验收

本地完整 Python 628 项 / 270.935 秒通过，26 组 Node 功能回归及 2 项语法检查通过；实际构建六文件及三 ZIP 的公开字节一致。独立安全审查另补 8 个离线鉴权/action 案例；期限回归 6 类，覆盖 stalled headers/body、忽略 Abort/cancel、父取消、预取消零请求、拒绝响应及流大小上限。真实 JACC 指针元数据离线重现不再提前拒绝，未读取原件；完整尺寸正例使用合成 bytes，不冒充真实生产 PDF。

部署后从实际 state 回读六文件，每个大小/SHA256 与 manifest 相符；实际 `_worker.js` 446,394 B、SHA256 `00b5c7f578f3cd08224b6f9b9f46b50c45f8ea2246e5f9a593eb667595e28768`，与本地已验 Worker 逐字一致。实际保存 Worker 的 LFS/来源快检离线回归通过；36 个公开摘要身份 / 72 次严格查询零网络通过。保存成品的 1440/390 px × cards/compact 四个 Chromium 场景通过，无页面错误或横向溢出，研究结构仅本地模拟 POST/GET，真实模型请求为 0。不是现场自定义域名或真 iPhone 连通验收。

## 实际内容与运维

本版轻量刷新使雷达 870→869，文献库 1,264、checked guides 12、QL 12、归档题录 12,671、中文标题 15,142。24 篇周榜公开整行与 .17 相同，标题/译文/速览均 24/24，基本内容待补 0；研究结构仍 0/24、studyMissing=24。文献库 1,264 篇整行不变，CURATED/QUICKLOOKS/JOURNAL_METRICS/PREGENERATED/RADAR 投影不变。来源/生成时间、RSS 条目及刷新状态按真实本轮推进，不声称整个 public.js 与 .17 逐字相同。

刷新后未出现的唯一规范身份为 DOI `10.1038/s41467-026-78213-5`（Game theory driven multi-agent framework mitigates language model hallucination），不是周榜内容被覆盖。RSS PubMed 追踪参数导致 id 随 ff 改变的问题仍在，本版未修。源健康本轮 82 个：ok 54、filtered_empty 23、not_feed 5；后 5 个仍需信源专项维护。本轮保留原调度，没有创建计划或调用外部下载任务。

## 真实口令测试仍待完成

当前执行器无受支持的已登录/保存口令浏览器上下文，不绕过既有 1010/403/工具拒绝；最新生产 `PDF_GITHUB_COMMIT` 未读，不能凭缓存 manual_needed 猜配置。请只在网站内使用既有口令打开 [JACC 检查已归档全文并下载](https://learn.dryz.info/api/acquire/retry?doi=10.1016%2Fj.jacc.2024.02.026)。手动归档检查路径只查已有私有索引，不回退出版社；重复下载可验缓存命中。若仍失败，先用 [来源版本快检](https://learn.dryz.info/api/fulltext-source?doi=10.1016%2Fj.jacc.2024.02.026) 核对 configuredCommit/resolvedCommit/candidateFound；不要将口令发到聊天或公开 issue。

原作者另在其授权上下文回读真实既有 JACC 原件并严格双解析验证，不代替本次生产口令入口验收。主发布本轮真实私有 PDF/出版社下载、私有索引写、正式归档写均 0。

## 后续桥候选隔离

用户已批准现有同 audience/repo/workflow/main OIDC 的 authorized_claim/authorized_update 两能力，未启用生产变量。候选 `0eb91c69d49d87434892b69817432d5e574bf535` 未合入本版。独立审查仍要求 KV 跨 isolate 非原子领取显式 hold/no-execution，以及恢复基础 OIDC 在 body 读取前、严格有界 stalled body/cancel 回归。候选不能作为真实下载许可；作者修正及固定 SHA 审查完成、精确配置证据齐后另行受控合版。无新 token、存储绑定、调度、Mac 命令或正式归档权限。

完整机器回执和测试摘要在本目录同名 JSON。仅在证据分支提交；文档提交不改变生产 main。
