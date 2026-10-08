# Public bibliography v2 review — 2026-10-08

This source-only patch reviews the five priority DOI cases from Library report
`learn-dryz-_bug_-v2.md` (`libfile_776ebc6f9fc08191bc768618a1669abf`). Native Library reads covered lines 78–91 and 266–299 (P0-7/8 and section 7). The report's counts are hypotheses; it does not contain the full claimed 30-DOI or 78-title lists. No access to the reporter's local temporary directory is assumed.

Baseline: main `0edf01932612c9f2a68bde3e638be27a42f187bf` (v14.2.13), runtime state `350addefc78f57362278ab73123924e852b179bb`. A later read-only fetch found main `7ed3157a88ed00ea1079aaecd00403aa04148b3d` (v14.2.14); its changed files do not overlap this patch. This handoff retains the recorded baseline and leaves integration to the original task. Only state `data/` and `public/` were restored into this isolated checkout. The public baseline contains 1,264 library records and 874 dynamic records, denominator 2,138. Raw approved snapshot remains 1,268 records.

## First reviewed batch

| Original public DOI | Result | Public action |
| --- | --- | --- |
| `10.1002/dta.1857` | verified: registered Drug Testing and Analysis article is unrelated to the JAMA title | Use `10.1001/jama.2026.14789` and official title |
| `10.1016/s2589-7500(20)30185-0` | verified: registered Lancet Digital Health mammography article is unrelated to the JAMA Internal Medicine title | Use `10.1001/jamainternmed.2025.7627` and official full title |
| `10.1093/ehjdh/ztag011/8431732` | verified: canonical registry title, journal and both named public authors match | Use `10.1093/ehjdh/ztag011`, official title and online date 2026-01-21 |
| `10.1016/j.jacc.2024` | unresolved: truncated identifier; original title is only a column header | Retain article ID/title, hold DOI link |
| `10.1145/nnnnnnn.nnnnnnn` | unresolved: template placeholder; targeted title search did not establish a real identifier | Retain preprint ID/title, hold DOI link |

Counts: verified 3, falsepositive 0, unresolved 2. A registry 404 or empty PubMed search does not prove an article does not exist. No PMID was assigned. The first two replacements have Crossref print dates only: add issue months 2026-09 and 2026-05, retain existing source dates with their unreviewed labels, and do not manufacture online or ingestion dates. Registry responses and public original/canonical strings are recorded in `public-library-doi-review-20261008.json`.

All five identities remain outside the existing generated PDF download registry. Their fulltext status stays `not_verified`, local availability false and ingestion date unknown. DOI-associated old abstracts, translations and drafts are discarded on these five projected records to prevent identity rebinding. No private PDF identity is claimed or inferred from a title. The private mother index and PDF bodies were neither read nor changed in this continuation.

## Reproducible public-only candidate inventory

`python3 scripts/audit_public_bibliography.py --bundle public/public.js` performs no network requests and parses only LIBRARY and FEEDS. It saves a field-allowlisted local JSON inventory; original strings are preserved and NFKC is emitted only as `queryTitle`.

The committed baseline inventory `public-library-quality-v2-suspects-20261008.json` contains 82 candidates: 3 verified and 79 unresolved, including the two priority HOLDs and 77 not reviewed. It is an independent heuristic inventory, not reproduction or proof of the report's exact 78. Flags overlap: 53 NFKC variants, 12 title/header fragments, 11 navigation/learning paths, 11 section prefixes, 5 appended resource identifiers, 2 truncated shapes and 1 placeholder. There are 34 distinct title-flagged candidates and 42 NFKC-only candidates. Unicode variants, section labels and old publisher prefixes are not automatic errors. No prefix-mismatch error rule exists.

Baseline public bundle SHA-256: `bfa4abc5a930ee0d885e5cad2da46ac2721cb1a19d2a2778ca54129ff870f85c`. Candidate generation is offline and excludes the 14k radar corpus. Official metadata requests were limited to these five priority cases and four title queries. One PubMed HTTP 429 occurred in the targeted batch; no retry or subsequent PubMed batch followed.

## Integration and remaining review

The projection is finite and idempotent. Changed title/journal/DOI, unexpected PMID or a replacement DOI already attached to another ID produces a fixed HOLD instead of an inferred merge. The existing snapshot retention guard and field whitelist remain active. Runtime data, public outputs, workflows, API worker source, classifier, search code and private credentials are not part of the source patch.

Validation passed: 551 full-suite tests, then 25 relevant tests after the final DOI normalization guard; real-state build and six-file release preflight also passed. Results and hashes are recorded in `public-library-quality-v2-validation-20261008.json`. Run `python3 -m unittest discover -s scripts -p 'test_public_bibliography_review.py'` for the 15 new regression tests, followed by the existing suite and `python3 scripts/build_public.py` on an approved state checkout. After projection the public library remains 1,264; records without DOI or URL rise from 242 to 244 because the two unverified links are held. Raw library and approved snapshot hashes were unchanged.

The original integration task retains the only main/state integration and deployment authority. Remaining work: obtain the report's exact suspect lists or review the independent inventory in bounded batches; establish real identifiers for the two HOLDs; independently verify the first two source online dates. Proposed audience boundary remains pending confirmation: anonymous public users receive bibliography and verified public links; authenticated owner access to private PDFs requires independent identity/authorization verification outside this patch. No private contents or PDF availability are exposed by the bibliography projection.
