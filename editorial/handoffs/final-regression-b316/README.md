# b316 最终完整构建与离线回归

固定候选 `b316007580476a5016c20e4a81ae54cb962df919`，合入 main `12701e17e71eb3c2eb1f76cfc42766d352e5a5a8`，隔离检出 `/workspace/week-integration-final-b316`。本轮代码未修改。

**完整离线回归通过。** 完整六文件构建版本 v14.2，`public_payloads()` 发布预检通过；3份ZIP CRC通过且全部6个公开文件逐字节等于通过守卫的构建。457项Python unittest、15个Node离线回归及app语法检查全部通过。原失败的来源健康测试现以真实journal-metrics模块和实际helper通过40项断言；新全文队列与调度器均为离线模拟回归。浏览器布局520断言／60布局、周榜fixture67项、期刊与真实周榜116项、完整DOI浏览器检查通过；外部请求均被拦截或模拟。

输入使用已恢复并校验的固定 state `5dd46b9a0e8aaa3aee94f1c0bc6c88679baaae96`，整体复用上一轮该state的离线准备快照，未混入其它state、未重新下载缓存。完整摘要缓存31,339,518字节／14,480条，Git blob `90ca0b2292319774a5bbf7c5753e726d3a67d0d9`，SHA256 `ec8b03e740668080dc93c46c70f1033bf36c377485bd6ae7edc47d9cf8f8efdc`。Full abstract cache missing及其它构建守卫均保持。新main的build_public仅改变release字符串，release_integrity新增代码／workflow输入，没有要求新state数据结构。固定输入文件全量哈希见 `fixed-inputs.json`，实际构建输入哈希和codeSha见 `public-manifest.json` 与 `build-package-readback.json`。

公开库1268、radar870、历史题录12635、题名译文14994、周榜24；周榜覆盖仍为题名22／摘要翻译1／study0／quicklook0。不能以本次包验收宣称24篇内容生成完成。

暂停保持，预留仍为4次／3800输出tokens；已准备快照的ledger和cache与本轮输入哈希一致，原任务正式data文件亦与原备份一致。准备快照已有上一轮import增加的pauseReasons，因此审计分别使用准备输入哈希与原文件备份作为基准，不把这些旧元数据差异误判为本轮改账。暂停守卫仍返回paid_work_paused。实际模型0调用、新预留0，未再次请求403端点，未写main/state、未部署、未改调度／权限。

剩余生产阻塞由集成交接报告：Cloudflare服务更新 `No access to the specified service.`。本轮未重新触发、验证或解决该发布链问题，不能将离线通过当作线上发布成功。真实study生成及24篇批量计费亦未验收。

证据入口 `summary.json`；构建日志 `build-*.log`，全量回归日志 `test-*.log`、`browser-*.log`，包回读与哈希 `build-package-readback.json`，完整manifest `public-manifest.json`。三个包位于隔离检出 `.local/final-regression-packages`，没有用于部署。专用分支推送前主线和本地分支工作流过滤复核见 `push-safety-readonly.json`。
