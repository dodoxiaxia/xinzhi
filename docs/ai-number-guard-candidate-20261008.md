# AI numeric validation: isolated candidate, not deployed

The user's compare/brief failure has not been reproduced from its original inputs: the second paper identity, request source fingerprints and failed model output are missing. The known first paper is DOI 10.1093/ehjdh/ztag152; its actual API-resolved abstract has not been recovered. This candidate must not be described as resolving the screenshot.

Offline regression proves an independent format bug: the production guard accepts 2026-09-23 but rejects the lossless translation 2026年09月23日. Calendar formatting is normalized without stripping medical or trial-identifier leading zeros. Existing percentage, decimal, thousands and CI formatting already passes; no new exemption or calculated-number allowance is introduced.

Brief points now use their own paper's title/abstract instead of borrowing numeric support from other papers, and duplicate paper IDs are rejected. Study assertions retain their selected-quote boundary. Existing one-retry behavior receives bounded field/paper/source-number feedback; the provider attempt limit remains two, without additional loops or budget/model changes.

Validation diagnostics contain only public identity keys, SHA-256 source fingerprints, bounded numeric tokens and field/attempt identifiers. Raw model output, source prose, headers and credentials are not retained. The read-only status endpoint sanitizes the diagnostic; its KV record expires after 24 hours. Diagnostic storage failure cannot hide the original validation failure.

The historical guard excerpt is pinned by SHA-256 in the fixture. All constructed source identities are explicitly synthetic and are not the missing user's paper. The existing real public-abstract fixture remains separately identified. Twenty new offline cases pass alongside study services, evidence, Worker and brief feedback regressions. No external model/metadata call, private PDF read or production request was made. The new suite is included in daily pre-deployment checks if this candidate is eventually integrated.

Release gate: retain as an isolated candidate until the original second identity and source/output evidence are available, followed by a fresh integration review. Do not overwrite the v14.2.13 DOI changes or the static Worker router when merging.
