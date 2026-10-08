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

网站 POST 必须通过既有全文口令、origin 与额度保护。KV 请求 key 按规范 DOI 固定，ID 为 `request-` 加 DOI SHA256 前 32 位。同一 DOI 并发提交对应同一请求 ID，原票据保留，不新建第二个下载账本。

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
  "fencing_guarantee": "single_controlled_dispatcher_only",
  "official_url": "https://doi.org/10.1000/example",
  "batch_id": "website-request-0123456789abcdef0123456789abcdef",
  "source_policy": "existing_then_oa_then_authorized",
  "ledger_requirement": "existing_canonical_ledger_exact_owner_or_hold",
  "executor_claimed": false,
  "archive_complete": false
}
```

`owner`、`request_version`、`idempotency_key` 必须使用后端上述值，Mac adapter 不得由客户端默认补造。owner 是受控 dispatcher 归属，不能用它覆盖 Mac 既有 `owner_queue`；request_version=1 是不可变请求描述的版本，不是全局原子 fencing generation；idempotency_key 将此次 handoff 绑定网站唯一 DOI 请求。

执行者先核对后端活态：仅 GET 固定 `https://learn.dryz.info/api/library?doi=规范DOI`，必须 id/doi 相同、state=`claimed`、requestVersion 相同，并比对 `handoff.claimProof`。proof 算法为 SHA256(UTF-8 compact JSON array)，按顺序：`[website_request_id, claim_id, dispatcher_run_id, doi, title, owner, request_version, idempotency_key, batch_id]`。claim_id 由后端随机生成，只在私有交接包里出现；公开接口仅给 proof，不给 claim_id。必须拒绝缺字段、任一字段改变、活态不匹配或无法读回。proof 是后端票据对应证据，不赋予下载或账本写权限，也不替代跨端互斥。

这只证明受控 dispatcher 领取交接票据。Mac 原任务必须先在**当前 871 项及后续最新账本**核对 canonical DOI、`owner_queue`、已有侧和 `website_request_id`；不能用旧 815 项覆盖，也不能仅凭本机 lock / exit 0 宣称跨端领取成功。已有别的 owner 且仍需获取时 hold，不直接消费。缺有效跨执行者排他证据或安全授权浏览器工具时保持 hold/manual-needed，不调用正式下载 consumer。原 `run_download.py --batch-id … --doi … --title … --limit 1` 的单篇执行范围不变；获准运行的 adapter 负责把 request id 保留在 record.item 并证明归属。

任务包是私有 workflow artifact，经主会话交现有 Mac 任务。无自动 Mac 唤醒接口、无新 consumer/scheduler。原 consumer.lock/ledger.lock 只保证本机；网站请求表不替代 canonical 领取账本。

## 进度回传

由同一受控 main workflow 以新一期短期 OIDC 提交；没有把 OIDC token 或网站口令交 Mac。`claim_id` 是关联 ID，不能替代 OIDC 身份。

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

回执固定字段：version、website_request_id、batch_id、doi、title；ledger.key / owner_request_id / items / handoff_owner / request_version / idempotency_key / canonical / snapshot_sha256 / checked_at；content.sha256 / bytes / pages；verification.verified=true、method=`dual_parser_all_pages_title_doi`；sides.mac / github / drive；indexes.mac / github / drive 的 SHA256。ledger.items 至少 871（仅拒绝已知过时快照，不能证明永远最新），canonical 必须 true，snapshot_sha256 是实际最新账本读取的内容指纹；checked_at 必须不早于请求且不超过当前时间五分钟。adapter 仍须实际读取当时的最新 canonical 账本，禁止凭最低计数推断最新。handoff_owner/request_version/idempotency_key/batch_id 必须匹配领取包。

每侧须有 verified、同 content SHA/bytes。Mac 另须 identity_verified；GitHub 须 commit，网站会按该 immutable commit 再读真实母索引和该篇原件核验 hash；Drive 须 dryz@dryz.info、content_read_back=true、真实 file_id、已确认私有 root_id。三个母索引 SHA 必须一致，GitHub 母索引 SHA还必须与网站实际读到的相符。增量候选可以复用全文，但母索引尚未登记不能标三端 complete。

回执来自唯一执行者对三侧实际读回的机械证据，经已授权的私有仓库写入者发表；网站不是独立 Drive/Mac 内容下载器。应明确证据来源。**发表这份新回执及任何正式归档需先展示精确文件范围并获确认。** 本候选不新建该文件，不正式归档、补母索引或新增上传。

## 并发保证范围

KV 是最终一致性存储，本轮没有强原子跨端 fencing。请求 ID 稳定、同 isolate 串行、同 run 幂等 claim、写后回读；原 `fulltext.yml` 全工作流 `xinzhi-fulltext-queue` concurrency 为唯一跨 dispatcher 串行入口。领取不自动过期或转给另一个 owner。范围之外的并行合法身份、旧 consumer、Mac owner 冲突不能由 KV/OIDC 解决，必须拒绝/协调，不能称全局原子防重。

要对多 dispatcher 作独立强原子防重，另需获批的强一致性存储/fencing；本候选没有创建这些能力。验收分别报告并发同 DOI 一票据、同 run 一领取、串行不同 run 不再领取和 stale 回读拒绝；不能把 mock 当成跨云实测。

## 主集成验收顺序与本轮证据

1. 先合并已有全文 A 的两个提交：`f5639914e2bff2cf841dd5306655d8333863cd4e` 和 `9081761da91d2524b2d2ddb1b2994db712770647`。后者修复 LFS pointer metadata.size 与原件 target size 混淆。主集成另负责忽略 Abort 的有界正文读取回归，本分支 B 不修改该读取函数。
2. 在既有安全口令入口核对 `/api/fulltext-source` 的真实配置/解析 SHA，再验证已存在的 JACC 原件复用。实际 Production 配置值本模块尚未读取，不能凭缓存 manual_needed 推断版本。
3. B 合版验收后，仅按已批准两项能力由唯一主发布启用上述变量。无需启用异步下载队列或添加调度。在 GitHub 私有仓库 Actions 的既有 `fulltext.yml` 手动选择 mode=`authorized_claim`，request_json 为仅 DOI 的 JSON；只取一次受控任务 artifact。没有任务应返回 null，不重复建立请求。
4. 将 task artifact 交原 Mac 执行者，先验 live proof、最新 canonical ledger 和 exact owner。缺安全浏览器工具/登录/跨执行者排他证据则 hold；可通过同 workflow 的 mode=`authorized_update` 回传明确 blocked 原因。网站入口不发送任意命令、不控制 Safari、不自动启动 consumer。
5. 已核验及各侧同步回执须来自实际机械证据；如需发表固定私有 receipt 文件，先确认该文件和正式归档的精确写入范围。使用既有 main workflow 的 `authorized_update`，不得将合成测试证明上传私有正式仓库。

本轮两个 syntax 检查、11 个 Node 功能/离线浏览器检查和 55 个 Python workflow/public build/package 检查通过。新增回归包括缺/错 owner/version/idempotency/batch、旧 815 ledger、过时 canonical 读取、Mac 离线、Drive 未读回/错根、三索引伪相同但不匹配实际 CSV、缺严格核验、401/403/429 持久暂停，以及前端所有接单状态不能制造下载可用。原始本地摘要 `.local/doi-validation/authorized-handoff-tests.txt`，合成回执不证明真实归档。

真实已有原件回读的脱敏证据见 `doi-execution-evidence-20261008.json`；598792 B / 13 页 / SHA 一致及严格核验通过。出版社新下载 0；本轮生产授权领取/回传 0，Mac consumer 0，canonical ledger 写入 0，正式归档写入 0。当前 Mac 没有支持的 Safari CUA 工具可调用，但不能据此说先前授权渠道坏了；目前仍不可声称订阅文献全自动闭环。
