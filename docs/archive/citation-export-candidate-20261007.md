# 精选清单批量引用导出候选（2026-10-07）

固定基线：main `7dbe94c5465e7acca4097ac0282ef8ff78e4a48f`。独立分支 `candidate/huddle-citation-export-20261007`，未合并 main、未改 state、未发布。只由唯一集成者决定合并与发布。

已核实现有能力：`app.js` 的 `buildCitations` 生成单条 GB/T、AMA、BibTeX；`exportHuddleMarkdown` 和 `copyHuddleSummary` 提供原有 Markdown 与精选汇总。基线无 RIS。本补丁直接复用上述单条 formatter，原 formatter、Markdown、汇总和 CSS 没有改动。

新增 `citation-export.js`，非空精选清单顶部折叠区默认选中全部条目，可选择不限篇数的子集；保持精选清单顺序，在所选子集内按规范化 DOI 去重，保留首条并逐条提示重复。与证据对照的 2–4 篇勾选互相独立。选择仅保留于当前浏览器会话。清单 rerender 保留导出选择，显式未选任何条目不会回落到导出全部。

RIS 通过浏览器 Blob/object URL 本地生成，UTF-8 MIME，CRLF 记录；不上传、不查元数据、不调用模型。仅使用原题名、作者数组、真实期刊、已有日期中的年份、有效 DOI 和 HTTP(S) URL，多个作者分别输出 AU。原题录中的换行与控制字符被压平，避免 RIS 记录注入。PubMed 查询标签不作为期刊名；缺项不写伪值。当前公开字段白名单没有已核验卷期页码，因此逐条明确提示缺少卷期/页码，不推断临床结论。RIS N1 内含缺项提示，复制输出也附逐条提示；BibTeX 的提示使用 `%` 注释。批量复制保留现有单条 formatter 的格式行为，引用草稿仍须对照原文补全。

模块边界：app 只在 `openHuddleModal` 的原 `const newlyOpened` 前加一行 mount（另加空行），index 只在 app script 前加载模块；不接管空清单 disabled（由任务 01a116de-a39b 负责），不改 app/css 主任务 01a11479 的布局。模块追加内容到 `#huddleModalBody`，自己管理事件、选择和缺项列表。

公开构建把模块并入现有 public.js，仍恰好六文件；本地源码包登记新模块；release provenance 登记模块哈希，旧构建与改动输入不匹配时拒绝打包。daily workflow 增加模块路径与离线检查，触发仍严格限定 main。候选分支推送不会触发 daily/fulltext 生产工作流，不调用 workflow_dispatch。

验收（全部离线 fixture，不替代生产验收）：

- `node --check app.js`、`node --check citation-export.js`、`git diff --check` 通过。
- `node scripts/test_citation_export.cjs`：33 项；中文、英文符号、多作者、无 DOI、同 DOI 去重、选择子集、未知选择提示、UTF-8 和 JSON Unicode 转义回读、严格 RIS 解析、注入防护、已有单条引用一致性、本地 Blob 清理。
- `node scripts/test_citation_export_ui.cjs`：75 项；真实 Chromium，1280/390/320px，子集复制三格式、实际文件下载并解析、rerender 保留选择、未选子集禁用、DOI 去重提示、无脚本错误与页面溢出。选择和导出新增网络请求为 0。
- `node scripts/test_boot_url_ui.cjs`：20 情景 / 240 项通过。
- `node scripts/test_study_ui.cjs`：83 项通过；阅读逻辑 20 项、API 文案 6 项、PDF 链接范围 4 项通过。
- Python `test_release_build.py` 3、`test_public_build.py` 23、`test_package_release.py` 23、`test_workflow.py` 9 项通过；包含完整合成六文件构建及源码模块改动后 provenance 拒绝打包。

浏览器证据在隔离工作树 `.local/citation-export-qa/`：results.json、三个宽度截图和实际 subset-*.ris；不进入公开包或 Git。未恢复生产 state、未构建/部署生产数据包、未发送群消息、未声称临床长图简报完成。

集成：cherry-pick 本分支提交，在并行 app 接线冲突时仅将 mount 行保留在 `openHuddleModal` 已生成 body 后的位置。发布前由唯一集成者运行候选测试及原发布门槛，再检查六文件包。回滚：集成后 `git revert <候选提交 SHA>` 撤销模块及接线；若与其他修改有冲突，只移除本模块 mount/script/bundle/provenance/package/workflow 三行登记和本候选文件，不覆盖其他任务的 app/css。候选尚未上线时无需生产回滚。
