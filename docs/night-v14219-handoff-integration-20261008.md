# v14.2.19 候选：受控授权交接，执行保持 hold

基线为已发布 v14.2.18 源 `30b16e81a4a6a65cc9d0154f2ba42599187d1a54`、实际 state `a03db83ac17843173288ae1187f1c81d271baafe`。合入作者 `0eb91c69d49d87434892b69817432d5e574bf535` 和修订 `58c93bcde81da9b67fb7e58d2b5b4e064c3bcc45`；保留主发布在 .18 的 LFS ignored-Abort 期限修复。完整回归、最终构建和独立安全结论以固定源码验收为准；本说明不确认生产发布或开关已启用。

用户已批准原 main fulltext 工作流 OIDC 的 authorized_claim / authorized_update 两能力。沿用原 audience、issuer、repo/repository_id、workflow_ref、ref/sub 和 github-hosted 限制；新动作仅允许 workflow_dispatch，原 queue 权限不扩张。没有新 token、存储绑定、协调器、定时计划或 Mac 命令接口。

基础 OIDC 认证先于 request.body 读取。通过认证后 JSON 正文至多 1,024 B、5 秒，读取和取消不响应也必须有界退出；JWKS 响应头和正文也有界。新增回归覆盖匿名 stalled body 立即拒绝且不读 body、有身份 stalled body、忽略取消、late read、超限及同步取消异常。

KV 最终一致性不能排除跨 isolate 双 claim。所有交接包、公开状态及处理回执固定 execution_state=hold、ready_to_execute=false、hold_reason=exclusion_unverified、executorClaimed=false；runner 拒绝篡改后的可执行包。两 isolate 的陈旧/延迟读取回归承认可能不同 claimId，不将票据当作执行许可。ledgerLatestVerified=false，不把五分钟指纹和最低账本条数当作最新跨端排他证明。

回执必须绑定当前 claimId、dispatcherRunId、claimProof；canonical ledger 校验时间必须晚于本次 claim 且在当前五分钟内，保留 owner/version/idempotency/batch、snapshot hash/bytes 等核验。失败 complete 在所有 proof/索引/三侧证据通过前不写 PDF 缓存、题录或 archiveComplete。合法回执仅证明指定版本的执行者证据及网站 GitHub 回读，不能授予启动 consumer 的权限。

现有订阅 consumer 必须等真实排他安全和支持的授权浏览器齐备，当前仍 hold。本候选不创建私有 canonical receipt、不修改正式归档、母索引或账本。真实 LFS 生产口令下载和最新 PDF_GITHUB_COMMIT 仍待原 .18 安全入口验收。

## 仅两个指定开关的配置途径与当前缺口

明确允许的最终目标只有：Cloudflare `dryz-xinzhi` **Production** `FULLTEXT_AUTHORIZED_HANDOFF_ENABLED=true`；GitHub `dodoxiaxia/xinzhi` **repository Actions variable** 同名 `true`。保留原 `FULLTEXT_ASYNC_ENABLED` 状态。审查及最终代码门禁未通过前，两者都不变更。

当前执行器可通过现有 GitHub 连接读源码、run 和日志并通过授权 git 路径发布；没有 Cloudflare 配置读写工具、GitHub repository variable 写工具、可调用的插件目录搜索，或受支持的已登录控制台上下文。先前变量 API 403 不通过其它身份重试。仓库现有 daily 发布步骤只是 `wrangler pages deploy`，没有设置环境变量的功能；工作流现有 GITHUB_TOKEN 权限也不含 Variables write。不会读取或复制它及 Cloudflare token 值，不创建新身份或扩大权限。

因此目前不能声称两个开关已设置，或当前 FULLTEXT_ASYNC_ENABLED / PDF_GITHUB_COMMIT 已取得精确读回。生产合版还应核对 fulltext workflow 的旧 queue 是否会因源码 push 启动；在该风险对应的既有非秘密配置证据齐备前，不能仅凭旧 skipped run 推定当前关闭。

审查通过后的最小用户操作是仅在既有登录控制台设置两个非秘密文本值，并确认保存结果：

1. [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → dryz-xinzhi → Settings → Variables and Secrets → Production，添加/更新 `FULLTEXT_AUTHORIZED_HANDOFF_ENABLED` 为文本 `true`，保存；不改其它变量。配置和生产部署生效顺序需以本次实际部署证据确认。
2. [xinzhi Actions variables](https://github.com/dodoxiaxia/xinzhi/settings/variables/actions) → Repository variables，添加/更新同名变量为 `true`，保存。不要创建同名 Secret、environment-scoped 变量或新 token。

仅反馈两值及原 FULLTEXT_ASYNC_ENABLED 的非秘密状态，不发送网站口令/token。收到实际配置证据且独立审查无阻断后，唯一主发布按已批准范围部署/核验；真实 consumer 保持 hold，不凭票据启动。不会通过未经批准的新 DO/Worker 或常驻协调器补缺口。

官方依据：[Pages 环境变量与控制台路径](https://developers.cloudflare.com/pages/functions/bindings/#environment-variables)、[GitHub repository variable 写权限](https://docs.github.com/en/rest/actions/variables#update-a-repository-variable)。这两个来源说明支持的配置和权限要求，不证明当前连接拥有该权限或指定值已经生效。
