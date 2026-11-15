# 仅发布已核验原包（deploy-only-verified）手动 CI 说明

本说明对应工作流 [deploy-only-verified.yml](../.github/workflows/deploy-only-verified.yml) 与校验脚本 [deploy_only_verified.py](../scripts/deploy_only_verified.py)。

## 1. 用途与开/关同包路径

- 仅支持 `workflow_dispatch` 手动触发，且仅允许在 `refs/heads/main` 上运行；不监听 `push`、`schedule`、`pull_request`、`workflow_call` 或 `repository_dispatch`。
- 输入参数收敛为两项：
  - `purpose`：`open` 或 `close`（二选一）。
  - `confirm`：必须严格等于固定字面量 `publish-verified-d646340-c6eb758`。
- **`open` 与 `close` 走完全相同的已核验原包与发布命令**：
  - 两者均从钉死的 state 提交 `c6eb758a08b9b449fe84e2139564d3eb474b38d3`（仓库 `dodoxiaxia/xinzhi-state`）只读提取 `public/` 到临时目录并完成 19 个文件的字节数与 64 位 SHA-256 校验。
  - 两者均调用同一条官方 Wrangler 3 命令发布到 `dryz-xinzhi`（`main` 分支），显式绑定包代码 SHA `d646340107ca82ceb902ded4f64c403556ad7345`（`CI=true`，不使用 `--no-bundle`，不升级 Wrangler 4）。
  - 本工作流**不修改** `D1_BACKFILL_ENABLED`（开关由另一路在机器认证就绪后操作），不刷新数据、不重新构建、不写回 `state` 分支，也不引入任何机器令牌。

## 2. 必须全部通过的闸门（任一失败即退出，不执行 deploy）

1. **生产代码 SHA 闸门**：只读查询 Cloudflare Pages 项目 `dryz-xinzhi`，要求 `canonical_deployment`（以及若有成功的生产 `latest_deployment`）的 `commit_hash` 必须仍为 `d646340107ca82ceb902ded4f64c403556ad7345`。若生产已是其他提交，立即中止，避免覆盖新版本。
2. **原包 19 文件指纹闸门**：仅从钉死的 `c6eb758a08b9b449fe84e2139564d3eb474b38d3` 只读提取 `public/`（不读 `state` 分支尖、不读工作区 `public/`、不读 `docs/public-manifest.json`），核对文件集合恰好为 [deploy-only-verified-public.json](../config/deploy-only-verified-public.json) 中的 19 个文件，无多无少，且每个文件的 `bytes` 与 64 位 `sha256` 完全一致。
3. **`main` 相对 `d646340` 差异 allowlist 闸门**：先检查 checkout 的 `HEAD`，只允许状态为 `A`（新增）且路径严格属于本次已审的 5 个新文件；任何已有文件改动或 allowlist 之外的路径均拒绝发布。
4. **关闭路径可用性**：不要求 `github.sha == d646340107ca82ceb902ded4f64c403556ad7345`。本方案合并到 `main` 后，只要闸门 1/2/3/5 与临发布复核满足，`purpose=close` 与 `purpose=open` 同样放行。
5. **并发串行与 fail-closed 探测**：加入与 `daily.yml` 的 `refresh` job 相同的 job 级并发组 `daily-refresh-state`（`cancel-in-progress: false`，不取消其他运行）。GitHub Actions runs 按页读取，每页 30 条，最多 10 页；Cloudflare deployments 每页 10 条，最多 10 页。这不是全量历史扫描。任一列表在达到页上限后仍无法证明已经列完，即 fail-closed 中止，不会把第一页当作完整结果。
6. **临发布新鲜度复核**：在 setup-node 之后、wrangler 之前，重新只读查询生产代码 SHA，并 `git fetch` 远端 `origin/main`。正式仓库 `dodoxiaxia/xinzhi` 为 public（未认证 API `private=false` / `visibility=public`，匿名 `git fetch` 可得 `origin/main`），因此 `actions/checkout` 保持 `persist-credentials: false`，recheck 步骤不必再注入 `GITHUB_TOKEN`，也不会把 checkout 令牌写入磁盘。相对 d646340 的五文件 allowlist **只说明路径新增**，后续若再次改写这五条路径，`git diff --name-status` 仍会显示 `A`，故复核还必须要求远端 tip **等于本次已审 checkout 的 HEAD，或二者 tree 完全一致**（本工作流自身合并可以是已审 HEAD；其后 tip 变化不自动放行）。失败则停止，避免窗口内新版 main/生产被旧包覆盖。

## 3. 需交 ddx 确认的事项

> **请 ddx 确认**：闸门 3 的 allowlist **仅指本次已审的这 5 个新文件**（`.github/workflows/deploy-only-verified.yml`、`scripts/deploy_only_verified.py`、`scripts/test_deploy_only_verified.py`、`config/deploy-only-verified-public.json`、`docs/deploy-only-verified.md`），**不得扩大为「任意 `main` 只要看起来像 CI 改动」**。

## 4. 离线测试范围说明

- [test_deploy_only_verified.py](../scripts/test_deploy_only_verified.py) 为纯离线单元测试（使用本地临时 Git 仓库与 mock 响应），未联网、未使用真实凭据，也未在生产环境执行过真实发布。

## 4.1 与 daily 正式凭据名称的关系

Pages 发布使用的 Secret 名称与 daily 相同：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。state 读取使用相同配置名 `vars.XINZHI_STATE_REPO`（映到环境变量 `XINZHI_STATE_REPOSITORY`）和 `secrets.XINZHI_STATE_TOKEN`。差异在于：daily 在仓库未配置时回退到当前仓库、在 token 未配置时回退到 `GITHUB_TOKEN`；本工作流默认仓库为钉死的 `dodoxiaxia/xinzhi-state`，且不回退 token，脚本还强制该仓库与钉死提交。正式环境若已配置私有 state 仓库和有效 `XINZHI_STATE_TOKEN`（与现网取 c6eb758 包的方式一致），此差异不妨碍取包。若某环境只靠 daily 的回退才能读 state，本工作流会明确失败，而不会静默改用其他包来源。

## 5. 审合时的守卫检查

仓库的 `workflows-untouched` 检查会在 `python3 scripts/check_guardrails.py --base origin/main --commit-range origin/main..HEAD PR_BODY.md` 时拦下任何 `.github/workflows/` 新增。这是既定规则；本次是 Donald 明确批准的「不碰 workflow」精确例外。审合时请用 `--allow-workflows` 跑该检查，且仅允许本 PR 新增上述 5 个文件、不改 `daily.yml` 或现有自动触发。不要为了过检查去改 `scripts/check_guardrails.py` 或 daily。
