# DOI 云执行接入审查包（未部署）

网页当前可运行的部分在 `edge/_worker.js`；此目录是接入前可执行协议原型，不被网页导入，没有 HTTP 路由、运行中的队列、工作流或调度。代码可离线运行 `node proposals/doi-cloud-bridge/test_bridge.mjs`。它不是完整上传器，不能凭测试输出声称归档完成。

## 选定架构与切换边界

选用 **现有 Pages Worker + 一个私有 R2 bucket + 一个 GitHub Actions executor**。复用仓库已有 Cloudflare 触发 Actions 的模式；现有 `workers/cron-dispatch` 的代码仅作为模式参考，不读取或借用其 Secret，不调用其定时任务。

唯一领取账本在切换后放入 R2 `ledger/current.json`。先将最新 815 ledger 及两端母索引机械比对、保留历史与 DOI/标题别名；经原流程负责人确认当前消费者和唯一 owner 后，迁移到唯一权威副本。`items[doi].website` 是同一条记录上的提交/执行字段，outbox 也在此字段，不另起 Cloudflare Queue/第二领取账本。GitHub、Drive、Mac 上账本为回读过的同步副本，不能再各自领取。**没有 owner 切换确认，原型拒绝初始化或领取；本次没有停止 Grok、迁移账本或启动消费者。**

R2 绑定读写具有全局强一致性；`put(..., {onlyIf:{etagMatches}})` 以旧版本 ETag 条件更新，条件失败返回 null。用整份账本的一次条件更新同时保存 DOI 提交、日额度、outbox 和唯一执行 owner，避免跨多个对象的半提交。815 条规模适用，原型 8 MiB 上限，超限应停下重新评估。依据：[R2 一致性](https://developers.cloudflare.com/r2/reference/consistency/)、[条件操作](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)。

接通后，现有 `/api/acquire` 在同源/口令校验之后，先读取唯一账本状态：已有网页文件可立即复用；未处理 DOI 原子保存 submitted，再触发 Actions。现有 KV 只保留缓存与公共题录投影。正式切换时必须把当前同步 OA 执行移入唯一 executor，不能让 Worker 与 executor 同时新下载。成功提交只表示持久化，不表示运行成功。触发失败保留 outbox，受保护的用户重试或维护者 reconcile 可重新唤醒；不增加后台重试或定时器。

Actions `concurrency` 与账本 active owner 双重约束。`queue:max` 最多保留 100 个待运行 workflow；仍必须每次从持久账本取未处理任务，不能把 Actions 队列当任务数据库。达到数量/时长预算后未处理任务继续显示 submitted；下一次受保护提交/人工 reconcile 才继续。失联任务不靠 TTL 抢占：先验证旧 run 已终止，再核对远端对象及 commit 后恢复。依据：[Actions 并发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

## 网页、只读 PDF 与 executor 的接口

| 接口 | 权限及行为 |
| --- | --- |
| 现有 `/api/acquire?doi=` | GET 表单，POST 同源+全文口令；只接 DOI，不接 URL、路径、fileId、任务状态或任意 workflow/ref。接通后持久化提交并返回安全状态。 |
| 现有 `/api/pdf?id=` | 已实现只读 GitHub PDF 下载不改，`GITHUB_LIBRARY_TOKEN` 不增写权限。 |
| 现有 `/api/fulltext?doi=` | 继续口令保护，下载通过核验的缓存；若正式归档未完成，状态仍明确区分。 |
| 拟 `/api/archive/internal/claim`、`stage`、`receipt` | 仅 executor 的短期 GitHub OIDC JWT，POST、严格请求体上限、固定对象操作；不是对公众的第二个 DOI 提交入口。stage 仅可写当前 claim 的内容寻址 PDF；receipt 服务端复验后生成，不能从用户提交 JSON 直接采信。 |
| 拟受保护状态查询 | 只返回不透明任务 id、状态、三侧 pending/verified 和固定错误码；无私有路径、索引、fileId、凭据、原始错误正文。公共 `/api/library` 仍只返回安全题录投影。 |

`oidc.mjs` 已实现固定 issuer/JWKS、RS256 签名、aud、repo/owner 数字 ID、main ref、workflow 路径与已批准 workflow SHA、event、时间窗、run/attempt 验证。该普通 workflow 应核对 `workflow_ref`，不是仅对 reusable workflow 才有的 `job_workflow_ref`。每个任务持久化 run/attempt，回调还须匹配当前 owner，带预期对象版本与幂等键；短期 JWT 不等于可任意改账本。接通时需加受保护入口、JWT 密钥缓存/限流、回调请求体校验与对象阶段约束。依据：[GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc)。

## 需要用户在安全界面确认的最小新增范围

下表是待批准方案，不是已创建的资源或授权。全部凭据只通过官方设置界面/密钥存储器提供，不能贴聊天、写仓库或导出当前 ChatGPT 连接器 token。

| 资源/凭据 | 最小范围、接收方及实际限制 |
| --- | --- |
| 1 个 Cloudflare R2 bucket，建议 `xinzhi-doi-private` | 私有，绑定仅给现有 `dryz-xinzhi` Pages。保存 `ledger/current.json`、固定 source snapshots、`staging/sha256/<hash>.pdf` 和机械回执；不启用公开 URL，不需要 S3 密钥。由用户现有 Cloudflare 管理界面创建/绑定，本次不扩展部署 token。 |
| `ARCHIVE_DISPATCH_TOKEN` | 新的细粒度 GitHub token，仅 `dodoxiaxia/xinzhi`，Actions:write（隐含 metadata:read）；保存于 Pages Secret。GitHub 的授权范围是仓库 Actions，并不能细到一个 workflow；Worker 代码只允许 `archive-doi.yml`、main、固定 mode。不能复用 PDF 只读 token。 |
| 1 个 `archive-doi.yml` 手动触发 workflow + `literature-archive` 环境 | 仅 workflow_dispatch，无 schedule/push trigger、无 Pages 发布、无 main/state 网站写入；job 自带 GITHUB_TOKEN 只 contents:read、id-token:write。审批后固定受信 workflow SHA，防分支/其它 workflow 借用 OIDC。环境访问限定批准分支。 |
| `AI_LIBRARY_WRITE_TOKEN` | 另一个细粒度 token，仅私有 `dodoxiaxia/AI-`，Contents:write（隐含 metadata:read）；只给 `literature-archive` job。**GitHub token 不能限制路径**，实际仓库级写权限必须用户明白；代码只允许批准的 PDF 目录、母索引和账本/回执，禁止 workflow、AGENTS、其他代码、force push 和删除。 |
| 用户自有 Google OAuth 应用，`drive.file` | 接收方仅该归档 executor；账号 `dryz@dryz.info`。通过正常 OAuth + Picker 逐个授权固定私有根、已有 CSV、ledger，以及验收 PDF/后续需读取的既有文件。该 scope 不是全盘读写；**选中文件夹不作为已获得所有既有子文件权限的证据**。遇到未授权既有 fileId 标记 `drive_scope_needed`，不能另建副本或扩大为 drive 全盘权限。 |
| `DRIVE_OAUTH_CLIENT_ID` / `CLIENT_SECRET` / `REFRESH_TOKEN` | 仅在 `literature-archive` GitHub 环境 Secret 中持久存储，用于官方 Drive API 短期 access token。需官方安全授权回调与 secret 写入流程；此流程尚未实现/批准。Pages、浏览器、ChatGPT 模型与日志不接收这些值。 |
| Mac 端 | MVP 不新增网络服务或持久凭据。离线保持 mac_pending；用户在 Mac 正常授权环境运行一次机械同步/回读命令后才可提交该侧证据。将来如需全自动，须单独批准只向外连接的受限同步 agent 与认证方式；本方案不擅自启用 SSH、监听端口、LaunchAgent 或控制 Safari。 |

根目录、CSV、ledger 和复用验收 PDF 的精确 fileId 已在主会话私有交接资料固定；不放进网页输出。Drive OAuth `drive.file` 只覆盖应用创建或用户选定的文件；长期运行需要安全保存 refresh token。[Google 官方权限说明](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)。

已确认会话 Drive 连接身份正确，成功读回私有原件；这不能证明新应用或后台具备写权限。ChatGPT 的 GitHub/Drive 连接器可继续做**人工监督的读取/回读**，未发现可供 Worker/Actions 调用的连接器运行时代理，也不能提取其托管凭据。现有终端能 push 专用分支也不等于后台获得长期 AI- 写授权。

## 下载与各侧落库步骤

1. 唯一 executor 领取后，先回读当前两端 CSV、完整 canonical ledger，运行 `workflow_state` 的规范化/查重/别名及题名冲突判定。原型的 DOI key 去重不取代这些规则。查重状态不明时 hold，不能抢先下载。
2. 依序复用已核文件、合法 OA、正常机构授权流程。网页获准 OA 先行的时间为北京时间 **2026-10-07 18:10:48**；不改变 dot 直接指定 DOI 的 Hamburg-first 或定期查新流程。来源地址只取官方解析结果；新 executor 的传输层必须继承 HTTPS/来源白名单、每次重定向检查、DNS/IP SSRF 限制、超时和大小上限。不能直接把本机 `run_download.py` 的泛 URL transport 当云端安全抓取器。
3. 私有暂存保留原 PDF 字节。复用 `strict_pdf_verifier` 双解析器遍历全部页，检验首页 DOI/题名、头/尾、≥50 KiB、大小上限与 SHA。只有严格验证结果才能形成 immutable manifest。没有受支持的 Hamburg 登录桥时 `manual_needed`，403/429/登录/验证码停止，不导出 Cookie 或临时签名参数。
4. GitHub：PDF、CSV、机械回执做同一 Git tree/commit；CAS 更新预期 parent 的 ref，不 force。结果未知先查固定路径/hash/commit，不重复上传；409 先 hold/reconcile，不无限重试。读回该 commit 的 PDF 原字节与 CSV，再写 GitHub receipt。
5. Drive：既有 fileId 原位 update；新二进制 PDF 先 `files.generateIds`，将唯一预分配 ID 存账本后 upload。中断重入先 get 同一 ID；409 读回比对，不能另取 ID 重建。分别 get media 回读 PDF 与 CSV。官方 API 支持预生成 ID 的安全重试：[Drive 上传说明](https://developers.google.com/workspace/drive/api/guides/manage-uploads#use_a_pre-generated_id_to_upload_files)。
6. Mac：只在真实 Mac 端做路径白名单/无 symlink 逃逸、原字节落盘、CSV 合并及回读。云端历史 ledger 中的 local=true 不是本轮回读，离线不等待占用 executor，持久保留待同步任务。
7. 三侧 receipt 都必须绑定本轮 generation、同一 PDF SHA/大小、同一最终母索引 SHA、原件位置的不可变版本与当前回读时间。全部齐全才 complete；否则精确显示 github_pending/drive_pending/mac_pending。先前题录追加导致 CSV 版本变化时需再次核对同一同步版本。任何前端乐观状态都无权完成任务。

## 一次性验收顺序与当前实现缺口

**现在已可验**：现有 Worker 离线测试；CAS/OIDC/状态原型离线测试；通过授权连接器取回的真实 GitHub/Drive 原件机械验证。没有新的出版商下载或归档写入。

**批准后先零新下载验收**：为独立 staging bucket 导入合成账本，24 并发同 DOI 只一条、重启仍可查、dispatch 失败不丢任务、未经授权及跨 repo/ref JWT 均拒绝。再在批准正式迁移窗口导入最新 815 ledger，两端索引必须一致、未知消费者未停则不切换。选择已核 DOI `10.1001/jamanetworkopen.2026.37533`，通过真实口令入口→唯一任务→既有 PDF 复用→两端当前原字节回读；不重新获取出版商 PDF、不重复创建远端文件。Mac 未在线应返回 pending，不能人为补 true。

**最后才新增一篇**：另行先报告未重复的目标 DOI，最多一篇；许可/桥具备后执行严格验证、两侧上传回读及 Mac 同步。正常授权操作涉及登录由用户在受支持安全界面完成。

**还需实现/验证，不能以“只差 token”概括**：R2 真实资源/跨实例条件写实测；带签名校验的内部路由和受保护状态接口；815 schema/alias migration 与 owner cutover；bounded drain runner、崩溃 reconcile、严格下载 transport、Git tree 原子上传器、Drive OAuth 安全设置与 uploader；Mac 机械同步/签名回执桥。`ledger.mjs` 只实现接收/领取/dispatch 状态核心，`oidc.mjs` 实现鉴权核心，`archiveStatus` 是状态验证纯函数。`archive-doi.yml.example` 故意 fail closed，不能安装后假装可执行完整归档。测试的合成 receipt 不属于真实库证据。
