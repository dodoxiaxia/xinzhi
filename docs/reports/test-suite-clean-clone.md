# 干净克隆测试套件根因与前后对照

## 范围与证据边界

本报告记录 t23 的已知根因、runner 项目映射和验收证据。实现克隆基于 `e40c86d316e1965784fc0860c04bb080354aab8f`，分支为 `devin/1795167808-t23-clean-clone-tests`。下表将原始基线与本次验收结果分开记录；基线失败数和后续验收结果不可互相替代。

附件记录的原始基线来自 `4cdd352`：`82 passed, 20 failed, 3 skipped`。此前 `e40c86d` 干净克隆的补充 `--no-browser` 基线为 `74 passed, 2 failed, 18 skipped`，退出码 1；这不是本次实现后的全套运行，也不能证明所有测试已全绿。相关旧报告与日志：`/home/ubuntu/xinzhi-baseline-report.md`、`/home/ubuntu/xinzhi-baseline-test-run.log`。

## 根因

1. Python 聚合 `python-unittest` 中四个用例直接依赖被 `.gitignore` 排除的 `data/` 或构建后的 `public/`。附件也将 Gap C 用例归因于经 `verify_public_sol_gap.py`、`build_public.public_weekly_board` 和 `week_precompute.validate` 进入缺少运行时输入的路径；但该具体用例此前在 `e40c86d` 干净克隆直接通过，因此附件所述失败链未在本场景独立复现，缺少原失败运行的分支/输入证据，未据此改 validator。三个读快照用例改用已跟踪的 `editorial/public_library_snapshot.json`；公开 allowlist 每次都用临时当前源码副本，调用 runner 的 `prepare_fixture_workspace` 生成真实浏览器数据并运行真实 `build_public.py`，不依赖已有运行时数据，也不改真实工作树。
2. 15 个 Node 浏览器测试在没有 Node Playwright 时直接启动并报 `MODULE_NOT_FOUND`，旧 runner 将环境缺失记为失败。现在 runner 先检测 Node Playwright；只有 Node 浏览器项目在缺包时会在启动前按名称 `SKIP`，非浏览器 Node 项目照常运行。
3. 四个早期 Python UI 项目需要 `public/`，干净克隆没有生成目录。现在默认只在 `data/` 不存在时从离线夹具创建公开构建；`--fixture` 在隔离副本运行。没有可用 `public/` 时，相关浏览器 wrapper 在启动前按原因 `SKIP`。
4. 旧 runner 把 Chromium 固定默认到 `/usr/bin/chromium`，无法适配其他系统路径或 Playwright 自带浏览器。新检测按显式环境变量、三个约定系统路径、Playwright 自带浏览器顺序回退，并将选择导出到子进程。
5. `build_public.py` 的输出根固定为仓库根，并会改写跟踪的 `docs/public-manifest.json`。不能在维护者工作树中直接构建；新 runner 在隔离源码副本内构建，自动模式只复制缺失且被忽略的 `data/`、`public/` 输出。

## 20 个 runner 失败项前后映射

20 行是 runner 级别的失败桶：1 个 `python-unittest` 聚合项、15 个 Node 浏览器项、4 个早期 Python UI 项。五个 Python 用例是第 1 行聚合项内部的详细案例，**不是另加五行**。基线结果与分配置验收结果分开记录；完整工具、Node Playwright 物理缺失和 `--no-browser` 三个 fresh clone 均已运行。当前 main 基线另有 `test_list_readability_ui` 失败（不属于原 20 行映射），详见实测记录。

| # | Runner 项目 | 基线结果 | 实现后的处理 / 验收状态 |
|---:|---|---|---|
| 1 | `python-unittest`（含五个下列用例） | FAIL：运行时 `data/` 缺失；allowlist 无 `public/` | fresh clone 三种配置均 PASS，均运行 1193 个 unittest；`--fixture` 不含 `.git` 也未跳过 integrity 测试。完整工具与 Node 缺包/无浏览器配置结果见实测记录。 |
| 2 | `test_boot_url_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；真实 Node 包缺失 clone 与显式 `--no-browser` 均在启动前按原因 SKIP。 |
| 3 | `test_citation_export_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 4 | `test_deep_reader_history_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 5 | `test_doi_library_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 6 | `test_doi_miss_form_persist_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 7 | `test_doi_radar_archive_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 8 | `test_download_inline_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 9 | `test_filter_panel_toggle_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 10 | `test_fulltext_resilience_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 11 | `test_mobile_chipbar` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 12 | `test_mode_toolrow_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 13 | `test_popstate_restore_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 14 | `test_range_bar_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 15 | `test_topics_requests_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 16 | `test_ux_ce5de25_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 完整工具 fresh clone PASS；Node 包缺失/`--no-browser` 时按原因 SKIP。 |
| 17 | `test_reading_mode_ui` | FAIL：`public/` 未构建 | 完整工具和 Node 缺包 fresh clone 均 PASS；`--no-browser` 时因显式选项 SKIP。 |
| 18 | `test_request_loop_ui` | FAIL：`public/` 未构建 | 完整工具和 Node 缺包 fresh clone 均 PASS；`--no-browser` 时因显式选项 SKIP。 |
| 19 | `test_topic_multitag_ui` | FAIL：`public/` 未构建 | 完整工具和 Node 缺包 fresh clone 均 PASS；`--no-browser` 时因显式选项 SKIP。 |
| 20 | `test_search_zh_expansion_ui` | FAIL：`public/` 未构建 | 完整工具和 Node 缺包 fresh clone 均 PASS；`--no-browser` 时因显式选项 SKIP。 |

## 五个 Python 用例明细

| 测试 | 原读取/失败来源 | 实现处理 |
|---|---|---|
| `test_pipeline.PipelineTests.test_library_unique_and_paths_not_exposed` | `ROOT/data/library.json` | 使用已跟踪 `editorial/public_library_snapshot.json`；所有原断言保留。 |
| `test_pipeline.PipelineTests.test_public_allowlist` | 工作树没有已构建 `public/`；旧 synthetic HTML 不覆盖真实站点机密内容检查 | 通过 `prepare_fixture_workspace` 复制当前源码，在副本内运行 `build_browser_data.py` 与真实 `build_public.py`，再断言副本 `public/`；原 allowlist、路径和禁用内容断言保留，并比对源工作树 docs 文件哈希。 |
| `test_feed_health.HealthTests.test_main_collects_once_and_writes_current_health_despite_old_blocked_status` | `feeds.ROOT/data/library.json` | 读取已跟踪公开快照；临时写入路径和原断言保留。 |
| `test_feed_health.HealthTests.test_no_permanent_source_filter_and_enabled_scope_stays_website_only` | `feeds.ROOT/data/library.json` | 同上；原断言保留。 |
| `test_sol_gap_c_overlay.GapC.test_source_changes_or_rehashing_never_reuse_old_results` | 附件报告该用例经构建/校验路径遇到缺失数据；但同一 SHA 的先前干净克隆直接运行通过，失败链未在该场景复现 | 不改该测试或 validator；先前输出为 1 test、55.654 秒、`OK`。原失败运行所用分支和输入是区分两种结果所需证据。 |

## PR #225 smoke 检查范围与线上验收边界

- runner 的本地浏览器执行门控影响 `scripts/smoke_live.py:CHECKS` 中的浏览器检查 ID：`205, 206, 208, 209, 210, 211, 212, 214, 216, 219, 220`。依赖缺失、没有 `public/` 或显式 `--no-browser` 时，在启动前按原因 `SKIP`；依赖齐全时本地 smoke 测试执行这些检查。
- 静态检查仍保留：`203, 204, 207, 213, 215, 217, 218, 221, 222, 223, 224, assets, budget, secrets`。此项只改本地测试 runner 和测试夹具，没有生产代码改动。
- 所有本地 smoke 自动化只使用测试内的 loopback fixture，并在外网不可达的 network namespace 中运行；**没有访问 `learn.dryz.info`，也没有执行线上 smoke**。这不是部署验收证据。
- 合并与部署后由 ddx 对 `learn.dryz.info` 执行 smoke，记录 release run 和完整 pass/fail 列表；任何失败都不能视为验收通过。该 post-deploy 验收当前仍待执行。

本地离线结果不是线上 smoke 或部署验收证据；完整命令、SHA、summary、skip 原因和日志路径列于下文。

## 2026-11-20 本地离线验收记录

所有下列测试进程通过 `unshare --user --map-root-user --net` 运行，启动时仅配置 loopback（`ip link set lo up`）；允许本地 smoke fixture，禁止外网。环境使用 Python 3.11.17 venv、Node v24.22.2、Python/Node Playwright 和 Google Chrome for Testing 156.0.8078.47；Node 缺包用例另有注明。没有访问线上站点、production/state、Secret 或模型服务。

### pristine main 全套 baseline

- 克隆：`/home/ubuntu/xinzhi-clean-baseline`，`main`，SHA `e40c86d316e1965784fc0860c04bb080354aab8f`；运行前无 `data/`、`public/`，跟踪文件工作树干净。
- 命令：在上述网络 namespace 中加载已有 Python venv、nvm 默认 Node，设置 `NODE_PATH="$(npm root -g)"`、`CHROMIUM_PATH="$HOME/.local/bin/google-chrome"`、`LANG=C.UTF-8`，直接执行 `./scripts/run_all_tests.sh`（无 `--no-browser`）。
  ```sh
  source /home/ubuntu/repos/xinzhi/.local/test-venv/bin/activate
  source "$HOME/.nvm/nvm.sh" --no-use && nvm use default
  export NODE_PATH="$(npm root -g)" CHROMIUM_PATH="$HOME/.local/bin/google-chrome" LANG=C.UTF-8
  ./scripts/run_all_tests.sh
  ```
- 输出：`== Summary: 98 passed, 6 failed, 2 skipped`，退出码 `1`。`python-unittest` 内 `Ran 1181 tests in 448.415s`、`FAILED (failures=1, errors=3)`；3 个错误引用缺失的 `data/library.json`，`test_public_allowlist` 因未构建 `public/` 失败。另有 `test_reading_mode_ui`、`test_request_loop_ui`、`test_list_readability_ui`、`test_topic_multitag_ui`、`test_search_zh_expansion_ui` 五项失败，均在没有公开构建的基线。两个 skip 是 `first-screen-budget` 与 `python browser tests`，原因都是 `public/ not built (python3 scripts/build_public.py)`。
- 主日志：`/home/ubuntu/xinzhi-t23-main-full-baseline-20261120T103219Z.log`；该 run 是新增全套基线，不能替换前述 `4cdd352` 的 `82/20/3`，也不能替换先前 e40c `--no-browser` 的 `74/2/18`。

### 修正后 `--fixture --no-browser` 工作树实测（独立于 clean-clone #3）

- 命令：实现工作树中直接执行 `./scripts/run_all_tests.sh --fixture --no-browser`；fixture 复制排除 `.git`，实际运行完整测试。结果：Python `Ran 1193 tests in 518.948s`、`OK`；runner `== Summary: 78 passed, 0 failed, 47 skipped`，退出码 `0`。
- 47 项均为显式 `--no-browser requested`，不是环境缺失或命令失败；所有已启动测试通过。此项直接验证了不含 `.git` 的 fixture 导出可运行完整 integrity 测试。
- 日志：`/home/ubuntu/xinzhi-t23-fixture-no-browser-20261120T102136Z.log`。该测试在本地提交 `4345acfaad17f4b0f9ea7915b5152c5f42dd436b` 前运行；代码/测试与该提交相同，之后仅补了报告中的 #225 smoke 范围说明。

### fresh local clone：完整工具，全 runner

- 克隆 `/home/ubuntu/xinzhi-t23-acceptance-full`，测试 SHA `4345acfaad17f4b0f9ea7915b5152c5f42dd436b`；运行前为干净克隆，无 `data/`、`public/`。工具探测确认 Python Playwright、Node Playwright、Chrome 均可用。
- 命令：在同一外网隔离 namespace 中直接执行 `./scripts/run_all_tests.sh`。runner 自动生成离线 fixture，发布到 clone 忽略的 `data/`、`public/`。
  ```sh
  source /home/ubuntu/repos/xinzhi/.local/test-venv/bin/activate
  source "$HOME/.nvm/nvm.sh" --no-use && nvm use default
  export NODE_PATH="$(npm root -g)" CHROMIUM_PATH="$HOME/.local/bin/google-chrome" LANG=C.UTF-8
  ./scripts/run_all_tests.sh
  ```
- 输出：Python `Ran 1193 tests in 522.254s`、`OK`；`== Summary: 124 passed, 0 failed, 0 skipped`，退出码 `0`。包括所有 Node/Python 浏览器用例与 first-screen budget；无 browser skip。
- 日志：`/home/ubuntu/xinzhi-t23-acceptance-full-20261120T104600Z.log`。

### fresh local clone：Node Playwright 物理缺失

- 克隆 `/home/ubuntu/xinzhi-t23-acceptance-no-node`，测试 SHA 同为 `4345acfaad17f4b0f9ea7915b5152c5f42dd436b`。Node v24.22.2 安装复制到 `/home/ubuntu/xinzhi-t23-node-no-playwright/`，仅从该一次性副本移除 `lib/node_modules/playwright`；`npm root -g` 指向副本，`node -e "require.resolve('playwright')"` 确认不可解析。共享 Node 安装中的 Playwright 仍存在。Python Playwright 与 Chrome 可用。
- 命令：`PATH` 前置副本 `bin/`、`NODE_PATH=/home/ubuntu/xinzhi-t23-node-no-playwright/lib/node_modules`，在外网隔离 namespace 中直接执行 `./scripts/run_all_tests.sh`。
  ```sh
  source /home/ubuntu/repos/xinzhi/.local/test-venv/bin/activate
  export PATH="/home/ubuntu/xinzhi-t23-node-no-playwright/bin:$PATH"
  export NODE_PATH="/home/ubuntu/xinzhi-t23-node-no-playwright/lib/node_modules"
  export CHROMIUM_PATH="$HOME/.local/bin/google-chrome" LANG=C.UTF-8
  ./scripts/run_all_tests.sh
  ```
- 输出：Python `Ran 1193 tests in 519.587s`、`OK`；`== Summary: 106 passed, 0 failed, 18 skipped`，退出码 `0`。18 个 skip 全部且仅因 `Node playwright package not installed`：`test_boot_url_ui`、`test_citation_export_ui`、`test_deep_reader_history_ui`、`test_doi_direct_download`、`test_doi_library_ui`、`test_doi_miss_form_persist_ui`、`test_doi_radar_archive_ui`、`test_download_inline_ui`、`test_filter_panel_toggle_ui`、`test_fulltext_resilience_ui`、`test_grok_fulltext`、`test_mobile_chipbar`、`test_mode_toolrow_ui`、`test_popstate_restore_ui`、`test_range_bar_ui`、`test_topics_requests_ui`、`test_ux_ce5de25_ui`、`feature-map-walk`。Python 浏览器测试和其他 Node 项目照常运行。
- 日志：`/home/ubuntu/xinzhi-t23-acceptance-no-node-20261120T110524Z.log`。

### fresh local clone：`--no-browser`

- 克隆 `/home/ubuntu/xinzhi-t23-acceptance-no-browser`，测试 SHA `4345acfaad17f4b0f9ea7915b5152c5f42dd436b`；起始克隆无 `data/`、`public/`。runner 生成的目录是被忽略输出；测试后 `git status --short` 为空。
- 精确命令（在该 clone 根目录，外层 network namespace 用 `unshare --user --map-root-user --net`，并先 `ip link set lo up`）：
  ```sh
  source /home/ubuntu/repos/xinzhi/.local/test-venv/bin/activate
  source "$HOME/.nvm/nvm.sh" --no-use && nvm use default >/dev/null
  export NODE_PATH="$(npm root -g)" CHROMIUM_PATH="$HOME/.local/bin/google-chrome" LANG=C.UTF-8
  ./scripts/run_all_tests.sh --no-browser
  ```
- 输出：Python `Ran 1193 tests in 526.432s`、`OK`；`== Summary: 78 passed, 0 failed, 47 skipped`，退出码 `0`。47 个 skip 全部原因为 `--no-browser requested`，不是工具缺失：`smoke-live browser tests`；`test_boot_url_ui`、`test_citation_export_ui`、`test_deep_reader_history_ui`、`test_doi_direct_download`、`test_doi_library_ui`、`test_doi_miss_form_persist_ui`、`test_doi_radar_archive_ui`、`test_download_inline_ui`、`test_filter_panel_toggle_ui`、`test_fulltext_resilience_ui`、`test_grok_fulltext`、`test_mobile_chipbar`、`test_mode_toolrow_ui`、`test_popstate_restore_ui`、`test_range_bar_ui`、`test_topics_requests_ui`、`test_ux_ce5de25_ui`；`feature-map-walk`；`test_reading_shards_ui`、`test_reading_mode_ui`、`test_mwg_local_ui`、`test_request_loop_ui`、`test_weekly_layout_ui`、`test_list_readability_ui`、`test_long_titles_ui`、`test_topic_multitag_ui`、`test_radar_filter_followup_ui`、`test_search_zh_expansion_ui`；`test_back_to_top_ui`、`test_brief_feedback_ui`、`test_curated_doi_layout_ui`、`test_deferred_reader_ui`、`test_faceted_filters_ui`、`test_journal_ui`、`test_layout_ui`、`test_mobile_library_ui`、`test_navigation_search_ui`、`test_reader_drawer_scroll`、`test_reader_overlays_ui`、`test_search_shortlist_ui`、`test_search_toggle_ui`、`test_sidebar_focus_trap_ui`、`test_sol_gap_reader`、`test_weekly_ui`、`test_list_actions_ui`、`test_shortlist_share_ui`。
- 主日志：`/home/ubuntu/xinzhi-t23-acceptance-no-browser-20261120T112217Z.log`；Python 子日志：`/home/ubuntu/xinzhi-t23-acceptance-no-browser/.local/test-logs/python-unittest.log`。

### 要求检查命令

- `python3 scripts/build_sources.py --check`：`up to date`，退出码 `0`。
- `python3 scripts/check_guardrails.py`：最初在无 `public/` 的工作树运行时打印 `SKIP public-ids: no public/ dir`、`guardrails: all checks passed`，退出码 `0`；完成最终报告后，`public/` 已由离线夹具生成，再次运行打印 `guardrails: all checks passed`，退出码 `0`。
- `python3 scripts/test_run_all_tests_harness.py`：`Ran 12 tests`、`OK`，退出码 `0`。
- 直接执行 `./scripts/run_all_tests.sh --help` 成功（退出码 `0`），确认 runner 可直接调用且为可执行文件。
- canonical `bash <(git show origin/main:scripts/verify.sh) --no-fetch` 已完成，退出码 `0`；使用 referee `origin/main` SHA `e40c86d316e1965784fc0860c04bb080354aab8f`（提交日期 `2026-11-19T17:52:47-06:00`）。离线选项打印警告 `WARNING --no-fetch: referee origin/main may be stale; using e40c86d316e1 committed 2026-11-19T17:52:47-06:00`；`guardrails-referee`、`build-sources-check` 和 `run-all-tests-no-browser` 均 PASS。完整输出见下方。

## 断言和 runner 清单核对

- 将基线 `e40c86d316e1965784fc0860c04bb080354aab8f` 与当前代码的断言 AST 做多重集比较：`scripts/test_pipeline.py` 基线 17 个断言节点、当前 19 个，17 个旧节点全部保留；新增两项只验证 fixture 构建成功和真实源码 docs 哈希未变。`scripts/test_feed_health.py` 基线/当前均为 145 个断言节点，全部一致。`test_public_allowlist` 的断言移入临时 fixture 上下文，但 AST、字符串和断言语义均未改；`test_release_build.py` 与所有浏览器测试文件未改。
- runner 清单正则比较得到基线/当前均 14 个测试脚本引用，旧 runner 中的 14 项全部保留。仓库跟踪 mode 为 `100755`，工作树 mode 为 `755`；实际测试命令直接调用 `./scripts/run_all_tests.sh`（选项随配置变化），与 `bash scripts/run_all_tests.sh` 等价。`./scripts/run_all_tests.sh --help` 已成功，未为重复确认而重跑。
- 禁止字符串对照：基线与当前 tuple 均含精确字面量 `当前路径` 1 次，`当 前路径` 0 次。之前审查中出现的空格版本最可能是重写 allowlist setup 时手动重录 tuple 的疏忽；该中间文件/diff 未保存，无法确认具体编辑动作。现已恢复为基线原值，基线到最终提交的断言 AST 比较确认无旧断言丢失或改值。

## 三个 fresh-clone runner 的完整 summary 输出

### 全工具 full runner

```text
== Summary: 124 passed, 0 failed, 0 skipped
Log: /home/ubuntu/xinzhi-t23-acceptance-full-20261120T104600Z.log
Exit code: 0
```

### Node Playwright 在隔离副本中物理缺失

```text
== Summary: 106 passed, 0 failed, 18 skipped
  SKIP test_boot_url_ui: Node playwright package not installed
  SKIP test_citation_export_ui: Node playwright package not installed
  SKIP test_deep_reader_history_ui: Node playwright package not installed
  SKIP test_doi_direct_download: Node playwright package not installed
  SKIP test_doi_library_ui: Node playwright package not installed
  SKIP test_doi_miss_form_persist_ui: Node playwright package not installed
  SKIP test_doi_radar_archive_ui: Node playwright package not installed
  SKIP test_download_inline_ui: Node playwright package not installed
  SKIP test_filter_panel_toggle_ui: Node playwright package not installed
  SKIP test_fulltext_resilience_ui: Node playwright package not installed
  SKIP test_grok_fulltext: Node playwright package not installed
  SKIP test_mobile_chipbar: Node playwright package not installed
  SKIP test_mode_toolrow_ui: Node playwright package not installed
  SKIP test_popstate_restore_ui: Node playwright package not installed
  SKIP test_range_bar_ui: Node playwright package not installed
  SKIP test_topics_requests_ui: Node playwright package not installed
  SKIP test_ux_ce5de25_ui: Node playwright package not installed
  SKIP feature-map-walk: Node playwright package not installed
Log: /home/ubuntu/xinzhi-t23-acceptance-no-node-20261120T110524Z.log
Exit code: 0
```

### `--no-browser`

```text
== Summary: 78 passed, 0 failed, 47 skipped
  SKIP smoke-live browser tests: --no-browser requested
  SKIP test_boot_url_ui: --no-browser requested
  SKIP test_citation_export_ui: --no-browser requested
  SKIP test_deep_reader_history_ui: --no-browser requested
  SKIP test_doi_direct_download: --no-browser requested
  SKIP test_doi_library_ui: --no-browser requested
  SKIP test_doi_miss_form_persist_ui: --no-browser requested
  SKIP test_doi_radar_archive_ui: --no-browser requested
  SKIP test_download_inline_ui: --no-browser requested
  SKIP test_filter_panel_toggle_ui: --no-browser requested
  SKIP test_fulltext_resilience_ui: --no-browser requested
  SKIP test_grok_fulltext: --no-browser requested
  SKIP test_mobile_chipbar: --no-browser requested
  SKIP test_mode_toolrow_ui: --no-browser requested
  SKIP test_popstate_restore_ui: --no-browser requested
  SKIP test_range_bar_ui: --no-browser requested
  SKIP test_topics_requests_ui: --no-browser requested
  SKIP test_ux_ce5de25_ui: --no-browser requested
  SKIP feature-map-walk: --no-browser requested
  SKIP test_reading_shards_ui: --no-browser requested
  SKIP test_reading_mode_ui: --no-browser requested
  SKIP test_mwg_local_ui: --no-browser requested
  SKIP test_request_loop_ui: --no-browser requested
  SKIP test_weekly_layout_ui: --no-browser requested
  SKIP test_list_readability_ui: --no-browser requested
  SKIP test_long_titles_ui: --no-browser requested
  SKIP test_topic_multitag_ui: --no-browser requested
  SKIP test_radar_filter_followup_ui: --no-browser requested
  SKIP test_search_zh_expansion_ui: --no-browser requested
  SKIP test_back_to_top_ui: --no-browser requested
  SKIP test_brief_feedback_ui: --no-browser requested
  SKIP test_curated_doi_layout_ui: --no-browser requested
  SKIP test_deferred_reader_ui: --no-browser requested
  SKIP test_faceted_filters_ui: --no-browser requested
  SKIP test_journal_ui: --no-browser requested
  SKIP test_layout_ui: --no-browser requested
  SKIP test_mobile_library_ui: --no-browser requested
  SKIP test_navigation_search_ui: --no-browser requested
  SKIP test_reader_drawer_scroll: --no-browser requested
  SKIP test_reader_overlays_ui: --no-browser requested
  SKIP test_search_shortlist_ui: --no-browser requested
  SKIP test_search_toggle_ui: --no-browser requested
  SKIP test_sidebar_focus_trap_ui: --no-browser requested
  SKIP test_sol_gap_reader: --no-browser requested
  SKIP test_weekly_ui: --no-browser requested
  SKIP test_list_actions_ui: --no-browser requested
  SKIP test_shortlist_share_ui: --no-browser requested
Log: /home/ubuntu/xinzhi-t23-acceptance-no-browser-20261120T112217Z.log
Exit code: 0
```

### Canonical referee

```text
== verify entry: referee origin/main@e40c86d316e1 (2026-11-19T17:52:47-06:00)
WARNING --no-fetch: referee origin/main may be stale; using e40c86d316e1 committed 2026-11-19T17:52:47-06:00
== verify summary (referee origin/main@e40c86d316e1 (2026-11-19T17:52:47-06:00))
  PASS guardrails-referee
  PASS build-sources-check
  PASS run-all-tests-no-browser
Log: /home/ubuntu/xinzhi-t23-canonical-verify-20261120T113413Z.log
Exit code: 0
```

## 跳过了什么

- 全工具 full runner：0 项 skip，所有 124 项通过。
- Node Playwright 缺失配置：18 项，完整名称与原因见上方块；Node 包确实只从一次性副本移除，Python Playwright、Chrome、非浏览器 Node 测试仍运行。
- `--no-browser` fresh clone 和 canonical verifier：各 47 项，完整名称见上方块，原因均为显式 `--no-browser requested`；因此这些配置不能作为浏览器通过证据。
- main 基线的 2 项 skip：`first-screen-budget`、`python browser tests`，均因 `public/ not built (python3 scripts/build_public.py)`。

## 哪些没有验证

- 未对 `learn.dryz.info` 或任何 production/state/Secret/付费模型服务运行测试，未进行 post-deploy smoke；部署后由 ddx 记录 release run 和完整 pass/fail 列表，任何失败都不接受。
- 未从零安装依赖；所有运行复用现有 Python venv、Node、Playwright 与 Chrome。Node 缺包场景只删除一次性副本中的 Playwright，没有改共享安装。
- 不把离线 fixture 浏览器结果外推为线上部署状态；没有创建 PR，也未运行 PR/CI workflow。
- 新增/修改的 Markdown 未做视觉渲染检查。

## 有什么风险

- main 的 pristine baseline 确实未通过（`98 passed, 6 failed, 2 skipped`）；缺失运行时 `data/`、`public/` 可解释相关失败，但这只说明基线不便携，不证明当前 main 全部测试为绿。附件基线 `4cdd352` 的 `82/20/3` 与 e40c `--no-browser` 的 `74/2/18` 是不同运行，不能互相替换。
- `--no-browser` 有意跳过全部浏览器项目；Node 缺包配置也只验证了正确 `SKIP` 行为。完整浏览器本地证据仅来自已安装 Playwright/Chrome 且使用离线 fixture 的 fresh clone。
- `--no-fetch` 使 canonical referee 可能过期；本次实际使用的 `origin/main` SHA 与日期已记录，未联网更新远端 ref。
- 临时错误字面量的精确键入原因因无保存的中间 patch 无法证实；最终文件与基线断言 AST 已对照，所有旧断言均保留。
