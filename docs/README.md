# docs 目录索引

先读仓库根目录的 [AGENTS.md](../AGENTS.md)：架构、本地构建、测试、约定与术语都在那里。本目录只放仍然有效的说明；各轮交接记录、按日期或版本命名的核验报告都在 [archive/](archive)，只作历史证据，内容可能与当前系统不符。

## 使用说明

| 文件 | 内容 |
| --- | --- |
| [使用说明.md](使用说明.md) | 读者使用手册（源文件） |
| 使用说明.html / 使用说明.pdf | 由 [manual-tools/](manual-tools) 从 Markdown 和 [manual-assets/](manual-assets) 截图导出的离线版本；截图是 2026-10-12 界面简化之前的，待界面定稿后重新导出。含截图的压缩包由同一脚本生成，不提交（`.gitignore` 忽略 `*.zip`） |

## 运维与部署

| 文件 | 内容 |
| --- | --- |
| [自动化发布说明.md](自动化发布说明.md) | GitHub Actions 流水线、state 分支、发布与回滚 |
| [部署到dryz.info.md](部署到dryz.info.md) | Cloudflare Pages 与域名部署 |
| [网站配置与外部状态清单.md](网站配置与外部状态清单.md) | 各项配置放在哪里、如何核对 |
| [运行依赖与故障复盘-20261010.md](运行依赖与故障复盘-20261010.md) | 外部依赖清单与 2026-10-10 故障复盘 |
| [云端协同同步总账-20261010.md](云端协同同步总账-20261010.md) | 截至 2026-10-10 的云端/GitHub 同步状态与未完成事项 |
| [服务运行说明.md](服务运行说明.md) | `service/` 本地编辑服务（不在公网运行） |

## 功能与接入说明

| 文件 | 内容 |
| --- | --- |
| [AI解读部署说明.md](AI解读部署说明.md) | `/api/ql`、`/api/ai`：AI 速览、翻译、综述、研究结构的配置与限额 |
| [AI速览方案B.md](AI速览方案B.md) | AI 速览预生成方案 |
| [每日全文精读.md](每日全文精读.md) | AI 全文精读的生成与展示规则 |
| [雷达365天存档说明.md](雷达365天存档说明.md) | 文献雷达 30/90/365 天存档 |
| [PDF下载接入.md](PDF下载接入.md) | 文献库 PDF 下载（口令只在 Cloudflare Secret） |
| [DOI按需全文与补录.md](DOI按需全文与补录.md) | 按 DOI 获取全文与补录题录 |
| [GitHub文献库接入.md](GitHub文献库接入.md) | 私有 GitHub 文献库作为后台来源 |
| [汉堡与Grok全文接入.md](汉堡与Grok全文接入.md) | 维护者模式汉堡入口与 Grok 全文回传 |
| [Muse网站接入.md](Muse网站接入.md) | Muse 原件送达与核验 |

## 由代码读写的文件（不要改名或移动）

| 路径 | 用途 |
| --- | --- |
| `public-manifest.json` | 公开文件清单；构建写入，发布守卫和 state 保存读取 |
| `last-refresh.json`、`deployment-status.json` | 流水线运行与发布结果；随 state 保存 |
| `本期群分享材料.md` | `scripts/build_share_pack.py` 的输出 |
| `journal-public-observations-batch1-20261007.json`、`journal-public-observations-batch6-20261007.json` | 期刊指标测试读取的观测数据 |
| [evidence/](evidence) | PubMed 研究状态证据，构建与测试读取其 manifest |
| [manual-tools/](manual-tools)、[manual-assets/](manual-assets) | 手册导出工具与截图 |

## 归档

[archive/](archive) 保存 2026-09-29 至 2026-10-10 的交接记录（如 `当前交付状态.md`、`其他Agent维护交接.md`）、版本发布与核验记录（`night-v14*`、`核验记录-2026100*`、`v14.4优化与发布-20261010.md` 等）、各专题的审计 JSON/CSV，以及原 `docs/history/`（现为 `archive/history/`）。
