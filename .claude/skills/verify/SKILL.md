---
name: verify
description: 改完心知仓库后、交卷或开 PR 前的固定自验入口。用 origin/main 上的守卫当裁判检查当前工作树，再跑 build_sources --check 和 run_all_tests.sh --no-browser；改界面时加浏览器测试和 feature_map_walk。
---

# 心知仓库自验入口

任何 bot、CLI 或人改了本仓库，交卷前都跑同一个入口，并把输出贴进交卷或 PR 正文。

## 怎么跑

只有这一种入口，选项加在后面：

```sh
bash <(git show origin/main:scripts/verify.sh)
bash <(git show origin/main:scripts/verify.sh) --ui     # 改了界面时（需先按 AGENTS.md 第 2 节构建 public/ 并有 Chromium）
```

入口本身取自 origin/main，被验分支里的 `scripts/verify.sh` 不参与。直接运行分支里的文件（`scripts/verify.sh`、
`bash scripts/verify.sh`）不算入口：文件开头到自检之间的任何一行都是分支代码，可以在自检前直接退出，所以它的输出不能当自验证据。
输出第一行 `verify entry: referee origin/main@<SHA> (<提交时间>)` 只在实际执行的字节与裁判的 `scripts/verify.sh` 完全一致时出现；
否则入口会改用裁判那份执行，或印 `branch copy, NOT the referee entry`。分支里的入口与裁判不同时，输出会写
「working-tree scripts/verify.sh differs from the referee entry; ignored」。

其他选项：`--referee-only` 只跑守卫；`--no-fetch` 离线时不先拉取，输出会印 `WARNING --no-fetch` 以及所用裁判的 SHA 和提交时间，
交卷时照抄；`--pr-body FILE` 顺带检查 PR 正文。各步日志在 `.local/verify/<时间>/`，结尾打印汇总。
退出码：0 全部通过；1 有步骤失败；2 用法或环境错误；3 改了界面但没跑 `--ui`。

## 入口按顺序做什么

1. **裁判守卫（取自 origin/main）**：把 origin/main 的 `scripts/`（`check_guardrails.py` 及其辅助模块）和
   `config/guardrails.json` 用 `git archive` 落到临时目录，导入那份检查器，对当前工作树执行
   与 `check_guardrails.py --base origin/main --commit-range origin/main..HEAD` 相同的检查（含未跟踪文件）。
   分支里的 `check_guardrails.py` 和 `config/guardrails.json` 一律不用；两者与 main 不同时输出会写
   「differs; ignored」。可用环境变量 `VERIFY_REFEREE_REF` 换裁判引用，交卷时须写明。
2. `python3 scripts/build_sources.py --check`
3. `scripts/run_all_tests.sh --no-browser`
4. 改了 `index.html`、`style.css`、`src/app/`、拼接产物、`edge/src/*.js` 或 `docs/feature-map.json` 时：`--ui` 会跑完整的
   `scripts/run_all_tests.sh`（含浏览器测试和 `node scripts/feature_map_walk.cjs --viewport all`）。
   没跑就在汇总里标 `NOT RUN` 并以 3 退出；交卷必须写明浏览器部分没验及原因。

发布前 CI 实际跑的离线测试以 `.github/workflows/daily.yml`「发布前验证」步骤的当前清单为准，不在这里抄数量。
动到公开包或 Worker 的改动，除本入口外还要逐条跑那份清单。

## 裁判不自改

- 被验的改动不能顺手改判定它的东西：守卫、守卫配置、本入口、本技能、验收规则。要改就单独开 PR，先审先合，
  合并后其他分支才按新规则判。改裁判的 PR 自身仍由当时 main 上的裁判判定。
- 入口用的是 main 的检查器，所以新加的守卫只在它合入 main 之后才对分支生效。

## 测试变弱必须写理由（`test-weakening` 守卫）

差异（相对 `merge-base(origin/main, HEAD)`，含未提交和未跟踪文件）里新增以下写法时，同一差异里必须写明理由，否则不过：

- 跳过测试：`unittest.skip*`、`pytest.mark.skip*`、`skipTest(`、`it.skip(` / `test.skip(` / `describe.skip(`
- 固定等待：`waitForTimeout(`
- 给断言套重试（仅测试文件）：`for attempt in …`、`while … retries`、`retry(` / `@retry`、`toPass(`、`expect.poll(`、`flaky`，前后 8 行内有断言

理由格式：在**同一行或上一行**写注释，且这一行也必须是本次新增的：

```python
@unittest.skipIf(shutil.which('git') is None, 'needs git')  # verify-allow: 容器里没有 git 时无法建临时仓库
```

```js
// verify-allow: 该动画没有完成事件，只能等固定时长
await page.waitForTimeout(300);
```

理由去掉标点和空白后至少 4 个字符；`TODO`、`TBD`、`FIXME`、`reason`、`later` 等占位词不分大小写、去标点后比较，
`TODO.`、`fixme!` 也不算。也可用通用写法 `guardrails:allow test-weakening <理由>`。
按共用验收口径，测试不稳时优先找根因；找不到就删掉该测试并在交卷里写明，不要用跳过、固定等待或重试刷绿。
这个守卫目前按「观察再执行」口径：只认上面列出的写法，已知漏网的写法（裸 `skipIf`、`pytest.skip()`、`xit` 等）
列在 `docs/guardrails.md#test-weakening` 的「已知缺口」里，命中不了不等于允许，交卷照样要写明。细则见同一节。

## 修 3 轮仍不过就停

同一步骤连续 3 次运行失败（入口在 `.local/verify/history.tsv` 计数，汇总会打印 `consecutive failing runs` 和 `STOP`），
停止修改，交给 ddx，附三轮的改法和报错。

这个计数只是本地提示，不是强制锁：`history.tsv` 在本机 `.local/` 下，删掉或换个工作树就会从 0 开始，入口也不会因此拒跑。
停手靠执行者自觉和交卷时如实写轮数。

## 交卷要附

- 入口汇总输出（含 `verify entry:` 那一行、裁判 SHA、每步 PASS/FAIL/NOT RUN）和 HEAD 完整 SHA。
- 一行「这次怎么验的，哪些没验、为什么」；离线核验、发布回执、线上验收分开写。

## 可选：只观察的提交钩子

`scripts/git-hooks/pre-commit` 在提交时用 `bash <(git show origin/main:scripts/verify.sh) --referee-only --no-fetch`
打印裁判守卫结果（入口同样取自 origin/main，main 上还没有入口时只打印跳过），从不拦提交。需要的人自己启用：
`git config core.hooksPath scripts/git-hooks`（撤销：`git config --unset core.hooksPath`）。不会自动安装到任何环境。
