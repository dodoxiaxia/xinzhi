# 现有 scout/build 的持续补齐接线建议

本批固定state 350addefc78f57362278ab73123924e852b179bb、main 0edf01932612c9f2a68bde3e638be27a42f187bf。五篇缺口经旧源快照、现行corrected缓存、旧归档缓存及state运行缓存差分，均为新身份；本次没有源hash变化或DOI/PMID映射遗漏。diff.json保留检索范围。既有19篇不重新生成，不用旧窗口/低相关稿补覆盖。

当前仓库的实际入口是daily.yml→ci_daily.py：refresh_feeds/fetch_pubmed/merge_candidates更新来源，WEEK_BOARD再选择和复用缓存，然后build_public构建。快速刷新不执行FULL_OPTIONAL；完整刷新里的translate_titles和configured week_precompute是可选步骤，失败、暂停或跳过不会自动使整次刷新失败。发布sanity只检查雷达/文库数量，不检查摘要覆盖。因此“刷新/构建成功”可以同时伴随19/24内容覆盖。本仓库没有找到名为scout的脚本；外部scout如参与，应把已授权公开候选交给现有来源入口，不能假定另有可用模型服务。

本补丁提供scripts/public_precompute_pending.py：只读当前公开24榜与指定现行缓存/旧源，复验身份、原文SHA256和机械内容；输出缺失title/translate/quicklook、new_identity/source_hash_changed/identity_mapping_review_required/已有身份缺任务，附完整公开源摘要、任务版本和证据快照queueKey。它不调用模型、不写cache/ledger、不重映射身份。sourceHash改变必失效；仅别名相同的内容送人工工程复核，不自动改键。queueKey不是收费请求ID，也不能替代现有cache_key或完成验证；执行时仍须按实际授权模型及现有提示词/验证版本find/store。

建议主集成在ci_daily.py现有WEEK_BOARD成功之后、BUILD之前调用pending_manifest，并用现有atomic写data/public-precompute-pending.json；该路径随既有state保存流程持久化，无需新cron/权限。来源/哈希不合法时明确失败，不写空的“已完成”队列。原full-cache是已被corrected-cache取代的归档证据，不应作为执行复用来源。

```python
from public_precompute_pending import pending_manifest
from week_precompute import read, atomic
board = read(ROOT/'data/weekly-board.json', {})
active_cache = read(ROOT/'data/week-precompute-cache.json', {'entries': {}})
# 先前WEEK_BOARD已经通过现行overlay加载器应用经复验的编辑内容。
pending = pending_manifest(board, [active_cache], approved_prior_source_snapshots)
atomic(ROOT/'data/public-precompute-pending.json', pending)
report['precompute'] = {k: pending[k] for k in
                       ('coverage', 'pendingPapers', 'contentComplete', 'studyMissing')}
```

已有调度每次刷新都会重算这个有限清单；新源/改源自动进入下一次待处理记录，不把昨天的0缺口当今天完成。后台现有生成步骤应先复用现行cache，再对仍匹配当前paperID/hash/版本的缺口有限增量处理；源在运行中改变则放弃该旧任务并留下新源任务。成功条目及断点保留，失败不清空已生成内容。已有403/429/认证、全局暂停、未知余额/账单或预算上限仍须停止付费，不新增服务/token、重试循环或额度。Sol会话整理不是已经验证可被CI自动调用的生产API；此工具也不解决服务连接或额度阻塞。

建议把“内容完成”作为独立状态：pendingPapers>0时记录content_pending及阻塞原因、公开准确覆盖，不能用构建success替代。继续现有来源刷新和已有调度；只有实际缓存复验后清单为0，才宣称本轮题名/中文摘要/速览已预生成。studyMissing独立保留，本批即使0个P0缺口仍有24个study缺失，不能称全文精读或结构研究已完成。

本次只交工具和具体接线建议，未修改ci_daily/daily.yml或启用自动调用；主集成需审查接入及公开coverage状态。发布前必须再读当前state；gap-board.json只是固定快照的离线验证结果，不应覆盖以后选择出来的动态榜。来源、窗口、app与生产发布本任务均未改。
