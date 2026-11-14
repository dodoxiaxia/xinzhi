# 方案：让守卫检查在 PR 阶段运行（需要改 `.github/workflows`，本 PR 不改）

## 现状

- `scripts/check_guardrails.py` 通过 `scripts/test_public_build.py` 导入的两组测试运行。`daily.yml` 的「发布前验证」和 `daily-reading-checks.yml` 都会跑这个文件。
- `daily.yml` 只在推送到 main 或定时触发时运行，且「发布前验证」只在 `deploy == 'true'` 时执行。所以守卫在合并之后、发布之前拦截，此时检查的是用 state 数据构建出的真实 `public/`。
- 在 PR 阶段，只有改动 `scripts/build_public.py`、`scripts/ci_daily.py`、`app.js`、`index.html`、`style.css` 等少数路径的 PR 才会触发 `daily-reading-checks.yml`，从而跑到守卫。其他 PR（例如只改文档、`src/`、`edge/`、`config/`）合并前没有守卫。
- PR 差异类检查（不得新增截图和 PDF、不得改工作流、提交信息里的禁用词）需要 `--base`，现有 CI 无法提供，只能在本地提 PR 前运行。

## 提议

新增 `.github/workflows/guardrails.yml`，只在 `pull_request` 上运行，约 1 分钟：

```yaml
name: guardrails
on:
  pull_request:
permissions:
  contents: read
jobs:
  guardrails:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - name: 守卫检查（差异模式，PR 正文也检查）
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
          BASE: origin/${{ github.base_ref }}
        run: |
          printf '%s' "$PR_BODY" > "$RUNNER_TEMP/pr-body.md"
          python3 scripts/check_guardrails.py --tracked-only --base "$BASE" \
            --commit-range "$BASE..HEAD" "$RUNNER_TEMP/pr-body.md"
      - name: 功能地图与守卫自测
        run: |
          python3 -m unittest discover -s scripts -p 'test_guardrails.py'
```

- 这个新工作流会被 `--base` 的 `workflows-untouched` 检查拦住自己，所以引入它的那个 PR 要用 `--allow-workflows` 本地检查，并由 ddx 明确同意。
- PR 正文写到 `$RUNNER_TEMP`，作为额外文件参数传入，和仓库文本一样做禁用词、密钥样式、32 位十六进制 ID 检查。
- 工作流不使用任何 Secret，权限为只读。

## 验收

1. 一个故意带假密钥的 PR 变红，报错行里只有文件、行号和前 4 个字符。
2. 一个新增 PNG 的 PR 变红，提示把证据放到仓库外。
3. 一个正常 PR 变绿，耗时 < 2 分钟。
4. 之后可以把 `test_public_build.py` 里的导入保留（发布前仍再检查一次真实 `public/`）。

## 风险

- 误报会挡住 PR：用 `config/guardrails.json` 的带理由例外处理，例外失效会报错，清单不会悄悄变长。
- `pull_request` 事件对来自 fork 的 PR 没有 Secret 也不需要，因此安全。
