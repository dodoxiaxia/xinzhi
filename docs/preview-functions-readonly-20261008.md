# Exact existing preview Functions diagnosis — 2026-10-08

## Result

Cloudflare's existing deployment metadata reports `uses_functions: true` for both the exact preview `3f577b35-9077-4c4f-be65-e2079d3a5c56` and the project's canonical production deployment. This excludes absence of Functions according to that metadata. It does not prove the remote Worker byte hash, successful application invocations, or resource use.

The read-only job [37704183978](https://github.com/dodoxiaxia/xinzhi/actions/runs/37704183978), job `113074510052`, logged this safe result at `2026-10-07T23:47:00.6007033Z`. Existing project, exact preview deployment and exact production deployment API reads all returned 200. No application requests, deployment or configuration writes occurred.

Production main was separately read and remains `0371c21e846f05fdb5ef8e41968a711ac01a5a19` (v14.2.12). Its successful release is [37676064534](https://github.com/dodoxiaxia/xinzhi/actions/runs/37676064534).

## Candidate identity and routing

Previously saved exact preview metadata identifies source `5c46f0f5c973fa0940fc18af3ad1a582abb0f2a9`; the retained build manifest identifies `v14.3.0-preview.1`, Worker 333137 bytes and SHA256 `27590463a0b643d91cd060843b098790afeeb45c9062a4f9db5c66722602a379`. This is a CI build artifact hash, not a Cloudflare remote-byte readback.

The reviewed held candidate is now `53bee6b1f5b5b9cd1f5cca4bcede8921806e4b10`, which has not been deployed. The old preview is not proof for that newer exact candidate.

Reviewed `/public-data/` is the first fetch routing branch, uses only the Pages `ASSETS` binding, and does not inspect authorization, cookies or preview environment conditions. Its explicit error statuses are 404, 405, 409 and 503, not 403. Other private PDF/API handlers are separate. This does not identify whether the original rejection came from edge security or execution egress.

## Configuration and evidence limits

The earlier successful configuration read at `2026-10-07T19:54:17.801335Z` showed both environments using `usage_model: standard`, compatibility date `2026-09-29`, and `fail_open: true`. These are dated configuration observations, not proof of a complete current equality comparison or account pricing tier.

The new full report was uploaded as artifact `11519046324`, ZIP SHA256 `acfbdd029304954f95149e4bc0aca3d29e1b77e26b98499dde9b4a960aeedeb4`. Its download reference returned 403 in this execution environment and was not retried. Therefore current full configuration differences and binding-name comparison were not read locally; only the safe Functions summary is verified from the existing job log. The artifact-download 403 is a different request from the original preview-route 403.

Original application response headers/body were not retained. Historical metrics data query was denied; schema availability did not confer data-query permission. Parent reports the user's authenticated mobile screenshots showed Production Last24h Success3736/Errors0/Subrequests3050 and Preview Last6h zero/No data. These screenshots were reviewed by the parent; this task did not independently inspect their pixels. No data is not a passed CPU/memory gate. The user's successful existing JAMA download confirms that existing flow only.

## Decision

Keep the performance candidate held. Real exact-candidate GET/HEAD, concurrency, CPU and memory gates remain unmet. Do not bump versions just to publish. No additional screenshots, computer login, credentials, Analytics permissions or disabled protections requested. Temporary diagnostic workflow and script are removed from this branch's final tree to prevent further automatic reads.

See [prior read-only diagnosis](https://github.com/dodoxiaxia/xinzhi/blob/1d8029a70db794747a34a8267f8eaab04b5373ed/docs/preview403-readonly-diagnosis-20261008.md) and [held candidate review](https://github.com/dodoxiaxia/xinzhi/blob/53bee6b1f5b5b9cd1f5cca4bcede8921806e4b10/docs/lazy-public-data-integration-review-20261008.md).

