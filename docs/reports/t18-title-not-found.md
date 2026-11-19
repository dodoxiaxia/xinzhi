# t18 机器上传首页身份核对

基线为 main 的 #199 合并提交 a62e2510。六份原件的输入证据来自工单中的首页摘要和 Worker 检查值。下表区分可以在代码和合成 PDF 上复现的问题，以及需要原件才能确认的版式或编码。

| 样本 | 根因及证据 | 决定 | 新的检查字段 | 合成测试 |
| --- | --- | --- | --- | --- |
| A · ejhf.2333 | [machinePageText / machineDecodeFontText](../../edge/src/04a-machine-pdf.js#L868) 已把同页的内容流连成一条再解码。原实现缺少 ToUnicode 时跳过操作符解码，字面串扫描也读不到标准字体用十六进制操作数显示的题名。合成件复现版权行和两个 DOI 读得到、跨内容流的两行题名读不到。原件究竟是该机制、显示顺序，还是其他编码，待确认。 | 修复可复现的标准字体取字缺口。要求声称 DOI 和完整题名同在操作符读出的首页文字中。 | `titleExtraction = text_operators` | [Worker A](../../scripts/test_machine_identity.cjs#L1188)，换一个题名用词或改掉声称 DOI 均拒收。[双解析器](../../scripts/test_muse_pdf_verifier.py#L267) 原有 `title_matches` 已能读到这类十六进制标题。 |
| B · j.hrthm.2024.03.017 | [machineIdentity / machineCatalogTitleVariant](../../edge/src/04a-machine-pdf.js#L1022) 原比较保留年份和括号里的字母，导致题录多出的年份及印刷题名多出的协会缩写打断匹配。可正确解码的 `ﬁ` 已由 NFKD 处理。 | 修复。只允许去掉题录开头的四位年份、去掉印刷题名词后长度为 2–8 的全大写括号缩写，或两者同时发生。必须在首页操作符文字或 Info/XMP 读到声称 DOI。 | `titleVariant = year_prefix_dropped`、`acronym_inserted` 或 `year_prefix_dropped+acronym_inserted` | [Worker B](../../scripts/test_machine_identity.cjs#L1259) 和[双解析器](../../scripts/test_muse_pdf_verifier.py#L284)。年份被替换、题名换词、无声称 DOI、外来 DOI 或缩写形状错误均拒收。核验仍要求双解析器都从正文读到声称 DOI。 |
| C · ehab626 | [machinePageText](../../edge/src/04a-machine-pdf.js#L868) 扫描整个首页的内容流，栏目与作者在先本身不会让后续题名漏读。提供的检查值只能确认 Worker 未在完整归一化结果中匹配题名，无法定位原件中的字形或图像。合成件复现作者后的标准字体十六进制标题被旧路径漏掉。 | 修复可复现的文字标题缺口。原件若仅有图像、缺失字形映射或显示顺序割裂题名，证据不足时继续拒收。 | 命中可恢复文字时 `titleExtraction = text_operators` | [Worker C](../../scripts/test_machine_identity.cjs#L1211) 和[双解析器](../../scripts/test_muse_pdf_verifier.py#L267)。题名只在 PDF 注释、未被显示的合成件继续拒收。 |
| D · ehac270、ehad192 | [machineFirstPage](../../edge/src/04a-machine-pdf.js#L857) 原来把封面当成正文首页，后页 DOI 扫描要求先在第 1 页读到题名。标准字体十六进制封面合成件可复现旧路径的 `readable=false`，原件封面的实际不可读原因仍待确认。 | 修复可识别的仓储封面。开头的 `University Repository`、顺序固定的题录栏和 Handle 链接同时成立时，先核对封面题名，再要求物理第 2 页正文同时提供完整题名和声称 DOI。双命中才是 `full`，上传依然进入待核验。 | `coverPage = repository`，正文命中 DOI 时 `doiPage = 2` | [Worker D](../../scripts/test_machine_identity.cjs#L1231) 和[双解析器](../../scripts/test_muse_pdf_verifier.py#L314)。错误封面题名、错误正文题名、外来 DOI、空白第 2 页与后续页拼接证据均拒收。 |
| E · jama.2023.11959 | [machineIdentity](../../edge/src/04a-machine-pdf.js#L1224) 的人工待核要求首页先命中登记题名并发现其他 DOI。工单的拒绝值与缺少题名、DOI 或两者相容，无法从摘要确定目标条目在 Worker 文字中的位置。 | 保持现有拒收与人工待核条件。识别到 Medical News in Brief 栏目字样时，沿用原题名规则。 | 无 | [Worker E](../../scripts/test_machine_identity.cjs#L1299) 和[双解析器](../../scripts/test_muse_pdf_verifier.py#L334)。缺失目标标题时拒收，即使正文出现声称 DOI。晚出现的十六进制标题和版本缩写也不触发新规则。 |

两种独立解析器各自核对正文 DOI。普通文档继续检查首页题名，仓储文档需要两种解析器都认出封面并分别在第 2 页找到题名及 DOI。B 的元数据证据可触发上传端变体规则，但若正文任何页均无 DOI，后续核验依旧拒绝。新字段位于 Worker 的身份检查结果，成功上传的现有响应仍通过 `task.identity` 返回等级。

在没有原件的环境中，用 main 与本分支的生成 Worker 对照了旧测试直接调用身份检查的样本。95 次旧版通过的结果逐字段一致。合成 A/C 在旧版均返回 `title_not_found`（DOI 在首页，`readable=true`），合成 D 返回 `identity_mismatch`（`readable=false`）。

未验证工单的 491 份原件及其六次拒绝，也无法验证真实 A/C/D 的字形编码、抽取位置或确切命中率，以及 E 的目标条目是否在原件里可读。维护者将在合并前运行真实 PDF harness。此次为离线验证，没有调用生产写入接口，也没有修改生产 KV/D1 或配置。

**本 PR 修改了 edge/src，合并前需要仓库所有者批准。**
