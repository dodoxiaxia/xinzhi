# 历史摘要补齐候选恢复

来源：寻找全文检索方案（01a11525-1004-76eb-998f-93de2d5100fe）中“167 篇摘要补齐，尚未上线”的工作轮次。

build-ui.patch 是该轮 `git diff -- scripts/build_public.py app.js` 的完整未截断输出。extract_pdf_abstracts.py.txt 是该轮源码读取输出中可完整分离的提取器快照；后续轮内存在修改，不能当作最终源码。原测试文件、PDF 核验回执、data/pdf-abstracts.json 和预览数据未完整恢复。

这里只保存可追溯候选，未应用到当前主线、未执行提取、未重写 state。历史源码基线与当前构建、摘要政策和身份校验已有差异，不能直接 git apply 上线。本次在 main 未找到历史 backfill_public_abstracts 函数和独立 PDF 摘要提取器，候选尚未完整集成；历史 167 是当时本地样本结果，不是当前线上覆盖数字。

再次推进时，应先恢复最终测试与经核对的来源证据，比较当前同 DOI/PMID 绑定、公开摘要政策及构建守卫，再验证，不用旧候选覆盖已修复的逻辑。
