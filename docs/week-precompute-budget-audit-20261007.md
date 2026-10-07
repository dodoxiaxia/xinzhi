# 预算口径更正与24篇剩余工作测算

“剩余4次/5800输出token”来自本次新设的本地保守试跑上限减去预留，**不是用户套餐额度/余额，也不是现有全服务每日预算**。原来的8次只是full刷新中速览步骤的每次执行限制；把它称为“existing daily budget”不准确，本交接予以更正。所有数值上限仍保持原值，本次未扩额或付费调用。

当前逐篇runtime方案：剩余71项，成功填完需要71–142次提供商调用；输出上限136200（全首轮成功）或384600（每项一次重试）。已核实原Worker支持4篇compare并写入单篇study缓存，可作为后续优化：先单篇验证，再批量其余23篇时，从当前快照总计54POST/最多108调用、376600输出；**尚未适配该runner或实测，不能当成已可执行交付**。

官方 Z.ai 页面在2026-10-07列 GLM-5.3-Flash 输入$0.15、输出$0.50/百万token：[官方价格](https://docs.z.ai/guides/overview/pricing)。实际部署的提供商host、账户价与余额未核实；不把这个价当已确认的用户账单价。

| 方案 | 可见输入精确UTF-8字节 | 输出上限token | 条件性规划估算USD |
|---|---:|---:|---:|
| 当前runtime，全首轮成功 | 310723 | 136200 | 0.117435 |
| 当前runtime，每项含一次重试 | 640433 | 384600 | 0.293818 |
| configured合并24篇，无重试 | 159323 | 139200 | 0.094420 |
| 首篇study验证，含一次重试 | 17381 | 3800 | 0.004584 |

最后一列按“每个UTF-8字节预算1个输入token，再按每调用256个输入token预留消息封装”×官方未缓存输入价，加输出上限×输出价计算。它是偏保守的**规划假设，不是实测token数或可保证的付款硬上限**；没有官方tokenizer/实际usage，未知的托管方费用、隐藏记账、重取原文变化不能靠此消除。输出部分单独可复核为 runtime含重试$0.19230。若要向用户承诺美元硬上限，集成方须先确认实际host/模型/计费规则及现有账户费用控制；不需提供明文key。

若用户批准在同一UTC日按当前逐篇runner完成全部，保留今天已预留的4次/3800后，本地执行包络需146次/388400输出。精确待审修改点见下文；本提交没有修改这些值。Worker现有实际限额也须只读核实，不能将默认IP_CAP=20当作可一次完成71POST，更不能换IP绕过。

# 2026-10-07 weekly precompute budget audit (offline)

## Finding

`4 attempts / 5800 output tokens remaining` is arithmetic under a newly imposed **local conservative trial cap** of 8 attempts and 9600 output tokens per UTC date. It is not a user plan allowance, provider balance, authorized money limit, or the original full-service budget. No provider API or credential was read/called during this audit.

The old `scripts/ci_daily.py` on base `03e2c7c` line 23 (current API worktree line 24) invokes `generate_quicklooks.py --call-model --limit 8` once per full pipeline run. `generate_quicklooks.py:297` sets `max_tokens:1200`; its `batch` counter starts at zero (`:383`) and checks that invocation's limit (`:389`) with no retries. Therefore 8 × 1200 = 9600 is that step's **per-invocation output reservation envelope**, not a persisted daily cap. The full pipeline also calls `translate_titles.py --run --limit 60` (`ci_daily.py:23` in API worktree), each at `max_tokens:4000` (`translate_titles.py:49`), showing 9600 never described the whole old pipeline.

The new branch hardcodes the inferred cap at `scripts/week_precompute.py:24-25` and `scripts/week_precompute_budget.py:9-10`. Its UTC-day grouping is new (`week_precompute.py:241,313`). The top-level comment claiming an “existing daily batch budget” should be corrected. The 4 reserved attempts preserve two attempts for a confirmed cached translation POST and two for the failed study POST; the 3800 output reservation belongs to the failed study. Exact billed usage is unknown.

## Actual existing Worker limits (code defaults, deployed overrides unknown)

`/workspace/study-evidence-api/edge/_worker.js:841-852`: `MODEL_CALL_CAP`, default 300 provider attempts per UTC date. This counts validation retries and errors; KV eventual consistency makes it a soft service-wide limiter, not a strict billing cap. `:978-980`: reader request defaults `DAILY_CAP=150` and `IP_CAP=20`; successful uncached generation consumes reader quota, failed work can refund reader quota while retaining model attempts. These are request limits, not tokens or money. Actual production variable overrides and current counters were not inspected. An otherwise empty default IP allowance permits at most 20 successful missing-cache task POSTs/day, so 71 tasks need at least four UTC dates unless a separately authorized configuration change is made. Do not infer the account's paid balance from any of these limits.

## Remaining scope and provider call/output bounds

All counts assume the saved source hashes remain unchanged and no additional valid shared caches appear. A successful repaired verification is one of the remaining tasks, not an extra duplicated call. Failure stops the batch.

| Missing task | Count / minimum calls if all first attempts succeed | Maximum calls, one internal retry each | First-attempt output caps | First + retry output caps |
|---|---:|---:|---:|---:|
| Translation | 23 | 46 | 69000 | 207000 |
| Study | 24 | 48 | 38400 | 91200 |
| Quicklook | 24 | 48 | 28800 | 86400 |
| Total | 71 | 142 | 136200 | 384600 |

The **current per-paper runner path** sends 71 POSTs at most in this success-through batch; this is not a theoretical minimum across all Worker routes. Provider calls are 71–142; valid cache hits lower both counts. Actual generated tokens may be lower and have no meaningful quality-preserving minimum that can be known before generation. The maxima follow the existing Worker `max_tokens`: translation 3000 then up to 6000 (`:999`), study 1600 then 2200 for one paper (`:1251`), quicklook 1200 then up to 2400 (`:785`). The larger translation/quicklook retry cap applies on truncation only, but is reserved conservatively for every missing task.

The existing configured combined alternative produces all missing fields for one paper in one request: 24 calls × 5800 = 139200 output reservation, no retry. This is a different implementation path; local existing config is absent, so this audit does not present it as an executable or verified option here.

## Input measurement

Measured actual decoded `messages[].content` strings using saved 24 public abstracts and the patched Worker functions (no network), including the new exact sentence evidence catalogs. Evidence catalogs have 318 spans. The 24 abstracts total 52537 Unicode characters / 52557 UTF-8 bytes; titles plus newline plus abstracts total 55731 characters / 55753 bytes.

| Runtime task | First input characters | First input UTF-8 bytes | First + retry characters | First + retry bytes |
|---|---:|---:|---:|---:|
| Translation | 59570 | 68332 | 121831 | 143771 |
| Study | 145854 | 167352 | 294756 | 341016 |
| Quicklook | 64745 | 75039 | 131698 | 155646 |
| Total | 270169 | 310723 | 548285 | 640433 |

Configured combined input totals 143201 characters / 159323 bytes. These are exact saved-input string measurements, **not provider token counts**. The runtime may re-fetch updated source metadata; the saved journal string is used here. Chat roles/framing, provider tokenizer, hidden reasoning, and other protocol/accounting overhead are not included. A crude 4 UTF-8 bytes/token conversion would yield about 77.7k first-input tokens or 160.1k with every retry, but this is only a planning heuristic and must not be quoted as an exact count or a guaranteed cap. Each paper/task measurement and source hash is in `editorial/week_precompute_token_estimate_20261007.json`.

## Exact configuration changes only if separately approved

For all remaining runtime tasks in one UTC day while preserving the current conservative ledger, the arithmetic envelope is **146 attempts / 388400 output tokens** = existing 4/3800 + remaining 142/384600. This is a proposed task execution reservation, not a recommendation to spend or to bypass service limits. To represent that approval in the current code requires updating both `week_precompute.py:24-25` and `week_precompute_budget.py:9-10`, the CLI `--attempt-limit` maximum/validation and its fixed “0..8” error (`week_precompute.py:368-371`), and the explicit CI `--attempt-limit 8` argument if that CI path is selected (`ci_daily.py:23` in precompute worktree). A reviewed explicit batch-budget configuration would avoid duplicated hardcoded constants. Do not modify these values before authorization.

The configured no-retry alternative's same-day arithmetic is 28 attempts / 143000 output tokens = existing 4/3800 + 24/139200. Do not create or request new credentials for that path. Runtime service overrides (`MODEL_CALL_CAP`, `DAILY_CAP`, `IP_CAP`) are separate; their actual configured values/counters must be checked by the sole integration owner before deciding whether any change is needed. No secret values are necessary for this check. Default `IP_CAP=20` cannot accommodate 71 successes in one day; do not route through multiple IPs or bypass it.

A cost expression, once the exact active model/provider pricing and token counts are verified, is `cost = input_billable_tokens * input_price_per_million / 1e6 + output_billable_tokens * output_price_per_million / 1e6`, plus any separately billed reasoning/tool charges. The guaranteed output reservation for remaining runtime work is 384600 tokens if the provider honors these caps; **no monetary upper bound can be certified without an input-token billing cap/tokenizer and reasoning accounting**. Official pricing verification is delegated separately; this audit does not guess prices or account balances.

## Durability blocker

Current daily workflow `daily.yml:137-152` saves state only when both refresh and deploy succeed. Its always-upload artifact `:166-174` contains only three docs, not the generated cache or attempt ledger. Paid work followed by a failure/runner loss can therefore lose reservations before a later run starts. Current precompute code correctly blocks paid CI with `paid_ci_requires_durable_checkpoint` (`week_precompute.py:243-244,298-299`). Merely uploading a final artifact under `always()` does not protect a killed runner after a paid dispatch. The minimal safe sequence is to persist an idempotent request reservation to a durable checkpoint **before every paid provider dispatch**, then persist each validated result, independently of publication success; on restart reconcile that checkpoint before any new paid work. Keep the CI block until that storage/restore path is tested. This audit makes no workflow or repository changes.

## Alternative existing compare route, not yet adapted or verified

The Worker accepts `compare` for 2–4 distinct papers (`edge/_worker.js:1317`) and writes each successfully validated paper into its shared single-paper `study` cache (`:1370-1372`). Therefore six 4-paper comparisons can theoretically fill all 24 study caches. That makes 23 translation + 24 quicklook + 6 compare = **53 POSTs / minimum 53 to maximum 106 provider attempts**. For 4 papers, study output limits are `min(6000,4*1600)=6000` then `min(7600,4*2200)=7600`; six groups reserve 81600 output tokens. The total remaining output reservation is **375000** = 207000 translation + 86400 quicklook + 81600 compare. First-attempt output caps total 133800.

This route requires runner changes for batching, exact source identity matching, per-paper validation/cache import, partial source availability, failed groups, reservations, and idempotent durable checkpoints. Current `week_precompute.py` does not execute it, and no real production comparison was tested in this audit. It is an alternative to review, not a claim the current batch can already run in 53 calls. Grouping all six sets without a prior standalone verification has been measured separately in the JSON; if a standalone repaired-study verification succeeds first, group the remaining 23 papers (five groups of 4, one group of 3): one successful single-study POST plus six compare POSTs, hence **54 total batch POSTs / up to 108 model attempts** from today's snapshot, with conservative remaining output **376600**: study costs 3800 for the single verification + 5×13600 for five 4-paper groups + (4800+6600) for one 3-paper group = 83200, plus translation 207000 and quicklook 86400. The already-consumed verification should not be charged again.

On 2026-10-07, the official Z.ai pricing page was checked: GLM-5.3-Flash is $0.15 input / $0.50 output per million tokens (https://docs.z.ai/guides/overview/pricing). Endpoint/provider host and the active account's price/plan are unobserved here, so that pricing is **conditional only**. At that conditional rate, remaining output-token reservation alone would be $0.19230 for the current runtime route, $0.18750 for the six-comparison alternative, or $0.06960 for configured combined calls. These exclude input and any additional reasoning charges and are not total cost ceilings. No paid budget changes are authorized by this arithmetic.
