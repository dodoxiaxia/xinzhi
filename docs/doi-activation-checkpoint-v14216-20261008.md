# DOI 专项当前可用基线与门禁检查点

已发布主基线 `9b5e65ae042a8c0d583acc8fd1edbaee816de36c`（v14.2.16），state `86aa095d746257f3f7bc04acd5f11bcab52107b4`；[实际发布回执](night-v14216-release-receipt-20261008.md)。根集成在做紧随的单篇内容 .17，没有修改 DOI/PDF/异步下载接口。DOI 专项 `01a115ba` 与 Mac 只读专项 `01a114b9` 已由父线程重启；此文提供源码与历史配置证据，不能代替他们的最新在线检查。

当前输入 DOI 的既有库快检、公开元数据识别、受保护私有归档读取与新的订阅下载任务是不同结果。不得把已有库返回、green/skipped、pending=false 或 OA 路径当作真实订阅原文领取完成。

## PDF 版本

[只读配置检查 37708828296](https://github.com/dodoxiaxia/xinzhi/actions/runs/37708828296) 在本轮较早已确认 production/env_vars 存在、共 7 项，`PDF_GITHUB_COMMIT` 未设置；未读取其他环境值/秘密。root 后续 .14/.15/.16 未修改此配置。当前 [libraryGithub](https://github.com/dodoxiaxia/xinzhi/blob/9b5e65ae042a8c0d583acc8fd1edbaee816de36c/edge/_worker.js#L492) 默认解析私有仓库 main 的当前 SHA，只有显式提供 PDF_GITHUB_COMMIT 才固定版本。因此已有证据不支持把阻塞归因为“固定旧 PDF SHA”；专项若发现当前显式设置，应核对该唯一非秘密值与已验收私有归档版本，不读取 token。

## job_disabled 的确定含义

[handleFulltextWorker](https://github.com/dodoxiaxia/xinzhi/blob/9b5e65ae042a8c0d583acc8fd1edbaee816de36c/edge/_worker.js#L806) 在认证前检查 Pages `FULLTEXT_ASYNC_ENABLED === 'true'`，否则返回 503/job_disabled。[pending](https://github.com/dodoxiaxia/xinzhi/blob/9b5e65ae042a8c0d583acc8fd1edbaee816de36c/edge/_worker.js#L817) 在同一开关关闭时返回 pending=false，不能据此认为不存在任务。[GitHub 下载 workflow](https://github.com/dodoxiaxia/xinzhi/blob/9b5e65ae042a8c0d583acc8fd1edbaee816de36c/.github/workflows/fulltext.yml#L21) 还分别要求 repo variable FULLTEXT_ASYNC_ENABLED=true。

旧生产检查实返 job_disabled；dispatcher 的旧部署失败已在既有交接记录。本次 API 发布不启用这两个开关或 dispatcher，因此不能声称订阅领取已打通。本执行器没有 callable Cloudflare 配置工具；既有 repo variable 查询 403 属权限边界，不能借重试、换凭据或加 token 绕过。Cloudflare 1010、安全拒绝/转 Codex NOT_FOUND 均不绕过。

## 最小下一动作

1. 由 DOI/Mac 专项或有现有管理员权限的人，只读确认 Pages production 与 GitHub repo 两处 FULLTEXT_ASYNC_ENABLED、现有唯一 consumer 的锁/会话/调度，以及既有归档和公开任务回执。不要只验证按钮或 OA。
2. 若 consumer 能实际领取且两端仅因关闭开关受阻，具体接线是用现有权限设置这两个已有非秘密值为 true，并使用现有受控 job 领取/回写；不新建 token、权限或 cron。若现有管理员读取/修改失败，明确报告被拒动作及所需的最小现有设置操作，停止在门禁上循环；不要先排队大量 DOI。
3. 只有通过真实、获授权订阅文献领取与 archive 回执、私有 GitHub 版本/SHA 回读，并验证前台缓存/索引状态后，才能报告该 DOI 已完成。Mac 仍是归档目标，尚未授权新文下载的只读审查不越界。

不请求无依据的全站权限扩展，也不在当前仍未知 consumer 事实时提前开启生产队列。当前“输入 DOI 查全文”尚不能称所有订阅路径已经完成；API .16 发布成功不证明下载 consumer 已激活。
