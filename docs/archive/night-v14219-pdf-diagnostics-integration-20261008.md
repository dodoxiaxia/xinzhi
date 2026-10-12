# v14.2.19 候选：真实 PDF 失败的安全阶段诊断

基于已部署 .18 `30b16e81a4a6a65cc9d0154f2ba42599187d1a54` 和实际 state `a03db83ac17843173288ae1187f1c81d271baafe`，不纳入 OIDC 接单桥候选。用户在 UTC 03:56:23 左右的 JACC 既有口令测试实际失败；精确页面文案对应 library_upstream 和应用默认 300 秒冷却。原部署和离线测试成功不能代替这次真实成功。

原 handleAcquire 将 index/Contents/LFS 等底层非身份错误折叠为 library_upstream，KV 也没有保留 stage/code/HTTP；历史失败阶段无法从原记录恢复。原母索引/真实 PDF 在其它授权上下文的回读仅证明既有原件存在，不能证明本次生产配置、凭据或链路成功。

本候选仅补最小观测和准确错误分类：既有口令成功授权后的失败响应返回白名单阶段、枚举 reason/errorCode、HTTP/对象级 code、UUID 请求编号和时间；正文 timeout 保留来源阶段。不得包含 URL/query、签名 URL、private path、token、口令、响应 body 或 raw exception。现有 KV 保存有期限的脱敏诊断，失败写入 best effort，不覆盖原业务错误、可用缓存或旧 paused 记录。

既有 `/api/fulltext-source` GET 仍只显示口令表单；POST 授权后只读配置及 lastDiagnostic，历史未记录须 explicit unavailable，不制造 stage。只读失败也保留允许的非秘密配置证据；发现 paused 时不得访问来源或清暂停，始终零写/零 PDF。公开 `/api/library` 的 found:false 与 found:true 统一安全 paused/error 信息，不公开受保护诊断。

离线反例已确认 HTTP200 batch 对象内 error403/429 原会错误地转成 generic+300秒，0 object GET/0 PDF writes。新分类须与直接 HTTP401/403/429 一样永久暂停，不建立默认自动恢复；这不是本次已确认生产根因。LFS object host/action header/redirect/所有 blob/原件 hash 与 size 约束不放松。`/api/acquire` 与 `/api/fulltext-source` 的单次12秒请求/正文超时和总45秒任务超时分别记录；忽略 Abort/cancel 仍有界退出。经典 `/api/pdf` 保持原有逐请求12秒限制，此版不宣称为该旧入口补上总45秒限制。OA 回退中被捕获的真实失败诊断须保留，不能用随后成功但无全文的元数据响应覆盖其 HTTP/原因。

本候选的源码、回归、真实 state 构建及独立审查以最终固定 SHA 为准。没有模型请求、真实 PDF/出版社下载、清缓存、删暂停、配置修改、正式归档、账本写入、新调度、权限或绑定。真实生产 root cause 仍需既有只读快检/安全日志或修订后一次受控测试定位，不宣称诊断功能即修好实际原文获取。

同时合入用户明确指定的最小侧栏修订，作者 `0f3a2be542a1a42b307e4c194554c701cde7f08e`，本候选 cherry-pick `2158292`。仅移除出版方/期刊侧栏的 IF/JCR/来源展开块，保留刊名、篇数和键盘筛选；其他位置的指标不变。`scripts/test_journal_ui.py` 验证 1440/390/320 宽度的筛选和无横向溢出，截图只代表本地实际候选构建，不能代替真实手机检查。

当前执行器无法访问生产状态的网页工具，没有 Cloudflare 配置/运行日志或支持的已登录口令上下文。最新 PDF_GITHUB_COMMIT 未读取，不以旧快照代替。用户只在网站内输入既有口令，不在聊天、日志或公开 issue 提交凭据。B 接单桥保持暂停，真实 consumer 不启动。
