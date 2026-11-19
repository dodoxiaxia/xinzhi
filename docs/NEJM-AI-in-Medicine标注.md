# NEJM「AI in Medicine」专栏标注说明

## 1. 背景与来源

NEJM「AI in Medicine」专栏文章发表在《New England Journal of Medicine》主刊，题名常不含 `AI` 等关键词（例如 `10.1056/nejmp2606894`《What the Robot Still Can’t Do》）。默认期刊分层规则会把 NEJM 主刊归为「顶级综合与科学」，导致这类文章在前端被划入 `general` 栏位而无法进入默认的「心血管+AI」核心视角。

本仓库采用**人工登记清单** [`config/nejm_ai_in_medicine.json`](../config/nejm_ai_in_medicine.json) 标识专栏成员。命中清单的 DOI 在元信息丰富与公开构建阶段会将 `clinicalTier` 设为 `AI医疗与数字医学`，使前端 `laneOf` 将其归为 `aimed` 并纳入核心视角。

## 2. 为什么不自动抓取专栏页

1. `nejm.org/ai-in-medicine` 对自动访问返回 Cloudflare 挑战（HTTP 403，`cf-mitigated: challenge`），且 `robots.txt` 禁止抓取 `/rss` 与 `/action` 下的订阅路径；**我们不绕过 Cloudflare 挑战**。
2. PubMed（efetch XML）与 Crossref（works API）均没有「专栏/栏目」字段：Crossref 的 `subject` 为空，PubMed 的 `PublicationType` 仅为 `Journal Article`。

因此，系统无法无人值守地从公开接口或专栏页自动发现新文章。

## 3. 更新频率与生效方式

- **构建生效**：登记提交即生效。`daily` 每次运行 `enrich_metadata.py` 与 `build_public.py` 时都会读取 [`config/nejm_ai_in_medicine.json`](../config/nejm_ai_in_medicine.json)。
- **新增方式**：由维护者在本地运行 [`scripts/ai_column.py`](../scripts/ai_column.py) 校验并追加，随后随代码提交。

## 4. 如何新增条目

单个或多个 DOI：

```sh
python3 scripts/ai_column.py add 10.1056/nejmp2606894
```

若已手工在浏览器保存专栏页 HTML 或文本，可从中提取 NEJM DOI 后逐条经 Crossref 核实并追加：

```sh
python3 scripts/ai_column.py add --from-html /path/to/nejm-ai-in-medicine.html
```

脚本会通过 Crossref API 核实 `DOI` 一致且 `container-title` 包含 `New England Journal of Medicine`，才以原子替换方式追加到清单中。

## 5. 失败处理

- **`daily` 构建阶段**：只读仓库内已提交的登记文件，不请求专栏页。遇到坏行（非对象、DOI 格式不合法、重复 DOI）会跳过并保留其余有效行；整文件缺失、不是合法 JSON 或顶层结构无效时，向 `stderr` 打印一行警告并返回空映射，不抛异常，不改写任何已提交文件。清单只会通过提交改变，坏文件在合并前被测试拦截；万一进了 main，`daily` 发布前的 `test_journal*.py` 会失败、不发布，线上沿用上一次的构建，已有标注不会被清掉。
- **维护脚本阶段**：网络异常、DOI 不一致或非 NEJM 期刊时，对应条目记入 `failed` 且退出码为 1；全部条目处理完成后仅在有新增条目时原子写回临时文件并替换，原有行顺序与内容保持原样，任何失败都不会破坏已有记录。
- **测试守护**：[`scripts/test_journal_ai_column.py`](../scripts/test_journal_ai_column.py) 校验已提交清单无坏行、DOI 均已规范化且无重复。

## 6. 局限

- 本方案**不会自动发现**专栏新发表的文章，新文章需要维护者周期性手工核对专栏页并运行 `scripts/ai_column.py add` 补入。
