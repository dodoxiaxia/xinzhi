## 当前上线修订（v14.2.7）

现行接入使用 `corrected-cache.json`，原 `full-cache.json`、原草稿和语义复核完整保留为固定交付记录；原 `artifact-sha256.json` 不代表后加修订文件。修订凭据见 `integration-correction.json`，现行离线预览见 `corrected-board.json`。CONDUCT-AF 按期刊官方公开摘要澄清 LVEF 改善的组间绝对差与百分点单位，速览明确临床结局相近不证明等效。数字出现次数、逐字引句校验未变；不声称修订已获人工医学终审。

`public_editorial_overlay.py` 每次重验现行源身份、DOI/PMID和 title+abstract 哈希；内存接入当前周榜，不改选文窗口，并仅向仍匹配当前雷达源的离榜条目提供内容。GLM 在线功能与配置不变，运行缓存及账本不写，原暂停保留。
