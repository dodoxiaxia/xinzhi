已按照 [`review-v1.md`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/review-v1.md) 的全部 9 项独立审查意见（R01 – R09），在当前工作目录下完成了定向修订。

原 PDF、首稿资产（`draft-v1.md`、`claims-v1.md`、`worker-log.md`）及 `state.json` **均完好保留未动，无外部网络请求、无 git 提交、未标注 final**。

---

### 一、 交付文件清单

交付物均存放在：  
[`/Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/)

1. **逐项修订对照表**：[`revision-v2.md`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/revision-v2.md)
   - 逐一响应 R01 至 R09，给出具体修改位置、原 PDF 证据依据、纠偏理由及前后对照说明。
2. **修订版精读文稿**：[`draft-v2.md`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/draft-v2.md)
   - 严格压实至平实、平衡、客观的学术研讨风格（约 5200 汉字）；
   - 保留全部主图表逐项拆解（Fig 1–3, Tab 1–4）、17 条核心证据的分母与边界、4 道自测题及三层阅读路线；
   - 彻底剔除过度外推与夸张修辞。
3. **修订版核心证据表**：[`claims-v2.md`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/claims-v2.md)
   - 17 条核心结论全量更新，严格纠正统计分母、标注属性（作者实测/作者主张/审查者推断/应用假设）与适用局限。
4. **增补过程审计日志**：[`worker-log-v2.md`](file:///Users/shijun/Documents/Codex/2026-09-29/https-github-com-kkkkhazix-aihot/outputs/xinzhi/.local/maintenance/20261002/paper-cross-review/finnish-ehr-20261002/worker-log-v2.md)
   - 记录审查意见复核过程、修改操作与合规守则检查。

---

### 二、 核心审查条目（R01 – R09）修订要点总结

| ID | 审查问题与核查依据 | v2 修订策略与修正结果 |
| :--- | :--- | :--- |
| **R01** | **人工审查范围与 2.9% 分母**（pp 6–7, 13）：医生复核仅覆盖 V1 自动判错的 78 例和 V1/V2 不一致对，并非 1664 条全量逐条核验。 | 保留 48/1664=2.9% 为作者实测检出比例，明确指出其余被判“正确”的回答未作全面逐条人工复核；其余 13 个模型未做此项审查。CLM-07 分离作者实测与审查者推断。 |
| **R02** | **消除 0.96% 强外推与强制架构指令**（p 7）：16/1664 为本次观察比例，未测真实伤害；未研究中文心血管或具体药物配伍。 | 删除“致命后果”、具体药物说明及强制架构要求；将时序流、源段定位与辅助规则作为独立待验证的**应用假设**，删除 DigiCare 等无论文来源的产品名。 |
| **R03** | **55 个不一致实例定性**（p 10）：计数单位为问答实例（instances）；作者检查未见系统模式；因资源未二次仲裁。 | 纠正单位为“问答实例”；客观表述排除操作减少了模糊实例，带来潜在选择偏倚风险，未量化方向与幅度，不断言这些全是难例或证实性能膨胀。 |
| **R04** | **Table 4 校准度指标分别呈现**（pp 6–7, 12）：Llama-3.3 ECE 最低（0.039），Gemma-3-27B MCE 最低（0.277）；置信度源于候选选项条件似然 Softmax。 | 分开列明 ECE、MCE 和 Bias，不设综合冠军；明确指出 Table 4 为约束多选择任务，置信度为选项似然概率，绝非模型自发口头自评。全稿同步修正。 |
| **R05** | **Table 3 8-bit 退化解释与无依据门槛**（p 6, Tab 3）：原文仅称可能为模型与后端交互，未确证机理；4-bit 并非全在 90% 以上；无 1000 例门槛。 | 纠正 8-bit 退化解释为“可能为特定实现交互，机理尚未确证”；客观呈现 4-bit 各模型差异；彻底删除 1000 例、$\Delta<2$ pp 等无文献依据的验收门槛。 |
| **R06** | **剥离未受实证支持的论断**（pp 2, 3, 5, 9）：未设 RAG 实验对照；未做门诊可用性试验；开放式评分混合人工审核为宽容因素。 | 明确未直接比较 RAG；延迟仅为特定硬件与配置测定；领域微调未见系统性优势限定在本次特定任务设置；开放式评分作客观宽容考量叙述。 |
| **R07** | **Fig 2 与 Fig 3 图解口径补全**（pp 4, 5）：Fig 2 图面为 14 模型，正文均值为 12 个全数据集模型；Fig 3 纵轴截断至约 88–100%，6.2% 在图例与正文。 | 补全 Fig 2 的 14 模型分布与 12 模型均值口径；说明 Fig 3 截断纵轴与 Poro-2 曲线跌出可视下界的事实。 |
| **R08** | **规范事实与术语**（pp 1, 3, 10）：刊期为 Article in Press（接收于 2026-09-11）；14 个模型完成主评测（12 全集+2 子集）；数据为假名化。 | 修正刊期说明；明确 12+2 完成模型分布；统一规范使用“去直接标识/假名化（pseudonymized）数据”。 |
| **R09** | **语言风格平实化与认知分层**（全文）：避免过度情绪化词汇，保持客观、平实、平衡。 | 全面剔除“致命/神话破灭/崩溃/温室”等夸张词汇；正文严格划分原文实测、作者主张、审查者推断与应用假设四个层级。 |

---

所有修订文件均已就绪，保持版本号为 v2，等待后续综合审查与流程整理。
