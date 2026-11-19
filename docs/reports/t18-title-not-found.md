# t18 机器上传首页身份核对

维护者对 main `a62e2510` 与首稿 `2f05914c` 使用生产选项 `allowTitleOnly`、`scanAllPages`、`holdForeignDoi`，各自运行 491 份真实 PDF、491 组错题名交叉配对和 491 组同题名外来 DOI 配对。1,473 次调用的结果逐字节一致，六份目标文件仍全部拒收。首稿的标准字体十六进制操作数合成件与真实文件的字体编码缺口不同。

| 样本 | 根因与代码路径 | 决定 | 检查字段 | 合成测试 |
| --- | --- | --- | --- | --- |
| A · `10.1002/ejhf.2333` | [machinePageFonts](../../edge/src/04a-machine-pdf.js#L1119) 原来只使用 ToUnicode。维护者实测标题和大部分正文使用无 ToUnicode 的 WinAnsi 或 Custom Type 1C 子集字体，约 1 KiB 的合刊版权说明仍能读取。两种 DOI 都出现在首页。同页内容流原已拼接。 | 恢复 Type 1C 字形后的完整题名与声称 DOI 必须同时出现在首页显示文字。 | `titleExtraction=text_operators` | [Worker A](../../scripts/test_machine_identity.cjs#L1188) 覆盖合刊说明、两个 DOI、跨流题名、错题名与错 DOI。 |
| B · `10.1016/j.hrthm.2024.03.017` | [machineFontWithoutUnicode](../../edge/src/04a-machine-pdf.js#L1085) 补上无 ToUnicode 的 Type 1C WinAnsi 等字形映射。维护者实测 1,497 个字符中有 790 个无法解码。解码后，题录年份和印刷括号缩写仍影响比较。 | [machineCatalogTitleVariant](../../edge/src/04a-machine-pdf.js#L1511) 仅在首页文字或 Info/XMP 已确认声称 DOI 时允许省略开头四位年份、插入词后 2–8 字母的大写括号缩写，或两者同时发生。 | `titleVariant=year_prefix_dropped`、`acronym_inserted` 或两者用 `+` 连接。 | [Worker B](../../scripts/test_machine_identity.cjs#L1298) 覆盖合成 CFF、连字、换词、换年份、外来或缺失 DOI 及非法缩写。 |
| C · `10.1093/eurheartj/ehab626` | [machinePageText](../../edge/src/04a-machine-pdf.js#L1353) 遍历整个首页。维护者实测 1,932 个字符中有 1,351 个无法解码。首页包括无 ToUnicode 的 Type 1C WinAnsi、MacRoman 和 Custom 字体，以及 TrueType WinAnsi。 | 从显示文字恢复题名并核对声称 DOI。合成件把题名排在栏目与作者之后。真实题名在解码后 Worker 文本中的偏移待原件复测。 | `titleExtraction=text_operators` | [Worker C](../../scripts/test_machine_identity.cjs#L1250) 覆盖晚出现的标题、未显示的文字和仅使用标准字体十六进制的反例。 |
| D · `10.1093/eurheartj/ehac270`、`10.1093/eurheartj/ehad192` | [machineFirstPage](../../edge/src/04a-machine-pdf.js#L1342) 看到的是仓储封面。维护者实测封面无可读文字，字体为无 ToUnicode 的 DINPro 与 DINPro-Bold Type 1C Custom。 | [machineRepositoryIdentity](../../edge/src/04a-machine-pdf.js#L1537) 要求机构抬头、固定顺序的题录栏和 Handle 链接。封面题名一致，物理第 2 页同时匹配题名及声称 DOI 时返回 `full`，上传进入待核验。 | `coverPage=repository`、`doiPage=2` | [Worker D](../../scripts/test_machine_identity.cjs#L1264) 覆盖错封面、错正文题名、外来 DOI、空白第 2 页与跨页证据。 |
| E · `10.1001/jama.2023.11959` | 维护者确认 Medical News in Brief 的第 1 页缺少目标题名和 DOI。[machineIdentity](../../edge/src/04a-machine-pdf.js#L1653) 对该栏目仍沿用原题名规则。 | 维持拒收。 | 无 | [Worker E](../../scripts/test_machine_identity.cjs#L1348) 覆盖缺少题名，即使首页印有声称 DOI。 |

## 解码与双解析器核验

保留文本操作符解析，用于从实际显示的 Tj/TJ 字符串读取 Type 1C 字形，合并首页原有 ToUnicode 文字与恢复的字形，并读取仓储封面。独立的标准字体十六进制题名兜底已移除。新解码要求逐字匹配，并为无法映射的字形保留占位。CFF 的编码格式 0 和 1 可附补充映射，charset 有 0、1、2 三种格式。每字体最多处理 256 KiB，单页 1 MiB、24 次 CFF 字体尝试，单个 INDEX 最多 4,096 项。截断数据、超限及不支持的字体沿用原路径。[Adobe CFF 规范](https://adobe-type-tools.github.io/font-tech-notes/pdfs/5176.CFF.pdf)

[双解析器合成测试](../../scripts/test_muse_pdf_verifier.py#L363) 使用与 Worker 同源的嵌入字体。PyMuPDF 1.26.6 直接读出题名和 DOI。pypdf 6.10.0 对无 ToUnicode 的内建 Custom 编码输出字节对应字符，未恢复正文文字。[read_cff_pages_with_pypdf](../../scripts/muse_pdf_verifier.py#L225) 因此加了有界兜底，将同一 CFF 字形映射作为临时 ToUnicode 提供给 pypdf。PyMuPDF 独立解析原件。普通核验要求两个解析器各自从正文找到 DOI，仓储封面还须分别命中物理第 2 页的题名及 DOI。人工放行仍按 #207 的严格首页题名规则及 SHA-256 核对执行。

## 待维护者复测

此环境没有 491 份真实 PDF。维护者将对更新后的草稿重跑 1,473 次调用，确认 A–D 的五份真实文件是否恢复、E 是否仍拒收、两组错配的结果，以及运行时间。合成测试覆盖了已测出的字体机制。

**本 PR 修改了 `edge/src`，合并前需要仓库所有者批准。**
