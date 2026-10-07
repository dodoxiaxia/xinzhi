# 心知｜心血管与AI医疗文献学习站

公开网站：https://learn.dryz.info/ 。源码版本 v13.5.2；实际发布结果以私有 `state` 分支的 `docs/deployment-status.json` 和相应 GitHub Actions 为准。接手先读 [运营与发布说明](docs/自动化发布说明.md) 和 [当前交付状态](docs/当前交付状态.md)；旧版本记录是历史证据。

## 阅读和内容范围

每日精选、每周精读、文献雷达、文献库构成四个主要栏目。雷达近14天自动聚合，文献库维持现有1,219条公开题录，不代表已读全文。原摘要、未经核对AI速览、摘要核对导读和全文精读分别标记；导读未经医生终审。本周没有新精读时明确显示未发布。

按刊关注、可读内容筛选和中文检索帮助查新；关注与晨会单仅存当前浏览器。内部共读文档只有指定Google账号可访问，当前仅dryz@dryz.info。

使用方法见 [使用说明](docs/使用说明.md)；本轮问题与后续路线见 [v7优化核验](docs/v7优化核验与后续路线.md)。

## 私有GitHub文献来源

用户已授权将定时更新的私有文献库 `dodoxiaxia/AI-` 用作后台来源。索引与按需选取的PDF只保存到 `.local/github-library/`；本机编辑台沿用已有登录门禁提供只读检索，公开题录范围保持不变。真实接入结果、快照日期与云端边界见 [GitHub接入说明](docs/GitHub文献库接入.md)。

## 本地核验与公开构建

当前源码与数据位于本目录。不要从早期导入脚本重建私人文献索引来覆盖既有公开范围，不要恢复旧前端模板。

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
node scripts/test_reading_logic.cjs
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

GitHub Actions 构建后将六个公开文件发布到 Cloudflare Pages 现有 `dryz-xinzhi` 项目 Production：index.html、public.js、style.css、icon.svg、_headers、_worker.js。手动发布也必须用同一白名单包。不上传项目根目录、PDF、数据库、.local、凭据、原私人索引或内部记录。Pages 发布成功和公网页面核验分别记录；失败保留上次有效站点与 state。缺完整摘要缓存时构建停止，不能用题录版覆盖已有摘要。

界面及聚合思路参考 https://github.com/KKKKhazix/AIHOT ，原参考快照589f79eff09470b31ba8a7f1d9eb62d36ff2be6c；未复制其品牌与后端代码。原文版权归各来源所有。
