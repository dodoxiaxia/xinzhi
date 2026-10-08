# 已有全文优先复用 / JACC LFS 修复候选

基于 v14.2.16 `9b5e65ae042a8c0d583acc8fd1edbaee816de36c`，与授权接单桥分别提交；唯一主发布验收后部署。

## 真实证据

- 私有 `dodoxiaxia/AI-` 已更新到 `401a33e5fc293f02057858695ef454856e7f42db`，GitHub 显示提交者账号 `dodoxiaxia`、时间 `2026-10-08T01:55:57Z`。本任务没有修改或覆盖该提交。
- 新母索引 1,509 行，SHA256 `3cc7808a87a04608a53dc7624de1ead789ab354cb63e3f4d9edd43d6162e9f5d`；JACC `10.1016/j.jacc.2024.02.026` 有唯一 DOI/题名匹配。以前 `911e…` / 1,336 行的结论仅适用于旧快照。
- 指定文件 raw 内容为 131 B Git LFS 指针；Git blob 为 `27cc55ff21e205adef0aef2f8a08387b5b0e6916`，指针 OID 为 `e09bac70ec8e828f7927c36a724c59dd29114f6f6a397a4d136af4fe498024b1`，目标大小 598,792 B。
- 已用现有 GitHub 授权工具按 Git LFS 正常下载协议回读这一份既有原件：598,792 B、同 SHA、13 页；原严格核验器双解析器逐页、题名/DOI通过。出版社下载 0。Mac/Drive 本轮未重复回读，来源由原任务另行确认。
- **生产口令下载尚未验证，Production `PDF_GITHUB_COMMIT` 实际值未读取。** 生产缓存仍显示 manual_needed 仅说明缓存状态，不能证明后端固定旧版本。精确私有文件路径和完整索引行留在忽略目录 `jacc-exact-private-handoff.json`，不写公开包或日志。

## 修复

普通 Git blob 保持原 SHA256、大小、Git blob 校验。遇到标准 LFS 指针时先验证指针 Git blob、OID/索引 SHA 与大小绑定，再向固定 GitHub 仓库的官方 LFS batch endpoint 请求单对象 download。现有只读 token 只用于 GitHub 官方 batch endpoint；对象 URL 必须来自该认证响应并通过 HTTPS/固定 GitHub 对象域限制，下载不转发 token、cookie 或任意 action headers，不接受重定向。原件再次核验大小、SHA 和 PDF 头；既有 EOF 校验保留。403/429/授权失败暂停，不重试或落到出版社获取。

复核修正：GitHub Contents metadata.size 可报告存储指针的 131 B，部分工具展示展开原件的 598,792 B。分别验证 pointer 的 Git blob 与合理 metadata size（只能等于 pointer.length 或指针声明的 targetSize），再用 targetSize 做 LFS batch、实际 PDF 长度和增量 entry.bytes 校验；不再把 pointer metadata.size 等同原件长度。回归使用合成 131/598792 fixture，覆盖两种元数据、尺寸/哈希不符、超限、真实 302 响应及对象阶段 401/403/429，不发真实失败请求。

两个旧调用点均复用此校验器：按公开题录 ID 下载 `/api/pdf`，及按 DOI 获取 `/api/acquire`。不重上传 PDF，不补母索引、不新建正式归档。

可选、默认关闭 `DOI_LOOKUP_LATEST_MAIN=true` 只使 DOI 路径查询当前私有 main 母索引；传统按 ID 下载仍保留 `PDF_GITHUB_COMMIT` 固定规则。`DOI_GITHUB_DELTA_ENABLED=true` 可读固定的私有增量元数据文件，至多 200 条、262 KiB，必须已有 DOI/题名/安全路径/双解析器核验指纹；实际文件仍做大小/SHA/blob回读。候选不创建该文件，不启用变量；增量元数据不能凭文件名猜身份或把 index miss 当成所有端无文件。

口令保护 `/api/fulltext-source?doi=…`：GET 仅表单，POST 验证既有口令后只读版本及索引，不读 PDF、不写 KV。返回配置固定 SHA、DOI 是否跟随 main、实际解析 SHA、当前 DOI 是否有合格候选。没有私人路径、其他索引行或凭据。主发布可在安全界面核对真正的版本差异，避免凭缓存状态猜配置。

## 验收边界

合成测试覆盖 LFS 指针 blob/OID/size 绑定、原件 hash、错误对象、SSRF/重定向/凭据不外送、失败暂停；源快检覆盖口令边界、零 PDF/零写入、固定与最新版本差异、已核增量复用。真实原件回读是独立证据，测试 mock 不冒充生产回读。

发布后需在既有安全口令入口完成本文一次已有文件复用与缓存重复命中；若固定版本确实旧，再由主发布按批准范围更新版本或选择 DOI 跟随 main。现有 token 是否支持 Production 上的 LFS batch 仍需这一验收，不生成 token 或扩权限。

协议依据：[GitHub LFS 指针说明](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)、[Git LFS 官方 batch 下载协议](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)。
