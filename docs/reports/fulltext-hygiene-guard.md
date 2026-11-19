# t20 全文精读生成端文本卫生守门

## 根因及覆盖范围

[PR #216](https://github.com/dodoxiaxia/xinzhi/pull/216) 在公开精读 PMC13740100 的主要结果字段发现了一个 U+FFFD。生成端只验证题名、段落结构、证据与数字。模型原始响应会先写入可复用草稿，再做这些检查。U+FFFD 可以同时进入草稿和公开精读。

#216 的建议补丁通过了当前主线的 `git apply --check`。其中的 `model_text` 会修复可逆字符，而且拟接入的结构校验也用于读取已发布精读。t20 复用 `text_hygiene.py` 的原始字符检测，在模型草稿写入前、旧草稿复用前，以及引句按原文绑定后检查。私有 PDF 预览共用草稿校验。已发布精读继续按现有的证据和结构规则读取，字符问题由只读审计报告。

检查字段为 `titleZh`、兼容字段 `title_zh`、各正文段的 `text` 及证据的 `quote`。拒绝 U+FFFD、无效 Unicode、C0/C1 控制字符、字面八进制／十六进制／Unicode 转义、多层 HTML 实体和可严格反解的 UTF-8 乱码。正文保留正常 LF 和制表符。题名保留原有的首尾换行修剪，题名内换行报错。单层 HTML 实体仍由 #216 的通用审计报告。

## 生成及预算

模型响应含异常时，当前预约记为 `invalid`，错误码为 `unrecoverable_text_artifact`。旧草稿复用遇到同样错误就按原有流程跳过。既有模型调用点、预约计数和上限维持现状。模拟使用相同输入，在启用和停用守门时均记录 4 次模型调用与 4 次源请求，达到上限后同日重跑均无额外调用。正文不合格时，该条不占发布名额，运行仍可在原预算内按既有顺序处理后续候选。

## 本地只读审计

```sh
python3 scripts/fixtures/build_browser_data.py .local/t20/fixture/data
python3 scripts/audit_text_hygiene.py --check-readings --data-dir .local/t20/fixture/data
```

仓库 fixture 共扫描 3 篇精读、0 份草稿、0 处异常。另一个临时 fixture 验证了已发布记录的 `sections.findings.text` 和草稿 `titleZh` 均会按 ID 报告，并逐字节核对文件没有变化。

使用已有数据时，省略 `--data-dir` 会读取仓库下的 `data/deep-readings.json`。有异常时返回 1，干净时返回 0。输出包括记录类型、ID、字段名和异常计数。审计只扫描本地已存储字段。PMC13740100 来自 #216 的线上只读记录。本次未读取私有线上数据、重生成精读或调用真实模型。
