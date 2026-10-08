# v14.2.18 生产口令 PDF 验收失败：第一诊断检查点

截至本检查点，生产源码仍 `30b16e81a4a6a65cc9d0154f2ba42599187d1a54`、实际保存部署 state 仍 `a03db83ac17843173288ae1187f1c81d271baafe`；.18 部署/回归/字节回读成功与这次真实下载失败是不同结果。B 合版和启用暂停，候选 `341747356734db003263f616079065e8befae5ef` 只在独立分支。

## 真实已知

用户在 .18 JACC `10.1016/j.jacc.2024.02.026` 的既有口令入口测试失败。父线程提供用户截图 `image(20261008-035640).png` 的识别文本：文献来源暂时不可用，请稍后重试；请在 5 分钟后手动重试，北京时间 2026-10-08 12:01:23 起。请求时间只能据此近似为 UTC 03:56:23，未取得 HTTP 状态码或 request ID。没有重新 POST、清缓存、删暂停或绕过限制。

上述精确文案映射 `LibraryFailure library_upstream`。正常 HTTP 401/403/429 在 .18 的 LFS batch/object 路径应走 `library_paused`、423 和暂停文案；指针/原件完整性失败应走 review。这排除了把截图直接解读为这些特定分支，但不能证明上游从未返回拒绝或已经到达 LFS。冷却 300 秒是应用 fallback，不能证明上游返回 Retry-After，不能证明网站固定了旧 commit、口令错误或 pointer size 再次错误。

## 可复查的阶段丢失

[实际源 libraryGithub](https://github.com/dodoxiaxia/xinzhi/blob/30b16e81a4a6a65cc9d0154f2ba42599187d1a54/edge/_worker.js#L549) 顺序包含 main commit 解析（未 pin 时）、母索引读取/解析/身份、PDF Contents metadata、raw pointer/blob、LFS batch、object 与最终完整性。索引 miss 本身是 null/manual_needed，不等于此次错误。

[handleAcquire 来源 catch](https://github.com/dodoxiaxia/xinzhi/blob/30b16e81a4a6a65cc9d0154f2ba42599187d1a54/edge/_worker.js#L951) 对配置/paused 单独抛出，对 identity/integrity/index 分类 review；其余 `pdf_upstream`、`pdf_timeout`、`pdf_not_found`、`pdf_too_large` 或未知异常归 sourceUnavailable。随后保存泛化的 library_upstream 并重抛相同错误，原阶段、code、HTTP 状态没有保存。后续 attempt 记录又只留该泛化 code 和默认冷却。因此现有页面及已保存通用状态不足以回溯具体失败阶段。

正常流程的可能具体错误包括：索引请求网络/响应错误；Contents file 404；单个请求/正文超时；batch JSON/object/error/transfer；action URL 或非空 headers 被安全拒绝；object 请求网络错误。这里是代码枚举，不是本次已观测事实。不会扩大 host/action headers 或改校验来试错。

## 独立离线检查点，不冒充生产原因

独立审查发现 HTTP 200 LFS batch 若含 `object.error.code=403/429`，当前 `pdfGithubBytes` 会因 object.error 抛 pdf_upstream，而非 library_paused；最终出现 generic library_upstream 与 300 秒冷却。该嵌入拒绝分支没有被此前 HTTP status fixture 覆盖。其反例与安全分类修复应单独验收，不据此断定本次实际 batch 内容。

## 观测缺口与下一步

本执行器没有 Cloudflare 配置/运行日志工具或支持的已登录安全口令上下文。一次 `/api/library?doi=…` 的现有网页工具读取返回不可访问，未换域名/身份/工具绕过。已有 GitHub 部署日志仅证明部署及 state 保存，不含本次边缘请求日志。最新生产 PDF_GITHUB_COMMIT 保持未知，不以旧配置读回替代。

已请用户只做一次既有 [全文来源版本快检](https://learn.dryz.info/api/fulltext-source?doi=10.1016%2Fj.jacc.2024.02.026)：在网站内输入既有口令，返回 configuredCommit/resolvedCommit/candidateFound 或 error。此入口不下载 PDF、不写缓存；不聊天索密。该结果可先区分索引/版本与文件/LFS后续路径，不要继续盲试下载。若仍只有泛化 error，就需要现有安全控制台中本次请求日志，或先合入仅保存白名单 stage/code/status 的诊断候选；禁止日志含 token、口令、私有路径、签名 URL 或 response body。

真正生产根因在本检查点仍未确认。继续保留已有有效缓存和暂停，不将离线 mock 成功或作者其它凭据上下文的 PDF 回读当作此次口令成功。
