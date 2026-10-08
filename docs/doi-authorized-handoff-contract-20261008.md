# 受控授权接单契约 v1（候选默认关闭；用户已批准两项能力）

这不是网站自动唤醒 Mac，也不是无人值守下载完成。沿用 existing → OA → 授权执行者 的网站来源顺序；直接向 dot 点名的汉堡优先策略另属原任务，不能改写为网站策略。

## 权限差异，未激活

| 项目 | 原有 / 候选 |
|---|---|
| OIDC audience | 均为 `https://learn.dryz.info/api/fulltext-worker` |
| issuer | 均为 `https://token.actions.githubusercontent.com` |
| repository / repository_id | 均为 `dodoxiaxia/xinzhi` / `1397425558` |
| workflow_ref | 均为 `dodoxiaxia/xinzhi/.github/workflows/fulltext.yml@refs/heads/main` |
| ref / sub | 均为 `refs/heads/main` / `repo:dodoxiaxia/xinzhi:ref:refs/heads/main` |
| runner | 均只接受 `github-hosted`，拒绝 self-hosted、PR、其他 repo/ref/workflow |
| workflow permissions | 均为 `contents:read`、`id-token:write`；不加 Contents/Drive 写权限，不增加新 token |
| 新能力 | 同一 principal 新增 `authorized_claim` 与 `authorized_update`：领取授权请求、提交处理回执。用户已在主会话明确回答“允许”；本分支不自行启用。 |
| 新动作事件 | 仅 `workflow_dispatch`；新动作额外拒绝 push / schedule，原 queue 规则不变。 |

已批准动作的接收方和最小范围：唯一主发布验收并部署候选后，才可在 Cloudflare 账号下 `dryz-xinzhi` Production 设置 `FULLTEXT_AUTHORIZED_HANDOFF_ENABLED=true`，并在 `dodoxiaxia/xinzhi` 仓库设置同名变量 `true`，允许既有 main `fulltext.yml` 身份调用上表两动作。继续保留原 `FULLTEXT_ASYNC_ENABLED` 状态，不启用下载调度。本模块没有执行变量变更。新接口不允许其他 principal；不创建 Cloudflare Queue/绑定、token、常驻服务或 Safari Cookie 桥。

## 请求与领取包

网站 POST 必须通过既有全文口令、origin 与额度保护。KV 请求 key 按规范 DOI 固定，ID 为 `request-` 加 DOI SHA256 前 32 位。同一 DOI 并发提交对应同一请求 ID；单 isolate 已观察到的票据保留。最终一致 KV 无法保证跨 isolate 旧值不会覆写状态，也不能保证唯一 claim；不能把稳定 ID 当成全局唯一执行领取。

工作接口：`POST /api/fulltext-worker`，只接受上表 OIDC。每轮至多领取一个：

```json
{"action":"authorized_claim","doi":"10.1000/example"}
```

`doi` 可省略，默认只读至多 30 个既有请求；没有任务返回 `handoff:null`。成功响应中的 `handoff`：

```json
{
  "version": 1,
  "website_request_id": "request-0123456789abcdef0123456789abcdef",
  "claim_id": "claim-0123456789abcdef0123456789abcdef",
  "doi": "10.1000/example",
  "title": "已核官方题名",
  "dispatcher_run_id": "1234",
  "claim_proof": "BACKEND_GENERATED_SHA256",
  "backend_status_url": "https://learn.dryz.info/api/library?doi=10.1000%2Fexample",
  "owner": "github-workflow:dodoxiaxia/xinzhi/.github/workflows/fulltext.yml@refs/heads/main:run:1234",
  "request_version": 1,
  "idempotency_key": "website:request-0123456789abcdef0123456789abcdef",
  "fencing_guarantee": "unverified",
  "execution_state": "hold",
  "ready_to_execute": false,
  "hold_reason": "exclusion_unverified",
  "official_url": "https://doi.org/10.1000/example",
  "batch_id": "website-request-0123456789abcdef0123456789abcdef",
  "source_policy": "existing_then_oa_then_authorized",
  "ledger_requirement": "existing_canonical_ledger_exact_owner_or_hold",
  "executor_claimed": false,
  "archive_complete": false
}
```

`owner`、`request_version`、`idempotency_key` 必须使用后端上述值，Mac adapter 不得由客户端默认补造。owner 是受控 dispatcher 归属，不能用它覆盖 Mac 既有 `owner_queue`；request_version=1 是不可变请求描述的版本，不是全局原子 fencing generation；idempotency_key 将此次 handoff 绑定网站唯一 DOI 请求。

**本候选所有领取包、公开状态及回执响应固定 execution_state=hold、ready_to_execute=false、hold_reason=exclusion_unverified。** 包的 executor_claimed 和公开 executorClaimed 永远 false；即使收到有效已存在文件回执，也不推断排他领取，不解除 hold。claimed 只描述票据，不能启动 consumer。runner 拒绝任何缺 hold 字段或 ready_to_execute=true / executorClaimed=true 的包，前端同样拒绝在导入题录前接受这类响应。没有可解锁执行的参数、flag、callback 或消费者调用。

执行者先核对后端活态：仅 GET 固定 `https://learn.dryz.info/api/library?doi=规范DOI`，必须 id/doi 相同、state=`claimed`、requestVersion 相同，并比对 `handoff.claimProof`。proof 算法为 SHA256(UTF-8 compact JSON array)，按顺序：`[website_request_id, claim_id, dispatcher_run_id, doi, title, owner, request_version, idempotency_key, batch_id]`。claim_id 由后端随机生成，只在私有交接包里出现；公开接口仅给 proof，不给 claim_id。必须拒绝缺字段、任一字段改变、活态不匹配或无法读回。proof 是后端票据对应证据，不赋予下载或账本写权限，也不替代跨端互斥。

公开时间权威字段在上述 GET 的 handoff 内：`createdAt`、`claimedAt`，均为正的 JavaScript safe integer、UTC Unix epoch **毫秒数**，不是秒数或字符串。createdAt 是该后端票据首次创建时间，claimedAt 是该票据本次 claim 时间；submitted 没有 claimedAt。Mac 必须先匹配 id/doi/requestVersion/claimProof，才采用同一响应中的时间，缺字段/格式错误则 hold，不能由本机默认补造。受最终一致 KV 限制，它们是该票据视图的时间，不能证明全局最新或排他；私有领取包及九项 proof 数组不新增时间字段，也不公开 owner/claim_id。

这只证明受控 dispatcher 领取交接票据。Mac 原任务必须先在**当前 871 项及后续最新账本**核对 canonical DOI、`owner_queue`、已有侧和 `website_request_id`；不能用旧 815 项覆盖，也不能仅凭本机 lock / exit 0 宣称跨端领取成功。已有别的 owner 且仍需获取时 hold，不直接消费。缺有效跨执行者排他证据或安全授权浏览器工具时保持 hold/manual-needed，不调用正式下载 consumer。原 `run_download.py --batch-id … --doi … --title … --limit 1` 的单篇执行范围不变；获准运行的 adapter 负责把 request id 保留在 record.item 并证明归属。

任务包是私有 workflow artifact，经主会话交现有 Mac 任务。无自动 Mac 唤醒接口、无新 consumer/scheduler。原 consumer.lock/ledger.lock 只保证本机；网站请求表不替代 canonical 领取账本。

## 进度回传

由同一受控 main workflow 以新一期短期 OIDC 提交；没有把 OIDC token 或网站口令交 Mac。`claim_id` 是关联 ID，不能替代 OIDC 身份。

Worker 先完成基础 OIDC 校验，再读取 JSON 请求体；匿名 stalled body 不读取，直接 401。通过 OIDC 后 body 总预算 5 秒、最多 1024 B，每次 reader.read 都与 deadline 竞争；超时返回 job_body_timeout/408。cancel/releaseLock 仅尽力清理，不能等取消 promise；忽略 abort、永不完成的取消和晚到数据均不能拖住响应或恢复解析。新动作在解析后继续要求已核验 principal 的 event_name=workflow_dispatch，原 queue 事件范围不扩大。JWKS transport/text 同样与原 8 秒认证 deadline 竞争。

```json
{
  "action":"authorized_update",
  "doi":"10.1000/example",
  "id":"request-0123456789abcdef0123456789abcdef",
  "claim_id":"claim-0123456789abcdef0123456789abcdef",
  "state":"pending_browser",
  "ledger_key":"doi:10.1000/example",
  "owner_request_id":"request-0123456789abcdef0123456789abcdef",
  "owner":"github-workflow:dodoxiaxia/xinzhi/.github/workflows/fulltext.yml@refs/heads/main:run:1234",
  "request_version":1,
  "idempotency_key":"website:request-0123456789abcdef0123456789abcdef",
  "batch_id":"website-request-0123456789abcdef0123456789abcdef"
}
```

状态：`pending_browser` / `downloaded` 是执行者报告，尚无安全核验证明，不设置 executorClaimed 或 archive.complete。回调必须保留领取包的 owner/request_version/idempotency_key/batch_id，即使 OIDC run_id 是新的回传 run。`blocked` 须带枚举原因：login_required / captcha / http403 / http429 / browser_tool_unavailable / ownership_conflict / archive_confirmation_required / source_failed。blocked 不自动恢复，不允许计时后反复执行。回执或 GitHub 内容读回遇 401/403/429 时写入暂停状态，后续回调拒绝继续，无自动循环。

`verified` / `sync_pending` / `complete` 必须另带 `receipt_commit`，读取私有 AI- 固定路径 `zcode-workflows/doi-handoff-receipts/REQUEST_ID.json` 的 canonical 机械回执。没有该文件/证明则拒绝成功，不能上传 mock、exit 0 或前端乐观回执。

## 安全回执 v1

回执固定字段：version、website_request_id、batch_id、doi、title、claim_id、dispatcher_run_id、claim_proof；ledger.key / owner_request_id / items / handoff_owner / request_version / idempotency_key / canonical / snapshot_sha256 / snapshot_bytes / owner_queue / ownership_checked / checked_at；content.sha256 / bytes / pages；verification.verified=true、method=`dual_parser_all_pages_title_doi`；sides.mac / github / drive；indexes.mac / github / drive 的 SHA256。ledger.items 至少 871（仅拒绝已知过时快照，不能证明永远最新），canonical 必须 true；snapshot_sha256 和 snapshot_bytes 是执行者本次实际读取的完整 canonical ledger 原始字节 SHA256/字节数（整数 1..16777216），不能对抽样行或重新序列化 JSON 算指纹。owner_queue 必须保留账本原 owner、非空且不超过 256 字符；ownership_checked 必须 true，表示机械核对原归属未被此请求覆盖。它们留在私有回执，不出公开 GET。checked_at 为可解析 ISO8601 UTC 时间，必须不早于本次 claimedAt、位于当前时间过去五分钟至未来三十秒范围。仅“请求创建后”不足：数小时前/数日前的请求后快照也必须拒绝。handoff_owner/request_version/idempotency_key/batch_id/claim_id/dispatcher_run_id/claim_proof 必须匹配本次领取包。

网站按 receipt_commit 读取固定私有文件，保存实际原始回执字节的 receiptSha256 与该 immutable commit。账本 snapshot_sha256 是执行者证明中的另一指纹，不能冒充回执文件 hash，也不能凭它和墙钟推断账本始终最新。网站没有独立 canonical ledger 最新版本读取桥，所有公开响应明确 ledgerLatestVerified=false，继续 hold。receiptVerified=true 仅表示指定版本回执通过验证，不能设置 executorClaimed。实际 canonical 读取仍必须由获授权执行者完成，不能仅凭计数或指纹自报。

当前没有真实 canonical 回执发表许可/文件及 byte/hash/owner/time 实读证明。Mac 对 verified/sync_pending/complete 继续拒绝私有回传；必须先展示固定回执的精确写入范围、获确认、完成实际 canonical 读取和各侧回读，不能上传 mock。源码合成测试中的 snapshot_bytes/owner_queue/fingerprint 仅测试必填和门控，不证明 871 项最新或任何生产接通。

每侧须有 verified、同 content SHA/bytes。Mac 另须 identity_verified；GitHub 须 commit，网站会按该 immutable commit 再读真实母索引和该篇原件核验 hash；indexes.github.commit 必须等于 sides.github.commit，将母索引指纹绑定实际读取的固定版本。Drive 须 dryz@dryz.info、content_read_back=true、真实 file_id、已确认私有 root_id。三个母索引 SHA 必须一致，GitHub 母索引 SHA还必须与网站实际读到的相符。此一致性只证明回执指定的版本，不证明“当前 main 最新”；增量候选母索引未登记不能标三端 complete。

所有回执验证先完成，才执行缓存写入：complete 缺 Drive/索引/归属/时间证明返回 409 时不写 PDF、题录或归档状态。已有可用缓存和部分归档记录也保留。有效 verified/sync_pending/complete 可回读既有 GitHub 原件并写合法缓存；仍保持执行 hold。401/403/429 是明确例外：写暂停记录，保留既有 PDF/题录/归档证明，不自动重试。KV 多 key 写入不是事务，存储失败不能宣称所有写入原子完成。

回执来自唯一执行者对三侧实际读回的机械证据，经已授权的私有仓库写入者发表；网站不是独立 Drive/Mac 内容下载器。应明确证据来源。**发表这份新回执及任何正式归档需先展示精确文件范围并获确认。** 本候选不新建该文件，不正式归档、补母索引或新增上传。

## 并发保证范围

KV 是最终一致性存储，本轮没有强原子跨端 fencing。请求 ID 稳定、同 isolate 串行、同 run 幂等 claim、写后回读；原 `fulltext.yml` 的 concurrency 只串行 workflow 调度，不能防止后续 run 经另一 isolate 读到旧 submitted 并再 claim。两个独立 isolate 的旧值/延迟传播回归明确复现两个不同 claim_id，但二者均 hold、无执行许可。单次写后回读成功也不证明唯一领取。范围之外的并行合法身份、旧 consumer、Mac owner 冲突不能由 KV/OIDC 解决。

要对多 dispatcher 作独立强原子防重，另需获批的强一致性存储/fencing；本候选没有创建这些能力。即时一致 fixture 的“不同 run 不再领取”只适用于该 fixture，不能外推最终一致 KV。合成测试不冒充跨云实测。

## 主集成验收顺序与本轮证据

1. 先合并已有全文 A 的两个提交：`f5639914e2bff2cf841dd5306655d8333863cd4e` 和 `9081761da91d2524b2d2ddb1b2994db712770647`。后者修复 LFS pointer metadata.size 与原件 target size 混淆。主集成另负责忽略 Abort 的有界正文读取回归，本分支 B 不修改该读取函数。
2. 在既有安全口令入口核对 `/api/fulltext-source` 的真实配置/解析 SHA，再验证已存在的 JACC 原件复用。实际 Production 配置值本模块尚未读取，不能凭缓存 manual_needed 推断版本。
3. B 合版验收后，仅按已批准两项能力由唯一主发布启用上述变量。无需启用异步下载队列或添加调度。在 GitHub 私有仓库 Actions 的既有 `fulltext.yml` 手动选择 mode=`authorized_claim`，request_json 为仅 DOI 的 JSON；只取一次受控任务 artifact。没有任务应返回 null，不重复建立请求。
4. 将 task artifact 交原 Mac 执行者，先验 live proof、最新 canonical ledger 和 exact owner。缺安全浏览器工具/登录/跨执行者排他证据则 hold；可通过同 workflow 的 mode=`authorized_update` 回传明确 blocked 原因。网站入口不发送任意命令、不控制 Safari、不自动启动 consumer。
5. 已核验及各侧同步回执须来自实际机械证据；如需发表固定私有 receipt 文件，先确认该文件和正式归档的精确写入范围。使用既有 main workflow 的 `authorized_update`，不得将合成测试证明上传私有正式仓库。

本轮两个 syntax 检查、11 个 Node 功能/离线浏览器检查和 55 个 Python workflow/public build/package 检查通过。新增回归包括缺/错 owner/version/idempotency/batch、旧 815 ledger、过时 canonical 读取、Mac 离线、Drive 未读回/错根、三索引伪相同但不匹配实际 CSV、缺严格核验、401/403/429 持久暂停，以及前端所有接单状态不能制造下载可用。原始本地摘要 `.local/doi-validation/authorized-handoff-tests.txt`，合成回执不证明真实归档。

真实已有原件回读的脱敏证据见 `doi-execution-evidence-20261008.json`；598792 B / 13 页 / SHA 一致及严格核验通过。出版社新下载 0；本轮生产授权领取/回传 0，Mac consumer 0，canonical ledger 写入 0，正式归档写入 0。当前 Mac 没有支持的 Safari CUA 工具可调用，但不能据此说先前授权渠道坏了；目前仍不可声称订阅文献全自动闭环。

## 后续排他执行审批计划（未执行）

现有能力可复用：edge Worker 的口令/origin/额度保护、QL_KV 状态与已核 PDF 缓存；既有 private GitHub 只读身份读取固定版本 CSV/LFS/回执；同一 main fulltext.yml 的手动 OIDC principal 和私有 artifact；Mac 原 mechanical 下载器、严格核验器、canonical ledger 和本机锁。它们足以实现受控票据/状态/回执，本候选没有把只读 token 当写库权限。网站仍无 Mac/Safari 控制或独立 Drive/canonical 最新内容读桥。当前仓库配置未证实可复用的强一致领取服务，不能假设已存在或已授权。

若要跨 isolate 唯一领取，最小拟议增量是同一 Cloudflare 账号内一个独立 Worker `doi-claim-coordinator`、SQLite Durable Object 类/namespace `DoiClaimCoordinator` 和 dryz-xinzhi 的 `DOI_CLAIMS` DO binding（Production 与 Preview 隔离）。只存规范 DOI、request ID、owner、单调版本/fencing token 和状态，不存 PDF、索引正文、Cookie 或凭据；事务核对归属，不按超时自动放给第二个 owner。Pages 必须绑定独立 Worker 承载的 DO，不能直接在 Pages 项目里部署 DO。[Cloudflare Pages DO binding 官方说明](https://developers.cloudflare.com/pages/functions/bindings/#durable-objects)

需用户后续在安全界面批准的精确操作：在该账号创建/迁移该 SQLite namespace、发布这一 Worker、给指定 Pages 项目编辑这一 Production/Preview binding；现有 Pages 发布身份未必有 Worker/namespace 操作权限，不自动扩 token/OAuth。Worker 仅通过内部 binding 访问、不添加公网 route/调度。已有 GitHub 两动作的 principal/audience 保持不变；任何新执行者认证或桥接能力另列最小接收方/操作范围，不能搬 OIDC token/Cookie 到 Mac 或服务器。

费用取决于当前账号计划和用量，尚未读取账单或批准预算。SQLite DO 支持 Workers Free，超过免费限额会失败；若需要 Workers Paid，有基础月费（官方当前示例为至少 $5/月）及超过包含额度的请求、时长和存储费用。预算/限额必须在创建前确认，本轮未开通套餐、资源或计费。[Cloudflare DO 官方价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)

这项服务仍只约束遵守协议的执行者。Mac 可先增加指定唯一 consumer 的持久幂等/版本归属检查，配合原本机锁防该 Mac 重复消费；不能由此声称 Grok 或其他云互斥。任何潜在副作用执行者都须接入同一领取/版本校验协议，否则继续 hold；本轮不停止 Grok、不新建 consumer，也不解除 execution hold。实际安全浏览器授权和正式归档/回执写入的精确权限另需确认。

补充离线回归模拟两种独立 isolate 旧值/延迟双 claim 场景，两个包均 hold；完成回执不会产生 executorClaimed，runner/前端拒绝伪造执行许可。包含匿名/有效身份 stalled body、忽略 cancel、取消抛错、晚到 read、超限/read 错误；本次 claim 前/一小时前但请求后的账本证明、未来时间、错误 claim/proof/固定索引 commit；验证失败零 cache/paper/archive 写入并保留先前可用 PDF/部分归档状态。原始补充摘要 `.local/doi-validation/authorized-handoff-hold-tests.txt`。本轮无需新增强一致资源即可安全交付受控状态/回执候选，订阅自动执行链路仍 hold。
