## 改了什么

<!-- 一两句话：改了什么、为什么。 -->

## 发布前检查

- [ ] `python3 scripts/check_guardrails.py --base origin/main --commit-range origin/main..HEAD PR_BODY.md` 通过（禁用词、密钥样式、32 位十六进制 ID、源码与构建产物一致、禁止提交 PDF/截图、不改工作流等）
- [ ] 已在本地跑 `daily.yml` 里全部离线发布前检查和 `python3 scripts/build_sources.py --check`
- [ ] 没有提交截图、录屏、PDF（验证产物放仓库外，只在下面写位置）

## 界面验证产物（改了 `index.html`、`src/app/`、`style.css`、`app.js` 时必填；其他 PR 写「无界面改动」）

- 产物目录（仓库外，例如 `/workspace/ui-evidence/<分支名>/`）：
- 索引文件（`INDEX.md`，由 `node scripts/ui_evidence.cjs` 生成）：
- 三个宽度截图（390x844、884 宽、1280x800）：已生成 / 未生成（原因）
- 关键交互的录屏或连续帧（写出交互名称）：
- 功能地图 `docs/feature-map.json` 已同步（新增或改动的控件、状态都登记了）：是 / 否 / 无改动
- `node scripts/feature_map_walk.cjs --viewport all` 结果：

## 备注

<!-- 需要审核人决定的事、已知问题。 -->
