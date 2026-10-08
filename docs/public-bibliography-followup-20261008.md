# Bounded public bibliography followup — 2026-10-08

Source base: `bc267debeb40e783d22e32be63ed788d57240440`; read-only refreshed main: `7ed3157a88ed00ea1079aaecd00403aa04148b3d`; public runtime state baseline: `350addefc78f57362278ab73123924e852b179bb`. The previous five-case review and 82-candidate inventory were read before selecting these ten new IDs. This branch adds files only. Existing synchronization, classifier, API worker, builder, workflow and private source files are unchanged.

Counts: **verified 7, false-positive 2, unresolved 1**. Six finite corrections, one explicitly guarded public duplicate alias, one DOI-link HOLD and two retained singleton records are proposed. They are not wired into the live builder and have not been deployed. The two M8 duplicate claims replaced two previously prepared corrections so this delivery stays at ten items; that earlier public registry evidence is preserved separately for reuse and is not applied by this policy.

| Public record ID | Decision | Canonical public DOI |
| --- | --- | --- |
| `5aa7bd3c3a9717e9` | verified: truncated old identifier; official JAMA identity confirmed | `10.1001/jama.2026.3533` |
| `64d7382f06c6991f` | verified: old JAMIA DOI belongs to another article; official JAMA identity confirmed | `10.1001/jama.2026.3249` |
| `3bcf52b03b3bfd64` | verified: old Frontiers DOI belongs to another article; explicit duplicate of existing public ID `ffeb47ca0a734600` | `10.1001/jama.2026.0946` |
| `2e9a9023ee2212fc` | verified: canonical registry title/journal and local public cache corroborate the correct identity | `10.1093/ehjdh/ztag098` |
| `205851dfec4a1c18` | verified: canonical registry title/journal and local public cache corroborate the correct identity | `10.1093/eurheartj/ehag494` |
| `039a2a57e62585bb` | verified: canonical registry title/journal and local public cache corroborate the correct identity | `10.1093/ehjdh/ztag032` |
| `c9dcd2b66a6ce72b` | verified: navigation-contaminated title is a real JAMA/JN Learning multimedia record, retained and cleaned | `10.1001/jama.2026.6477` |
| `14ac10d88baa1cf1` | unresolved: old DOI identifies an unrelated Nature Methods article; column-only title cannot identify the intended original | none; keep original ID/title and hold the DOI link |
| `f2ef8eba6b15c671` | false-positive against recorded baseline: M8 duplicate claim not reproduced; retain | `10.1016/j.landig.2025.100931` |
| `abebc81043af3725` | false-positive against recorded baseline: M8 duplicate claim not reproduced; retain | `10.1016/j.landig.2026.100983` |

The new Library report `00-QA总报告-2026-10-08.md` (`libfile_5c9d8c32aea88191a873a20644cb2c8f`) was read at lines 45–51, including M8. Both reported DOIs occur exactly once each in the recorded public library, approved raw snapshot and runtime library, and zero times in FEEDS. M8's 1,268 denominator differs from the current local public projection of 1,264. Historical merging is not established; this finding does not assert that the report was never true. The latest remote state refresh failed with a GitHub authentication error, so the false-positive designation is limited to the recorded local baseline. Credentials were not changed or bypassed. Cardinality is rechecked during projection; a newly observed duplicate causes HOLD instead of silently retaining both.

The Wizard of Oz record is not discarded as a menu. Its [JAMA page](https://jamanetwork.com/journals/jama/fullarticle/2850538) and [JN Learning page](https://edhub.ama-assn.org/jn-learning/audio-player/19071589) both give June 17, 2026. Crossref currently reports July 14. The proposed first-online date follows the publisher's explicit June 17 date and records the conflict in `dateBasis`; both values remain in the evidence JSON. This identifies public bibliography only and assigns no study-design or genre classification.

For the two other applied JAMA corrections and existing duplicate target, Crossref supplied print dates only. Issue months are recorded separately; existing source dates and their unreviewed labels remain. Three OUP records have independently verified Crossref online dates. No cached PMID was assigned without a separate independent verification. No ingestion date is invented.

Six replacement identities were found first in the existing public metadata cache, including the already published Lost Aura target. Crossref checks comprised 15 exact DOI metadata requests and two title queries. There was one targeted publisher search and two publisher pages. No requests were retried; no new 403/429 occurred. The previous PubMed 429 was respected: this followup made zero PubMed requests. No all-corpus external verification, model request, mother-index read or PDF-body read was performed. Crossref metadata was copied selectively, without abstracts or private fields.

## Files and offline validation

- `editorial/public_bibliography_followup_20261008.json`: ten-entry public-field-only policy.
- `scripts/public_bibliography_followup.py`: standalone validator and pure preview projection, no remote calls or input writes.
- `scripts/test_public_bibliography_followup.py`: 17 regression tests.
- `docs/public-bibliography-followup-evidence-20261008.json`: original/public official evidence and date conflict.
- `docs/public-bibliography-followup-validation-20261008.json`: reproducible test/preview/input-hash evidence.
- `docs/public-bibliography-followup-20261008.md`: this handoff.

Run `python3 -m unittest discover -s scripts -p 'test_public_bibliography_followup.py'` and `python3 scripts/public_bibliography_followup.py`. Seventeen new tests and 42 relevant regressions passed. The full-library offline preview is 1,264 → 1,263 because of the one expressly named duplicate; this is not a production count. Projection is idempotent, retains the unresolved article and both M8 singleton records, rejects duplicate DOI variants and changed public identities, drops unknown private fields, clears source-DOI enrichment, and preserves classifier fields. The existing canonical duplicate target's legitimate public enrichment remains intact. No same-title/different-DOI rule is used: the one alias follows an independently verified correction of the unrelated original DOI to the canonical official public identity, with exact guards on both named records and all original public strings retained in the audit.

## Integration contract

The unique integration owner may call `project(papers, policy)` after the existing `project_public_library` step and before serialization/PDF registry generation. The returned audit's `pdfBindingHoldIds` must be unioned with the existing quality audit HOLDs; this batch returns **11** IDs, including both sides of the explicit alias. The combined prior/followup preview has **17** HOLD IDs. A title, DOI, journal or PMID change, missing canonical target, or unexpected already-published replacement DOI produces a fixed HOLD instead of an inferred merge.

All affected public targets stay `fulltextStatus=not_verified` and `localAvailable=false`. Their raw approved snapshot and raw runtime library are unchanged. Any independently verified private PDF rebinding is outside this policy. If the owner wires the policy, add its JSON and projection module to build provenance, union the PDF HOLDs, and add the new test invocation through the owner's integration change. This followup intentionally makes none of those shared-file edits.

Remaining blocker: the true title/identifier behind `Invited Commentary AI IN SURGERY` is unknown. The rest of the original independent candidate inventory is outside this bounded ten-case followup.
