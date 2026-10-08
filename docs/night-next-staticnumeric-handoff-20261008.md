# 后续静态/API候选：v14.2.15，未发布

v14.2.14 已单独改为覆盖/发布策略最小版（7ed3157a88ed00ea1079aaecd00403aa04148b3d），包含六文件协议、现有DOI状态与新增覆盖报告，尚待本任务实际发布回执。此前7ba90e0的静态/API候选v14.2.14仅是历史候选命名，未部署，不得混淆两者。

本分支继承14覆盖策略、静态哈希/嵌套校验/原子目录修复及隔离数字guard。release_integrity冲突保留daily.yml和现有ci_daily.py输入指纹，ci_daily只有一个指纹项。原应用/Worker合版正常，DOI保护没有被旧文件覆盖。

既有静态合版553 Python、24 Node、1004实资产浏览器和492正确hash nested浏览器/真实进程中断恢复通过；新增coverage16项/原pipeline30项随后针对新合版验证。14覆盖补丁的生产结果应由独立source/run/state识别，不能从本候选version或离线资产推定发布。

仍HOLD：原AI组合的第二identity及实际source/output尚不全；进一步独立静态审阅与获允许的线上验收尚未完成。Cloudflare1010不是此架构修复，NoData不证明CPU0。GLM/预算/调度/权限不改。最终发布前用最新生产state恢复，固定source重新build、包/输入指纹预检并经原有授权发布入口；需要回滚时撤销整个静态协议，而非删文件绕guard。
