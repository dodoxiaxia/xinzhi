# 全文口令与 PDF 下载

2026-10-07：按用户要求，全文采用简单的共享口令。文献卡片、紧凑列表和阅读详情点击“下载 PDF”，在新页面输入全文口令，正确后直接保存文件。官网原文入口保留。

## 下载流程

浏览器访问同源 `/api/pdf?id=公开文献ID`，GET 只展示口令表单。口令通过 POST 请求体发送，服务端校验通过后才读取私有 `dodoxiaxia/AI-` 索引与 PDF；错误时提示重新输入。每篇下载单独验证，不要求账号登录，不将口令保存到浏览器。

默认口令采用本次会话指定值，源码只保存 SHA-256 摘要；前端、表单回显、URL 和请求日志不含口令。可选服务端 Secret `PDF_DOWNLOAD_PASSPHRASE` 覆盖默认值，用于以后修改口令。

服务端只接受现有文献库中的 ID，按 DOI 精确匹配；无 DOI 时仅接受唯一的完全相同题名（忽略大小写和连续空白），不用模糊匹配。有 DOI 的条目不回退到题名。索引和单篇 PDF 固定在同一 GitHub commit。匹配歧义、异常校验记录、非 PDF 或缺少全文时拒绝下载并提示官网入口。下载响应为 `application/pdf` 与 attachment，支持中文文件名，并禁止缓存。

公开六文件包不含 PDF、GitHub 凭据、私有路径或原始索引。构建只向 Worker 注入已公开文献 ID、DOI 与题名的对应表。GitHub 文件通过服务端读取，凭据不传给浏览器。

v14.1 增加独立的[按 DOI 获取与补录](DOI按需全文与补录.md)。它沿用全文口令，在已有 GitHub 文件之外尝试开放全文，并把补录题录和文件保存到受保护存储中；原有 ID 下载接口及其限制保留。补录需要现有 `QL_KV` 绑定，浏览器只收到安全题录和受保护下载入口。

下载要求索引提供合法 SHA-256，并同时核对实际文件大小、PDF 文件头与 Git blob 指纹。云端单篇上限 20 MiB、本地上限 50 MiB；超过上限时提示使用官网入口。

## Cloudflare Pages 配置

在现有 `dryz-xinzhi` 项目配置以下运行时变量/Secret；这是 Pages Worker 的运行时配置，不是 GitHub Actions 模型配置。

| 名称 | 用途 |
|---|---|
| `PDF_DOWNLOAD_ENABLED` | 配置完成后设置为 `true` |
| `GITHUB_LIBRARY_TOKEN` | Secret；仅私有 `dodoxiaxia/AI-` 的 Contents 只读权限 |
| `PDF_DOWNLOAD_PASSPHRASE` | 可选 Secret；省略时使用本次指定口令 |
| `PDF_GITHUB_COMMIT` | 可选，40 位固定 commit；省略时读取 main 的当前 commit |

下载端点直接展示口令表单。若此前配置过该路径的 Cloudflare Access 应用，应移除该路径的账号登录门禁，让请求到达口令表单；Worker 本身仍在读取 PDF 前验证口令。

GitHub 只读凭据通过 GitHub/Cloudflare 的受保护界面配置，不写入聊天、仓库或静态文件。缺少下载开关或 GitHub 凭据时不能下载；按钮出现不代表上线验收完成。

### 创建并安装只读凭据

1. 打开[已预填的 GitHub fine-grained token 创建页](https://github.com/settings/personal-access-tokens/new?name=xinzhi-pdf-readonly&description=Read%20PDF%20library%20for%20dryz-xinzhi%3B%20select%20only%20dodoxiaxia%2FAI-.&target_name=dodoxiaxia&expires_in=90&contents=read)。模板设置资源所有者 `dodoxiaxia`、有效期 90 天和 `Contents: Read-only`。GitHub 不支持通过该模板预选单个仓库，仍需在页面选择 **Only select repositories**，并只选 **AI-**。`Metadata: Read-only` 自动附带，不添加其他权限。确认后点击 **Generate token**。
2. 在 [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) 打开 `dryz-xinzhi`，进入 **Settings → Variables and Secrets**，选择 **Production** 环境。
3. 新增 `GITHUB_LIBRARY_TOKEN`，将刚生成的令牌直接粘贴到该界面，选择 **Encrypt / Secret** 后保存；不要通过聊天、源码、普通文本变量或 workflow 输入传递令牌。当前方案不需要在 GitHub Actions 中另存这份令牌。
4. 在同一环境添加文本变量 `PDF_DOWNLOAD_ENABLED`，值为 `true`。使用本次指定口令时省略 `PDF_DOWNLOAD_PASSPHRASE`。Preview 环境不自动复制这些配置。
5. 保存配置后，通过现有 `daily-refresh` 发布流程部署包含下载功能的版本。Secret 必须在该次部署前保存，旧部署不会因新增变量而完成上线。部署后以错误口令与正确口令分别验证，并确认正确口令能下载对应 PDF；令牌到期时在同一界面替换并重新发布。

配置入口与权限依据：[GitHub 令牌和模板说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[Cloudflare Pages 变量与 Secret 说明](https://developers.cloudflare.com/pages/functions/bindings/#secrets)。

2026-10-07 配置已完成：账号持有人已生成所需 GitHub 凭据，并直接保存为 `dryz-xinzhi` Production 环境的 `GITHUB_LIBRARY_TOKEN` Secret；`PDF_DOWNLOAD_ENABLED=true` 已启用。令牌没有写入聊天、源码或公开包。生产下载验收已通过，见下方记录。

## 本地使用与验证

运行 `python3 service/server.py`，在文献库点击“下载 PDF”并输入相同口令即可。本地下载复用既有快照、单篇 fetch 与文件完整性校验，不要求编辑台会话；编辑台其他接口沿用原登录方式。

针对性检查：

```sh
python3 -m unittest discover -s scripts -p 'test_github_library.py'
python3 -m unittest discover -s scripts -p 'test_public_build.py'
python3 -m unittest service.tests.test_service
node scripts/test_reading_logic.cjs
node scripts/test_pdf_worker.cjs
node scripts/test_edge_worker.cjs
python3 scripts/build_public.py
python3 scripts/package_release.py
```

上线后确认表单可打开、错误口令不读取私有文件、正确口令可保存 PDF；缺少全文、校验异常和服务端凭据缺失须给出明确提示。保持现有唯一发布流程，不另建自动化。

## 本地验证记录

之前已实际从私有 GitHub 固定 commit `7d1d0fac70a2c4e866068d941c4c34e85d7163f9` 取得截图中 `10.1136/bmjdh-2026-000098` 的 PDF，700,176 字节，首页题名、DOI、文件头、Git blob 和索引 SHA-256 校验通过。仅验证文件对应与完整性，不代表新增全文医学审查。

本次口令版本验证结果：

- 203 项脚本测试、38 项本地服务测试及三组 Node 检查通过，涵盖正确/错误口令、空表单、过大或重复字段、跨来源提交、默认摘要与服务端覆盖值，以及原 PDF 完整性流程。
- Chromium 在 390px 窗口打开口令表单，错误口令返回空白重输表单；输入本次指定口令后实际保存 BMJ PDF，700,176 字节，SHA-256 与上述 GitHub 校验记录一致，URL 不含口令。
- 真实浏览器检查发现并修复表单来源策略：初次与重输表单使用 `Referrer-Policy: same-origin`，确保浏览器正确提交同源 Origin；仍拒绝 `Origin:null`。
- 构建和打包通过，公开目录恰好六文件，保留文献库 1,219 条与已有 12 篇导读，静态目录没有 PDF。

## 生产上线验收（2026-10-07）

- 已合并 [下载功能 PR #1](https://github.com/dodoxiaxia/xinzhi/pull/1)，保留主分支的新 study/compare 功能；合并后原 Worker、研读服务与 UI、PDF、阅读逻辑、公开构建和打包检查通过。
- 部署代码为 `b4808cd41afaa345c8a50c23e7564c43779f7708`。[daily-refresh 发布记录](https://github.com/dodoxiaxia/xinzhi/actions/runs/37593501961)的 Cloudflare 发布与 state 保存步骤均成功。生产包仍为六文件，包含 1,219 条文献与 12 篇已核对导读，不包含私有 PDF 或 GitHub Secret。
- [生产文献库](https://learn.dryz.info/?mode=library)中的下载按钮可打开真实口令页。GET 返回 200、`no-store`、`Referrer-Policy: same-origin`；错误口令 POST 返回 403；正确口令返回 200、`application/pdf`、attachment 与 `private, no-store`。
- Chromium 在 390×844 窗口从文献库搜索结果点击“下载 PDF”，错误口令可重新输入；正确口令实际保存 `Contested futures of AI ethics for global population health.pdf`，700,176 字节，SHA-256 为 `73ab73688db1e860879df3ab0f66ec9f5d3b9bd04ac57b0ca004407dcc32b532`，与此前 GitHub 核验记录一致。下载 URL 仅含公开文献 ID。
