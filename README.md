# 心知｜心血管与AI医疗文献学习站

公开网站：https://learn.dryz.info/ 。源码版本 v14.1.2；实际发布结果以私有 `state` 分支的 `docs/deployment-status.json` 和相应 GitHub Actions 为准。接手先读 [运营与发布说明](docs/自动化发布说明.md) 和 [当前交付状态](docs/当前交付状态.md)；旧版本记录是历史证据。

## 阅读和内容范围

每日精选、每周精读、文献雷达、文献库构成四个主要栏目。雷达近14天自动聚合，文献库本版获批静态题录为1,268条，不代表已读全文。原摘要、未经核对AI速览、摘要核对导读和全文精读分别标记；导读未经医生终审。本周没有新精读时明确显示未发布。

按刊关注、可读内容筛选和中文检索帮助查新；关注与晨会单仅存当前浏览器。内部共读文档只有指定Google账号可访问，当前仅dryz@dryz.info。

使用方法见 [使用说明](docs/使用说明.md)；本轮问题与后续路线见 [v7优化核验](docs/v7优化核验与后续路线.md)。

## 私有GitHub文献来源

用户已授权将定时更新的私有文献库 `dodoxiaxia/AI-` 用作后台来源，并选择输入共享口令后下载 PDF。文献库下载接口按公开文献 ID 精确匹配 DOI，无 DOI 时匹配唯一的相同题名，服务端校验口令与单篇文件后供下载；官网原文入口保留。云端须配置 GitHub 只读凭据并启用下载开关。见 [PDF下载接入](docs/PDF下载接入.md)；历史索引接入和本机缓存说明见 [GitHub接入说明](docs/GitHub文献库接入.md)。

v14.1 新增按 DOI 获取全文与补录：准确 DOI 先跨栏目精确查重，输入全文口令后才查 GitHub 或开放全文来源。补充题录和已取得的 PDF 保存在现有受保护存储中，页面合并显示，日常构建不覆盖补录记录。无可用 PDF 时明确标为待补全文，不改变既有导读审核状态。见 [DOI 按需全文与补录](docs/DOI按需全文与补录.md)。

## 本地核验与公开构建

v14.1.1 将审核后的公开题录快照接入发布：恢复 `state` 后先运行 `scripts/apply_public_library.py`，再刷新与构建；构建守卫阻止旧状态覆盖已批准条目。快照保留原 1219 个 ID，新增 49 条至 1268 条。后续索引更新必须一并交付审核后的快照与 manifest，不能只提交同步脚本。发表日期精度与全文可用性分别记录，题录入库不代表全文已核验。

当前源码与数据位于本目录。不要从早期导入脚本重建私人文献索引来覆盖既有公开范围，不要恢复旧前端模板。

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
node scripts/test_reading_logic.cjs
node scripts/test_edge_worker.cjs
node scripts/test_doi_library_worker.cjs
node scripts/test_doi_library_ui.cjs
node scripts/test_study_services.cjs
node scripts/test_study_ui.cjs
python3 scripts/apply_public_library.py
python3 scripts/build_public.py
python3 scripts/package_release.py
```

构建使用公开字段白名单，精选独立归档，若旧精选消失、缺元数据、存在私有路径或多余公开文件则停止。模型流程及小批量预算见交接和 [AI速览说明](docs/AI速览方案B.md)。GLM初稿成功不等于来源核对或公网发布。

完整恢复 state 后可预览公开六文件：

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory public
```

本地预览为 http://127.0.0.1:8765/ 。

## 部署边界

v13.6 在阅读抽屉增加“研究结构与全文核对”，晨会清单增加明确选择 2–4 篇的“逐篇证据对照”。仅处理服务器取得的公开摘要，展示逐字引文及缺项；打开页面和选择只读缓存，点击生成才调用模型。模型生成与中文语义仍需回查原文，不能当作全文精读或质量评审。运行配置、缓存、次数限制与连接诊断见 [AI 服务说明](docs/AI解读部署说明.md)。

GitHub Actions 构建后将六个公开文件发布到 Cloudflare Pages 现有 `dryz-xinzhi` 项目 Production：index.html、public.js、style.css、icon.svg、_headers、_worker.js。手动发布也必须用同一白名单包。不上传项目根目录、PDF、数据库、.local、凭据、原私人索引或内部记录。Pages 发布成功和公网页面核验分别记录；失败保留上次有效站点与 state。缺完整摘要缓存时构建停止，不能用题录版覆盖已有摘要。

界面及聚合思路参考 https://github.com/KKKKhazix/AIHOT ，原参考快照589f79eff09470b31ba8a7f1d9eb62d36ff2be6c；未复制其品牌与后端代码。原文版权归各来源所有。
