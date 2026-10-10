# 重建使用手册

本工具从 2026-10-07 手册对话恢复，2026-10-10 适配当前界面并重新导出；位于 docs 下以免手册生成工具变更触发生产发布。

依赖：Python Playwright、Pandoc、Chromium 和中文系统字体。导出只读 docs/使用说明.md 和六张 manual-assets PNG，生成离线 HTML、可检索 PDF 和 ZIP，不调用模型、不发布网站。

```sh
python docs/manual-tools/export_user_manual.py
```

更新截图时，先把固定 state 的 public 六文件放入本地预览目录（不要覆盖 main 源码），然后运行：

```sh
python -m http.server 8768 --bind 127.0.0.1 --directory .local/manual-preview/public
# 另一个终端
python docs/manual-tools/capture_ui.py
python docs/manual-tools/export_user_manual.py
```

capture_ui 仅允许本地预览请求，API 使用关闭生成的模拟响应，其他外网请求中止。截图带本地预览标记；验证记录写入 .local/manual-work，不能用作线上服务或权限验收证据。截图用的 state SHA 见 ../cloud-sync-evidence-20261010.json。

本次导出 15 页，六张图、12 章；浏览器采集无页面错误，PDF 文本可检索。历史手册曾为 16 页，重建版布局和新增段落不同，不声称二进制一致。
