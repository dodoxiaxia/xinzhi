# 56739c6 唯一固定候选最终生产包证据

源码 `56739c69271cfaf58aabe52062bd6000584da700`，父 `b316007580476a5016c20e4a81ae54cb962df919`；state `5dd46b9a0e8aaa3aee94f1c0bc6c88679baaae96`。只读观察 main仍为12701e17，state仍与固定输入一致。复用b316已校验的整个准备快照，没有混接其它state、没有重复拉摘要缓存、没有修改候选或添加UI变化。

**v14.2.1完整生产构建、发布预检、3个ZIP回读通过。** CRC完整，包中全部6个公开文件逐字节对应通过守卫的构建。源码codeSha、全部输入哈希和公开文件哈希由完整manifest记录；未跳archive或其它守卫。原完整缓存31,339,518字节／14,480条，Git blob90ca0b2292319774a5bbf7c5753e726d3a67d0d9，SHA256 `ec8b03e740668080dc93c46c70f1033bf36c377485bd6ae7edc47d9cf8f8efdc`。

本轮回归：460项Python、16个Node离线回归命令、app语法、完整DOI浏览器均通过。16包含新增test_fulltext_activation；此外首屏20场景／240检查由test_boot_url_ui执行通过。新增解耦3项Python检查、默认关闭6种激活配置、显式启用的队列/OIDC、原PDF/DOI/研究引句与数字边界均通过。所有外部服务请求为模拟或拦截；没有访问真实下载或模型。

包哈希：

| 文件 | SHA-256 |
|---|---|
| xinzhi-public.zip | `577f0dae5586840051f8de6631aea4b7822891ab1ab54738e8cc44dc881104eb` |
| 心知-公开网站包.zip | `577f0dae5586840051f8de6631aea4b7822891ab1ab54738e8cc44dc881104eb` |
| 心知-本地学习站.zip | `4cb13dee524549d41a7ec8ad90b661f91b33b15b2c4aaf6a3fb8058132469b6a` |
| public-manifest.json | `f26a691d262021b902be6fa73360a2ad9e5e904bcc98fd30d9c8429ad4b2516c` |

ZIP位于隔离检出 `/workspace/week-release-final-56739c6/.local/release-evidence-packages`。公开库1268、radar870、历史题录12635、标题译文14994、周榜24。周榜内容覆盖仍为22／1／0／0；不是24篇生成完成。

账本／模型缓存与本轮固定准备输入哈希一致，暂停守卫仍paid_work_paused，预留4次／3800输出不变。0模型调用、0新预留、0发布、0调度／权限修改、0真实403端点请求，未写main/state。没有本轮离线构建阻塞；真正Pages发布与真实模型生成仍由唯一负责人验收。本轮未触发或解决Cloudflare服务权限，不把解耦后包通过当作生产已发布。

证据入口summary.json；输入fixed-inputs.json与refs-readonly.json；构建和ZIP回读build-package-readback.json；完整manifest public-manifest.json；回归tests-regression.json与doi-browser.json，各命令全量日志同步保存。保持这一固定提交，不再循环改版。
