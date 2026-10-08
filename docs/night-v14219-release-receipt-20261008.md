# v14.2.19 夜间小版发布回执

生产源码固定为 `1e6d028024c005e813fbec29828c33201ce09b2e`，候选分支 `codex/night-v14219-pdf-diagnostics-20261008`。基线为已发布 .18 `30b16e81a4a6a65cc9d0154f2ba42599187d1a54`，本地恢复实际 state `a03db83ac17843173288ae1187f1c81d271baafe`。发布任务 [37727218068](https://github.com/dodoxiaxia/xinzhi/actions/runs/37727218068)。实际部署于 UTC 04:29:12 成功，Pages `60e11d29`，最终 run completed/success；state `0e9b75e078ba7208d645bdff16ef9dfacafc1e3d`。六文件 byte/SHA256 全部回读通过，详见同名 JSON finalProduction。

侧栏补丁原作者 `0f3a2be542a1a42b307e4c194554c701cde7f08e`，cherry-pick `2158292`。移除出版方/期刊侧栏 IF/JCR/来源展开块，保留刊名、篇数、键盘筛选及其他位置的期刊指标。实际候选 Chromium 在 1440/390/320 宽度通过 131 项检查；维护者已查看桌面和 390 宽度截图。

既有口令授权后，全文失败可返回白名单阶段/原因/底层错误码/HTTP 与对象级状态/UUID/时间。诊断与原文缓存分离，TTL 86400，写入 best effort；历史没有记录的阶段明确 unavailable。既有来源快检 GET 仍零 KV/上游/写入，授权 POST 只读配置与 metadataOnly 索引证据，失败仍能显示允许的配置和既有诊断。字段不含私有路径、签名链接、token、口令、raw exception 或响应正文。公开 library GET 仅返回安全暂停/错误枚举。

HTTP200 LFS batch 内对象级 401/403/429 与直接拒绝一致，永久暂停，零 object GET/零 PDF 写入。旧 PDF 下载入口也在认证后优先检查历史暂停，不自动恢复。原有 LFS host/header/redirect、blob 与原件 hash/size 守卫保留；available 优先。metadata/Contents/LFS 的 12 秒请求及正文等待有界，ignoreAbort/cancel 不阻塞失败回执。acquire/sourcecheck 保留来源总45秒期限；经典 `/api/pdf` 仍只有逐请求12秒限制。KV 最终一致，不能将这些检查描述为跨实例原子锁。

独立源码安全审查固定最终 SHA 通过。628 项 Python 回归通过（265.017 秒）；最终固定源码 27 组 Node 功能测试及 2 项语法检查通过；诊断 34 个合成场景通过。实际构建 Worker 的同组诊断、LFS reuse、来源快检再次通过；36 个公开摘要身份、72 次严格查找均零元数据/模型请求。六文件和三份 ZIP 验证通过；四组 1440/390 × cards/compact 的实际候选页面检查通过，均为本地拦截 Chromium，未调用真实模型。

实际生产 .18 的 JACC DOI `10.1016/j.jacc.2024.02.026` 在 UTC 03:56:23 左右仍失败。所见 library_upstream 和应用默认300秒不能确定 index/Contents/LFS/metadata 哪一步失败，原记录无此阶段。离线对象级拒绝反例证明旧分类存在缺口，不证明这就是本次生产根因。新诊断上线不等于真实全文已修好；同名 JSON 的 productionProtectedPdfReadback 如为 pending，表示仍待受控回读，不得声称成功。

本版不含 B OIDC authorized handoff，不启用 flags/consumer，不改生产配置/凭据/权限/绑定/新调度，不获取真实 PDF，不写正式私有归档或账本。网站工具受限，未绕过 Cloudflare1010/403，也未声称完成真实 custom-domain/API/手机测试。原临时 `/tmp` 工作目录仍不可据本工作树推断。

线上最新快刷将雷达869→874；library仍1264，所有paper记录相同，只有generatedAt变化。本周窗口2026-10-02～08选24篇，新增选择导致title/translate/quicklook实际21/24，pending3，study仍0/24。外部模型/运行缓存/账本写入均0；不得将本地24/24结果误写成此次实际生产覆盖。真实产物Worker注入摘要39项，78次严格查找零网络，34诊断场景/LFS/sourcecheck通过。规范化三种注入数据后Worker代码与固定候选一致，侧栏两种指标调用已从实际public.js移除。未重新开展耗时的实际产物浏览器测试或扩大修复。
