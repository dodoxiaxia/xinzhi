# AGENTS.md — 心知文献学习站

所有 Agent（Claude、Codex、Gemini Antigravity 等）和人工维护者都从这里进入。本文件是唯一入口；`CLAUDE.md` 只指向这里。其他文档见 [docs/README.md](docs/README.md)，按日期命名的旧交接与核验记录都在 `docs/archive/`，只作历史证据，不描述当前系统。

- 公开网站：https://learn.dryz.info/ （Cloudflare Pages 项目 `dryz-xinzhi`）
- 仓库：`dodoxiaxia/xinzhi`，**公开仓库**。所有分支（包括 `state`）、提交历史和 Actions 日志都可被任何人读取。

## 1. 架构一页说明

```
RSS（config/ 与 data/feeds.json 中约 80 个信源）+ PubMed
        │  GitHub Actions: .github/workflows/daily.yml（daily-refresh）
        ▼
scripts/ci_daily.py 依次运行：
  apply_public_library.py → refresh_feeds.py --all → fetch_pubmed.py → merge_candidates.py
  → media_signals.py / auto_picks.py
  完整刷新（每天一次）另跑：fetch_archive.py、archive_details.py、translate_titles.py、
  generate_quicklooks.py（AI 速览）、week_precompute.py（近7天榜预生成）、daily_fulltext.py（AI 全文精读）
        │
        ▼
scripts/build_public.py  →  public/ 9 个公开文件
  index.html  public.js  radar.js  feed.xml  style.css  icon.png  demo-reading.html  _headers  _worker.js
        │  发布前离线测试（daily.yml 中的 node/unittest 列表）
        ▼
wrangler pages deploy public → Cloudflare Pages（dryz-xinzhi）
        │  发布成功后
        ▼
scripts/save_state.py：覆盖式写回 state 分支（data/、public/、docs/ 下三个状态 JSON；不保留历史）
```

- **调度**：daily.yml 每天北京时间 04:47 完整刷新，另有每 4 小时的轻量刷新兜底；`workers/cron-dispatch/` 是每 2 小时触发一次的外部定时器，`scripts/fast_refresh_gate.py` 限制轻量刷新间隔。推送到 main 且改动前端、`edge/`、`scripts/`、`editorial/` 等路径时也会运行（推送触发的运行不调用模型）。
- **其他工作流**：`fulltext.yml`（全文队列，仓库变量 `FULLTEXT_ASYNC_ENABLED` 为 true 时才运行）、`fulltext-import.yml`（`editorial/fulltext-imports.json` 导入）、`muse-review.yml`（每小时核验 Muse 送来的原件）、`muse-checks.yml` 与 `daily-reading-checks.yml`（PR 检查）。
- **state 分支**：保存运行时数据 `data/`、上次构建的 `public/`，以及 `docs/public-manifest.json`、`docs/last-refresh.json`、`docs/deployment-status.json`。工作流恢复 state 后再构建，state 从不覆盖 main 的代码。
  - **位置**：仓库变量 `XINZHI_STATE_REPO`（如 `dodoxiaxia/xinzhi-state`，私有）加 Secret `XINZHI_STATE_TOKEN`（只授权该私有仓库的 Contents 读写）时，所有读写都去那个私有仓库的 `state` 分支；两者都没配置时退回本仓库的 `state` 分支（公开）。`daily.yml`、`daily-reading-checks.yml` 与全文/周榜检查点（`week_precompute_ci.state_repository()`/`state_token()`）用同一位置。
  - **一次性迁移**：私有仓库还没有 `state` 时，`daily.yml` 的恢复步骤会先把本仓库的 `state` 复制过去；首次成功运行后可删除本仓库的 `state` 分支。
  - 本仓库仍是公开的：不要往 `data/` 以外的地方写不能公开的内容；在完成迁移前，`data/` 也要按公开对待。
- **API**：`edge/_worker.js` 由构建复制为 `public/_worker.js`，在 Pages 上提供 `/api/*`：AI 速览/翻译/综述/研究结构（`/api/ql`、`/api/ai`）、DOI 查重与补录、PDF 下载、全文任务、Muse/Grok 回传。存储用 KV `QL_KV`。配置项名称（不含值）见 [docs/AI解读部署说明.md](docs/AI解读部署说明.md)、[docs/PDF下载接入.md](docs/PDF下载接入.md)、[docs/网站配置与外部状态清单.md](docs/网站配置与外部状态清单.md)。
- **前端**：`index.html` + `app.js` + `citation-export.js` + `journal-metrics.js` + `style.css`；构建时把数据和脚本打包进 `public.js`。365 天雷达题录单独放在 `radar.js`，按需加载。
- **四个栏目**（URL 参数 `mode`）：

  | 栏目 | `mode` | 内容 |
  | --- | --- | --- |
  | 每日精选 | `curated`（默认） | 自动/人工挑选的当日文献，按日归档 |
  | 近7天榜 | `weekly` | 北京时间当日及前 6 天的 20–30 篇榜单；右栏/“全文精读”页签是 AI 全文精读目录 |
  | 文献雷达 | `candidates` | 近 14 天 RSS + PubMed 聚合，30/90/365 天来自雷达存档 |
  | 文献库 | `library` | 审核后的公开题录快照（`editorial/public_library_snapshot.json`）及 DOI 补录 |

  另有“信源状态”（`mode=sources`）。
- **其他目录**：`editorial/`（人工/会话审核过的内容与覆盖层，构建会读取）、`config/`（期刊指标、出版状态、题录裁定等）、`service/` 与 `editor/`（本地编辑服务，见 [docs/服务运行说明.md](docs/服务运行说明.md)，不在公网运行）。

## 2. 本地恢复数据、构建与预览

```sh
git fetch origin state                                # 迁移后改为：git fetch https://github.com/dodoxiaxia/xinzhi-state.git state（需有访问权）
git archive FETCH_HEAD | tar -x -C . data public       # data/ 与 public/ 已在 .gitignore
python3 scripts/build_public.py                        # 生成 public/ 9 个文件
python3 -m http.server 8765 --bind 127.0.0.1 --directory public   # http://127.0.0.1:8765/
```

- 构建会改写 `docs/public-manifest.json` 并生成 `docs/public-library-quality-audit.json`。**提交前**用 `git checkout docs/public-manifest.json` 恢复，并删除 `docs/public-library-quality-audit.json`。
- CI 在构建前还会运行 `scripts/apply_public_library.py`（写入审核后的公开题录快照）。只想预览界面时可以跳过。
- `scripts/serve_preview.py`（`start.command` 调用）只放行白名单文件，也可用来预览。

## 3. 测试

一条命令跑全部测试并汇总：

```sh
scripts/run_all_tests.sh               # Python 单元测试 + service 测试 + Node 测试 + 浏览器测试
scripts/run_all_tests.sh --no-browser  # 不需要 Chromium / public/ 的部分
```

日志在 `.local/test-logs/`。浏览器测试的截图和结果写到 `.local/` 下。

**浏览器环境**

- 浏览器测试需要先完成第 2 节的构建（测试直接读 `public/`）。
- Chromium 路径取环境变量 `CHROMIUM_PATH`，未设置时用 `/usr/bin/chromium`。云端容器里可以把它链接到 Playwright 自带的 Chromium，例如 `ln -sf /opt/pw-browsers/chromium-1194/chrome-linux/chrome /usr/bin/chromium`。
- Python 端用已安装的 `playwright` 包；Node 端需要 `NODE_PATH=$(npm root -g)` 才能找到全局安装的 Playwright（`run_all_tests.sh` 会自动设置）。
- 需要 UTF-8 locale（`LANG=C.UTF-8`），否则 Chromium 会把中文下载文件名存成 `download`。`run_all_tests.sh` 会自动设置。
- 浏览器测试是独立脚本（`python3 scripts/test_x_ui.py`），不是 unittest 模块。`test_brief_feedback_ui.py`、`test_navigation_search_ui.py`、`test_reader_drawer_scroll.py` 可以接一个目录参数并用 `--fixed` 区分修复前/后的预期；不带参数时检查本仓库的 `public/`，并按修复后的行为断言。

**已知的环境限制**（与代码无关）

- `test_muse_pdf_verifier.py` 需要 PyMuPDF（`fitz`），缺少时跳过。
- `test_worker_fetch_compat.cjs` 需要能启动的 `workerd`；CI 用 `npm exec --package=workerd@1.20261009.1 -- node scripts/test_worker_fetch_compat.cjs` 运行。

发布前 CI 实际运行的测试清单在 `daily.yml` 的“发布前验证”步骤里。新增测试时同时加到 `run_all_tests.sh`（浏览器测试）或保证它能被 `unittest discover` / `scripts/test_*.cjs` 自动发现。

## 4. 约定与禁区

- **公开仓库**：不提交口令、API key、token、Cookie、个人邮箱、内部文档 ID/链接、私人索引原始文件或未授权全文。已经进入历史的内容删不掉，提交前先检查 diff。
- **PDF 下载口令**只存在于 Cloudflare Secret `PDF_DOWNLOAD_PASSPHRASE`。代码、测试、文档、提交信息里都不写口令值；测试用明显的假值。其他凭据（`LLM_API_KEY`、`GITHUB_LIBRARY_TOKEN`、GitHub Actions 的 `XINZHI_LLM_API_KEY`、`CLOUDFLARE_API_TOKEN` 等）同理，只在 Cloudflare/GitHub 的 Secret 中配置。
- **AI 内容必须标注“未经人工核对”**（或同义的“未经人工审核”“未经人工医学终审”）。AI 速览、机器翻译、AI 综述、AI 全文精读都要带标注；不要把 AI 结果显示成“已核对导读”。
- **不要用旧导入脚本覆盖公开题录**：`scripts/build_data.py`、`service/import_data.py` 等早期导入工具不能用来重建文献库。文献库只能通过审核后的快照（`editorial/public_library_snapshot.json` + manifest，由 `apply_public_library.py` 应用）更新，构建守卫会阻止旧状态覆盖已批准条目。也不要恢复旧前端模板。
- **公开文件白名单**：只发布第 1 节列出的 9 个文件。不上传 PDF、数据库、`.local/`、凭据或内部记录。
- **`app.js` 与 `edge/_worker.js` 是拼接产物**：源码在 `src/app/*.js` 与 `edge/src/*.js`（按文件名顺序逐字拼接）。改源文件后运行 `python3 scripts/build_sources.py`，并把拼接结果一起提交；不要直接编辑 `app.js` 或 `_worker.js`（`build_public.py` 与测试会检查两者是否一致）。
- **界面只有一套风格 + 深浅色**：「临床期刊」风格（`data-style="a"` 固定），旧链接里的 `?style=` 会被忽略。筛选区为「领域 + 时间 + 搜索」常显，其余在「更多筛选」里；期刊只有出版方/期刊树一个入口。
- **改界面要同步更新 UI 测试**：改 `index.html`、`src/app/`、`style.css` 时，运行浏览器测试，并在同一提交里更新失效的断言（保持断言原意）。
- **维护者模式**：汉堡菜单（登录、按 DOI 获取全文等）只对维护者显示。在浏览器访问一次 `?maintainer=1` 开启（存在 localStorage），`?maintainer=0` 关闭。普通读者看不到这些入口。
- **历史与返回键**：切换栏目会 `pushState`，返回键回到上一个栏目；打开阅读面板/精选清单会压入一条历史，返回键先关闭面板（见 `scripts/test_reader_overlays_ui.py`）。
- **模型调用要有边界**：打开页面不触发付费生成；网络中断后进入“完成状态尚未确认”等待态，只允许只读查询，不自动重新提交。
- **分支**：不要直接推 main；不要删除别人的远程分支。

## 5. 术语表

界面和文档统一使用左列用语。右列是代码或旧文档里仍能看到的旧称，新内容不要再用。

| 统一用语 | 含义 | 旧称 / 代码中的名字 |
| --- | --- | --- |
| 每日精选 | 首页栏目，`mode=curated` | 日报、今日精选、`curated` |
| 近7天榜 | 近 7 天 20–30 篇榜单，`mode=weekly` | 每周精读、每周共读、周榜、近7日榜、`weekly`、`WEEKLY_BOARD` |
| 文献雷达 | 近 14 天聚合 + 365 天存档，`mode=candidates` | 雷达、候选池、`candidates`、`RADAR` |
| 文献库 | 审核后的公开题录，`mode=library` | 公共题录、私有文献库（指来源）、`library` |
| 信源状态 | 各 RSS/PubMed 信源健康度，`mode=sources` | 信源健康、`source-health` |
| 精选清单 | 读者自己加入的待讨论文献（仅存本浏览器） | 晨会单、晨会清单、讨论清单、huddle（代码：`huddle*`、`#openHuddleBtn`） |
| 讨论提纲 | 基于精选清单生成的 AI 提纲 | 晨会提纲、`brief`（mode=huddle） |
| 综述速读 | 基于当前结果生成的 AI 综述 | AI 综述、digest、`brief`（mode=digest） |
| 全文精读 | 读全文后写的长篇解读；AI 生成的叫“AI 全文精读”，人工写的叫“人工精读示范” | 每日全文精读、深读、deep reading（代码：`deepReading*`、`daily_fulltext.py`） |
| AI 速览 | 模型根据公开摘要生成的要点，未经人工核对 | AI 解读、一键 AI 解读、quicklook（代码：`quicklook*`、`/api/ql`） |
| 已核对导读 | 对照期刊公开摘要核对过的中文导读，未经医生终审 | 导读、摘要核对导读、摘要核对、guide（代码：`draftData`、`reading=guide`） |
| 原摘要 / 中英对照 | 期刊公开摘要及机器翻译 | 摘要翻译、translation |
| 阅读面板 | 点开文献后右侧（手机为全屏）的阅读区 | 抽屉、drawer、速读（按钮文字） |
| 关注期刊 / 我的期刊 | 收藏的期刊及按收藏筛选（仅存本浏览器） | favorites |
| 维护者模式 | `?maintainer=1` 开启的汉堡入口 | 汉堡登录 |

## 6. 文档索引

- 使用说明：[docs/使用说明.md](docs/使用说明.md)
- 运维与发布：[docs/自动化发布说明.md](docs/自动化发布说明.md)、[docs/部署到dryz.info.md](docs/部署到dryz.info.md)、[docs/运行依赖与故障复盘-20261010.md](docs/运行依赖与故障复盘-20261010.md)
- 完整目录：[docs/README.md](docs/README.md)
