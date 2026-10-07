# 预览403只读诊断：性能版继续HOLD

生产 v14.2.12 / main0371c21e 未修改。候选53bee6b1的3项代码审查缺陷已修正，本诊断没有重复改动app/css/Worker。

## 已查证

原预览run37675847598只保存HTTP403，没有保存被拒路由的响应头、非敏感正文、CF-Ray或最终重定向URL。这个采集缺口不能在不重试受拒请求的约束下补回，现有GitHub日志/产物也未保留这些内容。

2026-10-07 19:54 UTC，使用现有CI部署身份读取配置（run37677990603/source6222eb37）：Pages项目dryz-xinzhi和精确预览部署3f577b35-9077-4c4f-be65-e2079d3a5c56均HTTP200，环境preview、URL与分支/commit均正确，deploy阶段success。项目域名包含learn.dryz.info，production_branch为main。账户/项目/部署不存在已排除。预览/生产usage_model均standard，未更改设置。

Access应用API返回HTTP403/code9999，错误为access.api.error.not_enabled（Access未启用）。这不是指令，不执行错误文字中的“Enable Access”。没有证据支持把原预览403归因于Access鉴权，也不让用户关掉Access/WAF来试。

当前身份可以读Analytics settings/schema；workersInvocationsAdaptive元数据enabled=true并列出max_cpuTime/max_memoryUsageBytes等字段。但2026-10-07 19:57 UTC实际原时间窗数据查询返回GraphQL“authorization denied”（run37678326401/sourcec86addb6），已经停止。元数据可读不等于指标读取授权。不能提供CPU/内存实测值，也不能把缺数据当0或资源通过。

公开数据Worker路径优先匹配；审核源码只有200/404/405/409/503显式响应，没有403。原403不是该数据handler的显式业务返回。WAF/平台早期安全拦截、出口代理限制及重定向路径仍无法依据旧记录定因；不猜测哪个已证实。

## 最小现有授权动作

在已有Cloudflare后台身份下，只读 Workers & Pages → dryz-xinzhi → 上述预览部署及 Functions Metrics，检查北京时间2026-10-08 03:38:15–03:38:30（UTC10-07 19:38:15–19:38:30）的调用/异常、CPU及可用内存记录，并核实显示的预览保护状态。无需提交任何凭据或扩张部署token权限。

若现有后台同样无法关联该次请求，走现有Cloudflare Support/安全事件查看入口，只询问：部署3f577b35存在且成功，在上述时窗GitHub Actions发出的 GET https://3f577b35.dryz-xinzhi.pages.dev/public-data/3e5ac332ce377ae7a0254e49e987ee1f32455f5d609f135328339c23dda40267/FEEDS.json 返回403；请核对历史阻断分类/规则或可用请求记录。此为用户可复制的询问上下文，没有替用户发送支持消息。原CF-Ray/客户端IP没有保留，必须明确这一限制。

不重新打开拒绝的预览URL，不改域名/节点/身份，不换服务令牌、不绕挑战，不停用WAF，不增加CPU/内存额度，不部署性能版。真实GET/HEAD、并发、CPU/内存门禁仍未通过；明早大版本若仍缺这些证据，准确说明性能部分未上线。

## 证据和参考

- 配置只读证据：[Actions37677990603](https://github.com/dodoxiaxia/xinzhi/actions/runs/37677990603)，同目录configuration JSON。
- 指标读取拒绝证据：[Actions37678326401](https://github.com/dodoxiaxia/xinzhi/actions/runs/37678326401)，同目录telemetry JSON。
- [Cloudflare Pages预览Access说明](https://developers.cloudflare.com/pages/configuration/preview-deployments/)。
- [Pages Functions Metrics入口与CPU指标](https://developers.cloudflare.com/pages/functions/metrics/)。
- [Analytics settings说明](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/)描述availableFields；实际数据授权仍以请求结果为准。
- [Cloudflare403分类](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-403/)说明403可由多种安全或早期边缘情况触发，状态码本身不能定因。

所有配置读操作零预览路由请求、零部署、零模型/PDF、零配置/权限变更；拒绝的Access API和实际指标查询均未重试。临时只读工作流从本分支最终树删除，避免后续推送重复诊断；不合入main。
