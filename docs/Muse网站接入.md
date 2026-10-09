# Muse 接入知新文献库

网站：https://learn.dryz.info/ 。本协议让现有 Muse 定时领取读者提交的 DOI，下载原件、上传原私有 Drive「文献」收件箱，并回传原件。网站另行核验 PDF 后提供受全文口令保护的下载。Muse 不需要对外 Webhook。

可直接转发给 Muse 的在线协议：https://learn.dryz.info/api/muse/protocol 。网页同时显示实际是否已启用；机器 GET 返回 JSON 协议，不读取任务或原件。

## 先在私密配置中完成这一步

Cloudflare Pages 项目 `dryz-xinzhi` 的 Production 环境设置：

| 配置 | 内容 |
| --- | --- |
| `MUSE_FULLTEXT_ENABLED` | 字符串 `true` |
| `MUSE_FULLTEXT_KEY` | 独立随机密钥，32–128 位，仅英文字母、数字、下划线或短横线；建议 32 个随机字节编码为 base64url |
| `GROK_FULLTEXT_ENABLED` | 关闭或字符串 `false` |
| `FULLTEXT_ASYNC_ENABLED` | 关闭或字符串 `false` |

把同一个 `MUSE_FULLTEXT_KEY` 保存在 Muse 的私密配置。不要发给 Codex、粘贴到聊天、写入代码或 URL；不要使用汉堡密码、Cookie、GitHub token 或网站全文口令代替它。继续保留已有 `QL_KV` 与 `PDF_DOWNLOAD_ENABLED=true`。保存后重新部署 Production，并确认在线协议显示“已启用”。本协议不读取或修改汉堡会话，也不新增 GitHub/Drive 写凭据。

开关未设置时，Muse 领取与读者派发保持关闭。GitHub 的核验任务使用短时 OIDC，只能核验已上传原件，不持有 Muse 密钥。既有全文导入使用另一独立 OIDC 范围。

生产 GitHub 已启用 immutable subject。网站接受精确的既有默认主分支身份，以及 `repo:dodoxiaxia@214921265/xinzhi@1397425558:ref:refs/heads/main`；同时固定签名、issuer、audience、仓库及 ID、主分支、GitHub 托管 runner 和专用工作流。没有改变 GitHub 认证模板或放宽到其他账户、仓库、环境、分支。导入先检查 `protocolVersion:5`、Muse 核验先检查版本 3 部署就绪，再申请短时令牌。

Cloudflare 运行时取 GitHub 公钥失败时，优先使用随 Worker 发布的官方公钥缓存。既有发布任务从唯一官方 HTTPS 地址刷新公钥，验证 RSA/算法/用途/标识及强度，缓存有效期 24 小时；仅放当前发布器的 `.local`，不从 state 恢复信任材料。过期或未知公钥仍需成功取钥并验签，否则拒绝认证。复用原发布周期，增加正常客户端 User-Agent，未关闭 TLS、签名或网络防护；公钥不是凭据。

Cloudflare Workers 只接受 `redirect:"manual"` 或 `"follow"`。公钥、LFS 和既有 Bot 派发均使用 `manual`，收到重定向立即拒绝；仅既有 GitHub Contents 的固定路径跳转按原白名单处理。真实 workerd 回归使用合成原件和本地模拟来源，不访问外网，检查身份签名、LFS 原件回读、3xx 拒绝及 401/403/429 停止。

## 直接交给 Muse 的任务说明

以下是 Muse 要的五项信息和完整执行约定，可以转发本节。密钥在上一步私密配置中交接。

1. 网站是 `https://learn.dryz.info/`。所有 Muse 机器请求带 `Authorization: Bearer <私密配置中的 MUSE_FULLTEXT_KEY>`，禁止把密钥放入查询参数、日志或结果。读者照常在网站表单输入全文口令。
2. 待办通过 `POST https://learn.dryz.info/api/muse/claim` 领取；`Content-Type: application/json`，请求正文 `{}`。每次只领一篇，返回 `{"ok":true,"task":null}` 表示没有待办；有任务时返回下述 JSON。
3. 进度和完成信息 `POST https://learn.dryz.info/api/muse/receipt`，JSON 结构见下；PDF 原件另行 `PUT https://learn.dryz.info/api/muse/upload`。只返回私有 Drive 链接不能完成网站导入。
4. 建议每 10 分钟轮询一次。无任务静默，有失败或需重新登录才通知维护者。建立一个定时任务，禁止重复建立或与现有下载流程并行领取。
5. 每轮最多三篇，串行处理。每篇结束后再领下一篇。按 DOI 复用现有 Muse 下载结果和原领取账本，已有文件不再次从出版社下载。

领取响应示例（`taskId`、`leaseId` 必须使用网站当次返回的值）：

```json
{
  "ok": true,
  "task": {
    "schemaVersion": 1,
    "taskId": "00000000-0000-4000-8000-000000000001",
    "doi": "10.1016/j.jacc.2024.02.026",
    "title": "The Natural History of Atrial Functional Mitral Regurgitation",
    "leaseId": "00000000-0000-4000-8000-000000000002",
    "leaseUntil": "2026-10-09T12:20:00.000Z",
    "idempotencyKey": "doi:10.1016/j.jacc.2024.02.026",
    "sources": ["open_access", "authorized_hamburg"],
    "institutionLoginUrl": "https://login.emedien3.sub.uni-hamburg.de/han/ScienceDirectElsevierJournalBackfiles",
    "institutionUrl": "https://dx-1doi-1org-10039f8q70087.emedien3.sub.uni-hamburg.de/10.1016/j.jacc.2024.02.026",
    "receiptUrl": "https://learn.dryz.info/api/muse/receipt",
    "uploadUrl": "https://learn.dryz.info/api/muse/upload"
  }
}
```

执行约定：

- 先检查现有原件和领取账本，再沿用现有 `lit-download` 的开放获取和已授权汉堡浏览器流程。仅使用领取响应的 `sources`；不使用 Sci-Hub 等其他来源。网站不接收汉堡账号、密码、Cookie、登录截图或临时下载 URL。
- 每五分钟回传一次 `state:"running"`，续当前任务的 20 分钟租约；一次获取最长两小时。不因网站响应丢失或租约过期另领同一 DOI、另开下载消费者。
- 遇到重新登录，回传 `state:"login_required"` 并通知维护者在原 Muse 授权浏览器处理。登录确认后可用原 `taskId`/`leaseId` 回传 `running` 恢复（任务创建后 24 小时内）。不定期刷新 Cookie，不猜测会话时长。
- 下载原件需核实 `%PDF-`、完整页面、首页 DOI/题名、非错误页。保留原字节，不重写、压缩、转换、加水印或“修复”PDF。上传 Drive 时保持私有。
- 上传 Drive 后，计算同一原件的 SHA256 与字节数，回传 `uploaded`；随后上传完全相同的原字节。失败回传 `failed`，先核查原因，不能盲目重试出版社或自动创建替代任务。
- 401/403/409/413/415 立即停止本任务并通知维护者；来源拒绝、验证或限流同样停止，不换客户端、代理或地址绕过。只有存储同步待确认的 503 可以在保留原文件和原任务的前提下稍后回传/上传，不能重新下载。

进度 JSON：

```json
{
  "taskId": "<网站返回 taskId>",
  "doi": "<网站返回规范 DOI>",
  "leaseId": "<网站返回 leaseId>",
  "state": "running"
}
```

`state` 还可为 `login_required` 或 `failed`；此时不附 PDF 字段。完成 Drive 上传后的 JSON：

```json
{
  "taskId": "<网站返回 taskId>",
  "doi": "<网站返回规范 DOI>",
  "leaseId": "<网站返回 leaseId>",
  "state": "uploaded",
  "sha256": "<PDF 原件的 64 位小写 SHA256>",
  "bytes": 598119,
  "driveFileId": "<Drive 文件 ID，不是链接>"
}
```

原件上传使用 `PUT /api/muse/upload`，正文直接为 PDF 的二进制，**不使用 JSON/base64/multipart**；以下头必须齐全：

| 头 | 内容 |
| --- | --- |
| `Authorization` | 独立 Muse Bearer 密钥 |
| `Content-Type` | `application/pdf` |
| `X-Muse-Doi` | 领取响应的规范 DOI |
| `X-Muse-Task-Id` | 领取响应的 taskId |
| `X-Muse-Lease-Id` | 领取响应的 leaseId |

原件范围 50 KiB–10 MiB。网站核对传输长度、SHA256、PDF 首尾和存储回读后先进入私有候选区，返回 `verified:false`。不要把这一步当作全文已可下载。网站独立任务每小时第 23 分钟核验候选；实际 GitHub 排队会增加等待时间。两种解析器分别检查所有页面并渲染、确认首页 DOI 和题名（最多 200 页）。通过后网站才显示下载按钮，失败显示待核验。

## 读者使用

启用配置后，原“获取全文”入口自动进入 Muse 任务页。网站只读取官方 DOI 元数据、写入待办；Muse 定时领取。重复读者请求复用同一任务；已经可用的 PDF 直接下载。公开状态响应不包含密钥、租约、私有 Drive ID、正文或机构会话。PDF 仍需原全文口令，普通 GET 不返回文件。

没有在此环境代建 Muse cron；转发上述任务说明后，由已有 Muse 建立或更新其唯一任务。上线代码或空队列核验成功不能证明 Muse 私密配置、真实领取或真实回传已完成。

## 样本与正式归档边界

本次样本 DOI `10.1016/j.jacc.2024.02.026`、题名 *The Natural History of Atrial Functional Mitral Regurgitation*。Muse Drive 原件 598119 字节，SHA256 `1a0bf6de7ddc5aa9711d8e280b5fa98b72957d040d4858548140131f03f88af5`，13 页核验通过。原 AI- 库既有副本 598792 字节，SHA256 `e09bac70ec8e828f7927c36a724c59dd29114f6f6a397a4d136af4fe498024b1`；两份 13 页逐页正文和渲染像素一致，字节不同。保留两份原件，网站优先复用既有 GitHub 副本，不覆盖原库。

`editorial/fulltext-imports.json` 固定原 GitHub commit、DOI、校验值；独立导入工作流重新读取该 commit 母索引和真实 PDF/LFS 对象，并在网站缓存回读成功后确认。不会调 Muse、OA、出版社或 GitHub/Drive 写接口。

Muse「文献」是私有收件箱，不是正式 Drive「mac文献-三端同步」。网站可下载只说明网站缓存核验成功；不等于原 20 列母索引、Macmini、GitHub、正式 Drive 全部归档。所有 API 保持 `archive.complete:false`；Muse 的 Drive 上传仅记为 `reported`。正式三端工作继续按原归档所有者与核验流程执行，本接入不删除文件、不切换归档所有者、不新增原库下载消费者。
