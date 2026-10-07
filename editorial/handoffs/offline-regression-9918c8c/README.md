# 固定候选完整缓存回归与历史补账

候选 `9918c8c67ade43e49a88aa6fe8bc9bc39cc23eaf`，隔离检出 `/workspace/week-integration-regression-9918c8c`。输入固定 state `5dd46b9a0e8aaa3aee94f1c0bc6c88679baaae96`；历史摘要缓存与原任务现存文件逐字节一致，Git blob `90ca0b2292319774a5bbf7c5753e726d3a67d0d9`，31,339,518 bytes／14,480条，SHA-256 `ec8b03e740668080dc93c46c70f1033bf36c377485bd6ae7edc47d9cf8f8efdc`。未跳过 Full abstract cache missing 守卫。

**全包回归未全绿：一个既有部署门禁失败。** `node scripts/test_source_health_ui.cjs` 报 `ReferenceError: journalMetricBadge is not defined`。`app.js` 的 `renderSourcesHealth` 已引用该函数，但测试通过 VM 单独提取的函数集未包含这一依赖。固定候选未作修补；失败日志 `test-10.log`。真实浏览器来源视图和期刊接入断言通过，不能据此忽略失败门禁。应由唯一集成负责人修复测试依赖后对新固定 SHA 回归。

其余结果：Python unittest 全发现457项通过；其余 Node 回归通过；布局520断言／60布局、周榜fixture67项、期刊与真实周榜116项、完整 DOI 浏览器检查通过。完整六文件构建与 `public_payloads()` 预检通过，3个ZIP CRC与6文件逐字节回读通过。公开库1268、radar870、历史题录12635、标题翻译14994、周榜24；周榜生成覆盖标题22／翻译1／study0／quicklook0。ZIP仅在隔离检出 `.local/regression-packages`，未部署。

原 `.local/week-precompute-ledger.json` 实际只保留第一条 translate 请求，计数2且无输出预留；正式 `data/week-precompute-ledger.json` 已为4／3800。候选自动修复函数要求旧账本已有两条身份，对实际原件报 `ledger_receipt_does_not_cover_local_history`，没有自动绕过。按本轮显式授权，对原件第一条请求的 paperID、sourceHash、task、at、预留2逐项与固定真实收据核对，补入已确认缓存命中的输出预留0，再用候选 `merge_ledger` 精确并入收据第二条 study 的2／3800预留。原第一条失败状态、原每日暂停及收据失败暂停全部保留。原文件、收据、正式账本和历史模型缓存均有备份，补账差异见 `ledger-reconciliation.diff`。补账后的正式计数4／3800不代表真实账单或套餐余额。暂停守卫返回 `paid_work_paused`；正式data账本与历史模型缓存未变。

原403响应头和正文均未留存，仅有此前状态码收据。本轮不再请求这些端点。模型调用0、新费用预留0，未读取凭据，未写main/state、未部署、未扩大预算。候选代码始终为固定9918c8c；本目录仅交付审计与测试证据。

证据入口：`summary.json`、`ledger-audit.json`、`pause-preservation.json`、`build-package-readback.json`、`tests-backend.json`、`tests-browser.json`、`doi-browser.json`。公开manifest及每条回归完整日志同时留存。
