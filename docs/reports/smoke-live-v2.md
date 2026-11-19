# 生产只读冒烟验收 v2

2026-11-19（太平洋时间），浏览器路径为 `/usr/bin/google-chrome`。以下为同一天的基线、更新后的全表和定向运行。

- #205 的近7天榜向 `/demo-reading.html` 发起请求。Pages 返回 308，跳转到 `/demo-reading`。旧冒烟路由中止所有 3xx，Chromium 因中止报 `net::ERR_FAILED`，两个宽度均误报。新版只跟随允许列表上的同源目标。基线没有复现工单的手机首页超时，但 #208 的导航触发了同一 12 秒限制。新版将导航时限独立为 20 秒，超时后允许一次 40 秒重试。
- #215 的近期和存档雷达时间戳早于首次部署要求，而 30 条声明没有机器或无来源标签。旧版把等待刷新和标签缺陷合并为 FAIL。新版这次报告 WAIT，记录数据时间、要求时间和年龄。旧数据超过 36 小时或仍有机器标签时返回 FAIL。
- 基线 3 FAIL。新版全表退出 0，覆盖 #203 至 #224，含 1 WAIT。上游 GET/HEAD 由 43 次增至 55 次，浏览器拦截的其他请求由 15 次降至 11 次，路径为 `/api/ai`、`/api/ql`。新版跟随 4 跳，非 GET/HEAD 发出数仍为 0。

## 基线

```sh
export CHROMIUM_PATH=/usr/bin/google-chrome
python3 scripts/smoke_live.py
```

| PR | Check | Status | Evidence |
| --- | --- | --- | --- |
| 203 | DataCite DOI metadata | SKIP | no safe GET invokes DataCite: /api/library only reads stored records; metadata backfill, acquisition and machine registration are authenticated write paths |
| 205 | Chromium layout / console | FAIL | expected 4 rendered modes at each viewport, no overflow or console/page errors; observed 390px weekly: console/page error Failed to load resource: net::ERR_FAILED; 1280px weekly: console/page error Failed to load resource: net::ERR_FAILED |
| 206 | Radar AI journal count | PASS | NEJM AI: preview 3, #listTotal 3 |
| 208 | Reading-mode deep links | FAIL | expected check to complete; observed Page.goto: Timeout 12000ms exceeded. |
| 209 | Request record and DOI miss form | PASS | #requestsModalBackdrop 仅此浏览器保存; .doi-empty form[data-ft-form] controls visible; not submitted |
| 210 | Retired translation actions absent | PASS | cards, drawer and reading mode: 0 matches for [data-action="ai-translate"], [data-action="tr-check"] |
| 211 | Radar multi-topic previews and URL | PASS | #房颤/电生理,#心衰/心肌: 178 single → 377 OR → 30 AND → 1159 cleared; previews matched |
| 212 | Longest weekly and reading titles | PASS | 390px, weekly 390/390, 24 rows, longest pmid-43034999 (186 chars); readings PMC13604957 390/390, 38 rows, longest PMC13751769 (243 chars) |
| 213 | Seven-day public reading catalog | PASS | 7 Beijing dates; journals (informational): 2026-11-20: 1 (European heart journal. Digital health); 2026-11-19: 12 (BMJ open, Clinical reviews in allergy & immunology, Diagnostics (Basel, Switzerland), Health science reports, Immunologic research, JAMA cardiology, Journal of medical Internet research, Medicine, Microsystems & nanoengineering, Renal failure, The Egyptian heart journal : (EHJ) : official bulletin of the Egyptian Society of Cardiology); 2026-11-18: 12 (American heart journal plus : cardiology research and practice, Bioengineering (Basel, Switzerland), Cardiovascular ultrasound, Experimental physiology, Frontiers in endocrinology, Frontiers in genetics, Frontiers in medicine, JMIR medical informatics, PloS one); 2026-11-17: 12 (Advances in medical education and practice, Current cardiology reports, Diagnostics (Basel, Switzerland), European heart journal. Digital health, European journal of radiology open, Experimental physiology, Frontiers in digital health, JACC. Advances, JAMIA open, JMIR medical informatics, Journal of personalized medicine, PloS one); 2026-11-16: 12 (Cardiology research and practice, Cardiovascular research, Current atherosclerosis reports, Diagnostics (Basel, Switzerland), EClinicalMedicine, European heart journal open, European heart journal. Digital health, Frontiers in cardiovascular medicine, Genes and environment : the official journal of the Japanese Environmental Mutagen Society, Journal of clinical medicine, PLOS digital health, PloS one); 2026-11-15: 5 (Cardiology research and practice, JMIR public health and surveillance, Journal of medical Internet research, PLOS digital health, PloS one); 2026-11-14: 11 (Advances in respiratory medicine, Critical care explorations, Frontiers in cardiovascular medicine, Frontiers in digital health, Frontiers in medicine, International journal of general medicine, JAMA network open, JMIR AI, NPJ digital medicine, Rheumatology international) |
| 214 | Disabled / removable zero-count journals | PASS | 9 initial zero rows checked; NEJM AI remained visible at 0 and was removable |
| 215 | Radar notices and data freshness | FAIL | expected fresh radar data and no machine/unattributed tags on notice titles; observed 0/30 machine/unattributed tagged notices; recent radar updatedAt=2026-11-18T22:17:07.512091+00:00 (not yet regenerated; required ≥ 2026-11-19T12:25:10+00:00); archive radar updatedAt=2026-11-18T22:17:07.512091+00:00 (not yet regenerated; required ≥ 2026-11-19T12:25:10+00:00) |
| assets | Homepage and hashed asset caching | PASS | / HTTP 200; 13 immutable hashed files (2 reading shard references) |
| budget | First-screen size budget | PASS | data gzip 96050 B / brotli 75113 B; total gzip 260506 B / brotli 198314 B |
| secrets | Credential patterns in response bodies | PASS | 28 response bodies, 0 credential-pattern matches |

Transport: 43/60 upstream GET/HEAD; 0 browser non-GET/HEAD aborted; 15 other requests blocked.

## 新版全表

```sh
python3 scripts/smoke_live.py
```

| PR | Check | Status | Evidence |
| --- | --- | --- | --- |
| 203 | DataCite DOI metadata | SKIP | no safe GET invokes DataCite; /api/library only reads stored records |
| 204 | Library backfill review | SKIP | offline editorial decisions are not exposed as public GET state |
| 205 | Chromium layout / console | PASS | test_layout_ui + test_mobile_library_ui (layout subset): curated 390/390; weekly 390/390; candidates 390/390; library 390/390; at 390×844; curated 1280/1280; weekly 1280/1280; candidates 1280/1280; library 1280/1280; at 1280×800; 0 errors |
| 206 | Radar AI journal count | PASS | NEJM AI: preview 3, #listTotal 3 |
| 207 | Identity hold review | SKIP | authenticated operator decisions are unavailable via public GET |
| 208 | Reading-mode deep links | PASS | rss-20b2b5e35f417555, rss-591e80cc1cd19696, rss-0ebc6db588c407df; zzzz → 「没有找到这篇文献」 once, paper removed |
| 209 | Request record and DOI miss form | PASS | #requestsModalBackdrop 仅此浏览器保存; .doi-empty form[data-ft-form] controls visible; not submitted |
| 210 | Retired translation actions absent | PASS | cards, drawer and reading mode: 0 matches for [data-action="ai-translate"], [data-action="tr-check"] |
| 211 | Radar multi-topic previews and URL | PASS | #房颤/电生理,#心衰/心肌: 178 single → 377 OR → 30 AND → 1159 cleared; previews matched |
| 212 | Longest weekly and reading titles | PASS | 390px, weekly 390/390, 24 rows, longest pmid-43034999 (186 chars); readings PMC13604957 390/390, 38 rows, longest PMC13751769 (243 chars) |
| 213 | Seven-day public reading catalog | PASS | 7 Beijing dates; journals (informational): 2026-11-20: 1 (European heart journal. Digital health); 2026-11-19: 12 (BMJ open, Clinical reviews in allergy & immunology, Diagnostics (Basel, Switzerland), Health science reports, Immunologic research, JAMA cardiology, Journal of medical Internet research, Medicine, Microsystems & nanoengineering, Renal failure, The Egyptian heart journal : (EHJ) : official bulletin of the Egyptian Society of Cardiology); 2026-11-18: 12 (American heart journal plus : cardiology research and practice, Bioengineering (Basel, Switzerland), Cardiovascular ultrasound, Experimental physiology, Frontiers in endocrinology, Frontiers in genetics, Frontiers in medicine, JMIR medical informatics, PloS one); 2026-11-17: 12 (Advances in medical education and practice, Current cardiology reports, Diagnostics (Basel, Switzerland), European heart journal. Digital health, European journal of radiology open, Experimental physiology, Frontiers in digital health, JACC. Advances, JAMIA open, JMIR medical informatics, Journal of personalized medicine, PloS one); 2026-11-16: 12 (Cardiology research and practice, Cardiovascular research, Current atherosclerosis reports, Diagnostics (Basel, Switzerland), EClinicalMedicine, European heart journal open, European heart journal. Digital health, Frontiers in cardiovascular medicine, Genes and environment : the official journal of the Japanese Environmental Mutagen Society, Journal of clinical medicine, PLOS digital health, PloS one); 2026-11-15: 5 (Cardiology research and practice, JMIR public health and surveillance, Journal of medical Internet research, PLOS digital health, PloS one); 2026-11-14: 11 (Advances in respiratory medicine, Critical care explorations, Frontiers in cardiovascular medicine, Frontiers in digital health, Frontiers in medicine, International journal of general medicine, JAMA network open, JMIR AI, NPJ digital medicine, Rheumatology international) |
| 214 | Disabled / removable zero-count journals | PASS | 9 initial zero rows checked; NEJM AI remained visible at 0 and was removable |
| 215 | Radar notices and data freshness | WAIT | 0/30 machine/unattributed tagged notices; recent radar updatedAt=2026-11-18T22:17:07.512091+00:00; required ≥ 2026-11-19T12:25:10+00:00; age 24.1 h; archive radar updatedAt=2026-11-18T22:17:07.512091+00:00; required ≥ 2026-11-19T12:25:10+00:00; age 24.1 h |
| 216 | Public text hygiene | PASS | curated: 12 titles, 2 gists; weekly: 48 titles, 22 gists; candidates: 40 titles, 9 gists; library: 30 titles, 10 gists; library payload: 1167 papers, 21437 strings |
| 217 | Offline test hygiene | SKIP | offline test assertions have no public GET surface |
| 218 | Read-only smoke runner | SKIP | runner behavior is covered by offline fixtures |
| 219 | Chinese search and abbreviations | PASS | 房颤消融: 16 results; AF: 47 results; ablation: no expansion |
| 220 | Read-only shortlist share | PASS | 2 public papers in share order; shortlist localStorage unchanged; merge untouched |
| 221 | Machine PDF title matching | SKIP | machine-upload identity checks have no public GET surface |
| 223 | 404, crawl and share metadata | PASS | Chinese HTTP 404; robots blocks /api/; 1 sitemap URLs; 5 share tags |
| 224 | Reading draft artifact rejection | SKIP | prepublication draft rejection has no public GET surface |
| assets | Homepage and hashed asset caching | PASS | / HTTP 200; 13 immutable hashed files (2 reading shard references) |
| budget | First-screen size budget | PASS | data gzip 96050 B / brotli 75113 B; total gzip 260506 B / brotli 198314 B |
| secrets | Credential patterns in response bodies | PASS | 34 response bodies, 0 credential-pattern matches |
| 222 | Private PDF staging isolation | PASS | 2 private HEAD probes returned 404; 55 responses, 0 PDFs |

Transport: 55/60 upstream GET/HEAD; 0 browser non-GET/HEAD aborted; 11 other requests blocked; 4 redirects followed; blocked paths: /api/ai, /api/ql.
Exit: 0

## 新版定向检查

```sh
python3 scripts/smoke_live.py --only 216,219,220,222,223
```

| PR | Check | Status | Evidence |
| --- | --- | --- | --- |
| 216 | Public text hygiene | PASS | curated: 12 titles, 2 gists; weekly: 48 titles, 22 gists; candidates: 40 titles, 9 gists; library: 35 titles, 10 gists; library payload: 1167 papers, 21437 strings |
| 219 | Chinese search and abbreviations | PASS | 房颤消融: 16 results; AF: 47 results; ablation: no expansion |
| 220 | Read-only shortlist share | PASS | 2 public papers in share order; shortlist localStorage unchanged; merge untouched |
| 223 | 404, crawl and share metadata | PASS | Chinese HTTP 404; robots blocks /api/; 1 sitemap URLs; 5 share tags |
| 222 | Private PDF staging isolation | PASS | 2 private HEAD probes returned 404; 31 responses, 0 PDFs |

Transport: 31/60 upstream GET/HEAD; 0 browser non-GET/HEAD aborted; 0 other requests blocked; 1 redirects followed; blocked paths: none.
Exit: 0
