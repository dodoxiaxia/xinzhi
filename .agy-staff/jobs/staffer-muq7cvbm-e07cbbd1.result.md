已完成对论文《**Automating clinical information retrieval from Finnish electronic health records using large language models**》（*npj Digital Medicine*, 2026, DOI: [10.1038/s41746-026-03282-1](https://doi.org/10.1038/s41746-026-03282-1)）的全文 15 个物理页的系统性提取、可视化研判与精读首稿撰写。

工作成果已严格限定保存在指定工作目录下，**未修改原始 PDF，未变动 `state.json`，未作 git 提交，无外部网络与付费请求**。

---

### 一、 交付文件清单与路径

交付物均存放在：  
[`/Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/)

1. **精读首稿文档**：[`draft-v1.md`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/draft-v1.md)
   - 包含简概览、六维深度剖析、核心图表（Figure 1–3, Table 1–4）逐项对照拆解、局限性与替代解释（重点说不好）、对中文心血管病历助手的可检验启示、科室自测 4 题及详解、三层递进精读路线。
2. **核心证据与结论裁决表**：[`claims-v1.md`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/claims-v1.md)
   - 梳理 17 条稳定编号结论（`CLM-01` 至 `CLM-17`），严格标注物理页码、章节、$\le 20$ 英文词锚点、四级证据属性（`[作者实测]`、`[作者主张]`、`[审查者推断]`、`[应用假设]`）与边界限制。
3. **过程与审计日志**：[`worker-log.md`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/worker-log.md)
   - 详细记录命令行与工具执行轨迹、15 个物理页提取状态、真实图像查看核验声明与方法学缺口记录。
4. **辅助提取与渲染资产**：
   - 逐页文本提取：[`extracted_text/`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/extracted_text/)（含 `fulltext.txt` 及 `page_1.txt` 至 `page_15.txt`）
   - 逐页 PNG 渲染：[`rendered_pages/`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/rendered_pages/)（含 `page-01.png` 至 `page-15.png`）

---

### 二、 核心临床审查裁决摘要（对抗式研判）

1. **分母边界审查（拒绝摘要数字泛化）**：
   - **95.3% 准确率**：分母严格限定为最优模型 `Llama-3.1-70B` 在 $N=1664$ 个经上游 GDPR 最小化清洗的乳腺癌问题对（V1提问），且此前已**人为剔除了 55 个两次标注不一致的疑难标注对**；规则匹配基线仅 45.4%；
   - **2.9% 临床显著错误率**：**分母严格仅对应 Llama-3.1-70B 单个模型**（48/1664），是由单名肿瘤医生盲审自动评分器筛选出的 78 个初筛错误样本判定得出，**其余 13 个模型完全未做临床严重度分级审查**；
   - **16 个尝试模型 vs 14 个完成模型**：`Llama-4-Scout-17B-16E`（全流程 OOM）与 `GPT-OSS-20B`（长文本 >10,373 tokens 因 Transformers 强制反量化为 bf16 导致 OOM）未完成主评测；芬兰语模型 `Llama-Poro-2` 因 8k 窗口仅在 $N=955$ 子集评测，超长病历准确率断崖跌至 0.9%–6.2%。
2. **“0.96% 语义安全翻转”——临床落地的核心死穴**：
   - 在最优的 Llama-3.1-70B 中，语义等价改写（V1 与 V2）导致 16 对问题（占全量 0.96%）发生“一问回答正确，换个问法立即诱发足以误导诊疗的临床显著错误”。在实际临床交互中，医生提问习惯的随机变异存在严重隐患。
3. **置信度校准矛盾**：
   - 概率校准（Table 4）显示高准确率不等于高可靠度。医学微调模型 `MedGemma-27B` 严重失准（MCE 0.707, ECE 0.193，显著欠置信），远逊于通用 `Gemma-3-27B`（ECE 0.045, MCE 0.277）；模型内置信度不能直接充当临床质控过滤网。
4. **对中文心血管病历助手（如心衰 GDMT / 房颤抗凝）的转译启示**：
   - 必须坚持**神经符号架构（NeSy）**，大模型仅作非结构化事实与实体提取，时序冲突消解与用药剂量推导交由确定性规则库；
   - 针对时序依赖极强的任务（如心血管事件与手术先后判定，对应论文中表现最差、极差达 9.3%–98.7% 的 CQ6 新辅助化疗），必须显式解构为状态机，并强制要求信源段落高亮（Evidence-span Attribution）与语义自洽交叉校验熔断。

---

### 三、 真实视觉查看与覆盖状态确认

- **已真实图像核验**：
  - `page-02.png`（**Figure 1**）：确认为工作流愿景示意图，非测量数据图；
  - `page-05.png`（**Figure 2**）：实测箱线图，确认 CQ6 与 CQ14 散点极低及分布离散度；
  - `page-05.png`（**Figure 3**）：四分位折线图，确认 Poro-2 垂直俯冲崩溃轨迹及四分位长度混杂病例复杂度的局限。
- **缺口记录**：补充材料（Supplementary Tables 1–12, Figs 1–3）未包含在出版商 15 页主 PDF 中，依规记录为缺口，不凭空揣测。
- **后续流程**：阶段性结果已落地保存，待 Codex 独立对照原文审查，暂未标记 final。
