# DOI 一次口令下载候选与现有链路断点

候选分支 `codex/doi-self-service-repair-20261008` 在原工作区续做，基于最新 main `655975cf75ed1a08d5a8ce03a2847c4a31af5f9f`（v14.2.8 加 PubMed 访问错误诊断修复）；最终补丁 SHA 由交接消息给出。只修改既有入口及测试，不合入早期 `b909032/f5f3839` 删除 OA 的方案，也不恢复旧 R2 原型。

## 已核实的生产状态

起始部署为 v14.2.6 / `377aa936df7962261e693ccf1406ae18cc0856be`，Actions `37652647044` 已成功部署。随后已合入 v14.2.7 与 v14.2.8 最新代码，Worker 没有被这些内容更新修改。

生产 `/api/fulltext-worker` 实返 `job_disabled`；`/api/fulltext-pending` 返回 pending=false。现有文档明确记录：独立桥接任务 `01a1152b-e819-73bf-9934-bf37086780f5` 的 cron 部署曾失败，异步方案在 Pages 与 Actions 两平台都需要明确启用。本任务不启用或部署它。先前下载工作流 green/skipped 不证明下载发生。

目前真正能执行的是同步路径：受保护表单 → Crossref → GitHub 已有原件或明确合法 OA → KV 缓存 → 口令下载。已对三篇做生产 API 原字节回读与机械核验：

| DOI | 本轮操作 | 文件字节 | SHA256 | 全页核验 |
| --- | --- | ---: | --- | --- |
| `10.1001/jamanetworkopen.2026.37533` | 原只读下载、按 DOI 保存缓存、缓存下载、重复提交 cached=true | 1202764 | `7234844b6174ea61ee7200f7af83b948a4c7ab6ee42fc58ed47b3f31a1cb04c4` | 16 页，通过 |
| `10.1111/jce.70522` | 原只读下载、按 DOI 保存缓存、缓存下载、重复提交 cached=true | 623576 | `3c638d2ffe6d3b2f1ba463dbbb76e6cbe0630275ae28938a2a1779a7f3739c48` | 9 页，通过 |
| `10.1371/journal.pone.0174944` | 最新两端索引/815 ledger 查重未命中，但网站已有缓存，因此直接复用；没有新 OA 获取 | 1428808 | `690575cc821768ed4999307fc0e58965c4b1e49fec1aab117a8e5e2409e0015b` | 14 页，通过 |

生产 API 回读是事实；本轮新增的一次口令功能尚未部署，不能算作生产已验收。机械核验复用 `strict_pdf_verifier` 的双解析器、全部页、首页 DOI/题名、头/大小/SHA。私有原始 PDF、CSV、ledger 和口令只在授权本地目录/临时表单文件，不进入提交、公开包或模型。证据摘要见 `doi-reuse-api-evidence-20261008.json`。Mac 没有本轮当前回读，所有网站缓存都不冒充三端完成。

## 本次具体修改

原表单获取成功后还需另开下载表单、再次输入口令。现在同一个 `/api/acquire` GET 表单的 POST action 带固定 `download=1`：一次口令验证，先持久保存题录/文件，再返回 PDF attachment。客户端无需 JS、Cookie、新 token、额外会话或密码存储；口令只在当前 POST body。该 flag 不含凭据，只在既有 acquire 路由接受，不能用于 library/fulltext，也不能重复或传任意 URL。

未使用 download flag 的 JSON 获取 API 保持原行为；已缓存文件优先复用，保存失败/缓存损坏/等待同步不会发成功附件。没有 PDF 时返回准确状态页，订阅需要已授权机构流程，当前桥未接通。结果 JSON 的 `archive` 与附件 `X-Xinzhi-Archive-Status` 均说明正式归档未确认。

401/403/429 和 PDF 来源 HTML 登录/验证码页面会暂停；OA 不继续换源循环，受保护重复提交不发源请求。同步暂停标记保存在既有 attempt 命名空间，无自动重试；异步执行若将来启用，暂停结果也不会重排队。私有 GitHub 索引/文件读取失败不转去 OA，避免查重未知仍重复获取。

维护者确认权限/限流原因解决后，可在既有 KV 管理界面对精确 DOI 的 `library:attempt:<doi>` 暂停标记做受控恢复。这不是公开解锁接口；本任务没有清除生产标记或扩展 KV 管理权限。

## 已通过的测试与合法 QA 交接

```sh
node scripts/test_doi_direct_download.cjs
node scripts/test_doi_direct_download.cjs --browser
node scripts/test_doi_library_worker.cjs
node scripts/test_fulltext_jobs.cjs
node scripts/test_fulltext_activation.cjs
node scripts/test_pdf_worker.cjs
node scripts/test_edge_worker.cjs
node scripts/test_doi_library_ui.cjs --helpers-only
node scripts/test_fulltext_dispatcher.cjs
python3 -m unittest discover -s scripts -p 'test_public_build.py' # 23
python3 -m unittest discover -s scripts -p 'test_package_release.py' # 23
python3 -m unittest discover -s scripts -p 'test_release_build.py' # 3
python3 -m unittest discover -s scripts -p 'test_workflow.py' # 9
```

`--browser` 使用真实 Chromium 表单/CSP/attachment 事件、合成 HTTP/KV 来源，证明只一个带口令 POST，保存后收到正确文件；没有第二个口令请求或持久存储。新增无浏览器依赖测试已加入现有 daily-refresh 门禁，不改调度或发布权限。

生产浏览器旅程受当前云环境代理证书不受 Chromium 信任阻挡；未关闭证书校验、改信任库或绕过警告。请独立 QA 在合法浏览器环境验收：从首页输入上述既有 DOI → 获取表单 → 只输入一次口令 → 下载附件 → 返回文献库查看 → 重复获取。另验错误口令、手机版、非 OA 的待授权状态。先用已有 PDF，避免重复出版商下载。生产原字节回读与候选合成浏览器测试是两类证据，不混称网站端到端完成。

## 订阅桥：可以先人工按需交接，不新增持续访问或调度

可用现有 Mac 任务与已授权机构浏览器完成**监督下按需交接**，最小流程为：

1. 用户/主线程把已核 DOI、官网 URL、当前网站状态，以及存在时的现有任务 id，明确交给持有 Mac 浏览器的任务；不传 Cookie、口令、PDF、私有路径或临时签名链接到网页/外部模型。
2. Mac 任务先用当前两端母索引与唯一领取账本查重，沿原授权流程正常登录机构浏览器。仅原唯一归档 owner 执行；不新增 consumer，不擅自停旧 Grok。验证码/403/429停止并报告。
3. Mac 任务复用原机械核验/归档流程，分别证明 Mac、私有 GitHub、Drive 当前原字节/索引回读。已归档的 JAMA/Wiley只能复用。其现有写权限由该任务实际工具/凭据验证，不能从本网站只读 token 推断。
4. 回报经核对的归档 DOI 与版本给主线程；网站仍经原 `/api/acquire` 复用 GitHub 文件。需核对运行中的 `PDF_GITHUB_COMMIT` 是否固定旧快照；若固定，主集成在其授权发布范围内更新到已核快照。该非秘密配置当前未读取，不能假定默认跟随最新 main。此前若该 DOI有暂停标记，先受控恢复。正式回执未接入网站前仍保持 archive 不确认。

**当前队列不能自动交给 Mac**：它未启用；工作接口只接受 GitHub-hosted `fulltext.yml` OIDC，且只有 claim/run，没有 Mac领取或上传回执动作。文件获取实际在 Pages 执行，GHA 只是唤醒，无法共享 Mac Safari。不能把 Mac改为绕过这个身份边界的自托管 runner或借用浏览器 Cookie。

人工交接和本次下载补丁不需新增凭据、R2、OAuth或调度。当前任务不能在平台中自动读取/唤醒另一个 Mac 任务；由主线程按已有任务授权转交。这是一段需人监督的链路，不宣称无人值守。

若用户后续要求自动交接/三端回传，需先单独确认具体新增范围：

| 最小缺项 | 需要确认的范围与接收方 |
| --- | --- |
| 激活现有队列 | Pages 与 GitHub 两处非秘密 `FULLTEXT_ASYNC_ENABLED`，处理旧挂起任务/唯一 owner、保留原调度职责；由主集成核对。当前 gh 查询仓库变量返回403，不能据此提升权限。 |
| 现有 dispatcher 真正部署/触发 | 核对正确 Cloudflare 账户和既有 worker；此前部署 No access to specified service。若原凭据确实没有 Workers Scripts Edit，需用户只向指定部署执行者授权正确账户的所需资源，保留 PDF token 只读。不自行创建新 token 或改 cron。 |
| Mac 自动按需桥 | 受支持的授权浏览器执行器、出站取指定任务及提交回执的认证；仅指定 DOI/任务，PDF留私有。接收方是唯一归档 executor/Mac adapter，不能给匿名网页或开放通用 URL/本机路径访问。无支持桥就 manual_needed。此认证与实现尚未批准，不能复用 GHA身份冒充 Mac。 |
| 云端直接写正式 GitHub/Drive（如替代现有 Mac writer） | AI- 精确仓库 Contents 写及 Drive已确认私有根/母索引/账本的文件范围，凭据只给唯一归档 executor。仅在原已授权 writer 无法复用时才需要；目前 Pages 只读凭据不够，聊天连接器不是可导出后台 token。 |
| 严格跨云唯一领取 | 已有 KV软锁不是原子锁，本机fcntl也不能跨云。需确认同一815账本的唯一 owner与原子持久存储迁移；可能需要1个私有R2或同等强一致服务，先批准范围再实现/切换，不同时维护第二领取库。 |

本次没有申请/创建上表资源，没有触发生产 workflow 或改 main/state。统一由主集成验收后发布大版本。
