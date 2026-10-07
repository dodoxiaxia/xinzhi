# UI 与付费断点离线整合（未发布）

基线 main `e238e6f2d93de6387f1530e079acc2836c2dbf95`（已发布 v14.1.4）。组合 UI 来源 `6d7aa7f680136218d13c5671a4f8e71ba3c3f4b5`，共同祖先 `75f538eff711e7eb53628e0c101df278a97c3ee7`；断点来源 `4de0d1472ef47682086782670e28da0b40a98faf` 的九文件增量，父提交 `a9c67378a57f13d120b67b70be5c97ab32ff7806`。在隔离目录三方合并，没有覆盖旧主线完整文件，没有推 main/state、实际模型调用、PDF 读取/下载、资源创建或新调度。

保留 v14.1.4 的最小 API 四文件、Logo 文字删除、1268 条公开库快照、DOI/PDF 下载与权限、官方日期、每日发布检查及调度。新期刊指标配置与脚本加入现有 push 路径过滤；预生成、指标及工作流离线测试加入既有部署门禁。

## 审查后补充修复

- 配置模型保留提供商报告的 token usage 与 finish_reason。缺失时 providerUsageKnown=false，不假设零用量，不根据 KV 或输出预留推导美元硬预算。报告不包含凭据、模型响应正文或 private PDF。
- 模型返回后保存 usage；验证失败、截断或模型错误尽力持久化 failed_or_uncertain 与暂停。checkpoint 自身失败后不重试不确定写入；远端 started 预留仍阻止后续重复收费。已经确认的 usage 不得被后续 checkpoint 删除或改写。
- pauseReasons 单独存在时也阻止付费回调，不能仅将 paused 置空绕过暂停。
- 原固定收据保守记录四次提供商尝试预留／3800 输出预留。新增纯函数只修复这两条精确历史身份的旧“两个 POST”计数；填入输出预留且保留原使用量、暂停、失败和其它日记录。未知调用、缺少请求记录、冲突收据或额外费用拒绝推算。实际原任务账本不在本执行环境，本轮未回写其文件。
- 周榜筛选接受“期刊官网 published-online（已复核）”日期；旧来源快照不得覆盖已核官网日期。JAMA DOI 10.1001/jamanetworkopen.2026.37533 以 2026-10-05 纳入当前24篇榜，rank24。

## 离线证据与范围

预生成／预算／cache／checkpoint／CI／新增整合回归106项；CI 30项；workflow9项；期刊25项；公开相关83项；release3项；package23项。Node证据20项、期刊43项、日期10项及原API/PDF/DOI边界通过。

浏览器520断言／60布局，另67周榜fixture、116期刊与实际周榜接入断言。全部外部请求被阻止或模拟，真实模型POST为零；页面JS错误与横向溢出均为零。截图在本任务本地测试目录，包含明确离线译文fixture。

读取固定 state `5dd46b9a0e8aaa3aee94f1c0bc6c88679baaae96` 的候选、文库、PubMed、信源等输入并验证Git blob；radar/archive标题、译文、速览亦与该 state hash 一致。但本环境无法取得完整31 MB `data/archive-full.json`。完整生产构建确实被现有“Full abstract cache missing”守卫拒绝，未取消检查。浏览器fixture在缺少历史归档的隔离输入上构建六文件，不当作完整生产包。pipeline7项仅对该fixture通过。发布前须在原正常restore路径恢复完整 state 再跑完整构建、打包与回读。

当前24篇覆盖：中文题名22、中文摘要1、study0、quicklook0；不能标为完成，也不能把本候选发布作为生成验收。

## 仍需协调

1. 原账本持有任务使用固定收据离线修复其两次POST旧计数，留存原文件和审计记录，暂停不得自行解除。该快照导入是一次性交接，不应在后续已完成任务每次刷新时重新导入旧失败暂停。
2. checkpoint代码仅在已有Actions环境且 XINZHI_PRECOMPUTE_STATE_CHECKPOINT=1 启用；其它情况默认关闭。仓库变量当前值未取得：现有GitHub connector不支持该variables读取URL。本轮未设置变量、读取token值或验证真实state写权限。
3. cloud运行接口和预生成任务的GET均403，未发送模型POST。不再重复访问、换端点或换执行环境绕过。仅凭403尚不能定位Cloudflare WAF；需原响应头/拒绝码、时间、是否CF-Ray，以及Cloudflare相同请求的事件对照。若Cloudflare无对应事件，应由云执行平台放行合法的learn.dryz.info HTTPS出口；若有阻断事件，只针对已确认规则和请求修复授权，勿整体关闭保护。用户手机可查看已有站点，不依赖桌面或Mac开新服务。
4. 先无模型核实已有GITHUB_TOKEN的state权限与竞争租约，再决定开启断点。此模块只有两文件提交；新账户、凭据、调度、R2均未创建。
5. 服务恢复且原账本完成核对后，仅执行已授权的一次study验证。全24的实际生成及provider费用仍待原任务验收；8次／9600输出是代理自行设定的试跑上限，不是用户套餐额度。

DOI完整分支 `1dcf78fddf1cd5d725faea24ef8e9ffa56c16b9f` 另有OA、暂停分类和未部署归档原型。本候选未合入该分支；其R2、新token、Drive OAuth、owner切换及消费者仍是单独待审范围，不能把网站KV缓存等同于三端归档。
