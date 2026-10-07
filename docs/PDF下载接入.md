# 全文口令与 PDF 下载

2026-10-07：按用户要求，全文采用简单的共享口令。文献卡片、紧凑列表和阅读详情点击“下载 PDF”，在新页面输入全文口令，正确后直接保存文件。官网原文入口保留。

## 下载流程

浏览器访问同源 `/api/pdf?id=公开文献ID`，GET 只展示口令表单。口令通过 POST 请求体发送，服务端校验通过后才读取私有 `dodoxiaxia/AI-` 索引与 PDF；错误时提示重新输入。每篇下载单独验证，不要求账号登录，不将口令保存到浏览器。

默认口令采用本次会话指定值，源码只保存 SHA-256 摘要；前端、表单回显、URL 和请求日志不含口令。可选服务端 Secret `PDF_DOWNLOAD_PASSPHRASE` 覆盖默认值，用于以后修改口令。

服务端只接受现有文献库中的 ID，按 DOI 精确匹配；无 DOI 时仅接受唯一的完全相同题名（忽略大小写和连续空白），不用模糊匹配。有 DOI 的条目不回退到题名。索引和单篇 PDF 固定在同一 GitHub commit。匹配歧义、异常校验记录、非 PDF 或缺少全文时拒绝下载并提示官网入口。下载响应为 `application/pdf` 与 attachment，支持中文文件名，并禁止缓存。

公开六文件包不含 PDF、GitHub 凭据、私有路径或原始索引。构建只向 Worker 注入已公开文献 ID、DOI 与题名的对应表。GitHub 文件通过服务端读取，凭据不传给浏览器。

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

## 验证记录（尚未上线）

之前已实际从私有 GitHub 固定 commit `7d1d0fac70a2c4e866068d941c4c34e85d7163f9` 取得截图中 `10.1136/bmjdh-2026-000098` 的 PDF，700,176 字节，首页题名、DOI、文件头、Git blob 和索引 SHA-256 校验通过。仅验证文件对应与完整性，不代表新增全文医学审查。

本次口令版本验证结果：

- 203 项脚本测试、38 项本地服务测试及三组 Node 检查通过，涵盖正确/错误口令、空表单、过大或重复字段、跨来源提交、默认摘要与服务端覆盖值，以及原 PDF 完整性流程。
- Chromium 在 390px 窗口打开口令表单，错误口令返回空白重输表单；输入本次指定口令后实际保存 BMJ PDF，700,176 字节，SHA-256 与上述 GitHub 校验记录一致，URL 不含口令。
- 真实浏览器检查发现并修复表单来源策略：初次与重输表单使用 `Referrer-Policy: same-origin`，确保浏览器正确提交同源 Origin；仍拒绝 `Origin:null`。
- 构建和打包通过，公开目录恰好六文件，保留文献库 1,219 条与已有 12 篇导读，静态目录没有 PDF。

尚未配置 GitHub 下载凭据或启用生产开关，不把本地验证记作上线。
