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

20 行是 runner 级别的失败桶：1 个 `python-unittest` 聚合项、15 个 Node 浏览器项、4 个早期 Python UI 项。五个 Python 用例是第 1 行聚合项内部的详细案例，**不是另加五行**。原始失败原因和期望处理如下；当前 handoff 的完整浏览器验收尚未执行。

| # | Runner 项目 | 基线结果 | 实现后的处理 / 验收状态 |
|---:|---|---|---|
| 1 | `python-unittest`（含五个下列用例） | FAIL：运行时 `data/` 缺失；allowlist 无 `public/` | 指定用例改为可移植夹具；聚合项照常运行并保留真实失败。定向测试结果见交付消息；全套聚合验收待后续运行。 |
| 2 | `test_boot_url_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 安装 Playwright 后实际运行；缺包则启动前 `SKIP (Node playwright package not installed)`。完整运行待验收。 |
| 3 | `test_citation_export_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 4 | `test_deep_reader_history_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 5 | `test_doi_library_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 6 | `test_doi_miss_form_persist_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 7 | `test_doi_radar_archive_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 8 | `test_download_inline_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 9 | `test_filter_panel_toggle_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 10 | `test_fulltext_resilience_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 11 | `test_mobile_chipbar` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 12 | `test_mode_toolrow_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 13 | `test_popstate_restore_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 14 | `test_range_bar_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 15 | `test_topics_requests_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 16 | `test_ux_ce5de25_ui` | FAIL：Node Playwright `MODULE_NOT_FOUND` | 同上；完整运行待验收。 |
| 17 | `test_reading_mode_ui` | FAIL：`public/` 未构建 | fixture 成功时执行；没有 `public/` 或显式禁用 fixture 时，启动前显示依赖/路径原因并 `SKIP`。完整运行待验收。 |
| 18 | `test_request_loop_ui` | FAIL：`public/` 未构建 | 同上；完整运行待验收。 |
| 19 | `test_topic_multitag_ui` | FAIL：`public/` 未构建 | 同上；完整运行待验收。 |
| 20 | `test_search_zh_expansion_ui` | FAIL：`public/` 未构建 | 同上；完整运行待验收。 |

## 五个 Python 用例明细

| 测试 | 原读取/失败来源 | 实现处理 |
|---|---|---|
| `test_pipeline.PipelineTests.test_library_unique_and_paths_not_exposed` | `ROOT/data/library.json` | 使用已跟踪 `editorial/public_library_snapshot.json`；所有原断言保留。 |
| `test_pipeline.PipelineTests.test_public_allowlist` | 工作树没有已构建 `public/`；旧 synthetic HTML 不覆盖真实站点机密内容检查 | 通过 `prepare_fixture_workspace` 复制当前源码，在副本内运行 `build_browser_data.py` 与真实 `build_public.py`，再断言副本 `public/`；原 allowlist、路径和禁用内容断言保留，并比对源工作树 docs 文件哈希。 |
| `test_feed_health.HealthTests.test_main_collects_once_and_writes_current_health_despite_old_blocked_status` | `feeds.ROOT/data/library.json` | 读取已跟踪公开快照；临时写入路径和原断言保留。 |
| `test_feed_health.HealthTests.test_no_permanent_source_filter_and_enabled_scope_stays_website_only` | `feeds.ROOT/data/library.json` | 同上；原断言保留。 |
| `test_sol_gap_c_overlay.GapC.test_source_changes_or_rehashing_never_reuse_old_results` | 附件报告该用例经构建/校验路径遇到缺失数据；但同一 SHA 的先前干净克隆直接运行通过，失败链未在该场景复现 | 不改测试或 validator；先前输出为 1 test、55.654 秒、`OK`。本次未把它当作修改内容；原失败运行所用分支和输入是区分两种结果所需证据。 |

## PR #225 smoke 检查范围与线上验收边界

- runner 的本地浏览器执行门控影响 `scripts/smoke_live.py:CHECKS` 中的浏览器检查 ID：`205, 206, 208, 209, 210, 211, 212, 214, 216, 219, 220`。依赖缺失、没有 `public/` 或显式 `--no-browser` 时，在启动前按原因 `SKIP`；依赖齐全时本地 smoke 测试执行这些检查。
- 静态检查仍保留：`203, 204, 207, 213, 215, 217, 218, 221, 222, 223, 224, assets, budget, secrets`。此项只改本地测试 runner 和测试夹具，没有生产代码改动。
- 所有本地 smoke 自动化只使用测试内的 loopback fixture，并在外网不可达的 network namespace 中运行；**没有访问 `learn.dryz.info`，也没有执行线上 smoke**。这不是部署验收证据。
- 合并与部署后由 ddx 对 `learn.dryz.info` 执行 smoke，记录 release run 和完整 pass/fail 列表；任何失败都不能视为验收通过。该 post-deploy 验收当前仍待执行。

验收命令、SHA、完整 summary/skip 原因和日志路径见下方追加的 acceptance 记录。不得把本地离线结果表述成线上 smoke 通过。
