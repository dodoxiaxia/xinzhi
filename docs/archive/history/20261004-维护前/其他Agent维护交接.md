# 心知维护交接（v13.2，2026-10-03同步）

先读docs/当前交付状态.md、docs/核验记录-20261003.md和最新manifest。线上仍12篇导读、最新9/30，四文件匹配主v13.2；公开库1219、速览3不变。当前六文件与旧五文件发布范围待同步，保持现有Worker、页面和生产包，不重复部署、回退或再次问同一个待决问题。

今日四步查新后843候选，142移出仅87超窗、55仍在日期窗内，PubMed1500/1704仍截断，不统称过期。RSS82/82成功；私有GH同commit1300/3异常，xinzhi空仓库workflow/run仍0。没有新外部错误或付费模型调用；备份、数据/数据库检查有效。

复用10/1三篇摘要核对稿及收据；10/2芬兰EHR全文学习报告三份交付与原PDFSHA均匹配、目标周9/28–10/4、reviewed/非医生终审/未发布不变。不为同稿再次调用模型或重读全部全文；10/5起保留原周历史期，不能改成下一周新精读。10/3仅查身份和接线，未重做医学接受或医生终审。

最低网站接入方案：build_public实际读取根index/app，不读weekly_checked文件，还写根data/docs；必须复制必要可信输入到私有隔离根，编辑真实weekly DOM与app期次数据，再运行副本构建。仅换weekly文件或DEST不足。prepared_at/构建日期不授予published；本轮没有制作此候选。维护源码/主public/manifest/editorial不变。

实际构建/发布前仍运行相关测试、重查内部共读权限和公网交互/内容/哈希。10/1测试和权限证据不冒称今日重验；不触发Worker生成或扩大预算。继续同一个08:00automation，无变化安静。下面为历史交接，其日期/版本/执行范围须以上述最新事实为准，隐私与错误即停边界继续保留。

---

# 心知维护交接（v13.2，2026-10-01同步）

先读docs/当前交付状态.md、docs/核验记录-20261001.md和最新manifest。线上四个静态内容已匹配v13.2，源码与公开目录六文件，含_worker.js。历史v7交接/五文件包不得用来回退新版；页面残留版本字样不是部署依据。

本轮09/30之后的新变化：365天公开雷达、机器翻译、读者触发云端AI、GitHub Actions定义。云端只读状态可生成，只证明配置存在；模型、实际成本、严格限额、真实调用尚未核验。当前代码会失败重试，与本地维护模型错误即停边界不同。维护者不自动触发云端生成或扩大调用预算/权限。

既有用户授权发布清单为五文件，现有源码六文件。未获同步前保留现有线上Worker与新版public，不上传六文件，也不删Worker或用五文件旧包覆盖。隔离候选构建可准备，但不能称已发布；只在实际公网验收后确认。

新增private dodoxiaxia/xinzhi截至10/1为空仓库、workflows=0，本地git未设remote，不能称05:17/半小时自动发布已启用。保留同一个08:00 Codex任务；不推送上游、新建调度、配置Secrets或扩大凭据。

查新分步运行现有四个必需脚本，先备份覆盖的数据和实际数据库，必需失败立即停。不要直接运行新版refresh_daily或ci_daily：前者会继续optional并触发大量标题翻译，后者直接构建/部署。未经明确预算不跑translate_titles批量付费。GLM仍只处理公开题名摘要，单批最多5导读或3速览/12摘要检索，任一模型错误即停止本轮；不跨另一批次重试。

本轮Python103项测试、修复夹具后的JavaScript20条断言通过；修复metadata对空格/逗号千位分隔人数截断、JAMA设计段与病例对照标签误识别，app/生产public未改。日期缓存测试要加载_rs并在vm加载后设置固定北京时间，保留原语义期望；不要因旧夹具报错回退网页。

10/1查新82个RSS来源成功，当前候选970。3篇已完成GLM初稿和独立NCBI摘要核对，保存.local/maintenance/20261001/reviewed-ready.json（pmid-42814420、42814450、42808436）；隔离候选15篇，新增3篇显示待发布，根editorial仍12。先查这些稿件、收据、candidate-qa及线上是否已纳入，勿重复付费生成；不把准备/本机数据库更新称发布。公开1219条ID范围和3条既有quicklooks保留。未获得全文，群材料仅私有草稿、不发送。10/1内部GoogleDoc只读权限核验仍仅dryz@dryz.info，无anyone/domain。

下面是v7时的完整历史交接，隐私、1219公开范围、医生终审、固定commit与PDF核验、内部GoogleDoc权限、GLM预算和不发送群消息等边界继续保留；其版本、五文件执行方法、旧验证数量与日期由上方最新事实取代。详细原稿也在docs/history/20261001-同步前-其他Agent维护交接.md。

---

# 历史 v7 交接（以下条款仍适用时沿用）

工作目录：/Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi

先读 `docs/当前交付状态.md`、`docs/v7优化核验与后续路线.md` 和 `docs/public-manifest.json`，检查文件修改时间、Claude是否仍在写入和公网是否更新。以实际部署为准；历史v2/v6记录不作为当前实现指令。不要覆盖另一Agent的未完成工作或重复部署。

## 内容和模型

使用当前RSS/PubMed查新、合并和metadata脚本，PubMed完整摘要优先同篇RSS片段。不要把未知日期、研究类型或期刊名猜成已知。分类只是导航；综合医学和AI行业来源不丢弃。公开文献档案维持现有1,219条范围，未经明确指示不扩大本地私人索引的公开内容。

GLM-5.3-Flash 只处理公开题名摘要；凭据在.local/llm.json或环境变量，禁止输出/上传。generate_drafts.py默认干跑，可按已选公开ID单篇调用；真实输出仍是未核对初稿。发生API、模型或证据校验错误停止，不循环重试、不换付费模型、不用GPT批量接管。私有诊断仅供定位问题。原早晨ValueError无法追溯，不要写成已确定截断所致。

generate_quicklooks.py默认3次模型、12次摘要检索，上限20/40需明确扩大。它将候选与文献库去重，已核对导读及已生成项不重复付费；完整PubMed摘要优先，RSS片段回EuropePMC核验DOI/PMID。任一API或证据校验失败全批停止、旧有效quicklooks保留。键为小写DOI或pmid-数字。速览始终标未经人工核对，不能放进source_checked精选。

source_checked_drafts.json仅追加完成来源核对的导读，明确published日期、证据范围和来源URL；不覆盖已有文章。data/curated-archive.json保留离开14天雷达的已核对题录；构建缺元数据或既有已核对导读消失会报错，不应删除旧导读“解决”。如确需撤回应明确记录原因，并同步处理导读与归档，不能用仅最新一期替换全部导读。速览abstractSource/abstractSourceUrl公开来源字段会随构建保留。根预览与public均加载同一归档和速览内容。

周五按paper-cross-review取得并核验全文，逐段审查后再发布精读；没取得全文则显示未发布。AGY仅用于必要全文工作。分享包用于用户自行复制群文案，不自动发微信群。

## GitHub后台文献来源

用户2026-09-30授权使用定时更新的private dodoxiaxia/AI-。先读 docs/GitHub文献库接入.md 及 .local/github-library/index.json 的快照信息。运行 scripts/github_library.py sync 只读同步当前默认分支、固定同一commit的索引，失败保留旧快照；按DOI/题名/常见中文词 search，用选定id fetch 单篇PDF用于身份核验和全文精读。GH登录是本机维护者身份，不能据此声称Cloudflare已有私有后台授权。本机编辑台只读检索沿用现有会话；不得公开索引路径或全文缓存，不变更仓库权限。

先查索引再取少量原文，GLM仍只接收公开题名摘要，不传私人笔记或内部记录。文件头及SHA校验不等于阅读或医学复核；精读前仍核验PDF题名/DOI并按全文审查流程处理。现有1219条公开文献库范围不因私有索引更新自动扩大。私有快照、下载收据、PDF和凭据均不得进入五文件公开包；后台代码接入不触发重复网站发布。

本轮真实快照为1300题录，checksum_counts=valid1297/missing0/invalid3；异常只保留题录并拒绝该记录全文，勿替换为空白后取用。大文件以Contents固定commit确定blob，再读取Git blobs JSON/base64并复核SHA；不使用旧raw二进制路径。TAILORED-AF的PDF身份与哈希已核验，但PDF首页日期2025-02-14与原索引2025-09-01冲突，选每日新文不能直接相信索引日期。不得将仓库中的会议稿或私人材料发给GLM；模型输入必须是已确认公开的论文题名摘要。

## 构建与发布

运行相关离线测试与 scripts/test_reading_logic.cjs，使用当前build_public.py生成 public 并核对manifest。不得恢复旧clinicalAppraisal套模板或假作者引用。按当前北京时间计算近7/30/90天，未知日期和刊期不冒充精确发表日；日期未知排最后。关注期刊与晨会清单只是此浏览器localStorage，不是已实现跨设备同步。

package_release.py只发布5个公开文件。构建/public目录有额外文件、私有路径或凭据要停止。通过已登录的Chrome上传到Cloudflare dryz-xinzhi生产环境；登录、锁屏或连接缺失就保留线上版。发布后实际访问learn.dryz.info，核对版本、数据/精选日期、摘要和速览标签、分页及原文链接；确认公网四个可取静态文件哈希与manifest一致，再标deployed。_headers为平台配置，不能把请求/_headers当作该文件的线上字节核验。

2026-09-30用户已手动发布v7，四文件内容与manifest精确匹配，线上交互已核验；不要为GitHub私有后台改动重复部署。公开打包先检查目录与五文件均为普通文件、非符号链接，再读取并替换包。Chrome文件上传权限尚未重新验证，不将用户手动上传当作无人值守发布链路完成。

发布前只读核验内部共读文档1TKpoqTTC17i_e8Yeu2I8Zh9TwI0EK4eFg-quZK9vIj4没有anyone/domain共享，只授权dryz@dryz.info。不增加成员、不动邮件DNS、不买计划、不扩大账户权限。不得上传.local、全文PDF、数据库、内部讨论或原私人索引。

每天08:00使用现有automation任务；尊重用户并行让Claude维护的状态。无新内容保持原期和日期，发布/明确失败/需要用户操作才通知，不创建第二个每日任务。
