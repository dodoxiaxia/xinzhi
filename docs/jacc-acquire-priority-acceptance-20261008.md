# JACC DOI 获取与反复五分钟提示：优先集成验收

记录时间：2026-10-08 00:19 UTC；生产源码回读 main `0371c21e846f05fdb5ef8e41968a711ac01a5a19`。此文为补丁到齐前的源码分析和验收准备，**不是修复或发布完成回执**。尚未收到 DOI 补丁、Drive 身份核验结果；不重复开发，不下载出版社全文或正式上传。

目标文献：The Natural History of Atrial Functional Mitral Regurgitation，DOI `10.1016/j.jacc.2024.02.026`。用户两次真实获取失败，提示截止时间08:15:37→08:20:44；这是父线程提供的用户观察，不冒充本任务端点实测。

## 已从当前源码确认

- [librarySave](https://github.com/dodoxiaxia/xinzhi/blob/0371c21e846f05fdb5ef8e41968a711ac01a5a19/edge/_worker.js#L555)在全文未 available 时写入 `Date.now()+300秒` 重试期限，pending/review 都可能进入此路径。
- [libraryResult](https://github.com/dodoxiaxia/xinzhi/blob/0371c21e846f05fdb5ef8e41968a711ac01a5a19/edge/_worker.js#L384)对 pending 显示机构授权执行桥尚未接通，同时附带重试倒计时；这些信息让未具备获取条件的状态看起来可在五分钟后解决。
- [handleAcquire错误路径](https://github.com/dodoxiaxia/xinzhi/blob/0371c21e846f05fdb5ef8e41968a711ac01a5a19/edge/_worker.js#L857)除 paused 外，多种失败又统一写入新的300秒；需审查是否把需人工关联或缺通道的失败当作短暂故障。
- [librarySoftGate](https://github.com/dodoxiaxia/xinzhi/blob/0371c21e846f05fdb5ef8e41968a711ac01a5a19/edge/_worker.js#L527)在既有冷却期内保持原期限并阻止上游调用。问题不应修成取消所有限流：过期后无条件再次 pending 会新建五分钟期限，才是本次重点。
- [libraryGithub](https://github.com/dodoxiaxia/xinzhi/blob/0371c21e846f05fdb5ef8e41968a711ac01a5a19/edge/_worker.js#L473)使用配置的 commit；未配置时读取 main SHA，再在同一个 commit 核验 index/文件。这证明固定快照行为存在，**未读取实际 env 值，不能宣称当前固定到哪个 commit，也不能宣称 JACC 已在可达索引中**。
- pending 的 JSON `ok:true` 表示题录流程结果；不等于有 PDF、下载成功或三端归档完成。全文 available 必须由完整性核验后的实际文件支撑。

## 下一补丁的必要验收

1. **用户真实断点优先**：只先合 DOI 状态/提示补丁和经核验的必要关联；不夹带静态分片、动态扫描候选53bee6b1、Cloudflare套餐或权限改动。
2. **无意义期限**：mock clock 重现首次无可用全文、五分钟后重复申请、第二次仍缺执行通道；不得再次误导为“等五分钟即可取得”或宣称正在处理。真实 rate cap、busy lock、上游临时失败、KV同步仍保留准确的原期限/Retry-After。
3. **状态区分**：缺授权/人工桥、题录身份待核验、暂时上游故障、真实 queued/running、全文已校验可用必须分别表达。GET只读、不延长冷却、不产生获取或正式归档；自动重试不得由界面暗示或新增。
4. **已有 pending 兼容**：旧 KV attempt/paper 与没有新字段的记录须测试，避免上线后旧五分钟继续误导；不能清除已核实 available 或抹掉真实限制。
5. **文件身份及快照**：固定快照范围由原 DOI 任务核实。Drive 两个598792字节文件目前仅线索，不能凭长度或文件名承诺这篇 PDF；待原归档任务提供 DOI/题名/SHA及重复关系核验，不重复获取，不正式上传。
6. **安全与不回退**：口令、Origin、OIDC、PDF路径/尺寸/SHA、GitHub blob核验、private no-store、已 available 优先与同步重试、身份冲突 HOLD、存储失败保留原错误均回归；不打印凭据，不把API状态包含的配置暴露给浏览器。
7. **打包发布**：候选 source SHA到齐后，基于当时最新main/state合版；跑 DOI/PDF/fulltext相关离线完整回归、受影响页面/Worker对照、现有六文件 manifest/provenance预检，以及完整合版回归。依照原发布授权串行处理；未核实阶段明示，不凭 mock 宣称 JACC 已成功下载。
8. **发布回执**：分别报告提示修复、实际下载可用性、网站缓存与Mac/GitHub/Drive归档证据。没有实际成功下载证据就写“未验证”；不将Cloudflare升级与文献访问授权混为一谈。

## 当前分工与边界

原 DOI 任务修状态和检查GitHub快照，原Mac归档任务定点核验Drive已有文件；本任务保持唯一发布者和补丁集成者。静态分片排在本用户断点之后，未取消其完整性验收。生产保持v14.2.12，Cloudflare1010另线尚未解决。

用户询问Cloudflare升级价格与必要性，不等于购买授权。未创建技术支持工单，未生成/授权AgentLee新token，未发送支持请求；不得把“付费”描述为该文献可下载的必要或充分条件。

