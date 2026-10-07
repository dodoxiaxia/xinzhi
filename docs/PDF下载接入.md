# 授权用户 PDF 下载

2026-10-07：按用户选择，PDF 下载只向登录的授权用户开放。文献卡片、紧凑列表和阅读详情提供“登录下载 PDF”，并保留官网原文链接。

## 下载流程

浏览器访问同源 `/api/pdf?id=公开文献ID`。服务端只接受现有文献库中的 ID，按 DOI 精确匹配私有 `dodoxiaxia/AI-` 索引；无 DOI 时仅接受唯一的完全相同题名（忽略大小写和连续空白），不用模糊匹配。有 DOI 的条目不回退到题名。索引和单篇 PDF 固定在同一 GitHub commit。匹配歧义、异常校验记录、非 PDF 或缺少全文时拒绝下载并提示官网入口。下载响应为 `application/pdf` 与 attachment，支持中文文件名，并禁止缓存。

公开六文件包继续不含 PDF、GitHub 凭据、私有路径或原始索引。构建只向 Worker 注入已公开文献 ID、DOI 与题名的对应表。GitHub 文件通过服务端读取，凭据不传给浏览器，也不把仓库改为公开。未配置登录校验与只读凭据时，接口保持关闭。

下载要求索引提供合法 SHA-256，并同时核对实际文件大小、PDF 文件头与 Git blob 指纹。云端单篇上限 20 MiB、本地上限 50 MiB；超过上限时提示使用官网入口。

## Cloudflare Pages 配置

在现有 `dryz-xinzhi` 项目配置以下运行时变量/Secret；这是 Pages Worker 的运行时配置，不是 GitHub Actions 模型配置。

| 名称 | 用途 |
|---|---|
| `PDF_DOWNLOAD_ENABLED` | 配置完成后设置为 `true` |
| `GITHUB_LIBRARY_TOKEN` | Secret；仅私有 `dodoxiaxia/AI-` 的 Contents 只读权限 |
| `CF_ACCESS_TEAM_DOMAIN` | Access 团队域名，如 `团队名.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | 下述 Access 应用的 Audience 标识 |
| `PDF_GITHUB_COMMIT` | 可选，40 位固定 commit；省略时读取 main 的当前 commit |

创建 Cloudflare Access Self-hosted 应用，保护 `learn.dryz.info/api/pdf*`，仅允许明确指定的授权账号登录。将该应用的团队域名和 Audience 填入上述配置；网站其他页面仍可公开浏览。普通导航会先经过 Access 登录，再返回下载地址。Worker 另外验证 Access JWT 签名、签发者、Audience 和有效期，即使从其他域名访问 Worker 也无法绕过认证。

配置新的只读 GitHub凭据须通过 GitHub/Cloudflare 的受保护界面完成，勿在聊天、仓库或静态文件中粘贴令牌。仅前端按钮出现不代表云端配置或上线验收完成。

## 本地使用与验证

本地 `python3 service/server.py` 沿用编辑台会话。先在 `/editor/` 登录，再访问文献库下载入口；匿名请求不能读取私有索引或 PDF。本地下载复用既有快照、单篇 fetch 与文件完整性校验，不新增批量下载或上游定时任务。

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

上线后用授权账号确认登录后可保存 PDF，再确认匿名用户及错误 Audience 被拒绝；缺少全文、校验异常和服务端凭据缺失须给出明确错误。保持现有唯一发布流程，不另建自动化。

## 本次验证（尚未上线）

- 203 项脚本测试、32 项本地服务测试与三组 Node 检查通过，包括真实 RSA 签名的离线 Access 验证和原有 AI Worker 回归。
- 浏览器检查卡片、紧凑列表、阅读详情的地址一致；无 DOI 条目有下载入口；390px 手机端按钮正常换行，未产生脚本错误。
- 本地构建与打包通过：公开文件恰好六个，文献库 1,219 条、已核对导读 12 篇；Worker 对应表为 1,219 个公开身份，静态目录没有 PDF。
- 已从私有 GitHub 固定 commit `7d1d0fac70a2c4e866068d941c4c34e85d7163f9` 取到截图中 `10.1136/bmjdh-2026-000098` 的 PDF，700,176 字节，文件头、Git blob 和索引 SHA-256 校验通过。仅验证文件对应与完整性，不代表新增全文医学审查。
- 本次未配置 Cloudflare Access、GitHub 下载凭据或启用生产开关；不将本地验证记作上线。
