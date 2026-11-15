# 仅发布已核验正式包（deploy-only-verified）输入式绑定手动 CI 说明

本说明对应工作流 [deploy-only-verified.yml](../.github/workflows/deploy-only-verified.yml) 与校验脚本 [deploy_only_verified.py](../scripts/deploy_only_verified.py)。

## 1. 方案变更：从仓库死 pin 改为输入式绑定与三方核验

- 仓库内历史遗留的 [deploy-only-verified-public.json](../config/deploy-only-verified-public.json) **不再是权威**，本工作流与脚本**不再读取**该文件作为闸门，也不再硬编码单一包代码 SHA 或 `state` 提交。
- 仅支持 `workflow_dispatch` 手动触发，且仅允许在 `refs/heads/main` 上运行；权限保持最小化（`contents: read` + `actions: read`），不监听 `push`、`schedule`、`pull_request`、`workflow_call` 或 `repository_dispatch`。
- 工作流输入为 4 项：
  - `purpose`：`open` 或 `close`（二选一）。
  - `confirm`：必须精确等于固定确认字面量 `publish-official-bound-bundle`。
  - `daily_run_id`：本仓库一次已成功并已部署的 `daily-refresh` 运行 ID（正整数）。
  - `state_commit`：私有 `state` 仓库对应的精确 40 位小写 commit SHA（禁止分支名、`tip` 或短 SHA）。
- **为什么不再增加第三个绑定输入**：`daily_run_id` 标识官方构建与部署回执，`state_commit` 标识不可变包文件树，当前生产身份由脚本只读 GET `dryz-xinzhi` 与生产域名现场得出，并与前两者交叉验证。若 `close` 需要改绑到最新正式包但无法唯一确定对应的官方 run 或 `state` 提交，脚本直接 fail-closed 中止，要求人工重新 dispatch 新的 `daily_run_id` + `state_commit`。
- **不以用户粘贴清单或任意仓库/URL 为权威**：不接受任意仓库名、任意 URL 或手工粘贴的 19 行哈希作为校验依据。
- **不改 `daily.yml`、不改六键清单、不改开关**：本工作流不刷新数据、不重新构建、不写 `state`、不修改 `D1_BACKFILL_ENABLED`，也不引入任何机器令牌；六键清单不在本 PR 范围内。

## 2. 三方交叉核验（缺一即失败，不得部署）

1. **官方 `daily-refresh` run 回执**：
   - 使用本仓库 `GITHUB_TOKEN` 查询 `GET /repos/{github.repository}/actions/runs/{daily_run_id}`，拒绝外仓或伪造 `url`/`html_url`/`artifacts_url`。
   - 工作流必须是 `.github/workflows/daily.yml`（`daily-refresh`），`head_branch` 为 `main`，`status == 'completed'` 且 `conclusion == 'success'`。
   - 按该 run 实际的 `run_attempt` 下载官方产物 `pipeline-final-{run_id}-{run_attempt}`（跨域名重定向自动剥离 `Authorization` 头）。
   - 解析 `docs/deployment-status.json`：要求 `deployed == true`、`deploymentOutcome == 'success'`、`codeSha` 为 40 位小写 hex、且 `build.files` 恰好 19 项（含 `_worker.js` 与 `_headers`），每项 `path`、`bytes` 与 64 位 `sha256` 合法且无重复路径。
2. **私有 `state` 仓库不可变原包**：
   - 强制 `state` 仓库为 `dodoxiaxia/xinzhi-state`（`vars.XINZHI_STATE_REPO` 必须等于该值）且必须提供 `secrets.XINZHI_STATE_TOKEN`（不回退到 `GITHUB_TOKEN` 或当前仓库）。
   - 使用 `git -c 'http.https://github.com/.extraheader='` 与一次性 `GIT_ASKPASS` 仅 `fetch` 该精确 `state_commit` SHA，**禁止跟随 `refs/heads/state` 分支尖**；导出 `public/` 到仓库工作树外的临时目录，核对 19 路径集合及逐项 `bytes` / 64 位 `sha256` 与回执完全一致（含 `_worker.js` 与 `_headers`）。
3. **当前生产状态与 17 静态指纹**：
   - 只读 GET Cloudflare Pages 项目 `dryz-xinzhi`：要求 `canonical_deployment` 与 `latest_deployment` 均为 `production`、终态 `success`、且为**同一部署**（`id` 与 `commit_hash` 一致），且 `commit_hash` 等于回执 `codeSha`。
   - 对 19 名单中除 `_worker.js`、`_headers` 外的 **17 个静态路径**，从生产域名 `https://learn.dryz.info` 取回响应体并比对 `bytes` 与 64 位 `sha256`。`_worker.js` 与 `_headers` 的源码级核验来自精确 `state_commit`，若公网 HTTP 请求返回 HTML，绝不当作匹配或「包已变」失败依据。
   - **拒绝同 `codeSha` 历史旧包**：即使存在另一成功已部署 `daily-refresh` run 拥有相同 `codeSha`，只要其 17 个可静态核对的指纹与当前线上不一致，立即拒绝，只放行真正对应当前生产的正式包。线上 GET 不能区分「仅 `_worker.js` / `_headers` 不同、17 静态相同」的两份包；这两项只能由官方回执与精确 `state_commit` 交叉证明。

## 3. 开关设置要求与 `open` / `close` 行为

> 本工作流**自身不修改** `D1_BACKFILL_ENABLED`。外部对项目设置执行 PATCH **并不等于已经关闭运行时开关**；已在线部署仍保留发布当下的环境变量快照，必须由后续一次发布把已修改后的设置带入新部署的运行时。

- **`purpose=open`**：
  - 要求项目设置 `deployment_configs.production.env_vars.D1_BACKFILL_ENABLED` 为 `plain_text` 且值精确为 `'true'`（允许 live 部署快照此时仍为 `'false'`）。
  - 所选绑定必须**已经是当前生产**；若取包后到 `wrangler` 前（临发布复核阶段）生产身份、17 静态或官方 19 包发生任何变化，立即 fail-closed 拒绝，绝不自动改绑，绝不发布旧包。
- **`purpose=close`**：
  - 要求项目设置 `D1_BACKFILL_ENABLED` 为 `plain_text` 且值精确为 `'false'`（允许 live 部署快照此时仍为 `'true'`）。外部应先将变量 PATCH 为 `false`，再 dispatch `close`；本次发出的正式包必须在项目设置已为 `false` 的前提下由 Wrangler 发布。后续通过机器接口证实运行时状态不在本脚本范围内。
  - 若原绑定仍是当前生产，即使 `main` 上仅有下面 4 个已审控制文件的改动或仅环境变量改变，只要生产包未变，正常放行。临发布复核时，`close` 不因 `origin/main` 相对本次 checkout 又前进了仅这 4 个路径而误拒；`open` 在生产未变时仍要求远端 tip 与已审 checkout 同 commit 或同 tree。非这 4 个路径的远端变化一律拒绝。
  - 若原绑定已被窗口内新一次正式 `daily-refresh` 替代：**绝不发布旧包**；允许在同一次 `close` 运行内自动改绑到当时当前正式包，但必须重新完整通过三方核验（发现**唯一**官方成功已部署且 17 静态匹配的 `daily-refresh` run、在 `state` 历史中发现 `public/` 与该回执 19 指纹完全一致的**唯一**提交而不盲目跟 `state` tip、生产 SHA 与 17 静态一致、项目设置仍为 `'false'`）。若生产 `commit_hash` 与 `origin/main` 已一起前移，改绑以新鲜 `fetch` 后的 `origin/main` 相对新官方 `codeSha` 做 4 文件白名单检查，**不要求**已过期的本次 checkout HEAD 仍等于远端 tip。改绑完成取包之后，还必须再读一次项目设置、生产身份、17 静态指纹和 `origin/main`；若此时生产已变成更新的包或开关已改变，立即 fail-closed，不发布刚取出的包。若任一步无法唯一确定，立即 fail-closed 中止，不要猜测。

## 4. `main` 差异白名单与临发布复核

以当次绑定回执的 `codeSha` 为基点，只允许 `main`（以及临发布新鲜 `fetch` 后的 `origin/main`）相对 `codeSha` 新增或修改（`A` / `M`）以下 **4 个路径**（**不含** `config/deploy-only-verified-public.json`，不得扩大名单）：

1. `.github/workflows/deploy-only-verified.yml`
2. `scripts/deploy_only_verified.py`
3. `scripts/test_deploy_only_verified.py`
4. `docs/deploy-only-verified.md`

临发布复核（`--recheck-before-deploy`）在 `setup-node` 之后、`wrangler@3` 之前执行：`git fetch origin main` 并校验 `origin/main` 与本次已审 checkout `HEAD` 处于同一 commit 或同一 tree（避免窗口内新合入的未审改动被自动放行），同时再次核对生产身份、开关设置、17 静态指纹与官方 19 包。仅当闸门与复核均 `success` 且 `verified == 'true'` 时，才执行：

`npx --yes wrangler@3 pages deploy <verified-public-dir> --project-name dryz-xinzhi --branch main --commit-dirty=true --commit-hash <boundCodeSha>`

## 5. 并发队列、分页边界与首次 PR 触发 `daily` 的真实说明

- **并发与队列限制（不承诺无竞态或必然同包）**：
  - 本工作流与 `daily.yml` 的 `refresh` job 共用 job 级并发组 `daily-refresh-state`（`cancel-in-progress: false`），但该组仅串行单个 deploy job，且 GitHub 默认队列为 `single`（同组最多 1 个运行中 + 1 个 pending，后入队的 run 会取消并替换同组里已 pending 的 run）。
  - `open` 与 `close` 是两次独立 `workflow_dispatch`，跨 run 之间没有全局锁。**禁止同时预先排队 `open` 与 `close`**，必须在 `open` 完全结束之后再 dispatch `close`。
- **分页检查边界（实报每页上限，截断即 fail-closed，不冒称全量）**：
  - 并发检查：Cloudflare Pages deployments 按每页 `25` 条最多 `20` 页读取；GitHub Actions 活跃状态（`in_progress`、`queued`、`waiting`、`pending`、`requested`）按每页 `30` 条最多 `10` 页读取。
  - 产物与 `close` 发现：单次 run artifacts 按每页 `100` 条最多 `10` 页读取；`close` 改绑搜索 `daily.yml` 已完成 run 按每页 `100` 条最多 `10` 页读取；`state` 历史搜索最多检查最近 `50` 个提交。真实 `state` 分支通常会超过 50 个提交，此时即令窗口内前 50 个里已有唯一匹配，脚本仍因无法证明后段历史没有第二份相同 `public/` 而 fail-closed。因此**自动改绑只是短历史上的便利路径**；超过边界或不能唯一确定时，必须重新 dispatch 明确的新 `daily_run_id` + `state_commit`，这才是可靠关闭路径。
  - 上述任一枚举若达到页/提交上限仍无法证明已列完，立即 fail-closed 报错中止。
- **首次改造 PR 仍会触发 `daily-refresh`**：
  - `daily.yml` 的 `push.paths` 包含 `scripts/**`，本次改造修改了 [deploy_only_verified.py](../scripts/deploy_only_verified.py) 与 [test_deploy_only_verified.py](../scripts/test_deploy_only_verified.py)，因此合入 `main` 时**仍会触发一次正常的 `daily-refresh`**（不能宣称本 PR 不会自动发布）。
  - 因为本方案不再依赖仓库内硬 pin，接受该次正常刷新完成后，直接绑定当时新产出的正式包 `daily_run_id` 与 `state_commit` 作为首对输入即可。

## 6. 离线测试与守卫检查

- [test_deploy_only_verified.py](../scripts/test_deploy_only_verified.py) 全部基于本地临时目录、本地裸 Git 仓库、内存 ZIP 与 mock API 响应运行，无网络访问、无真实凭据，也未代表真实 CI 或生产发布结果。
- 本仓库 `workflows-untouched` 守卫会在运行 `scripts/check_guardrails.py` 时拦截 `.github/workflows/` 变动；本次仅在 Donald 明确批准修改上述 4 个文件（且不修改 `daily.yml` 或其他工作流）的范围内执行，审合时需使用 `--allow-workflows`，且不得为了过检查而修改 `scripts/check_guardrails.py` 或 `daily.yml`。
