# v14.2.17 发布回执

源 `bf31203c97ce7f7972494a6b9629e452abcbb800`；state `4472b381a3d6b2c98b2927a9c8aa68420d1adf4f`。

[GitHub 发布流水线](https://github.com/dodoxiaxia/xinzhi/actions/runs/37718883798) 成功；[Cloudflare Pages 发布地址](https://bed0f0b2.dryz-xinzhi.pages.dev)。部署 2026-10-08 02:44:55 UTC（北京时间 10:44:55），最终 state 成功 02:45:02 UTC，run 完成 02:45:08 UTC。保存文档的 pending 为 state push 前快照，最终日志和已保存字节回读确认成功。

本版保留已发布 .16 的 API 期限、任务租约与只读等待恢复；实际 Worker 437907 字节/SHA256 与 .16 完全相同。仅补 PMID 42841502 / DOI 10.1161/jaha.126.050332 的中文摘要和速览，来源 hash `8353e8f5fdc72d999835aa2e789e725c3be34cbd357c569e0a76872ff78393aa`。实际发布后的其他 23 篇公开榜整行逐字相同；基本内容待补 1→0。

实际标题、中文摘要、速览各 24/24；研究结构 0/24、studyMissing=24、fullyPreparedPapers=0。weeklyContent.status=partial 是真实研究结构缺口，基本任务队列 contentComplete=true 只表示标题/中文摘要/速览齐备。不能称所有全文、医学审查或自动作者闭环均完成。

42 项补稿/复用回归（新 9+相关 33）、73 项发布相关回归通过；既有 CI 发布前门禁全部成功。三种本地 ZIP 六文件均匹配最终源构建清单。实际 state 六文件字节/哈希回读通过；实际 Worker 36 篇/72 次身份匹配、零网络；实际发布资源在 1440/390px cards/compact 四场景通过，并核对新文 Sol 来源提示、译文和四条速览引句显示。浏览器 API 为本地模拟，未执行真实模型或 PDF 请求。

缓存和费用账本字节与输入 state 一致。沿用既有调度/权限，没有启用新的 OIDC claim/receipt 能力；该能力须等待父线程正在请求的用户批准。已有 JACC LFS 原件复用由 DOI 专项独立修复，不能被新订阅桥阻塞，也不能把原件存在说成网站下载已验收。Mac mock、Bridge/真机/生产模型与无人值守 Sol 消费者均不能提前报完成。

[机器回执](night-v14217-release-receipt-20261008.json) 包含实际六文件 SHA256、覆盖、空基本任务队列、原 23 篇复用、浏览器和本地包证据；[测试摘要](night-v14217-test-summary-20261008.txt)。[.16 回执](https://github.com/dodoxiaxia/xinzhi/blob/fa59d1c/docs/night-v14216-release-receipt-20261008.md)与[DOI 接线门禁](https://github.com/dodoxiaxia/xinzhi/blob/fa59d1c/docs/doi-activation-checkpoint-v14216-20261008.md)分别保留。Cloudflare 当前 PDF pin 未重新实测；较早只读检查确认未设置，本执行器没有配置读取工具，不绕过拒绝或扩大 token。
