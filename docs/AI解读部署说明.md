# 一键 AI 解读：部署与运维说明（v13.5）

下列是配置要求，不代表本轮已核实 Cloudflare 实际绑定或模型连通性。Actions 批处理和 Pages runtime 是两套配置；最近 Pages 发布成功只证明部署被接受。

读者在文献详情里点“✨ 一键 AI 解读” → 网站后端（`_worker.js`）取 Europe PMC 公开摘要 → 调你的大模型 API → 校验（引句必须是摘要原文、数字必须出现在摘要里）→ 存入 KV → 所有读者之后直接看到，不再重复调用。内容标注“模型生成 · 未经人工核对”。

## 你需要做的（Cloudflare 后台，约 5 分钟）
1. **建 KV**：Workers & Pages → KV → Create namespace，名字如 `xinzhi-ql`。
2. **绑定**：Pages 项目 `dryz-xinzhi` → Settings → Bindings → Add → KV namespace，变量名填 **`QL_KV`**，选上一步的 namespace（Production 环境）。
3. **变量**（Settings → Variables and Secrets → Production）：
   - `LLM_ENDPOINT` = 例如 `https://open.bigmodel.cn/api/paas/v4/chat/completions`（须 https）
   - `LLM_MODEL` = 例如 `glm-4-flash`
   - `LLM_API_KEY` = 你的 key，类型选 **Secret**（加密，不会出现在网页或公开包里）
   - 可选：`DAILY_CAP`（全站每日计数阈值，默认 150）、`IP_CAP`（每访客每日计数阈值，默认 20）、`AI_ENABLED` 设为 `off` 关闭生成（已存解读仍可读）
4. **重新部署**：使用 daily.yml 的同一六文件发布流程；不要用旧版本 ZIP 覆盖新页面和 Worker。
5. 先检查平台只读配置与 GET 缓存/可生成状态；真正生成会调用付费模型，仅在已授权内容工作中验证。

没配好时：网站照常使用，按钮自动隐藏（后端返回未配置）。

## 安全与成本
- key 只在 Cloudflare 的加密变量里；前端只调用同域 `/api/ql`。
- 摘要由服务器自己去 Europe PMC 取，不接受前端传来的摘要，防止有人往共享缓存里投毒。
- 计数：全站与每访客阈值、同一篇 90 秒锁、Origin 同域检查。KV 读改写与锁不是原子操作，不能当作严格的并发费用硬上限；需在账户核实实际调用、KV 用量及平台限流。原始失败重试也可能产生模型调用费用。
- v13.5 不接受请求 hint 作为 PMID/DOI 对应关系，只用匹配的权威记录；模型请求拒绝跳转，鉴权/限流/传输错误不再次调用；短字段执行 60 字上限，失败详情仅返回安全码。

## 运营
- 删除/撤下某条解读：KV 里删除键 `ql:pmid:<号>` 或 `ql:doi:<小写doi>`。
- 所有条目都带 `generatedBy: reader-click`、模型名和时间，可日后批量导出复核，把好的并入 `data/quicklooks.json`。
- 每日批处理 `generate_quicklooks.py` 仍可并存；本地预览（无后端）不显示按钮。
- 公开包现为 6 个文件（新增 `_worker.js`）；`edge/_worker.js` 是源码。

## v10 追加：翻译与多篇综述（同一后端 `/api/ai`，同一 KV、同一限额）
- **摘要中英对照**：详情抽屉“公开摘要”下方的“🌐 翻译摘要”，生成后全站共享，同时补上中文标题。校验：译文里的数字必须都出现在原文里。
- **晨会清单“✨ AI 生成讨论提纲”**：清单里 ≥2 篇时出现；按文献集合缓存。
- **列表页“✨ AI 综述本页前 N 篇”**：对当前筛选结果的前 8 篇做综述速读；同一组文献缓存复用。
- 三个功能共用日上限（DAILY_CAP）和每人上限（IP_CAP）；`AI_ENABLED=off` 一并关闭。翻译/综述缓存键：`tr:pmid:…`、`br:<mode>:<hash>`。
- 未做：追问对话、AI 检索助手（不可缓存、成本与被滥用风险高）。

## 取摘要的回退链（v10 修订）
用户点击 AI 按钮时，后端按顺序找公开摘要，找到即停：Europe PMC → PubMed(efetch) → OpenAlex → Crossref → 期刊 DOI 落地页的公开元数据（citation_abstract / dc.description，最后手段，单篇、仅点击时、带标识 UA、失败不重试）。摘要须 ≥300 字符，来源写入结果（“摘要来源”）。都没有时不生成解读（避免编造），可“只翻译标题”。
每日流水线 `archive_details.py --fill` 也会给 RSS 候选里“有 DOI 无摘要”的条目按 DOI 补摘要，并入公开包。
注意：NEJM/JAMA/AHA 等出版商页面常有反爬，落地页那一步经常拿不到，属预期；读者来信/述评本来就没有摘要。
