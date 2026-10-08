# 当前周榜六篇缺口补齐

`gap-cache.json` 为12条现有缓存契约结果：榜内rank15、16、21–24的完整中文摘要及速览各六份。`sources.json` 保留开始时当前24榜的原英文摘要、身份、日期和hash；`coverage.json` 仅列本批六篇及两类缓存键。生成来自现有Sol会话对保存的公开摘要的整理，外部模型API调用0；实际后端身份及providerUsage未知，不冒充GLM、人工医学终审或全文阅读。原数字次数、连续引句及同句数字规则未变。

基线main为f0d460f035f9f62db1073f54971d40ad9af3098c（v14.2.8），源state为fcb77d58eab7c8e1de58c3e6c90eb59513d91cdb。完成时复读state 1c9bdb528717b4cfd687b2557d8c3d16dde25d2d，六篇身份、原文、日期和sourceHash仍一致，窗口仍为2026-10-02至2026-10-08；没有移动窗口、修改选文或填补不存在的摘要。适配相关原文件与当时最新main 655975cf75ed1a08d5a8ce03a2847c4a31af5f9f一致。详细绑定见current-state-recheck.json、receipt.json与artifact-sha256.json。

两份独立Sol复核均通过，绑定最终草稿SHA，23条引句逐字核对。首轮发现的持久完全缓解措辞、BCG相较化疗的比较方向、摘要未报告灌注独立比较的范围已修正，历史问题保留在review。12项现有生产validator通过；20项回归通过（本批6、原overlay5、既有预览9）。空缓存阶段先验证源和隔离守卫，缺口覆盖测试当时如实失败；导入12条实际结果后全部通过。

必要适配只在public_editorial_overlay.py的现有离线加载路径登记本补充包，并在preview脚本输出白名单加入本专用目录。原corrected-cache及CONDUCT-AF修订保留。加载所得编辑内容目录共30篇，包含原24与新增六篇；它不是新的周榜。apply_board只给当前选文中原文hash、DOI/PMID仍匹配的条目附加内容，当前24篇和日期窗口保持权威。新增源变化会拒绝旧内容；不存在或不完整的补充包分别保持原流程或明确报错，不转而触发付费生成。

`gap-board.json` 是对完成时最新state的离线接入预览：题名24、翻译24、quicklook24、study0，选文、window、原文、来源日期和allowAutomaticGeneration=false保持不变。未写正式data、state、main，未部署，未创建调度。

唯一主集成负责人可cherry-pick本单一最小提交；发布前重新按当前公开源复验身份和hash，并运行：

```sh
python -m unittest discover -s scripts -p test_sol_gap_overlay.py -v
python -m unittest discover -s scripts -p test_public_editorial_overlay.py -v
python -m unittest discover -s scripts -p test_sol_public_overlay.py -v
```

既有week_precompute/build_public离线路径会通过新增加载包应用到实时选择，不要把本固定预览覆盖未来动态周榜。账本没有写入，开始与复读state账本hash相同，保留暂停及4次尝试/3800输出预留。原API/账户预算与线上连接问题没有在本轮重新测试；离线内容验证不等于线上验证。
