# v14.2.1 最小发布解耦候选（未发布）

基于已固定的 UI/断点合版 `b316007580476a5016c20e4a81ae54cb962df919`；其 main 父提交是 `12701e17e71eb3c2eb1f76cfc42766d352e5a5a8`，另一父提交是 `9918c8c67ade43e49a88aa6fe8bc9bc39cc23eaf`。本候选仅增加下面11文件增量，不重新覆盖整份旧主线。未推 main/state、未发布、未触发 Actions、未设置变量或读取/扩大凭据。

## 具体范围

| 文件 | 改动 |
|---|---|
| `.github/workflows/daily.yml` | 移除 Cloudflare 全文调度器 deploy/readiness 步骤；保留原 Pages 命令、权限、日更时间、restore 租约、部署/保存状态条件与六文件门禁；加入新增离线回归。 |
| `.github/workflows/fulltext.yml` | 下载 job 需 main 且非秘密仓库变量 `FULLTEXT_ASYNC_ENABLED=true` 才运行，默认跳过。 |
| `edge/_worker.js` | 只有 Worker 配置字面字符串 `FULLTEXT_ASYNC_ENABLED=true` 时才能展示任务、入队、领取或执行；默认恢复即时查证/获取/保存与缓存下载。关闭时 pending=false、worker POST 返回 job_disabled，不读取/删除排队记录，不请求 OIDC/JWKS。 |
| `app.js` | 没有真实活动任务时使用“尝试获取文献”文案，不宣称已提交后台或关页后继续。真实任务轮询代码仍保留。 |
| `scripts/build_public.py` | 候选版本 v14.2.1，不更改公开字段、内容输入或构建守卫。 |
| `scripts/test_fulltext_jobs.cjs` | 既有队列测试显式启用，继续测试真实队列/OIDC/租约/回传/重试。 |
| `scripts/test_fulltext_activation.cjs` | 六种未启用配置验证无队列/身份副作用、保存既有任务、口令保护、即时成功与显式启用去重。 |
| `scripts/test_release_decoupling.py` | 解析实际 workflow 门槛；验证只部署 Pages、保留原日更及 state/public 检查、调度器源码原字节未变。GitHub Actions 字符串比较不区分大小写，与 Worker 字面值比较不同；配置统一使用小写 true。 |
| `README.md`、`docs/DOI按需全文与补录.md`、本文 | 明确未发布状态、默认行为、队列与归档范围、风险、回滚与独立验收条件。 |

`workers/cron-dispatch/index.js`、`workers/cron-dispatch/wrangler.toml` 和调度器测试保持 b316 原字节。本轮未部署这些文件，也未修改现网 Cloudflare timer；仓库中保留 PR6 的队列设计不代表已切换现网 daily 兜底。公开1268快照、日期政策、模型证据校验、账本/暂停、缓存、24篇榜及其覆盖保持 b316 原字节。

## 来源任务与范围

独立任务 `01a1152b-e819-73bf-9934-bf37086780f5` 的 PR6 / main12701开发了网站后台队列与 GitHub OIDC runner；运行37612765941在 xinzhi-cron 的 Cloudflare service 权限处失败，Pages/state skipped，未验收为上线。该任务等待用户处理既有权限，双方协调信息尚未成功送达，不能说已有双方约定。本 UI 候选不重试 Denied 服务、不申请新 token、不扩权或更换调度器职责。

PR6 的 runner 仅通过 OIDC 领取/运行边缘服务任务，PDF 保存到 QL_KV；不是815或 GitHub/Drive/Macmini 三端归档执行者。processed:0/waiting_for_website_deploy 的绿灯、关闭队列后的 skipped、离线 synthetic PDF 回传都不证明真实下载完成。

## 离线验证及诚实边界

新增激活回归、既有队列/OIDC回归与3项解耦 Python 检查通过。全套 Python 460项在已构建的浏览器 fixture 中通过；初次新源码目录未创建 public，原公开白名单检查正确报错，之后仅在明确标注的 fixture 上重跑，不取消原检查。全部15个 Node 离线测试命令通过，真实外部来源/模型调用为0。

浏览器520断言/60布局、67周榜 fixture、116期刊与实际周榜检查、完整 DOI 浏览器和20首屏场景/240检查均通过。浏览器目录明确省略历史归档，仅用于布局/入口检查，六文件 fixture 不作完整生产包。新候选完整 archive restore、生产构建和3ZIP逐文件回读仍需原数据任务执行。父线程已提供 b316 的完整缓存回归证据 `85e76f84de7b152193c352b74db255f6a3e7a5fd`，固定 state `5dd46b9a0e8aaa3aee94f1c0bc6c88679baaae96`；它不替代本增量的新构建验收。

周榜24篇仍是题名22、译文1、study0、quicklook0，保留缺失提示，不扩大收费任务或解除暂停。该22来自更新输入后选文替换，旧历史快照23仍保留；不是缓存被删除。公开摘要分析与 private PDF 口令下载保持原边界。

## 风险、启用与回滚

默认即时取文仍有原请求时限、来源可访问性和手动重试限制，关闭页面不保证完成。已有队列记录保持休眠，关闭期间不会继续消费；尚未有生产队列上线证据，不能暗称正在后台处理。若以后决定启用，必须由统筹先确认两任务职责、既有 daily 兜底安排、合法部署权限、Worker与GitHub变量、真实任务回读及已有队列处理；本候选不自动设置这些条件。

代码审查回滚点是 b316；若恢复其队列默认开启和调度器部署门禁，原权限失败也会回来，不能当作可发布修复。已成功发布的生产回滚点为 v14.1.4 / main `e238e6f2d93de6387f1530e079acc2836c2dbf95`，需按原完整 state restore 构建再走既有 Pages 路径；回滚代码不删除 QL_KV 或档案数据。本轮未执行回滚。

发布前由统筹确认协调完成，并再次核 main/state 与固定回归输入；main 若已前进必须重新审查增量，不盲推。无需因 UI 发布扩大 Workers 权限。此文列出的解耦候选与完整24预生成验收是不同交付，均不得假称完成。
